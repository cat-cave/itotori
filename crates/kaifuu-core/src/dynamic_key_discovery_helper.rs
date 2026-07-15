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

use crate::{
    HelperRedactionPolicy, HelperResult, KaifuuResult, KeyMaterialKind, KeyValidationProof,
    SecretRef, stable_json,
};

mod implementation;

pub use implementation::{
    AdapterHelperDependency, AdapterTierEntry, DynamicKeyDiscoveryFailure,
    DynamicKeyDiscoveryOutcome, DynamicKeyDiscoveryValidation, DynamicKeyHelperTierReference,
    attempt_dynamic_key_discovery, dynamic_key_helper_tier_reference,
};
use implementation::{scan_value_for_leaks, validate_nested_helper_result};

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
