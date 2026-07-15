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

/// The platform adapter a native-Windows helper would run under. A single
/// variant today (a native local Windows helper), kept as an enum to mirror the
/// Wine/Proton adapter and leave room for future native surfaces.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NativeWindowsPlatformAdapter {
    /// A native Windows helper binary running locally on a Windows host.
    NativeWindowsLocal,
}

impl NativeWindowsPlatformAdapter {
    /// A stable, non-secret platform-adapter identifier surfaced in the
    /// resolution (`native-windows`).
    pub fn adapter_id(self) -> &'static str {
        match self {
            Self::NativeWindowsLocal => NATIVE_WINDOWS_PLATFORM_ADAPTER_ID,
        }
    }

    /// The stable platform id surfaced in the helper result.
    pub fn platform_id(self) -> &'static str {
        match self {
            Self::NativeWindowsLocal => NATIVE_WINDOWS_PLATFORM_ID,
        }
    }

    /// The launcher *reference* (never a path, never executed) the intended
    /// command fronts with.
    pub fn program_ref(self) -> &'static str {
        match self {
            Self::NativeWindowsLocal => NATIVE_WINDOWS_HELPER_PROGRAM_REF,
        }
    }

    /// The helper kind. A native local Windows helper reuses the
    /// local Windows helper kind (paired with the `WindowsLocal` capability).
    pub fn helper_kind(self) -> HelperKind {
        HelperKind::WineLocalWindowsHelper
    }

    /// The capability level for a native local Windows helper.
    pub fn capability_level(self) -> HelperCapabilityLevel {
        HelperCapabilityLevel::WindowsLocal
    }
}

// Windows command-line quoting (CommandLineToArgvW rules) — a RESOLVED
// descriptor, never an execution. `windows_quote_argument` implements the
// canonical backslash/quote escaping; `windows_command_line` joins a program
// reference and its args into a single command line; `windows_command_line_to_argv`
// is the inverse parser used to *prove* the quoting round-trips.

fn argument_needs_quoting(arg: &str) -> bool {
    arg.is_empty()
        || arg
            .chars()
            .any(|character| matches!(character, ' ' | '\t' | '"'))
}

/// Quotes a single argument per the CommandLineToArgvW rules so that the value
/// survives a Windows process's command-line parsing back to the original
/// bytes. Backslashes are only special immediately before a `"` or the closing
/// quote; a `"` is escaped as `\"`.
/// This is a **pure descriptor**: it produces the string a launcher *would*
/// pass, and never itself launches anything.
pub fn windows_quote_argument(arg: &str) -> String {
    if !argument_needs_quoting(arg) {
        return arg.to_string();
    }

    let mut quoted = String::from("\"");
    let mut chars = arg.chars().peekable();
    loop {
        let mut backslashes = 0_usize;
        while chars.peek() == Some(&'\\') {
            chars.next();
            backslashes += 1;
        }

        match chars.next() {
            None => {
                // Backslashes immediately before the closing quote must be
                // doubled so the quote is not consumed as an escape.
                for _ in 0..(backslashes * 2) {
                    quoted.push('\\');
                }
                break;
            }
            Some('"') => {
                // Backslashes before a literal quote are doubled, plus one more
                // backslash to escape the quote itself.
                for _ in 0..=(backslashes * 2) {
                    quoted.push('\\');
                }
                quoted.push('"');
            }
            Some(character) => {
                // Backslashes not before a quote are literal.
                for _ in 0..backslashes {
                    quoted.push('\\');
                }
                quoted.push(character);
            }
        }
    }
    quoted.push('"');
    quoted
}

/// Joins a program reference and its arguments into a single Windows command
/// line, quoting each token per [`windows_quote_argument`]. A descriptor only.
pub fn windows_command_line(program_ref: &str, arguments: &[String]) -> String {
    let mut tokens = Vec::with_capacity(arguments.len() + 1);
    tokens.push(windows_quote_argument(program_ref));
    for argument in arguments {
        tokens.push(windows_quote_argument(argument));
    }
    tokens.join(" ")
}

