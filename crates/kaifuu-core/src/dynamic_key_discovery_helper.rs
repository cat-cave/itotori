//! Dynamic-key-discovery REMOTE HELPER boundary (reference tier).
//! A small family of engines derive their archive key at *runtime*: the key is
//! never present in a shippable static form, and recovering it requires scanning
//! the memory of a *launched* game process. Static-Rust extraction cannot reach
//! it. For those engines the key must come from a **remote helper** — a separate
//! binary that launches the game and memory-scans it — which is exactly the
//! `no-shell-out-in-the-shipped-pipeline` boundary.
//! This module captures that boundary as a **continuous-tier REFERENCE**. It is
//! deliberately *not* a shipped shell-out: nothing here spawns a process, opens
//! a socket, or scans memory. There is no `std::process`, no `std::net`, no
//! socket import in this file. It defines the *typed request/response shape* of
//! such a helper call, the disabled-by-default gate that keeps it out of the
//! shipped pipeline, and a tier reference proving the pure static adapters never
//! depend on it. A real remote helper binary lives entirely outside kaifuu; the
//! shipped pipeline only ever *references* the boundary defined here.
//! Three governing LAWS, each structurally enforced:
//! - **Optional + disabled by default.** [`HelperInvocationMode`] gates every
//!   call. Its default is [`HelperInvocationMode::PublicFixture`], and both the
//!   public-fixture and CI modes are DISABLED: [`attempt_dynamic_key_discovery`]
//!   refuses with a typed [`DynamicKeyDiscoveryRefusal`] and never produces a
//!   response. Only the explicit, non-CI [`HelperInvocationMode::LiveOptIn`]
//!   (a real dynamic-key engine, opted in by an operator) enables the boundary.
//! - **Refs + proof hashes, never raw material.** The request names what is
//!   needed — a secret *requirement id* and a non-secret *scan target* — never a
//!   raw key. The response carries a [`SecretRef`] plus a one-way sha256
//!   [`ProofHash`] (via [`KeyValidationProof`]) — never the discovered key or any
//!   scanned memory. Every artifact deep-scans for raw
//!   key-like material and local paths in *every* string field and fails closed
//!   if any is found.
//! - **Pure adapters never depend on it.** The pure static adapters
//!   (RealLive / RPG Maker MV-MZ / Softpal / KiriKiri / TyranoScript) are
//!   [`AdapterHelperDependency::Pure`] and carry no helper binary reference. Only
//!   a continuous-tier engine may reference the helper. The tier reference's
//!   validator fails if any pure adapter names a helper binary.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    HELPER_RESULT_SCHEMA_VERSION, HelperCapabilityLevel, HelperDiagnostic, HelperDiagnosticCode,
    HelperExecutionFilesystemAccess, HelperExecutionSummary, HelperKind, HelperProvenance,
    HelperRedaction, HelperRedactionPolicy, HelperRedactionStatus, HelperResult,
    HelperResultExecutionMode, HelperResultSecretRef, KaifuuResult, KeyMaterialKind,
    KeyValidationMethod, KeyValidationProof, OperationStatus, ProofHash, SecretRef,
    is_local_absolute_path, looks_like_raw_key_material, redact_for_log_or_report, stable_json,
    validate_helper_result_value, validate_secret_redaction_boundary,
};

/// Schema version for the dynamic-key-discovery helper boundary artifacts.
pub const DYNAMIC_KEY_DISCOVERY_HELPER_SCHEMA_VERSION: &str = "0.1.0";

/// The stable, non-secret platform id surfaced in the helper result
/// for a remote dynamic-key-discovery helper.
pub const DYNAMIC_KEY_DISCOVERY_PLATFORM_ID: &str = "remote-dynamic-key-helper";

