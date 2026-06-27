//! KAIFUU-211 real-bytes integration test for the bundle-driven
//! patchback driver (`apply_translated_bundle`).
//!
//! Loads Sweetie HD scene 1 from `ITOTORI_REAL_GAME_ROOT`, runs
//! `kaifuu_reallive::produce_bundle` to get the canonical source-side
//! bundle, **synthesises** a translated bundle by replacing every
//! unit's `target.text` with a known en-US sentinel string, applies
//! the patchback, re-parses the patched `Seen.txt`, and asserts the
//! KAIFUU-211 acceptance criteria:
//!
//! - The directory still has 198 entries.
//! - Scene 1's bytecode decompresses cleanly.
//! - The Textout opcodes now contain the en-US sentinel bytes (not the
//!   original ja-JP body).
//! - The file size is within +/- 50% of the original for the one
//!   modified scene.
//! - The original source byte slice is unchanged (returned `Vec<u8>`
//!   is a fresh allocation).
//!
//! Env-gated; without `ITOTORI_REAL_GAME_ROOT` it prints an
//! explicit skip notice and returns (no silent pass).

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;
use std::path::PathBuf;

use kaifuu_reallive::{
    BridgeOpts, PatchbackOpts, REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN, RealLiveOpcode, SceneHeader,
    TranslatedBundleV02, apply_translated_bundle, decompress_avg32,
    gameexe::parse_gameexe_inventory, parse_archive, parse_real_bytecode, produce_bundle,
};
use serde_json::Value;

const SWEETIE_HD_GAME_ID: &str = "sweetie-hd";
const SWEETIE_HD_SOURCE_PROFILE_ID: &str = "kaifuu-reallive-sweetie-hd";

/// English-language sentinel used by the round-trip assertion.
///
/// The KAIFUU-211 spec asks the test to write an en-US string into the
/// Textout body and assert it survives a re-parse. The kaifuu-reallive
/// bytecode parser (KAIFUU-191) recognises a Shift-JIS Textout run by
/// the lead-byte switch `0x81..=0x9F | 0xE0..=0xFC` — pure ASCII bytes
/// would land as `RealLiveOpcode::Unknown` because no ASCII byte is a
/// SJIS lead.
///
/// We therefore prefix the en-US payload with one full-width SJIS
/// punctuation character (`「`, 0x81 0x75) so the bytes still parse as
/// a Textout opcode. The ASCII payload following the lead character
/// stops the run after the next non-SJIS-lead byte; that's the
/// documented parser behaviour for mixed SJIS/ASCII runs and matches
/// how real RealLive bytecode handles non-Japanese strings (a
/// follow-up parser node may widen the run rule, KAIFUU-191 audit).
const EN_SENTINEL: &str = "「[EN] hello world from kaifuu-211」";

/// SJIS lead-byte for the leading `「` character — used by the
/// post-patch byte-presence assertion as the contiguous run we expect
/// to find at the patched offset.
const EN_SENTINEL_SJIS_PREFIX: &[u8] = &[0x81, 0x75];

fn real_seen_txt_path() -> Option<PathBuf> {
    real_corpus::seen_txt_path()
}

