//! KAIFUU-211 real-bytes integration test for the bundle-driven
//! patchback driver (`apply_translated_bundle`).
//!
//! Loads a Sweetie HD **dialogue scene** from `ITOTORI_REAL_GAME_ROOT`,
//! runs `kaifuu_reallive::produce_bundle` to get the canonical
//! source-side bundle, **synthesises** a translated bundle by replacing
//! every (dialogue) unit's `target.text` with a known en-US sentinel
//! string, applies the patchback, re-parses the patched `Seen.txt`, and
//! asserts the KAIFUU-211 acceptance criteria PLUS the binary-vs-dialogue
//! surface-selection guarantee:
//!
//! - The directory still has 198 entries.
//! - The patched scene's bytecode decompresses cleanly.
//! - The Textout opcodes now contain the en-US sentinel bytes (not the
//!   original ja-JP body).
//! - **Every binary (non-translatable) Textout run in the scene survives
//!   patchback byte-identical** — a translate+patchback run never
//!   overwrites the embedded data tables.
//! - The file size is within +/- 50% of the original.
//! - The original source byte slice is unchanged (returned `Vec<u8>`
//!   is a fresh allocation).
//!
//! Env-gated and STRICT BY DEFAULT: without `ITOTORI_REAL_GAME_ROOT` an absent
//! corpus is a HARD FAILURE. Set the explicit opt-out
//! `ITOTORI_ALLOW_MISSING_CORPUS=1` to downgrade it to a loudly-logged skip
//! (knowingly forgoing real-bytes coverage).

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;
use std::path::PathBuf;

use kaifuu_reallive::{
    BridgeOpts, PatchbackOpts, REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN, RealLiveOpcode, SceneHeader,
    TranslatedBundleV02, TranslationScope, Xor2Cipher, Xor2DecScene, apply_translated_bundle,
    collect_goto_pointer_sites, compiler_version_uses_xor2, decode_dialogue_textout,
    decompress_avg32, encode_choice_option_next_string_safe, gameexe::parse_gameexe_inventory,
    parse_archive, parse_real_bytecode, parse_real_bytecode_spans, produce_bundle,
    recover_archive_cipher,
};

const SWEETIE_HD_GAME_ID: &str = "sweetie-hd";
const SWEETIE_HD_SOURCE_PROFILE_ID: &str = "kaifuu-reallive-sweetie-hd";
/// A known dialogue-bearing scene in Sweetie HD's `Seen.txt` that decodes
/// 100% clean. Scene 1 is an all-binary boundary scene and carries no
/// translatable units (see `bridge_real_bytes`), so the patchback
/// round-trip is exercised against a real dialogue scene instead.
/// (Scene 2011, previously used here, contains a second-level-XOR'd
/// `module_sel` block — a `compiler_version=110002` `xor_2` segment owned
/// by the decompressor follow-up node — and can no longer be decoded
/// end-to-end, so it is not a valid clean round-trip fixture.)
const DIALOGUE_SCENE_ID: u16 = 1017;

/// English-language sentinel used by the round-trip assertion.
///
/// Prefixed with one full-width SJIS punctuation character (`「`,
/// 0x81 0x75) so the patched bytes still parse as a Textout opcode (the
/// parser recognises a run by the SJIS lead-byte switch
/// `0x81..=0x9F | 0xE0..=0xFC`).
const EN_SENTINEL: &str = "「[EN] hello world from kaifuu-211」";

/// SJIS lead-byte for the leading `「` character.
const EN_SENTINEL_SJIS_PREFIX: &[u8] = &[0x81, 0x75];

fn real_seen_txt_path() -> Option<PathBuf> {
    real_corpus::seen_txt_path()
}

fn real_gameexe_ini_path() -> Option<PathBuf> {
    real_corpus::gameexe_ini_path()
}

fn bridge_opts(scene_kidoku_count: u32) -> BridgeOpts<'static> {
    BridgeOpts {
        game_id: SWEETIE_HD_GAME_ID,
        game_version: "1.0.0",
        source_profile_id: SWEETIE_HD_SOURCE_PROFILE_ID,
        source_locale: "ja-JP",
        extractor_name: "kaifuu-reallive-bridge",
        extractor_version: "0.1.0",
        scene_kidoku_count,
    }
}