/// The support boundary surfaced by the dynamic-key-discovery reference.
pub const DYNAMIC_KEY_DISCOVERY_HELPER_SUPPORT_BOUNDARY: &str = "Kaifuu's dynamic-key-discovery helper is a REMOTE HELPER boundary REFERENCE, not a shipped shell-out: it types the request/response of a helper that would launch a game and memory-scan it to recover a runtime-derived key, but nothing here spawns a process, opens a socket, or scans memory. The helper is OPTIONAL and DISABLED BY DEFAULT — public-fixture and CI modes refuse any call with a typed diagnostic; only an explicit non-CI live opt-in enables it. Requests carry a secret requirement id and a non-secret scan target (never a raw key); responses carry a secret ref plus a one-way sha256 proof hash (never the discovered key or scanned memory). The pure static adapters (RealLive, RPG Maker MV-MZ, Softpal, KiriKiri, TyranoScript) never depend on it.";

/// Semantic code: a helper call was attempted in a disabled mode
/// (public-fixture or CI). The call is refused, never executed.
pub const SEMANTIC_DYNAMIC_KEY_HELPER_DISABLED: &str = "kaifuu.dynamic_key_helper.disabled_in_mode";
/// Semantic code: a request, response, or refusal carried raw secret material,
/// which is forbidden.
pub const SEMANTIC_DYNAMIC_KEY_HELPER_SECRET_LEAK: &str = "kaifuu.dynamic_key_helper.secret_leak";
/// Semantic code: an artifact asserted (or attempted) a launch of untrusted game
/// code, which this reference boundary forbids.
pub const SEMANTIC_DYNAMIC_KEY_HELPER_LAUNCH_FORBIDDEN: &str =
    "kaifuu.dynamic_key_helper.launch_forbidden";
/// Semantic code: a nested helper result failed schema validation.
pub const SEMANTIC_DYNAMIC_KEY_HELPER_RESULT_INVALID: &str =
    "kaifuu.dynamic_key_helper.helper_result_invalid";
/// Semantic code: a pure static adapter declared a dependency on the remote
/// helper (a helper binary ref), violating the pure-adapter law.
pub const SEMANTIC_DYNAMIC_KEY_HELPER_PURE_ADAPTER_DEPENDENCY: &str =
    "kaifuu.dynamic_key_helper.pure_adapter_dependency";

/// The pure static adapters that must NEVER depend on the remote helper. These
/// are exactly the engine families kaifuu extracts with static-Rust only.
pub const PURE_ADAPTER_ENGINE_IDS: [&str; 5] = [
    "reallive",
    "rpgmaker-mv-mz",
    "softpal",
    "kirikiri",
    "tyranoscript",
];

/// Synthetic redacted-log hash surfaced by fixture helper results. Clearly fake
/// fixture material (never a real log digest).
const FIXTURE_REDACTED_LOG_HASH: &str =
    "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

/// Synthetic key-validation proof hash surfaced by the resolved fixture
/// response. Clearly fake fixture material (never a real key digest).
const FIXTURE_KEY_PROOF_HASH: &str =
    "sha256:abababababababababababababababababababababababababababababababab";

/// Synthetic secret ref surfaced by the resolved fixture response. A local
/// secret-ref scheme value — a *reference*, never the key.
const FIXTURE_DISCOVERED_SECRET_REF: &str = "local-secret:dyn-key-065";

// Mode gate — optional + disabled by default.

/// The mode a dynamic-key-discovery call runs under. The remote helper is
/// OPTIONAL and DISABLED BY DEFAULT: only [`Self::LiveOptIn`] enables it.
/// Availability is an explicit mode on the call, not a live probe — the shipped
/// pipeline never shells out, so nothing here decides availability by launching
/// anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum HelperInvocationMode {
    /// Public-fixture mode (committed proof, no private assets). DISABLED — the
    /// default, so the boundary is off unless explicitly enabled.
    #[default]
    PublicFixture,
    /// CI mode. DISABLED — the shipped/CI pipeline never requires the helper.
    Ci,
    /// A real dynamic-key engine, opted in by an operator on a non-CI host.
    /// The single mode that ENABLES the boundary.
    LiveOptIn,
}

