use super::*;
use crate::replay::DiagnosticReason;

fn text(event: &LinkedEvent) -> &LinkedTextEvent {
    match event {
        LinkedEvent::Text(text) => text,
        other @ LinkedEvent::Choice(_) => panic!("expected text event, got {other:?}"),
    }
}

fn choice(event: &LinkedEvent) -> &LinkedChoiceEvent {
    match event {
        LinkedEvent::Choice(choice) => choice,
        other @ LinkedEvent::Text(_) => panic!("expected choice event, got {other:?}"),
    }
}

#[test]
fn message_window_carries_its_source_unit_link() {
    let document = json!({
        "eventList": [
            { "code": 101, "parameters": ["", 0, 0, 2, "Alice"] },
            { "code": 401, "parameters": ["Hello."] },
            { "code": 401, "parameters": ["How are you?"] },
            { "code": 0, "parameters": [] },
        ],
        "sourceUnitLinks": [
            { "commandIndex": 0, "sourceUnitKey": "mvmz.map1.ev1.msg000", "bridgeUnitId": "019ed0-bu-1" },
        ],
    });
    let pack = ReplayPack::from_json(&document).unwrap();
    let outcome = replay_pack(&pack, UnknownPolicy::SkipWithDiagnostic).unwrap();
    assert_eq!(outcome.linked_events.len(), 1);
    let event = text(&outcome.linked_events[0]);
    assert_eq!(event.speaker.as_deref(), Some("Alice"));
    assert_eq!(event.lines, vec!["Hello.", "How are you?"]);
    assert_eq!(
        event.link,
        Some(SourceUnitLink {
            source_unit_key: "mvmz.map1.ev1.msg000".to_string(),
            bridge_unit_id: Some("019ed0-bu-1".to_string()),
        })
    );
    assert!(outcome.base.diagnostics.is_empty());
}

#[test]
fn choice_options_align_to_route_map_ids() {
    let document = json!({
        "eventList": [
            { "code": 102, "parameters": [["The forest path", "The mountain pass"], 1] },
        ],
        "routeAlignments": [
            { "commandIndex": 0, "options": [
                { "optionIndex": 0, "routeKey": "route.forest", "sourceUnitKey": "mvmz.map1.ch0.opt0" },
                { "optionIndex": 1, "routeKey": "route.mountain", "sourceUnitKey": "mvmz.map1.ch0.opt1" },
            ] },
        ],
    });
    let pack = ReplayPack::from_json(&document).unwrap();
    let outcome = replay_pack(&pack, UnknownPolicy::SkipWithDiagnostic).unwrap();
    assert_eq!(outcome.linked_events.len(), 1);
    let event = choice(&outcome.linked_events[0]);
    assert_eq!(event.options.len(), 2);
    assert_eq!(event.options[0].label, "The forest path");
    assert_eq!(event.options[0].route_key.as_deref(), Some("route.forest"));
    assert_eq!(
        event.options[1].route_key.as_deref(),
        Some("route.mountain")
    );
    assert_eq!(
        event.options[0]
            .link
            .as_ref()
            .map(|l| l.source_unit_key.as_str()),
        Some("mvmz.map1.ch0.opt0")
    );
}

#[test]
fn unsupported_command_in_pack_surfaces_typed_diagnostic_not_silent() {
    // Code 355 (Script) is outside the declared subset — the base outcome
    // must diagnose it, and the enriched stream must not swallow it.
    let document = json!({
        "eventList": [
            { "code": 101, "parameters": ["", 0, 0, 2, "Bob"] },
            { "code": 401, "parameters": ["A line."] },
            { "code": 355, "parameters": ["$gameSwitches.setValue(2, true)"] },
        ],
        "sourceUnitLinks": [
            { "commandIndex": 0, "sourceUnitKey": "mvmz.map1.ev2.msg000" },
        ],
    });
    let pack = ReplayPack::from_json(&document).unwrap();
    let outcome = replay_pack(&pack, UnknownPolicy::SkipWithDiagnostic).unwrap();
    // The message window still emitted, with its link (no bridge id here).
    assert_eq!(outcome.linked_events.len(), 1);
    assert_eq!(
        text(&outcome.linked_events[0]).link,
        Some(SourceUnitLink {
            source_unit_key: "mvmz.map1.ev2.msg000".to_string(),
            bridge_unit_id: None,
        })
    );
    // The unsupported command did NOT vanish: it is a typed diagnostic.
    assert_eq!(outcome.base.diagnostics.len(), 1);
    assert_eq!(outcome.base.diagnostics[0].code, 355);
    assert_eq!(
        outcome.base.diagnostics[0].reason,
        DiagnosticReason::CommandOutsideSubset { code: 355 }
    );
}

#[test]
fn fail_policy_propagates_the_base_diagnostic() {
    let document = json!({
        "eventList": [
            { "code": 205, "parameters": [] },
        ],
    });
    let pack = ReplayPack::from_json(&document).unwrap();
    let error = replay_pack(&pack, UnknownPolicy::Fail).unwrap_err();
    assert_eq!(error.code, 205);
    assert_eq!(
        error.reason,
        DiagnosticReason::CommandOutsideSubset { code: 205 }
    );
}

#[test]
fn option_without_alignment_defaults_to_no_route() {
    let document = json!({
        "eventList": [
            { "code": 102, "parameters": [["Yes", "No"], 1] },
        ],
    });
    let pack = ReplayPack::from_json(&document).unwrap();
    let outcome = replay_pack(&pack, UnknownPolicy::SkipWithDiagnostic).unwrap();
    let event = choice(&outcome.linked_events[0]);
    assert_eq!(event.options.len(), 2);
    assert!(event.options.iter().all(|o| o.route_key.is_none()));
    assert!(event.options.iter().all(|o| o.link.is_none()));
}

#[test]
fn missing_event_list_is_a_pack_error() {
    let document = json!({ "sourceUnitLinks": [] });
    let error = ReplayPack::from_json(&document).unwrap_err();
    assert!(matches!(error, PackError::MalformedPack { .. }));
}
