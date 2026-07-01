//! UTSUSHI-227 synthetic integration tests for
//! `validate_replay_contains` / `validate_log_contains`.
//!
//! Test bodies (all synthetic; no real bytes, no `Command::new`, no Wine):
//!
//! 1. **`synthetic_patched_seen_txt_replay_contains_sentinel`** —
//!    drives the validator on a one-scene synthetic envelope that
//!    embeds the en-US sentinel as the Textout body. Confirms the
//!    library API matches the binary's surface without needing the
//!    real bytes.
//!
//! 2. **`synthetic_unpatched_envelope_returns_no_match`** — the
//!    regression sentinel for the synthetic path. A synthetic envelope
//!    whose Textout body is NOT the sentinel returns `Ok(NoMatch)`.
//!
//! 3. **`synthetic_envelope_textline_event_is_observable`** — smoke:
//!    the synthetic envelope always produces at least one TextLine
//!    event.
//!
//! Linux-only: no `Command::new`, no Wine, no Windows helper.

// Hollow planted-sentinel proof removed; real replay/render evidence is delivered by the utsushi-real-runtime-evidence-no-sentinel node.

use utsushi_reallive::{
    ReplayEvent, ReplayOpts, ReplayValidation, replay_scene_bytes, validate_log_contains,
};

/// English-language sentinel embedded as the synthetic Textout body. The
/// leading `「` (SJIS `0x81 0x75`) is required so the KAIFUU-191 parser
/// recognises the run as a Textout opcode (ASCII leads classify as
/// `Unknown`).
///
/// The interior payload (`STELLA-ALPHA-EN-US-SENTINEL`) is the part the
/// validator's substring picker looks for. It is a synthetic ASCII string
/// (never real game text).
const EN_US_SENTINEL: &str = "「STELLA-ALPHA-EN-US-SENTINEL」";

/// The substring the validator's picker contracts on.
const EN_US_SENTINEL_SUBSTR: &str = "STELLA-ALPHA-EN-US-SENTINEL";

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
                    .is_some_and(|body| body.contains(EN_US_SENTINEL_SUBSTR))
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
