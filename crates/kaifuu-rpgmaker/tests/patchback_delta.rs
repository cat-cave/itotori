//! End-to-end patchback + `.kaifuu` delta producer tests.
//!
//! - Synthetic-JSON tests build a minimal `www` tree (no retail bytes),
//!   extract a bundle, turn it into a translated bundle, and assert:
//!     * an UNTRANSLATED bundle (`target == source`) round-trips
//!       BYTE-IDENTICAL (zero changed files, zero delta entries), and
//!       `kaifuu_delta::apply_delta` reproduces the tree;
//!     * a single-surface translation changes ONLY that file, only that
//!       string literal, and `apply_delta` reproduces the patched tree;
//!     * a stale on-disk source is a typed error, never a silent splice.
//! - An `#[ignore]`d real-bytes test runs the byte-identical untranslated
//!   round-trip on the LustMemory corpus. No verbatim text is asserted or
//!   printed.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use kaifuu_rpgmaker::{
    BridgeOpts, PatchbackError, PatchbackOpts, TranslatedBundleV02, apply_translated_bundle,
    extract_game_dir, produce_delta_package,
};
use serde_json::Value;

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

/// Build a minimal RPG Maker MV/MZ `www` tree under `root`.
fn build_www(root: &Path) {
    let data = root.join("data");
    write(
        &data.join("System.json"),
        r#"{"gameTitle":"Synth Title","currencyUnit":"G","hasEncryptedImages":true,"terms":{"basic":["Level","Lv"],"params":["Max HP"],"commands":[null,"Fight"],"messages":{"actorDamage":"%1 took %2 damage!"}},"equipTypes":["","Weapon"],"elements":["","Fire"]}"#,
    );
    write(
        &data.join("Map001.json"),
        r#"{"displayName":"Town","events":[null,{"id":1,"pages":[{"list":[{"code":101,"indent":0,"parameters":["Face",0,0,2,"Hero"]},{"code":401,"indent":0,"parameters":["Hello there!"]},{"code":102,"indent":0,"parameters":[["Yes","No"],1,0,2,0]},{"code":105,"indent":0,"parameters":[2,false]},{"code":405,"indent":0,"parameters":["Scrolling text"]},{"code":0,"indent":0,"parameters":[]}]}]}]}"#,
    );
    write(
        &data.join("Items.json"),
        r#"[null,{"id":1,"name":"Potion","description":"Heals HP."}]"#,
    );
    // A non-translatable file with no surfaces — must stay byte-identical.
    write(
        &data.join("MapInfos.json"),
        r#"[null,{"id":1,"name":"Town"}]"#,
    );
}

/// Add a `target.{locale,text}` to every unit. `translate` maps a unit's
/// `sourceUnitKey` to an optional replacement; `None` keeps `sourceText`
/// (an untranslated, no-op draft).
fn build_translated_bundle(bundle_json: &Value, translate: &BTreeMap<String, String>) -> Value {
    let mut translated = bundle_json.clone();
    let units = translated
        .get_mut("units")
        .and_then(Value::as_array_mut)
        .expect("bundle has units");
    for unit in units {
        let key = unit
            .get("sourceUnitKey")
            .and_then(Value::as_str)
            .expect("unit has sourceUnitKey")
            .to_string();
        let source_text = unit
            .get("sourceText")
            .and_then(Value::as_str)
            .expect("unit has sourceText")
            .to_string();
        let text = translate.get(&key).cloned().unwrap_or(source_text);
        unit["target"] = serde_json::json!({"locale": "en-US", "text": text});
    }
    translated
}

