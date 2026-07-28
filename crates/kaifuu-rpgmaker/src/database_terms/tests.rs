use super::*;
use serde_json::json;

#[test]
fn actors_declared_fields_extract_numeric_and_note_do_not() {
    let actors = json!([
        null,
        {
            "id": 1,
            "name": "Ariel",
            "nickname": "The Bold",
            "profile": "A wandering knight.",
            "note": "<dev tag>",
            "initialLevel": 1,
            "characterIndex": 0
        }
    ]);
    let out = extract_database("Actors.json", &actors);
    assert!(out.diagnostics.is_empty());
    let roles: Vec<&str> = out.units.iter().map(|u| u.text_role.as_str()).collect();
    assert_eq!(roles, vec!["name", "nickname", "profile"]);
    // note / initialLevel / characterIndex are never surfaced.
    for unit in &out.units {
        assert_ne!(unit.field_key, "note");
        assert_eq!(unit.entry_id(), Some(1));
        assert_eq!(unit.entry_index(), Some(1));
        assert_eq!(unit.fixture_profile_id, "synthetic-fixture");
    }
    assert_eq!(
        out.units[0].source_unit_key(),
        "rpgmaker:Actors.json#/1/name"
    );
}

#[test]
fn skills_and_states_messages_are_declared() {
    let skills = json!([
        null,
        {"id": 1, "name": "Fire", "description": "Burns.", "message1": " chants!", "message2": ""}
    ]);
    let out = extract_database("Skills.json", &skills);
    // Empty message2 is not a unit.
    let keys: Vec<&str> = out.units.iter().map(|u| u.field_key.as_str()).collect();
    assert_eq!(keys, vec!["name", "description", "message1"]);
    assert_eq!(out.units[2].text_role, DatabaseTermRole::Message);

    let states = json!([
        null,
        {"id": 1, "name": "Poison", "message1": " is poisoned!", "message2": "", "message3": "", "message4": " recovers."}
    ]);
    let out = extract_database("States.json", &states);
    let keys: Vec<&str> = out.units.iter().map(|u| u.field_key.as_str()).collect();
    assert_eq!(keys, vec!["name", "message1", "message4"]);
}

#[test]
fn troop_name_and_battle_messages_extract_unknown_code_is_diagnostic() {
    let troops = json!([
        null,
        {
            "id": 1,
            "name": "Slime*2",
            "members": [{"enemyId": 1, "x": 100, "y": 200}],
            "pages": [
                {"list": [
                    {"code": 101, "parameters": ["", 0, 0, 2]},
                    {"code": 401, "parameters": ["The slimes attack!"]},
                    {"code": 405, "parameters": ["A hush falls over the field."]},
                    {"code": 12345, "parameters": []}
                ]}
            ]
        }
    ]);
    let out = extract_database("Troops.json", &troops);
    let roles: Vec<&str> = out.units.iter().map(|u| u.text_role.as_str()).collect();
    assert_eq!(roles, vec!["name", "battle_message", "battle_message"]);
    // Troop name pointer, then the two battle messages.
    assert_eq!(
        out.units[0].source_unit_key(),
        "rpgmaker:Troops.json#/1/name"
    );
    assert_eq!(
        out.units[1].source_unit_key(),
        "rpgmaker:Troops.json#/1/pages/0/list/1/parameters/0"
    );
    assert_eq!(out.units[1].array_index, Some(1));
    // The unknown battle-event code is a diagnostic, never a silent drop.
    assert_eq!(out.diagnostics.len(), 1);
    assert_eq!(out.diagnostics[0].command_code, Some(12345));
    assert_eq!(
        out.diagnostics[0].kind,
        DatabaseDiagnosticKind::UnsupportedCommand
    );
}

#[test]
fn numeric_in_string_field_is_unsupported_field_diagnostic() {
    // A number placed where a declared string field is expected must NOT
    // be extracted, and is flagged as an unsupported field type.
    let items = json!([null, {"id": 1, "name": 42, "description": "ok"}]);
    let out = extract_database("Items.json", &items);
    assert_eq!(out.units.len(), 1, "only the string description extracts");
    assert_eq!(out.units[0].field_key, "description");
    assert_eq!(out.diagnostics.len(), 1);
    assert_eq!(
        out.diagnostics[0].kind,
        DatabaseDiagnosticKind::UnsupportedFieldType
    );
    assert_eq!(out.diagnostics[0].pointer, vec!["1", "name"]);
}

#[test]
fn malformed_database_container_is_diagnostic() {
    let out = extract_database("Items.json", &json!({"not": "an array"}));
    assert!(out.units.is_empty());
    assert_eq!(
        out.diagnostics[0].kind,
        DatabaseDiagnosticKind::MalformedContainer
    );
}

#[test]
fn system_terms_and_types_extract_with_stable_pointers() {
    let system = json!({
        "gameTitle": "My Game",
        "currencyUnit": "G",
        "versionId": 12345,
        "equipTypes": ["", "Weapon", "Shield"],
        "elements": ["", "Fire", "Ice"],
        "terms": {
            "basic": ["Level", "Lv"],
            "commands": ["Fight", "", "Escape"],
            "params": ["Max HP"],
            "messages": {"possession": "Possession", "level": "%1 Lv."}
        }
    });
    let out = extract_system("System.json", &system);
    assert!(
        out.diagnostics.is_empty(),
        "clean System has no diagnostics"
    );

    let key = |k: &str| out.units.iter().any(|u| u.source_unit_key() == k);
    assert!(key("rpgmaker:System.json#/gameTitle"));
    assert!(key("rpgmaker:System.json#/currencyUnit"));
    // Empty type-list slot 0 is not a unit; slot 1 is.
    assert!(key("rpgmaker:System.json#/equipTypes/1"));
    assert!(!key("rpgmaker:System.json#/equipTypes/0"));
    assert!(key("rpgmaker:System.json#/elements/1"));
    assert!(key("rpgmaker:System.json#/terms/basic/0"));
    // Empty commands slot 1 skipped; slot 2 kept.
    assert!(key("rpgmaker:System.json#/terms/commands/2"));
    assert!(!key("rpgmaker:System.json#/terms/commands/1"));
    assert!(key("rpgmaker:System.json#/terms/messages/level"));
    assert!(key("rpgmaker:System.json#/terms/messages/possession"));

    // gameTitle is metadata; a type list is a type_name; a term is a term.
    let title = out
        .units
        .iter()
        .find(|u| u.field_key == "gameTitle")
        .unwrap();
    assert_eq!(title.text_role, DatabaseTermRole::GameTitle);
    assert!(matches!(
        title.container,
        UnitContainer::SystemSection {
            section: "gameTitle"
        }
    ));
    // versionId (a number) is never surfaced.
    assert!(!out.units.iter().any(|u| u.field_key == "versionId"));
}

#[test]
fn deterministic_reextraction_yields_identical_units() {
    let system = json!({
        "gameTitle": "T",
        "terms": {"messages": {"b": "B", "a": "A", "c": "C"}}
    });
    let first = extract_system("System.json", &system);
    let second = extract_system("System.json", &system);
    assert_eq!(first, second);
    assert_eq!(
        first.units[0].bridge_unit_id(),
        second.units[0].bridge_unit_id()
    );
}
