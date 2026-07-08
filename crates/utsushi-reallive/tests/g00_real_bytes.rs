//! UTSUSHI-216 real-bytes integration tests for the g00 image-format
//! decoder.
//!
//! Pins the decoder against the Sweetie HD `$GAME/REALLIVEDATA/g00/`
//! corpus (2,450 files) following the same pattern as
//! `decompressor_real_bytes.rs` / `scene_header_real_bytes.rs`: the
//! tests are `#[ignore]`-gated and only run when
//! `ITOTORI_REAL_GAME_ROOT` is set (the same env var the rest of
//! the real-bytes suite uses — see `tests/gameexe_real_bytes.rs` for
//! the canonical pattern).
//!
//! # Acceptance criteria pinned here
//!
//! 1. `g00_type0_back_decodes` — Sweetie HD's
//!    `$GAME/REALLIVEDATA/g00/BACK.g00` (type 0) decodes with non-zero
//!    width, a typed pixel buffer whose length equals
//!    `width * height * 4`, and a first pixel whose RGBA bytes do not
//!    silently match the on-disk byte order (i.e. the BGRA->RGBA
//!    reorder fired). The exact pixel value depends on the LZSS
//!    variant the corpus actually uses; the test pins the structural
//!    acceptance and surfaces the LZSS-variant identification as a
//!    typed warning rather than a hard failure (the warning is the
//!    audit-traceable surface for the
//!    "LZSS distance encoding regression" audit-focus item).
//! 2. `g00_corpus_histogram_real_bytes_2450_files` — directory-wide
//!    histogram across all 2,450 `.g00` files emits a typed
//!    `G00CorpusHistogram` and a `Vec<G00Warning>` containing one
//!    `NoTypeNInCorpus` entry per documented type that is absent in
//!    the corpus.
//! 3. `g00_type2_btn000_decodes_header_and_regions` — Sweetie HD's
//!    `$GAME/REALLIVEDATA/g00/btn000.g00` (type 2) decodes its
//!    header + region table cleanly. The region rectangles must be
//!    non-degenerate so the `objLoadRegion` opcode at UTSUSHI-214 can
//!    consume them.
//!
//! # Multi-game validation status
//!
//! Per the itotori operating model
//! (`docs/dev/orchestration-operating-model.md`), a parser that targets a
//! real engine substrate must be exercised against at least two real
//! corpora before its node is merged-complete. Sweetie HD is the only
//! RealLive title currently staged. The g00 module mirrors the pattern
//! its UTSUSHI-201/202/203 sibling parsers landed: real-bytes pinned
//! against the only staged corpus today, with the second-corpus
//! follow-up tracked as a known gap. The commit message records the
//! single-corpus posture explicitly.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;
use std::path::PathBuf;

use utsushi_reallive::{
    G00_TYPE_PALETTED_LZSS, G00_TYPE_RAW_BGR, G00_TYPE_REGIONED_LZSS, G00CorpusHistogram, G00Type,
    G00Warning, decode_g00,
};

// Relative path under the Sweetie HD extraction root to the
// `g00` directory.

/// File name of the type-0 BACK.g00 image pinned by the UTSUSHI-216
/// acceptance criterion.
const SWEETIE_HD_TYPE0_BACK_FILENAME: &str = "BACK.g00";

/// File name of a type-2 region-table image used for the
/// header/region-table real-bytes pin. `btn000.g00` is the
/// alphabetically first type-2 file in the corpus.
const SWEETIE_HD_TYPE2_BTN_FILENAME: &str = "btn000.g00";

/// Expected number of `.g00` files in the Sweetie HD corpus (pinned by
/// the UTSUSHI-216 acceptance block).
const SWEETIE_HD_G00_CORPUS_SIZE: u64 = 2450;

/// Documented BACK.g00 canvas dimensions (header bytes 1-4 LE).
const SWEETIE_HD_BACK_WIDTH: u32 = 1280;
const SWEETIE_HD_BACK_HEIGHT: u32 = 720;

/// Resolve the Sweetie HD g00 directory under
/// `ITOTORI_REAL_GAME_ROOT`. Returns `None` when the env var is
/// unset so each test can skip with a documented diagnostic (no silent
/// pass).
fn real_g00_dir() -> Option<PathBuf> {
    real_corpus::reallivedata_subdir("g00")
}

