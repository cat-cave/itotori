use std::fs;
use std::path::PathBuf;

use crate::{flag, flag_present, positional, read_json, write_json};

/// `kaifuu compat-evidence` — the claimed-support compatibility
/// EVIDENCE integration command.
/// It produces one suite-readable [`kaifuu_core::compat_evidence::CompatEvidenceReport`]
/// that INTEGRATES the three existing sources for a reproduction
/// bundle: the claimed-support tuple validation (engine family
/// variant, container, crypto, codec, surface, patch-back mode, profile/fixture
/// id, secret-requirement ids, diagnostics), the redacted repro-bundle index
/// , and the regression verdict per claim. The written
/// artifact is always the REDACTED form (ref-only ids/hashes/counts).
/// Two modes:
/// `--fixture` integrate the committed SYNTHETIC
/// fixtures (no private inputs) — emits the
/// golden shape; and
/// `--bundle <p> --catalogue <p> --baseline <p>`
/// integrate real inputs read from JSON.
/// Both require `--output <p>`.
/// `asset-ocr <asset.png> --output <report.json>`.
/// Reads a PUBLIC image/UI asset (an uncompressed grayscale PNG fixture) and
/// emits schema-valid text regions with provenance + stable content hashes.
/// Uncertain / unrecognized regions are surfaced as findings (source =
/// provenance + confidence + a labelled candidate), never asserted as truth.
/// Pure in-process Rust: no shell-out to any external OCR binary.
pub(crate) fn run_asset_ocr_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    use kaifuu_core::asset_ocr::{AssetOcrRequest, run_asset_ocr};

    let asset_path = PathBuf::from(positional(args, 1)?);
    let output = PathBuf::from(flag(args, "--output")?);
    let asset_name = asset_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("asset-ocr: asset path has no file name")?;
    let asset_bytes = fs::read(&asset_path)?;
    let report = run_asset_ocr(AssetOcrRequest {
        asset_bytes: &asset_bytes,
        asset_name,
    })?;
    write_json(&output, &report)?;
    Ok(())
}

pub(crate) fn run_compat_evidence_command(
    args: &[String],
) -> Result<(), Box<dyn std::error::Error>> {
    use kaifuu_core::compat_evidence::integrate_compat_evidence;
    use kaifuu_core::compat_regression::{PublicFixtureCatalogue, RegressionBaseline};
    use kaifuu_core::repro_bundle::ReproBundle;

    let output = PathBuf::from(flag(args, "--output")?);

    let report = if flag_present(args, "--fixture") {
        use kaifuu_core::compat_regression::fixtures as regression_fixtures;
        use kaifuu_core::repro_bundle::fixtures as bundle_fixtures;
        integrate_compat_evidence(
            &bundle_fixtures::clean_bundle(),
            &regression_fixtures::public_catalogue(),
            &regression_fixtures::baseline(),
        )
    } else {
        let bundle: ReproBundle = read_json(&PathBuf::from(flag(args, "--bundle")?))?;
        let catalogue: PublicFixtureCatalogue =
            read_json(&PathBuf::from(flag(args, "--catalogue")?))?;
        let baseline: RegressionBaseline = read_json(&PathBuf::from(flag(args, "--baseline")?))?;
        integrate_compat_evidence(&bundle, &catalogue, &baseline)
    };

    write_json(&output, &report.redacted_for_report())?;
    Ok(())
}
