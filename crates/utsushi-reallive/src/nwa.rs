//! RealLive `.nwa` BGM / SE container decoder.
//!
//! Decodes the NWA on-disk layout the Sweetie HD `REALLIVEDATA/bgm/`
//! corpus (28 files) and `REALLIVEDATA/wav/` corpus (73 files) ship.
//! Per the spec acceptance criterion, the decoder verifies
//! header decode and reports the typed `(channels, bps, sample_rate
//! sample_count,...)` shape — actual PCM mixing is **not** required.
//!
//! # On-disk layout (44-byte header)
//!
//! After byte-level probing of Sweetie HD's `bgm/ASA.nwa` and
//! `wav/CHIME.nwa` under `docs/research/reallive-engine.md` § ".nwa
//! (BGM / SE)", the header is 44 bytes wide:
//!
//! ```text
//! @0x00 u16 channels (=2 for ASA.nwa)
//! @0x02 u16 bits_per_sample (=16)
//! @0x04 u32 sample_rate (=44100 / 0x0000AC44)
//! @0x08 i32 compression_mode (-1 = raw PCM, 0..=5 = NWA-compressed
//!                              level n; ASA.nwa = 0)
//! @0x0c u32 use_runlength (0 = no run-length wrapping)
//! @0x10 u32 block_count (ASA.nwa = 33,074)
//! @0x14 u32 uncompressed_byte_size (raw PCM data size, in bytes)
//! @0x18 u32 compressed_data_size (file size minus header bytes)
//! @0x1c u32 total_sample_count (= uncompressed_byte_size / (bps/8))
//! @0x20 u32 samples_per_block (samples-per-channel per block)
//! @0x24 u32 last_block_sample_count (samples in the final, possibly
//!                                      short, block)
//! @0x28 u32 reserved_or_unknown (observed as 0 in Sweetie HD)
//! ```
//!
//! After the header, a **per-block offset table** of `block_count`
//! u32 LE entries describes the start byte of each compressed block
//! (relative to the file). The PCM blocks follow. For
//! `compression_mode = -1` (true raw PCM) the offset table is empty and
//! the PCM begins immediately after the header. For `compression_mode
//! >= 0`, the blocks carry the NWA compression scheme (variable bit
//! sample deltas, optionally run-length wrapped per the
//! `use_runlength` flag).
//!
//! # Spec acceptance vs. real bytes
//!
//! The spec acceptance text pins
//! "decoder returns 33,818,820 sample frames at 44,100 Hz, 16-bit
//! 2-channel" for `bgm/ASA.nwa`. The real bytes at `@0x1c` of ASA.nwa
//! decode to `total_sample_count = 16,933,486` (= `uncompressed_byte_size
//! 2` = `33,866,972 / 2`), which is one per-channel sample value at
//! every frame. The spec's "33,818,820" was a transcription typo
//! (`docs/research/reallive-engine.md` `@0x14` annotated the byte
//! sequence `dc c4 04 02` as `0x020404c4 = 33,818,820` rather than the
//! correct `0x0204c4dc = 33,866,972`). Per the itotori operating-model
//! rule "real-bytes preferred", the real-bytes integration test in
//! `tests/nwa_real_bytes.rs` pins the actual byte-derived values; the
//! discrepancy is recorded in a typed audit comment there. The spec
//! verification handle (`nwa_asa_decodes_33M_frames`) remains the
//! test name so the spec-pinned `cargo test` invocation resolves.
//!
//! # Clean-room provenance
//!
//! The header layout above was re-derived from the byte sequences
//! `xxd -l 64 ASA.nwa` shows, cross-referenced against the public-format
//! commentary in `docs/research/reallive-engine.md` § ".nwa". rlvm
//! (`https://github.com/eglaysher/rlvm`) is a **research anchor only**;
//! no rlvm source is vendored, linked, or mechanically translated. See
//! [`crate::RLVM_RESEARCH_ANCHOR_BOUNDARY_STATEMENT`].

use serde::{Deserialize, Serialize};

/// Width of the NWA header in bytes (`0x2c`).
pub const NWA_HEADER_BYTE_LEN: usize = 0x2c;

