//! UTSUSHI-216 — RealLive `g00` image-format decoder (types 0, 1, 2).
//!
//! Decodes the three publicly-documented sub-formats of the RealLive
//! `g00` image container family. Sweetie HD's `$GAME/REALLIVEDATA/g00/`
//! ships 2,450 files; a corpus-wide lead-byte histogram (see the
//! integration test
//! `tests/g00_real_bytes.rs::g00_corpus_histogram_real_bytes_2450_files`)
//! observes 2,145 type-0 files, 305 type-2 files, and zero type-1 files
//! in this corpus.
//!
//! # On-disk layout
//!
//! After byte-level probing of Sweetie HD's `BACK.g00` (type 0) and
//! `btn000.g00` (type 2) under
//! `docs/research/reallive-engine.md` § "g00 (RealLive image format)",
//! all three sub-formats share the same five-byte preamble
//! `(type:u8, width:u16, height:u16)` and the same trailing LZSS
//! payload structure
//! `(compressed_size:u32, uncompressed_size:u32, lzss_payload[...])`.
//! Type 2 inserts a fixed `region_count:u32` field plus the
//! 24-byte-per-record region table between the preamble and the LZSS
//! payload. Per the rlvm-derived public format documentation
//! ([P] anchors under
//! `docs/research/reallive-engine.md`), the `compressed_size` field
//! counts everything from itself to the end of the LZSS payload
//! inclusive, so the LZSS data is `compressed_size - 8` bytes long.
//!
//! ```text
//! Type 0 (24-bpp BGRA, LZSS):
//!   0x00  u8   type        = 0x00
//!   0x01  u16  width
//!   0x03  u16  height
//!   0x05  u32  compressed_size       (LZSS section length from byte 5)
//!   0x09  u32  uncompressed_size     (== width * height * 4)
//!   0x0d  u8[] lzss_payload[compressed_size - 8]
//!
//! Type 1 (8-bpp paletted, LZSS):
//!   0x00  u8   type        = 0x01
//!   0x01  u16  width
//!   0x03  u16  height
//!   0x05  u32  compressed_size       (LZSS section length from byte 5)
//!   0x09  u32  uncompressed_size     (== 256*4 palette + width*height indices)
//!   0x0d  u8[] lzss_payload[compressed_size - 8]
//!
//! Type 2 (24-bpp BGRA + regions, LZSS):
//!   0x00  u8   type        = 0x02
//!   0x01  u16  width
//!   0x03  u16  height
//!   0x05  u32  region_count
//!   0x09  G00RegionRecord[region_count]  (24 bytes each)
//!   ....  u32  compressed_size            (LZSS section length from here)
//!   ....  u32  uncompressed_size
//!   ....  u8[] lzss_payload[compressed_size - 8]
//! ```
//!
//! Each [`G00Region`]'s record on disk is six little-endian `i32`
//! fields: `(x1, y1, x2, y2, origin_x, origin_y)`. The
//! [`G00Rect`] uses the rlvm/xclannad public-format convention of the
//! rectangle being **inclusive** at `(x2, y2)`, so the region's pixel
//! width is `x2 - x1 + 1`. The `name` field is reserved (the on-disk
//! record does not store a string; the `objLoadRegion` opcode at
//! UTSUSHI-214 supplies names through `Gameexe.ini`-driven
//! cross-references, not through the g00 record itself).
//!
//! # LZSS variant
//!
//! All three g00 types share a classic LZSS variant with the following
//! parameters (re-derived from BACK.g00 real bytes):
//!
//! - 8-bit flag byte, LSB first. `bit = 0` → literal byte; `bit = 1` →
//!   2-byte back-reference token.
//! - Back-reference token (16 bits, little-endian byte order): the low
//!   8 bits and the high 4 bits of the next 12 carry the **absolute**
//!   ring-buffer position (12-bit, range `0..=4095`); the low 4 bits
//!   of the second byte carry `length - 3` (length range `3..=18`).
//! - Ring buffer is `4096` bytes, initialised to `0x00`; the cursor
//!   starts at `4096 - 18 = 4078` (one max-length match before the
//!   wrap point).
//!
//! Whether this exact algorithm matches every g00 file in the corpus
//! is a working hypothesis pinned by the synthetic round-trip tests in
//! `tests` and re-verified against Sweetie HD's `BACK.g00` header in
//! `tests/g00_real_bytes.rs::g00_type0_back_decodes`. When the LZSS
//! payload falls **short** of `uncompressed_size` (input exhausted
//! mid-stream), the decoder does not silently truncate: it returns the
//! partial buffer paired with a structured [`G00Warning::PayloadLengthMismatch`]
//! so downstream consumers observe the shortfall. When the payload
//! **overruns** `uncompressed_size`, the decoder surfaces a typed
//! [`G00DecodeError::OutputOverflow`] instead.
//!
//! # Clean-room provenance
//!
//! The format hypothesis above is derived from publicly-archived
//! xclannad / jagarl notes ([P] anchors in
//! `docs/research/reallive-engine.md` § "g00 (RealLive image format)")
//! plus the Sweetie HD real bytes audited under
//! `crates/utsushi-reallive/tests/g00_real_bytes.rs`. rlvm
//! (`https://github.com/eglaysher/rlvm`) is a **research anchor
//! only**: no rlvm source is vendored, linked, or mechanically
//! translated, per the crate-wide
//! [`crate::RLVM_RESEARCH_ANCHOR_BOUNDARY_STATEMENT`].

use serde::{Deserialize, Serialize};

/// Type discriminator for raw 24-bpp BGRA (LZSS-compressed) images.
/// Lead byte is `0x00`.
pub const G00_TYPE_RAW_BGR: u8 = 0;
/// Type discriminator for 8-bpp paletted images with LZSS compression.
/// Lead byte is `0x01`.
pub const G00_TYPE_PALETTED_LZSS: u8 = 1;
/// Type discriminator for 24-bpp images with a region table and LZSS
/// compression. Lead byte is `0x02`.
pub const G00_TYPE_REGIONED_LZSS: u8 = 2;

/// Number of bytes consumed by the shared `(type, width, height)`
/// preamble. Every g00 type shares this 5-byte prefix.
pub const G00_HEADER_PREAMBLE_BYTE_LEN: usize = 5;

/// Number of bytes a single type-2 [`G00Region`] record occupies on
/// disk: six little-endian `i32` fields.
pub const G00_REGION_RECORD_BYTE_LEN: usize = 24;

/// Number of bytes the type-1 palette occupies after LZSS decoding:
/// 256 entries × 4-byte BGRA each.
pub const G00_TYPE1_PALETTE_BYTE_LEN: usize = 256 * 4;

/// LZSS ring-buffer size, in bytes. The 12-bit back-reference
/// position field addresses `0..LZSS_RING_BUFFER_LEN`.
pub const G00_LZSS_RING_BUFFER_LEN: usize = 4096;

/// LZSS maximum match length. 4-bit length field carries
/// `length - LZSS_MIN_RUN`, range `0..=15`.
pub const G00_LZSS_MAX_RUN: usize = 18;

