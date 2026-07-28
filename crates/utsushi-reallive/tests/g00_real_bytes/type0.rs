use super::*;

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn g00_type0_back_decodes() {
    let Some(g00_dir) = real_g00_dir() else {
        real_corpus::require_real_bytes("utsushi-reallive g00_type0_back_decodes");
        return;
    };
    let path = g00_dir.join(PRIMARY_CORPUS_TYPE0_BACK_FILENAME);
    let bytes =
        fs::read(&path).unwrap_or_else(|err| panic!("failed to read {}: {err}", path.display()));

    let (image, warnings) = decode_g00(&bytes)
        .unwrap_or_else(|err| panic!("BACK.g00 must decode through type-0 path: {err}"));

    assert_eq!(image.g00_type, G00Type::RawBgr);
    assert_eq!(
        image.width, PRIMARY_CORPUS_BACK_WIDTH,
        "BACK.g00 width is pinned at {PRIMARY_CORPUS_BACK_WIDTH} per the documented header bytes",
    );
    assert_eq!(
        image.height, PRIMARY_CORPUS_BACK_HEIGHT,
        "BACK.g00 height is pinned at {PRIMARY_CORPUS_BACK_HEIGHT}",
    );
    assert!(
        image.width > 0,
        "decoded width must be non-zero per  acceptance criterion 1",
    );
    let expected_pixel_byte_count = (image.width as usize) * (image.height as usize) * 4;
    assert_eq!(
        image.pixels_rgba.len(),
        expected_pixel_byte_count,
        "pixels_rgba.len() must equal width * height * 4 (== 3686400) per acceptance criterion 1",
    );
    assert!(
        image.regions.is_empty(),
        "type-0 image must carry no regions; got: {:?}",
        image.regions,
    );

    // The relative-LZ77 decode must consume the whole payload and fill
    // the exact canvas: BACK.g00 is 1280*720*4 = 3686400 bytes with NO
    // PayloadLengthMismatch. The pre-fix decoder produced a truncated
    // garbage buffer; a zero-warning full fill is only reachable with the
    // correct algorithm.
    assert!(
        warnings.is_empty(),
        "BACK.g00 must decode with zero warnings (exact fill, no PayloadLengthMismatch); \
         got: {warnings:?}",
    );

    // Audit-focus: the BGR -> RGBA reorder fired. BACK.g00's first pixel
    // is not grey, so B != R; if the reorder were skipped, slot 0 (R)
    // would hold the on-disk B byte.
    // Coherence gate: a real photographic background has strong vertical
    // correlation. Garbage (the pre-fix state) measured ≈ 77; this file
    // decodes to ≈ 4. Pin it below the coherent threshold so a decode
    // regression to noise can never pass this test again.
    let mad = vertical_row_mad(
        &image.pixels_rgba,
        image.width as usize,
        image.height as usize,
    );
    eprintln!("BACK.g00 vertical row-MAD = {mad:.2} (coherent < {COHERENT_ROW_MAD_MAX})");
    assert!(
        mad < COHERENT_ROW_MAD_MAX,
        "BACK.g00 decoded to incoherent noise (row-MAD {mad:.2} ≥ {COHERENT_ROW_MAD_MAX}): \
         the LZSS decode is wrong",
    );
}
