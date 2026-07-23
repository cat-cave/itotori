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
/// must take the dst to exactly `uncompressed_size` — no overshoot
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
        0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
        0x00,
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
