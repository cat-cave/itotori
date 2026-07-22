use super::*;

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde_json::Value;
use utsushi_core::conformance::capture_recording::{
    ArtifactCountRange, DurationRangeMs, RecordingConformanceCheck,
};
use utsushi_core::sink::{
    AudioEvent, AudioEventKind, AudioEventSink, FrameArtifact, FrameArtifactSink, SinkCapability,
    SinkError, SinkKind, SinkResult,
};
use utsushi_core::{ObservationArtifactRef, runtime_artifact_uri};

const RUN_ID: &str = "smoke-recording-run-000";
const RECORDING_ID: &str = "smoke-recording-000";
pub(super) const FRAME_COUNT: u32 = 3;
const AUDIO_EVENT_COUNT: u32 = 4;
const DURATION_MS: u64 = 1_500;

/// Small in-test frame sink: collects emitted artifacts and exposes a
/// count accessor.
pub(super) struct CollectingFrameSink {
    capability: SinkCapability,
    frames: Mutex<Vec<FrameArtifact>>,
}

impl CollectingFrameSink {
    fn supported() -> Self {
        Self {
            capability: SinkCapability::Supported {
                evidence_tier_ceiling: EvidenceTier::E2,
            },
            frames: Mutex::new(Vec::new()),
        }
    }

    pub(super) fn frame_count(&self) -> u32 {
        u32::try_from(self.frames.lock().expect("frames lock").len()).unwrap_or(u32::MAX)
    }

    pub(super) fn emitted_artifact_refs(&self) -> Vec<ObservationArtifactRef> {
        self.frames
            .lock()
            .expect("frames lock")
            .iter()
            .map(|frame| frame.artifact_ref.clone())
            .collect()
    }
}

impl FrameArtifactSink for CollectingFrameSink {
    fn capability(&self) -> SinkCapability {
        self.capability
    }

    fn emit_frame(&self, artifact: FrameArtifact) -> SinkResult<()> {
        artifact.validate()?;
        self.frames.lock().expect("frames lock").push(artifact);
        Ok(())
    }
}

/// Small in-test audio sink: collects emitted events for the count
/// accessor.
pub(super) struct CollectingAudioSink {
    capability: SinkCapability,
    events: Mutex<Vec<AudioEvent>>,
}

impl CollectingAudioSink {
    fn supported() -> Self {
        Self {
            capability: SinkCapability::Supported {
                evidence_tier_ceiling: EvidenceTier::E0,
            },
            events: Mutex::new(Vec::new()),
        }
    }

    pub(super) fn event_count(&self) -> u32 {
        u32::try_from(self.events.lock().expect("audio lock").len()).unwrap_or(u32::MAX)
    }
}

impl AudioEventSink for CollectingAudioSink {
    fn capability(&self) -> SinkCapability {
        self.capability
    }

    fn emit_event(&self, audio: AudioEvent) -> SinkResult<()> {
        audio.validate()?;
        if matches!(self.capability, SinkCapability::Unsupported) {
            return Err(SinkError::UnsupportedKind {
                sink: SinkKind::AudioEvent,
                adapter_id: "smoke".to_string(),
                reason: "audio sink unsupported".to_string(),
            });
        }
        self.events.lock().expect("audio lock").push(audio);
        Ok(())
    }
}

fn frame_artifact_ref(index: u32) -> ObservationArtifactRef {
    let artifact_id = format!("frame-{index:04}");
    ObservationArtifactRef {
        artifact_id: artifact_id.clone(),
        artifact_kind: RuntimeArtifactKind::FrameCapture
            .artifact_kind()
            .to_string(),
        uri: runtime_artifact_uri(RUN_ID, RuntimeArtifactKind::FrameCapture, &artifact_id)
            .expect("frame uri"),
        media_type: Some("image/png".to_string()),
    }
}