/// Sentinel `compression_mode` value indicating the file carries raw
/// 16-bit PCM data with no NWA compression. The signed-i32 `-1` value
/// is the convention the public xclannad notes pin.
pub const NWA_COMPRESSION_MODE_RAW_PCM: i32 = -1;

/// Maximum NWA compression mode value documented by the public
/// xclannad / rlvm references. Any value outside `-1..=5` is rejected
/// as out-of-profile.
pub const NWA_COMPRESSION_MODE_MAX: i32 = 5;

/// Stable diagnostic codes [`NwaDecodeError`] uses.
pub const NWA_HEADER_TRUNCATED_CODE: &str = "utsushi.reallive.nwa.header_truncated";
pub const NWA_UNSUPPORTED_CHANNELS_CODE: &str = "utsushi.reallive.nwa.unsupported_channels";
pub const NWA_UNSUPPORTED_BPS_CODE: &str = "utsushi.reallive.nwa.unsupported_bps";
pub const NWA_OUT_OF_PROFILE_COMPRESSION_CODE: &str =
    "utsushi.reallive.nwa.out_of_profile_compression";

/// Typed errors surfaced by [`decode_nwa_header`].
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NwaDecodeError {
    /// The byte slice is shorter than [`NWA_HEADER_BYTE_LEN`].
    #[error("nwa file truncated: need {needed} bytes for header, got {actual} ({code})")]
    HeaderTruncated {
        code: String,
        needed: usize,
        actual: usize,
    },
    /// The `channels` field is `0`, which would imply a zero-frame
    /// stream. The decoder refuses to silently emit a degenerate frame
    /// count.
    #[error("nwa header carries unsupported channels = {channels} ({code})")]
    UnsupportedChannels { code: String, channels: u16 },
    /// The `bits_per_sample` field is neither `8` nor `16`. Sweetie HD
    /// ships exclusively 16-bit PCM; the decoder rejects any other
    /// width up-front so a wrong-width interpretation cannot silently
    /// land at the sample-frame computation.
    #[error("nwa header carries unsupported bits_per_sample = {bps} ({code})")]
    UnsupportedBitsPerSample { code: String, bps: u16 },
    /// The `compression_mode` field is outside the documented
    /// `-1..=5` range.
    #[error(
        "nwa header carries out-of-profile compression_mode = {mode} (expected -1..=5) ({code})"
    )]
    OutOfProfileCompression { code: String, mode: i32 },
}

/// Typed `compression_mode` enum.
///
/// Per the public format docs, `-1` is the raw-PCM sentinel; `0..=5`
/// are the NWA-compressed levels. Sweetie HD's `bgm/ASA.nwa` carries
/// `compression_mode = 0` (level-0 NWA compression). The actual sample
/// decompression for `Compressed {.. }` is **not** implemented in
/// (the spec says "decoder verifies header decode and emits
/// metadata") — the typed variant is the surface a later work can
/// extend without changing the file format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum NwaCompressionMode {
    /// Raw 16-bit (or 8-bit) PCM. No per-block compression; the file
    /// body after the header is the raw PCM stream.
    RawPcm,
    /// NWA-compressed level `level` (`0..=5`). The per-block table
    /// describes the start byte of each compressed block; the
    /// per-block decompression is a follow-up.
    Compressed {
        /// Compression level `0..=5`.
        level: u8,
    },
}

impl NwaCompressionMode {
    /// Decode the i32 wire field into a typed variant.
    pub fn from_wire(value: i32) -> Result<Self, NwaDecodeError> {
        match value {
            NWA_COMPRESSION_MODE_RAW_PCM => Ok(NwaCompressionMode::RawPcm),
            level if (0..=NWA_COMPRESSION_MODE_MAX).contains(&level) => {
                Ok(NwaCompressionMode::Compressed { level: level as u8 })
            }
            _ => Err(NwaDecodeError::OutOfProfileCompression {
                code: NWA_OUT_OF_PROFILE_COMPRESSION_CODE.to_string(),
                mode: value,
            }),
        }
    }

    /// Inverse of [`Self::from_wire`].
    pub fn to_wire(self) -> i32 {
        match self {
            NwaCompressionMode::RawPcm => NWA_COMPRESSION_MODE_RAW_PCM,
            NwaCompressionMode::Compressed { level } => level as i32,
        }
    }
}

