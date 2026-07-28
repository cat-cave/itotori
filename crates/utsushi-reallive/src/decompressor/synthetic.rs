//! Test-only AVG32 LZSS encoder used to exercise the production decoder.

use super::{AVG32_COMPRESSED_PREAMBLE_LEN, AVG32_XOR_MASK};

/// Compress a token sequence using the AVG32-shape LZSS + XOR encoder.
///
/// The on-disk format is read-side; this exists solely for synthetic
/// decoder tests and audit fuzzing.
pub(crate) fn encode_synthetic(
    tokens: &[SyntheticToken],
    declared_uncompressed_size: u32,
) -> Vec<u8> {
    let mut out = Vec::new();
    let preamble = (0u32.to_le_bytes(), declared_uncompressed_size.to_le_bytes());
    for (index, byte) in preamble.0.iter().chain(preamble.1.iter()).enumerate() {
        out.push(byte ^ AVG32_XOR_MASK[index]);
    }

    let mut mask_idx = AVG32_COMPRESSED_PREAMBLE_LEN as u8;
    let mut index = 0;
    while index < tokens.len() {
        let end = (index + 8).min(tokens.len());
        let block = &tokens[index..end];
        let flag = block.iter().enumerate().fold(0u8, |flag, (bit, token)| {
            flag | u8::from(matches!(token, SyntheticToken::Literal(_))) << bit
        });
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
                    for byte in [(count & 0xff) as u8, (count >> 8) as u8] {
                        out.push(byte ^ AVG32_XOR_MASK[mask_idx as usize]);
                        mask_idx = mask_idx.wrapping_add(1);
                    }
                }
            }
        }
        index = end;
    }

    for (index, byte) in (out.len() as u32).to_le_bytes().iter().enumerate() {
        out[index] = byte ^ AVG32_XOR_MASK[index];
    }
    out
}

/// Synthetic token type understood by [`encode_synthetic`].
#[derive(Debug, Clone, Copy)]
pub(crate) enum SyntheticToken {
    Literal(u8),
    BackReference { back_distance: u16, run_length: u8 },
}
