use super::*;

use super::g00_test_support::*;

#[test]
fn lzss_type0_all_literals_round_trip() {
    let bgr: Vec<u8> = (0..24u8).collect(); // 8 BGR pixels
    let enc = encode_all_literals(&bgr, LzssVariant::Type0Bgr);
    let out = lzss_decode(&enc, bgr.len(), LzssVariant::Type0Bgr);
    assert_eq!(out, bgr);
}

#[test]
fn lzss_scn2k_all_literals_round_trip() {
    let data: Vec<u8> = (0..20u8).collect();
    let enc = encode_all_literals(&data, LzssVariant::Scn2k);
    let out = lzss_decode(&enc, data.len(), LzssVariant::Scn2k);
    assert_eq!(out, data);
}

#[test]
fn lzss_type0_backreference_repeats_first_pixel() {
    // 4 BGR pixels; the 4th is a back-reference to the 1st.
    // Flag 0b0000_0111: bits 0,1,2 literal (3 pixels), bit 3 backref.
    let mut enc = vec![0b0000_0111u8];
    enc.extend_from_slice(&[0x11, 0x22, 0x33]); // pixel 0
    enc.extend_from_slice(&[0x44, 0x55, 0x66]); // pixel 1
    enc.extend_from_slice(&[0x77, 0x88, 0x99]); // pixel 2
    // token: distance = 3*3 = 9 bytes back, length = 3 bytes.
    // t = (distance/3)<<4 | (length/3 - 1) = (3<<4)|0 = 0x30.
    enc.extend_from_slice(&[0x30, 0x00]);
    let out = lzss_decode(&enc, 12, LzssVariant::Type0Bgr);
    assert_eq!(out.len(), 12);
    assert_eq!(&out[0..3], &[0x11, 0x22, 0x33]);
    assert_eq!(
        &out[9..12],
        &[0x11, 0x22, 0x33],
        "backref reproduced pixel 0"
    );
}

#[test]
fn lzss_scn2k_backreference_run_fill() {
    // literal 0xAB, then a token: distance 1, length 5 → run-fill.
    // token t: distance = t>>4 = 1, length = (t&0xf)+2 = 5 → t&0xf = 3.
    // t = (1<<4)|3 = 0x13 → lo=0x13, hi=0x00.
    let enc = vec![0b0000_0001u8, 0xAB, 0x13, 0x00];
    let out = lzss_decode(&enc, 6, LzssVariant::Scn2k);
    assert_eq!(out, vec![0xAB; 6]);
}

/// Assemble a type-0 g00 file from a BGR canvas (all-literal LZSS).
fn synth_type0(width: u16, height: u16, bgr: &[u8]) -> Vec<u8> {
    assert_eq!(bgr.len(), width as usize * height as usize * 3);
    let lzss = encode_all_literals(bgr, LzssVariant::Type0Bgr);
    let mut bytes = vec![G00_TYPE_RAW_BGR];
    bytes.extend_from_slice(&width.to_le_bytes());
    bytes.extend_from_slice(&height.to_le_bytes());
    let compressed_size = (lzss.len() + 8) as u32;
    let uncompressed_size = (width as u32) * (height as u32) * 4; // final 32-bpp size
    bytes.extend_from_slice(&compressed_size.to_le_bytes());
    bytes.extend_from_slice(&uncompressed_size.to_le_bytes());
    bytes.extend_from_slice(&lzss);
    bytes
}

#[test]
fn content_validator_rejects_strict_framing_and_token_failures() {
    assert_content_validator_rejects_strict_framing_and_token_failures();
}

#[test]
fn truncated_preamble_is_typed_error() {
    let err = decode_g00(&[0u8; 3]).expect_err("3-byte input is too short");
    match err {
        G00DecodeError::TruncatedPreamble {
            observed_len,
            required_len,
        } => {
            assert_eq!(observed_len, 3);
            assert_eq!(required_len, G00_HEADER_PREAMBLE_BYTE_LEN);
        }
        other => panic!("expected TruncatedPreamble, got: {other:?}"),
    }
}

