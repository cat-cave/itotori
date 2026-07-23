use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperRegistryEntry {
    pub schema_version: String,
    pub helper_id: String,
    pub helper_version: String,
    pub capabilities: Vec<HelperCapability>,
    pub input_schema_id: String,
    pub output_schema_id: String,
    pub redaction_class: HelperRedactionClass,
    pub execution_policy: HelperExecutionPolicy,
    pub binary_allowlist: HelperBinaryAllowlist,
}

impl HelperRegistryEntry {
    pub fn normalize(&mut self) {
        self.capabilities.sort();
        self.capabilities.dedup();
        self.binary_allowlist.normalize();
    }

    pub fn supports(&self, capability: HelperCapability) -> bool {
        self.capabilities.contains(&capability)
    }

    pub fn expected_fixture_redacted_log_hash(&self) -> &'static str {
        "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    }

    /// Stage the registered helper binary into a trusted staging directory and
    /// validate the STAGED bytes against the allowlist entry.
    /// This is the hardened replacement for the old hash-then-exec-path launch
    /// seam: instead of hashing the mutable `executable_path` and
    /// later launching that same path — a hash-to-exec TOCTOU where an attacker
    /// who can write the path swaps the binary between the hash-check and the
    /// exec — the source bytes are copied ONCE into `staging_dir` (a directory
    /// the untrusted source cannot write), the hash is computed from the STAGED
    /// copy, and the returned [`StagedHelperBinary`] is the execution reference
    /// (a held descriptor to the staged copy on Unix). A swap of the original
    /// path after staging has no effect: the bytes that were validated are
    /// exactly the bytes bound to execution.
    /// `staging_dir` MUST be a caller-controlled trusted directory (e.g. a
    /// freshly allocated Kaifuu-owned temp dir), never a directory writable by
    /// the untrusted helper source.
    pub fn stage_and_validate_binary_launch(
        &self,
        request: HelperBinaryLaunchValidationRequest<'_>,
        staging_dir: &Path,
    ) -> HelperBinaryLaunchOutcome {
        stage_and_validate_helper_binary_launch(self, request, staging_dir)
    }

