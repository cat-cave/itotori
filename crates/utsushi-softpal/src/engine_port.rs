//! The Softpal runtime [`EnginePort`]: executes the extracted `Sv20`
//! scene-dispatch and drives the substrate text + frame sinks from it.
//!
//! `launch` runs the whole scene program once ([`SoftpalScene::execute`]),
//! buffering a `TextLine` per dialogue line + per text-bearing choice option
//! and a bounded playthrough of edge-redacted layout frames (one per leading
//! dialogue line). `observe` drains those buffers into the sinks; `capture`
//! writes a representative redacted PNG through the managed artifact store.

use std::sync::{Arc, Mutex};

use utsushi_core::substrate::{
    CapabilityDeclaration, CapabilityStance, CaptureOutcome, EngineParityProfile, EnginePort,
    EnginePortError, EvidenceTier, FidelityTier, FrameArtifact, FrameArtifactSink, LifecycleStage,
    ObservationArtifactRef, PortCapability, PortManifest, PortRequest, PortShutdownOutcome,
    REQUIRED_LIFECYCLE_STAGES, SinkCapability, SinkResult, SinkSet, TextLine, TextSurfaceSink,
};
use utsushi_core::{RuntimeArtifactKind, RuntimeArtifactRoot, runtime_artifact_uri};

use crate::scene_render::{SoftpalRedaction, encode_softpal_png, render_dialogue_frame};
use crate::scene_runtime::{SceneStep, SoftpalScene};

const PORT_ID: &str = "utsushi-softpal";
const PORT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Default number of leading dialogue lines rendered to their own frame.
const DEFAULT_PLAYTHROUGH_MAX: usize = 6;

/// Extracted-scene configuration for [`UtsushiSoftpalPort`].
#[derive(Clone, Default)]
pub struct UtsushiSoftpalPortContext {
    script_bytes: Option<Arc<Vec<u8>>>,
    textdat_bytes: Option<Arc<Vec<u8>>>,
    title: Option<String>,
}

impl UtsushiSoftpalPortContext {
    /// An empty context inspects capabilities but cannot launch a run.
    pub fn empty() -> Self {
        Self::default()
    }

    /// A short title/label carried into the capture summary (never a host path).
    pub fn title(&self) -> Option<&str> {
        self.title.as_deref()
    }
}

impl std::fmt::Debug for UtsushiSoftpalPortContext {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("UtsushiSoftpalPortContext")
            .field("script_bytes", &self.script_bytes.as_ref().map(|b| b.len()))
            .field(
                "textdat_bytes",
                &self.textdat_bytes.as_ref().map(|b| b.len()),
            )
            .field("title", &self.title)
            .finish()
    }
}

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

/// The Softpal runtime engine port.
pub struct UtsushiSoftpalPort {
    context: UtsushiSoftpalPortContext,
    text_sink: Arc<PortTextSink>,
    frame_sink: Arc<PortFrameSink>,
    sink_set: SinkSet,
    playthrough_max: usize,

    scene: Option<SoftpalScene>,
    buffered_text: Vec<TextLine>,
    buffered_frames: Vec<FrameArtifact>,
    rendered_dialogue: Vec<String>,

    launched: bool,
    emitted: bool,
    shut_down: bool,
}

impl std::fmt::Debug for UtsushiSoftpalPort {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("UtsushiSoftpalPort")
            .field("title", &self.context.title)
            .field("launched", &self.launched)
            .field("buffered_text", &self.buffered_text.len())
            .field("buffered_frames", &self.buffered_frames.len())
            .field(
                "dialogue_count",
                &self.scene.as_ref().map(|scene| scene.stats.dialogue_count),
            )
            .finish()
    }
}