pub(super) fn container_artifact_ref() -> ObservationArtifactRef {
    ObservationArtifactRef {
        artifact_id: RECORDING_ID.to_string(),
        artifact_kind: RuntimeArtifactKind::Recording.artifact_kind().to_string(),
        uri: runtime_artifact_uri(RUN_ID, RuntimeArtifactKind::Recording, RECORDING_ID)
            .expect("recording uri"),
        media_type: Some("application/zip".to_string()),
    }
}

fn build_frame(index: u32) -> FrameArtifact {
    FrameArtifact {
        frame_id: format!("frame-{index:04}"),
        evidence_tier: EvidenceTier::E2,
        artifact_ref: frame_artifact_ref(index),
        width: Some(320),
        height: Some(180),
        frame_index: u64::from(index),
        bridge_ref: None,
    }
}

fn build_audio_event(index: u32, kind: AudioEventKind) -> AudioEvent {
    AudioEvent {
        event_id: format!("audio-{index:04}"),
        evidence_tier: EvidenceTier::E0,
        event_kind: kind,
        cue_id: None,
        source_asset: None,
        bridge_ref: None,
        frame_index: Some(u64::from(index)),
    }
}

pub(super) fn drive_sinks() -> (CollectingFrameSink, CollectingAudioSink) {
    let frame_sink = CollectingFrameSink::supported();
    let audio_sink = CollectingAudioSink::supported();
    for index in 0..FRAME_COUNT {
        frame_sink.emit_frame(build_frame(index)).expect("frame");
    }
    let kinds = [
        AudioEventKind::BgmStart,
        AudioEventKind::Marker,
        AudioEventKind::Marker,
        AudioEventKind::BgmStop,
    ];
    for (index, kind) in kinds.iter().enumerate() {
        audio_sink
            .emit_event(build_audio_event(index as u32, *kind))
            .expect("audio");
    }
    (frame_sink, audio_sink)
}

pub(super) fn baseline_metadata() -> RecordingMetadata {
    let mut artifact_refs = vec![container_artifact_ref()];
    for index in 0..FRAME_COUNT {
        artifact_refs.push(frame_artifact_ref(index));
    }
    RecordingMetadata {
        recording_id: RECORDING_ID.to_string(),
        frame_count: FRAME_COUNT,
        audio_event_count: AUDIO_EVENT_COUNT,
        duration_ms: DURATION_MS,
        evidence_tier: EvidenceTier::E2,
        artifact_refs,
    }
}

pub(super) fn baseline_check() -> RecordingConformanceCheck {
    RecordingConformanceCheck {
        profile: ProfileId::RecordingCapture,
        observed_recording: baseline_metadata(),
        expected_duration_range: DurationRangeMs {
            min: 1_000,
            max: 2_000,
        },
        expected_event_count_range: ArtifactCountRange { min: 5, max: 10 },
    }
}

/// Walk a serde_json::Value, rebuilding every Object as a BTreeMap so the
/// emitted key order is sorted.
fn canonicalize(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut sorted: BTreeMap<String, Value> = BTreeMap::new();
            for (key, child) in map {
                sorted.insert(key, canonicalize(child));
            }
            let mut out = serde_json::Map::new();
            for (key, child) in sorted {
                out.insert(key, child);
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(canonicalize).collect()),
        other => other,
    }
}

pub(super) fn canonical_bytes<T: serde::Serialize>(value: &T) -> Vec<u8> {
    let owned = serde_json::to_value(value).expect("to value");
    let canonical = canonicalize(owned);
    serde_json::to_vec(&canonical).expect("canonical bytes")
}

pub(super) fn contains_key_anywhere(value: &Value, key: &str) -> bool {
    match value {
        Value::Object(map) => {
            if map.contains_key(key) {
                return true;
            }
            map.values().any(|child| contains_key_anywhere(child, key))
        }
        Value::Array(items) => items.iter().any(|item| contains_key_anywhere(item, key)),
        _ => false,
    }
}
