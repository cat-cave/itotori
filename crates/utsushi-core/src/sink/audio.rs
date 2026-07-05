//! Audio-event sink contract.
//!
//! Audio events are inspectable metadata, capped at `E0`. The sink does not
//! accept bytes, sample rates, durations, or mix levels: there is no surface
//! that could look like playback evidence.

use serde::{Deserialize, Serialize};

use crate::{EvidenceTier, ObservationBridgeRef, vfs::AssetId};

use super::errors::{SinkError, SinkResult};
use super::{SinkCapability, SinkKind};

/// Headless audio-event sink.
pub trait AudioEventSink: Send + Sync {
    /// Adapter-declared support for the audio-event sink kind.
    fn capability(&self) -> SinkCapability;

    /// Emit an audio event as inspectable metadata. The sink MUST reject any
    /// `evidence_tier != EvidenceTier::E0` because audio events do not prove
    /// playback parity.
    fn emit_event(&self, audio: AudioEvent) -> SinkResult<()>;

    /// Drain queued emissions. Called by the runner after `EnginePort::observe`
    /// (after the frame sink drain) to surface audio metadata into
    /// [`crate::port::RunnerOutcome`].
    fn drain_events(&self) -> Vec<AudioEvent> {
        Vec::new()
    }
}

/// Runtime-observed audio event metadata. Engine-neutral; the kind enum is
/// the only discriminant.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioEvent {
    pub event_id: String,
    /// Always `E0`; the sink rejects anything else.
    pub evidence_tier: EvidenceTier,
    /// Engine-neutral discriminant; not opcode/file-format leakage.
    pub event_kind: AudioEventKind,
    /// Stable cue/label/track id from the runtime. Engine-supplied string;
    /// the sink does not interpret. NEVER a host path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cue_id: Option<String>,
    /// Optional asset id of the audio resource. Uses the UTSUSHI-020
    /// `AssetId`, so it is engine-neutral and host-path-free by construction.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_asset: Option<AssetId>,
    /// Optional bridge-unit linkage (for voiced dialogue tied to a line).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bridge_ref: Option<ObservationBridgeRef>,
    /// Optional monotonic timeline marker from the runtime clock.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_index: Option<u64>,
}

impl AudioEvent {
    /// Per-payload validator. Called by the sink before insertion.
    pub fn validate(&self) -> SinkResult<()> {
        if self.evidence_tier != EvidenceTier::E0 {
            return Err(SinkError::EvidenceTierMismatch {
                sink: SinkKind::AudioEvent,
                claimed: self.evidence_tier,
                ceiling: SinkKind::AudioEvent.evidence_tier_ceiling(),
            });
        }
        Ok(())
    }
}

/// Engine-neutral audio event taxonomy. The taxonomy is intentionally narrow
/// — adding a kind is a small additive enum extension, removing one is a
/// breaking change. Voice-subtitle sync is a deliberate follow-up.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioEventKind {
    BgmStart,
    BgmStop,
    SeFire,
    VoicePlay,
    VoiceStop,
    Marker,
}

