//! Native Windows local helper adapter (dry-run only).
//! This is the native-Windows analogue of 's Wine/Proton helper
//! dry-run ([`crate::wine_proton_helper`]). It resolves what a *native* Windows
//! helper binary *would* do — naming the platform adapter (`native-windows`),
//! the helper binary id, the intended command (both the argv template **and**
//! the CommandLineToArgvW-quoted command line), the working-directory policy,
//! the profile id, and the redaction policy — **without launching untrusted
//! game code**. It exists to make the native-Windows helper wiring provable in
//! public CI on a runner that is not Windows and has no private game assets.
//! Safety boundary (strict-proof), identical in spirit
//! - **Dry-run is resolve + validate + emit, never launch.** There is no
//!   `std::process` import in this module and no code path that spawns a
//!   binary. The resolver builds a *descriptor* of the intended command — the
//!   Windows command line is produced by a pure quoting function, never handed
//!   to a spawner. [`NativeWindowsDryRunResolution::launched`] is always
//!   `false` and [`ResolvedWindowsHelperCommand::launches_untrusted_code`] is
//!   always `false`; [`NativeWindowsDryRunResolution::validate`] fails closed if
//!   either is ever `true`.
//! - **Never serialize raw secret material.** Every emitted helper result
//!   conforms to the [`HelperResult`] schema (refs + redacted fields
//!   only) and the resolution is deep-scanned for raw
//!   key material and local paths in *every* string field, regardless of field
//!   name. A resolution carrying raw secret material fails validation.
//! - **Unavailable platform is a typed diagnostic, not a crash.** When the
//!   synthetic request declares native-Windows unavailable (e.g. public CI runs
//!   on Linux), the resolver still resolves the intended command and emits a
//!   [`HelperDiagnosticCode::HelperUnavailable`] helper result carrying the
//!   [`SEMANTIC_HELPER_UNAVAILABLE`] semantic code. Availability is an explicit
//!   *synthetic request field*, never a live Windows probe or shell-out.
//!   Under the semantic matrix a native local Windows helper is
//!   modelled as [`HelperKind::WineLocalWindowsHelper`] +
//!   [`HelperCapabilityLevel::WindowsLocal`] + [`HelperResultExecutionMode::PlatformHelper`]
//!   (the `WindowsLocal` capability is exactly the native-Windows seam the schema
//!   already blesses). We reuse it rather than inventing a parallel kind.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    HELPER_RESULT_SCHEMA_VERSION, HelperCapabilityLevel, HelperDiagnostic, HelperDiagnosticCode,
    HelperExecutionFilesystemAccess, HelperExecutionSummary, HelperKind, HelperProvenance,
    HelperRedaction, HelperRedactionPolicy, HelperRedactionStatus, HelperResult,
    HelperResultExecutionMode, KaifuuResult, OperationStatus, PlatformAvailability, ProofHash,
    SEMANTIC_HELPER_UNAVAILABLE, is_local_absolute_path, looks_like_raw_key_material,
    redact_for_log_or_report, stable_json, validate_helper_result_value,
    validate_secret_redaction_boundary,
};

/// Schema version for the native-Windows dry-run resolution artifact.
pub const NATIVE_WINDOWS_HELPER_SCHEMA_VERSION: &str = "0.1.0";

/// Stable, non-secret platform-adapter identifier surfaced by the resolver.
pub const NATIVE_WINDOWS_PLATFORM_ADAPTER_ID: &str = "native-windows";

/// The stable platform id surfaced in the helper result.
pub const NATIVE_WINDOWS_PLATFORM_ID: &str = "native-windows-local";

/// The launcher *reference* (never a path, never executed) the intended command
/// fronts with. A native Windows helper is its own executable, referenced by a
/// stable token rather than a filesystem path.
pub const NATIVE_WINDOWS_HELPER_PROGRAM_REF: &str = "native-windows-helper";

/// The argv→command-line quoting rules the descriptor follows.
pub const NATIVE_WINDOWS_QUOTING_RULES: &str = "CommandLineToArgvW";

/// Support boundary surfaced by the native-Windows dry-run adapter.
pub const NATIVE_WINDOWS_HELPER_SUPPORT_BOUNDARY: &str = "Kaifuu's native-Windows helper adapter runs in dry-run only: it resolves the platform adapter (native-windows), helper binary id, command argv, the CommandLineToArgvW-quoted command line, working-directory policy, profile id, and redaction policy WITHOUT launching untrusted game code. No process is ever spawned; no Windows host is required. Availability is a synthetic request field, not a live probe. Helper results carry secret references and redacted fields only — never raw key material — and a non-Windows runner yields a typed helper_unavailable diagnostic, not a failure.";