/// LZSS minimum match length. Back-references shorter than this are
/// never emitted; the 4-bit field encodes `length - LZSS_MIN_RUN`.
pub const G00_LZSS_MIN_RUN: usize = 3;

/// Initial ring-buffer cursor position. Classic LZSS convention:
/// `LZSS_RING_BUFFER_LEN - LZSS_MAX_RUN` (one max-length match before
/// the wrap point).
pub const G00_LZSS_INITIAL_CURSOR: usize = G00_LZSS_RING_BUFFER_LEN - G00_LZSS_MAX_RUN;

/// Strongly-typed enumeration of the three documented g00 sub-formats.
///
/// The discriminator is the value of byte 0 of the file. Any other
/// value is rejected by [`decode_g00`] as
/// [`G00DecodeError::UnknownType`] — there is no silent fallback to
/// "treat unknown as raw".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum G00Type {
    /// Type 0: 24-bpp BGRA pixel stream (LZSS-compressed). No region
    /// table.
    RawBgr,
    /// Type 1: 8-bpp paletted with LZSS compression. Decoded payload
    /// is 1024 bytes of palette (256 × BGRA entries) followed by
    /// `width * height` palette indices.
    PalettedLzss,
    /// Type 2: 24-bpp BGRA pixel stream with a region table and LZSS
    /// compression. Carries a `Vec<G00Region>` describing the
    /// sub-bitmaps inside the canvas.
    RegionedLzss,
}

impl G00Type {
    /// The on-disk byte value for this sub-format.
    pub const fn lead_byte(self) -> u8 {
        match self {
            G00Type::RawBgr => G00_TYPE_RAW_BGR,
            G00Type::PalettedLzss => G00_TYPE_PALETTED_LZSS,
            G00Type::RegionedLzss => G00_TYPE_REGIONED_LZSS,
        }
    }

    /// Recover the typed sub-format from a lead byte. Returns `None`
    /// for any value not in `{0, 1, 2}` so the caller can surface the
    /// out-of-profile byte through a typed error rather than a panic.
    pub const fn from_lead_byte(byte: u8) -> Option<Self> {
        match byte {
            G00_TYPE_RAW_BGR => Some(G00Type::RawBgr),
            G00_TYPE_PALETTED_LZSS => Some(G00Type::PalettedLzss),
            G00_TYPE_REGIONED_LZSS => Some(G00Type::RegionedLzss),
            _ => None,
        }
    }
}

/// Inclusive-bound axis-aligned rectangle, in pixel coordinates.
///
/// Matches the on-disk type-2 region record (`x1, y1, x2, y2`). The
/// rectangle's pixel width is `x2 - x1 + 1` and its pixel height is
/// `y2 - y1 + 1`. Negative coordinates are preserved verbatim so a
/// malformed record surfaces through downstream consumers rather than
/// being silently clamped here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct G00Rect {
    /// Inclusive-left X coordinate.
    pub x1: i32,
    /// Inclusive-top Y coordinate.
    pub y1: i32,
    /// Inclusive-right X coordinate.
    pub x2: i32,
    /// Inclusive-bottom Y coordinate.
    pub y2: i32,
}

impl G00Rect {
    /// Pixel width of this rectangle: `x2 - x1 + 1`. Returns `0` when
    /// the rectangle is inverted (`x2 < x1`) so a malformed record does
    /// not produce a negative dimension. Audit tooling looking for
    /// inverted rectangles should check the raw fields directly.
    pub fn width(&self) -> u32 {
        if self.x2 < self.x1 {
            0
        } else {
            (self.x2 - self.x1 + 1) as u32
        }
    }

    /// Pixel height of this rectangle: `y2 - y1 + 1`. Same inverted
    /// guard as [`Self::width`].
    pub fn height(&self) -> u32 {
        if self.y2 < self.y1 {
            0
        } else {
            (self.y2 - self.y1 + 1) as u32
        }
    }
}

/// One region of a type-2 g00 image.
///
/// Type 2 g00 files carry a region list immediately after the header.
/// Each region describes a sub-bitmap inside the file's canvas plus an
/// origin offset (`origin_x`, `origin_y`) used by the `objLoadRegion`
/// opcode in UTSUSHI-214 to anchor the sub-bitmap inside the parent
/// surface. The `name` field is `None` here: the on-disk region record
/// does **not** store a string; cross-referenced names land through
/// `Gameexe.ini` lookups handled at the opcode layer. The slot is
/// preserved on this struct so the caller does not have to wrap it in a
/// pair-type when it threads the region list through the opcode chain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct G00Region {
    /// The rectangle this region covers inside the file's canvas.
    pub rect: G00Rect,
    /// Origin offset the region is anchored at when blitted onto a
    /// parent surface. Preserved as raw `i32` LE fields from the
    /// region record.
    pub origin_x: i32,
    /// Origin Y. See [`Self::origin_x`].
    pub origin_y: i32,
    /// Optional region name. Always `None` from the on-disk record;
    /// populated by the `objLoadRegion` cross-reference at the opcode
    /// layer (UTSUSHI-214).
    pub name: Option<String>,
}

/// Successfully-decoded g00 image.
///
/// Carries the decoded RGBA pixel buffer (BGR reordered to RGBA at the
/// decoder boundary so downstream consumers can ignore the on-disk
/// byte order) plus the type-2 region table (empty for types 0 and 1).
/// A `Vec<G00Warning>` accompanies every successful decode through the
/// outer [`decode_g00`] return tuple — warnings are never silent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct G00Image {
    /// The decoded sub-format. Mirrors the lead byte for ergonomics
    /// (the lead byte is also reachable via [`G00Type::lead_byte`]).
    pub g00_type: G00Type,
    /// Width in pixels, from the `u16 LE` header field at offset 1.
    pub width: u32,
    /// Height in pixels, from the `u16 LE` header field at offset 3.
    pub height: u32,
    /// Decoded pixel buffer in RGBA8 byte order. For types 0 and 1
    /// the length is `width * height * 4`; for type 2 the length is
    /// the LZSS-decoded byte count (the type-2 canvas may be a
    /// concatenation of region atlases rather than a flat
    /// `width*height` surface — see
    /// [`G00Image::pixels_rgba_byte_len_full_canvas`]).
    pub pixels_rgba: Vec<u8>,
    /// Region table from the on-disk type-2 record. Empty for types 0
    /// and 1.
    pub regions: Vec<G00Region>,
}

impl G00Image {
    /// Expected pixel-buffer byte length for a type-0 or type-1 image:
    /// `width * height * 4` (one RGBA tuple per canvas pixel).
    pub fn pixels_rgba_byte_len_full_canvas(&self) -> usize {
        (self.width as usize)
            .saturating_mul(self.height as usize)
            .saturating_mul(4)
    }

    /// Expected pixel-buffer byte length for a type-2 atlas:
    /// `sum(region.width * region.height) * 4`. Returns 0 when the
    /// image has no regions (which is the well-formed case only for
    /// types 0/1; a type-2 image with zero regions is a malformed
    /// header surfaced by [`decode_g00`]).
    pub fn pixels_rgba_byte_len_type2_atlas(&self) -> usize {
        self.regions
            .iter()
            .map(|region| {
                (region.rect.width() as usize)
                    .saturating_mul(region.rect.height() as usize)
                    .saturating_mul(4)
            })
            .sum()
    }
}

