//! KAIFUU-109 — MV/MZ map + common-event command-text extract & patch.
//!
//! Drives the KAIFUU-109 slice against committed **synthetic public**
//! fixtures (`tests/fixtures/k109/{Map001,CommonEvents}.json`; authored
//! English, no retail bytes) and proves:
//!
//! 1. Extraction emits STABLE units carrying every acceptance field
//!    (source file, event/common-event id, page index, command index, text
//!    role, fixture-profile id) plus a stable surface key + bridge unit id.
//! 2. A trivial patch changes ONLY the declared command-text literals — a
//!    byte-level locality proof shows every inter-literal byte is identical,
//!    and an untranslated patch is a byte-identical no-op.
//! 3. A regression — a patch that touches a non-text byte, or that drops a
//!    declared unit — is DETECTED (the guards below fail on it).

use std::collections::BTreeSet;
use std::path::PathBuf;

use kaifuu_rpgmaker::{
    CommandTextRole, CommandTranslation, MapExtractError, Scanner, StableCommandUnit,
    encode_json_string_ascii_safe, extract_common_event_units, extract_common_events_file,
    extract_map_file, extract_map_units, patch_command_file,
};
use serde_json::Value;

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/k109")
}

fn read(name: &str) -> Vec<u8> {
    std::fs::read(fixture_dir().join(name)).unwrap_or_else(|e| panic!("read {name}: {e}"))
}

/// A synthetic non-ASCII translation (also exercises the `\u`-escape encoder).
fn translate(source: &str) -> String {
    format!("\u{8a33}:{source}")
}

// ---------------------------------------------------------------------------
// 1. Stable units with all acceptance fields
// ---------------------------------------------------------------------------

#[test]
fn stable_units_carry_all_acceptance_fields() {
    let map_value: Value = serde_json::from_slice(&read("Map001.json")).unwrap();
    let map = extract_map_units("Map001.json", &map_value);
    assert!(
        map.diagnostics.is_empty(),
        "clean fixture has no diagnostics"
    );

    // Every declared role is present in the map fixture.
    let roles: BTreeSet<&str> = map.units.iter().map(|u| u.text_role.as_str()).collect();
    for role in [
        "show_text",
        "choice_option",
        "choice_branch",
        "scrolling_text",
        "comment",
    ] {
        assert!(
            roles.contains(role),
            "map fixture must exercise role {role}"
        );
    }

    for unit in &map.units {
        assert_eq!(unit.source_file, "Map001.json");
        assert_eq!(unit.container_id(), 1, "event id");
        assert_eq!(unit.page_index(), Some(0), "map units carry a page index");
        assert_eq!(unit.fixture_profile_id, "KAIFUU-109");
        assert!(!unit.bridge_unit_id().is_empty());
        assert!(
            unit.source_unit_key()
                .starts_with("rpgmaker:Map001.json#/events/1/pages/0/list/"),
            "unstable key: {}",
            unit.source_unit_key()
        );
        // Command index round-trips through the pointer.
        assert!(unit.pointer.contains(&unit.command_index.to_string()));
    }

    // Common events: same stable fields, but NO page index.
    let ce_value: Value = serde_json::from_slice(&read("CommonEvents.json")).unwrap();
    let ce = extract_common_event_units("CommonEvents.json", &ce_value);
    assert!(!ce.units.is_empty());
    for unit in &ce.units {
        assert_eq!(unit.source_file, "CommonEvents.json");
        assert_eq!(unit.container_id(), 1, "common-event id");
        assert_eq!(unit.page_index(), None, "common events have no page index");
        assert_eq!(unit.fixture_profile_id, "KAIFUU-109");
        assert!(
            unit.source_unit_key()
                .starts_with("rpgmaker:CommonEvents.json#/1/list/"),
        );
    }

    // Deterministic: re-extraction yields identical units + ids.
    assert_eq!(
        map.units,
        extract_map_units("Map001.json", &map_value).units
    );
    assert_eq!(
        map.units[0].bridge_unit_id(),
        extract_map_units("Map001.json", &map_value).units[0].bridge_unit_id(),
    );
}

// ---------------------------------------------------------------------------
// 2. Byte-preserving patch (only declared literals change)
// ---------------------------------------------------------------------------

/// Locate every declared unit's quoted-literal span in `original`, paired
/// with the ASCII-safe encoding of its translated target, sorted ascending.
fn located_targets(original: &[u8], units: &[StableCommandUnit]) -> Vec<(usize, usize, Vec<u8>)> {
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
/// replaced by exactly its encoded target. Returns `Err` on any drift.
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

fn all_units() -> (Vec<u8>, Vec<StableCommandUnit>) {
    let bytes = read("Map001.json");
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    (bytes, extract_map_units("Map001.json", &value).units)
}

#[test]
fn trivial_patch_changes_only_declared_text() {
    let (bytes, units) = all_units();
    let translations: Vec<CommandTranslation> = units
        .iter()
        .map(|u| CommandTranslation {
            unit: u,
            target_text: translate(&u.source_text),
        })
        .collect();

    let patched = patch_command_file("Map001.json", &bytes, &translations).expect("patch");
    assert_ne!(patched, bytes, "a real translation changes bytes");

    // Byte-level: only the declared literals differ; everything else — the
    // `x`/`y` coordinates, `code`/`indent` numbers, key order, whitespace,
    // the untouched `101` speaker-setup array — is byte-identical.
    let spans = located_targets(&bytes, &units);
    verify_only_declared_changed(&bytes, &patched, &spans).expect("byte locality");

    // The patched bytes still parse, and each declared surface decodes to its
    // target while a NON-declared value (the event coordinate) is unchanged.
    let patched_value: Value = serde_json::from_slice(&patched).expect("patched reparse");
    let orig_value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        patched_value["events"][1]["x"], orig_value["events"][1]["x"],
        "non-text field preserved"
    );
    assert_eq!(
        patched_value["events"][1]["pages"][0]["list"][1]["parameters"][0]
            .as_str()
            .unwrap(),
        translate("Halt! Who goes there?"),
        "declared Show Text literal updated"
    );
    // The 101 speaker-setup command (NOT a KAIFUU-109 declared surface) is
    // untouched.
    assert_eq!(
        patched_value["events"][1]["pages"][0]["list"][0]["parameters"][4],
        orig_value["events"][1]["pages"][0]["list"][0]["parameters"][4],
    );
}

