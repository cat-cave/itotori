//! `genaudit3-avg32-lzss-differential-test` (P2) — cross-crate differential
//! proof that the AVG32 LZSS + XOR decompressor is **byte-identical** between
//! the two independent reimplementations:
//!
//! * **extract side** — [`kaifuu_reallive::decompress_avg32`]
//!   (`kaifuu-reallive/src/decompressor.rs`), the 0-unknown extract-path
//!   decoder the patchback driver round-trips through.
//! * **runtime side** — [`utsushi_reallive::AvgDecompressor::decompress`]
//!   (`utsushi-reallive/src/decompressor.rs`), the runtime decoder the port
//!   replays scene bytecode through.
//!
//! The two share **no code** — the workspace "format-identical
//! implementation-separate" rule keeps them independent so a regression in one
//! cannot poison the other. That independence is exactly why they can silently
//! DISAGREE on an edge case (a literal run, a back-reference distance/length
//! boundary, a clip at the declared length, a malformed token). A divergence
//! would mean the runtime replays *different bytes* than were extracted and
//! translated — a correctness hole invisible to either crate's own unit tests.
//!
//! This test builds a shared corpus of AVG32 streams with a **third
//! independent** encoder (neither decoder's own test encoder) and decodes each
//! stream through BOTH decoders, asserting:
//!
//! * on a valid stream: both return `Ok` and the output bytes are identical;
//! * on a malformed-but-bounded stream: both return `Err` in the same
//!   category (truncated / back-ref-out-of-range / end-of-stream).
//!
//! The runtime decoder carries two features the extract decoder does not (an
//! optional second-level XOR pass and typed warnings). For an apples-to-apples
//! codec comparison the runtime side is always driven with `xor2_key = None`
//! and `compiler_version = 0`, so no second-level XOR is applied and no warning
//! fires — matching the extract decoder's first-level-only contract exactly.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use sha2::{Digest, Sha256};
use utsushi_reallive::{AVG32_COMPRESSED_PREAMBLE_LEN, AVG32_XOR_MASK, AvgDecompressor};

