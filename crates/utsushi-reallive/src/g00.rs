//! RealLive `g00` image-format decoder (types 0, 1, 2).
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
//! `docs/research/reallive-engine.md` § "g00 (RealLive image format)"
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
//!   0x00 u8 type = 0x00
//!   0x01 u16 width
//!   0x03 u16 height
//!   0x05 u32 compressed_size (LZSS section length from byte 5)
//!   0x09 u32 uncompressed_size (== width * height * 4)
//!   0x0d u8[] lzss_payload[compressed_size - 8]
//!
//! Type 1 (8-bpp paletted, LZSS):
//!   0x00 u8 type = 0x01
//!   0x01 u16 width
//!   0x03 u16 height
//!   0x05 u32 compressed_size (LZSS section length from byte 5)
//!   0x09 u32 uncompressed_size (== 256*4 palette + width*height indices)
//!   0x0d u8[] lzss_payload[compressed_size - 8]
//!
//! Type 2 (24-bpp BGRA + regions, LZSS):
//!   0x00 u8 type = 0x02
//!   0x01 u16 width
//!   0x03 u16 height
//!   0x05 u32 region_count
//!   0x09 G00RegionRecord[region_count] (24 bytes each)
//!   .... u32 compressed_size (LZSS section length from here)
//!   .... u32 uncompressed_size
//!   .... u8[] lzss_payload[compressed_size - 8]
//! ```
//!
//! Each [`G00Region`]'s record on disk is six little-endian `i32`
//! fields: `(x1, y1, x2, y2, origin_x, origin_y)`. The
//! [`G00Rect`] uses the rlvm/xclannad public-format convention of the
//! rectangle being **inclusive** at `(x2, y2)`, so the region's pixel
//! width is `x2 - x1 + 1`. The `name` field is reserved (the on-disk
//! record does not store a string; the `objLoadRegion` opcode supplies
//! names through `Gameexe.ini`-driven cross-references, not through the
//! g00 record itself).
//!
//! # LZSS variant (relative back-reference LZ77)
//!
//! All three g00 types share the RealLive/AVG32 LZ77 control structure
//! (flag byte, LSB-first, `bit = 1` → literal, `bit = 0` → 2-byte
//! back-reference token) but differ in the copy granularity and the
//! token bit-packing. The back-reference is a **relative back-distance
//! into the already-emitted output** (there is no fixed ring buffer and
//! no absolute position); the history starts empty and overlapping
//! copies are byte-by-byte, so a small distance with a long length is a
//! run-fill.
//!
//! - **Type 0** (`RawBgr`): the LZSS output is a flat **24-bpp BGR**
//!   canvas of `width * height * 3` bytes. A literal copies **3** bytes
//!   (one BGR pixel). A back-reference token `t` (16-bit little-endian)
//!   splits as `distance = (t >> 4) * 3` bytes and
//!   `length = ((t & 0x0f) + 1) * 3` bytes (i.e. a whole number of
//!   3-byte pixels; length range `3..=48`). After decoding, each BGR
//!   triple is expanded to RGBA `(R, G, B, 0xff)` at the decoder
//!   boundary. The header's `uncompressed_size` field is the **final
//!   32-bpp** size `width * height * 4`, *not* the LZSS output size — a
//!   correct decode stops exactly when the `width * height * 3` BGR
//!   canvas is filled, which is also exactly when the compressed payload
//!   is consumed.
//! - **Types 1 & 2** (`PalettedLzss` / `RegionedLzss`): the AVG2000
//!   ("SCN2k") token. A literal copies **1** byte. A back-reference
//!   token `t` splits as `distance = (t >> 4)` bytes and
//!   `length = (t & 0x0f) + 2` bytes. Type 1's LZSS output is a colour
//!   table (`u16 LE count`, then `count` × 4-byte BGRA entries) followed
//!   by one palette index per pixel; type 2's LZSS output is a region
//!   container (a per-region offset/length table followed by tagged
//!   32-bpp sub-bitmaps that are blitted into the transparent canvas).
//!
//! When the LZSS payload falls **short** of the expected output (input
//! exhausted mid-stream), the decoder does not silently truncate: it
//! zero-fills to the declared canvas size and surfaces a structured
//! [`G00Warning::PayloadLengthMismatch`] so downstream consumers observe
//! the shortfall. The decoder appends output one unit at a time and
//! stops the instant the target size is reached, so it can never overrun.
//!
//! # Clean-room provenance
//!
//! The algorithm above was re-derived by reading the publicly-archived
//! Jagarl/xclannad `file.cc` `G00CONV` decode (GPL-v2) as a **research
//! reference for the algorithm only** and validated byte-exact against
//! it as an external oracle on real Sweetie HD and Kanon g00 bytes (see
//! `docs/research/g00-type0-decoder-findings.md`). No third-party source
//! is vendored, linked, or mechanically translated into this crate; the
//! Rust below is an independent reimplementation of the (uncopyrightable)
//! bitstream algorithm, per the crate-wide
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

