//! Engine-port implementation for the synthetic fixture runtime
//! ( sinks-bridge migration).
//!
//! [`FixtureEnginePort`] is the substrate alpha gate's "≥1 non-test
//! consumer of each sink subsystem outside `utsushi-core`". It owns a
//! [`FixtureObservationSinks`] container (text + frame buffers shaped as
//! `Mutex<Vec<_>>`) and pushes one [`TextLine`] emission per
//! [`EnginePort::observe`] call until the fixture source is exhausted
//! followed by one [`FrameArtifact`] emission for capture/smoke operations.
//! Trace stays text-only so it never reports a frame artifact URI without the
//! capture stage materializing that file. The runner drains the sinks per tick
//! (text → frame → audio) as documented on [`utsushi_core::Runner::tick`].
//!
//! The audio sink is intentionally left absent: the fixture has no audio
//! source, and the substrate's `SinkCapability::Unsupported` posture is
//! the audit-correct surface for "engine port has no audio evidence to
//! announce".

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::Value;

use utsushi_core::substrate::CaptureOutcome;
use utsushi_core::{
    AssetId, AudioEventSink, CapabilityDeclaration, CapabilityStance, EngineParityProfile,
    EnginePort, EnginePortError, EvidenceTier, FidelityTier, FrameArtifact, FrameArtifactSink,
    Inspectable, LifecycleStage, ObservationArtifactRef, ObservationBridgeRef, PortCapability,
    PortManifest, PortRequest, PortShutdownOutcome, REQUIRED_LIFECYCLE_STAGES, RuntimeArtifactKind,
    RuntimeArtifactRoot, SinkCapability, SinkError, SinkKind, SinkResult, SinkSet, SnapshotError,
    StatePath, StateTree, StateValue, TextLine, TextSurfaceSink,
};

/// Schema-version literal advertised on the legacy
/// `observationHookEvents[]` JSON envelopes the fixture still produces in
/// its `RuntimeAdapter` reports. The `utsushi-core` Rust type that owned
/// this constant was deleted by; the fixture re-exports the
/// literal so cli/test consumers can still pin against it.
pub const FIXTURE_OBSERVATION_HOOK_SCHEMA_VERSION: &str = "0.1.0-alpha";

const FIXTURE_PORT_ID: &str = "utsushi-fixture";
const FIXTURE_PORT_VERSION: &str = "0.0.0";
const FIXTURE_CAPTURE_ARTIFACT_ID: &str = "019ed003-0000-7000-8000-000000000004";

/// Collector text sink the fixture engine port owns. Buffers emissions
/// in a `Mutex<Vec<TextLine>>` and surfaces them to the runner via
/// [`TextSurfaceSink::drain_lines`].
pub struct FixtureTextSink {
    buffer: Mutex<Vec<TextLine>>,
}

impl FixtureTextSink {
    pub fn new() -> Self {
        Self {
            buffer: Mutex::new(Vec::new()),
        }
    }
}

impl Default for FixtureTextSink {
    fn default() -> Self {
        Self::new()
    }
}

impl TextSurfaceSink for FixtureTextSink {
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

/// Collector frame sink the fixture engine port owns.
pub struct FixtureFrameSink {
    buffer: Mutex<Vec<FrameArtifact>>,
}

impl FixtureFrameSink {
    pub fn new() -> Self {
        Self {
            buffer: Mutex::new(Vec::new()),
        }
    }
}

impl Default for FixtureFrameSink {
    fn default() -> Self {
        Self::new()
    }
}

impl FrameArtifactSink for FixtureFrameSink {
    fn capability(&self) -> SinkCapability {
        SinkCapability::Supported {
            evidence_tier_ceiling: EvidenceTier::E2,
        }
    }

    fn emit_frame(&self, frame: FrameArtifact) -> SinkResult<()> {
        frame.validate()?;
        self.buffer.lock().expect("frame sink lock").push(frame);
        Ok(())
    }

    fn drain_frames(&self) -> Vec<FrameArtifact> {
        std::mem::take(&mut *self.buffer.lock().expect("frame sink lock"))
    }
}

/// Explicitly-unsupported audio sink. The fixture has no audio source;
/// returning [`SinkError::UnsupportedKind`] from `emit_event` is the
/// audit-correct posture per the §F sink rules. Kept on the `SinkSet` so
/// the substrate's capability-summary surface shows a deliberate
/// `Unsupported` value rather than "absent".
struct FixtureAudioSink;

impl AudioEventSink for FixtureAudioSink {
    fn capability(&self) -> SinkCapability {
        SinkCapability::Unsupported
    }

