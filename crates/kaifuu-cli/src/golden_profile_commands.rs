use std::path::PathBuf;

use crate::{
    AdapterRegistry, DetectOutcome, GoldenByteEquivalenceMode, GoldenHarnessRequest,
    PartialAdapterCommand, ProfileRequest, build_partial_adapter_report, detect_or_partial, flag,
    flag_optional, flag_present, positional, read_json, redact_for_log_or_report,
    run_round_trip_golden, validate_profile_value, write_json, write_partial_adapter_report,
    write_validated_stable_profile,
};

pub(crate) fn run_golden_command(
    args: &[String],
    registry: &AdapterRegistry,
) -> Result<(), Box<dyn std::error::Error>> {
    let game_dir = PathBuf::from(positional(args, 1)?);
    let output = PathBuf::from(flag(args, "--output")?);
    let work_dir = flag_optional(args, "--work-dir")
        .map_or_else(|| output.with_extension("work"), PathBuf::from);
    let translated_patch_export = flag_optional(args, "--translated-patch")
        .map(PathBuf::from)
        .map(|path| read_json::<serde_json::Value>(&path))
        .transpose()?;
    let translated_source_bridge = flag_optional(args, "--translated-source-bridge")
        .map(PathBuf::from)
        .map(|path| read_json::<serde_json::Value>(&path))
        .transpose()?;
    let byte_equivalence = if flag_present(args, "--assert-asset-inventory") {
        GoldenByteEquivalenceMode::AssertInventory
    } else if flag_present(args, "--expect-byte-identical") {
        GoldenByteEquivalenceMode::AssertSourceJson
    } else {
        GoldenByteEquivalenceMode::Unsupported {
            support_boundary:
                "byte-identical round-trip is not claimed unless --expect-byte-identical or --assert-asset-inventory is set for an adapter known to support byte-stable patching"
                    .to_string(),
        }
    };
    let report = run_round_trip_golden(
        registry,
        GoldenHarnessRequest {
            game_dir: &game_dir,
            work_dir: &work_dir,
            adapter_id: flag_optional(args, "--adapter"),
            byte_equivalence,
            translated_patch_export: translated_patch_export.as_ref(),
            translated_source_bridge: translated_source_bridge.as_ref(),
        },
    )?;
    let report = report.redacted_for_report();
    let failed = report.status == kaifuu_core::OperationStatus::Failed;
    write_json(&output, &report)?;
    if failed {
        return Err(format!(
            "golden round-trip failed; report written to {}",
            redact_for_log_or_report(&output.display().to_string())
        )
        .into());
    }
    Ok(())
}

pub(crate) fn run_profile_command(
    args: &[String],
    registry: &AdapterRegistry,
) -> Result<(), Box<dyn std::error::Error>> {
    match positional(args, 1)? {
        "init" => {
            let game_dir = PathBuf::from(positional(args, 2)?);
            let output = PathBuf::from(flag(args, "--output")?);
            match detect_or_partial(registry, &game_dir, true)? {
                DetectOutcome::FullDetect(adapter) | DetectOutcome::Diagnostic(adapter) => {
                    let profile = adapter.profile(ProfileRequest {
                        game_dir: &game_dir,
                    })?;
                    write_validated_stable_profile(&output, &profile)?;
                }
                DetectOutcome::Partial(detection) => {
                    let report = build_partial_adapter_report(
                        &detection,
                        &game_dir,
                        PartialAdapterCommand::Profile,
                    );
                    write_partial_adapter_report(&output, &report)?;
                }
            }
        }
        "validate" => {
            let profile_path = PathBuf::from(positional(args, 2)?);
            let output = PathBuf::from(flag(args, "--output")?);
            let profile: serde_json::Value = read_json(&profile_path)?;
            write_json(
                &output,
                &validate_profile_value(&profile).redacted_for_report(),
            )?;
        }
        _ => {
            let game_dir = PathBuf::from(positional(args, 1)?);
            let output = PathBuf::from(flag(args, "--output")?);
            match detect_or_partial(registry, &game_dir, true)? {
                DetectOutcome::FullDetect(adapter) | DetectOutcome::Diagnostic(adapter) => {
                    let profile = adapter.profile(ProfileRequest {
                        game_dir: &game_dir,
                    })?;
                    write_validated_stable_profile(&output, &profile)?;
                }
                DetectOutcome::Partial(detection) => {
                    let report = build_partial_adapter_report(
                        &detection,
                        &game_dir,
                        PartialAdapterCommand::Profile,
                    );
                    write_partial_adapter_report(&output, &report)?;
                }
            }
        }
    }
    Ok(())
}
