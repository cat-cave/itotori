use serde::{Deserialize, Serialize};

use crate::{
    HELPER_RESULT_SCHEMA_VERSION, HelperCapabilityLevel, HelperDiagnostic, HelperDiagnosticCode,
    HelperExecutionFilesystemAccess, HelperExecutionSummary, HelperKind, HelperProvenance,
    HelperRedaction, HelperRedactionStatus, HelperResult, HelperResultExecutionMode,
    HelperResultSecretRef, KaifuuResult, KeyValidationMethod, KeyValidationProof, ProofHash,
    SecretRef, stable_json,
};

use super::{
    DYNAMIC_KEY_DISCOVERY_HELPER_SCHEMA_VERSION, DYNAMIC_KEY_DISCOVERY_PLATFORM_ID,
    DynamicKeyDiscoveryDiagnostic, DynamicKeyDiscoveryRefusal, DynamicKeyDiscoveryRequest,
    DynamicKeyDiscoveryResponse, FIXTURE_DISCOVERED_SECRET_REF, FIXTURE_KEY_PROOF_HASH,
    FIXTURE_REDACTED_LOG_HASH, HelperInvocationMode, PURE_ADAPTER_ENGINE_IDS,
    SEMANTIC_DYNAMIC_KEY_HELPER_DISABLED, SEMANTIC_DYNAMIC_KEY_HELPER_PURE_ADAPTER_DEPENDENCY,
    SEMANTIC_DYNAMIC_KEY_HELPER_RESULT_INVALID,
};

mod validation;
pub use validation::{DynamicKeyDiscoveryFailure, DynamicKeyDiscoveryValidation};
pub(super) use validation::{scan_value_for_leaks, validate_nested_helper_result};

#[cfg(test)]
#[path = "implementation/tests.rs"]
mod test_support;

/// The outcome of an [`attempt_dynamic_key_discovery`] call: either a refusal
/// (disabled modes) or a resolved response (the enabled live opt-in).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum DynamicKeyDiscoveryOutcome {
    /// The call was refused because the helper is disabled in this mode.
    Refused(DynamicKeyDiscoveryRefusal),
    /// The call resolved a response (secret ref + proof hash) in an enabled mode.
    Resolved(DynamicKeyDiscoveryResponse),
}

impl DynamicKeyDiscoveryOutcome {
    /// Whether this outcome is a refusal.
    pub fn is_refused(&self) -> bool {
        matches!(self, Self::Refused(_))
    }

    /// Whether this outcome is a resolved response.
    pub fn is_resolved(&self) -> bool {
        matches!(self, Self::Resolved(_))
    }

    /// The resolved response, if any.
    pub fn response(&self) -> Option<&DynamicKeyDiscoveryResponse> {
        match self {
            Self::Resolved(response) => Some(response),
            Self::Refused(_) => None,
        }
    }

    /// The refusal, if any.
    pub fn refusal(&self) -> Option<&DynamicKeyDiscoveryRefusal> {
        match self {
            Self::Refused(refusal) => Some(refusal),
            Self::Resolved(_) => None,
        }
    }

    /// Validates whichever variant this outcome holds.
    pub fn validate(&self) -> DynamicKeyDiscoveryValidation {
        match self {
            Self::Refused(refusal) => refusal.validate(),
            Self::Resolved(response) => response.validate(),
        }
    }
}

