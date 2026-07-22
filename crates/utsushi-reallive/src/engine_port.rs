//! The real RealLive [`EnginePort`] — drives the substrate text, frame
//! AND audio sinks from a SINGLE real-bytes RealLive replay.
//!
//! This replaces the former inert scaffold (every lifecycle
//! method returned a typed `unimplemented` marker and the port held an
//! EMPTY [`SinkSet`]). That scaffold was the substrate-honesty gap the
//! `docs/audits/substrate-honesty.md` re-grounding flagged (F.2 / I.1):
//! the substrate sinks had NO production producer. [`UtsushiReallivePort`]
//! is that producer.
//!
//! # What drives each sink (all from ONE `observe_scene` run)
//!
//! - **Text**: the real Seen.txt → scene-header → AVG32 inflate →
//!   bytecode-decode → 9-module dispatch chain emits decoded `TextLine`s
//!   through the substrate [`TextSurfaceSink`] (via [`crate::MsgRuntime`]).
//! - **Audio**: the real `bgm` / `koe` / `se` / `wav` opcodes fire during
//!   the same branch-following drive; their [`crate::AudioEvent`]s are
//!   converted to substrate [`AudioEvent`]s (at the substrate audio `E0`
//!   ceiling) and emitted through [`AudioEventSink`].
//! - **Frame**: the real terminal graphics-object stack from that drive is
//!   composited through the real g00 rasteriser ([`RenderPass`]) — real
//!   decoded g00 art in the private full-fidelity buffer, a copyright-safe
//!   edge-outline of that art in the announced public frame — and
//!   announced through [`FrameArtifactSink`] at `EvidenceTier::E2`.
//!
//! The port ALSO drives its declared `Snapshot` and `DeterministicReplay`
//! capabilities for real: it self-verifies snapshot/restore identity at
//! every tick boundary
//! ([`ReplayEngine::verify_branch_snapshot_restore_each_tick`]) and that
//! two replays of the entry scene serialise byte-identically, so those
//! manifest capabilities are BACKED BY EXERCISED MACHINERY rather than
//! advertised-but-inert.
//!
//! # Clean-room provenance
//!
//! See [`crate::RLVM_RESEARCH_ANCHOR_BOUNDARY_STATEMENT`]. No rlvm source
//! is vendored, linked, or mechanically translated. The `use_xor_2`
//! segment-cipher recovery for encrypted titles is a dev-only
//! `kaifuu-reallive` concern staged by the caller BEFORE constructing the
//! port (the port consumes a pre-decoded [`ReplayEngine`]); no key material
//! lives in this crate.

use std::sync::{Arc, Mutex};

use utsushi_core::substrate::{
    AssetPackage, AudioEvent, AudioEventSink, CapabilityDeclaration, CapabilityStance,
    CaptureOutcome, EngineParityProfile, EnginePort, EnginePortError, EvidenceTier, FidelityTier,
    FrameArtifact, FrameArtifactSink, LifecycleStage, PortCapability, PortManifest, PortRequest,
    PortShutdownOutcome, REQUIRED_LIFECYCLE_STAGES, SinkCapability, SinkResult, SinkSet, TextLine,
    TextSurfaceSink,
};
// `RuntimeArtifactRoot`, `RuntimeArtifactKind`, and `runtime_artifact_uri`
// remain public crate-root helpers used to materialize managed artifacts.
use utsushi_core::{
    RuntimeArtifactKind, RuntimeArtifactRoot, RuntimeOperation, runtime_artifact_uri,
};

use crate::audio::{AudioEvent as RealliveAudioEvent, AudioEventPayload};
use crate::gameexe::MessageWindowConfig;
use crate::render_pipeline::{RecordingFrameArtifactSink, RenderPass, SceneEmit, TextLayer};
use crate::replay::{ReplayEngine, ReplayLog, ReplayOpts, SceneObservation};
use crate::rlop::HeadlessChoicePolicy;
use crate::vm::SceneId;

/// Stable port id used by the manifest and by audit tooling.
const PORT_ID: &str = "utsushi-reallive";

/// Crate semantic version, sourced from Cargo metadata.
const PORT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Step budget for the observation drive. Sized so a VN opening reaches
/// its BGM start + first background load + first dialogue lines; an
/// event-gated spin cannot exceed it.
const OBSERVE_STEP_BUDGET: u32 = 50_000;

