//! Integration tests for the deterministic input/clock/replay substrate
//! (UTSUSHI-021).
//!
//! Exercises the recording adapter / replay-driver contract end-to-end and
//! pins the on-disk JSON form to a checked-in golden fixture so accidental
//! field renames regress loudly.

use std::sync::Arc;

use serde_json::Value;
use utsushi_core::{
    AssetId, ChoiceIndex, ClockOrigin, InputError, InputEvent, InputKind, LogicalClock,
    LogicalClockTick, MenuTarget, PointerButton, REPLAY_LOG_SCHEMA_VERSION, ReplayCursor,
    ReplayEntry, ReplayLog, ReplayLogBuilder, ReplayMetadata, RuntimeRequest,
};

/// A purely in-test adapter that observes each replayed `InputEvent` and
/// emits a synthetic trace line. It does not implement `RuntimeAdapter`
/// (that's UTSUSHI-103's surface decision); instead it models the contract
/// runner-template authors will inherit.
struct RecordingAdapter {
    supported_kinds: Vec<InputKind>,
}

impl RecordingAdapter {
    fn supports_text_and_choice() -> Self {
        Self {
            supported_kinds: vec![InputKind::Text, InputKind::Choice, InputKind::Advance],
        }
    }

    fn dispatch(&self, event: &InputEvent) -> Result<String, InputError> {
        let kind = event.kind();
        if !self.supported_kinds.contains(&kind) {
            // mirror the contract that adapters return typed UnsupportedKind
            // rather than silently dropping.
            let supported: &'static [InputKind] = match self.supported_kinds.as_slice() {
                [InputKind::Text, InputKind::Choice, InputKind::Advance] => {
                    &[InputKind::Text, InputKind::Choice, InputKind::Advance]
                }
                _ => unreachable!("test adapter supports only the fixed kinds set"),
            };
            return Err(InputError::unsupported_kind(kind.token(), supported));
        }
        match event {
            InputEvent::Text {} => Ok("text-line".to_string()),
            InputEvent::Choice {
                index,
                bridge_unit_id,
            } => Ok(format!(
                "choice index={} bridge={}",
                index.get(),
                bridge_unit_id.as_deref().unwrap_or("-")
            )),
            InputEvent::Advance {} => Ok("advance".to_string()),
            _ => unreachable!("supported kinds covered above"),
        }
    }
}

fn drive_log(adapter: &RecordingAdapter, log: &ReplayLog) -> Result<Vec<String>, InputError> {
    let mut cursor = ReplayCursor::start();
    let mut clock = LogicalClock::starting_at(log.metadata.clock_origin);
    let mut trace = Vec::new();
    while let Some((entry, next)) = log.next_event(cursor)? {
        clock.advance_to(entry.tick)?;
        let line = adapter.dispatch(&entry.event)?;
        trace.push(format!("tick={} {line}", clock.now().get()));
        cursor = next;
    }
    Ok(trace)
}

fn sample_log() -> ReplayLog {
    let mut builder = ReplayLogBuilder::new().metadata(ReplayMetadata {
        run_id: "replay-fixture-1".to_string(),
        adapter_name: "fixture".to_string(),
        adapter_version: "0.1.0".to_string(),
        clock_origin: ClockOrigin::RunStart,
        seed: 0,
        source_label: Some("public-fixture:hello-game".to_string()),
    });
    builder
        .record(LogicalClockTick(1), InputEvent::text())
        .unwrap();
    builder
        .record(LogicalClockTick(2), InputEvent::text())
        .unwrap();
    builder
        .record(LogicalClockTick(3), InputEvent::text())
        .unwrap();
    builder
        .record(
            LogicalClockTick(4),
            InputEvent::Choice {
                index: ChoiceIndex(1),
                bridge_unit_id: Some("intro-unit-7".to_string()),
            },
        )
        .unwrap();
    builder.note_asset(AssetId::parse("vfs://fixture/intro.txt").unwrap());
    builder.build().unwrap()
}

#[test]
fn fixture_replay_emits_same_text_and_choice_sequence_as_recording() {
    let log = sample_log();
    let adapter = RecordingAdapter::supports_text_and_choice();
    let trace_a = drive_log(&adapter, &log).unwrap();
    let trace_b = drive_log(&adapter, &log).unwrap();
    // Same log, same adapter, same seed -> byte-identical trace.
    assert_eq!(trace_a, trace_b);
    assert_eq!(
        trace_a,
        vec![
            "tick=1 text-line".to_string(),
            "tick=2 text-line".to_string(),
            "tick=3 text-line".to_string(),
            "tick=4 choice index=1 bridge=intro-unit-7".to_string(),
        ]
    );
}