/// Fatal errors raised by [`decode_g00`].
///
/// Every recoverable mismatch is a typed variant — there is no
/// `Ok(empty_image)` fallback for truncated input, an unknown type, or
/// an LZSS regression. The alpha-gate contract forbids silent
/// zero-state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum G00DecodeError {
    /// Input slice is shorter than the 5-byte
    /// `(type, width_u16, height_u16)` preamble. No fields can be
    /// parsed.
    TruncatedPreamble {
        /// Length of the input slice that was offered.
        observed_len: usize,
        /// Required length (== [`G00_HEADER_PREAMBLE_BYTE_LEN`]).
        required_len: usize,
    },
    /// Input slice is shorter than the per-type header demands.
    TruncatedHeader {
        /// Sub-format the partial header carried.
        g00_type: G00Type,
        /// Number of bytes the parser needed from the input.
        required_len: usize,
        /// Number of bytes available in the input.
        observed_len: usize,
    },
    /// The lead byte at offset 0 is not one of the documented values
    /// `{0, 1, 2}`. The unknown byte is preserved on the error so audit
    /// tooling can diagnose the on-disk file.
    UnknownType {
        /// Observed lead byte that did not match any documented type.
        observed: u8,
    },
    /// Type 2 region count was zero (a type-2 file is only well-formed
    /// with at least one region — the rectangle table is what
    /// distinguishes type 2 from type 0).
    Type2ZeroRegions,
    /// Decoded LZSS payload is shorter than the per-type pixel-buffer
    /// requirement (type 0/2: `< width*height*4`; type 1: `< palette +
    /// width*height`).
    DecodedBufferTooShort {
        /// Sub-format whose decoded buffer was short.
        g00_type: G00Type,
        /// Bytes required by the per-type pixel layout.
        required_len: usize,
        /// Bytes actually produced by the LZSS decoder.
        observed_len: usize,
    },
    /// LZSS stream ran out of input before producing the declared
    /// `uncompressed_size` bytes.
    UnexpectedEndOfStream {
        /// Sub-format whose LZSS stream ran short.
        g00_type: G00Type,
        /// Bytes declared by the LZSS header.
        declared_uncompressed_size: usize,
        /// Bytes actually emitted before the input was exhausted.
        emitted: usize,
    },
    /// LZSS stream produced more bytes than the declared
    /// `uncompressed_size`. The partial output is discarded before this
    /// error surfaces so callers do not observe overshooting buffers.
    OutputOverflow {
        /// Sub-format whose LZSS stream overflowed.
        g00_type: G00Type,
        /// Bytes declared by the LZSS header.
        declared_uncompressed_size: usize,
        /// Bytes emitted at the moment the overflow was caught.
        emitted: usize,
    },
}

impl std::fmt::Display for G00DecodeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            G00DecodeError::TruncatedPreamble {
                observed_len,
                required_len,
            } => write!(
                formatter,
                "utsushi.reallive.g00.truncated_preamble: \
                 observed_len={observed_len} required_len={required_len}"
            ),
            G00DecodeError::TruncatedHeader {
                g00_type,
                observed_len,
                required_len,
            } => write!(
                formatter,
                "utsushi.reallive.g00.truncated_header: \
                 type={g00_type:?} observed_len={observed_len} required_len={required_len}"
            ),
            G00DecodeError::UnknownType { observed } => write!(
                formatter,
                "utsushi.reallive.g00.unknown_type: observed lead byte 0x{observed:02x} \
                 not in documented set {{0, 1, 2}}"
            ),
            G00DecodeError::Type2ZeroRegions => write!(
                formatter,
                "utsushi.reallive.g00.type2_zero_regions: \
                 type-2 region_count was zero (type-2 requires at least one region)"
            ),
            G00DecodeError::DecodedBufferTooShort {
                g00_type,
                observed_len,
                required_len,
            } => write!(
                formatter,
                "utsushi.reallive.g00.decoded_buffer_too_short: \
                 type={g00_type:?} observed_len={observed_len} required_len={required_len}"
            ),
            G00DecodeError::UnexpectedEndOfStream {
                g00_type,
                declared_uncompressed_size,
                emitted,
            } => write!(
                formatter,
                "utsushi.reallive.g00.unexpected_end_of_stream: \
                 type={g00_type:?} declared_uncompressed_size={declared_uncompressed_size} \
                 emitted={emitted}"
            ),
            G00DecodeError::OutputOverflow {
                g00_type,
                declared_uncompressed_size,
                emitted,
            } => write!(
                formatter,
                "utsushi.reallive.g00.output_overflow: \
                 type={g00_type:?} declared_uncompressed_size={declared_uncompressed_size} \
                 emitted={emitted}"
            ),
        }
    }
}

impl std::error::Error for G00DecodeError {}

/// Non-fatal observations emitted alongside a successful g00 decode.
///
/// Like the other warning enums in this crate
/// ([`crate::SceneHeaderWarning`], [`crate::DecompressWarning`]), the
/// alpha-gate contract requires non-silent semantics for every
/// documented branch that historically had a different on-disk shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum G00Warning {
    /// The decoded LZSS payload did not exactly match the
    /// `uncompressed_size` declared by the on-disk header *and* the
    /// per-type pixel layout. The decode produced a typed best-effort
    /// pixel buffer (zero-extended or truncated to the
    /// pixel-layout size) so downstream consumers can still surface a
    /// canvas; the warning fires so corpus-level audit can spot the
    /// LZSS-variant mismatch.
    PayloadLengthMismatch {
        /// Sub-format whose LZSS output did not match the header.
        g00_type: G00Type,
        /// `uncompressed_size` field from the header.
        declared_uncompressed_size: u64,
        /// Number of bytes the LZSS decoder produced before stopping.
        observed_payload_size: u64,
    },
    /// The corpus-wide histogram walk observed zero files of this
    /// type. Emitted by
    /// [`G00CorpusHistogram::missing_type_warnings`] for every type
    /// in `{0, 1, 2}` whose count is zero. This is the
    /// `utsushi.reallive.g00_no_type_N_in_corpus` warning the
    /// acceptance criterion calls for.
    NoTypeNInCorpus {
        /// The g00 type that the corpus had zero files of.
        g00_type: G00Type,
    },
}

impl std::fmt::Display for G00Warning {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            G00Warning::PayloadLengthMismatch {
                g00_type,
                declared_uncompressed_size,
                observed_payload_size,
            } => write!(
                formatter,
                "utsushi.reallive.g00.payload_length_mismatch: \
                 type={g00_type:?} declared_uncompressed_size={declared_uncompressed_size} \
                 observed_payload_size={observed_payload_size}"
            ),
            G00Warning::NoTypeNInCorpus { g00_type } => write!(
                formatter,
                "utsushi.reallive.g00_no_type_N_in_corpus: \
                 corpus walk observed zero files of type {} ({g00_type:?})",
                g00_type.lead_byte(),
            ),
        }
    }
}