/// Decoded NWA header. Fields are laid out in the on-disk byte order.
///
/// `total_sample_count` is the engineering quantity downstream callers
/// (mixers, sample-frame computations) reach for. For a stereo file the
/// per-channel sample frame count is `total_sample_count / channels`;
/// for a mono file the two are equal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NwaHeader {
    /// `@0x00` — number of audio channels (`1` for mono, `2` for
    /// stereo). The decoder rejects `0`.
    pub channels: u16,
    /// `@0x02` — bits per sample (`8` or `16`). The decoder rejects
    /// any other width.
    pub bits_per_sample: u16,
    /// `@0x04` — sample rate, Hz (e.g. `44_100` for ASA.nwa).
    pub sample_rate: u32,
    /// `@0x08` — typed compression mode (raw PCM or compressed level).
    pub compression_mode: NwaCompressionMode,
    /// `@0x0c` — `1` if blocks are wrapped in run-length encoding, `0`
    /// otherwise. Sweetie HD's ASA.nwa carries `0`.
    pub use_runlength: u32,
    /// `@0x10` — number of compressed blocks (= `0x8132` for ASA.nwa).
    pub block_count: u32,
    /// `@0x14` — uncompressed PCM byte size (= 33,866,972 for ASA.nwa
    /// — see the module docstring for the spec-vs-real-bytes
    /// discrepancy note).
    pub uncompressed_byte_size: u32,
    /// `@0x18` — compressed data size in bytes (= 18,317,046 for
    /// ASA.nwa, matching the on-disk file size).
    pub compressed_data_size: u32,
    /// `@0x1c` — total int16 (or int8) sample count, across all
    /// channels (= 16,933,486 for ASA.nwa). For a stereo file the
    /// per-channel sample frame count is `total_sample_count
    /// channels`.
    pub total_sample_count: u32,
    /// `@0x20` — samples per block (per channel).
    pub samples_per_block: u32,
    /// `@0x24` — samples in the final (potentially short) block.
    pub last_block_sample_count: u32,
}

impl NwaHeader {
    /// Per-channel frame count derived from
    /// `uncompressed_byte_size / (bytes_per_sample * channels)`. Wraps
    /// the arithmetic at `u64` so a multi-hour file can't overflow.
    pub fn frames_per_channel(&self) -> u64 {
        let bytes_per_sample = (self.bits_per_sample as u64).div_ceil(8);
        let denom = bytes_per_sample.saturating_mul(self.channels as u64);
        if denom == 0 {
            return 0;
        }
        (self.uncompressed_byte_size as u64) / denom
    }

    /// Total sample count across all channels, mirroring the
    /// `total_sample_count` wire field as a `u64` (so downstream
    /// callers don't have to keep widening).
    pub fn total_samples(&self) -> u64 {
        self.total_sample_count as u64
    }
}

/// Decode the 44-byte NWA header from `bytes`.
///
/// The decoder validates `channels != 0`, `bits_per_sample in {8, 16}`
/// and `compression_mode in -1..=5`. Every other field is recorded
/// verbatim — a wrong-looking `block_count` would surface at the
/// caller's sample-frame computation, not as a hard decoder error.
pub fn decode_nwa_header(bytes: &[u8]) -> Result<NwaHeader, NwaDecodeError> {
    if bytes.len() < NWA_HEADER_BYTE_LEN {
        return Err(NwaDecodeError::HeaderTruncated {
            code: NWA_HEADER_TRUNCATED_CODE.to_string(),
            needed: NWA_HEADER_BYTE_LEN,
            actual: bytes.len(),
        });
    }
    let channels = u16_le(bytes, 0x00);
    let bits_per_sample = u16_le(bytes, 0x02);
    let sample_rate = u32_le(bytes, 0x04);
    let compression_mode_wire = i32_le(bytes, 0x08);
    let use_runlength = u32_le(bytes, 0x0c);
    let block_count = u32_le(bytes, 0x10);
    let uncompressed_byte_size = u32_le(bytes, 0x14);
    let compressed_data_size = u32_le(bytes, 0x18);
    let total_sample_count = u32_le(bytes, 0x1c);
    let samples_per_block = u32_le(bytes, 0x20);
    let last_block_sample_count = u32_le(bytes, 0x24);

    if channels == 0 {
        return Err(NwaDecodeError::UnsupportedChannels {
            code: NWA_UNSUPPORTED_CHANNELS_CODE.to_string(),
            channels,
        });
    }
    if !matches!(bits_per_sample, 8 | 16) {
        return Err(NwaDecodeError::UnsupportedBitsPerSample {
            code: NWA_UNSUPPORTED_BPS_CODE.to_string(),
            bps: bits_per_sample,
        });
    }
    let compression_mode = NwaCompressionMode::from_wire(compression_mode_wire)?;

    Ok(NwaHeader {
        channels,
        bits_per_sample,
        sample_rate,
        compression_mode,
        use_runlength,
        block_count,
        uncompressed_byte_size,
        compressed_data_size,
        total_sample_count,
        samples_per_block,
        last_block_sample_count,
    })
}

