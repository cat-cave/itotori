//! UTSUSHI-203 — AVG32 LZSS + XOR scene-bytecode decompressor.
//!
//! Decodes the AVG32-shape compressed bytecode payload that sits after
//! the [`crate::SceneHeader`] in every populated RealLive scene blob.
//! The on-disk transform is a two-step pipeline:
//!
//! 1. **First-level XOR** — every consumed byte of the compressed stream
//!    is XOR'd against a fixed, public 256-byte mask
//!    ([`AVG32_XOR_MASK`]) indexed by a counter that increments per
//!    consumed byte (the first 8 mask slots are spent on the preamble,
//!    so the first flag byte XOR'es against `mask[8]`).
//! 2. **LZSS** — rlvm-shape sliding-window decompression with 16-bit
//!    flag bytes (LSB first), a 4096-byte addressable window, and a
//!    `count_word = (back_distance << 4) | (run_length - 2)` encoding.
//! 3. **Optional second-level XOR** — when [`AvgDecompressor::decompress`]
//!    is called with `Some(key)` the 16-byte key is XOR'd cyclically
//!    against the post-LZSS bytes. For Sweetie HD (and any other
//!    Sukara-branch title carrying compiler version `110002`) the caller
//!    passes `None` per outcome A in
//!    the RealLive encryption research notes.
//!
//! # Outcome A (Sukara-branch / compiler version 110002)
//!
//! The encryption-mechanism research probe under
//! `RealLive encryption research notes` proved
//! the rlvm `scenario.cc::Header` heuristic ("if compiler_version ==
//! 110002 then enable second-level XOR") is overly pessimistic for the
//! Sukara-branch HD remasters. Sweetie HD's scene #0001 decompresses
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

use serde::{Deserialize, Serialize};

use crate::scene_header::COMPILER_VERSION_1_10;

/// Byte length of the AVG32 first-level XOR mask. The mask cycles by
/// `(idx & 0xff)`, so a `u8` mask-index counter wraps naturally.
pub const AVG32_XOR_MASK_LEN: usize = 256;

/// Byte length of the compressed-stream preamble that rlvm skips
/// (`src += 8`). The preamble is *not* a no-op: its 8 bytes XOR'd against
/// the first 8 mask slots yield the LE `u32` pair
/// `(bytecode_compressed_size, bytecode_uncompressed_size)` — see the
/// self-consistency check in
/// `RealLive encryption research notes` §4.1.
pub const AVG32_COMPRESSED_PREAMBLE_LEN: usize = 8;

/// Byte length of the optional second-level XOR key.
pub const AVG32_XOR2_KEY_LEN: usize = 16;

/// Minimum LZSS run length emitted by a back-reference.
///
/// Encoded in the 4 low bits of the `count_word`; the LZSS encoder stores
/// `(run - 2)` so the on-disk minimum run is 2 bytes and the maximum is
/// `0x0f + 2 = 17` bytes. (The roadmap spec mentions "18" in one place;
/// the on-disk maximum per the rlvm `compression.cc` encoding is 17.)
pub const AVG32_LZSS_MIN_RUN: usize = 2;

/// Maximum LZSS run length emitted by a back-reference (`0x0f + 2 = 17`).
pub const AVG32_LZSS_MAX_RUN: usize = (0x0f) + AVG32_LZSS_MIN_RUN;

/// Maximum LZSS back-reference distance (the addressable window). The
/// `count_word >> 4` lookup is a 12-bit value, so the back-distance
/// ranges over `1..=4095` bytes.
pub const AVG32_LZSS_MAX_BACK_DISTANCE: usize = 4095;

