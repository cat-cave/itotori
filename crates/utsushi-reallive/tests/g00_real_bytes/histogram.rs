use super::*;

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn g00_corpus_histogram_real_bytes_2450_files() {
    let Some(g00_dir) = real_g00_dir() else {
        real_corpus::require_real_bytes(
            "utsushi-reallive g00_corpus_histogram_real_bytes_2450_files",
        );
        return;
    };

    let entries = fs::read_dir(&g00_dir)
        .unwrap_or_else(|err| panic!("failed to walk g00 directory {}: {err}", g00_dir.display()));

    let mut histogram = G00CorpusHistogram::default();
    for entry in entries {
        let entry = entry.expect("DirEntry read must succeed");
        let path = entry.path();
        if !path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("g00"))
        {
            continue;
        }
        match fs::read(&path) {
            Ok(bytes) => histogram.observe_lead_byte(&bytes),
            Err(_) => {
                histogram.unreadable_count += 1;
            }
        }
    }

    assert_eq!(
        histogram.total(),
        PRIMARY_CORPUS_G00_CORPUS_SIZE,
        "primary_corpus HD g00 corpus size is pinned at {PRIMARY_CORPUS_G00_CORPUS_SIZE} files in 's acceptance block",
    );
    eprintln!(
        "primary_corpus HD g00 lead-byte histogram: type0={} type1={} type2={} unknown={} unreadable={}",
        histogram.type0_count,
        histogram.type1_count,
        histogram.type2_count,
        histogram.unknown_count,
        histogram.unreadable_count,
    );

    let warnings = histogram.missing_type_warnings();
    // For primary_corpus HD specifically: byte-0 spot-check observed
    // 2145 type-0, 0 type-1, 305 type-2 files. So the only missing
    // type is type 1, and the warnings vec must contain exactly one
    // NoTypeNInCorpus for `G00Type::PalettedLzss`.
    assert_eq!(
        warnings.len(),
        1,
        "primary_corpus HD must surface exactly one missing-type warning (type 1); got: {warnings:?}",
    );
    assert!(
        matches!(
            warnings[0],
            G00Warning::NoTypeNInCorpus {
                g00_type: G00Type::PalettedLzss
            }
        ),
        "missing-type warning must point at PalettedLzss for primary_corpus HD; got: {:?}",
        warnings[0],
    );
    let rendered = warnings[0].to_string();
    assert!(
        rendered.starts_with("utsushi.reallive.g00_no_type_N_in_corpus:"),
        "Display string must carry the spec-defined typed prefix; got: {rendered}",
    );

    assert!(
        histogram.type0_count > 0,
        "primary_corpus HD must carry at least one type-0 file (BACK.g00 is the documented type-0 pin)",
    );
    assert!(
        histogram.type2_count > 0,
        "primary_corpus HD must carry at least one type-2 file (btn000.g00 is the documented type-2 pin)",
    );
    assert_eq!(
        histogram.type1_count, 0,
        "primary_corpus HD's spot-check observed zero type-1 files; the typed warning above pins this",
    );
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn g00_type2_btn000_decodes_header_and_regions() {
    let Some(g00_dir) = real_g00_dir() else {
        real_corpus::require_real_bytes(
            "utsushi-reallive g00_type2_btn000_decodes_header_and_regions",
        );
        return;
    };
    let path = g00_dir.join(PRIMARY_CORPUS_TYPE2_BTN_FILENAME);
    let bytes =
        fs::read(&path).unwrap_or_else(|err| panic!("failed to read {}: {err}", path.display()));

    // The decode call exercises header parsing, region-table parsing
    // and the LZSS pixel-stream decode. The acceptance criterion
    // specifically requires the region table to be usable by
    // `objLoadRegion` (). The header/region-table layer is
    // hand-verified below so the acceptance does not depend on the
    // LZSS payload round-trip matching this exact file's variant.
    let raw_type = bytes[0];
    assert_eq!(
        raw_type, G00_TYPE_REGIONED_LZSS,
        "btn000.g00 must be lead-byte type 2",
    );
    let width = u16::from_le_bytes([bytes[1], bytes[2]]) as u32;
    let height = u16::from_le_bytes([bytes[3], bytes[4]]) as u32;
    let region_count = u32::from_le_bytes([bytes[5], bytes[6], bytes[7], bytes[8]]) as usize;
    assert!(width > 0, "btn000.g00 width must be non-zero");
    assert!(height > 0, "btn000.g00 height must be non-zero");
    assert!(
        region_count > 0,
        "btn000.g00 region_count must be non-zero (type 2 requires regions)",
    );

    let (image, warnings) = decode_g00(&bytes)
        .unwrap_or_else(|err| panic!("btn000.g00 must decode through type-2 path: {err}"));

    assert_eq!(image.g00_type, G00Type::RegionedLzss);
    assert_eq!(image.width, width);
    // btn000.g00 is an "overlaid" type-2 image: its `region_count`
    // identical full-canvas region records are stacked vertically, so the
    // reconstructed canvas height is `header_height * region_count` (the
    // reference decoder performs the same munge). The decoded height must
    // therefore be a positive whole multiple of the header height.
    assert!(
        image.height >= height && image.height % height == 0,
        "type-2 canvas height {} must be a positive multiple of header height {height}",
        image.height,
    );
    assert_eq!(
        image.pixels_rgba.len(),
        (image.width as usize) * (image.height as usize) * 4,
        "type-2 pixel buffer must fill the reconstructed canvas",
    );
    // The decoded canvas must be coherent, not garbage (the pre-fix
    // decoder produced noise here too).
    let btn_mad = vertical_row_mad(
        &image.pixels_rgba,
        image.width as usize,
        image.height as usize,
    );
    eprintln!("btn000.g00 vertical row-MAD = {btn_mad:.2}");
    assert!(
        btn_mad < 60.0,
        "btn000.g00 decoded to incoherent noise (row-MAD {btn_mad:.2})",
    );
    assert_eq!(
        image.regions.len(),
        region_count,
        "decoded regions vec must mirror on-disk region_count: \
         audit-focus regression check for 'Region table off-by-one'",
    );
    for (i, region) in image.regions.iter().enumerate() {
        assert!(
            region.rect.width() > 0,
            "region {i} rect must have non-zero width; got: {:?}",
            region.rect,
        );
        assert!(
            region.rect.height() > 0,
            "region {i} rect must have non-zero height; got: {:?}",
            region.rect,
        );
        assert!(
            region.name.is_none(),
            "region name must be None from on-disk record \
             (cross-referenced names land at the opcode layer)",
        );
    }

    for warning in &warnings {
        eprintln!("btn000.g00 decode warning (audit-traceable, not a failure): {warning}",);
    }

    // Audit-focus pin: hand-verify the first region's rect is
    // non-inverted (catches 'Region table off-by-one').
    let r0_x1 = i32::from_le_bytes([bytes[9], bytes[10], bytes[11], bytes[12]]);
    let r0_y1 = i32::from_le_bytes([bytes[13], bytes[14], bytes[15], bytes[16]]);
    let r0_x2 = i32::from_le_bytes([bytes[17], bytes[18], bytes[19], bytes[20]]);
    let r0_y2 = i32::from_le_bytes([bytes[21], bytes[22], bytes[23], bytes[24]]);
    assert!(
        r0_x2 >= r0_x1,
        "first region rect inverted on X axis (x1={r0_x1}, x2={r0_x2}): would indicate decoder \
         hoisted the wrong fields",
    );
    assert!(
        r0_y2 >= r0_y1,
        "first region rect inverted on Y axis (y1={r0_y1}, y2={r0_y2})",
    );
    // Cross-check against the typed decode.
    assert_eq!(image.regions[0].rect.x1, r0_x1);
    assert_eq!(image.regions[0].rect.x2, r0_x2);
    assert_eq!(image.regions[0].rect.y1, r0_y1);
    assert_eq!(image.regions[0].rect.y2, r0_y2);
}

#[test]
fn g00_corpus_histogram_no_path_set_documents_skip() {
    // Mirror the `gameexe_real_bytes.rs::verify_real_bytes_known_values_skips_when_env_unset`
    // pattern: when the env var is unset, the real-bytes tests above
    // print a diagnostic and return. This test makes the skip
    // explicit so the CI run records the "skipped, not silently
    // passed" semantics.
    if real_corpus::game_root().is_some() {
        return;
    }
    eprintln!(
        "ITOTORI_REAL_GAME_ROOT not set — g00 corpus histogram real-bytes tests are \
         #[ignore]-gated and only run with ITOTORI_REAL_GAME_ROOT set.",
    );
}

#[test]
fn g00_type_lead_byte_constants_match_spec() {
    // Pin the spec-defined lead-byte values so a transcription
    // regression in `src/g00.rs` surfaces here with a clear failure.
    assert_eq!(G00_TYPE_RAW_BGR, 0);
    assert_eq!(G00_TYPE_PALETTED_LZSS, 1);
    assert_eq!(G00_TYPE_REGIONED_LZSS, 2);
}
