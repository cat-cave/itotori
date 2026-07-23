use super::*;

pub(super) fn stage_and_validate_helper_binary_launch(
    entry: &HelperRegistryEntry,
    request: HelperBinaryLaunchValidationRequest<'_>,
    staging_dir: &Path,
) -> HelperBinaryLaunchOutcome {
    let mut diagnostics = Vec::new();

    // Bind the validated bytes to execution through a trusted staging COPY. The
    // source path is read exactly ONCE (no-follow) and copied into the trusted
    // `staging_dir`; the observed hash is of the STAGED bytes, and the staged
    // copy (held open) is the execution reference. The mutable source path is
    // never re-opened, so a swap after this point cannot change what runs.
    let staged_name = staged_helper_binary_name(request.allowlist_entry_id);
    let (observed_hash, staged, staging_error) =
        match stage_helper_binary_no_follow(request.executable_path, staging_dir, &staged_name) {
            Ok(staged) => (Some(staged.staged_hash().to_string()), Some(staged), None),
            Err(HelperBinaryStagingError::SourceMissing) => (None, None, None),
            Err(error) => (None, None, Some(error)),
        };

    if let Some(error) = staging_error {
        helper_binary_launch_failure(
            &mut diagnostics,
            request,
            observed_hash.as_deref(),
            SEMANTIC_HELPER_ALLOWLIST_STAGING_FAILED,
            "executablePath",
            "reinstall_helper_binary",
            &format!("helper binary could not be safely staged for launch: {error}"),
        );
    }

    let allowlist_entry = entry
        .binary_allowlist
        .entries
        .iter()
        .find(|candidate| candidate.allowlist_entry_id == request.allowlist_entry_id);

    let Some(allowlist_entry) = allowlist_entry else {
        helper_binary_launch_failure(
            &mut diagnostics,
            request,
            observed_hash.as_deref(),
            SEMANTIC_HELPER_ALLOWLIST_MISSING_ENTRY,
            "allowlistEntryId",
            "install_or_select_allowed_helper",
            "helper binary allowlist entry is not registered",
        );
        return helper_binary_launch_outcome(request, observed_hash, diagnostics, staged);
    };

    if allowlist_entry.helper_id != request.helper_id || entry.helper_id != request.helper_id {
        helper_binary_launch_failure(
            &mut diagnostics,
            request,
            observed_hash.as_deref(),
            SEMANTIC_HELPER_ALLOWLIST_MISSING_ENTRY,
            "helperId",
            "install_or_select_allowed_helper",
            "helper id does not match the binary allowlist entry",
        );
    }
    if allowlist_entry.platform != request.platform {
        helper_binary_launch_failure(
            &mut diagnostics,
            request,
            observed_hash.as_deref(),
            SEMANTIC_HELPER_ALLOWLIST_WRONG_PLATFORM,
            "platform",
            "select_platform_helper",
            "helper binary platform does not match the current launch platform",
        );
    }
    if allowlist_entry.helper_version != request.helper_version
        || entry.helper_version != request.helper_version
    {
        helper_binary_launch_failure(
            &mut diagnostics,
            request,
            observed_hash.as_deref(),
            SEMANTIC_HELPER_ALLOWLIST_STALE_VERSION,
            "helperVersion",
            "upgrade_helper_binary",
            "helper binary version does not match the requested helper version",
        );
    }
    let executable_name = request
        .executable_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if executable_name != allowlist_entry.executable_name {
        helper_binary_launch_failure(
            &mut diagnostics,
            request,
            observed_hash.as_deref(),
            SEMANTIC_HELPER_ALLOWLIST_EXECUTABLE_NAME_MISMATCH,
            "executableName",
            "install_or_select_allowed_helper",
            "helper binary executable name does not match the allowlist entry",
        );
    }
    if observed_hash.is_none() {
        helper_binary_launch_failure(
            &mut diagnostics,
            request,
            observed_hash.as_deref(),
            SEMANTIC_HELPER_ALLOWLIST_MISSING_BINARY,
            "executablePath",
            "install_helper_binary",
            "helper binary is missing or unreadable",
        );
    } else if observed_hash.as_deref() != Some(allowlist_entry.sha256_hash.as_str()) {
        helper_binary_launch_failure(
            &mut diagnostics,
            request,
            observed_hash.as_deref(),
            SEMANTIC_HELPER_ALLOWLIST_HASH_MISMATCH,
            "sha256Hash",
            "reinstall_helper_binary",
            "helper binary hash does not match the allowlist entry",
        );
    }
    for capability in request.required_capabilities {
        if !entry.supports(*capability) || !allowlist_entry.capabilities.contains(capability) {
            helper_binary_launch_failure(
                &mut diagnostics,
                request,
                observed_hash.as_deref(),
                SEMANTIC_HELPER_ALLOWLIST_UNDECLARED_CAPABILITY,
                "capabilities",
                "request_declared_helper_capability",
                &format!(
                    "helper binary does not declare required capability {}",
                    helper_capability_name(*capability)
                ),
            );
        }
    }

    helper_binary_launch_outcome(request, observed_hash, diagnostics, staged)
}

