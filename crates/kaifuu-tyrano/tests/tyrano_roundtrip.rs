//! TyranoScript `.ks` stable-extraction + byte-preserving patch proof (the
//! layered-pipeline round-trip: identity container + null-key crypto +
//! tyrano-script-markup codec).
//!
//! Fixtures are synthetic, authored, CC0 (`fixtures/scenario_basic.ks`); no
//! retail TyranoScript bytes. The Shift-JIS test builds its bytes in-process to
//! exercise the trailing-byte hazard without committing a binary blob.

use std::collections::BTreeMap;
use std::path::PathBuf;

use kaifuu_tyrano::{
    TextRole, TsEncoding, apply_patch, parse_ks, parse_ks_with_encoding, structural_bytes,
    verify_byte_preserving,
};

const FIXTURE_FILE: &str = "scenario_basic.ks";

/// Resolve this crate's manifest directory at RUNTIME (see the KiriKiri adapter
/// for why `CARGO_MANIFEST_DIR` is read from the environment, not the baked
/// compile-time constant, so a reused test binary reads the live worktree).
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
fn parses_stable_dialogue_choice_and_speaker_units() {
    let bytes = fixture_bytes();
    let doc = parse_ks(FIXTURE_FILE, &bytes);
    assert_eq!(doc.encoding, TsEncoding::Utf8);

    // Dialogue text: plain message runs, split around the `&f.count` embed.
    assert_eq!(
        dialogue_texts(&bytes),
        vec![
            "こんにちは、世界。",
            "これは",
            "回目の挑戦です。",
            "やあ、アリス。準備はいい？",
            "どうしますか。",
            "もう一度挑戦しますか。",
            "[[これは括弧のリテラル]] とテキスト。",
        ],
    );

    // Choice text: `[link]…[endlink]` inline caption + `[glink]`/`[button]`
    // quoted `text=` attribute captions.
    let choices: Vec<_> = doc.choice_units().collect();
    assert_eq!(
        choices
            .iter()
            .map(|u| u.source_text.as_str())
            .collect::<Vec<_>>(),
        vec!["はい、始めます", "いいえ、まだです", "あとで決める"],
    );
    assert!(choices.iter().all(|u| u.role == TextRole::Choice));

    // Speaker names: `#name` line + `[chara_ptext text=…]`.
    let speakers: Vec<_> = doc.speaker_units().collect();
    assert_eq!(
        speakers
            .iter()
            .map(|u| u.source_text.as_str())
            .collect::<Vec<_>>(),
        vec!["アリス", "ボブ先生"],
    );
    assert!(speakers.iter().all(|u| u.role == TextRole::SpeakerName));

    // Active-speaker tracking (from `#name` then `[chara_ptext]`).
    assert_eq!(
        doc.dialogue_units()
            .map(|u| u.speaker.clone())
            .collect::<Vec<_>>(),
        vec![
            Some("アリス".to_string()),
            Some("アリス".to_string()),
            Some("アリス".to_string()),
            Some("ボブ先生".to_string()),
            Some("ボブ先生".to_string()),
            Some("ボブ先生".to_string()),
            Some("ボブ先生".to_string()),
        ],
    );

    // Stable extraction identity keys.
    assert_eq!(
        doc.dialogue_units()
            .map(|u| u.source_unit_key.clone())
            .collect::<Vec<_>>(),
        vec![
            "tyranoscript:scenario_basic.ks#L4#seg0#dialogue",
            "tyranoscript:scenario_basic.ks#L5#seg0#dialogue",
            "tyranoscript:scenario_basic.ks#L5#seg1#dialogue",
            "tyranoscript:scenario_basic.ks#L7#seg0#dialogue",
            "tyranoscript:scenario_basic.ks#L8#seg0#dialogue",
            "tyranoscript:scenario_basic.ks#L14#seg0#dialogue",
            "tyranoscript:scenario_basic.ks#L16#seg0#dialogue",
        ],
    );
    assert_eq!(
        doc.choice_units()
            .map(|u| u.source_unit_key.clone())
            .collect::<Vec<_>>(),
        vec![
            "tyranoscript:scenario_basic.ks#L9#seg0#choice",
            "tyranoscript:scenario_basic.ks#L10#seg0#choice",
            "tyranoscript:scenario_basic.ks#L11#seg0#choice",
        ],
    );

    // No-silent-skip: the `@`-line command vocabulary would be recorded — this
    // fixture uses inline tags only, so there are no line-command findings.
    // Every span decodes to its recorded source text (exact byte span).
    for u in &doc.units {
        assert_eq!(
            &String::from_utf8(bytes[u.start_byte..u.end_byte].to_vec()).unwrap(),
            &u.source_text,
        );
    }

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
}

