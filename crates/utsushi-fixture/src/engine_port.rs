//! Engine-port implementation for the synthetic fixture runtime
//! (UTSUSHI-224 sinks-bridge migration).
//!
//! [`FixtureEnginePort`] is the substrate alpha gate's "≥1 non-test
//! consumer of each sink subsystem outside `utsushi-core`". It owns a
//! [`FixtureObservationSinks`] container (text + frame buffers shaped as
//! `Mutex<Vec<_>>`) and pushes one [`TextLine`] emission per
//! [`EnginePort::observe`] call until the fixture source is exhausted,
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

use utsushi_core::{
    AssetId, AudioEventSink, CapabilityDeclaration, CapabilityStance, CaptureOutcome,
    EngineParityProfile, EnginePort, EnginePortError, EvidenceTier, FidelityTier, FrameArtifact,
    FrameArtifactSink, LifecycleStage, ObservationArtifactRef, ObservationBridgeRef,
    PortCapability, PortManifest, PortRequest, PortShutdownOutcome, REQUIRED_LIFECYCLE_STAGES,
    RuntimeArtifactKind, RuntimeArtifactRoot, SinkCapability, SinkError, SinkKind, SinkResult,
    SinkSet, TextLine, TextSurfaceSink,
};

/// Schema-version literal advertised on the legacy
/// `observationHookEvents[]` JSON envelopes the fixture still produces in
/// its `RuntimeAdapter` reports. The `utsushi-core` Rust type that owned
/// this constant was deleted by UTSUSHI-224; the fixture re-exports the
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
pub struct FixtureEnginePort {
    state: PortState,
    sinks: FixtureObservationSinks,
    queued_lines: Vec<TextLine>,
    queued_frames: Vec<FrameArtifact>,
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
        limitations: &["Synthetic fixture engine port; emits deterministic sink payloads only."],
    };

    /// Cross-engine capability parity profile (UTSUSHI parity gate). The
    /// fixture wires the four required lifecycle capabilities; the
    /// port-driven `Snapshot` / `DeterministicReplay` capabilities (which
    /// `utsushi-reallive` wires) are declared dev-`Pending` — the synthetic
    /// fixture does not yet exercise the substrate snapshot/replay
    /// primitives, but nothing precludes it, so this is a dev gap, never a
    /// permanent one-engine hole.
    pub const PARITY_PROFILE: EngineParityProfile = EngineParityProfile {
        manifest: Self::MANIFEST,
        declarations: &[
            CapabilityDeclaration {
                capability: PortCapability::Snapshot,
                stance: CapabilityStance::Pending,
                note: "dev: the synthetic fixture does not yet drive the substrate snapshot primitives; no engine-specific reason it cannot.",
            },
            CapabilityDeclaration {
                capability: PortCapability::DeterministicReplay,
                stance: CapabilityStance::Pending,
                note: "dev: the synthetic fixture does not yet drive the substrate deterministic-replay primitives.",
            },
        ],
    };

    pub fn new() -> Self {
        Self {
            state: PortState::Idle,
            sinks: FixtureObservationSinks::new(),
            queued_lines: Vec::new(),
            queued_frames: Vec::new(),
            capture_target: None,
            shut_down: false,
        }
    }

    pub fn sinks(&self) -> &FixtureObservationSinks {
        &self.sinks
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