/// Step budget for the per-tick snapshot/restore-identity proof. Kept
/// small so the O(state) per-tick snapshot cost stays bounded while still
/// verifying identity at many real tick boundaries.
const SNAPSHOT_PROOF_STEP_BUDGET: u32 = 2_000;

/// Step budget for the deterministic-replay proof (linear-walk cataloguing
/// replay, serialised twice and compared).
const DETERMINISM_PROOF_STEP_BUDGET: u32 = 50_000;

/// Env var that overrides how many leading play-order messages the
/// playthrough sequence renders — one frame per message. A real scene can
/// produce hundreds of messages; the bound keeps `launch` from emitting
/// thousands of frames while still rendering a playable through-line.
/// Overridden per-port by [`UtsushiReallivePort::with_playthrough_max`].
const PLAYTHROUGH_MAX_ENV: &str = "ITOTORI_PLAYTHROUGH_MAX";

/// Default playthrough-sequence bound when neither
/// [`UtsushiReallivePort::with_playthrough_max`] nor [`PLAYTHROUGH_MAX_ENV`]
/// is set: render the first N play-order messages, each to its own frame.
const DEFAULT_PLAYTHROUGH_MAX: usize = 8;

/// How many consecutive scenes the multi-scene playthrough observation
/// follows across the real scene-dispatch (jump / farcall / return into
/// another SEEN present in the store) before stopping. Keeps `launch` from
/// walking the whole game while still crossing ≥1 scene boundary so the
/// rendered through-line spans scene A → scene B.
const PLAYTHROUGH_MAX_SCENES: usize = 4;

// Production sink collectors
//
// The port's live `SinkSet` holds these three buffering sinks. The runner
// drains them per tick (text → frame → audio). They ARE the substrate sink
// contracts (`&self` emit + drain, interior mutability), not a bypass.

#[derive(Debug, Default)]
struct PortTextSink {
    lines: Mutex<Vec<TextLine>>,
}

impl TextSurfaceSink for PortTextSink {
    fn capability(&self) -> SinkCapability {
        SinkCapability::Supported {
            evidence_tier_ceiling: EvidenceTier::E1,
        }
    }

    fn emit_line(&self, line: TextLine) -> SinkResult<()> {
        line.validate()?;
        self.lines.lock().expect("PortTextSink lock").push(line);
        Ok(())
    }

    fn drain_lines(&self) -> Vec<TextLine> {
        std::mem::take(&mut *self.lines.lock().expect("PortTextSink lock"))
    }
}

#[derive(Debug, Default)]
struct PortFrameSink {
    frames: Mutex<Vec<FrameArtifact>>,
}

impl FrameArtifactSink for PortFrameSink {
    fn capability(&self) -> SinkCapability {
        SinkCapability::Supported {
            evidence_tier_ceiling: EvidenceTier::E2,
        }
    }

    fn emit_frame(&self, frame: FrameArtifact) -> SinkResult<()> {
        frame.validate()?;
        self.frames.lock().expect("PortFrameSink lock").push(frame);
        Ok(())
    }

    fn drain_frames(&self) -> Vec<FrameArtifact> {
        std::mem::take(&mut *self.frames.lock().expect("PortFrameSink lock"))
    }
}

#[derive(Debug, Default)]
struct PortAudioSink {
    events: Mutex<Vec<AudioEvent>>,
}

impl AudioEventSink for PortAudioSink {
    fn capability(&self) -> SinkCapability {
        SinkCapability::Supported {
            evidence_tier_ceiling: EvidenceTier::E0,
        }
    }

    fn emit_event(&self, event: AudioEvent) -> SinkResult<()> {
        event.validate()?;
        self.events.lock().expect("PortAudioSink lock").push(event);
        Ok(())
    }

    fn drain_events(&self) -> Vec<AudioEvent> {
        std::mem::take(&mut *self.events.lock().expect("PortAudioSink lock"))
    }
}