#[test]
fn untranslated_patch_is_byte_identical_noop() {
    for name in ["Map001.json", "CommonEvents.json"] {
        let bytes = read(name);
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        let units = if name == "Map001.json" {
            extract_map_units(name, &value).units
        } else {
            extract_common_event_units(name, &value).units
        };
        let translations: Vec<CommandTranslation> = units
            .iter()
            .map(|u| CommandTranslation {
                unit: u,
                target_text: u.source_text.clone(), // target == source
            })
            .collect();
        let patched = patch_command_file(name, &bytes, &translations).expect("noop patch");
        assert_eq!(
            patched, bytes,
            "{name}: untranslated patch must be byte-identical"
        );
    }
}

// ---------------------------------------------------------------------------
// 3. Regressions are DETECTED
// ---------------------------------------------------------------------------

#[test]
fn regression_touching_non_text_byte_is_detected() {
    // A "patch" that leaves the declared literals as-is (no-op targets) but
    // corrupts a NON-text structural field (`"y":7` -> `"y":9`). The locality
    // guard must reject it.
    let (bytes, units) = all_units();

    // No-op spans: each declared literal replaced by its own (unchanged) bytes.
    let noop_spans: Vec<(usize, usize, Vec<u8>)> = units
        .iter()
        .map(|u| {
            let mut scanner = Scanner::new(&bytes);
            let span = scanner.locate(&u.pointer).unwrap();
            (span.start, span.end, bytes[span.start..span.end].to_vec())
        })
        .collect();
    let mut sorted = noop_spans;
    sorted.sort_by_key(|(s, ..)| *s);

    // Sanity: an honest no-op passes the guard.
    verify_only_declared_changed(&bytes, &bytes, &sorted).expect("honest no-op passes");

    // Regress a non-text byte and confirm detection.
    let original_str = String::from_utf8(bytes.clone()).unwrap();
    let tampered = original_str.replace("\"y\": 7", "\"y\": 9").into_bytes();
    assert_ne!(
        tampered, bytes,
        "tamper must actually change a non-text field"
    );
    let err = verify_only_declared_changed(&bytes, &tampered, &sorted)
        .expect_err("touching a non-text byte must be detected");
    assert!(err.contains("non-declared byte drift"), "got: {err}");
}

#[test]
fn regression_dropping_a_declared_unit_is_detected() {
    // A patch that DROPS one declared unit leaves that unit's literal equal
    // to its source. A completeness check (every declared unit's on-disk
    // literal decodes to its target) must catch the omission.
    let (bytes, units) = all_units();
    assert!(units.len() >= 2);

    // Translate every unit EXCEPT the last one.
    let translations: Vec<CommandTranslation> = units[..units.len() - 1]
        .iter()
        .map(|u| CommandTranslation {
            unit: u,
            target_text: translate(&u.source_text),
        })
        .collect();
    let patched = patch_command_file("Map001.json", &bytes, &translations).expect("patch");

    let dropped = units.last().unwrap();
    let mut scanner = Scanner::new(&patched);
    let span = scanner
        .locate(&dropped.pointer)
        .expect("dropped unit still resolves");
    let on_disk = Scanner::decode_span(&patched, span).unwrap();
    // The dropped unit was NOT translated: its literal is still the source,
    // never the intended target. A completeness gate flags exactly this.
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

// ---------------------------------------------------------------------------
// 4. Semantic diagnostics before any write (malformed / missing)
// ---------------------------------------------------------------------------

#[test]
fn missing_file_is_a_typed_diagnostic() {
    let err = extract_common_events_file(&fixture_dir().join("DoesNotExist.json"))
        .expect_err("missing file must be a typed error");
    assert!(matches!(err, MapExtractError::MissingFile { .. }));
}

#[test]
fn malformed_json_is_a_typed_diagnostic() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("Map042.json");
    std::fs::write(&path, b"{ this is not valid json ]").unwrap();
    let err = extract_map_file(&path).expect_err("malformed JSON must be a typed error");
    assert!(matches!(err, MapExtractError::MalformedJson { .. }));
}

#[test]
fn choice_options_and_branches_are_distinct_surfaces() {
    // The `Show Choices` option array (102) AND the per-branch `When`
    // labels (402) are BOTH extracted as distinct, independently-patchable
    // surfaces.
    let (_, units) = all_units();
    let options: Vec<&StableCommandUnit> = units
        .iter()
        .filter(|u| u.text_role == CommandTextRole::ChoiceOption)
        .collect();
    let branches: Vec<&StableCommandUnit> = units
        .iter()
        .filter(|u| u.text_role == CommandTextRole::ChoiceBranch)
        .collect();
    assert_eq!(options.len(), 2, "two choice options");
    assert_eq!(branches.len(), 2, "two When-branch labels");
    // Distinct pointers (option array index vs the 402 parameters[1]).
    let keys: BTreeSet<String> = units
        .iter()
        .map(StableCommandUnit::source_unit_key)
        .collect();
    assert_eq!(
        keys.len(),
        units.len(),
        "every unit has a unique surface key"
    );
}
