//! MV/MZ database + `System.json` terms extract & patch.
//! Drives the slice against committed **synthetic public**
//! fixtures (`tests/fixtures/k110/*.json`; authored English, no retail bytes)
//! and proves:
//! 1. Extraction emits STABLE units carrying every acceptance field (source
//!    file, database entry id + array index or System section, field key,
//!    text role, fixture-profile id) plus a stable surface key + bridge unit
//!    id — and covers the declared database + terms surfaces.
//! 2. A trivial patch changes ONLY the declared string literals — a
//!    byte-level locality proof shows every inter-literal byte (numbers, ids,
//!    notes, key order, whitespace) is identical, and an untranslated patch
//!    is a byte-identical no-op across every fixture.
//! 3. A regression — a patch that touches a non-text byte, that drops a
//!    declared unit, or that would alter a numeric field — is DETECTED.
//! 4. Numeric fields, developer `note`/script fields, malformed containers,
//!    and missing optional files produce semantic diagnostics / typed errors,
//!    never a blind extraction.

use std::collections::BTreeSet;
use std::path::PathBuf;

use kaifuu_rpgmaker::{
    DatabaseDiagnosticKind, DatabaseExtractError, DatabaseTermRole, DatabaseTranslation, Scanner,
    StableDatabaseUnit, encode_json_string_ascii_safe, extract_database_file,
    extract_database_units, extract_system_file, extract_system_units, patch_database_file,
};
use serde_json::Value;

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

fn fixture_dir() -> PathBuf {
    test_manifest_dir().join("tests/fixtures/k110")
}

fn read(name: &str) -> Vec<u8> {
    std::fs::read(fixture_dir().join(name)).unwrap_or_else(|e| panic!("read {name}: {e}"))
}

/// A synthetic non-ASCII translation (also exercises the `\u`-escape encoder).
fn translate(source: &str) -> String {
    format!("\u{8a33}:{source}")
}

fn db_units(logical_file: &str, fixture: &str) -> (Vec<u8>, Vec<StableDatabaseUnit>) {
    let bytes = read(fixture);
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    (bytes, extract_database_units(logical_file, &value).units)
}

fn system_units() -> (Vec<u8>, Vec<StableDatabaseUnit>) {
    let bytes = read("System.json");
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    (bytes, extract_system_units("System.json", &value).units)
}

// 1. Stable units with all acceptance fields

#[test]
fn database_units_carry_all_acceptance_fields() {
    let (_, actors) = db_units("Actors.json", "Actors.json");
    assert!(!actors.is_empty());
    for unit in &actors {
        assert_eq!(unit.source_file, "Actors.json");
        assert!(unit.entry_id().is_some(), "db unit carries an entry id");
        assert!(
            unit.entry_index().is_some(),
            "db unit carries an array index"
        );
        assert_eq!(unit.fixture_profile_id, "KAIFUU-110");
        assert!(!unit.bridge_unit_id().is_empty());
        assert!(unit.source_unit_key().starts_with("rpgmaker:Actors.json#/"));
    }
    // Every declared Actors role is present, note/id fields never are.
    let keys: BTreeSet<&str> = actors.iter().map(|u| u.field_key.as_str()).collect();
    assert!(keys.contains("name") && keys.contains("nickname") && keys.contains("profile"));
    assert!(!keys.contains("note"));
    assert!(!keys.contains("characterIndex"));

    // Skills expose the message1/2 battle lines; States expose message1..4.
    let (_, skills) = db_units("Skills.json", "Skills.json");
    let skill_keys: BTreeSet<&str> = skills.iter().map(|u| u.field_key.as_str()).collect();
    assert!(skill_keys.contains("message1"), "skill use message");
    let (_, states) = db_units("States.json", "States.json");
    let state_msgs = states
        .iter()
        .filter(|u| u.text_role == DatabaseTermRole::Message)
        .count();
    assert_eq!(
        state_msgs, 3,
        "message1/2/4 present, empty message3 skipped"
    );

    // Deterministic re-extraction.
    let (_, actors2) = db_units("Actors.json", "Actors.json");
    assert_eq!(actors, actors2);
    assert_eq!(actors[0].bridge_unit_id(), actors2[0].bridge_unit_id());
}

