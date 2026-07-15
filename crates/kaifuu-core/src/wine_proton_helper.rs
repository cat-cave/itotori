//! Wine/Proton helper adapter (dry-run only).
//! This module resolves what a Wine or Proton Windows helper *would* do —
//! naming the helper binary id, the platform adapter, the intended command,
//! the profile id, and the redaction policy — **without launching untrusted
//! game code**. It exists to make the helper wiring provable in public CI on a
//! runner that has no Wine, no Proton, and no private game assets.
//! Safety boundary (strict-proof):
//! - **Dry-run is resolve + validate + emit, never launch.** There is no
//!   `std::process` import in this module and no code path that spawns a
//!   binary. The resolver builds a *descriptor* of the intended command; it
//!   never runs it. [`WineProtonDryRunResolution::launched`] is always `false`
//!   and [`ResolvedHelperCommand::launches_untrusted_code`] is always `false`;
//!   [`WineProtonDryRunResolution::validate`] fails closed if either is ever
//!   `true`.
//! - **Never log raw secret material.** Every emitted helper result conforms to
//!   the [`HelperResult`] schema (refs + redacted fields only) and
//!   the resolution is deep-scanned for raw key
//!   material and local paths in *every* string field, regardless of field
//!   name. A resolution carrying raw secret material fails validation.
//! - **Unavailable platform is a typed diagnostic, not a crash.** When the
//!   synthetic request declares Wine/Proton unavailable, the resolver still
//!   resolves the intended command and emits a
//!   [`HelperDiagnosticCode::HelperUnavailable`] helper result carrying the
//!   [`SEMANTIC_HELPER_UNAVAILABLE`] semantic code.
//!   The dry-run path is deliberately *separate* from the in-process
//!   [`crate::HelperRegistry`] execution path: that registry actually invokes an
//!   adapter in-process, whereas a Wine/Proton helper must never execute at all
//!   from Kaifuu. Keeping them apart makes "no launch" structurally true rather
//!   than a runtime check.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    HELPER_RESULT_SCHEMA_VERSION, HelperCapabilityLevel, HelperDiagnostic, HelperDiagnosticCode,
    HelperExecutionFilesystemAccess, HelperExecutionSummary, HelperKind, HelperProvenance,
    HelperRedaction, HelperRedactionStatus, HelperResult, HelperResultExecutionMode, KaifuuResult,
    OperationStatus, ProofHash, SEMANTIC_HELPER_UNAVAILABLE, is_local_absolute_path,
    looks_like_raw_key_material, redact_for_log_or_report, stable_json,
    validate_helper_result_value, validate_secret_redaction_boundary,
};

/// Schema version for the Wine/Proton dry-run resolution artifact.
pub const WINE_PROTON_HELPER_SCHEMA_VERSION: &str = "0.1.0";

/// Support boundary surfaced by the Wine/Proton dry-run adapter.
pub const WINE_PROTON_HELPER_SUPPORT_BOUNDARY: &str = "Kaifuu's Wine/Proton helper adapter runs in dry-run only: it resolves the helper binary id, platform adapter, intended command, profile id, and redaction policy WITHOUT launching untrusted game code. No process is ever spawned; no Wine or Proton install is required. Helper results carry secret references and redacted fields only — never raw key material — and unavailable platforms are typed diagnostics, not crashes.";

/// Semantic code: the resolution (or a nested helper result) carried raw secret
/// material, which is forbidden.
pub const SEMANTIC_WINE_PROTON_DRY_RUN_SECRET_LEAK: &str = "kaifuu.wine_proton.dry_run.secret_leak";
/// Semantic code: the resolution asserted (or attempted) a launch of untrusted
/// game code, which the dry-run path forbids.
pub const SEMANTIC_WINE_PROTON_DRY_RUN_LAUNCH_FORBIDDEN: &str =
    "kaifuu.wine_proton.dry_run.launch_forbidden";
/// Semantic code: the nested helper result failed schema validation.
pub const SEMANTIC_WINE_PROTON_DRY_RUN_HELPER_RESULT_INVALID: &str =
    "kaifuu.wine_proton.dry_run.helper_result_invalid";

