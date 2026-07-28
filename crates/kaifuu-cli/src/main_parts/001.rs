use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use kaifuu_core::{
    AdapterFailure, AdapterRegistry, AssetInventoryManifest, AssetInventoryRequest,
    DetectionReport, EncryptedMediaProofFixture, EncryptedMediaProofRequest, EngineAdapter,
    ExtractRequest, GameProfile, GoldenByteEquivalenceMode, GoldenHarnessRequest,
    HelperBinaryLaunchValidationRequest, HelperCapability, HelperRedactionStatus,
    HelperRegistryInvocationRequest, KaifuuResult, LocalKeyImportRequest, LocalKeyImportSource,
    LocalSecretDirectoryStore, PackedReadinessValidationReport, PartialAdapterCommand, PatchExport,
    PatchPreflightRequest, PatchRequest, PatchResult, ProfileRequest, ProofHash,
    RpgMakerMvMzFixtureKeyValidationRequest, SecretRef, SiglusParserBoundarySmokeRequest,
    SiglusParserBoundarySmokeVariant, VerifyRequest, Xp3CapabilityProfileFixture,
    Xp3CapabilityProfileRequest, Xp3ProfileProofFixture, Xp3ProfileProofRequest, atomic_write_text,
    encode_xp3, encrypted_media_proof, fixture_helper_registry, generate_alpha_encrypted_readiness,
    generate_xp3_capability_profile, normalize_helper_result_value, pack_plain_xp3_from_directory,
    parse_helper_capability, parse_hex_bytes, plain_xp3_writer_capability,
    promote_staged_directory_no_clobber, read_json, read_plain_xp3_archive,
    redact_for_log_or_report, redact_report_value, replace_plain_xp3_entry_payload,
    run_plain_xp3_smoke_from_path, run_round_trip_golden,
    run_siglus_known_key_parser_boundary_smoke, sha256_hash_bytes, stable_json,
    unpack_plain_xp3_to_directory, validate_helper_registry_entry_value,
    validate_helper_result_value, validate_offset_map_value, validate_packed_engine_readiness_dir,
    validate_profile_value, validate_rpg_maker_mv_mz_fixture_key, write_json, xp3_profile_proof,
};
use kaifuu_delta::{
    ContractStageStatus, SourceProvenance, apply_delta, create_delta,
    run_encrypted_xp3_contract_scaffold,
};

pub(crate) use bgi_commands::run_bgi_command;
pub(crate) use evidence_commands::{run_asset_ocr_command, run_compat_evidence_command};
pub(crate) use golden_profile_commands::{run_golden_command, run_profile_command};
#[cfg(test)]
pub(crate) use key_commands::import_key_material_from_args;
pub(crate) use key_commands::run_key_command;
pub(crate) use offset_map_commands::run_offset_map_command;
pub(crate) use partial_adapter::{
    DetectOutcome, build_partial_adapter_report, detect_or_partial, registered_adapter_for_game,
    write_partial_adapter_report,
};
pub(crate) use readiness_commands::run_readiness_command;
pub(crate) use reallive_commands::{run_extract_reallive_bundle, run_patch_reallive_bundle};
pub(crate) use rpgmaker_commands::{
    run_extract_rpgmaker_bundle, run_patch_rpgmaker_bundle, run_rpg_maker_command,
};
pub(crate) use siglus_commands::run_siglus_command;
pub(crate) use softpal_commands::run_softpal_command;
pub(crate) use wolf_commands::run_wolf_command;
pub(crate) use xp3_commands::run_xp3_command;
const APPLY_REPORT_FILE_NAME: &str = "patch-result.json";
const REAL_GAME_ROOT_ENV: &str = "ITOTORI_REAL_GAME_ROOT";

