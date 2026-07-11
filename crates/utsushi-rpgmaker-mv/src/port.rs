//! `EnginePort` + `Inspectable` implementation for the RPG Maker MV/MZ
//! runtime port.
//!
//! Unlike the `utsushi-reallive` / `utsushi-siglus` scaffolds — whose
//! lifecycle methods return a typed `Lifecycle` "unimplemented" error —
//! this port's lifecycle methods do **real work**: `launch` resolves and
//! parses the project's MV/MZ event-command data, `observe` emits the
//! runtime text stream one line per tick into the text sink, `capture`
//! materialises a deterministic trace-log artifact under the managed
//! runtime artifact root, and the port exposes its playback cursor through
//! the [`Inspectable`] snapshot surface.
//!
//! # Substrate-facade containment
//!
//! Every `utsushi_core::*` lifecycle symbol is sourced through
//! `utsushi_core::substrate::*`, including [`SubstrateCaptureOutcome`] (the
//! `EnginePort::capture` return type). The only documented crate-root
//! reach-arounds left here are [`runtime_artifact_uri`] and
//! [`RuntimeArtifactKind`], which mint the managed trace-log URI.

use std::sync::{Arc, Mutex};

use utsushi_core::substrate::{
    AssetId, AudioEvent, AudioEventSink, CapabilityDeclaration, CapabilityStance,
    CaptureOutcome as SubstrateCaptureOutcome, EngineParityProfile, EnginePort, EnginePortError,
    EvidenceTier, FidelityTier, FrameArtifact, FrameArtifactSink, Inspectable, LifecycleStage,
    ObservationBridgeRef, PortCapability, PortManifest, PortRequest, PortShutdownOutcome,
    REQUIRED_LIFECYCLE_STAGES, SinkCapability, SinkError, SinkKind, SinkResult, SinkSet,
    SnapshotError, StatePath, StateTree, StateValue, TextLine, TextSurfaceSink,
};
// Forced reach-arounds: `runtime_artifact_uri` + `RuntimeArtifactKind` mint the
// managed trace-log URI the artifact is written under.
use utsushi_core::{RuntimeArtifactKind, runtime_artifact_uri};

use crate::event_data::{DataDir, DataLayout, EventDataError, MessageLine, TextRole, load_program};

/// Stable port id. Matches the `EngineFamily::RpgmakerMv -> "utsushi-rpgmaker-mv"`
/// mapping in `utsushi_core::port::impl_map` (validator.rs) and the
/// `RpgmakerMz` family's `utsushi-rpgmaker-*` prefix rule.
const PORT_ID: &str = "utsushi-rpgmaker-mv";

/// Crate semantic version, sourced from Cargo metadata.
const PORT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Collector text sink. The port pushes one [`TextLine`] per `observe`
/// tick; the runner drains via [`TextSurfaceSink::drain_lines`].
pub struct RpgmakerMvTextSink {
    buffer: Mutex<Vec<TextLine>>,
}

impl RpgmakerMvTextSink {
    pub fn new() -> Self {
        Self {
            buffer: Mutex::new(Vec::new()),
        }
    }
}

impl Default for RpgmakerMvTextSink {
    fn default() -> Self {
        Self::new()
    }
}

impl TextSurfaceSink for RpgmakerMvTextSink {
    fn capability(&self) -> SinkCapability {
        SinkCapability::Supported {
            evidence_tier_ceiling: EvidenceTier::E1,
        }
    }

    fn emit_line(&self, line: TextLine) -> SinkResult<()> {
        line.validate()?;
        self.buffer.lock().expect("text sink lock").push(line);
        Ok(())
    }

    fn drain_lines(&self) -> Vec<TextLine> {
        std::mem::take(&mut *self.buffer.lock().expect("text sink lock"))
    }
}

/// Explicitly-unsupported frame sink. The MV/MZ runtime renders to a JS
/// DOM/canvas; this port observes the text stream only and does not
/// rasterise frames. Declaring the sink `Unsupported` is the audit-correct
/// posture for "this port has no frame evidence to announce" (vs silently
/// omitting the sink).
struct RpgmakerMvFrameSink;

impl FrameArtifactSink for RpgmakerMvFrameSink {
    fn capability(&self) -> SinkCapability {
        SinkCapability::Unsupported
    }

    fn emit_frame(&self, _frame: FrameArtifact) -> SinkResult<()> {
        Err(SinkError::UnsupportedKind {
            sink: SinkKind::FrameArtifact,
            adapter_id: PORT_ID.to_string(),
            reason: "utsushi-rpgmaker-mv observes the text stream only; frame rasterisation is a deferred surface".to_string(),
        })
    }
}