/// Convert an engine-emitted [`RealliveAudioEvent`] into a substrate
/// [`AudioEvent`] at the substrate audio `E0` ceiling. The engine carrier
/// pins `E1` (it consumed real NWA/OVK bytes); the substrate audio sink
/// caps at `E0` ("audio metadata is not playback parity"), so the port
/// down-declares to `E0` at the emission boundary — the honest tier for a
/// headless audio-event announcement.
fn to_substrate_audio(event: &RealliveAudioEvent) -> AudioEvent {
    let cue_id = match event.payload() {
        AudioEventPayload::Asset { asset_id } => Some(asset_id.clone()),
        AudioEventPayload::Voice {
            archive_id,
            sample_id,
        } => Some(format!("{archive_id}#{sample_id}")),
        AudioEventPayload::Stop { cue_id }
        | AudioEventPayload::VoiceStop { cue_id }
        | AudioEventPayload::Marker { cue_id } => Some(cue_id.clone()),
    };
    AudioEvent {
        event_id: event.event_id.clone(),
        evidence_tier: EvidenceTier::E0,
        event_kind: event.event_kind,
        cue_id,
        // The engine's `(archive_id, sample_id)` / asset labels are not
        // `vfs://` asset ids, so they surface through `cue_id`; leave the
        // typed `source_asset` empty rather than manufacture an id.
        source_asset: None,
        bridge_ref: None,
        frame_index: None,
    }
}

/// The real RealLive engine port. Owns a pre-decoded [`ReplayEngine`] (the
/// caller stages any `use_xor_2` recovery before constructing), the g00
/// asset package the frame compositor reads, and the entry scene the
/// observation drive starts from.
pub struct UtsushiReallivePort {
    engine: ReplayEngine,
    assets: Arc<dyn AssetPackage>,
    entry_scene: SceneId,
    /// The `#WINDOW.000` message-window layout read from the game's
    /// `Gameexe.ini` — drives the dialogue box position/colour/alpha
    /// font-size/insets + the `NAME_MOD` name box. Config-driven, not
    /// hardcoded.
    window_config: MessageWindowConfig,
    /// The game's declared framebuffer / virtual screen space the
    /// `window_config` coordinates live in (`Gameexe.screen_size_px`).
    /// The render pass is built at THIS size, so every game renders in its
    /// own declared coordinate space — no baked-in canvas.
    screen_size: (u32, u32),

    text_sink: Arc<PortTextSink>,
    frame_sink: Arc<PortFrameSink>,
    audio_sink: Arc<PortAudioSink>,
    sink_set: SinkSet,

    buffered_text: Vec<TextLine>,
    buffered_frames: Vec<FrameArtifact>,
    buffered_audio: Vec<AudioEvent>,
    /// The REAL play-order message bodies (single pass, branch-following)
    /// the scene produces — the SAME decoded text the substrate text sink
    /// emits for the driven scene, in the order a player sees them. Each
    /// leading message (up to the playthrough bound) is rendered to its OWN
    /// frame; this field carries the whole play-order stream.
    frame_text_lines: Vec<String>,
    /// The play-order message body rendered into each emitted playthrough
    /// frame, in frame order: `playthrough_frame_messages[i]` is the message
    /// composited into frame `i`. Equals `frame_text_lines[..N]` where `N`
    /// is the rendered count (the play-order length capped at the bound).
    /// This is the audit-grade frame→message mapping: a regression that
    /// rendered only message #0, or repeated one message, would break the
    /// 1:1 correspondence recorded here.
    playthrough_frame_messages: Vec<String>,
    /// The scene id each emitted playthrough frame belongs to, in frame order
    /// (`playthrough_frame_scene_ids[i]` is the scene of frame `i`). Distinct
    /// values across the vector prove the rendered playthrough CROSSED a scene
    /// boundary (a regression that stopped at the entry scene yields a single
    /// distinct id). Parallel to [`Self::playthrough_frame_messages`].
    playthrough_frame_scene_ids: Vec<SceneId>,
    /// Optional per-port override for the playthrough-sequence bound. `None`
    /// falls back to [`PLAYTHROUGH_MAX_ENV`] then [`DEFAULT_PLAYTHROUGH_MAX`].
    playthrough_max: Option<usize>,
    emitted: bool,
    launched: bool,
    shut_down: bool,

    snapshot_ticks_verified: u32,
    deterministic_replay_verified: bool,
    observation_steps: u32,
    reached_natural_terminus: bool,
    /// The single-scene deterministic replay-review log produced during a
    /// `ReplayReview` lifecycle. It is retained after shutdown so the CLI
    /// adapter can publish the legacy replay-log JSON surface without
    /// driving a second free-standing runtime path.
    replay_log: Option<ReplayLog>,
}

