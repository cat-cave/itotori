use std::path::{Path, PathBuf};

use crate::{
    HelperBinaryLaunchValidationRequest, HelperCapability, HelperRegistryInvocationRequest,
    allocate_patch_staging_dir, atomic_write_text, fixture_helper_registry, flag, flag_optional,
    flag_present, flag_values, normalize_helper_result_value, parse_helper_capability, positional,
    read_json, redact_report_value, remove_patch_staging_dir, validate_helper_registry_entry_value,
    validate_helper_result_value, write_json,
};

pub(crate) fn run_helper_registry_command(
    args: &[String],
) -> Result<(), Box<dyn std::error::Error>> {
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
            // A request normally selects its registered helper through
            // `helperId`. An explicit `--helper-id` selects the dispatch entry
            // instead, so a fixture which intentionally claims the wrong
            // helper can be evaluated by the registered stub and produce the
            // same structured boundary diagnostic as core. Without that
            // override, an unregistered request id still fails closed before
            // any helper adapter is invoked.
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
            // Bind the validated bytes to execution through a trusted staging
            // COPY: the helper binary is copied into a fresh
            // Kaifuu-owned staging directory the untrusted source cannot write,
            // the hash is validated against the STAGED bytes, and the staged
            // copy is the execution reference — a swap of `executable_path`
            // after this check cannot change what would run. The staged copy is
            // dropped (removed) when `outcome` goes out of scope.
            let staging_dir = allocate_patch_staging_dir(&output)?;
            let outcome = entry.stage_and_validate_binary_launch(
                HelperBinaryLaunchValidationRequest {
                    helper_id: &entry.helper_id,
                    allowlist_entry_id,
                    executable_path: &executable_path,
                    platform,
                    helper_version,
                    required_capabilities: &required_capabilities,
                },
                &staging_dir,
            );
            let result = outcome.validation.redacted_for_report();
            let failed = result.status == kaifuu_core::OperationStatus::Failed;
            let write_result = write_json(&output, &result);
            // Drop the staged execution reference (removes the staged copy) and
            // then clear the trusted staging directory.
            drop(outcome);
            remove_patch_staging_dir(&staging_dir)?;
            write_result?;
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
                "usage: kaifuu helper-registry <validate <entry.json>|check-binary <entry.json>|invoke-fixture-stub [--input <request.json>] [--helper-id <registered-id>]> --output <report.json>\n  invoke-fixture-stub derives its dispatch helper from input.helperId. Pass --helper-id kaifuu.fixture.helper-stub only when a fixture intentionally rejects that request helper id and needs the registered stub to emit its structured boundary diagnostic; an unregistered dispatch id fails closed."
                    .into(),
            );
        }
    }
    Ok(())
}

pub(crate) fn run_helper_result_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
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

pub(crate) fn run_helper_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    match positional(args, 1)? {
        "run" => run_helper_run_command(args),
        "dry-run" => run_helper_dry_run_command(args),
        "quoting-fixture" => run_helper_quoting_fixture_command(args),
        _ => Err(
            "usage: kaifuu helper <run|dry-run|quoting-fixture> ...\n  run --out <helper-result.json> [--input <request.json>] [--mode stub]\n  dry-run [--platform wine-proton|native-windows] --input <request.json> --out <resolution.json>\n  quoting-fixture --out <fixture.json>"
                .into(),
        ),
    }
}

/// Resolves a Wine/Proton dry-run: names the helper binary id, platform
/// adapter, intended command, profile id, and redaction policy WITHOUT ever
/// launching untrusted game code. No Wine/Proton install is required — the
/// synthetic request declares availability, and an unavailable platform yields
/// a typed `helper_unavailable` diagnostic rather than a crash. A resolution
/// carrying raw secret material (or asserting a launch) fails.
fn run_helper_dry_run_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    // The dry-run path never spawns a process, but reject execution-config
    // flags anyway for a consistent posture with `helper run`.
    reject_helper_execution_config_flags(args)?;
    match flag_optional(args, "--platform").unwrap_or("wine-proton") {
        "wine-proton" => run_wine_proton_dry_run_command(args),
        "native-windows" => run_native_windows_dry_run_command(args),
        other => Err(format!(
            "unsupported dry-run platform {other:?}; expected wine-proton or native-windows"
        )
        .into()),
    }
}

