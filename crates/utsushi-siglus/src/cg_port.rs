//! EnginePort lifecycle for static Siglus text observation and optional G00 capture.

use std::sync::Arc;

use utsushi_core::substrate::{
    AssetPackage, CapabilityDeclaration, CapabilityStance, CaptureOutcome, EngineParityProfile,
    EnginePort, EnginePortError, EvidenceTier, FidelityTier, LifecycleStage, PortCapability,
    PortManifest, PortRequest, PortShutdownOutcome, REQUIRED_LIFECYCLE_STAGES, SinkSet, TextLine,
    TextSurfaceSink,
};
use utsushi_core::{RuntimeArtifactKind, RuntimeArtifactRoot, runtime_artifact_uri};

use crate::cg_port_sinks::SiglusObservationSinks;
use crate::launch::{RequestAssetPackage, SiglusSceneMomentIndex, hydrate_siglus_launch};
use crate::observe::{SiglusChoiceDiagnostic, SiglusChoiceMoment};
use crate::siglus_g00::{SiglusG00Image, decode_siglus_g00};
use crate::siglus_render::{SiglusCgRedaction, encode_siglus_png, render_siglus_cg};

const PORT_ID: &str = "utsushi-siglus";
const PORT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// G00 asset configuration for [`UtsushiSiglusPort`].
#[derive(Clone, Default)]
pub struct UtsushiSiglusPortContext {
    asset_package: Option<Arc<dyn AssetPackage>>,
    g00_logical_path: Option<String>,
}

impl UtsushiSiglusPortContext {
    /// An empty context is useful for capability inspection. At launch the
    /// port hydrates its package from [`PortRequest::vfs`]; callers that also
    /// need the optional CG capture slice may use
    /// [`UtsushiSiglusPort::with_g00_asset`].
    pub fn empty() -> Self {
        Self::default()
    }

    /// Borrow the package backing the configured CG asset.
    pub fn asset_package(&self) -> Option<&Arc<dyn AssetPackage>> {
        self.asset_package.as_ref()
    }

    /// Package-relative G00 path selected for this port instance.
    pub fn g00_logical_path(&self) -> Option<&str> {
        self.g00_logical_path.as_deref()
    }
}

impl std::fmt::Debug for UtsushiSiglusPortContext {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("UtsushiSiglusPortContext")
            .field(
                "asset_package",
                &self.asset_package.as_ref().map(|_| "<present>"),
            )
            .field("g00_logical_path", &self.g00_logical_path)
            .finish()
    }
}

/// Siglus static text/choice and optional CG-capture engine port.
///
/// `launch` opens and decodes real package bytes. `observe` walks the decoded
/// surfaces one finite scene per tick. When configured with a G00, `capture`
/// preserves the existing edge-redacted PNG path; otherwise it writes a
/// deterministic text trace under the managed artifact root.
#[derive(Debug)]
pub struct UtsushiSiglusPort {
    context: UtsushiSiglusPortContext,
    launch_index: Option<SiglusSceneMomentIndex>,
    decoded: Option<SiglusG00Image>,
    sinks: SiglusObservationSinks,
    /// Finite decoded text surfaces for each not-yet-observed scene, reversed
    /// so `observe` can pop scenes in source order.
    pending_scenes: Vec<Vec<TextLine>>,
    text_program: Vec<TextLine>,
    choice_moments: Vec<SiglusChoiceMoment>,
    choice_diagnostics: Vec<SiglusChoiceDiagnostic>,
    lines_emitted: usize,
    shut_down: bool,
}