/// Explicitly-unsupported audio sink — the static event-stream walk
/// announces no audio evidence.
struct RpgmakerMvAudioSink;

impl AudioEventSink for RpgmakerMvAudioSink {
    fn capability(&self) -> SinkCapability {
        SinkCapability::Unsupported
    }

    fn emit_event(&self, _audio: AudioEvent) -> SinkResult<()> {
        Err(SinkError::UnsupportedKind {
            sink: SinkKind::AudioEvent,
            adapter_id: PORT_ID.to_string(),
            reason: "utsushi-rpgmaker-mv has no audio evidence to announce".to_string(),
        })
    }
}

/// Sink bundle owned by [`UtsushiRpgmakerMvPort`].
pub struct RpgmakerMvObservationSinks {
    text: Arc<RpgmakerMvTextSink>,
    sink_set: SinkSet,
}

impl RpgmakerMvObservationSinks {
    pub fn new() -> Self {
        let text = Arc::new(RpgmakerMvTextSink::new());
        let sink_set = SinkSet::new()
            .with_text(text.clone() as Arc<dyn TextSurfaceSink>)
            .with_frame(Arc::new(RpgmakerMvFrameSink) as Arc<dyn FrameArtifactSink>)
            .with_audio(Arc::new(RpgmakerMvAudioSink) as Arc<dyn AudioEventSink>);
        Self { text, sink_set }
    }

    pub fn sink_set(&self) -> &SinkSet {
        &self.sink_set
    }
}

impl Default for RpgmakerMvObservationSinks {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PortState {
    Idle,
    Launched,
    Drained,
    ShutDown,
}

impl PortState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Launched => "launched",
            Self::Drained => "drained",
            Self::ShutDown => "shut_down",
        }
    }
}

/// RPG Maker MV/MZ runtime port.
///
/// Owns the parsed playback program (the ordered text stream) and a
/// playback cursor. The lifecycle methods drive real behaviour; the
/// [`Inspectable`] impl exposes the cursor + inventory into the snapshot
/// substrate.
pub struct UtsushiRpgmakerMvPort {
    state: PortState,
    sinks: RpgmakerMvObservationSinks,
    layout: Option<DataLayout>,
    /// The not-yet-emitted tail of the playback program.
    pending: Vec<TextLine>,
    /// The source lines, retained for capture-artifact assembly and
    /// inventory.
    program: Vec<MessageLine>,
    files_loaded: usize,
    lines_total: usize,
    lines_emitted: usize,
    shut_down: bool,
}

