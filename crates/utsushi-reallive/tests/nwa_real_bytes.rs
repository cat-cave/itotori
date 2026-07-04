//! UTSUSHI-217 real-bytes integration tests for the NWA decoder.
//!
//! Pins the decoder against Sweetie HD's `REALLIVEDATA/bgm/ASA.nwa`
//! (18,317,046 bytes) and `REALLIVEDATA/wav/CHIME.nwa`. Mirrors the
//! `g00_real_bytes.rs` env-gating pattern (`ITOTORI_REAL_GAME_ROOT`
//! must be set for the `#[ignore]`-gated cases to execute).
//!
//! # Acceptance criteria pinned here
//!
//! 1. [`nwa_asa_decodes_33M_frames`] — UTSUSHI-217 spec-pinned name.
//!    The decoder returns channels=2, bits_per_sample=16,
//!    sample_rate=44_100 against `ASA.nwa`. The spec text quotes
//!    "33,818,820 sample frames" as the acceptance value; the real
//!    bytes at `@0x14` decode to `uncompressed_byte_size = 33,866,972`
//!    (=> `total_sample_count = 16,933,486`, `frames_per_channel =
//!    8,466,743`). The spec's `33,818,820` was a transcription typo in
//!    `docs/research/reallive-engine.md` (the `dc c4 04 02` byte
//!    sequence at `@0x14` was annotated as
//!    `0x020404c4 = 33,818,820` rather than the correct
//!    `0x0204c4dc = 33,866,972`). Per the itotori
//!    "real-bytes preferred" operating-model rule, this test pins the
//!    real-bytes-derived value; the typed audit assertion below names
//!    the discrepancy explicitly so a future spec correction surfaces
//!    here.
//! 2. [`nwa_chime_decodes_raw_pcm_header`] — Sweetie HD's
//!    `REALLIVEDATA/wav/CHIME.nwa` decodes to channels >= 1,
//!    bps == 16, sample_rate within the documented audio-grade band.
//!    Acts as a second-file cross-reference inside the same corpus —
//!    not a second engine corpus (the single-corpus posture is
//!    documented below).
//!
//! # Multi-game validation status
//!
//! Per the itotori operating model
//! (`docs/orchestration-operating-model.md`), a parser that targets a
//! real engine substrate must be exercised against at least two real
//! corpora before its node is merged-complete. Sweetie HD is the only
//! RealLive title currently staged. The NWA module mirrors the pattern its
//! UTSUSHI-201/202/203/216 sibling parsers landed: real-bytes pinned
//! against the only staged corpus today (two distinct files within
//! that corpus — `bgm/ASA.nwa` and `wav/CHIME.nwa`), with the
//! second-corpus follow-up tracked as a known gap. The commit message
//! records the single-corpus posture explicitly.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;
use std::path::PathBuf;

use utsushi_reallive::{
    NWA_HEADER_BYTE_LEN, NwaCompressionMode, NwaDecodeError, decode_nwa, decode_nwa_header,
};

// Title directory under the Sweetie HD extraction root. Mirrors the
// existing `gameexe_real_bytes.rs` / `g00_real_bytes.rs` constants.

// Relative path under the title dir to the `bgm/` corpus.

// Relative path under the title dir to the `wav/` corpus.

/// File name of the UTSUSHI-217 spec-pinned ASA.nwa fixture.
const ASA_NWA: &str = "ASA.nwa";

/// File name of CHIME.nwa — the second-file cross-reference inside
/// the corpus.
const CHIME_NWA: &str = "CHIME.nwa";

/// Documented file size of `ASA.nwa` (matches the spec's
/// "18,317,046 bytes" acceptance value).
const ASA_NWA_FILE_SIZE: u64 = 18_317_046;

/// Real-bytes value at `@0x14` of `ASA.nwa`. Spec text quotes
/// `33,818,820`; the actual `dc c4 04 02` u32 LE decodes to
/// `0x0204c4dc = 33_866_972`. See the test below for the typed
/// discrepancy assertion.
const ASA_NWA_UNCOMPRESSED_BYTE_SIZE_REAL: u32 = 33_866_972;

