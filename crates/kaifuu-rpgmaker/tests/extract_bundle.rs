//! End-to-end adapter tests.
//! - A synthetic-JSON test builds a minimal RPG Maker MV/MZ `www` tree in
//!   a tempdir (no retail bytes), runs the full [`extract_game_dir`]
//!   pipeline, and asserts unit counts/structure + the
//!   unknown-code-becomes-finding behavior. Because [`extract_game_dir`]
//!   runs the bundle through `BridgeBundleV02::validate_json`, a passing
//!   run also proves v0.2 schema validity.

use std::fs;
use std::path::Path;

use kaifuu_rpgmaker::{
    BridgeOpts, ExtractError, FindingKind, QuotedSpan, Scanner, extract_game_dir,
};

fn opts() -> BridgeOpts<'static> {
    BridgeOpts {
        game_id: "rpgmaker-test",
        game_version: "test",
        source_profile_id: "kaifuu-rpgmaker-test",
        source_locale: "ja-JP",
        extractor_name: "kaifuu-rpgmaker",
        extractor_version: "0.1.0",
    }
}

fn write(path: &Path, contents: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

#[test]
fn synthetic_www_tree_extracts_dialogue_choice_scroll_db_and_unknown_finding() {
    let tmp = tempfile::tempdir().unwrap();
    let www = tmp.path().join("www");
    let data = www.join("data");

    // System.json with an encryption flag so archive detection identifies
    // the tree as RPG Maker MV/MZ (engine identification reuse).
    write(
        &data.join("System.json"),
        r#"{
            "gameTitle": "Synth Title",
            "currencyUnit": "G",
            "hasEncryptedImages": true,
            "terms": {
                "basic": ["Level", "Lv"],
                "params": ["Max HP"],
                "commands": [null, "Fight"],
                "messages": {"actorDamage": "%1 took %2 damage!"}
            },
            "equipTypes": ["", "Weapon"],
            "elements": ["", "Fire"]
        }"#,
    );

    // Map with 101 setup (MZ speaker), 401 line w/ escape code, 102 choices,
    // 105 scroll setup + 405 line, and an unknown code 70.
    write(
        &data.join("Map001.json"),
        r#"{
            "displayName": "Town",
            "events": [null, {"id": 1, "pages": [{"list": [
                {"code": 101, "indent": 0, "parameters": ["Face", 0, 0, 2, "Hero"]},
                {"code": 401, "indent": 0, "parameters": ["Hello \\v[1]!"]},
                {"code": 401, "indent": 0, "parameters": ["Second line"]},
                {"code": 102, "indent": 0, "parameters": [["Yes", "No"], 1, 0, 2, 0]},
                {"code": 402, "indent": 0, "parameters": [0, "Yes"]},
                {"code": 404, "indent": 0, "parameters": []},
                {"code": 105, "indent": 0, "parameters": [2, false]},
                {"code": 405, "indent": 0, "parameters": ["Scrolling text"]},
                {"code": 356, "indent": 0, "parameters": ["SomePlugin do"]},
                {"code": 70, "indent": 0, "parameters": []},
                {"code": 0, "indent": 0, "parameters": []}
            ]}]}]
        }"#,
    );

    // Database name + description surfaces.
    write(
        &data.join("Items.json"),
        r#"[null, {"id": 1, "name": "Potion", "description": "Heals HP."}]"#,
    );

    let result = extract_game_dir(&www, &opts()).expect("extraction must succeed");
    let units = &result.bundle.bundle.units;

    // Surface kinds present: speaker_name, dialogue x2, choice_label x2,
    // narration, ui_label (title terms/etc.), metadata_text, database_entry.
    let kind = |k: &str| units.iter().filter(|u| u.surface_kind == k).count();
    assert_eq!(kind("dialogue"), 2, "two 401 lines");
    assert_eq!(kind("choice_label"), 2, "two choice options");
    assert_eq!(kind("narration"), 1, "one 405 scroll line");
    assert_eq!(kind("speaker_name"), 1, "MZ 101 speaker param");
    assert!(kind("database_entry") >= 2, "item name + description");
    assert!(kind("metadata_text") >= 1, "gameTitle");
    assert!(kind("ui_label") >= 5, "terms/types/displayName");

    // Stable JSON-pointer surface keys.
    assert!(
        units
            .iter()
            .any(|u| u.source_unit_key
                == "rpgmaker:Map001.json#/events/1/pages/0/list/3/parameters/0/0"),
        "choice option keyed by its array-index pointer"
    );
    assert!(
        units
            .iter()
            .any(|u| u.source_unit_key == "rpgmaker:Items.json#/1/description"),
    );

    // The 401 dialogue line carries a \v[1] protected control span.
    let dialogue = units
        .iter()
        .find(|u| u.surface_kind == "dialogue" && u.source_text.contains("Hello"))
        .expect("first dialogue line");
    assert!(
        dialogue.spans.iter().any(
            |s| s.parsed_name.as_ref().and_then(serde_json::Value::as_str)
                == Some("rpgmaker.escape.V")
        ),
        "escape code must be a protected span"
    );

    // The bridge coordinate is the exact raw quoted-string span in the
    // source file, not a decoded-text or serializer-relative offset.
    let map_bytes = fs::read(data.join("Map001.json")).expect("read synthetic map bytes");
    let range = dialogue.source_location["range"]
        .as_object()
        .expect("dialogue sourceLocation.range");
    let start = usize::try_from(
        range["startByte"]
            .as_u64()
            .expect("range.startByte is an unsigned integer"),
    )
    .expect("range.startByte fits usize");
    let end = usize::try_from(
        range["endByte"]
            .as_u64()
            .expect("range.endByte is an unsigned integer"),
    )
    .expect("range.endByte fits usize");
    let expected_raw = b"\"Hello \\\\v[1]!\"";
    let expected_start = map_bytes
        .windows(expected_raw.len())
        .position(|window| window == expected_raw)
        .expect("synthetic dialogue literal is present");
    assert_eq!(start, expected_start, "range begins at the opening quote");
    assert_eq!(end, expected_start + expected_raw.len());
    assert_eq!(&map_bytes[start..end], expected_raw);
    assert_eq!(
        Scanner::decode_span(&map_bytes, QuotedSpan { start, end })
            .expect("range remains a decodable JSON string"),
        dialogue.source_text,
    );

    // Findings: plugin (356) + unknown (70), never silently dropped.
    assert!(
        result
            .findings
            .iter()
            .any(|f| f.kind == FindingKind::PluginCommandText)
    );
    let unknown = result
        .findings
        .iter()
        .find(|f| f.kind == FindingKind::UnknownCommandCode)
        .expect("unknown code 70 must become a finding");
    assert_eq!(unknown.command_code, Some(70));
    assert!(
        !unknown.detail.contains("SomePlugin"),
        "findings must not carry source text"
    );
}

#[test]
fn non_rpg_maker_directory_is_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    let www = tmp.path().join("www");
    write(
        &www.join("data").join("Notes.json"),
        r#"{"unrelated": true}"#,
    );
    let err = extract_game_dir(&www, &opts()).expect_err("must reject non-RPG-Maker dir");
    assert!(matches!(err, ExtractError::NotRpgMaker { .. }));
}