/// Attempts a dynamic-key-discovery helper call **without ever launching game
/// code or shelling out**. The mode is the disabled-by-default gate:
/// - In [`HelperInvocationMode::PublicFixture`] and [`HelperInvocationMode::Ci`]
///   the helper is DISABLED: the call is refused with a typed
///   [`SEMANTIC_DYNAMIC_KEY_HELPER_DISABLED`] diagnostic and a helper
///   result whose diagnostic is [`HelperDiagnosticCode::HelperAuthorizationDenied`].
///   No response, no secret ref, no proof, no launch.
/// - In [`HelperInvocationMode::LiveOptIn`] the boundary is ENABLED and resolves
///   a response carrying a [`SecretRef`] + sha256 proof hash. Even here nothing
///   is launched from kaifuu: the response models the boundary shape a real,
///   out-of-process remote helper populates.
///   use kaifuu_core::{
///   attempt_dynamic_key_discovery, DynamicKeyDiscoveryRequest, HelperInvocationMode,
///   HelperRedactionPolicy, KeyMaterialKind, DYNAMIC_KEY_DISCOVERY_HELPER_SCHEMA_VERSION,
///   let request = DynamicKeyDiscoveryRequest {
///   schema_version: DYNAMIC_KEY_DISCOVERY_HELPER_SCHEMA_VERSION.to_string,
///   fixture_id: "kaifuu-dynamic-key-discovery".to_string,
///   helper_binary_id: "kaifuu.fixture.remote-dynamic-key-helper".to_string,
///   allowlist_entry_id: "kaifuu-fixture-dynamic-key-allowlist".to_string,
///   requirement_id: "dyn-key-req-065".to_string,
///   scan_target: "process-image:fixture-adv-runtime".to_string,
///   material_kind: KeyMaterialKind::FixedBytes,
///   profile_id: "019ed000-0000-7000-8000-profile00065".to_string,
///   redaction_policy: HelperRedactionPolicy::RedactRawLogsAndSecretRefs,
///   timeout_ms: 5000,
///   // Disabled by default: CI refuses.
///   let refused = attempt_dynamic_key_discovery(&request, HelperInvocationMode::Ci);
///   assert!(refused.is_refused);
///   // Only the explicit opt-in enables it.
///   let resolved = attempt_dynamic_key_discovery(&request, HelperInvocationMode::LiveOptIn);
///   assert!(resolved.is_resolved);
///   assert_eq!(resolved.validate.status, kaifuu_core::OperationStatus::Passed);
pub fn attempt_dynamic_key_discovery(
    request: &DynamicKeyDiscoveryRequest,
    mode: HelperInvocationMode,
) -> DynamicKeyDiscoveryOutcome {
    if !mode.helper_enabled() {
        return DynamicKeyDiscoveryOutcome::Refused(build_refusal(request, mode));
    }
    DynamicKeyDiscoveryOutcome::Resolved(build_response(request))
}

fn build_refusal(
    request: &DynamicKeyDiscoveryRequest,
    mode: HelperInvocationMode,
) -> DynamicKeyDiscoveryRefusal {
    let helper_result = HelperResult {
        schema_version: HELPER_RESULT_SCHEMA_VERSION.to_string(),
        fixture_id: request.fixture_id.clone(),
        helper_result_id: format!("helper-result-{}", request.fixture_id),
        profile_id: request.profile_id.clone(),
        helper: HelperProvenance {
            helper_id: request.helper_binary_id.clone(),
            helper_version: "0.1.0".to_string(),
            helper_kind: HelperKind::RemoteWindowsHelper,
        },
        capability_level: HelperCapabilityLevel::RemoteWindows,
        execution: HelperExecutionSummary {
            mode: HelperResultExecutionMode::RemoteHelper,
            platform: DYNAMIC_KEY_DISCOVERY_PLATFORM_ID.to_string(),
            bounded: true,
            timeout_ms: request.timeout_ms,
            // Refused: nothing ran, nothing touched the network or filesystem.
            duration_ms: Some(0),
            network_access: false,
            filesystem_access: HelperExecutionFilesystemAccess::None,
        },
        diagnostic: HelperDiagnostic {
            code: HelperDiagnosticCode::HelperAuthorizationDenied,
            message: format!(
                "{SEMANTIC_DYNAMIC_KEY_HELPER_DISABLED}: dynamic-key-discovery helper is disabled in {} mode; enable it only via an explicit non-CI live opt-in",
                mode.mode_id()
            ),
        },
        redaction: HelperRedaction {
            status: HelperRedactionStatus::Redacted,
            redacted_log_hash: ProofHash::new(FIXTURE_REDACTED_LOG_HASH)
                .expect("fixture redacted-log hash is a valid sha256 ref"),
        },
        secret_refs: Vec::new(),
        proof_hashes: Vec::new(),
    };

    DynamicKeyDiscoveryRefusal {
        schema_version: DYNAMIC_KEY_DISCOVERY_HELPER_SCHEMA_VERSION.to_string(),
        fixture_id: request.fixture_id.clone(),
        requirement_id: request.requirement_id.clone(),
        mode,
        diagnostic: DynamicKeyDiscoveryDiagnostic {
            code: SEMANTIC_DYNAMIC_KEY_HELPER_DISABLED.to_string(),
            message: format!(
                "dynamic-key-discovery helper refused in {} mode (disabled by default)",
                mode.mode_id()
            ),
        },
        launched_untrusted_code: false,
        helper_result,
    }
}