fn run_wine_proton_dry_run_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let input_path = PathBuf::from(flag(args, "--input")?);
    reject_env_file_path(&input_path)?;
    let output = PathBuf::from(flag(args, "--out").or_else(|_| flag(args, "--output"))?);

    let value: serde_json::Value = read_json(&input_path)?;
    let request: kaifuu_core::WineProtonDryRunRequest = serde_json::from_value(value)
        .map_err(|error| format!("invalid Wine/Proton dry-run request: {error}"))?;
    let resolution = kaifuu_core::resolve_wine_proton_dry_run(&request);

    let validation = resolution.validate();
    if validation.status == kaifuu_core::OperationStatus::Failed {
        return Err(format!(
            "Wine/Proton dry-run resolution failed validation for fixture {}: {}",
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

    atomic_write_text(&output, &resolution.stable_json()?)?;
    Ok(())
}

/// Resolves a native-Windows dry-run: records the platform adapter
/// (native-windows), helper binary id, command argv + CommandLineToArgvW-quoted
/// command line, working-directory policy, profile id, and redaction policy
/// WITHOUT launching untrusted game code. No Windows host is required — the
/// synthetic request declares availability, and a non-Windows runner yields a
/// typed `helper_unavailable` diagnostic rather than a failure. A resolution
/// carrying raw secret material (or asserting a launch) fails and writes nothing.
fn run_native_windows_dry_run_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let input_path = PathBuf::from(flag(args, "--input")?);
    reject_env_file_path(&input_path)?;
    let output = PathBuf::from(flag(args, "--out").or_else(|_| flag(args, "--output"))?);

    let value: serde_json::Value = read_json(&input_path)?;
    let request: kaifuu_core::NativeWindowsDryRunRequest = serde_json::from_value(value)
        .map_err(|error| format!("invalid native-Windows dry-run request: {error}"))?;
    let resolution = kaifuu_core::resolve_native_windows_dry_run(&request);

    let validation = resolution.validate();
    if validation.status == kaifuu_core::OperationStatus::Failed {
        return Err(format!(
            "native-Windows dry-run resolution failed validation for fixture {}: {}",
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

    atomic_write_text(&output, &resolution.stable_json()?)?;
    Ok(())
}

/// Emits the native-Windows CommandLineToArgvW quoting fixture: a
/// resolved descriptor showing correct quoting of args with spaces, quotes, and
/// backslashes. Every case is proven to round-trip (quote -> command line ->
/// parse recovers the original argv); the fixture never launches anything.
fn run_helper_quoting_fixture_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    reject_helper_execution_config_flags(args)?;
    let output = PathBuf::from(flag(args, "--out").or_else(|_| flag(args, "--output"))?);
    let fixture = kaifuu_core::resolve_windows_command_line_quoting_fixture();

    let validation = fixture.validate();
    if validation.status == kaifuu_core::OperationStatus::Failed {
        return Err(format!(
            "native-Windows quoting fixture failed validation for {}: {}",
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

    atomic_write_text(&output, &fixture.stable_json()?)?;
    Ok(())
}

fn run_helper_run_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    // Helper execution is in-process fixture/stub only. There is no external
    // process launch path: the engine performs deterministic, in-process key
    // discovery (see the Siglus StaticParser), so `helper run` never spawns an
    // external binary.
    reject_helper_execution_config_flags(args)?;
    let output = PathBuf::from(flag(args, "--out").or_else(|_| flag(args, "--output"))?);
    if flag_optional(args, "--mode").is_some_and(|mode| mode != "stub") {
        return Err(
            "helper run only supports the in-process --mode stub fixture path; external helper-process launch is not supported".into(),
        );
    }
    run_helper_run_fixture_stub(args, &output)
}

fn run_helper_run_fixture_stub(
    args: &[String],
    output: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let input = flag_optional(args, "--input")
        .map(PathBuf::from)
        .map(|path| {
            reject_env_file_path(&path)?;
            read_json(&path)
        })
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
    let capability = helper_run_requested_capabilities(args)?
        .into_iter()
        .next()
        .unwrap_or(HelperCapability::FixtureInvocation);
    let value = registry.invoke(HelperRegistryInvocationRequest {
        helper_id,
        helper_version,
        allowlist_entry_id,
        capability,
        input: &input,
    })?;
    let result = normalize_helper_result_value(&value).map_err(|validation| {
        format!(
            "fixture helper output failed validation for {}: {}",
            validation.fixture_id.as_deref().unwrap_or("<unknown>"),
            validation
                .failures
                .iter()
                .map(|failure| format!("{}:{}", failure.field, failure.code))
                .collect::<Vec<_>>()
                .join(", ")
        )
    })?;
    atomic_write_text(output, &result.stable_json()?)?;
    Ok(())
}

fn helper_run_requested_capabilities(
    args: &[String],
) -> Result<Vec<HelperCapability>, Box<dyn std::error::Error>> {
    flag_values(args, "--capability")
        .iter()
        .map(|capability| {
            parse_helper_capability(capability)
                .ok_or_else(|| format!("unsupported helper capability {capability}").into())
        })
        .collect()
}

fn reject_helper_execution_config_flags(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    for forbidden in [
        "--command",
        "--shell",
        "--args",
        "--argv",
        "--env",
        "--environment",
        "--executable-path",
    ] {
        if flag_present(args, forbidden) {
            return Err(format!(
                "kaifuu helper run rejects arbitrary execution configuration flag {forbidden}; select a hash-pinned --profile instead"
            )
            .into());
        }
    }
    Ok(())
}

fn reject_env_file_path(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == ".env" || name.starts_with(".env."))
    {
        return Err("refusing to read or execute .env/.env.* path".into());
    }
    Ok(())
}

pub(crate) fn run_key_helper_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
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
        _ => {
            return Err(
                "usage: kaifuu key-helper validate --fixture <helper-result.json> --output <report.json>"
                    .into(),
            );
        }
    }
    Ok(())
}