/// Recursively read a directory tree into a sorted `relative-path -> bytes`
/// map, for byte-equality comparison.
fn read_tree(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for entry in fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            if path.is_dir() {
                walk(root, &path, out);
            } else {
                let rel = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                out.insert(rel, fs::read(&path).unwrap());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

#[test]
fn untranslated_bundle_round_trips_byte_identical() {
    let tmp = tempfile::tempdir().unwrap();
    let www = tmp.path().join("www");
    build_www(&www);

    let extraction = extract_game_dir(&www, &opts()).unwrap();
    let translated = build_translated_bundle(&extraction.bundle.json, &BTreeMap::new());
    let bundle = TranslatedBundleV02::from_json(&translated).unwrap();

    // In-memory byte-identity: every patched file equals its source bytes.
    let patched =
        apply_translated_bundle(&www, &bundle, &PatchbackOpts::rpg_maker_default()).unwrap();
    let data_dir = www.join("data");
    assert!(!patched.is_empty(), "the bundle references data files");
    for (file, bytes) in &patched {
        let source = fs::read(data_dir.join(file)).unwrap();
        assert_eq!(
            bytes, &source,
            "{file} must be byte-identical for an untranslated draft"
        );
    }

    // Delta level: zero changed files, source tree == target tree.
    let patched_dir = tmp.path().join("patched-data");
    let produced = produce_delta_package(
        &www,
        &bundle,
        &PatchbackOpts::rpg_maker_default(),
        &patched_dir,
    )
    .unwrap();
    assert_eq!(
        produced.changed_file_count, 0,
        "no file changes for an untranslated draft"
    );
    assert_eq!(
        produced.delta["changedEntries"].as_array().unwrap().len(),
        0,
        "no delta entries"
    );
    assert_eq!(
        produced.delta["sourceCompatibility"]["rootHash"], produced.delta["target"]["rootHash"],
        "source and target trees hash identically"
    );

    // The materialized patched tree is byte-identical to the source data.
    assert_eq!(read_tree(&data_dir), read_tree(&patched_dir));

    // apply_delta reproduces the tree.
    let delta_path = tmp.path().join("untranslated.kaifuu");
    kaifuu_core::write_json(&delta_path, &produced.delta).unwrap();
    let output_dir = tmp.path().join("applied-untranslated");
    let report = kaifuu_delta::apply_delta(&data_dir, &delta_path, &output_dir).unwrap();
    assert_eq!(report["status"], "passed");
    assert_eq!(read_tree(&output_dir), read_tree(&data_dir));
}

#[test]
fn single_surface_translation_changes_only_that_surface() {
    let tmp = tempfile::tempdir().unwrap();
    let www = tmp.path().join("www");
    build_www(&www);
    let data_dir = www.join("data");
    let source_tree = read_tree(&data_dir);

    let extraction = extract_game_dir(&www, &opts()).unwrap();

    // Translate exactly one surface: the Items.json item name.
    let target_key = "rpgmaker:Items.json#/1/name".to_string();
    let mut translate = BTreeMap::new();
    translate.insert(target_key.clone(), "Elixir".to_string());
    let translated = build_translated_bundle(&extraction.bundle.json, &translate);
    let bundle = TranslatedBundleV02::from_json(&translated).unwrap();

    let patched =
        apply_translated_bundle(&www, &bundle, &PatchbackOpts::rpg_maker_default()).unwrap();

    // Every referenced file except Items.json is byte-identical; Items.json
    // changed ONLY in the targeted `name` literal.
    for (file, bytes) in &patched {
        let source = fs::read(data_dir.join(file)).unwrap();
        if file == "Items.json" {
            assert_ne!(bytes, &source);
            // Surgical: source/target differ only by "Potion" -> "Elixir".
            let source_str = String::from_utf8(source).unwrap();
            let target_str = String::from_utf8(bytes.clone()).unwrap();
            assert_eq!(
                source_str.replacen("\"Potion\"", "\"Elixir\"", 1),
                target_str
            );
        } else {
            assert_eq!(bytes, &source, "{file} must be untouched");
        }
    }

    // Delta: exactly one changed file (Items.json) + apply reproduces.
    let patched_dir = tmp.path().join("patched-data");
    let produced = produce_delta_package(
        &www,
        &bundle,
        &PatchbackOpts::rpg_maker_default(),
        &patched_dir,
    )
    .unwrap();
    assert_eq!(produced.changed_file_count, 1);
    let changed: Vec<&str> = produced.delta["changedEntries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["path"].as_str().unwrap())
        .collect();
    assert_eq!(changed, vec!["Items.json"]);

    // Non-targeted files in the patched tree are byte-identical to source.
    let patched_tree = read_tree(&patched_dir);
    for (file, source_bytes) in &source_tree {
        if file != "Items.json" {
            assert_eq!(
                &patched_tree[file], source_bytes,
                "{file} unchanged in patched tree"
            );
        }
    }

    let delta_path = tmp.path().join("translated.kaifuu");
    kaifuu_core::write_json(&delta_path, &produced.delta).unwrap();
    let output_dir = tmp.path().join("applied-translated");
    let report = kaifuu_delta::apply_delta(&data_dir, &delta_path, &output_dir).unwrap();
    assert_eq!(report["status"], "passed");
    assert_eq!(read_tree(&output_dir), patched_tree);

    // Re-extracting the patched tree resolves the translated text at the
    // same surface key (proves the surface stayed targetable).
    let patched_www = tmp.path().join("patched-www");
    fs::create_dir_all(patched_www.join("data")).unwrap();
    for (file, bytes) in &patched_tree {
        fs::write(patched_www.join("data").join(file), bytes).unwrap();
    }
    let re = extract_game_dir(&patched_www, &opts()).unwrap();
    let unit = re
        .bundle
        .bundle
        .units
        .iter()
        .find(|u| u.source_unit_key == target_key)
        .expect("translated surface re-extracts at the same key");
    assert_eq!(unit.source_text, "Elixir");
}

#[test]
fn stale_on_disk_source_is_typed_error() {
    let tmp = tempfile::tempdir().unwrap();
    let www = tmp.path().join("www");
    build_www(&www);

    let extraction = extract_game_dir(&www, &opts()).unwrap();
    let translated = build_translated_bundle(&extraction.bundle.json, &BTreeMap::new());
    let bundle = TranslatedBundleV02::from_json(&translated).unwrap();

    // Mutate the on-disk source AFTER extraction: the bundle's recorded
    // sourceHash no longer matches the located literal.
    fs::write(
        www.join("data").join("Items.json"),
        r#"[null,{"id":1,"name":"Tonic","description":"Heals HP."}]"#,
    )
    .unwrap();

    let err = apply_translated_bundle(&www, &bundle, &PatchbackOpts::rpg_maker_default())
        .expect_err("a stale source must be a typed error, not a silent splice");
    assert!(
        matches!(err, PatchbackError::StaleSource { .. }),
        "expected StaleSource, got {err:?}"
    );
}

#[test]
#[ignore = "requires ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ (read-only LustMemory corpus)"]
fn real_bytes_untranslated_round_trip_is_byte_identical() {
    let root = std::env::var("ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ")
        .expect("ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ must be set for the real-bytes test");
    let www = Path::new(&root);

    let extraction = extract_game_dir(www, &opts()).expect("real corpus extraction");
    let unit_count = extraction.bundle.bundle.units.len();
    let translated = build_translated_bundle(&extraction.bundle.json, &BTreeMap::new());
    let bundle = TranslatedBundleV02::from_json(&translated).expect("translated bundle parses");

    // In-memory byte-identity for every referenced file (proves every
    // surfaced unit is patch-back-targetable AND no spurious diffs).
    let data_dir = www.join("data");
    let patched =
        apply_translated_bundle(www, &bundle, &PatchbackOpts::rpg_maker_default()).expect("apply");
    for (file, bytes) in &patched {
        let source = fs::read(data_dir.join(file)).expect("read source data file");
        assert_eq!(bytes, &source, "{file} must round-trip byte-identical");
    }
    eprintln!(
        "[real-bytes] untranslated round-trip byte-identical over {} referenced files ({unit_count} units)",
        patched.len()
    );

    // Delta level: zero changed files + apply reproduces the source tree.
    let tmp = tempfile::tempdir().unwrap();
    let patched_dir = tmp.path().join("patched-data");
    let produced = produce_delta_package(
        www,
        &bundle,
        &PatchbackOpts::rpg_maker_default(),
        &patched_dir,
    )
    .expect("delta produce");
    assert_eq!(
        produced.changed_file_count, 0,
        "no changed files for an untranslated draft"
    );
    assert_eq!(
        produced.delta["changedEntries"].as_array().unwrap().len(),
        0
    );
    assert_eq!(
        produced.delta["sourceCompatibility"]["rootHash"],
        produced.delta["target"]["rootHash"]
    );

    let delta_path = tmp.path().join("real.kaifuu");
    kaifuu_core::write_json(&delta_path, &produced.delta).unwrap();
    let output_dir = tmp.path().join("applied");
    let report =
        kaifuu_delta::apply_delta(&data_dir, &delta_path, &output_dir).expect("apply_delta");
    assert_eq!(report["status"], "passed");
    assert_eq!(
        read_tree(&output_dir),
        read_tree(&data_dir),
        "apply reproduces the source tree"
    );
}