/// Semantic code: the resolution (or a nested helper result) carried raw secret
/// material, which is forbidden.
pub const SEMANTIC_NATIVE_WINDOWS_DRY_RUN_SECRET_LEAK: &str =
    "kaifuu.native_windows.dry_run.secret_leak";
/// Semantic code: the resolution asserted (or attempted) a launch of untrusted
/// game code, which the dry-run path forbids.
pub const SEMANTIC_NATIVE_WINDOWS_DRY_RUN_LAUNCH_FORBIDDEN: &str =
    "kaifuu.native_windows.dry_run.launch_forbidden";
/// Semantic code: the nested helper result failed schema validation.
pub const SEMANTIC_NATIVE_WINDOWS_DRY_RUN_HELPER_RESULT_INVALID: &str =
    "kaifuu.native_windows.dry_run.helper_result_invalid";
/// Semantic code: the CommandLineToArgvW quoting descriptor did not round-trip
/// (quote → command line → parse must recover the original argv exactly).
pub const SEMANTIC_NATIVE_WINDOWS_QUOTING_NOT_REVERSIBLE: &str =
    "kaifuu.native_windows.dry_run.quoting_not_reversible";

/// Synthetic redacted-log hash surfaced by fixture dry-run results. Clearly
/// fake fixture material (never a real log digest).
const FIXTURE_REDACTED_LOG_HASH: &str =
    "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

#[path = "native_windows_helper/command.rs"]
mod command;
pub use command::*;

// Dry-run request / resolution

/// A native-Windows dry-run request. Its shape is constrained
/// (`deny_unknown_fields`) so callers cannot smuggle raw execution config or
/// secret material through arbitrary keys.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeWindowsDryRunRequest {
    pub schema_version: String,
    pub fixture_id: String,
    pub helper_binary_id: String,
    pub allowlist_entry_id: String,
    pub platform_adapter: NativeWindowsPlatformAdapter,
    pub profile_id: String,
    pub redaction_policy: HelperRedactionPolicy,
    pub platform_availability: PlatformAvailability,
    pub timeout_ms: u32,
}

/// The resolved shape of the command a native-Windows helper *would* run.
/// A descriptor, not an execution plan handed to any spawner. `program_ref` is
/// a launcher *reference* token (never a filesystem path), `argument_template`
/// holds template tokens only, and `command_line` is the CommandLineToArgvW
/// quoting of `[program_ref] ++ argument_template` — the Windows-specific
/// resolution — none of which is ever executed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvedWindowsHelperCommand {
    pub program_ref: String,
    pub argument_template: Vec<String>,
    pub command_line: String,
    pub quoting_rules: String,
    pub working_directory_policy: String,
    /// Always `false`. Present as an explicit, validated proof that the dry-run
    /// descriptor never launches untrusted game code.
    pub launches_untrusted_code: bool,
}

/// The full native-Windows dry-run resolution. It names the six required
/// fields — platform-adapter, helper-binary-id, command-argv (with the quoted
/// command line), working-directory-policy, profile-id, redaction-policy — and
/// carries a -conformant helper result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeWindowsDryRunResolution {
    pub schema_version: String,
    pub fixture_id: String,
    pub platform_adapter: NativeWindowsPlatformAdapter,
    pub platform_adapter_id: String,
    pub helper_binary_id: String,
    pub intended_command: ResolvedWindowsHelperCommand,
    pub profile_id: String,
    pub redaction_policy: HelperRedactionPolicy,
    /// Always `false`. Explicit proof that resolving the dry-run did not launch
    /// the game binary.
    pub launched: bool,
    pub helper_result: HelperResult,
}

impl NativeWindowsDryRunResolution {
    /// Deep-scans + normalizes the resolution and renders it as stable JSON.
    pub fn stable_json(&self) -> KaifuuResult<String> {
        let mut resolution = self.clone();
        resolution.helper_result.normalize();
        stable_json(&resolution)
    }

