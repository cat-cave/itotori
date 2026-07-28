//! AVG32 LZSS + XOR scene-bytecode decompressor.
//!
//! Decodes the AVG32-shape compressed bytecode payload that sits after
//! the [`crate::SceneHeader`] in every populated RealLive scene blob.
//! The on-disk transform is a two-step pipeline:
//!
//! 1. **First-level XOR** — every consumed byte of the compressed stream
//!    is XOR'd against a fixed, public 256-byte mask
//!    ([`AVG32_XOR_MASK`]) indexed by a counter that increments per
//!    consumed byte (the first 8 mask slots are spent on the preamble
//!    so the first flag byte XOR'es against `mask[8]`).
//! 2. **LZSS** — rlvm-shape sliding-window decompression with 16-bit
//!    flag bytes (LSB first), a 4096-byte addressable window, and a
//!    `count_word = (back_distance << 4) | (run_length - 2)` encoding.
//! 3. **Optional second-level XOR** — when [`AvgDecompressor::decompress`]
//!    is called with `Some(key)` the 16-byte key is XOR'd cyclically
//!    against the post-LZSS bytes. For any compiler-110002 title the caller
//!    passes `None` per outcome A in
//!    the RealLive encryption research notes.
//!
//! # Outcome A (compiler version 110002)
//!
//! The encryption-mechanism research probe under
//! `RealLive encryption research notes` proved
//! the rlvm `scenario.cc::Header` heuristic ("if compiler_version ==
//! 110002 then enable second-level XOR") is overly pessimistic for the
//! compiler-110002 HD remasters. The observed scene #0001 decompresses
//! cleanly with `xor2_key = None`: the resulting 1660-byte stream
//! begins `0a 02 00 0a 03 00 21 00` and parses as a valid
//! BytecodeElement sequence. The decompressor therefore makes the
//! second-level XOR pass **optional** (caller-controlled) and emits a
//! typed [`DecompressWarning::Xor2NotApplied`] when the call site
//! passes `xor2_key = None` for a compiler version that historically
//! requested an XOR-2 pass. The warning is never silent and is part of
//! the return value — silent skip is forbidden by the alpha-gate
//! contract.
//!
//! # Clean-room provenance
//!
//! The 256-byte [`AVG32_XOR_MASK`] is a **numeric public constant** —
//! the same fixed array used by every RealLive title since AVG32. The
//! bytes are reproduced here verbatim from the rlvm
//! `src/libreallive/compression.cc` `xor_mask[256]` (BSD-3-Clause, Peter
//! Jolly, 2006); a documented numeric constant is not a license-protected
//! expression. The LZSS algorithm is restated in our own words from the
//! same source — no code is mechanically translated.

use crate::scene_header::COMPILER_VERSION_1_10;

mod constants;
mod errors;
pub use constants::*;
pub use errors::{DecompressError, DecompressWarning};

/// AVG32 LZSS + XOR decompressor.
///
/// The decompressor is stateless — every call to
/// [`AvgDecompressor::decompress`] starts a fresh stream. The struct is
/// a unit-like type carrying only the algorithm; it exists so callers
/// have a named entry point and so future configuration (e.g. an
/// AVG32 mask override for a non-canonical title) can land as a method
/// without breaking the call shape.
#[derive(Debug, Clone, Copy, Default)]
pub struct AvgDecompressor;

impl AvgDecompressor {
    /// Construct a fresh decompressor. Equivalent to [`Self::default`].
    pub const fn new() -> Self {
        Self
    }

