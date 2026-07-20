//! EnginePort lifecycle that turns a configured Siglus G00 into a safe frame.

use std::sync::Arc;

use utsushi_core::substrate::{
    AssetPackage, CapabilityDeclaration, CapabilityStance, CaptureOutcome, EngineParityProfile,
    EnginePort, EnginePortError, EvidenceTier, FidelityTier, LifecycleStage, PortCapability,
    PortManifest, PortRequest, PortShutdownOutcome, REQUIRED_LIFECYCLE_STAGES, SinkSet,
};
use utsushi_core::{RuntimeArtifactKind, RuntimeArtifactRoot, runtime_artifact_uri};

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
    /// An empty context is useful for capability inspection but cannot launch
    /// a capture; use [`UtsushiSiglusPort::with_g00_asset`] for production.
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

/// Siglus image/CG engine port.
///
/// `launch` opens and decodes real package bytes. `capture` rasterizes that
/// decoded image and writes an edge-redacted PNG through the managed artifact
/// store. Full-fidelity pixels remain in-memory only unless an embedding
/// caller explicitly uses [`crate::render_siglus_cg`] with `Full`.
#[derive(Debug)]
pub struct UtsushiSiglusPort {
    context: UtsushiSiglusPortContext,
    decoded: Option<SiglusG00Image>,
    sink_set: SinkSet,
    shut_down: bool,
}

impl UtsushiSiglusPort {
    /// Manifest for the implemented G00 decode/capture slice.
    pub const MANIFEST: PortManifest = PortManifest {
        id: PORT_ID,
        name: "Utsushi Siglus G00/CG Engine Port",
        version: PORT_VERSION,
        abi_version: 1,
        capabilities: &[
            PortCapability::Launch,
            PortCapability::Capture,
            PortCapability::Shutdown,
        ],
        required_methods: REQUIRED_LIFECYCLE_STAGES,
        optional_methods: &[],
        env_schema: &[],
        fidelity_tier_max: FidelityTier::LayoutProbe,
        evidence_tier_max: EvidenceTier::E2,
        limitations: &[
            "The production slice decodes type-0 compressed and type-2 layered Siglus G00 containers; type-3 is rejected as unsupported rather than guessed.",
            "Capture artifacts are edge-redacted by default; full-fidelity decoded pixels are not persisted by this port.",
            "Siglus VM, text observation, snapshot, and replay remain outside this CG-focused slice.",
        ],
    };

    /// Capability parity declaration consumed by the generated engine gate.
    pub const PARITY_PROFILE: EngineParityProfile = EngineParityProfile {
        manifest: Self::MANIFEST,
        declarations: &[
            CapabilityDeclaration {
                capability: PortCapability::Observe,
                stance: CapabilityStance::Pending,
                note: "dev: this CG slice does not yet emit VM-driven observation events.",
            },
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
            decoded: None,
            sink_set: SinkSet::new(),
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
        self.decoded = Some(self.load_image(LifecycleStage::Launch)?);
        self.shut_down = false;
        Ok(())
    }

    fn observe(&mut self, request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        request.cancellation.check(LifecycleStage::Observe)?;
        if self.decoded.is_none() {
            return Err(Self::lifecycle_error(
                LifecycleStage::Observe,
                "launch must decode the configured Siglus G00 before observe",
            ));
        }
        Ok(())
    }

    fn sink_set(&self) -> &SinkSet {
        &self.sink_set
    }

    fn capture(&mut self, request: &PortRequest<'_>) -> Result<CaptureOutcome, EnginePortError> {
        request.cancellation.check(LifecycleStage::Capture)?;
        let root = request
            .artifact_root
            .ok_or(EnginePortError::ArtifactRootMissing {
                stage: LifecycleStage::Capture,
            })?;
        let Some(image) = &self.decoded else {
            return Err(Self::lifecycle_error(
                LifecycleStage::Capture,
                "launch must run before capture",
            ));
        };
        Self::write_capture(image, root, request.run_id)
    }

    fn shutdown(&mut self) -> Result<PortShutdownOutcome, EnginePortError> {
        if self.shut_down {
            return Ok(PortShutdownOutcome::already_shut_down());
        }
        self.decoded = None;
        self.shut_down = true;
        Ok(PortShutdownOutcome::clean())
    }
}
