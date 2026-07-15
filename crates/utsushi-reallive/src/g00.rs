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
//! record does not store a string; the `objLoadRegion` opcode at
//! supplies names through `Gameexe.ini`-driven
//! cross-references, not through the g00 record itself).
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

impl G00Image {
    /// Expected pixel-buffer byte length for the *final* decoded canvas:
    /// `width * height * 4`. This is the length `pixels_rgba` is sized
    /// to for type 0 and type 1, and for type 2 *as long as you read
    /// `height` off this struct* — `self.height` is the canvas height
    /// the decoder wrote out, which for type-2 stacked regions is the
    /// on-disk `height` * `regions.len()` (NOT the on-disk `height`
    /// the input bytes carried). For the per-band layout (sum of the
    /// original on-disk region rectangles), use
    /// [`Self::pixels_rgba_byte_len_type2_atlas`] instead.
    pub fn pixels_rgba_byte_len_full_canvas(&self) -> usize {
        (self.width as usize)
            .saturating_mul(self.height as usize)
            .saturating_mul(4)
    }

    /// Expected pixel-buffer byte length for a type-2 atlas by the
    /// per-band sum: `sum(region.width * region.height) * 4`. This
    /// matches the on-disk region rectangles *before* the
    /// "overlaid image" stack-multiplies the canvas height. Returns 0
    /// when the image has no regions (which is the well-formed case
    /// only for types 0/1; a type-2 image with zero regions is a
    /// malformed header surfaced by [`decode_g00`]).
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
            G00DecodeError::MalformedCompressedSize {
                g00_type,
                compressed_size,
                minimum,
            } => write!(
                formatter,
                "utsushi.reallive.g00.malformed_compressed_size: \
                 type={g00_type:?} compressed_size={compressed_size} minimum={minimum}"
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

mod validation;

pub use validation::{
    G00ContentValidationError, G00LzssValidation, G00MetadataError, G00PatternGeometry,
    probe_g00_pattern_geometry, validate_g00_lzss_content,
};

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
/// Header: 5-byte preamble + `(u32 compressed_size, u32 uncompressed_size)`
/// LZSS payload. Decoded payload is `width * height * 4` bytes of BGRA pixels
/// reordered to RGBA at the decoder boundary.
fn decode_type0(
    input: &[u8],
    width: u32,
    height: u32,
) -> Result<(G00Image, Vec<G00Warning>), G00DecodeError> {
    let section = parse_lzss_section(input, G00_HEADER_PREAMBLE_BYTE_LEN, G00Type::RawBgr)?;
    let pixel_count = (width as usize).saturating_mul(height as usize);
    // The LZSS output is a flat 24-bpp BGR canvas (`width * height * 3`).
    // The header's `uncompressed_size` field is the *final* 32-bpp size
    // (`width * height * 4`) and is used only for the shortfall warning.
    let bgr_target = pixel_count.saturating_mul(G00_TYPE0_BGR_BYTES_PER_PIXEL);
    let rgba_target = pixel_count.saturating_mul(4);

    let bgr = lzss_decode(section.payload, bgr_target, LzssVariant::Type0Bgr);

    // Expand each decoded BGR triple to RGBA `(R, G, B, 0xff)`.
    let mut pixels_rgba = Vec::with_capacity(rgba_target);
    for triple in bgr.chunks_exact(G00_TYPE0_BGR_BYTES_PER_PIXEL) {
        pixels_rgba.push(triple[2]); // R
        pixels_rgba.push(triple[1]); // G
        pixels_rgba.push(triple[0]); // B
        pixels_rgba.push(0xff); // opaque alpha
    }

    let mut warnings = Vec::new();
    if pixels_rgba.len() != rgba_target {
        // Short LZSS stream: zero-fill to the full canvas and surface a
        // typed warning (never a silent wrong-size buffer).
        warnings.push(G00Warning::PayloadLengthMismatch {
            g00_type: G00Type::RawBgr,
            declared_uncompressed_size: rgba_target as u64,
            observed_payload_size: pixels_rgba.len() as u64,
        });
        pixels_rgba.resize(rgba_target, 0);
    }

    Ok((
        G00Image {
            g00_type: G00Type::RawBgr,
            width,
            height,
            pixels_rgba,
            regions: Vec::new(),
        },
        warnings,
    ))
}

/// Decode a type-1 (8-bpp paletted + LZSS) g00 file.
///
/// Header layout: 5-byte preamble, `u32 LE compressed_size`
/// `u32 LE uncompressed_size`. The LZSS payload decodes to a 1024-byte
/// BGRA palette followed by `width * height` palette indices.
fn decode_type1(
    input: &[u8],
    width: u32,
    height: u32,
) -> Result<(G00Image, Vec<G00Warning>), G00DecodeError> {
    let section = parse_lzss_section(input, G00_HEADER_PREAMBLE_BYTE_LEN, G00Type::PalettedLzss)?;
    let pixel_count = (width as usize).saturating_mul(height as usize);

    // Type-1 LZSS uses the SCN2k token. Its output is a colour table
    // (`u16 LE count`, then `count` × 4-byte BGRA entries) followed by
    // one palette index per pixel. The header target is the declared
    // uncompressed size + 1 (the AVG2000 decoder over-allocates by one).
    let decoded = lzss_decode(
        section.payload,
        section.uncompressed_size.saturating_add(1),
        LzssVariant::Scn2k,
    );

    if decoded.len() < 2 {
        return Err(G00DecodeError::DecodedBufferTooShort {
            g00_type: G00Type::PalettedLzss,
            required_len: 2,
            observed_len: decoded.len(),
        });
    }
    let colortable_len = u16::from_le_bytes([decoded[0], decoded[1]]) as usize;
    let clamped_len = colortable_len.min(256);
    // Palette entries are 4-byte BGRA values; index stream starts after
    // the (raw, unclamped) colour table.
    let indices_start = 2usize.saturating_add(colortable_len.saturating_mul(4));

    let mut pixels_rgba = Vec::with_capacity(pixel_count.saturating_mul(4));
    let mut observed_pixels = 0usize;
    if indices_start <= decoded.len() {
        for &index in &decoded[indices_start..] {
            if observed_pixels >= pixel_count {
                break;
            }
            let idx = index as usize;
            let (r, g, b, a) = if idx < clamped_len {
                let off = 2 + idx * 4;
                // On-disk palette entry byte order is B, G, R, A.
                (
                    decoded[off + 2],
                    decoded[off + 1],
                    decoded[off],
                    decoded[off + 3],
                )
            } else {
                (0, 0, 0, 0)
            };
            pixels_rgba.push(r);
            pixels_rgba.push(g);
            pixels_rgba.push(b);
            pixels_rgba.push(a);
            observed_pixels += 1;
        }
    }

    let mut warnings = Vec::new();
    let rgba_target = pixel_count.saturating_mul(4);
    if pixels_rgba.len() != rgba_target {
        warnings.push(G00Warning::PayloadLengthMismatch {
            g00_type: G00Type::PalettedLzss,
            declared_uncompressed_size: rgba_target as u64,
            observed_payload_size: pixels_rgba.len() as u64,
        });
        pixels_rgba.resize(rgba_target, 0);
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
/// Header layout: 5-byte preamble, `u32 LE region_count`
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

    // "Overlaid image" munge: some newer type-2 files carry N identical
    // full-size region records stacked on top of each other. When every
    // region is the same non-degenerate rectangle, each is given its own
    // vertical band and the canvas height is multiplied, exactly as the
    // reference decoder does before reconstruction.
    let first = &regions[0].rect;
    let all_identical = region_count > 1
        && first.width() > 0
        && first.height() > 0
        && regions
            .iter()
            .all(|r| r.rect == *first && r.origin_x == regions[0].origin_x);
    let mut canvas_height = height as usize;
    if all_identical {
        for (i, region) in regions.iter_mut().enumerate() {
            // `i` and `height` both originate from disk bytes; the band
            // offset (and its accumulation into the region rect) is computed
            // with saturating ops so a hostile region count / height can only
            // push the rect out of the canvas — never overflow i32. A
            // saturated coordinate lands outside `canvas_height` and is
            // skipped by the per-pixel bounds check below.
            let dy = (i as i32).saturating_mul(height as i32);
            region.rect.y1 = region.rect.y1.saturating_add(dy);
            region.rect.y2 = region.rect.y2.saturating_add(dy);
        }
        canvas_height = (height as usize).saturating_mul(region_count);
    }

    let section = parse_lzss_section(input, lzss_preamble_off, G00Type::RegionedLzss)?;
    let decoded = lzss_decode(
        section.payload,
        section.uncompressed_size,
        LzssVariant::Scn2k,
    );

    let mut warnings = Vec::new();
    if decoded.len() != section.uncompressed_size {
        warnings.push(G00Warning::PayloadLengthMismatch {
            g00_type: G00Type::RegionedLzss,
            declared_uncompressed_size: section.uncompressed_size as u64,
            observed_payload_size: decoded.len() as u64,
        });
    }

    // Reconstruct the transparent canvas by blitting each region's
    // tagged 32-bpp sub-bitmaps. The SCN2k output is a container: a
    // per-region `(offset, length)` table (8-byte stride starting at
    // byte 4) followed by region blocks; each block is a `0x74`-byte
    // header then repeated `(0x5c`-byte sub-header + `w*h*4` BGRA
    // pixels`)` records.
    let canvas_w = width as usize;
    let mut pixels_rgba = vec![0u8; canvas_w.saturating_mul(canvas_height).saturating_mul(4)];
    let region_deal2 = rd_u32(&decoded, 0);
    let region_deal = region_count.min(region_deal2);
    for (i, region) in regions.iter().enumerate().take(region_deal) {
        let offset = rd_u32(&decoded, 4 + i * 8);
        let length = rd_u32(&decoded, 8 + i * 8);
        let block_start = offset.saturating_add(0x74);
        let block_end = offset.saturating_add(length).min(decoded.len());
        let mut src = block_start;
        while src.saturating_add(0x5c) <= block_end {
            let bx = rd_u16(&decoded, src) as i32;
            let by = rd_u16(&decoded, src + 2) as i32;
            let sw = rd_u16(&decoded, src + 6);
            let sh = rd_u16(&decoded, src + 8);
            src += 0x5c;
            // `bx`/`by` (sub-bitmap offsets) and `region.rect.{x1,y1}` are
            // all read verbatim from disk; sum with saturating ops so a
            // corrupt/out-of-range region can only saturate to i32::MIN/MAX
            // (skipped by the bounds check), never wrap into a wrong pixel.
            let dst_x = bx.saturating_add(region.rect.x1);
            let dst_y = by.saturating_add(region.rect.y1);
            let sub_pixels = sw.saturating_mul(sh);
            for row in 0..sh {
                for col in 0..sw {
                    let s = src + (row * sw + col) * 4;
                    if s + 4 > decoded.len() {
                        continue;
                    }
                    let px = dst_x.saturating_add(col as i32);
                    let py = dst_y.saturating_add(row as i32);
                    if px < 0 || py < 0 || px as usize >= canvas_w || py as usize >= canvas_height {
                        continue;
                    }
                    let d = ((py as usize) * canvas_w + px as usize) * 4;
                    // Sub-bitmap pixel byte order is B, G, R, A.
                    pixels_rgba[d] = decoded[s + 2];
                    pixels_rgba[d + 1] = decoded[s + 1];
                    pixels_rgba[d + 2] = decoded[s];
                    pixels_rgba[d + 3] = decoded[s + 3];
                }
            }
            src = src.saturating_add(sub_pixels.saturating_mul(4));
        }
    }

    Ok((
        G00Image {
            g00_type: G00Type::RegionedLzss,
            width,
            height: canvas_height as u32,
            pixels_rgba,
            regions,
        },
        warnings,
    ))
}

/// Parse the LZSS section preamble at offset `preamble_off` into a
/// typed [`LzssSection`].
fn parse_lzss_section(
    input: &[u8],
    preamble_off: usize,
    g00_type: G00Type,
) -> Result<LzssSection<'_>, G00DecodeError> {
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
    // `compressed_size` is defined to include the 8-byte preamble, so a
    // value below the preamble length is internally inconsistent. Reject
    // it with a typed error rather than letting the `.max(payload_start)`
    // clamp below hide the malformed header behind an empty payload that
    // only surfaces as a downstream PayloadLengthMismatch warning.
    if compressed_size < 8 {
        return Err(G00DecodeError::MalformedCompressedSize {
            g00_type,
            compressed_size,
            minimum: 8,
        });
    }
    // `compressed_size` includes the 8-byte preamble itself.
    let declared_payload_end = preamble_off.saturating_add(compressed_size);
    let payload_end = declared_payload_end.min(input.len()).max(payload_start);
    Ok(LzssSection {
        payload: &input[payload_start..payload_end],
        uncompressed_size,
    })
}

/// Read a little-endian `u16` at `off`, or `0` if it runs past the end.
fn rd_u16(buf: &[u8], off: usize) -> usize {
    if off + 2 <= buf.len() {
        (buf[off] as usize) | ((buf[off + 1] as usize) << 8)
    } else {
        0
    }
}

/// Read a little-endian `u32` at `off`, or `0` if it runs past the end.
fn rd_u32(buf: &[u8], off: usize) -> usize {
    if off + 4 <= buf.len() {
        (buf[off] as usize)
            | ((buf[off + 1] as usize) << 8)
            | ((buf[off + 2] as usize) << 16)
            | ((buf[off + 3] as usize) << 24)
    } else {
        0
    }
}

/// The two g00 LZSS token layouts. Both share the flag structure
/// (8-bit flag byte, LSB-first, `bit = 1` → literal, `bit = 0` →
/// back-reference) and both encode the back-reference as a relative
/// back-distance into the already-emitted output (no ring buffer).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LzssVariant {
    /// Type-0 24-bpp BGR: literal = 3 bytes; token `t` →
    /// `distance = (t >> 4) * 3`, `length = ((t & 0x0f) + 1) * 3`.
    Type0Bgr,
    /// AVG2000 ("SCN2k"), used by types 1 and 2: literal = 1 byte;
    /// token `t` → `distance = (t >> 4)`, `length = (t & 0x0f) + 2`.
    Scn2k,
}

impl LzssVariant {
    /// Bytes copied per literal token.
    fn literal_unit(self) -> usize {
        match self {
            LzssVariant::Type0Bgr => 3,
            LzssVariant::Scn2k => 1,
        }
    }