    fn emit_event(&self, _audio: utsushi_core::AudioEvent) -> SinkResult<()> {
        Err(SinkError::UnsupportedKind {
            sink: SinkKind::AudioEvent,
            adapter_id: FIXTURE_PORT_ID.to_string(),
            reason: "utsushi-fixture port has no audio evidence to announce".to_string(),
        })
    }
}

/// Sink bundle owned by [`FixtureEnginePort`]. The text + frame sinks are
/// reachable through the [`SinkSet`] (so the runner drains them per
/// tick) and through the `text`/`frame` accessors (so the fixture port
/// itself can push into them from `observe()` and `capture()`).
pub struct FixtureObservationSinks {
    text: Arc<FixtureTextSink>,
    frame: Arc<FixtureFrameSink>,
    sink_set: SinkSet,
}

impl FixtureObservationSinks {
    pub fn new() -> Self {
        let text = Arc::new(FixtureTextSink::new());
        let frame = Arc::new(FixtureFrameSink::new());
        let sink_set = SinkSet::new()
            .with_text(text.clone() as Arc<dyn TextSurfaceSink>)
            .with_frame(frame.clone() as Arc<dyn FrameArtifactSink>)
            .with_audio(Arc::new(FixtureAudioSink) as Arc<dyn AudioEventSink>);
        Self {
            text,
            frame,
            sink_set,
        }
    }

    pub fn sink_set(&self) -> &SinkSet {
        &self.sink_set
    }

    pub fn text(&self) -> Arc<FixtureTextSink> {
        self.text.clone()
    }

    pub fn frame(&self) -> Arc<FixtureFrameSink> {
        self.frame.clone()
    }
}

impl Default for FixtureObservationSinks {
    fn default() -> Self {
        Self::new()
    }
}

/// Engine port that exercises the substrate sinks-bridge path against a
/// deterministic in-memory fixture script. Used as the alpha-gate
/// "production consumer outside `utsushi-core`" for the substrate
/// sinks. The port reads `source.json` from `request.input_root` on
/// launch, queues one text line per declared source unit (capped at
/// the script length), and emits a single deterministic frame
/// announcement once the text stream completes.
///
/// The port implements [`Inspectable`] so conformance can snapshot its
/// real lifecycle counters (units loaded, lines/frames emitted, queue
/// depths, lifecycle stage) rather than fabricating a sentinel state
/// tree out of band.
pub struct FixtureEnginePort {
    state: PortState,
    sinks: FixtureObservationSinks,
    queued_lines: Vec<TextLine>,
    queued_frames: Vec<FrameArtifact>,
    /// Units loaded from `source.json` at launch. Survives drain so the
    /// post-run inspectable surface still records what was processed.
    units_loaded: u64,
    lines_emitted: u64,
    frames_emitted: u64,
    capture_target: Option<PathBuf>,
    shut_down: bool,
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

/// Immutable view of the fixture port's inspectable state. Shared by the
/// live [`FixtureEnginePort`] inspect path and the independently prepared
/// golden baseline used by snapshot-restore conformance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FixturePortInspectState {
    pub lifecycle: &'static str,
    pub units_loaded: u64,
    pub queued_lines: u64,
    pub queued_frames: u64,
    pub lines_emitted: u64,
    pub frames_emitted: u64,
    pub shut_down: bool,
}

impl FixturePortInspectState {
    /// Expected post-`run_trace` end state for a fixture source with
    /// `units_loaded` script units. Computed independently of any live
    /// port instance (immutable golden baseline for SnapshotRestore).
    ///
    /// Trace does not queue frames, so after a full drain every unit is
    /// emitted as text, queues are empty, lifecycle is `drained`, and the
    /// runner has shut the port down.
    pub fn expected_post_trace(units_loaded: u64) -> Self {
        Self {
            lifecycle: "drained",
            units_loaded,
            queued_lines: 0,
            queued_frames: 0,
            lines_emitted: units_loaded,
            frames_emitted: 0,
            shut_down: true,
        }
    }