/// The AVG32 first-level XOR mask used on the LZSS compressed stream.
///
/// Public numeric constant; the same fixed array used by every RealLive
/// title since AVG32. Reproduced from rlvm
/// `src/libreallive/compression.cc::xor_mask[256]` (BSD-3-Clause,
/// Peter Jolly, 2006). A documented numeric constant is not a
/// license-protected expression.
pub const AVG32_XOR_MASK: [u8; AVG32_XOR_MASK_LEN] = [
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

/// Fatal errors raised by [`AvgDecompressor::decompress`].
///
/// Every recoverable mismatch is a typed variant — there is no
/// `Ok(empty_vec)` fallback for truncated input or invalid flag bytes.
/// The alpha-gate contract forbids silent zero-state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecompressError {
    /// The compressed input was shorter than the fixed 8-byte preamble
    /// or ran out mid-token. The decompressor refuses to emit a partial
    /// buffer in this case.
    TruncatedInput {
        /// Total length of the input slice offered.
        observed_len: usize,
        /// Decompressor position at which the shortfall was detected.
        position: usize,
        /// Number of additional input bytes the decoder needed.
        needed: usize,
        /// Human-readable diagnostic.
        message: String,
    },
    /// The LZSS back-reference pointed outside the already-emitted
    /// output (distance 0, or distance greater than emitted length).
    BackReferenceOutOfRange {
        /// Length of `dst` at the moment the back-reference was decoded.
        emitted: usize,
        /// Back-distance the token requested.
        back_distance: usize,
        /// Run length the token requested.
        run_length: usize,
        /// Input position immediately after the token's bytes.
        position: usize,
    },
    /// The decompressor finished consuming input without producing the
    /// declared number of bytes. The partial output is dropped so the
    /// caller cannot accidentally treat a short stream as a full scene.
    UnexpectedEndOfStream {
        /// Declared uncompressed size the caller passed.
        declared_uncompressed_size: usize,
        /// Number of output bytes actually produced before the input
        /// was exhausted.
        emitted: usize,
        /// Final input position.
        position: usize,
    },
}

impl std::fmt::Display for DecompressError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DecompressError::TruncatedInput { message, .. } => {
                write!(
                    formatter,
                    "utsushi.reallive.decompress.truncated_input: {message}"
                )
            }
            DecompressError::BackReferenceOutOfRange {
                emitted,
                back_distance,
                run_length,
                position,
            } => write!(
                formatter,
                "utsushi.reallive.decompress.back_reference_out_of_range: \
                 emitted={emitted} back_distance={back_distance} run_length={run_length} \
                 at input position {position}",
            ),
            DecompressError::UnexpectedEndOfStream {
                declared_uncompressed_size,
                emitted,
                position,
            } => write!(
                formatter,
                "utsushi.reallive.decompress.unexpected_end_of_stream: \
                 declared_uncompressed_size={declared_uncompressed_size} emitted={emitted} \
                 at input position {position}",
            ),
        }
    }
}

impl std::error::Error for DecompressError {}

/// Non-fatal observation emitted alongside a successful decompression.
///
/// Like [`crate::SceneHeaderWarning`], these are returned in the success
/// tuple — the alpha-gate contract requires non-silent semantics for
/// every documented branch that historically had a different on-disk
/// shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DecompressWarning {
    /// The caller did not pass an `xor2_key` for a compiler version
    /// that the rlvm `scenario.cc::Header` heuristic historically
    /// requested a second-level XOR pass on (currently: `110002`).
    ///
    /// For Sukara-branch HD remasters (Sweetie HD and siblings) this is
    /// the correct call — outcome A in
    /// `RealLive encryption research notes`
    /// proves the rlvm branch is overly pessimistic for these titles.
    /// The warning fires so that downstream code (and audit tooling)
    /// can see the deliberate choice was made; it is never silent.
    Xor2NotApplied {
        /// The compiler version at the scene header that historically
        /// would have requested a second-level XOR.
        compiler_version: u32,
    },
}

impl std::fmt::Display for DecompressWarning {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DecompressWarning::Xor2NotApplied { compiler_version } => write!(
                formatter,
                "utsushi.reallive.decompress.xor2_not_applied: compiler_version={compiler_version} \
                 historically requested a second-level XOR pass; xor2_key=None was supplied \
                 (outcome A for Sukara-branch titles — see \
                 RealLive encryption research notes)",
            ),
        }
    }
}

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
    /// `SceneHeader::bytecode_offset .. + bytecode_compressed_size`.
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
    /// Sukara-branch titles.
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
        // real output: when the declared size is legitimate this preallocates it in full,
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
                    // observed Sweetie HD behaviour where the final run
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