impl std::fmt::Debug for UtsushiReallivePort {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("UtsushiReallivePort")
            .field("entry_scene", &self.entry_scene)
            .field("scenes_in_store", &self.engine.scene_ids().len())
            .field("launched", &self.launched)
            .field("buffered_text", &self.buffered_text.len())
            .field("buffered_frames", &self.buffered_frames.len())
            .field("buffered_audio", &self.buffered_audio.len())
            .field("frame_text_lines", &self.frame_text_lines.len())
            .field("snapshot_ticks_verified", &self.snapshot_ticks_verified)
            .field(
                "deterministic_replay_verified",
                &self.deterministic_replay_verified,
            )
            .finish()
    }
}

impl UtsushiReallivePort {
    /// Audit-grade manifest declaration. `Snapshot`
    /// `DeterministicReplay` are declared because the port DRIVES them (see
    /// [`Self::launch`]) — not advertised-but-inert.
    pub const MANIFEST: PortManifest = PortManifest {
        id: PORT_ID,
        name: "Utsushi RealLive Engine Port",
        version: PORT_VERSION,
        abi_version: 1,
        capabilities: &[
            PortCapability::Launch,
            PortCapability::Observe,
            PortCapability::Capture,
            PortCapability::Shutdown,
            // Driven for real in `launch`: snapshot/restore identity at
            // every tick boundary, and byte-deterministic replay.
            PortCapability::Snapshot,
            PortCapability::DeterministicReplay,
            // The same launch/observe lifecycle also produces the
            // scene-scoped deterministic replay-review log consumed by the
            // CLI adapter.
            PortCapability::ReplayReview,
        ],
        required_methods: REQUIRED_LIFECYCLE_STAGES,
        optional_methods: &[],
        env_schema: &[],
        fidelity_tier_max: FidelityTier::LayoutProbe,
        evidence_tier_max: EvidenceTier::E2,
        limitations: &[
            "Encrypted RealLive titles (use_xor_2) require the dev-only kaifuu-reallive segment-cipher recovery staged by the caller before constructing the port; no key material lives in this crate.",
            "rlvm is referenced as a research anchor only; no rlvm source is vendored, linked, or mechanically translated.",
        ],
    };

    /// Cross-engine capability parity profile (UTSUSHI parity gate). The
    /// RealLive port is the interpreter-backed reference: it OWNS the VM and
    /// wires every REQUIRED capability plus the port-driven `Snapshot`
    /// `DeterministicReplay` capabilities. The one contract capability it does
    /// not wire is `Jump` (jump-to-moment): the `EnginePort::jump` optional
    /// lifecycle method is on the reference VM's roadmap but not yet driven
    /// here, so it is declared dev-`Pending`. No engine wires `Jump` today, so
    /// it also stays a uniform framework limitation — the declaration records
    /// intent, never a permanent one-engine gap.
    pub const PARITY_PROFILE: EngineParityProfile = EngineParityProfile {
        manifest: Self::MANIFEST,
        declarations: &[CapabilityDeclaration {
            capability: PortCapability::Jump,
            stance: CapabilityStance::Pending,
            note: "dev: jump-to-moment (EnginePort::jump) is on the reference-VM roadmap but not yet wired; no engine wires it yet.",
        }],
    };

    /// Construct the port over a pre-decoded [`ReplayEngine`], the g00
    /// asset package the frame compositor reads, the entry scene to drive
    /// from (the game's `#SEEN_START`), the `#WINDOW.000` message-window
    /// layout ([`crate::Gameexe::message_window`]) that drives the dialogue
    /// box, and the game's declared virtual screen size
    /// ([`crate::Gameexe::screen_size_px`]) the config coordinates live in.
    pub fn new(
        engine: ReplayEngine,
        assets: Arc<dyn AssetPackage>,
        entry_scene: SceneId,
        window_config: MessageWindowConfig,
        screen_size: (u32, u32),
    ) -> Self {
        let text_sink = Arc::new(PortTextSink::default());
        let frame_sink = Arc::new(PortFrameSink::default());
        let audio_sink = Arc::new(PortAudioSink::default());
        let sink_set = SinkSet::new()
            .with_text(Arc::clone(&text_sink) as Arc<dyn TextSurfaceSink>)
            .with_frame(Arc::clone(&frame_sink) as Arc<dyn FrameArtifactSink>)
            .with_audio(Arc::clone(&audio_sink) as Arc<dyn AudioEventSink>);
        Self {
            engine,
            assets,
            entry_scene,
            window_config,
            screen_size,
            text_sink,
            frame_sink,
            audio_sink,
            sink_set,
            buffered_text: Vec::new(),
            buffered_frames: Vec::new(),
            buffered_audio: Vec::new(),
            frame_text_lines: Vec::new(),
            playthrough_frame_messages: Vec::new(),
            playthrough_frame_scene_ids: Vec::new(),
            playthrough_max: None,
            emitted: false,
            launched: false,
            shut_down: false,
            snapshot_ticks_verified: 0,
            deterministic_replay_verified: false,
            observation_steps: 0,
            reached_natural_terminus: false,
            replay_log: None,
        }
    }

