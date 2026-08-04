//! `[iscript]…[endscript]` TJS-block recognition proof.
//! Two layers:
//! 1. A synthetic, authored, CC0 fixture (`fixtures/iscript_block.ks`) covering
//!    the bracket spelling, the `@iscript`/`@endscript` line-command spelling, a
//!    single-line `[iscript]…[endscript]`, and adjacent blocks. It asserts the
//!    TJS body never becomes a `dialogue` unit, ordinary dialogue around the
//!    blocks still parses, and the swallowed code stays byte-identical in the
//!    structural (patchback) stream.

use std::path::PathBuf;

use kaifuu_kirikiri::{KsFindingKind, parse_ks, structural_bytes};

const FIXTURE_FILE: &str = "iscript_block.ks";

fn manifest_dir() -> PathBuf {
    std::env::var_os("CARGO_MANIFEST_DIR")
        .map_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")), PathBuf::from)
}

fn fixture_bytes() -> Vec<u8> {
    let path = manifest_dir().join("fixtures").join(FIXTURE_FILE);
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// Markers that only ever appear in the fixture's TJS body lines — if any turns
/// up in a `dialogue` unit, code leaked into the translatable stream.
const TJS_MARKERS: &[&str] = &[
    "f.total",
    "f.gallery",
    "cg_01",
    "kag.process",
    "var s",
    "f.inline",
];

#[test]
fn iscript_bodies_are_never_emitted_as_dialogue() {
    let bytes = fixture_bytes();
    let doc = parse_ks(FIXTURE_FILE, &bytes);

    let dialogue: Vec<&str> = doc
        .dialogue_units()
        .map(|u| u.source_text.as_str())
        .collect();

    // Only the real message lines survive as dialogue — no TJS.
    assert_eq!(
        dialogue,
        vec![
            "これは通常の台詞です。",
            "ブロックの後の地の文。",
            "別の話者の台詞。",
            "インライン iscript の後の台詞。",
            "隣接ブロックの後の地の文。",
        ],
        "unexpected dialogue units (TJS body must be swallowed)"
    );

    for unit in doc.dialogue_units() {
        for marker in TJS_MARKERS {
            assert!(
                !unit.source_text.contains(marker),
                "TJS code `{marker}` leaked into a dialogue unit: {:?}",
                unit.source_text
            );
        }
    }
}

#[test]
fn every_iscript_block_open_is_recorded_as_a_finding() {
    let doc = parse_ks(FIXTURE_FILE, &fixture_bytes());
    let iscript_findings = doc
        .findings
        .iter()
        .filter(|f| f.kind == KsFindingKind::IScriptBlock)
        .count();
    // Two multi-line ([iscript], @iscript), one single-line inline, two adjacent.
    assert_eq!(
        iscript_findings, 5,
        "expected 5 recorded iscript block opens, got {iscript_findings}"
    );
}

#[test]
fn swallowed_tjs_is_preserved_byte_identical_in_the_structural_stream() {
    let bytes = fixture_bytes();
    let doc = parse_ks(FIXTURE_FILE, &bytes);
    let structural = structural_bytes(&bytes, &doc);
    let structural_text = String::from_utf8(structural).expect("fixture is UTF-8");
    // The TJS body is not translatable, so it lives entirely in the structural
    // (immutable, patch-preserved) stream — a naive patch leaves it untouched.
    for marker in [
        "f.total = 10;",
        "kag.process(",
        "f.inline = 1;",
        "f.second = 2;",
    ] {
        assert!(
            structural_text.contains(marker),
            "swallowed TJS `{marker}` missing from the structural stream"
        );
    }
}
