//! Cross-sink integration tests for the UTSUSHI-022 substrate.
//!
//! These tests run from outside the `utsushi-core` crate and exercise the
//! public sink API together with the published
//! [`utsushi_core::redaction::reject_unredacted_local_paths`] re-export.

use std::sync::{Arc, Mutex};

use serde_json::Value;
use tempfile::TempDir;

use utsushi_core::{
    AssetId, AudioEvent, AudioEventKind, AudioEventSink, EvidenceTier, FrameArtifact,
    FrameArtifactSink, ObservationArtifactRef, ObservationBridgeRef, RUNTIME_ARTIFACT_URI_ROOT,
    RuntimeArtifactRoot, SinkCapability, SinkError, SinkKind, SinkResult, SinkSet, TextLine,
    TextSurfaceSink, redaction::reject_unredacted_local_paths,
};

struct Collector<T> {
    capability: SinkCapability,
    adapter_id: String,
    items: Mutex<Vec<T>>,
}

impl<T> Collector<T> {
    fn supported(adapter_id: &str, evidence_tier_ceiling: EvidenceTier) -> Self {
        Self {
            capability: SinkCapability::Supported {
                evidence_tier_ceiling,
            },
            adapter_id: adapter_id.to_string(),
            items: Mutex::new(Vec::new()),
        }
    }

    fn drained(&self) -> Vec<T>
    where
        T: Clone,
    {
        self.items.lock().unwrap().clone()
    }
}

impl TextSurfaceSink for Collector<TextLine> {
    fn capability(&self) -> SinkCapability {
        self.capability
    }
    fn emit_line(&self, line: TextLine) -> SinkResult<()> {
        if matches!(self.capability, SinkCapability::Unsupported) {
            return Err(SinkError::UnsupportedKind {
                sink: SinkKind::TextSurface,
                adapter_id: self.adapter_id.clone(),
                reason: "no text".to_string(),
            });
        }
        line.validate()?;
        self.items.lock().unwrap().push(line);
        Ok(())
    }
}

impl FrameArtifactSink for Collector<FrameArtifact> {
    fn capability(&self) -> SinkCapability {
        self.capability
    }
    fn emit_frame(&self, artifact: FrameArtifact) -> SinkResult<()> {
        if matches!(self.capability, SinkCapability::Unsupported) {
            return Err(SinkError::UnsupportedKind {
                sink: SinkKind::FrameArtifact,
                adapter_id: self.adapter_id.clone(),
                reason: "no frames".to_string(),
            });
        }
        artifact.validate()?;
        self.items.lock().unwrap().push(artifact);
        Ok(())
    }
}

impl AudioEventSink for Collector<AudioEvent> {
    fn capability(&self) -> SinkCapability {
        self.capability
    }
    fn emit_event(&self, audio: AudioEvent) -> SinkResult<()> {
        if matches!(self.capability, SinkCapability::Unsupported) {
            return Err(SinkError::UnsupportedKind {
                sink: SinkKind::AudioEvent,
                adapter_id: self.adapter_id.clone(),
                reason: "no audio".to_string(),
            });
        }
        audio.validate()?;
        self.items.lock().unwrap().push(audio);
        Ok(())
    }
}

const RUN_ID: &str = "0190a000-0000-7000-8000-000000000001";
const FRAME_ID: &str = "0190a000-0000-7000-8000-000000000002";

fn managed_uri() -> String {
    format!("{RUNTIME_ARTIFACT_URI_ROOT}/{RUN_ID}/screenshots/{FRAME_ID}.png")
}

fn write_managed_frame() -> TempDir {
    let temp = TempDir::new().expect("tempdir");
    let root = RuntimeArtifactRoot::new(temp.path());
    root.prepare().expect("prepare");
    root.write_bytes(&managed_uri(), &[0u8; 4]).expect("write");
    temp
}

#[test]
fn sink_output_passes_reject_unredacted_local_paths() {
    let _temp = write_managed_frame();

    let text: Arc<Collector<TextLine>> =
        Arc::new(Collector::supported("synthetic-json", EvidenceTier::E1));
    let frame: Arc<Collector<FrameArtifact>> =
        Arc::new(Collector::supported("headless-capture", EvidenceTier::E2));
    let audio: Arc<Collector<AudioEvent>> =
        Arc::new(Collector::supported("synthetic-json", EvidenceTier::E0));

    let set = SinkSet::new()
        .with_text(text.clone())
        .with_frame(frame.clone())
        .with_audio(audio.clone());

    let line = TextLine {
        line_id: "line-1".to_string(),
        evidence_tier: EvidenceTier::E1,
        text: "hello world".to_string(),
        speaker: Some("narrator".to_string()),
        text_surface: Some("adv".to_string()),
        bridge_ref: Some(ObservationBridgeRef {
            bridge_unit_id: Some("0190a000-0000-7000-8000-00000000aaaa".to_string()),
            source_unit_key: Some("intro/line/1".to_string()),
            runtime_object_id: None,
        }),
        source_asset: Some(AssetId::parse("vfs://www/data/Map001.json").unwrap()),
    };
    set.text().unwrap().emit_line(line).expect("text accepted");

    let artifact = FrameArtifact {
        frame_id: FRAME_ID.to_string(),
        evidence_tier: EvidenceTier::E2,
        artifact_ref: ObservationArtifactRef {
            artifact_id: FRAME_ID.to_string(),
            artifact_kind: "screenshot".to_string(),
            uri: managed_uri(),
            media_type: Some("image/png".to_string()),
        },
        width: Some(1920),
        height: Some(1080),
        frame_index: 7,
        bridge_ref: None,
    };
    set.frame()
        .unwrap()
        .emit_frame(artifact)
        .expect("frame accepted");

    let event = AudioEvent {
        event_id: "event-bgm-1".to_string(),
        evidence_tier: EvidenceTier::E0,
        event_kind: AudioEventKind::BgmStart,
        cue_id: Some("bgm.field.1".to_string()),
        source_asset: Some(AssetId::parse("vfs://www/audio/bgm/Field1.ogg").unwrap()),
        bridge_ref: None,
        frame_index: Some(7),
    };
    set.audio()
        .unwrap()
        .emit_event(event)
        .expect("audio accepted");

    let lines: Vec<Value> = text
        .drained()
        .iter()
        .map(|line| serde_json::to_value(line).unwrap())
        .collect();
    let frames: Vec<Value> = frame
        .drained()
        .iter()
        .map(|frame| serde_json::to_value(frame).unwrap())
        .collect();
    let events: Vec<Value> = audio
        .drained()
        .iter()
        .map(|event| serde_json::to_value(event).unwrap())
        .collect();

    let combined = serde_json::json!({
        "textLines": lines,
        "frameArtifacts": frames,
        "audioEvents": events,
    });
    reject_unredacted_local_paths("", &combined)
        .expect("cross-sink clean emission passes redaction filter");
}

// The former `runtime_request_with_sinks_*` tests pinned a dead
// `RuntimeRequest.sinks` field. That legacy plumbing was deleted: a port
// owns its sinks through `EnginePort::sink_set()` and the runner drains
// them per tick, so `RuntimeRequest` no longer carries a `SinkSet`. The
// "Debug does not expose the implementor type" invariant now lives on
// `SinkSet` itself (`sink::set::tests::sink_set_debug_does_not_expose_implementor_type`).