/// Compress a byte slice using the AVG32-shape LZSS + XOR encoder.
///
/// **Test-only**. The on-disk format is read-side: real archives never
/// require us to *write* a compressed scene blob. This encoder exists
/// so the synthetic round-trip suite can prove the decoder's algorithm
/// is the inverse of a documented encoder, and so audit tooling can
/// fuzz the decoder against synthetic streams without depending on
/// rlvm to produce them.
///
/// The encoder emits literal-only tokens (no back-references) by
/// default; the caller passes an explicit list of
/// [`SyntheticToken`] values to exercise the full encoding space.
#[cfg(test)]
pub(crate) fn encode_synthetic(
    tokens: &[SyntheticToken],
    declared_uncompressed_size: u32,
) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();

    // 8-byte preamble: write the (compressed_size, uncompressed_size)
    // u32 LE pair XOR'd against the first 8 mask slots. The compressed
    // size is unknown at this point, so we patch it back in at the end.
    let preamble_placeholder = (0u32.to_le_bytes(), declared_uncompressed_size.to_le_bytes());
    for (i, &b) in preamble_placeholder
        .0
        .iter()
        .chain(preamble_placeholder.1.iter())
        .enumerate()
    {
        out.push(b ^ AVG32_XOR_MASK[i]);
    }

    let mut mask_idx: u8 = AVG32_COMPRESSED_PREAMBLE_LEN as u8;
    // Build the token stream: each block of up to 8 tokens shares one
    // 8-bit flag byte (LSB-first), per the rlvm decoder loop where
    // `bit` cycles 1, 2, 4, 8, 16, 32, 64, 128 and then 256 triggers a
    // flag-byte reload.
    let mut idx = 0usize;
    while idx < tokens.len() {
        let block_end = (idx + 8).min(tokens.len());
        let block = &tokens[idx..block_end];

        // Flag byte: bit set => literal, bit clear => back-reference.
        let mut flag: u8 = 0;
        for (i, token) in block.iter().enumerate() {
            if matches!(token, SyntheticToken::Literal(_)) {
                flag |= 1u8 << i;
            }
        }
        out.push(flag ^ AVG32_XOR_MASK[mask_idx as usize]);
        mask_idx = mask_idx.wrapping_add(1);

        for token in block {
            match token {
                SyntheticToken::Literal(byte) => {
                    out.push(byte ^ AVG32_XOR_MASK[mask_idx as usize]);
                    mask_idx = mask_idx.wrapping_add(1);
                }
                SyntheticToken::BackReference {
                    back_distance,
                    run_length,
                } => {
                    let count = ((*back_distance as u32) << 4) | ((*run_length as u32 - 2) & 0x0f);
                    let lo = (count & 0xff) as u8;
                    let hi = ((count >> 8) & 0xff) as u8;
                    out.push(lo ^ AVG32_XOR_MASK[mask_idx as usize]);
                    mask_idx = mask_idx.wrapping_add(1);
                    out.push(hi ^ AVG32_XOR_MASK[mask_idx as usize]);
                    mask_idx = mask_idx.wrapping_add(1);
                }
            }
        }

        idx = block_end;
    }

    // Patch the preamble's compressed-size slot now that we know the
    // total. The XOR is reversible, so we recompute the raw byte from
    // the new plaintext and the mask.
    let compressed_size = out.len() as u32;
    let bytes = compressed_size.to_le_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        out[i] = b ^ AVG32_XOR_MASK[i];
    }

    out
}

/// Synthetic token type the test-only [`encode_synthetic`] understands.
#[cfg(test)]
#[derive(Debug, Clone, Copy)]
pub(crate) enum SyntheticToken {
    /// Literal byte.
    Literal(u8),
    /// Back-reference. `back_distance` ∈ `1..=4095`, `run_length` ∈
    /// `2..=17`.
    BackReference { back_distance: u16, run_length: u8 },
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Convenience: decompress without any second-level XOR, asserting
    /// no warnings fire.
    fn decompress_no_xor2(compressed: &[u8], uncompressed_size: u32) -> Vec<u8> {
        let (out, warnings) = AvgDecompressor::new()
            .decompress(compressed, uncompressed_size, None, 0)
            .expect("synthetic stream must decompress cleanly");
        assert!(
            warnings.is_empty(),
            "synthetic test fixtures use compiler_version=0 so the xor2 warning must not fire; got: {warnings:?}",
        );
        out
    }

