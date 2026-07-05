//! KAG `.ks` stable-extraction + byte-preserving patch proof.
//!
//! Fixtures are synthetic, authored, CC0 (`fixtures/dialogue_basic.ks`); no
//! retail KiriKiri bytes. The Shift-JIS test builds its bytes in-process to
//! exercise the trailing-byte hazard without committing a binary blob.

use std::collections::BTreeMap;
use std::path::PathBuf;

use kaifuu_kirikiri::{
    KsEncoding, TextRole, apply_patch, parse_ks, parse_ks_with_encoding, structural_bytes,
    verify_byte_preserving,
};

const FIXTURE_FILE: &str = "dialogue_basic.ks";

/// Resolve this crate's manifest directory for locating tracked test fixtures.
///
/// `env!("CARGO_MANIFEST_DIR")` is baked at COMPILE time, so a test binary
/// reused from a different (since-removed) worktree would point fixture reads at
/// a dead path (`Os NotFound`). `cargo test` sets `CARGO_MANIFEST_DIR` in the
/// RUNTIME environment to the LIVE crate directory; prefer that, falling back to
/// the compile-time constant only outside cargo.
fn test_manifest_dir() -> PathBuf {
    std::env::var_os("CARGO_MANIFEST_DIR")
        .map_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")), PathBuf::from)
}

