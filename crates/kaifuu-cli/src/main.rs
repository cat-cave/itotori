use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use kaifuu_core::{
    AdapterRegistry, AssetInventoryManifest, AssetInventoryRequest, DetectionReport,
    DetectionResult, EngineAdapter, ExtractRequest, GameProfile, GoldenByteEquivalenceMode,
    GoldenHarnessRequest, HELPER_REGISTRY_SCHEMA_VERSION, HelperBinaryLaunchDiagnostic,
    HelperBinaryLaunchValidationRequest, HelperBinaryLaunchValidationResult, HelperCapability,
    HelperExecutionMode, HelperProcessCancelToken, HelperRedactionStatus,
    HelperRegistryInvocationRequest, KaifuuResult, LocalKeyImportRequest, LocalKeyImportSource,
    LocalSecretDirectoryStore, PatchExport, PatchPreflightRequest, PatchRequest, PatchResult,
    ProfileRequest, ProofHash, RegisteredBoundedHelperProcessRequest,
    SEMANTIC_HELPER_EXECUTION_DISALLOWED, SecretRef, SiglusParserBoundarySmokeRequest,
    SiglusParserBoundarySmokeVariant, VerifyRequest, atomic_write_text, fixture_helper_registry,
    normalize_helper_result_value, parse_helper_capability, parse_hex_bytes,
    promote_staged_directory_no_clobber, read_json, redact_for_log_or_report, redact_report_value,
    run_registered_bounded_helper_process, run_round_trip_golden,
    run_siglus_known_key_parser_boundary_smoke, sha256_hash_bytes,
    validate_helper_registry_entry_value, validate_helper_result_value, validate_offset_map_value,
    validate_profile_value, write_json,
};
use kaifuu_delta::{apply_delta, create_delta};

const APPLY_REPORT_FILE_NAME: &str = "patch-result.json";

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
            let game_dir = PathBuf::from(positional(&args, 1)?);
            let output = PathBuf::from(flag(&args, "--output")?);
            let adapter = registered_adapter_for_game(registry, &game_dir)?;
            let extraction = adapter.extract(ExtractRequest {
                game_dir: &game_dir,
            })?;
            write_json(&output, &extraction.bridge)?;
        }
        Some("asset-inventory" | "assets") => {
            let game_dir = PathBuf::from(positional(&args, 1)?);
            let output = PathBuf::from(flag(&args, "--output")?);
            let adapter = registered_adapter_for_game(registry, &game_dir)?;
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
            let game_dir = PathBuf::from(positional(&args, 1)?);
            let patch = PathBuf::from(flag(&args, "--patch")?);
            let output = PathBuf::from(flag(&args, "--output")?);
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
                return Err(format!(
                    "patch preflight failed: {}",
                    preflight.failure_codes().join(", ")
                )
                .into());
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
            write_json(
                &PathBuf::from(output),
                &create_delta(&PathBuf::from(original), &PathBuf::from(patched))?,
            )?;
        }
        Some("apply") => {
            let game_dir = PathBuf::from(positional(&args, 1)?);
            let patch = PathBuf::from(flag(&args, "--patch")?);
            let output = PathBuf::from(flag(&args, "--output")?);
            let report_output = flag_optional(&args, "--report-output")
                .map(PathBuf::from)
                .map(Ok)
                .unwrap_or_else(|| default_apply_report_output(&output))?;
            let report_output = validate_apply_report_output(&game_dir, &output, &report_output)?;
            let result = apply_delta(&game_dir, &patch, &output)?;
            write_apply_report_json(&report_output, &redact_report_value(&result))?;
        }
        Some("verify") => {
            let game_dir = PathBuf::from(positional(&args, 1)?);
            let output = flag_optional(&args, "--output").unwrap_or("verify-result.json");
            let adapter = registered_adapter_for_game(registry, &game_dir)?;
            let result = adapter
                .verify(VerifyRequest {
                    game_dir: &game_dir,
                })?
                .redacted_for_report();
            write_json(&PathBuf::from(output), &result)?;
        }
        Some("golden") => {
            run_golden_command(&args, registry)?;
        }
        Some("offset-map" | "offsets") => {
            run_offset_map_command(&args)?;
        }
        Some("helper-result") => {
            run_helper_result_command(&args)?;
        }
        Some("key-helper") => {
            run_key_helper_command(&args)?;
        }
        Some("helper-registry") => {
            run_helper_registry_command(&args)?;
        }
        Some("key") => {
            run_key_command(&args)?;
        }
        Some("siglus") => {
            run_siglus_command(&args)?;
        }
        Some("profile") => {
            run_profile_command(&args, registry)?;
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
        _ => {
            return Err(
                "usage: kaifuu <detect|extract|asset-inventory|patch|diff|apply|verify|golden|offset-map|helper-result|key-helper|helper-registry|key|siglus|profile|capabilities> ..."
                    .into(),
            );
        }
    }
    Ok(())
}

fn run_siglus_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    match positional(args, 1)? {
        "parser-boundary-smoke" => {
            let scene_path = PathBuf::from(flag(args, "--scene")?);
            let gameexe_path = PathBuf::from(flag(args, "--gameexe")?);
            let output = PathBuf::from(flag(args, "--output")?);
            let key_request = flag_optional(args, "--key-request")
                .map(PathBuf::from)
                .map(|path| read_json::<serde_json::Value>(&path))
                .transpose()?;
            let variant = parse_siglus_parser_boundary_variant(
                flag_optional(args, "--variant").unwrap_or("parser-boundary-success"),
            )?;
            let report =
                run_siglus_known_key_parser_boundary_smoke(SiglusParserBoundarySmokeRequest {
                    scene_path: &scene_path,
                    gameexe_path: &gameexe_path,
                    key_request: key_request.as_ref(),
                    variant,
                })?;
            write_json(&output, &report.redacted_for_report())?;
            if report.status == kaifuu_core::OperationStatus::Failed {
                return Err(
                    format!("siglus parser-boundary smoke failed: {:?}", report.outcome).into(),
                );
            }
        }
        _ => {
            return Err(
                "usage: kaifuu siglus parser-boundary-smoke --scene <Scene.pck> --gameexe <Gameexe.dat> --key-request <helper-request.json> --output <report.json> [--variant parser-boundary-success|helper-required|missing-key|unsupported-opcode|out-of-profile]"
                    .into(),
            );
        }
    }
    Ok(())
}

fn parse_siglus_parser_boundary_variant(
    value: &str,
) -> Result<SiglusParserBoundarySmokeVariant, Box<dyn std::error::Error>> {
    match value {
        "parser-boundary-success" | "success" => {
            Ok(SiglusParserBoundarySmokeVariant::ParserBoundarySuccess)
        }
        "helper-required" => Ok(SiglusParserBoundarySmokeVariant::HelperRequired),
        "missing-key" => Ok(SiglusParserBoundarySmokeVariant::MissingKey),
        "unsupported-opcode" => Ok(SiglusParserBoundarySmokeVariant::UnsupportedOpcode),
        "out-of-profile" => Ok(SiglusParserBoundarySmokeVariant::OutOfProfile),
        _ => Err(format!("unsupported Siglus parser-boundary smoke variant {value}").into()),
    }
}

fn run_key_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    match positional(args, 1)? {
        "import" => {
            let secret_store = PathBuf::from(flag(args, "--secret-store")?);
            let secret_ref = SecretRef::new(flag(args, "--secret-ref")?.to_string())?;
            let key_purpose = flag(args, "--purpose")?.to_string();
            let engine_profile_id = flag(args, "--engine-profile-id")?.to_string();
            let source_hash = ProofHash::new(
                flag_optional(args, "--source-hash")
                    .map(str::to_string)
                    .unwrap_or_else(|| {
                        sha256_hash_bytes(format!("{engine_profile_id}:{key_purpose}").as_bytes())
                    }),
            )?;
            let output = PathBuf::from(flag(args, "--output")?);
            let source = match flag_optional(args, "--source").unwrap_or("manual") {
                "manual" | "manual-key-entry" => LocalKeyImportSource::ManualKeyEntry,
                "known-key" | "known-key-database" => LocalKeyImportSource::KnownKeyDatabaseImport,
                value => {
                    return Err(format!("unsupported key import source {value}").into());
                }
            };
            let material = import_key_material_from_args(args)?;
            let result = LocalSecretDirectoryStore::new(secret_store).import_key_reference(
                LocalKeyImportRequest {
                    secret_ref,
                    key_purpose,
                    engine_profile_id,
                    source_hash,
                    redaction_status: HelperRedactionStatus::Redacted,
                    source,
                    material,
                },
            )?;
            atomic_write_text(&output, &result.stable_json()?)?;
        }
        _ => {
            return Err(
                "usage: kaifuu key import --secret-store <dir> --secret-ref <local-secret:id> --purpose <id> --engine-profile-id <id> (--key-hex <hex>|--key-file <path>) --output <metadata.json> [--source-hash sha256:<hash>] [--source manual|known-key]"
                    .into(),
            );
        }
    }
    Ok(())
}

fn import_key_material_from_args(args: &[String]) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let key_hex = flag_optional(args, "--key-hex");
    let key_file = flag_optional(args, "--key-file");
    match (key_hex, key_file) {
        (Some(_), Some(_)) => Err("choose either --key-hex or --key-file, not both".into()),
        (Some(hex), None) => Ok(parse_hex_bytes(hex)?),
        (None, Some(path)) => Ok(fs::read(path)?),
        (None, None) => Err("key import requires --key-hex or --key-file".into()),
    }
}

