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
mod decoder;
mod errors;
mod lzss;
mod model;
mod validation;

#[cfg(test)]
mod tests;

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

pub use decoder::decode_g00;
pub use errors::{G00CorpusHistogram, G00DecodeError, G00Warning};
pub use model::{
    G00_HEADER_PREAMBLE_BYTE_LEN, G00_REGION_RECORD_BYTE_LEN, G00_TYPE_PALETTED_LZSS,
    G00_TYPE_RAW_BGR, G00_TYPE_REGIONED_LZSS, G00_TYPE0_BGR_BYTES_PER_PIXEL, G00Image, G00Rect,
    G00Region, G00Type,
};
pub use validation::{
    G00ContentValidationError, G00LzssValidation, G00MetadataError, G00PatternGeometry,
    probe_g00_pattern_geometry, validate_g00_lzss_content,
};

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
