//! Display-surface probing for the browser launch adapter.
//!
//! Owns the strict-display activation gate (`UTSUSHI_STRICT_DISPLAY`) and the
//! pure decision that turns host display-env state into a typed
//! `utsushi.browser.display_unavailable` outcome. With the gate off (default)
//! the headless-only launch path is unchanged.

use std::env;

use super::browser_detection::{BrowserDetectionLabel, BrowserUnavailabilityReason};

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
    evaluate_display(
        strict_display_enabled(),
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
