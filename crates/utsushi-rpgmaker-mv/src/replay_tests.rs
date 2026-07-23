use super::*;

#[test]
fn replays_show_text_window_with_speaker() {
    let list = vec![
        json!({ "code": 101, "indent": 0, "parameters": ["face", 0, 0, 2, "Alice"] }),
        json!({ "code": 401, "indent": 0, "parameters": ["Hello there."] }),
        json!({ "code": 401, "indent": 0, "parameters": ["How are you?"] }),
        json!({ "code": 0, "indent": 0, "parameters": [] }),
    ];
    let outcome = replay_event_list(&list, UnknownPolicy::SkipWithDiagnostic).unwrap();
    assert_eq!(
        outcome.events,
        vec![ReplayEvent::Text {
            speaker: Some("Alice".to_string()),
            lines: vec!["Hello there.".to_string(), "How are you?".to_string()],
        }]
    );
    assert!(outcome.diagnostics.is_empty());
}

#[test]
fn replays_choices() {
    let list = vec![json!({ "code": 102, "parameters": [["Yes", "No"], 1] })];
    let outcome = replay_event_list(&list, UnknownPolicy::SkipWithDiagnostic).unwrap();
    assert_eq!(
        outcome.events,
        vec![ReplayEvent::Choice {
            options: vec!["Yes".to_string(), "No".to_string()],
        }]
    );
}

#[test]
fn threads_switch_and_variable_state() {
    let list = vec![
        json!({ "code": 121, "parameters": [1, 1, 0] }), // switch 1 ON
        json!({ "code": 122, "parameters": [10, 10, 0, 0, 5] }), // var 10 = 5
        json!({ "code": 122, "parameters": [10, 10, 1, 0, 3] }), // var 10 += 3 => 8
        json!({ "code": 122, "parameters": [11, 11, 0, 1, 10] }), // var 11 = var 10 => 8
    ];
    let outcome = replay_event_list(&list, UnknownPolicy::SkipWithDiagnostic).unwrap();
    assert!(outcome.state.switch(1));
    assert_eq!(outcome.state.variable(10), 8);
    assert_eq!(outcome.state.variable(11), 8);
    assert_eq!(
        outcome.events,
        vec![
            ReplayEvent::SwitchChanged {
                switch_id: 1,
                value: true
            },
            ReplayEvent::VariableChanged {
                variable_id: 10,
                value: 5
            },
            ReplayEvent::VariableChanged {
                variable_id: 10,
                value: 8
            },
            ReplayEvent::VariableChanged {
                variable_id: 11,
                value: 8
            },
        ]
    );
}

#[test]
fn switch_range_and_off_value() {
    let list = vec![json!({ "code": 121, "parameters": [1, 3, 1] })]; // switches 1..=3 OFF
    let outcome = replay_event_list(&list, UnknownPolicy::SkipWithDiagnostic).unwrap();
    assert_eq!(outcome.events.len(), 3);
    assert!(!outcome.state.switch(2));
}

#[test]
fn unknown_command_skips_with_semantic_diagnostic_not_silently() {
    // Code 355 (Script) is deliberately outside the narrow skeleton.
    let list = vec![
        json!({ "code": 121, "parameters": [1, 1, 0] }),
        json!({ "code": 355, "parameters": ["$gameSwitches.setValue(2, true)"] }),
        json!({ "code": 122, "parameters": [10, 10, 0, 0, 1] }),
    ];
    let outcome = replay_event_list(&list, UnknownPolicy::SkipWithDiagnostic).unwrap();
    // The unsupported command did NOT vanish silently: it is a diagnostic.
    assert_eq!(outcome.diagnostics.len(), 1);
    let diagnostic = &outcome.diagnostics[0];
    assert_eq!(diagnostic.code, 355);
    assert_eq!(diagnostic.command_index, 1);
    assert_eq!(diagnostic.severity, DiagnosticSeverity::Unsupported);
    assert_eq!(
        diagnostic.reason,
        DiagnosticReason::CommandOutsideSubset { code: 355 }
    );
    // Replay continued: the surrounding subset commands still applied.
    assert!(outcome.state.switch(1));
    assert_eq!(outcome.state.variable(10), 1);
}

#[test]
fn unknown_command_fail_policy_aborts_with_diagnostic() {
    let list = vec![
        json!({ "code": 121, "parameters": [1, 1, 0] }),
        json!({ "code": 999, "parameters": [] }),
    ];
    let error = replay_event_list(&list, UnknownPolicy::Fail).unwrap_err();
    assert_eq!(error.code, 999);
    assert_eq!(
        error.reason,
        DiagnosticReason::CommandOutsideSubset { code: 999 }
    );
}

#[test]
fn unsupported_variable_operand_is_diagnosed_not_miscomputed() {
    // operandType 2 = random — outside the skeleton; must not silently
    // fabricate a value.
    let list = vec![json!({ "code": 122, "parameters": [10, 10, 0, 2, 1, 6] })];
    let outcome = replay_event_list(&list, UnknownPolicy::SkipWithDiagnostic).unwrap();
    assert_eq!(outcome.events.len(), 0);
    assert_eq!(outcome.diagnostics.len(), 1);
    assert_eq!(
        outcome.diagnostics[0].reason,
        DiagnosticReason::UnsupportedVariableOperand { operand_type: 2 }
    );
    // State untouched — no fabricated value.
    assert_eq!(outcome.state.variable(10), 0);
}