/// Decoded NWA file: header plus an optional borrowed view into the
/// per-block offset table (when present).
///
/// The struct is borrowed-from-input: the per-block table view points
/// into the slice passed to [`decode_nwa`]. Owners who need a `'static`
/// view can call [`NwaFile::into_owned`].
#[derive(Debug, Clone)]
pub struct NwaFile<'a> {
    /// Decoded header.
    pub header: NwaHeader,
    /// Per-block byte offsets (one u32 per block) for the compressed
    /// variants. Empty for [`NwaCompressionMode::RawPcm`].
    pub block_offsets: Vec<u32>,
    /// Borrowed view of the entire file bytes — useful for downstream
    /// callers that want to decode the PCM payload themselves. The
    /// header is the prefix; the per-block table follows; the PCM
    /// compressed payload tails it.
    pub bytes: &'a [u8],
}

impl<'a> NwaFile<'a> {
    /// Byte offset (from file start) where the per-block table ends
    /// and the PCM / compressed payload begins.
    pub fn payload_start(&self) -> usize {
        NWA_HEADER_BYTE_LEN + self.block_offsets.len() * std::mem::size_of::<u32>()
    }

    /// Borrow the PCM / compressed payload. Returns the slice tail
    /// starting at [`Self::payload_start`].
    pub fn payload(&self) -> &'a [u8] {
        let start = self.payload_start().min(self.bytes.len());
        &self.bytes[start..]
    }
}

/// Length in bytes of the per-block offset table for the given block
/// count.
pub fn nwa_block_table_byte_len(block_count: u32) -> usize {
    (block_count as usize).saturating_mul(std::mem::size_of::<u32>())
}

/// Decode the full NWA container.
///
/// For raw-PCM files the per-block table is empty and the payload
/// starts at `@0x2c`. For compressed files the per-block table is read
/// into a `Vec<u32>` and the payload starts at
/// `@0x2c + block_count * 4`.
pub fn decode_nwa(bytes: &[u8]) -> Result<NwaFile<'_>, NwaDecodeError> {
    let header = decode_nwa_header(bytes)?;
    let block_offsets = match header.compression_mode {
        NwaCompressionMode::RawPcm => Vec::new(),
        NwaCompressionMode::Compressed { .. } => {
            let table_len = nwa_block_table_byte_len(header.block_count);
            let table_start = NWA_HEADER_BYTE_LEN;
            let table_end = table_start.saturating_add(table_len);
            if bytes.len() < table_end {
                // The per-block table is truncated. Surface the same
                // diagnostic the header-truncated path uses, naming
                // the typed code so callers can grep without scraping
                // `Display`.
                return Err(NwaDecodeError::HeaderTruncated {
                    code: NWA_HEADER_TRUNCATED_CODE.to_string(),
                    needed: table_end,
                    actual: bytes.len(),
                });
            }
            let table_bytes = &bytes[table_start..table_end];
            let mut offsets = Vec::with_capacity(header.block_count as usize);
            for chunk in table_bytes.chunks_exact(std::mem::size_of::<u32>()) {
                offsets.push(u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
            }
            offsets
        }
    };
    Ok(NwaFile {
        header,
        block_offsets,
        bytes,
    })
}

#[inline]
fn u16_le(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
}

#[inline]
fn u32_le(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}

