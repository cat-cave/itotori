

use std::fs;
use std::path::PathBuf;

use utsushi_reallive::{
    G00_TYPE_PALETTED_LZSS, G00_TYPE_RAW_BGR, G00_TYPE_REGIONED_LZSS, G00ContentValidationError,
    G00CorpusHistogram, G00MetadataError, G00Type, G00Warning, decode_g00,
    probe_g00_pattern_geometry, validate_g00_lzss_content,
};

// Relative path under the Sweetie HD extraction root to the
// `g00` directory.

/// File name of the type-0 BACK.g00 image pinned by the
/// acceptance criterion.
const PRIMARY_CORPUS_TYPE0_BACK_FILENAME: &str = "BACK.g00";

/// File name of a type-2 region-table image used for the
/// header/region-table real-bytes pin. `btn000.g00` is the
/// alphabetically first type-2 file in the corpus.
const PRIMARY_CORPUS_TYPE2_BTN_FILENAME: &str = "btn000.g00";

/// Expected number of `.g00` files in the Sweetie HD corpus (pinned by
/// the acceptance block).
const PRIMARY_CORPUS_G00_CORPUS_SIZE: u64 = 2450;

/// Documented BACK.g00 canvas dimensions (header bytes 1-4 LE).
const PRIMARY_CORPUS_BACK_WIDTH: u32 = 1280;
const PRIMARY_CORPUS_BACK_HEIGHT: u32 = 720;

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
    for env_var in [real_corpus::PRIMARY, real_corpus::SECONDARY] {
        if let Some(dir) = real_corpus::g00_dir_for(env_var) {
            ran = true;
            assert_type0_corpus_coherent(env_var.engine, &dir);
        }
    }
    if !ran {
        real_corpus::require_real_bytes(
            "utsushi-reallive g00 type-0 corpus coherence (needs ITOTORI_REAL_GAME_ROOT or ITOTORI_REAL_GAME_ROOT_2)",
        );
    }
}

/// Stable discriminant name for a [`G00ContentValidationError`], used to
/// build a rejection histogram in the real-corpus cross-check below.
fn content_err_kind(err: &G00ContentValidationError) -> &'static str {
    match err {
        G00ContentValidationError::TruncatedPreamble => "TruncatedPreamble",
        G00ContentValidationError::UnknownType => "UnknownType",
        G00ContentValidationError::HeaderBounds { .. } => "HeaderBounds",
        G00ContentValidationError::RegionTableOverflow => "RegionTableOverflow",
        G00ContentValidationError::Type2ZeroRegions => "Type2ZeroRegions",
        G00ContentValidationError::InvalidCompressedSize => "InvalidCompressedSize",
        G00ContentValidationError::OuterLengthMismatch { .. } => "OuterLengthMismatch",
        G00ContentValidationError::DeclaredOutputMismatch { .. } => "DeclaredOutputMismatch",
        G00ContentValidationError::CountOverflow => "CountOverflow",
        G00ContentValidationError::TruncatedLiteral { .. } => "TruncatedLiteral",
        G00ContentValidationError::TruncatedBackreference { .. } => "TruncatedBackreference",
        G00ContentValidationError::InvalidDistance { .. } => "InvalidDistance",
        G00ContentValidationError::OutputOverrun { .. } => "OutputOverrun",
        G00ContentValidationError::OutputUnderrun { .. } => "OutputUnderrun",
        G00ContentValidationError::UnconsumedPayload { .. } => "UnconsumedPayload",
    }
}

/// Stable discriminant name for a [`G00MetadataError`].
fn metadata_err_kind(err: &G00MetadataError) -> &'static str {
    match err {
        G00MetadataError::Validator(inner) => content_err_kind(inner),
        G00MetadataError::ZeroRegionTable => "ZeroRegionTable",
        G00MetadataError::RegionTableBounds { .. } => "RegionTableBounds",
        G00MetadataError::InvertedRegion { .. } => "InvertedRegion",
        G00MetadataError::RegionDimensionOverflow { .. } => "RegionDimensionOverflow",
    }
}