impl HelperInvocationMode {
    /// Whether the remote helper is enabled in this mode. True only for
    /// [`Self::LiveOptIn`]; both public-fixture and CI modes are disabled.
    pub fn helper_enabled(self) -> bool {
        matches!(self, Self::LiveOptIn)
    }

    /// A stable, non-secret mode identifier surfaced in diagnostics.
    pub fn mode_id(self) -> &'static str {
        match self {
            Self::PublicFixture => "public-fixture",
            Self::Ci => "ci",
            Self::LiveOptIn => "live-opt-in",
        }
    }
}

// Request / response boundary types — refs + proof hashes only.

/// A dynamic-key-discovery helper request. Its shape is constrained
/// (`deny_unknown_fields`) so callers cannot smuggle raw execution config or
/// secret material through arbitrary keys.
/// It carries only what the helper *needs*: the secret `requirement_id` it must
/// satisfy and a non-secret `scan_target` descriptor of what it scans — never a
/// raw key, never a local path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DynamicKeyDiscoveryRequest {
    pub schema_version: String,
    pub fixture_id: String,
    pub helper_binary_id: String,
    pub allowlist_entry_id: String,
    /// The secret *requirement* the helper must satisfy — an id, never a value.
    pub requirement_id: String,
    /// A non-secret descriptor of what the helper scans (e.g. a process-image
    /// reference). Never a raw key, never a local path.
    pub scan_target: String,
    /// The kind of material the helper is expected to discover.
    pub material_kind: KeyMaterialKind,
    pub profile_id: String,
    pub redaction_policy: HelperRedactionPolicy,
    pub timeout_ms: u32,
}

impl DynamicKeyDiscoveryRequest {
    /// Renders the request as stable JSON.
    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(self)
    }

    /// Validates the request: no string field anywhere may carry raw key
    /// material or a local path (deep-scan), and the
    /// standard secret-redaction boundary must find nothing.
    pub fn validate(&self) -> DynamicKeyDiscoveryValidation {
        let mut failures = Vec::new();
        scan_value_for_leaks(self, &mut failures);
        DynamicKeyDiscoveryValidation::from_failures(&self.fixture_id, failures)
    }
}

/// A dynamic-key-discovery helper response. It carries only a [`SecretRef`] to
/// the discovered key plus a one-way sha256 [`KeyValidationProof`] — never the
/// raw discovered key or any scanned memory. `launched_untrusted_code` is always
/// `false`: this reference boundary never spawns game code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DynamicKeyDiscoveryResponse {
    pub schema_version: String,
    pub fixture_id: String,
    pub requirement_id: String,
    /// A reference to the discovered key — never the key itself.
    pub discovered_secret_ref: SecretRef,
    /// A one-way sha256 proof the discovered key is valid — never the key.
    pub proof: KeyValidationProof,
    /// Always `false`. Explicit proof this reference never launches game code.
    pub launched_untrusted_code: bool,
    pub helper_result: HelperResult,
}

impl DynamicKeyDiscoveryResponse {
    /// Deep-scans + normalizes the response and renders it as stable JSON.
    pub fn stable_json(&self) -> KaifuuResult<String> {
        let mut response = self.clone();
        response.helper_result.normalize();
        stable_json(&response)
    }

    /// Validates the response:
    /// 1. `launched_untrusted_code` must be `false` (no launch);
    /// 2. no string field anywhere may carry raw key material or a local path
    ///    (deep-scan) and the standard secret-redaction boundary must find
    ///    nothing;
    /// 3. the nested helper result must pass schema validation.
    pub fn validate(&self) -> DynamicKeyDiscoveryValidation {
        let mut failures = Vec::new();

        if self.launched_untrusted_code {
            failures.push(DynamicKeyDiscoveryFailure {
                code: SEMANTIC_DYNAMIC_KEY_HELPER_LAUNCH_FORBIDDEN.to_string(),
                field: "launchedUntrustedCode".to_string(),
                message: "the dynamic-key-discovery reference must never launch game code"
                    .to_string(),
            });
        }

        let value = scan_value_for_leaks(self, &mut failures);
        validate_nested_helper_result(&value, &mut failures);

        DynamicKeyDiscoveryValidation::from_failures(&self.fixture_id, failures)
    }
}

