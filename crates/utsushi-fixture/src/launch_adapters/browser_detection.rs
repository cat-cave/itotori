//! Bounded Chromium probe used by the browser launch adapter.
//!
//! enforces the orchestrator's "no optionality on claimed
//! inputs" architectural commitment for MV/MZ alpha: probe outcomes
//! categorize environmental misconfiguration with typed semantic codes
//! in the engine-neutral `utsushi.browser.*` namespace, never silent
//! skips.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use utsushi_core::RuntimeHarnessErrorKind;

pub(super) const BROWSER_CANDIDATES: &[&str] = &[
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
    "chrome",
    "msedge",
    "microsoft-edge",
    "brave-browser",
];

#[cfg(target_os = "macos")]
pub(super) const BROWSER_PLATFORM_PATHS: &[&str] = &[
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/opt/homebrew/bin/chromium",
    "/opt/homebrew/bin/google-chrome",
];

#[cfg(target_os = "windows")]
pub(super) const BROWSER_PLATFORM_PATHS: &[&str] = &[];

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
pub(super) const BROWSER_PLATFORM_PATHS: &[&str] = &[];

/// Minimum supported Chromium major version. The 100 floor tracks the
/// `--headless=new` flag introduction (Chromium 109 formally, accepted
/// from earlier builds; the 100 floor gives a safe margin). The choice
/// of a major-version floor (not a full semver match) is documented in
/// the descriptor limitation list.
pub(super) const CHROMIUM_MIN_SUPPORTED_MAJOR: u32 = 100;

pub(super) fn chromium_min_supported_version_string() -> &'static str {
    "100.0.0"
}

/// Bounded version-probe timeout. `<binary> --version` should complete
/// in tens of milliseconds; a wedged binary cannot block descriptor
/// evaluation longer than this floor.
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub(super) enum ChromiumVersion {
    Parsed {
        major: u32,
        minor: u32,
        patch: u32,
    },
    #[default]
    Unknown,
}

impl ChromiumVersion {
    pub(super) fn major(self) -> Option<u32> {
        match self {
            Self::Parsed { major, .. } => Some(major),
            Self::Unknown => None,
        }
    }

    pub(super) fn version_string(self) -> String {
        match self {
            Self::Parsed {
                major,
                minor,
                patch,
            } => format!("{major}.{minor}.{patch}"),
            Self::Unknown => "unknown".to_string(),
        }
    }
}

#[derive(Clone, Debug)]
pub(super) struct ChromiumProbeOutcome {
    pub(super) program: PathBuf,
    pub(super) source: BrowserDetectionLabel,
    pub(super) version: ChromiumVersion,
}

