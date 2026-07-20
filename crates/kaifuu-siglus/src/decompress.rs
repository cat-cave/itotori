//! Proprietary Siglus LZSS decompressor.
//! After the constant-256-byte-XOR + optional second-layer strip
//! ([`crate::decrypt`]), a Siglus scene payload is an 8-byte size header
//! followed by a proprietary-LZSS-compressed bytecode blob. This module owns
//! the decompress direction; [`crate::compress`] owns the inverse used by
//! patchback.
//!
//! # Codec (byte-oriented LZSS)
//!
//! The compressed stream is a sequence of groups. Each group begins with one
//! 8-bit flag byte; the eight flag bits are consumed least-significant first.
//! For each flag bit, `1` copies one literal byte straight to the output, and
//! `0` reads a little-endian `u16` back-reference token `w` whose copy length is
//! `(w & 0x0F) + 2` and whose back offset (distance from the current output
//! tail) is `w >> 4`. An offset of `0`, or one past the emitted-so-far window,
//! is a hard error (no wrap, no zero-fill).
//!
//! The window copy is byte-by-byte so overlapping runs (offset `<` length)
//! replicate correctly. Decoding stops once exactly `dst_len` bytes are
//! emitted; running out of input first is a typed truncation error, never a
//! silent short read.
//!
//! Format re-derived from publicly archived Siglus format documentation and
//! re-tested against real Siglus title bytes; see the crate-level clean-room
//! provenance note. No reference source is vendored or mechanically translated.

use thiserror::Error;

/// Fatal errors raised by the Siglus LZSS decompressor.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SiglusDecompressError {
    /// The compressed stream was exhausted before producing `dst_len` bytes.
    #[error(
        "kaifuu.siglus.decompress.truncated_input: compressed stream length {observed_len} \
         exhausted at position {position}, needed {needed} more bytes"
    )]
    TruncatedInput {
        observed_len: usize,
        position: usize,
        needed: usize,
    },
    /// A back-reference instruction targeted bytes outside the current output
    /// window (offset zero, or reaching before the start of output).
    #[error(
        "kaifuu.siglus.decompress.back_reference_out_of_range: back-ref at position {position} \
         targets offset={back} but only {emitted} bytes have been emitted"
    )]
    BackReferenceOutOfRange {
        position: usize,
        back: usize,
        emitted: usize,
    },
    /// Decoding produced more than `dst_len` bytes — a malformed or
    /// wrongly-keyed stream. The decoder never truncates silently.
    #[error(
        "kaifuu.siglus.decompress.overrun: decoder produced {produced} bytes exceeding the \
         declared {dst_len}"
    )]
    Overrun { produced: usize, dst_len: usize },
}

/// Decompress a proprietary-Siglus-LZSS-compressed scene payload.
/// `compressed` is the post-decrypt LZSS stream (the bytes **after** the
/// 8-byte `[u32 compressed_size][u32 decompressed_size]` header); `dst_len` is
/// the declared decompressed size read from that header. On success the output
/// is exactly `dst_len` bytes. There is no `Ok(partial)` path: a truncated
/// stream, an out-of-range back-reference, or an emission over `dst_len` is a
/// typed error.
pub fn decompress_siglus_lzss(
    compressed: &[u8],
    dst_len: usize,
) -> Result<Vec<u8>, SiglusDecompressError> {
    let mut out: Vec<u8> = Vec::with_capacity(dst_len);
    let mut pos = 0usize;
    let observed_len = compressed.len();

    while out.len() < dst_len {
        let flags = *compressed
            .get(pos)
            .ok_or(SiglusDecompressError::TruncatedInput {
                observed_len,
                position: pos,
                needed: 1,
            })?;
        pos += 1;

        for bit in 0..8 {
            if out.len() >= dst_len {
                break;
            }
            if (flags >> bit) & 1 != 0 {
                // Literal byte.
                let byte = *compressed
                    .get(pos)
                    .ok_or(SiglusDecompressError::TruncatedInput {
                        observed_len,
                        position: pos,
                        needed: 1,
                    })?;
                pos += 1;
                out.push(byte);
            } else {
                // Back-reference token (little-endian u16).
                if pos + 2 > observed_len {
                    return Err(SiglusDecompressError::TruncatedInput {
                        observed_len,
                        position: pos,
                        needed: pos + 2 - observed_len,
                    });
                }
                let token = u16::from_le_bytes([compressed[pos], compressed[pos + 1]]) as usize;
                let token_pos = pos;
                pos += 2;

                let length = (token & 0x0F) + 2;
                let offset = token >> 4;
                if offset == 0 || offset > out.len() {
                    return Err(SiglusDecompressError::BackReferenceOutOfRange {
                        position: token_pos,
                        back: offset,
                        emitted: out.len(),
                    });
                }

                let src_start = out.len() - offset;
                for i in 0..length {
                    if out.len() >= dst_len {
                        break;
                    }
                    let byte = out[src_start + i];
                    out.push(byte);
                }
            }
        }
    }

    if out.len() != dst_len {
        return Err(SiglusDecompressError::Overrun {
            produced: out.len(),
            dst_len,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_literal_group_round_trips() {
        // Flag 0xFF => eight literal bytes.
        let mut stream = vec![0xFFu8];
        stream.extend_from_slice(b"ABCDEFGH");
        let out = decompress_siglus_lzss(&stream, 8).expect("all-literal decode");
        assert_eq!(out, b"ABCDEFGH");
    }

    #[test]
    fn back_reference_replicates_overlapping_run() {
        // Emit one literal 'A' (flag bit0=1), then a back-ref offset=1 length=5
        // (token: offset=1 -> <<4, length-2=3 -> low nibble) => 0x13 -> "AAAAA".
        // Flag byte low bits: bit0=1 (literal), bit1=0 (back-ref).
        let flag = 0b0000_0001u8;
        let token = ((1usize << 4) | (5 - 2)) as u16; // offset=1, length=5
        let mut stream = vec![flag, b'A'];
        stream.extend_from_slice(&token.to_le_bytes());
        let out = decompress_siglus_lzss(&stream, 6).expect("overlap decode");
        assert_eq!(out, b"AAAAAA");
    }

    #[test]
    fn truncated_stream_is_typed_error_not_partial() {
        let err = decompress_siglus_lzss(&[0xFF, b'A'], 8).expect_err("must not short-read");
        assert!(matches!(err, SiglusDecompressError::TruncatedInput { .. }));
        assert!(
            err.to_string()
                .starts_with(crate::SIGLUS_UNIMPLEMENTED_MARKER)
        );
    }

    #[test]
    fn back_reference_before_output_start_is_rejected() {
        // First op is a back-ref with no prior output -> out of range.
        let token = (1usize << 4) as u16;
        let mut stream = vec![0b0000_0000u8];
        stream.extend_from_slice(&token.to_le_bytes());
        let err = decompress_siglus_lzss(&stream, 4).expect_err("empty-window back-ref");
        assert!(matches!(
            err,
            SiglusDecompressError::BackReferenceOutOfRange { .. }
        ));
    }
}
