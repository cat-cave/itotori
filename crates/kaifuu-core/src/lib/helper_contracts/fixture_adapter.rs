use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterHelperRequirementDeclaration {
    pub helper_registry_id: String,
    pub capabilities: Vec<HelperCapability>,
    pub allowlist_ref_id: String,
}

impl AdapterHelperRequirementDeclaration {
    pub fn new(
        helper_registry_id: impl Into<String>,
        capabilities: Vec<HelperCapability>,
        allowlist_ref_id: impl Into<String>,
    ) -> Self {
        let mut declaration = Self {
            helper_registry_id: helper_registry_id.into(),
            capabilities,
            allowlist_ref_id: allowlist_ref_id.into(),
        };
        declaration.capabilities.sort();
        declaration.capabilities.dedup();
        declaration
    }

    pub(crate) fn sort_key(&self) -> (String, String) {
        (
            self.helper_registry_id.clone(),
            self.allowlist_ref_id.clone(),
        )
    }

    pub(crate) fn redacted_for_report(&self) -> Self {
        Self {
            helper_registry_id: redact_for_log_or_report(&self.helper_registry_id),
            capabilities: self.capabilities.clone(),
            allowlist_ref_id: redact_for_log_or_report(&self.allowlist_ref_id),
        }
    }
}

pub const FIXTURE_HELPER_REGISTRY_ID: &str = "kaifuu.fixture.helper-stub";
pub const FIXTURE_HELPER_ALLOWLIST_REF_ID: &str = "kaifuu-fixture-helper-stub-allowlist";

#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct FixtureHelperStubAdapter;

impl FixtureHelperStubAdapter {
    pub(crate) fn registry_entry() -> HelperRegistryEntry {
        HelperRegistryEntry {
            schema_version: HELPER_REGISTRY_SCHEMA_VERSION.to_string(),
            helper_id: FIXTURE_HELPER_REGISTRY_ID.to_string(),
            helper_version: "0.1.0".to_string(),
            capabilities: vec![
                HelperCapability::FixtureInvocation,
                HelperCapability::KeyValidation,
            ],
            input_schema_id: HELPER_REGISTRY_INPUT_SCHEMA_FIXTURE_REQUEST.to_string(),
            output_schema_id: HELPER_REGISTRY_OUTPUT_SCHEMA_HELPER_RESULT.to_string(),
            redaction_class: HelperRedactionClass::PublicFixture,
            execution_policy: HelperExecutionPolicy {
                policy_id: "kaifuu-fixture-helper-stub-policy".to_string(),
                mode: HelperExecutionMode::FixtureInProcess,
                allowlist_ref_id: FIXTURE_HELPER_ALLOWLIST_REF_ID.to_string(),
                filesystem_access: HelperFilesystemAccess::None,
                network_access: false,
                max_runtime_seconds: 1,
            },
            binary_allowlist: HelperBinaryAllowlist {
                entries: vec![HelperBinaryAllowlistEntry {
                    allowlist_entry_id: FIXTURE_HELPER_ALLOWLIST_REF_ID.to_string(),
                    helper_id: FIXTURE_HELPER_REGISTRY_ID.to_string(),
                    platform: "fixture-any".to_string(),
                    helper_version: "0.1.0".to_string(),
                    executable_name: "kaifuu-fixture-helper".to_string(),
                    sha256_hash:
                        "sha256:c1ac7473395cf2fbb823d33c63b5b4810352e3d2c255833498ba4fc4efb29f7c"
                            .to_string(),
                    signature: HelperBinarySignatureMetadata {
                        signature_kind: "public-fixture-none".to_string(),
                        signer: "kaifuu-public-fixtures".to_string(),
                        signature_ref: "fixtures-public-no-signature".to_string(),
                    },
                    capabilities: vec![
                        HelperCapability::FixtureInvocation,
                        HelperCapability::KeyValidation,
                    ],
                }],
            },
        }
    }
}