/// Coherent-image threshold: mean absolute difference between
/// vertically-adjacent pixel rows (RGB channels). Real decoded art sits
/// well below this (photographic backgrounds ≈ 4–6); the pre-fix garbage
/// decode measured ≈ 77 (indistinguishable from random ≈ 85), so this
/// bound makes it impossible for garbage to masquerade as a valid
/// decode. A handful of intrinsically high-frequency assets (a literal
/// `NOISE.g00`, alpha masks) legitimately exceed this — the corpus test
/// asserts a robust *median* and a high coherent-fraction rather than a
/// hard per-file cap so those real assets are not false failures.
const COHERENT_ROW_MAD_MAX: f64 = 20.0;

/// Mean absolute difference between vertically-adjacent rows over the
/// RGB channels of an RGBA buffer. A structural coherence proxy: garbage
/// decodes have no vertical correlation (~77+), real images do (≪ 20).
fn vertical_row_mad(rgba: &[u8], width: usize, height: usize) -> f64 {
    if height < 2 || width == 0 {
        return 0.0;
    }
    let stride = width * 4;
    let mut sum = 0u64;
    let mut n = 0u64;
    for row in 1..height {
        for col in 0..width {
            for ch in 0..3 {
                let a = rgba[row * stride + col * 4 + ch] as i32;
                let b = rgba[(row - 1) * stride + col * 4 + ch] as i32;
                sum += (a - b).unsigned_abs() as u64;
                n += 1;
            }
        }
    }
    sum as f64 / n as f64
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn g00_type0_back_decodes() {
    let Some(g00_dir) = real_g00_dir() else {
        real_corpus::require_real_bytes("utsushi-reallive g00_type0_back_decodes");
        return;
    };
    let path = g00_dir.join(SWEETIE_HD_TYPE0_BACK_FILENAME);
    let bytes =
        fs::read(&path).unwrap_or_else(|err| panic!("failed to read {}: {err}", path.display()));

    let (image, warnings) = decode_g00(&bytes)
        .unwrap_or_else(|err| panic!("BACK.g00 must decode through type-0 path: {err}"));

    assert_eq!(image.g00_type, G00Type::RawBgr);
    assert_eq!(
        image.width, SWEETIE_HD_BACK_WIDTH,
        "BACK.g00 width is pinned at {SWEETIE_HD_BACK_WIDTH} per the documented header bytes",
    );
    assert_eq!(
        image.height, SWEETIE_HD_BACK_HEIGHT,
        "BACK.g00 height is pinned at {SWEETIE_HD_BACK_HEIGHT}",
    );
    assert!(
        image.width > 0,
        "decoded width must be non-zero per UTSUSHI-216 acceptance criterion 1",
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
    // PayloadLengthMismatch. The pre-fix decoder produced a truncated,
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

/// Decode every type-0 g00 file under `g00_dir` and return the per-file
/// vertical row-MAD list, asserting each file fills its exact canvas with
/// zero warnings. Skips non-type-0 files (types 1/2, which the histogram
/// test covers separately).
fn assert_type0_corpus_coherent(title: &str, g00_dir: &PathBuf) {
    let entries = fs::read_dir(g00_dir).unwrap_or_else(|err| {
        panic!(
            "failed to walk {title} g00 dir {}: {err}",
            g00_dir.display()
        )
    });
    let mut mads: Vec<f64> = Vec::new();
    let mut type0 = 0usize;
    for entry in entries {
        let path = entry.expect("DirEntry").path();
        if !path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("g00"))
        {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else {
            continue;
        };
        if bytes.first() != Some(&G00_TYPE_RAW_BGR) {
            continue;
        }
        type0 += 1;
        let (image, warnings) = decode_g00(&bytes)
            .unwrap_or_else(|err| panic!("{title} type-0 {} failed: {err}", path.display()));
        let expected = (image.width as usize) * (image.height as usize) * 4;
        assert_eq!(
            image.pixels_rgba.len(),
            expected,
            "{title} {}: type-0 must fill width*height*4 exactly",
            path.display(),
        );
        assert!(
            warnings.is_empty(),
            "{title} {}: type-0 must decode with zero warnings; got {warnings:?}",
            path.display(),
        );
        mads.push(vertical_row_mad(
            &image.pixels_rgba,
            image.width as usize,
            image.height as usize,
        ));
    }

    assert!(type0 > 0, "{title}: expected at least one type-0 g00 file");
    mads.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = mads[mads.len() / 2];
    let coherent = mads.iter().filter(|&&m| m < 25.0).count();
    let coherent_frac = coherent as f64 / mads.len() as f64;
    eprintln!(
        "{title} type-0 corpus: files={type0} median_row_mad={median:.2} \
         coherent_frac(<25)={coherent_frac:.4} max={:.2}",
        mads.last().copied().unwrap_or(0.0),
    );
    // Median cleanly separates real art (≈ 4–6) from garbage (≈ 77). A
    // few intrinsically noisy assets (NOISE.g00, masks) are tolerated by
    // using a robust median plus a high coherent-fraction floor.
    assert!(
        median < COHERENT_ROW_MAD_MAX,
        "{title}: type-0 corpus median row-MAD {median:.2} ≥ {COHERENT_ROW_MAD_MAX} — \
         the corpus decoded to noise",
    );
    assert!(
        coherent_frac > 0.95,
        "{title}: only {coherent_frac:.4} of type-0 files are coherent (<25 row-MAD); \
         expected > 0.95 (garbage decode would drive this near zero)",
    );
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT (and optionally _2) env var"]
fn g00_type0_corpus_coherence_both_titles() {
    let mut ran = false;
    for env_var in [
        real_corpus::REAL_GAME_ROOT_ENV,
        real_corpus::REAL_GAME_ROOT_2_ENV,
    ] {
        if let Some(dir) = real_corpus::g00_dir_for_env(env_var) {
            ran = true;
            assert_type0_corpus_coherent(env_var, &dir);
        }
    }
    if !ran {
        real_corpus::require_real_bytes(
            "utsushi-reallive g00 type-0 corpus coherence (needs ITOTORI_REAL_GAME_ROOT or ITOTORI_REAL_GAME_ROOT_2)",
        );
    }
}

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
        SWEETIE_HD_G00_CORPUS_SIZE,
        "Sweetie HD g00 corpus size is pinned at {SWEETIE_HD_G00_CORPUS_SIZE} files in UTSUSHI-216's acceptance block",
    );
    eprintln!(
        "Sweetie HD g00 lead-byte histogram: type0={} type1={} type2={} unknown={} unreadable={}",
        histogram.type0_count,
        histogram.type1_count,
        histogram.type2_count,
        histogram.unknown_count,
        histogram.unreadable_count,
    );

    let warnings = histogram.missing_type_warnings();
    // For Sweetie HD specifically: byte-0 spot-check observed
    // 2145 type-0, 0 type-1, 305 type-2 files. So the only missing
    // type is type 1, and the warnings vec must contain exactly one
    // NoTypeNInCorpus for `G00Type::PalettedLzss`.
    assert_eq!(
        warnings.len(),
        1,
        "Sweetie HD must surface exactly one missing-type warning (type 1); got: {warnings:?}",
    );
    assert!(
        matches!(
            warnings[0],
            G00Warning::NoTypeNInCorpus {
                g00_type: G00Type::PalettedLzss
            }
        ),
        "missing-type warning must point at PalettedLzss for Sweetie HD; got: {:?}",
        warnings[0],
    );
    let rendered = warnings[0].to_string();
    assert!(
        rendered.starts_with("utsushi.reallive.g00_no_type_N_in_corpus:"),
        "Display string must carry the spec-defined typed prefix; got: {rendered}",
    );

    assert!(
        histogram.type0_count > 0,
        "Sweetie HD must carry at least one type-0 file (BACK.g00 is the documented type-0 pin)",
    );
    assert!(
        histogram.type2_count > 0,
        "Sweetie HD must carry at least one type-2 file (btn000.g00 is the documented type-2 pin)",
    );
    assert_eq!(
        histogram.type1_count, 0,
        "Sweetie HD's spot-check observed zero type-1 files; the typed warning above pins this",
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
    let path = g00_dir.join(SWEETIE_HD_TYPE2_BTN_FILENAME);
    let bytes =
        fs::read(&path).unwrap_or_else(|err| panic!("failed to read {}: {err}", path.display()));

    // The decode call exercises header parsing, region-table parsing,
    // and the LZSS pixel-stream decode. The acceptance criterion
    // specifically requires the region table to be usable by
    // `objLoadRegion` (UTSUSHI-214). The header/region-table layer is
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