    /// Split a 16-bit back-reference token into `(distance, length)` in
    /// bytes.
    fn split_token(self, t: usize) -> (usize, usize) {
        match self {
            LzssVariant::Type0Bgr => ((t >> 4) * 3, ((t & 0x0f) + 1) * 3),
            LzssVariant::Scn2k => (t >> 4, (t & 0x0f) + 2),
        }
    }
}

/// Decode a RealLive/AVG32 g00 LZSS stream into `out_size` bytes.
///
/// The control structure is an 8-bit flag byte read LSB-first: a set
/// bit emits a literal (`variant.literal_unit()` bytes copied straight
/// from the input); a clear bit consumes a 2-byte little-endian token
/// that copies `length` bytes from `distance` bytes back in the output
/// produced so far (overlapping copies are byte-by-byte, so a short
/// distance is a run-fill). There is no ring buffer — the history is the
/// output itself, initially empty.
///
/// The decoder stops the instant `out_size` is reached, so it never
/// overruns; when the input is exhausted first (or a token references an
/// impossible distance) it returns the partial output. Callers compare
/// `out.len()` against their expected size and surface a typed
/// [`G00Warning::PayloadLengthMismatch`] on a shortfall — the length
/// adjustment is never silent.
fn lzss_decode(input: &[u8], out_size: usize, variant: LzssVariant) -> Vec<u8> {
    // Cap the preallocation: `out_size` is derived from attacker-controlled
    // header fields, but each input byte expands to a bounded number of
    // output bytes, so bound the reservation by the input length. The vector
    // still grows incrementally, so this never changes the decoded result.
    let per_byte = match variant {
        LzssVariant::Type0Bgr => 45, // max token length (((0x0f)+1)*3) per 2 input bytes ≈ 24; be generous
        LzssVariant::Scn2k => 17,
    };
    let initial_capacity = out_size.min(input.len().saturating_mul(per_byte));
    let mut dst: Vec<u8> = Vec::with_capacity(initial_capacity);
    let unit = variant.literal_unit();
    let mut src = 0usize;

    'outer: while dst.len() < out_size && src < input.len() {
        let flag = input[src];
        src += 1;
        for bit in 0..8 {
            if dst.len() >= out_size {
                break 'outer;
            }
            if src >= input.len() {
                break 'outer;
            }
            if (flag >> bit) & 1 == 1 {
                // Literal: copy `unit` bytes straight through.
                for _ in 0..unit {
                    if src >= input.len() || dst.len() >= out_size {
                        break;
                    }
                    dst.push(input[src]);
                    src += 1;
                }
            } else {
                if src + 2 > input.len() {
                    break 'outer;
                }
                let token = (input[src] as usize) | ((input[src + 1] as usize) << 8);
                src += 2;
                let (distance, length) = variant.split_token(token);
                if distance == 0 || distance > dst.len() {
                    // Impossible back-reference (empty or over-long history):
                    // stop rather than fabricate bytes. Surfaces as a
                    // PayloadLengthMismatch at the caller.
                    break 'outer;
                }
                let start = dst.len() - distance;
                for k in 0..length {
                    if dst.len() >= out_size {
                        break;
                    }
                    let byte = dst[start + k];
                    dst.push(byte);
                }
            }
        }
    }