    pub fn validate(&self) -> HelperRegistryValidationResult {
        match serde_json::to_value(self) {
            Ok(value) => validate_helper_registry_entry_value(&value),
            Err(_) => HelperRegistryValidationResult {
                schema_version: HELPER_REGISTRY_SCHEMA_VERSION.to_string(),
                helper_id: Some(redact_for_log_or_report(&self.helper_id)),
                status: OperationStatus::Failed,
                diagnostics: vec![HelperRegistryDiagnostic {
                    helper_id: Some(redact_for_log_or_report(&self.helper_id)),
                    code: "helper_registry_serialization_failed".to_string(),
                    field: "$".to_string(),
                    message: "helper registry entry could not be serialized for validation"
                        .to_string(),
                }],
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HelperCapability {
    FixtureInvocation,
    KeyDiscovery,
    KeyValidation,
    ProtectedExecutableProbe,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HelperRedactionClass {
    PublicFixture,
    SecretRefOnly,
    AggregateOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HelperExecutionMode {
    FixtureInProcess,
    Disallowed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HelperFilesystemAccess {
    None,
    TempOnly,
    ReadOnlyWorkspace,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperExecutionPolicy {
    pub policy_id: String,
    pub mode: HelperExecutionMode,
    pub allowlist_ref_id: String,
    pub filesystem_access: HelperFilesystemAccess,
    pub network_access: bool,
    pub max_runtime_seconds: u32,
}

pub fn validate_helper_key_ref_request(input: &Value) -> Vec<LocalKeyImportDiagnostic> {
    let mut diagnostics = Vec::new();
    for finding in validate_secret_redaction_boundary(input) {
        diagnostics.push(LocalKeyImportDiagnostic {
            code: SEMANTIC_FORBIDDEN_PUBLIC_SERIALIZATION.to_string(),
            field: finding.field,
            message: finding.reason,
        });
    }

    let expected_engine_profile_id = input
        .get("engineProfileId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let expected_source_hash = input
        .get("sourceHash")
        .and_then(Value::as_str)
        .map(str::to_string);
    if let Some(source_hash) = expected_source_hash.as_deref()
        && ProofHash::new(source_hash.to_string()).is_err()
    {
        diagnostics.push(LocalKeyImportDiagnostic {
            code: "invalid_proof_hash".to_string(),
            field: "sourceHash".to_string(),
            message: "sourceHash must be sha256:<64 lowercase hex characters>".to_string(),
        });
    }

    let key_refs = input
        .get("keyRefs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let required_key_refs = input
        .get("requiredKeyRefs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for (index, key_ref) in key_refs.iter().enumerate() {
        let field = format!("keyRefs.{index}");
        let Some(_requirement_id) = key_ref.get("requirementId").and_then(Value::as_str) else {
            diagnostics.push(LocalKeyImportDiagnostic {
                code: "missing_required_field".to_string(),
                field: format!("{field}.requirementId"),
                message: "key ref requirementId must not be empty".to_string(),
            });
            continue;
        };
        if let Some(secret_ref) = key_ref.get("secretRef").and_then(Value::as_str)
            && let Err(message) = SecretRef::new(secret_ref.to_string())
        {
            diagnostics.push(LocalKeyImportDiagnostic {
                code: "invalid_secret_ref".to_string(),
                field: format!("{field}.secretRef"),
                message,
            });
        }
        if key_ref
            .get("engineProfileId")
            .and_then(Value::as_str)
            .is_some_and(|engine_profile_id| {
                expected_engine_profile_id
                    .as_deref()
                    .is_some_and(|expected| expected != engine_profile_id)
            })
        {
            diagnostics.push(LocalKeyImportDiagnostic {
                code: SEMANTIC_KEY_IMPORT_WRONG_ENGINE_PROFILE.to_string(),
                field: format!("{field}.engineProfileId"),
                message: "key ref engine profile id does not match the helper request".to_string(),
            });
        }
        if key_ref
            .get("sourceHash")
            .and_then(Value::as_str)
            .is_some_and(|source_hash| {
                expected_source_hash
                    .as_deref()
                    .is_some_and(|expected| expected != source_hash)
            })
        {
            diagnostics.push(LocalKeyImportDiagnostic {
                code: SEMANTIC_KEY_IMPORT_HASH_MISMATCH.to_string(),
                field: format!("{field}.sourceHash"),
                message: "key ref source hash does not match the helper request".to_string(),
            });
        }
    }

    for (index, required) in required_key_refs.iter().enumerate() {
        let field = format!("requiredKeyRefs.{index}");
        let Some(requirement_id) = required.get("requirementId").and_then(Value::as_str) else {
            diagnostics.push(LocalKeyImportDiagnostic {
                code: "missing_required_field".to_string(),
                field: format!("{field}.requirementId"),
                message: "required key ref requirementId must not be empty".to_string(),
            });
            continue;
        };
        let matching_refs = key_refs
            .iter()
            .enumerate()
            .filter(|(_, key_ref)| {
                key_ref
                    .get("requirementId")
                    .and_then(Value::as_str)
                    .is_some_and(|candidate| candidate == requirement_id)
            })
            .collect::<Vec<_>>();
        if matching_refs.is_empty() {
            diagnostics.push(LocalKeyImportDiagnostic {
                code: SEMANTIC_MISSING_KEY_MATERIAL.to_string(),
                field,
                message: format!(
                    "required local key ref {requirement_id} was not provided to helper boundary"
                ),
            });
            continue;
        }

        for (key_ref_index, key_ref) in matching_refs {
            let field = format!("keyRefs.{key_ref_index}");
            match key_ref.get("secretRef").and_then(Value::as_str) {
                Some(secret_ref) if !secret_ref.is_empty() => {
                    if let Err(message) = SecretRef::new(secret_ref.to_string()) {
                        diagnostics.push(LocalKeyImportDiagnostic {
                            code: "invalid_secret_ref".to_string(),
                            field: format!("{field}.secretRef"),
                            message,
                        });
                    }
                }
                _ => {
                    diagnostics.push(LocalKeyImportDiagnostic {
                        code: SEMANTIC_MISSING_KEY_MATERIAL.to_string(),
                        field: format!("{field}.secretRef"),
                        message: format!(
                            "required local key ref {requirement_id} must include a valid secretRef"
                        ),
                    });
                }
            }

            match (
                key_ref.get("engineProfileId").and_then(Value::as_str),
                expected_engine_profile_id.as_deref(),
            ) {
                (Some(engine_profile_id), Some(expected))
                    if engine_profile_id == expected && !engine_profile_id.is_empty() => {}
                _ => diagnostics.push(LocalKeyImportDiagnostic {
                    code: SEMANTIC_KEY_IMPORT_WRONG_ENGINE_PROFILE.to_string(),
                    field: format!("{field}.engineProfileId"),
                    message: "required key ref engine profile id must match the helper request"
                        .to_string(),
                }),
            }

            if let Some(expected_key_purpose) = required.get("keyPurpose").and_then(Value::as_str) {
                match key_ref.get("keyPurpose").and_then(Value::as_str) {
                    Some(key_purpose) if key_purpose == expected_key_purpose => {}
                    _ => diagnostics.push(LocalKeyImportDiagnostic {
                        code: SEMANTIC_KEY_IMPORT_WRONG_KEY_PURPOSE.to_string(),
                        field: format!("{field}.keyPurpose"),
                        message: format!(
                            "required key ref purpose must match {expected_key_purpose}"
                        ),
                    }),
                }
            }

            match (
                key_ref.get("sourceHash").and_then(Value::as_str),
                expected_source_hash.as_deref(),
            ) {
                (Some(source_hash), Some(expected))
                    if source_hash == expected && !source_hash.is_empty() => {}
                _ => diagnostics.push(LocalKeyImportDiagnostic {
                    code: SEMANTIC_KEY_IMPORT_HASH_MISMATCH.to_string(),
                    field: format!("{field}.sourceHash"),
                    message: "required key ref source hash must match the helper request"
                        .to_string(),
                }),
            }
        }
    }

    diagnostics
        .into_iter()
        .map(|diagnostic| diagnostic.redacted_for_report())
        .collect()
}

pub(super) fn validate_helper_registry_request_binding(
    entry: &HelperRegistryEntry,
    capability: HelperCapability,
    input: &Value,
) -> Vec<LocalKeyImportDiagnostic> {
    let mut diagnostics = Vec::new();

    if let Some(helper_id) = input.get("helperId").and_then(Value::as_str)
        && helper_id != entry.helper_id
    {
        diagnostics.push(LocalKeyImportDiagnostic {
            code: SEMANTIC_HELPER_REQUEST_WRONG_HELPER.to_string(),
            field: "helperId".to_string(),
            message: "helper request helperId does not match the registry entry".to_string(),
        });
    }

    if let Some(helper_version) = input.get("helperVersion").and_then(Value::as_str)
        && helper_version != entry.helper_version
    {
        diagnostics.push(LocalKeyImportDiagnostic {
            code: SEMANTIC_HELPER_ALLOWLIST_STALE_VERSION.to_string(),
            field: "helperVersion".to_string(),
            message: "helper request helperVersion does not match the registry entry".to_string(),
        });
    }

    if let Some(allowlist_entry_id) = input.get("allowlistEntryId").and_then(Value::as_str)
        && allowlist_entry_id != entry.execution_policy.allowlist_ref_id
    {
        diagnostics.push(LocalKeyImportDiagnostic {
            code: SEMANTIC_HELPER_ALLOWLIST_MISSING_ENTRY.to_string(),
            field: "allowlistEntryId".to_string(),
            message: "helper request allowlist entry does not match the registry policy"
                .to_string(),
        });
    }

    if let Some(requested_capability) = input.get("requestedCapability").and_then(Value::as_str) {
        match parse_helper_capability(requested_capability) {
            Some(capability) if entry.supports(capability) => {}
            Some(_) => diagnostics.push(LocalKeyImportDiagnostic {
                code: SEMANTIC_HELPER_REGISTRY_MISSING_CAPABILITY.to_string(),
                field: "requestedCapability".to_string(),
                message: "helper registry entry does not support the requested capability"
                    .to_string(),
            }),
            None => diagnostics.push(LocalKeyImportDiagnostic {
                code: SEMANTIC_HELPER_REGISTRY_MISSING_CAPABILITY.to_string(),
                field: "requestedCapability".to_string(),
                message: "helper request capability is not registered".to_string(),
            }),
        }
    }

    match input.get("expectedRedactedLogHash") {
        Some(Value::String(expected_redacted_log_hash)) => {
            if ProofHash::new(expected_redacted_log_hash.clone()).is_err() {
                diagnostics.push(LocalKeyImportDiagnostic {
                    code: "invalid_proof_hash".to_string(),
                    field: "expectedRedactedLogHash".to_string(),
                    message: "expectedRedactedLogHash must be sha256:<64 lowercase hex characters>"
                        .to_string(),
                });
            } else if expected_redacted_log_hash != entry.expected_fixture_redacted_log_hash() {
                diagnostics.push(LocalKeyImportDiagnostic {
                    code: SEMANTIC_HELPER_REQUEST_REDACTED_OUTPUT_MISMATCH.to_string(),
                    field: "expectedRedactedLogHash".to_string(),
                    message: "helper redacted output hash did not match the request expectation"
                        .to_string(),
                });
            }
        }
        Some(_) => diagnostics.push(LocalKeyImportDiagnostic {
            code: "invalid_proof_hash".to_string(),
            field: "expectedRedactedLogHash".to_string(),
            message: "expectedRedactedLogHash must be sha256:<64 lowercase hex characters>"
                .to_string(),
        }),
        None if helper_request_requires_redacted_log_expectation(capability, input) => {
            diagnostics.push(LocalKeyImportDiagnostic {
                code: SEMANTIC_HELPER_REQUEST_MISSING_REDACTED_OUTPUT_EXPECTATION.to_string(),
                field: "expectedRedactedLogHash".to_string(),
                message: "helper request must declare expectedRedactedLogHash before success"
                    .to_string(),
            });
        }
        None => {}
    }

    diagnostics
        .into_iter()
        .map(|diagnostic| diagnostic.redacted_for_report())
        .collect()
}

fn helper_request_requires_redacted_log_expectation(
    capability: HelperCapability,
    input: &Value,
) -> bool {
    capability == HelperCapability::KeyValidation
        && input
            .get("keyRefs")
            .and_then(Value::as_array)
            .is_some_and(|key_refs| {
                key_refs.iter().any(|key_ref| {
                    key_ref
                        .get("requirementId")
                        .and_then(Value::as_str)
                        .is_some_and(|requirement_id| requirement_id == "siglus-secondary-key")
                        && key_ref
                            .get("secretRef")
                            .and_then(Value::as_str)
                            .is_some_and(|secret_ref| !secret_ref.is_empty())
                        && key_ref
                            .get("keyPurpose")
                            .and_then(Value::as_str)
                            .is_some_and(|key_purpose| key_purpose == "siglus-secondary-key")
                })
            })
}
