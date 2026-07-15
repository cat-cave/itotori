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

    /// Like [`synth_type2`] but with a caller-chosen region rectangle and
    /// sub-bitmap top-left, so a test can drive out-of-range coordinates
    /// through the region-blit arithmetic (`dst = sub_xy + region.rect`).
    fn synth_type2_region(
        w: u16,
        h: u16,
        bgra: &[u8],
        rect: (i32, i32, i32, i32),
        sub_xy: (u16, u16),
    ) -> Vec<u8> {
        let wh4 = w as usize * h as usize * 4;
        assert_eq!(bgra.len(), wh4);
        let offset = 12usize;
        let block_len = 0x74 + 0x5c + wh4;
        let length = block_len;
        let mut unc = Vec::new();
        unc.extend_from_slice(&1u32.to_le_bytes()); // region_deal2
        unc.extend_from_slice(&(offset as u32).to_le_bytes()); // offset@4
        unc.extend_from_slice(&(length as u32).to_le_bytes()); // length@8
        unc.extend_from_slice(&[0u8; 0x74]); // region block header
        let mut sub = vec![0u8; 0x5c];
        sub[0..2].copy_from_slice(&sub_xy.0.to_le_bytes()); // sub x (bx)
        sub[2..4].copy_from_slice(&sub_xy.1.to_le_bytes()); // sub y (by)
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
        bytes.extend_from_slice(&rect.0.to_le_bytes()); // x1
        bytes.extend_from_slice(&rect.1.to_le_bytes()); // y1
        bytes.extend_from_slice(&rect.2.to_le_bytes()); // x2
        bytes.extend_from_slice(&rect.3.to_le_bytes()); // y2
        bytes.extend_from_slice(&0i32.to_le_bytes()); // origin_x
        bytes.extend_from_slice(&0i32.to_le_bytes()); // origin_y
        bytes.extend_from_slice(&((lzss.len() + 8) as u32).to_le_bytes());
        bytes.extend_from_slice(&(uncompressed_size as u32).to_le_bytes());
        bytes.extend_from_slice(&lzss);
        bytes
    }

    /// Build a type-2 container carrying TWO identical full-canvas region
    /// records whose rect `y1 == y2 == region_y`, exercising the
    /// "overlaid image" band-offset accumulation (`region.rect.y1 += dy`).
    fn synth_type2_two_identical_regions(w: u16, h: u16, region_y: i32) -> Vec<u8> {
        let wh4 = w as usize * h as usize * 4;
        let bgra = vec![0u8; wh4]; // transparent sub-bitmaps
        let block = || {
            let mut b = Vec::new();
            b.extend_from_slice(&[0u8; 0x74]); // block header
            let mut sub = vec![0u8; 0x5c];
            sub[6..8].copy_from_slice(&w.to_le_bytes());
            sub[8..10].copy_from_slice(&h.to_le_bytes());
            b.extend_from_slice(&sub);
            b.extend_from_slice(&bgra);
            b
        };
        let b0 = block();
        let b1 = block();
        let table_len = 4 + 8 * 2; // region_deal2 + two (offset,length) pairs
        let off0 = table_len;
        let off1 = off0 + b0.len();
        let mut unc = Vec::new();
        unc.extend_from_slice(&2u32.to_le_bytes()); // region_deal2
        unc.extend_from_slice(&(off0 as u32).to_le_bytes());
        unc.extend_from_slice(&(b0.len() as u32).to_le_bytes());
        unc.extend_from_slice(&(off1 as u32).to_le_bytes());
        unc.extend_from_slice(&(b1.len() as u32).to_le_bytes());
        unc.extend_from_slice(&b0);
        unc.extend_from_slice(&b1);
        let uncompressed_size = unc.len();

        let lzss = encode_all_literals(&unc, LzssVariant::Scn2k);
        let mut bytes = vec![G00_TYPE_REGIONED_LZSS];
        bytes.extend_from_slice(&w.to_le_bytes());
        bytes.extend_from_slice(&h.to_le_bytes());
        bytes.extend_from_slice(&2u32.to_le_bytes()); // region_count
        for _ in 0..2 {
            bytes.extend_from_slice(&0i32.to_le_bytes()); // x1
            bytes.extend_from_slice(&region_y.to_le_bytes()); // y1
            bytes.extend_from_slice(&((w as i32) - 1).to_le_bytes()); // x2
            bytes.extend_from_slice(&region_y.to_le_bytes()); // y2 == y1 (height 1)
            bytes.extend_from_slice(&0i32.to_le_bytes()); // origin_x
            bytes.extend_from_slice(&0i32.to_le_bytes()); // origin_y
        }
        bytes.extend_from_slice(&((lzss.len() + 8) as u32).to_le_bytes());
        bytes.extend_from_slice(&(uncompressed_size as u32).to_le_bytes());
        bytes.extend_from_slice(&lzss);
        bytes
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
