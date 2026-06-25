//! KAIFUU-210 — AVG32 LZSS + 256-byte XOR decompressor for RealLive
//! scene bytecode.
//!
//! Clean-room provenance:
//! - Restated in our own words from rlvm's BSD-licensed
//!   `libreallive/compression.cc::Decompress` (Peter Jolly, 2006). The
//!   AVG32 LZSS algorithm and the 256-byte XOR mask constant are
//!   documented behavior of a fixed file format used by every RealLive
//!   title since 1.10 — no rlvm source is vendored.
//! - Confirmed against Sweetie HD scene #1 in
//!   `docs/research/reallive-sweetie-hd-encryption-mechanism.md` §4.
//!   The same algorithm is also implemented in `utsushi-reallive`'s
//!   `decompressor` module; per the workspace "format-identical,
//!   implementation-separate" rule kaifuu-reallive does not depend on
//!   utsushi-reallive and this module is an independent re-derivation.
//!
//! Sukara-branch titles (Sweetie HD) do NOT apply a second-level XOR
//! pass after LZSS decompression — outcome A in the encryption-mechanism
//! research doc. The decompressor below therefore only models the
//! first-level (256-byte XOR + LZSS) transform. A future node may add a
//! second-level-XOR variant for Key / Visual Arts titles.

use thiserror::Error;

/// AVG32 256-byte XOR mask applied to the LZSS compressed stream.
///
/// Restated in our own words from rlvm's BSD-licensed
/// `compression.cc::xor_mask[256]` constant. The 256-byte table is a
/// documented constant of the AVG32 format.
const AVG32_XOR_MASK: [u8; 256] = [
    0x8b, 0xe5, 0x5d, 0xc3, 0xa1, 0xe0, 0x30, 0x44, 0x00, 0x85, 0xc0, 0x74, 0x09, 0x5f, 0x5e, 0x33,
    0xc0, 0x5b, 0x8b, 0xe5, 0x5d, 0xc3, 0x8b, 0x45, 0x0c, 0x85, 0xc0, 0x75, 0x14, 0x8b, 0x55, 0xec,
    0x83, 0xc2, 0x20, 0x52, 0x6a, 0x00, 0xe8, 0xf5, 0x28, 0x01, 0x00, 0x83, 0xc4, 0x08, 0x89, 0x45,
    0x0c, 0x8b, 0x45, 0xe4, 0x6a, 0x00, 0x6a, 0x00, 0x50, 0x53, 0xff, 0x15, 0x34, 0xb1, 0x43, 0x00,
    0x8b, 0x45, 0x10, 0x85, 0xc0, 0x74, 0x05, 0x8b, 0x4d, 0xec, 0x89, 0x08, 0x8a, 0x45, 0xf0, 0x84,
    0xc0, 0x75, 0x78, 0xa1, 0xe0, 0x30, 0x44, 0x00, 0x8b, 0x7d, 0xe8, 0x8b, 0x75, 0x0c, 0x85, 0xc0,
    0x75, 0x44, 0x8b, 0x1d, 0xd0, 0xb0, 0x43, 0x00, 0x85, 0xff, 0x76, 0x37, 0x81, 0xff, 0x00, 0x00,
    0x04, 0x00, 0x6a, 0x00, 0x76, 0x43, 0x8b, 0x45, 0xf8, 0x8d, 0x55, 0xfc, 0x52, 0x68, 0x00, 0x00,
    0x04, 0x00, 0x56, 0x50, 0xff, 0x15, 0x2c, 0xb1, 0x43, 0x00, 0x6a, 0x05, 0xff, 0xd3, 0xa1, 0xe0,
    0x30, 0x44, 0x00, 0x81, 0xef, 0x00, 0x00, 0x04, 0x00, 0x81, 0xc6, 0x00, 0x00, 0x04, 0x00, 0x85,
    0xc0, 0x74, 0xc5, 0x8b, 0x5d, 0xf8, 0x53, 0xe8, 0xf4, 0xfb, 0xff, 0xff, 0x8b, 0x45, 0x0c, 0x83,
    0xc4, 0x04, 0x5f, 0x5e, 0x5b, 0x8b, 0xe5, 0x5d, 0xc3, 0x8b, 0x55, 0xf8, 0x8d, 0x4d, 0xfc, 0x51,
    0x57, 0x56, 0x52, 0xff, 0x15, 0x2c, 0xb1, 0x43, 0x00, 0xeb, 0xd8, 0x8b, 0x45, 0xe8, 0x83, 0xc0,
    0x20, 0x50, 0x6a, 0x00, 0xe8, 0x47, 0x28, 0x01, 0x00, 0x8b, 0x7d, 0xe8, 0x89, 0x45, 0xf4, 0x8b,
    0xf0, 0xa1, 0xe0, 0x30, 0x44, 0x00, 0x83, 0xc4, 0x08, 0x85, 0xc0, 0x75, 0x56, 0x8b, 0x1d, 0xd0,
    0xb0, 0x43, 0x00, 0x85, 0xff, 0x76, 0x49, 0x81, 0xff, 0x00, 0x00, 0x04, 0x00, 0x6a, 0x00, 0x76,
];

/// Length of the fixed 8-byte AVG32 preamble at the start of the
/// compressed stream. The preamble carries an XOR'd
/// `(compressed_size, uncompressed_size)` `u32 LE` pair that is also
/// stored in plaintext in the scene header; the decompressor skips it.
pub const AVG32_COMPRESSED_PREAMBLE_LEN: usize = 8;