#[test]
fn troop_name_and_battle_messages_are_stable_units() {
    let (_, troops) = db_units("Troops.json", "Troops.json");
    let roles: Vec<&str> = troops.iter().map(|u| u.text_role.as_str()).collect();
    assert_eq!(roles, vec!["name", "battle_message", "battle_message"]);
    assert_eq!(troops[0].source_unit_key(), "rpgmaker:Troops.json#/1/name");
    assert_eq!(
        troops[1].source_unit_key(),
        "rpgmaker:Troops.json#/1/pages/0/list/1/parameters/0"
    );
    assert_eq!(
        troops[2].source_unit_key(),
        "rpgmaker:Troops.json#/1/pages/0/list/2/parameters/0"
    );
    for unit in &troops {
        assert_eq!(unit.entry_id(), Some(1));
    }
}

#[test]
fn system_terms_and_types_are_stable_units() {
    let (_, units) = system_units();
    let keys: BTreeSet<String> = units
        .iter()
        .map(StableDatabaseUnit::source_unit_key)
        .collect();
    for expected in [
        "rpgmaker:System.json#/gameTitle",
        "rpgmaker:System.json#/currencyUnit",
        "rpgmaker:System.json#/equipTypes/1",
        "rpgmaker:System.json#/elements/2",
        "rpgmaker:System.json#/skillTypes/1",
        "rpgmaker:System.json#/weaponTypes/1",
        "rpgmaker:System.json#/armorTypes/1",
        "rpgmaker:System.json#/terms/basic/0",
        "rpgmaker:System.json#/terms/commands/0",
        "rpgmaker:System.json#/terms/params/0",
        "rpgmaker:System.json#/terms/messages/levelUp",
        "rpgmaker:System.json#/terms/messages/possession",
    ] {
        assert!(keys.contains(expected), "missing System surface {expected}");
    }
    // Empty padding slots (index 0 of type lists, empty command slot 8) never
    // become units; numeric fields (versionId) are never surfaced.
    assert!(!keys.contains("rpgmaker:System.json#/equipTypes/0"));
    assert!(!keys.contains("rpgmaker:System.json#/terms/commands/8"));
    assert!(!units.iter().any(|u| u.field_key == "versionId"));
    // Every unit carries a unique surface key.
    assert_eq!(keys.len(), units.len());
}

// 2. Byte-preserving patch (only declared literals change)

fn located_targets(original: &[u8], units: &[StableDatabaseUnit]) -> Vec<(usize, usize, Vec<u8>)> {
    let mut out: Vec<(usize, usize, Vec<u8>)> = units
        .iter()
        .map(|u| {
            let mut scanner = Scanner::new(original);
            let span = scanner
                .locate(&u.pointer)
                .unwrap_or_else(|e| panic!("locate {}: {e}", u.source_unit_key()));
            let encoded = encode_json_string_ascii_safe(&translate(&u.source_text)).into_bytes();
            (span.start, span.end, encoded)
        })
        .collect();
    out.sort_by_key(|(start, ..)| *start);
    out
}

/// Byte-level locality proof: every byte OUTSIDE the declared literals is
/// identical between `original` and `patched`, and each declared literal was
/// replaced by exactly its encoded target.
fn verify_only_declared_changed(
    original: &[u8],
    patched: &[u8],
    spans: &[(usize, usize, Vec<u8>)],
) -> Result<(), String> {
    let mut oi = 0usize;
    let mut pi = 0usize;
    for (idx, (start, end, encoded)) in spans.iter().enumerate() {
        let seg = start - oi;
        let (o_seg, p_seg) = (
            original.get(oi..*start).ok_or("original seg oob")?,
            patched.get(pi..pi + seg).ok_or("patched seg oob")?,
        );
        if o_seg != p_seg {
            return Err(format!("non-declared byte drift before literal {idx}"));
        }
        pi += seg;
        let p_lit = patched
            .get(pi..pi + encoded.len())
            .ok_or("patched literal oob")?;
        if p_lit != encoded.as_slice() {
            return Err(format!("declared literal {idx} is not its target"));
        }
        pi += encoded.len();
        oi = *end;
    }
    if original.get(oi..) != patched.get(pi..) {
        return Err("non-declared byte drift after last literal".to_string());
    }
    Ok(())
}