    /// Materialize the shared fixture-port state contract as a
    /// [`StateTree`]. Paths are stable public names under `port.*`
    /// `metadata.*` so golden baselines and live snapshots share the
    /// same schema.
    pub fn to_state_tree(&self) -> Result<StateTree, SnapshotError> {
        let mut tree = StateTree::new();
        tree.insert(
            StatePath::parse("port.state")?,
            StateValue::String {
                value: self.lifecycle.to_string(),
            },
        )?;
        tree.insert(
            StatePath::parse("port.units_loaded")?,
            StateValue::Uint {
                value: self.units_loaded,
            },
        )?;
        tree.insert(
            StatePath::parse("port.queued_lines")?,
            StateValue::Uint {
                value: self.queued_lines,
            },
        )?;
        tree.insert(
            StatePath::parse("port.queued_frames")?,
            StateValue::Uint {
                value: self.queued_frames,
            },
        )?;
        tree.insert(
            StatePath::parse("port.lines_emitted")?,
            StateValue::Uint {
                value: self.lines_emitted,
            },
        )?;
        tree.insert(
            StatePath::parse("port.frames_emitted")?,
            StateValue::Uint {
                value: self.frames_emitted,
            },
        )?;
        tree.insert(
            StatePath::parse("port.shut_down")?,
            StateValue::Uint {
                value: u64::from(self.shut_down),
            },
        )?;
        tree.insert(
            StatePath::parse("metadata.adapter_name")?,
            StateValue::String {
                value: FIXTURE_PORT_ID.to_string(),
            },
        )?;
        Ok(tree)
    }
}

/// Thin [`Inspectable`] wrapping an independently prepared
/// [`FixturePortInspectState`] golden baseline.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FixturePortStateInspectable {
    state: FixturePortInspectState,
}

impl FixturePortStateInspectable {
    pub fn new(state: FixturePortInspectState) -> Self {
        Self { state }
    }

    pub fn state(&self) -> &FixturePortInspectState {
        &self.state
    }
}

impl Inspectable for FixturePortStateInspectable {
    fn inspectable_id(&self) -> &'static str {
        FIXTURE_PORT_ID
    }

    fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
        self.state.to_state_tree()
    }
}

impl FixtureEnginePort {
    pub const MANIFEST: PortManifest = PortManifest {
        id: FIXTURE_PORT_ID,
        name: "Utsushi Fixture Engine Port",
        version: FIXTURE_PORT_VERSION,
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
        fidelity_tier_max: FidelityTier::LayoutProbe,
        evidence_tier_max: EvidenceTier::E2,
        limitations: &[
            "Synthetic fixture engine port; emits deterministic sink payloads only.",
            "Inspect-only: the port implements Inspectable but not Restorable (no controlled-playback restore).",
        ],
    };

    /// Cross-engine capability parity profile (UTSUSHI parity gate). The
    /// fixture wires the four required lifecycle capabilities; the
    /// port-driven `Snapshot` / `DeterministicReplay` capabilities (which
    /// `utsushi-reallive` wires) are declared dev-`Pending` — Inspectable
    /// is wired for snapshot-restore conformance, but Restorable
    /// deterministic replay are not, so this remains a dev gap rather than
    /// a permanent one-engine hole.
    pub const PARITY_PROFILE: EngineParityProfile = EngineParityProfile {
        manifest: Self::MANIFEST,
        declarations: &[
            CapabilityDeclaration {
                capability: PortCapability::Snapshot,
                stance: CapabilityStance::Pending,
                note: "dev: the synthetic fixture is inspect-only (Inspectable, not Restorable); full snapshot round-trip is not yet wired.",
            },
            CapabilityDeclaration {
                capability: PortCapability::DeterministicReplay,
                stance: CapabilityStance::Pending,
                note: "dev: the synthetic fixture does not yet drive the substrate deterministic-replay primitives.",
            },
            CapabilityDeclaration {
                capability: PortCapability::ReplayReview,
                stance: CapabilityStance::Pending,
                note: "dev: replay-review evidence is not yet wired through the synthetic fixture port.",
            },
        ],
    };

    pub fn new() -> Self {
        Self {
            state: PortState::Idle,
            sinks: FixtureObservationSinks::new(),
            queued_lines: Vec::new(),
            queued_frames: Vec::new(),
            units_loaded: 0,
            lines_emitted: 0,
            frames_emitted: 0,
            capture_target: None,
            shut_down: false,
        }
    }

    pub fn sinks(&self) -> &FixtureObservationSinks {
        &self.sinks
    }

    /// Read the live port's inspectable counters into the shared state
    /// contract.
    pub fn inspectable_state(&self) -> FixturePortInspectState {
        FixturePortInspectState {
            lifecycle: self.state.as_str(),
            units_loaded: self.units_loaded,
            queued_lines: self.queued_lines.len() as u64,
            queued_frames: self.queued_frames.len() as u64,
            lines_emitted: self.lines_emitted,
            frames_emitted: self.frames_emitted,
            shut_down: self.shut_down,
        }
    }