/// Parses a Windows command line back into its argument vector using the
/// CommandLineToArgvW rules (the inverse of [`windows_command_line`]). Used to
/// prove the quoting descriptor round-trips; it never executes anything.
pub fn windows_command_line_to_argv(command_line: &str) -> Vec<String> {
    let mut argv = Vec::new();
    let mut chars = command_line.chars().peekable();

    loop {
        while matches!(chars.peek(), Some(' ' | '\t')) {
            chars.next();
        }
        if chars.peek().is_none() {
            break;
        }

        let mut current = String::new();
        let mut in_quotes = false;
        loop {
            let mut backslashes = 0_usize;
            while chars.peek() == Some(&'\\') {
                chars.next();
                backslashes += 1;
            }

            match chars.peek().copied() {
                Some('"') => {
                    for _ in 0..(backslashes / 2) {
                        current.push('\\');
                    }
                    if backslashes % 2 == 1 {
                        // Escaped literal quote.
                        current.push('"');
                        chars.next();
                    } else {
                        chars.next();
                        in_quotes = !in_quotes;
                    }
                }
                Some(character) if !in_quotes && matches!(character, ' ' | '\t') => {
                    for _ in 0..backslashes {
                        current.push('\\');
                    }
                    break;
                }
                Some(character) => {
                    for _ in 0..backslashes {
                        current.push('\\');
                    }
                    current.push(character);
                    chars.next();
                }
                None => {
                    for _ in 0..backslashes {
                        current.push('\\');
                    }
                    break;
                }
            }
        }
        argv.push(current);
    }
    argv
}

/// A single argv→command-line quoting case: the raw argument and the
/// CommandLineToArgvW-quoted form it resolves to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowsQuotingCase {
    pub raw: String,
    pub quoted: String,
}

/// A resolved Windows command-line quoting fixture: a set of adversarial args
/// (spaces / quotes / backslashes) shown with their CommandLineToArgvW-quoted
/// forms, plus the joined command line. Every case is proven to round-trip
/// (quote → command line → parse recovers the original argv). A descriptor,
/// never an execution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowsCommandLineQuotingFixture {
    pub schema_version: String,
    pub fixture_id: String,
    pub quoting_rules: String,
    pub cases: Vec<WindowsQuotingCase>,
    /// The command line produced by quoting-and-joining every raw case.
    pub command_line: String,
    /// Always `false`: the fixture resolves a quoting descriptor, never a launch.
    pub launches_untrusted_code: bool,
}

impl WindowsCommandLineQuotingFixture {
    /// Renders the fixture as stable JSON.
    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(self)
    }

    /// Validates the fixture: every case round-trips through the parser, no
    /// string carries raw secret material or a local path, and it never
    /// launches.
    pub fn validate(&self) -> NativeWindowsDryRunValidation {
        let mut failures = Vec::new();

        if self.launches_untrusted_code {
            failures.push(NativeWindowsDryRunFailure {
                code: SEMANTIC_NATIVE_WINDOWS_DRY_RUN_LAUNCH_FORBIDDEN.to_string(),
                field: "launchesUntrustedCode".to_string(),
                message: "the quoting fixture is a descriptor and must never launch".to_string(),
            });
        }

        for (index, case) in self.cases.iter().enumerate() {
            if windows_quote_argument(&case.raw) != case.quoted {
                failures.push(NativeWindowsDryRunFailure {
                    code: SEMANTIC_NATIVE_WINDOWS_QUOTING_NOT_REVERSIBLE.to_string(),
                    field: format!("cases.{index}.quoted"),
                    message: "quoted form must match CommandLineToArgvW quoting of raw".to_string(),
                });
            }
            let round_tripped = windows_command_line_to_argv(&case.quoted);
            if round_tripped != vec![case.raw.clone()] {
                failures.push(NativeWindowsDryRunFailure {
                    code: SEMANTIC_NATIVE_WINDOWS_QUOTING_NOT_REVERSIBLE.to_string(),
                    field: format!("cases.{index}.raw"),
                    message: "quoted argument must parse back to the original raw argument"
                        .to_string(),
                });
            }
        }

        let raw_args: Vec<String> = self.cases.iter().map(|case| case.raw.clone()).collect();
        if windows_command_line_to_argv(&self.command_line) != raw_args {
            failures.push(NativeWindowsDryRunFailure {
                code: SEMANTIC_NATIVE_WINDOWS_QUOTING_NOT_REVERSIBLE.to_string(),
                field: "commandLine".to_string(),
                message: "the joined command line must parse back to every raw argument"
                    .to_string(),
            });
        }

        if let Ok(value) = serde_json::to_value(self) {
            deep_scan_raw_secret_material(&value, "$", &mut failures);
        }

        NativeWindowsDryRunValidation::from_failures(&self.fixture_id, failures)
    }
}

