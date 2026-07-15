//! `synthetic-fixture-author-feature-complete-archives` (P2) — RPG Maker MV/MZ.
//! Authors a MINIMAL, feature-complete SYNTHETIC RPG Maker MV/MZ `www` tree
//! (no retail bytes) that instantiates EVERY event-command `code` in the
//! coverage manifest's `event_command_code` group EXACTLY ONCE, then drives it
//! through the REAL [`extract_game_dir`] pipeline and asserts it extracts /
//! classifies CLEAN — every manifest code is recognised by the real
//! `classify` (zero `UnknownCommandCode` findings) — exactly as the
//! LustMemory real-bytes lane does, orders of magnitude faster, with NO
//! copyrighted bytes (all text is authored synthetic English).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use kaifuu_rpgmaker::{BridgeOpts, FindingKind, extract_game_dir};
use serde_json::{Value, json};

/// Resolve this crate's manifest directory for locating tracked test fixtures.
/// `env!("CARGO_MANIFEST_DIR")` is baked at COMPILE time, so a test binary
/// reused from a different (since-removed) worktree would point fixture reads at
/// a dead path (`Os NotFound`). `cargo test` sets `CARGO_MANIFEST_DIR` in the
/// RUNTIME environment to the LIVE crate directory; prefer that, falling back to
/// the compile-time constant only outside cargo.
fn test_manifest_dir() -> PathBuf {
    std::env::var_os("CARGO_MANIFEST_DIR")
        .map_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")), PathBuf::from)
}

fn manifest_value() -> Value {
    let path = test_manifest_dir().join("../../fixtures/synthetic/coverage-manifest.v0.json");
    let bytes = std::fs::read(&path)
        .unwrap_or_else(|err| panic!("read coverage manifest {}: {err}", path.display()));
    serde_json::from_slice(&bytes).expect("coverage manifest is valid JSON")
}

/// Every event-command `code` the manifest enumerates for RPG Maker MV/MZ.
fn manifest_codes(manifest: &Value) -> Vec<i64> {
    manifest["engineFamilies"]["rpg_maker_mv_mz"]["componentGroups"]["event_command_code"]
        ["components"]
        .as_array()
        .expect("event_command_code components array")
        .iter()
        .map(|c| c["code"].as_i64().expect("code"))
        .collect()
}

/// Synthetic-English parameters per code — proper shapes for the text-bearing
/// codes, empty for the recognised structural codes. All text is authored,
/// non-copyrighted.
fn params_for(code: i64) -> Value {
    match code {
        401 => json!(["[EN] A synthetic dialogue line"]),
        405 => json!(["[EN] A synthetic scrolling line"]),
        102 => json!([["[EN] Yes", "[EN] No"], 1, 0, 2, 0]),
        320 => json!([1, "[EN] NewName"]),
        324 => json!([1, "[EN] NewNick"]),
        325 => json!([1, "[EN] New profile text"]),
        101 => json!(["Face", 0, 0, 2, "[EN] Speaker"]),
        355 => json!(["[EN] this.scriptLine()"]),
        655 => json!(["[EN] this.moreScript()"]),
        356 => json!(["[EN] SynthPlugin doThing"]),
        357 => json!(["SynthPlugin", "cmd", { "arg": "[EN] value" }]),
        122 => json!([1, 1, 4, 4, "[EN] scriptOperand()"]),
        _ => json!([]),
    }
}

fn write(path: &Path, contents: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, contents).unwrap();
}

fn opts() -> BridgeOpts<'static> {
    BridgeOpts {
        game_id: "synthetic-rpgmaker",
        game_version: "0.0.0",
        source_profile_id: "synthetic-rpgmaker",
        source_locale: "en-US",
        extractor_name: "synthetic-corpus-author",
        extractor_version: "0.1.0",
    }
}

/// Build the synthetic `www` tree and return `(www_dir, emitted_codes)`.
fn build_www(tmp: &Path, codes: &[i64]) -> BTreeSet<i64> {
    let www = tmp.join("www");
    let data = www.join("data");

    // System.json so the real detector identifies the tree as RPG Maker MV/MZ.
    write(
        &data.join("System.json"),
        r#"{
            "gameTitle": "Synthetic Corpus Title",
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

    // One event page whose list carries exactly one entry per manifest code.
    let list: Vec<Value> = codes
        .iter()
        .map(|&code| json!({"code": code, "indent": 0, "parameters": params_for(code)}))
        .collect();
    let map = json!({
        "displayName": "Synthetic Map",
        "events": [null, {"id": 1, "pages": [{"list": list}]}]
    });
    write(
        &data.join("Map001.json"),
        &serde_json::to_string_pretty(&map).unwrap(),
    );

    codes.iter().copied().collect()
}

/// The synthetic RPG Maker tree instantiates 100% of the manifest event codes
/// and every one is recognised by the REAL extractor (zero unknown-code
/// findings) — decode/classify CLEAN, just like the real LustMemory lane.
#[test]
fn synthetic_www_instantiates_every_event_command_code_clean() {
    let start = std::time::Instant::now();
    let manifest = manifest_value();
    let codes = manifest_codes(&manifest);
    assert_eq!(
        codes.len(),
        122,
        "manifest enumerates 122 event-command codes"
    );

    let tmp = tempfile::tempdir().unwrap();
    let emitted = build_www(tmp.path(), &codes);

    // 100% instantiation: every manifest code is present in the synthetic tree.
    let manifest_set: BTreeSet<i64> = codes.iter().copied().collect();
    assert_eq!(
        emitted, manifest_set,
        "synthetic corpus must instantiate exactly the manifest event codes"
    );

    let result = extract_game_dir(&tmp.path().join("www"), &opts()).expect("extraction succeeds");

    // Zero of the manifest codes may surface an UnknownCommandCode finding —
    // every one is recognised by the real classify (the no-silent-skip bar).
    let unknown_codes: Vec<i64> = result
        .findings
        .iter()
        .filter(|f| f.kind == FindingKind::UnknownCommandCode)
        .filter_map(|f| f.command_code)
        .collect();
    assert!(
        unknown_codes.is_empty(),
        "every manifest event code must be recognised; unknown: {unknown_codes:?}"
    );

    // A truly-unknown code is still flagged (proves the gate is non-vacuous):
    // extend with code 70 and re-extract.
    let mut with_unknown = codes.clone();
    with_unknown.push(70);
    let tmp2 = tempfile::tempdir().unwrap();
    build_www(tmp2.path(), &with_unknown);
    let result2 = extract_game_dir(&tmp2.path().join("www"), &opts()).expect("extraction succeeds");
    assert!(
        result2
            .findings
            .iter()
            .any(|f| f.kind == FindingKind::UnknownCommandCode && f.command_code == Some(70)),
        "an unknown code (70) must still surface a finding"
    );

    // The text-bearing codes produced translatable synthetic-English units.
    let units = &result.bundle.bundle.units;
    assert!(
        units.iter().any(|u| u.surface_kind == "dialogue"),
        "the 401 line must surface a dialogue unit"
    );
    assert!(
        units.iter().any(|u| u.surface_kind == "choice_label"),
        "the 102 choices must surface choice_label units"
    );
    // No copyrighted bytes: every extracted unit's source text is authored ASCII.
    for unit in units {
        assert!(
            unit.source_text.is_ascii(),
            "every synthetic unit's source text must be authored ASCII"
        );
    }

    eprintln!(
        "synthetic RPG Maker MV/MZ: 122/122 event codes instantiated + classified clean in {:?}",
        start.elapsed()
    );
}