impl UtsushiSoftpalPort {
    /// Audit-grade manifest. The port wires Launch + Observe + Capture +
    /// Shutdown — it EXECUTES the scene-dispatch (Observe) and CAPTURES a
    /// layout frame, matching the RealLive reference's core surface.
    pub const MANIFEST: PortManifest = PortManifest {
        id: PORT_ID,
        name: "Utsushi Softpal Sv20 Runtime Port",
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
        fidelity_tier_max: FidelityTier::LayoutProbe,
        evidence_tier_max: EvidenceTier::E2,
        limitations: &[
            "Executes the linear Sv20 scene-dispatch the kaifuu-softpal disassembler proves (0-unknown on two real titles); it does not evaluate Sv20 expression values or resolve conditional jumps (Pal.dll semantics), so branch selection is deterministic-first, not a branch-following interpreter.",
            "Captured frames are message-box LAYOUT probes (geometry + text-extent bars), edge-redacted by default; Softpal background-CG decode is out of scope, so no source pixels are composited or persisted.",
            "Softpal VM snapshot, deterministic replay, and replay-review remain future work; the decoded dialogue/choice stream is cross-checked against the resolved bridge disassembly.",
        ],
    };

    /// Cross-engine capability parity profile (UTSUSHI parity gate). The port
    /// wires the four required lifecycle capabilities; the VM-backed
    /// Snapshot / DeterministicReplay / ReplayReview (wired by the RealLive
    /// reference) and Jump are declared dev-`Pending`, never permanently N/A.
    pub const PARITY_PROFILE: EngineParityProfile = EngineParityProfile {
        manifest: Self::MANIFEST,
        declarations: &[
            CapabilityDeclaration {
                capability: PortCapability::Jump,
                stance: CapabilityStance::Pending,
                note: "dev: jump-to-moment needs Sv20 jump-target resolution (Pal.dll); no engine wires it yet.",
            },
            CapabilityDeclaration {
                capability: PortCapability::Snapshot,
                stance: CapabilityStance::Pending,
                note: "dev: a Softpal VM state model is not yet built, so snapshot/restore is unwired.",
            },
            CapabilityDeclaration {
                capability: PortCapability::DeterministicReplay,
                stance: CapabilityStance::Pending,
                note: "dev: deterministic replay awaits the Softpal VM state model.",
            },
            CapabilityDeclaration {
                capability: PortCapability::ReplayReview,
                stance: CapabilityStance::Pending,
                note: "dev: no replay-review surface exists without a Softpal VM.",
            },
        ],
    };

    /// An unconfigured port. Its `launch` fails, telling callers to supply the
    /// extracted `SCRIPT.SRC` + `TEXT.DAT` rather than silently doing nothing.
    pub fn new() -> Self {
        Self::from_context(UtsushiSoftpalPortContext::empty())
    }

    /// Construct the port over the extracted `SCRIPT.SRC` + `TEXT.DAT` bytes of
    /// one Softpal title (the caller stages the PAC extraction), with a short
    /// title label carried into the capture summary.
    pub fn with_extracted_scene(
        script_bytes: Vec<u8>,
        textdat_bytes: Vec<u8>,
        title: impl Into<String>,
    ) -> Self {
        Self::from_context(UtsushiSoftpalPortContext {
            script_bytes: Some(Arc::new(script_bytes)),
            textdat_bytes: Some(Arc::new(textdat_bytes)),
            title: Some(title.into()),
        })
    }

    fn from_context(context: UtsushiSoftpalPortContext) -> Self {
        let text_sink = Arc::new(PortTextSink::default());
        let frame_sink = Arc::new(PortFrameSink::default());
        let sink_set = SinkSet::new()
            .with_text(Arc::clone(&text_sink) as Arc<dyn TextSurfaceSink>)
            .with_frame(Arc::clone(&frame_sink) as Arc<dyn FrameArtifactSink>);
        Self {
            context,
            text_sink,
            frame_sink,
            sink_set,
            playthrough_max: DEFAULT_PLAYTHROUGH_MAX,
            scene: None,
            buffered_text: Vec::new(),
            buffered_frames: Vec::new(),
            rendered_dialogue: Vec::new(),
            launched: false,
            emitted: false,
            shut_down: false,
        }
    }