    /// Validates the resolution:
    /// 1. `launched` and `intendedCommand.launchesUntrustedCode` must be
    ///    `false` (no launch);
    /// 2. the `commandLine` must be exactly the CommandLineToArgvW quoting of
    ///    `[programRef] ++ argumentTemplate` and must parse back to it
    ///    (the quoting is a reversible descriptor, not an execution);
    /// 3. no string field anywhere may carry raw key material or a local path
    ///    (deep-scan)
    /// 4. the standard secret-redaction boundary must find nothing;
    /// 5. the nested helper result must pass schema validation.
    pub fn validate(&self) -> NativeWindowsDryRunValidation {
        let mut failures = Vec::new();

        if self.launched || self.intended_command.launches_untrusted_code {
            failures.push(NativeWindowsDryRunFailure {
                code: SEMANTIC_NATIVE_WINDOWS_DRY_RUN_LAUNCH_FORBIDDEN.to_string(),
                field: "launched".to_string(),
                message: "dry-run must never launch untrusted game code".to_string(),
            });
        }

        let expected_command_line = windows_command_line(
            &self.intended_command.program_ref,
            &self.intended_command.argument_template,
        );
        if self.intended_command.command_line == expected_command_line {
            let mut expected_argv = vec![self.intended_command.program_ref.clone()];
            expected_argv.extend(self.intended_command.argument_template.iter().cloned());
            if windows_command_line_to_argv(&self.intended_command.command_line) != expected_argv {
                failures.push(NativeWindowsDryRunFailure {
                    code: SEMANTIC_NATIVE_WINDOWS_QUOTING_NOT_REVERSIBLE.to_string(),
                    field: "intendedCommand.commandLine".to_string(),
                    message: "commandLine must parse back to programRef ++ argumentTemplate"
                        .to_string(),
                });
            }
        } else {
            failures.push(NativeWindowsDryRunFailure {
                code: SEMANTIC_NATIVE_WINDOWS_QUOTING_NOT_REVERSIBLE.to_string(),
                field: "intendedCommand.commandLine".to_string(),
                message: "commandLine must be the CommandLineToArgvW quoting of programRef ++ argumentTemplate".to_string(),
            });
        }

        let Ok(value) = serde_json::to_value(self) else {
            failures.push(NativeWindowsDryRunFailure {
                code: SEMANTIC_NATIVE_WINDOWS_DRY_RUN_HELPER_RESULT_INVALID.to_string(),
                field: "$".to_string(),
                message: "resolution could not be serialized for validation".to_string(),
            });
            return NativeWindowsDryRunValidation::from_failures(&self.fixture_id, failures);
        };

        deep_scan_raw_secret_material(&value, "$", &mut failures);

        for finding in validate_secret_redaction_boundary(&value) {
            failures.push(NativeWindowsDryRunFailure {
                code: SEMANTIC_NATIVE_WINDOWS_DRY_RUN_SECRET_LEAK.to_string(),
                field: finding.field,
                message: finding.reason,
            });
        }

        if let Some(helper_result) = value.get("helperResult") {
            let helper_validation = validate_helper_result_value(helper_result);
            if helper_validation.status == OperationStatus::Failed {
                for failure in helper_validation.failures {
                    failures.push(NativeWindowsDryRunFailure {
                        code: SEMANTIC_NATIVE_WINDOWS_DRY_RUN_HELPER_RESULT_INVALID.to_string(),
                        field: format!("helperResult.{}", failure.field),
                        message: failure.message,
                    });
                }
            }
        }

        NativeWindowsDryRunValidation::from_failures(&self.fixture_id, failures)
    }
}