fn run_helper_registry_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    match positional(args, 1)? {
        "validate" => {
            let registry_entry_path = PathBuf::from(positional(args, 2)?);
            let output = PathBuf::from(flag(args, "--output")?);
            let value: serde_json::Value = read_json(&registry_entry_path)?;
            let validation = validate_helper_registry_entry_value(&value).redacted_for_report();
            let failed = validation.status == kaifuu_core::OperationStatus::Failed;
            write_json(&output, &validation)?;
            if failed {
                return Err(format!(
                    "helper registry validation failed for {}: {}",
                    validation.helper_id.as_deref().unwrap_or("<unknown>"),
                    validation
                        .diagnostics
                        .iter()
                        .map(|diagnostic| format!("{}:{}", diagnostic.field, diagnostic.code))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
                .into());
            }
        }
        "invoke-fixture-stub" => {
            let output = PathBuf::from(flag(args, "--output")?);
            let input = flag_optional(args, "--input")
                .map(PathBuf::from)
                .map(|path| read_json(&path))
                .transpose()?
                .unwrap_or_else(|| serde_json::json!({"fixture": true}));
            let registry = fixture_helper_registry()?;
            let helper_id = flag_optional(args, "--helper-id")
                .or_else(|| input.get("helperId").and_then(serde_json::Value::as_str))
                .unwrap_or(kaifuu_core::FIXTURE_HELPER_REGISTRY_ID);
            let helper_version = flag_optional(args, "--helper-version")
                .or_else(|| {
                    input
                        .get("helperVersion")
                        .and_then(serde_json::Value::as_str)
                })
                .unwrap_or("0.1.0");
            let allowlist_entry_id = flag_optional(args, "--allowlist-entry-id")
                .or_else(|| {
                    input
                        .get("allowlistEntryId")
                        .and_then(serde_json::Value::as_str)
                })
                .unwrap_or(kaifuu_core::FIXTURE_HELPER_ALLOWLIST_REF_ID);
            let capability = flag_optional(args, "--capability")
                .or_else(|| {
                    input
                        .get("requestedCapability")
                        .and_then(serde_json::Value::as_str)
                })
                .map(|capability| {
                    parse_helper_capability(capability).ok_or_else(
                        || -> Box<dyn std::error::Error> {
                            format!("unsupported helper capability {capability}").into()
                        },
                    )
                })
                .transpose()?
                .unwrap_or(HelperCapability::FixtureInvocation);
            let result = registry.invoke(HelperRegistryInvocationRequest {
                helper_id,
                helper_version,
                allowlist_entry_id,
                capability,
                input: &input,
            })?;
            write_json(&output, &redact_report_value(&result))?;
        }
        "check-binary" => {
            let registry_entry_path = PathBuf::from(positional(args, 2)?);
            let output = PathBuf::from(flag(args, "--output")?);
            let executable_path = PathBuf::from(flag(args, "--helper-binary")?);
            let allowlist_entry_id = flag(args, "--allowlist-entry-id")?;
            let platform = flag(args, "--platform")?;
            let helper_version = flag(args, "--helper-version")?;
            let value: serde_json::Value = read_json(&registry_entry_path)?;
            let registry_validation = validate_helper_registry_entry_value(&value);
            if registry_validation.status == kaifuu_core::OperationStatus::Failed {
                let registry_validation = registry_validation.redacted_for_report();
                write_json(&output, &registry_validation)?;
                return Err(format!(
                    "helper registry validation failed for {}: {}",
                    registry_validation
                        .helper_id
                        .as_deref()
                        .unwrap_or("<unknown>"),
                    registry_validation
                        .diagnostics
                        .iter()
                        .map(|diagnostic| format!("{}:{}", diagnostic.field, diagnostic.code))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
                .into());
            }
            let entry: kaifuu_core::HelperRegistryEntry = serde_json::from_value(value)?;
            let required_capabilities = flag_values(args, "--capability")
                .iter()
                .map(|capability| {
                    parse_helper_capability(capability)
                        .ok_or_else(|| format!("unsupported helper capability {capability}").into())
                })
                .collect::<Result<Vec<_>, Box<dyn std::error::Error>>>()?;
            let result = entry
                .validate_binary_launch(HelperBinaryLaunchValidationRequest {
                    helper_id: &entry.helper_id,
                    allowlist_entry_id,
                    executable_path: &executable_path,
                    platform,
                    helper_version,
                    required_capabilities: &required_capabilities,
                })
                .redacted_for_report();
            let failed = result.status == kaifuu_core::OperationStatus::Failed;
            write_json(&output, &result)?;
            if failed {
                return Err(format!(
                    "helper binary allowlist validation failed for {} / {}: {}",
                    result.helper_id,
                    result.allowlist_entry_id,
                    result
                        .diagnostics
                        .iter()
                        .map(|diagnostic| diagnostic.code.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
                .into());
            }
        }
        _ => {
            return Err(
                "usage: kaifuu helper-registry <validate <entry.json>|check-binary <entry.json>|invoke-fixture-stub> --output <report.json>"
                    .into(),
            );
        }
    }
    Ok(())
}

fn run_helper_result_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    match positional(args, 1)? {
        "validate" => {
            let helper_result_path = PathBuf::from(positional(args, 2)?);
            let output = PathBuf::from(flag(args, "--output")?);
            let value: serde_json::Value = read_json(&helper_result_path)?;
            let validation = validate_helper_result_value(&value).redacted_for_report();
            let failed = validation.status == kaifuu_core::OperationStatus::Failed;
            write_json(&output, &validation)?;
            if failed {
                return Err(format!(
                    "helper result validation failed for fixture {}: {}",
                    validation.fixture_id.as_deref().unwrap_or("<unknown>"),
                    validation
                        .failures
                        .iter()
                        .map(|failure| format!("{}:{}", failure.field, failure.code))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
                .into());
            }
        }
        _ => {
            return Err(
                "usage: kaifuu helper-result validate <helper-result.json> --output <report.json>"
                    .into(),
            );
        }
    }
    Ok(())
}

fn run_key_helper_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    match positional(args, 1)? {
        "validate" => {
            let fixture = PathBuf::from(flag(args, "--fixture")?);
            let output = PathBuf::from(flag(args, "--output")?);
            let value: serde_json::Value = read_json(&fixture)?;
            match normalize_helper_result_value(&value) {
                Ok(result) => {
                    atomic_write_text(&output, &result.stable_json()?)?;
                }
                Err(validation) => {
                    write_json(&output, &validation)?;
                    return Err(format!(
                        "key helper fixture validation failed for {}: {}",
                        validation.fixture_id.as_deref().unwrap_or("<unknown>"),
                        validation
                            .failures
                            .iter()
                            .map(|failure| format!("{}:{}", failure.field, failure.code))
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                    .into());
                }
            }
        }
        "run-process" => {
            let helper_binary = PathBuf::from(flag(args, "--helper-binary")?);
            let timeout_ms = parse_u32_flag(args, "--timeout-ms")?;
            let output = PathBuf::from(flag(args, "--output")?);
            let registry_entry_path = PathBuf::from(flag(args, "--helper-registry-entry")?);
            let allowlist_entry_id = flag(args, "--allowlist-entry-id")?;
            let platform = flag(args, "--platform")?;
            let helper_version = flag(args, "--helper-version")?;
            let registry_value: serde_json::Value = read_json(&registry_entry_path)?;
            let registry_validation = validate_helper_registry_entry_value(&registry_value);
            if registry_validation.status == kaifuu_core::OperationStatus::Failed {
                let registry_validation = registry_validation.redacted_for_report();
                write_json(&output, &registry_validation)?;
                return Err(format!(
                    "helper registry validation failed for {}: {}",
                    registry_validation
                        .helper_id
                        .as_deref()
                        .unwrap_or("<unknown>"),
                    registry_validation
                        .diagnostics
                        .iter()
                        .map(|diagnostic| format!("{}:{}", diagnostic.field, diagnostic.code))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
                .into());
            }
            let entry: kaifuu_core::HelperRegistryEntry = serde_json::from_value(registry_value)?;
            let helper_id = flag_optional(args, "--helper-id")
                .map(str::to_string)
                .unwrap_or_else(|| entry.helper_id.clone());
            let required_capabilities = flag_values(args, "--capability")
                .iter()
                .map(|capability| {
                    parse_helper_capability(capability)
                        .ok_or_else(|| format!("unsupported helper capability {capability}").into())
                })
                .collect::<Result<Vec<_>, Box<dyn std::error::Error>>>()?;
            if required_capabilities.is_empty() {
                return Err("run-process requires at least one --capability".into());
            }
            if entry.execution_policy.mode != HelperExecutionMode::LocalProcess {
                let policy_report = helper_execution_policy_requires_local_process_report(
                    &helper_id,
                    allowlist_entry_id,
                    platform,
                );
                write_json(&output, &policy_report)?;
                return Err(SEMANTIC_HELPER_EXECUTION_DISALLOWED.into());
            }
            let allowlist_validation = entry
                .validate_binary_launch(HelperBinaryLaunchValidationRequest {
                    helper_id: &helper_id,
                    allowlist_entry_id,
                    executable_path: &helper_binary,
                    platform,
                    helper_version,
                    required_capabilities: &required_capabilities,
                })
                .redacted_for_report();
            if allowlist_validation.status == kaifuu_core::OperationStatus::Failed {
                write_json(&output, &allowlist_validation)?;
                return Err(format!(
                    "helper binary allowlist validation failed for {} / {}: {}",
                    allowlist_validation.helper_id,
                    allowlist_validation.allowlist_entry_id,
                    allowlist_validation
                        .diagnostics
                        .iter()
                        .map(|diagnostic| diagnostic.code.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
                .into());
            }
            let policy_timeout_ms = entry
                .execution_policy
                .max_runtime_seconds
                .saturating_mul(1000);
            let effective_timeout_ms = timeout_ms.min(policy_timeout_ms);
            let stdin = flag_optional(args, "--stdin")
                .map(fs::read)
                .transpose()?
                .unwrap_or_default();
            let cancel_token = flag_optional(args, "--cancel-after-ms")
                .map(|value| {
                    let delay_ms = value.parse::<u64>().map_err(|_| {
                        format!("flag --cancel-after-ms must be an unsigned integer, got {value}")
                    })?;
                    let token = HelperProcessCancelToken::new();
                    let cancel_token = token.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                        cancel_token.cancel();
                    });
                    Ok::<_, Box<dyn std::error::Error>>(token)
                })
                .transpose()?;
            let result = run_registered_bounded_helper_process(
                &entry,
                RegisteredBoundedHelperProcessRequest {
                    helper_id: &helper_id,
                    allowlist_entry_id,
                    executable_path: &helper_binary,
                    platform,
                    helper_version,
                    required_capabilities: &required_capabilities,
                    timeout_ms: effective_timeout_ms,
                    stdin: &stdin,
                    cancel_token,
                },
            );
            let failed = result.status == kaifuu_core::OperationStatus::Failed;
            write_json(&output, &result)?;
            if failed {
                return Err(result.diagnostic.code.into());
            }
        }
        _ => {
            return Err(
                "usage: kaifuu key-helper <validate --fixture <helper-result.json>|run-process --helper-registry-entry <entry.json> --helper-binary <path> --allowlist-entry-id <id> --platform <platform> --helper-version <version> --capability <capability> --timeout-ms <ms>> --output <report.json>"
                    .into(),
            );
        }
    }
    Ok(())
}

fn helper_execution_policy_requires_local_process_report(
    helper_id: &str,
    allowlist_entry_id: &str,
    platform: &str,
) -> HelperBinaryLaunchValidationResult {
    HelperBinaryLaunchValidationResult {
        schema_version: HELPER_REGISTRY_SCHEMA_VERSION.to_string(),
        helper_id: redact_for_log_or_report(helper_id),
        allowlist_entry_id: redact_for_log_or_report(allowlist_entry_id),
        status: kaifuu_core::OperationStatus::Failed,
        observed_hash: None,
        platform: redact_for_log_or_report(platform),
        diagnostics: vec![HelperBinaryLaunchDiagnostic {
            helper_id: redact_for_log_or_report(helper_id),
            allowlist_entry_id: redact_for_log_or_report(allowlist_entry_id),
            code: SEMANTIC_HELPER_EXECUTION_DISALLOWED.to_string(),
            field: "executionPolicy.mode".to_string(),
            observed_hash: None,
            platform: redact_for_log_or_report(platform),
            remediation_code: "select_allowed_helper_policy".to_string(),
            message: "helper registry execution policy must be local_process for process launch"
                .to_string(),
        }],
    }
}

fn run_offset_map_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    match positional(args, 1)? {
        "validate" => {
            let offset_map_path = PathBuf::from(positional(args, 2)?);
            let output = PathBuf::from(flag(args, "--output")?);
            let value: serde_json::Value = read_json(&offset_map_path)?;
            let validation = validate_offset_map_value(&value);
            let failed = validation.status == kaifuu_core::OperationStatus::Failed;
            write_json(&output, &validation)?;
            if failed {
                return Err(format!(
                    "offset map validation failed: {}",
                    validation
                        .diagnostics
                        .iter()
                        .map(|diagnostic| diagnostic.code.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
                .into());
            }
        }
        _ => {
            return Err(
                "usage: kaifuu offset-map validate <offset-map.json> --output <report.json>".into(),
            );
        }
    }
    Ok(())
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
        return Err(format!(
            "patch preflight failed: {}",
            result.failure_codes().join(", ")
        )
        .into());
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

fn run_golden_command(
    args: &[String],
    registry: &AdapterRegistry,
) -> Result<(), Box<dyn std::error::Error>> {
    let game_dir = PathBuf::from(positional(args, 1)?);
    let output = PathBuf::from(flag(args, "--output")?);
    let work_dir = flag_optional(args, "--work-dir")
        .map(PathBuf::from)
        .unwrap_or_else(|| output.with_extension("work"));
    let translated_patch_export = flag_optional(args, "--translated-patch")
        .map(PathBuf::from)
        .map(|path| read_json::<serde_json::Value>(&path))
        .transpose()?;
    let translated_source_bridge = flag_optional(args, "--translated-source-bridge")
        .map(PathBuf::from)
        .map(|path| read_json::<serde_json::Value>(&path))
        .transpose()?;
    let byte_equivalence = if flag_present(args, "--expect-byte-identical") {
        GoldenByteEquivalenceMode::AssertSourceJson
    } else {
        GoldenByteEquivalenceMode::Unsupported {
            support_boundary:
                "byte-identical round-trip is not claimed unless --expect-byte-identical is set for an adapter known to support byte-stable patching"
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

fn run_profile_command(
    args: &[String],
    registry: &AdapterRegistry,
) -> Result<(), Box<dyn std::error::Error>> {
    match positional(args, 1)? {
        "init" => {
            let game_dir = PathBuf::from(positional(args, 2)?);
            let output = PathBuf::from(flag(args, "--output")?);
            let adapter = registered_adapter_for_game(registry, &game_dir)?;
            let profile = adapter.profile(ProfileRequest {
                game_dir: &game_dir,
            })?;
            write_validated_stable_profile(&output, &profile)?;
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
            let adapter = registered_adapter_for_game(registry, &game_dir)?;
            let profile = adapter.profile(ProfileRequest {
                game_dir: &game_dir,
            })?;
            write_validated_stable_profile(&output, &profile)?;
        }
    }
    Ok(())
}

fn engine_registry() -> AdapterRegistry {
    kaifuu_engine_fixture::registry()
}

fn detect_registered_adapter(
    registry: &AdapterRegistry,
    game_dir: &Path,
) -> KaifuuResult<DetectionResult> {
    registry.detect(game_dir)?.ok_or_else(|| {
        format!(
            "no registered adapter detected {}",
            redact_for_log_or_report(&game_dir.display().to_string())
        )
        .into()
    })
}

fn registered_adapter_for_game<'a>(
    registry: &'a AdapterRegistry,
    game_dir: &Path,
) -> KaifuuResult<&'a dyn EngineAdapter> {
    let detection = detect_registered_adapter(registry, game_dir)?;
    registry.get(&detection.adapter_id).ok_or_else(|| {
        format!(
            "detected adapter {} is not registered",
            detection.adapter_id
        )
        .into()
    })
}

fn write_validated_stable_profile(output: &Path, profile: &GameProfile) -> KaifuuResult<()> {
    let mut normalized = profile.clone();
    normalized.normalize();
    let value = serde_json::to_value(&normalized)?;
    let validation = validate_profile_value(&value);
    if validation.status == kaifuu_core::OperationStatus::Failed {
        let validation = validation.redacted_for_report();
        return Err(format!(
            "generated profile failed validation: {}",
            validation
                .failures
                .iter()
                .map(|failure| failure.code.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )
        .into());
    }
    atomic_write_text(
        output,
        &kaifuu_core::stable_json(&redact_report_value(&value))?,
    )
}

fn write_stable_asset_inventory(
    output: &Path,
    manifest: &AssetInventoryManifest,
) -> KaifuuResult<()> {
    let mut normalized = manifest.clone();
    normalized.normalize();
    let value = serde_json::to_value(&normalized)?;
    atomic_write_text(
        output,
        &kaifuu_core::stable_json(&redact_report_value(&value))?,
    )
}

fn default_apply_report_output(output: &Path) -> KaifuuResult<PathBuf> {
    let output_name = output
        .file_name()
        .ok_or("apply output directory must include a final path component")?
        .to_string_lossy();
    Ok(output
        .with_file_name(format!("{output_name}.kaifuu"))
        .join(APPLY_REPORT_FILE_NAME))
}

fn validate_apply_report_output(
    game_dir: &Path,
    output: &Path,
    report_output: &Path,
) -> KaifuuResult<PathBuf> {
    let source_root = lexical_absolute_path(game_dir)?;
    let output_root = lexical_absolute_path(output)?;
    let report_path = lexical_absolute_path(report_output)?;
    let source_root_canonical = canonical_existing_prefix(game_dir)?;
    let output_root_canonical = canonical_existing_prefix(output)?;
    let report_path_canonical = canonical_existing_prefix(report_output)?;

    if path_is_inside_root(&report_path, &source_root)
        || path_is_inside_root(&report_path_canonical, &source_root_canonical)
    {
        return Err(format!(
            "apply report output must not be inside source game directory: {}",
            redact_for_log_or_report(&report_output.display().to_string())
        )
        .into());
    }
    if path_is_inside_root(&report_path, &output_root)
        || path_is_inside_root(&report_path_canonical, &output_root_canonical)
    {
        return Err(format!(
            "apply report output must not be inside patched output directory: {}",
            redact_for_log_or_report(&report_output.display().to_string())
        )
        .into());
    }
    reject_existing_symlink_components(&report_path)?;
    Ok(report_path)
}

fn path_is_inside_root(path: &Path, root: &Path) -> bool {
    path == root || path.starts_with(root)
}

fn canonical_existing_prefix(path: &Path) -> KaifuuResult<PathBuf> {
    let absolute = lexical_absolute_path(path)?;
    let components = absolute
        .components()
        .map(|component| component.as_os_str().to_os_string())
        .collect::<Vec<_>>();

    let mut current = PathBuf::new();
    let mut canonical_prefix = PathBuf::new();
    let mut consumed = 0_usize;
    for (index, component) in components.iter().enumerate() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(_) => {
                canonical_prefix = match fs::canonicalize(&current) {
                    Ok(canonical) => canonical,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => break,
                    Err(error) => return Err(error.into()),
                };
                consumed = index + 1;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => break,
            Err(error) => return Err(error.into()),
        }
    }

    let mut canonical = canonical_prefix;
    for component in &components[consumed..] {
        canonical.push(component);
    }
    Ok(canonical)
}

fn reject_existing_symlink_components(path: &Path) -> KaifuuResult<()> {
    let mut current = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => current.push(prefix.as_os_str()),
            Component::RootDir => current.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir | Component::Normal(_) => {
                current.push(component.as_os_str());
                let metadata = match fs::symlink_metadata(&current) {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => break,
                    Err(error) => return Err(error.into()),
                };
                if metadata.file_type().is_symlink() {
                    return Err(format!(
                        "apply report output path must not contain symlinks: {}",
                        redact_for_log_or_report(&current.display().to_string())
                    )
                    .into());
                }
            }
        }
    }
    Ok(())
}

fn write_apply_report_json(report_output: &Path, value: &serde_json::Value) -> KaifuuResult<()> {
    let parent = report_output.parent().unwrap_or_else(|| Path::new("."));
    create_report_parent_without_symlinks(parent)?;
    reject_existing_symlink_components(report_output)?;
    write_json(report_output, value)
}

fn create_report_parent_without_symlinks(parent: &Path) -> KaifuuResult<()> {
    if parent.as_os_str().is_empty() {
        return Ok(());
    }

    let mut current = PathBuf::new();
    for component in parent.components() {
        match component {
            Component::Prefix(prefix) => current.push(prefix.as_os_str()),
            Component::RootDir => current.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir | Component::Normal(_) => {
                current.push(component.as_os_str());
                match fs::symlink_metadata(&current) {
                    Ok(metadata) => {
                        if metadata.file_type().is_symlink() {
                            return Err(format!(
                                "apply report output parent must not contain symlinks: {}",
                                redact_for_log_or_report(&current.display().to_string())
                            )
                            .into());
                        }
                        if !metadata.is_dir() {
                            return Err(format!(
                                "apply report output parent must be a directory: {}",
                                redact_for_log_or_report(&current.display().to_string())
                            )
                            .into());
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {
                        fs::create_dir(&current)?;
                        let metadata = fs::symlink_metadata(&current)?;
                        if metadata.file_type().is_symlink() || !metadata.is_dir() {
                            return Err(format!(
                                "apply report output parent must be a directory and not a symlink: {}",
                                redact_for_log_or_report(&current.display().to_string())
                            )
                            .into());
                        }
                    }
                    Err(error) => return Err(error.into()),
                }
            }
        }
    }
    Ok(())
}

fn lexical_absolute_path(path: &Path) -> KaifuuResult<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                let at_root = normalized
                    .components()
                    .next_back()
                    .is_some_and(|part| matches!(part, Component::Prefix(_) | Component::RootDir));
                if !at_root {
                    normalized.pop();
                }
            }
            Component::Normal(part) => normalized.push(part),
        }
    }
    Ok(normalized)
}

fn allocate_patch_staging_dir(output: &Path) -> KaifuuResult<PathBuf> {
    let parent = output.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let file_name = output
        .file_name()
        .ok_or("patch output directory must include a final path component")?
        .to_string_lossy();
    for attempt in 0..1000 {
        let staging = parent.join(format!(
            ".{file_name}.kaifuu-staging-{}-{attempt}",
            std::process::id()
        ));
        match fs::create_dir(&staging) {
            Ok(()) => return Ok(staging),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    Err("could not allocate a unique patch staging directory".into())
}

fn remove_patch_staging_dir(staging_output: &Path) -> KaifuuResult<()> {
    match fs::remove_dir_all(staging_output) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn promote_patch_staging_dir(staging_output: &Path, output: &Path) -> KaifuuResult<()> {
    promote_staged_directory_no_clobber(staging_output, output, "patch output directory")
}

fn positional(args: &[String], index: usize) -> Result<&str, Box<dyn std::error::Error>> {
    args.get(index)
        .map(String::as_str)
        .ok_or_else(|| format!("missing positional argument {index}").into())
}

fn flag<'a>(args: &'a [String], name: &str) -> Result<&'a str, Box<dyn std::error::Error>> {
    flag_optional(args, name).ok_or_else(|| format!("missing flag {name}").into())
}

fn parse_u32_flag(args: &[String], name: &str) -> Result<u32, Box<dyn std::error::Error>> {
    let value = flag(args, name)?;
    let parsed = value
        .parse::<u32>()
        .map_err(|_| format!("flag {name} must be an unsigned integer, got {value}"))?;
    if parsed == 0 {
        return Err(format!("flag {name} must be greater than zero").into());
    }
    Ok(parsed)
}

fn flag_optional<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .map(String::as_str)
}

fn flag_present(args: &[String], name: &str) -> bool {
    args.iter().any(|arg| arg == name)
}

fn flag_values<'a>(args: &'a [String], name: &str) -> Vec<&'a str> {
    args.iter()
        .enumerate()
        .filter_map(|(index, arg)| {
            if arg == name {
                args.get(index + 1).map(String::as_str)
            } else {
                None
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use kaifuu_core::{
        ASSET_INVENTORY_SCHEMA_VERSION, AdapterCapabilities, AdapterFailure, AdapterWarning,
        ArchiveDetectionSignal, ArchiveDetectionStatus, AssetInventoryAsset,
        AssetInventoryAssetKind, AssetInventoryAssetRef, AssetInventoryPatchMode,
        AssetInventorySurface, AssetInventorySurfaceKind, AssetInventoryTextSourceKind, AssetKind,
        AssetList, AssetListRequest, AssetProfile, BridgeBundle, BridgeUnit, Capability,
        CapabilityReport, CapabilityStatus, CodecTransform, ContainerTransform, CryptoTransform,
        DetectRequest, DetectionEvidence, DetectionReportStatus, EngineProfile, EvidenceStatus,
        ExtractionResult, GoldenAssertionStatus, GoldenRoundTripReport, HelperCapability,
        LayeredAccessCapabilityContract, LayeredAccessPreflightReport,
        LayeredAccessPreflightRequirement, LayeredAccessProfile, LayeredAccessStage,
        OperationStatus, PatchExportEntry, PatchRef, PatchResult, ProfileRequirement,
        ProtectedSpanMapping, REDACTED_DETECTION_GAME_DIR, RequirementCategory, RequirementStatus,
        SemanticErrorCode, TextSurface, VerificationResult, XP3_PLAIN_MAGIC, content_hash,
        deterministic_id, read_json, sha256_hash_bytes,
    };
    use std::cell::RefCell;
    use std::collections::BTreeMap;
    use std::fs;
    use std::rc::Rc;
    use std::time::{SystemTime, UNIX_EPOCH};

    const TEST_ADAPTER_ID: &str = "kaifuu.test.registry";

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("kaifuu-cli-{name}-{}-{nonce}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(unix)]
    fn write_executable_stub(path: &Path, script: &str) {
        use std::os::unix::fs::PermissionsExt;

        fs::write(path, script).unwrap();
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(path, permissions).unwrap();
    }

    #[cfg(unix)]
    fn write_process_helper_registry_entry(root: &Path, helper: &Path) -> PathBuf {
        let registry_path = root.join("process-helper-registry.json");
        let executable_name = helper.file_name().unwrap().to_str().unwrap();
        let helper_hash = sha256_hash_bytes(&fs::read(helper).unwrap());
        let registry_entry = serde_json::json!({
            "schemaVersion": "0.1.0",
            "helperId": "kaifuu.fixture.process-stub",
            "helperVersion": "0.1.0",
            "capabilities": ["fixture_invocation"],
            "inputSchemaId": "kaifuu.helper.fixture-request.v0.1",
            "outputSchemaId": "kaifuu.helper-result.v0.1",
            "redactionClass": "public_fixture",
            "executionPolicy": {
                "policyId": "kaifuu-process-helper-stub-policy",
                "mode": "local_process",
                "allowlistRefId": kaifuu_core::FIXTURE_HELPER_ALLOWLIST_REF_ID,
                "filesystemAccess": "none",
                "networkAccess": false,
                "maxRuntimeSeconds": 5
            },
            "binaryAllowlist": {
                "entries": [
                    {
                        "allowlistEntryId": kaifuu_core::FIXTURE_HELPER_ALLOWLIST_REF_ID,
                        "helperId": "kaifuu.fixture.process-stub",
                        "platform": "fixture-any",
                        "helperVersion": "0.1.0",
                        "executableName": executable_name,
                        "sha256Hash": helper_hash,
                        "signature": {
                            "signatureKind": "public-fixture-none",
                            "signer": "kaifuu-public-fixtures",
                            "signatureRef": "fixtures-public-no-signature"
                        },
                        "capabilities": ["fixture_invocation"]
                    }
                ]
            }
        });
        fs::write(
            &registry_path,
            serde_json::to_string_pretty(&registry_entry).unwrap(),
        )
        .unwrap();
        registry_path
    }

    #[cfg(unix)]
    fn allowlisted_process_args(registry: &Path, helper: &Path) -> Vec<String> {
        vec![
            "--helper-id".to_string(),
            "kaifuu.fixture.process-stub".to_string(),
            "--helper-registry-entry".to_string(),
            registry.to_str().unwrap().to_string(),
            "--helper-binary".to_string(),
            helper.to_str().unwrap().to_string(),
            "--allowlist-entry-id".to_string(),
            kaifuu_core::FIXTURE_HELPER_ALLOWLIST_REF_ID.to_string(),
            "--platform".to_string(),
            "fixture-any".to_string(),
            "--helper-version".to_string(),
            "0.1.0".to_string(),
            "--capability".to_string(),
            "fixture_invocation".to_string(),
        ]
    }

    fn temp_game(root: &Path) -> PathBuf {
        let game_dir = root.join("game");
        fs::create_dir_all(&game_dir).unwrap();
        fs::write(
            game_dir.join("source.json"),
            r#"{
  "gameId": "hello-fixture",
  "title": "Hello Fixture",
  "sourceLocale": "ja-JP",
  "units": [
    {
      "sourceUnitKey": "hello.scene.001.line.001",
      "speaker": "Narrator",
      "textSurface": "dialogue",
      "sourceText": "こんにちは、{player}。",
      "protectedSpans": [
        {
          "kind": "placeholder",
          "raw": "{player}",
          "start": 6,
          "end": 14
        }
      ]
    }
  ]
}
"#,
        )
        .unwrap();
        game_dir
    }

    fn public_fixture_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/hello-game")
    }

    fn public_fixture_path(relative_path: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(relative_path)
    }

    fn core_fixture_path(relative_path: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../kaifuu-core")
            .join(relative_path)
    }

    fn write_fixture_file(root: &Path, relative_path: &str, bytes: &[u8]) {
        let path = root.join(relative_path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, bytes).unwrap();
    }

    #[derive(Clone, Copy)]
    struct Xp3TestEntry<'a> {
        path: &'a str,
        payload: &'a [u8],
        compressed: bool,
        adler32: u32,
    }

    fn plain_xp3_fixture(entries: &[Xp3TestEntry<'_>]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(XP3_PLAIN_MAGIC);
        bytes.extend_from_slice(&0_u64.to_le_bytes());

        let mut segment_offsets = Vec::new();
        for entry in entries {
            segment_offsets.push(bytes.len() as u64);
            bytes.extend_from_slice(entry.payload);
        }

        let index_offset = bytes.len() as u64;
        let mut index = Vec::new();
        for (entry, offset) in entries.iter().zip(segment_offsets) {
            let mut file = Vec::new();
            let path_units = entry.path.encode_utf16().collect::<Vec<_>>();
            let mut info = Vec::new();
            info.extend_from_slice(&0_u32.to_le_bytes());
            info.extend_from_slice(&(entry.payload.len() as u64).to_le_bytes());
            info.extend_from_slice(&(entry.payload.len() as u64).to_le_bytes());
            info.extend_from_slice(&(path_units.len() as u16).to_le_bytes());
            for unit in path_units {
                info.extend_from_slice(&unit.to_le_bytes());
            }
            append_xp3_chunk(&mut file, b"info", &info);

            let mut segment = Vec::new();
            segment.extend_from_slice(&(u32::from(entry.compressed)).to_le_bytes());
            segment.extend_from_slice(&offset.to_le_bytes());
            segment.extend_from_slice(&(entry.payload.len() as u64).to_le_bytes());
            segment.extend_from_slice(&(entry.payload.len() as u64).to_le_bytes());
            append_xp3_chunk(&mut file, b"segm", &segment);
            append_xp3_chunk(&mut file, b"adlr", &entry.adler32.to_le_bytes());
            append_xp3_chunk(&mut index, b"File", &file);
        }

        bytes.push(0);
        bytes.extend_from_slice(&(index.len() as u64).to_le_bytes());
        bytes.extend_from_slice(&index);
        bytes[XP3_PLAIN_MAGIC.len()..XP3_PLAIN_MAGIC.len() + 8]
            .copy_from_slice(&index_offset.to_le_bytes());
        bytes
    }

    fn append_xp3_chunk(output: &mut Vec<u8>, name: &[u8; 4], content: &[u8]) {
        output.extend_from_slice(name);
        output.extend_from_slice(&(content.len() as u64).to_le_bytes());
        output.extend_from_slice(content);
    }

    fn run_cli(args: &[&str]) {
        run_with_args(args.iter().map(|arg| arg.to_string()).collect()).unwrap();
    }

    fn run_cli_with_registry(args: &[&str], registry: &AdapterRegistry) {
        run_cli_with_registry_result(args, registry).unwrap();
    }

    fn run_cli_with_registry_result(
        args: &[&str],
        registry: &AdapterRegistry,
    ) -> Result<(), Box<dyn std::error::Error>> {
        run_with_args_and_registry(args.iter().map(|arg| arg.to_string()).collect(), registry)
    }

    #[test]
    fn helper_result_validate_command_accepts_public_fixture() {
        let root = temp_dir("helper-result-valid");
        let output = root.join("helper-result-report.json");
        let fixture = public_fixture_path("fixtures/public/kaifuu-helper-results/success.json");

        run_cli(&[
            "helper-result",
            "validate",
            fixture.to_str().unwrap(),
            "--output",
            output.to_str().unwrap(),
        ]);

        let report: serde_json::Value = read_json(&output).unwrap();
        assert_eq!(report["status"], "passed");
        assert_eq!(report["fixtureId"], "kaifuu-helper-success");
        assert_eq!(report["failures"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn key_helper_validate_command_writes_normalized_helper_result_contract() {
        let root = temp_dir("key-helper-valid");
        let output = root.join("normalized-helper-result.json");
        let fixture = public_fixture_path(
            "fixtures/public/kaifuu-helper-results/key-helper/manual-entry.json",
        );

        run_cli(&[
            "key-helper",
            "validate",
            "--fixture",
            fixture.to_str().unwrap(),
            "--output",
            output.to_str().unwrap(),
        ]);

        let result: serde_json::Value = read_json(&output).unwrap();
        assert_eq!(result["fixtureId"], "kaifuu-key-helper-manual-entry");
        assert_eq!(result["helper"]["helperKind"], "manualKeyEntry");
        assert_eq!(result["capabilityLevel"], "manualEntry");
        assert_eq!(result["execution"]["mode"], "notExecuted");
        assert_eq!(result["execution"]["bounded"], true);
        let serialized = fs::read_to_string(&output).unwrap();
        assert!(!serialized.contains("rawKey"));
        assert!(!serialized.contains("keyMaterial"));
        assert!(!serialized.contains("command"));
    }

    #[test]
    fn key_helper_validate_command_rejects_arbitrary_command_metadata() {
        let root = temp_dir("key-helper-invalid");
        let output = root.join("key-helper-report.json");
        let fixture = public_fixture_path(
            "fixtures/public/kaifuu-helper-results/invalid/execution-command-field.json",
        );

        let result = run_with_args(vec![
            "key-helper".to_string(),
            "validate".to_string(),
            "--fixture".to_string(),
            fixture.to_str().unwrap().to_string(),
            "--output".to_string(),
            output.to_str().unwrap().to_string(),
        ]);

        assert!(result.is_err());
        let report: serde_json::Value = read_json(&output).unwrap();
        assert_eq!(report["status"], "failed");
        assert!(
            report["failures"]
                .as_array()
                .unwrap()
                .iter()
                .any(|failure| failure["field"] == "execution.command"
                    && failure["code"] == "forbidden_helper_execution_field")
        );
        let serialized = fs::read_to_string(&output).unwrap();
        assert!(!serialized.contains("fixture-helper --dump"));
    }

    #[test]
    fn key_helper_validate_command_rejects_top_level_command_metadata() {
        let root = temp_dir("key-helper-top-level-command-invalid");
        let fixture = root.join("top-level-command.json");
        let output = root.join("key-helper-report.json");
        let mut value: serde_json::Value = read_json(&public_fixture_path(
            "fixtures/public/kaifuu-helper-results/key-helper/static-parser.json",
        ))
        .unwrap();
        value.as_object_mut().unwrap().insert(
            "command".to_string(),
            serde_json::json!("fixture-helper --dump-private-state"),
        );
        write_json(&fixture, &value).unwrap();

        let result = run_with_args(vec![
            "key-helper".to_string(),
            "validate".to_string(),
            "--fixture".to_string(),
            fixture.to_str().unwrap().to_string(),
            "--output".to_string(),
            output.to_str().unwrap().to_string(),
        ]);

        assert!(result.is_err());
        let report: serde_json::Value = read_json(&output).unwrap();
        assert_eq!(report["status"], "failed");
        assert!(
            report["failures"]
                .as_array()
                .unwrap()
                .iter()
                .any(|failure| failure["field"] == "command"
                    && failure["code"] == "forbidden_helper_metadata_field")
        );
        let serialized = fs::read_to_string(&output).unwrap();
        assert!(!serialized.contains("dump-private-state"));
    }

    #[test]
    fn key_helper_validate_command_rejects_static_parser_remote_overclaim() {
        let root = temp_dir("key-helper-static-remote-overclaim-invalid");
        let fixture = root.join("static-remote-overclaim.json");
        let output = root.join("key-helper-report.json");
        let mut value: serde_json::Value = read_json(&public_fixture_path(
            "fixtures/public/kaifuu-helper-results/key-helper/static-parser.json",
        ))
        .unwrap();
        value["capabilityLevel"] = serde_json::json!("remoteWindows");
        value["execution"]["mode"] = serde_json::json!("remoteHelper");
        write_json(&fixture, &value).unwrap();

        let result = run_with_args(vec![
            "key-helper".to_string(),
            "validate".to_string(),
            "--fixture".to_string(),
            fixture.to_str().unwrap().to_string(),
            "--output".to_string(),
            output.to_str().unwrap().to_string(),
        ]);

        assert!(result.is_err());
        let report: serde_json::Value = read_json(&output).unwrap();
        assert_eq!(report["status"], "failed");
        assert!(
            report["failures"]
                .as_array()
                .unwrap()
                .iter()
                .any(|failure| failure["field"] == "helper"
                    && failure["code"] == "invalid_helper_semantics")
        );
    }

    #[cfg(unix)]
    #[test]
    fn key_helper_run_process_redacts_stdout_and_stderr() {
        let root = temp_dir("key-helper-run-process-redaction");
        let helper = root.join("helper-stub");
        let output = root.join("process-report.json");
        write_executable_stub(
            &helper,
            r#"#!/bin/sh
printf 'public-ok 00112233445566778899aabbccddeeff /home/dev/private-game\n'
printf 'stderr C:\Users\Dev\SecretGame\n' >&2
"#,
        );
        let registry = write_process_helper_registry_entry(&root, &helper);

        let mut args = vec!["key-helper".to_string(), "run-process".to_string()];
        args.extend(allowlisted_process_args(&registry, &helper));
        args.extend([
            "--timeout-ms".to_string(),
            "1000".to_string(),
            "--output".to_string(),
            output.to_str().unwrap().to_string(),
        ]);
        run_with_args(args).unwrap();

        let report: serde_json::Value = read_json(&output).unwrap();
        assert_eq!(report["status"], "passed");
        assert_eq!(report["diagnostic"]["code"], "success");
        assert_eq!(report["execution"]["bounded"], true);
        assert_eq!(report["execution"]["networkAccess"], true);
        assert_eq!(report["execution"]["filesystemAccess"], "hostInherited");
        assert!(report["stdout"]["byteCount"].as_u64().unwrap() > 0);
        assert_eq!(
            report["stdout"]["redactedText"],
            "[REDACTED:kaifuu.secret_redacted]"
        );
        assert_eq!(
            report["stderr"]["redactedText"],
            "[REDACTED:kaifuu.secret_redacted]"
        );
        let serialized = fs::read_to_string(&output).unwrap();
        for forbidden in [
            "00112233445566778899aabbccddeeff",
            "/home/dev/private-game",
            "C:\\Users\\Dev\\SecretGame",
            helper.to_str().unwrap(),
        ] {
            assert!(!serialized.contains(forbidden), "{forbidden} leaked");
        }
    }

    #[cfg(unix)]
    #[test]
    fn key_helper_run_process_rejects_hash_mismatch_before_launch() {
        let root = temp_dir("key-helper-run-process-allowlist-hash");
        let helper = root.join("helper-stub");
        let marker = root.join("launched-marker");
        let output = root.join("process-report.json");
        write_executable_stub(
            &helper,
            &format!(
                r#"#!/bin/sh
printf launched > '{}'
"#,
                marker.display()
            ),
        );
        let registry = write_process_helper_registry_entry(&root, &helper);
        let mut registry_value: serde_json::Value = read_json(&registry).unwrap();
        registry_value["binaryAllowlist"]["entries"][0]["sha256Hash"] = serde_json::json!(
            "sha256:0000000000000000000000000000000000000000000000000000000000000000"
        );
        fs::write(
            &registry,
            serde_json::to_string_pretty(&registry_value).unwrap(),
        )
        .unwrap();

        let mut args = vec!["key-helper".to_string(), "run-process".to_string()];
        args.extend(allowlisted_process_args(&registry, &helper));
        args.extend([
            "--timeout-ms".to_string(),
            "1000".to_string(),
            "--output".to_string(),
            output.to_str().unwrap().to_string(),
        ]);
        let result = run_with_args(args);

        assert!(result.is_err());
        assert!(!marker.exists(), "helper launched before allowlist gate");
        let report: serde_json::Value = read_json(&output).unwrap();
        assert_eq!(report["status"], "failed");
        assert!(
            report["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|diagnostic| diagnostic["code"]
                    == kaifuu_core::SEMANTIC_HELPER_ALLOWLIST_HASH_MISMATCH)
        );
        let serialized = fs::read_to_string(&output).unwrap();
        assert!(!serialized.contains(marker.to_str().unwrap()));
        assert!(!serialized.contains(helper.to_str().unwrap()));
    }

    #[cfg(unix)]
    #[test]
    fn key_helper_run_process_disallowed_policy_blocks_launch() {
        let root = temp_dir("key-helper-run-process-disallowed-policy");
        let helper = root.join("helper-stub");
        let marker = root.join("launched-marker");
        let output = root.join("process-report.json");
        write_executable_stub(
            &helper,
            &format!(
                r#"#!/bin/sh
printf launched > '{}'
"#,
                marker.display()
            ),
        );
        let registry = write_process_helper_registry_entry(&root, &helper);
        let mut registry_value: serde_json::Value = read_json(&registry).unwrap();
        registry_value["executionPolicy"]["mode"] = serde_json::json!("disallowed");
        fs::write(
            &registry,
            serde_json::to_string_pretty(&registry_value).unwrap(),
        )
        .unwrap();

        let mut args = vec!["key-helper".to_string(), "run-process".to_string()];
        args.extend(allowlisted_process_args(&registry, &helper));
        args.extend([
            "--timeout-ms".to_string(),
            "1000".to_string(),
            "--output".to_string(),
            output.to_str().unwrap().to_string(),
        ]);
        let result = run_with_args(args);

        assert!(result.is_err());
        assert!(
            !marker.exists(),
            "helper launched despite disallowed policy"
        );
        let report: serde_json::Value = read_json(&output).unwrap();
        assert_eq!(report["status"], "failed");
        assert_eq!(report["observedHash"], serde_json::Value::Null);
        assert!(
            report["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|diagnostic| diagnostic["code"]
                    == kaifuu_core::SEMANTIC_HELPER_EXECUTION_DISALLOWED
                    && diagnostic["field"] == "executionPolicy.mode")
        );
        let serialized = fs::read_to_string(&output).unwrap();
        assert!(!serialized.contains(marker.to_str().unwrap()));
        assert!(!serialized.contains(helper.to_str().unwrap()));
    }

    #[cfg(unix)]
    #[test]
    fn key_helper_run_process_fixture_policy_blocks_before_allowlist() {
        let root = temp_dir("key-helper-run-process-fixture-policy");
        let helper = root.join("helper-stub");
        let marker = root.join("launched-marker");
        let output = root.join("process-report.json");
        write_executable_stub(
            &helper,
            &format!(
                r#"#!/bin/sh
printf launched > '{}'
"#,
                marker.display()
            ),
        );
        let registry = write_process_helper_registry_entry(&root, &helper);
        let mut registry_value: serde_json::Value = read_json(&registry).unwrap();
        registry_value["executionPolicy"]["mode"] = serde_json::json!("fixture_in_process");
        registry_value["binaryAllowlist"]["entries"][0]["sha256Hash"] = serde_json::json!(
            "sha256:0000000000000000000000000000000000000000000000000000000000000000"
        );
        fs::write(
            &registry,
            serde_json::to_string_pretty(&registry_value).unwrap(),
        )
        .unwrap();

        let mut args = vec!["key-helper".to_string(), "run-process".to_string()];
        args.extend(allowlisted_process_args(&registry, &helper));
        args.extend([
            "--timeout-ms".to_string(),
            "1000".to_string(),
            "--output".to_string(),
            output.to_str().unwrap().to_string(),
        ]);
        let result = run_with_args(args);

        assert!(result.is_err());
        assert!(
            !marker.exists(),
            "helper launched despite fixture-in-process policy"
        );
        let report: serde_json::Value = read_json(&output).unwrap();
        assert_eq!(report["status"], "failed");
        assert_eq!(report["observedHash"], serde_json::Value::Null);
        assert!(
            report["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|diagnostic| diagnostic["code"]
                    == kaifuu_core::SEMANTIC_HELPER_EXECUTION_DISALLOWED
                    && diagnostic["field"] == "executionPolicy.mode")
        );
        let serialized = fs::read_to_string(&output).unwrap();
        assert!(!serialized.contains(marker.to_str().unwrap()));
        assert!(!serialized.contains(helper.to_str().unwrap()));
        assert!(!serialized.contains(kaifuu_core::SEMANTIC_HELPER_ALLOWLIST_HASH_MISMATCH));
    }

    #[cfg(unix)]
    #[test]
    fn key_helper_run_process_output_overflow_is_failure() {
        let root = temp_dir("key-helper-run-process-output-overflow");
        let helper = root.join("helper-stub");
        let output = root.join("process-report.json");
        write_executable_stub(
            &helper,
            r#"#!/bin/sh
yes A | head -c 70000
"#,
        );
        let registry = write_process_helper_registry_entry(&root, &helper);

        let mut args = vec!["key-helper".to_string(), "run-process".to_string()];
        args.extend(allowlisted_process_args(&registry, &helper));
        args.extend([
            "--timeout-ms".to_string(),
            "1000".to_string(),
            "--output".to_string(),
            output.to_str().unwrap().to_string(),
        ]);
        let result = run_with_args(args);

        assert!(result.is_err());
        let report: serde_json::Value = read_json(&output).unwrap();
        assert_eq!(report["status"], "failed");
        assert_eq!(
            report["diagnostic"]["code"],
            kaifuu_core::SEMANTIC_HELPER_OUTPUT_OVERFLOW
        );
        assert_eq!(report["stdout"]["truncated"], true);
        assert!(
            report["stdout"]["byteCount"].as_u64().unwrap()
                > report["stdout"]["capturedByteCount"].as_u64().unwrap()
        );
        let serialized = fs::read_to_string(&output).unwrap();
        assert!(!serialized.contains(helper.to_str().unwrap()));
    }

    #[cfg(unix)]
    #[test]
    fn key_helper_run_process_registry_policy_bounds_timeout() {
        let root = temp_dir("key-helper-run-process-policy-timeout");
        let helper = root.join("helper-stub");
        let output = root.join("process-report.json");
        write_executable_stub(
            &helper,
            r#"#!/bin/sh
sleep 2
"#,
        );
        let registry = write_process_helper_registry_entry(&root, &helper);
        let mut registry_value: serde_json::Value = read_json(&registry).unwrap();
        registry_value["executionPolicy"]["maxRuntimeSeconds"] = serde_json::json!(1);
        fs::write(
            &registry,
            serde_json::to_string_pretty(&registry_value).unwrap(),
        )
        .unwrap();

        let mut args = vec!["key-helper".to_string(), "run-process".to_string()];
        args.extend(allowlisted_process_args(&registry, &helper));
        args.extend([
            "--timeout-ms".to_string(),
            "5000".to_string(),
            "--output".to_string(),
            output.to_str().unwrap().to_string(),
        ]);
        let result = run_with_args(args);

        assert!(result.is_err());
        let report: serde_json::Value = read_json(&output).unwrap();
        assert_eq!(report["status"], "failed");
        assert_eq!(
            report["diagnostic"]["code"],
            kaifuu_core::SEMANTIC_HELPER_TIMEOUT
        );
        assert_eq!(report["execution"]["timeoutMs"], 1000);
        assert_eq!(report["timedOut"], true);
        let serialized = fs::read_to_string(&output).unwrap();
        assert!(!serialized.contains(helper.to_str().unwrap()));
    }

    #[cfg(unix)]
    #[test]
    fn key_helper_run_process_timeout_kills_process_group() {
        let root = temp_dir("key-helper-run-process-timeout");
        let helper = root.join("helper-stub");
        let marker = root.join("leaked-marker");
        let output = root.join("process-report.json");
        write_executable_stub(
            &helper,
            &format!(
                r#"#!/bin/sh
(sleep 1; printf leaked > '{}') &
wait
"#,
                marker.display()
            ),
        );
        let registry = write_process_helper_registry_entry(&root, &helper);

        let mut args = vec!["key-helper".to_string(), "run-process".to_string()];
        args.extend(allowlisted_process_args(&registry, &helper));
        args.extend([
            "--timeout-ms".to_string(),
            "50".to_string(),
            "--output".to_string(),
            output.to_str().unwrap().to_string(),
        ]);
        let result = run_with_args(args);

        assert!(result.is_err());
        std::thread::sleep(std::time::Duration::from_millis(1200));
        assert!(
            !marker.exists(),
            "helper child process escaped timeout cleanup"
        );
        let report: serde_json::Value = read_json(&output).unwrap();
        assert_eq!(report["status"], "failed");
        assert_eq!(
            report["diagnostic"]["code"],
            kaifuu_core::SEMANTIC_HELPER_TIMEOUT
        );
        assert_eq!(report["timedOut"], true);
        assert_eq!(report["terminated"], true);
        let serialized = fs::read_to_string(&output).unwrap();
        assert!(!serialized.contains(marker.to_str().unwrap()));
        assert!(!serialized.contains(helper.to_str().unwrap()));
    }

    #[cfg(unix)]
    #[test]
    fn key_helper_run_process_cancel_kills_process_group() {
        let root = temp_dir("key-helper-run-process-cancel");
        let helper = root.join("helper-stub");
        let marker = root.join("cancel-leaked-marker");
        let output = root.join("process-report.json");
        write_executable_stub(
            &helper,
            &format!(
                r#"#!/bin/sh
(sleep 1; printf leaked > '{}') &
wait
"#,
                marker.display()
            ),
        );
        let registry = write_process_helper_registry_entry(&root, &helper);

        let mut args = vec!["key-helper".to_string(), "run-process".to_string()];
        args.extend(allowlisted_process_args(&registry, &helper));
        args.extend([
            "--timeout-ms".to_string(),
            "5000".to_string(),
            "--cancel-after-ms".to_string(),
            "50".to_string(),
            "--output".to_string(),
            output.to_str().unwrap().to_string(),
        ]);
        let result = run_with_args(args);

        assert!(result.is_err());
        std::thread::sleep(std::time::Duration::from_millis(1200));
        assert!(
            !marker.exists(),
            "helper child process escaped cancel cleanup"
        );
        let report: serde_json::Value = read_json(&output).unwrap();
        assert_eq!(report["status"], "failed");
        assert_eq!(
            report["diagnostic"]["code"],
            kaifuu_core::SEMANTIC_HELPER_CANCELLED
        );
        assert_eq!(report["cancelled"], true);
        assert_eq!(report["terminated"], true);
        let serialized = fs::read_to_string(&output).unwrap();
        assert!(!serialized.contains(marker.to_str().unwrap()));
        assert!(!serialized.contains(helper.to_str().unwrap()));
    }

    #[test]
    fn helper_registry_validate_command_accepts_public_fixture() {
        let root = temp_dir("helper-registry-valid");
        let output = root.join("helper-registry-report.json");
        let fixture = public_fixture_path(
            "fixtures/public/kaifuu-helper-results/helper-registry/valid-helper.json",
        );

        run_cli(&[
            "helper-registry",
            "validate",
            fixture.to_str().unwrap(),
            "--output",
            output.to_str().unwrap(),
        ]);

        let report: serde_json::Value = read_json(&output).unwrap();
        assert_eq!(report["status"], "passed");
        assert_eq!(report["helperId"], kaifuu_core::FIXTURE_HELPER_REGISTRY_ID);
        assert_eq!(report["diagnostics"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn helper_registry_validate_command_rejects_invalid_fixtures() {
        let cases = [
            (
                "missing-capability",
                kaifuu_core::SEMANTIC_HELPER_REGISTRY_MISSING_CAPABILITY,
            ),
            (
                "bad-schema-id",
                kaifuu_core::SEMANTIC_HELPER_REGISTRY_UNSUPPORTED_SCHEMA_ID,
            ),
            (
                "unsupported-redaction-class",
                kaifuu_core::SEMANTIC_HELPER_REGISTRY_INVALID_REDACTION_CLASS,
            ),
        ];

        for (fixture_name, expected_code) in cases {
            let root = temp_dir(&format!("helper-registry-invalid-{fixture_name}"));
            let output = root.join("helper-registry-report.json");
            let fixture = public_fixture_path(&format!(
                "fixtures/public/kaifuu-helper-results/helper-registry/{fixture_name}.json",
            ));

            let result = run_with_args(vec![
                "helper-registry".to_string(),
                "validate".to_string(),
                fixture.to_str().unwrap().to_string(),
                "--output".to_string(),
                output.to_str().unwrap().to_string(),
            ]);

            assert!(result.is_err());
            let report: serde_json::Value = read_json(&output).unwrap();
            assert_eq!(report["status"], "failed");
            assert!(
                report["diagnostics"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|diagnostic| diagnostic["code"] == expected_code)
            );
        }
    }

    #[test]
    fn helper_registry_invoke_fixture_stub_command_uses_registry_boundary() {
        let root = temp_dir("helper-registry-invoke");
        let output = root.join("helper-result.json");

        run_cli(&[
            "helper-registry",
            "invoke-fixture-stub",
            "--output",
            output.to_str().unwrap(),
        ]);

        let result: serde_json::Value = read_json(&output).unwrap();
        assert_eq!(result["fixtureId"], "kaifuu-helper-registry-stub");
        assert_eq!(
            result["helper"]["helperId"],
            kaifuu_core::FIXTURE_HELPER_REGISTRY_ID
        );
        assert_eq!(result["diagnostic"]["code"], "success");
    }

    #[test]
    fn helper_registry_invoke_fixture_stub_accepts_siglus_key_validation_request() {
        let root = temp_dir("helper-registry-invoke-siglus-request");
        let output = root.join("helper-result.json");
        let request = public_fixture_path(
            "fixtures/public/kaifuu-helper-results/helper-request/siglus-secondary-key-request.json",
        );

        run_cli(&[
            "helper-registry",
            "invoke-fixture-stub",
            "--input",
            request.to_str().unwrap(),
            "--output",
            output.to_str().unwrap(),
        ]);

        let result: serde_json::Value = read_json(&output).unwrap();
        let expected: serde_json::Value = read_json(&public_fixture_path(
            "fixtures/public/kaifuu-helper-results/siglus-secondary-key-helper-boundary-success.json",
        ))
        .unwrap();
        assert_eq!(result, expected);
        assert_eq!(
            result["helper"]["helperId"],
            kaifuu_core::FIXTURE_HELPER_REGISTRY_ID
        );
        assert_eq!(result["diagnostic"]["code"], "success");
        let serialized = fs::read_to_string(&output).unwrap();
        for forbidden in [
            "rawKey",
            "keyMaterial",
            "00112233445566778899aabbccddeeff",
            "decrypted script",
            "/home/",
            "C:\\",
        ] {
            assert!(!serialized.contains(forbidden), "leaked {forbidden}");
        }
    }

    #[test]
    fn helper_registry_invoke_fixture_stub_rejects_siglus_request_missing_redaction_expectation() {
        let root = temp_dir("helper-registry-invoke-siglus-request-missing-redaction");
        let input = root.join("helper-request.json");
        let output = root.join("helper-result.json");
        let mut request: serde_json::Value = read_json(&public_fixture_path(
            "fixtures/public/kaifuu-helper-results/helper-request/siglus-secondary-key-request.json",
        ))
        .unwrap();
        request
            .as_object_mut()
            .unwrap()
            .remove("expectedRedactedLogHash");
        fs::write(&input, serde_json::to_string_pretty(&request).unwrap()).unwrap();

        run_cli(&[
            "helper-registry",
            "invoke-fixture-stub",
            "--input",
            input.to_str().unwrap(),
            "--output",
            output.to_str().unwrap(),
        ]);

        let result: serde_json::Value = read_json(&output).unwrap();
        assert_eq!(result["diagnostic"]["code"], "redaction_failure");
        assert_eq!(
            result["diagnostic"]["message"],
            kaifuu_core::SEMANTIC_HELPER_REQUEST_MISSING_REDACTED_OUTPUT_EXPECTATION
        );
        assert_eq!(result["redaction"]["status"], "failed");
        assert_eq!(result["secretRefs"], serde_json::json!([]));
        let serialized = fs::read_to_string(&output).unwrap();
        for forbidden in [
            "rawKey",
            "keyMaterial",
            "00112233445566778899aabbccddeeff",
            "fixture-only-siglus-secondary-key-v1",
            "decrypted script",
            "/home/",
            "C:\\",
        ] {
            assert!(!serialized.contains(forbidden), "leaked {forbidden}");
        }
    }

    #[test]
    fn helper_registry_invoke_fixture_stub_rejects_siglus_key_refs_without_redaction_expectation() {
        let root = temp_dir("helper-registry-invoke-siglus-request-no-required-redaction");
        let input = root.join("helper-request.json");
        let output = root.join("helper-result.json");
        let mut request: serde_json::Value = read_json(&public_fixture_path(
            "fixtures/public/kaifuu-helper-results/helper-request/siglus-secondary-key-request.json",
        ))
        .unwrap();
        let request_object = request.as_object_mut().unwrap();
        request_object.remove("expectedRedactedLogHash");
        request_object.remove("requiredKeyRefs");
        fs::write(&input, serde_json::to_string_pretty(&request).unwrap()).unwrap();

        run_cli(&[
            "helper-registry",
            "invoke-fixture-stub",
            "--input",
            input.to_str().unwrap(),
            "--output",
            output.to_str().unwrap(),
        ]);

        let result: serde_json::Value = read_json(&output).unwrap();
        assert_eq!(result["diagnostic"]["code"], "redaction_failure");
        assert_eq!(
            result["diagnostic"]["message"],
            kaifuu_core::SEMANTIC_HELPER_REQUEST_MISSING_REDACTED_OUTPUT_EXPECTATION
        );
        assert_eq!(result["redaction"]["status"], "failed");
        assert_eq!(result["secretRefs"], serde_json::json!([]));
        let serialized = fs::read_to_string(&output).unwrap();
        for forbidden in [
            "rawKey",
            "keyMaterial",
            "00112233445566778899aabbccddeeff",
            "fixture-only-siglus-secondary-key-v1",
            "decrypted script",
            "/home/",
            "C:\\",
        ] {
            assert!(!serialized.contains(forbidden), "leaked {forbidden}");
        }
    }

    #[test]
    fn key_import_command_writes_local_secret_and_hash_only_report() {
        let root = temp_dir("key-import-command");
        let secret_store = root.join("secrets.local");
        let output = root.join("key-import-report.json");

        run_cli(&[
            "key",
            "import",
            "--secret-store",
            secret_store.to_str().unwrap(),
            "--secret-ref",
            "local-secret:fixture/siglus/manual-secondary-key",
            "--purpose",
            "siglus-secondary-key",
            "--engine-profile-id",
            "019ed000-0000-7000-8000-profile00087",
            "--source-hash",
            "sha256:2222222222222222222222222222222222222222222222222222222222222222",
            "--key-hex",
            "000102030405060708090a0b0c0d0e0f",
            "--output",
            output.to_str().unwrap(),
        ]);

        let report: serde_json::Value = read_json(&output).unwrap();
        assert_eq!(
            report["secretRef"],
            "local-secret:fixture/siglus/manual-secondary-key"
        );
        assert_eq!(report["keyPurpose"], "siglus-secondary-key");
        assert_eq!(
            report["engineProfileId"],
            "019ed000-0000-7000-8000-profile00087"
        );
        assert_eq!(report["redactionStatus"], "redacted");
        assert_eq!(report["materialBytes"], 16);
        assert!(
            report["materialHash"]
                .as_str()
                .unwrap()
                .starts_with("sha256:")
        );
        assert_eq!(
            fs::read(secret_store.join("fixture/siglus/manual-secondary-key")).unwrap(),
            (0_u8..16).collect::<Vec<_>>()
        );
        let serialized = fs::read_to_string(&output).unwrap();
        assert!(!serialized.contains("000102030405060708090a0b0c0d0e0f"));
        assert!(!serialized.contains("rawKey"));
        assert!(!serialized.contains("keyMaterial"));
    }

    #[test]
    fn helper_registry_check_binary_reports_allowlist_diagnostics() {
        let fixture = public_fixture_path(
            "fixtures/public/kaifuu-helper-results/helper-registry/valid-helper.json",
        );
        let allowed_binary = public_fixture_path(
            "fixtures/public/kaifuu-helper-results/helper-binaries/kaifuu-fixture-helper",
        );
        let root = temp_dir("helper-registry-check-binary-allowed");
        let output = root.join("helper-binary-report.json");

        run_cli(&[
            "helper-registry",
            "check-binary",
            fixture.to_str().unwrap(),
            "--helper-binary",
            allowed_binary.to_str().unwrap(),
            "--allowlist-entry-id",
            kaifuu_core::FIXTURE_HELPER_ALLOWLIST_REF_ID,
            "--platform",
            "fixture-any",
            "--helper-version",
            "0.1.0",
            "--capability",
            "fixture_invocation",
            "--output",
            output.to_str().unwrap(),
        ]);

        let report: serde_json::Value = read_json(&output).unwrap();
        assert_eq!(report["status"], "passed");
        assert_eq!(report["helperId"], kaifuu_core::FIXTURE_HELPER_REGISTRY_ID);
        assert_eq!(
            report["allowlistEntryId"],
            kaifuu_core::FIXTURE_HELPER_ALLOWLIST_REF_ID
        );
        assert_eq!(
            report["observedHash"],
            "sha256:c1ac7473395cf2fbb823d33c63b5b4810352e3d2c255833498ba4fc4efb29f7c"
        );

        let mismatch_binary = public_fixture_path(
            "fixtures/public/kaifuu-helper-results/helper-binaries/kaifuu-fixture-helper-mismatch",
        );
        let cases = [
            (
                "missing",
                fixture.clone(),
                public_fixture_path(
                    "fixtures/public/kaifuu-helper-results/helper-binaries/missing-helper",
                ),
                "fixture-any",
                "0.1.0",
                "fixture_invocation",
                kaifuu_core::SEMANTIC_HELPER_ALLOWLIST_MISSING_BINARY,
            ),
            (
                "mismatched",
                fixture.clone(),
                mismatch_binary,
                "fixture-any",
                "0.1.0",
                "fixture_invocation",
                kaifuu_core::SEMANTIC_HELPER_ALLOWLIST_HASH_MISMATCH,
            ),
            (
                "wrong-platform",
                public_fixture_path(
                    "fixtures/public/kaifuu-helper-results/helper-registry/allowlist-wrong-platform.json",
                ),
                allowed_binary.clone(),
                "fixture-any",
                "0.1.0",
                "fixture_invocation",
                kaifuu_core::SEMANTIC_HELPER_ALLOWLIST_WRONG_PLATFORM,
            ),
            (
                "stale-version",
                public_fixture_path(
                    "fixtures/public/kaifuu-helper-results/helper-registry/allowlist-stale-version.json",
                ),
                allowed_binary.clone(),
                "fixture-any",
                "0.1.0",
                "fixture_invocation",
                kaifuu_core::SEMANTIC_HELPER_ALLOWLIST_STALE_VERSION,
            ),
            (
                "undeclared-capability",
                public_fixture_path(
                    "fixtures/public/kaifuu-helper-results/helper-registry/allowlist-missing-declared-capability.json",
                ),
                allowed_binary.clone(),
                "fixture-any",
                "0.1.0",
                "key_discovery",
                kaifuu_core::SEMANTIC_HELPER_ALLOWLIST_UNDECLARED_CAPABILITY,
            ),
        ];

        for (
            name,
            registry_fixture,
            helper_binary,
            platform,
            helper_version,
            capability,
            expected_code,
        ) in cases
        {
            let root = temp_dir(&format!("helper-registry-check-binary-{name}"));
            let output = root.join("helper-binary-report.json");
            let result = run_with_args(vec![
                "helper-registry".to_string(),
                "check-binary".to_string(),
                registry_fixture.to_str().unwrap().to_string(),
                "--helper-binary".to_string(),
                helper_binary.to_str().unwrap().to_string(),
                "--allowlist-entry-id".to_string(),
                kaifuu_core::FIXTURE_HELPER_ALLOWLIST_REF_ID.to_string(),
                "--platform".to_string(),
                platform.to_string(),
                "--helper-version".to_string(),
                helper_version.to_string(),
                "--capability".to_string(),
                capability.to_string(),
                "--output".to_string(),
                output.to_str().unwrap().to_string(),
            ]);

            assert!(result.is_err(), "{name} unexpectedly passed");
            let report: serde_json::Value = read_json(&output).unwrap();
            assert_eq!(report["status"], "failed");
            assert_eq!(report["helperId"], kaifuu_core::FIXTURE_HELPER_REGISTRY_ID);
            assert_eq!(
                report["allowlistEntryId"],
                kaifuu_core::FIXTURE_HELPER_ALLOWLIST_REF_ID
            );
            assert_eq!(report["platform"], platform);
            if name == "mismatched" {
                let observed_hash = report["observedHash"]
                    .as_str()
                    .expect("mismatched helper should report top-level observedHash");
                assert!(
                    observed_hash.starts_with("sha256:")
                        && observed_hash.len() == 71
                        && observed_hash["sha256:".len()..]
                            .chars()
                            .all(|character| character.is_ascii_hexdigit()
                                && !character.is_ascii_uppercase()),
                    "{name}: observedHash is not canonical: {report:#?}"
                );
                assert!(
                    report["diagnostics"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|diagnostic| {
                            diagnostic["code"] == expected_code
                                && diagnostic["observedHash"].as_str() == Some(observed_hash)
                        }),
                    "{name}: diagnostic did not preserve observedHash: {report:#?}"
                );
            }
            assert!(
                report["diagnostics"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|diagnostic| {
                        diagnostic["code"] == expected_code
                            && diagnostic["helperId"] == kaifuu_core::FIXTURE_HELPER_REGISTRY_ID
                            && diagnostic["allowlistEntryId"]
                                == kaifuu_core::FIXTURE_HELPER_ALLOWLIST_REF_ID
                            && diagnostic["platform"] == platform
                            && diagnostic["remediationCode"]
                                .as_str()
                                .is_some_and(|code| !code.is_empty())
                    }),
                "{name}: {report:#?}"
            );
        }
    }

    #[test]
    fn helper_result_validate_command_rejects_raw_secret_ref_path_component() {
        let root = temp_dir("helper-result-invalid-path-component");
        let output = root.join("helper-result-report.json");
        let fixture = public_fixture_path(
            "fixtures/public/kaifuu-helper-results/invalid/raw-base64url-path-component-secret-ref.json",
        );

        let result = run_with_args(vec![
            "helper-result".to_string(),
            "validate".to_string(),
            fixture.to_str().unwrap().to_string(),
            "--output".to_string(),
            output.to_str().unwrap().to_string(),
        ]);

        assert!(result.is_err());
        let report: serde_json::Value = read_json(&output).unwrap();
        assert_eq!(report["status"], "failed");
        assert_eq!(
            report["fixtureId"],
            "kaifuu-helper-invalid-encoded-path-component-ref"
        );
        assert!(
            report["failures"]
                .as_array()
                .unwrap()
                .iter()
                .any(|failure| {
                    failure["fixtureId"] == "kaifuu-helper-invalid-encoded-path-component-ref"
                        && failure["field"] == "secretRefs.0.secretRef"
                })
        );
        let serialized = fs::read_to_string(&output).unwrap();
        assert!(!serialized.contains("mP9xZpQ2rS7vLj4N8aW_KtYd0hF3uC6b"));
    }

    #[test]
    fn helper_result_validate_command_reports_redacted_field_and_fixture_id() {
        let root = temp_dir("helper-result-invalid");
        let helper_result_path = root.join("helper-result.json");
        let output = root.join("helper-result-report.json");
        fs::write(
            &helper_result_path,
            r#"{
  "schemaVersion": "0.1.0",
  "fixtureId": "kaifuu-helper-invalid-redaction",
  "helperResultId": "helper-result-invalid-redaction",
  "profileId": "019ed000-0000-7000-8000-profile00085",
  "helper": {
    "helperId": "kaifuu.fixture.static-parser",
    "helperVersion": "0.1.0",
    "helperKind": "staticParser"
  },
  "diagnostic": {
    "code": "success",
    "message": "helper output referenced path=/home/dev/private/key.bin"
  },
  "redaction": {
    "status": "redacted",
    "redactedLogHash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "secretRefs": [
    {
      "requirementId": "siglus-secondary-key",
      "secretRef": "local-secret:fixture/siglus/secondary-key",
      "materialKind": "fixedBytes",
      "bytes": 16
    }
  ],
  "proofHashes": []
}
"#,
        )
        .unwrap();

        let result = run_with_args(vec![
            "helper-result".to_string(),
            "validate".to_string(),
            helper_result_path.to_str().unwrap().to_string(),
            "--output".to_string(),
            output.to_str().unwrap().to_string(),
        ]);

        assert!(result.is_err());
        let report: serde_json::Value = read_json(&output).unwrap();
        assert_eq!(report["status"], "failed");
        assert_eq!(report["fixtureId"], "kaifuu-helper-invalid-redaction");
        assert!(
            report["failures"]
                .as_array()
                .unwrap()
                .iter()
                .any(|failure| {
                    failure["fixtureId"] == "kaifuu-helper-invalid-redaction"
                        && failure["field"] == "diagnostic.message"
                })
        );
        let serialized = fs::read_to_string(&output).unwrap();
        assert!(!serialized.contains("/home/dev"));
        assert!(!serialized.contains("key.bin"));
    }

    #[test]
    fn offset_map_validate_command_accepts_valid_fixture() {
        let root = temp_dir("offset-map-valid");
        let output = root.join("offset-map-report.json");
        let fixture = core_fixture_path("fixtures/offset-map/shift-jis.json");

        run_cli(&[
            "offset-map",
            "validate",
            fixture.to_str().unwrap(),
            "--output",
            output.to_str().unwrap(),
        ]);

        let report: serde_json::Value = read_json(&output).unwrap();
        assert_eq!(report["status"], "passed");
        assert_eq!(report["diagnostics"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn offset_map_validate_command_writes_semantic_diagnostics() {
        let root = temp_dir("offset-map-invalid");
        let input = root.join("invalid-offset-map.json");
        let output = root.join("offset-map-report.json");
        fs::write(
            &input,
            r#"{
  "sourceFileId": "script.ks",
  "encoding": "utf_8",
  "sourceLength": 6,
  "decodedTextLength": 6,
  "patchedLength": 6,
  "segments": [
    {
      "sourceBytes": { "start": 0, "end": 4 },
      "decodedText": { "start": 0, "end": 4 },
      "patchedBytes": { "start": 0, "end": 4 }
    },
    {
      "sourceBytes": { "start": 3, "end": 8 },
      "decodedText": { "start": 4, "end": 6 },
      "patchedBytes": { "start": 4, "end": 6 }
    }
  ]
}
"#,
        )
        .unwrap();

        let error = run_cli_with_registry_result(
            &[
                "offset-map",
                "validate",
                input.to_str().unwrap(),
                "--output",
                output.to_str().unwrap(),
            ],
            &engine_registry(),
        )
        .expect_err("invalid offset map should fail");
        let error = error.to_string();
        assert!(
            error.contains("kaifuu.missing_source_revision_id"),
            "{error}"
        );
        assert!(error.contains("kaifuu.overlapping_spans"), "{error}");
        assert!(
            error.contains("kaifuu.out_of_range_source_range"),
            "{error}"
        );

        let report: serde_json::Value = read_json(&output).unwrap();
        let codes = report["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .map(|diagnostic| diagnostic["code"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert!(codes.contains(&"kaifuu.missing_source_revision_id"));
        assert!(codes.contains(&"kaifuu.overlapping_spans"));
        assert!(codes.contains(&"kaifuu.out_of_range_source_range"));
    }

    #[test]
    fn offset_map_validate_command_rejects_detached_decoded_source_axes() {
        let root = temp_dir("offset-map-detached");
        let input = root.join("detached-offset-map.json");
        let output = root.join("offset-map-report.json");
        fs::write(
            &input,
            r#"{
  "sourceFileId": "script.ks",
  "sourceRevisionId": "rev-detached-001",
  "encoding": "utf_8",
  "sourceLength": 4,
  "decodedTextLength": 4,
  "patchedLength": 4,
  "segments": [
    {
      "sourceBytes": { "start": 0, "end": 0 },
      "decodedText": { "start": 0, "end": 4 },
      "patchedBytes": { "start": 0, "end": 4 }
    }
  ]
}
"#,
        )
        .unwrap();

        let error = run_cli_with_registry_result(
            &[
                "offset-map",
                "validate",
                input.to_str().unwrap(),
                "--output",
                output.to_str().unwrap(),
            ],
            &engine_registry(),
        )
        .expect_err("detached offset map should fail");
        let error = error.to_string();
        assert!(error.contains("kaifuu.detached_offset_segment"), "{error}");

        let report: serde_json::Value = read_json(&output).unwrap();
        let codes = report["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .map(|diagnostic| diagnostic["code"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert!(codes.contains(&"kaifuu.detached_offset_segment"));
    }

    fn write_apply_delta(root: &Path) -> (PathBuf, PathBuf) {
        let game_dir = temp_game(root);
        let patched_dir = root.join("patched");
        fs::create_dir_all(&patched_dir).unwrap();
        write_fixture_file(
            &patched_dir,
            "source.json",
            br#"{"units":[{"targetText":"Hello, {player}."}]}"#,
        );

        let delta_path = root.join("hello.kaifuu");
        run_cli(&[
            "diff",
            game_dir.to_str().unwrap(),
            patched_dir.to_str().unwrap(),
            "--output",
            delta_path.to_str().unwrap(),
        ]);
        (game_dir, delta_path)
    }

    fn test_capabilities() -> AdapterCapabilities {
        AdapterCapabilities::new(
            TEST_ADAPTER_ID,
            vec![
                CapabilityReport::supported(Capability::Detection),
                CapabilityReport::supported(Capability::Extraction),
                CapabilityReport::supported(Capability::Patching),
                CapabilityReport::supported(Capability::Verification),
                CapabilityReport::supported(Capability::AssetInventory),
                CapabilityReport::supported(Capability::NonTextSurfaceExtraction),
                CapabilityReport::supported(Capability::ProfileGeneration),
            ],
        )
    }

    struct RecordingAdapter {
        calls: Rc<RefCell<Vec<&'static str>>>,
    }

    impl RecordingAdapter {
        fn record(&self, call: &'static str) {
            self.calls.borrow_mut().push(call);
        }

        fn profile_result(&self) -> GameProfile {
            let mut profile = GameProfile {
                schema_version: "0.1.0".to_string(),
                profile_id: deterministic_id("profile", 98),
                game_id: "registry-dispatch-game".to_string(),
                title: "Registry Dispatch Game".to_string(),
                source_locale: "en-US".to_string(),
                engine: EngineProfile {
                    adapter_id: TEST_ADAPTER_ID.to_string(),
                    engine_family: "registry-test".to_string(),
                    engine_version: Some("9.9.9".to_string()),
                    detected_variant: "injected-adapter".to_string(),
                },
                source_fingerprint: None,
                key_requirements: vec![],
                archive_parameters: vec![],
                helper_evidence: None,
                assets: vec![AssetProfile {
                    asset_id: deterministic_id("asset", 98),
                    path: "registry.txt".to_string(),
                    asset_kind: AssetKind::Script,
                    text_surfaces: vec![TextSurface::Dialogue],
                    source_hash: Some("registry-source-hash".to_string()),
                    patching: CapabilityReport::supported(Capability::Patching),
                }],
                layered_access: None,
                capabilities: test_capabilities().reports,
                requirements: vec![],
                metadata: Default::default(),
            };
            profile.normalize();
            profile
        }
    }

    impl EngineAdapter for RecordingAdapter {
        fn id(&self) -> &'static str {
            TEST_ADAPTER_ID
        }

        fn name(&self) -> &'static str {
            "Kaifuu registry dispatch test adapter"
        }

        fn capabilities(&self) -> AdapterCapabilities {
            self.record("capabilities");
            test_capabilities()
        }

        fn detect(&self, request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
            self.record("detect");
            Ok(DetectionResult {
                adapter_id: TEST_ADAPTER_ID.to_string(),
                detected: true,
                engine_family: Some("registry-test".to_string()),
                engine_version: Some("9.9.9".to_string()),
                detected_variant: Some("injected-adapter".to_string()),
                evidence: vec![DetectionEvidence {
                    path: request.game_dir.display().to_string(),
                    kind: "injected_registry".to_string(),
                    status: EvidenceStatus::Matched,
                    detail: "custom registry adapter was called".to_string(),
                }],
                requirements: vec![ProfileRequirement {
                    category: RequirementCategory::SecretKey,
                    key: "test_key".to_string(),
                    status: RequirementStatus::NotRequired,
                    description: "test adapter does not need secrets".to_string(),
                    placeholder: None,
                    secret: true,
                }],
                capabilities: test_capabilities().reports,
            })
        }

        fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
            self.record("profile");
            Ok(self.profile_result())
        }

        fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
            self.record("list_assets");
            Ok(AssetList {
                adapter_id: TEST_ADAPTER_ID.to_string(),
                assets: vec![],
            })
        }

        fn asset_inventory(
            &self,
            _request: AssetInventoryRequest<'_>,
        ) -> KaifuuResult<AssetInventoryManifest> {
            self.record("asset_inventory");
            let mut metadata = BTreeMap::new();
            metadata.insert(
                "supportBoundary".to_string(),
                "registry test asset inventory".to_string(),
            );
            let mut manifest = AssetInventoryManifest {
                schema_version: ASSET_INVENTORY_SCHEMA_VERSION.to_string(),
                manifest_id: deterministic_id("asset-inventory", 98),
                adapter_id: TEST_ADAPTER_ID.to_string(),
                source_locale: "en-US".to_string(),
                assets: vec![AssetInventoryAsset {
                    asset_id: "registry-image".to_string(),
                    asset_key: "image/registry".to_string(),
                    asset_kind: AssetInventoryAssetKind::Image,
                    path: Some("registry/image.png".to_string()),
                    source_hash: Some(content_hash("registry-image")),
                    metadata: BTreeMap::new(),
                }],
                surfaces: vec![AssetInventorySurface {
                    surface_id: "registry-image-text".to_string(),
                    asset_surface_kind: AssetInventorySurfaceKind::ImageText,
                    source_asset_ref: AssetInventoryAssetRef {
                        asset_id: "registry-image".to_string(),
                        asset_key: Some("image/registry".to_string()),
                    },
                    source_location: None,
                    source_text: Some("Registry".to_string()),
                    source_hash: Some(content_hash("Registry")),
                    text_source_kind: AssetInventoryTextSourceKind::ManualTranscription,
                    patch_mode: AssetInventoryPatchMode::Unsupported,
                    patching: CapabilityReport::unsupported(
                        Capability::AssetTextPatching,
                        "registry test adapter does not patch image assets",
                    ),
                    notes: vec![],
                }],
                capabilities: test_capabilities().reports,
                warnings: vec![],
                metadata,
            };
            manifest.normalize();
            Ok(manifest)
        }

        fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
            self.record("extract");
            Ok(ExtractionResult {
                adapter_id: TEST_ADAPTER_ID.to_string(),
                profile: self.profile_result(),
                bridge: BridgeBundle {
                    schema_version: "0.1.0".to_string(),
                    bridge_id: deterministic_id("bridge", 98),
                    source_bundle_hash: "registry-bundle-hash".to_string(),
                    source_locale: "en-US".to_string(),
                    extractor_name: "registry-test-extractor".to_string(),
                    extractor_version: "9.9.9".to_string(),
                    units: vec![BridgeUnit {
                        bridge_unit_id: deterministic_id("bridge-unit", 98),
                        source_unit_key: "registry.unit.001".to_string(),
                        occurrence_id: "registry-occurrence-001".to_string(),
                        source_hash: "registry-source-hash".to_string(),
                        source_locale: "en-US".to_string(),
                        source_text: "Registry source".to_string(),
                        speaker: "Registry".to_string(),
                        text_surface: "dialogue".to_string(),
                        protected_spans: vec![],
                        patch_ref: PatchRef {
                            asset_id: "registry.txt".to_string(),
                            write_mode: "replace".to_string(),
                            source_unit_key: "registry.unit.001".to_string(),
                        },
                    }],
                },
                warnings: Vec::<AdapterWarning>::new(),
            })
        }

        fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
            self.record("patch");
            fs::create_dir_all(request.output_dir)?;
            fs::write(
                request.output_dir.join("registry-adapter-called.txt"),
                "patch\n",
            )?;
            Ok(PatchResult {
                schema_version: "0.1.0".to_string(),
                patch_result_id: deterministic_id("patch-result", 98),
                patch_export_id: request.patch_export.patch_export_id.clone(),
                status: OperationStatus::Passed,
                output_hash: "registry-patch-output".to_string(),
                failures: vec![],
            })
        }

        fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
            self.record("verify");
            Ok(VerificationResult {
                schema_version: "0.1.0".to_string(),
                patch_result_id: deterministic_id("verify", 98),
                status: OperationStatus::Passed,
                output_hash: "registry-verify-output".to_string(),
                failures: vec![],
            })
        }
    }

    fn recording_registry(calls: Rc<RefCell<Vec<&'static str>>>) -> AdapterRegistry {
        let mut registry = AdapterRegistry::new();
        registry.register(RecordingAdapter { calls });
        registry
    }

    struct PreflightBlockingAdapter;

    impl EngineAdapter for PreflightBlockingAdapter {
        fn id(&self) -> &'static str {
            "kaifuu.test.preflight"
        }

        fn name(&self) -> &'static str {
            "Kaifuu preflight failure test adapter"
        }

        fn capabilities(&self) -> AdapterCapabilities {
            AdapterCapabilities::new(
                self.id(),
                vec![
                    CapabilityReport::supported(Capability::Detection),
                    CapabilityReport::supported(Capability::Patching),
                    CapabilityReport::requires_user_input(
                        Capability::ContainerAccess,
                        "synthetic preflight requires container support",
                    ),
                    CapabilityReport::requires_user_input(
                        Capability::CryptoAccess,
                        "synthetic preflight requires crypto support",
                    ),
                ],
            )
        }

        fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
            Ok(DetectionResult {
                adapter_id: self.id().to_string(),
                detected: true,
                engine_family: Some("preflight-test".to_string()),
                engine_version: None,
                detected_variant: Some("layered-access-test".to_string()),
                evidence: vec![],
                requirements: vec![],
                capabilities: self.capabilities().reports,
            })
        }

        fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
            Err("profile is not used by the preflight test".into())
        }

        fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
            Err("list_assets is not used by the preflight test".into())
        }

        fn asset_inventory(
            &self,
            _request: AssetInventoryRequest<'_>,
        ) -> KaifuuResult<AssetInventoryManifest> {
            Err("asset_inventory is not used by the preflight test".into())
        }

        fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
            Err("extract is not used by the preflight test".into())
        }

        fn patch_preflight(&self, request: PatchPreflightRequest<'_>) -> KaifuuResult<PatchResult> {
            let raw_key = "00112233445566778899aabbccddeeff";
            let preflight = LayeredAccessPreflightReport::from_requirements(
                self.id(),
                "preflight-test",
                "layered-access-test",
                vec![
                    LayeredAccessPreflightRequirement::missing_capability(
                        LayeredAccessStage::Container,
                        "private-route-name/ending.ks",
                        "container helper unavailable for /home/dev/Private Route Spoiler Game/data.xp3",
                    ),
                    LayeredAccessPreflightRequirement::missing_capability(
                        LayeredAccessStage::Crypto,
                        "Scene.pck",
                        format!("helper dump included unresolved raw key {raw_key}"),
                    ),
                ],
            );
            Ok(PatchResult {
                schema_version: "0.1.0".to_string(),
                patch_result_id: deterministic_id("patch-result", 77),
                patch_export_id: request.patch_export.patch_export_id.clone(),
                status: OperationStatus::Failed,
                output_hash: content_hash("preflight failed without output"),
                failures: preflight.failures,
            })
        }

        fn patch(&self, _request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
            Err("patch must not run after a blocking preflight failure".into())
        }

        fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
            Err("verify is not used by the preflight test".into())
        }
    }

    fn preflight_registry() -> AdapterRegistry {
        let mut registry = AdapterRegistry::new();
        registry.register(PreflightBlockingAdapter);
        registry
    }

    struct ContractStatusPreflightAdapter;

    impl EngineAdapter for ContractStatusPreflightAdapter {
        fn id(&self) -> &'static str {
            "kaifuu.test.contract-status-preflight"
        }

        fn name(&self) -> &'static str {
            "Kaifuu contract status preflight test adapter"
        }

        fn capabilities(&self) -> AdapterCapabilities {
            let mut access_contract = LayeredAccessCapabilityContract::plaintext_identity();
            access_contract.patch.status = CapabilityStatus::RequiresUserInput;
            access_contract.patch.support_boundary =
                Some("patch access requires local helper confirmation before writing".to_string());
            AdapterCapabilities::new(
                self.id(),
                vec![
                    CapabilityReport::supported(Capability::Detection),
                    CapabilityReport::supported(Capability::Patching),
                    CapabilityReport::supported(Capability::ContainerAccess),
                    CapabilityReport::supported(Capability::CryptoAccess),
                    CapabilityReport::supported(Capability::CodecAccess),
                    CapabilityReport::supported(Capability::PatchBack),
                ],
            )
            .with_access_contract(access_contract)
        }

        fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
            Ok(DetectionResult {
                adapter_id: self.id().to_string(),
                detected: true,
                engine_family: Some("contract-status-preflight-test".to_string()),
                engine_version: None,
                detected_variant: Some("requires-user-input".to_string()),
                evidence: vec![],
                requirements: vec![],
                capabilities: self.capabilities().reports,
            })
        }

        fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
            Err("profile is not used by the contract status preflight test".into())
        }

        fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
            Err("list_assets is not used by the contract status preflight test".into())
        }

        fn asset_inventory(
            &self,
            _request: AssetInventoryRequest<'_>,
        ) -> KaifuuResult<AssetInventoryManifest> {
            Err("asset_inventory is not used by the contract status preflight test".into())
        }

        fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
            Err("extract is not used by the contract status preflight test".into())
        }

        fn patch_preflight(&self, request: PatchPreflightRequest<'_>) -> KaifuuResult<PatchResult> {
            let access_profile = LayeredAccessProfile::plaintext_identity_for_asset(
                "source-json",
                "source.json",
                &[TextSurface::Dialogue],
                "$.lines[*]",
            );
            let preflight = LayeredAccessPreflightReport::from_access_profile(
                self.id(),
                "contract-status-preflight-test",
                "requires-user-input",
                &self.capabilities(),
                &access_profile,
            );
            Ok(PatchResult {
                schema_version: "0.1.0".to_string(),
                patch_result_id: deterministic_id("patch-result", 82),
                patch_export_id: request.patch_export.patch_export_id.clone(),
                status: preflight.status,
                output_hash: content_hash("contract status preflight without output"),
                failures: preflight.failures,
            })
        }

        fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
            fs::create_dir_all(request.output_dir)?;
            fs::write(
                request
                    .output_dir
                    .join("contract-status-preflight-bypassed.txt"),
                "patch should not have run\n",
            )?;
            Ok(PatchResult {
                schema_version: "0.1.0".to_string(),
                patch_result_id: deterministic_id("patch-result", 83),
                patch_export_id: request.patch_export.patch_export_id.clone(),
                status: OperationStatus::Passed,
                output_hash: content_hash("contract status preflight bypassed"),
                failures: vec![],
            })
        }

        fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
            Err("verify is not used by the contract status preflight test".into())
        }
    }

    fn contract_status_preflight_registry() -> AdapterRegistry {
        let mut registry = AdapterRegistry::new();
        registry.register(ContractStatusPreflightAdapter);
        registry
    }

    struct MaliciousPreflightBlockingPatchAdapter {
        failure: AdapterFailure,
    }

    impl MaliciousPreflightBlockingPatchAdapter {
        fn new(failure: AdapterFailure) -> Self {
            Self { failure }
        }
    }

    impl EngineAdapter for MaliciousPreflightBlockingPatchAdapter {
        fn id(&self) -> &'static str {
            "kaifuu.test.malicious-preflight"
        }

        fn name(&self) -> &'static str {
            "Kaifuu malicious preflight failure test adapter"
        }

        fn capabilities(&self) -> AdapterCapabilities {
            AdapterCapabilities::new(
                self.id(),
                vec![
                    CapabilityReport::supported(Capability::Detection),
                    CapabilityReport::supported(Capability::Patching),
                ],
            )
        }

        fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
            Ok(DetectionResult {
                adapter_id: self.id().to_string(),
                detected: true,
                engine_family: Some("malicious-preflight-test".to_string()),
                engine_version: None,
                detected_variant: Some("writes-before-failure".to_string()),
                evidence: vec![],
                requirements: vec![],
                capabilities: self.capabilities().reports,
            })
        }

        fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
            Err("profile is not used by the malicious preflight test".into())
        }

        fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
            Err("list_assets is not used by the malicious preflight test".into())
        }

        fn asset_inventory(
            &self,
            _request: AssetInventoryRequest<'_>,
        ) -> KaifuuResult<AssetInventoryManifest> {
            Err("asset_inventory is not used by the malicious preflight test".into())
        }

        fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
            Err("extract is not used by the malicious preflight test".into())
        }

        fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
            fs::create_dir_all(request.output_dir)?;
            fs::write(
                request.output_dir.join("must-not-escape.txt"),
                "leaked output\n",
            )?;
            Ok(PatchResult {
                schema_version: "0.1.0".to_string(),
                patch_result_id: deterministic_id("patch-result", 78),
                patch_export_id: request.patch_export.patch_export_id.clone(),
                status: OperationStatus::Failed,
                output_hash: content_hash("malicious preflight output"),
                failures: vec![self.failure.clone()],
            })
        }

        fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
            Err("verify is not used by the malicious preflight test".into())
        }
    }

    fn malicious_registry(failure: AdapterFailure) -> AdapterRegistry {
        let mut registry = AdapterRegistry::new();
        registry.register(MaliciousPreflightBlockingPatchAdapter::new(failure));
        registry
    }

    enum PatchFilesystemFailureMode {
        AdapterErrAfterWrite,
        ReportWriteCollision,
        SuccessfulWrite,
    }

    struct PatchFilesystemFailureAdapter {
        mode: PatchFilesystemFailureMode,
    }

    impl PatchFilesystemFailureAdapter {
        fn new(mode: PatchFilesystemFailureMode) -> Self {
            Self { mode }
        }
    }

    impl EngineAdapter for PatchFilesystemFailureAdapter {
        fn id(&self) -> &'static str {
            "kaifuu.test.patch-filesystem-failure"
        }

        fn name(&self) -> &'static str {
            "Kaifuu patch filesystem failure test adapter"
        }

        fn capabilities(&self) -> AdapterCapabilities {
            AdapterCapabilities::new(
                self.id(),
                vec![
                    CapabilityReport::supported(Capability::Detection),
                    CapabilityReport::supported(Capability::Patching),
                ],
            )
        }

        fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
            Ok(DetectionResult {
                adapter_id: self.id().to_string(),
                detected: true,
                engine_family: Some("patch-filesystem-failure-test".to_string()),
                engine_version: None,
                detected_variant: Some("cleanup".to_string()),
                evidence: vec![],
                requirements: vec![],
                capabilities: self.capabilities().reports,
            })
        }

        fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
            Err("profile is not used by the patch filesystem failure test".into())
        }

        fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
            Err("list_assets is not used by the patch filesystem failure test".into())
        }

        fn asset_inventory(
            &self,
            _request: AssetInventoryRequest<'_>,
        ) -> KaifuuResult<AssetInventoryManifest> {
            Err("asset_inventory is not used by the patch filesystem failure test".into())
        }

        fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
            Err("extract is not used by the patch filesystem failure test".into())
        }

        fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
            fs::write(
                request.output_dir.join("adapter-output.txt"),
                "staged output\n",
            )?;
            match self.mode {
                PatchFilesystemFailureMode::AdapterErrAfterWrite => {
                    Err("adapter failed after writing staged output".into())
                }
                PatchFilesystemFailureMode::ReportWriteCollision => {
                    fs::create_dir(request.output_dir.join("patch-result.json"))?;
                    Ok(self.patch_result(request.patch_export))
                }
                PatchFilesystemFailureMode::SuccessfulWrite => {
                    Ok(self.patch_result(request.patch_export))
                }
            }
        }

        fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
            Err("verify is not used by the patch filesystem failure test".into())
        }
    }

    impl PatchFilesystemFailureAdapter {
        fn patch_result(&self, patch_export: &PatchExport) -> PatchResult {
            PatchResult {
                schema_version: "0.1.0".to_string(),
                patch_result_id: deterministic_id("patch-result", 79),
                patch_export_id: patch_export.patch_export_id.clone(),
                status: OperationStatus::Passed,
                output_hash: content_hash("patch filesystem failure output"),
                failures: vec![],
            }
        }
    }

    fn patch_filesystem_failure_registry(mode: PatchFilesystemFailureMode) -> AdapterRegistry {
        let mut registry = AdapterRegistry::new();
        registry.register(PatchFilesystemFailureAdapter::new(mode));
        registry
    }

    fn empty_patch_export(root: &Path, seed: usize) -> PathBuf {
        let patch_export = PatchExport {
            patch_export_id: deterministic_id("patch", seed),
            source_locale: "ja-JP".to_string(),
            target_locale: "en-US".to_string(),
            entries: vec![],
        };
        let patch_export_path = root.join("patch-export.json");
        write_json(&patch_export_path, &patch_export).unwrap();
        patch_export_path
    }

    fn assert_no_patch_staging_entries(root: &Path, output_name: &str) {
        let leaked_entries = fs::read_dir(root)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(output_name) && name.contains("kaifuu-staging"))
            .collect::<Vec<_>>();
        assert_eq!(leaked_entries, Vec::<String>::new());
    }

    struct SensitiveReportAdapter;

    impl EngineAdapter for SensitiveReportAdapter {
        fn id(&self) -> &'static str {
            "kaifuu.test.sensitive-report"
        }

        fn name(&self) -> &'static str {
            "Kaifuu sensitive report test adapter"
        }

        fn capabilities(&self) -> AdapterCapabilities {
            AdapterCapabilities::new(
                self.id(),
                vec![
                    CapabilityReport::requires_user_input(
                        Capability::KeyProfile,
                        "path=~/games/private/key.bin",
                    ),
                    CapabilityReport::unsupported(
                        Capability::PatchBack,
                        "requires file=%USERPROFILE%\\Games\\SecretRoute\\patcher.exe",
                    ),
                ],
            )
        }

        fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
            Ok(DetectionResult {
                adapter_id: self.id().to_string(),
                detected: true,
                engine_family: Some("sensitive-report-test".to_string()),
                engine_version: None,
                detected_variant: Some("private-route".to_string()),
                evidence: vec![],
                requirements: vec![
                    ProfileRequirement {
                        category: RequirementCategory::SecretKey,
                        key: "route-key".to_string(),
                        status: RequirementStatus::Missing,
                        description: "read key from $HOME/games/private/key.bin".to_string(),
                        placeholder: Some(
                            "file=%USERPROFILE%\\Games\\SecretRoute\\key.bin".to_string(),
                        ),
                        secret: true,
                    },
                    ProfileRequirement {
                        category: RequirementCategory::File,
                        key: "script".to_string(),
                        status: RequirementStatus::Unsupported,
                        description: "story-ish filename private-route-ending.ks must stay local"
                            .to_string(),
                        placeholder: None,
                        secret: false,
                    },
                ],
                capabilities: self.capabilities().reports,
            })
        }

        fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
            let mut metadata = BTreeMap::new();
            metadata.insert(
                "diagnostic".to_string(),
                "source=$HOME/games/private/key.bin".to_string(),
            );
            Ok(GameProfile {
                schema_version: "0.1.0".to_string(),
                profile_id: deterministic_id("profile", 1301),
                game_id: "sensitive-report-game".to_string(),
                title: "Sensitive Report Game".to_string(),
                source_locale: "ja-JP".to_string(),
                engine: EngineProfile {
                    adapter_id: self.id().to_string(),
                    engine_family: "sensitive-report-test".to_string(),
                    engine_version: None,
                    detected_variant: "private-route".to_string(),
                },
                source_fingerprint: None,
                key_requirements: vec![],
                archive_parameters: vec![],
                helper_evidence: None,
                assets: vec![AssetProfile {
                    asset_id: deterministic_id("asset", 1301),
                    path: "~/games/private/source.ks".to_string(),
                    asset_kind: AssetKind::Script,
                    text_surfaces: vec![TextSurface::Dialogue],
                    source_hash: Some(content_hash("sensitive profile asset")),
                    patching: CapabilityReport::limited(
                        Capability::Patching,
                        "helper input lives at %USERPROFILE%\\Games\\SecretRoute\\key.bin",
                    ),
                }],
                layered_access: None,
                capabilities: self.capabilities().reports,
                requirements: vec![ProfileRequirement {
                    category: RequirementCategory::SecretKey,
                    key: "route-key".to_string(),
                    status: RequirementStatus::Missing,
                    description:
                        "helper dump source:/home/dev/game/private-route-ending.ks exposed raw key 00112233445566778899aabbccddeeff"
                            .to_string(),
                    placeholder: Some("file=C:\\Games\\SecretRoute\\key.bin".to_string()),
                    secret: true,
                }],
                metadata,
            })
        }

        fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
            Err("list_assets is not used by the sensitive report test".into())
        }

        fn asset_inventory(
            &self,
            _request: AssetInventoryRequest<'_>,
        ) -> KaifuuResult<AssetInventoryManifest> {
            Err("asset_inventory is not used by the sensitive report test".into())
        }

        fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
            Err("extract is not used by the sensitive report test".into())
        }

        fn patch(&self, _request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
            Err("patch is not used by the sensitive report test".into())
        }

        fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
            Err("verify is not used by the sensitive report test".into())
        }
    }

    fn sensitive_report_registry() -> AdapterRegistry {
        let mut registry = AdapterRegistry::new();
        registry.register(SensitiveReportAdapter);
        registry
    }

    struct InvalidProfileAdapter;

    impl EngineAdapter for InvalidProfileAdapter {
        fn id(&self) -> &'static str {
            "kaifuu.test.invalid-profile"
        }

        fn name(&self) -> &'static str {
            "Kaifuu invalid profile test adapter"
        }

        fn capabilities(&self) -> AdapterCapabilities {
            AdapterCapabilities::new(
                self.id(),
                vec![
                    CapabilityReport::supported(Capability::Detection),
                    CapabilityReport::supported(Capability::ProfileGeneration),
                    CapabilityReport::supported(Capability::Patching),
                ],
            )
        }

        fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
            Ok(DetectionResult {
                adapter_id: self.id().to_string(),
                detected: true,
                engine_family: Some("invalid-profile-test".to_string()),
                engine_version: None,
                detected_variant: Some("missing-profile-id".to_string()),
                evidence: vec![],
                requirements: vec![],
                capabilities: self.capabilities().reports,
            })
        }

        fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
            Ok(GameProfile {
                schema_version: "0.1.0".to_string(),
                profile_id: String::new(),
                game_id: "invalid-profile-game".to_string(),
                title: "Invalid Profile Game".to_string(),
                source_locale: "ja-JP".to_string(),
                engine: EngineProfile {
                    adapter_id: self.id().to_string(),
                    engine_family: "invalid-profile-test".to_string(),
                    engine_version: None,
                    detected_variant: "missing-profile-id".to_string(),
                },
                source_fingerprint: None,
                key_requirements: vec![],
                archive_parameters: vec![],
                helper_evidence: None,
                assets: vec![AssetProfile {
                    asset_id: deterministic_id("asset", 1401),
                    path: "source.ks".to_string(),
                    asset_kind: AssetKind::Script,
                    text_surfaces: vec![TextSurface::Dialogue],
                    source_hash: Some(content_hash("invalid profile source")),
                    patching: CapabilityReport::supported(Capability::Patching),
                }],
                layered_access: None,
                capabilities: self.capabilities().reports,
                requirements: vec![],
                metadata: BTreeMap::new(),
            })
        }

        fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
            Err("list_assets is not used by the invalid profile test".into())
        }

        fn asset_inventory(
            &self,
            _request: AssetInventoryRequest<'_>,
        ) -> KaifuuResult<AssetInventoryManifest> {
            Err("asset_inventory is not used by the invalid profile test".into())
        }

        fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
            Err("extract is not used by the invalid profile test".into())
        }

        fn patch(&self, _request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
            Err("patch is not used by the invalid profile test".into())
        }

        fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
            Err("verify is not used by the invalid profile test".into())
        }
    }

    fn invalid_profile_registry() -> AdapterRegistry {
        let mut registry = AdapterRegistry::new();
        registry.register(InvalidProfileAdapter);
        registry
    }

    fn assert_no_sensitive_profile_material(surface: &str) {
        for forbidden in [
            "~/games",
            "$HOME/games",
            "%USERPROFILE%",
            "/home/dev/game",
            "C:\\Games",
            "private/key.bin",
            "helper dump",
            "decrypted text",
            "00112233445566778899aabbccddeeff",
            "private-route-ending.ks",
            "SecretRoute",
        ] {
            assert!(
                !surface.contains(forbidden),
                "profile write surface leaked {forbidden}: {surface}"
            );
        }
    }

    fn assert_calls(calls: &Rc<RefCell<Vec<&'static str>>>, expected: &[&'static str]) {
        assert_eq!(calls.borrow().as_slice(), expected);
        calls.borrow_mut().clear();
    }

    #[test]
    fn engine_commands_use_supplied_registry() {
        let root = temp_dir("injected-registry-dispatch");
        let game_dir = root.join("non-fixture-game");
        fs::create_dir_all(&game_dir).unwrap();
        let calls = Rc::new(RefCell::new(Vec::new()));
        let registry = recording_registry(Rc::clone(&calls));

        let capabilities_path = root.join("capabilities.json");
        run_cli_with_registry(
            &[
                "capabilities",
                "--output",
                capabilities_path.to_str().unwrap(),
            ],
            &registry,
        );
        let capabilities: Vec<AdapterCapabilities> = read_json(&capabilities_path).unwrap();
        assert_eq!(capabilities, vec![test_capabilities()]);
        assert_calls(&calls, &["capabilities"]);

        let detect_path = root.join("detect.json");
        run_cli_with_registry(
            &[
                "detect",
                game_dir.to_str().unwrap(),
                "--output",
                detect_path.to_str().unwrap(),
            ],
            &registry,
        );
        let detection_report: DetectionReport = read_json(&detect_path).unwrap();
        assert_eq!(detection_report.status, DetectionReportStatus::Matched);
        assert_eq!(detection_report.detections.len(), 1);
        let detection = &detection_report.detections[0];
        assert_eq!(detection.adapter_id, TEST_ADAPTER_ID);
        assert_eq!(
            detection.detected_variant.as_deref(),
            Some("injected-adapter")
        );
        assert_eq!(detection.evidence[0].status, EvidenceStatus::Matched);
        let serialized_detection: serde_json::Value = read_json(&detect_path).unwrap();
        let detection_json = &serialized_detection["detections"][0];
        assert_eq!(detection_json["engineFamily"], "registry-test");
        assert_eq!(detection_json["engineVersion"], "9.9.9");
        assert_eq!(detection_json["detectedVariant"], "injected-adapter");
        let serialized_detection_text = fs::read_to_string(&detect_path).unwrap();
        assert!(!serialized_detection_text.contains(&game_dir.display().to_string()));
        assert_calls(&calls, &["detect"]);

        let profile_path = root.join("profile.json");
        run_cli_with_registry(
            &[
                "profile",
                "init",
                game_dir.to_str().unwrap(),
                "--output",
                profile_path.to_str().unwrap(),
            ],
            &registry,
        );
        let profile: GameProfile = read_json(&profile_path).unwrap();
        assert_eq!(profile.engine.adapter_id, TEST_ADAPTER_ID);
        assert_eq!(profile.game_id, "registry-dispatch-game");
        assert_calls(&calls, &["detect", "profile"]);

        let asset_inventory_path = root.join("asset-inventory.json");
        run_cli_with_registry(
            &[
                "asset-inventory",
                game_dir.to_str().unwrap(),
                "--output",
                asset_inventory_path.to_str().unwrap(),
            ],
            &registry,
        );
        let asset_inventory: AssetInventoryManifest = read_json(&asset_inventory_path).unwrap();
        assert_eq!(asset_inventory.adapter_id, TEST_ADAPTER_ID);
        assert_eq!(asset_inventory.surfaces.len(), 1);
        assert_eq!(
            asset_inventory.surfaces[0].patching.status,
            CapabilityStatus::Unsupported
        );
        assert_calls(&calls, &["detect", "asset_inventory"]);

        let validation_path = root.join("profile-validation.json");
        run_cli_with_registry(
            &[
                "profile",
                "validate",
                profile_path.to_str().unwrap(),
                "--output",
                validation_path.to_str().unwrap(),
            ],
            &registry,
        );
        let validation: kaifuu_core::ProfileValidationResult = read_json(&validation_path).unwrap();
        assert_eq!(validation.status, OperationStatus::Passed);
        assert_calls(&calls, &[]);

        let bridge_path = root.join("bridge.json");
        run_cli_with_registry(
            &[
                "extract",
                game_dir.to_str().unwrap(),
                "--output",
                bridge_path.to_str().unwrap(),
            ],
            &registry,
        );
        let bridge: BridgeBundle = read_json(&bridge_path).unwrap();
        assert_eq!(bridge.extractor_name, "registry-test-extractor");
        assert_eq!(bridge.units[0].source_unit_key, "registry.unit.001");
        assert_calls(&calls, &["detect", "extract"]);

        let patch_export = PatchExport {
            patch_export_id: deterministic_id("patch", 98),
            source_locale: "en-US".to_string(),
            target_locale: "fr-FR".to_string(),
            entries: vec![],
        };
        let patch_export_path = root.join("patch-export.json");
        write_json(&patch_export_path, &patch_export).unwrap();
        let patched_dir = root.join("patched");
        run_cli_with_registry(
            &[
                "patch",
                game_dir.to_str().unwrap(),
                "--patch",
                patch_export_path.to_str().unwrap(),
                "--output",
                patched_dir.to_str().unwrap(),
            ],
            &registry,
        );
        let patch_result: PatchResult = read_json(&patched_dir.join("patch-result.json")).unwrap();
        assert_eq!(patch_result.output_hash, "registry-patch-output");
        assert!(patched_dir.join("registry-adapter-called.txt").exists());
        assert_calls(&calls, &["detect", "patch"]);

        let verify_path = root.join("verify.json");
        run_cli_with_registry(
            &[
                "verify",
                game_dir.to_str().unwrap(),
                "--output",
                verify_path.to_str().unwrap(),
            ],
            &registry,
        );
        let verify: VerificationResult = read_json(&verify_path).unwrap();
        assert_eq!(verify.output_hash, "registry-verify-output");
        assert_calls(&calls, &["detect", "verify"]);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn detection_and_capabilities_reports_redact_sensitive_free_text() {
        let root = temp_dir("sensitive-report-redaction");
        let game_dir = root.join("game");
        fs::create_dir_all(&game_dir).unwrap();
        let registry = sensitive_report_registry();

        let capabilities_path = root.join("capabilities.json");
        run_cli_with_registry(
            &[
                "capabilities",
                "--output",
                capabilities_path.to_str().unwrap(),
            ],
            &registry,
        );
        let capabilities_serialized = fs::read_to_string(&capabilities_path).unwrap();
        assert!(capabilities_serialized.contains(kaifuu_core::SEMANTIC_SECRET_REDACTED));
        for forbidden in ["~/games", "%USERPROFILE%", "private/key.bin", "SecretRoute"] {
            assert!(
                !capabilities_serialized.contains(forbidden),
                "capabilities leaked {forbidden}"
            );
        }

        let detect_path = root.join("detect.json");
        run_cli_with_registry(
            &[
                "detect",
                game_dir.to_str().unwrap(),
                "--output",
                detect_path.to_str().unwrap(),
            ],
            &registry,
        );
        let detection_serialized = fs::read_to_string(&detect_path).unwrap();
        assert!(detection_serialized.contains(kaifuu_core::SEMANTIC_SECRET_REDACTED));
        for forbidden in [
            "$HOME/games",
            "%USERPROFILE%",
            "private/key.bin",
            "SecretRoute",
        ] {
            assert!(
                !detection_serialized.contains(forbidden),
                "detection leaked {forbidden}"
            );
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn profile_write_gate_rejects_unredacted_adapter_payloads_on_init_and_legacy_paths() {
        let root = temp_dir("sensitive-profile-write-gate");
        let game_dir = root.join("game");
        fs::create_dir_all(&game_dir).unwrap();
        let registry = sensitive_report_registry();

        for legacy in [false, true] {
            let label = if legacy { "legacy" } else { "init" };
            let output = root.join(format!("profile-{label}.json"));
            let args = if legacy {
                vec![
                    "profile",
                    game_dir.to_str().unwrap(),
                    "--output",
                    output.to_str().unwrap(),
                ]
            } else {
                vec![
                    "profile",
                    "init",
                    game_dir.to_str().unwrap(),
                    "--output",
                    output.to_str().unwrap(),
                ]
            };
            let error = run_cli_with_registry_result(&args, &registry)
                .expect_err("sensitive profile payload should be rejected")
                .to_string();

            assert!(
                error.contains("generated profile failed validation"),
                "{label} path returned unexpected error: {error}"
            );
            assert!(
                error.contains(kaifuu_core::SEMANTIC_SECRET_REDACTED),
                "{label} path did not report the redaction boundary: {error}"
            );
            assert!(
                !output.exists(),
                "{label} path persisted an invalid profile to {}",
                output.display()
            );
            assert_no_sensitive_profile_material(&error);
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn profile_write_gate_redacts_raw_key_material_before_persisting_valid_profile() {
        let root = temp_dir("profile-write-gate-redacted-persist");
        let output = root.join("profile.json");
        let profile = GameProfile {
            schema_version: "0.1.0".to_string(),
            profile_id: deterministic_id("profile", 1402),
            game_id: "valid-redaction-profile-game".to_string(),
            title: "Valid Profile 00112233445566778899aabbccddeeff".to_string(),
            source_locale: "ja-JP".to_string(),
            engine: EngineProfile {
                adapter_id: "kaifuu.test.redacted-persist".to_string(),
                engine_family: "redacted-persist-test".to_string(),
                engine_version: None,
                detected_variant: "valid-title-redaction".to_string(),
            },
            source_fingerprint: None,
            key_requirements: vec![],
            archive_parameters: vec![],
            helper_evidence: None,
            assets: vec![AssetProfile {
                asset_id: deterministic_id("asset", 1402),
                path: "source.ks".to_string(),
                asset_kind: AssetKind::Script,
                text_surfaces: vec![TextSurface::Dialogue],
                source_hash: Some(content_hash("redacted persist source")),
                patching: CapabilityReport::supported(Capability::Patching),
            }],
            layered_access: None,
            capabilities: vec![
                CapabilityReport::supported(Capability::ProfileGeneration),
                CapabilityReport::supported(Capability::Patching),
            ],
            requirements: vec![],
            metadata: BTreeMap::new(),
        };

        assert_eq!(profile.validate().status, OperationStatus::Passed);
        write_validated_stable_profile(&output, &profile).unwrap();

        let serialized = fs::read_to_string(&output).unwrap();
        assert!(serialized.contains(kaifuu_core::SEMANTIC_SECRET_REDACTED));
        assert_no_sensitive_profile_material(&serialized);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn legacy_profile_command_rejects_structurally_invalid_profiles_before_write() {
        let root = temp_dir("legacy-profile-invalid-write-gate");
        let game_dir = root.join("game");
        fs::create_dir_all(&game_dir).unwrap();
        let output = root.join("profile.json");
        let registry = invalid_profile_registry();

        let error = run_cli_with_registry_result(
            &[
                "profile",
                game_dir.to_str().unwrap(),
                "--output",
                output.to_str().unwrap(),
            ],
            &registry,
        )
        .expect_err("legacy profile command should reject invalid generated profiles")
        .to_string();

        assert!(error.contains("generated profile failed validation"));
        assert!(error.contains("missing_required_field"));
        assert!(!output.exists());
        assert_no_sensitive_profile_material(&error);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn fixture_commands_dispatch_through_registered_adapter() {
        let root = temp_dir("fixture-dispatch");
        let game_dir = temp_game(&root);

        let capabilities_path = root.join("capabilities.json");
        run_cli(&[
            "capabilities",
            "--output",
            capabilities_path.to_str().unwrap(),
        ]);
        let capabilities: Vec<AdapterCapabilities> = read_json(&capabilities_path).unwrap();
        assert_eq!(capabilities.len(), 3);
        let fixture_capabilities = capabilities
            .iter()
            .find(|capabilities| {
                capabilities.adapter_id == kaifuu_engine_fixture::FIXTURE_ADAPTER_ID
            })
            .unwrap();
        assert_eq!(
            fixture_capabilities.adapter_id,
            kaifuu_engine_fixture::FIXTURE_ADAPTER_ID
        );
        assert!(fixture_capabilities.reports.iter().any(|report| {
            report.capability == Capability::LineParityPatching
                && report.status == CapabilityStatus::Limited
        }));
        assert!(fixture_capabilities.access_contract.is_some());
        assert!(
            fixture_capabilities
                .helper_requirements
                .iter()
                .any(|requirement| {
                    requirement.helper_registry_id == kaifuu_core::FIXTURE_HELPER_REGISTRY_ID
                        && requirement.allowlist_ref_id
                            == kaifuu_core::FIXTURE_HELPER_ALLOWLIST_REF_ID
                        && requirement
                            .capabilities
                            .contains(&HelperCapability::FixtureInvocation)
                })
        );
        assert!(capabilities.iter().any(|capabilities| {
            capabilities.adapter_id == kaifuu_engine_fixture::XP3_DETECTOR_ADAPTER_ID
                && capabilities.reports.iter().any(|report| {
                    report.capability == Capability::Detection
                        && report.status == CapabilityStatus::Supported
                })
        }));

        let detect_path = root.join("detect.json");
        run_cli(&[
            "detect",
            game_dir.to_str().unwrap(),
            "--output",
            detect_path.to_str().unwrap(),
        ]);
        let detection_report: DetectionReport = read_json(&detect_path).unwrap();
        assert_eq!(detection_report.status, DetectionReportStatus::Matched);
        let detection = &detection_report.detections[0];
        assert!(detection.detected);
        assert_eq!(
            detection.adapter_id,
            kaifuu_engine_fixture::FIXTURE_ADAPTER_ID
        );
        assert!(detection.evidence.iter().any(|evidence| {
            evidence.path == "source.json" && evidence.status == EvidenceStatus::Matched
        }));

        let profile_path = root.join("profile.json");
        run_cli(&[
            "profile",
            "init",
            game_dir.to_str().unwrap(),
            "--output",
            profile_path.to_str().unwrap(),
        ]);
        let profile: GameProfile = read_json(&profile_path).unwrap();
        assert_eq!(
            profile.engine.adapter_id,
            kaifuu_engine_fixture::FIXTURE_ADAPTER_ID
        );
        let layered_access = profile.layered_access.as_ref().unwrap();
        assert!(layered_access.surfaces.iter().any(|surface| {
            surface.container == kaifuu_core::ContainerTransform::Identity
                && surface.crypto == kaifuu_core::CryptoTransform::NullKey
                && surface.codec == kaifuu_core::CodecTransform::Identity
        }));
        assert!(profile.requirements.iter().any(|requirement| {
            requirement.category == RequirementCategory::SecretKey
                && requirement.status == RequirementStatus::NotRequired
                && requirement.secret
                && requirement.placeholder.is_none()
        }));

        let validation_path = root.join("profile-validation.json");
        run_cli(&[
            "profile",
            "validate",
            profile_path.to_str().unwrap(),
            "--output",
            validation_path.to_str().unwrap(),
        ]);
        let validation: kaifuu_core::ProfileValidationResult = read_json(&validation_path).unwrap();
        assert_eq!(validation.status, OperationStatus::Passed);

        let bridge_path = root.join("bridge.json");
        run_cli(&[
            "extract",
            game_dir.to_str().unwrap(),
            "--output",
            bridge_path.to_str().unwrap(),
        ]);
        let bridge: BridgeBundle = read_json(&bridge_path).unwrap();
        assert_eq!(bridge.units.len(), 1);

        let patch_export = PatchExport {
            patch_export_id: deterministic_id("patch", 1),
            source_locale: "ja-JP".to_string(),
            target_locale: "en-US".to_string(),
            entries: vec![PatchExportEntry {
                bridge_unit_id: bridge.units[0].bridge_unit_id.clone(),
                source_unit_key: bridge.units[0].source_unit_key.clone(),
                source_hash: bridge.units[0].source_hash.clone(),
                target_text: "Hello, {player}.".to_string(),
                protected_span_mappings: vec![ProtectedSpanMapping::new("{player}", 7, 15)],
            }],
        };
        let patch_export_path = root.join("patch-export.json");
        write_json(&patch_export_path, &patch_export).unwrap();

        let patched_dir = root.join("patched");
        run_cli(&[
            "patch",
            game_dir.to_str().unwrap(),
            "--patch",
            patch_export_path.to_str().unwrap(),
            "--output",
            patched_dir.to_str().unwrap(),
        ]);
        let patch_result: PatchResult = read_json(&patched_dir.join("patch-result.json")).unwrap();
        assert_eq!(patch_result.status, OperationStatus::Passed);
        assert!(
            fs::read_to_string(patched_dir.join("source.json"))
                .unwrap()
                .contains("Hello, {player}.")
        );

        let verify_path = root.join("verify.json");
        run_cli(&[
            "verify",
            patched_dir.to_str().unwrap(),
            "--output",
            verify_path.to_str().unwrap(),
        ]);
        let verify: VerificationResult = read_json(&verify_path).unwrap();
        assert_eq!(verify.status, OperationStatus::Passed);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn diff_apply_commands_round_trip_v02_delta_package() {
        let root = temp_dir("diff-apply-v02");
        let game_dir = temp_game(&root);
        write_fixture_file(&game_dir, "readme.txt", b"same\n");

        let patched_dir = root.join("patched");
        fs::create_dir_all(&patched_dir).unwrap();
        write_fixture_file(
            &patched_dir,
            "source.json",
            br#"{"units":[{"targetText":"Hello, {player}."}]}"#,
        );
        write_fixture_file(&patched_dir, "readme.txt", b"same\n");
        write_fixture_file(&patched_dir, "extra.txt", b"new\n");

        let delta_path = root.join("hello.kaifuu");
        run_cli(&[
            "diff",
            game_dir.to_str().unwrap(),
            patched_dir.to_str().unwrap(),
            "--output",
            delta_path.to_str().unwrap(),
        ]);
        let delta: serde_json::Value = read_json(&delta_path).unwrap();
        assert_eq!(delta["schemaVersion"], "0.2.0");
        let changed_paths = delta["changedEntries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["path"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(changed_paths, vec!["extra.txt", "source.json"]);

        let output_dir = root.join("applied");
        run_cli(&[
            "apply",
            game_dir.to_str().unwrap(),
            "--patch",
            delta_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
        ]);

        let report_path = root.join("applied.kaifuu/patch-result.json");
        let apply_result: serde_json::Value = read_json(&report_path).unwrap();
        assert_eq!(apply_result["status"], "passed");
        assert_eq!(apply_result["changedFileCount"], 2);
        assert!(!output_dir.join("patch-result.json").exists());
        assert!(
            fs::read_to_string(output_dir.join("source.json"))
                .unwrap()
                .contains("Hello, {player}.")
        );
        assert_eq!(
            fs::read_to_string(output_dir.join("readme.txt")).unwrap(),
            "same\n"
        );
        assert_eq!(
            fs::read_to_string(output_dir.join("extra.txt")).unwrap(),
            "new\n"
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn apply_command_preserves_target_patch_result_and_writes_report_outside_output() {
        let root = temp_dir("apply-target-report-collision");
        let game_dir = temp_game(&root);

        let patched_dir = root.join("patched");
        fs::create_dir_all(&patched_dir).unwrap();
        write_fixture_file(
            &patched_dir,
            "source.json",
            br#"{"units":[{"targetText":"Hello, {player}."}]}"#,
        );
        write_fixture_file(&patched_dir, "patch-result.json", b"real game file\n");

        let delta_path = root.join("hello.kaifuu");
        run_cli(&[
            "diff",
            game_dir.to_str().unwrap(),
            patched_dir.to_str().unwrap(),
            "--output",
            delta_path.to_str().unwrap(),
        ]);
        let delta: serde_json::Value = read_json(&delta_path).unwrap();
        assert!(
            delta["target"]["files"]
                .as_array()
                .unwrap()
                .iter()
                .any(|record| record["path"] == "patch-result.json")
        );

        let output_dir = root.join("applied");
        run_cli(&[
            "apply",
            game_dir.to_str().unwrap(),
            "--patch",
            delta_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
        ]);

        assert_eq!(
            fs::read(output_dir.join("patch-result.json")).unwrap(),
            b"real game file\n"
        );
        let report: serde_json::Value =
            read_json(&root.join("applied.kaifuu/patch-result.json")).unwrap();
        assert_eq!(report["status"], "passed");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn apply_command_rejects_report_output_inside_patched_output() {
        let root = temp_dir("apply-report-output-guard");
        let (game_dir, delta_path) = write_apply_delta(&root);
        let output_dir = root.join("applied");

        let result = run_with_args(
            [
                "apply",
                game_dir.to_str().unwrap(),
                "--patch",
                delta_path.to_str().unwrap(),
                "--output",
                output_dir.to_str().unwrap(),
                "--report-output",
                output_dir.join("patch-result.json").to_str().unwrap(),
            ]
            .iter()
            .map(|arg| arg.to_string())
            .collect(),
        );

        let error = result.unwrap_err().to_string();
        assert!(
            error.contains("apply report output must not be inside patched output directory"),
            "{error}"
        );
        assert!(!output_dir.exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn apply_command_rejects_report_output_inside_source() {
        let root = temp_dir("apply-report-source-guard");
        let (game_dir, delta_path) = write_apply_delta(&root);
        let output_dir = root.join("applied");

        let result = run_with_args(
            [
                "apply",
                game_dir.to_str().unwrap(),
                "--patch",
                delta_path.to_str().unwrap(),
                "--output",
                output_dir.to_str().unwrap(),
                "--report-output",
                game_dir.join("report.json").to_str().unwrap(),
            ]
            .iter()
            .map(|arg| arg.to_string())
            .collect(),
        );

        let error = result.unwrap_err().to_string();
        assert!(
            error.contains("apply report output must not be inside source game directory"),
            "{error}"
        );
        assert!(!output_dir.exists());

        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn apply_command_rejects_default_report_sidecar_symlink_to_output() {
        use std::os::unix::fs as unix_fs;

        let root = temp_dir("apply-report-default-sidecar-symlink");
        let (game_dir, delta_path) = write_apply_delta(&root);
        let output_dir = root.join("applied");
        unix_fs::symlink(&output_dir, root.join("applied.kaifuu")).unwrap();

        let result = run_with_args(
            [
                "apply",
                game_dir.to_str().unwrap(),
                "--patch",
                delta_path.to_str().unwrap(),
                "--output",
                output_dir.to_str().unwrap(),
            ]
            .iter()
            .map(|arg| arg.to_string())
            .collect(),
        );

        let error = result.unwrap_err().to_string();
        assert!(
            error.contains("apply report output path must not contain symlinks"),
            "{error}"
        );
        assert!(!output_dir.exists());

        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn apply_command_rejects_report_output_symlink_to_source() {
        use std::os::unix::fs as unix_fs;

        let root = temp_dir("apply-report-output-symlink-source");
        let (game_dir, delta_path) = write_apply_delta(&root);
        let output_dir = root.join("applied");
        let report_link = root.join("report-link");
        unix_fs::symlink(&game_dir, &report_link).unwrap();

        let result = run_with_args(
            [
                "apply",
                game_dir.to_str().unwrap(),
                "--patch",
                delta_path.to_str().unwrap(),
                "--output",
                output_dir.to_str().unwrap(),
                "--report-output",
                report_link.join("report.json").to_str().unwrap(),
            ]
            .iter()
            .map(|arg| arg.to_string())
            .collect(),
        );

        let error = result.unwrap_err().to_string();
        assert!(
            error.contains("apply report output must not be inside source game directory"),
            "{error}"
        );
        assert!(!output_dir.exists());

        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn apply_command_rejects_report_output_symlink_to_output() {
        use std::os::unix::fs as unix_fs;

        let root = temp_dir("apply-report-output-symlink-output");
        let (game_dir, delta_path) = write_apply_delta(&root);
        let output_dir = root.join("applied");
        let report_link = root.join("output-report-link");
        unix_fs::symlink(&output_dir, &report_link).unwrap();

        let result = run_with_args(
            [
                "apply",
                game_dir.to_str().unwrap(),
                "--patch",
                delta_path.to_str().unwrap(),
                "--output",
                output_dir.to_str().unwrap(),
                "--report-output",
                report_link.join("patch-result.json").to_str().unwrap(),
            ]
            .iter()
            .map(|arg| arg.to_string())
            .collect(),
        );

        let error = result.unwrap_err().to_string();
        assert!(
            error.contains("apply report output path must not contain symlinks"),
            "{error}"
        );
        assert!(!output_dir.exists());

        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn apply_command_rejects_canonical_source_report_output_bypass() {
        use std::os::unix::fs as unix_fs;

        let root = temp_dir("apply-report-source-canonical");
        let (game_dir, delta_path) = write_apply_delta(&root);
        let game_link = root.join("game-link");
        unix_fs::symlink(&game_dir, &game_link).unwrap();
        let output_dir = root.join("applied");

        let result = run_with_args(
            [
                "apply",
                game_link.to_str().unwrap(),
                "--patch",
                delta_path.to_str().unwrap(),
                "--output",
                output_dir.to_str().unwrap(),
                "--report-output",
                game_dir.join("report.json").to_str().unwrap(),
            ]
            .iter()
            .map(|arg| arg.to_string())
            .collect(),
        );

        let error = result.unwrap_err().to_string();
        assert!(
            error.contains("apply report output must not be inside source game directory"),
            "{error}"
        );
        assert!(!output_dir.exists());

        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn apply_command_rejects_canonical_output_report_output_bypass() {
        use std::os::unix::fs as unix_fs;

        let root = temp_dir("apply-report-output-canonical");
        let (game_dir, delta_path) = write_apply_delta(&root);
        let real_parent = root.join("real-parent");
        fs::create_dir_all(&real_parent).unwrap();
        let linked_parent = root.join("linked-parent");
        unix_fs::symlink(&real_parent, &linked_parent).unwrap();
        let output_dir = linked_parent.join("applied");

        let result = run_with_args(
            [
                "apply",
                game_dir.to_str().unwrap(),
                "--patch",
                delta_path.to_str().unwrap(),
                "--output",
                output_dir.to_str().unwrap(),
                "--report-output",
                real_parent
                    .join("applied")
                    .join("patch-result.json")
                    .to_str()
                    .unwrap(),
            ]
            .iter()
            .map(|arg| arg.to_string())
            .collect(),
        );

        let error = result.unwrap_err().to_string();
        assert!(
            error.contains("apply report output must not be inside patched output directory"),
            "{error}"
        );
        assert!(!real_parent.join("applied").exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn patch_command_returns_error_when_adapter_reports_failed_patch_result() {
        let root = temp_dir("patch-failed-exit");
        let game_dir = temp_game(&root);
        let bridge_path = root.join("bridge.json");
        run_cli(&[
            "extract",
            game_dir.to_str().unwrap(),
            "--output",
            bridge_path.to_str().unwrap(),
        ]);
        let bridge: BridgeBundle = read_json(&bridge_path).unwrap();
        let patch_export = PatchExport {
            patch_export_id: deterministic_id("patch", 1),
            source_locale: "ja-JP".to_string(),
            target_locale: "en-US".to_string(),
            entries: vec![PatchExportEntry {
                bridge_unit_id: bridge.units[0].bridge_unit_id.clone(),
                source_unit_key: bridge.units[0].source_unit_key.clone(),
                source_hash: bridge.units[0].source_hash.clone(),
                target_text: "Hello, {player}.".to_string(),
                protected_span_mappings: vec![ProtectedSpanMapping::new("{player}", 0, 8)],
            }],
        };
        let patch_export_path = root.join("patch-export.json");
        write_json(&patch_export_path, &patch_export).unwrap();
        let patched_dir = root.join("patched");

        let result = run_with_args(
            [
                "patch",
                game_dir.to_str().unwrap(),
                "--patch",
                patch_export_path.to_str().unwrap(),
                "--output",
                patched_dir.to_str().unwrap(),
            ]
            .iter()
            .map(|arg| arg.to_string())
            .collect(),
        );

        let error = result.unwrap_err().to_string();
        assert!(error.contains("patch failed; see"));
        let patch_result: PatchResult = read_json(&patched_dir.join("patch-result.json")).unwrap();
        assert_eq!(patch_result.status, OperationStatus::Failed);
        assert!(!patched_dir.join("source.json").exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn patch_command_cleans_staging_when_adapter_errors_after_writing() {
        let root = temp_dir("patch-adapter-error-cleanup");
        let game_dir = root.join("game");
        fs::create_dir_all(&game_dir).unwrap();
        let patch_export_path = empty_patch_export(&root, 79);
        let output_dir = root.join("patched-output");
        let registry =
            patch_filesystem_failure_registry(PatchFilesystemFailureMode::AdapterErrAfterWrite);

        let result = run_with_args_and_registry(
            [
                "patch",
                game_dir.to_str().unwrap(),
                "--patch",
                patch_export_path.to_str().unwrap(),
                "--output",
                output_dir.to_str().unwrap(),
            ]
            .iter()
            .map(|arg| arg.to_string())
            .collect(),
            &registry,
        );

        let error = result.unwrap_err().to_string();
        assert!(
            error.contains("adapter failed after writing staged output"),
            "{error}"
        );
        assert!(!output_dir.exists());
        assert_no_patch_staging_entries(&root, "patched-output");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn patch_command_cleans_staging_when_promotion_fails_for_existing_output() {
        let root = temp_dir("patch-promotion-cleanup");
        let game_dir = root.join("game");
        fs::create_dir_all(&game_dir).unwrap();
        let patch_export_path = empty_patch_export(&root, 80);
        let output_dir = root.join("patched-output");
        fs::create_dir_all(&output_dir).unwrap();
        fs::write(output_dir.join("existing.txt"), "existing output\n").unwrap();
        let registry =
            patch_filesystem_failure_registry(PatchFilesystemFailureMode::SuccessfulWrite);

        let result = run_with_args_and_registry(
            [
                "patch",
                game_dir.to_str().unwrap(),
                "--patch",
                patch_export_path.to_str().unwrap(),
                "--output",
                output_dir.to_str().unwrap(),
            ]
            .iter()
            .map(|arg| arg.to_string())
            .collect(),
            &registry,
        );

        let error = result.unwrap_err().to_string();
        assert!(
            error.contains("patch output directory already exists"),
            "{error}"
        );
        assert_eq!(
            fs::read_to_string(output_dir.join("existing.txt")).unwrap(),
            "existing output\n"
        );
        assert!(!output_dir.join("adapter-output.txt").exists());
        assert!(!output_dir.join("patch-result.json").exists());
        assert_no_patch_staging_entries(&root, "patched-output");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn patch_promotion_rejects_empty_directory_created_after_staging() {
        let root = temp_dir("patch-promotion-empty-dir-race");
        let output_dir = root.join("patched-output");
        let staging_dir = allocate_patch_staging_dir(&output_dir).unwrap();
        fs::write(staging_dir.join("adapter-output.txt"), "staged output\n").unwrap();
        fs::create_dir(&output_dir).unwrap();

        let error = promote_patch_staging_dir(&staging_dir, &output_dir)
            .unwrap_err()
            .to_string();

        assert!(
            error.contains("patch output directory already exists"),
            "{error}"
        );
        assert_eq!(
            fs::read_to_string(staging_dir.join("adapter-output.txt")).unwrap(),
            "staged output\n"
        );
        assert!(fs::read_dir(&output_dir).unwrap().next().is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn patch_promotion_rejects_existing_file_without_touching_staging_or_output() {
        let root = temp_dir("patch-promotion-existing-file");
        let output_dir = root.join("patched-output");
        let staging_dir = allocate_patch_staging_dir(&output_dir).unwrap();
        fs::write(staging_dir.join("adapter-output.txt"), "staged output\n").unwrap();
        fs::write(&output_dir, "existing file\n").unwrap();

        let error = promote_patch_staging_dir(&staging_dir, &output_dir)
            .unwrap_err()
            .to_string();

        assert!(
            error.contains("patch output directory already exists"),
            "{error}"
        );
        assert_eq!(
            fs::read_to_string(staging_dir.join("adapter-output.txt")).unwrap(),
            "staged output\n"
        );
        assert_eq!(fs::read_to_string(&output_dir).unwrap(), "existing file\n");
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn patch_promotion_rejects_existing_symlink_like_output() {
        use std::os::unix::fs as unix_fs;

        let root = temp_dir("patch-promotion-existing-symlink");
        let output_dir = root.join("patched-output");
        let linked_target = root.join("linked-target");
        let staging_dir = allocate_patch_staging_dir(&output_dir).unwrap();
        fs::write(staging_dir.join("adapter-output.txt"), "staged output\n").unwrap();
        fs::create_dir(&linked_target).unwrap();
        unix_fs::symlink(&linked_target, &output_dir).unwrap();

        let error = promote_patch_staging_dir(&staging_dir, &output_dir)
            .unwrap_err()
            .to_string();

        assert!(
            error.contains("patch output directory already exists"),
            "{error}"
        );
        assert_eq!(
            fs::read_to_string(staging_dir.join("adapter-output.txt")).unwrap(),
            "staged output\n"
        );
        assert!(
            fs::symlink_metadata(&output_dir)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn patch_command_cleans_staging_when_report_write_fails() {
        let root = temp_dir("patch-report-write-cleanup");
        let game_dir = root.join("game");
        fs::create_dir_all(&game_dir).unwrap();
        let patch_export_path = empty_patch_export(&root, 81);
        let output_dir = root.join("patched-output");
        let registry =
            patch_filesystem_failure_registry(PatchFilesystemFailureMode::ReportWriteCollision);

        let result = run_with_args_and_registry(
            [
                "patch",
                game_dir.to_str().unwrap(),
                "--patch",
                patch_export_path.to_str().unwrap(),
                "--output",
                output_dir.to_str().unwrap(),
            ]
            .iter()
            .map(|arg| arg.to_string())
            .collect(),
            &registry,
        );

        assert!(result.is_err());
        assert!(!output_dir.exists());
        assert_no_patch_staging_entries(&root, "patched-output");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn patch_command_preflight_failure_is_redacted_and_writes_no_output() {
        let root = temp_dir("patch-preflight-redaction");
        let game_dir = root.join("Private Route Spoiler Game");
        fs::create_dir_all(&game_dir).unwrap();
        let patch_export = PatchExport {
            patch_export_id: deterministic_id("patch", 77),
            source_locale: "ja-JP".to_string(),
            target_locale: "en-US".to_string(),
            entries: vec![],
        };
        let patch_export_path = root.join("patch-export.json");
        write_json(&patch_export_path, &patch_export).unwrap();
        let output_dir = root.join("patched-output");
        let registry = preflight_registry();

        let result = run_with_args_and_registry(
            [
                "patch",
                game_dir.to_str().unwrap(),
                "--patch",
                patch_export_path.to_str().unwrap(),
                "--output",
                output_dir.to_str().unwrap(),
            ]
            .iter()
            .map(|arg| arg.to_string())
            .collect(),
            &registry,
        );

        let error = result.unwrap_err().to_string();
        assert!(error.contains("patch preflight failed"), "{error}");
        assert!(
            error.contains(kaifuu_core::SEMANTIC_MISSING_CONTAINER_CAPABILITY),
            "{error}"
        );
        assert!(
            error.contains(kaifuu_core::SEMANTIC_MISSING_CRYPTO_CAPABILITY),
            "{error}"
        );
        assert!(!error.contains("00112233445566778899aabbccddeeff"));
        assert!(!error.contains("/home/dev"));
        assert!(!error.contains("Private Route Spoiler Game"));
        assert!(!error.contains("private-route-name"));
        assert!(!error.contains("helper dump"));
        assert!(!output_dir.exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn patch_command_preflight_blocks_layered_contract_status_before_output_prepare() {
        let root = temp_dir("patch-preflight-contract-status");
        let game_dir = root.join("game");
        fs::create_dir_all(&game_dir).unwrap();
        let patch_export = PatchExport {
            patch_export_id: deterministic_id("patch", 82),
            source_locale: "ja-JP".to_string(),
            target_locale: "en-US".to_string(),
            entries: vec![],
        };
        let patch_export_path = root.join("patch-export.json");
        write_json(&patch_export_path, &patch_export).unwrap();
        let output_dir = root.join("patched-output");
        let registry = contract_status_preflight_registry();

        let result = run_with_args_and_registry(
            [
                "patch",
                game_dir.to_str().unwrap(),
                "--patch",
                patch_export_path.to_str().unwrap(),
                "--output",
                output_dir.to_str().unwrap(),
            ]
            .iter()
            .map(|arg| arg.to_string())
            .collect(),
            &registry,
        );

        let error = result.unwrap_err().to_string();
        assert!(error.contains("patch preflight failed"), "{error}");
        assert!(
            error.contains(kaifuu_core::SEMANTIC_MISSING_PATCH_BACK_CAPABILITY),
            "{error}"
        );
        assert!(!output_dir.exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn patch_command_reports_encoded_string_slot_preflight_without_output_mutation() {
        let root = temp_dir("patch-encoded-string-slot-preflight");
        let game_dir = root.join("game");
        fs::create_dir_all(&game_dir).unwrap();
        fs::write(
            game_dir.join("source.json"),
            r#"{
  "gameId": "encoded-slot-fixture",
  "title": "Encoded Slot Fixture",
  "sourceLocale": "ja-JP",
  "units": [
    {
      "sourceUnitKey": "slot.line.001",
      "speaker": "Narrator",
      "textSurface": "dialogue",
      "sourceText": "Hi",
      "encodedStringSlot": {
        "slotId": "slot.line.001",
        "encoding": "utf_8",
        "byteRange": { "start": 32, "end": 37 },
        "layout": { "kind": "null_terminated", "terminatorHex": "00" },
        "sourceBytesHex": "4869000000"
      }
    }
  ]
}
"#,
        )
        .unwrap();
        let bridge_path = root.join("bridge.json");
        run_cli(&[
            "extract",
            game_dir.to_str().unwrap(),
            "--output",
            bridge_path.to_str().unwrap(),
        ]);
        let bridge: BridgeBundle = read_json(&bridge_path).unwrap();
        let patch_export = PatchExport {
            patch_export_id: deterministic_id("patch", 82),
            source_locale: "ja-JP".to_string(),
            target_locale: "en-US".to_string(),
            entries: vec![PatchExportEntry {
                bridge_unit_id: bridge.units[0].bridge_unit_id.clone(),
                source_unit_key: bridge.units[0].source_unit_key.clone(),
                source_hash: bridge.units[0].source_hash.clone(),
                target_text: "Overflow".to_string(),
                protected_span_mappings: vec![],
            }],
        };
        let patch_export_path = root.join("patch-export.json");
        write_json(&patch_export_path, &patch_export).unwrap();
        let output_dir = root.join("patched-output");

        let result = run_with_args(
            [
                "patch",
                game_dir.to_str().unwrap(),
                "--patch",
                patch_export_path.to_str().unwrap(),
                "--output",
                output_dir.to_str().unwrap(),
            ]
            .iter()
            .map(|arg| arg.to_string())
            .collect(),
        );

        let error = result.unwrap_err().to_string();
        assert!(error.contains("patch preflight failed"), "{error}");
        assert!(error.contains(kaifuu_core::STRING_SLOT_OVERFLOW), "{error}");
        assert!(!output_dir.exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn patch_command_cleans_malicious_adapter_output_on_late_preflight_failure() {
        let root = temp_dir("patch-preflight-malicious-output");
        let game_dir = root.join("malicious-game");
        fs::create_dir_all(&game_dir).unwrap();
        let patch_export = PatchExport {
            patch_export_id: deterministic_id("patch", 78),
            source_locale: "ja-JP".to_string(),
            target_locale: "en-US".to_string(),
            entries: vec![],
        };
        let patch_export_path = root.join("patch-export.json");
        write_json(&patch_export_path, &patch_export).unwrap();
        let output_dir = root.join("patched-output");
        let registry = malicious_registry(AdapterFailure::missing_key_material(
            "kaifuu.test.malicious-preflight",
            "malicious-preflight-test",
            "writes-before-failure",
            "raw-key",
            "path=/home/dev/game helper dump contained 00112233445566778899aabbccddeeff",
        ));

        let result = run_with_args_and_registry(
            [
                "patch",
                game_dir.to_str().unwrap(),
                "--patch",
                patch_export_path.to_str().unwrap(),
                "--output",
                output_dir.to_str().unwrap(),
            ]
            .iter()
            .map(|arg| arg.to_string())
            .collect(),
            &registry,
        );

        let error = result.unwrap_err().to_string();
        assert!(error.contains("patch preflight failed"), "{error}");
        assert!(error.contains(kaifuu_core::SEMANTIC_MISSING_KEY_MATERIAL));
        assert!(!error.contains("/home/dev"));
        assert!(!error.contains("helper dump"));
        assert!(!error.contains("00112233445566778899aabbccddeeff"));
        assert!(!output_dir.exists());
        let leaked_entries = fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains("patched-output") && name.contains("kaifuu-staging"))
            .collect::<Vec<_>>();
        assert_eq!(leaked_entries, Vec::<String>::new());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn patch_command_preflight_blocking_semantic_classes_write_no_output() {
        let cases = vec![
            AdapterFailure::missing_key_material(
                "kaifuu.test.malicious-preflight",
                "semantic-test",
                "missing-key",
                "local-key",
                "missing local key material",
            ),
            AdapterFailure::helper_unavailable(
                "kaifuu.test.malicious-preflight",
                "semantic-test",
                "helper-unavailable",
                "helper unavailable before patching",
            ),
            AdapterFailure::key_validation_failed(
                "kaifuu.test.malicious-preflight",
                "semantic-test",
                "key-validation",
                "local-key",
                "key validation failed before patching",
            ),
            AdapterFailure::protected_executable_unsupported(
                "kaifuu.test.malicious-preflight",
                "semantic-test",
                "protected-exe",
                "protected executable unsupported before patching",
            ),
            AdapterFailure::semantic(
                kaifuu_core::AdapterFailureSemanticParams::new(
                    SemanticErrorCode::UnsupportedLayeredTransform,
                    "kaifuu.test.malicious-preflight",
                    "unsupported layered transform before patching",
                )
                .engine("semantic-test")
                .detected_variant("unsupported-layered-transform"),
            ),
            AdapterFailure::semantic(
                kaifuu_core::AdapterFailureSemanticParams::new(
                    SemanticErrorCode::MissingCodecCapability,
                    "kaifuu.test.malicious-preflight",
                    "codec unavailable before patching",
                )
                .engine("semantic-test")
                .detected_variant("missing-codec")
                .required_capability(Capability::CodecAccess),
            ),
            AdapterFailure::semantic(
                kaifuu_core::AdapterFailureSemanticParams::new(
                    SemanticErrorCode::MissingPatchBackCapability,
                    "kaifuu.test.malicious-preflight",
                    "patch-back unavailable before patching",
                )
                .engine("semantic-test")
                .detected_variant("missing-patch-back")
                .required_capability(Capability::PatchBack),
            ),
        ];

        for (index, failure) in cases.into_iter().enumerate() {
            let root = temp_dir(&format!("patch-preflight-semantic-{index}"));
            let game_dir = root.join("game");
            fs::create_dir_all(&game_dir).unwrap();
            let patch_export = PatchExport {
                patch_export_id: deterministic_id("patch", 790 + index),
                source_locale: "ja-JP".to_string(),
                target_locale: "en-US".to_string(),
                entries: vec![],
            };
            let patch_export_path = root.join("patch-export.json");
            write_json(&patch_export_path, &patch_export).unwrap();
            let output_dir = root.join("patched-output");
            let expected_code = failure.error_code.clone();
            let registry = malicious_registry(failure);

            let result = run_with_args_and_registry(
                [
                    "patch",
                    game_dir.to_str().unwrap(),
                    "--patch",
                    patch_export_path.to_str().unwrap(),
                    "--output",
                    output_dir.to_str().unwrap(),
                ]
                .iter()
                .map(|arg| arg.to_string())
                .collect(),
                &registry,
            );

            let error = result.unwrap_err().to_string();
            assert!(error.contains("patch preflight failed"), "{error}");
            assert!(error.contains(&expected_code), "{error}");
            assert!(!output_dir.exists(), "{expected_code} wrote output");
            let _ = fs::remove_dir_all(root);
        }
    }

    #[test]
    fn golden_command_runs_fixture_round_trip_and_public_translated_patch() {
        let root = temp_dir("golden-public-translated");
        let fixture_dir = public_fixture_dir();
        let report_path = root.join("golden-report.json");
        let work_dir = root.join("golden-work");
        run_cli(&[
            "golden",
            fixture_dir.to_str().unwrap(),
            "--adapter",
            kaifuu_engine_fixture::FIXTURE_ADAPTER_ID,
            "--translated-patch",
            fixture_dir
                .join("expected/patch-export-v0.2.fr-FR.json")
                .to_str()
                .unwrap(),
            "--translated-source-bridge",
            fixture_dir
                .join("expected/bridge-v0.2.json")
                .to_str()
                .unwrap(),
            "--work-dir",
            work_dir.to_str().unwrap(),
            "--output",
            report_path.to_str().unwrap(),
        ]);

        let report: GoldenRoundTripReport = read_json(&report_path).unwrap();
        assert_eq!(report.status, OperationStatus::Passed);
        assert!(report.failures.is_empty());
        assert!(report.phases.iter().any(|phase| {
            phase.phase == "byte_equivalence" && phase.status == GoldenAssertionStatus::Skipped
        }));
        assert!(report.phases.iter().any(|phase| {
            phase.phase == "translated_target_equivalence"
                && phase.status == GoldenAssertionStatus::Passed
        }));
        assert!(
            fs::read_to_string(work_dir.join("translated-patch/source.json"))
                .unwrap()
                .contains("Bonjour, {player}.")
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn golden_command_returns_error_for_v02_translated_patch_without_source_bridge() {
        let root = temp_dir("golden-public-translated-no-source-bridge");
        let fixture_dir = public_fixture_dir();
        let mut patch_export: serde_json::Value =
            read_json(&fixture_dir.join("expected/patch-export-v0.2.fr-FR.json")).unwrap();
        patch_export["entries"][0]["sourceHash"] = serde_json::json!(
            "sha256:0000000000000000000000000000000000000000000000000000000000000000"
        );
        let patch_path = root.join("stale-patch-export.json");
        write_json(&patch_path, &patch_export).unwrap();
        let report_path = root.join("golden-report.json");
        let work_dir = root.join("golden-work");

        let result = run_with_args(
            [
                "golden",
                fixture_dir.to_str().unwrap(),
                "--adapter",
                kaifuu_engine_fixture::FIXTURE_ADAPTER_ID,
                "--translated-patch",
                patch_path.to_str().unwrap(),
                "--work-dir",
                work_dir.to_str().unwrap(),
                "--output",
                report_path.to_str().unwrap(),
            ]
            .iter()
            .map(|arg| arg.to_string())
            .collect(),
        );

        assert!(result.is_err());
        let report: GoldenRoundTripReport = read_json(&report_path).unwrap();
        assert_eq!(report.status, OperationStatus::Failed);
        assert!(report.failures.iter().any(|failure| {
            failure.phase == "translated_source_compatibility"
                && failure.code == "translated_source_bridge_required"
                && failure.actual.as_deref() == Some("missing source bridge")
        }));
        assert!(!report.phases.iter().any(|phase| {
            phase.phase == "translated_patch_conversion" || phase.phase == "translated_patch"
        }));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn golden_command_returns_error_and_report_for_translated_patch_failure() {
        let root = temp_dir("golden-public-translated-failure");
        let fixture_dir = public_fixture_dir();
        let mut patch_export: serde_json::Value =
            read_json(&fixture_dir.join("expected/patch-export-v0.2.fr-FR.json")).unwrap();
        patch_export["entries"][0]["targetText"] = serde_json::json!("Bonjour.");
        let patch_path = root.join("bad-patch-export.json");
        write_json(&patch_path, &patch_export).unwrap();
        let report_path = root.join("golden-report.json");
        let work_dir = root.join("golden-work");

        let result = run_with_args(
            [
                "golden",
                fixture_dir.to_str().unwrap(),
                "--adapter",
                kaifuu_engine_fixture::FIXTURE_ADAPTER_ID,
                "--translated-patch",
                patch_path.to_str().unwrap(),
                "--translated-source-bridge",
                fixture_dir
                    .join("expected/bridge-v0.2.json")
                    .to_str()
                    .unwrap(),
                "--work-dir",
                work_dir.to_str().unwrap(),
                "--output",
                report_path.to_str().unwrap(),
            ]
            .iter()
            .map(|arg| arg.to_string())
            .collect(),
        );

        assert!(result.is_err());
        let report: GoldenRoundTripReport = read_json(&report_path).unwrap();
        assert_eq!(report.status, OperationStatus::Failed);
        assert!(report.failures.iter().any(|failure| {
            failure.phase == "translated_patch"
                && failure.source_unit_key.as_deref() == Some("hello.scene.001.line.001")
                && failure
                    .asset_ref
                    .as_deref()
                    .unwrap_or("")
                    .contains("source.json#hello.scene.001.line.001")
        }));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn detect_unknown_directory_is_non_fatal_and_evidence_based() {
        let root = temp_dir("unknown-detect");
        let game_dir = root.join("unknown-game");
        fs::create_dir_all(&game_dir).unwrap();
        let detect_path = root.join("detect.json");

        run_cli(&[
            "detect",
            game_dir.to_str().unwrap(),
            "--output",
            detect_path.to_str().unwrap(),
        ]);

        let detection_report: DetectionReport = read_json(&detect_path).unwrap();
        assert_eq!(detection_report.status, DetectionReportStatus::Unknown);
        assert_eq!(detection_report.detections.len(), 3);
        let fixture_detection = detection_report
            .detections
            .iter()
            .find(|detection| detection.adapter_id == kaifuu_engine_fixture::FIXTURE_ADAPTER_ID)
            .unwrap();
        assert!(!fixture_detection.detected);
        assert!(fixture_detection.evidence.iter().any(|evidence| {
            evidence.path == "source.json" && evidence.status == EvidenceStatus::Missing
        }));
        let xp3_detection = detection_report
            .detections
            .iter()
            .find(|detection| {
                detection.adapter_id == kaifuu_engine_fixture::XP3_DETECTOR_ADAPTER_ID
            })
            .unwrap();
        assert!(!xp3_detection.detected);
        assert!(xp3_detection.evidence.iter().any(|evidence| {
            evidence.path == "data.xp3" && evidence.status == EvidenceStatus::Missing
        }));
        assert!(
            detection_report
                .detections
                .iter()
                .all(|detection| !detection.detected)
        );
        assert!(detection_report.warnings[0].contains("no registered adapter"));

        let serialized = fs::read_to_string(&detect_path).unwrap();
        assert!(!serialized.contains("confidence"));
        let serialized_report: serde_json::Value = serde_json::from_str(&serialized).unwrap();
        for detection_json in serialized_report["detections"].as_array().unwrap() {
            let detection_json = detection_json.as_object().unwrap();
            assert!(!detection_json.contains_key("engineFamily"));
            assert!(!detection_json.contains_key("engineVersion"));
            assert!(!detection_json.contains_key("detectedVariant"));
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn detect_cli_writes_archive_detection_matrix_without_adapter_support_claim() {
        let root = temp_dir("archive-detect");
        let game_dir = root.join("Private Route Spoiler Game");
        fs::create_dir_all(&game_dir).unwrap();
        write_fixture_file(&game_dir, "game/scripts.rpa", b"RenPy archive synthetic");
        write_fixture_file(
            &game_dir,
            "www/data/System.json",
            br#"{
  "hasEncryptedImages": true,
  "encryptionKey": "00112233445566778899aabbccddeeff"
}"#,
        );
        write_fixture_file(&game_dir, "img/pictures/private-title.rpgmvp", b"encrypted");
        write_fixture_file(&game_dir, "img/pictures/private-title.png_", b"encrypted");
        let detect_path = root.join("detect.json");

        run_cli(&[
            "detect",
            game_dir.to_str().unwrap(),
            "--output",
            detect_path.to_str().unwrap(),
        ]);

        let detection_report: DetectionReport = read_json(&detect_path).unwrap();
        assert_eq!(detection_report.game_dir, REDACTED_DETECTION_GAME_DIR);
        assert_eq!(detection_report.status, DetectionReportStatus::Unknown);
        assert_eq!(
            detection_report.archive_detection.status,
            ArchiveDetectionStatus::Matched
        );
        assert!(!detection_report.detections[0].detected);
        assert!(
            detection_report
                .warnings
                .iter()
                .any(|warning| { warning.contains("no registered extraction adapter") })
        );

        let rpg_maker = detection_report
            .archive_detection
            .rows
            .iter()
            .find(|row| row.row_id == "rpg-maker-mv-mz-encrypted-assets")
            .unwrap();
        assert!(rpg_maker.detected);
        assert!(
            rpg_maker
                .signals
                .contains(&ArchiveDetectionSignal::Encrypted)
        );
        assert!(rpg_maker.evidence.iter().any(|evidence| {
            evidence.pattern == "*.rpgmvp|*.rpgmvm|*.rpgmvo|*.png_|*.m4a_|*.ogg_"
                && evidence.status == EvidenceStatus::Matched
                && evidence.count == 2
        }));
        assert!(
            rpg_maker
                .diagnostics
                .iter()
                .any(|diagnostic| { diagnostic.code == SemanticErrorCode::MissingKeyMaterial })
        );
        assert!(rpg_maker.capabilities.iter().any(|capability| {
            capability.capability == Capability::Extraction
                && capability.status == CapabilityStatus::Unsupported
        }));

        let serialized = fs::read_to_string(&detect_path).unwrap();
        assert!(serialized.contains("\"archiveDetection\""));
        assert!(!serialized.contains(&game_dir.display().to_string()));
        assert!(!serialized.contains("Private Route Spoiler Game"));
        assert!(!serialized.contains("00112233445566778899aabbccddeeff"));
        assert!(!serialized.contains("private-title"));
        assert!(!serialized.contains("confidence"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn detect_cli_matches_public_rpg_maker_encrypted_suffix_fixture_report() {
        let root = temp_dir("public-rpg-maker-suffix-detect");
        let game_dir = public_fixture_path("fixtures/public/kaifuu-rpg-maker-encrypted-suffixes");
        let expected_path = game_dir.join("expected/detection-report-v0.1.json");
        let detect_path = root.join("detect.json");

        run_cli(&[
            "detect",
            game_dir.to_str().unwrap(),
            "--output",
            detect_path.to_str().unwrap(),
        ]);

        let actual: serde_json::Value = read_json(&detect_path).unwrap();
        let expected: serde_json::Value = read_json(&expected_path).unwrap();
        assert_eq!(actual, expected);

        let detection_report: DetectionReport = serde_json::from_value(actual).unwrap();
        assert_eq!(detection_report.status, DetectionReportStatus::Unknown);
        assert_eq!(
            detection_report.archive_detection.status,
            ArchiveDetectionStatus::Matched
        );
        assert!(!detection_report.detections[0].detected);
        let rpg_maker = detection_report
            .archive_detection
            .rows
            .iter()
            .find(|row| row.row_id == "rpg-maker-mv-mz-encrypted-assets")
            .unwrap();
        assert!(rpg_maker.detected);
        assert!(rpg_maker.evidence.iter().any(|evidence| {
            evidence.pattern == "*.rpgmvp|*.rpgmvm|*.rpgmvo|*.png_|*.m4a_|*.ogg_"
                && evidence.status == EvidenceStatus::Matched
                && evidence.count == 6
        }));
        assert!(
            rpg_maker
                .diagnostics
                .iter()
                .any(|diagnostic| { diagnostic.code == SemanticErrorCode::MissingKeyMaterial })
        );
        assert_eq!(rpg_maker.detected_variant, "mv_or_mz_with_unknown_suffix");
        assert!(rpg_maker.surfaces.iter().any(|surface| {
            surface.fixture_id == "kaifuu-rpgmaker-mv-image-rpgmvp"
                && surface.engine_family == "rpgmaker"
                && surface.variant == "mv_or_mz"
                && surface.container == ContainerTransform::ProjectAsset
                && surface.crypto == CryptoTransform::RpgMakerAssetXor
                && surface.codec == CodecTransform::PngImage
                && surface.surface == "image_asset"
                && surface.key_requirement_refs == vec!["rpg-maker-mv-mz-asset-key".to_string()]
        }));
        assert!(rpg_maker.surfaces.iter().any(|surface| {
            surface.fixture_id == "kaifuu-rpgmaker-plain-image-png"
                && surface.variant == "plain_asset"
                && surface.crypto == CryptoTransform::NullKey
                && surface.key_requirement_refs.is_empty()
                && surface.diagnostics.is_empty()
        }));
        let unknown_surfaces = rpg_maker
            .surfaces
            .iter()
            .filter(|surface| surface.variant == "unknown_suffix")
            .collect::<Vec<_>>();
        assert_eq!(unknown_surfaces.len(), 2);
        for surface in unknown_surfaces {
            assert_eq!(surface.crypto, CryptoTransform::Unknown);
            assert!(surface.key_requirement_refs.is_empty());
            assert!(surface.diagnostics.iter().any(|diagnostic| {
                diagnostic.code == SemanticErrorCode::MissingCryptoCapability
            }));
            assert!(
                !surface
                    .diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.code == SemanticErrorCode::MissingKeyMaterial)
            );
        }

        let serialized = fs::read_to_string(&detect_path).unwrap();
        for forbidden in [
            "title.rpgmvp",
            "theme.rpgmvm",
            "cursor.rpgmvo",
            "title.rpgmvu",
            "title.webp_",
        ] {
            assert!(!serialized.contains(forbidden), "report leaked {forbidden}");
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn siglus_detector_profile_fixture_reports_identify_inventory_only() {
        let root = temp_dir("public-siglus-detector");
        let game_dir = public_fixture_path("fixtures/public/kaifuu-encrypted-matrix/raw/siglus");
        let expected_root = public_fixture_path("fixtures/public/kaifuu-encrypted-matrix/expected");

        let detect_path = root.join("siglus-detect.json");
        run_cli(&[
            "detect",
            game_dir.to_str().unwrap(),
            "--output",
            detect_path.to_str().unwrap(),
        ]);
        let actual_detection: serde_json::Value = read_json(&detect_path).unwrap();
        let expected_detection: serde_json::Value =
            read_json(&expected_root.join("siglus-detection-report-v0.1.json")).unwrap();
        assert_eq!(actual_detection, expected_detection);
        let detection_report: DetectionReport =
            serde_json::from_value(actual_detection.clone()).unwrap();
        let siglus_detection = detection_report
            .detections
            .iter()
            .find(|detection| {
                detection.adapter_id == kaifuu_engine_fixture::SIGLUS_DETECTOR_ADAPTER_ID
            })
            .unwrap();
        assert!(siglus_detection.detected);
        assert_eq!(siglus_detection.engine_family.as_deref(), Some("siglus"));
        assert!(siglus_detection.capabilities.iter().any(|capability| {
            capability.capability == Capability::AssetInventory
                && capability.status == CapabilityStatus::Supported
        }));
        assert!(siglus_detection.capabilities.iter().any(|capability| {
            capability.capability == Capability::Extraction
                && capability.status == CapabilityStatus::Unsupported
        }));
        assert!(siglus_detection.capabilities.iter().any(|capability| {
            capability.capability == Capability::RuntimeVm
                && capability.status == CapabilityStatus::Unsupported
        }));

        let profile_path = root.join("siglus-profile.json");
        run_cli(&[
            "profile",
            "init",
            game_dir.to_str().unwrap(),
            "--output",
            profile_path.to_str().unwrap(),
        ]);
        let actual_profile: serde_json::Value = read_json(&profile_path).unwrap();
        let expected_profile: serde_json::Value =
            read_json(&expected_root.join("siglus-detector-profile-v0.1.json")).unwrap();
        assert_eq!(actual_profile, expected_profile);
        let profile: GameProfile = serde_json::from_value(actual_profile).unwrap();
        assert_eq!(profile.profile_id, "019ed000-0000-7000-8000-000000091001");
        assert_eq!(
            profile
                .metadata
                .get("profileDiagnostics.encryptedPayload")
                .map(String::as_str),
            Some("true")
        );
        assert_eq!(
            profile
                .metadata
                .get("profileDiagnostics.unsupportedParserBoundary")
                .map(String::as_str),
            Some("true")
        );
        assert!(profile.assets.iter().all(|asset| {
            asset
                .source_hash
                .as_deref()
                .unwrap_or("")
                .starts_with("sha256:")
        }));
        assert!(profile.capabilities.iter().any(|capability| {
            capability.capability == Capability::Patching
                && capability.status == CapabilityStatus::Unsupported
        }));

        let inventory_path = root.join("siglus-inventory.json");
        run_cli(&[
            "asset-inventory",
            game_dir.to_str().unwrap(),
            "--output",
            inventory_path.to_str().unwrap(),
        ]);
        let actual_inventory: serde_json::Value = read_json(&inventory_path).unwrap();
        let expected_inventory: serde_json::Value =
            read_json(&expected_root.join("siglus-asset-inventory-v0.1.json")).unwrap();
        assert_eq!(actual_inventory, expected_inventory);
        let inventory: AssetInventoryManifest = serde_json::from_value(actual_inventory).unwrap();
        assert_eq!(inventory.validate().status, OperationStatus::Passed);
        assert!(inventory.assets.iter().all(|asset| {
            asset
                .source_hash
                .as_deref()
                .unwrap_or("")
                .starts_with("sha256:")
        }));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn siglus_parser_boundary_smoke_cli_writes_redacted_report_and_blocks_unsupported_opcode() {
        let root = temp_dir("siglus-parser-boundary-smoke");
        let game_dir = public_fixture_path("fixtures/public/kaifuu-encrypted-matrix/raw/siglus");
        let key_request = public_fixture_path(
            "fixtures/public/kaifuu-helper-results/helper-request/siglus-secondary-key-request.json",
        );

        let success_output = root.join("siglus-parser-boundary-success.json");
        run_cli(&[
            "siglus",
            "parser-boundary-smoke",
            "--scene",
            game_dir.join("Scene.pck").to_str().unwrap(),
            "--gameexe",
            game_dir.join("Gameexe.dat").to_str().unwrap(),
            "--key-request",
            key_request.to_str().unwrap(),
            "--output",
            success_output.to_str().unwrap(),
        ]);
        let success: serde_json::Value = read_json(&success_output).unwrap();
        let expected_success: serde_json::Value =
            read_json(&public_fixture_path(
                "fixtures/public/kaifuu-encrypted-matrix/expected/siglus-parser-boundary-smoke-v0.1.json",
            ))
            .unwrap();
        assert_eq!(success, expected_success);
        assert_eq!(success["status"], "passed");
        assert_eq!(success["outcome"], "parser_boundary_success");
        assert_eq!(success["profileId"], "019ed000-0000-7000-8000-000000091001");
        assert_eq!(success["patchWriteAttempted"], false);
        assert_eq!(
            success["textSlots"][0]["textSlotId"],
            "siglus.synthetic.scene.text.001"
        );
        assert_eq!(
            success["textSlots"][0]["byteSpan"],
            serde_json::json!({"startByte": 17, "endByte": 52})
        );

        let unsupported_output = root.join("siglus-parser-boundary-unsupported.json");
        let result = run_with_args(vec![
            "siglus".to_string(),
            "parser-boundary-smoke".to_string(),
            "--scene".to_string(),
            game_dir.join("Scene.pck").to_str().unwrap().to_string(),
            "--gameexe".to_string(),
            game_dir.join("Gameexe.dat").to_str().unwrap().to_string(),
            "--key-request".to_string(),
            key_request.to_str().unwrap().to_string(),
            "--variant".to_string(),
            "unsupported-opcode".to_string(),
            "--output".to_string(),
            unsupported_output.to_str().unwrap().to_string(),
        ]);
        assert!(result.is_err());
        let unsupported: serde_json::Value = read_json(&unsupported_output).unwrap();
        assert_eq!(unsupported["status"], "failed");
        assert_eq!(unsupported["outcome"], "unsupported_opcode");
        assert_eq!(unsupported["patchWriteAttempted"], false);
        assert_eq!(
            unsupported["diagnostics"][0]["semanticCode"],
            kaifuu_core::SEMANTIC_SIGLUS_UNSUPPORTED_OPCODE
        );
        assert_eq!(
            unsupported["diagnostics"][0]["unsupportedOpcode"],
            "SIGLUS_SYNTH_UNSUPPORTED_7f"
        );

        for output in [success_output, unsupported_output] {
            let serialized = fs::read_to_string(output).unwrap();
            for forbidden in [
                "rawKey",
                "keyMaterial",
                "00112233445566778899aabbccddeeff",
                "fixture-only-siglus-secondary-key-v1",
                "decrypted script",
                "/home/",
                "C:\\",
            ] {
                assert!(!serialized.contains(forbidden), "leaked {forbidden}");
            }
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn xp3_detector_profile_fixture_reports_variant_profiles_and_unknown_diagnostics() {
        let root = temp_dir("public-xp3-detector");
        let fixture_root = public_fixture_path("fixtures/public/kaifuu-encrypted-matrix");
        let expected_root = fixture_root.join("expected");

        for (variant, expected_name) in [
            ("plain", "xp3-plain-detector-profile-v0.1.json"),
            ("encrypted", "xp3-encrypted-detector-profile-v0.1.json"),
            ("compressed", "xp3-compressed-detector-profile-v0.1.json"),
        ] {
            let game_dir = fixture_root.join("xp3-profiles").join(variant);
            let profile_path = root.join(format!("xp3-{variant}-profile.json"));
            run_cli(&[
                "profile",
                "init",
                game_dir.to_str().unwrap(),
                "--output",
                profile_path.to_str().unwrap(),
            ]);
            let actual_profile: serde_json::Value = read_json(&profile_path).unwrap();
            let expected_profile: serde_json::Value =
                read_json(&expected_root.join(expected_name)).unwrap();
            assert_eq!(actual_profile, expected_profile);

            let profile: GameProfile = serde_json::from_value(actual_profile).unwrap();
            assert_eq!(
                profile.engine.adapter_id,
                kaifuu_engine_fixture::XP3_DETECTOR_ADAPTER_ID
            );
            assert_eq!(profile.validate().status, OperationStatus::Passed);
            assert!(profile.capabilities.iter().any(|capability| {
                capability.capability == Capability::Extraction
                    && capability.status == CapabilityStatus::Unsupported
            }));
            if variant == "encrypted" {
                assert_eq!(profile.key_requirements.len(), 1);
                assert!(
                    profile
                        .layered_access
                        .as_ref()
                        .unwrap()
                        .surfaces
                        .iter()
                        .any(|surface| surface.key_requirement_refs
                            == vec!["kirikiri-xp3-key-profile".to_string()])
                );
            }
            if variant == "compressed" {
                assert!(profile.archive_parameters.iter().any(|parameter| {
                    parameter.kind == kaifuu_core::ArchiveParameterKind::Compression
                        && parameter.value == "compressed"
                }));
            }
        }

        let unknown_dir = fixture_root.join("xp3-profiles/unknown");
        let detect_path = root.join("xp3-unknown-detect.json");
        run_cli(&[
            "detect",
            unknown_dir.to_str().unwrap(),
            "--output",
            detect_path.to_str().unwrap(),
        ]);
        let actual_detection: serde_json::Value = read_json(&detect_path).unwrap();
        let expected_detection: serde_json::Value =
            read_json(&expected_root.join("xp3-unknown-detection-report-v0.1.json")).unwrap();
        assert_eq!(actual_detection, expected_detection);
        let detection_report: DetectionReport = serde_json::from_value(actual_detection).unwrap();
        assert_eq!(detection_report.status, DetectionReportStatus::Unknown);
        let xp3_detection = detection_report
            .detections
            .iter()
            .find(|detection| {
                detection.adapter_id == kaifuu_engine_fixture::XP3_DETECTOR_ADAPTER_ID
            })
            .unwrap();
        assert!(!xp3_detection.detected);
        assert_eq!(
            xp3_detection.detected_variant.as_deref(),
            Some("xp3-unknown-container")
        );
        let xp3_archive = detection_report
            .archive_detection
            .rows
            .iter()
            .find(|row| row.row_id == "kirikiri-xp3")
            .unwrap();
        assert!(
            xp3_archive
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == SemanticErrorCode::UnknownEngineVariant)
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn xp3_inventory_cli_reports_plain_file_table_separately_from_extract_and_patch() {
        let root = temp_dir("xp3-inventory-cli");
        let game_dir = root.join("game");
        fs::create_dir_all(&game_dir).unwrap();
        fs::write(
            game_dir.join("data.xp3"),
            plain_xp3_fixture(&[
                Xp3TestEntry {
                    path: "scenario/intro.ks",
                    payload: b"plain text payload",
                    compressed: false,
                    adler32: 0x0102_0304,
                },
                Xp3TestEntry {
                    path: "image/title.png",
                    payload: b"compressed-image-bytes",
                    compressed: true,
                    adler32: 0x0506_0708,
                },
            ]),
        )
        .unwrap();
        let inventory_path = root.join("inventory.json");

        run_cli(&[
            "asset-inventory",
            game_dir.to_str().unwrap(),
            "--output",
            inventory_path.to_str().unwrap(),
        ]);

        let inventory: AssetInventoryManifest = read_json(&inventory_path).unwrap();
        assert_eq!(
            inventory.adapter_id,
            kaifuu_engine_fixture::XP3_DETECTOR_ADAPTER_ID
        );
        assert_eq!(inventory.validate().status, OperationStatus::Passed);
        assert!(inventory.capabilities.iter().any(|capability| {
            capability.capability == Capability::AssetInventory
                && capability.status == CapabilityStatus::Supported
        }));
        assert!(inventory.capabilities.iter().any(|capability| {
            capability.capability == Capability::Extraction
                && capability.status == CapabilityStatus::Unsupported
        }));
        assert!(inventory.capabilities.iter().any(|capability| {
            capability.capability == Capability::Patching
                && capability.status == CapabilityStatus::Unsupported
        }));

        let script = inventory
            .assets
            .iter()
            .find(|asset| asset.asset_key == "scenario/intro.ks")
            .unwrap();
        let script_hash = sha256_hash_bytes(b"plain text payload");
        assert_eq!(script.source_hash.as_deref(), Some(script_hash.as_str()));
        assert_eq!(
            script.metadata.get("profileId").map(String::as_str),
            Some("019ed000-0000-7000-8000-000000095001")
        );
        assert_eq!(
            script.metadata.get("compressed").map(String::as_str),
            Some("false")
        );

        let image = inventory
            .assets
            .iter()
            .find(|asset| asset.asset_key == "image/title.png")
            .unwrap();
        assert_eq!(image.asset_kind, AssetInventoryAssetKind::Image);
        assert_eq!(
            image.metadata.get("compressed").map(String::as_str),
            Some("true")
        );
        assert_eq!(
            image.metadata.get("storedAdler32").map(String::as_str),
            Some("adler32:05060708")
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn xp3_inventory_cli_reports_public_plain_profile_entries() {
        let root = temp_dir("public-xp3-inventory-cli");
        let fixture_root = public_fixture_path("fixtures/public/kaifuu-encrypted-matrix");
        let game_dir = fixture_root.join("xp3-profiles/plain");
        let inventory_path = root.join("inventory.json");

        run_cli(&[
            "asset-inventory",
            game_dir.to_str().unwrap(),
            "--output",
            inventory_path.to_str().unwrap(),
        ]);

        let inventory: AssetInventoryManifest = read_json(&inventory_path).unwrap();
        assert_eq!(
            inventory.adapter_id,
            kaifuu_engine_fixture::XP3_DETECTOR_ADAPTER_ID
        );
        assert_eq!(inventory.validate().status, OperationStatus::Passed);

        let archive = inventory
            .assets
            .iter()
            .find(|asset| asset.asset_key == "data.xp3")
            .unwrap();
        assert_eq!(
            archive.metadata.get("profileId").map(String::as_str),
            Some("019ed000-0000-7000-8000-000000095001")
        );
        assert_eq!(
            archive.metadata.get("entryCount").map(String::as_str),
            Some("3")
        );

        let intro = inventory
            .assets
            .iter()
            .find(|asset| asset.asset_key == "scenario/intro.ks")
            .unwrap();
        assert_eq!(intro.asset_kind, AssetInventoryAssetKind::Script);
        assert_eq!(
            intro.source_hash.as_deref(),
            Some(sha256_hash_bytes(b"hello public xp3\n").as_str())
        );
        assert_eq!(
            intro.metadata.get("originalSize").map(String::as_str),
            Some("17")
        );
        assert_eq!(
            intro.metadata.get("archiveSize").map(String::as_str),
            Some("17")
        );
        assert_eq!(
            intro.metadata.get("compressed").map(String::as_str),
            Some("false")
        );
        assert_eq!(
            intro.metadata.get("profileId").map(String::as_str),
            Some("019ed000-0000-7000-8000-000000095001")
        );

        let compressed = inventory
            .assets
            .iter()
            .find(|asset| asset.asset_key == "scenario/compressed.ks")
            .unwrap();
        assert_eq!(
            compressed.source_hash.as_deref(),
            Some(sha256_hash_bytes(b"compressed public payload\n").as_str())
        );
        assert_eq!(
            compressed.metadata.get("originalSize").map(String::as_str),
            Some("26")
        );
        assert_eq!(
            compressed.metadata.get("archiveSize").map(String::as_str),
            Some("26")
        );
        assert_eq!(
            compressed.metadata.get("compressed").map(String::as_str),
            Some("true")
        );
        assert_eq!(
            compressed.metadata.get("storedAdler32").map(String::as_str),
            Some("adler32:33334444")
        );
        assert_eq!(
            compressed.metadata.get("profileId").map(String::as_str),
            Some("019ed000-0000-7000-8000-000000095001")
        );

        let image = inventory
            .assets
            .iter()
            .find(|asset| asset.asset_key == "image/title.png")
            .unwrap();
        assert_eq!(image.asset_kind, AssetInventoryAssetKind::Image);
        assert_eq!(
            image.source_hash.as_deref(),
            Some(sha256_hash_bytes(b"png fixture bytes\n").as_str())
        );
        assert_eq!(
            image.metadata.get("originalSize").map(String::as_str),
            Some("18")
        );
        assert_eq!(
            image.metadata.get("archiveSize").map(String::as_str),
            Some("18")
        );
        assert_eq!(
            image.metadata.get("compressed").map(String::as_str),
            Some("false")
        );
        assert_eq!(
            image.metadata.get("profileId").map(String::as_str),
            Some("019ed000-0000-7000-8000-000000095001")
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn xp3_inventory_cli_rejects_encrypted_and_helper_required_profiles() {
        let root = temp_dir("xp3-inventory-cli-diagnostics");
        let encrypted_dir = root.join("encrypted");
        fs::create_dir_all(&encrypted_dir).unwrap();
        fs::write(
            encrypted_dir.join("data.xp3"),
            b"XP3\r\nXP3-CRYPT\nfixture-only encrypted archive",
        )
        .unwrap();
        let encrypted_output = root.join("encrypted.json");
        let encrypted_error = run_cli_with_registry_result(
            &[
                "asset-inventory",
                encrypted_dir.to_str().unwrap(),
                "--output",
                encrypted_output.to_str().unwrap(),
            ],
            &engine_registry(),
        )
        .unwrap_err()
        .to_string();
        assert!(encrypted_error.contains("kaifuu.missing_capability.crypto"));

        let helper_dir = root.join("helper");
        fs::create_dir_all(&helper_dir).unwrap();
        fs::write(
            helper_dir.join("data.xp3"),
            b"XP3\r\nXP3-HELPER-REQUIRED\nfixture-only helper-required archive",
        )
        .unwrap();
        let helper_output = root.join("helper.json");
        let helper_error = run_cli_with_registry_result(
            &[
                "asset-inventory",
                helper_dir.to_str().unwrap(),
                "--output",
                helper_output.to_str().unwrap(),
            ],
            &engine_registry(),
        )
        .unwrap_err()
        .to_string();
        assert!(helper_error.contains("kaifuu.helper_required"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn siglus_detector_reports_missing_pair_and_unknown_variant_diagnostics() {
        let root = temp_dir("siglus-detector-diagnostics");
        let source_fixture =
            public_fixture_path("fixtures/public/kaifuu-encrypted-matrix/raw/siglus/Scene.pck");
        let missing_pair_dir = root.join("missing-pair");
        fs::create_dir_all(&missing_pair_dir).unwrap();
        fs::copy(&source_fixture, missing_pair_dir.join("Scene.pck")).unwrap();

        let missing_pair_detect = root.join("missing-pair-detect.json");
        run_cli(&[
            "detect",
            missing_pair_dir.to_str().unwrap(),
            "--output",
            missing_pair_detect.to_str().unwrap(),
        ]);
        let missing_report: DetectionReport = read_json(&missing_pair_detect).unwrap();
        let missing_siglus = missing_report
            .detections
            .iter()
            .find(|detection| {
                detection.adapter_id == kaifuu_engine_fixture::SIGLUS_DETECTOR_ADAPTER_ID
            })
            .unwrap();
        assert!(!missing_siglus.detected);
        assert_eq!(
            missing_siglus.detected_variant.as_deref(),
            Some("scene-pck-missing-gameexe-dat")
        );
        assert!(missing_siglus.requirements.iter().any(|requirement| {
            requirement.key == "Gameexe.dat" && requirement.status == RequirementStatus::Missing
        }));

        let unknown_dir = root.join("unknown-variant");
        fs::create_dir_all(&unknown_dir).unwrap();
        fs::write(
            unknown_dir.join("Scene.pck"),
            b"fixture-only unknown siglus-like scene",
        )
        .unwrap();
        fs::write(
            unknown_dir.join("Gameexe.dat"),
            b"fixture-only unknown siglus-like metadata",
        )
        .unwrap();
        let unknown_detect = root.join("unknown-detect.json");
        run_cli(&[
            "detect",
            unknown_dir.to_str().unwrap(),
            "--output",
            unknown_detect.to_str().unwrap(),
        ]);
        let report: DetectionReport = read_json(&unknown_detect).unwrap();
        let siglus = report
            .detections
            .iter()
            .find(|detection| {
                detection.adapter_id == kaifuu_engine_fixture::SIGLUS_DETECTOR_ADAPTER_ID
            })
            .unwrap();
        assert!(!siglus.detected);
        assert_eq!(
            siglus.detected_variant.as_deref(),
            Some("unknown-siglus-named-files")
        );
        assert!(siglus.requirements.iter().any(|requirement| {
            requirement.key == "siglus-synthetic-signature"
                && requirement.status == RequirementStatus::Unsupported
        }));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn detect_source_without_units_has_no_engine_version() {
        let root = temp_dir("source-without-units-detect");
        let game_dir = root.join("unknown-fixture-like-game");
        fs::create_dir_all(&game_dir).unwrap();
        fs::write(
            game_dir.join("source.json"),
            r#"{
  "gameId": "not-fixture-yet",
  "title": "Not Fixture Yet",
  "sourceLocale": "ja-JP"
}
"#,
        )
        .unwrap();
        let detect_path = root.join("detect.json");

        run_cli(&[
            "detect",
            game_dir.to_str().unwrap(),
            "--output",
            detect_path.to_str().unwrap(),
        ]);

        let detection_report: DetectionReport = read_json(&detect_path).unwrap();
        assert_eq!(detection_report.status, DetectionReportStatus::Unknown);
        let detection = &detection_report.detections[0];
        assert!(!detection.detected);
        assert_eq!(detection.engine_family, None);
        assert_eq!(detection.engine_version, None);
        assert_eq!(detection.detected_variant, None);
        assert!(detection.evidence.iter().any(|evidence| {
            evidence.path == "source.json"
                && evidence.status == EvidenceStatus::Missing
                && evidence.detail.contains("missing units")
        }));
        let serialized: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&detect_path).unwrap()).unwrap();
        let detection_json = serialized["detections"][0].as_object().unwrap();
        assert!(!detection_json.contains_key("engineFamily"));
        assert!(!detection_json.contains_key("engineVersion"));
        assert!(!detection_json.contains_key("detectedVariant"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn profile_init_is_stable_across_repeated_cli_runs() {
        let root = temp_dir("profile-init-stability");
        let game_dir = temp_game(&root);
        let first_path = root.join("profile-first.json");
        let second_path = root.join("profile-second.json");

        run_cli(&[
            "profile",
            "init",
            game_dir.to_str().unwrap(),
            "--output",
            first_path.to_str().unwrap(),
        ]);
        run_cli(&[
            "profile",
            "init",
            game_dir.to_str().unwrap(),
            "--output",
            second_path.to_str().unwrap(),
        ]);

        assert_eq!(
            fs::read_to_string(&first_path).unwrap(),
            fs::read_to_string(&second_path).unwrap()
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn profile_validation_reports_missing_required_fields() {
        let root = temp_dir("profile-validation-failure");
        let profile_path = root.join("profile.json");
        let validation_path = root.join("validation.json");
        fs::write(
            &profile_path,
            r#"{
  "schemaVersion": "0.1.0",
  "profileId": "",
  "gameId": "broken-game",
  "title": "Broken Game",
  "sourceLocale": "ja-JP",
  "engine": {
    "adapterId": "kaifuu.fixture",
    "engineFamily": "fixture",
    "engineVersion": null,
    "detectedVariant": ""
  },
  "assets": [],
  "capabilities": [],
  "requirements": [
    {
      "category": "secret_key",
      "key": "archive_key",
      "status": "missing",
      "description": "archive key must be provided out of band",
      "placeholder": "KAIFUU_ARCHIVE_KEY",
      "secret": true
    }
  ],
  "metadata": {}
}
"#,
        )
        .unwrap();

        run_cli(&[
            "profile",
            "validate",
            profile_path.to_str().unwrap(),
            "--output",
            validation_path.to_str().unwrap(),
        ]);

        let validation: kaifuu_core::ProfileValidationResult = read_json(&validation_path).unwrap();
        assert_eq!(validation.status, OperationStatus::Failed);
        assert!(validation.failures.iter().any(|failure| {
            failure.code == "missing_required_field" && failure.field == "profileId"
        }));
        assert!(validation.failures.iter().any(|failure| {
            failure.code == "missing_requirement" && failure.field == "requirements.archive_key"
        }));
        let serialized = fs::read_to_string(&validation_path).unwrap();
        assert!(serialized.contains("KAIFUU_ARCHIVE_KEY"));
        assert!(!serialized.contains("actual-secret"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn profile_validation_redacts_secret_bearing_key_profile_fields() {
        let root = temp_dir("profile-validation-redaction");
        let profile_path = root.join("profile.json");
        let validation_path = root.join("validation.json");
        fs::write(
            &profile_path,
            r#"{
  "schemaVersion": "0.1.0",
  "profileId": "019ed000-0000-7000-8000-profile00014",
  "gameId": "siglus-owned-local",
  "title": "Siglus Owned Local",
  "sourceLocale": "ja-JP",
  "engine": {
    "adapterId": "kaifuu.siglus",
    "engineFamily": "siglus",
    "engineVersion": null,
    "detectedVariant": "scene-pck-secondary-key"
  },
  "sourceFingerprint": {
    "gameRootHash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "engineEvidence": ["Scene.pck", "Gameexe.dat"]
  },
  "keyRequirements": [
    {
      "requirementId": "siglus-secondary-key",
      "secretRef": "local-secret:siglus/example/secondary-key",
      "kind": "fixedBytes",
      "bytes": 16,
      "rawKey": "00112233445566778899aabbccddeeff",
      "validation": {
        "method": "decryptHeaderProof",
        "proofHash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      }
    }
  ],
  "archiveParameters": [
    {
      "parameterId": "scene-cipher-key",
      "name": "cipherKey",
      "kind": "cipherScheme",
      "value": "mP9xZpQ2rS7vLj4N8aW_KtYd0hF3uC6b",
      "source": "manual"
    }
  ],
  "helperEvidence": {
    "helperKind": "staticParser",
    "toolVersion": "kaifuu-key-helper/0.1.0",
    "redactedLogHash": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "helperDump": "register dump with local key bytes"
  },
  "assets": [
    {
      "assetId": "019ed000-0000-7000-8000-asset0000014",
      "path": "Scene.pck",
      "assetKind": "archive",
      "textSurfaces": ["dialogue"],
      "sourceHash": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      "patching": {
        "capability": "patching",
        "status": "limited",
        "limitation": "requires caller-provided resolved keys and archive parameters"
      }
    }
  ],
  "capabilities": [
    {
      "capability": "key_profile",
      "status": "supported",
      "limitation": null
    },
    {
      "capability": "patching",
      "status": "limited",
      "limitation": "requires caller-provided resolved keys and archive parameters"
    }
  ],
  "requirements": [
    {
      "category": "secret_key",
      "key": "siglus-secondary-key",
      "status": "satisfied",
      "description": "secondary key is referenced through local secret storage",
      "placeholder": null,
      "secret": true
    }
  ],
  "metadata": {
    "localPath": "/home/dev/private-game",
    "decryptedText": "private script line"
  }
}
"#,
        )
        .unwrap();

        run_cli(&[
            "profile",
            "validate",
            profile_path.to_str().unwrap(),
            "--output",
            validation_path.to_str().unwrap(),
        ]);

        let validation: kaifuu_core::ProfileValidationResult = read_json(&validation_path).unwrap();
        assert_eq!(validation.status, OperationStatus::Failed);
        for field in [
            "keyRequirements.0.rawKey",
            "archiveParameters.0.value",
            "helperEvidence.helperDump",
            "metadata.localPath",
            "metadata.decryptedText",
        ] {
            assert!(
                validation.failures.iter().any(|failure| {
                    failure.code == kaifuu_core::SEMANTIC_SECRET_REDACTED && failure.field == field
                }),
                "missing secret redaction failure for {field}: {:#?}",
                validation.failures
            );
        }
        let serialized = fs::read_to_string(&validation_path).unwrap();
        assert!(!serialized.contains("00112233445566778899aabbccddeeff"));
        assert!(!serialized.contains("mP9xZpQ2rS7vLj4N8aW_KtYd0hF3uC6b"));
        assert!(!serialized.contains("/home/dev/private-game"));
        assert!(!serialized.contains("private script line"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn profile_validation_redacts_requirement_free_text_fields() {
        let root = temp_dir("profile-validation-requirement-redaction");
        let profile_path = root.join("profile.json");
        let validation_path = root.join("validation.json");
        fs::write(
            &profile_path,
            r#"{
  "schemaVersion": "0.1.0",
  "profileId": "019ed000-0000-7000-8000-profile00015",
  "gameId": "sensitive-requirements",
  "title": "Sensitive Requirements",
  "sourceLocale": "ja-JP",
  "engine": {
    "adapterId": "kaifuu.fixture",
    "engineFamily": "fixture",
    "engineVersion": null,
    "detectedVariant": "plain-json-source"
  },
  "assets": [],
  "capabilities": [
    {
      "capability": "patching",
      "status": "limited",
      "limitation": "requires profile validation"
    }
  ],
  "requirements": [
    {
      "category": "secret_key",
      "key": "archive-key",
      "status": "missing",
      "description": "helper dump source:/home/dev/game/private-route-ending.ks exposed raw key 00112233445566778899aabbccddeeff",
      "placeholder": "file=C:\\Games\\SecretRoute\\key.bin",
      "secret": true
    },
    {
      "category": "file",
      "key": "story-script",
      "status": "unsupported",
      "description": "decrypted text from private-route-ending.ks must remain local",
      "placeholder": null,
      "secret": false
    }
  ],
  "metadata": {}
}
"#,
        )
        .unwrap();

        run_cli(&[
            "profile",
            "validate",
            profile_path.to_str().unwrap(),
            "--output",
            validation_path.to_str().unwrap(),
        ]);

        let validation: kaifuu_core::ProfileValidationResult = read_json(&validation_path).unwrap();
        assert_eq!(validation.status, OperationStatus::Failed);
        for field in [
            "requirements.0.description",
            "requirements.0.placeholder",
            "requirements.1.description",
        ] {
            assert!(
                validation.failures.iter().any(|failure| {
                    failure.code == kaifuu_core::SEMANTIC_SECRET_REDACTED && failure.field == field
                }),
                "missing requirement redaction failure for {field}: {:#?}",
                validation.failures
            );
        }
        let serialized = fs::read_to_string(&validation_path).unwrap();
        assert!(serialized.contains(kaifuu_core::SEMANTIC_SECRET_REDACTED));
        for forbidden in [
            "/home/dev/game",
            "C:\\Games",
            "helper dump",
            "decrypted text",
            "00112233445566778899aabbccddeeff",
            "private-route-ending.ks",
            "SecretRoute",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "validation leaked {forbidden}"
            );
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn profile_validation_reports_malformed_profile_fields() {
        let root = temp_dir("profile-validation-malformed");
        let profile_path = root.join("profile.json");
        let validation_path = root.join("validation.json");
        fs::write(
            &profile_path,
            r#"{
  "schemaVersion": "9.9.9",
  "profileId": "bad profile id",
  "gameId": "broken-game",
  "title": "Broken Game",
  "sourceLocale": "ja_JP",
  "engine": {
    "adapterId": "kaifuu.fixture",
    "engineFamily": "fixture",
    "engineVersion": "",
    "detectedVariant": "plain-json-source"
  },
  "assets": [
    {
      "assetId": "bad asset",
      "path": "../source.json",
      "assetKind": "scriptish",
      "textSurfaces": ["dialogue", "dialogue", "bad_surface"],
      "sourceHash": "",
      "patching": {
        "capability": "line_parity_patching",
        "status": "limited",
        "limitation": ""
      }
    }
  ],
  "capabilities": [
    {
      "capability": "detection",
      "status": "supported",
      "limitation": "unexpected"
    },
    {
      "capability": "detection",
      "status": "supported",
      "limitation": null
    }
  ],
  "requirements": [
    {
      "category": "secret_key",
      "key": "archive key",
      "status": "blocked",
      "description": "",
      "placeholder": null,
      "secret": true
    }
  ],
  "metadata": {}
}
"#,
        )
        .unwrap();

        run_cli(&[
            "profile",
            "validate",
            profile_path.to_str().unwrap(),
            "--output",
            validation_path.to_str().unwrap(),
        ]);

        let validation: kaifuu_core::ProfileValidationResult = read_json(&validation_path).unwrap();
        assert_eq!(validation.status, OperationStatus::Failed);
        for expected_code in [
            "unsupported_schema_version",
            "invalid_locale",
            "invalid_engine_version",
            "invalid_asset_id",
            "invalid_asset_path",
            "invalid_enum_value",
            "duplicate_text_surface",
            "invalid_text_surface",
            "invalid_source_hash",
            "missing_capability_limitation",
            "unexpected_capability_limitation",
            "duplicate_capability",
            "invalid_requirement_key",
            "inconsistent_capability",
        ] {
            assert!(
                validation
                    .failures
                    .iter()
                    .any(|failure| failure.code == expected_code),
                "missing validation failure code {expected_code}: {:#?}",
                validation.failures
            );
        }
        let serialized = fs::read_to_string(&validation_path).unwrap();
        assert!(!serialized.contains("confidence"));
        assert!(!serialized.contains("actual-secret"));

        let _ = fs::remove_dir_all(root);
    }
}