/// `(scene_blob, decompressed_bytecode, header)` for a scene id.
///
/// The bytecode is returned as the real PLAINTEXT the interpreter executes:
/// after AVG32 decompression, Sweetie HD's second-level `xor_2` segment
/// (`compiler_version=110002`) over `[256, 513)` is decrypted with the
/// per-game key recovered cross-scene from the whole archive. Comparing at
/// the plaintext layer is the only correct fidelity check for an
/// encrypted-at-rest game: the patchback re-encrypts edited scenes, so a raw
/// (still-ciphertext) comparison would see the position-fixed xor_2 window
/// shift whenever a length-changing splice moved content under it.
fn scene_bytes(seen_bytes: &[u8], scene_id: u16) -> (Vec<u8>, Vec<u8>, SceneHeader) {
    let index = parse_archive(seen_bytes).expect("envelope parses");
    let entry = index
        .entries
        .iter()
        .find(|entry| entry.scene_id == scene_id)
        .unwrap_or_else(|| panic!("scene {scene_id} must exist"));
    let blob_start = entry.byte_offset as usize;
    let blob_end = blob_start + entry.byte_len as usize;
    let scene_blob = seen_bytes[blob_start..blob_end].to_vec();
    let header = SceneHeader::parse(&scene_blob).expect("scene header must parse");
    let bytecode = &scene_blob[header.bytecode_offset as usize
        ..(header.bytecode_offset + header.bytecode_compressed_size) as usize];
    let mut decompressed = decompress_avg32(bytecode, header.bytecode_uncompressed_size as usize)
        .expect("AVG32 decompression must succeed");
    if compiler_version_uses_xor2(header.compiler_version) {
        recover_archive_xor2_cipher(seen_bytes)
            .expect("Sweetie HD archive must yield a validated xor_2 cipher")
            .apply_segment(&mut decompressed);
    }
    (scene_blob, decompressed, header)
}

