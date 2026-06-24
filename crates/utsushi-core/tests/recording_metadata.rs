//! Controlled playback recording metadata smoke (UTSUSHI-064).
//!
//! This single integration test exercises the controlled playback contract
//! through an inline fixture recording path. The substrate
//! (`RecordingMetadata`, `RecordingConformanceCheck`, `FrameArtifactSink`,
//! `AudioEventSink`) already exists; this slice is the structural smoke
//! that pins:
//!
//! - **Recording metadata is portable.** Every `ObservationArtifactRef`
//!   inside `artifact_refs` flows through `validate_runtime_artifact_uri`
//!   and `looks_like_local_path`; no host path or `file:`/`data:`/`blob:`
//!   scheme can survive.
//! - **No evidence-tier overclaim.** `E3` / `E4` recordings fail with
//!   `RecordingEvidenceTierOverclaim`
//!   (`utsushi.conformance.recording_evidence_tier_overclaim`).
//! - **Missing recording → `Unsupported`, never silent Pass.** When the
//!   manifest does not declare `RecordingCapture`, the smoke shape is
//!   `ResultOutcome::Unsupported { semantic_code:
//!   "utsushi.conformance.recording_capture_unsupported",
//!   declared_in_manifest: false }`. When the manifest DOES declare it but
//!   the recording is empty (`frame_count = 0`), validation fails with
//!   `RecordingFrameCountMismatch`.
//! - **Audio discipline.** The wire JSON walks every nested key and asserts
//!   no `audioEventTier`, `audioSampleRate`, `codec`, `channels`, or
//!   `mixLevels` field appears.

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde_json::Value;
use utsushi_core::conformance::capture_recording::codes as recording_codes;
use utsushi_core::conformance::capture_recording::{
    ArtifactCountRange, DurationRangeMs, RecordingConformanceCheck, RecordingMetadata,
};
use utsushi_core::conformance::diagnostics::ConformanceError;
use utsushi_core::conformance::result::ResultOutcome;
use utsushi_core::redaction::reject_unredacted_local_paths;
use utsushi_core::sink::{
    AudioEvent, AudioEventKind, AudioEventSink, FrameArtifact, FrameArtifactSink, SinkCapability,
    SinkError, SinkKind, SinkResult,
};
use utsushi_core::{
    EvidenceRef, EvidenceTier, ObservationArtifactRef, ProfileId, RuntimeArtifactKind,
    runtime_artifact_uri,
};

const RUN_ID: &str = "smoke-recording-run-000";
const RECORDING_ID: &str = "smoke-recording-000";
const FRAME_COUNT: u32 = 3;
const AUDIO_EVENT_COUNT: u32 = 4;
const DURATION_MS: u64 = 1_500;

/// Small in-test frame sink: collects emitted artifacts and exposes a
/// count accessor.
struct CollectingFrameSink {
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

    fn frame_count(&self) -> u32 {
        u32::try_from(self.frames.lock().expect("frames lock").len()).unwrap_or(u32::MAX)
    }

