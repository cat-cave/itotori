//! UTSUSHI-227 real-bytes + synthetic integration test for
//! `validate_replay_contains`.
//!
//! Three test bodies:
//!
//! 1. **`patched_sweetie_hd_replay_contains_en_us_sentinel`** —
//!    env-gated on `KAIFUU_REAL_SWEETIE_HD_PATH`. Loads the real
//!    Sweetie HD `Seen.txt`, runs the KAIFUU-210 producer to build a
//!    v0.2 BridgeBundle, **synthesises** a translated bundle by
//!    replacing every unit's `target.text` with the en-US sentinel
//!    `"「STELLA-ALPHA-EN-US-SENTINEL」"`, applies
//!    [`kaifuu_reallive::apply_translated_bundle`] to write a patched
//!    `Seen.txt` to a tmp file, then asserts the four UTSUSHI-227
//!    acceptance criteria:
//!
//!    - `validate_replay_contains(patched, 1, "STELLA-ALPHA-EN-US-SENTINEL")`
//!      returns `Ok(Matched)`.
//!    - `validate_replay_contains(original, 1, "STELLA-ALPHA-EN-US-SENTINEL")`
//!      returns `Ok(NoMatch)` — **regression sentinel**. If the
//!      original also matches, the substring picker is broken.
//!    - Two invocations against the patched copy produce byte-equal
//!      `to_deterministic_json` output.
//!    - The serialised `ReplayLog` JSON contains at least one TextLine
//!      whose `bodyUtf8` field carries the sentinel substring.
//!
//! 2. **`synthetic_patched_seen_txt_replay_contains_sentinel`** —
//!    drives the validator on a one-scene synthetic envelope that
//!    embeds the en-US sentinel as the Textout body. Confirms the
//!    library API matches the binary's surface without needing the
//!    real bytes.
//!
//! 3. **`synthetic_unpatched_envelope_returns_no_match`** — the
//!    regression sentinel for the synthetic path. A synthetic envelope
//!    whose Textout body is NOT the sentinel returns `Ok(NoMatch)`.
//!
//! Linux-only: no `Command::new`, no Wine, no Windows helper.

use std::env;
use std::fs;
use std::path::PathBuf;

use kaifuu_reallive::{
    BridgeOpts, PatchbackOpts, RealLiveOpcode, SceneHeader, TranslatedBundleV02,
    apply_translated_bundle, decompress_avg32, gameexe::parse_gameexe_inventory, parse_archive,
    parse_real_bytecode, produce_bundle,
};
use utsushi_reallive::{
    ReplayEvent, ReplayOpts, ReplayValidation, replay_scene, replay_scene_bytes,
    validate_log_contains, validate_replay_contains,
};

/// Relative path under the Sweetie HD extraction root that holds the
/// raw `Seen.txt` envelope. Mirrors UTSUSHI-220's real-bytes test.
const SWEETIE_HD_SEEN_RELATIVE_PATH: &str =
    "オシオキSweetie＋Sweets!! HD_DL版/REALLIVEDATA/Seen.txt";
/// Relative path under the Sweetie HD extraction root that holds the
/// Gameexe.ini sidecar (used by the KAIFUU-210 producer for NAMAE
/// resolution).
const SWEETIE_HD_GAMEEXE_RELATIVE_PATH: &str =
    "オシオキSweetie＋Sweets!! HD_DL版/REALLIVEDATA/Gameexe.ini";

/// English-language sentinel used by the regression-sentinel
/// assertion. The leading `「` (SJIS `0x81 0x75`) is required so the
/// KAIFUU-191 parser recognises the run as a Textout opcode (ASCII
/// leads classify as `Unknown`); see the patchback real-bytes test for
/// the same convention.
///
/// The interior payload (`STELLA-ALPHA-EN-US-SENTINEL`) is the part the
/// validator's substring picker looks for. The string is intentionally
/// distinctive — every byte of it is ASCII, and the prefix `STELLA-`
/// does not appear in either Sweetie HD's ja-JP scene-1 text (which
/// is all Shift-JIS) or in any UTSUSHI-220 artefact.
const EN_US_SENTINEL: &str = "「STELLA-ALPHA-EN-US-SENTINEL」";

