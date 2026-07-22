use super::*;

/// Activation-gate env var for strict display checking ().
/// Absent / falsey (unset, `""`, `0`, `false`, `off`) leaves the
/// headless-only behavior untouched: no display env var is
/// NOT an error. Truthy opts the operator into requiring a usable
/// display surface, so a CI runner with a broken/absent display gets a
/// typed `utsushi.browser.display_unavailable` diagnostic instead of a
/// silent headless launch.
const STRICT_DISPLAY_ENV: &str = "UTSUSHI_STRICT_DISPLAY";

/// X11/Wayland session env vars whose presence signals a usable display
/// surface on platforms that use that convention (Linux/BSD).
const DISPLAY_ENV_VARS: &[&str] = &["WAYLAND_DISPLAY", "DISPLAY"];

pub(super) fn strict_display_enabled() -> bool {
    env_flag_enabled(STRICT_DISPLAY_ENV)
}

fn env_flag_enabled(name: &str) -> bool {
    match env::var(name) {
        Ok(value) => {
            let trimmed = value.trim();
            !trimmed.is_empty()
                && !trimmed.eq_ignore_ascii_case("0")
                && !trimmed.eq_ignore_ascii_case("false")
                && !trimmed.eq_ignore_ascii_case("off")
        }
        Err(_) => false,
    }
}

fn display_env_present() -> bool {
    DISPLAY_ENV_VARS
        .iter()
        .any(|name| env::var(name).is_ok_and(|value| !value.trim().is_empty()))
}

fn display_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unix"
    }
}

/// Whether the current platform advertises a usable display through the
/// X11/Wayland `DISPLAY`/`WAYLAND_DISPLAY` env-var convention. macOS and
/// Windows expose a native window server whose availability those env
/// vars do not describe, so strict env-based checking cannot prove the
/// surface is absent there and must not false-positive.
fn platform_uses_display_env() -> bool {
    cfg!(all(unix, not(target_os = "macos")))
}

/// Real strict-display probe (). Reads the activation gate and
/// the host display env, then decides via [`evaluate_display`].
pub(super) fn probe_display(
    source: BrowserDetectionLabel,
) -> Result<DisplayProbeOutcome, BrowserUnavailabilityReason> {
    super::evaluate_display(
        super::strict_display_enabled(),
        display_env_present(),
        platform_uses_display_env(),
        source,
        display_platform(),
    )
}

/// Pure strict-display decision, separated from the env reads in
/// [`probe_display`] so the policy is exercised deterministically without
/// process-env mutation.
///
/// - A present display surface is always usable (`PresentEnv`).
/// - Gate off keeps the headless-only default (`HeadlessOnly`); absence of
///   a display is never an error, preserving behavior.
/// - Gate on with no display: on env-convention platforms this is a hard
///   [`BrowserUnavailabilityReason::DisplayUnavailable`]; on native-window
///   platforms the env signal is inapplicable, so it stays `PresentEnv`.
pub(super) fn evaluate_display(
    strict: bool,
    display_present: bool,
    platform_uses_display_env: bool,
    source: BrowserDetectionLabel,
    platform: &'static str,
) -> Result<DisplayProbeOutcome, BrowserUnavailabilityReason> {
    if display_present {
        return Ok(DisplayProbeOutcome::PresentEnv);
    }
    if !strict {
        return Ok(DisplayProbeOutcome::HeadlessOnly);
    }
    if !platform_uses_display_env {
        return Ok(DisplayProbeOutcome::PresentEnv);
    }
    Err(BrowserUnavailabilityReason::DisplayUnavailable {
        source,
        platform,
        probe: DisplayProbeOutcome::UnavailableStrict,
    })
}