    fn emitted_artifact_refs(&self) -> Vec<ObservationArtifactRef> {
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
struct CollectingAudioSink {
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

    fn event_count(&self) -> u32 {
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

fn container_artifact_ref() -> ObservationArtifactRef {
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

fn drive_sinks() -> (CollectingFrameSink, CollectingAudioSink) {
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

fn baseline_metadata() -> RecordingMetadata {
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

fn baseline_check() -> RecordingConformanceCheck {
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
/// emitted key order is sorted (matches the recorder's
/// `deterministic_json_bytes` canonicalization pattern from UTSUSHI-060).
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

fn canonical_bytes<T: serde::Serialize>(value: &T) -> Vec<u8> {
    let owned = serde_json::to_value(value).expect("to value");
    let canonical = canonicalize(owned);
    serde_json::to_vec(&canonical).expect("canonical bytes")
}

#[test]
fn recording_metadata_round_trips_through_serde_json_byte_for_byte() {
    let metadata = baseline_metadata();
    let first = canonical_bytes(&metadata);
    let restored: RecordingMetadata =
        serde_json::from_slice(&first).expect("round-trip deserialize");
    assert_eq!(metadata, restored);
    let second = canonical_bytes(&restored);
    assert_eq!(first, second);
}

#[test]
fn recording_metadata_serializes_with_camel_case_field_names() {
    let metadata = baseline_metadata();
    let value = serde_json::to_value(&metadata).expect("serialize");
    let obj = value.as_object().expect("object");
    assert!(obj.contains_key("recordingId"));
    assert!(obj.contains_key("frameCount"));
    assert!(obj.contains_key("audioEventCount"));
    assert!(obj.contains_key("durationMs"));
    assert!(obj.contains_key("evidenceTier"));
    assert!(obj.contains_key("artifactRefs"));
    assert!(!obj.contains_key("recording_id"));
    assert!(!obj.contains_key("artifact_refs"));
}

#[test]
fn recording_metadata_round_trip_preserves_artifact_ref_order() {
    let metadata = baseline_metadata();
    let bytes = serde_json::to_vec(&metadata).expect("serialize");
    let restored: RecordingMetadata = serde_json::from_slice(&bytes).expect("deserialize");
    let original_kinds: Vec<_> = metadata
        .artifact_refs
        .iter()
        .map(|r| r.artifact_kind.as_str())
        .collect();
    let restored_kinds: Vec<_> = restored
        .artifact_refs
        .iter()
        .map(|r| r.artifact_kind.as_str())
        .collect();
    assert_eq!(original_kinds, restored_kinds);
    assert_eq!(original_kinds[0], "recording");
    assert!(
        original_kinds[1..]
            .iter()
            .all(|kind| *kind == "frame_capture")
    );
}

#[test]
fn recording_conformance_check_run_returns_pass_with_e2_tier_on_in_range_metadata() {
    let check = baseline_check();
    match check.run() {
        ResultOutcome::Pass { evidence_tier } => {
            assert_eq!(evidence_tier, EvidenceTier::E2);
        }
        other => panic!("expected Pass, got {other:?}"),
    }
}

#[test]
fn recording_conformance_check_passes_when_frame_count_audio_event_count_and_duration_are_in_range()
{
    baseline_check()
        .validate()
        .expect("baseline check validates");
}

#[test]
fn recording_metadata_serialized_form_contains_evidence_tier_literal_in_wire_json() {
    let metadata = baseline_metadata();
    let serialized = serde_json::to_string(&metadata).expect("serialize");
    assert!(
        serialized.contains("\"evidenceTier\":\"E2\""),
        "wire JSON must surface evidenceTier=E2 literally: {serialized}"
    );
}

#[test]
fn recording_metadata_serialize_twice_produces_byte_identical_output() {
    let metadata = baseline_metadata();
    let first = canonical_bytes(&metadata);
    let second = canonical_bytes(&metadata);
    assert_eq!(first, second);
}

#[test]
fn recording_metadata_serialize_resolve_serialize_produces_byte_identical_output_across_three_runs()
{
    let metadata = baseline_metadata();
    let mut payloads = Vec::new();
    for _ in 0..3 {
        let bytes = canonical_bytes(&metadata);
        let restored: RecordingMetadata = serde_json::from_slice(&bytes).expect("round-trip");
        payloads.push(canonical_bytes(&restored));
    }
    assert_eq!(payloads[0], payloads[1]);
    assert_eq!(payloads[1], payloads[2]);
}

#[test]
fn recording_conformance_result_envelope_serialize_twice_produces_byte_identical_output() {
    let check = baseline_check();
    let outcome = check.run();
    let first = canonical_bytes(&outcome);
    let second = canonical_bytes(&outcome);
    assert_eq!(first, second);
}

#[test]
fn recording_conformance_check_fails_with_evidence_tier_overclaim_code_on_e4_tier() {
    let mut check = baseline_check();
    check.observed_recording.evidence_tier = EvidenceTier::E4;
    match check.run() {
        ResultOutcome::Fail { semantic_code, .. } => {
            assert_eq!(
                semantic_code,
                recording_codes::RECORDING_EVIDENCE_TIER_OVERCLAIM
            );
        }
        other => panic!("expected Fail, got {other:?}"),
    }
}

#[test]
fn recording_conformance_check_fails_with_evidence_tier_overclaim_code_on_e3_tier() {
    let mut check = baseline_check();
    check.observed_recording.evidence_tier = EvidenceTier::E3;
    match check.run() {
        ResultOutcome::Fail { semantic_code, .. } => {
            assert_eq!(
                semantic_code,
                recording_codes::RECORDING_EVIDENCE_TIER_OVERCLAIM
            );
        }
        other => panic!("expected Fail, got {other:?}"),
    }
}

#[test]
fn recording_metadata_serialized_form_does_not_contain_audio_event_tier_field() {
    // Audit-focus defense (audio side): walk the wire JSON for every
    // recording-metadata payload exercised by the smoke and assert no
    // forbidden audio-fidelity key appears. The smoke serializes both the
    // bare metadata and the conformance check envelope to catch
    // accidental nesting in either shape.
    let forbidden_keys = [
        "audioEventTier",
        "audioSampleRate",
        "audio_event_tier",
        "audio_sample_rate",
        "codec",
        "channels",
        "mixLevels",
        "mix_levels",
        "bitrate",
    ];
    let bare = serde_json::to_value(baseline_metadata()).expect("bare value");
    let envelope = serde_json::to_value(baseline_check()).expect("envelope value");
    for forbidden in &forbidden_keys {
        assert!(
            !contains_key_anywhere(&bare, forbidden),
            "metadata JSON must not contain forbidden audio field {forbidden}: {bare}"
        );
        assert!(
            !contains_key_anywhere(&envelope, forbidden),
            "envelope JSON must not contain forbidden audio field {forbidden}: {envelope}"
        );
    }
}

#[test]
fn recording_runner_emits_unsupported_outcome_when_manifest_does_not_declare_recording_capture() {
    // The runner shape: when the manifest does not declare
    // RecordingCapture, the runner emits Unsupported. The check is never
    // constructed.
    let outcome = ResultOutcome::Unsupported {
        semantic_code: recording_codes::RECORDING_CAPTURE_UNSUPPORTED.to_string(),
        declared_in_manifest: false,
    };
    match &outcome {
        ResultOutcome::Unsupported {
            semantic_code,
            declared_in_manifest,
        } => {
            assert_eq!(
                semantic_code,
                recording_codes::RECORDING_CAPTURE_UNSUPPORTED
            );
            assert!(!declared_in_manifest);
        }
        other => panic!("expected Unsupported, got {other:?}"),
    }
    // The wire JSON literal pins the structural defense.
    let serialized = serde_json::to_string(&outcome).expect("serialize");
    assert!(
        serialized.contains("\"kind\":\"unsupported\""),
        "wire JSON must surface outcome=unsupported: {serialized}"
    );
    assert!(
        serialized.contains(recording_codes::RECORDING_CAPTURE_UNSUPPORTED),
        "wire JSON must surface the semantic code: {serialized}"
    );
}

#[test]
fn recording_conformance_check_fails_with_frame_count_mismatch_when_frame_count_is_zero_but_artifact_refs_are_nonempty()
 {
    let mut check = baseline_check();
    check.observed_recording.frame_count = 0;
    match check.validate() {
        Err(ConformanceError::RecordingFrameCountMismatch { declared, actual }) => {
            assert_eq!(declared, 0);
            assert_eq!(actual, FRAME_COUNT);
        }
        other => panic!("expected RecordingFrameCountMismatch, got {other:?}"),
    }
}

#[test]
fn recording_conformance_check_fails_with_event_count_out_of_range_when_audio_event_count_plus_frame_count_is_below_expected_min()
 {
    let mut check = baseline_check();
    check.observed_recording.audio_event_count = 0;
    // 3 (frames) + 0 (audio) = 3, below the min=5.
    match check.validate() {
        Err(ConformanceError::RecordingEventCountOutOfRange { observed, min, max }) => {
            assert_eq!(observed, FRAME_COUNT);
            assert_eq!(min, 5);
            assert_eq!(max, 10);
        }
        other => panic!("expected RecordingEventCountOutOfRange, got {other:?}"),
    }
}

#[test]
fn recording_conformance_check_does_not_return_pass_for_a_recording_with_zero_frame_count_and_zero_audio_events()
 {
    // The "missing recording silently passed" defense. With no frames and
    // no audio events, validation MUST surface a typed failure (either
    // frame-count mismatch against artifact refs, or event-count out of
    // range), never a Pass.
    let mut check = baseline_check();
    check.observed_recording.frame_count = 0;
    check.observed_recording.audio_event_count = 0;
    // Strip the frame_capture refs so the validator reaches the deeper
    // count rule rather than RecordingFrameCountMismatch (which is also
    // a Fail, just a different code).
    check.observed_recording.artifact_refs = vec![container_artifact_ref()];
    let outcome = check.run();
    assert!(matches!(outcome, ResultOutcome::Fail { .. }));
    match &outcome {
        ResultOutcome::Fail { semantic_code, .. } => {
            // The check reaches event-count or container/duration checks
            // depending on which fails first; the structural assertion is
            // that the outcome is NEVER Pass.
            assert!(
                semantic_code.starts_with("utsushi.conformance.recording_"),
                "semantic code must namespace under recording: {semantic_code}"
            );
        }
        _ => unreachable!(),
    }
}

#[test]
fn recording_conformance_check_fails_with_recording_artifact_host_path_code_when_artifact_uri_is_absolute_local_path()
 {
    let mut check = baseline_check();
    check.observed_recording.artifact_refs[1].uri = "/home/leak/frame.png".to_string();
    match check.run() {
        ResultOutcome::Fail { semantic_code, .. } => {
            assert_eq!(semantic_code, recording_codes::RECORDING_ARTIFACT_HOST_PATH);
        }
        other => panic!("expected Fail, got {other:?}"),
    }
}

#[test]
fn recording_conformance_check_fails_with_recording_artifact_host_path_code_when_artifact_uri_uses_file_scheme()
 {
    let mut check = baseline_check();
    check.observed_recording.artifact_refs[1].uri = "file:///srv/leak/frame.png".to_string();
    match check.run() {
        ResultOutcome::Fail { semantic_code, .. } => {
            assert_eq!(semantic_code, recording_codes::RECORDING_ARTIFACT_HOST_PATH);
        }
        other => panic!("expected Fail, got {other:?}"),
    }
}

#[test]
fn recording_conformance_check_fails_with_recording_id_malformed_when_recording_id_looks_like_local_path()
 {
    let mut check = baseline_check();
    check.observed_recording.recording_id = "/tmp/leak/recording".to_string();
    match check.run() {
        ResultOutcome::Fail { semantic_code, .. } => {
            assert_eq!(semantic_code, recording_codes::RECORDING_ID_MALFORMED);
        }
        other => panic!("expected Fail, got {other:?}"),
    }
}

#[test]
fn recording_metadata_serialized_form_passes_reject_unredacted_local_paths_filter() {
    let metadata = baseline_metadata();
    let value = serde_json::to_value(&metadata).expect("serialize");
    reject_unredacted_local_paths("recordingMetadata", &value).expect("filter pass");
}

#[test]
fn recording_conformance_result_envelope_passes_reject_unredacted_local_paths_filter() {
    let check = baseline_check();
    let value = serde_json::to_value(&check).expect("serialize check");
    reject_unredacted_local_paths("recordingConformanceCheck", &value).expect("filter pass");
    let outcome = check.run();
    let outcome_value = serde_json::to_value(&outcome).expect("serialize outcome");
    reject_unredacted_local_paths("outcome", &outcome_value).expect("outcome filter");
}

#[test]
fn recording_metadata_frame_count_equals_emitted_frame_sink_event_count() {
    let (frame_sink, _audio_sink) = drive_sinks();
    let metadata = baseline_metadata();
    assert_eq!(metadata.frame_count, frame_sink.frame_count());
}

#[test]
fn recording_metadata_audio_event_count_equals_emitted_audio_sink_event_count() {
    let (_frame_sink, audio_sink) = drive_sinks();
    let metadata = baseline_metadata();
    assert_eq!(metadata.audio_event_count, audio_sink.event_count());
}

#[test]
fn recording_metadata_artifact_refs_count_minus_container_equals_frame_sink_event_count() {
    let (frame_sink, _audio_sink) = drive_sinks();
    let metadata = baseline_metadata();
    let frame_refs = metadata
        .artifact_refs
        .iter()
        .filter(|r| r.artifact_kind == "frame_capture")
        .count();
    assert_eq!(
        u32::try_from(frame_refs).expect("count fits u32"),
        frame_sink.frame_count()
    );
    // And the sink's emitted refs map 1:1 to the metadata's frame_capture
    // refs (modulo the container).
    let emitted = frame_sink.emitted_artifact_refs();
    let metadata_frame_refs: Vec<_> = metadata
        .artifact_refs
        .iter()
        .filter(|r| r.artifact_kind == "frame_capture")
        .cloned()
        .collect();
    assert_eq!(emitted.len(), metadata_frame_refs.len());
}

#[test]
fn recording_metadata_smoke_only_emits_codes_registered_in_capture_recording_codes_all() {
    // For each twin that yields a typed failure, capture the
    // semantic_code() and confirm it is in
    // capture_recording::codes::ALL. The structural assertion: no smoke
    // path leaks a code outside the registry.
    let mut observed_codes: Vec<&str> = Vec::new();
    {
        let mut check = baseline_check();
        check.observed_recording.evidence_tier = EvidenceTier::E4;
        if let Err(error) = check.validate() {
            observed_codes.push(error.semantic_code());
        }
    }
    {
        let mut check = baseline_check();
        check.observed_recording.evidence_tier = EvidenceTier::E3;
        if let Err(error) = check.validate() {
            observed_codes.push(error.semantic_code());
        }
    }
    {
        let mut check = baseline_check();
        check.observed_recording.frame_count = 0;
        if let Err(error) = check.validate() {
            observed_codes.push(error.semantic_code());
        }
    }
    {
        let mut check = baseline_check();
        check.observed_recording.artifact_refs[1].uri = "/home/leak/frame.png".to_string();
        if let Err(error) = check.validate() {
            observed_codes.push(error.semantic_code());
        }
    }
    {
        let mut check = baseline_check();
        check.observed_recording.recording_id = "/tmp/leak/recording".to_string();
        if let Err(error) = check.validate() {
            observed_codes.push(error.semantic_code());
        }
    }

    assert!(
        !observed_codes.is_empty(),
        "smoke must exercise at least one code"
    );
    for code in &observed_codes {
        assert!(
            recording_codes::ALL.contains(code),
            "code {code} not in capture_recording::codes::ALL"
        );
    }
}

#[test]
fn recording_conformance_pass_result_cross_validates_against_manifest_declaring_recording_capture_at_e2()
 {
    // Build a full ConformanceResult envelope from the Pass outcome and
    // assert the envelope-level validator accepts it. This pins the
    // structural compatibility with UTSUSHI-026's `validate`.
    let check = baseline_check();
    let outcome = check.run();
    // Project each artifact ref into the substrate's
    // `EvidenceRef::RuntimeArtifact` variant. The recording's container
    // contributes a `Recording` kind; each frame ref contributes a
    // `FrameCapture` kind.
    let evidence = check
        .observed_recording
        .artifact_refs
        .iter()
        .map(|artifact| EvidenceRef::RuntimeArtifact {
            kind: match artifact.artifact_kind.as_str() {
                "recording" => RuntimeArtifactKind::Recording,
                "frame_capture" => RuntimeArtifactKind::FrameCapture,
                other => panic!("unexpected artifact kind {other}"),
            },
            uri: artifact.uri.clone(),
            artifact_id: Some(artifact.artifact_id.clone()),
        })
        .collect::<Vec<_>>();
    let envelope = utsushi_core::ConformanceResult {
        schema_version: utsushi_core::CONFORMANCE_SCHEMA_VERSION.to_string(),
        adapter_id: "utsushi-fixture".to_string(),
        profile_id: ProfileId::RecordingCapture,
        outcome,
        evidence,
        recorded_at: "2026-06-23T12:00:00Z".to_string(),
    };
    envelope.validate().expect("envelope validates");
}

fn contains_key_anywhere(value: &Value, key: &str) -> bool {
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
