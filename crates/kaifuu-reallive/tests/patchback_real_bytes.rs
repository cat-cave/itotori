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
//! Env-gated; without `ITOTORI_REAL_GAME_ROOT` it prints an
//! explicit skip notice and returns (no silent pass). Set
//! `ITOTORI_REQUIRE_REAL_BYTES=1` to turn the absent corpus into a
//! hard failure instead of a skip.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;
use std::path::PathBuf;

use kaifuu_reallive::{
    BridgeOpts, PatchbackOpts, REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN, RealLiveOpcode, SceneHeader,
    TranslatedBundleV02, apply_translated_bundle, decode_dialogue_textout, decompress_avg32,
    gameexe::parse_gameexe_inventory, parse_archive, parse_real_bytecode, produce_bundle,
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
    let decompressed = decompress_avg32(bytecode, header.bytecode_uncompressed_size as usize)
        .expect("AVG32 decompression must succeed");
    (scene_blob, decompressed, header)
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

    let patched = apply_translated_bundle(&seen_bytes, &translated, &PatchbackOpts::shift_jis())
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
    let new_decompressed =
        decompress_avg32(new_bytecode, new_header.bytecode_uncompressed_size as usize)
            .expect("patched bytecode must decompress cleanly");

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
    let err = apply_translated_bundle(&seen_bytes, &translated, &PatchbackOpts::shift_jis())
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