/// Synthetic redacted-log hash surfaced by fixture dry-run results. Clearly
/// fake fixture material (never a real log digest).
const FIXTURE_REDACTED_LOG_HASH: &str =
    "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

/// The platform adapter a Wine/Proton helper would run under.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WineProtonPlatformAdapter {
    /// A local Wine prefix on the host.
    WineLocal,
    /// A local Proton (Steam Play) runtime on the host.
    ProtonLocal,
}

impl WineProtonPlatformAdapter {
    /// A stable, non-secret platform identifier surfaced in helper results.
    pub fn platform_id(self) -> &'static str {
        match self {
            Self::WineLocal => "wine-local-windows",
            Self::ProtonLocal => "proton-local-windows",
        }
    }

    /// The launcher *reference* (never a path, never executed) the intended
    /// command would front with.
    pub fn launcher_ref(self) -> &'static str {
        match self {
            Self::WineLocal => "wine",
            Self::ProtonLocal => "proton",
        }
    }

    /// The helper kind. Proton is a Wine derivative, so both resolve
    /// to the local Windows helper kind.
    pub fn helper_kind(self) -> HelperKind {
        HelperKind::WineLocalWindowsHelper
    }

    /// The capability level for a local Wine/Proton helper.
    pub fn capability_level(self) -> HelperCapabilityLevel {
        HelperCapabilityLevel::WineLocal
    }
}

/// The redaction policy the helper result is emitted under.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HelperRedactionPolicy {
    /// Raw helper logs and any recovered key material are redacted to
    /// references before anything is serialized or reported.
    RedactRawLogsAndSecretRefs,
}

impl HelperRedactionPolicy {
    /// A stable, non-secret policy identifier surfaced in the resolution.
    pub fn policy_id(self) -> &'static str {
        match self {
            Self::RedactRawLogsAndSecretRefs => "redact-raw-logs-and-secret-refs",
        }
    }
}

/// Whether the synthetic runner declares the Wine/Proton platform available.
/// This is an explicit input on the request rather than a live probe: the
/// dry-run path never shells out to Wine/Proton, so availability is supplied by
/// the (synthetic) fixture. Public CI runs the "unavailable" fixture with no
/// Wine/Proton present and still gets a typed diagnostic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlatformAvailability {
    /// The platform helper is present on the runner.
    Available,
    /// The platform helper is absent on the runner.
    Unavailable,
}

/// A Wine/Proton dry-run request. Its shape is constrained (`deny_unknown_fields`)
/// so callers cannot smuggle raw execution config or secret material through
/// arbitrary keys.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WineProtonDryRunRequest {
    pub schema_version: String,
    pub fixture_id: String,
    pub helper_binary_id: String,
    pub allowlist_entry_id: String,
    pub platform_adapter: WineProtonPlatformAdapter,
    pub profile_id: String,
    pub redaction_policy: HelperRedactionPolicy,
    pub platform_availability: PlatformAvailability,
    pub timeout_ms: u32,
}

/// The resolved shape of the command a Wine/Proton helper *would* run.
/// This is a descriptor, not an execution plan handed to any spawner. The
/// `program_ref` is a launcher *reference* (`wine` / `proton`), never a
/// filesystem path, and `argument_template` holds template tokens only — never
/// secret material.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvedHelperCommand {
    pub program_ref: String,
    pub argument_template: Vec<String>,
    pub working_directory_policy: String,
    /// Always `false`. Present as an explicit, validated proof that the dry-run
    /// descriptor never launches untrusted game code.
    pub launches_untrusted_code: bool,
}

/// The full dry-run resolution: it names the five required fields
/// (helper-binary-id, platform-adapter, intended-command, profile-id,
/// redaction-policy) and carries a -conformant helper result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WineProtonDryRunResolution {
    pub schema_version: String,
    pub fixture_id: String,
    pub helper_binary_id: String,
    pub platform_adapter: WineProtonPlatformAdapter,
    pub intended_command: ResolvedHelperCommand,
    pub profile_id: String,
    pub redaction_policy: HelperRedactionPolicy,
    /// Always `false`. Explicit proof that resolving the dry-run did not launch
    /// the game binary.
    pub launched: bool,
    pub helper_result: HelperResult,
}

