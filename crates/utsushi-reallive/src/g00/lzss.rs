//! Shared LZSS section parse, token variants, and stream decode for g00.
//!
//! Owns [`parse_lzss_section`], [`lzss_decode`], the [`LzssVariant`] token
//! layouts, and the little-endian field readers used by the type-2
//! region reconstruct path. Extracted from the parent so the framing and
//! compression primitives live in their own ≤500-line child.

use super::{G00DecodeError, G00Type};

/// Decoded LZSS-section view shared by all three g00 sub-formats.
///
/// Returned from [`parse_lzss_section`]. Pinned as a typed struct so
/// the parsing of the LZSS preamble is reusable across types 0/1/2
/// without each decoder having to re-implement the size-field math.
#[derive(Debug, Clone, Copy)]
pub(super) struct LzssSection<'a> {
    /// Compressed payload slice (NOT including the 8-byte preamble
    /// `(compressed_size, uncompressed_size)`).
    pub(super) payload: &'a [u8],
    /// `uncompressed_size` field from the LZSS preamble.
    pub(super) uncompressed_size: usize,
}

/// Parse the LZSS section preamble at offset `preamble_off` into a
/// typed [`LzssSection`].
pub(super) fn parse_lzss_section(
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
pub(super) fn rd_u16(buf: &[u8], off: usize) -> usize {
    if off + 2 <= buf.len() {
        (buf[off] as usize) | ((buf[off + 1] as usize) << 8)
    } else {
        0
    }
}

/// Read a little-endian `u32` at `off`, or `0` if it runs past the end.
pub(super) fn rd_u32(buf: &[u8], off: usize) -> usize {
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
pub(super) enum LzssVariant {
    /// Type-0 24-bpp BGR: literal = 3 bytes; token `t` →
    /// `distance = (t >> 4) * 3`, `length = ((t & 0x0f) + 1) * 3`.
    Type0Bgr,
    /// AVG2000 ("SCN2k"), used by types 1 and 2: literal = 1 byte;
    /// token `t` → `distance = (t >> 4)`, `length = (t & 0x0f) + 2`.
    Scn2k,
}

impl LzssVariant {
    /// Bytes copied per literal token.
    pub(super) fn literal_unit(self) -> usize {
        match self {
            LzssVariant::Type0Bgr => 3,
            LzssVariant::Scn2k => 1,
        }
    }

    /// Split a 16-bit back-reference token into `(distance, length)` in
    /// bytes.
    pub(super) fn split_token(self, t: usize) -> (usize, usize) {
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
pub(super) fn lzss_decode(input: &[u8], out_size: usize, variant: LzssVariant) -> Vec<u8> {
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