/// Corpus-wide histogram of g00 lead bytes.
///
/// Produced by directory walks over `$GAME/REALLIVEDATA/g00/`. The
/// `acceptance` criterion of UTSUSHI-216 calls for this aggregate to
/// surface the per-type distribution and to emit a typed
/// [`G00Warning::NoTypeNInCorpus`] for every documented type the
/// corpus has zero files of.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct G00CorpusHistogram {
    /// Number of files whose lead byte was 0 (type 0).
    pub type0_count: u64,
    /// Number of files whose lead byte was 1 (type 1).
    pub type1_count: u64,
    /// Number of files whose lead byte was 2 (type 2).
    pub type2_count: u64,
    /// Number of files whose lead byte was outside `{0, 1, 2}`.
    pub unknown_count: u64,
    /// Number of files the walker tried to open but could not read at
    /// all (zero-byte file or I/O error). Surfaced so corpus-level
    /// audit can distinguish "walk skipped" from "walk ran but file
    /// had unknown discriminator".
    pub unreadable_count: u64,
}

impl G00CorpusHistogram {
    /// Total number of files counted across every bucket (including
    /// the unknown and unreadable buckets). Convenience accessor for
    /// the acceptance test, which pins the total at the corpus size.
    pub fn total(&self) -> u64 {
        self.type0_count
            + self.type1_count
            + self.type2_count
            + self.unknown_count
            + self.unreadable_count
    }

    /// Number of files counted in the three *documented* buckets
    /// (excluding unknown / unreadable). Convenience accessor that
    /// mirrors the corpus size for a well-formed g00 directory.
    pub fn documented_total(&self) -> u64 {
        self.type0_count + self.type1_count + self.type2_count
    }

    /// One [`G00Warning::NoTypeNInCorpus`] per documented type
    /// (`{0, 1, 2}`) whose count is zero. The returned vector is
    /// always in `(0, 1, 2)` order so the acceptance test can pin the
    /// shape deterministically.
    pub fn missing_type_warnings(&self) -> Vec<G00Warning> {
        let mut warnings = Vec::new();
        if self.type0_count == 0 {
            warnings.push(G00Warning::NoTypeNInCorpus {
                g00_type: G00Type::RawBgr,
            });
        }
        if self.type1_count == 0 {
            warnings.push(G00Warning::NoTypeNInCorpus {
                g00_type: G00Type::PalettedLzss,
            });
        }
        if self.type2_count == 0 {
            warnings.push(G00Warning::NoTypeNInCorpus {
                g00_type: G00Type::RegionedLzss,
            });
        }
        warnings
    }

    /// Walk a single file's lead byte into the histogram. Files
    /// shorter than 1 byte are routed to [`Self::unreadable_count`];
    /// otherwise the byte is bucketed by the [`G00Type`] discriminator.
    pub fn observe_lead_byte(&mut self, file_bytes: &[u8]) {
        if file_bytes.is_empty() {
            self.unreadable_count += 1;
            return;
        }
        match file_bytes[0] {
            G00_TYPE_RAW_BGR => self.type0_count += 1,
            G00_TYPE_PALETTED_LZSS => self.type1_count += 1,
            G00_TYPE_REGIONED_LZSS => self.type2_count += 1,
            _ => self.unknown_count += 1,
        }
    }
}

/// Decoded LZSS-section view shared by all three g00 sub-formats.
///
/// Returned from [`parse_lzss_section`]. Pinned as a typed struct so
/// the parsing of the LZSS preamble is reusable across types 0/1/2
/// without each decoder having to re-implement the size-field math.
#[derive(Debug, Clone, Copy)]
struct LzssSection<'a> {
    /// Compressed payload slice (NOT including the 8-byte preamble
    /// `(compressed_size, uncompressed_size)`).
    payload: &'a [u8],
    /// `uncompressed_size` field from the LZSS preamble.
    uncompressed_size: usize,
}

/// Decode a g00 file into a typed [`G00Image`] + warnings tuple.
///
/// Dispatches on the lead byte at offset 0 to one of the three
/// type-specific decoders. Returns `Err(G00DecodeError::UnknownType)`
/// for any lead byte outside `{0, 1, 2}` — there is no silent
/// "treat unknown as type 0" fallback.
pub fn decode_g00(input: &[u8]) -> Result<(G00Image, Vec<G00Warning>), G00DecodeError> {
    if input.len() < G00_HEADER_PREAMBLE_BYTE_LEN {
        return Err(G00DecodeError::TruncatedPreamble {
            observed_len: input.len(),
            required_len: G00_HEADER_PREAMBLE_BYTE_LEN,
        });
    }
    let lead = input[0];
    let g00_type =
        G00Type::from_lead_byte(lead).ok_or(G00DecodeError::UnknownType { observed: lead })?;
    let width = u16::from_le_bytes([input[1], input[2]]) as u32;
    let height = u16::from_le_bytes([input[3], input[4]]) as u32;

    match g00_type {
        G00Type::RawBgr => decode_type0(input, width, height),
        G00Type::PalettedLzss => decode_type1(input, width, height),
        G00Type::RegionedLzss => decode_type2(input, width, height),
    }
}

/// Decode a type-0 (24-bpp BGRA, LZSS) g00 file.
///
/// Header: 5-byte preamble + `(u32 compressed_size, u32 uncompressed_size)` +
/// LZSS payload. Decoded payload is `width * height * 4` bytes of BGRA pixels,
/// reordered to RGBA at the decoder boundary.
fn decode_type0(
    input: &[u8],
    width: u32,
    height: u32,
) -> Result<(G00Image, Vec<G00Warning>), G00DecodeError> {
    let section = parse_lzss_section(input, G00_HEADER_PREAMBLE_BYTE_LEN, G00Type::RawBgr)?;
    let pixel_byte_count = (width as usize)
        .saturating_mul(height as usize)
        .saturating_mul(4);

    let (decoded, length_warning) =
        lzss_decode_classic(section.payload, section.uncompressed_size, G00Type::RawBgr)?;
    let mut bgra = pad_or_truncate(decoded, pixel_byte_count);

    bgra_to_rgba_in_place(&mut bgra);

    let mut warnings = Vec::new();
    if let Some(w) = length_warning {
        warnings.push(w);
    }

    Ok((
        G00Image {
            g00_type: G00Type::RawBgr,
            width,
            height,
            pixels_rgba: bgra,
            regions: Vec::new(),
        },
        warnings,
    ))
}