impl AudioEventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BgmStart => "bgm_start",
            Self::BgmStop => "bgm_stop",
            Self::SeFire => "se_fire",
            Self::VoicePlay => "voice_play",
            Self::VoiceStop => "voice_stop",
            Self::Marker => "marker",
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::json;

    use crate::redaction::reject_unredacted_local_paths;

    use super::*;

    struct CollectingAudioSink {
        capability: SinkCapability,
        adapter_id: String,
        events: Mutex<Vec<AudioEvent>>,
    }

    impl CollectingAudioSink {
        fn supported() -> Self {
            Self {
                capability: SinkCapability::Supported {
                    evidence_tier_ceiling: EvidenceTier::E0,
                },
                adapter_id: "synthetic-json".to_string(),
                events: Mutex::new(Vec::new()),
            }
        }

        fn unsupported() -> Self {
            Self {
                capability: SinkCapability::Unsupported,
                adapter_id: "text-only-adapter".to_string(),
                events: Mutex::new(Vec::new()),
            }
        }
    }

    impl AudioEventSink for CollectingAudioSink {
        fn capability(&self) -> SinkCapability {
            self.capability
        }

        fn emit_event(&self, audio: AudioEvent) -> SinkResult<()> {
            if matches!(self.capability, SinkCapability::Unsupported) {
                return Err(SinkError::UnsupportedKind {
                    sink: SinkKind::AudioEvent,
                    adapter_id: self.adapter_id.clone(),
                    reason: "adapter does not produce audio metadata".to_string(),
                });
            }
            audio.validate()?;
            self.events.lock().expect("lock").push(audio);
            Ok(())
        }
    }

    fn sample_event(kind: AudioEventKind, evidence_tier: EvidenceTier) -> AudioEvent {
        AudioEvent {
            event_id: format!("event-{}", kind.as_str()),
            evidence_tier,
            event_kind: kind,
            cue_id: Some("bgm.field.1".to_string()),
            source_asset: Some(
                AssetId::parse("vfs://www/audio/bgm/Field1.ogg").expect("valid asset id"),
            ),
            bridge_ref: None,
            frame_index: Some(42),
        }
    }

    #[test]
    fn audio_sink_accepts_e0_bgm_start_with_vfs_asset_id() {
        let sink = CollectingAudioSink::supported();
        let event = sample_event(AudioEventKind::BgmStart, EvidenceTier::E0);
        sink.emit_event(event).expect("E0 BGM start accepted");
        assert_eq!(sink.events.lock().unwrap().len(), 1);
    }

    #[test]
    fn audio_sink_accepts_e0_voice_play_with_bridge_ref() {
        let sink = CollectingAudioSink::supported();
        let mut event = sample_event(AudioEventKind::VoicePlay, EvidenceTier::E0);
        event.bridge_ref = Some(ObservationBridgeRef {
            bridge_unit_id: Some("0190a000-0000-7000-8000-000000000001".to_string()),
            source_unit_key: Some("intro/voice/1".to_string()),
            runtime_object_id: None,
        });
        sink.emit_event(event).expect("E0 voice play accepted");
    }

    #[test]
    fn audio_sink_rejects_e1_emission_as_evidence_tier_mismatch() {
        let sink = CollectingAudioSink::supported();
        let event = sample_event(AudioEventKind::SeFire, EvidenceTier::E1);
        let error = sink.emit_event(event).expect_err("E1 rejected");
        assert!(matches!(
            error,
            SinkError::EvidenceTierMismatch {
                sink: SinkKind::AudioEvent,
                claimed: EvidenceTier::E1,
                ceiling: EvidenceTier::E0,
            }
        ));
    }

    #[test]
    fn audio_sink_rejects_e2_emission_as_evidence_tier_mismatch() {
        let sink = CollectingAudioSink::supported();
        let event = sample_event(AudioEventKind::SeFire, EvidenceTier::E2);
        sink.emit_event(event).expect_err("E2 rejected");
    }

    #[test]
    fn audio_sink_rejects_e3_emission_as_evidence_tier_mismatch() {
        let sink = CollectingAudioSink::supported();
        let event = sample_event(AudioEventKind::Marker, EvidenceTier::E3);
        sink.emit_event(event).expect_err("E3 rejected");
    }

    #[test]
    fn audio_sink_unsupported_capability_returns_unsupported_kind() {
        let sink = CollectingAudioSink::unsupported();
        let event = sample_event(AudioEventKind::BgmStart, EvidenceTier::E0);
        let error = sink.emit_event(event).expect_err("unsupported rejects");
        match error {
            SinkError::UnsupportedKind {
                sink, adapter_id, ..
            } => {
                assert_eq!(sink, SinkKind::AudioEvent);
                assert_eq!(adapter_id, "text-only-adapter");
            }
            other => panic!("expected UnsupportedKind, got {other:?}"),
        }
    }

    #[test]
    fn audio_sink_payload_has_no_audio_bytes_field() {
        // Structural test: the AudioEvent surface must not even *contain*
        // anything that smells like playback fidelity.
        let event = sample_event(AudioEventKind::BgmStart, EvidenceTier::E0);
        let value = serde_json::to_value(&event).expect("serialize");
        let obj = value.as_object().expect("object");
        for forbidden in ["bytes", "sampleRate", "duration", "mixLevel", "channels"] {
            assert!(
                !obj.contains_key(forbidden),
                "AudioEvent leaked playback-shaped key {forbidden}: {value}"
            );
        }
    }

    #[test]
    fn audio_sink_round_trips_metadata_through_json_without_loss() {
        let event = sample_event(AudioEventKind::VoicePlay, EvidenceTier::E0);
        let value = serde_json::to_value(&event).expect("serialize");
        let parsed: AudioEvent = serde_json::from_value(value).expect("deserialize");
        assert_eq!(parsed, event);
    }

    #[test]
    fn audio_sink_emission_passes_observation_redaction_filter() {
        let event = sample_event(AudioEventKind::SeFire, EvidenceTier::E0);
        let value = json!({ "audioEvent": serde_json::to_value(&event).unwrap() });
        reject_unredacted_local_paths("", &value).expect("clean emission passes");
    }
}