impl UtsushiRpgmakerMvPort {
    /// Audit-grade manifest declaration. Mirrors [`EnginePort::MANIFEST`].
    ///
    /// Tier ceilings are pinned at trace-only / E1: the port proves "the
    /// runtime emitted this string for this source unit," not "this text
    /// was rendered on screen." Frame/audio sinks are declared
    /// `Unsupported`.
    pub const MANIFEST: PortManifest = PortManifest {
        id: PORT_ID,
        name: "Utsushi RPG Maker MV/MZ Engine Port",
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
            "Static event-stream walk, not a live JS interpreter: conditional branches are not evaluated, choice options are all surfaced in declaration order, and variable/switch state is not threaded.",
            "Text surfaces only (Show Text 401, Show Scrolling Text 405, Show Choices 102). Frame rasterisation (JS DOM/canvas) and audio are declared Unsupported sinks; screenshot/frame capture is a deferred surface.",
            "Script (355/655) and Plugin (356/357) command text is not extracted; a plugin registry is a deferred follow-up.",
            "Inspect-only: the port implements Inspectable but not Restorable (no controlled-playback restore).",
            "Clean-room: no RPG Maker engine source is vendored or linked; command-code numbers are public MV/MZ engine constants.",
        ],
    };

    /// Cross-engine capability parity profile (UTSUSHI parity gate). This
    /// static event-stream port wires the four required lifecycle
    /// capabilities and declares the port-driven `Snapshot` /
    /// `DeterministicReplay` capabilities (wired by `utsushi-reallive`) as
    /// dev-`Pending`: the port is inspect-only (implements `Inspectable` but
    /// not `Restorable`) and drives no live JS runtime, so full snapshot
    /// round-trip and deterministic replay are not yet built. They are NOT
    /// `NotApplicable` — the MV/MZ runtime can support them — so the parity
    /// gate keeps them visible as a dev gap, never a permanent hole.
    pub const PARITY_PROFILE: EngineParityProfile = EngineParityProfile {
        manifest: Self::MANIFEST,
        declarations: &[
            CapabilityDeclaration {
                capability: PortCapability::Snapshot,
                stance: CapabilityStance::Pending,
                note: "dev: the static event-stream port is inspect-only (Inspectable, not Restorable); full snapshot round-trip is not yet wired.",
            },
            CapabilityDeclaration {
                capability: PortCapability::DeterministicReplay,
                stance: CapabilityStance::Pending,
                note: "dev: deterministic replay awaits a live playback loop; the static walk drives no clock/input replay yet.",
            },
            CapabilityDeclaration {
                capability: PortCapability::ReplayReview,
                stance: CapabilityStance::Pending,
                note: "dev: replay-review evidence awaits a live playback loop; the static event stream does not expose it yet.",
            },
        ],
    };

    pub fn new() -> Self {
        Self {
            state: PortState::Idle,
            sinks: RpgmakerMvObservationSinks::new(),
            layout: None,
            pending: Vec::new(),
            program: Vec::new(),
            files_loaded: 0,
            lines_total: 0,
            lines_emitted: 0,
            shut_down: false,
        }
    }

    pub fn sinks(&self) -> &RpgmakerMvObservationSinks {
        &self.sinks
    }

    /// Number of lines observed so far (drained by the runner).
    pub fn lines_emitted(&self) -> usize {
        self.lines_emitted
    }

    /// Total number of text lines in the loaded program.
    pub fn lines_total(&self) -> usize {
        self.lines_total
    }

    /// The resolved data layout, once launched.
    pub fn layout(&self) -> Option<DataLayout> {
        self.layout
    }

    fn build_text_line(&self, index: usize, line: &MessageLine) -> TextLine {
        let layout = self.layout.unwrap_or(DataLayout::Mv);
        let source_asset = AssetId::parse(&format!(
            "vfs://{}/data/{}",
            layout.asset_package(),
            line.file
        ))
        .ok();
        TextLine {
            line_id: format!(
                "rpgmaker-mv:{}:{:04}:{:04}",
                line.file, line.message_group, index
            ),
            evidence_tier: EvidenceTier::E1,
            text: line.text.clone(),
            speaker: line.speaker.clone(),
            color: None,
            text_surface: Some(line.role.surface_label().to_string()),
            bridge_ref: Some(ObservationBridgeRef {
                bridge_unit_id: None,
                source_unit_key: Some(line.source_unit_key()),
                runtime_object_id: None,
            }),
            source_asset,
            byte_offset_in_scene: None,
            body_shift_jis: None,
        }
    }
}

impl Default for UtsushiRpgmakerMvPort {
    fn default() -> Self {
        Self::new()
    }
}

fn launch_error(error: EventDataError) -> EnginePortError {
    EnginePortError::Lifecycle {
        stage: LifecycleStage::Launch,
        message: format!("rpgmaker-mv launch failed: {error}"),
        source: None,
    }
}

impl EnginePort for UtsushiRpgmakerMvPort {
    const MANIFEST: PortManifest = Self::MANIFEST;

    fn launch(&mut self, request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        request.cancellation.check(LifecycleStage::Launch)?;

        let data_dir = DataDir::discover(request.input_root).ok_or(EventDataError::NoDataDirectory);
        let data_dir = data_dir.map_err(launch_error)?;
        let program = load_program(&data_dir).map_err(launch_error)?;

        self.layout = Some(data_dir.layout);
        self.files_loaded = program.files_loaded;
        self.lines_total = program.lines.len();
        self.lines_emitted = 0;
        self.pending = program
            .lines
            .iter()
            .enumerate()
            .map(|(index, line)| self.build_text_line(index, line))
            .collect();
        // Keep the queue in dispatch order; `observe` pops from the front.
        self.pending.reverse();
        self.program = program.lines;
        self.state = PortState::Launched;
        Ok(())
    }

    fn observe(&mut self, request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        request.cancellation.check(LifecycleStage::Observe)?;
        if self.state == PortState::ShutDown {
            return Err(EnginePortError::Lifecycle {
                stage: LifecycleStage::Observe,
                message: "rpgmaker-mv port observed after shutdown".to_string(),
                source: None,
            });
        }
        if let Some(line) = self.pending.pop() {
            self.sinks
                .text
                .emit_line(line)
                .map_err(|error| EnginePortError::Lifecycle {
                    stage: LifecycleStage::Observe,
                    message: format!("rpgmaker-mv text emit failed: {error}"),
                    source: None,
                })?;
            self.lines_emitted += 1;
            Ok(())
        } else {
            self.state = PortState::Drained;
            Ok(())
        }
    }

    fn sink_set(&self) -> &SinkSet {
        self.sinks.sink_set()
    }