/// The substring the validator's picker contracts on. Stable across
/// the patched-copy match and the original-copy no-match arms.
const EN_US_SENTINEL_SUBSTR: &str = "STELLA-ALPHA-EN-US-SENTINEL";

fn sweetie_hd_seen_txt_path() -> Option<PathBuf> {
    let root = env::var_os("KAIFUU_REAL_SWEETIE_HD_PATH")?;
    Some(PathBuf::from(root).join(SWEETIE_HD_SEEN_RELATIVE_PATH))
}

fn sweetie_hd_gameexe_path() -> Option<PathBuf> {
    let root = env::var_os("KAIFUU_REAL_SWEETIE_HD_PATH")?;
    Some(PathBuf::from(root).join(SWEETIE_HD_GAMEEXE_RELATIVE_PATH))
}

/// Build a patched `Seen.txt` whose scene 1 carries the en-US
/// sentinel in every Textout body. Returns the patched bytes.
fn patch_sweetie_hd_with_sentinel(seen_bytes: &[u8]) -> Vec<u8> {
    let index = parse_archive(seen_bytes).expect("real Seen.txt envelope must parse");
    let entry = index
        .entries
        .iter()
        .find(|entry| entry.scene_id == 1)
        .expect("scene 1 must exist in the directory");
    let blob_start = entry.byte_offset as usize;
    let blob_end = blob_start + entry.byte_len as usize;
    let scene_blob = &seen_bytes[blob_start..blob_end];

    let header = SceneHeader::parse(scene_blob).expect("scene header must parse");
    let bytecode = &scene_blob[header.bytecode_offset as usize
        ..(header.bytecode_offset + header.bytecode_compressed_size) as usize];
    let decompressed = decompress_avg32(bytecode, header.bytecode_uncompressed_size as usize)
        .expect("AVG32 decompression must succeed");

    let gameexe_bytes = sweetie_hd_gameexe_path()
        .and_then(|path| fs::read(path).ok())
        .unwrap_or_default();
    let gameexe_inventory = parse_gameexe_inventory(&gameexe_bytes);

    let opts = BridgeOpts {
        game_id: "sweetie-hd",
        game_version: "1.0.0",
        source_profile_id: "kaifuu-reallive-sweetie-hd",
        source_locale: "ja-JP",
        scene_blob_file_offset: entry.byte_offset,
        extractor_name: "kaifuu-reallive-bridge",
        extractor_version: "0.1.0",
        scene_kidoku_count: header.kidoku_count,
    };
    let produced = produce_bundle(1, scene_blob, &decompressed, &gameexe_inventory, &opts)
        .expect("v0.2 bundle must build from real Sweetie HD scene 1");

    let mut translated_value = produced.json.clone();
    {
        let units = translated_value["units"]
            .as_array_mut()
            .expect("units must be a JSON array");
        for unit in units.iter_mut() {
            unit["target"] = serde_json::json!({
                "locale": "en-US",
                "text": EN_US_SENTINEL,
            });
        }
    }
    let translated =
        TranslatedBundleV02::from_json(&translated_value).expect("translated bundle parses");
    apply_translated_bundle(seen_bytes, &translated, &PatchbackOpts::shift_jis())
        .expect("apply_translated_bundle must succeed on Sweetie HD scene 1")
}

