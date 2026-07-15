    /// Encode a byte stream as an all-literal g00 LZSS stream for the
    /// given variant (`bit = 1` → literal). Because the decoder stops the
    /// instant `out_size` is reached, the trailing (clear) bits of a
    /// partial final flag group are never interpreted as tokens, so this
    /// round-trips for any length.
    fn encode_all_literals(bytes: &[u8], variant: LzssVariant) -> Vec<u8> {
        let unit = variant.literal_unit();
        assert_eq!(bytes.len() % unit, 0, "literal payload must be whole units");
        let units: Vec<&[u8]> = bytes.chunks_exact(unit).collect();
        let mut out = Vec::new();
        let mut i = 0;
        while i < units.len() {
            let end = (i + 8).min(units.len());
            let count = end - i;
            let flag: u8 = if count == 8 { 0xff } else { (1u8 << count) - 1 };
            out.push(flag);
            for u in &units[i..end] {
                out.extend_from_slice(u);
            }
            i = end;
        }
        out
    }

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

    fn type0_with(payload: &[u8], declared_output: u32) -> Vec<u8> {
        let mut bytes = vec![G00_TYPE_RAW_BGR, 1, 0, 1, 0];
        bytes.extend_from_slice(&((payload.len() + 8) as u32).to_le_bytes());
        bytes.extend_from_slice(&declared_output.to_le_bytes());
        bytes.extend_from_slice(payload);
        bytes
    }

    #[test]
    fn content_validator_rejects_strict_framing_and_token_failures() {
        let err = |bytes: &[u8]| validate_g00_lzss_content(bytes).unwrap_err();
        assert!(matches!(
            err(&[0; 4]),
            G00ContentValidationError::TruncatedPreamble
        ));
        assert!(matches!(
            err(&[3; 5]),
            G00ContentValidationError::UnknownType
        ));
        assert!(matches!(
            err(&[0; 5]),
            G00ContentValidationError::HeaderBounds { .. }
        ));
        let mut type2 = vec![G00_TYPE_REGIONED_LZSS, 0, 0, 0, 0];
        type2.extend_from_slice(&1u32.to_le_bytes());
        assert!(matches!(
            err(&type2),
            G00ContentValidationError::HeaderBounds { .. }
        ));
        let mut malformed = type0_with(&[7, 1, 2, 3], 4);
        malformed[5..9].copy_from_slice(&4u32.to_le_bytes());
        assert!(matches!(
            err(&malformed),
            G00ContentValidationError::InvalidCompressedSize
        ));
        let mut outer = type0_with(&[7, 1, 2, 3], 4);
        outer[5..9].copy_from_slice(&13u32.to_le_bytes());
        assert!(matches!(
            err(&outer),
            G00ContentValidationError::OuterLengthMismatch { .. }
        ));
        assert!(matches!(
            err(&type0_with(&[7, 1, 2, 3], 3)),
            G00ContentValidationError::DeclaredOutputMismatch { .. }
        ));
        assert!(matches!(
            err(&type0_with(&[1], 4)),
            G00ContentValidationError::TruncatedLiteral { .. }
        ));
        assert!(matches!(
            err(&type0_with(&[0, 0], 4)),
            G00ContentValidationError::TruncatedBackreference { .. }
        ));
        assert!(matches!(
            err(&type0_with(&[0, 0, 0], 4)),
            G00ContentValidationError::InvalidDistance { .. }
        ));
        let mut type1 = vec![G00_TYPE_PALETTED_LZSS, 0, 0, 0, 0];
        type1.extend_from_slice(&12u32.to_le_bytes());
        type1.extend_from_slice(&1u32.to_le_bytes());
        type1.extend_from_slice(&[1, 0xaa, 0x10, 0]);
        assert!(matches!(
            err(&type1),
            G00ContentValidationError::OutputOverrun { .. }
        ));
        assert!(matches!(
            err(&type0_with(&[], 4)),
            G00ContentValidationError::OutputUnderrun { .. }
        ));
        let mut trailing = type0_with(&[1, 1, 2, 3], 4);
        trailing.push(0);
        let compressed_size = (trailing.len() - 5) as u32;
        trailing[5..9].copy_from_slice(&compressed_size.to_le_bytes());
        assert!(matches!(
            err(&trailing),
            G00ContentValidationError::UnconsumedPayload { .. }
        ));
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

    /// Build a minimal but format-faithful type-2 container + file for a
    /// `w`×`h` canvas with one full-canvas region whose sub-bitmap pixels
    /// are `bgra`.
    fn synth_type2(w: u16, h: u16, bgra: &[u8]) -> Vec<u8> {
        let wh4 = w as usize * h as usize * 4;
        assert_eq!(bgra.len(), wh4);
        // Container: [u32 region_deal2=1][u32 offset=12][u32 length]
        //            [0x74 header][0x5c subheader][w*h*4 pixels]
        let offset = 12usize;
        let block_len = 0x74 + 0x5c + wh4;
        let length = block_len;
        let mut unc = Vec::new();
        unc.extend_from_slice(&1u32.to_le_bytes()); // region_deal2
        unc.extend_from_slice(&(offset as u32).to_le_bytes()); // offset@4
        unc.extend_from_slice(&(length as u32).to_le_bytes()); // length@8
        assert_eq!(unc.len(), offset);
        unc.extend_from_slice(&[0u8; 0x74]); // region block header
        let mut sub = vec![0u8; 0x5c];
        sub[0..2].copy_from_slice(&0u16.to_le_bytes()); // x
        sub[2..4].copy_from_slice(&0u16.to_le_bytes()); // y
        sub[6..8].copy_from_slice(&w.to_le_bytes()); // w
        sub[8..10].copy_from_slice(&h.to_le_bytes()); // h
        unc.extend_from_slice(&sub);
        unc.extend_from_slice(bgra);
        let uncompressed_size = unc.len();

        let lzss = encode_all_literals(&unc, LzssVariant::Scn2k);
        let mut bytes = vec![G00_TYPE_REGIONED_LZSS];
        bytes.extend_from_slice(&w.to_le_bytes());
        bytes.extend_from_slice(&h.to_le_bytes());
        bytes.extend_from_slice(&1u32.to_le_bytes()); // region_count
        // region record: x1,y1,x2,y2,origin_x,origin_y
        bytes.extend_from_slice(&0i32.to_le_bytes());
        bytes.extend_from_slice(&0i32.to_le_bytes());
        bytes.extend_from_slice(&((w as i32) - 1).to_le_bytes());
        bytes.extend_from_slice(&((h as i32) - 1).to_le_bytes());
        bytes.extend_from_slice(&0i32.to_le_bytes());
        bytes.extend_from_slice(&0i32.to_le_bytes());
        bytes.extend_from_slice(&((lzss.len() + 8) as u32).to_le_bytes());
        bytes.extend_from_slice(&(uncompressed_size as u32).to_le_bytes());
        bytes.extend_from_slice(&lzss);
        bytes
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
