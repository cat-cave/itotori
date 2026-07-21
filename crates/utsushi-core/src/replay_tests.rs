use super::*;
use crate::input::{ChoiceIndex, MenuTarget, PointerButton};
use serde_json::json;

fn sample_metadata() -> ReplayMetadata {
    ReplayMetadata {
        run_id: "replay-test-1".to_string(),
        adapter_name: "fixture".to_string(),
        adapter_version: "0.1.0".to_string(),
        clock_origin: ClockOrigin::RunStart,
        seed: 42,
        source_label: Some("public-fixture:hello-game".to_string()),
    }
}

fn small_log() -> ReplayLog {
    let mut builder = ReplayLogBuilder::new().metadata(sample_metadata());
    builder
        .record(LogicalClockTick(1), InputEvent::text())
        .unwrap();
    builder
        .record(LogicalClockTick(2), InputEvent::choice(0))
        .unwrap();
    builder
        .record(LogicalClockTick(3), InputEvent::text())
        .unwrap();
    builder
        .record(LogicalClockTick(4), InputEvent::advance())
        .unwrap();
    builder.build().unwrap()
}

#[test]
fn replay_log_builder_records_events_in_strictly_monotonic_tick_order() {
    let log = small_log();
    assert_eq!(log.events().len(), 4);
    let ticks: Vec<u64> = log.events().iter().map(|entry| entry.tick.0).collect();
    assert_eq!(ticks, vec![1, 2, 3, 4]);
}

#[test]
fn replay_log_builder_rejects_non_monotonic_tick_with_typed_error() {
    let mut builder = ReplayLogBuilder::new().metadata(sample_metadata());
    builder
        .record(LogicalClockTick(2), InputEvent::text())
        .unwrap();
    let error = builder
        .record(LogicalClockTick(2), InputEvent::text())
        .unwrap_err();
    match error {
        InputError::NonMonotonicTick {
            previous,
            attempted,
            code,
        } => {
            assert_eq!(previous, LogicalClockTick(2));
            assert_eq!(attempted, LogicalClockTick(2));
            assert_eq!(code, "utsushi.replay.non_monotonic_tick");
        }
        other => panic!("expected NonMonotonicTick, got {other:?}"),
    }
    let error_back = builder
        .record(LogicalClockTick(1), InputEvent::text())
        .unwrap_err();
    assert!(matches!(error_back, InputError::NonMonotonicTick { .. }));
}

#[test]
fn replay_log_builder_rejects_event_with_redaction_violation() {
    let mut builder = ReplayLogBuilder::new().metadata(sample_metadata());
    let event = InputEvent::MenuSelect {
        target: MenuTarget::new("main_menu", "/home/trevor/secret"),
    };
    let error = builder.record(LogicalClockTick(1), event).unwrap_err();
    match error {
        InputError::RedactionViolation { code, field_path } => {
            assert_eq!(code, "utsushi.replay.redaction_violation");
            assert!(field_path.contains("itemId"));
        }
        other => panic!("expected RedactionViolation, got {other:?}"),
    }
}

#[test]
fn replay_log_builder_requires_metadata() {
    let builder = ReplayLogBuilder::new();
    let error = builder.build().unwrap_err();
    assert!(matches!(error, InputError::InvalidPayload { .. }));
}

#[test]
fn replay_log_round_trips_through_serde_json() {
    let log = small_log();
    let value = log.to_json_value().unwrap();
    let back = ReplayLog::from_json_value(value).unwrap();
    assert_eq!(log, back);
}

#[test]
fn replay_log_to_json_value_passes_reject_unredacted_local_paths() {
    let log = small_log();
    let value = log.to_json_value().unwrap();
    // Doubly-sure: the helper reused at the runtime boundary must accept.
    crate::reject_unredacted_local_paths_public("", &value).unwrap();
}

#[test]
fn replay_log_from_json_value_rejects_mismatched_schema_version() {
    let log = small_log();
    let mut value = log.to_json_value().unwrap();
    value["schemaVersion"] = json!("9.9.9");
    let error = ReplayLog::from_json_value(value).unwrap_err();
    let downcast = error.downcast::<InputError>().unwrap();
    match *downcast {
        InputError::UnsupportedSchemaVersion {
            observed,
            expected,
            code,
        } => {
            assert_eq!(observed, "9.9.9");
            assert_eq!(expected, "0.1.0-alpha");
            assert_eq!(code, "utsushi.replay.unsupported_schema_version");
        }
        other => panic!("expected UnsupportedSchemaVersion, got {other:?}"),
    }
}

#[test]
fn replay_log_from_json_value_rejects_non_monotonic_ticks_in_payload() {
    let log = small_log();
    let mut value = log.to_json_value().unwrap();
    // forge the second entry tick to equal the first
    value["events"][1]["tick"] = json!(1);
    let error = ReplayLog::from_json_value(value).unwrap_err();
    let downcast = error.downcast::<InputError>().unwrap();
    assert!(matches!(*downcast, InputError::NonMonotonicTick { .. }));
}