#[test]
fn unknown_lead_byte_is_typed_error_not_silent_fallback() {
    let bytes = [0x42u8, 0x00, 0x00, 0x00, 0x00];
    let err = decode_g00(&bytes).expect_err("lead byte 0x42 must be rejected");
    match err {
        G00DecodeError::UnknownType { observed } => assert_eq!(observed, 0x42),
        other => panic!("expected UnknownType, got: {other:?}"),
    }
}

#[test]
fn parse_lzss_section_rejects_compressed_size_below_preamble() {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&4u32.to_le_bytes()); // compressed_size = 4 (< 8)
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&[0u8; 4]);
    let err = parse_lzss_section(&bytes, 0, G00Type::RawBgr)
        .expect_err("compressed_size < 8 must be rejected");
    match err {
        G00DecodeError::MalformedCompressedSize {
            g00_type,
            compressed_size,
            minimum,
        } => {
            assert_eq!(g00_type, G00Type::RawBgr);
            assert_eq!(compressed_size, 4);
            assert_eq!(minimum, 8);
        }
        other => panic!("expected MalformedCompressedSize, got: {other:?}"),
    }
}

#[test]
fn type0_decodes_bgr_to_rgba_with_opaque_alpha() {
    // 2 BGR pixels: (B=10,G=20,R=30), (B=50,G=60,R=70).
    let bgr = [10u8, 20, 30, 50, 60, 70];
    let bytes = synth_type0(2, 1, &bgr);
    let (image, warnings) = decode_g00(&bytes).expect("type-0 must decode");
    assert_eq!(image.g00_type, G00Type::RawBgr);
    assert_eq!(image.width, 2);
    assert_eq!(image.height, 1);
    assert_eq!(image.pixels_rgba.len(), 2 * 4);
    // BGR (10,20,30) -> RGBA (30,20,10,255).
    assert_eq!(&image.pixels_rgba[..4], &[30, 20, 10, 0xff]);
    assert_eq!(&image.pixels_rgba[4..], &[70, 60, 50, 0xff]);
    assert!(image.regions.is_empty());
    assert!(
        warnings.is_empty(),
        "clean round trip must not warn: {warnings:?}"
    );
    let validation = validate_g00_lzss_content(&bytes).unwrap();
    assert_eq!(
        (
            validation.g00_type,
            validation.region_count,
            validation.payload_bytes,
            validation.emitted_count
        ),
        (G00Type::RawBgr, 0, 7, 6)
    );
}

#[test]
fn type0_bgr_byte_order_is_not_treated_as_rgb() {
    // B != R so a silent skip of the reorder is observable.
    let bgr = [0x11u8, 0x22, 0x33]; // B=0x11, G=0x22, R=0x33
    let bytes = synth_type0(1, 1, &bgr);
    let (image, _) = decode_g00(&bytes).expect("type-0 must decode");
    assert_eq!(image.pixels_rgba[0], 0x33, "R slot holds on-disk R (not B)");
    assert_eq!(image.pixels_rgba[1], 0x22, "G slot holds on-disk G");
    assert_eq!(image.pixels_rgba[2], 0x11, "B slot holds on-disk B");
    assert_eq!(image.pixels_rgba[3], 0xff, "alpha is opaque");
}

#[test]
fn type0_short_stream_pads_and_warns_not_silent() {
    // Declare a 4x1 canvas but supply LZSS for only 1 pixel.
    let bgr = [1u8, 2, 3];
    let lzss = encode_all_literals(&bgr, LzssVariant::Type0Bgr);
    let mut bytes = vec![G00_TYPE_RAW_BGR];
    bytes.extend_from_slice(&4u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&((lzss.len() + 8) as u32).to_le_bytes());
    bytes.extend_from_slice(&(4u32 * 4).to_le_bytes()); // 4x1 canvas * 4 bytes
    bytes.extend_from_slice(&lzss);
    let (image, warnings) = decode_g00(&bytes).expect("short type-0 decodes best-effort");
    assert_eq!(image.pixels_rgba.len(), 4 * 4, "padded to full canvas");
    assert!(
        warnings.iter().any(|w| matches!(
            w,
            G00Warning::PayloadLengthMismatch {
                g00_type: G00Type::RawBgr,
                ..
            }
        )),
        "short stream must surface PayloadLengthMismatch; got {warnings:?}",
    );
    assert!(validate_g00_lzss_content(&bytes).is_err());
}