fn build_response(request: &DynamicKeyDiscoveryRequest) -> DynamicKeyDiscoveryResponse {
    let discovered_secret_ref = SecretRef::new(FIXTURE_DISCOVERED_SECRET_REF)
        .expect("fixture discovered secret ref is a valid local secret ref");
    let proof = KeyValidationProof {
        method: KeyValidationMethod::DecryptHeaderProof,
        proof_hash: ProofHash::new(FIXTURE_KEY_PROOF_HASH)
            .expect("fixture key proof hash is a valid sha256 ref"),
    };

    let helper_result = HelperResult {
        schema_version: HELPER_RESULT_SCHEMA_VERSION.to_string(),
        fixture_id: request.fixture_id.clone(),
        helper_result_id: format!("helper-result-{}", request.fixture_id),
        profile_id: request.profile_id.clone(),
        helper: HelperProvenance {
            helper_id: request.helper_binary_id.clone(),
            helper_version: "0.1.0".to_string(),
            helper_kind: HelperKind::RemoteWindowsHelper,
        },
        capability_level: HelperCapabilityLevel::RemoteWindows,
        execution: HelperExecutionSummary {
            mode: HelperResultExecutionMode::RemoteHelper,
            platform: DYNAMIC_KEY_DISCOVERY_PLATFORM_ID.to_string(),
            bounded: true,
            timeout_ms: request.timeout_ms,
            duration_ms: Some(0),
            // A real remote helper reaches the game over the network; the shape
            // is modelled here, but nothing is launched from kaifuu.
            network_access: true,
            filesystem_access: HelperExecutionFilesystemAccess::None,
        },
        diagnostic: HelperDiagnostic {
            code: HelperDiagnosticCode::Success,
            message: "remote dynamic-key-discovery helper resolved a secret ref and proof hash"
                .to_string(),
        },
        redaction: HelperRedaction {
            status: HelperRedactionStatus::Redacted,
            redacted_log_hash: ProofHash::new(FIXTURE_REDACTED_LOG_HASH)
                .expect("fixture redacted-log hash is a valid sha256 ref"),
        },
        secret_refs: vec![HelperResultSecretRef {
            requirement_id: request.requirement_id.clone(),
            secret_ref: discovered_secret_ref.clone(),
            material_kind: request.material_kind,
            bytes: Some(16),
            validation: Some(proof.clone()),
        }],
        proof_hashes: vec![proof.clone()],
    };

    DynamicKeyDiscoveryResponse {
        schema_version: DYNAMIC_KEY_DISCOVERY_HELPER_SCHEMA_VERSION.to_string(),
        fixture_id: request.fixture_id.clone(),
        requirement_id: request.requirement_id.clone(),
        discovered_secret_ref,
        proof,
        launched_untrusted_code: false,
        helper_result,
    }
}

// Continuous-tier reference — pure adapters never depend on the helper.

/// Whether an adapter depends on the remote dynamic-key-discovery helper.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdapterHelperDependency {
    /// A pure static adapter: static-Rust extraction only, NO helper dependency.
    Pure,
    /// A continuous-tier adapter: needs the remote helper for runtime key
    /// discovery.
    Continuous,
}

impl AdapterHelperDependency {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pure => "pure",
            Self::Continuous => "continuous",
        }
    }
}

/// A single tier-reference entry: an engine, its helper dependency, and (only
/// for a continuous-tier engine) the helper binary it references.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdapterTierEntry {
    pub engine_id: String,
    pub dependency: AdapterHelperDependency,
    /// The helper binary this adapter references. `Some` only for a continuous
    /// adapter; a pure adapter must leave this `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper_binary_id: Option<String>,
}

impl AdapterTierEntry {
    /// A pure static adapter with no helper dependency.
    pub fn pure(engine_id: impl Into<String>) -> Self {
        Self {
            engine_id: engine_id.into(),
            dependency: AdapterHelperDependency::Pure,
            helper_binary_id: None,
        }
    }

    /// A continuous-tier adapter that references the remote helper.
    pub fn continuous(engine_id: impl Into<String>, helper_binary_id: impl Into<String>) -> Self {
        Self {
            engine_id: engine_id.into(),
            dependency: AdapterHelperDependency::Continuous,
            helper_binary_id: Some(helper_binary_id.into()),
        }
    }

    /// Whether this entry references the remote helper (a helper dependency).
    pub fn references_helper(&self) -> bool {
        self.helper_binary_id.is_some()
    }
}

