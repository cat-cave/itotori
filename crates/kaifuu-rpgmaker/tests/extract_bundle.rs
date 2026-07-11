//! End-to-end adapter tests.
//!
//! - A synthetic-JSON test builds a minimal RPG Maker MV/MZ `www` tree in
//!   a tempdir (no retail bytes), runs the full [`extract_game_dir`]
//!   pipeline, and asserts unit counts/structure + the
//!   unknown-code-becomes-finding behavior. Because [`extract_game_dir`]
//!   runs the bundle through `BridgeBundleV02::validate_json`, a passing
//!   run also proves v0.2 schema validity.
//! - An `#[ignore]`d real-bytes test runs against the LustMemory corpus
//!   (env `ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ`) and asserts a
//!   non-trivial unit count + structure only — never verbatim text.

use std::fs;
use std::path::{Path, PathBuf};

use kaifuu_rpgmaker::{BridgeOpts, ExtractError, FindingKind, extract_game_dir};

/// Descend (bounded BFS) from the staged corpus root to the RPG Maker `www`
/// directory (the one that holds `data/`). The LustMemory corpus is staged
/// with an extra title-specific parent (`extracted/LustMemory/www`), so the
/// env var points at the corpus ROOT and the test resolves the game dir —
/// mirroring the utsushi-core composite real-bytes test's `locate_subdir`.
fn resolve_www_dir(root: &Path) -> PathBuf {
    fn find(dir: &Path, depth: usize) -> Option<PathBuf> {
        if dir
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.eq_ignore_ascii_case("www"))
            && dir.join("data").is_dir()
        {
            return Some(dir.to_path_buf());
        }
        if depth == 0 {
            return None;
        }
        let mut children: Vec<PathBuf> = fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect();
        children.sort();
        children
            .into_iter()
            .find_map(|child| find(&child, depth - 1))
    }
    if root.join("data").is_dir() {
        return root.to_path_buf();
    }
    find(root, 5).unwrap_or_else(|| {
        panic!(
            "ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ={} contains no `www/` dir with a `data/` \
             subdirectory (expected an RPG Maker MV/MZ install tree)",
            root.display()
        )
    })
}

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

#[test]
#[ignore = "requires ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ (read-only LustMemory corpus)"]
fn real_bytes_lustmemory_extracts_non_trivial_unit_count() {
    let root = std::env::var("ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ")
        .expect("ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ must be set for the real-bytes test");
    let www_root = resolve_www_dir(Path::new(&root));
    let www = www_root.as_path();

    let result = extract_game_dir(www, &opts()).expect("real corpus extraction must succeed");
    let units = &result.bundle.bundle.units;

    // Counts only (no verbatim text) — useful as a structural census.
    let count = |k: &str| units.iter().filter(|u| u.surface_kind == k).count();
    eprintln!(
        "[real-bytes] total_units={} assets={} | dialogue={} narration={} choice_label={} speaker_name={} database_entry={} ui_label={} metadata_text={}",
        units.len(),
        result.bundle.bundle.assets.len(),
        count("dialogue"),
        count("narration"),
        count("choice_label"),
        count("speaker_name"),
        count("database_entry"),
        count("ui_label"),
        count("metadata_text"),
    );
    let finding = |k: FindingKind| result.findings.iter().filter(|f| f.kind == k).count();
    eprintln!(
        "[real-bytes] findings total={} | unknown={} script={} plugin={} control_var={}",
        result.findings.len(),
        finding(FindingKind::UnknownCommandCode),
        finding(FindingKind::ScriptCommandText),
        finding(FindingKind::PluginCommandText),
        finding(FindingKind::ControlVariableScriptString),
    );

    // Non-trivial: the corpus carries thousands of Show Text lines alone.
    assert!(
        units.len() > 2000,
        "expected a non-trivial unit count, got {}",
        units.len()
    );

    // Structure, not verbatim text: a spread of surface kinds + multiple
    // source files as assets.
    let has = |k: &str| units.iter().any(|u| u.surface_kind == k);
    assert!(has("dialogue"), "dialogue lines present");
    assert!(has("choice_label"), "choice labels present");
    assert!(has("narration"), "scrolling narration present");
    assert!(has("database_entry"), "database surfaces present");
    assert!(
        has("ui_label") || has("metadata_text"),
        "system surfaces present"
    );
    assert!(
        result.bundle.bundle.assets.len() >= 5,
        "multiple data files contributed assets, got {}",
        result.bundle.bundle.assets.len()
    );

    // Every observed plugin/script command is now either a D_TEXT unit or a
    // typed opaque occurrence. The closed-set proof in the companion
    // multi-title test checks the command names and reasons; this legacy
    // LustMemory smoke keeps the no-generic-bucket invariant local too.
    assert_eq!(
        result
            .findings
            .iter()
            .filter(|f| {
                matches!(
                    f.kind,
                    FindingKind::PluginCommandText
                        | FindingKind::ScriptCommandText
                        | FindingKind::ControlVariableScriptString
                )
            })
            .count(),
        0,
        "LustMemory plugin/script commands must be typed or translatable"
    );

    // Recognized message-bearing plugin commands (e.g. D_TEXT) extract their
    // display text as units keyed by their parameters/0 pointer. They map to
    // the `narration` surface and carry a `rpgmaker.plugin.*` control-markup
    // span over the command keyword, which is how they are identified here
    // (counts only — never verbatim text).
    let plugin_text_units: Vec<_> = units
        .iter()
        .filter(|u| {
            u.surface_kind == "narration"
                && u.spans.iter().any(|s| {
                    s.parsed_name
                        .as_ref()
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|name| name.starts_with("rpgmaker.plugin."))
                })
        })
        .collect();
    eprintln!(
        "[real-bytes] recognized plugin/script-command text units={} (D_TEXT)",
        plugin_text_units.len()
    );
    assert!(
        !plugin_text_units.is_empty(),
        "the corpus's D_TEXT plugin commands must extract as translatable units"
    );

    // No engine-control command was mis-extracted as dialogue: every
    // recognized plugin-text unit keeps its command keyword protected as a
    // preserve-exact span (so the keyword/size are never sent to a
    // translator as prose).
    for unit in &plugin_text_units {
        assert!(
            unit.spans.iter().any(|s| {
                s.parsed_name
                    .as_ref()
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|name| {
                        name.starts_with("rpgmaker.plugin.") && name.ends_with(".command")
                    })
            }),
            "recognized plugin text must protect its command keyword"
        );
    }

    // Every protected span's byte range must reproduce its raw substring
    // (the v0.2 validator already enforced this; assert again as a
    // structural guard against silent corruption).
    for unit in units {
        for span in &unit.spans {
            let (start, end) = (span.start_byte as usize, span.end_byte as usize);
            assert!(end <= unit.source_text.len());
            assert_eq!(
                &unit.source_text.as_bytes()[start..end],
                span.raw.as_bytes()
            );
        }
    }
}