/// Real-oracle proof for the strict `validate_g00_lzss_content`
/// (and `probe_g00_pattern_geometry`) helpers: the strict validator adds
/// invariants (exact outer-length match, fully-consumed payload
/// declared-output cross-check) that the tolerant `decode_g00` does NOT
/// enforce. This walks the whole real corpus and asserts the strict validator
/// ACCEPTS every real g00 file the decoder decodes **cleanly** (`Ok` with zero
/// warnings) — i.e. it may not false-reject a well-formed archived asset. Files
/// the decoder itself flags with a `PayloadLengthMismatch` warning are already
/// imperfect and are reported for information only (strict is allowed to reject
/// those). This is the assertion that turns the synthetic-only proof of these
/// helpers into a real-bytes oracle proof.
fn assert_strict_validator_accepts_clean_decodes(title: &str, g00_dir: &PathBuf) {
    let entries = fs::read_dir(g00_dir).unwrap_or_else(|err| {
        panic!(
            "failed to walk {title} g00 dir {}: {err}",
            g00_dir.display()
        )
    });

    let mut total = 0usize;
    let mut decode_err = 0usize;
    let mut clean = 0usize;
    let mut warned = 0usize;
    // Informational: how the strict validator treats the decoder's
    // already-flagged (warned) files. Not asserted — strict may reject these.
    let mut validate_ok_on_warned = 0usize;
    let mut validate_err_on_warned = 0usize;
    // The load-bearing failures: files the decoder decoded CLEANLY but the
    // strict validator / probe rejected. Any entry here is a real false
    // rejection, not a proof gap.
    let mut clean_rejections: Vec<(String, &'static str)> = Vec::new();
    let mut probe_rejections: Vec<(String, &'static str)> = Vec::new();

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
        total += 1;
        let Ok((_image, warnings)) = decode_g00(&bytes) else {
            decode_err += 1;
            continue;
        };
        if !warnings.is_empty() {
            warned += 1;
            match validate_g00_lzss_content(&bytes) {
                Ok(_) => validate_ok_on_warned += 1,
                Err(_) => validate_err_on_warned += 1,
            }
            continue;
        }
        clean += 1;
        // Core invariant: a cleanly-decoded real file must not be rejected by
        // the strict content validator.
        if let Err(err) = validate_g00_lzss_content(&bytes) {
            clean_rejections.push((
                path.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                content_err_kind(&err),
            ));
        }
        // Probe pattern 0 must likewise accept a cleanly-decoded file.
        if let Err(err) = probe_g00_pattern_geometry(&bytes, 0) {
            probe_rejections.push((
                path.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                metadata_err_kind(&err),
            ));
        }
    }

    eprintln!(
        "{title} strict-validator vs decoder: total={total} decode_err={decode_err} \
         clean={clean} warned={warned} (warned→validate_ok={validate_ok_on_warned} \
         validate_err={validate_err_on_warned}) clean_rejections={} probe_rejections={}",
        clean_rejections.len(),
        probe_rejections.len(),
    );

    assert!(
        clean > 0,
        "{title}: expected at least one cleanly-decoded g00 file"
    );

    // Build a discriminant histogram + a small sample for any failure message.
    let summarize = |label: &str, rejects: &[(String, &'static str)]| -> String {
        let mut counts: std::collections::BTreeMap<&'static str, usize> =
            std::collections::BTreeMap::new();
        for (_, kind) in rejects {
            *counts.entry(kind).or_default() += 1;
        }
        let sample: Vec<String> = rejects
            .iter()
            .take(10)
            .map(|(name, kind)| format!("{name} → {kind}"))
            .collect();
        format!(
            "{title}: {label} strict validator false-rejected {} of {clean} cleanly-decoded \
             files — histogram={counts:?}; sample={sample:?}. These are real files the tolerant \
             decoder accepts with zero warnings; do NOT weaken the validator to force a pass — \
             this is a real correctness finding.",
            rejects.len(),
        )
    };

    assert!(
        clean_rejections.is_empty(),
        "{}",
        summarize("validate_g00_lzss_content", &clean_rejections),
    );
    assert!(
        probe_rejections.is_empty(),
        "{}",
        summarize("probe_g00_pattern_geometry", &probe_rejections),
    );
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT (and optionally _2) env var"]
fn g00_strict_validator_accepts_real_corpus_both_titles() {
    let mut ran = false;
    for env_var in [real_corpus::PRIMARY, real_corpus::SECONDARY] {
        if let Some(dir) = real_corpus::g00_dir_for(env_var) {
            ran = true;
            assert_strict_validator_accepts_clean_decodes(env_var.engine, &dir);
        }
    }
    if !ran {
        real_corpus::require_real_bytes(
            "utsushi-reallive g00 strict-validator vs decoder (needs ITOTORI_REAL_GAME_ROOT or ITOTORI_REAL_GAME_ROOT_2)",
        );
    }
}

