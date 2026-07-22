use super::*;
use serde_json::json;

#[test]
fn every_declared_code_is_catalogue_recognised() {
    // The surface set never drifts from the shared catalogue
    // every code `command_text_role` handles is a recognised classify
    // code (never Unknown).
    for code in [401, 102, 402, 405, 108, 408] {
        assert!(command_text_role(code).is_some());
        assert_ne!(
            classify(code),
            CodeClass::Unknown,
            "declared code {code} must be catalogue-recognised"
        );
    }
}

#[test]
fn extract_map_covers_all_declared_surfaces_with_stable_fields() {
    let map = json!({
        "displayName": "Town",
        "events": [null, {"id": 7, "pages": [{"list": [
            {"code": 101, "parameters": ["Face", 0, 0, 2, "Hero"]},
            {"code": 401, "parameters": ["Show text line"]},
            {"code": 102, "parameters": [["Yes", "No"], 1, 0, 2, 0]},
            {"code": 402, "parameters": [0, "Yes"]},
            {"code": 404, "parameters": []},
            {"code": 105, "parameters": [2, false]},
            {"code": 405, "parameters": ["Scrolling line"]},
            {"code": 108, "parameters": ["Comment head"]},
            {"code": 408, "parameters": ["Comment tail"]},
            {"code": 999, "parameters": []}
        ]}]}]
    });
    let out = extract_map("Map001.json", &map);

    let roles: Vec<CommandTextRole> = out.units.iter().map(|u| u.text_role).collect();
    assert_eq!(
        roles,
        vec![
            CommandTextRole::ShowText,
            CommandTextRole::ChoiceOption,
            CommandTextRole::ChoiceOption,
            CommandTextRole::ChoiceBranch,
            CommandTextRole::ScrollingText,
            CommandTextRole::Comment,
            CommandTextRole::Comment,
        ]
    );

    // Every stable-unit acceptance field is populated.
    for unit in &out.units {
        assert_eq!(unit.source_file, "Map001.json");
        assert_eq!(unit.container_id(), 7, "event id");
        assert_eq!(unit.page_index(), Some(0), "page index");
        assert_eq!(unit.fixture_profile_id, FIXTURE_PROFILE_ID);
        assert!(!unit.bridge_unit_id().is_empty());
        assert!(unit.source_unit_key().starts_with("rpgmaker:Map001.json#/"));
    }

    // Command indices are the list positions.
    let show_text = &out.units[0];
    assert_eq!(show_text.command_index, 1);
    assert_eq!(
        show_text.source_unit_key(),
        "rpgmaker:Map001.json#/events/1/pages/0/list/1/parameters/0"
    );
    // Choice option pointer indexes into the option array.
    assert_eq!(out.units[2].option_index, Some(1));
    assert_eq!(
        out.units[2].source_unit_key(),
        "rpgmaker:Map001.json#/events/1/pages/0/list/2/parameters/0/1"
    );
    // Choice branch label is parameters[1].
    assert_eq!(
        out.units[3].source_unit_key(),
        "rpgmaker:Map001.json#/events/1/pages/0/list/3/parameters/1"
    );

    // The unrecognised code 999 becomes a semantic diagnostic, never a
    // silent drop.
    assert_eq!(out.diagnostics.len(), 1);
    assert_eq!(out.diagnostics[0].command_code, Some(999));
    assert_eq!(
        out.diagnostics[0].kind,
        CommandDiagnosticKind::UnsupportedCommand
    );
}

#[test]
fn extract_common_events_has_no_page_index() {
    let common = json!([
        null,
        {"id": 3, "name": "CE", "list": [
            {"code": 401, "parameters": ["Common line"]}
        ]}
    ]);
    let out = extract_common_events("CommonEvents.json", &common);
    assert_eq!(out.units.len(), 1);
    assert_eq!(out.units[0].container_id(), 3);
    assert_eq!(out.units[0].page_index(), None);
    assert_eq!(
        out.units[0].source_unit_key(),
        "rpgmaker:CommonEvents.json#/1/list/0/parameters/0"
    );
}

#[test]
fn empty_command_text_is_not_a_unit() {
    let map = json!({"events": [null, {"id": 1, "pages": [{"list": [
        {"code": 401, "parameters": [""]},
        {"code": 108, "parameters": [""]}
    ]}]}]});
    assert!(extract_map("Map001.json", &map).units.is_empty());
}