    #[test]
    fn truncated_input_shorter_than_preamble_is_typed_error() {
        let err = AvgDecompressor::new()
            .decompress(&[0u8; 4], 16, None, 0)
            .expect_err("4-byte input is shorter than the 8-byte preamble");
        match err {
            DecompressError::TruncatedInput {
                observed_len,
                needed,
                ..
            } => {
                assert_eq!(observed_len, 4);
                assert_eq!(needed, AVG32_COMPRESSED_PREAMBLE_LEN);
            }
            other => panic!("expected TruncatedInput, got: {other:?}"),
        }
    }

    #[test]
    fn empty_input_is_typed_error_not_silent_pass() {
        let err = AvgDecompressor::new()
            .decompress(&[], 0, None, 0)
            .expect_err("empty input must refuse silent zero-state");
        assert!(matches!(err, DecompressError::TruncatedInput { .. }));
    }

    /// A tiny stream declaring a ~4 GiB uncompressed size must not try to
    /// preallocate that much up front. The decode loop still surfaces the
    /// shortfall as a typed [`DecompressError::UnexpectedEndOfStream`]; the
    /// point of this test is that the call returns (rather than aborting on a
    /// failed multi-gigabyte reservation) because the initial capacity is
    /// bounded by the input length.
    #[test]
    fn implausible_declared_size_does_not_overallocate() {
        // 8-byte preamble + a single flag byte requesting literals, then the
        // stream is exhausted long before the declared `u32::MAX` bytes.
        let mut compressed = vec![0u8; AVG32_COMPRESSED_PREAMBLE_LEN];
        compressed.push(0xff); // flag byte: next tokens are literals
        compressed.push(0x41); // one literal, then end-of-stream

        let err = AvgDecompressor::new()
            .decompress(&compressed, u32::MAX, None, 0)
            .expect_err("a truncated stream declaring u32::MAX must error, not OOM");
        match err {
            DecompressError::UnexpectedEndOfStream {
                declared_uncompressed_size,
                ..
            } => assert_eq!(declared_uncompressed_size, u32::MAX as usize),
            other => panic!("expected UnexpectedEndOfStream, got: {other:?}"),
        }
    }

    /// Synthetic case #1: pure literals. All tokens are literals; no
    /// back-references. Exercises the literal path through the flag-byte
    /// cycle.
    #[test]
    fn synthetic_pure_literals_round_trip() {
        let plaintext: Vec<u8> = (0..32u8).collect();
        let tokens: Vec<SyntheticToken> = plaintext
            .iter()
            .map(|&b| SyntheticToken::Literal(b))
            .collect();
        let compressed = encode_synthetic(&tokens, plaintext.len() as u32);
        let out = decompress_no_xor2(&compressed, plaintext.len() as u32);
        assert_eq!(out, plaintext);
    }

    /// Synthetic case #2: pure back-references following a literal
    /// preamble. Emit 4 literals, then 4 back-references that copy them.
    #[test]
    fn synthetic_pure_back_references_round_trip() {
        // First emit the back-buffer as literals, then a single
        // back-reference that copies them.
        let mut tokens: Vec<SyntheticToken> = (0..4u8).map(SyntheticToken::Literal).collect();
        tokens.push(SyntheticToken::BackReference {
            back_distance: 4,
            run_length: 4,
        });
        // Expected output: 0,1,2,3, then 0,1,2,3 copied from back.
        let expected: Vec<u8> = vec![0, 1, 2, 3, 0, 1, 2, 3];
        let compressed = encode_synthetic(&tokens, expected.len() as u32);
        let out = decompress_no_xor2(&compressed, expected.len() as u32);
        assert_eq!(out, expected);
    }