impl UtsushiSiglusPort {
    /// Manifest for the static text walk and optional G00 capture path.
    pub const MANIFEST: PortManifest = PortManifest {
        id: PORT_ID,
        name: "Utsushi Siglus Engine Port",
        version: PORT_VERSION,
        abi_version: 1,
        capabilities: &[
            PortCapability::Launch,
            PortCapability::Observe,
            PortCapability::Capture,
            PortCapability::Shutdown,
        ],
        required_methods: REQUIRED_LIFECYCLE_STAGES,
        optional_methods: &[],
        env_schema: &[],
        fidelity_tier_max: FidelityTier::TraceOnly,
        evidence_tier_max: EvidenceTier::E1,
        limitations: &[
            "Observe is a deterministic static walk of decoded CD_TEXT/CD_NAME surfaces and linked GLOBAL.SELBTN choices, not a live Siglus VM: substitutions and state-dependent rendering are not evaluated.",
            "Each E1 text or choice option carries the stable source-unit key used by the Siglus bridge; static branch targets are structural links, not executed paths.",
            "The production slice decodes type-0 compressed and type-2 layered Siglus G00 containers; type-3 is rejected as unsupported rather than guessed.",
            "A configured G00 capture is edge-redacted by default; otherwise capture writes a text trace. Full-fidelity decoded pixels are not persisted by this port.",
            "Frame and audio sinks are Unsupported. Snapshot and replay remain deferred.",
        ],
    };

    /// Capability parity declaration consumed by the generated engine gate.
    pub const PARITY_PROFILE: EngineParityProfile = EngineParityProfile {
        manifest: Self::MANIFEST,
        declarations: &[
            CapabilityDeclaration {
                capability: PortCapability::Snapshot,
                stance: CapabilityStance::Pending,
                note: "dev: no Siglus VM state is modelled by the CG slice.",
            },
            CapabilityDeclaration {
                capability: PortCapability::DeterministicReplay,
                stance: CapabilityStance::Pending,
                note: "dev: no Siglus VM replay path is modelled by the CG slice.",
            },
            CapabilityDeclaration {
                capability: PortCapability::ReplayReview,
                stance: CapabilityStance::Pending,
                note: "dev: no replay-review surface exists without a Siglus VM.",
            },
        ],
    };

    /// Construct an unconfigured port. Its launch error tells callers to
    /// supply a real asset package rather than silently using fixture pixels.
    pub fn new() -> Self {
        Self {
            context: UtsushiSiglusPortContext::empty(),
            launch_index: None,
            decoded: None,
            sinks: SiglusObservationSinks::new(),
            pending_scenes: Vec::new(),
            text_program: Vec::new(),
            choice_moments: Vec::new(),
            choice_diagnostics: Vec::new(),
            lines_emitted: 0,
            shut_down: false,
        }
    }

    /// Construct the real production G00 path from a package and logical
    /// asset reference, for example `g00/AH01A01.g00`.
    pub fn with_g00_asset(
        asset_package: Arc<dyn AssetPackage>,
        g00_logical_path: impl Into<String>,
    ) -> Self {
        Self {
            context: UtsushiSiglusPortContext {
                asset_package: Some(asset_package),
                g00_logical_path: Some(g00_logical_path.into()),
            },
            ..Self::new()
        }
    }

    /// Borrow the port configuration for audit and embedding setup.
    pub fn context(&self) -> &UtsushiSiglusPortContext {
        &self.context
    }

    /// Fully decoded scene/moment index, available after a successful launch.
    pub fn scene_moment_index(&self) -> Option<&SiglusSceneMomentIndex> {
        self.launch_index.as_ref()
    }

    /// Number of scenes decoded during launch.
    pub fn scene_count(&self) -> usize {
        self.launch_index
            .as_ref()
            .map_or(0, SiglusSceneMomentIndex::scene_count)
    }

    /// Number of indexed review moments exposed by the trace-only launch.
    pub fn moment_count(&self) -> usize {
        self.launch_index
            .as_ref()
            .map_or(0, SiglusSceneMomentIndex::moment_count)
    }

    /// Number of parsed `Gameexe.dat` configuration entries from launch.
    pub fn gameexe_entry_count(&self) -> usize {
        self.launch_index
            .as_ref()
            .map_or(0, SiglusSceneMomentIndex::gameexe_entry_count)
    }

    /// Number of static text lines emitted so far.
    pub fn lines_emitted(&self) -> usize {
        self.lines_emitted
    }

    /// Number of static text lines prepared during launch.
    pub fn lines_total(&self) -> usize {
        self.text_program.len()
    }

    /// Static player-facing choices decoded at launch, in scene and source
    /// order. Each option links to its E1 text line and structural branch
    /// target when the select-to-jump shape is supported.
    pub fn choice_moments(&self) -> &[SiglusChoiceMoment] {
        &self.choice_moments
    }

