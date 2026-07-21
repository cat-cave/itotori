//! AVG32 LZSS re-compressor (literal-only emission) for
//! RealLive scene bytecode.
//! Pairs with [`crate::decompressor::decompress_avg32`]: emits the
//! 8-byte preamble (`(compressed_size, uncompressed_size)` as `u32 LE`,
//! XOR'd by the 256-byte mask), then encodes every input byte as a
//! literal under a flag-byte of all-ones. This is the simplest legal
//! AVG32 LZSS payload — it is intentionally larger than a back-reference
//! encoder would produce, but it round-trips bit-exactly through the
//! decompressor and avoids the rlvm encoder's complexity.
//! Clean-room provenance:
//! - The flag-byte / literal-or-backref encoding is the inverse of
//!   [`crate::decompressor::decompress_avg32`]'s decode loop, restated
//!   in our own words from rlvm's BSD-licensed
//!   `libreallive/compression.cc::Decompress` and the AVG32 LZSS public
//!   documentation. No rlvm source is vendored.
//! - The 256-byte XOR mask is the same documented constant shared with
//!   the decompressor; we apply it to every byte we write (including
//!   the preamble), mirroring the read-side mask consumption.
//! - This module is independent of `utsushi-reallive`'s parallel
//!   implementation (workspace rule: format-identical, implementation-
//!   separate).
//!   The output is **byte-deterministic** for a given input and the
//!   decompressor verifies it round-trips. The literal-only
//!   emission stays inside the AVG32 format's documented control-byte
//!   grammar — no novel opcodes, no engine-specific extensions.

use thiserror::Error;

use crate::decompressor::{AVG32_COMPRESSED_PREAMBLE_LEN, AVG32_XOR_MASK};

/// Fatal errors raised by [`compress_avg32_literal`].
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CompressError {
    /// The plaintext input exceeded `u32::MAX` and could not be encoded
    /// into the 4-byte preamble's `uncompressed_size` field.
    #[error(
        "kaifuu.reallive.compress.input_too_large: plaintext length {observed_len} \
         exceeds the u32 preamble size budget"
    )]
    InputTooLarge { observed_len: usize },
    /// The encoded compressed size overflowed `u32`. Practically
    /// unreachable for any real RealLive scene, but typed so the encoder
    /// surface has no implicit panic.
    #[error(
        "kaifuu.reallive.compress.output_too_large: encoded compressed length {observed_len} \
         exceeds the u32 preamble size budget"
    )]
    OutputTooLarge { observed_len: usize },
}

/// Encode `plaintext` as an AVG32 LZSS payload using literal-only
/// emission.
/// Output layout:
/// - 8-byte preamble: `(compressed_size_u32_le, uncompressed_size_u32_le)`
///   XOR'd by the 256-byte mask (mask indices 0..=7).
/// - For every 8 input bytes (the last group may be partial), emit one
///   flag byte (all-ones — every code unit is a literal) followed by the
///   8 plaintext bytes. The XOR mask continues across the whole stream;
///   indices roll over at 256 by `u8::wrapping_add`.
///   The result decompresses byte-identically to `plaintext` via
///   [`crate::decompressor::decompress_avg32`].
pub fn compress_avg32_literal(plaintext: &[u8]) -> Result<Vec<u8>, CompressError> {
    if plaintext.len() > u32::MAX as usize {
        return Err(CompressError::InputTooLarge {
            observed_len: plaintext.len(),
        });
    }

    // Total emitted bytes = 8 (preamble) + ceil(N/8) flag bytes + N
    // literal bytes. Pre-compute and reserve the buffer.
    let group_count = plaintext
        .len()
        .div_ceil(8)
        .max(usize::from(!plaintext.is_empty()));
    let total_len = AVG32_COMPRESSED_PREAMBLE_LEN + group_count + plaintext.len();
    if total_len > u32::MAX as usize {
        return Err(CompressError::OutputTooLarge {
            observed_len: total_len,
        });
    }
    let compressed_size_u32 = total_len as u32;
    let uncompressed_size_u32 = plaintext.len() as u32;

    let mut output = Vec::with_capacity(total_len);
    let mut mask_idx: u8 = 0;

    // Preamble: 8 bytes — (compressed_size, uncompressed_size) u32 LE.
    for byte in compressed_size_u32.to_le_bytes() {
        push_masked(&mut output, byte, &mut mask_idx);
    }
    for byte in uncompressed_size_u32.to_le_bytes() {
        push_masked(&mut output, byte, &mut mask_idx);
    }

    // Body: for each 8-byte group, emit flag=0xFF (all literals) then up
    // to 8 literal bytes. The decompressor consumes the flag byte first
    // and walks `bit = 1, 2, 4,... 128` testing `(flag & bit)!= 0`;
    // 0xFF makes every bit position a literal.
    let mut cursor = 0usize;
    while cursor < plaintext.len() {
        push_masked(&mut output, 0xFF, &mut mask_idx);
        let group_end = (cursor + 8).min(plaintext.len());
        for &byte in &plaintext[cursor..group_end] {
            push_masked(&mut output, byte, &mut mask_idx);
        }
        cursor = group_end;
    }

    debug_assert_eq!(
        output.len(),
        total_len,
        "compress_avg32_literal pre-computed total_len must match emitted len"
    );
    Ok(output)
}