/// A typed diagnostic on a dynamic-key-discovery call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicKeyDiscoveryDiagnostic {
    pub code: String,
    pub message: String,
}

/// The refusal produced when a call is attempted in a disabled mode. It carries
/// no response, no secret ref, and no proof, and never launches.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DynamicKeyDiscoveryRefusal {
    pub schema_version: String,
    pub fixture_id: String,
    pub requirement_id: String,
    pub mode: HelperInvocationMode,
    pub diagnostic: DynamicKeyDiscoveryDiagnostic,
    /// Always `false`. A refused call never launches game code.
    pub launched_untrusted_code: bool,
    pub helper_result: HelperResult,
}

impl DynamicKeyDiscoveryRefusal {
    /// Deep-scans + normalizes the refusal and renders it as stable JSON.
    pub fn stable_json(&self) -> KaifuuResult<String> {
        let mut refusal = self.clone();
        refusal.helper_result.normalize();
        stable_json(&refusal)
    }

    /// Validates the refusal: it must not launch, must carry no secret material,
    /// and its nested helper result must pass validation.
    pub fn validate(&self) -> DynamicKeyDiscoveryValidation {
        let mut failures = Vec::new();

        if self.launched_untrusted_code {
            failures.push(DynamicKeyDiscoveryFailure {
                code: SEMANTIC_DYNAMIC_KEY_HELPER_LAUNCH_FORBIDDEN.to_string(),
                field: "launchedUntrustedCode".to_string(),
                message: "a refused call must never launch game code".to_string(),
            });
        }

        let value = scan_value_for_leaks(self, &mut failures);
        validate_nested_helper_result(&value, &mut failures);

        DynamicKeyDiscoveryValidation::from_failures(&self.fixture_id, failures)
    }
}

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

// Shared validation plumbing.

/// Serializes `artifact`, deep-scans every string for raw key material / local
/// paths, runs the standard secret-redaction boundary, and returns the JSON
/// value (so callers can reuse it, e.g. to validate a nested helper result).
fn scan_value_for_leaks<T: Serialize>(
    artifact: &T,
    failures: &mut Vec<DynamicKeyDiscoveryFailure>,
) -> Value {
    let Ok(value) = serde_json::to_value(artifact) else {
        failures.push(DynamicKeyDiscoveryFailure {
            code: SEMANTIC_DYNAMIC_KEY_HELPER_RESULT_INVALID.to_string(),
            field: "$".to_string(),
            message: "artifact could not be serialized for validation".to_string(),
        });
        return Value::Null;
    };

    deep_scan_raw_secret_material(&value, "$", failures);

    for finding in validate_secret_redaction_boundary(&value) {
        failures.push(DynamicKeyDiscoveryFailure {
            code: SEMANTIC_DYNAMIC_KEY_HELPER_SECRET_LEAK.to_string(),
            field: finding.field,
            message: finding.reason,
        });
    }

    value
}

/// Validates a nested `helperResult` object (if present) against the
/// schema, folding any failure into the dynamic-key-discovery failures.
fn validate_nested_helper_result(value: &Value, failures: &mut Vec<DynamicKeyDiscoveryFailure>) {
    if let Some(helper_result) = value.get("helperResult") {
        let helper_validation = validate_helper_result_value(helper_result);
        if helper_validation.status == OperationStatus::Failed {
            for failure in helper_validation.failures {
                failures.push(DynamicKeyDiscoveryFailure {
                    code: SEMANTIC_DYNAMIC_KEY_HELPER_RESULT_INVALID.to_string(),
                    field: format!("helperResult.{}", failure.field),
                    message: failure.message,
                });
            }
        }
    }
}