#[test]
fn fixture_replay_unsupported_input_surface_typed_unsupported_kind_error() {
    let mut builder = ReplayLogBuilder::new().metadata(ReplayMetadata {
        run_id: "replay-pointer-fixture".to_string(),
        adapter_name: "fixture".to_string(),
        adapter_version: "0.1.0".to_string(),
        clock_origin: ClockOrigin::RunStart,
        seed: 0,
        source_label: None,
    });
    builder
        .record(LogicalClockTick(1), InputEvent::text())
        .unwrap();
    builder
        .record(
            LogicalClockTick(2),
            InputEvent::Pointer {
                x: 0.5,
                y: 0.5,
                button: PointerButton::Primary,
            },
        )
        .unwrap();
    let log = builder.build().unwrap();
    let adapter = RecordingAdapter::supports_text_and_choice();
    let error = drive_log(&adapter, &log).unwrap_err();
    match error {
        InputError::UnsupportedKind {
            kind,
            supported,
            code,
        } => {
            assert_eq!(kind, "pointer");
            assert_eq!(code, "utsushi.input.unsupported_kind");
            let supported_tokens: Vec<&str> = supported.iter().map(|kind| kind.token()).collect();
            assert_eq!(supported_tokens, vec!["text", "choice", "advance"]);
        }
        other => panic!("expected UnsupportedKind, got {other:?}"),
    }
}

#[test]
fn fixture_replay_round_trips_log_through_serde_byte_for_byte() {
    let log = sample_log();
    let value = log.to_json_value().unwrap();
    let reparsed = ReplayLog::from_json_value(value.clone()).unwrap();
    let revalue = reparsed.to_json_value().unwrap();
    assert_eq!(value, revalue);
    assert_eq!(log, reparsed);
}

#[test]
fn fixture_replay_log_matches_checked_in_golden() {
    let log = sample_log();
    let serialized = log.to_json_value().unwrap();

    // Golden lives next to the test source so the schema-version pin is
    // visible to anyone evolving the wire format.
    let golden_str = include_str!("fixtures/replay_log_golden.json");
    let golden: Value =
        serde_json::from_str(golden_str).expect("golden replay log must be valid JSON");
    assert_eq!(
        serialized, golden,
        "serialized replay log diverged from checked-in golden; bump REPLAY_LOG_SCHEMA_VERSION \
         and update fixtures/replay_log_golden.json if the change is intentional"
    );

    // And the wire form is what we expect:
    assert_eq!(
        serialized["schemaVersion"], REPLAY_LOG_SCHEMA_VERSION,
        "schema version field must equal REPLAY_LOG_SCHEMA_VERSION"
    );
}

#[test]
fn fixture_replay_log_round_trips_from_golden_file_into_struct() {
    let golden_str = include_str!("fixtures/replay_log_golden.json");
    let value: Value = serde_json::from_str(golden_str).unwrap();
    let log = ReplayLog::from_json_value(value).unwrap();
    assert_eq!(log, sample_log());
}

#[test]
fn fixture_replay_log_rejects_mismatched_schema_version_from_disk() {
    let golden_str = include_str!("fixtures/replay_log_golden.json");
    let mut value: Value = serde_json::from_str(golden_str).unwrap();
    value["schemaVersion"] = Value::String("0.99.0-future".to_string());
    let error = ReplayLog::from_json_value(value).unwrap_err();
    let downcast = error.downcast::<InputError>().unwrap();
    match *downcast {
        InputError::UnsupportedSchemaVersion {
            observed,
            expected,
            code,
        } => {
            assert_eq!(observed, "0.99.0-future");
            assert_eq!(expected, REPLAY_LOG_SCHEMA_VERSION);
            assert_eq!(code, "utsushi.replay.unsupported_schema_version");
        }
        other => panic!("expected UnsupportedSchemaVersion, got {other:?}"),
    }
}