    /// Test/conformance helper: deliberately corrupt a live counter so
    /// negative snapshot-restore cases can assert real state drift
    /// against an independently prepared golden baseline.
    pub fn mutate_units_loaded_for_test(&mut self, units_loaded: u64) {
        self.units_loaded = units_loaded;
    }
}

impl Default for FixtureEnginePort {
    fn default() -> Self {
        Self::new()
    }
}

impl EnginePort for FixtureEnginePort {
    const MANIFEST: PortManifest = Self::MANIFEST;

    fn launch(&mut self, request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        request.cancellation.check(LifecycleStage::Launch)?;
        let source_path = request.input_root.join("source.json");
        let raw =
            std::fs::read_to_string(&source_path).map_err(|error| EnginePortError::Lifecycle {
                stage: LifecycleStage::Launch,
                message: format!("fixture source read failed: {error}"),
                source: None,
            })?;
        let source: Value =
            serde_json::from_str(&raw).map_err(|error| EnginePortError::Lifecycle {
                stage: LifecycleStage::Launch,
                message: format!("fixture source parse failed: {error}"),
                source: None,
            })?;

        let game_id = source["gameId"].as_str().unwrap_or("fixture").to_string();
        let units = source["units"].as_array().cloned().unwrap_or_default();
        if units.is_empty() {
            return Err(EnginePortError::Lifecycle {
                stage: LifecycleStage::Launch,
                message: "fixture source has no units".to_string(),
                source: None,
            });
        }

        self.units_loaded = units.len() as u64;
        self.lines_emitted = 0;
        self.frames_emitted = 0;
        self.queued_lines.clear();
        self.queued_frames.clear();

        for (index, unit) in units.iter().enumerate() {
            let source_unit_key = unit["sourceUnitKey"].as_str().unwrap_or("").to_string();
            let text = unit["targetText"]
                .as_str()
                .or_else(|| unit["sourceText"].as_str())
                .unwrap_or("")
                .to_string();
            self.queued_lines.push(TextLine {
                line_id: deterministic_line_id(&game_id, index),
                evidence_tier: EvidenceTier::E1,
                text,
                speaker: unit["speaker"].as_str().map(ToString::to_string),
                color: None,
                text_surface: unit["textSurface"].as_str().map(ToString::to_string),
                bridge_ref: Some(ObservationBridgeRef {
                    bridge_unit_id: Some(deterministic_bridge_unit_id(&game_id, index)),
                    source_unit_key: Some(source_unit_key),
                    runtime_object_id: None,
                }),
                source_asset: AssetId::parse(&format!("vfs://fixture/units/unit-{index:03}.json"))
                    .ok(),
                byte_offset_in_scene: None,
                body_shift_jis: None,
            });
        }

        if !matches!(request.operation, utsushi_core::RuntimeOperation::Trace) {
            // Capture/smoke reports must not announce a frame artifact URI that
            // differs from the file materialised by `capture`. Trace does not
            // run the capture stage, so it must not queue this screenshot ref.
            let artifact_id = FIXTURE_CAPTURE_ARTIFACT_ID.to_string();
            let uri = utsushi_core::runtime_artifact_uri(
                request.run_id,
                RuntimeArtifactKind::Screenshot,
                &artifact_id,
            )
            .map_err(|error| EnginePortError::Lifecycle {
                stage: LifecycleStage::Launch,
                message: format!("fixture capture uri build failed: {error}"),
                source: None,
            })?;
            let bridge_ref = ObservationBridgeRef {
                bridge_unit_id: Some(deterministic_bridge_unit_id(&game_id, 0)),
                source_unit_key: units[0]
                    .get("sourceUnitKey")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                runtime_object_id: None,
            };
            self.queued_frames.push(FrameArtifact {
                frame_id: artifact_id.clone(),
                evidence_tier: EvidenceTier::E2,
                artifact_ref: ObservationArtifactRef {
                    artifact_id,
                    artifact_kind: "screenshot".to_string(),
                    uri,
                    media_type: Some("image/png".to_string()),
                },
                width: Some(320),
                height: Some(180),
                frame_index: 1,
                bridge_ref: Some(bridge_ref),
            });
        }

        self.state = PortState::Launched;
        Ok(())
    }

