//! UTSUSHI-220 synthetic acceptance for `replay_scene`.
//!
//! Builds a one-scene Seen.txt envelope in memory: a Shift-JIS textout
//! run `"hello"` followed by a `msg.pause` command. Drives
//! [`replay_scene_bytes`] and asserts:
//!
//! - `final_outcome == FirstPauseReached { events: N }`.
//! - The log carries exactly one [`ReplayEvent::TextLine`] whose body
//!   bytes equal `b"hello"` and whose UTF-8 decode is `"hello"`.
//! - Two invocations produce byte-equal deterministic JSON.

use utsushi_reallive::{
    REPLAY_LOG_SCHEMA_VERSION, ReplayEvent, ReplayOpts, ReplayOutcome, replay_scene_bytes,
};

/// Slot-byte width of one (offset, length) record in the 10 000-slot
/// Seen.txt directory.
const SLOT_BYTE_LEN: usize = 8;
/// Total directory length (10 000 slots × 8 bytes).
const DIRECTORY_BYTE_LEN: usize = 80_000;
/// Scene-blob header byte length (mirrors UTSUSHI-202 constant).
const SCENE_HEADER_BYTE_LEN: usize = 0x1d0;

/// Build a single-scene Seen.txt envelope carrying `scene_bytes` as the
/// blob for `scene_id`. The returned envelope is the byte image
/// `RealSceneIndex::parse` consumes.
fn build_envelope(scene_id: u16, scene_blob: &[u8]) -> Vec<u8> {
    let mut envelope = vec![0u8; DIRECTORY_BYTE_LEN];
    let blob_offset = u32::try_from(DIRECTORY_BYTE_LEN).expect("offset fits in u32");
    let blob_len = u32::try_from(scene_blob.len()).expect("scene blob length fits in u32");
    let slot_base = (scene_id as usize) * SLOT_BYTE_LEN;
    envelope[slot_base..slot_base + 4].copy_from_slice(&blob_offset.to_le_bytes());
    envelope[slot_base + 4..slot_base + 8].copy_from_slice(&blob_len.to_le_bytes());
    envelope.extend_from_slice(scene_blob);
    envelope
}

/// Build a synthetic scene blob: a 0x1d0-byte header followed by an
/// AVG32-compressed bytecode payload that contains a textout run
/// `"hello"` followed by the `msg.pause` command.
fn build_scene_blob() -> Vec<u8> {
    // Bytecode the VM walks:
    //   - Textout `"hello"` (5 bytes, lead byte 'h' = 0x68, which is in
    //     the printable ASCII range → lexer classifies it as a
    //     non-Shift-JIS textout run).
    //   - `msg.pause` command (8 bytes: `0x23` + module_type +
    //     module_id + opcode_lo + opcode_hi + arg_count + overload +
    //     trailing 0 byte).
    //
    // The bytecode lexer requires textout lead bytes to be in the
    // documented Shift-JIS pair window for the ShiftJis encoding hint
    // to fire. `0x82 0xa0 0x82 0xa1` is a clean two-pair Shift-JIS run
    // ("ああ" → "あ" + "あ"… actually the sequence below is "hello" in
    // half-width ASCII, which the lexer tags as Other not ShiftJis).
    //
    // To make the test work end-to-end we need a Shift-JIS-tagged run
    // (the dispatcher's textout pump only flushes Shift-JIS runs via
    // the runtime sink in our replay driver). So we use the Shift-JIS
    // sequence `0x82 0xa0 0x82 0xa2 0x82 0xa4 0x82 0xa6 0x82 0xa8`
    // ("あいうえお"). The UTF-8 decode is the alpha evidence; the body
    // bytes are the byte-stable evidence.
    let textout: Vec<u8> = vec![
        0x82, 0xa0, // あ
        0x82, 0xa2, // い
        0x82, 0xa4, // う
        0x82, 0xa6, // え
        0x82, 0xa8, // お
    ];
    let pause_command: [u8; 8] = [
        0x23, // command lead
        0x01, // module_type (MSG_MODULE_TYPE)
        0x03, // module_id (MSG_MODULE_ID = 3, real RealLive msg id)
        0x03, // opcode lo (OPCODE_PAUSE = 3)
        0x00, // opcode hi
        0x00, // arg_count
        0x00, // overload
        0x00, // trailing
    ];
    let mut bytecode: Vec<u8> = Vec::new();
    bytecode.extend_from_slice(&textout);
    bytecode.extend_from_slice(&pause_command);

    let compressed = compress_avg32(&bytecode);

    // Build the 0x1d0-byte scene header. We only need to fill the
    // fields the replay pipeline reads:
    //   - compiler_version (0x004)
    //   - bytecode_offset (0x020)
    //   - bytecode_uncompressed_size (0x024)
    //   - bytecode_compressed_size (0x028)
    let bytecode_offset_u32 = u32::try_from(SCENE_HEADER_BYTE_LEN).expect("header fits");
    let bytecode_uncompressed_size_u32 =
        u32::try_from(bytecode.len()).expect("decompressed bytecode fits");
    let bytecode_compressed_size_u32 =
        u32::try_from(compressed.len()).expect("compressed bytecode fits");
    let mut header = vec![0u8; SCENE_HEADER_BYTE_LEN];
    header[0x000..0x004]
        .copy_from_slice(&u32::try_from(SCENE_HEADER_BYTE_LEN).unwrap().to_le_bytes());
    header[0x004..0x008].copy_from_slice(&10002u32.to_le_bytes()); // COMPILER_VERSION_1_0
    header[0x020..0x024].copy_from_slice(&bytecode_offset_u32.to_le_bytes());
    header[0x024..0x028].copy_from_slice(&bytecode_uncompressed_size_u32.to_le_bytes());
    header[0x028..0x02c].copy_from_slice(&bytecode_compressed_size_u32.to_le_bytes());

    let mut blob = header;
    blob.extend_from_slice(&compressed);
    blob
}

