use super::*;

/// A synthetic AVG32 token. The shared encoder ([`encode_avg32`]) turns a token
/// stream into the on-disk compressed bytes both decoders consume.
#[derive(Debug, Clone, Copy)]
pub(super) enum Token {
    /// A single literal byte.
    Literal(u8),
    /// A back-reference. `back_distance` is the window distance
    /// (`count >> 4`), `run_length` is the emitted length (`(count & 0x0f)
    /// 2`). The encoder does NOT validate these — malformed values are emitted
    /// verbatim so the decoders' error paths can be compared.
    BackRef { back_distance: u16, run_length: u8 },
}

/// Independent AVG32 LZSS + XOR encoder.
///
/// This is deliberately a *third* implementation, distinct from either
/// decoder's own test-only encoder, so the differential compares the two
/// decoders against a neutral producer rather than against one side's inverse.
///
/// Layout (matches the documented AVG32 format both decoders decode):
/// * 8-byte preamble carrying the LE `u32` pair `(compressed_size
///   uncompressed_size)` XOR'd against mask slots `0..8`. The decoders *skip*
///   the preamble (they only advance the mask index to 8), so its content is
///   cosmetic — we still write a truthful pair for realism.
/// * body: blocks of up to 8 tokens, each prefixed by one flag byte (LSB
///   first; bit set => literal, bit clear => back-reference). The XOR mask
///   index increments per emitted byte and wraps at 256 via `u8::wrapping_add`.
pub(super) fn encode_avg32(tokens: &[Token], declared_uncompressed_size: u32) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();

    // Reserve preamble space; patched with the real (compressed, uncompressed)
    // pair once the total length is known.
    out.extend_from_slice(&[0u8; AVG32_COMPRESSED_PREAMBLE_LEN]);

    let mut mask_idx: u8 = AVG32_COMPRESSED_PREAMBLE_LEN as u8;
    let mut idx = 0usize;
    while idx < tokens.len() {
        let block_end = (idx + 8).min(tokens.len());
        let block = &tokens[idx..block_end];

        let mut flag: u8 = 0;
        for (i, token) in block.iter().enumerate() {
            if matches!(token, Token::Literal(_)) {
                flag |= 1u8 << i;
            }
        }
        push_masked(&mut out, flag, &mut mask_idx);

        for token in block {
            match *token {
                Token::Literal(byte) => push_masked(&mut out, byte, &mut mask_idx),
                Token::BackRef {
                    back_distance,
                    run_length,
                } => {
                    let count = ((back_distance as u32) << 4) | ((run_length as u32 - 2) & 0x0f);
                    push_masked(&mut out, (count & 0xff) as u8, &mut mask_idx);
                    push_masked(&mut out, ((count >> 8) & 0xff) as u8, &mut mask_idx);
                }
            }
        }
        idx = block_end;
    }

    // Patch the preamble with the real (compressed_size, uncompressed_size)
    // pair now that the total is known (mask slots 0..8).
    let compressed_size = out.len() as u32;
    let mut preamble = [0u8; AVG32_COMPRESSED_PREAMBLE_LEN];
    preamble[0..4].copy_from_slice(&compressed_size.to_le_bytes());
    preamble[4..8].copy_from_slice(&declared_uncompressed_size.to_le_bytes());
    for (i, &plain) in preamble.iter().enumerate() {
        out[i] = plain ^ AVG32_XOR_MASK[i];
    }

    out
}

pub(super) fn push_masked(out: &mut Vec<u8>, byte: u8, mask_idx: &mut u8) {
    out.push(byte ^ AVG32_XOR_MASK[*mask_idx as usize]);
    *mask_idx = mask_idx.wrapping_add(1);
}

/// The category of a decode error, normalised across the two crates' distinct
/// error enums so the differential can assert both decoders reject a malformed
/// stream the *same way*.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum ErrCategory {
    Truncated,
    BackRefOutOfRange,
    UnexpectedEndOfStream,
}

fn kaifuu_category(err: &kaifuu_reallive::DecompressError) -> ErrCategory {
    use kaifuu_reallive::DecompressError as E;
    match err {
        E::TruncatedInput { .. } => ErrCategory::Truncated,
        E::BackReferenceOutOfRange { .. } => ErrCategory::BackRefOutOfRange,
        E::UnexpectedEndOfStream { .. } => ErrCategory::UnexpectedEndOfStream,
    }
}