#[test]
#[ignore = "real-bytes; requires KAIFUU_REAL_SWEETIE_HD_PATH env var"]
fn patched_sweetie_hd_replay_contains_en_us_sentinel() {
    let Some(seen_path) = sweetie_hd_seen_txt_path() else {
        eprintln!(
            "KAIFUU_REAL_SWEETIE_HD_PATH unset; skipping UTSUSHI-227 real-bytes Sweetie HD \
             patched-replay validation (no silent pass: re-run with \
             KAIFUU_REAL_SWEETIE_HD_PATH=/scratch/itotori-research/sweetie-hd/extracted)",
        );
        return;
    };

    let seen_bytes = fs::read(&seen_path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", seen_path.display()));

    // Sanity: the original copy must NOT contain the sentinel — that
    // is the regression-sentinel contract. Re-walking the original
    // decompressed bytecode and confirming the sentinel is absent
    // BEFORE we run the validator catches a broken substring picker
    // earlier than the validator's NoMatch arm would.
    let index = parse_archive(&seen_bytes).expect("envelope parses");
    let entry = index
        .entries
        .iter()
        .find(|entry| entry.scene_id == 1)
        .expect("scene 1");
    let blob_start = entry.byte_offset as usize;
    let blob_end = blob_start + entry.byte_len as usize;
    let scene_blob = &seen_bytes[blob_start..blob_end];
    let header = SceneHeader::parse(scene_blob).expect("scene header");
    let bytecode = &scene_blob[header.bytecode_offset as usize
        ..(header.bytecode_offset + header.bytecode_compressed_size) as usize];
    let decompressed =
        decompress_avg32(bytecode, header.bytecode_uncompressed_size as usize).expect("decompress");
    let opcodes = parse_real_bytecode(&decompressed).expect("parse bytecode");
    let mut original_textout_count = 0usize;
    for op in &opcodes {
        if let RealLiveOpcode::Textout { raw_bytes, .. } = op {
            original_textout_count += 1;
            let (decoded, _, _) = encoding_rs::SHIFT_JIS.decode(raw_bytes);
            assert!(
                !decoded.contains(EN_US_SENTINEL_SUBSTR),
                "regression-sentinel precondition: the substring {EN_US_SENTINEL_SUBSTR:?} \
                 MUST NOT appear in the original Sweetie HD scene-1 Textout bytes (this would \
                 mean the substring picker is matching pre-existing bytes)"
            );
        }
    }
    eprintln!(
        "[UTSUSHI-227 real-bytes] precondition: original scene-1 has {original_textout_count} \
         Textout opcodes and none carry the sentinel substring"
    );

    // Write the patched Seen.txt to a tmp file so the validator's
    // path-based API gets exercised end-to-end.
    let tmp_dir = env::temp_dir().join(format!(
        "utsushi-reallive-utsushi-227-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&tmp_dir);
    fs::create_dir_all(&tmp_dir).expect("mkdir tmp");
    let patched_path = tmp_dir.join("Seen.txt");
    let patched_bytes = patch_sweetie_hd_with_sentinel(&seen_bytes);
    fs::write(&patched_path, &patched_bytes).expect("write patched Seen.txt");

    eprintln!(
        "[UTSUSHI-227 real-bytes] patched archive: source={} bytes, patched={} bytes (ratio={:.3})",
        seen_bytes.len(),
        patched_bytes.len(),
        (patched_bytes.len() as f64) / (seen_bytes.len() as f64),
    );

    // ---- Acceptance #0: validator matches on the patched copy. ----
    let validation = validate_replay_contains(&patched_path, 1, EN_US_SENTINEL_SUBSTR)
        .expect("validate patched");
    match &validation {
        ReplayValidation::Matched {
            matching_event_index,
            body_utf8,
        } => {
            eprintln!(
                "[UTSUSHI-227 real-bytes] alpha-evidence: patched copy MATCHED \
                 event_index={matching_event_index} body_utf8={body_utf8:?}"
            );
            assert!(
                body_utf8.contains(EN_US_SENTINEL_SUBSTR),
                "Matched body_utf8 must contain the sentinel"
            );
        }
        ReplayValidation::NoMatch {
            textline_count,
            sample_bodies,
        } => {
            panic!(
                "real-bytes acceptance #0: patched copy MUST match the sentinel; got NoMatch \
                 with textline_count={textline_count} and {sample_count} sample bodies: \
                 {sample_bodies:?}",
                sample_count = sample_bodies.len(),
            );
        }
    }

    // ---- Acceptance #1: regression sentinel — original NoMatch. ----
    let original_validation =
        validate_replay_contains(&seen_path, 1, EN_US_SENTINEL_SUBSTR).expect("validate original");
    match &original_validation {
        ReplayValidation::NoMatch {
            textline_count,
            sample_bodies,
        } => {
            eprintln!(
                "[UTSUSHI-227 real-bytes] regression sentinel: original copy NoMatch \
                 textline_count={textline_count} sample_count={}",
                sample_bodies.len()
            );
            assert!(
                *textline_count > 0,
                "original Sweetie HD scene-1 replay should still produce at least one TextLine; \
                 a zero-count NoMatch would mean the VM never reached text, which is a \
                 UTSUSHI-220 regression"
            );
        }
        ReplayValidation::Matched {
            matching_event_index,
            body_utf8,
        } => {
            panic!(
                "real-bytes acceptance #1 (regression sentinel): original UNPATCHED copy MUST \
                 NOT match the sentinel {EN_US_SENTINEL_SUBSTR:?}; got Matched at \
                 event_index={matching_event_index} body_utf8={body_utf8:?}. This means the \
                 substring picker is matching pre-existing bytes — the test is broken."
            );
        }
    }

    // ---- Acceptance #2: deterministic JSON across two runs. ----
    let opts = ReplayOpts::default();
    let log_a = replay_scene(&patched_path, 1, &opts).expect("first replay");
    let log_b = replay_scene(&patched_path, 1, &opts).expect("second replay");
    let json_a = log_a.to_deterministic_json().expect("serialise a");
    let json_b = log_b.to_deterministic_json().expect("serialise b");
    eprintln!(
        "[UTSUSHI-227 real-bytes] determinism: json_a.len()={} json_b.len()={}",
        json_a.len(),
        json_b.len()
    );
    assert_eq!(
        json_a, json_b,
        "real-bytes acceptance #2: two replays of the patched Seen.txt MUST produce byte-equal \
         deterministic JSON",
    );

    // ---- Acceptance #3: JSON inspection — at least one TextLine
    //     event's bodyUtf8 field contains the substring. ----
    let parsed: serde_json::Value =
        serde_json::from_str(&json_a).expect("ReplayLog JSON parses back");
    let events = parsed
        .get("events")
        .and_then(|value| value.as_array())
        .expect("ReplayLog JSON has events array");
    let matching_textline_count = events
        .iter()
        .filter(|event| {
            event.get("kind").and_then(|kind| kind.as_str()) == Some("text_line")
                && event
                    .get("bodyUtf8")
                    .and_then(|body| body.as_str())
                    .map(|body| body.contains(EN_US_SENTINEL_SUBSTR))
                    .unwrap_or(false)
        })
        .count();
    eprintln!(
        "[UTSUSHI-227 real-bytes] JSON inspection: {matching_textline_count} TextLine event(s) \
         have bodyUtf8 containing the sentinel substring"
    );
    assert!(
        matching_textline_count >= 1,
        "real-bytes acceptance #3: at least one TextLine event's bodyUtf8 field must contain \
         the substring {EN_US_SENTINEL_SUBSTR:?}; got 0 of {total_events} events",
        total_events = events.len(),
    );

    let _ = fs::remove_dir_all(&tmp_dir);
}

/// Slot-byte width of one (offset, length) record in the 10 000-slot
/// Seen.txt directory. Mirrors `tests/replay_scene_synthetic.rs`.
const SLOT_BYTE_LEN: usize = 8;
/// Total directory length (10 000 slots × 8 bytes).
const DIRECTORY_BYTE_LEN: usize = 80_000;
/// Scene-blob header byte length (mirrors UTSUSHI-202 constant).
const SCENE_HEADER_BYTE_LEN: usize = 0x1d0;

/// Build a one-scene Seen.txt envelope whose decompressed bytecode is
/// `bytecode_payload`. Used by the synthetic tests below.
fn build_synthetic_envelope(scene_id: u16, bytecode_payload: &[u8]) -> Vec<u8> {
    let compressed = compress_avg32_literal(bytecode_payload);
    let mut header = vec![0u8; SCENE_HEADER_BYTE_LEN];
    header[0x000..0x004]
        .copy_from_slice(&u32::try_from(SCENE_HEADER_BYTE_LEN).unwrap().to_le_bytes());
    header[0x004..0x008].copy_from_slice(&10002u32.to_le_bytes()); // COMPILER_VERSION_1_0
    header[0x020..0x024]
        .copy_from_slice(&u32::try_from(SCENE_HEADER_BYTE_LEN).unwrap().to_le_bytes());
    header[0x024..0x028]
        .copy_from_slice(&u32::try_from(bytecode_payload.len()).unwrap().to_le_bytes());
    header[0x028..0x02c].copy_from_slice(&u32::try_from(compressed.len()).unwrap().to_le_bytes());

    let mut blob = header;
    blob.extend_from_slice(&compressed);

    let mut envelope = vec![0u8; DIRECTORY_BYTE_LEN];
    let blob_offset = u32::try_from(DIRECTORY_BYTE_LEN).expect("offset fits");
    let blob_len = u32::try_from(blob.len()).expect("len fits");
    let slot_base = (scene_id as usize) * SLOT_BYTE_LEN;
    envelope[slot_base..slot_base + 4].copy_from_slice(&blob_offset.to_le_bytes());
    envelope[slot_base + 4..slot_base + 8].copy_from_slice(&blob_len.to_le_bytes());
    envelope.extend_from_slice(&blob);
    envelope
}

/// Build a synthetic bytecode payload that emits `textout_bytes` as a
/// Shift-JIS Textout then halts with a `msg.pause` command. The
/// returned bytes are NOT compressed — feed them to
/// [`build_synthetic_envelope`] which compresses them with the literal
/// AVG32 encoder.
fn build_textout_then_pause(textout_bytes: &[u8]) -> Vec<u8> {
    let pause_command: [u8; 8] = [
        0x23, // command lead
        0x01, // MSG_MODULE_TYPE
        0x05, // MSG_MODULE_ID
        0x03, // OPCODE_PAUSE
        0x00, 0x00, 0x00, 0x00,
    ];
    let mut bytecode: Vec<u8> = Vec::new();
    bytecode.extend_from_slice(textout_bytes);
    bytecode.extend_from_slice(&pause_command);
    bytecode
}

/// Minimal AVG32 LZSS+XOR encoder that emits every input byte as a
/// literal — copied verbatim from `tests/replay_scene_synthetic.rs`.
/// Re-exporting it would couple the two integration tests; the helper
/// is small enough that duplicating it is the lower-coupling choice.
fn compress_avg32_literal(input: &[u8]) -> Vec<u8> {
    let mask = [
        0x8B, 0xE5, 0x5D, 0xC3, 0xA1, 0xE0, 0x30, 0x44, 0x00, 0x85, 0xC0, 0x74, 0x09, 0x5F, 0x5E,
        0x33, 0xC0, 0x5B, 0x8B, 0xE5, 0x5D, 0xC3, 0x8B, 0x45, 0x0C, 0x85, 0xC0, 0x75, 0x14, 0x8B,
        0x55, 0xEC, 0x83, 0xC2, 0x20, 0x52, 0x6A, 0x00, 0xE8, 0xF5, 0x28, 0x01, 0x00, 0x83, 0xC4,
        0x08, 0x89, 0x45, 0x0C, 0x8B, 0x45, 0xE4, 0x6A, 0x00, 0x6A, 0x00, 0x50, 0xFF, 0x75, 0x0C,
        0xE8, 0x71, 0xC4, 0x01, 0x00, 0x83, 0xC4, 0x10, 0x89, 0x45, 0xE0, 0x8B, 0x45, 0xB8, 0xA3,
        0x00, 0x00, 0x00, 0x00, 0x8B, 0x45, 0x0C, 0x50, 0xE8, 0x55, 0x28, 0x01, 0x00, 0x83, 0xC4,
        0x04, 0x8B, 0x55, 0xEC, 0x8B, 0x45, 0xE0, 0xA3, 0x00, 0x00, 0x00, 0x00, 0x8B, 0x45, 0xF0,
        0x8B, 0x40, 0x10, 0x8B, 0x4D, 0xF0, 0x83, 0xC1, 0x10, 0x51, 0x52, 0x50, 0xE8, 0xDE, 0xFC,
        0xFF, 0xFF, 0x83, 0xC4, 0x0C, 0xEB, 0x24, 0x6A, 0xFF, 0xFF, 0x75, 0xE4, 0x8B, 0x45, 0xF0,
        0x8B, 0x40, 0x10, 0x83, 0xC0, 0x10, 0x50, 0x68, 0x44, 0x0E, 0x42, 0x00, 0xFF, 0x75, 0x08,
        0xE8, 0x4F, 0x16, 0x00, 0x00, 0x83, 0xC4, 0x10, 0x89, 0x45, 0xF4, 0x8B, 0x45, 0xF4, 0x5F,
        0x5E, 0x5B, 0x8B, 0xE5, 0x5D, 0xC3, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC,
        0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0x55, 0x8B, 0xEC, 0x83, 0xEC, 0x10, 0x53, 0x56,
        0x57, 0x33, 0xFF, 0x33, 0xDB, 0x33, 0xF6, 0x39, 0x7D, 0x10, 0x76, 0x6C, 0x8B, 0x45, 0x0C,
        0x03, 0xC7, 0x33, 0xC9, 0x8A, 0x08, 0xC1, 0xE9, 0x05, 0x8B, 0x55, 0x08, 0x03, 0xD3, 0x8A,
        0x0C, 0x0A, 0x8B, 0x55, 0x0C, 0x03, 0xD7, 0x32, 0x0A, 0x88, 0x0A, 0x43, 0x83, 0xFB, 0x10,
        0x75, 0x05, 0x33, 0xDB, 0xFF, 0x45, 0xF8,
    ];
    let mut out: Vec<u8> = vec![0u8; 8];
    let mut mask_idx: u8 = 8;
    let mut i = 0;
    while i < input.len() {
        let chunk_end = (i + 8).min(input.len());
        let chunk = &input[i..chunk_end];
        let flag_value: u8 = (1u16.wrapping_shl(chunk.len() as u32).wrapping_sub(1)) as u8;
        let masked_flag = flag_value ^ mask[mask_idx as usize % mask.len()];
        out.push(masked_flag);
        mask_idx = mask_idx.wrapping_add(1);
        for byte in chunk {
            let masked = byte ^ mask[mask_idx as usize % mask.len()];
            out.push(masked);
            mask_idx = mask_idx.wrapping_add(1);
        }
        i = chunk_end;
    }
    out
}

#[test]
fn synthetic_patched_seen_txt_replay_contains_sentinel() {
    // Encode the sentinel as SJIS and embed it as a Textout body.
    let (sjis_payload, _, had_errors) = encoding_rs::SHIFT_JIS.encode(EN_US_SENTINEL);
    assert!(
        !had_errors,
        "sentinel must encode cleanly as SJIS for the synthetic test"
    );
    let bytecode = build_textout_then_pause(&sjis_payload);
    let envelope = build_synthetic_envelope(1, &bytecode);

    let opts = ReplayOpts {
        step_budget: 64,
        stop_at_first_pause: true,
    };
    let log = replay_scene_bytes(&envelope, 1, &opts).expect("synthetic replay");
    let validation = validate_log_contains(&log, EN_US_SENTINEL_SUBSTR);
    match validation {
        ReplayValidation::Matched {
            matching_event_index,
            body_utf8,
        } => {
            eprintln!(
                "[UTSUSHI-227 synthetic] MATCHED event_index={matching_event_index} \
                 body_utf8={body_utf8:?}"
            );
            assert!(body_utf8.contains(EN_US_SENTINEL_SUBSTR));
        }
        ReplayValidation::NoMatch {
            textline_count,
            sample_bodies,
        } => {
            panic!(
                "synthetic replay must match the sentinel; got NoMatch \
                 textline_count={textline_count} samples={sample_bodies:?}"
            );
        }
    }

    // Acceptance #2 mirror: synthetic determinism (preserved from
    // UTSUSHI-220 — re-asserted here because the validator's behaviour
    // depends on it).
    let log_a = replay_scene_bytes(&envelope, 1, &opts).expect("first synthetic replay");
    let log_b = replay_scene_bytes(&envelope, 1, &opts).expect("second synthetic replay");
    let json_a = log_a.to_deterministic_json().expect("serialise a");
    let json_b = log_b.to_deterministic_json().expect("serialise b");
    assert_eq!(json_a, json_b);

    // Acceptance #3 mirror: at least one TextLine's bodyUtf8 contains
    // the substring (direct JSON inspection).
    let parsed: serde_json::Value = serde_json::from_str(&json_a).expect("parse JSON");
    let events = parsed
        .get("events")
        .and_then(|value| value.as_array())
        .expect("events array");
    let matching = events
        .iter()
        .filter(|event| {
            event.get("kind").and_then(|kind| kind.as_str()) == Some("text_line")
                && event
                    .get("bodyUtf8")
                    .and_then(|body| body.as_str())
                    .map(|body| body.contains(EN_US_SENTINEL_SUBSTR))
                    .unwrap_or(false)
        })
        .count();
    assert!(
        matching >= 1,
        "JSON inspection: at least one TextLine event must carry the sentinel"
    );
}

#[test]
fn synthetic_unpatched_envelope_returns_no_match() {
    // Build an envelope whose textout is a Shift-JIS body that does
    // NOT contain the sentinel.
    let (sjis_payload, _, _) = encoding_rs::SHIFT_JIS.encode("あいうえお");
    let bytecode = build_textout_then_pause(&sjis_payload);
    let envelope = build_synthetic_envelope(1, &bytecode);
    let opts = ReplayOpts {
        step_budget: 64,
        stop_at_first_pause: true,
    };
    let log = replay_scene_bytes(&envelope, 1, &opts).expect("synthetic replay");
    let validation = validate_log_contains(&log, EN_US_SENTINEL_SUBSTR);
    match validation {
        ReplayValidation::NoMatch {
            textline_count,
            sample_bodies,
        } => {
            assert!(
                textline_count >= 1,
                "synthetic envelope should still produce at least one TextLine"
            );
            assert!(
                !sample_bodies
                    .iter()
                    .any(|body| body.contains(EN_US_SENTINEL_SUBSTR)),
                "no sample body should contain the sentinel"
            );
        }
        ReplayValidation::Matched {
            matching_event_index,
            body_utf8,
        } => {
            panic!(
                "synthetic unpatched envelope must NOT match the sentinel; got Matched at \
                 event_index={matching_event_index} body_utf8={body_utf8:?}"
            );
        }
    }
}

#[test]
fn synthetic_envelope_textline_event_is_observable() {
    // Smoke: the synthetic envelope produces at least one TextLine
    // event regardless of substring. Guards against a regression
    // where the runtime's flush path silently swallows the textout.
    let (sjis_payload, _, _) = encoding_rs::SHIFT_JIS.encode(EN_US_SENTINEL);
    let bytecode = build_textout_then_pause(&sjis_payload);
    let envelope = build_synthetic_envelope(1, &bytecode);
    let opts = ReplayOpts {
        step_budget: 64,
        stop_at_first_pause: true,
    };
    let log = replay_scene_bytes(&envelope, 1, &opts).expect("synthetic replay");
    let textline_count = log
        .events
        .iter()
        .filter(|event| matches!(event, ReplayEvent::TextLine { .. }))
        .count();
    assert!(
        textline_count >= 1,
        "synthetic envelope must produce at least one TextLine event; got {textline_count}"
    );
}