fn main() {
    if let Err(error) = run() {
        eprintln!("{}", redact_for_log_or_report(&error.to_string()));
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    run_with_args(std::env::args().skip(1).collect())
}

fn run_with_args(args: Vec<String>) -> Result<(), Box<dyn std::error::Error>> {
    let registry = engine_registry();
    run_with_args_and_registry(args, &registry)
}

fn run_with_args_and_registry(
    args: Vec<String>,
    registry: &AdapterRegistry,
) -> Result<(), Box<dyn std::error::Error>> {
    if flag_optional(&args, "--engine") == Some("softpal")
        && matches!(
            args.first().map(String::as_str),
            Some("extract" | "patch" | "verify")
        )
    {
        return run_softpal_command(&args);
    }
    if siglus_commands::is_siglus_engine_command(&args) {
        return siglus_commands::run_siglus_engine_command(&args);
    }
    match args.first().map(String::as_str) {
        Some("detect") => {
            let game_dir = PathBuf::from(positional(&args, 1)?);
            let output = PathBuf::from(flag(&args, "--output")?);
            let detections = registry.detect_all(&game_dir)?;
            write_json(
                &output,
                &DetectionReport::from_results(&game_dir, detections),
            )?;
        }
        Some("extract") => {
            // --engine reallive --scene <N> --bundle-output <path>
            // routes through the kaifuu-reallive bridge producer rather
            // than the registry adapter surface. The `game_dir` positional
            // is optional under --engine reallive — if absent we read
            // `ITOTORI_REAL_GAME_ROOT` as a generic real-corpus fixture
            // convenience.
            if let Some(engine) = flag_optional(&args, "--engine")
                && engine == "reallive"
            {
                return run_extract_reallive_bundle(&args);
            }
            // RPG Maker MV/MZ extraction (vertical-slice wiring) routes
            // through the kaifuu-rpgmaker `extract_game_dir` bundle
            // producer: it takes the game's `www/` directory plus the same
            // identity-metadata flags as the RealLive path and writes the
            // v0.2 BridgeBundle JSON to `--bundle-output`.
            if let Some(engine) = flag_optional(&args, "--engine")
                && (engine == "rpgmaker" || engine == "rpg-maker")
            {
                return run_extract_rpgmaker_bundle(&args);
            }
            let game_dir = PathBuf::from(positional(&args, 1)?);
            let output = PathBuf::from(flag(&args, "--output")?);
            match detect_or_partial(registry, &game_dir, false)? {
                DetectOutcome::FullDetect(adapter) | DetectOutcome::Diagnostic(adapter) => {
                    let extraction = adapter.extract(ExtractRequest {
                        game_dir: &game_dir,
                    })?;
                    write_json(&output, &extraction.bridge)?;
                }
                DetectOutcome::Partial(detection) => {
                    // partial path: detect returned false but
                    // accumulated nonzero Matched evidence. Emit a
                    // PartialAdapterReport so the dashboard / downstream
                    // tools can ingest what WAS recovered. Exits 0 unless
                    // a P0/P1 diagnostic fires.
                    let report = build_partial_adapter_report(
                        &detection,
                        &game_dir,
                        PartialAdapterCommand::Extract,
                    );
                    write_partial_adapter_report(&output, &report)?;
                }
            }
        }
        Some("asset-inventory" | "assets") => {
            let game_dir = PathBuf::from(positional(&args, 1)?);
            let output = PathBuf::from(flag(&args, "--output")?);
            let adapter = match detect_or_partial(registry, &game_dir, true)? {
                DetectOutcome::FullDetect(adapter) | DetectOutcome::Diagnostic(adapter) => adapter,
                DetectOutcome::Partial(_) => registered_adapter_for_game(registry, &game_dir)?,
            };
            let manifest = adapter.asset_inventory(AssetInventoryRequest {
                game_dir: &game_dir,
            })?;
            let validation = manifest.validate();
            if validation.status == kaifuu_core::OperationStatus::Failed {
                return Err(format!(
                    "generated asset inventory failed validation: {}",
                    validation
                        .failures
                        .iter()
                        .map(|failure| failure.code.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
                .into());
            }
            write_stable_asset_inventory(&output, &manifest)?;
        }
        Some("patch") => {
            // `patch --engine reallive --source <readonly>
            // --target <writable> --bundle <translated.json>` routes
            // through the kaifuu-reallive bundle-driven patchback. The
            // historical registry-adapter path runs when --engine is
            // absent or set to anything other than `reallive`.
            if let Some(engine) = flag_optional(&args, "--engine")
                && engine == "reallive"
            {
                return run_patch_reallive_bundle(&args);
            }
            // RPG Maker MV/MZ bundle-driven patchback + `.kaifuu` delta
            // producer (vertical-slice wiring). Reads the translated v0.2
            // bundle, byte-surgically patches the source `www/data/*.json`
            // into `--patched-data-output`, and writes the delta package to
            // `--delta-output`. The source tree is never mutated.
            if let Some(engine) = flag_optional(&args, "--engine")
                && (engine == "rpgmaker" || engine == "rpg-maker")
            {
                return run_patch_rpgmaker_bundle(&args);
            }
            let game_dir = PathBuf::from(positional(&args, 1)?);
            let patch = PathBuf::from(flag(&args, "--patch")?);
            let output = PathBuf::from(flag(&args, "--output")?);
            validate_patch_target_root(&game_dir, &output, "patch output directory")?;
            let patch_export: PatchExport = read_json(&patch)?;
            let adapter = registered_adapter_for_game(registry, &game_dir)?;
            let preflight = adapter
                .patch_preflight(PatchPreflightRequest {
                    game_dir: &game_dir,
                    patch_export: &patch_export,
                })?
                .redacted_for_report();
            if preflight.status == kaifuu_core::OperationStatus::Failed
                && preflight.has_preflight_blocking_failure()
            {
                return Err(patch_preflight_failure_message(&preflight).into());
            }
            let result = run_patch_with_owned_staging(adapter, &game_dir, &patch_export, &output)?;
            let failed = result.status == kaifuu_core::OperationStatus::Failed;
            if failed {
                return Err(format!(
                    "patch failed; see {}",
                    redact_for_log_or_report(
                        &output.join("patch-result.json").display().to_string()
                    )
                )
                .into());
            }
        }
        Some("diff") => {
            let original = positional(&args, 1)?;
            let patched = positional(&args, 2)?;
            let output = flag(&args, "--output")?;
            // --source-extract <path> reads the originating
            // extract envelope (PartialAdapterReport on the
            // partial path; a regular bridge envelope otherwise) and
            // carries the `partial` provenance forward through the delta
            // package so apply can refuse partial sources.
            let source_provenance = match flag_optional(&args, "--source-extract") {
                Some(path) => SourceProvenance::from_extract_envelope_file(Path::new(path))?,
                None => SourceProvenance::complete(),
            };
            write_json(
                &PathBuf::from(output),
                &create_delta(
                    &PathBuf::from(original),
                    &PathBuf::from(patched),
                    source_provenance,
                )?,
            )?;
        }
        Some("apply") => {
            let game_dir = PathBuf::from(positional(&args, 1)?);
            let patch = PathBuf::from(flag(&args, "--patch")?);
            let output = PathBuf::from(flag(&args, "--output")?);
            let report_output = flag_optional(&args, "--report-output")
                .map(PathBuf::from)
                .map_or_else(|| default_apply_report_output(&output), Ok)?;
            let report_output = validate_apply_report_output(&game_dir, &output, &report_output)?;
            let result = apply_delta(&game_dir, &patch, &output)?;
            write_apply_report_json(&report_output, &redact_report_value(&result))?;
        }
        Some("verify") => {
            let game_dir = PathBuf::from(positional(&args, 1)?);
            let output = flag_optional(&args, "--output").unwrap_or("verify-result.json");
            match detect_or_partial(registry, &game_dir, false)? {
                DetectOutcome::FullDetect(adapter) | DetectOutcome::Diagnostic(adapter) => {
                    let result = adapter
                        .verify(VerifyRequest {
                            game_dir: &game_dir,
                        })?
                        .redacted_for_report();
                    write_json(&PathBuf::from(output), &result)?;
                }
                DetectOutcome::Partial(detection) => {
                    // partial verify: emit a PartialAdapterReport
                    // and exit 0 unless a P0/P1 diagnostic fires.
                    let report = build_partial_adapter_report(
                        &detection,
                        &game_dir,
                        PartialAdapterCommand::Verify,
                    );
                    write_partial_adapter_report(&PathBuf::from(output), &report)?;
                    if report.has_blocking_diagnostic() {
                        return Err(format!(
                            "verify reported {} blocking diagnostic(s); see {}",
                            report.severity_counts.blocking(),
                            redact_for_log_or_report(&PathBuf::from(output).display().to_string())
                        )
                        .into());
                    }
                }
            }
        }
        Some("golden") => {
            run_golden_command(&args, registry)?;
        }
        Some("offset-map" | "offsets") => {
            run_offset_map_command(&args)?;
        }
        Some("helper-result") => {
            helper_commands::run_helper_result_command(&args)?;
        }
        Some("helper") => {
            helper_commands::run_helper_command(&args)?;
        }
        Some("key-helper") => {
            helper_commands::run_key_helper_command(&args)?;
        }
        Some("helper-registry") => {
            helper_commands::run_helper_registry_command(&args)?;
        }
        Some("key") => {
            run_key_command(&args)?;
        }
        Some("siglus") => {
            run_siglus_command(&args)?;
        }
        Some("rpg-maker" | "rpgmaker") => {
            run_rpg_maker_command(&args)?;
        }
        Some("xp3") => {
            run_xp3_command(&args)?;
        }
        Some("wolf") => {
            return run_wolf_command(&args);
        }
        Some("bgi") => {
            return run_bgi_command(&args);
        }
        Some("profile") => {
            run_profile_command(&args, registry)?;
        }
        Some("readiness") => {
            return run_readiness_command(&args);
        }
        Some("capabilities") => {
            let output = PathBuf::from(flag(&args, "--output")?);
            let capabilities = registry
                .adapters()
                .iter()
                .map(|adapter| adapter.capabilities().redacted_for_report())
                .collect::<Vec<_>>();
            write_json(&output, &capabilities)?;
        }
        Some("binary-patch-smoke") => {
            return run_binary_patch_smoke_command(&args);
        }
        Some("compat-evidence") => {
            return run_compat_evidence_command(&args);
        }
        Some("asset-ocr") => {
            return run_asset_ocr_command(&args);
        }
        Some("vault") => {
            return vault::run_vault_command(&args);
        }
        _ => {
            return Err(
                "usage: kaifuu <detect|extract|asset-inventory|patch|diff|apply|verify|golden|offset-map|helper|helper-result|key-helper|helper-registry|key|siglus|rpgmaker|rpg-maker|xp3|wolf|bgi|profile|readiness|capabilities|binary-patch-smoke|compat-evidence|asset-ocr|vault> ..."
                    .into(),
            );
        }
    }
    Ok(())
}

fn run_binary_patch_smoke_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let fixture_dir = flag_optional(args, "--fixture").map(PathBuf::from);
    let output_dir = PathBuf::from(flag(args, "--output")?);

    // `--inject-failure` is a test/debug-only rollback-testing
    // seam. It is only parsed when the failure-injection seam is compiled in
    // (`cfg(any(debug_assertions, feature = "failure-injection"))`). In a
    // release `--no-default-features` build the flag is NOT registered, so a
    // caller-supplied `--inject-failure` is an unknown flag and is rejected
    // rather than silently ignored by the manual arg parser.
    #[cfg(any(debug_assertions, feature = "failure-injection"))]
    let inject_failure = {
        let inject_failure_raw = flag_optional(args, "--inject-failure").unwrap_or("none");
        binary_patch_smoke::InjectFailure::parse(inject_failure_raw)
            .map_err(|message| -> Box<dyn std::error::Error> { message.into() })?
    };
    #[cfg(not(any(debug_assertions, feature = "failure-injection")))]
    if flag_present(args, "--inject-failure") {
        return Err("unknown flag --inject-failure".into());
    }

    let run_id = flag_optional(args, "--run-id").unwrap_or("binary-patch-smoke-0001");

    let outcome =
        binary_patch_smoke::run_binary_patch_smoke(binary_patch_smoke::BinaryPatchSmokeConfig {
            fixture_dir: fixture_dir.as_deref(),
            output_dir: &output_dir,
            #[cfg(any(debug_assertions, feature = "failure-injection"))]
            inject_failure,
            run_id,
        });

    let mut stdout = io::stdout();
    binary_patch_smoke::write_smoke_summary(&mut stdout, &outcome);

    match outcome {
        binary_patch_smoke::BinarySmokeOutcome::Passed => Ok(()),
        binary_patch_smoke::BinarySmokeOutcome::Failed => {
            std::process::exit(1);
        }
        binary_patch_smoke::BinarySmokeOutcome::Aborted(reason) => Err(reason.into()),
    }
}
fn run_patch_with_owned_staging(
    adapter: &dyn EngineAdapter,
    game_dir: &Path,
    patch_export: &PatchExport,
    output: &Path,
) -> KaifuuResult<PatchResult> {
    let staging_output = allocate_patch_staging_dir(output)?;
    let result = match adapter.patch(PatchRequest {
        game_dir,
        patch_export,
        output_dir: &staging_output,
    }) {
        Ok(result) => result.redacted_for_report(),
        Err(error) => {
            remove_patch_staging_dir(&staging_output)?;
            return Err(error);
        }
    };
    let failed = result.status == kaifuu_core::OperationStatus::Failed;
    if failed && result.has_preflight_blocking_failure() {
        remove_patch_staging_dir(&staging_output)?;
        return Err(patch_preflight_failure_message(&result).into());
    }
    if let Err(error) = write_json(&staging_output.join("patch-result.json"), &result) {
        remove_patch_staging_dir(&staging_output)?;
        return Err(error);
    }
    if let Err(error) = promote_patch_staging_dir(&staging_output, output) {
        remove_patch_staging_dir(&staging_output)?;
        return Err(error);
    }
    Ok(result)
}

fn patch_preflight_failure_message(result: &PatchResult) -> String {
    let details = result
        .failures
        .iter()
        .map(patch_preflight_failure_detail)
        .collect::<Vec<_>>();
    if details.is_empty() {
        "patch preflight failed".to_string()
    } else {
        format!("patch preflight failed: {}", details.join("; "))
    }
}