impl HelperExecutableAdapter for FixtureHelperStubAdapter {
    fn helper_id(&self) -> &'static str {
        FIXTURE_HELPER_REGISTRY_ID
    }

    fn invoke(
        &self,
        entry: &HelperRegistryEntry,
        request: HelperRegistryInvocationRequest<'_>,
    ) -> KaifuuResult<Value> {
        let input = request.input;
        let fixture_id = input
            .get("fixtureId")
            .and_then(Value::as_str)
            .unwrap_or("kaifuu-helper-registry-key-ref-request");
        let helper_result_id = format!("helper-result-{fixture_id}");
        let mut request_diagnostics = validate_helper_key_ref_request(input);
        request_diagnostics.extend(validate_helper_registry_request_binding(
            entry,
            request.capability,
            input,
        ));
        if !request_diagnostics.is_empty() {
            let code = request_diagnostics
                .iter()
                .map(|diagnostic| diagnostic.code.as_str())
                .find(|code| *code == SEMANTIC_FORBIDDEN_PUBLIC_SERIALIZATION)
                .or_else(|| {
                    request_diagnostics
                        .iter()
                        .map(|diagnostic| diagnostic.code.as_str())
                        .find(|code| *code == SEMANTIC_MISSING_KEY_MATERIAL)
                })
                .or_else(|| {
                    request_diagnostics
                        .iter()
                        .map(|diagnostic| diagnostic.code.as_str())
                        .find(|code| {
                            matches!(
                                *code,
                                SEMANTIC_HELPER_REQUEST_WRONG_HELPER
                                    | SEMANTIC_HELPER_REGISTRY_MISSING_CAPABILITY
                                    | SEMANTIC_HELPER_REQUEST_MISSING_REDACTED_OUTPUT_EXPECTATION
                                    | SEMANTIC_HELPER_REQUEST_REDACTED_OUTPUT_MISMATCH
                            )
                        })
                })
                .or_else(|| {
                    request_diagnostics
                        .first()
                        .map(|diagnostic| diagnostic.code.as_str())
                })
                .unwrap_or(SEMANTIC_KEY_VALIDATION_FAILED);
            let diagnostic_code = match code {
                SEMANTIC_MISSING_KEY_MATERIAL => "missing_key",
                SEMANTIC_FORBIDDEN_PUBLIC_SERIALIZATION
                | SEMANTIC_HELPER_REQUEST_MISSING_REDACTED_OUTPUT_EXPECTATION
                | SEMANTIC_HELPER_REQUEST_REDACTED_OUTPUT_MISMATCH => "redaction_failure",
                _ => "validation_failed",
            };
            let secret_refs = if diagnostic_code == "missing_key" {
                input
                    .get("requiredKeyRefs")
                    .and_then(Value::as_array)
                    .map(|required_key_refs| {
                        required_key_refs
                            .iter()
                            .enumerate()
                            .filter_map(|(index, required_key_ref)| {
                                let requirement_id =
                                    required_key_ref.get("requirementId")?.as_str()?;
                                Some(serde_json::json!({
                                    "requirementId": requirement_id,
                                    "secretRef": format!("local-secret:fixture/missing/key-ref-{index}"),
                                    "materialKind": required_key_ref
                                        .get("materialKind")
                                        .and_then(Value::as_str)
                                        .unwrap_or("fixedBytes"),
                                    "bytes": required_key_ref
                                        .get("bytes")
                                        .and_then(Value::as_u64)
                                        .unwrap_or(16)
                                }))
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default()
            } else {
                vec![]
            };
            return Ok(serde_json::json!({
                "schemaVersion": HELPER_RESULT_SCHEMA_VERSION,
                "fixtureId": fixture_id,
                "helperResultId": helper_result_id,
                "profileId": input
                    .get("engineProfileId")
                    .and_then(Value::as_str)
                    .unwrap_or("019ed000-0000-7000-8000-profile00086"),
                "helper": {
                    "helperId": entry.helper_id,
                    "helperVersion": entry.helper_version,
                    "helperKind": "knownKeyDatabaseImport"
                },
                "capabilityLevel": "localKeyImport",
                "execution": {
                    "mode": "notExecuted",
                    "platform": "fixture-local",
                    "bounded": true,
                    "timeoutMs": 1000,
                    "durationMs": 0,
                    "networkAccess": false,
                    "filesystemAccess": "none"
                },
                "diagnostic": {
                    "code": diagnostic_code,
                    "message": code
                },
                "redaction": {
                    "status": if diagnostic_code == "redaction_failure" { "failed" } else { "redacted" },
                    "redactedLogHash": entry.expected_fixture_redacted_log_hash()
                },
                "secretRefs": secret_refs,
                "proofHashes": []
            }));
        }

        let secret_refs = input
            .get("keyRefs")
            .and_then(Value::as_array)
            .map(|key_refs| {
                key_refs
                    .iter()
                    .filter_map(|key_ref| {
                        let requirement_id = key_ref.get("requirementId")?.as_str()?;
                        let secret_ref = key_ref.get("secretRef")?.as_str()?;
                        let proof_hash = key_ref
                            .get("materialHash")
                            .and_then(Value::as_str)
                            .unwrap_or(
                                "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
                            );
                        Some(serde_json::json!({
                            "requirementId": requirement_id,
                            "secretRef": secret_ref,
                            "materialKind": key_ref
                                .get("materialKind")
                                .and_then(Value::as_str)
                                .unwrap_or("fixedBytes"),
                            "bytes": key_ref
                                .get("bytes")
                                .and_then(Value::as_u64)
                                .unwrap_or(16),
                            "validation": {
                                "method": "decryptHeaderProof",
                                "proofHash": proof_hash
                            }
                        }))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if !secret_refs.is_empty() {
            let proof_hashes = secret_refs
                .iter()
                .filter_map(|secret_ref| secret_ref.pointer("/validation/proofHash"))
                .map(|proof_hash| {
                    serde_json::json!({
                        "method": "decryptHeaderProof",
                        "proofHash": proof_hash
                    })
                })
                .collect::<Vec<_>>();
            return Ok(serde_json::json!({
                "schemaVersion": HELPER_RESULT_SCHEMA_VERSION,
                "fixtureId": fixture_id,
                "helperResultId": helper_result_id,
                "profileId": input
                    .get("engineProfileId")
                    .and_then(Value::as_str)
                    .unwrap_or("019ed000-0000-7000-8000-profile00086"),
                "helper": {
                    "helperId": entry.helper_id,
                    "helperVersion": entry.helper_version,
                    "helperKind": "knownKeyDatabaseImport"
                },
                "capabilityLevel": "localKeyImport",
                "execution": {
                    "mode": "notExecuted",
                    "platform": "fixture-local",
                    "bounded": true,
                    "timeoutMs": 1000,
                    "durationMs": 0,
                    "networkAccess": false,
                    "filesystemAccess": "none"
                },
                "diagnostic": {
                    "code": "success",
                    "message": "fixture helper received bounded refs through registry boundary"
                },
                "redaction": {
                    "status": "redacted",
                    "redactedLogHash": entry.expected_fixture_redacted_log_hash()
                },
                "secretRefs": secret_refs,
                "proofHashes": proof_hashes
            }));
        }

        Ok(serde_json::json!({
            "schemaVersion": HELPER_RESULT_SCHEMA_VERSION,
            "fixtureId": "kaifuu-helper-registry-stub",
            "helperResultId": "helper-result-registry-stub",
            "profileId": "019ed000-0000-7000-8000-profile00086",
            "helper": {
                "helperId": entry.helper_id,
                "helperVersion": entry.helper_version,
                "helperKind": "staticParser"
            },
            "capabilityLevel": "staticAnalysis",
            "execution": {
                "mode": "inProcess",
                "platform": "fixture-static",
                "bounded": true,
                "timeoutMs": 1000,
                "durationMs": 0,
                "networkAccess": false,
                "filesystemAccess": "readOnlyWorkspace"
            },
            "diagnostic": {
                "code": "success",
                "message": "fixture helper stub invoked through helper registry boundary"
            },
            "redaction": {
                "status": "redacted",
                "redactedLogHash": entry.expected_fixture_redacted_log_hash()
            },
            "secretRefs": [
                {
                    "requirementId": "fixture-helper-stub-proof",
                    "secretRef": "local-secret:fixture/helper/stub-proof",
                    "materialKind": "fixedBytes",
                    "bytes": 16,
                    "validation": {
                        "method": "fixtureRoundTripProof",
                        "proofHash": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
                    }
                }
            ],
            "proofHashes": [
                {
                    "method": "fixtureRoundTripProof",
                    "proofHash": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
                }
            ]
        }))
    }
}

/// Builds the fixture helper registry facade.
/// Public callers can discover and invoke fixture helpers only through
/// [`HelperRegistry::entries_for_capability`] and [`HelperRegistry::invoke`].
/// use kaifuu_core::{
/// fixture_helper_registry, validate_helper_result_value, HelperCapability,
/// HelperRegistryInvocationRequest, OperationStatus, FIXTURE_HELPER_ALLOWLIST_REF_ID,
/// FIXTURE_HELPER_REGISTRY_ID,
/// let registry = fixture_helper_registry.unwrap;
/// let input = serde_json::json!({"fixture": true});
/// let output = registry
/// .invoke(HelperRegistryInvocationRequest {
/// helper_id: FIXTURE_HELPER_REGISTRY_ID,
/// helper_version: "0.1.0",
/// allowlist_entry_id: FIXTURE_HELPER_ALLOWLIST_REF_ID,
/// capability: HelperCapability::FixtureInvocation,
/// input: &input,
/// .unwrap;
/// assert_eq!(
/// validate_helper_result_value(&output).status,
/// OperationStatus::Passed
/// ```compile_fail
/// use kaifuu_core::{fixture_helper_registry, FIXTURE_HELPER_REGISTRY_ID};
/// let mut registry = fixture_helper_registry.unwrap;
/// let forged_entry = registry.get(FIXTURE_HELPER_REGISTRY_ID).unwrap.clone;
/// registry.register_entry(forged_entry).unwrap;
/// ```compile_fail
/// use kaifuu_core::{FixtureHelperStubAdapter, HelperExecutableAdapter};
/// let adapter = FixtureHelperStubAdapter;
/// let entry = FixtureHelperStubAdapter::registry_entry;
/// let _ = adapter.invoke(&entry, &serde_json::json!({"fixture": true}));
pub fn fixture_helper_registry() -> KaifuuResult<HelperRegistry> {
    let mut registry = HelperRegistry::new();
    registry.register_entry(FixtureHelperStubAdapter::registry_entry())?;
    registry.register_executable(FixtureHelperStubAdapter);
    Ok(registry)
}