    /// Synthetic case #3: 1-byte distance back-reference. Exercises the
    /// minimum back-distance value (== 1), which the decoder commonly
    /// uses to emit runs of a single byte (the back-reference straddles
    /// the dst end so `dst[start + i]` reads bytes the same loop just
    /// pushed).
    #[test]
    fn synthetic_one_byte_distance_back_reference_round_trip() {
        // Literal 0xAB, then a back-ref distance=1, run=5. The decoder
        // should overwrite-from-itself, producing six copies of 0xAB.
        let tokens = vec![
            SyntheticToken::Literal(0xAB),
            SyntheticToken::BackReference {
                back_distance: 1,
                run_length: 5,
            },
        ];
        let expected = vec![0xAB; 6];
        let compressed = encode_synthetic(&tokens, expected.len() as u32);
        let out = decompress_no_xor2(&compressed, expected.len() as u32);
        assert_eq!(out, expected);
    }

    /// Synthetic case #4: max-distance back-reference (4095 bytes).
    /// Exercises the addressable-window limit.
    #[test]
    fn synthetic_max_distance_back_reference_round_trip() {
        let back_distance = AVG32_LZSS_MAX_BACK_DISTANCE as u16; // 4095
        let mut tokens: Vec<SyntheticToken> = Vec::new();
        // Emit `back_distance` literal bytes (0..255 cycling).
        for i in 0..back_distance {
            tokens.push(SyntheticToken::Literal((i & 0xff) as u8));
        }
        // Now a back-reference at exactly that distance, run=2 (minimum
        // run length so we are testing the distance, not the length).
        tokens.push(SyntheticToken::BackReference {
            back_distance,
            run_length: 2,
        });
        let mut expected: Vec<u8> = (0..back_distance).map(|i| (i & 0xff) as u8).collect();
        // The back-reference copies `expected[0..2]` to the end (since
        // start = dst.len() - back_distance = 0).
        expected.push(expected[0]);
        expected.push(expected[1]);

        let compressed = encode_synthetic(&tokens, expected.len() as u32);
        let out = decompress_no_xor2(&compressed, expected.len() as u32);
        assert_eq!(out, expected);
    }

    /// Synthetic case #5: max-length back-reference (17 bytes).
    /// Exercises the upper end of the 4-bit `(run - 2)` field.
    #[test]
    fn synthetic_max_length_back_reference_round_trip() {
        let run_length = AVG32_LZSS_MAX_RUN as u8; // 17
        // Emit 17 literals (0xC0..0xC0+17), then a back-ref distance=17
        // run=17 to copy them.
        let mut tokens: Vec<SyntheticToken> = (0..run_length)
            .map(|i| SyntheticToken::Literal(0xC0u8.wrapping_add(i)))
            .collect();
        tokens.push(SyntheticToken::BackReference {
            back_distance: run_length as u16,
            run_length,
        });
        let mut expected: Vec<u8> = (0..run_length).map(|i| 0xC0u8.wrapping_add(i)).collect();
        expected.extend_from_slice(&expected.clone());

        let compressed = encode_synthetic(&tokens, expected.len() as u32);
        let out = decompress_no_xor2(&compressed, expected.len() as u32);
        assert_eq!(out, expected);
    }

    /// Synthetic case #6: mixed literals and back-references in an
    /// arbitrary pattern.
    #[test]
    fn synthetic_mixed_pattern_round_trip() {
        let tokens = vec![
            SyntheticToken::Literal(0x10),
            SyntheticToken::Literal(0x20),
            SyntheticToken::Literal(0x30),
            SyntheticToken::Literal(0x40),
            SyntheticToken::BackReference {
                back_distance: 2,
                run_length: 2,
            }, // copy [0x30, 0x40]
            SyntheticToken::Literal(0x50),
            SyntheticToken::BackReference {
                back_distance: 7,
                run_length: 3,
            }, // copy [0x10, 0x20, 0x30]
        ];
        let expected = vec![
            0x10, 0x20, 0x30, 0x40, // literals
            0x30, 0x40, // back-ref distance=2 run=2
            0x50, // literal
            0x10, 0x20, 0x30, // back-ref distance=7 run=3
        ];
        let compressed = encode_synthetic(&tokens, expected.len() as u32);
        let out = decompress_no_xor2(&compressed, expected.len() as u32);
        assert_eq!(out, expected);
    }