#[test]
fn type1_synthetic_palette_round_trip() {
    // SCN2k container: u16 colortable_len=2, then 2 BGRA entries
    // then indices [0,1] for a 2x1 image.
    let mut decoded = Vec::new();
    decoded.extend_from_slice(&2u16.to_le_bytes());
    decoded.extend_from_slice(&[0x00, 0x00, 0xff, 0xff]); // idx0 B,G,R,A = red
    decoded.extend_from_slice(&[0x00, 0xff, 0x00, 0xff]); // idx1 = green
    decoded.extend_from_slice(&[0, 1]); // indices
    let lzss = encode_all_literals(&decoded, LzssVariant::Scn2k);
    let mut file = vec![G00_TYPE_PALETTED_LZSS];
    file.extend_from_slice(&2u16.to_le_bytes());
    file.extend_from_slice(&1u16.to_le_bytes());
    file.extend_from_slice(&((lzss.len() + 8) as u32).to_le_bytes());
    // uncompressed_size: Jagarl decodes to declared+1; declared = decoded.len()-1.
    file.extend_from_slice(&((decoded.len() - 1) as u32).to_le_bytes());
    file.extend_from_slice(&lzss);
    let (image, warnings) = decode_g00(&file).expect("synthetic type-1 must decode");
    assert_eq!(image.g00_type, G00Type::PalettedLzss);
    assert_eq!(image.pixels_rgba.len(), 8);
    assert_eq!(
        &image.pixels_rgba[..4],
        &[0xff, 0x00, 0x00, 0xff],
        "idx0 red"
    );
    assert_eq!(
        &image.pixels_rgba[4..],
        &[0x00, 0xff, 0x00, 0xff],
        "idx1 green"
    );
    assert!(
        warnings.is_empty(),
        "clean type-1 must not warn: {warnings:?}"
    );
    assert_eq!(
        validate_g00_lzss_content(&file).unwrap().emitted_count,
        decoded.len()
    );
}

#[test]
fn type2_zero_regions_is_typed_error() {
    let mut bytes = vec![G00_TYPE_REGIONED_LZSS];
    bytes.extend_from_slice(&100u16.to_le_bytes());
    bytes.extend_from_slice(&50u16.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&[0u8; 8]);
    let err = decode_g00(&bytes).expect_err("zero-region type-2 must error");
    assert!(matches!(err, G00DecodeError::Type2ZeroRegions));
    assert!(matches!(
        validate_g00_lzss_content(&bytes),
        Err(G00ContentValidationError::Type2ZeroRegions)
    ));
}

fn append_type2_region(
    mut bytes: Vec<u8>,
    rect: (i32, i32, i32, i32),
    origin: (i32, i32),
) -> Vec<u8> {
    let mut record = Vec::new();
    for value in [rect.0, rect.1, rect.2, rect.3, origin.0, origin.1] {
        record.extend_from_slice(&value.to_le_bytes());
    }
    bytes.splice(33..33, record);
    bytes[5..9].copy_from_slice(&2u32.to_le_bytes());
    bytes
}

#[test]
fn pattern_geometry_reads_header_patterns_and_rlvm_fallback() {
    let type0 = synth_type0(2, 1, &[1, 2, 3, 4, 5, 6]);
    assert_eq!(
        probe_g00_pattern_geometry(&type0, 7).unwrap(),
        G00PatternGeometry {
            g00_type: G00Type::RawBgr,
            pattern_count: 1,
            selected_pattern: 0,
            width: 2,
            height: 1,
            origin_x: 0,
            origin_y: 0,
        }
    );
    let mut type1 = vec![G00_TYPE_PALETTED_LZSS, 4, 0, 3, 0];
    type1.extend_from_slice(&10u32.to_le_bytes());
    type1.extend_from_slice(&0u32.to_le_bytes());
    type1.extend_from_slice(&[1, 0]);
    assert_eq!(
        probe_g00_pattern_geometry(&type1, 7).unwrap(),
        G00PatternGeometry {
            g00_type: G00Type::PalettedLzss,
            pattern_count: 1,
            selected_pattern: 0,
            width: 4,
            height: 3,
            origin_x: 0,
            origin_y: 0,
        }
    );
    let type2 = append_type2_region(synth_type2(2, 1, &[0; 8]), (3, -2, 5, 1), (7, -9));
    let selected = probe_g00_pattern_geometry(&type2, 1).unwrap();
    assert_eq!(
        (
            selected.pattern_count,
            selected.selected_pattern,
            selected.width,
            selected.height,
            selected.origin_x,
            selected.origin_y
        ),
        (2, 1, 3, 4, 7, -9)
    );
    let fallback = probe_g00_pattern_geometry(&type2, 9).unwrap();
    assert_eq!(
        (
            fallback.selected_pattern,
            fallback.width,
            fallback.height,
            fallback.origin_x,
            fallback.origin_y
        ),
        (0, 2, 1, 0, 0)
    );
}