/// Deep-scans every string in `value` for raw key material or a local absolute
/// path, regardless of the field name it hides behind.
fn deep_scan_raw_secret_material(
    value: &Value,
    field: &str,
    failures: &mut Vec<DynamicKeyDiscoveryFailure>,
) {
    match value {
        Value::String(text) => {
            if looks_like_raw_key_material(text) {
                failures.push(DynamicKeyDiscoveryFailure {
                    code: SEMANTIC_DYNAMIC_KEY_HELPER_SECRET_LEAK.to_string(),
                    field: field.to_string(),
                    message: "raw key-like material must be referenced through secretRef, never serialized".to_string(),
                });
            } else if is_local_absolute_path(text) {
                failures.push(DynamicKeyDiscoveryFailure {
                    code: SEMANTIC_DYNAMIC_KEY_HELPER_SECRET_LEAK.to_string(),
                    field: field.to_string(),
                    message: "local absolute paths must be redacted from helper artifacts"
                        .to_string(),
                });
            }
        }
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                deep_scan_raw_secret_material(item, &format!("{field}.{index}"), failures);
            }
        }
        Value::Object(object) => {
            for (key, child) in object {
                let child_field = if field == "$" {
                    key.clone()
                } else {
                    format!("{field}.{key}")
                };
                deep_scan_raw_secret_material(child, &child_field, failures);
            }
        }
        _ => {}
    }
}

/// The outcome of validating a dynamic-key-discovery artifact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicKeyDiscoveryValidation {
    pub schema_version: String,
    pub fixture_id: Option<String>,
    pub status: OperationStatus,
    pub failures: Vec<DynamicKeyDiscoveryFailure>,
}

impl DynamicKeyDiscoveryValidation {
    fn from_failures(fixture_id: &str, failures: Vec<DynamicKeyDiscoveryFailure>) -> Self {
        let status = if failures.is_empty() {
            OperationStatus::Passed
        } else {
            OperationStatus::Failed
        };
        Self {
            schema_version: DYNAMIC_KEY_DISCOVERY_HELPER_SCHEMA_VERSION.to_string(),
            fixture_id: Some(redact_for_log_or_report(fixture_id)),
            status,
            failures: failures
                .iter()
                .map(DynamicKeyDiscoveryFailure::redacted_for_report)
                .collect(),
        }
    }
}

/// A single validation failure for a dynamic-key-discovery artifact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicKeyDiscoveryFailure {
    pub code: String,
    pub field: String,
    pub message: String,
}

impl DynamicKeyDiscoveryFailure {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> DynamicKeyDiscoveryRequest {
        DynamicKeyDiscoveryRequest {
            schema_version: DYNAMIC_KEY_DISCOVERY_HELPER_SCHEMA_VERSION.to_string(),
            fixture_id: "kaifuu-dynamic-key-discovery".to_string(),
            helper_binary_id: "kaifuu.fixture.remote-dynamic-key-helper".to_string(),
            allowlist_entry_id: "kaifuu-fixture-dynamic-key-allowlist".to_string(),
            requirement_id: "dyn-key-req-065".to_string(),
            scan_target: "process-image:fixture-adv-runtime".to_string(),
            material_kind: KeyMaterialKind::FixedBytes,
            profile_id: "019ed000-0000-7000-8000-profile00065".to_string(),
            redaction_policy: HelperRedactionPolicy::RedactRawLogsAndSecretRefs,
            timeout_ms: 5000,
        }
    }