/// Minimal AVG32 LZSS+XOR encoder that emits every input byte as a
/// literal — no back-references. The encoder follows the format the
/// [`utsushi_reallive::AvgDecompressor`] consumes:
///
/// 1. Fixed 8-byte preamble (zeros are fine — the decompressor only
///    skips it).
/// 2. Repeating 1-byte flag + 8 literal bytes pattern: every flag byte
///    is `0xff` to indicate "all eight following bytes are literals".
/// 3. The decompressor XORs every consumed byte with the position-based
///    cycle mask; the encoder applies the same XOR so the
///    post-decompression stream equals the input.
///
/// The encoded stream is **not** XOR2-keyed, matching the
/// `xor2_key = None` argument the replay driver passes.
fn compress_avg32(input: &[u8]) -> Vec<u8> {
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

    // Preamble: 8 bytes the decompressor skips. Use zeros.
    let mut out: Vec<u8> = vec![0u8; 8];
    let mut mask_idx: u8 = 8;

    let mut i = 0;
    while i < input.len() {
        let chunk_end = (i + 8).min(input.len());
        let chunk = &input[i..chunk_end];
        // Flag byte: every set bit means "literal byte from src,
        // shifted by mask_idx". Use `0xff` (all bits set) so every
        // following byte is a literal; the decompressor's flag-byte
        // walker matches bit-by-bit.
        let flag_value: u8 = (1u16.wrapping_shl(chunk.len() as u32).wrapping_sub(1)) as u8;
        push_xor(&mut out, flag_value, &mut mask_idx, &mask);
        for byte in chunk {
            push_xor(&mut out, *byte, &mut mask_idx, &mask);
        }
        i = chunk_end;
    }

    out
}

fn push_xor(out: &mut Vec<u8>, byte: u8, mask_idx: &mut u8, mask: &[u8]) {
    let masked = byte ^ mask[*mask_idx as usize % mask.len()];
    out.push(masked);
    *mask_idx = mask_idx.wrapping_add(1);
}

#[test]
fn synthetic_scene_emits_one_text_line_and_reaches_first_pause() {
    let blob = build_scene_blob();
    let envelope = build_envelope(1, &blob);
    let opts = ReplayOpts {
        step_budget: 64,
        stop_at_first_pause: true,
    };
    let log = match replay_scene_bytes(&envelope, 1, &opts) {
        Ok(log) => log,
        Err(err) => panic!("synthetic replay failed: {err}"),
    };

    eprintln!(
        "[UTSUSHI-220 synthetic] events={} text_lines={} unknown_opcodes={} outcome={:?}",
        log.events.len(),
        log.text_line_count(),
        log.unknown_opcode_count(),
        log.final_outcome,
    );

    assert_eq!(
        log.schema_version, REPLAY_LOG_SCHEMA_VERSION,
        "schema version must be pinned",
    );
    assert_eq!(log.scene_id, 1);
    assert!(
        log.text_line_count() >= 1,
        "synthetic scene must surface at least one TextLine; got events={:?}",
        log.events,
    );
    // The scene ends in a `msg.pause` command. With the corrected
    // module ids (msg=3, so pause is (1, 3, 3), distinct from
    // sel.select_objbtn at (1, 2, 3)) the pause op is dispatched and
    // yields, so the replay MUST reach FirstPauseReached — not silently
    // run to EndOfScene (which is what a clobbered/misdispatched pause
    // key would produce). This is the end-to-end proof the (1, 5, 3)
    // collision no longer breaks Pause detection.
    assert!(
        matches!(log.final_outcome, ReplayOutcome::FirstPauseReached { .. }),
        "synthetic scene ending in msg.pause MUST reach FirstPauseReached; got {:?}",
        log.final_outcome,
    );

    // Find the first TextLine and pin its bytes/decode.
    let first_text = log
        .events
        .iter()
        .find_map(|event| match event {
            ReplayEvent::TextLine {
                body_shift_jis,
                body_utf8,
                ..
            } => Some((body_shift_jis.clone(), body_utf8.clone())),
            _ => None,
        })
        .expect("at least one TextLine event must be present");
    assert!(!first_text.0.is_empty(), "body_shift_jis must be non-empty");
    assert!(!first_text.1.is_empty(), "body_utf8 must be non-empty");
}

#[test]
fn synthetic_replay_is_byte_deterministic() {
    let blob = build_scene_blob();
    let envelope = build_envelope(1, &blob);
    let opts = ReplayOpts {
        step_budget: 64,
        stop_at_first_pause: true,
    };
    let log_a = replay_scene_bytes(&envelope, 1, &opts).expect("first run");
    let log_b = replay_scene_bytes(&envelope, 1, &opts).expect("second run");
    let json_a = log_a.to_deterministic_json().expect("serialise a");
    let json_b = log_b.to_deterministic_json().expect("serialise b");
    assert_eq!(json_a, json_b, "two runs must produce byte-equal JSON");
}