#[test]
fn identity_patch_reproduces_source_bytes_exactly() {
    let bytes = fixture_bytes();
    let doc = parse_ks(FIXTURE_FILE, &bytes);

    // Re-pack every unit (dialogue + choice + speaker) with its own source
    // text: the identity round-trip must be byte-identical.
    let translations: BTreeMap<String, String> = doc
        .units
        .iter()
        .map(|u| (u.source_unit_key.clone(), u.source_text.clone()))
        .collect();

    let patched = apply_patch(&bytes, &doc.units, doc.encoding, &translations).unwrap();
    assert_eq!(patched, bytes, "identity patch must reproduce source bytes");
}

#[test]
fn translation_patch_changes_only_translatable_text() {
    let bytes = fixture_bytes();
    let doc = parse_ks(FIXTURE_FILE, &bytes);

    // Translate every translatable unit (dialogue + choice + speaker) to a new
    // string; structure (tags/labels/jumps/variables) must be untouched.
    let translations: BTreeMap<String, String> = doc
        .units
        .iter()
        .enumerate()
        .map(|(i, u)| (u.source_unit_key.clone(), format!("<T{i}>")))
        .collect();

    let patched = apply_patch(&bytes, &doc.units, doc.encoding, &translations).unwrap();
    assert_ne!(patched, bytes, "translatable text must have changed");

    // Round-trip proof: nothing but translatable spans moved.
    verify_byte_preserving(&bytes, &patched, FIXTURE_FILE, doc.encoding).unwrap();

    // Structural (non-text) byte streams are byte-identical.
    let pat_doc = parse_ks(FIXTURE_FILE, &patched);
    assert_eq!(
        structural_bytes(&bytes, &doc),
        structural_bytes(&patched, &pat_doc),
    );

    // Concrete: every tag / label / jump / variable / comment survives
    // byte-identical, and the attribute quotes around choice captions stay put.
    let patched_str = String::from_utf8(patched.clone()).unwrap();
    for needle in [
        "; tyranoscript synthetic scenario fixture",
        "*start|オープニング",
        "[eval exp=\"f.count=0\"]",
        "[fadein time=500]",
        "[l][r]",
        "&f.count",
        "[chara_ptext text=\"",
        "[link target=*yes]",
        "[endlink]",
        "[glink text=\"",
        "[button text=\"",
        "target=*no]",
        "target=*maybe]",
        "[jump target=*start storage=next.ks]",
        "[if exp=\"f.count>0\"]",
        "[endif]",
        "[cm]",
    ] {
        assert!(patched_str.contains(needle), "missing structure: {needle}");
    }
    // The `#` speaker-line marker is structure: it survives even though the
    // display name it introduces (unit 0) is translated to `<T0>`.
    assert!(patched_str.contains("#<T0>"), "speaker `#` marker lost");
}

#[test]
fn choice_only_patch_leaves_dialogue_and_structure_intact() {
    let bytes = fixture_bytes();
    let doc = parse_ks(FIXTURE_FILE, &bytes);

    // Translate ONLY choice captions.
    let translations: BTreeMap<String, String> = doc
        .choice_units()
        .enumerate()
        .map(|(i, u)| (u.source_unit_key.clone(), format!("choice-{i}")))
        .collect();

    let patched = apply_patch(&bytes, &doc.units, doc.encoding, &translations).unwrap();
    verify_byte_preserving(&bytes, &patched, FIXTURE_FILE, doc.encoding).unwrap();

    // Dialogue text is unchanged; choices are swapped.
    assert_eq!(dialogue_texts(&patched), dialogue_texts(&bytes));
    assert_eq!(
        parse_ks(FIXTURE_FILE, &patched)
            .choice_units()
            .map(|u| u.source_text.clone())
            .collect::<Vec<_>>(),
        vec!["choice-0", "choice-1", "choice-2"],
    );
}

#[test]
fn regression_touching_a_tag_fails_verification() {
    let bytes = fixture_bytes();
    let doc = parse_ks(FIXTURE_FILE, &bytes);
    // Identity patch, then corrupt an inline tag byte: turn `[cm]` into `[xm]`.
    let translations: BTreeMap<String, String> = doc
        .units
        .iter()
        .map(|u| (u.source_unit_key.clone(), u.source_text.clone()))
        .collect();
    let mut tampered = apply_patch(&bytes, &doc.units, doc.encoding, &translations).unwrap();

    let idx = tampered
        .windows(4)
        .position(|w| w == b"[cm]")
        .expect("[cm] present");
    tampered[idx + 1] = b'x';

    let err = verify_byte_preserving(&bytes, &tampered, FIXTURE_FILE, doc.encoding).unwrap_err();
    assert!(
        matches!(err, kaifuu_tyrano::VerifyError::StructureChanged { .. }),
        "expected StructureChanged, got {err:?}",
    );
}