    dst
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Encode a byte stream as an all-literal g00 LZSS stream for the
    /// given variant (`bit = 1` → literal). Because the decoder stops the
    /// instant `out_size` is reached, the trailing (clear) bits of a
    /// partial final flag group are never interpreted as tokens, so this
    /// round-trips for any length.
    fn encode_all_literals(bytes: &[u8], variant: LzssVariant) -> Vec<u8> {
        let unit = variant.literal_unit();
        assert_eq!(bytes.len() % unit, 0, "literal payload must be whole units");
        let units: Vec<&[u8]> = bytes.chunks_exact(unit).collect();
        let mut out = Vec::new();
        let mut i = 0;
        while i < units.len() {
            let end = (i + 8).min(units.len());
            let count = end - i;
            let flag: u8 = if count == 8 { 0xff } else { (1u8 << count) - 1 };
            out.push(flag);
            for u in &units[i..end] {
                out.extend_from_slice(u);
            }
            i = end;
        }
        out
    }

    #[test]
    fn lzss_type0_all_literals_round_trip() {
        let bgr: Vec<u8> = (0..24u8).collect(); // 8 BGR pixels
        let enc = encode_all_literals(&bgr, LzssVariant::Type0Bgr);
        let out = lzss_decode(&enc, bgr.len(), LzssVariant::Type0Bgr);
        assert_eq!(out, bgr);
    }