    /// Override the playthrough-sequence bound for this port: render the
    /// first `max` play-order messages, each to its own frame. Takes
    /// precedence over [`PLAYTHROUGH_MAX_ENV`]. A `max` of 0 is clamped to
    /// 1 (a playthrough renders at least its first message). Builder-style
    /// so tests can pin a deterministic bound without touching process env.
    pub fn with_playthrough_max(mut self, max: usize) -> Self {
        self.playthrough_max = Some(max);
        self
    }

    /// The effective playthrough-sequence bound: the per-port override if
    /// set, else [`PLAYTHROUGH_MAX_ENV`], else [`DEFAULT_PLAYTHROUGH_MAX`].
    /// Always ≥ 1.
    fn resolved_playthrough_max(&self) -> usize {
        if let Some(max) = self.playthrough_max {
            return max.max(1);
        }
        std::env::var(PLAYTHROUGH_MAX_ENV)
            .ok()
            .and_then(|raw| raw.trim().parse::<usize>().ok())
            .filter(|parsed| *parsed >= 1)
            .unwrap_or(DEFAULT_PLAYTHROUGH_MAX)
    }

    /// The play-order message body rendered into each emitted playthrough
    /// frame, in frame order (`[i]` = the message composited into frame
    /// `i`). This is the prefix of [`Self::frame_text_lines`] capped at the
    /// playthrough bound — the frame→message correspondence proof. Empty
    /// until `launch` runs.
    pub fn playthrough_frame_messages(&self) -> &[String] {
        &self.playthrough_frame_messages
    }

    /// The scene id each emitted playthrough frame belongs to, in frame order
    /// (`[i]` = the scene of frame `i`). More than one DISTINCT value proves
    /// the rendered playthrough crossed a scene boundary (scene A's messages
    /// over A's background, then scene B's over B's). Parallel to
    /// [`Self::playthrough_frame_messages`]. Empty until `launch` runs.
    pub fn playthrough_frame_scene_ids(&self) -> &[SceneId] {
        &self.playthrough_frame_scene_ids
    }

    /// Tick boundaries at which the port verified snapshot/restore
    /// identity during `launch` (the `Snapshot` capability evidence).
    pub fn snapshot_ticks_verified(&self) -> u32 {
        self.snapshot_ticks_verified
    }

    /// Whether the port proved byte-deterministic replay during `launch`
    /// (the `DeterministicReplay` capability evidence).
    pub fn deterministic_replay_verified(&self) -> bool {
        self.deterministic_replay_verified
    }

    /// Number of VM steps the observation drive executed.
    pub fn observation_steps(&self) -> u32 {
        self.observation_steps
    }

    /// The REAL play-order message bodies (single pass, branch-following)
    /// the driven scene produces during [`Self::launch`] — the SAME decoded
    /// lines, in the SAME order, the substrate text sink emits. Each leading
    /// message (up to the playthrough bound, see
    /// [`Self::playthrough_frame_messages`]) is rendered to its OWN frame;
    /// this is the whole play-order stream. Empty until `launch` runs (or
    /// when the driven scene produced no message).
    pub fn frame_text_lines(&self) -> &[String] {
        &self.frame_text_lines
    }

    /// Replay-review evidence captured by the port during its last
    /// `ReplayReview` lifecycle. The log is scene-scoped even though normal
    /// capture/trace lifecycles may follow a bounded multi-scene playthrough.
    pub fn replay_log(&self) -> Option<&ReplayLog> {
        self.replay_log.as_ref()
    }
}

#[path = "engine_port/lifecycle.rs"]
mod lifecycle;
