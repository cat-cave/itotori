use super::*;

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