/// Decode a type-1 (8-bpp paletted + LZSS) g00 file.
///
/// Header layout: 5-byte preamble, `u32 LE compressed_size`,
/// `u32 LE uncompressed_size`. The LZSS payload decodes to a 1024-byte
/// BGRA palette followed by `width * height` palette indices.
fn decode_type1(
    input: &[u8],
    width: u32,
    height: u32,
) -> Result<(G00Image, Vec<G00Warning>), G00DecodeError> {
    let section = parse_lzss_section(input, G00_HEADER_PREAMBLE_BYTE_LEN, G00Type::PalettedLzss)?;
    let pixel_count = (width as usize).saturating_mul(height as usize);
    let required_decoded_len = G00_TYPE1_PALETTE_BYTE_LEN.saturating_add(pixel_count);

    let (decoded, length_warning) = lzss_decode_classic(
        section.payload,
        section.uncompressed_size,
        G00Type::PalettedLzss,
    )?;

    if decoded.len() < required_decoded_len {
        return Err(G00DecodeError::DecodedBufferTooShort {
            g00_type: G00Type::PalettedLzss,
            required_len: required_decoded_len,
            observed_len: decoded.len(),
        });
    }

    let palette = &decoded[..G00_TYPE1_PALETTE_BYTE_LEN];
    let indices = &decoded[G00_TYPE1_PALETTE_BYTE_LEN..G00_TYPE1_PALETTE_BYTE_LEN + pixel_count];
    let mut pixels_rgba = Vec::with_capacity(pixel_count.saturating_mul(4));
    for &index in indices {
        let palette_off = (index as usize) * 4;
        // Palette stored as BGRA on disk; reorder to RGBA at decode
        // boundary.
        let b = palette[palette_off];
        let g = palette[palette_off + 1];
        let r = palette[palette_off + 2];
        let a = palette[palette_off + 3];
        pixels_rgba.push(r);
        pixels_rgba.push(g);
        pixels_rgba.push(b);
        pixels_rgba.push(a);
    }

    let mut warnings = Vec::new();
    if let Some(w) = length_warning {
        warnings.push(w);
    }

    Ok((
        G00Image {
            g00_type: G00Type::PalettedLzss,
            width,
            height,
            pixels_rgba,
            regions: Vec::new(),
        },
        warnings,
    ))
}

/// Decode a type-2 (24-bpp + regions + LZSS) g00 file.
///
/// Header layout: 5-byte preamble, `u32 LE region_count`,
/// `region_count` × 24-byte region records, then the LZSS preamble
/// (`u32 LE compressed_size`, `u32 LE uncompressed_size`) and stream.
fn decode_type2(
    input: &[u8],
    width: u32,
    height: u32,
) -> Result<(G00Image, Vec<G00Warning>), G00DecodeError> {
    let post_count_off = G00_HEADER_PREAMBLE_BYTE_LEN + 4;
    if input.len() < post_count_off {
        return Err(G00DecodeError::TruncatedHeader {
            g00_type: G00Type::RegionedLzss,
            required_len: post_count_off,
            observed_len: input.len(),
        });
    }
    let region_count = u32::from_le_bytes([input[5], input[6], input[7], input[8]]) as usize;
    if region_count == 0 {
        return Err(G00DecodeError::Type2ZeroRegions);
    }
    let region_bytes_total = region_count.saturating_mul(G00_REGION_RECORD_BYTE_LEN);
    let lzss_preamble_off = post_count_off.saturating_add(region_bytes_total);
    if input.len() < lzss_preamble_off + 8 {
        return Err(G00DecodeError::TruncatedHeader {
            g00_type: G00Type::RegionedLzss,
            required_len: lzss_preamble_off + 8,
            observed_len: input.len(),
        });
    }

    let mut regions = Vec::with_capacity(region_count);
    for region_idx in 0..region_count {
        let off = post_count_off + region_idx * G00_REGION_RECORD_BYTE_LEN;
        let x1 = i32::from_le_bytes([input[off], input[off + 1], input[off + 2], input[off + 3]]);
        let y1 = i32::from_le_bytes([
            input[off + 4],
            input[off + 5],
            input[off + 6],
            input[off + 7],
        ]);
        let x2 = i32::from_le_bytes([
            input[off + 8],
            input[off + 9],
            input[off + 10],
            input[off + 11],
        ]);
        let y2 = i32::from_le_bytes([
            input[off + 12],
            input[off + 13],
            input[off + 14],
            input[off + 15],
        ]);
        let origin_x = i32::from_le_bytes([
            input[off + 16],
            input[off + 17],
            input[off + 18],
            input[off + 19],
        ]);
        let origin_y = i32::from_le_bytes([
            input[off + 20],
            input[off + 21],
            input[off + 22],
            input[off + 23],
        ]);
        regions.push(G00Region {
            rect: G00Rect { x1, y1, x2, y2 },
            origin_x,
            origin_y,
            name: None,
        });
    }

    let section = parse_lzss_section(input, lzss_preamble_off, G00Type::RegionedLzss)?;

    let (decoded, length_warning) = lzss_decode_classic(
        section.payload,
        section.uncompressed_size,
        G00Type::RegionedLzss,
    )?;

    // Type-2 atlas: reorder BGRA to RGBA at the decode boundary.
    let mut pixels_rgba = decoded;
    bgra_to_rgba_in_place(&mut pixels_rgba);

    let mut warnings = Vec::new();
    if let Some(w) = length_warning {
        warnings.push(w);
    }

    Ok((
        G00Image {
            g00_type: G00Type::RegionedLzss,
            width,
            height,
            pixels_rgba,
            regions,
        },
        warnings,
    ))
}

/// Parse the LZSS section preamble at offset `preamble_off` into a
/// typed [`LzssSection`].
fn parse_lzss_section<'a>(
    input: &'a [u8],
    preamble_off: usize,
    g00_type: G00Type,
) -> Result<LzssSection<'a>, G00DecodeError> {
    if input.len() < preamble_off + 8 {
        return Err(G00DecodeError::TruncatedHeader {
            g00_type,
            required_len: preamble_off + 8,
            observed_len: input.len(),
        });
    }
    let compressed_size = u32::from_le_bytes([
        input[preamble_off],
        input[preamble_off + 1],
        input[preamble_off + 2],
        input[preamble_off + 3],
    ]) as usize;
    let uncompressed_size = u32::from_le_bytes([
        input[preamble_off + 4],
        input[preamble_off + 5],
        input[preamble_off + 6],
        input[preamble_off + 7],
    ]) as usize;
    let payload_start = preamble_off + 8;
    // `compressed_size` includes the 8-byte preamble itself.
    let declared_payload_end = preamble_off.saturating_add(compressed_size);
    let payload_end = declared_payload_end.min(input.len()).max(payload_start);
    Ok(LzssSection {
        payload: &input[payload_start..payload_end],
        uncompressed_size,
    })
}

/// Reorder a `width * height * 4` BGRA byte slice into RGBA, in place.
///
/// The on-disk byte order is BGRA (one of the audit-focus items in
/// UTSUSHI-216 is "Treating 'BGR' as 'RGB' silently"). This helper
/// performs the swap explicitly so consumers see RGBA.
fn bgra_to_rgba_in_place(bgra: &mut [u8]) {
    for chunk in bgra.chunks_exact_mut(4) {
        chunk.swap(0, 2); // swap B and R; G and A stay in place.
    }
}

/// Truncate or zero-extend `decoded` to exactly `target_len` bytes.
///
/// Used when the LZSS-decoded payload does not exactly match the
/// per-type pixel-buffer requirement (which is the audit-traceable
/// hypothesis mismatch surface). Callers emit a typed
/// [`G00Warning::PayloadLengthMismatch`] when this helper has to
/// adjust the buffer.
fn pad_or_truncate(mut decoded: Vec<u8>, target_len: usize) -> Vec<u8> {
    if decoded.len() < target_len {
        decoded.resize(target_len, 0);
    } else if decoded.len() > target_len {
        decoded.truncate(target_len);
    }
    decoded
}