    fn capture(
        &mut self,
        request: &PortRequest<'_>,
    ) -> Result<SubstrateCaptureOutcome, EnginePortError> {
        request.cancellation.check(LifecycleStage::Capture)?;
        let root = request
            .artifact_root
            .ok_or_else(|| EnginePortError::Lifecycle {
                stage: LifecycleStage::Capture,
                message: "rpgmaker-mv capture requires a managed artifact root".to_string(),
                source: None,
            })?;

        let uri = runtime_artifact_uri(
            request.run_id,
            RuntimeArtifactKind::TraceLog,
            "rpgmaker-mv-text-trace-001",
        )
        .map_err(|error| EnginePortError::Lifecycle {
            stage: LifecycleStage::Capture,
            message: format!("rpgmaker-mv capture uri build failed: {error}"),
            source: None,
        })?;

        let trace = self.build_trace_document();
        let bytes =
            serde_json::to_vec_pretty(&trace).map_err(|error| EnginePortError::Lifecycle {
                stage: LifecycleStage::Capture,
                message: format!("rpgmaker-mv trace serialize failed: {error}"),
                source: None,
            })?;

        let path = root
            .write_bytes(&uri, &bytes)
            .map_err(|error| EnginePortError::Lifecycle {
                stage: LifecycleStage::Capture,
                message: format!("rpgmaker-mv capture write failed: {error}"),
                source: None,
            })?;

        Ok(SubstrateCaptureOutcome::new(uri)
            .with_path(path)
            .with_summary(format!(
                "rpgmaker-mv text trace: {} lines across {} files",
                self.lines_total, self.files_loaded
            )))
    }

    fn shutdown(&mut self) -> Result<PortShutdownOutcome, EnginePortError> {
        if self.shut_down {
            Ok(PortShutdownOutcome::already_shut_down())
        } else {
            self.shut_down = true;
            self.state = PortState::ShutDown;
            Ok(PortShutdownOutcome::clean())
        }
    }
}

impl UtsushiRpgmakerMvPort {
    /// Build the deterministic trace document the capture artifact serialises.
    /// Engine-neutral: it carries the runtime-observed text stream (the
    /// evidence) plus per-line role/speaker/source-unit linkage. No host
    /// paths, no engine command bytes.
    fn build_trace_document(&self) -> serde_json::Value {
        let lines: Vec<serde_json::Value> = self
            .program
            .iter()
            .enumerate()
            .map(|(index, line)| {
                serde_json::json!({
                    "lineId": format!(
                        "rpgmaker-mv:{}:{:04}:{:04}",
                        line.file, line.message_group, index
                    ),
                    "file": line.file,
                    "role": role_tag(line.role),
                    "messageGroup": line.message_group,
                    "speaker": line.speaker,
                    "sourceUnitKey": line.source_unit_key(),
                    "text": line.text,
                })
            })
            .collect();
        serde_json::json!({
            "schema": "utsushi-rpgmaker-mv-text-trace/0.1.0-alpha",
            "portId": PORT_ID,
            "layout": self.layout.map_or("unlaunched", super::event_data::DataLayout::as_str),
            "filesLoaded": self.files_loaded,
            "lineCount": self.lines_total,
            "lines": lines,
        })
    }
}

fn role_tag(role: TextRole) -> &'static str {
    match role {
        TextRole::Dialogue => "dialogue",
        TextRole::Scrolling => "scrolling",
        TextRole::Choice => "choice",
    }
}

impl Inspectable for UtsushiRpgmakerMvPort {
    fn inspectable_id(&self) -> &'static str {
        PORT_ID
    }

    fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
        let mut tree = StateTree::new();
        tree.insert(
            StatePath::parse("port.state")?,
            StateValue::String {
                value: self.state.as_str().to_string(),
            },
        )?;
        tree.insert(
            StatePath::parse("port.data_layout")?,
            StateValue::String {
                value: self
                    .layout
                    .map_or("unlaunched", DataLayout::as_str)
                    .to_string(),
            },
        )?;
        tree.insert(
            StatePath::parse("port.files_loaded")?,
            StateValue::Uint {
                value: self.files_loaded as u64,
            },
        )?;
        tree.insert(
            StatePath::parse("port.lines_total")?,
            StateValue::Uint {
                value: self.lines_total as u64,
            },
        )?;
        tree.insert(
            StatePath::parse("port.lines_emitted")?,
            StateValue::Uint {
                value: self.lines_emitted as u64,
            },
        )?;
        tree.insert(
            StatePath::parse("metadata.adapter_name")?,
            StateValue::String {
                value: PORT_ID.to_string(),
            },
        )?;
        Ok(tree)
    }
}