#[test]
fn replay_log_serialized_form_does_not_embed_asset_bytes() {
    // Synthesize a 100-event log with the heaviest variants the substrate
    // supports and verify the JSON ceiling.
    let mut builder = ReplayLogBuilder::new().metadata(sample_metadata());
    for index in 0..100u64 {
        let tick = LogicalClockTick(index + 1);
        let event = match index % 5 {
            0 => InputEvent::text(),
            1 => InputEvent::choice_with_bridge((index as u16) % 8, "bridge-unit-id-token"),
            2 => InputEvent::Pointer {
                x: (index as f32) / 100.0,
                y: 1.0 - (index as f32) / 100.0,
                button: PointerButton::Primary,
            },
            3 => InputEvent::MenuSelect {
                target: MenuTarget::new("main_menu", format!("item-{index}")),
            },
            _ => InputEvent::raw("fixture", format!("token-{index}")),
        };
        builder.record(tick, event).unwrap();
    }
    let log = builder.build().unwrap();
    let serialized = serde_json::to_string(&log).unwrap();
    // Ceiling: 16 KiB so any binary embedding regresses loudly.
    assert!(
        serialized.len() < 16 * 1024,
        "serialized replay log too large: {} bytes",
        serialized.len()
    );
}

#[test]
fn replay_log_asset_refs_only_contain_vfs_scheme_ids() {
    let mut builder = ReplayLogBuilder::new().metadata(sample_metadata());
    builder.note_asset(AssetId::parse("vfs://hello/intro.txt").unwrap());
    builder.note_asset(AssetId::parse("vfs://hello/scene/02.txt").unwrap());
    builder
        .record(LogicalClockTick(1), InputEvent::text())
        .unwrap();
    let log = builder.build().unwrap();
    for id in log.asset_refs() {
        assert!(id.as_str().starts_with("vfs://"));
        // round-tripping through parse must succeed (canonical form).
        let parsed = AssetId::parse(id.as_str()).unwrap();
        assert_eq!(&parsed, id);
    }
    // and the serialized form preserves them.
    let value = log.to_json_value().unwrap();
    let refs = value.get("assetRefs").unwrap().as_array().unwrap();
    assert_eq!(refs.len(), 2);
    assert!(
        refs.iter()
            .all(|v| v.as_str().unwrap().starts_with("vfs://"))
    );
}

#[test]
fn replay_cursor_drives_log_end_to_end_and_terminates_at_end() {
    let log = small_log();
    let mut cursor = ReplayCursor::start();
    let mut collected = Vec::new();
    while let Some((entry, next)) = log.next_event(cursor).unwrap() {
        collected.push(entry);
        cursor = next;
    }
    assert_eq!(collected.len(), 4);
    // one more call returns None
    assert!(log.next_event(cursor).unwrap().is_none());
}

#[test]
fn replay_cursor_rejects_past_end_position() {
    let log = small_log();
    let error = log
        .next_event(ReplayCursor(log.events().len() + 1))
        .unwrap_err();
    assert!(matches!(error, InputError::InvalidPayload { .. }));
}

#[test]
fn replay_log_redaction_walk_catches_path_in_metadata_source_label() {
    let mut builder = ReplayLogBuilder::new().metadata(ReplayMetadata {
        source_label: Some("/home/trevor/private-game".to_string()),
        ..sample_metadata()
    });
    builder
        .record(LogicalClockTick(1), InputEvent::text())
        .unwrap();
    let error = builder.build().unwrap_err();
    match error {
        InputError::RedactionViolation { field_path, .. } => {
            assert!(field_path.contains("sourceLabel"));
        }
        other => panic!("expected RedactionViolation, got {other:?}"),
    }
}

#[test]
fn replay_log_pointer_invalid_payload_surfaces_typed_error() {
    let mut builder = ReplayLogBuilder::new().metadata(sample_metadata());
    let bad = InputEvent::Pointer {
        x: 1.5,
        y: 0.0,
        button: PointerButton::Primary,
    };
    let error = builder.record(LogicalClockTick(1), bad).unwrap_err();
    assert!(matches!(
        error,
        InputError::InvalidPayload {
            kind: crate::input::InputKind::Pointer,
            ..
        }
    ));
}

#[test]
fn replay_schema_version_default_matches_pinned_constant() {
    assert_eq!(
        ReplaySchemaVersion::default().as_str(),
        REPLAY_LOG_SCHEMA_VERSION
    );
    assert_eq!(ReplaySchemaVersion::current().as_str(), "0.1.0-alpha");
}

#[test]
fn replay_log_entry_choice_index_round_trips() {
    let mut builder = ReplayLogBuilder::new().metadata(sample_metadata());
    builder
        .record(
            LogicalClockTick(1),
            InputEvent::Choice {
                index: ChoiceIndex(7),
                bridge_unit_id: None,
            },
        )
        .unwrap();
    let log = builder.build().unwrap();
    let v = log.to_json_value().unwrap();
    let back = ReplayLog::from_json_value(v).unwrap();
    assert_eq!(log, back);
}