#[inline]
fn i32_le(bytes: &[u8], offset: usize) -> i32 {
    i32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Synthesise a 44-byte NWA header with the given field values.
    /// Used by the unit tests that pin the field-offset / typed-error
    /// surface without needing real bytes on disk. The 11-arg arity
    /// matches the on-disk field count one-for-one; a struct wrapper
    /// would add a layer of indirection the tests would have to read
    /// past.
    // reason: test-only synthetic NWA header builder; each argument is a distinct header field the tests set explicitly.
    #[allow(clippy::too_many_arguments)]
    fn synth_header(
        channels: u16,
        bps: u16,
        sample_rate: u32,
        compression_mode: i32,
        use_runlength: u32,
        block_count: u32,
        uncompressed_byte_size: u32,
        compressed_data_size: u32,
        total_sample_count: u32,
        samples_per_block: u32,
        last_block_sample_count: u32,
    ) -> Vec<u8> {
        let mut bytes = vec![0u8; NWA_HEADER_BYTE_LEN];
        bytes[0x00..0x02].copy_from_slice(&channels.to_le_bytes());
        bytes[0x02..0x04].copy_from_slice(&bps.to_le_bytes());
        bytes[0x04..0x08].copy_from_slice(&sample_rate.to_le_bytes());
        bytes[0x08..0x0c].copy_from_slice(&compression_mode.to_le_bytes());
        bytes[0x0c..0x10].copy_from_slice(&use_runlength.to_le_bytes());
        bytes[0x10..0x14].copy_from_slice(&block_count.to_le_bytes());
        bytes[0x14..0x18].copy_from_slice(&uncompressed_byte_size.to_le_bytes());
        bytes[0x18..0x1c].copy_from_slice(&compressed_data_size.to_le_bytes());
        bytes[0x1c..0x20].copy_from_slice(&total_sample_count.to_le_bytes());
        bytes[0x20..0x24].copy_from_slice(&samples_per_block.to_le_bytes());
        bytes[0x24..0x28].copy_from_slice(&last_block_sample_count.to_le_bytes());
        bytes
    }

    #[test]
    fn header_truncated_returns_typed_error() {
        let bytes = vec![0u8; NWA_HEADER_BYTE_LEN - 1];
        let err = decode_nwa_header(&bytes).expect_err("short input rejected");
        match err {
            NwaDecodeError::HeaderTruncated {
                code,
                needed,
                actual,
            } => {
                assert_eq!(code, NWA_HEADER_TRUNCATED_CODE);
                assert_eq!(needed, NWA_HEADER_BYTE_LEN);
                assert_eq!(actual, NWA_HEADER_BYTE_LEN - 1);
            }
            other => panic!("expected HeaderTruncated, got {other:?}"),
        }
    }

    #[test]
    fn zero_channels_returns_typed_error() {
        let bytes = synth_header(0, 16, 44_100, -1, 0, 0, 0, 0, 0, 0, 0);
        let err = decode_nwa_header(&bytes).expect_err("zero channels rejected");
        assert!(matches!(
            err,
            NwaDecodeError::UnsupportedChannels { channels: 0, .. }
        ));
    }

    #[test]
    fn unsupported_bps_returns_typed_error() {
        let bytes = synth_header(2, 24, 44_100, -1, 0, 0, 0, 0, 0, 0, 0);
        let err = decode_nwa_header(&bytes).expect_err("24-bit rejected");
        assert!(matches!(
            err,
            NwaDecodeError::UnsupportedBitsPerSample { bps: 24, .. }
        ));
    }

    #[test]
    fn out_of_profile_compression_returns_typed_error() {
        let bytes = synth_header(2, 16, 44_100, 99, 0, 0, 0, 0, 0, 0, 0);
        let err = decode_nwa_header(&bytes).expect_err("mode 99 rejected");
        assert!(matches!(
            err,
            NwaDecodeError::OutOfProfileCompression { mode: 99, .. }
        ));
    }

    #[test]
    fn raw_pcm_round_trips_typed_fields() {
        let bytes = synth_header(2, 16, 44_100, -1, 0, 0, 1024, 1024, 512, 0, 0);
        let header = decode_nwa_header(&bytes).expect("decode");
        assert_eq!(header.channels, 2);
        assert_eq!(header.bits_per_sample, 16);
        assert_eq!(header.sample_rate, 44_100);
        assert_eq!(header.compression_mode, NwaCompressionMode::RawPcm);
        assert_eq!(header.total_sample_count, 512);
    }

    #[test]
    fn compressed_level0_round_trips_typed_fields() {
        let bytes = synth_header(2, 16, 44_100, 0, 0, 4, 65_536, 4_096, 16_384, 4_096, 4_096);
        let header = decode_nwa_header(&bytes).expect("decode");
        assert_eq!(
            header.compression_mode,
            NwaCompressionMode::Compressed { level: 0 }
        );
        assert_eq!(header.block_count, 4);
    }

    #[test]
    fn compression_mode_to_wire_round_trips() {
        for mode in [
            NwaCompressionMode::RawPcm,
            NwaCompressionMode::Compressed { level: 0 },
            NwaCompressionMode::Compressed { level: 5 },
        ] {
            let wire = mode.to_wire();
            let round = NwaCompressionMode::from_wire(wire).expect("round trip");
            assert_eq!(round, mode);
        }
    }

    #[test]
    fn decode_nwa_raw_pcm_has_empty_block_table_and_payload_starts_after_header() {
        let mut bytes = synth_header(2, 16, 44_100, -1, 0, 0, 8, 8, 4, 0, 0);
        bytes.extend_from_slice(&[0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]);
        let file = decode_nwa(&bytes).expect("decode");
        assert!(file.block_offsets.is_empty());
        assert_eq!(file.payload_start(), NWA_HEADER_BYTE_LEN);
        assert_eq!(
            file.payload(),
            &[0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]
        );
    }

    #[test]
    fn decode_nwa_compressed_decodes_block_table() {
        let mut bytes = synth_header(2, 16, 44_100, 0, 0, 3, 6_144, 4_096, 1_536, 512, 512);
        // Per-block offsets: 0x40, 0x80, 0xC0.
        bytes.extend_from_slice(&0x40u32.to_le_bytes());
        bytes.extend_from_slice(&0x80u32.to_le_bytes());
        bytes.extend_from_slice(&0xC0u32.to_le_bytes());
        bytes.extend_from_slice(&[0xAA, 0xBB, 0xCC]); // pretend payload
        let file = decode_nwa(&bytes).expect("decode");
        assert_eq!(file.block_offsets, vec![0x40, 0x80, 0xC0]);
        assert_eq!(file.payload_start(), NWA_HEADER_BYTE_LEN + 3 * 4);
        assert_eq!(file.payload(), &[0xAA, 0xBB, 0xCC]);
    }

    #[test]
    fn decode_nwa_compressed_with_truncated_block_table_returns_typed_error() {
        let mut bytes = synth_header(2, 16, 44_100, 0, 0, 4, 0, 0, 0, 0, 0);
        // Only 8 bytes of the 16-byte table.
        bytes.extend_from_slice(&[0u8; 8]);
        let err = decode_nwa(&bytes).expect_err("truncated table rejected");
        assert!(matches!(err, NwaDecodeError::HeaderTruncated { .. }));
    }

    #[test]
    fn frames_per_channel_uses_bytes_per_sample_and_channels() {
        let bytes = synth_header(2, 16, 44_100, -1, 0, 0, 16, 16, 8, 0, 0);
        let header = decode_nwa_header(&bytes).expect("decode");
        // 16 uncompressed_byte_size / (2 bytes/sample * 2 channels) = 4
        // frames per channel.
        assert_eq!(header.frames_per_channel(), 4);
    }

    #[test]
    fn audit_focus_raw_pcm_path_does_not_skip_offset_table_when_compression_active() {
        // Audit-focus pin : "Treating NWA as raw
        // bytes (i.e. skipping the offset table)". When the compression
        // mode is `Compressed`, the decoder MUST read the per-block
        // table. We pin the surface by checking the payload-start
        // accessor advances past the table.
        let mut bytes = synth_header(2, 16, 44_100, 0, 0, 2, 0, 0, 0, 0, 0);
        bytes.extend_from_slice(&0x40u32.to_le_bytes());
        bytes.extend_from_slice(&0x80u32.to_le_bytes());
        let file = decode_nwa(&bytes).expect("decode");
        assert_eq!(
            file.payload_start(),
            NWA_HEADER_BYTE_LEN + 2 * std::mem::size_of::<u32>(),
            "compressed mode MUST advance the payload-start cursor past the per-block table",
        );
    }
}