    /// Override how many leading dialogue lines are rendered to frames.
    #[must_use]
    pub fn with_playthrough_max(mut self, max: usize) -> Self {
        self.playthrough_max = max.max(1);
        self
    }

    /// Borrow the executed scene (present after a successful `launch`).
    pub fn scene(&self) -> Option<&SoftpalScene> {
        self.scene.as_ref()
    }

    /// The leading dialogue lines that were rendered to their own frame, in
    /// frame order — the frame -> dialogue correspondence.
    pub fn rendered_dialogue(&self) -> &[String] {
        &self.rendered_dialogue
    }

    fn lifecycle_error(stage: LifecycleStage, message: impl Into<String>) -> EnginePortError {
        EnginePortError::Lifecycle {
            stage,
            message: message.into(),
            source: None,
        }
    }

    fn build_text_lines(scene: &SoftpalScene) -> Vec<TextLine> {
        let mut lines = Vec::new();
        let mut dialogue_index = 0usize;
        let mut choice_index = 0usize;
        for step in &scene.steps {
            match step {
                SceneStep::Dialogue { speaker, text, .. } => {
                    lines.push(text_line(
                        format!("softpal-dialogue-{dialogue_index}"),
                        text.clone(),
                        speaker.clone(),
                        "adv",
                    ));
                    dialogue_index += 1;
                }
                SceneStep::Choice { options, .. } => {
                    for option in options {
                        if let Some(text) = &option.text {
                            lines.push(text_line(
                                format!("softpal-choice-{choice_index}"),
                                text.clone(),
                                None,
                                "choice",
                            ));
                            choice_index += 1;
                        }
                    }
                }
            }
        }
        lines
    }

    fn render_frames(
        &mut self,
        scene: &SoftpalScene,
        root: &RuntimeArtifactRoot,
        run_id: &str,
    ) -> Result<Vec<FrameArtifact>, EnginePortError> {
        root.prepare().map_err(|error| {
            Self::lifecycle_error(LifecycleStage::Launch, format!("artifact root: {error}"))
        })?;
        let mut frames = Vec::new();
        for (speaker, text) in scene.dialogue_lines().take(self.playthrough_max) {
            let index = frames.len();
            let frame = render_dialogue_frame(speaker, text, SoftpalRedaction::default());
            let png = encode_softpal_png(&frame).map_err(|error| {
                Self::lifecycle_error(LifecycleStage::Launch, format!("png encode: {error}"))
            })?;
            let artifact_id = format!("softpal-frame-{index}");
            let uri = runtime_artifact_uri(run_id, RuntimeArtifactKind::Screenshot, &artifact_id)
                .map_err(|error| {
                Self::lifecycle_error(LifecycleStage::Launch, format!("frame uri: {error}"))
            })?;
            root.write_bytes(&uri, &png).map_err(|error| {
                Self::lifecycle_error(LifecycleStage::Launch, format!("frame write: {error}"))
            })?;
            frames.push(FrameArtifact {
                frame_id: artifact_id.clone(),
                evidence_tier: EvidenceTier::E2,
                artifact_ref: ObservationArtifactRef {
                    artifact_id,
                    artifact_kind: "screenshot".to_string(),
                    uri,
                    media_type: Some("image/png".to_string()),
                },
                width: Some(frame.width),
                height: Some(frame.height),
                frame_index: index as u64,
                bridge_ref: None,
            });
            self.rendered_dialogue.push(text.to_string());
        }
        Ok(frames)
    }
}

impl Default for UtsushiSoftpalPort {
    fn default() -> Self {
        Self::new()
    }
}

impl EnginePort for UtsushiSoftpalPort {
    const MANIFEST: PortManifest = Self::MANIFEST;