impl ChromiumProbeOutcome {
    pub(super) fn source_label(&self) -> &'static str {
        self.source.as_str()
    }

    pub(super) fn version_string(&self) -> String {
        self.version.version_string()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum BrowserUnavailabilityReason {
    NoBinaryFound {
        source: BrowserDetectionLabel,
        candidates_tried: usize,
    },
    VersionMismatch {
        source: BrowserDetectionLabel,
        detected: ChromiumVersion,
        required_major: u32,
    },
    /// No usable display surface under strict display checking
    /// (). Produced by [`probe_display`] when the operator
    /// opts into the `UTSUSHI_STRICT_DISPLAY` activation gate and the
    /// host exposes no X11/Wayland display env var on a platform that
    /// uses that convention. Off by default, so the headless-only
    /// path is unchanged.
    DisplayUnavailable {
        source: BrowserDetectionLabel,
        platform: &'static str,
        probe: DisplayProbeOutcome,
    },
}

impl BrowserUnavailabilityReason {
    pub(super) fn semantic_code(&self) -> &'static str {
        match self {
            Self::NoBinaryFound { .. } => "utsushi.browser.chromium_unavailable",
            Self::VersionMismatch { .. } => "utsushi.browser.chromium_version_mismatch",
            Self::DisplayUnavailable { .. } => "utsushi.browser.display_unavailable",
        }
    }

    pub(super) fn harness_error_kind(&self) -> RuntimeHarnessErrorKind {
        match self {
            Self::NoBinaryFound { .. } => RuntimeHarnessErrorKind::ChromiumUnavailable,
            Self::VersionMismatch { .. } => RuntimeHarnessErrorKind::ChromiumVersionMismatch,
            Self::DisplayUnavailable { .. } => RuntimeHarnessErrorKind::ChromiumDisplayUnavailable,
        }
    }

    pub(super) fn source_label(&self) -> &'static str {
        match self {
            Self::NoBinaryFound { source, .. }
            | Self::VersionMismatch { source, .. }
            | Self::DisplayUnavailable { source, .. } => source.as_str(),
        }
    }

    pub(super) fn diagnostic_message(&self) -> String {
        match self {
            Self::NoBinaryFound { source, .. } => match source {
                BrowserDetectionLabel::ConfiguredUnavailable => {
                    "Configured browser executable is not launchable; \
                     update the adapter configuration or install Chromium."
                        .to_string()
                }
                BrowserDetectionLabel::EnvironmentUnavailable => {
                    "UTSUSHI_BROWSER_BIN is set but does not resolve to a launchable Chromium-compatible executable."
                        .to_string()
                }
                _ => "No Chromium-compatible browser executable detected; \
                      install Chromium/Chrome or set UTSUSHI_BROWSER_BIN."
                    .to_string(),
            },
            Self::VersionMismatch {
                detected,
                required_major,
                ..
            } => format!(
                "Detected Chromium {detected} is below the minimum supported major version {required_major}.",
                detected = detected.version_string(),
            ),
            Self::DisplayUnavailable { platform, .. } => format!(
                "No usable display surface detected on {platform} under strict display checking."
            ),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum DisplayProbeOutcome {
    /// Display env vars present (X11/Wayland session). Headless launch
    /// nonetheless proceeds with `--headless=new --disable-gpu --no-sandbox`.
    PresentEnv,
    /// No display env vars present but the adapter operates headlessly
    /// so launch is not gated.
    HeadlessOnly,
    /// Strict display checking explicitly enabled and no usable surface
    /// detected. Produced under the `UTSUSHI_STRICT_DISPLAY` gate.
    UnavailableStrict,
}

impl DisplayProbeOutcome {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::PresentEnv => "present_env",
            Self::HeadlessOnly => "headless_only",
            Self::UnavailableStrict => "unavailable_strict",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum BrowserDetectionLabel {
    Configured,
    ConfiguredUnavailable,
    Environment,
    EnvironmentUnavailable,
    Path,
    PlatformPath,
    Unavailable,
    VersionUnsupported,
}

impl BrowserDetectionLabel {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Configured => "configured",
            Self::ConfiguredUnavailable => "configured_unavailable",
            Self::Environment => "environment",
            Self::EnvironmentUnavailable => "environment_unavailable",
            Self::Path => "path",
            Self::PlatformPath => "platform_path",
            Self::Unavailable => "unavailable",
            Self::VersionUnsupported => "version_unsupported",
        }
    }
}

/// Probe the host for a Chromium-compatible launcher and verify its
/// reported `--version` is above the minimum supported major. The probe
/// is bounded and does not produce runtime evidence.
pub(super) fn probe_chromium(
    configured: Option<&Path>,
    version_override: Option<ChromiumVersion>,
) -> Result<ChromiumProbeOutcome, BrowserUnavailabilityReason> {
    // 1. Resolve a binary candidate against the configured/env/PATH/platform
    //    order documented in the descriptor limitation list.
    let Some((program, source)) = resolve_binary_candidate(configured) else {
        // candidates_tried = configured + env probe + PATH candidates
        // platform paths (all attempted unsuccessfully)
        let tried = 1 // env (if absent it still counts as one slot inspected)
            + BROWSER_CANDIDATES.len()
            + BROWSER_PLATFORM_PATHS.len();
        let source = if configured.is_some() {
            BrowserDetectionLabel::ConfiguredUnavailable
        } else if env::var_os("UTSUSHI_BROWSER_BIN").is_some() {
            BrowserDetectionLabel::EnvironmentUnavailable
        } else {
            BrowserDetectionLabel::Unavailable
        };
        return Err(BrowserUnavailabilityReason::NoBinaryFound {
            source,
            candidates_tried: tried,
        });
    };

    // 2. Bounded version probe. Tests may inject a deterministic version
    //    to exercise the mismatch comparison below without spawning the
    //    real `<binary> --version` shell-out (which can race/time out
    //    under concurrent load); production always passes `None` and thus
    //    shells out to the resolved binary.
    let version = version_override
        .unwrap_or_else(|| probe_version(&program).unwrap_or(ChromiumVersion::Unknown));
    if let Some(major) = version.major()
        && major < CHROMIUM_MIN_SUPPORTED_MAJOR
    {
        return Err(BrowserUnavailabilityReason::VersionMismatch {
            source: BrowserDetectionLabel::VersionUnsupported,
            detected: version,
            required_major: CHROMIUM_MIN_SUPPORTED_MAJOR,
        });
    }

    // 3. Strict-display gate (). Under the UTSUSHI_STRICT_DISPLAY
    //    activation gate the probe requires a usable display surface and
    //    emits DisplayUnavailable when none is detected. With the gate off
    //    (default) this is a no-op headless-only outcome, so the
    //    headless launch path is unchanged.
    probe_display(source)?;

    Ok(ChromiumProbeOutcome {
        program,
        source,
        version,
    })
}

#[path = "browser_detection_display.rs"]
mod display_probe;

pub(super) fn probe_display(
    source: BrowserDetectionLabel,
) -> Result<DisplayProbeOutcome, BrowserUnavailabilityReason> {
    display_probe::probe_display(source)
}

pub(super) fn strict_display_enabled() -> bool {
    display_probe::strict_display_enabled()
}

pub(super) fn evaluate_display(
    strict: bool,
    display_present: bool,
    platform_uses_display_env: bool,
    source: BrowserDetectionLabel,
    platform: &'static str,
) -> Result<DisplayProbeOutcome, BrowserUnavailabilityReason> {
    display_probe::evaluate_display(
        strict,
        display_present,
        platform_uses_display_env,
        source,
        platform,
    )
}

fn resolve_binary_candidate(configured: Option<&Path>) -> Option<(PathBuf, BrowserDetectionLabel)> {
    if let Some(path) = configured {
        if is_launchable_file(path) {
            return Some((path.to_path_buf(), BrowserDetectionLabel::Configured));
        }
        return None;
    }
    if let Ok(program) = env::var("UTSUSHI_BROWSER_BIN") {
        return resolve_program_candidate(&program)
            .map(|path| (path, BrowserDetectionLabel::Environment));
    }
    for candidate in BROWSER_CANDIDATES {
        if let Some(path) = resolve_program_candidate(candidate) {
            return Some((path, BrowserDetectionLabel::Path));
        }
    }
    for candidate in BROWSER_PLATFORM_PATHS {
        if is_launchable_file(Path::new(candidate)) {
            return Some((
                PathBuf::from(*candidate),
                BrowserDetectionLabel::PlatformPath,
            ));
        }
    }
    None
}

/// Bounded `<binary> --version` probe. Returns `None` on spawn failure
/// non-zero exit, output that does not parse, or timeout.
fn probe_version(program: &Path) -> Option<ChromiumVersion> {
    let mut child = Command::new(program)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => break,
            Ok(None) => {
                if started.elapsed() >= VERSION_PROBE_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return None,
        }
    }

    let output = child.wait_with_output().ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    parse_chromium_version(stdout.as_ref()).or_else(|| parse_chromium_version(stderr.as_ref()))
}

