use super::*;
use crate::EvidenceTier;
use crate::sink::{AudioEvent, AudioEventKind, TextLine};
use crate::validate_runtime_evidence_report_value;

fn sample_text_line() -> TextLine {
    TextLine {
        line_id: "line-001".to_string(),
        evidence_tier: EvidenceTier::E1,
        text: "hello".to_string(),
        speaker: None,
        color: None,
        text_surface: None,
        bridge_ref: None,
        source_asset: None,
        byte_offset_in_scene: None,
        body_shift_jis: None,
    }
}

fn sample_audio_event() -> AudioEvent {
    AudioEvent {
        event_id: "audio-001".to_string(),
        evidence_tier: EvidenceTier::E0,
        event_kind: AudioEventKind::BgmStart,
        cue_id: None,
        source_asset: None,
        bridge_ref: None,
        frame_index: None,
    }
}

#[test]
fn runner_outcome_to_value_surfaces_every_sink_payload_without_dropping() {
    let outcome = RunnerOutcome {
        manifest_id: "utsushi-test-port",
        manifest_version: "0.0.0",
        observations: vec![RunnerObservation {
            text: vec![sample_text_line()],
            frames: Vec::new(),
            audio: vec![sample_audio_event()],
        }],
        capture: None,
        shutdown: PortShutdownOutcome::clean(),
    };

    // The mapper now returns a typed Result and propagates any
    // serialization failure instead of silently dropping a payload.
    let descriptor = RuntimeAdapterDescriptor {
        name: outcome.manifest_id.to_string(),
        version: outcome.manifest_version.to_string(),
        fidelity_tier: crate::FidelityTier::TraceOnly,
        evidence_tier_ceiling: EvidenceTier::E1,
        capability_contract: crate::RuntimeCapabilityContract::new(
            crate::RuntimeCapabilityClass::StaticTrace,
            crate::FidelityTier::TraceOnly,
            EvidenceTier::E1,
            vec![crate::RuntimeFeatureSupport::supported(
                RuntimePlaybackFeature::InstrumentationHooks,
                EvidenceTier::E1,
                "Synthetic test hook support.",
            )],
            Vec::new(),
        ),
        capabilities: vec![crate::RuntimeCapability::Trace],
        approximation_tiers: vec![ApproximationTier::EnginePartial],
        diagnostics: Vec::new(),
        limitations: Vec::new(),
    };
    let value = runner_outcome_to_value(&outcome, RuntimeOperation::Trace, &descriptor)
        .expect("serialisable sink payloads must map to Ok");
    validate_runtime_evidence_report_value(&value)
        .expect("adapter report must satisfy RuntimeEvidenceReportV02");
    let observations = value["sinkObservations"]
        .as_array()
        .expect("sinkObservations array");
    // Both the text and the audio payload must surface; a dropped
    // observation would hide a real emission from the report.
    assert_eq!(observations.len(), 2);
    assert!(
        observations
            .iter()
            .any(|entry| entry["sink"] == "text_surface")
    );
    assert!(
        observations
            .iter()
            .any(|entry| entry["sink"] == "audio_event")
    );
}

#[test]
fn features_used_for_report_reports_only_observed_runtime_features() {
    assert_eq!(
        features_used_for_report(RuntimeOperation::Trace, false, false),
        Vec::<RuntimePlaybackFeature>::new()
    );
    assert_eq!(
        features_used_for_report(RuntimeOperation::Trace, true, false),
        vec![RuntimePlaybackFeature::InstrumentationHooks]
    );
    assert_eq!(
        features_used_for_report(RuntimeOperation::Capture, true, true),
        vec![
            RuntimePlaybackFeature::FrameCapture,
            RuntimePlaybackFeature::InstrumentationHooks
        ]
    );
    assert_eq!(
        features_used_for_report(RuntimeOperation::SmokeValidation, false, false),
        Vec::<RuntimePlaybackFeature>::new()
    );
    assert_eq!(
        features_used_for_report(RuntimeOperation::BranchDiscovery, false, true),
        vec![RuntimePlaybackFeature::BranchDiscovery]
    );
}