#[test]
fn pattern_geometry_rejects_invalid_or_unvalidated_metadata() {
    let inverted = append_type2_region(synth_type2(1, 1, &[0; 4]), (2, 0, 1, 0), (0, 0));
    assert!(matches!(
        probe_g00_pattern_geometry(&inverted, 1),
        Err(G00MetadataError::InvertedRegion { pattern: 1 })
    ));
    let overflow = append_type2_region(
        synth_type2(1, 1, &[0; 4]),
        (i32::MIN, 0, i32::MAX, 0),
        (0, 0),
    );
    assert!(matches!(
        probe_g00_pattern_geometry(&overflow, 1),
        Err(G00MetadataError::RegionDimensionOverflow { pattern: 1 })
    ));
    let truncated_table = [G00_TYPE_REGIONED_LZSS, 0, 0, 0, 0, 1, 0, 0, 0];
    assert!(matches!(
        probe_g00_pattern_geometry(&truncated_table, 0),
        Err(G00MetadataError::Validator(
            G00ContentValidationError::HeaderBounds { .. }
        ))
    ));
    let zero_table = [G00_TYPE_REGIONED_LZSS, 0, 0, 0, 0, 0, 0, 0, 0];
    assert!(matches!(
        probe_g00_pattern_geometry(&zero_table, 0),
        Err(G00MetadataError::Validator(
            G00ContentValidationError::Type2ZeroRegions
        ))
    ));
    assert!(matches!(
        probe_g00_pattern_geometry(&type0_with(&[1], 4), 0),
        Err(G00MetadataError::Validator(
            G00ContentValidationError::TruncatedLiteral { .. }
        ))
    ));
}

#[test]
fn type2_region_coordinate_overflow_is_skipped_not_panicking() {
    // The region's `x1` sits at i32::MAX and the sub-bitmap top-left is
    // non-zero, so the OLD unchecked `bx + region.rect.x1` (and the
    // per-pixel `dst_x + col`) OVERFLOW i32 — a panic under debug
    // `overflow-checks`, a silent wraparound into a wrong pixel under
    // release. Saturating arithmetic clamps the destination to i32::MAX
    // which the bounds check rejects, so the corrupt region writes
    // NOTHING and the canvas stays fully transparent — no panic, no OOB.
    let bgra = [0x11u8, 0x22, 0x33, 0xff, 0x44, 0x55, 0x66, 0x77];
    let bytes = synth_type2_region(2, 1, &bgra, (i32::MAX, 0, 1, 0), (1, 0));
    let (image, _warnings) = decode_g00(&bytes).expect("decode must not panic");
    assert_eq!(image.width, 2);
    assert_eq!(image.height, 1);
    assert_eq!(image.pixels_rgba.len(), 2 * 4);
    assert!(
        image.pixels_rgba.iter().all(|&b| b == 0),
        "out-of-range region must not write any pixel (stays transparent)"
    );
}

#[test]
fn type2_band_offset_overflow_is_saturated_not_panicking() {
    // Two identical regions whose rect `y1 == y2 == i32::MAX`. The
    // "overlaid image" munge accumulates a per-band `dy` into each
    // region's `y1`/`y2`; for the second band the OLD `region.rect.y1 +=
    // dy` OVERFLOWS i32 (panic under debug overflow-checks). Saturating
    // accumulation clamps to i32::MAX and the band is skipped by the
    // per-pixel bounds check — decode completes, no panic, no OOB.
    let bytes = synth_type2_two_identical_regions(2, 1, i32::MAX);
    let (image, _warnings) = decode_g00(&bytes).expect("decode must not panic");
    assert_eq!(image.width, 2);
    // Overlaid-image munge doubles the canvas height (2 bands × h=1).
    assert_eq!(image.regions.len(), 2);
    assert!(
        image.pixels_rgba.iter().all(|&b| b == 0),
        "out-of-range bands must not write any pixel"
    );
}