#[test]
fn runtime_request_replay_field_is_additive_and_shared_via_arc() {
    let log = sample_log();
    let shared = Arc::new(log.clone());
    // The field is additive; constructing a request without replay still
    // works exactly as in the UTSUSHI-020 baseline.
    let bare = RuntimeRequest::new(std::path::Path::new("/scratch/cwd"));
    assert!(bare.replay.is_none());

    let with_replay =
        RuntimeRequest::new(std::path::Path::new("/scratch/cwd")).with_replay(Arc::clone(&shared));
    let inner = with_replay.replay.as_ref().expect("replay field populated");
    assert!(Arc::ptr_eq(inner, &shared));

    // Adapters consume events via next_event, not via replay queries on the
    // request directly.
    let mut cursor = ReplayCursor::start();
    let (entry, _) = inner.next_event(cursor).unwrap().unwrap();
    assert_eq!(entry.tick, LogicalClockTick(1));
    assert_eq!(entry.event.kind(), InputKind::Text);
    cursor = ReplayCursor::start();
    let mut count = 0;
    while inner.next_event(cursor).unwrap().is_some() {
        let next = inner.next_event(cursor).unwrap().unwrap().1;
        cursor = next;
        count += 1;
    }
    assert_eq!(count, log.events().len());
}

#[test]
fn runtime_request_debug_does_not_leak_replay_log_contents() {
    let log = sample_log();
    let shared = Arc::new(log);
    let request =
        RuntimeRequest::new(std::path::Path::new("/scratch/cwd")).with_replay(Arc::clone(&shared));
    let debug = format!("{request:?}");
    assert!(
        debug.contains("Arc<ReplayLog>"),
        "expected debug to elide replay contents; got {debug}"
    );
    // Should not surface the run id verbatim.
    assert!(
        !debug.contains("replay-fixture-1"),
        "Debug must not leak the recorded run id; got {debug}"
    );
}

#[test]
fn replay_log_supports_menu_select_and_raw_variants_via_round_trip() {
    let mut builder = ReplayLogBuilder::new().metadata(ReplayMetadata {
        run_id: "replay-menu-fixture".to_string(),
        adapter_name: "fixture".to_string(),
        adapter_version: "0.1.0".to_string(),
        clock_origin: ClockOrigin::SnapshotRestore,
        seed: 7,
        source_label: None,
    });
    builder
        .record(
            LogicalClockTick(1),
            InputEvent::MenuSelect {
                target: MenuTarget::new("main_menu", "items"),
            },
        )
        .unwrap();
    builder
        .record(
            LogicalClockTick(2),
            InputEvent::raw("fixture", "diag-token"),
        )
        .unwrap();
    builder
        .record(LogicalClockTick(3), InputEvent::Skip { enable: true })
        .unwrap();
    builder
        .record(LogicalClockTick(4), InputEvent::Auto { enable: false })
        .unwrap();
    builder
        .record(LogicalClockTick(5), InputEvent::Save { slot: 1 })
        .unwrap();
    builder
        .record(LogicalClockTick(6), InputEvent::Load { slot: 1 })
        .unwrap();
    let log = builder.build().unwrap();
    let value = log.to_json_value().unwrap();
    let back = ReplayLog::from_json_value(value).unwrap();
    assert_eq!(log, back);
    // Sanity: 6 distinct kinds visited.
    let kinds: Vec<InputKind> = back
        .events()
        .iter()
        .map(|entry| entry.event.kind())
        .collect();
    assert_eq!(
        kinds,
        vec![
            InputKind::MenuSelect,
            InputKind::Raw,
            InputKind::Skip,
            InputKind::Auto,
            InputKind::Save,
            InputKind::Load,
        ]
    );
}

#[test]
fn replay_log_pointer_round_trip_preserves_exact_float_bits() {
    let mut builder = ReplayLogBuilder::new().metadata(ReplayMetadata {
        run_id: "replay-pointer-bits".to_string(),
        adapter_name: "fixture".to_string(),
        adapter_version: "0.1.0".to_string(),
        clock_origin: ClockOrigin::RunStart,
        seed: 0,
        source_label: None,
    });
    let event = InputEvent::Pointer {
        x: 0.125_f32,
        y: 0.875_f32,
        button: PointerButton::Secondary,
    };
    builder.record(LogicalClockTick(1), event.clone()).unwrap();
    let log = builder.build().unwrap();
    let value = log.to_json_value().unwrap();
    let back = ReplayLog::from_json_value(value).unwrap();
    let returned = back.events()[0].event.clone();
    // PartialEq for InputEvent::Pointer is exact float equality.
    assert_eq!(returned, event);
}

#[test]
fn replay_entry_struct_is_useful_to_external_consumers() {
    // Smoke test: external crates iterate via the public struct surface.
    let log = sample_log();
    for entry in log.iter() {
        let _: &ReplayEntry = entry;
        let _: LogicalClockTick = entry.tick;
        let _: &InputEvent = &entry.event;
    }
}