#[test]
fn trivial_patch_changes_only_declared_text_across_all_surfaces() {
    for (logical, fixture, is_system) in [
        ("Actors.json", "Actors.json", false),
        ("Items.json", "Items.json", false),
        ("Skills.json", "Skills.json", false),
        ("States.json", "States.json", false),
        ("Troops.json", "Troops.json", false),
        ("System.json", "System.json", true),
    ] {
        let (bytes, units) = if is_system {
            system_units()
        } else {
            db_units(logical, fixture)
        };
        assert!(!units.is_empty(), "{logical}: fixture yields units");
        let translations: Vec<DatabaseTranslation> = units
            .iter()
            .map(|u| DatabaseTranslation {
                unit: u,
                target_text: translate(&u.source_text),
            })
            .collect();
        let patched = patch_database_file(logical, &bytes, &translations)
            .unwrap_or_else(|e| panic!("{logical}: patch: {e}"));
        assert_ne!(
            patched, bytes,
            "{logical}: a real translation changes bytes"
        );

        let spans = located_targets(&bytes, &units);
        verify_only_declared_changed(&bytes, &patched, &spans)
            .unwrap_or_else(|e| panic!("{logical}: byte locality: {e}"));

        // Patched bytes still parse.
        let _: Value = serde_json::from_slice(&patched)
            .unwrap_or_else(|e| panic!("{logical}: patched reparse: {e}"));
    }
}

#[test]
fn non_text_fields_are_preserved_verbatim() {
    // Items.json: patch every declared string, then confirm numeric / boolean
    // note fields are byte-identical in the reparsed value.
    let (bytes, units) = db_units("Items.json", "Items.json");
    let translations: Vec<DatabaseTranslation> = units
        .iter()
        .map(|u| DatabaseTranslation {
            unit: u,
            target_text: translate(&u.source_text),
        })
        .collect();
    let patched = patch_database_file("Items.json", &bytes, &translations).expect("patch");
    let before: Value = serde_json::from_slice(&bytes).unwrap();
    let after: Value = serde_json::from_slice(&patched).unwrap();
    assert_eq!(before[1]["price"], after[1]["price"]);
    assert_eq!(before[1]["iconIndex"], after[1]["iconIndex"]);
    assert_eq!(before[1]["note"], after[1]["note"]);
    assert_eq!(before[1]["consumable"], after[1]["consumable"]);
    // The declared name/description DID change.
    assert_eq!(after[1]["name"].as_str().unwrap(), translate("Potion"));
}

#[test]
fn untranslated_patch_is_byte_identical_noop() {
    for (logical, fixture, is_system) in [
        ("Actors.json", "Actors.json", false),
        ("Skills.json", "Skills.json", false),
        ("Troops.json", "Troops.json", false),
        ("System.json", "System.json", true),
    ] {
        let (bytes, units) = if is_system {
            system_units()
        } else {
            db_units(logical, fixture)
        };
        let translations: Vec<DatabaseTranslation> = units
            .iter()
            .map(|u| DatabaseTranslation {
                unit: u,
                target_text: u.source_text.clone(), // target == source
            })
            .collect();
        let patched = patch_database_file(logical, &bytes, &translations).expect("noop patch");
        assert_eq!(
            patched, bytes,
            "{logical}: untranslated patch must be byte-identical"
        );
    }
}

// 3. Regressions are DETECTED