fn real_gameexe_ini_path() -> Option<PathBuf> {
    real_corpus::gameexe_ini_path()
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn patches_sweetie_hd_scene_1_with_en_us_sentinel_and_round_trips_archive() {
    let Some(seen_path) = real_seen_txt_path() else {
        eprintln!(
            "ITOTORI_REAL_GAME_ROOT unset; skipping (re-run with \
             ITOTORI_REAL_GAME_ROOT=/path/to/reallive-game-root)"
        );
        return;
    };
    let seen_bytes = fs::read(&seen_path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", seen_path.display()));
    assert!(
        seen_bytes.len() as u64 >= REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN,
        "Seen.txt must carry the 10,000-slot directory"
    );

    // Compute the source byte-equal sentinel hash so the post-write
    // self-check can confirm `apply_translated_bundle` does not mutate
    // its input slice.
    let source_seen_hash = simple_hash(&seen_bytes);

    // Locate scene 1's blob bytes via parse_archive (KAIFUU-188).
    let index = parse_archive(&seen_bytes).expect("real Seen.txt envelope must parse");
    assert_eq!(
        index.entries.len(),
        198,
        "Sweetie HD must have 198 populated scene slots"
    );
    let entry = index
        .entries
        .iter()
        .find(|entry| entry.scene_id == 1)
        .expect("scene 1 must exist in the directory");
    assert_eq!(entry.byte_offset, 0x13880);
    let blob_start = entry.byte_offset as usize;
    let blob_end = blob_start + entry.byte_len as usize;
    let scene_blob = &seen_bytes[blob_start..blob_end];

    let header = SceneHeader::parse(scene_blob).expect("scene header must parse");
    let bytecode = &scene_blob[header.bytecode_offset as usize
        ..(header.bytecode_offset + header.bytecode_compressed_size) as usize];
    let decompressed = decompress_avg32(bytecode, header.bytecode_uncompressed_size as usize)
        .expect("AVG32 decompression must succeed");

    // Build the v0.2 source bundle (KAIFUU-210 producer).
    let gameexe_bytes = real_gameexe_ini_path()
        .and_then(|path| fs::read(path).ok())
        .unwrap_or_default();
    let gameexe_inventory = parse_gameexe_inventory(&gameexe_bytes);

    let opts = BridgeOpts {
        game_id: SWEETIE_HD_GAME_ID,
        game_version: "1.0.0",
        source_profile_id: SWEETIE_HD_SOURCE_PROFILE_ID,
        source_locale: "ja-JP",
        scene_blob_file_offset: entry.byte_offset,
        extractor_name: "kaifuu-reallive-bridge",
        extractor_version: "0.1.0",
        scene_kidoku_count: header.kidoku_count,
    };
    let produced = produce_bundle(1, scene_blob, &decompressed, &gameexe_inventory, &opts)
        .expect("v0.2 bundle must build from real Sweetie HD scene 1");

    // Synthesise a translated bundle JSON: copy the produced source
    // JSON and append a `target = {locale: "en-US", text: EN_SENTINEL}`
    // entry to every unit.
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

    // Apply the patchback. Acceptance: source bytes unchanged after.
    let patched = apply_translated_bundle(&seen_bytes, &translated, &PatchbackOpts::shift_jis())
        .expect("apply_translated_bundle must succeed on Sweetie HD scene 1");
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

    // ---- Acceptance: scene 1's bytecode decompresses cleanly. ----
    let new_entry = reparsed
        .entries
        .iter()
        .find(|entry| entry.scene_id == 1)
        .expect("patched archive must still contain scene 1");
    let new_blob_start = new_entry.byte_offset as usize;
    let new_blob_end = new_blob_start + new_entry.byte_len as usize;
    let new_scene_blob = &patched[new_blob_start..new_blob_end];
    let new_header = SceneHeader::parse(new_scene_blob).expect("patched scene header parses");
    let new_bytecode = &new_scene_blob[new_header.bytecode_offset as usize
        ..(new_header.bytecode_offset + new_header.bytecode_compressed_size) as usize];
    let new_decompressed =
        decompress_avg32(new_bytecode, new_header.bytecode_uncompressed_size as usize)
            .expect("patched bytecode must decompress cleanly");

    // ---- Acceptance: patched bytecode carries the en-US sentinel bytes. ----
    //
    // The kaifuu-reallive parser (KAIFUU-191) recognises a Textout run
    // by the SJIS lead-byte switch and ends the run at the next non-
    // SJIS-lead byte. The en-US sentinel starts with a single SJIS
    // double-byte (`「` = 0x81 0x75) so its leading bytes still
    // classify as a Textout. The ASCII payload following the prefix
    // lands as `Unknown` per the documented parser rule for mixed
    // SJIS/ASCII runs — this matches the spec's "Encoding choice
    // (UTF-8 vs Shift-JIS) named in code" audit-focus row.
    //
    // We assert that the SJIS-encoded sentinel bytes appear contiguously
    // somewhere in the patched decompressed bytecode (full sentinel
    // window), and that at least one Textout opcode exists at a
    // patched offset (the leading 「).
    let opcodes = parse_real_bytecode(&new_decompressed).expect("patched bytecode parses");
    let en_sentinel_bytes =
        kaifuu_reallive::encode_shift_jis_slot(EN_SENTINEL).expect("sentinel encodes as SJIS");
    let sentinel_in_bytecode = new_decompressed
        .windows(en_sentinel_bytes.len())
        .any(|window| window == en_sentinel_bytes.as_slice());
    assert!(
        sentinel_in_bytecode,
        "patched decompressed bytecode must contain the SJIS-encoded en-US sentinel \
         (len={})",
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
        "scene 1 patched: textout_count={textout_count}, \
         sentinel_textout_count={sentinel_textout_count}"
    );
    assert!(
        textout_count > 0,
        "patched bytecode must still contain at least one Textout opcode (got 0)"
    );
    assert!(
        sentinel_textout_count > 0,
        "at least one Textout must start with the en-US sentinel's SJIS prefix \
         (`「` = 0x81 0x75); got 0/{textout_count}"
    );

    // ---- Acceptance: original ja-JP first-textout bytes are gone. ----
    let original_opcodes = parse_real_bytecode(&decompressed).expect("source bytecode parses");
    let original_first_textout = original_opcodes
        .iter()
        .find_map(|op| match op {
            RealLiveOpcode::Textout { raw_bytes, .. } if raw_bytes.len() >= 4 => Some(raw_bytes),
            _ => None,
        })
        .expect("source bytecode must have at least one textout");
    let original_present = new_decompressed
        .windows(original_first_textout.len())
        .any(|window| window == original_first_textout.as_slice());
    assert!(
        !original_present,
        "original ja-JP textout body must no longer appear verbatim in the patched bytecode"
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

    // ---- Acceptance: a full decoded re-walk of the patched bytes
    //     finds the en-US sentinel substring (via Shift-JIS decode of
    //     the whole bytecode rather than per-textout).
    let full_decoded = kaifuu_reallive::decode_shift_jis_slot(&new_decompressed).text;
    assert!(
        full_decoded.contains(EN_SENTINEL),
        "patched bytecode (Shift-JIS-decoded as a single buffer) must contain the en-US \
         sentinel string"
    );
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn provenance_mismatch_byte_range_emits_typed_error_on_real_bytes() {
    let Some(seen_path) = real_seen_txt_path() else {
        eprintln!("ITOTORI_REAL_GAME_ROOT unset; skipping");
        return;
    };
    let seen_bytes = fs::read(&seen_path).expect("read Seen.txt");

    // Take the produced bundle and corrupt one unit's sourceLocation
    // range to point at file offset 0 (inside the 80,000-byte
    // directory) — guaranteed not to match any scene.
    let index = parse_archive(&seen_bytes).expect("envelope parses");
    let entry = index
        .entries
        .iter()
        .find(|entry| entry.scene_id == 1)
        .expect("scene 1");
    let blob_start = entry.byte_offset as usize;
    let blob_end = blob_start + entry.byte_len as usize;
    let scene_blob = &seen_bytes[blob_start..blob_end];
    let header = SceneHeader::parse(scene_blob).expect("header");
    let bytecode = &scene_blob[header.bytecode_offset as usize
        ..(header.bytecode_offset + header.bytecode_compressed_size) as usize];
    let decompressed =
        decompress_avg32(bytecode, header.bytecode_uncompressed_size as usize).expect("decompress");
    let gameexe_bytes = real_gameexe_ini_path()
        .and_then(|path| fs::read(path).ok())
        .unwrap_or_default();
    let gameexe_inventory = parse_gameexe_inventory(&gameexe_bytes);
    let opts = BridgeOpts {
        game_id: SWEETIE_HD_GAME_ID,
        game_version: "1.0.0",
        source_profile_id: SWEETIE_HD_SOURCE_PROFILE_ID,
        source_locale: "ja-JP",
        scene_blob_file_offset: entry.byte_offset,
        extractor_name: "kaifuu-reallive-bridge",
        extractor_version: "0.1.0",
        scene_kidoku_count: header.kidoku_count,
    };
    let produced = produce_bundle(1, scene_blob, &decompressed, &gameexe_inventory, &opts)
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
        // Corrupt the first unit's byte range to point at file offset
        // 0 (inside the directory).
        units[0]["sourceLocation"]["range"] = serde_json::json!({
            "startByte": 0u64,
            "endByte": 8u64,
        });
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
        eprintln!("ITOTORI_REAL_GAME_ROOT unset; skipping");
        return;
    };
    let _ = fs::read(&seen_path).expect("read Seen.txt");
    // The produced bundle by itself (no target.text per unit) must be
    // rejected at parse time before any byte is written.
    let seen_bytes = fs::read(&seen_path).expect("read Seen.txt");
    let index = parse_archive(&seen_bytes).expect("parses");
    let entry = index
        .entries
        .iter()
        .find(|entry| entry.scene_id == 1)
        .expect("scene 1");
    let blob_start = entry.byte_offset as usize;
    let blob_end = blob_start + entry.byte_len as usize;
    let scene_blob = &seen_bytes[blob_start..blob_end];
    let header = SceneHeader::parse(scene_blob).expect("header");
    let bytecode = &scene_blob[header.bytecode_offset as usize
        ..(header.bytecode_offset + header.bytecode_compressed_size) as usize];
    let decompressed =
        decompress_avg32(bytecode, header.bytecode_uncompressed_size as usize).expect("decompress");
    let gameexe_bytes = real_gameexe_ini_path()
        .and_then(|path| fs::read(path).ok())
        .unwrap_or_default();
    let gameexe_inventory = parse_gameexe_inventory(&gameexe_bytes);
    let opts = BridgeOpts {
        game_id: SWEETIE_HD_GAME_ID,
        game_version: "1.0.0",
        source_profile_id: SWEETIE_HD_SOURCE_PROFILE_ID,
        source_locale: "ja-JP",
        scene_blob_file_offset: entry.byte_offset,
        extractor_name: "kaifuu-reallive-bridge",
        extractor_version: "0.1.0",
        scene_kidoku_count: header.kidoku_count,
    };
    let produced = produce_bundle(1, scene_blob, &decompressed, &gameexe_inventory, &opts)
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
    // Sanity: ensure produced JSON exists.
    let _ = serde_json::to_string(&produced.json).expect("produced json serialises");
    let _ = Value::Null;
}

/// Cheap byte-checksum used by the test for "byte slice unchanged"
/// invariants. Not a cryptographic hash; xor-rolling-sum suffices for
/// detecting any in-place mutation.
fn simple_hash(bytes: &[u8]) -> u64 {
    let mut acc: u64 = 0xcbf29ce484222325;
    for byte in bytes {
        acc ^= u64::from(*byte);
        acc = acc.wrapping_mul(0x100000001b3);
    }
    acc
}