    /// Synthetic case #7: edge case at the flag-byte boundary. Emit
    /// exactly 16 literals (filling one flag byte) then a back-reference
    /// straddling the flag-byte reload.
    #[test]
    fn synthetic_flag_byte_boundary_round_trip() {
        let mut tokens: Vec<SyntheticToken> = (0..16u8).map(SyntheticToken::Literal).collect();
        // The 17th token is a back-reference; it must trigger a flag
        // reload before its bytes are read.
        tokens.push(SyntheticToken::BackReference {
            back_distance: 16,
            run_length: 4,
        });
        let mut expected: Vec<u8> = (0..16u8).collect();
        expected.extend_from_slice(&[0, 1, 2, 3]);

        let compressed = encode_synthetic(&tokens, expected.len() as u32);
        let out = decompress_no_xor2(&compressed, expected.len() as u32);
        assert_eq!(out, expected);
    }

    /// Synthetic case #8: edge case at end-of-stream. The final token
    /// must take the dst to exactly `uncompressed_size` — no overshoot,
    /// no undershoot.
    #[test]
    fn synthetic_end_of_stream_exact_fit_round_trip() {
        // 10 literals -> last back-reference saturates to exactly 12.
        let mut tokens: Vec<SyntheticToken> = (0..10u8).map(SyntheticToken::Literal).collect();
        tokens.push(SyntheticToken::BackReference {
            back_distance: 10,
            run_length: 2,
        });
        let mut expected: Vec<u8> = (0..10u8).collect();
        expected.push(0);
        expected.push(1);

        let compressed = encode_synthetic(&tokens, expected.len() as u32);
        let out = decompress_no_xor2(&compressed, expected.len() as u32);
        assert_eq!(out, expected);
        assert_eq!(
            out.len(),
            expected.len(),
            "decoder must stop at exactly uncompressed_size on the last token",
        );
    }

    #[test]
    fn back_reference_distance_zero_is_typed_error() {
        // Build a malformed stream by hand: literal 0xAA, then a
        // back-reference with back_distance=0 (which would be invalid).
        // Use the test-only encoder by injecting a token shape the
        // encoder is willing to write — it doesn't validate distance.
        let tokens = vec![
            SyntheticToken::Literal(0xAA),
            SyntheticToken::BackReference {
                back_distance: 0,
                run_length: 2,
            },
        ];
        let compressed = encode_synthetic(&tokens, 4);
        let err = AvgDecompressor::new()
            .decompress(&compressed, 4, None, 0)
            .expect_err("back_distance=0 must be rejected, not silently treated as 1");
        assert!(matches!(
            err,
            DecompressError::BackReferenceOutOfRange {
                back_distance: 0,
                ..
            }
        ));
    }

    #[test]
    fn back_reference_distance_beyond_emitted_is_typed_error() {
        let tokens = vec![
            SyntheticToken::Literal(0xAA),
            SyntheticToken::BackReference {
                back_distance: 5,
                run_length: 2,
            }, // dst.len() == 1 here, so distance=5 is invalid
        ];
        let compressed = encode_synthetic(&tokens, 4);
        let err = AvgDecompressor::new()
            .decompress(&compressed, 4, None, 0)
            .expect_err("back_distance > emitted must be rejected");
        assert!(matches!(
            err,
            DecompressError::BackReferenceOutOfRange {
                back_distance: 5,
                emitted: 1,
                ..
            }
        ));
    }

    #[test]
    fn unexpected_end_of_stream_is_typed_error() {
        // Encode a 4-literal stream but ask for 100 bytes of output.
        let tokens: Vec<SyntheticToken> = (0..4u8).map(SyntheticToken::Literal).collect();
        let compressed = encode_synthetic(&tokens, 100);
        let err = AvgDecompressor::new()
            .decompress(&compressed, 100, None, 0)
            .expect_err("over-declared uncompressed_size must surface as a typed error");
        assert!(matches!(
            err,
            DecompressError::UnexpectedEndOfStream {
                declared_uncompressed_size: 100,
                emitted: 4,
                ..
            }
        ));
    }