impl WineProtonDryRunResolution {
    /// Deep-scans + normalizes the resolution and renders it as stable JSON.
    pub fn stable_json(&self) -> KaifuuResult<String> {
        let mut resolution = self.clone();
        resolution.helper_result.normalize();
        stable_json(&resolution)
    }

    /// Validates the resolution:
    /// 1. `launched` and `intendedCommand.launchesUntrustedCode` must be
    ///    `false` (no launch);
    /// 2. no string field anywhere may carry raw key material or a local path
    ///    (deep-scan)
    /// 3. the standard secret-redaction boundary must find nothing;
    /// 4. the nested helper result must pass schema validation.
    pub fn validate(&self) -> WineProtonDryRunValidation {
        let mut failures = Vec::new();

        if self.launched || self.intended_command.launches_untrusted_code {
            failures.push(WineProtonDryRunFailure {
                code: SEMANTIC_WINE_PROTON_DRY_RUN_LAUNCH_FORBIDDEN.to_string(),
                field: "launched".to_string(),
                message: "dry-run must never launch untrusted game code".to_string(),
            });
        }

        let Ok(value) = serde_json::to_value(self) else {
            failures.push(WineProtonDryRunFailure {
                code: SEMANTIC_WINE_PROTON_DRY_RUN_HELPER_RESULT_INVALID.to_string(),
                field: "$".to_string(),
                message: "resolution could not be serialized for validation".to_string(),
            });
            return WineProtonDryRunValidation::from_failures(&self.fixture_id, failures);
        };

        deep_scan_raw_secret_material(&value, "$", &mut failures);

        for finding in validate_secret_redaction_boundary(&value) {
            failures.push(WineProtonDryRunFailure {
                code: SEMANTIC_WINE_PROTON_DRY_RUN_SECRET_LEAK.to_string(),
                field: finding.field,
                message: finding.reason,
            });
        }

        if let Some(helper_result) = value.get("helperResult") {
            let helper_validation = validate_helper_result_value(helper_result);
            if helper_validation.status == OperationStatus::Failed {
                for failure in helper_validation.failures {
                    failures.push(WineProtonDryRunFailure {
                        code: SEMANTIC_WINE_PROTON_DRY_RUN_HELPER_RESULT_INVALID.to_string(),
                        field: format!("helperResult.{}", failure.field),
                        message: failure.message,
                    });
                }
            }
        }

        WineProtonDryRunValidation::from_failures(&self.fixture_id, failures)
    }
}