#[test]
fn regression_touching_a_jump_target_fails_verification() {
    let bytes = fixture_bytes();
    let doc = parse_ks(FIXTURE_FILE, &bytes);
    // Identity patch, then corrupt the `[jump]` storage — a structure edit.
    let translations: BTreeMap<String, String> = doc
        .units
        .iter()
        .map(|u| (u.source_unit_key.clone(), u.source_text.clone()))
        .collect();
    let mut tampered = apply_patch(&bytes, &doc.units, doc.encoding, &translations).unwrap();
    let idx = tampered
        .windows(7)
        .position(|w| w == b"next.ks")
        .expect("jump storage present");
    tampered[idx] = b'X';

    let err = verify_byte_preserving(&bytes, &tampered, FIXTURE_FILE, doc.encoding).unwrap_err();
    assert!(
        matches!(err, kaifuu_tyrano::VerifyError::StructureChanged { .. }),
        "expected StructureChanged, got {err:?}",
    );
}

#[test]
fn regression_dropping_a_unit_fails_verification() {
    let bytes = fixture_bytes();
    let doc = parse_ks(FIXTURE_FILE, &bytes);

    // DROP a dialogue unit: delete "どうしますか。", leaving its line empty.
    let dropped = String::from_utf8(bytes.clone())
        .unwrap()
        .replace("どうしますか。", "");
    let dropped_bytes = dropped.into_bytes();
    assert_ne!(dropped_bytes, bytes);

    let err =
        verify_byte_preserving(&bytes, &dropped_bytes, FIXTURE_FILE, doc.encoding).unwrap_err();
    assert!(
        matches!(err, kaifuu_tyrano::VerifyError::UnitSetChanged),
        "expected UnitSetChanged, got {err:?}",
    );
}

#[test]
fn attr_translation_containing_the_quote_is_rejected() {
    let bytes = fixture_bytes();
    let doc = parse_ks(FIXTURE_FILE, &bytes);
    let choice = doc.choice_units().nth(1).expect("glink choice"); // quoted attr
    let translations: BTreeMap<String, String> =
        BTreeMap::from([(choice.source_unit_key.clone(), "has a \" quote".to_string())]);
    let err = apply_patch(&bytes, &doc.units, doc.encoding, &translations).unwrap_err();
    assert!(
        matches!(
            err,
            kaifuu_tyrano::PatchError::QuoteInAttrTranslation { .. }
        ),
        "expected QuoteInAttrTranslation, got {err:?}",
    );
}

#[test]
fn shift_jis_scenario_round_trips_in_process() {
    // Build a tiny Shift-JIS `.ks` in-process (no committed binary blob). The
    // trailing byte of these kana can equal ASCII `[`/`]`/`&`; encoding-aware
    // scanning must not mis-split them.
    let (sjis, _, had_err) = encoding_rs::SHIFT_JIS
        .encode("#アリス\nこんにちは[l]せかい。[p]\n[glink text=\"はい\" target=*a]\n");
    assert!(!had_err);
    let bytes = sjis.into_owned();
    let doc = parse_ks_with_encoding("sjis.ks", &bytes, TsEncoding::ShiftJis);
    assert_eq!(doc.encoding, TsEncoding::ShiftJis);

    // Extracted dialogue + choice + speaker decode correctly.
    assert_eq!(
        doc.dialogue_units()
            .map(|u| u.source_text.clone())
            .collect::<Vec<_>>(),
        vec!["こんにちは", "せかい。"],
    );
    assert_eq!(
        doc.choice_units().next().unwrap().source_text,
        "はい".to_string()
    );
    assert_eq!(
        doc.speaker_units().next().unwrap().source_text,
        "アリス".to_string()
    );

    // Identity re-pack is byte-identical.
    let translations: BTreeMap<String, String> = doc
        .units
        .iter()
        .map(|u| (u.source_unit_key.clone(), u.source_text.clone()))
        .collect();
    let patched = apply_patch(&bytes, &doc.units, doc.encoding, &translations).unwrap();
    assert_eq!(patched, bytes);
}