    #[test]
    fn xor2_pass_round_trips_when_key_supplied() {
        // Encode a synthetic stream, decompress with an XOR-2 key, and
        // verify the result is the plaintext XOR'd cyclically against
        // that key. (We pre-XOR the plaintext on the encode side so the
        // round-trip is symmetric.)
        let key: [u8; AVG32_XOR2_KEY_LEN] = [
            0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee,
            0xff, 0x00,
        ];
        let plaintext: Vec<u8> = (0..32u8).collect();
        // Pre-XOR the plaintext: the encoder emits these bytes, the
        // decompressor LZSS'es them out and then applies XOR-2 to undo
        // the pre-XOR, giving us back the original plaintext.
        let pre_xored: Vec<u8> = plaintext
            .iter()
            .enumerate()
            .map(|(i, b)| b ^ key[i % AVG32_XOR2_KEY_LEN])
            .collect();
        let tokens: Vec<SyntheticToken> = pre_xored
            .iter()
            .map(|&b| SyntheticToken::Literal(b))
            .collect();
        let compressed = encode_synthetic(&tokens, plaintext.len() as u32);
        let (out, warnings) = AvgDecompressor::new()
            .decompress(
                &compressed,
                plaintext.len() as u32,
                Some(&key),
                COMPILER_VERSION_1_10,
            )
            .expect("synthetic stream with XOR-2 key must decompress cleanly");
        assert!(
            warnings.is_empty(),
            "key was supplied so the xor2_not_applied warning must not fire; got: {warnings:?}",
        );
        assert_eq!(out, plaintext);
    }

    #[test]
    fn xor2_not_applied_warning_fires_for_compiler_version_110002_with_none_key() {
        // Emit a trivial single-literal stream so the decompress path
        // succeeds. The warning fires because compiler_version=110002
        // historically requested an XOR-2 pass and we passed `None`.
        let tokens = vec![SyntheticToken::Literal(0x0A)];
        let compressed = encode_synthetic(&tokens, 1);
        let (out, warnings) = AvgDecompressor::new()
            .decompress(&compressed, 1, None, COMPILER_VERSION_1_10)
            .expect("trivial stream must decompress");
        assert_eq!(out, vec![0x0A]);
        assert_eq!(warnings.len(), 1);
        match &warnings[0] {
            DecompressWarning::Xor2NotApplied { compiler_version } => {
                assert_eq!(*compiler_version, COMPILER_VERSION_1_10);
            }
        }
    }

    #[test]
    fn xor2_not_applied_warning_silent_for_non_110002_versions() {
        // compiler_version=10002 (pre-1.10) never requested XOR-2, so
        // passing `None` must produce no warning.
        let tokens = vec![SyntheticToken::Literal(0x0A)];
        let compressed = encode_synthetic(&tokens, 1);
        let (_out, warnings) = AvgDecompressor::new()
            .decompress(&compressed, 1, None, crate::COMPILER_VERSION_1_0)
            .expect("trivial stream must decompress");
        assert!(
            warnings.is_empty(),
            "pre-1.10 compiler version must not emit xor2_not_applied warning; got: {warnings:?}",
        );
    }

    #[test]
    fn avg32_mask_constants_match_published_values() {
        // Spot-check three values from the rlvm `xor_mask[256]` constant
        // (Peter Jolly, 2006). If a transcription error landed in the
        // constant the synthetic round-trip would fail, but pinning a
        // few spot values catches the regression with a clearer
        // diagnostic.
        assert_eq!(AVG32_XOR_MASK[0], 0x8b);
        assert_eq!(AVG32_XOR_MASK[7], 0x44);
        assert_eq!(AVG32_XOR_MASK[8], 0x00);
        assert_eq!(AVG32_XOR_MASK[255], 0x76);
        assert_eq!(AVG32_XOR_MASK.len(), AVG32_XOR_MASK_LEN);
    }

    #[test]
    fn display_messages_carry_typed_error_codes() {
        let err = AvgDecompressor::new()
            .decompress(&[0u8; 4], 16, None, 0)
            .unwrap_err();
        let rendered = err.to_string();
        assert!(
            rendered.starts_with("utsushi.reallive.decompress."),
            "error Display must carry the typed code prefix; got: {rendered}",
        );

        let warning = DecompressWarning::Xor2NotApplied {
            compiler_version: COMPILER_VERSION_1_10,
        };
        let rendered = warning.to_string();
        assert!(
            rendered.starts_with("utsushi.reallive.decompress.xor2_not_applied:"),
            "warning Display must carry the typed code prefix; got: {rendered}",
        );
    }
}
