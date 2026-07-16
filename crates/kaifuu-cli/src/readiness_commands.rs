use std::path::PathBuf;

use crate::{
    PackedReadinessValidationReport, atomic_write_text, flag_optional,
    generate_alpha_encrypted_readiness, positional, validate_packed_engine_readiness_dir,
};

/// `kaifuu readiness validate [--fixtures-dir <dir>]
/// [--output <report.json>]`.
/// Reads every `*.profile.json` packed-engine readiness profile under
/// `--fixtures-dir` (default `fixtures/kaifuu/packed-engine`), validates each
/// against its engine family's transform/capability spec, and writes the
/// aggregate report (profile id, fixture id, capability levels, helper ids,
/// key refs, diagnostics, and content hashes) to `--output` (default
/// `target/kaifuu/packed-readiness-validation.json`). Each profile's
/// effective outcome is recomputed mechanically — a media transform, missing
/// key, helper-gated key, or unavailable helper is a readiness-only posture
/// that never claims extract/patch. The command exits non-zero, listing each
/// inconsistent profile's blocking finding codes, when any profile fails
/// validation.
pub(crate) fn run_readiness_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    match positional(args, 1)? {
        "validate" => run_readiness_validate(args),
        "alpha-encrypted" => run_readiness_alpha_encrypted(args),
        "alpha-profile" => run_readiness_alpha_profile(args),
        other => Err(format!(
            "usage: kaifuu readiness <validate|alpha-encrypted|alpha-profile> ...; got {other:?}"
        )
        .into()),
    }
}

fn run_readiness_validate(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let fixtures_dir = PathBuf::from(
        flag_optional(args, "--fixtures-dir").unwrap_or("fixtures/kaifuu/packed-engine"),
    );
    let output = PathBuf::from(
        flag_optional(args, "--output").unwrap_or("target/kaifuu/packed-readiness-validation.json"),
    );
    let report: PackedReadinessValidationReport =
        validate_packed_engine_readiness_dir(&fixtures_dir)?;
    let json = report.stable_json()?;
    atomic_write_text(&output, &json)?;

    println!(
        "kaifuu readiness validate: status={:?} profiles={} profileReady={} readinessOnly={}",
        report.status,
        report.profile_count,
        report.profile_ready_count,
        report.readiness_only_count,
    );

    if report.status == kaifuu_core::OperationStatus::Failed {
        let failures = report
            .entries
            .iter()
            .filter(|entry| entry.status == kaifuu_core::OperationStatus::Failed)
            .map(|entry| {
                let codes = entry
                    .findings
                    .iter()
                    .filter(|finding| finding.severity.is_blocking())
                    .map(|finding| format!("{}:{}", finding.severity.as_str(), finding.code))
                    .collect::<Vec<_>>()
                    .join(",");
                format!("{} [{}]", entry.profile_id, codes)
            })
            .collect::<Vec<_>>()
            .join("; ");
        return Err(format!("packed-engine readiness validation failed: {failures}").into());
    }
    Ok(())
}