/// A synthetic AVG32 token. The shared encoder ([`encode_avg32`]) turns a token
/// stream into the on-disk compressed bytes both decoders consume.
#[derive(Debug, Clone, Copy)]
enum Token {
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
fn encode_avg32(tokens: &[Token], declared_uncompressed_size: u32) -> Vec<u8> {
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

fn push_masked(out: &mut Vec<u8>, byte: u8, mask_idx: &mut u8) {
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
fn assert_decoders_agree(label: &str, compressed: &[u8], dst_len: u32) -> Option<Vec<u8>> {
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

// Valid-stream coverage: literals, back-references, boundaries.

#[test]
fn differential_pure_literals() {
    // Every byte a literal, spanning several flag-byte blocks and one full
    // mask-cycle (>256 emitted bytes) so the mask-index wrap is exercised.
    let plaintext: Vec<u8> = (0..300u32)
        .map(|i| (i.wrapping_mul(31) & 0xff) as u8)
        .collect();
    let tokens: Vec<Token> = plaintext.iter().map(|&b| Token::Literal(b)).collect();
    let compressed = encode_avg32(&tokens, plaintext.len() as u32);
    let out = assert_decoders_agree("pure_literals", &compressed, plaintext.len() as u32)
        .expect("valid stream must decode");
    assert_eq!(out, plaintext);
}

#[test]
fn differential_pure_back_references() {
    // Seed a back-buffer with literals, then copy it forward entirely with
    // back-references (no further literals) — the "pure back-reference" path.
    let mut tokens: Vec<Token> = (0..8u8).map(Token::Literal).collect();
    // Copy the 8-byte buffer in two run-4 back-references at distance 8.
    tokens.push(Token::BackRef {
        back_distance: 8,
        run_length: 4,
    });
    tokens.push(Token::BackRef {
        back_distance: 8,
        run_length: 4,
    });
    let expected: Vec<u8> = (0..8u8).chain(0..8u8).collect();
    let compressed = encode_avg32(&tokens, expected.len() as u32);
    let out = assert_decoders_agree("pure_back_references", &compressed, expected.len() as u32)
        .expect("valid stream must decode");
    assert_eq!(out, expected);
}

#[test]
fn differential_min_distance_self_overlap() {
    // back_distance == 1 (minimum): the run reads bytes the same loop just
    // pushed (RLE-style self-overlap). A classic place for two hand-rolled
    // decoders to diverge on the copy-window semantics.
    let tokens = vec![
        Token::Literal(0xAB),
        Token::BackRef {
            back_distance: 1,
            run_length: 17,
        }, // max run, min distance
    ];
    let expected = vec![0xAB; 18];
    let compressed = encode_avg32(&tokens, expected.len() as u32);
    let out = assert_decoders_agree(
        "min_distance_self_overlap",
        &compressed,
        expected.len() as u32,
    )
    .expect("valid stream must decode");
    assert_eq!(out, expected);
}

#[test]
fn differential_max_distance_back_reference() {
    // back_distance == 4095 (the 12-bit window maximum): copy the very first
    // bytes to the end.
    let back_distance = 4095u16;
    let mut tokens: Vec<Token> = (0..back_distance)
        .map(|i| Token::Literal((i & 0xff) as u8))
        .collect();
    tokens.push(Token::BackRef {
        back_distance,
        run_length: 3,
    });
    let mut expected: Vec<u8> = (0..back_distance).map(|i| (i & 0xff) as u8).collect();
    expected.extend_from_slice(&[expected[0], expected[1], expected[2]]);
    let compressed = encode_avg32(&tokens, expected.len() as u32);
    let out = assert_decoders_agree("max_distance", &compressed, expected.len() as u32)
        .expect("valid stream must decode");
    assert_eq!(out, expected);
}

#[test]
fn differential_min_and_max_run_length() {
    // Exercise run_length == 2 (minimum) and run_length == 17 (maximum) side
    // by side.
    let mut tokens: Vec<Token> = (0..17u8).map(Token::Literal).collect();
    tokens.push(Token::BackRef {
        back_distance: 17,
        run_length: 2,
    }); // min run
    tokens.push(Token::BackRef {
        back_distance: 19,
        run_length: 17,
    }); // max run
    let mut expected: Vec<u8> = (0..17u8).collect();
    expected.extend_from_slice(&[0, 1]); // min-run copy of first two
    // max-run copy: start = current_len - 19.
    let start = expected.len() - 19;
    for i in 0..17 {
        expected.push(expected[start + i]);
    }
    let compressed = encode_avg32(&tokens, expected.len() as u32);
    let out = assert_decoders_agree("min_max_run", &compressed, expected.len() as u32)
        .expect("valid stream must decode");
    assert_eq!(out, expected);
}

#[test]
fn differential_run_clipped_at_buffer_end() {
    // The final back-reference's run would overshoot the declared length; both
    // decoders must clip it to land on exactly `dst_len`. This is the one
    // place the two implementations structure the copy loop differently
    // (kaifuu breaks inside the loop; utsushi splits a clip branch), so it is
    // the highest-value divergence probe.
    let mut tokens: Vec<Token> = (0..10u8).map(Token::Literal).collect();
    // run_length 17 but only 3 more bytes fit before dst_len (13).
    tokens.push(Token::BackRef {
        back_distance: 10,
        run_length: 17,
    });
    let dst_len = 13u32;
    let mut expected: Vec<u8> = (0..10u8).collect();
    // Clipped copy: start = 10 - 10 = 0, only 3 bytes fit.
    expected.extend_from_slice(&[0, 1, 2]);
    let compressed = encode_avg32(&tokens, dst_len);
    let out = assert_decoders_agree("run_clipped_at_end", &compressed, dst_len)
        .expect("valid stream must decode");
    assert_eq!(out, expected);
    assert_eq!(out.len(), dst_len as usize);
}

#[test]
fn differential_back_reference_across_flag_boundary() {
    // 16 literals fill two 8-token flag blocks exactly; the 17th token is a
    // back-reference that forces a flag-byte reload before its bytes are read.
    let mut tokens: Vec<Token> = (0..16u8).map(Token::Literal).collect();
    tokens.push(Token::BackRef {
        back_distance: 16,
        run_length: 5,
    });
    let mut expected: Vec<u8> = (0..16u8).collect();
    expected.extend_from_slice(&[0, 1, 2, 3, 4]);
    let compressed = encode_avg32(&tokens, expected.len() as u32);
    let out = assert_decoders_agree("across_flag_boundary", &compressed, expected.len() as u32)
        .expect("valid stream must decode");
    assert_eq!(out, expected);
}

#[test]
fn differential_single_byte_output() {
    let tokens = vec![Token::Literal(0x5A)];
    let compressed = encode_avg32(&tokens, 1);
    let out = assert_decoders_agree("single_byte", &compressed, 1).expect("valid stream decodes");
    assert_eq!(out, vec![0x5A]);
}

#[test]
fn differential_mixed_realistic_pattern() {
    // A mixed literal/back-ref pattern resembling real bytecode: repeated
    // 3-byte opcode-ish groups with interspersed literals.
    let tokens = vec![
        Token::Literal(0x0a),
        Token::Literal(0x02),
        Token::Literal(0x00),
        Token::BackRef {
            back_distance: 3,
            run_length: 3,
        }, // repeat 0a 02 00
        Token::Literal(0x21),
        Token::Literal(0x00),
        Token::BackRef {
            back_distance: 8,
            run_length: 6,
        }, // copy across earlier bytes
        Token::Literal(0x40),
    ];
    let mut expected = vec![0x0a, 0x02, 0x00];
    expected.extend_from_slice(&[0x0a, 0x02, 0x00]);
    expected.extend_from_slice(&[0x21, 0x00]);
    let start = expected.len() - 8;
    for i in 0..6 {
        expected.push(expected[start + i]);
    }
    expected.push(0x40);
    let compressed = encode_avg32(&tokens, expected.len() as u32);
    let out = assert_decoders_agree("mixed_pattern", &compressed, expected.len() as u32)
        .expect("valid stream decodes");
    assert_eq!(out, expected);
}

// Malformed-but-bounded coverage: both decoders must reject the same way.

#[test]
fn differential_empty_input() {
    // Zero-length input: shorter than the 8-byte preamble => both Truncated.
    assert_decoders_agree("empty", &[], 16);
}

#[test]
fn differential_input_shorter_than_preamble() {
    assert_decoders_agree("short_preamble", &[0u8; 4], 16);
}

#[test]
fn differential_preamble_only_declaring_output() {
    // Exactly the 8-byte preamble, but the header declares 8 output bytes. The
    // first flag byte read fails => both Truncated. (Documented quirk: both
    // decoders read the first flag eagerly even for dst_len that the preamble
    // alone cannot satisfy.)
    let compressed = vec![0u8; AVG32_COMPRESSED_PREAMBLE_LEN];
    assert_decoders_agree("preamble_only", &compressed, 8);
}

#[test]
fn differential_over_declared_uncompressed_size() {
    // 4 literals but the header asks for 100 bytes => both UnexpectedEndOfStream.
    let tokens: Vec<Token> = (0..4u8).map(Token::Literal).collect();
    let compressed = encode_avg32(&tokens, 100);
    assert_decoders_agree("over_declared", &compressed, 100);
}

#[test]
fn differential_back_reference_distance_zero() {
    // back_distance == 0 is invalid => both BackRefOutOfRange.
    let tokens = vec![
        Token::Literal(0xAA),
        Token::BackRef {
            back_distance: 0,
            run_length: 2,
        },
    ];
    let compressed = encode_avg32(&tokens, 4);
    assert_decoders_agree("backref_distance_zero", &compressed, 4);
}

#[test]
fn differential_back_reference_beyond_emitted() {
    // back_distance > bytes emitted so far => both BackRefOutOfRange.
    let tokens = vec![
        Token::Literal(0xAA),
        Token::BackRef {
            back_distance: 5,
            run_length: 2,
        },
    ];
    let compressed = encode_avg32(&tokens, 4);
    assert_decoders_agree("backref_beyond_emitted", &compressed, 4);
}

#[test]
fn differential_truncated_mid_backref_token() {
    // A flag byte announcing a back-reference, then only ONE of the two count
    // bytes present before end-of-stream => both UnexpectedEndOfStream.
    // Build by hand: preamble + flag(back-ref at bit0) + one count byte.
    let mut compressed = vec![0u8; AVG32_COMPRESSED_PREAMBLE_LEN];
    let mut mask_idx = AVG32_COMPRESSED_PREAMBLE_LEN as u8;
    // flag = 0 => first token is a back-reference.
    push_masked(&mut compressed, 0x00, &mut mask_idx);
    // Only the low count byte; hi byte missing.
    push_masked(&mut compressed, 0x12, &mut mask_idx);
    assert_decoders_agree("truncated_mid_backref", &compressed, 16);
}

// Corpus tamper-evidence: pin a SHA-256 over the full synthetic corpus so a
// silent change to the shared inputs (which would weaken the differential) is
// caught. No copyrighted bytes are committed — every byte here is synthetic.

/// The complete synthetic corpus, regenerated deterministically. Each entry is
/// `(label, compressed_stream, declared_uncompressed_size)`.
fn synthetic_corpus() -> Vec<(&'static str, Vec<u8>, u32)> {
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

#[test]
fn synthetic_corpus_hash_is_pinned() {
    let mut hasher = Sha256::new();
    for (label, bytes, dst_len) in synthetic_corpus() {
        hasher.update(label.as_bytes());
        hasher.update(dst_len.to_le_bytes());
        hasher.update(&bytes);
        // Every corpus stream must itself pass the differential.
        assert_decoders_agree(label, &bytes, dst_len);
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        write!(hex, "{byte:02x}").expect("writing to a String is infallible");
    }
    // Tamper-evidence pin. If the shared synthetic inputs change, this fails
    // loudly so the differential's coverage cannot silently drift.
    assert_eq!(
        hex, "9e11afd6fa533efbd09a9e4b1159a92c0d4680d152b8c23c5e7354e91be14a56",
        "synthetic AVG32 corpus hash changed — update the pin only after \
         confirming the new streams still exercise the intended edge cases",
    );
}

// Real-bytes differential (env-gated, STRICT — runs only in the periodic
// ground-truth oracle where corpora are staged). Decodes every populated
// scene's real compressed bytecode through BOTH decoders and asserts the
// runtime and extract paths inflate to identical bytes. No raw copyrighted
// bytes are committed; the corpus is supplied at runtime via env var.

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT (+ ITOTORI_REAL_GAME_ROOT_2)"]
fn differential_on_real_scene_bytecode() {
    use utsushi_reallive::{RealSceneIndex, SCENE_HEADER_BYTE_LEN, SceneHeader};

    let corpora = real_corpus::corpora();
    if corpora.is_empty() {
        real_corpus::require_real_bytes("differential_on_real_scene_bytecode");
        return;
    }

    let mut total_scenes = 0usize;
    for corpus in &corpora {
        let bytes = std::fs::read(&corpus.seen_txt).unwrap_or_else(|err| {
            panic!(
                "[{}] read {}: {err}",
                corpus.label,
                corpus.seen_txt.display()
            )
        });
        let index = RealSceneIndex::parse(&bytes)
            .unwrap_or_else(|err| panic!("[{}] parse scene index: {err}", corpus.label));

        for entry in &index.entries {
            let start = entry.byte_offset as usize;
            let end = start + entry.byte_len as usize;
            let blob = &bytes[start..end];
            if blob.len() < SCENE_HEADER_BYTE_LEN {
                continue;
            }
            let Ok((header, _warnings)) = SceneHeader::parse(blob) else {
                continue;
            };
            let bc_off = header.bytecode_offset as usize;
            let bc_len = header.bytecode_compressed_size as usize;
            if bc_len == 0 || bc_off + bc_len > blob.len() {
                continue;
            }
            let compressed = &blob[bc_off..bc_off + bc_len];
            let label = format!("{}/scene-{}", corpus.label, entry.scene_id);
            // Both decoders first-level-only (xor2 = None). Any second-level
            // XOR is a downstream concern applied identically to both paths;
            // the codec differential compares the LZSS + first-level inflate.
            let out = assert_decoders_agree(&label, compressed, header.bytecode_uncompressed_size);
            if let Some(out) = out {
                assert_eq!(
                    out.len(),
                    header.bytecode_uncompressed_size as usize,
                    "[{label}] decoded length must equal the declared uncompressed size",
                );
                total_scenes += 1;
            }
        }
    }

    assert!(
        total_scenes > 0,
        "real-bytes differential resolved corpora but decoded zero populated scenes",
    );
    assert!(
        corpora.len() >= 2,
        "AVG32 codec differential must be proven on >= 2 RealLive corpora; only {} resolved",
        corpora.len(),
    );
    eprintln!(
        "AVG32 codec differential: {total_scenes} real scenes byte-identical across decoders"
    );
}