fn utsushi_category(err: &utsushi_reallive::DecompressError) -> ErrCategory {
    use utsushi_reallive::DecompressError as E;
    match err {
        E::TruncatedInput { .. } => ErrCategory::Truncated,
        E::BackReferenceOutOfRange { .. } => ErrCategory::BackRefOutOfRange,
        E::UnexpectedEndOfStream { .. } => ErrCategory::UnexpectedEndOfStream,
    }
}

/// Decode `compressed` through BOTH decoders and assert they agree, returning
/// the shared output on success (for callers that also want to check it).
///
/// * Both `Ok` => byte-identical output required.
/// * Both `Err` => same [`ErrCategory`] required.
/// * One `Ok`, one `Err` => a REAL DIVERGENCE (the runtime and extract paths
///   disagree on whether the stream is decodable) — hard failure.
pub(super) fn assert_decoders_agree(
    label: &str,
    compressed: &[u8],
    dst_len: u32,
) -> Option<Vec<u8>> {
    let kaifuu = kaifuu_reallive::decompress_avg32(compressed, dst_len as usize);
    // Runtime side: xor2_key = None + compiler_version = 0 => first-level-only
    // no second-level XOR, no warning — the apples-to-apples codec comparison.
    let utsushi = AvgDecompressor::new().decompress(compressed, dst_len, None, 0);

    match (kaifuu, utsushi) {
        (Ok(k_out), Ok((u_out, warnings))) => {
            assert!(
                warnings.is_empty(),
                "[{label}] runtime decoder emitted warnings under compiler_version=0/None key \
                 (should be silent for the codec comparison): {warnings:?}",
            );
            assert_eq!(
                k_out,
                u_out,
                "[{label}] DIVERGENCE: extract (kaifuu) and runtime (utsushi) decoders produced \
                 DIFFERENT bytes for the same AVG32 stream — the runtime would replay different \
                 bytes than were extracted. kaifuu.len()={}, utsushi.len()={}",
                k_out.len(),
                u_out.len(),
            );
            Some(k_out)
        }
        (Err(k_err), Err(u_err)) => {
            let k_cat = kaifuu_category(&k_err);
            let u_cat = utsushi_category(&u_err);
            assert_eq!(
                k_cat, u_cat,
                "[{label}] error-category DIVERGENCE: extract (kaifuu) rejected as {k_cat:?} \
                 ({k_err}) but runtime (utsushi) rejected as {u_cat:?} ({u_err}) — the two \
                 decoders disagree on HOW a malformed stream fails",
            );
            None
        }
        (Ok(k_out), Err(u_err)) => panic!(
            "[{label}] DIVERGENCE: extract (kaifuu) DECODED the stream to {} bytes but runtime \
             (utsushi) REJECTED it ({u_err}) — the runtime would fail to replay a scene the \
             extract path accepted",
            k_out.len(),
        ),
        (Err(k_err), Ok((u_out, _))) => panic!(
            "[{label}] DIVERGENCE: runtime (utsushi) DECODED the stream to {} bytes but extract \
             (kaifuu) REJECTED it ({k_err}) — the extract path would fail to produce a scene the \
             runtime accepts",
            u_out.len(),
        ),
    }
}

/// The complete synthetic corpus, regenerated deterministically. Each entry is
/// `(label, compressed_stream, declared_uncompressed_size)`.
pub(super) fn synthetic_corpus() -> Vec<(&'static str, Vec<u8>, u32)> {
    let mut corpus: Vec<(&'static str, Vec<u8>, u32)> = Vec::new();

    let lits: Vec<Token> = (0..64u8).map(Token::Literal).collect();
    corpus.push(("lits64", encode_avg32(&lits, 64), 64));

    let single = vec![Token::Literal(0x5A)];
    corpus.push(("single", encode_avg32(&single, 1), 1));

    let mut selfoverlap = vec![Token::Literal(0xAB)];
    selfoverlap.push(Token::BackRef {
        back_distance: 1,
        run_length: 17,
    });
    corpus.push(("selfoverlap", encode_avg32(&selfoverlap, 18), 18));

    corpus
}