    #[test]
    fn helper_disabled_by_default() {
        // Default mode is public-fixture, which is disabled.
        assert_eq!(
            HelperInvocationMode::default(),
            HelperInvocationMode::PublicFixture
        );
        assert!(!HelperInvocationMode::default().helper_enabled());
        assert!(!HelperInvocationMode::PublicFixture.helper_enabled());
        assert!(!HelperInvocationMode::Ci.helper_enabled());
        assert!(HelperInvocationMode::LiveOptIn.helper_enabled());
    }

    #[test]
    fn ci_and_public_fixture_modes_refuse_with_typed_diagnostic() {
        for mode in [
            HelperInvocationMode::PublicFixture,
            HelperInvocationMode::Ci,
        ] {
            let outcome = attempt_dynamic_key_discovery(&request(), mode);
            assert!(outcome.is_refused(), "{mode:?} must refuse");
            let refusal = outcome
                .refusal()
                .expect("refused outcome carries a refusal");
            // Typed diagnostic naming the disabled-in-mode semantic code.
            assert_eq!(
                refusal.diagnostic.code,
                SEMANTIC_DYNAMIC_KEY_HELPER_DISABLED
            );
            // No response, no launch.
            assert!(!refusal.launched_untrusted_code);
            // The nested helper result denies authorization and carries no secret.
            assert_eq!(
                refusal.helper_result.diagnostic.code,
                HelperDiagnosticCode::HelperAuthorizationDenied
            );
            assert!(refusal.helper_result.secret_refs.is_empty());
            assert!(refusal.helper_result.proof_hashes.is_empty());
            assert_eq!(refusal.validate().status, OperationStatus::Passed);
        }
    }

    #[test]
    fn live_opt_in_enables_and_resolves_ref_plus_proof() {
        let outcome = attempt_dynamic_key_discovery(&request(), HelperInvocationMode::LiveOptIn);
        assert!(outcome.is_resolved());
        let response = outcome
            .response()
            .expect("resolved outcome carries a response");

        // The response carries a secret REF and a sha256 PROOF hash — never a key.
        assert!(
            response
                .discovered_secret_ref
                .as_str()
                .starts_with("local-secret:")
        );
        assert!(response.proof.proof_hash.as_str().starts_with("sha256:"));
        // No launch, ever.
        assert!(!response.launched_untrusted_code);
        // The nested helper result is a valid remote-helper success.
        assert_eq!(
            response.helper_result.helper.helper_kind,
            HelperKind::RemoteWindowsHelper
        );
        assert_eq!(
            response.helper_result.execution.mode,
            HelperResultExecutionMode::RemoteHelper
        );
        assert_eq!(response.validate().status, OperationStatus::Passed);
    }

    #[test]
    fn request_carries_only_refs_no_raw_key_material() {
        // The request type has no field for a raw key; a valid request passes.
        assert_eq!(request().validate().status, OperationStatus::Passed);

        // Serialized request contains no raw key-like material anywhere.
        let serialized = request().stable_json().unwrap();
        assert!(!serialized.contains("\"rawKey\""));
        assert!(!serialized.contains("\"key\""));

        // Smuggling raw 32-hex key bytes through the scan target is rejected.
        let mut tampered = request();
        tampered.scan_target = "0123456789abcdef0123456789abcdef".to_string();
        let validation = tampered.validate();
        assert_eq!(validation.status, OperationStatus::Failed);
        assert!(
            validation
                .failures
                .iter()
                .any(|failure| failure.code == SEMANTIC_DYNAMIC_KEY_HELPER_SECRET_LEAK)
        );
    }

    #[test]
    fn response_carrying_raw_key_material_fails_validation() {
        let outcome = attempt_dynamic_key_discovery(&request(), HelperInvocationMode::LiveOptIn);
        let mut response = outcome.response().unwrap().clone();
        // Inject clearly-fake 32-hex "recovered key" bytes into an innocuous
        // field: the deep-scan must reject it.
        response.requirement_id = "0123456789abcdef0123456789abcdef".to_string();

        let validation = response.validate();
        assert_eq!(validation.status, OperationStatus::Failed);
        assert!(
            validation
                .failures
                .iter()
                .any(|failure| failure.code == SEMANTIC_DYNAMIC_KEY_HELPER_SECRET_LEAK)
        );
    }

