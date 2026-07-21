use super::*;
use serde_json::json;

#[test]
fn input_event_text_serializes_and_round_trips() {
    let event = InputEvent::text();
    let value = serde_json::to_value(&event).unwrap();
    assert_eq!(value, json!({ "kind": "text" }));
    let round: InputEvent = serde_json::from_value(value).unwrap();
    assert_eq!(round, event);
    assert_eq!(round.kind(), InputKind::Text);
}

#[test]
fn input_event_choice_round_trips_index_and_optional_bridge_id() {
    let event = InputEvent::choice_with_bridge(2, "unit-7");
    let value = serde_json::to_value(&event).unwrap();
    assert_eq!(
        value,
        json!({ "kind": "choice", "index": 2, "bridge_unit_id": "unit-7" })
    );
    let round: InputEvent = serde_json::from_value(value).unwrap();
    assert_eq!(round, event);
    let no_bridge = InputEvent::choice(0);
    let v2 = serde_json::to_value(&no_bridge).unwrap();
    // bridge id absent must be skipped on serialize
    assert_eq!(v2, json!({ "kind": "choice", "index": 0 }));
}

#[test]
fn input_event_menu_select_round_trips_menu_and_item_ids() {
    let event = InputEvent::MenuSelect {
        target: MenuTarget::new("main_menu", "items"),
    };
    let value = serde_json::to_value(&event).unwrap();
    assert_eq!(
        value,
        json!({
            "kind": "menu_select",
            "target": { "menuId": "main_menu", "itemId": "items" }
        })
    );
    let round: InputEvent = serde_json::from_value(value).unwrap();
    assert_eq!(round, event);
}

#[test]
fn input_event_menu_select_rejects_empty_item_id() {
    let event = InputEvent::MenuSelect {
        target: MenuTarget::new("main_menu", ""),
    };
    let error = event.validate_payload_shape().unwrap_err();
    match error {
        InputError::InvalidPayload { kind, code, .. } => {
            assert_eq!(kind, InputKind::MenuSelect);
            assert_eq!(code, INPUT_INVALID_PAYLOAD_CODE);
        }
        other => panic!("expected InvalidPayload, got {other:?}"),
    }
}

#[test]
fn input_event_pointer_round_trips_normalized_coordinates() {
    let event = InputEvent::Pointer {
        x: 0.25,
        y: 0.75,
        button: PointerButton::Primary,
    };
    let value = serde_json::to_value(&event).unwrap();
    assert_eq!(
        value,
        json!({
            "kind": "pointer",
            "x": 0.25,
            "y": 0.75,
            "button": "primary"
        })
    );
    let round: InputEvent = serde_json::from_value(value).unwrap();
    assert_eq!(round, event);
}

#[test]
fn input_event_pointer_rejects_out_of_range_coordinates() {
    let bad = InputEvent::Pointer {
        x: -0.1,
        y: 0.5,
        button: PointerButton::Primary,
    };
    let error = bad.validate_payload_shape().unwrap_err();
    assert!(matches!(
        error,
        InputError::InvalidPayload {
            kind: InputKind::Pointer,
            ..
        }
    ));
}

#[test]
fn input_event_raw_records_engine_and_code_without_path_leakage() {
    let event = InputEvent::raw("fixture", "diagnostic-token");
    let value = serde_json::to_value(&event).unwrap();
    assert_eq!(
        value,
        json!({
            "kind": "raw",
            "code": { "engine": "fixture", "code": "diagnostic-token" }
        })
    );
    let round: InputEvent = serde_json::from_value(value).unwrap();
    assert_eq!(round, event);
    assert_eq!(round.kind(), InputKind::Raw);
}

#[test]
fn input_event_kind_matches_payload_for_every_variant() {
    let cases: Vec<(InputEvent, InputKind)> = vec![
        (InputEvent::text(), InputKind::Text),
        (InputEvent::choice(1), InputKind::Choice),
        (InputEvent::advance(), InputKind::Advance),
        (InputEvent::Skip { enable: true }, InputKind::Skip),
        (InputEvent::Auto { enable: false }, InputKind::Auto),
        (InputEvent::Save { slot: 0 }, InputKind::Save),
        (InputEvent::Load { slot: 3 }, InputKind::Load),
        (
            InputEvent::MenuSelect {
                target: MenuTarget::new("main_menu", "items"),
            },
            InputKind::MenuSelect,
        ),
        (
            InputEvent::Pointer {
                x: 0.0,
                y: 0.0,
                button: PointerButton::Auxiliary,
            },
            InputKind::Pointer,
        ),
        (InputEvent::raw("fixture", "code"), InputKind::Raw),
    ];
    for (event, kind) in cases {
        assert_eq!(event.kind(), kind, "event {event:?} kind mismatch");
    }
}

#[test]
fn input_event_serde_rejects_unknown_fields_on_tagged_variants() {
    let value = json!({ "kind": "advance", "garbage": true });
    let parsed: Result<InputEvent, _> = serde_json::from_value(value);
    assert!(parsed.is_err());
}

#[test]
fn input_error_unsupported_kind_carries_stable_semantic_code() {
    let supported: &'static [InputKind] = &[InputKind::Text, InputKind::Choice];
    let error = InputError::unsupported_kind("pointer", supported);
    assert_eq!(error.semantic_code(), INPUT_UNSUPPORTED_KIND_CODE);
    assert_eq!(error.semantic_code(), "utsushi.input.unsupported_kind");
    match error {
        InputError::UnsupportedKind {
            kind,
            supported: actual,
            ..
        } => {
            assert_eq!(kind, "pointer");
            assert_eq!(actual.len(), 2);
        }
        other => panic!("expected UnsupportedKind, got {other:?}"),
    }
}

#[test]
fn input_error_semantic_codes_are_stable_strings() {
    assert_eq!(
        InputError::invalid_payload(InputKind::Choice, "x").semantic_code(),
        "utsushi.input.invalid_payload"
    );
    assert_eq!(
        InputError::clock_backtrack(LogicalClockTick(5), LogicalClockTick(3)).semantic_code(),
        "utsushi.clock.backtrack"
    );
    assert_eq!(
        InputError::non_monotonic_tick(LogicalClockTick(5), LogicalClockTick(5)).semantic_code(),
        "utsushi.replay.non_monotonic_tick"
    );
    assert_eq!(
        InputError::redaction_violation("metadata.sourceLabel").semantic_code(),
        "utsushi.replay.redaction_violation"
    );
    assert_eq!(
        InputError::unsupported_schema_version("9.9.9", "0.1.0-alpha").semantic_code(),
        "utsushi.replay.unsupported_schema_version"
    );
}

#[test]
fn input_kind_token_round_trip_via_serde() {
    for kind in [
        InputKind::Text,
        InputKind::Choice,
        InputKind::Advance,
        InputKind::Skip,
        InputKind::Auto,
        InputKind::Save,
        InputKind::Load,
        InputKind::MenuSelect,
        InputKind::Pointer,
        InputKind::Raw,
    ] {
        let value = serde_json::to_value(kind).unwrap();
        let back: InputKind = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(kind, back);
        // serialized form matches token()
        assert_eq!(value, json!(kind.token()));
    }
}
