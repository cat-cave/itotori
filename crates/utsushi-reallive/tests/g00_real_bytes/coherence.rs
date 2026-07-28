use super::*;
use utsushi_reallive::{G00ContentValidationError, G00MetadataError};

pub(super) fn assert_type0_corpus_coherent(title: &str, g00_dir: &PathBuf) {
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
pub(super) fn content_err_kind(err: &G00ContentValidationError) -> &'static str {
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
pub(super) fn metadata_err_kind(err: &G00MetadataError) -> &'static str {
    match err {
        G00MetadataError::Validator(inner) => content_err_kind(inner),
        G00MetadataError::ZeroRegionTable => "ZeroRegionTable",
        G00MetadataError::RegionTableBounds { .. } => "RegionTableBounds",
        G00MetadataError::InvertedRegion { .. } => "InvertedRegion",
        G00MetadataError::RegionDimensionOverflow { .. } => "RegionDimensionOverflow",
    }
}