    #[test]
    fn lzss_scn2k_all_literals_round_trip() {
        let data: Vec<u8> = (0..20u8).collect();
        let enc = encode_all_literals(&data, LzssVariant::Scn2k);
        let out = lzss_decode(&enc, data.len(), LzssVariant::Scn2k);
        assert_eq!(out, data);
    }

    #[test]
    fn lzss_type0_backreference_repeats_first_pixel() {
        // 4 BGR pixels; the 4th is a back-reference to the 1st.
        // Flag 0b0000_0111: bits 0,1,2 literal (3 pixels), bit 3 backref.
        let mut enc = vec![0b0000_0111u8];
        enc.extend_from_slice(&[0x11, 0x22, 0x33]); // pixel 0
        enc.extend_from_slice(&[0x44, 0x55, 0x66]); // pixel 1
        enc.extend_from_slice(&[0x77, 0x88, 0x99]); // pixel 2
        // token: distance = 3*3 = 9 bytes back, length = 3 bytes.
        // t = (distance/3)<<4 | (length/3 - 1) = (3<<4)|0 = 0x30.
        enc.extend_from_slice(&[0x30, 0x00]);
        let out = lzss_decode(&enc, 12, LzssVariant::Type0Bgr);
        assert_eq!(out.len(), 12);
        assert_eq!(&out[0..3], &[0x11, 0x22, 0x33]);
        assert_eq!(
            &out[9..12],
            &[0x11, 0x22, 0x33],
            "backref reproduced pixel 0"
        );
    }

    #[test]
    fn lzss_scn2k_backreference_run_fill() {
        // literal 0xAB, then a token: distance 1, length 5 → run-fill.
        // token t: distance = t>>4 = 1, length = (t&0xf)+2 = 5 → t&0xf = 3.
        // t = (1<<4)|3 = 0x13 → lo=0x13, hi=0x00.
        let enc = vec![0b0000_0001u8, 0xAB, 0x13, 0x00];
        let out = lzss_decode(&enc, 6, LzssVariant::Scn2k);
        assert_eq!(out, vec![0xAB; 6]);
    }

    /// Assemble a type-0 g00 file from a BGR canvas (all-literal LZSS).
    fn synth_type0(width: u16, height: u16, bgr: &[u8]) -> Vec<u8> {
        assert_eq!(bgr.len(), width as usize * height as usize * 3);
        let lzss = encode_all_literals(bgr, LzssVariant::Type0Bgr);
        let mut bytes = vec![G00_TYPE_RAW_BGR];
        bytes.extend_from_slice(&width.to_le_bytes());
        bytes.extend_from_slice(&height.to_le_bytes());
        let compressed_size = (lzss.len() + 8) as u32;
        let uncompressed_size = (width as u32) * (height as u32) * 4; // final 32-bpp size
        bytes.extend_from_slice(&compressed_size.to_le_bytes());
        bytes.extend_from_slice(&uncompressed_size.to_le_bytes());
        bytes.extend_from_slice(&lzss);
        bytes
    }

    fn type0_with(payload: &[u8], declared_output: u32) -> Vec<u8> {
        let mut bytes = vec![G00_TYPE_RAW_BGR, 1, 0, 1, 0];
        bytes.extend_from_slice(&((payload.len() + 8) as u32).to_le_bytes());
        bytes.extend_from_slice(&declared_output.to_le_bytes());
        bytes.extend_from_slice(payload);
        bytes
    }

    #[test]
    fn content_validator_rejects_strict_framing_and_token_failures() {
        let err = |bytes: &[u8]| validate_g00_lzss_content(bytes).unwrap_err();
        assert!(matches!(
            err(&[0; 4]),
            G00ContentValidationError::TruncatedPreamble
        ));
        assert!(matches!(
            err(&[3; 5]),
            G00ContentValidationError::UnknownType
        ));
        assert!(matches!(
            err(&[0; 5]),
            G00ContentValidationError::HeaderBounds { .. }
        ));
        let mut type2 = vec![G00_TYPE_REGIONED_LZSS, 0, 0, 0, 0];
        type2.extend_from_slice(&1u32.to_le_bytes());
        assert!(matches!(
            err(&type2),
            G00ContentValidationError::HeaderBounds { .. }
        ));
        let mut malformed = type0_with(&[7, 1, 2, 3], 4);
        malformed[5..9].copy_from_slice(&4u32.to_le_bytes());
        assert!(matches!(
            err(&malformed),
            G00ContentValidationError::InvalidCompressedSize
        ));
        let mut outer = type0_with(&[7, 1, 2, 3], 4);
        outer[5..9].copy_from_slice(&13u32.to_le_bytes());
        assert!(matches!(
            err(&outer),
            G00ContentValidationError::OuterLengthMismatch { .. }
        ));
        assert!(matches!(
            err(&type0_with(&[7, 1, 2, 3], 3)),
            G00ContentValidationError::DeclaredOutputMismatch { .. }
        ));
        assert!(matches!(
            err(&type0_with(&[1], 4)),
            G00ContentValidationError::TruncatedLiteral { .. }
        ));
        assert!(matches!(
            err(&type0_with(&[0, 0], 4)),
            G00ContentValidationError::TruncatedBackreference { .. }
        ));
        assert!(matches!(
            err(&type0_with(&[0, 0, 0], 4)),
            G00ContentValidationError::InvalidDistance { .. }
        ));
        let mut type1 = vec![G00_TYPE_PALETTED_LZSS, 0, 0, 0, 0];
        type1.extend_from_slice(&12u32.to_le_bytes());
        type1.extend_from_slice(&1u32.to_le_bytes());
        type1.extend_from_slice(&[1, 0xaa, 0x10, 0]);
        assert!(matches!(
            err(&type1),
            G00ContentValidationError::OutputOverrun { .. }
        ));
        assert!(matches!(
            err(&type0_with(&[], 4)),
            G00ContentValidationError::OutputUnderrun { .. }
        ));
        let mut trailing = type0_with(&[1, 1, 2, 3], 4);
        trailing.push(0);
        let compressed_size = (trailing.len() - 5) as u32;
        trailing[5..9].copy_from_slice(&compressed_size.to_le_bytes());
        assert!(matches!(
            err(&trailing),
            G00ContentValidationError::UnconsumedPayload { .. }
        ));
    }