/// Deep-scans every string in `value` for raw key material or a local absolute
/// path, regardless of the field name it hides behind.
fn deep_scan_raw_secret_material(
    value: &Value,
    field: &str,
    failures: &mut Vec<NativeWindowsDryRunFailure>,
) {
    match value {
        Value::String(text) => {
            if looks_like_raw_key_material(text) {
                failures.push(NativeWindowsDryRunFailure {
                    code: SEMANTIC_NATIVE_WINDOWS_DRY_RUN_SECRET_LEAK.to_string(),
                    field: field.to_string(),
                    message: "raw key-like material must be referenced through secretRef, never serialized".to_string(),
                });
            } else if is_local_absolute_path(text) {
                failures.push(NativeWindowsDryRunFailure {
                    code: SEMANTIC_NATIVE_WINDOWS_DRY_RUN_SECRET_LEAK.to_string(),
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

/// The outcome of validating a [`NativeWindowsDryRunResolution`] or a
/// [`WindowsCommandLineQuotingFixture`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeWindowsDryRunValidation {
    pub schema_version: String,
    pub fixture_id: Option<String>,
    pub status: OperationStatus,
    pub failures: Vec<NativeWindowsDryRunFailure>,
}

impl NativeWindowsDryRunValidation {
    fn from_failures(fixture_id: &str, failures: Vec<NativeWindowsDryRunFailure>) -> Self {
        let status = if failures.is_empty() {
            OperationStatus::Passed
        } else {
            OperationStatus::Failed
        };
        Self {
            schema_version: NATIVE_WINDOWS_HELPER_SCHEMA_VERSION.to_string(),
            fixture_id: Some(redact_for_log_or_report(fixture_id)),
            status,
            failures: failures
                .iter()
                .map(NativeWindowsDryRunFailure::redacted_for_report)
                .collect(),
        }
    }
}

/// A single validation failure for a native-Windows dry-run resolution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeWindowsDryRunFailure {
    pub code: String,
    pub field: String,
    pub message: String,
}

impl NativeWindowsDryRunFailure {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
        }
    }
}

/// Resolves a native-Windows dry-run **without launching untrusted game code**.
/// Given a synthetic request, this names the platform adapter, helper binary
/// id, intended command (argv template + CommandLineToArgvW-quoted command
/// line), working-directory policy, profile id, and redaction policy, and emits
/// a helper result. When the platform is unavailable (e.g. a
/// non-Windows public CI runner) the helper result carries a typed
/// [`HelperDiagnosticCode::HelperUnavailable`] diagnostic instead of failing.
/// use kaifuu_core::{
/// resolve_native_windows_dry_run, HelperRedactionPolicy, NativeWindowsDryRunRequest,
/// NativeWindowsPlatformAdapter, PlatformAvailability, NATIVE_WINDOWS_HELPER_SCHEMA_VERSION,
/// let request = NativeWindowsDryRunRequest {
/// schema_version: NATIVE_WINDOWS_HELPER_SCHEMA_VERSION.to_string,
/// fixture_id: "kaifuu-native-windows-dry-run".to_string,
/// helper_binary_id: "kaifuu.fixture.native-windows-local".to_string,
/// allowlist_entry_id: "kaifuu-fixture-native-windows-local-allowlist".to_string,
/// platform_adapter: NativeWindowsPlatformAdapter::NativeWindowsLocal,
/// profile_id: "019ed000-0000-7000-8000-profile00129".to_string,
/// redaction_policy: HelperRedactionPolicy::RedactRawLogsAndSecretRefs,
/// platform_availability: PlatformAvailability::Available,
/// timeout_ms: 5000,
/// let resolution = resolve_native_windows_dry_run(&request);
/// assert!(!resolution.launched);
/// assert!(!resolution.intended_command.launches_untrusted_code);
/// assert_eq!(resolution.validate.status, kaifuu_core::OperationStatus::Passed);
pub fn resolve_native_windows_dry_run(
    request: &NativeWindowsDryRunRequest,
) -> NativeWindowsDryRunResolution {
    let adapter = request.platform_adapter;

    // Deterministically DERIVE the intended command from the request identity.
    // Args are template tokens only; nothing here is secret or launched.
    let argument_template = vec![
        "--platform".to_string(),
        adapter.platform_id().to_string(),
        "--helper-binary-id".to_string(),
        request.helper_binary_id.clone(),
        "--profile-id".to_string(),
        request.profile_id.clone(),
        "--redaction-policy".to_string(),
        request.redaction_policy.policy_id().to_string(),
        "--dry-run".to_string(),
    ];
    let command_line = windows_command_line(adapter.program_ref(), &argument_template);

    let intended_command = ResolvedWindowsHelperCommand {
        program_ref: adapter.program_ref().to_string(),
        argument_template,
        command_line,
        quoting_rules: NATIVE_WINDOWS_QUOTING_RULES.to_string(),
        working_directory_policy: "sandboxed-read-only-game-copy".to_string(),
        launches_untrusted_code: false,
    };

    // A dry-run resolves the intended plan but never runs the helper, so it
    // recovers no key material. `helper_required` is the honest diagnostic for a
    // resolvable-but-unrun helper; `helper_unavailable` is the typed diagnostic
    // when the platform is absent (e.g. non-Windows CI). Neither requires a
    // recovered secretRef/proof under the matrix.
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
            // Windows matrix); `durationMs: 0` and the `launched: false` proof
            // show the dry-run resolved the plan without ever executing it.
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

    NativeWindowsDryRunResolution {
        schema_version: NATIVE_WINDOWS_HELPER_SCHEMA_VERSION.to_string(),
        fixture_id: request.fixture_id.clone(),
        platform_adapter: adapter,
        platform_adapter_id: adapter.adapter_id().to_string(),
        helper_binary_id: request.helper_binary_id.clone(),
        intended_command,
        profile_id: request.profile_id.clone(),
        redaction_policy: request.redaction_policy,
        launched: false,
        helper_result,
    }
}

#[cfg(test)]
#[path = "native_windows_helper/tests.rs"]
mod tests;