fn fixture_bytes() -> Vec<u8> {
    let path = test_manifest_dir().join("fixtures").join(FIXTURE_FILE);
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

fn dialogue_texts(bytes: &[u8]) -> Vec<String> {
    parse_ks(FIXTURE_FILE, bytes)
        .dialogue_units()
        .map(|u| u.source_text.clone())
        .collect()
}

#[test]
fn parses_stable_dialogue_units_and_speakers() {
    let bytes = fixture_bytes();
    let doc = parse_ks(FIXTURE_FILE, &bytes);
    assert_eq!(doc.encoding, KsEncoding::Utf8);

    let dialogue: Vec<_> = doc.dialogue_units().collect();
    assert_eq!(
        dialogue
            .iter()
            .map(|u| u.source_text.as_str())
            .collect::<Vec<_>>(),
        vec![
            "こんにちは、世界。",
            "これは",
            "試験の本文です。",
            "やあ、アリス。",
            "ナレーションのような地の文。",
            "[[これは括弧のリテラル]] とテキスト。",
        ],
    );

    // Stable extraction identity: file + line + segment + role.
    assert_eq!(
        dialogue[0].source_unit_key,
        "kirikiri-kag:dialogue_basic.ks#L4#seg0#dialogue"
    );
    assert_eq!(
        dialogue[1].source_unit_key,
        "kirikiri-kag:dialogue_basic.ks#L5#seg0#dialogue"
    );
    assert_eq!(
        dialogue[2].source_unit_key,
        "kirikiri-kag:dialogue_basic.ks#L5#seg1#dialogue"
    );

    // Speaker extraction (KAG #name convention, incl. voice/display split
    // and the bare-`#` reset).
    assert_eq!(
        dialogue
            .iter()
            .map(|u| u.speaker.clone())
            .collect::<Vec<_>>(),
        vec![
            Some("アリス".to_string()),
            Some("アリス".to_string()),
            Some("アリス".to_string()),
            Some("ボブ先生".to_string()),
            None,
            None,
        ],
    );

    // The `#name` lines themselves are extractable speaker_name units.
    let speakers: Vec<_> = doc.speaker_units().collect();
    assert_eq!(
        speakers
            .iter()
            .map(|u| u.source_text.as_str())
            .collect::<Vec<_>>(),
        vec!["アリス", "ボブ先生"],
    );
    assert!(speakers.iter().all(|u| u.role == TextRole::SpeakerName));

    // Deterministic ids: a second parse yields identical bridge unit ids.
    let doc2 = parse_ks(FIXTURE_FILE, &bytes);
    assert_eq!(
        doc.units
            .iter()
            .map(|u| &u.bridge_unit_id)
            .collect::<Vec<_>>(),
        doc2.units
            .iter()
            .map(|u| &u.bridge_unit_id)
            .collect::<Vec<_>>(),
    );

    // No-silent-skip: the `@wait` line command is recorded as a finding.
    assert!(doc.findings.iter().any(|f| f.detail == "wait"));

    // Every span decodes to its recorded source text (exact byte span).
    for u in &doc.units {
        assert_eq!(
            &String::from_utf8(bytes[u.start_byte..u.end_byte].to_vec()).unwrap(),
            &u.source_text,
        );
    }
}

#[test]
fn identity_patch_reproduces_source_bytes_exactly() {
    let bytes = fixture_bytes();
    let doc = parse_ks(FIXTURE_FILE, &bytes);

    // Translate every unit (dialogue + speaker) to its own source text.
    let translations: BTreeMap<String, String> = doc
        .units
        .iter()
        .map(|u| (u.source_unit_key.clone(), u.source_text.clone()))
        .collect();

    let patched = apply_patch(&bytes, &doc.units, doc.encoding, &translations).unwrap();
    assert_eq!(patched, bytes, "identity patch must reproduce source bytes");
}

#[test]
fn dialogue_only_patch_changes_only_translatable_text() {
    let bytes = fixture_bytes();
    let doc = parse_ks(FIXTURE_FILE, &bytes);

    // Translate ONLY dialogue units (leave speaker names & structure alone).
    let translations: BTreeMap<String, String> = doc
        .dialogue_units()
        .enumerate()
        .map(|(i, u)| (u.source_unit_key.clone(), format!("<T{i}>")))
        .collect();

    let patched = apply_patch(&bytes, &doc.units, doc.encoding, &translations).unwrap();
    assert_ne!(patched, bytes, "dialogue text must have changed");

    // Round-trip proof: nothing but translatable spans moved.
    verify_byte_preserving(&bytes, &patched, FIXTURE_FILE, doc.encoding).unwrap();

    // Structural (non-text) byte streams are byte-identical.
    let pat_doc = parse_ks(FIXTURE_FILE, &patched);
    assert_eq!(
        structural_bytes(&bytes, &doc),
        structural_bytes(&patched, &pat_doc),
    );

    // Concrete: every tag / command / comment / label survives byte-identical.
    let patched_str = String::from_utf8(patched.clone()).unwrap();
    for needle in [
        "; kirikiri-kag synthetic fixture",
        "*start|プロローグ",
        "@wait time=1000",
        "#アリス",
        "[fadein time=500]",
        "[l][r]",
        "[ruby text=てすと]",
        "#ボブ/ボブ先生",
        "[p]",
        "[cm]",
    ] {
        assert!(patched_str.contains(needle), "missing structure: {needle}");
    }

    // The translated dialogue is exactly what we asked for.
    assert_eq!(
        dialogue_texts(&patched),
        (0..6).map(|i| format!("<T{i}>")).collect::<Vec<_>>(),
    );
}

#[test]
fn regression_touching_a_tag_fails_verification() {
    let bytes = fixture_bytes();
    let doc = parse_ks(FIXTURE_FILE, &bytes);
    let translations: BTreeMap<String, String> = doc
        .dialogue_units()
        .map(|u| (u.source_unit_key.clone(), "x".to_string()))
        .collect();
    let mut tampered = apply_patch(&bytes, &doc.units, doc.encoding, &translations).unwrap();

    // Corrupt a tag byte: turn `[cm]` into `[xm]` (a parser/patch bug that
    // touched structure). Verification MUST fail.
    let idx = tampered
        .windows(4)
        .position(|w| w == b"[cm]")
        .expect("[cm] present");
    tampered[idx + 1] = b'x';

    let err = verify_byte_preserving(&bytes, &tampered, FIXTURE_FILE, doc.encoding).unwrap_err();
    assert!(
        matches!(err, kaifuu_kirikiri::VerifyError::StructureChanged { .. }),
        "expected StructureChanged, got {err:?}",
    );
}

#[test]
fn regression_dropping_a_unit_fails_verification() {
    let bytes = fixture_bytes();
    let doc = parse_ks(FIXTURE_FILE, &bytes);

    // Hand-build a "patched" buffer that DROPS a dialogue unit entirely:
    // delete the "やあ、アリス。" run, leaving just its trailing `[l]` tag.
    let dropped = String::from_utf8(bytes.clone())
        .unwrap()
        .replace("やあ、アリス。[l]", "[l]");
    let dropped_bytes = dropped.into_bytes();
    assert_ne!(dropped_bytes, bytes);

    let err =
        verify_byte_preserving(&bytes, &dropped_bytes, FIXTURE_FILE, doc.encoding).unwrap_err();
    assert!(
        matches!(err, kaifuu_kirikiri::VerifyError::UnitSetChanged),
        "expected UnitSetChanged, got {err:?}",
    );
}

#[test]
fn stale_source_is_rejected() {
    let bytes = fixture_bytes();
    let doc = parse_ks(FIXTURE_FILE, &bytes);
    let unit = doc.dialogue_units().next().unwrap();

    // Apply the (valid) units against a DIFFERENT source buffer whose bytes at
    // the recorded span no longer match — simulates re-applying against drift.
    let mut drifted = bytes.clone();
    // Flip a byte inside the first dialogue span.
    drifted[unit.start_byte] ^= 0x01;

    let translations = BTreeMap::from([(unit.source_unit_key.clone(), "y".to_string())]);
    let err = apply_patch(&drifted, &doc.units, doc.encoding, &translations).unwrap_err();
    assert!(
        matches!(err, kaifuu_kirikiri::PatchError::StaleSource { .. }),
        "expected StaleSource, got {err:?}",
    );
}

#[test]
fn newline_and_unknown_unit_translations_are_rejected() {
    let bytes = fixture_bytes();
    let doc = parse_ks(FIXTURE_FILE, &bytes);
    let key = doc.dialogue_units().next().unwrap().source_unit_key.clone();

    let nl = BTreeMap::from([(key.clone(), "line one\nline two".to_string())]);
    assert!(matches!(
        apply_patch(&bytes, &doc.units, doc.encoding, &nl).unwrap_err(),
        kaifuu_kirikiri::PatchError::NewlineInTranslation { .. },
    ));

    let unknown = BTreeMap::from([(
        "kirikiri-kag:nope#L9#seg9#dialogue".to_string(),
        "z".to_string(),
    )]);
    assert!(matches!(
        apply_patch(&bytes, &doc.units, doc.encoding, &unknown).unwrap_err(),
        kaifuu_kirikiri::PatchError::UnknownUnit { .. },
    ));
}

#[test]
fn shift_jis_trailing_byte_hazard_is_handled() {
    // Two Shift-JIS double-byte characters whose *trailing* bytes are `[`
    // (0x5B) and `]` (0x5D) — the exact bytes a naive scanner would mistake
    // for inline-tag delimiters — followed by ASCII text and a real `[p]`
    // tag, then a newline.
    // 0x83 0x5B = ゼ (trailing byte 0x5B = `[`); 0x83 0x5D = ゾ (0x5D = `]`).
    let mut src: Vec<u8> = Vec::new();
    src.extend_from_slice(&[0x83, 0x5B, 0x83, 0x5D]);
    src.extend_from_slice(b"text[p]\n");

    let doc = parse_ks_with_encoding("sjis.ks", &src, KsEncoding::ShiftJis);
    let dialogue: Vec<_> = doc.dialogue_units().collect();

    // The two kanji + "text" form ONE dialogue run: the embedded 0x5B/0x5D
    // were NOT treated as `[`/`]`, and `[p]` is the only real tag.
    assert_eq!(dialogue.len(), 1, "trailing bytes must not split the run");
    let expected = encoding_rs::SHIFT_JIS
        .decode(&[0x83, 0x5B, 0x83, 0x5D, b't', b'e', b'x', b't'])
        .0
        .into_owned();
    assert_eq!(dialogue[0].source_text, expected);

    // `[p]` survives as structure and identity patch round-trips byte-exact.
    let translations: BTreeMap<String, String> = doc
        .units
        .iter()
        .map(|u| (u.source_unit_key.clone(), u.source_text.clone()))
        .collect();
    let patched = apply_patch(&src, &doc.units, doc.encoding, &translations).unwrap();
    assert_eq!(patched, src, "Shift-JIS identity patch must round-trip");
    assert!(structural_bytes(&src, &doc).windows(3).any(|w| w == b"[p]"));
}