    #[test]
    fn response_asserting_launch_fails_validation() {
        let outcome = attempt_dynamic_key_discovery(&request(), HelperInvocationMode::LiveOptIn);
        let mut response = outcome.response().unwrap().clone();
        response.launched_untrusted_code = true;

        let validation = response.validate();
        assert_eq!(validation.status, OperationStatus::Failed);
        assert!(
            validation
                .failures
                .iter()
                .any(|failure| failure.code == SEMANTIC_DYNAMIC_KEY_HELPER_LAUNCH_FORBIDDEN)
        );
    }

    #[test]
    fn response_serializes_no_launch_command_fields() {
        let outcome = attempt_dynamic_key_discovery(&request(), HelperInvocationMode::LiveOptIn);
        let serialized = outcome.response().unwrap().stable_json().unwrap();
        // The boundary never serializes a launch command / argv / env.
        assert!(!serialized.contains("\"command\""));
        assert!(!serialized.contains("\"argv\""));
        assert!(!serialized.contains("\"env\""));
    }

    #[test]
    fn tier_reference_declares_continuous_and_keeps_pure_adapters_helper_free() {
        let reference = dynamic_key_helper_tier_reference();
        assert_eq!(reference.validate().status, OperationStatus::Passed);

        // Exactly one continuous-tier engine, and it references the helper.
        let continuous: Vec<_> = reference.continuous_adapters().collect();
        assert_eq!(continuous.len(), 1);
        assert!(continuous[0].references_helper());
        assert_eq!(continuous[0].engine_id, "runtime-scanned-key-adv");

        // Every named pure static adapter is present, pure, and helper-free.
        for engine_id in PURE_ADAPTER_ENGINE_IDS {
            let entry = reference
                .entries
                .iter()
                .find(|entry| entry.engine_id == engine_id)
                .unwrap_or_else(|| panic!("{engine_id} must be present"));
            assert_eq!(entry.dependency, AdapterHelperDependency::Pure);
            assert!(
                !entry.references_helper(),
                "{engine_id} must not depend on the helper"
            );
        }
    }

    #[test]
    fn pure_adapter_referencing_helper_fails_validation() {
        let mut reference = dynamic_key_helper_tier_reference();
        // Make a pure adapter depend on the remote helper: the law forbids it.
        let reallive = reference
            .entries
            .iter_mut()
            .find(|entry| entry.engine_id == "reallive")
            .unwrap();
        reallive.helper_binary_id = Some("kaifuu.fixture.remote-dynamic-key-helper".to_string());

        let validation = reference.validate();
        assert_eq!(validation.status, OperationStatus::Failed);
        assert!(
            validation
                .failures
                .iter()
                .any(|failure| failure.code == SEMANTIC_DYNAMIC_KEY_HELPER_PURE_ADAPTER_DEPENDENCY)
        );
    }

    #[test]
    fn artifacts_round_trip_through_stable_json() {
        let outcome = attempt_dynamic_key_discovery(&request(), HelperInvocationMode::LiveOptIn);
        let response = outcome.response().unwrap();
        let serialized = response.stable_json().unwrap();
        let parsed: DynamicKeyDiscoveryResponse = serde_json::from_str(&serialized).unwrap();
        assert_eq!(parsed.requirement_id, response.requirement_id);
        assert_eq!(
            parsed.discovered_secret_ref.as_str(),
            response.discovered_secret_ref.as_str()
        );

        let reference = dynamic_key_helper_tier_reference();
        let reference_json = reference.stable_json().unwrap();
        let parsed_reference: DynamicKeyHelperTierReference =
            serde_json::from_str(&reference_json).unwrap();
        assert_eq!(parsed_reference.entries, reference.entries);
    }
}