/// Recover the validated per-game `xor_2` cipher by decompressing every scene
/// of the archive (the cross-scene known-plaintext key recovery). `None` when
/// the archive carries no `use_xor_2` scenes or no key validates.
fn recover_archive_xor2_cipher(seen_bytes: &[u8]) -> Option<kaifuu_reallive::Xor2Cipher> {
    let index = parse_archive(seen_bytes).expect("envelope parses");
    let mut scenes: Vec<Xor2DecScene> = Vec::with_capacity(index.entries.len());
    for entry in &index.entries {
        let blob_start = entry.byte_offset as usize;
        let blob_end = blob_start + entry.byte_len as usize;
        if blob_end > seen_bytes.len() {
            continue;
        }
        let blob = &seen_bytes[blob_start..blob_end];
        let Ok(header) = SceneHeader::parse(blob) else {
            continue;
        };
        let bo = header.bytecode_offset as usize;
        let bc = header.bytecode_compressed_size as usize;
        let bu = header.bytecode_uncompressed_size as usize;
        if bo + bc > blob.len() {
            continue;
        }
        let Ok(decompressed) = decompress_avg32(&blob[bo..bo + bc], bu) else {
            continue;
        };
        scenes.push(Xor2DecScene {
            compiler_version: header.compiler_version,
            bytecode: decompressed,
        });
    }
    recover_archive_cipher(&scenes).ok()
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn patches_dialogue_scene_with_en_us_sentinel_and_preserves_binary_runs_byte_identical() {
    let Some(seen_path) = real_seen_txt_path() else {
        real_corpus::skip_or_require_real_bytes(
            "patches_dialogue_scene_with_en_us_sentinel_and_preserves_binary_runs_byte_identical",
        );
        return;
    };
    let seen_bytes = fs::read(&seen_path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", seen_path.display()));
    assert!(
        seen_bytes.len() as u64 >= REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN,
        "Seen.txt must carry the 10,000-slot directory"
    );

    let source_seen_hash = simple_hash(&seen_bytes);

    let index = parse_archive(&seen_bytes).expect("real Seen.txt envelope must parse");
    assert_eq!(
        index.entries.len(),
        198,
        "Sweetie HD must have 198 populated scene slots"
    );

    let (scene_blob, decompressed, header) = scene_bytes(&seen_bytes, DIALOGUE_SCENE_ID);

    // Capture every BINARY (non-translatable) Textout body BEFORE the
    // patch. These are the embedded data runs that must survive
    // byte-identical — they are never surfaced as translatable units.
    let original_opcodes = parse_real_bytecode(&decompressed).expect("source bytecode parses");
    let binary_runs: Vec<Vec<u8>> = original_opcodes
        .iter()
        .filter_map(|op| match op {
            RealLiveOpcode::Textout { raw_bytes, .. }
                if decode_dialogue_textout(raw_bytes).is_none() =>
            {
                Some(raw_bytes.clone())
            }
            _ => None,
        })
        .collect();
    assert!(
        !binary_runs.is_empty(),
        "the dialogue scene must contain at least one binary catch-all run to preserve"
    );
    // The first TRANSLATABLE textout body (used by the "original gone"
    // assertion — a binary run would survive and break the check).
    let original_first_dialogue: Vec<u8> = original_opcodes
        .iter()
        .find_map(|op| match op {
            RealLiveOpcode::Textout { raw_bytes, .. }
                if decode_dialogue_textout(raw_bytes).is_some() && raw_bytes.len() >= 4 =>
            {
                Some(raw_bytes.clone())
            }
            _ => None,
        })
        .expect("dialogue scene must have at least one readable textout");

    // Build the v0.2 source bundle (KAIFUU-210 producer).
    let gameexe_bytes = real_gameexe_ini_path()
        .and_then(|path| fs::read(path).ok())
        .unwrap_or_default();
    let gameexe_inventory = parse_gameexe_inventory(&gameexe_bytes);
    let opts = bridge_opts(header.kidoku_count);
    let produced = produce_bundle(
        DIALOGUE_SCENE_ID,
        &scene_blob,
        &decompressed,
        &gameexe_inventory,
        &opts,
    )
    .expect("v0.2 bundle must build from the dialogue scene");

    // Synthesise a translated bundle: en-US sentinel on every unit.
    let mut translated_value = produced.json.clone();
    {
        let units = translated_value["units"]
            .as_array_mut()
            .expect("units must be a JSON array");
        for unit in units.iter_mut() {
            unit["target"] = serde_json::json!({
                "locale": "en-US",
                "text": EN_SENTINEL,
            });
        }
    }
    let translated =
        TranslatedBundleV02::from_json(&translated_value).expect("translated bundle parses");

    let patched = apply_translated_bundle(
        &seen_bytes,
        &translated,
        &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
    )
    .expect("apply_translated_bundle must succeed on the dialogue scene");
    assert_eq!(
        simple_hash(&seen_bytes),
        source_seen_hash,
        "apply_translated_bundle must not mutate its input slice"
    );

    // ---- Acceptance: directory still has 198 entries. ----
    let reparsed = parse_archive(&patched).expect("patched Seen.txt must re-parse");
    assert_eq!(
        reparsed.entries.len(),
        198,
        "patched archive must preserve the 198-entry directory shape"
    );

    // ---- Acceptance: patched scene bytecode decompresses cleanly. ----
    let new_entry = reparsed
        .entries
        .iter()
        .find(|entry| entry.scene_id == DIALOGUE_SCENE_ID)
        .expect("patched archive must still contain the dialogue scene");
    let new_blob_start = new_entry.byte_offset as usize;
    let new_blob_end = new_blob_start + new_entry.byte_len as usize;
    let new_scene_blob = &patched[new_blob_start..new_blob_end];
    let new_header = SceneHeader::parse(new_scene_blob).expect("patched scene header parses");
    let new_bytecode = &new_scene_blob[new_header.bytecode_offset as usize
        ..(new_header.bytecode_offset + new_header.bytecode_compressed_size) as usize];
    let mut new_decompressed =
        decompress_avg32(new_bytecode, new_header.bytecode_uncompressed_size as usize)
            .expect("patched bytecode must decompress cleanly");
    // Decrypt the patched scene to the PLAINTEXT layer — the same layer the
    // binary runs were captured at and the layer the interpreter executes.
    // The per-game key is recovered from the pristine SOURCE archive (every
    // source scene decodes clean, so the key validates); it is identical for
    // the patched archive, whose edited scene the patchback re-encrypted.
    if compiler_version_uses_xor2(new_header.compiler_version) {
        recover_archive_xor2_cipher(&seen_bytes)
            .expect("Sweetie HD source archive must yield a validated xor_2 cipher")
            .apply_segment(&mut new_decompressed);
    }

    // ---- Acceptance: EVERY binary run survives byte-identical. ----
    for (i, run) in binary_runs.iter().enumerate() {
        let survives = new_decompressed
            .windows(run.len())
            .any(|window| window == run.as_slice());
        assert!(
            survives,
            "binary catch-all run #{i} (len={}) must survive patchback byte-identical — \
             a translate+patchback run must never overwrite an embedded data table",
            run.len()
        );
    }
    eprintln!(
        "scene {DIALOGUE_SCENE_ID}: {} binary runs preserved byte-identical",
        binary_runs.len()
    );

    // ---- Acceptance: patched bytecode carries the en-US sentinel bytes. ----
    let opcodes = parse_real_bytecode(&new_decompressed).expect("patched bytecode parses");
    let en_sentinel_bytes =
        kaifuu_reallive::encode_shift_jis_slot(EN_SENTINEL).expect("sentinel encodes as SJIS");
    let sentinel_in_bytecode = new_decompressed
        .windows(en_sentinel_bytes.len())
        .any(|window| window == en_sentinel_bytes.as_slice());
    assert!(
        sentinel_in_bytecode,
        "patched decompressed bytecode must contain the SJIS-encoded en-US sentinel (len={})",
        en_sentinel_bytes.len()
    );
    let textout_count = opcodes
        .iter()
        .filter(|op| matches!(op, RealLiveOpcode::Textout { .. }))
        .count();
    let sentinel_textout_count = opcodes
        .iter()
        .filter(|op| match op {
            RealLiveOpcode::Textout { raw_bytes, .. } => {
                raw_bytes.starts_with(EN_SENTINEL_SJIS_PREFIX)
            }
            _ => false,
        })
        .count();
    eprintln!(
        "scene {DIALOGUE_SCENE_ID} patched: textout_count={textout_count}, \
         sentinel_textout_count={sentinel_textout_count}"
    );
    assert!(
        sentinel_textout_count > 0,
        "at least one Textout must start with the en-US sentinel's SJIS prefix \
         (`「` = 0x81 0x75); got 0/{textout_count}"
    );

    // ---- Acceptance: original ja-JP first dialogue bytes are gone. ----
    let original_present = new_decompressed
        .windows(original_first_dialogue.len())
        .any(|window| window == original_first_dialogue.as_slice());
    assert!(
        !original_present,
        "original ja-JP dialogue body must no longer appear verbatim in the patched bytecode"
    );

    // ---- Acceptance: file size within +/- 50% of original. ----
    let size_ratio = (patched.len() as f64) / (seen_bytes.len() as f64);
    eprintln!(
        "Seen.txt size: source={} patched={} (ratio={size_ratio:.3})",
        seen_bytes.len(),
        patched.len()
    );
    assert!(
        (0.5..=1.5).contains(&size_ratio),
        "patched Seen.txt size {patched_len} is outside +/-50% of the source ({source_len})",
        patched_len = patched.len(),
        source_len = seen_bytes.len()
    );
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn provenance_mismatch_byte_range_emits_typed_error_on_real_bytes() {
    let Some(seen_path) = real_seen_txt_path() else {
        real_corpus::skip_or_require_real_bytes(
            "provenance_mismatch_byte_range_emits_typed_error_on_real_bytes",
        );
        return;
    };
    let seen_bytes = fs::read(&seen_path).expect("read Seen.txt");

    let (scene_blob, decompressed, header) = scene_bytes(&seen_bytes, DIALOGUE_SCENE_ID);
    let gameexe_bytes = real_gameexe_ini_path()
        .and_then(|path| fs::read(path).ok())
        .unwrap_or_default();
    let gameexe_inventory = parse_gameexe_inventory(&gameexe_bytes);
    let opts = bridge_opts(header.kidoku_count);
    let produced = produce_bundle(
        DIALOGUE_SCENE_ID,
        &scene_blob,
        &decompressed,
        &gameexe_inventory,
        &opts,
    )
    .expect("v0.2 bundle");

    let mut translated_value = produced.json.clone();
    {
        let units = translated_value["units"]
            .as_array_mut()
            .expect("units array");
        for unit in units.iter_mut() {
            unit["target"] = serde_json::json!({
                "locale": "en-US",
                "text": EN_SENTINEL,
            });
        }
        // Corrupt the first unit's occurrence index to one the scene's
        // bytecode re-walk cannot resolve.
        let bad_key = format!("reallive:scene-{DIALOGUE_SCENE_ID:04}#99999");
        units[0]["sourceUnitKey"] = serde_json::json!(bad_key);
        units[0]["patchRef"]["sourceUnitKey"] = serde_json::json!(bad_key);
    }
    let translated =
        TranslatedBundleV02::from_json(&translated_value).expect("translated bundle parses");
    let err = apply_translated_bundle(
        &seen_bytes,
        &translated,
        &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
    )
    .expect_err("corrupted provenance must raise a typed mismatch");
    eprintln!("provenance-mismatch error surfaced: {err}");
    let err_string = format!("{err}");
    assert!(
        err_string.contains("kaifuu.reallive.patchback_provenance_mismatch"),
        "expected provenance_mismatch code; got: {err_string}"
    );
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn missing_target_payload_surfaces_typed_schema_invalid_on_real_bytes() {
    let Some(seen_path) = real_seen_txt_path() else {
        real_corpus::skip_or_require_real_bytes(
            "missing_target_payload_surfaces_typed_schema_invalid_on_real_bytes",
        );
        return;
    };
    let seen_bytes = fs::read(&seen_path).expect("read Seen.txt");
    let (scene_blob, decompressed, header) = scene_bytes(&seen_bytes, DIALOGUE_SCENE_ID);
    let gameexe_bytes = real_gameexe_ini_path()
        .and_then(|path| fs::read(path).ok())
        .unwrap_or_default();
    let gameexe_inventory = parse_gameexe_inventory(&gameexe_bytes);
    let opts = bridge_opts(header.kidoku_count);
    let produced = produce_bundle(
        DIALOGUE_SCENE_ID,
        &scene_blob,
        &decompressed,
        &gameexe_inventory,
        &opts,
    )
    .expect("v0.2 bundle");
    // The source-side JSON has no `target` field — must fail to parse
    // as a translated bundle.
    let err = TranslatedBundleV02::from_json(&produced.json)
        .expect_err("missing target.text must surface a typed error");
    eprintln!("schema-invalid error surfaced: {err}");
    let err_string = format!("{err}");
    assert!(
        err_string.contains("kaifuu.reallive.patchback_bundle_schema_invalid")
            || err_string.contains("target"),
        "expected bundle_schema_invalid code; got: {err_string}"
    );
}

/// The Choice-bearing scene the config-driven-scope tests exercise:
/// Sweetie HD scene 2011 carries a real `module_sel` Choice (op #33, before
/// all 213 dialogue units) with two Shift-JIS options.
const CHOICE_SCENE_ID: u16 = 2011;

/// Decompress + `xor_2`-decrypt scene `scene_id` out of `seen_bytes` to the
/// plaintext bytecode layer, using an already-recovered per-game cipher.
fn decrypt_scene(seen_bytes: &[u8], scene_id: u16, cipher: &Xor2Cipher) -> Vec<u8> {
    let index = parse_archive(seen_bytes).expect("archive parses");
    let entry = index
        .entries
        .iter()
        .find(|e| e.scene_id == scene_id)
        .unwrap_or_else(|| panic!("scene {scene_id} present"));
    let blob = &seen_bytes
        [entry.byte_offset as usize..(entry.byte_offset + u64::from(entry.byte_len)) as usize];
    let header = SceneHeader::parse(blob).expect("header");
    let bo = header.bytecode_offset as usize;
    let bc = header.bytecode_compressed_size as usize;
    let mut d = decompress_avg32(
        &blob[bo..bo + bc],
        header.bytecode_uncompressed_size as usize,
    )
    .expect("decompress");
    if compiler_version_uses_xor2(header.compiler_version) {
        cipher.apply_segment(&mut d);
    }
    d
}

/// Produce the scene-2011 source bundle and return
/// `(translated_json_value, choice_unit_keys)` where `choice_unit_keys`
/// lists the `sourceUnitKey`s of the two `choice_label` units in order.
fn scene_2011_source_bundle(seen_bytes: &[u8]) -> (serde_json::Value, Vec<String>) {
    let (scene_blob, decompressed, header) = scene_bytes(seen_bytes, CHOICE_SCENE_ID);
    let gameexe_bytes = real_gameexe_ini_path()
        .and_then(|path| fs::read(path).ok())
        .unwrap_or_default();
    let gameexe_inventory = parse_gameexe_inventory(&gameexe_bytes);
    let opts = bridge_opts(header.kidoku_count);
    let produced = produce_bundle(
        CHOICE_SCENE_ID,
        &scene_blob,
        &decompressed,
        &gameexe_inventory,
        &opts,
    )
    .expect("v0.2 bundle must build from the choice scene");
    let choice_keys: Vec<String> = produced
        .bundle
        .units
        .iter()
        .filter(|u| u.surface_kind == "choice_label")
        .map(|u| u.source_unit_key.clone())
        .collect();
    assert_eq!(
        choice_keys.len(),
        2,
        "scene {CHOICE_SCENE_ID} must surface exactly two choice_label options"
    );
    (produced.json.clone(), choice_keys)
}

/// A translated en-US choice option deliberately carrying NextString-hostile
/// bytes: `[` (0x5B, the memory-index open byte that ends an unquoted
/// NextString token), plus `.`, `!`, `(`, `)`, `,`, `-`, `'` — none of which
/// are unquoted string-token bytes. A raw Shift-JIS splice of this text would
/// truncate the option and corrupt the select command.
const TRICKY_CHOICE_0: &str = "[EN] Maybe today I'm in the mood (yes!), a bit.";
const TRICKY_CHOICE_1: &str = "[EN] No way - I'd rather not... [skip]";

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn scope_dialogue_and_choices_patches_scene_2011_choice_nextstring_safe_round_trip() {
    let Some(seen_path) = real_seen_txt_path() else {
        real_corpus::skip_or_require_real_bytes(
            "scope_dialogue_and_choices_patches_scene_2011_choice_nextstring_safe_round_trip",
        );
        return;
    };
    let seen_bytes = fs::read(&seen_path).expect("read Seen.txt");
    let cipher = recover_archive_xor2_cipher(&seen_bytes)
        .expect("Sweetie HD must yield a validated xor_2 cipher");

    let (mut bundle_value, choice_keys) = scene_2011_source_bundle(&seen_bytes);

    // Translate the two choice options to the tricky en-US strings and the
    // dialogue units to a sentinel — all IN scope under dialogue+choices.
    let tricky = [TRICKY_CHOICE_0, TRICKY_CHOICE_1];
    {
        let units = bundle_value["units"].as_array_mut().expect("units array");
        for unit in units.iter_mut() {
            let key = unit["sourceUnitKey"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            let text = if let Some(idx) = choice_keys.iter().position(|k| *k == key) {
                tricky[idx].to_string()
            } else {
                EN_SENTINEL.to_string()
            };
            unit["target"] = serde_json::json!({"locale": "en-US", "text": text});
        }
    }
    let translated = TranslatedBundleV02::from_json(&bundle_value).expect("translated parses");

    let patched = apply_translated_bundle(
        &seen_bytes,
        &translated,
        &PatchbackOpts::shift_jis(TranslationScope::DialogueAndChoices),
    )
    .expect("dialogue+choices patch must succeed on the real choice scene");

    // Re-parse the patched scene at the plaintext layer.
    let patched_bytecode = decrypt_scene(&patched, CHOICE_SCENE_ID, &cipher);
    let ops = parse_real_bytecode(&patched_bytecode)
        .expect("patched choice scene must re-decompile cleanly (select framing intact)");
    let choices = ops
        .iter()
        .find_map(|op| match op {
            RealLiveOpcode::Choice { choices } => Some(choices),
            _ => None,
        })
        .expect("patched scene must still carry the module_sel Choice command");
    assert_eq!(
        choices.len(),
        2,
        "both choice options must survive the NextString-safe splice"
    );

    // Each option's raw bytes must equal the NextString-safe encoding of its
    // tricky translation, decode cleanly, and NOT carry an unescaped early
    // terminator — i.e. the `[` did not corrupt the token.
    for (i, expected_text) in tricky.iter().enumerate() {
        let expected_bytes =
            encode_choice_option_next_string_safe(expected_text).expect("tricky text encodes");
        assert_eq!(
            choices[i].bytes, expected_bytes,
            "option {i} bytes must be the NextString-safe quoted encoding of the translation"
        );
        assert!(
            decode_dialogue_textout(&choices[i].bytes).is_some(),
            "option {i} must decode cleanly as a translatable Shift-JIS run"
        );
        // The tricky `[` byte is present INSIDE the option (proving it was
        // carried, not stripped/truncated).
        assert!(
            choices[i].bytes.contains(&b'['),
            "option {i} must carry the literal `[` byte inside the quoted NextString"
        );
    }
    eprintln!(
        "scope=dialogue+choices: scene {CHOICE_SCENE_ID} choice round-tripped NextString-safe \
         (options: {:?})",
        choices.iter().map(|c| c.bytes.len()).collect::<Vec<_>>()
    );
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn scope_dialogue_only_carries_scene_2011_choice_byte_identical() {
    let Some(seen_path) = real_seen_txt_path() else {
        real_corpus::skip_or_require_real_bytes(
            "scope_dialogue_only_carries_scene_2011_choice_byte_identical",
        );
        return;
    };
    let seen_bytes = fs::read(&seen_path).expect("read Seen.txt");
    let cipher = recover_archive_xor2_cipher(&seen_bytes)
        .expect("Sweetie HD must yield a validated xor_2 cipher");

    // Capture the SOURCE choice options.
    let source_bytecode = decrypt_scene(&seen_bytes, CHOICE_SCENE_ID, &cipher);
    let source_ops = parse_real_bytecode(&source_bytecode).expect("source scene decompiles");
    let source_choice: Vec<Vec<u8>> = source_ops
        .iter()
        .find_map(|op| match op {
            RealLiveOpcode::Choice { choices } => {
                Some(choices.iter().map(|c| c.bytes.clone()).collect())
            }
            _ => None,
        })
        .expect("source scene carries a Choice command");

    let (mut bundle_value, choice_keys) = scene_2011_source_bundle(&seen_bytes);

    // Give the CHOICE units a corrupting `[`-bearing target and the dialogue
    // units the sentinel. Under dialogue-only scope the choice targets MUST be
    // ignored (carried byte-identical) — proving the CONFIG, not bundle
    // omission, enforces the scope boundary. This is the exact byte that would
    // corrupt a naive splice.
    {
        let units = bundle_value["units"].as_array_mut().expect("units array");
        for unit in units.iter_mut() {
            let key = unit["sourceUnitKey"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            let text = if choice_keys.contains(&key) {
                TRICKY_CHOICE_0.to_string()
            } else {
                EN_SENTINEL.to_string()
            };
            unit["target"] = serde_json::json!({"locale": "en-US", "text": text});
        }
    }
    let translated = TranslatedBundleV02::from_json(&bundle_value).expect("translated parses");

    let patched = apply_translated_bundle(
        &seen_bytes,
        &translated,
        &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
    )
    .expect("dialogue-only patch must succeed");

    let patched_bytecode = decrypt_scene(&patched, CHOICE_SCENE_ID, &cipher);
    let patched_ops =
        parse_real_bytecode(&patched_bytecode).expect("patched scene decompiles cleanly");
    let patched_choice: Vec<Vec<u8>> = patched_ops
        .iter()
        .find_map(|op| match op {
            RealLiveOpcode::Choice { choices } => {
                Some(choices.iter().map(|c| c.bytes.clone()).collect())
            }
            _ => None,
        })
        .expect("patched scene still carries a Choice command");

    assert_eq!(
        patched_choice, source_choice,
        "out-of-scope Choice options must be byte-identical under dialogue-only scope \
         (the corrupting `[` target must NOT have been applied)"
    );

    // Sanity: the dialogue WAS translated (the scope boundary is non-vacuous).
    let sentinel_sjis =
        kaifuu_reallive::encode_shift_jis_slot(EN_SENTINEL).expect("sentinel encodes");
    let sentinel_present = patched_bytecode
        .windows(sentinel_sjis.len())
        .any(|w| w == sentinel_sjis.as_slice());
    assert!(
        sentinel_present,
        "dialogue-only scope must still translate the dialogue Textout bodies"
    );
    eprintln!(
        "scope=dialogue-only: scene {CHOICE_SCENE_ID} choice options carried byte-identical \
         ({} options), dialogue translated",
        source_choice.len()
    );
}

/// A goto-rich Sweetie HD dialogue scene used by the length-changing
/// jump-recalculation test. Scene 8509 decodes 100% clean (0 unknown, 0
/// generic Command), surfaces 72 translatable dialogue units, and carries
/// **91 goto-family jump-target pointers**, every one of whose destination
/// sits AFTER the first dialogue body — so a length-changing edit to the
/// dialogue shifts all 91 targets and forces the recalculation path.
const GOTO_SCENE_ID: u16 = 8509;

/// A LONGER en-US replacement body. Deliberately long enough that even
/// replacing a multi-byte Shift-JIS source line (2 bytes/char) grows the
/// total scene bytecode — a genuine length-INCREASING edit. Carries NO
/// structural-opener byte (`0x00 0x0A 0x21 0x23 0x24 0x2C 0x40`, i.e. no
/// `,` `!` `#` `$` `@`) so it re-decodes as exactly ONE Textout element and
/// the scene's element count is preserved (the same-logical-element jump
/// assertion below keys on that 1:1 element correspondence).
const LONG_SENTINEL: &str = "「[EN] This is a deliberately long English localization line \
    padded well beyond the original Japanese so that even after the two-byte-per-character \
    Shift-JIS source is removed the patched scene bytecode is strictly larger exercising the \
    forward jump-target recalculation path across every downstream goto pointer in the scene」";
/// A SHORTER en-US replacement body (shrinks the multi-byte JA dialogue).
/// Leading/trailing full-width brackets keep it a valid Shift-JIS Textout run.
const SHORT_SENTINEL: &str = "「A」";

/// Map each element-boundary byte offset in `bytecode` to its element
/// ordinal (index into the decoded element stream), plus a synthetic
/// end-of-stream ordinal for fall-through targets. Every well-formed goto
/// target lands on one of these boundaries.
fn boundary_ordinals(bytecode: &[u8]) -> std::collections::BTreeMap<usize, (usize, &'static str)> {
    let spans = parse_real_bytecode_spans(bytecode).expect("bytecode spans decode");
    let mut map = std::collections::BTreeMap::new();
    let mut cursor = 0usize;
    for (ordinal, (op, width)) in spans.iter().enumerate() {
        map.insert(cursor, (ordinal, op.label()));
        cursor += width;
    }
    // End-of-stream boundary: a jump-to-end / fall-through target.
    map.insert(cursor, (spans.len(), "<end-of-stream>"));
    map
}

/// Exercise the length-changing patchback's jump-target recalculation on a
/// real, goto-rich Sweetie HD scene, for BOTH a longer and a shorter
/// translated body. Proves:
///  - the archive re-parses with the same 198-scene count and a correctly
///    rewritten scene offset table;
///  - the patched scene re-decompiles with ZERO new unknown / generic
///    opcodes and ZERO malformed framing (`parse_real_bytecode_spans` Ok);
///  - EVERY one of the 91 goto pointers was recalculated to a NEW byte
///    offset that still lands on an element boundary AND still targets the
///    SAME logical element (same ordinal + same opcode label) it pointed to
///    in the source — i.e. a jump that pointed to opcode X still points to
///    opcode X at its new offset, never into the middle of a command.
#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn length_changing_patch_recalculates_goto_targets_on_real_scene() {
    let Some(seen_path) = real_seen_txt_path() else {
        real_corpus::skip_or_require_real_bytes(
            "length_changing_patch_recalculates_goto_targets_on_real_scene",
        );
        return;
    };
    let seen_bytes = fs::read(&seen_path).expect("read Seen.txt");
    let cipher = recover_archive_xor2_cipher(&seen_bytes)
        .expect("Sweetie HD must yield a validated xor_2 cipher");

    let source_seen_len = seen_bytes.len();

    // ---- Source-side ground truth: element boundaries + goto sites. ----
    let source_bytecode = decrypt_scene(&seen_bytes, GOTO_SCENE_ID, &cipher);
    let source_boundaries = boundary_ordinals(&source_bytecode);
    let source_sites =
        collect_goto_pointer_sites(&source_bytecode).expect("source scene goto pointers collect");
    assert!(
        source_sites.len() >= 50,
        "test scene must be goto-rich; got {} sites",
        source_sites.len()
    );
    // Every source target lands on a boundary and targets a known element.
    let source_target_ordinals: Vec<(usize, &'static str)> = source_sites
        .iter()
        .map(|site| {
            assert!(site.target >= 0, "source goto target must be non-negative");
            *source_boundaries
                .get(&(site.target as usize))
                .unwrap_or_else(|| {
                    panic!(
                        "source goto target {:#x} does not land on an element boundary",
                        site.target
                    )
                })
        })
        .collect();

    // The source bundle (KAIFUU-210 producer), reused for both directions.
    let (scene_blob, decompressed, header) = scene_bytes(&seen_bytes, GOTO_SCENE_ID);
    let gameexe_bytes = real_gameexe_ini_path()
        .and_then(|path| fs::read(path).ok())
        .unwrap_or_default();
    let gameexe_inventory = parse_gameexe_inventory(&gameexe_bytes);
    let opts = bridge_opts(header.kidoku_count);
    let produced = produce_bundle(
        GOTO_SCENE_ID,
        &scene_blob,
        &decompressed,
        &gameexe_inventory,
        &opts,
    )
    .expect("v0.2 bundle builds from the goto-rich scene");
    let dialogue_units = produced
        .bundle
        .units
        .iter()
        .filter(|u| u.surface_kind == "dialogue")
        .count();
    assert!(dialogue_units > 0, "scene must carry dialogue units");

    for (label, sentinel, expect_longer) in [
        ("LONGER", LONG_SENTINEL, true),
        ("SHORTER", SHORT_SENTINEL, false),
    ] {
        // Translate every dialogue unit to the sentinel of this direction.
        let mut translated_value = produced.json.clone();
        {
            let units = translated_value["units"]
                .as_array_mut()
                .expect("units array");
            for unit in units.iter_mut() {
                unit["target"] = serde_json::json!({"locale": "en-US", "text": sentinel});
            }
        }
        let translated =
            TranslatedBundleV02::from_json(&translated_value).expect("translated bundle parses");

        let patched = apply_translated_bundle(
            &seen_bytes,
            &translated,
            &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
        )
        .unwrap_or_else(|err| panic!("{label}: length-changing patch must succeed: {err}"));

        // ---- Offset table rewritten; same scene count. ----
        let reparsed = parse_archive(&patched).expect("patched archive re-parses");
        assert_eq!(
            reparsed.entries.len(),
            198,
            "{label}: patched archive must keep the 198-scene directory"
        );

        // ---- Patched scene re-decompiles clean at the plaintext layer. ----
        let patched_bytecode = decrypt_scene(&patched, GOTO_SCENE_ID, &cipher);
        let patched_ops = parse_real_bytecode(&patched_bytecode)
            .unwrap_or_else(|err| panic!("{label}: patched scene must re-decompile: {err}"));
        let unknown = patched_ops
            .iter()
            .filter(|o| matches!(o, RealLiveOpcode::Unknown { .. }))
            .count();
        let generic = patched_ops
            .iter()
            .filter(|o| matches!(o, RealLiveOpcode::Command { .. }))
            .count();
        assert_eq!(unknown, 0, "{label}: zero unknown opcodes required");
        assert_eq!(
            generic, 0,
            "{label}: zero generic (un-catalogued) commands required"
        );
        // Framing must still partition exactly (no MalformedExpression / drift).
        parse_real_bytecode_spans(&patched_bytecode)
            .unwrap_or_else(|err| panic!("{label}: patched framing must partition: {err}"));

        // ---- Direction of the length change is as intended. ----
        if expect_longer {
            assert!(
                patched_bytecode.len() > source_bytecode.len(),
                "{label}: patched bytecode ({}) must be longer than source ({})",
                patched_bytecode.len(),
                source_bytecode.len()
            );
        } else {
            assert!(
                patched_bytecode.len() < source_bytecode.len(),
                "{label}: patched bytecode ({}) must be shorter than source ({})",
                patched_bytecode.len(),
                source_bytecode.len()
            );
        }

        // ---- Every goto target recalculated: same count, lands on a
        //      boundary, targets the SAME logical element. ----
        let patched_boundaries = boundary_ordinals(&patched_bytecode);
        let patched_sites = collect_goto_pointer_sites(&patched_bytecode)
            .expect("patched scene goto pointers collect");
        assert_eq!(
            patched_sites.len(),
            source_sites.len(),
            "{label}: goto pointer count must be preserved"
        );

        let mut changed_targets = 0usize;
        for (i, (src, pat)) in source_sites.iter().zip(patched_sites.iter()).enumerate() {
            assert!(
                pat.target >= 0,
                "{label}: patched goto target #{i} must be non-negative"
            );
            let (pat_ord, pat_label) = *patched_boundaries
                .get(&(pat.target as usize))
                .unwrap_or_else(|| {
                    panic!(
                        "{label}: patched goto target #{i} = {:#x} does NOT land on an element \
                         boundary (would jump into the middle of a command)",
                        pat.target
                    )
                });
            let (src_ord, src_label) = source_target_ordinals[i];
            assert_eq!(
                (pat_ord, pat_label),
                (src_ord, src_label),
                "{label}: goto #{i} must still target the same logical element \
                 (source ordinal {src_ord}/{src_label}); got {pat_ord}/{pat_label}"
            );
            if pat.target != src.target {
                changed_targets += 1;
            }
        }
        // A length change that shifts content under the jumps MUST move at
        // least some targets (proving recalculation ran, not a silent no-op).
        assert!(
            changed_targets > 0,
            "{label}: expected at least one goto target to be re-based by the length delta"
        );

        eprintln!(
            "scene {GOTO_SCENE_ID} {label}: seen {source_seen_len}->{} bytes, scene bytecode \
             {}->{} bytes, {} goto pointers all land on element boundaries & target the same \
             elements ({changed_targets} re-based)",
            patched.len(),
            source_bytecode.len(),
            patched_bytecode.len(),
            patched_sites.len(),
        );
    }
}

/// Cheap byte-checksum used by the test for "byte slice unchanged"
/// invariants. Not a cryptographic hash; FNV-1a suffices for detecting
/// any in-place mutation.
fn simple_hash(bytes: &[u8]) -> u64 {
    let mut acc: u64 = 0xcbf29ce484222325;
    for byte in bytes {
        acc ^= u64::from(*byte);
        acc = acc.wrapping_mul(0x100000001b3);
    }
    acc
}