/// Parse a Chromium-style `--version` output of the form
/// `"Chromium 124.0.6367.118..."` or `"Google Chrome 124.0.6367.118..."`.
/// Returns `None` if no dotted-number token is found.
pub(super) fn parse_chromium_version(text: &str) -> Option<ChromiumVersion> {
    for token in text.split_whitespace() {
        let parts: Vec<&str> = token.split('.').collect();
        if parts.len() < 2 {
            continue;
        }
        let parsed: Vec<u32> = parts
            .iter()
            .map(|part| part.parse::<u32>().ok())
            .take_while(Option::is_some)
            .map(Option::unwrap)
            .collect();
        if parsed.len() < 2 {
            continue;
        }
        return Some(ChromiumVersion::Parsed {
            major: parsed[0],
            minor: parsed[1],
            patch: parsed.get(2).copied().unwrap_or(0),
        });
    }
    None
}

fn resolve_program_candidate(program: &str) -> Option<PathBuf> {
    if program.trim().is_empty() {
        return None;
    }
    let path = Path::new(program);
    if program.contains('/') || program.contains('\\') {
        return is_launchable_file(path).then(|| path.to_path_buf());
    }
    env::var_os("PATH")
        .into_iter()
        .flat_map(|path_var| env::split_paths(&path_var).collect::<Vec<_>>())
        .flat_map(|dir| {
            executable_names(program)
                .into_iter()
                .map(move |name| dir.join(name))
        })
        .find(|candidate| is_launchable_file(candidate))
}

fn executable_names(program: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        let has_extension = Path::new(program).extension().is_some();
        if has_extension {
            return vec![program.to_string()];
        }
        return vec![format!("{program}.exe"), program.to_string()];
    }
    #[cfg(not(windows))]
    {
        vec![program.to_string()]
    }
}

fn is_launchable_file(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Test-only constructor for the `DisplayUnavailable` variant. The real
/// probe ([`probe_display`]) now produces this variant under the
/// `UTSUSHI_STRICT_DISPLAY` gate; this helper builds a deterministic
/// instance so the wiring smoke test can assert the semantic-code
/// harness-kind contract without depending on host env.
#[cfg(test)]
pub(super) fn force_display_unavailable() -> BrowserUnavailabilityReason {
    BrowserUnavailabilityReason::DisplayUnavailable {
        source: BrowserDetectionLabel::Path,
        platform: "test",
        probe: DisplayProbeOutcome::UnavailableStrict,
    }
}