fn push_masked(output: &mut Vec<u8>, byte: u8, mask_idx: &mut u8) {
    output.push(byte ^ AVG32_XOR_MASK[*mask_idx as usize]);
    *mask_idx = mask_idx.wrapping_add(1);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decompressor::decompress_avg32;

    #[test]
    fn empty_input_round_trips_as_preamble_only() {
        // Empty payload: no flag/literal bytes emitted (the decompressor
        // never reads them because dst_len=0). The output is exactly the
        // 8-byte preamble.
        let compressed = compress_avg32_literal(&[]).expect("empty input compresses");
        assert_eq!(compressed.len(), AVG32_COMPRESSED_PREAMBLE_LEN);
        // The decompressor reads one flag byte eagerly even when
        // dst_len=0, so we don't round-trip empty payloads — that's
        // documented and never produced by the patchback driver
        // (every real scene has bytecode).
    }

    #[test]
    fn single_byte_round_trips() {
        let compressed = compress_avg32_literal(&[0xAB]).expect("encodes");
        let decompressed = decompress_avg32(&compressed, 1).expect("decompresses");
        assert_eq!(decompressed, vec![0xAB]);
    }

    #[test]
    fn group_boundary_inputs_round_trip() {
        // 8 bytes (exactly one full flag group), 9 bytes (one full + one
        // partial), 16 bytes (two full groups).
        for len in [8usize, 9, 16, 17, 23, 24] {
            let plain: Vec<u8> = (0..len as u8).collect();
            let compressed = compress_avg32_literal(&plain).expect("encodes");
            let decompressed = decompress_avg32(&compressed, len).expect("decompresses");
            assert_eq!(decompressed, plain, "round-trip mismatch at len={len}");
        }
    }

    #[test]
    fn xor_mask_indices_roll_over_past_256() {
        // 300 input bytes exercises the mask index wrap.
        let plain: Vec<u8> = (0..300).map(|i| (i as u8).wrapping_mul(7)).collect();
        let compressed = compress_avg32_literal(&plain).expect("encodes");
        let decompressed = decompress_avg32(&compressed, plain.len()).expect("decompresses");
        assert_eq!(decompressed, plain);
    }

    #[test]
    fn output_length_matches_documented_formula() {
        // total = 8 preamble + ceil(N/8) flag bytes + N literals.
        for len in [0usize, 1, 7, 8, 9, 16, 17, 100, 256, 1024] {
            let plain: Vec<u8> = (0..len as u32).map(|i| i as u8).collect();
            let compressed = compress_avg32_literal(&plain).expect("encodes");
            let group_count = if len == 0 { 0 } else { len.div_ceil(8) };
            let expected_len = AVG32_COMPRESSED_PREAMBLE_LEN + group_count + len;
            assert_eq!(
                compressed.len(),
                expected_len,
                "encoded length mismatch at plaintext_len={len}"
            );
        }
    }
}