/// Resolves the canonical Windows command-line quoting fixture: a fixed set of
/// adversarial arguments (spaces, embedded quotes, mid/trailing backslashes,
/// and a backslash-before-quote) with their CommandLineToArgvW-quoted forms.
pub fn resolve_windows_command_line_quoting_fixture() -> WindowsCommandLineQuotingFixture {
    // Synthetic, non-secret adversarial args. None start with `\` or `/` or a
    // `X:` drive component, so they never look like local paths, and none look
    // like key material.
    let raw_args = [
        "plain",
        "arg with spaces",
        "say \"hi\"",
        "share\\folder name",
        "ends with backslash\\",
        "bs before quote\\\"",
    ];

    let cases: Vec<WindowsQuotingCase> = raw_args
        .iter()
        .map(|raw| WindowsQuotingCase {
            raw: (*raw).to_string(),
            quoted: windows_quote_argument(raw),
        })
        .collect();

    let joined: Vec<String> = raw_args.iter().map(|raw| (*raw).to_string()).collect();
    let command_line = joined
        .iter()
        .map(|raw| windows_quote_argument(raw))
        .collect::<Vec<_>>()
        .join(" ");

    WindowsCommandLineQuotingFixture {
        schema_version: NATIVE_WINDOWS_HELPER_SCHEMA_VERSION.to_string(),
        fixture_id: "kaifuu-native-windows-command-line-quoting".to_string(),
        quoting_rules: NATIVE_WINDOWS_QUOTING_RULES.to_string(),
        cases,
        command_line,
        launches_untrusted_code: false,
    }
}

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
mod tests {
    use super::*;

    fn request(availability: PlatformAvailability) -> NativeWindowsDryRunRequest {
        NativeWindowsDryRunRequest {
            schema_version: NATIVE_WINDOWS_HELPER_SCHEMA_VERSION.to_string(),
            fixture_id: "kaifuu-native-windows-dry-run".to_string(),
            helper_binary_id: "kaifuu.fixture.native-windows-local".to_string(),
            allowlist_entry_id: "kaifuu-fixture-native-windows-local-allowlist".to_string(),
            platform_adapter: NativeWindowsPlatformAdapter::NativeWindowsLocal,
            profile_id: "019ed000-0000-7000-8000-profile00129".to_string(),
            redaction_policy: HelperRedactionPolicy::RedactRawLogsAndSecretRefs,
            platform_availability: availability,
            timeout_ms: 5000,
        }
    }