#[test]
fn regression_touching_a_numeric_byte_is_detected() {
    // A "patch" that leaves declared literals as-is but corrupts a NON-text
    // numeric field (Items price 50 -> 99) must be rejected by the locality
    // guard.
    let (bytes, units) = db_units("Items.json", "Items.json");
    let noop_spans: Vec<(usize, usize, Vec<u8>)> = {
        let mut v: Vec<(usize, usize, Vec<u8>)> = units
            .iter()
            .map(|u| {
                let mut scanner = Scanner::new(&bytes);
                let span = scanner.locate(&u.pointer).unwrap();
                (span.start, span.end, bytes[span.start..span.end].to_vec())
            })
            .collect();
        v.sort_by_key(|(s, ..)| *s);
        v
    };
    verify_only_declared_changed(&bytes, &bytes, &noop_spans).expect("honest no-op passes");

    let tampered = String::from_utf8(bytes.clone())
        .unwrap()
        .replace("\"price\": 50", "\"price\": 99")
        .into_bytes();
    assert_ne!(tampered, bytes, "tamper must change a numeric field");
    let err = verify_only_declared_changed(&bytes, &tampered, &noop_spans)
        .expect_err("touching a numeric byte must be detected");
    assert!(err.contains("non-declared byte drift"), "got: {err}");
}

#[test]
fn regression_dropping_a_declared_unit_is_detected() {
    let (bytes, units) = db_units("Actors.json", "Actors.json");
    assert!(units.len() >= 2);
    // Translate every unit EXCEPT the last one.
    let translations: Vec<DatabaseTranslation> = units[..units.len() - 1]
        .iter()
        .map(|u| DatabaseTranslation {
            unit: u,
            target_text: translate(&u.source_text),
        })
        .collect();
    let patched = patch_database_file("Actors.json", &bytes, &translations).expect("patch");

    let dropped = units.last().unwrap();
    let mut scanner = Scanner::new(&patched);
    let span = scanner
        .locate(&dropped.pointer)
        .expect("dropped unit resolves");
    let on_disk = Scanner::decode_span(&patched, span).unwrap();
    assert_eq!(
        on_disk, dropped.source_text,
        "dropped unit left untranslated"
    );
    assert_ne!(
        on_disk,
        translate(&dropped.source_text),
        "completeness gate: a dropped declared unit is detectable"
    );
}

// 4. Semantic diagnostics / negative fixtures

#[test]
fn numeric_field_and_script_note_are_never_extracted() {
    // NumericWeapons.json: `name` is a number, `note` is a script string.
    let bytes = read("NumericWeapons.json");
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    let out = extract_database_units("Weapons.json", &value);
    // Only the string `description` extracts.
    assert_eq!(out.units.len(), 1);
    assert_eq!(out.units[0].field_key, "description");
    // No unit ever points at the numeric name or the script note.
    assert!(!out.units.iter().any(|u| u.field_key == "name"));
    assert!(!out.units.iter().any(|u| u.field_key == "note"));
    // The numeric name is flagged as an unsupported field type.
    assert!(out.diagnostics.iter().any(|d| {
        d.kind == DatabaseDiagnosticKind::UnsupportedFieldType && d.pointer == ["1", "name"]
    }));
}

#[test]
fn malformed_container_is_a_diagnostic() {
    let bytes = read("MalformedItems.json");
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    let out = extract_database_units("Items.json", &value);
    assert!(out.units.is_empty());
    assert_eq!(
        out.diagnostics[0].kind,
        DatabaseDiagnosticKind::MalformedContainer
    );
}

#[test]
fn missing_optional_database_file_is_a_typed_error() {
    let err = extract_database_file(&fixture_dir().join("DoesNotExist.json"))
        .expect_err("missing file must be a typed error");
    assert!(matches!(err, DatabaseExtractError::MissingFile { .. }));
}

#[test]
fn malformed_json_is_a_typed_error() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("System.json");
    std::fs::write(&path, b"{ not valid json ]").unwrap();
    let err = extract_system_file(&path).expect_err("malformed JSON must be a typed error");
    assert!(matches!(err, DatabaseExtractError::MalformedJson { .. }));
}