/// Bytes per pixel in the type-0 LZSS output canvas (24-bpp BGR, one
/// literal token = one pixel). The decoded BGR canvas is
/// `width * height * G00_TYPE0_BGR_BYTES_PER_PIXEL` bytes, expanded to
/// 32-bpp RGBA at the decoder boundary.
pub const G00_TYPE0_BGR_BYTES_PER_PIXEL: usize = 3;

/// Maximum trailing (unconsumed) LZSS-payload byte the strict content
/// validator tolerates for a **type-2** stream once the full declared
/// output has been emitted.
///
/// Real AVG2000 ("SCN2k") type-2 streams pad `compressed_size` by exactly
/// one byte beyond what the LZSS tokens need: the reference decoder
/// (xclannad `G00CONV`, `file.cc` `lzExtract`) stops the instant the
/// canvas fills (`while (ldest < ldestend && lsrc < lsrcend)` — the
/// `ldest < ldestend` guard fails) and never reads that trailing pad, so
/// the byte is legitimate padding, not corruption. Measured across the
/// Kanon corpus: 13 type-2 files carry exactly one trailing byte and the
/// corpus-wide maximum residue is 1 (Sweetie HD type-2 files consume their
/// payload exactly). The bound is kept at 1 so an oversized
/// `compressed_size` that would mask genuine framing corruption is still
/// rejected as [`G00ContentValidationError::UnconsumedPayload`]. See the
/// `g00_strict_validator_accepts_real_corpus_both_titles` oracle.
const G00_TYPE2_MAX_TRAILING_PADDING: usize = 1;

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
/// opcode in to anchor the sub-bitmap inside the parent
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
    /// layer ().
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
    /// Decoded pixel buffer in RGBA8 byte order. For type 0 and type 1
    /// the length is exactly `width * height * 4` (one RGBA tuple per
    /// canvas pixel); for type 2 see the canvas-height caveat below.
    /// Types 0 and 1 zero-pad or truncate the LZSS-decoded payload to the
    /// declared canvas size at the decode boundary (a short LZSS payload
    /// is zero-padded to the canvas size *and* surfaces a typed
    /// [`G00Warning::PayloadLengthMismatch`], so the size is never a
    /// silent mismatch). Type-2 — see also
    /// [`G00Image::pixels_rgba_byte_len_full_canvas`] and
    /// [`G00Image::pixels_rgba_byte_len_type2_atlas`]: the buffer's
    /// length is `width * struct.height * 4`, where `struct.height` is
    /// the *expanded* canvas height the decoder wrote onto `self.height`
    /// (the on-disk `height` field, multiplied by `regions.len()` when
    /// every region is the same non-degenerate rectangle — the
    /// "overlaid image" stacking the reference decoder applies before
    /// reconstruction). Downstream consumers MUST read the canvas
    /// height off `self` rather than off the on-disk header; the
    /// on-disk `width × height` is the per-band size, not the final
    /// surface size, for stacked type-2 files.
    pub pixels_rgba: Vec<u8>,
    /// Region table from the on-disk type-2 record. Empty for types 0
    /// and 1.
    pub regions: Vec<G00Region>,
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
    /// requirement (type 0/2: `< width*height*4`; type 1: `< palette
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
    /// The LZSS section header declared a `compressed_size` smaller than
    /// the mandatory 8-byte preamble it is defined to include. Such a
    /// value is internally inconsistent (the compressed region cannot be
    /// smaller than its own header), so the parser rejects it instead of
    /// clamping the implied payload to an empty slice (which would only
    /// surface downstream as a [`G00Warning::PayloadLengthMismatch`]).
    MalformedCompressedSize {
        /// Sub-format whose LZSS header carried the bad size.
        g00_type: G00Type,
        /// The `compressed_size` field read from the header.
        compressed_size: usize,
        /// Minimum well-formed value (the 8-byte preamble length).
        minimum: usize,
    },
}

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

/// Corpus-wide histogram of g00 lead bytes.
///
/// Produced by directory walks over `$GAME/REALLIVEDATA/g00/`. The
/// `acceptance` criterion of calls for this aggregate to
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

mod lzss;
mod validation;

use lzss::{LzssVariant, lzss_decode, parse_lzss_section, rd_u16, rd_u32};

pub use validation::{
    G00ContentValidationError, G00LzssValidation, G00MetadataError, G00PatternGeometry,
    probe_g00_pattern_geometry, validate_g00_lzss_content,
};

#[path = "g00/decode.rs"]
mod decode;
#[path = "g00/implementation.rs"]
mod implementation;

pub use decode::decode_g00;

#[cfg(test)]
#[path = "g00/test_support.rs"]
mod g00_test_support;
#[cfg(test)]
#[path = "g00/tests.rs"]
mod tests;