/// Build the launch outcome. The staged execution reference is retained only
/// when validation PASSED: a failed validation must never hand a caller an
/// executable handle, and a mismatched/failed staged copy is dropped (its temp
/// file removed on `Drop`) so nothing runs.
fn helper_binary_launch_outcome(
    request: HelperBinaryLaunchValidationRequest<'_>,
    observed_hash: Option<String>,
    diagnostics: Vec<HelperBinaryLaunchDiagnostic>,
    staged: Option<StagedHelperBinary>,
) -> HelperBinaryLaunchOutcome {
    let passed = diagnostics.is_empty();
    let validation = HelperBinaryLaunchValidationResult {
        schema_version: HELPER_REGISTRY_SCHEMA_VERSION.to_string(),
        helper_id: redact_for_log_or_report(request.helper_id),
        allowlist_entry_id: redact_for_log_or_report(request.allowlist_entry_id),
        status: if passed {
            OperationStatus::Passed
        } else {
            OperationStatus::Failed
        },
        observed_hash,
        platform: redact_for_log_or_report(request.platform),
        diagnostics,
    };
    HelperBinaryLaunchOutcome {
        validation,
        staged: if passed { staged } else { None },
    }
}

fn helper_binary_launch_failure(
    diagnostics: &mut Vec<HelperBinaryLaunchDiagnostic>,
    request: HelperBinaryLaunchValidationRequest<'_>,
    observed_hash: Option<&str>,
    code: &str,
    field: &str,
    remediation_code: &str,
    message: &str,
) {
    diagnostics.push(HelperBinaryLaunchDiagnostic {
        helper_id: redact_for_log_or_report(request.helper_id),
        allowlist_entry_id: redact_for_log_or_report(request.allowlist_entry_id),
        code: code.to_string(),
        field: field.to_string(),
        observed_hash: observed_hash.map(redact_helper_hash),
        platform: redact_for_log_or_report(request.platform),
        remediation_code: remediation_code.to_string(),
        message: redact_for_log_or_report(message),
    });
}

pub(crate) trait HelperExecutableAdapter {
    fn helper_id(&self) -> &'static str;
    fn invoke(
        &self,
        entry: &HelperRegistryEntry,
        request: HelperRegistryInvocationRequest<'_>,
    ) -> KaifuuResult<Value>;
}

#[derive(Default)]
pub struct HelperRegistry {
    entries: BTreeMap<String, HelperRegistryEntry>,
    executables: BTreeMap<String, Box<dyn HelperExecutableAdapter>>,
}

impl HelperRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub(crate) fn register_entry(&mut self, mut entry: HelperRegistryEntry) -> KaifuuResult<()> {
        entry.normalize();
        let validation = entry.validate();
        if validation.status == OperationStatus::Failed {
            return Err(format!(
                "helper registry entry {} failed validation: {}",
                redact_for_log_or_report(&entry.helper_id),
                validation
                    .diagnostics
                    .iter()
                    .map(|diagnostic| diagnostic.code.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
            .into());
        }
        self.entries.insert(entry.helper_id.clone(), entry);
        Ok(())
    }

    pub(crate) fn register_executable<A>(&mut self, adapter: A)
    where
        A: HelperExecutableAdapter + 'static,
    {
        self.executables
            .insert(adapter.helper_id().to_string(), Box::new(adapter));
    }

    pub fn get(&self, helper_id: &str) -> Option<&HelperRegistryEntry> {
        self.entries.get(helper_id)
    }

    pub fn entries_for_capability(
        &self,
        capability: HelperCapability,
    ) -> Vec<&HelperRegistryEntry> {
        self.entries
            .values()
            .filter(|entry| entry.supports(capability))
            .collect()
    }

    pub fn invoke(&self, request: HelperRegistryInvocationRequest<'_>) -> KaifuuResult<Value> {
        let entry = self.entries.get(request.helper_id).ok_or_else(|| {
            format!(
                "{}: helper registry id {} is not registered",
                SEMANTIC_HELPER_UNAVAILABLE,
                redact_for_log_or_report(request.helper_id)
            )
        })?;
        validate_helper_registry_invocation(entry, request)?;
        let executable = self.executables.get(request.helper_id).ok_or_else(|| {
            format!(
                "{}: helper registry id {} has no executable adapter",
                SEMANTIC_HELPER_UNAVAILABLE,
                redact_for_log_or_report(request.helper_id)
            )
        })?;
        let output = executable.invoke(entry, request)?;
        validate_helper_registry_output(entry, &output)?;
        Ok(output)
    }
}