    /// Decompress an AVG32-shape compressed bytecode payload.
    ///
    /// `compressed` is the on-disk bytes pointed at by
    /// `SceneHeader::bytecode_offset.. + bytecode_compressed_size`.
    /// `uncompressed_size` is the typed `bytecode_uncompressed_size`
    /// field from the scene header (the decoder uses it to short-circuit
    /// the LZSS loop on the documented `dst.len() < uncompressed_size`
    /// guard).
    ///
    /// When `xor2_key` is `Some`, the 16-byte key is XOR'd cyclically
    /// against the post-LZSS output. When it is `None`, the second-level
    /// XOR is intentionally skipped — see the
    /// RealLive encryption research notes
    /// outcome A note above for why this is the correct choice for
    /// compiler-110002 titles.
    ///
    /// `compiler_version` is the typed
    /// [`crate::SceneHeader::compiler_version`] value the scene header
    /// reported. It is used only to emit a typed
    /// [`DecompressWarning::Xor2NotApplied`] when the caller passes
    /// `xor2_key = None` for a compiler version that historically
    /// requested a second-level XOR.
    ///
    /// On success returns `Ok((decompressed, warnings))`. A truncated
    /// input, an out-of-range back-reference, or an end-of-stream
    /// shortfall all produce a typed [`DecompressError`] — there is no
    /// `Ok(partial_buffer)` path.
    pub fn decompress(
        &self,
        compressed: &[u8],
        uncompressed_size: u32,
        xor2_key: Option<&[u8; AVG32_XOR2_KEY_LEN]>,
        compiler_version: u32,
    ) -> Result<(Vec<u8>, Vec<DecompressWarning>), DecompressError> {
        let declared_uncompressed_size = uncompressed_size as usize;

        if compressed.len() < AVG32_COMPRESSED_PREAMBLE_LEN {
            return Err(DecompressError::TruncatedInput {
                observed_len: compressed.len(),
                position: 0,
                needed: AVG32_COMPRESSED_PREAMBLE_LEN,
                message: format!(
                    "compressed stream length {} is shorter than the fixed {}-byte preamble",
                    compressed.len(),
                    AVG32_COMPRESSED_PREAMBLE_LEN,
                ),
            });
        }

        // Bound the *initial* allocation against the input. `declared_uncompressed_size`
        // is an attacker-controlled raw u32 header field; a tiny malformed scene can
        // declare up to 0xFFFF_FFFF and force a ~4 GiB allocation before a single byte
        // is decoded. Each source byte expands to at most `AVG32_LZSS_MAX_RUN` output
        // bytes, so `compressed.len() * AVG32_LZSS_MAX_RUN` is a hard upper bound on the
        // real output: when the declared size is legitimate this preallocates it in full
        // and when it is implausible we cap the up-front reservation. The decode loop
        // below grows `dst` incrementally, so this never affects output correctness — a
        // genuine shortfall still surfaces as `UnexpectedEndOfStream`.
        let initial_capacity =
            declared_uncompressed_size.min(compressed.len().saturating_mul(AVG32_LZSS_MAX_RUN));
        let mut dst: Vec<u8> = Vec::with_capacity(initial_capacity);
        let mut src_pos: usize = AVG32_COMPRESSED_PREAMBLE_LEN;
        // Mask cycles with `(idx & 0xff)`; a `u8` wraps for free.
        let mut mask_idx: u8 = AVG32_COMPRESSED_PREAMBLE_LEN as u8;

        // 16-bit flag-byte cycle. rlvm's reference loop reloads when
        // `bit == 256`; representing `bit` as a `u32` lets the comparison
        // happen without overflow when the high bit shifts past 0x80.
        let mut bit: u32 = 1;
        let mut flag = xor_consume(compressed, &mut src_pos, &mut mask_idx).ok_or_else(|| {
            DecompressError::TruncatedInput {
                observed_len: compressed.len(),
                position: src_pos,
                needed: 1,
                message: "compressed stream exhausted before the first flag byte".to_string(),
            }
        })?;

        while dst.len() < declared_uncompressed_size {
            if bit == 256 {
                bit = 1;
                // Reload the flag byte. End-of-stream here is *not* an
                // error if we have produced exactly the declared output
                // length — the while-guard prevents the loop from
                // running in that case. So a missing flag byte here is
                // a structural shortfall: the encoder declared more
                // output than the stream actually carries.
                let Some(next_flag) = xor_consume(compressed, &mut src_pos, &mut mask_idx) else {
                    return Err(DecompressError::UnexpectedEndOfStream {
                        declared_uncompressed_size,
                        emitted: dst.len(),
                        position: src_pos,
                    });
                };
                flag = next_flag;
            }

            if (flag as u32) & bit != 0 {
                // Literal byte.
                let Some(literal) = xor_consume(compressed, &mut src_pos, &mut mask_idx) else {
                    return Err(DecompressError::UnexpectedEndOfStream {
                        declared_uncompressed_size,
                        emitted: dst.len(),
                        position: src_pos,
                    });
                };
                dst.push(literal);
            } else {
                // Back-reference: two XOR'd bytes form a u16 LE `count`.
                let Some(lo) = xor_consume(compressed, &mut src_pos, &mut mask_idx) else {
                    return Err(DecompressError::UnexpectedEndOfStream {
                        declared_uncompressed_size,
                        emitted: dst.len(),
                        position: src_pos,
                    });
                };
                let Some(hi) = xor_consume(compressed, &mut src_pos, &mut mask_idx) else {
                    return Err(DecompressError::UnexpectedEndOfStream {
                        declared_uncompressed_size,
                        emitted: dst.len(),
                        position: src_pos,
                    });
                };
                let count = (lo as u32) | ((hi as u32) << 8);
                let back_distance = (count >> 4) as usize;
                let run_length = ((count & 0x0f) as usize) + AVG32_LZSS_MIN_RUN;

                if back_distance == 0 || back_distance > dst.len() {
                    return Err(DecompressError::BackReferenceOutOfRange {
                        emitted: dst.len(),
                        back_distance,
                        run_length,
                        position: src_pos,
                    });
                }

                if dst.len().saturating_add(run_length) > declared_uncompressed_size {
                    // Per the rlvm reference, the last back-reference is
                    // allowed to *clip* against the declared length;
                    // emit only as many bytes as fit. This matches the
                    // observed behavior where the final run
                    // saturates the buffer exactly. Anything that would
                    // require *more* than that is genuine overflow.
                    let start = dst.len() - back_distance;
                    let remaining = declared_uncompressed_size - dst.len();
                    for i in 0..remaining {
                        let byte = dst[start + i];
                        dst.push(byte);
                    }
                    // After clipping we have hit the declared length;
                    // the loop guard will exit on the next iteration.
                } else {
                    let start = dst.len() - back_distance;
                    for i in 0..run_length {
                        let byte = dst[start + i];
                        dst.push(byte);
                    }
                }
            }

            bit <<= 1;
        }

        // Invariant: `dst.len()` can reach but never exceed
        // `declared_uncompressed_size`, so the decoder cannot overrun the
        // declared size. The loop only runs while
        // `dst.len() < declared_uncompressed_size`; the literal branch
        // pushes exactly one byte; and the back-reference branch either
        // takes the clip path — pushing exactly `declared_uncompressed_size
        // - dst.len()` bytes to land on the declared size — or the unclipped
        // path, which only runs when `dst.len() + run_length <=
        // declared_uncompressed_size`. No input can drive `dst.len()` past
        // the declared size, so a runtime overflow guard here would be
        // structurally unreachable; the invariant is pinned with a debug
        // assertion instead of a typed error path.
        debug_assert!(
            dst.len() <= declared_uncompressed_size,
            "AVG32 decompressor overshot declared_uncompressed_size \
             (dst.len()={}, declared_uncompressed_size={})",
            dst.len(),
            declared_uncompressed_size,
        );

        // Second-level XOR (optional). When the key is supplied we apply
        // it cyclically over the entire post-LZSS output. When it is
        // absent and the compiler version historically would have
        // requested it, we emit a typed warning so the choice is
        // observable to downstream audit tooling.
        let mut warnings: Vec<DecompressWarning> = Vec::new();
        match xor2_key {
            Some(key) => {
                for (i, byte) in dst.iter_mut().enumerate() {
                    *byte ^= key[i % AVG32_XOR2_KEY_LEN];
                }
            }
            None => {
                if compiler_version == COMPILER_VERSION_1_10 {
                    warnings.push(DecompressWarning::Xor2NotApplied { compiler_version });
                }
            }
        }

        Ok((dst, warnings))
    }
}

/// Consume one compressed byte at `*src_pos`, XOR it against the
/// current mask slot, and advance both the position and the mask
/// index. Returns `None` when the stream is exhausted.
fn xor_consume(src: &[u8], src_pos: &mut usize, mask_idx: &mut u8) -> Option<u8> {
    if *src_pos >= src.len() {
        return None;
    }
    let raw = src[*src_pos];
    let masked = raw ^ AVG32_XOR_MASK[*mask_idx as usize];
    *src_pos = src_pos.saturating_add(1);
    *mask_idx = mask_idx.wrapping_add(1);
    Some(masked)
}

#[cfg(test)]
#[path = "decompressor/synthetic.rs"]
mod synthetic;
#[cfg(test)]
pub(crate) use synthetic::{SyntheticToken, encode_synthetic};

#[cfg(test)]
#[path = "decompressor_tests.rs"]
mod tests;