    #[test]
    fn dry_run_records_six_required_fields_without_launching() {
        let resolution = resolve_native_windows_dry_run(&request(PlatformAvailability::Available));

        // (1) platform-adapter
        assert_eq!(
            resolution.platform_adapter,
            NativeWindowsPlatformAdapter::NativeWindowsLocal
        );
        assert_eq!(resolution.platform_adapter_id, "native-windows");
        // (2) helper-binary-id
        assert_eq!(
            resolution.helper_binary_id,
            "kaifuu.fixture.native-windows-local"
        );
        // (3) command-argv (+ quoted command line)
        assert_eq!(
            resolution.intended_command.program_ref,
            "native-windows-helper"
        );
        assert!(
            resolution
                .intended_command
                .argument_template
                .contains(&"--dry-run".to_string())
        );
        assert_eq!(
            resolution.intended_command.quoting_rules,
            "CommandLineToArgvW"
        );
        assert!(
            resolution
                .intended_command
                .command_line
                .starts_with("native-windows-helper --platform native-windows-local")
        );
        // (4) working-directory-policy
        assert_eq!(
            resolution.intended_command.working_directory_policy,
            "sandboxed-read-only-game-copy"
        );
        // (5) profile-id
        assert_eq!(
            resolution.profile_id,
            "019ed000-0000-7000-8000-profile00129"
        );
        // (6) redaction-policy
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
    fn unavailable_platform_emits_typed_helper_unavailable_diagnostic() {
        let resolution =
            resolve_native_windows_dry_run(&request(PlatformAvailability::Unavailable));

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
        let resolution = resolve_native_windows_dry_run(&request(PlatformAvailability::Available));

        let helper_value = serde_json::to_value(&resolution.helper_result).unwrap();
        assert_eq!(
            validate_helper_result_value(&helper_value).status,
            OperationStatus::Passed
        );
        // Native local Windows path: WineLocalWindowsHelper + WindowsLocal +
        // PlatformHelper (the native-Windows seam).
        assert_eq!(
            resolution.helper_result.helper.helper_kind,
            HelperKind::WineLocalWindowsHelper
        );
        assert_eq!(
            resolution.helper_result.capability_level,
            HelperCapabilityLevel::WindowsLocal
        );

        let serialized = resolution.stable_json().unwrap();
        // The execution object never carries a launch command; the
        // quoted descriptor lives under `commandLine`, not `command`/`argv`/`env`.
        assert!(!serialized.contains("\"command\""));
        assert!(!serialized.contains("\"argv\""));
        assert!(!serialized.contains("\"env\""));
        assert!(serialized.contains("\"commandLine\""));
    }

    #[test]
    fn resolution_carrying_raw_secret_material_fails_validation() {
        let mut resolution =
            resolve_native_windows_dry_run(&request(PlatformAvailability::Available));
        // Inject clearly-fake 32-hex "recovered key" bytes into an otherwise
        // innocuous field: the deep-scan must reject it.
        resolution.helper_binary_id = "0123456789abcdef0123456789abcdef".to_string();

        let validation = resolution.validate();
        assert_eq!(validation.status, OperationStatus::Failed);
        assert!(
            validation
                .failures
                .iter()
                .any(|failure| failure.code == SEMANTIC_NATIVE_WINDOWS_DRY_RUN_SECRET_LEAK)
        );
    }

    #[test]
    fn resolution_carrying_local_path_fails_validation() {
        let mut resolution =
            resolve_native_windows_dry_run(&request(PlatformAvailability::Available));
        // A Windows drive-letter absolute path must be rejected by the deep-scan
        // regardless of which field it hides in.
        resolution.intended_command.working_directory_policy =
            "C:\\Games\\Private\\game.exe".to_string();

        let validation = resolution.validate();
        assert_eq!(validation.status, OperationStatus::Failed);
        assert!(
            validation
                .failures
                .iter()
                .any(|failure| failure.code == SEMANTIC_NATIVE_WINDOWS_DRY_RUN_SECRET_LEAK)
        );
    }

    #[test]
    fn resolution_asserting_launch_fails_validation() {
        let mut resolution =
            resolve_native_windows_dry_run(&request(PlatformAvailability::Available));
        resolution.launched = true;

        let validation = resolution.validate();
        assert_eq!(validation.status, OperationStatus::Failed);
        assert!(
            validation
                .failures
                .iter()
                .any(|failure| failure.code == SEMANTIC_NATIVE_WINDOWS_DRY_RUN_LAUNCH_FORBIDDEN)
        );
    }

    #[test]
    fn resolution_round_trips_through_stable_json() {
        let resolution = resolve_native_windows_dry_run(&request(PlatformAvailability::Available));
        let serialized = resolution.stable_json().unwrap();
        let parsed: NativeWindowsDryRunResolution = serde_json::from_str(&serialized).unwrap();
        assert_eq!(parsed.platform_adapter, resolution.platform_adapter);
        assert_eq!(parsed.helper_binary_id, resolution.helper_binary_id);
        assert_eq!(
            parsed.intended_command.command_line,
            resolution.intended_command.command_line
        );
    }

    #[test]
    fn windows_quoting_matches_command_line_to_argv_rules() {
        // Canonical CommandLineToArgvW quoting expectations.
        assert_eq!(windows_quote_argument("plain"), "plain");
        assert_eq!(
            windows_quote_argument("arg with spaces"),
            "\"arg with spaces\""
        );
        assert_eq!(windows_quote_argument("say \"hi\""), "\"say \\\"hi\\\"\"");
        assert_eq!(
            windows_quote_argument("share\\folder name"),
            "\"share\\folder name\""
        );
        assert_eq!(
            windows_quote_argument("ends with backslash\\"),
            "\"ends with backslash\\\\\""
        );
        assert_eq!(
            windows_quote_argument("bs before quote\\\""),
            "\"bs before quote\\\\\\\"\""
        );
    }

    #[test]
    fn windows_quoting_fixture_round_trips_every_case() {
        let fixture = resolve_windows_command_line_quoting_fixture();
        assert_eq!(fixture.quoting_rules, "CommandLineToArgvW");
        assert!(!fixture.launches_untrusted_code);
        assert!(!fixture.cases.is_empty());

        // Each case: raw quotes to the recorded form and parses back to raw.
        for case in &fixture.cases {
            assert_eq!(windows_quote_argument(&case.raw), case.quoted);
            assert_eq!(
                windows_command_line_to_argv(&case.quoted),
                vec![case.raw.clone()]
            );
        }
        // The joined command line parses back to every raw argument in order.
        let raw_args: Vec<String> = fixture.cases.iter().map(|case| case.raw.clone()).collect();
        assert_eq!(
            windows_command_line_to_argv(&fixture.command_line),
            raw_args
        );

        assert_eq!(fixture.validate().status, OperationStatus::Passed);
    }

    #[test]
    fn intended_command_line_parses_back_to_argv() {
        let resolution = resolve_native_windows_dry_run(&request(PlatformAvailability::Available));
        let mut expected = vec![resolution.intended_command.program_ref.clone()];
        expected.extend(
            resolution
                .intended_command
                .argument_template
                .iter()
                .cloned(),
        );
        assert_eq!(
            windows_command_line_to_argv(&resolution.intended_command.command_line),
            expected
        );
    }

    #[test]
    fn quoting_fixture_with_tampered_quote_fails_validation() {
        let mut fixture = resolve_windows_command_line_quoting_fixture();
        // Corrupt a quoted form so it no longer matches CommandLineToArgvW.
        fixture.cases[1].quoted = "arg with spaces".to_string();
        let validation = fixture.validate();
        assert_eq!(validation.status, OperationStatus::Failed);
        assert!(
            validation
                .failures
                .iter()
                .any(|failure| failure.code == SEMANTIC_NATIVE_WINDOWS_QUOTING_NOT_REVERSIBLE)
        );
    }
}