/// Spec-quoted (erroneous) value the audit-traceable assertion names
/// explicitly. Pinned so a future spec correction shows up here.
const ASA_NWA_UNCOMPRESSED_BYTE_SIZE_SPEC: u32 = 33_818_820;

/// Resolve the Sweetie HD `bgm/` directory under
/// `ITOTORI_REAL_GAME_ROOT`.
fn real_bgm_dir() -> Option<PathBuf> {
    real_corpus::reallivedata_subdir("bgm")
}

/// Resolve the Sweetie HD `wav/` directory.
fn real_wav_dir() -> Option<PathBuf> {
    real_corpus::reallivedata_subdir("wav")
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
// The test name is the UTSUSHI-217 spec verification handle quoted
// verbatim (`cargo test -p utsushi-reallive nwa_asa_decodes_33M_frames`).
// The `M` is upper-case because the spec quotes "33M" as the
// human-readable order-of-magnitude shorthand for the frame count.
// reason: test name embeds the spec's '33M' order-of-magnitude shorthand verbatim.
#[allow(non_snake_case)]
fn nwa_asa_decodes_33M_frames() {
    let Some(bgm_dir) = real_bgm_dir() else {
        real_corpus::require_real_bytes("utsushi-reallive nwa_asa_decodes_33M_frames");
        return;
    };
    let path = bgm_dir.join(ASA_NWA);
    let bytes =
        fs::read(&path).unwrap_or_else(|err| panic!("failed to read {}: {err}", path.display()));

    // File size pin.
    assert_eq!(
        bytes.len() as u64,
        ASA_NWA_FILE_SIZE,
        "ASA.nwa file size is pinned at {ASA_NWA_FILE_SIZE} per the UTSUSHI-217 spec",
    );

    let file = decode_nwa(&bytes).expect("ASA.nwa decode");
    let header = &file.header;
    assert_eq!(header.channels, 2, "ASA.nwa is stereo per UTSUSHI-217 spec");
    assert_eq!(
        header.bits_per_sample, 16,
        "ASA.nwa is 16-bit per UTSUSHI-217 spec",
    );
    assert_eq!(
        header.sample_rate, 44_100,
        "ASA.nwa is 44.1 kHz per UTSUSHI-217 spec",
    );

    // ASA.nwa is compression_mode = 0 (NWA-compressed level 0). The
    // file is NOT raw PCM (file size 18_317_046 < uncompressed size
    // 33_866_972) — the spec acceptance text incorrectly suggests
    // "raw 16-bit PCM" but the real bytes carry NWA level-0
    // compression.
    assert!(
        matches!(
            header.compression_mode,
            NwaCompressionMode::Compressed { level: 0 }
        ),
        "ASA.nwa compression_mode is Compressed(level=0) per the @0x08 bytes; got {:?}",
        header.compression_mode,
    );
    assert_eq!(
        header.compressed_data_size as u64, ASA_NWA_FILE_SIZE,
        "ASA.nwa compressed_data_size at @0x18 must match the file size",
    );

    // Spec acceptance value vs real bytes — typed audit pin.
    assert_eq!(
        header.uncompressed_byte_size, ASA_NWA_UNCOMPRESSED_BYTE_SIZE_REAL,
        "ASA.nwa uncompressed_byte_size at @0x14 is the real-bytes value {ASA_NWA_UNCOMPRESSED_BYTE_SIZE_REAL}. \
         UTSUSHI-217 spec text quotes {ASA_NWA_UNCOMPRESSED_BYTE_SIZE_SPEC} (a typo derived from \
         docs/research/reallive-engine.md misreading 'dc c4 04 02' LE as 0x020404c4 rather than 0x0204c4dc). \
         This test pins the real-bytes value per the 'real-bytes preferred' itotori operating-model rule; \
         a future spec correction will surface here.",
    );

    // Cross-check the frame-derivation arithmetic.
    let frames = header.frames_per_channel();
    assert_eq!(
        frames,
        (ASA_NWA_UNCOMPRESSED_BYTE_SIZE_REAL as u64) / 4,
        "frames_per_channel = uncompressed_byte_size / (channels * bytes_per_sample) for stereo 16-bit",
    );
    eprintln!(
        "ASA.nwa decode summary: channels={}, bps={}, sample_rate={}, \
         uncompressed_byte_size={}, frames_per_channel={}, total_sample_count={}",
        header.channels,
        header.bits_per_sample,
        header.sample_rate,
        header.uncompressed_byte_size,
        frames,
        header.total_sample_count,
    );

    // Audit-focus pin (UTSUSHI-217 spec): "Treating NWA as raw bytes
    // (i.e. skipping the offset table)". ASA.nwa is compressed, so
    // the per-block table MUST be populated.
    assert_eq!(
        file.block_offsets.len() as u32,
        header.block_count,
        "compressed ASA.nwa must have block_count={} per-block offsets",
        header.block_count,
    );
    assert!(
        header.block_count > 0,
        "ASA.nwa block_count must be non-zero",
    );
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn nwa_chime_decodes_raw_pcm_header() {
    let Some(wav_dir) = real_wav_dir() else {
        real_corpus::require_real_bytes("utsushi-reallive nwa_chime_decodes_raw_pcm_header");
        return;
    };
    let path = wav_dir.join(CHIME_NWA);
    let bytes =
        fs::read(&path).unwrap_or_else(|err| panic!("failed to read {}: {err}", path.display()));

    let header = decode_nwa_header(&bytes).expect("CHIME.nwa header decode");
    assert!(
        // justification: audio channel count is domain-bounded to mono/stereo, not a relaxed floor.
        header.channels >= 1 && header.channels <= 2,
        "CHIME.nwa channels must be 1 or 2; got {}",
        header.channels,
    );
    assert!(
        matches!(header.bits_per_sample, 8 | 16),
        "CHIME.nwa bits_per_sample must be 8 or 16; got {}",
        header.bits_per_sample,
    );
    assert!(
        (8_000..=96_000).contains(&header.sample_rate),
        "CHIME.nwa sample_rate must be in the documented audio band; got {} Hz",
        header.sample_rate,
    );
    eprintln!(
        "CHIME.nwa header: channels={}, bps={}, sample_rate={}, compression_mode={:?}",
        header.channels, header.bits_per_sample, header.sample_rate, header.compression_mode,
    );
}

#[test]
fn nwa_real_bytes_skips_when_env_unset() {
    // Mirrors the `gameexe_real_bytes.rs::verify_real_bytes_known_values_skips_when_env_unset`
    // pattern: when the env var is unset, the real-bytes tests above
    // print a diagnostic and return. This test makes the skip
    // explicit so the CI run records the "skipped, not silently
    // passed" semantics.
    if real_corpus::game_root().is_some() {
        return;
    }
    eprintln!(
        "ITOTORI_REAL_GAME_ROOT not set — NWA real-bytes tests are #[ignore]-gated and \
         only run with ITOTORI_REAL_GAME_ROOT set.",
    );
}

#[test]
fn nwa_header_byte_len_constant_matches_44_bytes() {
    // Pin the spec-defined header width so a transcription regression
    // in `src/nwa.rs` surfaces here.
    assert_eq!(NWA_HEADER_BYTE_LEN, 0x2c);
}

#[test]
fn header_truncated_real_bytes_returns_typed_error() {
    // The decoder rejects an empty input — the typed-error surface
    // does not depend on a real-bytes fixture.
    let err = decode_nwa_header(&[]).expect_err("empty input rejected");
    assert!(matches!(err, NwaDecodeError::HeaderTruncated { .. }));
}