/// Deep-scans every string in `value` for raw key material or a local absolute
/// path, regardless of the field name it hides behind.
fn deep_scan_raw_secret_material(
    value: &Value,
    field: &str,
    failures: &mut Vec<WineProtonDryRunFailure>,
) {
    match value {
        Value::String(text) => {
            if looks_like_raw_key_material(text) {
                failures.push(WineProtonDryRunFailure {
                    code: SEMANTIC_WINE_PROTON_DRY_RUN_SECRET_LEAK.to_string(),
                    field: field.to_string(),
                    message: "raw key-like material must be referenced through secretRef, never serialized".to_string(),
                });
            } else if is_local_absolute_path(text) {
                failures.push(WineProtonDryRunFailure {
                    code: SEMANTIC_WINE_PROTON_DRY_RUN_SECRET_LEAK.to_string(),
                    field: field.to_string(),
                    message: "local absolute paths must be redacted from helper resolutions"
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

/// The outcome of validating a [`WineProtonDryRunResolution`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WineProtonDryRunValidation {
    pub schema_version: String,
    pub fixture_id: Option<String>,
    pub status: OperationStatus,
    pub failures: Vec<WineProtonDryRunFailure>,
}

impl WineProtonDryRunValidation {
    fn from_failures(fixture_id: &str, failures: Vec<WineProtonDryRunFailure>) -> Self {
        let status = if failures.is_empty() {
            OperationStatus::Passed
        } else {
            OperationStatus::Failed
        };
        Self {
            schema_version: WINE_PROTON_HELPER_SCHEMA_VERSION.to_string(),
            fixture_id: Some(redact_for_log_or_report(fixture_id)),
            status,
            failures: failures
                .iter()
                .map(WineProtonDryRunFailure::redacted_for_report)
                .collect(),
        }
    }
}

/// A single validation failure for a dry-run resolution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WineProtonDryRunFailure {
    pub code: String,
    pub field: String,
    pub message: String,
}

impl WineProtonDryRunFailure {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
        }
    }
}

/// Resolves a Wine/Proton dry-run **without launching untrusted game code**.
/// Given a synthetic request, this names the helper binary id, platform
/// adapter, intended command, profile id, and redaction policy, and emits a
/// helper result. When the platform is unavailable the helper result
/// carries a typed [`HelperDiagnosticCode::HelperUnavailable`] diagnostic
/// instead of crashing.
/// use kaifuu_core::{
/// resolve_wine_proton_dry_run, HelperRedactionPolicy, PlatformAvailability,
/// WineProtonDryRunRequest, WineProtonPlatformAdapter, WINE_PROTON_HELPER_SCHEMA_VERSION,
/// let request = WineProtonDryRunRequest {
/// schema_version: WINE_PROTON_HELPER_SCHEMA_VERSION.to_string,
/// fixture_id: "kaifuu-wine-proton-dry-run".to_string,
/// helper_binary_id: "kaifuu.fixture.wine-local-windows".to_string,
/// allowlist_entry_id: "kaifuu-fixture-wine-local-allowlist".to_string,
/// platform_adapter: WineProtonPlatformAdapter::WineLocal,
/// profile_id: "019ed000-0000-7000-8000-profile00090".to_string,
/// redaction_policy: HelperRedactionPolicy::RedactRawLogsAndSecretRefs,
/// platform_availability: PlatformAvailability::Available,
/// timeout_ms: 5000,
/// let resolution = resolve_wine_proton_dry_run(&request);
/// assert!(!resolution.launched);
/// assert!(!resolution.intended_command.launches_untrusted_code);
/// assert_eq!(resolution.validate.status, kaifuu_core::OperationStatus::Passed);
pub fn resolve_wine_proton_dry_run(
    request: &WineProtonDryRunRequest,
) -> WineProtonDryRunResolution {
    let adapter = request.platform_adapter;

    // Deterministically DERIVE the intended command from the request identity.
    // Args are template tokens only; nothing here is secret or launched.
    let intended_command = ResolvedHelperCommand {
        program_ref: adapter.launcher_ref().to_string(),
        argument_template: vec![
            "--platform".to_string(),
            adapter.platform_id().to_string(),
            "--helper-binary-id".to_string(),
            request.helper_binary_id.clone(),
            "--profile-id".to_string(),
            request.profile_id.clone(),
            "--redaction-policy".to_string(),
            request.redaction_policy.policy_id().to_string(),
            "--dry-run".to_string(),
        ],
        working_directory_policy: "sandboxed-read-only-game-copy".to_string(),
        launches_untrusted_code: false,
    };

    // A dry-run resolves the intended plan but never runs the helper, so it
    // recovers no key material. `helper_required` (not `success`) is the honest
    // diagnostic for a resolvable-but-unrun helper; `helper_unavailable` is the
    // typed diagnostic when the platform is absent. Neither requires a recovered
    // secretRef/proof under the matrix.
    let (diagnostic_code, diagnostic_message) = match request.platform_availability {
        PlatformAvailability::Available => (
            HelperDiagnosticCode::HelperRequired,
            format!(
                "dry-run resolved the intended {} helper command without launching untrusted game code; running the helper is required to actually recover material",
                adapter.platform_id()
            ),
        ),
        PlatformAvailability::Unavailable => (
            HelperDiagnosticCode::HelperUnavailable,
            format!(
                "{SEMANTIC_HELPER_UNAVAILABLE}: {} platform helper is unavailable on this runner; dry-run resolved the intended command without launching",
                adapter.platform_id()
            ),
        ),
    };

    let helper_result = HelperResult {
        schema_version: HELPER_RESULT_SCHEMA_VERSION.to_string(),
        fixture_id: request.fixture_id.clone(),
        helper_result_id: format!("helper-result-{}", request.fixture_id),
        profile_id: request.profile_id.clone(),
        helper: HelperProvenance {
            helper_id: request.helper_binary_id.clone(),
            helper_version: "0.1.0".to_string(),
            helper_kind: adapter.helper_kind(),
        },
        capability_level: adapter.capability_level(),
        execution: HelperExecutionSummary {
            // The result describes the platform-helper path (per the
            // Wine matrix); `durationMs: 0` and the `launched: false` proof show
            // the dry-run resolved the plan without ever executing it.
            mode: HelperResultExecutionMode::PlatformHelper,
            platform: adapter.platform_id().to_string(),
            bounded: true,
            timeout_ms: request.timeout_ms,
            duration_ms: Some(0),
            network_access: false,
            filesystem_access: HelperExecutionFilesystemAccess::LocalGameReadOnly,
        },
        diagnostic: HelperDiagnostic {
            code: diagnostic_code,
            message: diagnostic_message,
        },
        redaction: HelperRedaction {
            status: HelperRedactionStatus::Redacted,
            redacted_log_hash: ProofHash::new(FIXTURE_REDACTED_LOG_HASH)
                .expect("fixture redacted-log hash is a valid sha256 ref"),
        },
        secret_refs: Vec::new(),
        proof_hashes: Vec::new(),
    };

    WineProtonDryRunResolution {
        schema_version: WINE_PROTON_HELPER_SCHEMA_VERSION.to_string(),
        fixture_id: request.fixture_id.clone(),
        helper_binary_id: request.helper_binary_id.clone(),
        platform_adapter: adapter,
        intended_command,
        profile_id: request.profile_id.clone(),
        redaction_policy: request.redaction_policy,
        launched: false,
        helper_result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(
        adapter: WineProtonPlatformAdapter,
        availability: PlatformAvailability,
    ) -> WineProtonDryRunRequest {
        WineProtonDryRunRequest {
            schema_version: WINE_PROTON_HELPER_SCHEMA_VERSION.to_string(),
            fixture_id: "kaifuu-wine-proton-dry-run".to_string(),
            helper_binary_id: "kaifuu.fixture.wine-local-windows".to_string(),
            allowlist_entry_id: "kaifuu-fixture-wine-local-allowlist".to_string(),
            platform_adapter: adapter,
            profile_id: "019ed000-0000-7000-8000-profile00090".to_string(),
            redaction_policy: HelperRedactionPolicy::RedactRawLogsAndSecretRefs,
            platform_availability: availability,
            timeout_ms: 5000,
        }
    }

    #[test]
    fn dry_run_names_five_required_fields_without_launching() {
        let resolution = resolve_wine_proton_dry_run(&request(
            WineProtonPlatformAdapter::WineLocal,
            PlatformAvailability::Available,
        ));

        // (1) helper-binary-id
        assert_eq!(
            resolution.helper_binary_id,
            "kaifuu.fixture.wine-local-windows"
        );
        // (2) platform-adapter
        assert_eq!(
            resolution.platform_adapter,
            WineProtonPlatformAdapter::WineLocal
        );
        // (3) intended-command (resolved shape)
        assert_eq!(resolution.intended_command.program_ref, "wine");
        assert!(
            resolution
                .intended_command
                .argument_template
                .contains(&"--dry-run".to_string())
        );
        // (4) profile-id
        assert_eq!(
            resolution.profile_id,
            "019ed000-0000-7000-8000-profile00090"
        );
        // (5) redaction-policy
        assert_eq!(
            resolution.redaction_policy,
            HelperRedactionPolicy::RedactRawLogsAndSecretRefs
        );

        // No launch.
        assert!(!resolution.launched);
        assert!(!resolution.intended_command.launches_untrusted_code);

        assert_eq!(resolution.validate().status, OperationStatus::Passed);
        assert_eq!(
            resolution.helper_result.diagnostic.code,
            HelperDiagnosticCode::HelperRequired
        );
        assert_eq!(
            resolution.helper_result.execution.mode,
            HelperResultExecutionMode::PlatformHelper
        );
        // Even the "platform helper" path never actually executed.
        assert_eq!(resolution.helper_result.execution.duration_ms, Some(0));
    }

    #[test]
    fn proton_adapter_resolves_to_proton_launcher_ref() {
        let resolution = resolve_wine_proton_dry_run(&request(
            WineProtonPlatformAdapter::ProtonLocal,
            PlatformAvailability::Available,
        ));
        assert_eq!(resolution.intended_command.program_ref, "proton");
        assert_eq!(
            resolution.helper_result.execution.platform,
            "proton-local-windows"
        );
        assert_eq!(resolution.validate().status, OperationStatus::Passed);
    }

    #[test]
    fn unavailable_platform_emits_typed_helper_unavailable_diagnostic() {
        let resolution = resolve_wine_proton_dry_run(&request(
            WineProtonPlatformAdapter::ProtonLocal,
            PlatformAvailability::Unavailable,
        ));

        assert_eq!(
            resolution.helper_result.diagnostic.code,
            HelperDiagnosticCode::HelperUnavailable
        );
        assert_eq!(
            resolution.helper_result.diagnostic.code.semantic_code(),
            SEMANTIC_HELPER_UNAVAILABLE
        );
        assert!(
            resolution
                .helper_result
                .diagnostic
                .message
                .contains(SEMANTIC_HELPER_UNAVAILABLE)
        );
        // Still resolves the intended command, still does not launch.
        assert!(!resolution.launched);
        assert_eq!(resolution.validate().status, OperationStatus::Passed);
    }

    #[test]
    fn helper_result_conforms_to_kaifuu_085_and_carries_no_raw_secret() {
        let resolution = resolve_wine_proton_dry_run(&request(
            WineProtonPlatformAdapter::WineLocal,
            PlatformAvailability::Available,
        ));

        let helper_value = serde_json::to_value(&resolution.helper_result).unwrap();
        assert_eq!(
            validate_helper_result_value(&helper_value).status,
            OperationStatus::Passed
        );

        let serialized = resolution.stable_json().unwrap();
        // The execution object never carries a launch command.
        assert!(!serialized.contains("\"command\""));
        assert!(!serialized.contains("\"argv\""));
        assert!(!serialized.contains("\"env\""));
    }

    #[test]
    fn resolution_carrying_raw_secret_material_fails_validation() {
        let mut resolution = resolve_wine_proton_dry_run(&request(
            WineProtonPlatformAdapter::WineLocal,
            PlatformAvailability::Available,
        ));
        // Inject clearly-fake 32-hex "recovered key" bytes into an otherwise
        // innocuous field: the deep-scan must reject it.
        resolution.helper_binary_id = "0123456789abcdef0123456789abcdef".to_string();

        let validation = resolution.validate();
        assert_eq!(validation.status, OperationStatus::Failed);
        assert!(
            validation
                .failures
                .iter()
                .any(|failure| failure.code == SEMANTIC_WINE_PROTON_DRY_RUN_SECRET_LEAK)
        );
    }

    #[test]
    fn resolution_asserting_launch_fails_validation() {
        let mut resolution = resolve_wine_proton_dry_run(&request(
            WineProtonPlatformAdapter::WineLocal,
            PlatformAvailability::Available,
        ));
        resolution.launched = true;

        let validation = resolution.validate();
        assert_eq!(validation.status, OperationStatus::Failed);
        assert!(
            validation
                .failures
                .iter()
                .any(|failure| failure.code == SEMANTIC_WINE_PROTON_DRY_RUN_LAUNCH_FORBIDDEN)
        );
    }

    #[test]
    fn resolution_round_trips_through_stable_json() {
        let resolution = resolve_wine_proton_dry_run(&request(
            WineProtonPlatformAdapter::WineLocal,
            PlatformAvailability::Available,
        ));
        let serialized = resolution.stable_json().unwrap();
        let parsed: WineProtonDryRunResolution = serde_json::from_str(&serialized).unwrap();
        assert_eq!(parsed.platform_adapter, resolution.platform_adapter);
        assert_eq!(parsed.helper_binary_id, resolution.helper_binary_id);
    }
}