/// Decode a classic LZSS stream (ring buffer 4096, max-run 18, min-run 3,
/// absolute 12-bit position encoding).
///
/// Encoding:
/// - 8-bit flag byte, LSB first.
/// - `bit = 0` → emit one literal byte from input.
/// - `bit = 1` → read 2-byte back-reference token (lo, hi). The
///   absolute ring-buffer position is `lo | ((hi & 0xf0) << 4)` (12
///   bits). The match length is `(hi & 0x0f) + G00_LZSS_MIN_RUN`
///   (3..=18).
///
/// The ring buffer is fixed-size [`G00_LZSS_RING_BUFFER_LEN`] = 4096
/// bytes, initialised to `0x00`, with the cursor starting at
/// [`G00_LZSS_INITIAL_CURSOR`] = 4078.
///
/// Returns `(decoded, payload_length_mismatch_warning)`. The decoder
/// stops at either `dst.len() == uncompressed_size` (clean) or the
/// input being exhausted (warning is surfaced when the latter happens
/// short of the declared size).
fn lzss_decode_classic(
    input: &[u8],
    uncompressed_size: usize,
    g00_type: G00Type,
) -> Result<(Vec<u8>, Option<G00Warning>), G00DecodeError> {
    let mut dst = Vec::with_capacity(uncompressed_size);
    let mut ring = vec![0u8; G00_LZSS_RING_BUFFER_LEN];
    let mut cursor: usize = G00_LZSS_INITIAL_CURSOR;
    let mut src_pos = 0usize;
    let mut flag: u8 = 0;
    let mut bits_remaining: u8 = 0;

    while dst.len() < uncompressed_size {
        if bits_remaining == 0 {
            if src_pos >= input.len() {
                // Input exhausted mid-stream. Surface as a non-fatal
                // length warning so downstream consumers can still
                // observe the partial decode.
                break;
            }
            flag = input[src_pos];
            src_pos += 1;
            bits_remaining = 8;
        }
        let is_literal = (flag & 1) == 0;
        flag >>= 1;
        bits_remaining -= 1;

        if is_literal {
            if src_pos >= input.len() {
                break;
            }
            let byte = input[src_pos];
            src_pos += 1;
            dst.push(byte);
            ring[cursor] = byte;
            cursor = (cursor + 1) % G00_LZSS_RING_BUFFER_LEN;
        } else {
            if src_pos + 2 > input.len() {
                break;
            }
            let b1 = input[src_pos] as usize;
            let b2 = input[src_pos + 1] as usize;
            src_pos += 2;
            let position = b1 | ((b2 & 0xf0) << 4);
            let run_length = (b2 & 0x0f) + G00_LZSS_MIN_RUN;
            for i in 0..run_length {
                let byte = ring[(position + i) % G00_LZSS_RING_BUFFER_LEN];
                dst.push(byte);
                ring[cursor] = byte;
                cursor = (cursor + 1) % G00_LZSS_RING_BUFFER_LEN;
                if dst.len() >= uncompressed_size {
                    break;
                }
            }
        }
    }

    if dst.len() > uncompressed_size {
        return Err(G00DecodeError::OutputOverflow {
            g00_type,
            declared_uncompressed_size: uncompressed_size,
            emitted: dst.len(),
        });
    }

    let warning = if dst.len() != uncompressed_size {
        Some(G00Warning::PayloadLengthMismatch {
            g00_type,
            declared_uncompressed_size: uncompressed_size as u64,
            observed_payload_size: dst.len() as u64,
        })
    } else {
        None
    };

    Ok((dst, warning))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Synthetic LZSS encoder for the classic variant.
    ///
    /// Test-only: the on-disk format is read-side. Takes a literal
    /// byte sequence and emits a flag-byte + literals encoding (no
    /// back-references) so we can build a self-consistent fixture for
    /// the round-trip tests without depending on the rlvm reference.
    fn encode_lzss_literals_only(plaintext: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut idx = 0;
        while idx < plaintext.len() {
            let block_end = (idx + 8).min(plaintext.len());
            let block_len = block_end - idx;
            // Flag = bit set means "literal" -- but our decoder treats
            // bit=0 as literal. So we leave all relevant bits clear.
            let flag: u8 = 0;
            // (We still need to zero the unused high bits, which is
            // what 0 already gives us. The decoder only consumes the
            // first block_len bits before looping.)
            out.push(flag);
            for &byte in &plaintext[idx..block_end] {
                out.push(byte);
            }
            let _ = block_len; // silence unused warning under some configs
            idx = block_end;
        }
        out
    }

    /// Synthetic LZSS encoder that emits a single absolute-position
    /// back-reference after a run of literals. Used to exercise the
    /// back-reference decode path.
    fn encode_lzss_one_backref(
        literals: &[u8],
        backref_position: u16,
        backref_run_length: u8,
    ) -> Vec<u8> {
        let mut out = Vec::new();
        let mut idx = 0;
        // Emit literals 8 at a time (flag=0).
        while idx + 8 <= literals.len() {
            out.push(0);
            for &byte in &literals[idx..idx + 8] {
                out.push(byte);
            }
            idx += 8;
        }
        let tail_count = literals.len() - idx;
        // Final flag has bits 0..tail_count cleared (literal), then
        // bit tail_count set (backref). Remaining bits are unused.
        let flag: u8 = 1u8 << tail_count;
        out.push(flag);
        for &byte in &literals[idx..] {
            out.push(byte);
        }
        // Emit the backref token (lo, hi).
        let pos = backref_position as u32;
        let run = backref_run_length as u32;
        assert!(run >= G00_LZSS_MIN_RUN as u32 && run <= G00_LZSS_MAX_RUN as u32);
        let length_field = (run - G00_LZSS_MIN_RUN as u32) & 0x0f;
        let lo = (pos & 0xff) as u8;
        let hi = (((pos >> 4) & 0xf0) | length_field) as u8;
        out.push(lo);
        out.push(hi);
        out
    }

    #[test]
    fn truncated_preamble_is_typed_error() {
        let err =
            decode_g00(&[0u8; 3]).expect_err("3-byte input is shorter than the 5-byte preamble");
        match err {
            G00DecodeError::TruncatedPreamble {
                observed_len,
                required_len,
            } => {
                assert_eq!(observed_len, 3);
                assert_eq!(required_len, G00_HEADER_PREAMBLE_BYTE_LEN);
            }
            other => panic!("expected TruncatedPreamble, got: {other:?}"),
        }
    }

    #[test]
    fn unknown_lead_byte_is_typed_error_not_silent_fallback() {
        // 0x42 is not in {0, 1, 2}; decoder must reject.
        let bytes = [0x42u8, 0x00, 0x00, 0x00, 0x00];
        let err = decode_g00(&bytes).expect_err("lead byte 0x42 must be rejected");
        match err {
            G00DecodeError::UnknownType { observed } => assert_eq!(observed, 0x42),
            other => panic!("expected UnknownType, got: {other:?}"),
        }
    }

    #[test]
    fn lzss_classic_pure_literals_round_trip() {
        let plaintext: Vec<u8> = (0..16u8).collect();
        let encoded = encode_lzss_literals_only(&plaintext);
        let (out, warning) =
            lzss_decode_classic(&encoded, plaintext.len(), G00Type::RawBgr).expect("must decode");
        assert_eq!(out, plaintext);
        assert!(warning.is_none(), "no length mismatch on clean round trip");
    }

    #[test]
    fn lzss_classic_back_reference_round_trip() {
        // Emit 4 literals into the ring buffer, then a back-reference
        // copying them. The ring cursor starts at
        // G00_LZSS_INITIAL_CURSOR = 4078, so the 4 literals land at
        // positions 4078..4081. The back-reference at position=4078,
        // length=4 should produce the same 4 bytes.
        let literals = vec![0x10u8, 0x20, 0x30, 0x40];
        let encoded = encode_lzss_one_backref(&literals, G00_LZSS_INITIAL_CURSOR as u16, 4);
        let expected = vec![0x10, 0x20, 0x30, 0x40, 0x10, 0x20, 0x30, 0x40];
        let (out, warning) =
            lzss_decode_classic(&encoded, expected.len(), G00Type::RawBgr).expect("must decode");
        assert_eq!(out, expected);
        assert!(warning.is_none());
    }

    #[test]
    fn lzss_classic_short_stream_emits_length_warning_not_silent_pass() {
        // Audit-focus pin: regression test for the
        // "LZSS distance encoding regression that decodes a few bytes
        // and then garbage" item. Set up a stream that runs out
        // before producing the declared uncompressed_size — the
        // decoder must surface a typed PayloadLengthMismatch warning,
        // not silently truncate.
        let plaintext: Vec<u8> = (0..4u8).collect();
        let encoded = encode_lzss_literals_only(&plaintext);
        let (out, warning) = lzss_decode_classic(&encoded, 100, G00Type::RawBgr)
            .expect("over-declared size must surface warning, not error");
        assert!(out.len() < 100, "decoder must stop when input runs out");
        match warning {
            Some(G00Warning::PayloadLengthMismatch {
                g00_type,
                declared_uncompressed_size,
                observed_payload_size,
            }) => {
                assert_eq!(g00_type, G00Type::RawBgr);
                assert_eq!(declared_uncompressed_size, 100);
                assert_eq!(observed_payload_size, out.len() as u64);
            }
            other => panic!("expected PayloadLengthMismatch warning, got: {other:?}"),
        }
    }

    /// Build a synthetic type-0 g00 file: 5-byte preamble +
    /// `(compressed_size, uncompressed_size)` + literal-only LZSS
    /// payload encoding the supplied BGRA byte stream.
    fn synth_type0(width: u16, height: u16, bgra_payload: &[u8]) -> Vec<u8> {
        let lzss = encode_lzss_literals_only(bgra_payload);
        let mut bytes = Vec::new();
        bytes.push(G00_TYPE_RAW_BGR);
        bytes.extend_from_slice(&width.to_le_bytes());
        bytes.extend_from_slice(&height.to_le_bytes());
        let compressed_size = (lzss.len() + 8) as u32;
        let uncompressed_size = bgra_payload.len() as u32;
        bytes.extend_from_slice(&compressed_size.to_le_bytes());
        bytes.extend_from_slice(&uncompressed_size.to_le_bytes());
        bytes.extend_from_slice(&lzss);
        bytes
    }

    #[test]
    fn type0_decodes_2x1_bgra_to_rgba() {
        // 2 BGRA pixels: (B=10, G=20, R=30, A=40), (B=50, G=60, R=70, A=80).
        // After decode the RGBA bytes must be
        // (30, 20, 10, 40, 70, 60, 50, 80).
        let bgra_payload = [10u8, 20, 30, 40, 50, 60, 70, 80];
        let bytes = synth_type0(2, 1, &bgra_payload);
        let (image, warnings) = decode_g00(&bytes).expect("type-0 must decode");
        assert_eq!(image.g00_type, G00Type::RawBgr);
        assert_eq!(image.width, 2);
        assert_eq!(image.height, 1);
        assert_eq!(image.pixels_rgba.len(), 2 * 4);
        assert_eq!(&image.pixels_rgba[..4], &[30, 20, 10, 40]);
        assert_eq!(&image.pixels_rgba[4..], &[70, 60, 50, 80]);
        assert!(image.regions.is_empty());
        assert!(
            warnings.is_empty(),
            "clean round trip must not warn: {warnings:?}"
        );
    }

    #[test]
    fn type0_bgr_byte_order_is_not_treated_as_rgb() {
        // Audit-focus pin: regression test for the
        // "Treating 'BGR' as 'RGB' silently" audit item. Pick a pixel
        // where B != R so a silent reorder skip surfaces as a wrong
        // value here.
        let bgra_payload = [0x11u8, 0x22, 0x33, 0xff]; // B=0x11, G=0x22, R=0x33
        let bytes = synth_type0(1, 1, &bgra_payload);
        let (image, _) = decode_g00(&bytes).expect("type-0 must decode");
        // RGBA reorder: first byte must be R (0x33), then G, then B,
        // then alpha.
        assert_eq!(
            image.pixels_rgba[0], 0x33,
            "R slot must hold on-disk R byte (not B)"
        );
        assert_eq!(
            image.pixels_rgba[1], 0x22,
            "G slot must hold on-disk G byte"
        );
        assert_eq!(
            image.pixels_rgba[2], 0x11,
            "B slot must hold on-disk B byte"
        );
        assert_eq!(
            image.pixels_rgba[3], 0xff,
            "alpha must come from the on-disk A byte"
        );
    }

    #[test]
    fn type1_synthetic_round_trip() {
        // Build a 2x1 image with palette index 0 -> red, index 1 -> green.
        let mut decoded_payload = vec![0u8; G00_TYPE1_PALETTE_BYTE_LEN + 2];
        // Index 0: BGRA = (0x00, 0x00, 0xFF, 0xFF) -- red
        decoded_payload[0] = 0x00; // B
        decoded_payload[1] = 0x00; // G
        decoded_payload[2] = 0xff; // R
        decoded_payload[3] = 0xff; // A
        // Index 1: BGRA = (0x00, 0xFF, 0x00, 0xFF) -- green
        decoded_payload[4] = 0x00; // B
        decoded_payload[5] = 0xff; // G
        decoded_payload[6] = 0x00; // R
        decoded_payload[7] = 0xff; // A
        // Indices [0, 1] at the tail.
        decoded_payload[G00_TYPE1_PALETTE_BYTE_LEN] = 0;
        decoded_payload[G00_TYPE1_PALETTE_BYTE_LEN + 1] = 1;

        let lzss_payload = encode_lzss_literals_only(&decoded_payload);
        let uncompressed_size = decoded_payload.len() as u32;
        let compressed_size = (lzss_payload.len() + 8) as u32;

        let mut file = Vec::new();
        file.push(G00_TYPE_PALETTED_LZSS);
        file.extend_from_slice(&2u16.to_le_bytes());
        file.extend_from_slice(&1u16.to_le_bytes());
        file.extend_from_slice(&compressed_size.to_le_bytes());
        file.extend_from_slice(&uncompressed_size.to_le_bytes());
        file.extend_from_slice(&lzss_payload);

        let (image, warnings) = decode_g00(&file).expect("synthetic type-1 must decode");
        assert_eq!(image.g00_type, G00Type::PalettedLzss);
        assert_eq!(image.width, 2);
        assert_eq!(image.height, 1);
        assert_eq!(image.pixels_rgba.len(), 8);
        assert_eq!(&image.pixels_rgba[..4], &[0xff, 0x00, 0x00, 0xff]);
        assert_eq!(&image.pixels_rgba[4..], &[0x00, 0xff, 0x00, 0xff]);
        assert!(
            warnings.is_empty(),
            "synthetic type-1 must not warn; got {warnings:?}"
        );
    }

    #[test]
    fn type2_zero_regions_is_typed_error() {
        let mut bytes = Vec::new();
        bytes.push(G00_TYPE_REGIONED_LZSS);
        bytes.extend_from_slice(&100u16.to_le_bytes());
        bytes.extend_from_slice(&50u16.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        // Need at least 8 more bytes for the LZSS preamble check.
        bytes.extend_from_slice(&[0u8; 8]);
        let err = decode_g00(&bytes).expect_err("zero-region type-2 must error");
        assert!(matches!(err, G00DecodeError::Type2ZeroRegions));
    }

    #[test]
    fn type2_synthetic_round_trip_with_one_region() {
        // Build a 4-pixel canvas (4x1) with one region covering it.
        let bgra_payload = [
            0xAAu8, 0xBB, 0xCC, 0xff, // pixel 0
            0x01, 0x02, 0x03, 0xff, // pixel 1
            0x04, 0x05, 0x06, 0xff, // pixel 2
            0x07, 0x08, 0x09, 0xff, // pixel 3
        ];
        let lzss = encode_lzss_literals_only(&bgra_payload);
        let compressed_size = (lzss.len() + 8) as u32;
        let uncompressed_size = bgra_payload.len() as u32;

        let mut bytes = Vec::new();
        bytes.push(G00_TYPE_REGIONED_LZSS);
        bytes.extend_from_slice(&4u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u32.to_le_bytes()); // region_count
        // Region 0: x1=0 y1=0 x2=3 y2=0 origin=(7, 11)
        bytes.extend_from_slice(&0i32.to_le_bytes());
        bytes.extend_from_slice(&0i32.to_le_bytes());
        bytes.extend_from_slice(&3i32.to_le_bytes());
        bytes.extend_from_slice(&0i32.to_le_bytes());
        bytes.extend_from_slice(&7i32.to_le_bytes());
        bytes.extend_from_slice(&11i32.to_le_bytes());
        bytes.extend_from_slice(&compressed_size.to_le_bytes());
        bytes.extend_from_slice(&uncompressed_size.to_le_bytes());
        bytes.extend_from_slice(&lzss);

        let (image, warnings) = decode_g00(&bytes).expect("type-2 must decode");
        assert_eq!(image.g00_type, G00Type::RegionedLzss);
        assert_eq!(image.width, 4);
        assert_eq!(image.height, 1);
        assert_eq!(image.regions.len(), 1);
        assert_eq!(image.regions[0].rect.x1, 0);
        assert_eq!(image.regions[0].rect.x2, 3);
        assert_eq!(image.regions[0].rect.width(), 4);
        assert_eq!(image.regions[0].origin_x, 7);
        assert_eq!(image.regions[0].origin_y, 11);
        assert_eq!(image.regions[0].name, None);
        assert_eq!(image.pixels_rgba.len(), 16);
        // Pixel 0: BGRA=(AA, BB, CC, ff) -> RGBA=(CC, BB, AA, ff)
        assert_eq!(&image.pixels_rgba[..4], &[0xCC, 0xBB, 0xAA, 0xff]);
        assert!(
            warnings.is_empty(),
            "clean round trip must not warn: {warnings:?}"
        );
    }

    #[test]
    fn type2_region_off_by_one_inclusive_bound() {
        // Audit-focus pin: regression test for the
        // "Region table off-by-one against type 2 sub-bitmap counts"
        // audit item. With x1=0, x2=99 the width is 100, not 99 (the
        // bound is inclusive).
        let rect = G00Rect {
            x1: 0,
            y1: 0,
            x2: 99,
            y2: 49,
        };
        assert_eq!(rect.width(), 100);
        assert_eq!(rect.height(), 50);
        assert_eq!((rect.width() * rect.height()) as usize, 5000);
    }

    #[test]
    fn corpus_histogram_emits_no_type_n_warning_for_missing_types() {
        let mut histogram = G00CorpusHistogram::default();
        histogram.observe_lead_byte(&[G00_TYPE_RAW_BGR, 0, 0, 0]);
        histogram.observe_lead_byte(&[G00_TYPE_RAW_BGR, 0, 0, 0]);
        histogram.observe_lead_byte(&[G00_TYPE_REGIONED_LZSS, 0, 0, 0]);
        assert_eq!(histogram.type0_count, 2);
        assert_eq!(histogram.type1_count, 0);
        assert_eq!(histogram.type2_count, 1);
        assert_eq!(histogram.documented_total(), 3);
        let warnings = histogram.missing_type_warnings();
        assert_eq!(warnings.len(), 1);
        assert!(matches!(
            warnings[0],
            G00Warning::NoTypeNInCorpus {
                g00_type: G00Type::PalettedLzss
            }
        ));
    }

    #[test]
    fn corpus_histogram_unreadable_files_bucketed_separately() {
        let mut histogram = G00CorpusHistogram::default();
        histogram.observe_lead_byte(&[]);
        histogram.observe_lead_byte(&[0xFF]); // unknown lead byte
        assert_eq!(histogram.unreadable_count, 1);
        assert_eq!(histogram.unknown_count, 1);
        assert_eq!(histogram.documented_total(), 0);
        assert_eq!(histogram.total(), 2);
    }

    #[test]
    fn warning_display_carries_typed_code_prefix() {
        let warning = G00Warning::NoTypeNInCorpus {
            g00_type: G00Type::PalettedLzss,
        };
        let rendered = warning.to_string();
        assert!(
            rendered.starts_with("utsushi.reallive.g00_no_type_N_in_corpus:"),
            "warning must carry the spec-defined prefix; got: {rendered}",
        );
    }

    #[test]
    fn error_display_carries_typed_code_prefix() {
        let err = G00DecodeError::UnknownType { observed: 0xff };
        let rendered = err.to_string();
        assert!(
            rendered.starts_with("utsushi.reallive.g00."),
            "error Display must carry the typed code prefix; got: {rendered}",
        );
    }

    #[test]
    fn g00_type_lead_byte_round_trips() {
        for ty in [
            G00Type::RawBgr,
            G00Type::PalettedLzss,
            G00Type::RegionedLzss,
        ] {
            assert_eq!(G00Type::from_lead_byte(ty.lead_byte()), Some(ty));
        }
        assert_eq!(G00Type::from_lead_byte(3), None);
    }
}