/// The dynamic-key-discovery tier reference: a fixture listing the pure static
/// adapters (no helper dependency) alongside a continuous-tier engine that
/// DECLARES it needs the remote helper.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DynamicKeyHelperTierReference {
    pub schema_version: String,
    pub fixture_id: String,
    pub entries: Vec<AdapterTierEntry>,
}

impl DynamicKeyHelperTierReference {
    /// Renders the reference as stable JSON.
    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(self)
    }

    /// The pure static adapters (no helper dependency).
    pub fn pure_adapters(&self) -> impl Iterator<Item = &AdapterTierEntry> {
        self.entries
            .iter()
            .filter(|entry| entry.dependency == AdapterHelperDependency::Pure)
    }

    /// The continuous-tier adapters (helper-dependent).
    pub fn continuous_adapters(&self) -> impl Iterator<Item = &AdapterTierEntry> {
        self.entries
            .iter()
            .filter(|entry| entry.dependency == AdapterHelperDependency::Continuous)
    }

    /// Validates the tier reference, enforcing the pure-adapter law:
    /// 1. NO pure adapter may reference a helper binary (that would be a helper
    ///    dependency);
    /// 2. EVERY continuous adapter MUST reference a helper binary (otherwise it
    ///    is miscategorised);
    /// 3. each of [`PURE_ADAPTER_ENGINE_IDS`] must be present and pure;
    /// 4. no string field may carry raw key material or a local path, and the
    ///    standard secret-redaction boundary must find nothing.
    pub fn validate(&self) -> DynamicKeyDiscoveryValidation {
        let mut failures = Vec::new();

        for (index, entry) in self.entries.iter().enumerate() {
            match entry.dependency {
                AdapterHelperDependency::Pure => {
                    if entry.references_helper() {
                        failures.push(DynamicKeyDiscoveryFailure {
                            code: SEMANTIC_DYNAMIC_KEY_HELPER_PURE_ADAPTER_DEPENDENCY.to_string(),
                            field: format!("entries.{index}.helperBinaryId"),
                            message: format!(
                                "pure static adapter {} must not depend on the remote helper",
                                entry.engine_id
                            ),
                        });
                    }
                }
                AdapterHelperDependency::Continuous => {
                    if !entry.references_helper() {
                        failures.push(DynamicKeyDiscoveryFailure {
                            code: SEMANTIC_DYNAMIC_KEY_HELPER_RESULT_INVALID.to_string(),
                            field: format!("entries.{index}.helperBinaryId"),
                            message: format!(
                                "continuous-tier adapter {} must reference the remote helper it depends on",
                                entry.engine_id
                            ),
                        });
                    }
                }
            }
        }

        for engine_id in PURE_ADAPTER_ENGINE_IDS {
            let present_and_pure = self.entries.iter().any(|entry| {
                entry.engine_id == engine_id
                    && entry.dependency == AdapterHelperDependency::Pure
                    && !entry.references_helper()
            });
            if !present_and_pure {
                failures.push(DynamicKeyDiscoveryFailure {
                    code: SEMANTIC_DYNAMIC_KEY_HELPER_PURE_ADAPTER_DEPENDENCY.to_string(),
                    field: "entries".to_string(),
                    message: format!(
                        "pure static adapter {engine_id} must be present as a pure, helper-free entry"
                    ),
                });
            }
        }

        scan_value_for_leaks(self, &mut failures);

        DynamicKeyDiscoveryValidation::from_failures(&self.fixture_id, failures)
    }
}

/// The canonical dynamic-key-discovery tier reference: the five pure static
/// adapters (no helper dependency) plus one synthetic continuous-tier engine
/// that DECLARES it needs the remote helper.
pub fn dynamic_key_helper_tier_reference() -> DynamicKeyHelperTierReference {
    let mut entries: Vec<AdapterTierEntry> = PURE_ADAPTER_ENGINE_IDS
        .iter()
        .map(|engine_id| AdapterTierEntry::pure(*engine_id))
        .collect();
    // A synthetic continuous-tier engine: its key is derived at runtime and can
    // only be recovered by memory-scanning a launched game, so it declares a
    // dependency on the remote dynamic-key-discovery helper.
    entries.push(AdapterTierEntry::continuous(
        "runtime-scanned-key-adv",
        "kaifuu.fixture.remote-dynamic-key-helper",
    ));

    DynamicKeyHelperTierReference {
        schema_version: DYNAMIC_KEY_DISCOVERY_HELPER_SCHEMA_VERSION.to_string(),
        fixture_id: "kaifuu-dynamic-key-helper-tier-reference".to_string(),
        entries,
    }
}