    /// Explicit unsupported or incomplete choice shapes encountered during
    /// static decoding. No choice label text is retained in a diagnostic.
    pub fn choice_diagnostics(&self) -> &[SiglusChoiceDiagnostic] {
        &self.choice_diagnostics
    }

    /// Observation sinks, including E1 text and explicit Unsupported frame /
    /// audio declarations.
    pub fn sinks(&self) -> &SiglusObservationSinks {
        &self.sinks
    }

    fn hydrate_asset_package(&mut self, request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        if let Some(vfs) = request.vfs.clone() {
            // The request handoff is the launch authority. An explicit VFS
            // therefore replaces any embedding-time package configuration.
            self.context.asset_package = Some(Arc::new(RequestAssetPackage::new(vfs)));
        } else if self.context.asset_package.is_none() {
            return Err(Self::lifecycle_error(
                LifecycleStage::Launch,
                "a Siglus AssetPackage supplied through PortRequest.vfs is required",
            ));
        }
        Ok(())
    }

    fn load_image(&self, stage: LifecycleStage) -> Result<SiglusG00Image, EnginePortError> {
        let package =
            self.context.asset_package.as_ref().ok_or_else(|| {
                Self::lifecycle_error(stage, "a Siglus G00 AssetPackage is required")
            })?;
        let logical = self.context.g00_logical_path.as_deref().ok_or_else(|| {
            Self::lifecycle_error(stage, "a Siglus G00 logical asset path is required")
        })?;
        let id = package.resolve(logical).map_err(|error| {
            Self::lifecycle_error(stage, format!("G00 asset resolution failed: {error}"))
        })?;
        let bytes = package.open(&id).map_err(|error| {
            Self::lifecycle_error(stage, format!("G00 asset open failed: {error}"))
        })?;
        decode_siglus_g00(bytes.as_slice())
            .map_err(|error| Self::lifecycle_error(stage, format!("G00 decode failed: {error}")))
    }

    fn lifecycle_error(stage: LifecycleStage, message: impl Into<String>) -> EnginePortError {
        EnginePortError::Lifecycle {
            stage,
            message: message.into(),
            source: None,
        }
    }

    fn write_capture(
        image: &SiglusG00Image,
        root: &RuntimeArtifactRoot,
        run_id: &str,
    ) -> Result<CaptureOutcome, EnginePortError> {
        let frame = render_siglus_cg(image, SiglusCgRedaction::default()).map_err(|error| {
            Self::lifecycle_error(
                LifecycleStage::Capture,
                format!("G00 raster failed: {error}"),
            )
        })?;
        let png = encode_siglus_png(&frame).map_err(|error| {
            Self::lifecycle_error(
                LifecycleStage::Capture,
                format!("PNG encode failed: {error}"),
            )
        })?;
        root.prepare().map_err(|error| {
            Self::lifecycle_error(
                LifecycleStage::Capture,
                format!("capture root preparation failed: {error}"),
            )
        })?;
        let uri = runtime_artifact_uri(
            run_id,
            RuntimeArtifactKind::Screenshot,
            "siglus-g00-redacted",
        )
        .map_err(|error| {
            Self::lifecycle_error(
                LifecycleStage::Capture,
                format!("capture URI failed: {error}"),
            )
        })?;
        let path = root.write_bytes(&uri, &png).map_err(|error| {
            Self::lifecycle_error(
                LifecycleStage::Capture,
                format!("capture write failed: {error}"),
            )
        })?;
        Ok(CaptureOutcome::new(uri)
            .with_path(path)
            .with_summary(format!(
                "siglus-g00 capture: {}x{} layers={} redacted=true",
                image.width,
                image.height,
                image.layers.len()
            )))
    }