    fn observe(&mut self, request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        request.cancellation.check(LifecycleStage::Observe)?;
        if self.state == PortState::ShutDown {
            return Err(EnginePortError::Lifecycle {
                stage: LifecycleStage::Observe,
                message: "fixture port observed after shutdown".to_string(),
                source: None,
            });
        }
        // Drain a single text line first; once those are exhausted, push
        // the queued frame; once both queues are empty the runner sees an
        // empty tick and terminates the observation phase.
        if let Some(line) = pop_front(&mut self.queued_lines) {
            self.sinks
                .text
                .emit_line(line)
                .map_err(|error| EnginePortError::Lifecycle {
                    stage: LifecycleStage::Observe,
                    message: format!("text emit failed: {error}"),
                    source: None,
                })?;
            self.lines_emitted = self.lines_emitted.saturating_add(1);
            return Ok(());
        }
        if let Some(frame) = pop_front(&mut self.queued_frames) {
            self.sinks
                .frame
                .emit_frame(frame)
                .map_err(|error| EnginePortError::Lifecycle {
                    stage: LifecycleStage::Observe,
                    message: format!("frame emit failed: {error}"),
                    source: None,
                })?;
            self.frames_emitted = self.frames_emitted.saturating_add(1);
            return Ok(());
        }
        self.state = PortState::Drained;
        Ok(())
    }

    fn sink_set(&self) -> &SinkSet {
        self.sinks.sink_set()
    }

    fn capture(&mut self, request: &PortRequest<'_>) -> Result<CaptureOutcome, EnginePortError> {
        request.cancellation.check(LifecycleStage::Capture)?;
        let root = request
            .artifact_root
            .ok_or_else(|| EnginePortError::Lifecycle {
                stage: LifecycleStage::Capture,
                message: "fixture capture requires an artifact root".to_string(),
                source: None,
            })?;
        let uri = utsushi_core::runtime_artifact_uri(
            request.run_id,
            RuntimeArtifactKind::Screenshot,
            FIXTURE_CAPTURE_ARTIFACT_ID,
        )
        .map_err(|error| EnginePortError::Lifecycle {
            stage: LifecycleStage::Capture,
            message: format!("fixture capture uri build failed: {error}"),
            source: None,
        })?;
        let path = root
            .write_bytes(
                &uri,
                b"utsushi fixture deterministic screenshot placeholder\n",
            )
            .map_err(|error| EnginePortError::Lifecycle {
                stage: LifecycleStage::Capture,
                message: format!("fixture capture write failed: {error}"),
                source: None,
            })?;
        self.capture_target = Some(path.clone());
        Ok(CaptureOutcome::new(uri)
            .with_path(path)
            .with_summary("utsushi-fixture deterministic capture"))
    }

    fn shutdown(&mut self) -> Result<PortShutdownOutcome, EnginePortError> {
        if self.shut_down {
            Ok(PortShutdownOutcome::already_shut_down())
        } else {
            self.shut_down = true;
            Ok(PortShutdownOutcome::clean())
        }
    }
}

impl Inspectable for FixtureEnginePort {
    fn inspectable_id(&self) -> &'static str {
        FIXTURE_PORT_ID
    }

    fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
        self.inspectable_state().to_state_tree()
    }
}

fn pop_front<T>(buffer: &mut Vec<T>) -> Option<T> {
    if buffer.is_empty() {
        None
    } else {
        Some(buffer.remove(0))
    }
}

fn deterministic_line_id(game_id: &str, index: usize) -> String {
    format!("fixture-line:{game_id}:{index:04}")
}

fn deterministic_bridge_unit_id(game_id: &str, index: usize) -> String {
    let hash: u64 = game_id
        .bytes()
        .fold(0xcbf2_9ce4_8422_2325_u64, |acc, byte| {
            acc.wrapping_mul(0x100_0000_01b3).wrapping_add(byte as u64)
        })
        .wrapping_add(index as u64);
    format!(
        "019ed003-0000-7000-8000-{:08x}{:04x}",
        (hash & 0xffff_ffff) as u32,
        index as u16
    )
}

/// Manually-silenced helper so `RuntimeArtifactRoot` import remains in
/// scope without an unused-import diagnostic. The capture path uses the
/// `write_bytes` method on the runner-provided root reference; this
/// shim only exists so a downstream rename of `RuntimeArtifactRoot`
/// surfaces a compile error here too.
// reason: compile-time reference shim so a downstream RuntimeArtifactRoot rename fails here too.
#[allow(dead_code)]
fn _runtime_artifact_root_reference(root: &RuntimeArtifactRoot) -> &std::path::Path {
    root.path()
}