/// Fatal errors raised by [`decompress_avg32`].
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum DecompressError {
    /// The compressed stream was exhausted before producing the
    /// declared output length.
    #[error(
        "kaifuu.reallive.decompress.truncated_input: compressed stream length {observed_len} \
         exhausted at position {position}, needed {needed} more bytes"
    )]
    TruncatedInput {
        observed_len: usize,
        position: usize,
        needed: usize,
    },
    /// A back-reference instruction targeted bytes outside the current
    /// output window.
    #[error(
        "kaifuu.reallive.decompress.back_reference_out_of_range: back-ref at position {position} \
         targets back={back} but only {emitted} bytes have been emitted"
    )]
    BackReferenceOutOfRange {
        position: usize,
        back: usize,
        emitted: usize,
    },
    /// The decompressor finished consuming input without emitting the
    /// declared uncompressed size.
    #[error(
        "kaifuu.reallive.decompress.unexpected_end_of_stream: declared uncompressed size \
         {declared_uncompressed_size} but only {emitted} bytes were emitted"
    )]
    UnexpectedEndOfStream {
        declared_uncompressed_size: usize,
        emitted: usize,
    },
}

/// Decompress an AVG32-shape compressed bytecode payload (Sukara
/// branch — first-level transform only).
///
/// `compressed` is the on-disk byte range pointed at by the scene
/// header's `bytecode_offset .. + bytecode_compressed_size`. `dst_len`
/// is the declared `bytecode_uncompressed_size`.
///
/// On a truncated stream, out-of-range back-reference, or
/// emission-shortfall the function returns a typed [`DecompressError`]
/// — there is no `Ok(partial)` path.
pub fn decompress_avg32(compressed: &[u8], dst_len: usize) -> Result<Vec<u8>, DecompressError> {
    if compressed.len() < AVG32_COMPRESSED_PREAMBLE_LEN {
        return Err(DecompressError::TruncatedInput {
            observed_len: compressed.len(),
            position: 0,
            needed: AVG32_COMPRESSED_PREAMBLE_LEN,
        });
    }
    let mut dst: Vec<u8> = Vec::with_capacity(dst_len);
    let mut src_pos: usize = AVG32_COMPRESSED_PREAMBLE_LEN;
    let mut mask_idx: u8 = AVG32_COMPRESSED_PREAMBLE_LEN as u8;
    let mut bit: u32 = 1;

    let mut flag = match xor_consume(compressed, &mut src_pos, &mut mask_idx) {
        Some(byte) => byte,
        None => {
            return Err(DecompressError::TruncatedInput {
                observed_len: compressed.len(),
                position: src_pos,
                needed: 1,
            });
        }
    };

    while dst.len() < dst_len {
        if bit == 256 {
            bit = 1;
            let Some(next_flag) = xor_consume(compressed, &mut src_pos, &mut mask_idx) else {
                return Err(DecompressError::UnexpectedEndOfStream {
                    declared_uncompressed_size: dst_len,
                    emitted: dst.len(),
                });
            };
            flag = next_flag;
        }
        if (flag as u32) & bit != 0 {
            let Some(literal) = xor_consume(compressed, &mut src_pos, &mut mask_idx) else {
                return Err(DecompressError::UnexpectedEndOfStream {
                    declared_uncompressed_size: dst_len,
                    emitted: dst.len(),
                });
            };
            dst.push(literal);
        } else {
            let Some(lo) = xor_consume(compressed, &mut src_pos, &mut mask_idx) else {
                return Err(DecompressError::UnexpectedEndOfStream {
                    declared_uncompressed_size: dst_len,
                    emitted: dst.len(),
                });
            };
            let Some(hi) = xor_consume(compressed, &mut src_pos, &mut mask_idx) else {
                return Err(DecompressError::UnexpectedEndOfStream {
                    declared_uncompressed_size: dst_len,
                    emitted: dst.len(),
                });
            };
            let count = (lo as u32) | ((hi as u32) << 8);
            let back = (count >> 4) as usize;
            let run = ((count & 0x0f) as usize) + 2;
            if back == 0 || back > dst.len() {
                return Err(DecompressError::BackReferenceOutOfRange {
                    position: src_pos,
                    back,
                    emitted: dst.len(),
                });
            }
            let start = dst.len() - back;
            for i in 0..run {
                if dst.len() >= dst_len {
                    break;
                }
                let byte = dst[start + i];
                dst.push(byte);
            }
        }
        bit <<= 1;
    }
    Ok(dst)
}

fn xor_consume(src: &[u8], src_pos: &mut usize, mask_idx: &mut u8) -> Option<u8> {
    if *src_pos >= src.len() {
        return None;
    }
    let byte = src[*src_pos] ^ AVG32_XOR_MASK[*mask_idx as usize];
    *src_pos += 1;
    *mask_idx = mask_idx.wrapping_add(1);
    Some(byte)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_is_truncated_not_silent_ok() {
        let err = decompress_avg32(&[], 16).expect_err("empty input must error");
        assert!(matches!(err, DecompressError::TruncatedInput { .. }));
    }

    #[test]
    fn short_input_below_preamble_is_truncated() {
        let err = decompress_avg32(&[0u8; 4], 16).expect_err("preamble-short input must error");
        assert!(matches!(err, DecompressError::TruncatedInput { .. }));
    }
}