    fn launch(&mut self, request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        request.cancellation.check(LifecycleStage::Launch)?;
        if self.launched {
            return Ok(());
        }
        let (Some(script), Some(textdat)) =
            (&self.context.script_bytes, &self.context.textdat_bytes)
        else {
            return Err(Self::lifecycle_error(
                LifecycleStage::Launch,
                "the extracted Softpal SCRIPT.SRC + TEXT.DAT are required to launch",
            ));
        };
        let scene = SoftpalScene::execute(script, textdat)
            .map_err(|error| Self::lifecycle_error(LifecycleStage::Launch, error.to_string()))?;

        self.buffered_text = Self::build_text_lines(&scene);
        if let Some(root) = request.artifact_root {
            self.buffered_frames = self.render_frames(&scene, root, request.run_id)?;
        }
        self.scene = Some(scene);
        self.launched = true;
        Ok(())
    }

    fn observe(&mut self, request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        request.cancellation.check(LifecycleStage::Observe)?;
        if !self.launched {
            return Err(Self::lifecycle_error(
                LifecycleStage::Observe,
                "launch must execute the scene before observe",
            ));
        }
        if self.emitted {
            return Ok(());
        }
        for line in std::mem::take(&mut self.buffered_text) {
            self.text_sink.emit_line(line).map_err(|error| {
                Self::lifecycle_error(LifecycleStage::Observe, error.to_string())
            })?;
        }
        for frame in std::mem::take(&mut self.buffered_frames) {
            self.frame_sink.emit_frame(frame).map_err(|error| {
                Self::lifecycle_error(LifecycleStage::Observe, error.to_string())
            })?;
        }
        self.emitted = true;
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
        let Some(scene) = &self.scene else {
            return Err(Self::lifecycle_error(
                LifecycleStage::Capture,
                "launch must run before capture",
            ));
        };
        let (speaker, text) = scene.dialogue_lines().next().unwrap_or((None, ""));
        let frame = render_dialogue_frame(speaker, text, SoftpalRedaction::default());
        let png = encode_softpal_png(&frame)
            .map_err(|error| Self::lifecycle_error(LifecycleStage::Capture, error.to_string()))?;
        root.prepare().map_err(|error| {
            Self::lifecycle_error(LifecycleStage::Capture, format!("artifact root: {error}"))
        })?;
        let uri = runtime_artifact_uri(
            request.run_id,
            RuntimeArtifactKind::Screenshot,
            "softpal-capture",
        )
        .map_err(|error| Self::lifecycle_error(LifecycleStage::Capture, format!("uri: {error}")))?;
        let path = root.write_bytes(&uri, &png).map_err(|error| {
            Self::lifecycle_error(LifecycleStage::Capture, format!("write: {error}"))
        })?;
        let summary = format!(
            "utsushi-softpal capture: title={} dialogue={} choices={} system_selects={} \
             frames={} redacted=true",
            self.context.title.as_deref().unwrap_or("<unnamed>"),
            scene.stats.dialogue_count,
            scene.stats.text_bearing_choice_count,
            scene.stats.system_select_count,
            self.rendered_dialogue.len(),
        );
        Ok(CaptureOutcome::new(uri)
            .with_path(path)
            .with_summary(summary))
    }

    fn shutdown(&mut self) -> Result<PortShutdownOutcome, EnginePortError> {
        if self.shut_down {
            return Ok(PortShutdownOutcome::already_shut_down());
        }
        // The executed scene + its stats are retained after shutdown (like the
        // RealLive port retains its replay log) so a caller can inspect the
        // run's dialogue/choice accounting once the lifecycle has completed.
        self.buffered_text.clear();
        self.buffered_frames.clear();
        self.shut_down = true;
        Ok(PortShutdownOutcome::clean())
    }
}

fn text_line(line_id: String, text: String, speaker: Option<String>, surface: &str) -> TextLine {
    TextLine {
        line_id,
        evidence_tier: EvidenceTier::E1,
        text,
        speaker,
        color: None,
        text_surface: Some(surface.to_string()),
        bridge_ref: None,
        source_asset: None,
        byte_offset_in_scene: None,
        body_shift_jis: None,
    }
}