    fn write_text_trace(
        &self,
        root: &RuntimeArtifactRoot,
        run_id: &str,
    ) -> Result<CaptureOutcome, EnginePortError> {
        let uri = runtime_artifact_uri(run_id, RuntimeArtifactKind::TraceLog, "siglus-text-trace")
            .map_err(|error| {
                Self::lifecycle_error(
                    LifecycleStage::Capture,
                    format!("text trace URI failed: {error}"),
                )
            })?;
        let trace = serde_json::json!({
            "schema": "utsushi-siglus-text-trace/0.1.0-alpha",
            "portId": PORT_ID,
            "lineCount": self.text_program.len(),
            "linesEmitted": self.lines_emitted,
            "lines": &self.text_program,
            "choiceMoments": &self.choice_moments,
            "choiceDiagnostics": &self.choice_diagnostics,
        });
        let bytes = serde_json::to_vec_pretty(&trace).map_err(|error| {
            Self::lifecycle_error(
                LifecycleStage::Capture,
                format!("text trace serialization failed: {error}"),
            )
        })?;
        let path = root.write_bytes(&uri, &bytes).map_err(|error| {
            Self::lifecycle_error(
                LifecycleStage::Capture,
                format!("text trace write failed: {error}"),
            )
        })?;
        Ok(CaptureOutcome::new(uri)
            .with_path(path)
            .with_summary(format!(
                "siglus text trace: {} lines, {} choice moments",
                self.text_program.len(),
                self.choice_moments.len()
            )))
    }
}

impl Default for UtsushiSiglusPort {
    fn default() -> Self {
        Self::new()
    }
}

impl EnginePort for UtsushiSiglusPort {
    const MANIFEST: PortManifest = Self::MANIFEST;

    fn launch(&mut self, request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        request.cancellation.check(LifecycleStage::Launch)?;
        self.hydrate_asset_package(request)?;
        let package = self.context.asset_package.as_deref().ok_or_else(|| {
            Self::lifecycle_error(
                LifecycleStage::Launch,
                "a Siglus AssetPackage is required for launch hydration",
            )
        })?;
        let hydrated = hydrate_siglus_launch(package, request)?;
        self.pending_scenes = hydrated
            .scene_text_program
            .into_iter()
            .filter(|scene| !scene.is_empty())
            .rev()
            .collect();
        self.text_program = hydrated.text_program;
        self.choice_moments = hydrated.choice_moments;
        self.choice_diagnostics = hydrated.choice_diagnostics;
        self.lines_emitted = 0;
        self.launch_index = Some(hydrated.index);
        self.decoded = match self.context.g00_logical_path {
            Some(_) => Some(self.load_image(LifecycleStage::Launch)?),
            None => None,
        };
        self.shut_down = false;
        Ok(())
    }

    fn observe(&mut self, request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        request.cancellation.check(LifecycleStage::Observe)?;
        if self.shut_down {
            return Err(Self::lifecycle_error(
                LifecycleStage::Observe,
                "Siglus port observed after shutdown",
            ));
        }
        if self.launch_index.is_none() {
            return Err(Self::lifecycle_error(
                LifecycleStage::Observe,
                "launch must run before observe",
            ));
        }
        if let Some(scene) = self.pending_scenes.pop() {
            for line in scene {
                request.cancellation.check(LifecycleStage::Observe)?;
                self.sinks.text().emit_line(line).map_err(|error| {
                    Self::lifecycle_error(
                        LifecycleStage::Observe,
                        format!("text emission failed: {error}"),
                    )
                })?;
                self.lines_emitted += 1;
            }
        }
        Ok(())
    }

    fn sink_set(&self) -> &SinkSet {
        self.sinks.sink_set()
    }

    fn capture(&mut self, request: &PortRequest<'_>) -> Result<CaptureOutcome, EnginePortError> {
        request.cancellation.check(LifecycleStage::Capture)?;
        let root = request
            .artifact_root
            .ok_or(EnginePortError::ArtifactRootMissing {
                stage: LifecycleStage::Capture,
            })?;
        if let Some(image) = &self.decoded {
            Self::write_capture(image, root, request.run_id)
        } else if self.launch_index.is_some() {
            self.write_text_trace(root, request.run_id)
        } else {
            Err(Self::lifecycle_error(
                LifecycleStage::Capture,
                "launch must run before capture",
            ))
        }
    }

    fn shutdown(&mut self) -> Result<PortShutdownOutcome, EnginePortError> {
        if self.shut_down {
            return Ok(PortShutdownOutcome::already_shut_down());
        }
        self.decoded = None;
        self.launch_index = None;
        self.pending_scenes.clear();
        self.text_program.clear();
        self.choice_moments.clear();
        self.choice_diagnostics.clear();
        self.lines_emitted = 0;
        self.shut_down = true;
        Ok(PortShutdownOutcome::clean())
    }
}