/// `kaifuu readiness alpha-encrypted [--fixtures-dir <dir>]
/// [--output <report.json>] [--summary-output <summary.json>]`.
/// Generates public alpha encrypted-readiness EVIDENCE by COMPOSING the
/// packed-engine readiness validator output over the
/// alpha-encrypted fixture directory (default `fixtures/kaifuu/alpha-encrypted`)
/// with the synthetic patch artifacts in the same directory. The full report
/// (profile id, fixture id, engine family, surface ids, helper id, key ref,
/// capability levels, patch-result ref, diagnostics, and content/report hashes)
/// is written to `--output` (default
/// `target/kaifuu/alpha-encrypted-readiness.json`) and a README-safe aggregate
/// summary to `--summary-output` (default
/// `target/kaifuu/alpha-encrypted-readiness.summary.json`). A patch-capable
/// profile-ready entry without a patch result, a readiness-only entry that
/// claims one, a validation failure, a dangling patch artifact, or
/// an empty fixture directory each exit non-zero with structured finding codes.
fn run_readiness_alpha_encrypted(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let fixtures_dir = PathBuf::from(
        flag_optional(args, "--fixtures-dir").unwrap_or("fixtures/kaifuu/alpha-encrypted"),
    );
    let output = PathBuf::from(
        flag_optional(args, "--output").unwrap_or("target/kaifuu/alpha-encrypted-readiness.json"),
    );
    let summary_output = PathBuf::from(
        flag_optional(args, "--summary-output")
            .unwrap_or("target/kaifuu/alpha-encrypted-readiness.summary.json"),
    );

    let report = generate_alpha_encrypted_readiness(&fixtures_dir)?;
    atomic_write_text(&output, &report.stable_json()?)?;
    atomic_write_text(&summary_output, &report.summary().stable_json()?)?;

    println!(
        "kaifuu readiness alpha-encrypted: status={:?} profiles={} profileReady={} readinessOnly={} patchEvidence={} reportHash={} consumedValidationHash={}",
        report.status,
        report.profile_count,
        report.profile_ready_count,
        report.readiness_only_count,
        report.patch_evidence_count,
        report.report_hash.as_str(),
        report.consumed_validation.report_hash.as_str(),
    );

    if report.status == kaifuu_core::OperationStatus::Failed {
        let mut codes: Vec<String> = report
            .findings
            .iter()
            .filter(|finding| finding.severity.is_blocking())
            .map(|finding| format!("{}:{}", finding.severity.as_str(), finding.code))
            .collect();
        for entry in &report.entries {
            if entry.status == kaifuu_core::OperationStatus::Failed {
                let entry_codes = entry
                    .findings
                    .iter()
                    .filter(|finding| finding.severity.is_blocking())
                    .map(|finding| format!("{}:{}", finding.severity.as_str(), finding.code))
                    .collect::<Vec<_>>()
                    .join(",");
                codes.push(format!("{} [{}]", entry.profile_id, entry_codes));
            }
        }
        return Err(format!(
            "alpha encrypted-readiness generation failed: {}",
            codes.join("; ")
        )
        .into());
    }
    Ok(())
}

/// `kaifuu readiness alpha-profile [--fixtures-dir <dir>]
/// [--output <report.json>] [--summary-output <summary.json>]`.
/// Validates the alpha packed/encrypted-engine readiness-PROFILE subset (the
/// Siglus / KiriKiri XP3 / Wolf / RGSS3 / BGI seeds by default) and renders the
/// alpha capability-level summary. Writes a detailed, redacted validation report
/// (per-operation status + classified findings) and a README-safe capability
/// summary, and prints the capability table. Validation FAILS on any missing
/// required capability / fixture / key / helper / patch-back field; the exit is
/// non-zero. Reports carry only synthetic ids, kinds, and counts — never keys,
/// paths, decrypted content, or filenames.
fn run_readiness_alpha_profile(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    use kaifuu_core::{render_alpha_capability_summary_dir, validate_alpha_readiness_dir};

    let fixtures_dir = PathBuf::from(
        flag_optional(args, "--fixtures-dir").unwrap_or("fixtures/kaifuu/alpha-readiness/seeds"),
    );
    let output = PathBuf::from(
        flag_optional(args, "--output").unwrap_or("target/kaifuu/alpha-readiness-validation.json"),
    );
    let summary_output = PathBuf::from(
        flag_optional(args, "--summary-output")
            .unwrap_or("target/kaifuu/alpha-readiness.summary.json"),
    );

    // Validate the public synthetic profile fixtures into a detailed report and
    // render the README-safe capability summary from the same directory. Both
    // paths tolerate malformed fixtures (failed entry/row, never a panic).
    let report = validate_alpha_readiness_dir(&fixtures_dir)?;
    let summary = render_alpha_capability_summary_dir(&fixtures_dir)?;

    atomic_write_text(&output, &report.stable_json()?)?;
    atomic_write_text(&summary_output, &summary.stable_json()?)?;

    println!(
        "kaifuu readiness alpha-profile: status={:?} engines={} detectorOnly={} patchCapable={}",
        summary.status,
        summary.engine_count,
        summary.detector_only_count,
        summary.patch_capable_count,
    );
    print!("{}", summary.render_text_table());

    if report.status == kaifuu_core::OperationStatus::Failed {
        let failures = report
            .entries
            .iter()
            .filter(|entry| entry.status == kaifuu_core::OperationStatus::Failed)
            .map(|entry| {
                let codes = entry
                    .findings
                    .iter()
                    .filter(|finding| finding.severity.is_blocking())
                    .map(|finding| {
                        format!(
                            "{}:{}:{}",
                            finding.severity.as_str(),
                            finding.failure_class.as_str(),
                            finding.code
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                format!("{} [{}]", entry.profile_id, codes)
            })
            .collect::<Vec<_>>()
            .join("; ");
        return Err(format!("alpha readiness-profile validation failed: {failures}").into());
    }
    Ok(())
}