#[test]
fn type2_synthetic_region_container_round_trip() {
    // 2x1 canvas, first pixel BGRA (0x11,0x22,0x33,0xff).
    let bgra = [0x11u8, 0x22, 0x33, 0xff, 0x44, 0x55, 0x66, 0x77];
    let bytes = synth_type2(2, 1, &bgra);
    let (image, warnings) = decode_g00(&bytes).expect("type-2 must decode");
    assert_eq!(image.g00_type, G00Type::RegionedLzss);
    assert_eq!(image.width, 2);
    assert_eq!(image.height, 1);
    assert_eq!(image.regions.len(), 1);
    assert_eq!(image.regions[0].rect.width(), 2);
    assert_eq!(image.pixels_rgba.len(), 2 * 4);
    // BGRA (0x11,0x22,0x33,0xff) -> RGBA (0x33,0x22,0x11,0xff).
    assert_eq!(&image.pixels_rgba[..4], &[0x33, 0x22, 0x11, 0xff]);
    assert_eq!(&image.pixels_rgba[4..], &[0x66, 0x55, 0x44, 0x77]);
    assert!(
        warnings.is_empty(),
        "clean type-2 must not warn: {warnings:?}"
    );
    assert_eq!(validate_g00_lzss_content(&bytes).unwrap().region_count, 1);
}

#[test]
fn type2_region_off_by_one_inclusive_bound() {
    let rect = G00Rect {
        x1: 0,
        y1: 0,
        x2: 99,
        y2: 49,
    };
    assert_eq!(rect.width(), 100);
    assert_eq!(rect.height(), 50);
}

#[test]
fn corpus_histogram_emits_no_type_n_warning_for_missing_types() {
    let mut histogram = G00CorpusHistogram::default();
    histogram.observe_lead_byte(&[G00_TYPE_RAW_BGR, 0, 0, 0]);
    histogram.observe_lead_byte(&[G00_TYPE_RAW_BGR, 0, 0, 0]);
    histogram.observe_lead_byte(&[G00_TYPE_REGIONED_LZSS, 0, 0, 0]);
    assert_eq!(histogram.type0_count, 2);
    assert_eq!(histogram.type1_count, 0);
    assert_eq!(histogram.type2_count, 1);
    let warnings = histogram.missing_type_warnings();
    assert_eq!(warnings.len(), 1);
    assert!(matches!(
        warnings[0],
        G00Warning::NoTypeNInCorpus {
            g00_type: G00Type::PalettedLzss
        }
    ));
}

#[test]
fn corpus_histogram_unreadable_files_bucketed_separately() {
    let mut histogram = G00CorpusHistogram::default();
    histogram.observe_lead_byte(&[]);
    histogram.observe_lead_byte(&[0xFF]);
    assert_eq!(histogram.unreadable_count, 1);
    assert_eq!(histogram.unknown_count, 1);
    assert_eq!(histogram.total(), 2);
}

#[test]
fn warning_display_carries_typed_code_prefix() {
    let warning = G00Warning::NoTypeNInCorpus {
        g00_type: G00Type::PalettedLzss,
    };
    assert!(
        warning
            .to_string()
            .starts_with("utsushi.reallive.g00_no_type_N_in_corpus:")
    );
}

#[test]
fn error_display_carries_typed_code_prefix() {
    let err = G00DecodeError::UnknownType { observed: 0xff };
    assert!(err.to_string().starts_with("utsushi.reallive.g00."));
}

#[test]
fn g00_type_lead_byte_round_trips() {
    for ty in [
        G00Type::RawBgr,
        G00Type::PalettedLzss,
        G00Type::RegionedLzss,
    ] {
        assert_eq!(G00Type::from_lead_byte(ty.lead_byte()), Some(ty));
    }
    assert_eq!(G00Type::from_lead_byte(3), None);
}
