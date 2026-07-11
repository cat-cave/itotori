//! `[iscript]…[endscript]` TJS-block recognition proof.
//!
//! Two layers:
//!
//! 1. A synthetic, authored, CC0 fixture (`fixtures/iscript_block.ks`) covering
//!    the bracket spelling, the `@iscript`/`@endscript` line-command spelling, a
//!    single-line `[iscript]…[endscript]`, and adjacent blocks. It asserts the
//!    TJS body never becomes a `dialogue` unit, ordinary dialogue around the
//!    blocks still parses, and the swallowed code stays byte-identical in the
//!    structural (patchback) stream.
//!
//! 2. A REAL-BYTES gate (`KAIFUU_KIRIKIRI_REAL_KS_DIR`) that parses every `.ks`
//!    under a directory of extracted retail KAG scripts and asserts that no
//!    physical line inside an `[iscript]`/`@iscript` block is emitted as a
//!    `dialogue` unit. The block line-set is recomputed by an INDEPENDENT
//!    reference scanner (not the parser under test), so the assertion is a
//!    genuine cross-check. Retail scripts that are UTF-16 (KiriKiriZ's common
//!    encoding, outside this parser's UTF-8/Shift-JIS support) are transcoded to
//!    UTF-8 first — the bytes remain the real game's TJS content. No retail
//!    bytes are committed; the gate is a no-op when the env var is unset.

use std::path::PathBuf;

use kaifuu_kirikiri::{KsFindingKind, TextRole, parse_ks, structural_bytes};

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

// ---------------------------------------------------------------------------
// Real-bytes gate.
// ---------------------------------------------------------------------------

/// Decode possibly-UTF-16 `.ks` bytes to a UTF-8 byte vector. Retail KiriKiriZ
/// scripts are frequently UTF-16LE (BOM `FF FE`); this parser natively supports
/// UTF-8/Shift-JIS, so real UTF-16 scripts are transcoded (their TJS content is
/// unchanged) before the iscript logic is exercised.
fn to_utf8(bytes: &[u8]) -> Vec<u8> {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (cow, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        cow.into_owned().into_bytes()
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        let (cow, _, _) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
        cow.into_owned().into_bytes()
    } else {
        bytes.to_vec()
    }
}

/// INDEPENDENT reference: the set of physical line indices that lie INSIDE an
/// `[iscript]`/`@iscript` block body (open + body + close lines), computed from
/// the decoded text without touching the parser under test.
fn iscript_body_lines(text: &str) -> std::collections::BTreeSet<usize> {
    let mut inside = std::collections::BTreeSet::new();
    let mut open = false;
    for (idx, raw) in text.split('\n').enumerate() {
        let line = raw.strip_suffix('\r').unwrap_or(raw).trim_start();
        if open {
            inside.insert(idx);
            if line.contains("[endscript]") || line.starts_with("@endscript") {
                open = false;
            }
            continue;
        }
        let opens = line.starts_with("[iscript]")
            || line.starts_with("[iscript ")
            || line == "@iscript"
            || line.starts_with("@iscript ");
        if opens {
            inside.insert(idx);
            // A single-line `[iscript]…[endscript]` opens and closes on one line.
            if !(line.contains("[endscript]") && line.starts_with('[')) {
                open = true;
            }
        }
    }
    inside
}

#[test]
fn real_ks_never_emits_iscript_tjs_as_dialogue() {
    let Some(dir) = std::env::var_os("KAIFUU_KIRIKIRI_REAL_KS_DIR") else {
        eprintln!("KAIFUU_KIRIKIRI_REAL_KS_DIR unset — skipping real-bytes gate");
        return;
    };
    let dir = PathBuf::from(dir);
    let mut files = 0usize;
    let mut files_with_iscript = 0usize;
    let mut total_blocks = 0usize;
    let mut total_body_lines = 0usize;
    let mut leaks: Vec<String> = Vec::new();

    let mut entries: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("read_dir {}: {e}", dir.display()))
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("ks")))
        .collect();
    entries.sort();

    for path in &entries {
        files += 1;
        let raw = std::fs::read(path).unwrap();
        let utf8 = to_utf8(&raw);
        let text = String::from_utf8_lossy(&utf8).into_owned();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();

        let body_lines = iscript_body_lines(&text);
        // Count blocks (transitions into "open"/single-line) via the reference.
        let blocks = count_blocks(&text);
        if !body_lines.is_empty() {
            files_with_iscript += 1;
            total_blocks += blocks;
            total_body_lines += body_lines.len();
        }

        let doc = parse_ks(&name, utf8.as_slice());
        for unit in doc.units.iter().filter(|u| u.role == TextRole::Dialogue) {
            if body_lines.contains(&unit.line_index) {
                leaks.push(format!(
                    "{name} L{}: {:?}",
                    unit.line_index, unit.source_text
                ));
            }
        }
    }

    eprintln!(
        "real-bytes gate: {files} .ks files, {files_with_iscript} contain iscript, \
         {total_blocks} blocks, {total_body_lines} TJS body lines swallowed, \
         {} dialogue leaks",
        leaks.len()
    );
    assert!(files > 0, "no .ks files found under {}", dir.display());
    assert!(
        leaks.is_empty(),
        "TJS lines from iscript blocks leaked as dialogue:\n{}",
        leaks.join("\n")
    );
}

/// Reference count of iscript blocks in `text` (each open, including a
/// single-line block, counts once).
fn count_blocks(text: &str) -> usize {
    let mut blocks = 0usize;
    let mut open = false;
    for raw in text.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw).trim_start();
        if open {
            if line.contains("[endscript]") || line.starts_with("@endscript") {
                open = false;
            }
            continue;
        }
        let opens = line.starts_with("[iscript]")
            || line.starts_with("[iscript ")
            || line == "@iscript"
            || line.starts_with("@iscript ");
        if opens {
            blocks += 1;
            if !(line.contains("[endscript]") && line.starts_with('[')) {
                open = true;
            }
        }
    }
    blocks
}