    #[test]
    fn truncated_preamble_is_typed_error() {
        let err = decode_g00(&[0u8; 3]).expect_err("3-byte input is too short");
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
        let bytes = [0x42u8, 0x00, 0x00, 0x00, 0x00];
        let err = decode_g00(&bytes).expect_err("lead byte 0x42 must be rejected");
        match err {
            G00DecodeError::UnknownType { observed } => assert_eq!(observed, 0x42),
            other => panic!("expected UnknownType, got: {other:?}"),
        }
    }

    #[test]
    fn parse_lzss_section_rejects_compressed_size_below_preamble() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&4u32.to_le_bytes()); // compressed_size = 4 (< 8)
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&[0u8; 4]);
        let err = parse_lzss_section(&bytes, 0, G00Type::RawBgr)
            .expect_err("compressed_size < 8 must be rejected");
        match err {
            G00DecodeError::MalformedCompressedSize {
                g00_type,
                compressed_size,
                minimum,
            } => {
                assert_eq!(g00_type, G00Type::RawBgr);
                assert_eq!(compressed_size, 4);
                assert_eq!(minimum, 8);
            }
            other => panic!("expected MalformedCompressedSize, got: {other:?}"),
        }
    }

    #[test]
    fn type0_decodes_bgr_to_rgba_with_opaque_alpha() {
        // 2 BGR pixels: (B=10,G=20,R=30), (B=50,G=60,R=70).
        let bgr = [10u8, 20, 30, 50, 60, 70];
        let bytes = synth_type0(2, 1, &bgr);
        let (image, warnings) = decode_g00(&bytes).expect("type-0 must decode");
        assert_eq!(image.g00_type, G00Type::RawBgr);
        assert_eq!(image.width, 2);
        assert_eq!(image.height, 1);
        assert_eq!(image.pixels_rgba.len(), 2 * 4);
        // BGR (10,20,30) -> RGBA (30,20,10,255).
        assert_eq!(&image.pixels_rgba[..4], &[30, 20, 10, 0xff]);
        assert_eq!(&image.pixels_rgba[4..], &[70, 60, 50, 0xff]);
        assert!(image.regions.is_empty());
        assert!(
            warnings.is_empty(),
            "clean round trip must not warn: {warnings:?}"
        );
        let validation = validate_g00_lzss_content(&bytes).unwrap();
        assert_eq!(
            (
                validation.g00_type,
                validation.region_count,
                validation.payload_bytes,
                validation.emitted_count
            ),
            (G00Type::RawBgr, 0, 7, 6)
        );
    }

    #[test]
    fn type0_bgr_byte_order_is_not_treated_as_rgb() {
        // B != R so a silent skip of the reorder is observable.
        let bgr = [0x11u8, 0x22, 0x33]; // B=0x11, G=0x22, R=0x33
        let bytes = synth_type0(1, 1, &bgr);
        let (image, _) = decode_g00(&bytes).expect("type-0 must decode");
        assert_eq!(image.pixels_rgba[0], 0x33, "R slot holds on-disk R (not B)");
        assert_eq!(image.pixels_rgba[1], 0x22, "G slot holds on-disk G");
        assert_eq!(image.pixels_rgba[2], 0x11, "B slot holds on-disk B");
        assert_eq!(image.pixels_rgba[3], 0xff, "alpha is opaque");
    }

    #[test]
    fn type0_short_stream_pads_and_warns_not_silent() {
        // Declare a 4x1 canvas but supply LZSS for only 1 pixel.
        let bgr = [1u8, 2, 3];
        let lzss = encode_all_literals(&bgr, LzssVariant::Type0Bgr);
        let mut bytes = vec![G00_TYPE_RAW_BGR];
        bytes.extend_from_slice(&4u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&((lzss.len() + 8) as u32).to_le_bytes());
        bytes.extend_from_slice(&(4u32 * 4).to_le_bytes()); // 4x1 canvas * 4 bytes
        bytes.extend_from_slice(&lzss);
        let (image, warnings) = decode_g00(&bytes).expect("short type-0 decodes best-effort");
        assert_eq!(image.pixels_rgba.len(), 4 * 4, "padded to full canvas");
        assert!(
            warnings.iter().any(|w| matches!(
                w,
                G00Warning::PayloadLengthMismatch {
                    g00_type: G00Type::RawBgr,
                    ..
                }
            )),
            "short stream must surface PayloadLengthMismatch; got {warnings:?}",
        );
        assert!(validate_g00_lzss_content(&bytes).is_err());
    }

    #[test]
    fn type1_synthetic_palette_round_trip() {
        // SCN2k container: u16 colortable_len=2, then 2 BGRA entries
        // then indices [0,1] for a 2x1 image.
        let mut decoded = Vec::new();
        decoded.extend_from_slice(&2u16.to_le_bytes());
        decoded.extend_from_slice(&[0x00, 0x00, 0xff, 0xff]); // idx0 B,G,R,A = red
        decoded.extend_from_slice(&[0x00, 0xff, 0x00, 0xff]); // idx1 = green
        decoded.extend_from_slice(&[0, 1]); // indices
        let lzss = encode_all_literals(&decoded, LzssVariant::Scn2k);
        let mut file = vec![G00_TYPE_PALETTED_LZSS];
        file.extend_from_slice(&2u16.to_le_bytes());
        file.extend_from_slice(&1u16.to_le_bytes());
        file.extend_from_slice(&((lzss.len() + 8) as u32).to_le_bytes());
        // uncompressed_size: Jagarl decodes to declared+1; declared = decoded.len()-1.
        file.extend_from_slice(&((decoded.len() - 1) as u32).to_le_bytes());
        file.extend_from_slice(&lzss);
        let (image, warnings) = decode_g00(&file).expect("synthetic type-1 must decode");
        assert_eq!(image.g00_type, G00Type::PalettedLzss);
        assert_eq!(image.pixels_rgba.len(), 8);
        assert_eq!(
            &image.pixels_rgba[..4],
            &[0xff, 0x00, 0x00, 0xff],
            "idx0 red"
        );
        assert_eq!(
            &image.pixels_rgba[4..],
            &[0x00, 0xff, 0x00, 0xff],
            "idx1 green"
        );
        assert!(
            warnings.is_empty(),
            "clean type-1 must not warn: {warnings:?}"
        );
        assert_eq!(
            validate_g00_lzss_content(&file).unwrap().emitted_count,
            decoded.len()
        );
    }

    #[test]
    fn type2_zero_regions_is_typed_error() {
        let mut bytes = vec![G00_TYPE_REGIONED_LZSS];
        bytes.extend_from_slice(&100u16.to_le_bytes());
        bytes.extend_from_slice(&50u16.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&[0u8; 8]);
        let err = decode_g00(&bytes).expect_err("zero-region type-2 must error");
        assert!(matches!(err, G00DecodeError::Type2ZeroRegions));
        assert!(matches!(
            validate_g00_lzss_content(&bytes),
            Err(G00ContentValidationError::Type2ZeroRegions)
        ));
    }

    /// Build a minimal but format-faithful type-2 container + file for a
    /// `w`×`h` canvas with one full-canvas region whose sub-bitmap pixels
    /// are `bgra`.
    fn synth_type2(w: u16, h: u16, bgra: &[u8]) -> Vec<u8> {
        let wh4 = w as usize * h as usize * 4;
        assert_eq!(bgra.len(), wh4);
        // Container: [u32 region_deal2=1][u32 offset=12][u32 length]
        //            [0x74 header][0x5c subheader][w*h*4 pixels]
        let offset = 12usize;
        let block_len = 0x74 + 0x5c + wh4;
        let length = block_len;
        let mut unc = Vec::new();
        unc.extend_from_slice(&1u32.to_le_bytes()); // region_deal2
        unc.extend_from_slice(&(offset as u32).to_le_bytes()); // offset@4
        unc.extend_from_slice(&(length as u32).to_le_bytes()); // length@8
        assert_eq!(unc.len(), offset);
        unc.extend_from_slice(&[0u8; 0x74]); // region block header
        let mut sub = vec![0u8; 0x5c];
        sub[0..2].copy_from_slice(&0u16.to_le_bytes()); // x
        sub[2..4].copy_from_slice(&0u16.to_le_bytes()); // y
        sub[6..8].copy_from_slice(&w.to_le_bytes()); // w
        sub[8..10].copy_from_slice(&h.to_le_bytes()); // h
        unc.extend_from_slice(&sub);
        unc.extend_from_slice(bgra);
        let uncompressed_size = unc.len();

        let lzss = encode_all_literals(&unc, LzssVariant::Scn2k);
        let mut bytes = vec![G00_TYPE_REGIONED_LZSS];
        bytes.extend_from_slice(&w.to_le_bytes());
        bytes.extend_from_slice(&h.to_le_bytes());
        bytes.extend_from_slice(&1u32.to_le_bytes()); // region_count
        // region record: x1,y1,x2,y2,origin_x,origin_y
        bytes.extend_from_slice(&0i32.to_le_bytes());
        bytes.extend_from_slice(&0i32.to_le_bytes());
        bytes.extend_from_slice(&((w as i32) - 1).to_le_bytes());
        bytes.extend_from_slice(&((h as i32) - 1).to_le_bytes());
        bytes.extend_from_slice(&0i32.to_le_bytes());
        bytes.extend_from_slice(&0i32.to_le_bytes());
        bytes.extend_from_slice(&((lzss.len() + 8) as u32).to_le_bytes());
        bytes.extend_from_slice(&(uncompressed_size as u32).to_le_bytes());
        bytes.extend_from_slice(&lzss);
        bytes
    }

    fn append_type2_region(
        mut bytes: Vec<u8>,
        rect: (i32, i32, i32, i32),
        origin: (i32, i32),
    ) -> Vec<u8> {
        let mut record = Vec::new();
        for value in [rect.0, rect.1, rect.2, rect.3, origin.0, origin.1] {
            record.extend_from_slice(&value.to_le_bytes());
        }
        bytes.splice(33..33, record);
        bytes[5..9].copy_from_slice(&2u32.to_le_bytes());
        bytes
    }

    #[test]
    fn pattern_geometry_reads_header_patterns_and_rlvm_fallback() {
        let type0 = synth_type0(2, 1, &[1, 2, 3, 4, 5, 6]);
        assert_eq!(
            probe_g00_pattern_geometry(&type0, 7).unwrap(),
            G00PatternGeometry {
                g00_type: G00Type::RawBgr,
                pattern_count: 1,
                selected_pattern: 0,
                width: 2,
                height: 1,
                origin_x: 0,
                origin_y: 0,
            }
        );
        let mut type1 = vec![G00_TYPE_PALETTED_LZSS, 4, 0, 3, 0];
        type1.extend_from_slice(&10u32.to_le_bytes());
        type1.extend_from_slice(&0u32.to_le_bytes());
        type1.extend_from_slice(&[1, 0]);
        assert_eq!(
            probe_g00_pattern_geometry(&type1, 7).unwrap(),
            G00PatternGeometry {
                g00_type: G00Type::PalettedLzss,
                pattern_count: 1,
                selected_pattern: 0,
                width: 4,
                height: 3,
                origin_x: 0,
                origin_y: 0,
            }
        );
        let type2 = append_type2_region(synth_type2(2, 1, &[0; 8]), (3, -2, 5, 1), (7, -9));
        let selected = probe_g00_pattern_geometry(&type2, 1).unwrap();
        assert_eq!(
            (
                selected.pattern_count,
                selected.selected_pattern,
                selected.width,
                selected.height,
                selected.origin_x,
                selected.origin_y
            ),
            (2, 1, 3, 4, 7, -9)
        );
        let fallback = probe_g00_pattern_geometry(&type2, 9).unwrap();
        assert_eq!(
            (
                fallback.selected_pattern,
                fallback.width,
                fallback.height,
                fallback.origin_x,
                fallback.origin_y
            ),
            (0, 2, 1, 0, 0)
        );
    }

    #[test]
    fn pattern_geometry_rejects_invalid_or_unvalidated_metadata() {
        let inverted = append_type2_region(synth_type2(1, 1, &[0; 4]), (2, 0, 1, 0), (0, 0));
        assert!(matches!(
            probe_g00_pattern_geometry(&inverted, 1),
            Err(G00MetadataError::InvertedRegion { pattern: 1 })
        ));
        let overflow = append_type2_region(
            synth_type2(1, 1, &[0; 4]),
            (i32::MIN, 0, i32::MAX, 0),
            (0, 0),
        );
        assert!(matches!(
            probe_g00_pattern_geometry(&overflow, 1),
            Err(G00MetadataError::RegionDimensionOverflow { pattern: 1 })
        ));
        let truncated_table = [G00_TYPE_REGIONED_LZSS, 0, 0, 0, 0, 1, 0, 0, 0];
        assert!(matches!(
            probe_g00_pattern_geometry(&truncated_table, 0),
            Err(G00MetadataError::Validator(
                G00ContentValidationError::HeaderBounds { .. }
            ))
        ));
        let zero_table = [G00_TYPE_REGIONED_LZSS, 0, 0, 0, 0, 0, 0, 0, 0];
        assert!(matches!(
            probe_g00_pattern_geometry(&zero_table, 0),
            Err(G00MetadataError::Validator(
                G00ContentValidationError::Type2ZeroRegions
            ))
        ));
        assert!(matches!(
            probe_g00_pattern_geometry(&type0_with(&[1], 4), 0),
            Err(G00MetadataError::Validator(
                G00ContentValidationError::TruncatedLiteral { .. }
            ))
        ));
    }

    /// Like [`synth_type2`] but with a caller-chosen region rectangle and
    /// sub-bitmap top-left, so a test can drive out-of-range coordinates
    /// through the region-blit arithmetic (`dst = sub_xy + region.rect`).
    fn synth_type2_region(
        w: u16,
        h: u16,
        bgra: &[u8],
        rect: (i32, i32, i32, i32),
        sub_xy: (u16, u16),
    ) -> Vec<u8> {
        let wh4 = w as usize * h as usize * 4;
        assert_eq!(bgra.len(), wh4);
        let offset = 12usize;
        let block_len = 0x74 + 0x5c + wh4;
        let length = block_len;
        let mut unc = Vec::new();
        unc.extend_from_slice(&1u32.to_le_bytes()); // region_deal2
        unc.extend_from_slice(&(offset as u32).to_le_bytes()); // offset@4
        unc.extend_from_slice(&(length as u32).to_le_bytes()); // length@8
        unc.extend_from_slice(&[0u8; 0x74]); // region block header
        let mut sub = vec![0u8; 0x5c];
        sub[0..2].copy_from_slice(&sub_xy.0.to_le_bytes()); // sub x (bx)
        sub[2..4].copy_from_slice(&sub_xy.1.to_le_bytes()); // sub y (by)
        sub[6..8].copy_from_slice(&w.to_le_bytes()); // w
        sub[8..10].copy_from_slice(&h.to_le_bytes()); // h
        unc.extend_from_slice(&sub);
        unc.extend_from_slice(bgra);
        let uncompressed_size = unc.len();

        let lzss = encode_all_literals(&unc, LzssVariant::Scn2k);
        let mut bytes = vec![G00_TYPE_REGIONED_LZSS];
        bytes.extend_from_slice(&w.to_le_bytes());
        bytes.extend_from_slice(&h.to_le_bytes());
        bytes.extend_from_slice(&1u32.to_le_bytes()); // region_count
        bytes.extend_from_slice(&rect.0.to_le_bytes()); // x1
        bytes.extend_from_slice(&rect.1.to_le_bytes()); // y1
        bytes.extend_from_slice(&rect.2.to_le_bytes()); // x2
        bytes.extend_from_slice(&rect.3.to_le_bytes()); // y2
        bytes.extend_from_slice(&0i32.to_le_bytes()); // origin_x
        bytes.extend_from_slice(&0i32.to_le_bytes()); // origin_y
        bytes.extend_from_slice(&((lzss.len() + 8) as u32).to_le_bytes());
        bytes.extend_from_slice(&(uncompressed_size as u32).to_le_bytes());
        bytes.extend_from_slice(&lzss);
        bytes
    }

    /// Build a type-2 container carrying TWO identical full-canvas region
    /// records whose rect `y1 == y2 == region_y`, exercising the
    /// "overlaid image" band-offset accumulation (`region.rect.y1 += dy`).
    fn synth_type2_two_identical_regions(w: u16, h: u16, region_y: i32) -> Vec<u8> {
        let wh4 = w as usize * h as usize * 4;
        let bgra = vec![0u8; wh4]; // transparent sub-bitmaps
        let block = || {
            let mut b = Vec::new();
            b.extend_from_slice(&[0u8; 0x74]); // block header
            let mut sub = vec![0u8; 0x5c];
            sub[6..8].copy_from_slice(&w.to_le_bytes());
            sub[8..10].copy_from_slice(&h.to_le_bytes());
            b.extend_from_slice(&sub);
            b.extend_from_slice(&bgra);
            b
        };
        let b0 = block();
        let b1 = block();
        let table_len = 4 + 8 * 2; // region_deal2 + two (offset,length) pairs
        let off0 = table_len;
        let off1 = off0 + b0.len();
        let mut unc = Vec::new();
        unc.extend_from_slice(&2u32.to_le_bytes()); // region_deal2
        unc.extend_from_slice(&(off0 as u32).to_le_bytes());
        unc.extend_from_slice(&(b0.len() as u32).to_le_bytes());
        unc.extend_from_slice(&(off1 as u32).to_le_bytes());
        unc.extend_from_slice(&(b1.len() as u32).to_le_bytes());
        unc.extend_from_slice(&b0);
        unc.extend_from_slice(&b1);
        let uncompressed_size = unc.len();

        let lzss = encode_all_literals(&unc, LzssVariant::Scn2k);
        let mut bytes = vec![G00_TYPE_REGIONED_LZSS];
        bytes.extend_from_slice(&w.to_le_bytes());
        bytes.extend_from_slice(&h.to_le_bytes());
        bytes.extend_from_slice(&2u32.to_le_bytes()); // region_count
        for _ in 0..2 {
            bytes.extend_from_slice(&0i32.to_le_bytes()); // x1
            bytes.extend_from_slice(&region_y.to_le_bytes()); // y1
            bytes.extend_from_slice(&((w as i32) - 1).to_le_bytes()); // x2
            bytes.extend_from_slice(&region_y.to_le_bytes()); // y2 == y1 (height 1)
            bytes.extend_from_slice(&0i32.to_le_bytes()); // origin_x
            bytes.extend_from_slice(&0i32.to_le_bytes()); // origin_y
        }
        bytes.extend_from_slice(&((lzss.len() + 8) as u32).to_le_bytes());
        bytes.extend_from_slice(&(uncompressed_size as u32).to_le_bytes());
        bytes.extend_from_slice(&lzss);
        bytes
    }

    #[test]
    fn type2_region_coordinate_overflow_is_skipped_not_panicking() {
        // The region's `x1` sits at i32::MAX and the sub-bitmap top-left is
        // non-zero, so the OLD unchecked `bx + region.rect.x1` (and the
        // per-pixel `dst_x + col`) OVERFLOW i32 — a panic under debug
        // `overflow-checks`, a silent wraparound into a wrong pixel under
        // release. Saturating arithmetic clamps the destination to i32::MAX
        // which the bounds check rejects, so the corrupt region writes
        // NOTHING and the canvas stays fully transparent — no panic, no OOB.
        let bgra = [0x11u8, 0x22, 0x33, 0xff, 0x44, 0x55, 0x66, 0x77];
        let bytes = synth_type2_region(2, 1, &bgra, (i32::MAX, 0, 1, 0), (1, 0));
        let (image, _warnings) = decode_g00(&bytes).expect("decode must not panic");
        assert_eq!(image.width, 2);
        assert_eq!(image.height, 1);
        assert_eq!(image.pixels_rgba.len(), 2 * 4);
        assert!(
            image.pixels_rgba.iter().all(|&b| b == 0),
            "out-of-range region must not write any pixel (stays transparent)"
        );
    }

    #[test]
    fn type2_band_offset_overflow_is_saturated_not_panicking() {
        // Two identical regions whose rect `y1 == y2 == i32::MAX`. The
        // "overlaid image" munge accumulates a per-band `dy` into each
        // region's `y1`/`y2`; for the second band the OLD `region.rect.y1 +=
        // dy` OVERFLOWS i32 (panic under debug overflow-checks). Saturating
        // accumulation clamps to i32::MAX and the band is skipped by the
        // per-pixel bounds check — decode completes, no panic, no OOB.
        let bytes = synth_type2_two_identical_regions(2, 1, i32::MAX);
        let (image, _warnings) = decode_g00(&bytes).expect("decode must not panic");
        assert_eq!(image.width, 2);
        // Overlaid-image munge doubles the canvas height (2 bands × h=1).
        assert_eq!(image.regions.len(), 2);
        assert!(
            image.pixels_rgba.iter().all(|&b| b == 0),
            "out-of-range bands must not write any pixel"
        );
    }

    #[test]
    fn type2_synthetic_region_container_round_trip() {
        // 2x1 canvas, first pixel BGRA (0x11,0x22,0x33,0xff).
        let bgra = [0x11u8, 0x22, 0x33, 0xff, 0x44, 0x55, 0x66, 0x77];
        let bytes = synth_type2(2, 1, &bgra);
        let (image, warnings) = decode_g00(&bytes).expect("type-2 must decode");
        assert_eq!(image.g00_type, G00Type::RegionedLzss);
        assert_eq!(image.width, 2);
        assert_eq!(image.height, 1);
        assert_eq!(image.regions.len(), 1);
        assert_eq!(image.regions[0].rect.width(), 2);
        assert_eq!(image.pixels_rgba.len(), 2 * 4);
        // BGRA (0x11,0x22,0x33,0xff) -> RGBA (0x33,0x22,0x11,0xff).
        assert_eq!(&image.pixels_rgba[..4], &[0x33, 0x22, 0x11, 0xff]);
        assert_eq!(&image.pixels_rgba[4..], &[0x66, 0x55, 0x44, 0x77]);
        assert!(
            warnings.is_empty(),
            "clean type-2 must not warn: {warnings:?}"
        );
        assert_eq!(validate_g00_lzss_content(&bytes).unwrap().region_count, 1);
    }

    #[test]
    fn type2_region_off_by_one_inclusive_bound() {
        let rect = G00Rect {
            x1: 0,
            y1: 0,
            x2: 99,
            y2: 49,
        };
        assert_eq!(rect.width(), 100);
        assert_eq!(rect.height(), 50);
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
        histogram.observe_lead_byte(&[0xFF]);
        assert_eq!(histogram.unreadable_count, 1);
        assert_eq!(histogram.unknown_count, 1);
        assert_eq!(histogram.total(), 2);
    }

    #[test]
    fn warning_display_carries_typed_code_prefix() {
        let warning = G00Warning::NoTypeNInCorpus {
            g00_type: G00Type::PalettedLzss,
        };
        assert!(
            warning
                .to_string()
                .starts_with("utsushi.reallive.g00_no_type_N_in_corpus:")
        );
    }

    #[test]
    fn error_display_carries_typed_code_prefix() {
        let err = G00DecodeError::UnknownType { observed: 0xff };
        assert!(err.to_string().starts_with("utsushi.reallive.g00."));
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
