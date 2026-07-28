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


