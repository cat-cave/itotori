# UTSUSHI-148 — Browser launch alpha contract tightening

- **Node**: UTSUSHI-148
- **Title**: Browser launch alpha contract tightening
- **Branch**: `spec/utsushi-148`
- **Worktree**: `/scratch/worktrees/itotori-spec-utsushi-148`
- **DependsOn**: UTSUSHI-050 (complete)
- **Author**: planning worker (orchestrator)
- **Date**: 2026-06-23
- **Status target**: in_progress -> ready_for_review

## 1. Goal restatement

UTSUSHI-050 shipped Chromium browser launch + NW.js capability diagnostic
on the `RuntimeAdapter` surface (see `crates/utsushi-fixture/src/launch_adapters.rs`).
The `BrowserLaunchAdapter` advertises trace/frame_capture/smoke_validation as
adapter-supported regardless of host configuration, and treats absent Chromium
as a warning-level diagnostic (`utsushi.browser_host_unavailable`, severity
`warning`) plus a runtime failure only when the operator actually invokes
trace/capture/smoke. The `NwjsLaunchAdapter` is registered as a capability
diagnostic with zero capabilities but no semantic code separating "deliberately
research-tier" from "TBD until implementation lands."

UTSUSHI-148 succeeds that by tightening the contract to enforce the orchestrator's
"no optionality on claimed inputs" architectural commitment for the RPG Maker
MV/MZ vertical:

1. **Chromium browser launch is required for any MV/MZ alpha capability claim.**
   `BrowserLaunchAdapter`'s descriptor and capability listing no longer carry
   the implicit "when host support exists" optionality. Trace, capture, and
   smoke_validation remain advertised as the adapter's capability surface, but
   the runtime host-availability diagnostic graduates from warning to error
   severity in supported environments, and the launch path returns a typed,
   semantically-coded hard error rather than treating absence as a soft skip.
2. **Environmental misconfiguration is a hard error.** Missing Chromium, wrong
   Chromium version, broken display/DRI, or environment-pointed-but-broken
   `UTSUSHI_BROWSER_BIN` each emit a typed `RuntimeAdapterDiagnostic` (severity
   `error`) and, on launch, a `RuntimeHarnessError` whose semantic error code
   is one of the new `utsushi.browser.*` codes (see section 4).
3. **NW.js is explicitly research-tier.** `NwjsLaunchAdapter` is renamed in
   capability output as research-tier-unsupported (`utsushi.runtime.research_tier_unsupported`)
   so capability advertising clearly distinguishes it from "alpha capability
   present but not host-runnable today." Invoking trace/capture/smoke against
   the NW.js adapter returns the same semantic code.
4. **Engine-neutral diagnostic codes.** Codes use `utsushi.browser.*` and
   `utsushi.runtime.*` namespaces, never RPG-Maker-specific. Other engines
   that need Chromium launch in future (e.g. TyranoScript browser-target
   builds) share the same codes.

This is the runtime-evidence-side enforcement of the "no optionality on claimed
inputs" posture documented in
[`docs/itotori-vault-source-adapter.md`](../docs/itotori-vault-source-adapter.md)
and applied to the vault read path in KAIFUU-176. The browser launch path is
the runtime analog: if MV/MZ alpha runtime evidence is claimed, Chromium launch
success must be evidence-present, not "evidence-present when host happens to
have Chromium."

## 2. Module placement

**The work is cohesive within `crates/utsushi-fixture/src/launch_adapters.rs`,
with one small core extension and one CLI test update.** A survey of the tree:

```
crates/
  utsushi-core/src/lib.rs           # RuntimeAdapterDiagnostic, RuntimeHarnessError,
                                    #  RuntimeHarnessErrorKind enum
                                    #  -> small additive variants here (section 4.1)
  utsushi-cli/src/main.rs           # registers BROWSER_LAUNCH_ADAPTER / NWJS_LAUNCH_ADAPTER;
                                    #  capability_command output is the public capability
                                    #  advertising surface
                                    #  -> capability test update (section 8.4)
  utsushi-fixture/src/
    launch_adapters.rs              # BrowserLaunchAdapter, NwjsLaunchAdapter
                                    #  (THIS NODE's main edit surface; ~1300 lines today)
    lib.rs                          # re-exports the adapters
```

Despite the crate being named `utsushi-fixture`, UTSUSHI-050 placed the host-
backed launch adapters here. UTSUSHI-103 plans the longer-term `EnginePort`
template migration but explicitly defers BrowserLaunchAdapter/NwjsLaunchAdapter
migration ("launch hosts, not engine ports"). UTSUSHI-148 keeps the adapters
in their current crate to avoid colliding with UTSUSHI-103 / UTSUSHI-120
substrate work in flight.

A follow-up (out of scope here) may extract `BrowserLaunchAdapter` /
`NwjsLaunchAdapter` into a dedicated `utsushi-launch-adapters` crate once the
EnginePort migration policy is settled. UTSUSHI-148 is additive within the
current placement.

### Sub-module split inside `launch_adapters.rs`

The 1300-line file is already monolithic. UTSUSHI-148 keeps it that way to
minimize churn, but introduces a small private module boundary for the new
detection logic to keep the diff reviewable:

```rust
// inside launch_adapters.rs
mod browser_detection {
    // BrowserDetectionLabel (existing, renamed - see section 5.2)
    // ChromiumProbeOutcome (new)
    // ChromiumVersionCheck (new)
    // DisplayProbe (new)
    // probe_chromium(...) -> Result<ChromiumProbeOutcome, BrowserUnavailabilityReason>
    // chromium_min_supported_version() -> &'static str
}
```

The module is `pub(super)` so the existing test module stays adjacent and
fixture tests don't need crate-public surface changes.

## 3. Capability surface change

### 3.1 Before (UTSUSHI-050)

```rust
// browser_capability_contract() (current)
RuntimeCapabilityContract::new(
    RuntimeCapabilityClass::LaunchCapture,
    FidelityTier::LayoutProbe,
    EvidenceTier::E2,
    vec![
        // Launch: partial, with limitations including:
        //   "Host must provide Chromium/Chrome or UTSUSHI_BROWSER_BIN."
        // ...
    ],
    limitations: vec![
        "Browser support is host-capability dependent and limited to launch/capture
         smoke validation.",
        // ...
    ],
)
```

`browser_host_availability_diagnostic()` emits severity `info` when host is
available, severity `warning` when absent. `NwjsLaunchAdapter`'s descriptor
has `capabilities: vec![]` plus a limitation describing the adapter as a
"capability diagnostic fallback" — implicitly research-tier, but not labeled
as such with a semantic code.

The contract reads as: "Chromium browser launch is an alpha capability when
the host happens to support Chromium; otherwise it's a warning and the
capability listing still advertises it."

### 3.2 After (UTSUSHI-148)

```rust
// browser_capability_contract() (new)
RuntimeCapabilityContract::new(
    RuntimeCapabilityClass::LaunchCapture,
    FidelityTier::LayoutProbe,
    EvidenceTier::E2,
    vec![
        // Launch: status REMAINS `Partial` (E1 evidence ceiling) - the slice
        // does not implement RPG Maker scene hooks - but the description and
        // limitations are rewritten:
        RuntimeFeatureSupport::partial(
            RuntimePlaybackFeature::Launch,
            EvidenceTier::E1,
            "Launches browser-style runtime entrypoints through a bounded
             Chromium-compatible process. Required for MV/MZ alpha runtime
             evidence; a supported host environment must provide Chromium.",
            vec![
                "Chromium binary is mandatory: PATH lookup or UTSUSHI_BROWSER_BIN.
                 Absence is a hard utsushi.browser.chromium_unavailable error.".to_string(),
                "Launch is headless and does not yet inject RPG Maker
                 observation hooks.".to_string(),
            ],
        ),
        // TextTrace, Screenshot, FrameCapture, InstrumentationHooks features
        // retain their UTSUSHI-050 ceilings (E1/E2) — the capability surface
        // itself does not get richer in this node. What changes is that the
        // descriptions stop calling them "when the host supports it" and the
        // limitations no longer carry the "host-capability-dependent" caveat
        // language.
        // ...
    ],
    limitations: vec![
        // REMOVED: "Browser support is host-capability dependent..."
        // KEPT:    "No raw local screenshot path is exposed in runtime evidence reports."
        // ADDED:   "Chromium browser launch is required for MV/MZ alpha runtime
        //           evidence; supported host environments must provide Chromium
        //           on PATH or through UTSUSHI_BROWSER_BIN.",
        // ADDED:   "Environmental misconfiguration (missing/incompatible Chromium,
        //           unavailable display) is a hard error with semantic codes in
        //           the utsushi.browser.* namespace.",
    ],
)
```

The host-availability diagnostic graduates:

```rust
// browser_host_availability_diagnostic() (new shape)
fn browser_host_availability_diagnostic(&self) -> RuntimeAdapterDiagnostic {
    let outcome = browser_detection::probe_chromium(...);
    match outcome {
        Ok(probe) => RuntimeAdapterDiagnostic::new(
            "browser_host_availability",
            "available",
            "info",
            "Chromium-compatible browser host is available...",
        )
        .with_detail("capability", "browser_launch")
        .with_detail_value("hostAvailable", json!(true))
        .with_detail("browserSource", probe.source_label())
        .with_detail("chromiumVersion", probe.version_string())
        .with_detail("errorCode", "utsushi.browser.chromium_available")
        .with_detail("pathRedaction", "raw_local_paths_omitted"),

        Err(reason) => RuntimeAdapterDiagnostic::new(
            "browser_host_availability",
            "unavailable",
            "error",                                    // <-- WAS "warning"
            reason.diagnostic_message(),
        )
        .with_detail("capability", "browser_launch")
        .with_detail_value("hostAvailable", json!(false))
        .with_detail("browserSource", reason.source_label())
        .with_detail("errorCode", reason.semantic_code())  // utsushi.browser.*
        .with_detail("pathRedaction", "raw_local_paths_omitted"),
    }
}
```

### 3.3 NW.js demotion

```rust
// nwjs_unsupported_capability_contract() (renamed: nwjs_research_tier_contract)
//
// CHANGES:
// - capability_class stays StaticTrace (unchanged).
// - Every RuntimeFeatureSupport::unsupported() description is rewritten to
//   reference "research-tier" instead of "this slice".
// - limitations list gains:
//     "NW.js is research-tier and is not advertised as an alpha capability."
//
// AND, in NwjsLaunchAdapter::descriptor(),
// diagnostics now contains one entry:
//   RuntimeAdapterDiagnostic::new(
//       "research_tier_status",
//       "unsupported",
//       "info",
//       "NW.js launch is research-tier work. It is not part of the MV/MZ
//        alpha capability surface; use BrowserLaunchAdapter for alpha
//        runtime evidence.",
//   )
//   .with_detail("capability", "browser_launch")
//   .with_detail("errorCode", "utsushi.runtime.research_tier_unsupported")
//   .with_detail("runtimeTier", "research")
//   .with_detail("supersededBy", "utsushi-browser")
```

`NwjsLaunchAdapter::trace/capture/smoke_validate` (currently only `trace`
returns a `&'static str` error) all return a typed `RuntimeHarnessError`
of the new `RuntimeHarnessErrorKind::ResearchTierUnsupported` kind (section 4.1).

## 4. Semantic code additions

### 4.1 New `RuntimeHarnessErrorKind` variants (utsushi-core)

```rust
// crates/utsushi-core/src/lib.rs
pub enum RuntimeHarnessErrorKind {
    // existing:
    InvalidPlan,
    LaunchFailed,
    Timeout,
    ProcessFailed,
    ProcessWaitFailed,
    ProcessCleanupFailed,
    CaptureTimeout,
    CaptureFailed,
    ArtifactStoreUnavailable,
    ArtifactWriteFailed,
    // new (UTSUSHI-148):
    ChromiumUnavailable,            // -> "runtime_browser_chromium_unavailable"
    ChromiumVersionMismatch,        // -> "runtime_browser_chromium_version_mismatch"
    ChromiumDisplayUnavailable,     // -> "runtime_browser_display_unavailable"
    ResearchTierUnsupported,        // -> "runtime_research_tier_unsupported"
}
```

The error `code()` strings remain the legacy `runtime_*` namespace used by the
existing `RuntimeHarnessError::to_json()` `errorCode` field. The new
`utsushi.browser.*` / `utsushi.runtime.*` semantic codes attach as the
`RuntimeAdapterDiagnostic` detail field (matching the existing pattern at
launch_adapters.rs:374-380), AND as a new `with_detail("semanticCode", ...)`
on the harness error itself.

This keeps two things separate:

- `errorCode` (legacy field on `RuntimeHarnessError.to_json()`): the typed
  Rust error kind string.
- `semanticCode` (new detail; also the diagnostic `details.errorCode` value):
  the dotted-namespace contract code used by Itotori dashboards and audit
  matchers.

### 4.2 Semantic code catalog (engine-neutral)

| Semantic code                               | When emitted                                                                                          | Detail fields                                                      | RuntimeHarnessErrorKind      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------- |
| `utsushi.browser.chromium_available`        | Probe succeeded (info diagnostic)                                                                     | `chromiumVersion`, `browserSource`                                 | n/a (diagnostic only)        |
| `utsushi.browser.chromium_unavailable`      | No Chromium binary at PATH and no UTSUSHI_BROWSER_BIN, OR explicit config points to non-existent file | `browserSource`, `attemptedCandidates` (count only, not raw names) | `ChromiumUnavailable`        |
| `utsushi.browser.chromium_version_mismatch` | Detected Chromium but version < min supported                                                         | `chromiumVersionDetected`, `chromiumVersionRequired`               | `ChromiumVersionMismatch`    |
| `utsushi.browser.display_unavailable`       | Headless probe of display/DRI failed AND adapter was invoked without explicit headless override       | `displayProbe`, `platform`                                         | `ChromiumDisplayUnavailable` |
| `utsushi.runtime.research_tier_unsupported` | Adapter is research-tier; trace/capture/smoke invoked                                                 | `runtimeTier`, `supersededBy`                                      | `ResearchTierUnsupported`    |

Detail fields never include raw local paths — the existing
`pathRedaction: "raw_local_paths_omitted"` posture (covered by the regression
test at launch_adapters.rs:1073-1075) extends to every new code.

### 4.3 What stays under `RuntimeHarnessErrorKind::LaunchFailed`

The existing `LaunchFailed` code remains for genuinely opaque process spawn
failures that don't map to the new categorized codes (permission denied on
the binary file, fork failure under load, etc.). `LaunchFailed` no longer
covers "Chromium not found" — that becomes `ChromiumUnavailable` with the
typed semantic code.

The current `resolve_browser_program` paths at lines 287-319 return
`LaunchFailed` for both "UTSUSHI_BROWSER_BIN does not point to launchable"
and "no Chromium-compatible browser detected on PATH." Both branches change
to return `ChromiumUnavailable` with the appropriate `browserSource` detail
(`environment_unavailable` vs `path`).

## 5. Detection logic

The probe runs at `descriptor()` time (so capability output is honest without
needing to actually launch) and at every `trace`/`capture`/`smoke_validate`
call (so the diagnostic is fresh per-invocation; environment may change
between capability listing and launch).

### 5.1 `ChromiumProbe` lifecycle

```rust
mod browser_detection {
    pub(super) struct ChromiumProbeOutcome {
        pub program: PathBuf,         // resolved Chromium binary path
        pub source: BrowserDetectionLabel,  // Configured / Environment / Path
        pub version: ChromiumVersion, // parsed from --version output
    }

    pub(super) enum BrowserUnavailabilityReason {
        NoBinaryFound { source: BrowserDetectionLabel, candidates_tried: usize },
        VersionMismatch { detected: ChromiumVersion, required: ChromiumVersion },
        DisplayUnavailable { platform: &'static str, probe: DisplayProbeOutcome },
    }

    impl BrowserUnavailabilityReason {
        pub(super) fn semantic_code(&self) -> &'static str {
            match self {
                Self::NoBinaryFound { .. } => "utsushi.browser.chromium_unavailable",
                Self::VersionMismatch { .. } => "utsushi.browser.chromium_version_mismatch",
                Self::DisplayUnavailable { .. } => "utsushi.browser.display_unavailable",
            }
        }

        pub(super) fn diagnostic_message(&self) -> String { ... }
        pub(super) fn harness_error_kind(&self) -> RuntimeHarnessErrorKind { ... }
        pub(super) fn source_label(&self) -> &'static str { ... }
    }

    pub(super) fn probe_chromium(
        configured: Option<&Path>,
    ) -> Result<ChromiumProbeOutcome, BrowserUnavailabilityReason>;
}
```

The probe is pure / non-launching for the **binary lookup** and **version
check** stages. The **display check** is documented as caller's responsibility
for headless CI (see section 5.4): the probe reports display availability
deterministically when the platform supports a cheap check (Linux: presence
of `DISPLAY` or `WAYLAND_DISPLAY` env vars + `/dev/dri/card0` for hardware,
macOS: always assumed available, Windows: always assumed available), but
because the adapter already passes `--headless=new --disable-gpu --no-sandbox`,
display is not actually required for capture to succeed in CI. The display
probe therefore emits `display_unavailable` only when the operator opts in
to a non-headless launch (out of scope for this node) OR when a probe ENV
variable explicitly enables strict display checking.

Decision: in UTSUSHI-148, the `DisplayUnavailable` reason variant is defined
but is gated behind a `strict_display_check` adapter flag that this node does
NOT expose publicly. The variant exists in the enum to reserve the semantic
code; producing it requires a follow-up node. This avoids regressing CI on
headless runners while still satisfying the audit requirement that the code
is registered and reserved.

### 5.2 Binary detection (Linux / macOS / Windows)

Existing logic at lines 287-345 covers PATH lookup and `UTSUSHI_BROWSER_BIN`.
UTSUSHI-148 extends `BROWSER_CANDIDATES` to include OS-specific common
install paths as fallback after PATH lookup:

```rust
const BROWSER_CANDIDATES: &[&str] = &[
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
const BROWSER_PLATFORM_PATHS: &[&str] = &[
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

#[cfg(target_os = "windows")]
const BROWSER_PLATFORM_PATHS: &[&str] = &[
    // pulled from %ProgramFiles% / %ProgramFiles(x86)% at runtime, not
    // hardcoded - see resolve_platform_candidate
];

#[cfg(target_os = "linux")]
const BROWSER_PLATFORM_PATHS: &[&str] = &[];  // PATH covers Linux conventionally
```

Per the hard constraint that operator-environment paths remain the operator's
responsibility, these are documented in the limitation list as
"adapter-discovered common locations" rather than as guarantees.

The `BrowserDetectionLabel` enum at lines 386-410 is extended with two
variants reflecting the new detection states:

```rust
enum BrowserDetectionLabel {
    Configured,
    ConfiguredUnavailable,
    Environment,
    EnvironmentUnavailable,
    Path,
    PlatformPath,        // new: discovered via BROWSER_PLATFORM_PATHS
    Unavailable,
    VersionUnsupported,  // new: binary found but Chromium version too old
}
```

### 5.3 Chromium version check

Minimum supported Chromium major version is declared as a crate-level constant:

```rust
const CHROMIUM_MIN_SUPPORTED_MAJOR: u32 = 100;
const CHROMIUM_MIN_SUPPORTED_VERSION: &str = "100.0.0";
```

The 100.x choice tracks the `--headless=new` flag introduction (Chromium 109+
formally, but `--headless=new` is accepted from earlier builds; the 100 floor
gives a margin and matches the existing implicit assumption). The decision
to use a major-version floor (not a full semver match) is documented in
the limitation list.

The check runs `<binary> --version`, parses output of the form
`"Chromium 124.0.6367.118 ..."` or `"Google Chrome 124.0.6367.118 ..."`,
extracts the major version, and compares against the floor. Parse failure
is treated as `ChromiumVersionMismatch { detected: ChromiumVersion::Unknown,
required: 100 }` so the diagnostic still mentions the floor.

The `--version` invocation is bounded by the existing
`RuntimeLaunchCapturePlan`-style timeout pattern (1s grace), so a wedged
binary cannot block descriptor evaluation. Implementation uses the
`std::process::Command` direct API rather than the full
`RuntimeLaunchCaptureHarness` because version detection does not produce
runtime evidence and must not allocate an artifact root.

### 5.4 Display / DRI check

Display probing is platform-specific and intentionally narrow in this slice:

- **Linux**: deterministic env-var check (`DISPLAY`, `WAYLAND_DISPLAY`,
  `XDG_SESSION_TYPE`). No `/dev/dri` filesystem probe; that needs a separate
  audit pass and is out of scope here.
- **macOS** / **Windows**: display is assumed available (workstation OSes).
- **CI runners**: `--headless=new --disable-gpu --no-sandbox` already make
  display irrelevant for capture, so the probe does not gate launch unless
  `strict_display_check` is enabled (reserved, not exposed in this node).

The probe writes a `displayProbe` detail of `present_env`, `headless_only`,
or `unavailable_strict`. Headless CI receives `headless_only` and the adapter
proceeds with launch normally; only `unavailable_strict` blocks.

## 6. NW.js demotion mechanism

### 6.1 Adapter-side changes

- `NwjsLaunchAdapter::descriptor()` keeps `capabilities: vec![]` and
  `capability_class: StaticTrace`, but adds a `research_tier_status`
  `RuntimeAdapterDiagnostic` (severity `info`, status `unsupported`, semantic
  code `utsushi.runtime.research_tier_unsupported`).
- The descriptor's `limitations` field gains
  `"NW.js is research-tier and is not advertised as an alpha capability."`
  as its first entry.
- `nwjs_research_tier_contract()` (renamed from `nwjs_unsupported_capability_contract`)
  rewrites every `RuntimeFeatureSupport::unsupported(...)` description to
  reference "research-tier" rather than "this slice."
- `NwjsLaunchAdapter::trace` (and new `capture`, `smoke_validate` impls) all
  return:

```rust
Err(RuntimeHarnessError::new(
    RuntimeHarnessErrorKind::ResearchTierUnsupported,
    operation,
    "NW.js launch is research-tier work and is not advertised as an alpha capability.",
)
.with_detail("capability", "browser_launch")
.with_detail("semanticCode", "utsushi.runtime.research_tier_unsupported")
.with_detail("runtimeTier", "research")
.with_detail("supersededBy", "utsushi-browser")
.into())
```

(The `.into()` boxes into the existing `Box<dyn std::error::Error>` shape
the trait expects; `UtsushiResult<Value>` carries the harness error wrapped
in the existing top-level error type.)

### 6.2 CLI / capability advertising surface

`crates/utsushi-cli/src/main.rs::capabilities_output` already iterates every
registered descriptor and reports `capabilities`, `diagnostics`, and
`limitations` per adapter. The NW.js adapter's descriptor change automatically
propagates through: capability advertising downstream of `utsushi capabilities`
will now see the `research_tier_status` diagnostic with the semantic code.

A new CLI integration test (section 8.4) asserts that the `utsushi capabilities`
output for the NW.js adapter contains the `research_tier_status` diagnostic
with `details.errorCode == "utsushi.runtime.research_tier_unsupported"` and
`details.runtimeTier == "research"`.

### 6.3 Registration

The CLI continues to register `NwjsLaunchAdapter` in `runtime_registry()`:
removing it would hide the research-tier status from capability output, which
is the opposite of the desired contract. Keeping it registered ensures
discoverability of the research-tier banner.

## 7. Documentation update

### 7.1 `docs/subprojects-utsushi.md`

The "Runtime Adapter Contract" section currently describes the browser/NW.js
adapters in lines 214-226. Replace those paragraphs with:

> The `utsushi-browser` adapter is the alpha runtime evidence path for MV/MZ.
> It uses the core bounded process harness to launch a Chromium-compatible
> browser against `index.html` or `www/index.html`, captures a headless
> screenshot, and ingests screenshot bytes through the managed runtime
> artifact store. Browser evidence is capped at E2 layout-probe evidence: it
> proves bounded launch and screenshot production, not RPG Maker scene hooks,
> jump control, or reference-runtime fidelity.
>
> Browser launch is a required capability for MV/MZ alpha. A supported host
> environment must provide Chromium on PATH or through UTSUSHI_BROWSER_BIN.
> Missing Chromium, incompatible Chromium version, or other environmental
> misconfiguration are hard errors with semantic codes in the
> `utsushi.browser.*` namespace (e.g. `utsushi.browser.chromium_unavailable`,
> `utsushi.browser.chromium_version_mismatch`). Public CI that intentionally
> lacks Chromium must declare the skip at the recipe layer; the adapter itself
> does not silently degrade.
>
> The `utsushi-nwjs` adapter is research-tier. It remains registered so
> capability output explicitly reports the research-tier status under the
> semantic code `utsushi.runtime.research_tier_unsupported`. NW.js is NOT
> advertised as an alpha capability, and trace/capture/smoke calls against
> the adapter return the same semantic code. A future NW.js implementation
> must define bounded process launch, capture timing, screenshot extraction,
> and process-tree cleanup before it can be promoted from research-tier.

The "Runtime Strategy Bar" table (lines 80-86) is unchanged; the launch/capture
strategy already requires "launched, navigated, captured, and bounded reliably,"
which UTSUSHI-148 enforces rather than relaxes.

### 7.2 `docs/alpha-localization-project-readiness.md`

The MV/MZ alpha role table row (line 108) currently states the runtime
evidence bar as `"E1 trace or E2 capture when the probe can launch/capture; report must state limitations"`. Update to:

> `"E1 trace or E2 capture; Chromium browser launch is required and environmental
misconfiguration is a hard utsushi.browser.* error; report must state limitations"`.

Keep the rest of the row unchanged.

### 7.3 `docs/utsushi-runtime-artifacts.md` (if it lists semantic codes)

If the doc enumerates semantic codes, append the five new ones from
section 4.2 with one-line definitions and a note that they live in the
engine-neutral `utsushi.browser.*` / `utsushi.runtime.*` namespaces. If
the doc does not enumerate codes today, skip the touch.

### 7.4 Roadmap audit followup

No `roadmap/audits/` entry is created at plan time; the audit will be
generated by the orchestrator on completion. The plan reminder is that
UTSUSHI-050's follow-up `UTSUSHI-050-F001` ("Browser host availability
capability field") materially overlaps with UTSUSHI-148 — completing this
node closes that follow-up.

## 8. Test plan

All tests follow `docs/dev/testing-standard.md`. Test names read as falsifiable
behavior claims. Existing UTSUSHI-050 tests at `launch_adapters.rs:1003-1299`
stay; UTSUSHI-148 ADDS tests and updates two existing ones noted below.

### 8.1 Capability listing (in `utsushi-fixture` / `launch_adapters.rs::tests`)

- `browser_descriptor_capability_contract_marks_browser_launch_as_required_for_mv_mz_alpha()`
  — asserts the Launch feature's description string contains "Required for
  MV/MZ alpha runtime evidence" and that the limitations no longer contain
  the "host-capability dependent" caveat language. (Replaces a portion of the
  existing `browser_descriptor_reports_launch_capture_capability` test, but
  that test stays as the structural-presence smoke.)
- `browser_descriptor_omits_when_host_support_exists_optionality_language()`
  — string-grep that no descriptor field contains the literal phrases
  `"when host support exists"`, `"host-capability dependent"`, or
  `"when the host supports"`. Falsifiable check that the contract-tightening
  language landed.
- `nwjs_descriptor_advertises_research_tier_status_diagnostic()` — replaces
  the existing `nwjs_descriptor_is_explicit_unsupported_fallback` test. Asserts
  the descriptor's diagnostics contains exactly one
  `research_tier_status` entry whose `details.errorCode` is
  `utsushi.runtime.research_tier_unsupported` and whose `details.runtimeTier`
  is `research`. Also re-asserts the existing claim that
  `descriptor.capabilities` is empty.
- `nwjs_descriptor_limitations_mark_research_tier_explicitly()` — asserts
  the first limitation string contains "research-tier" and "not advertised as
  an alpha capability."

### 8.2 Detection behavior

- `browser_host_diagnostic_emits_error_severity_when_chromium_absent()` —
  using `with_browser_program(<path to nonexistent file>)`, asserts the
  diagnostic has `severity == "error"` (was `warning`) and
  `details.errorCode == "utsushi.browser.chromium_unavailable"`. Replaces
  the existing `browser_descriptor_reports_missing_configured_host_without_raw_path`
  assertion that checked `errorCode == "utsushi.browser_host_unavailable"`.
- `browser_run_returns_chromium_unavailable_kind_when_binary_missing()` —
  creates an adapter with `with_browser_program(<bogus path>)`, invokes
  `smoke_validate(...)`, asserts the resulting `RuntimeHarnessError.kind ==
RuntimeHarnessErrorKind::ChromiumUnavailable` and the `semanticCode` detail
  equals `"utsushi.browser.chromium_unavailable"`.
- `browser_run_returns_chromium_unavailable_when_env_browser_bin_broken()` —
  sets `UTSUSHI_BROWSER_BIN` to a nonexistent path via a scoped env guard
  (no global env mutation across tests), asserts the same kind +
  semanticCode + `browserSource == "environment_unavailable"`.
- `browser_run_returns_chromium_version_mismatch_when_version_too_old()` —
  uses a `fake_browser` shell script that prints
  `"Chromium 50.0.0.0 ..."` to stderr when invoked with `--version`. Asserts
  `RuntimeHarnessErrorKind::ChromiumVersionMismatch` and semanticCode
  `utsushi.browser.chromium_version_mismatch`.
- `browser_descriptor_does_not_invoke_browser_launch_during_version_probe()` —
  uses a `fake_browser` whose body writes to a marker file ONLY when invoked
  without `--version`. Calls `descriptor()` repeatedly and asserts the marker
  does not exist. Guards against the probe accidentally launching the
  capture flow at descriptor time.
- `browser_descriptor_version_probe_is_bounded_by_timeout()` — uses a
  `fake_browser` that sleeps 60 seconds. Asserts descriptor evaluation
  completes within a small bounded duration (e.g. < 3 seconds) and reports
  unavailable. (Cfg-gated on `unix` since the sleep/timeout interaction is
  shell-specific.)

### 8.3 NW.js path

- `nwjs_trace_returns_research_tier_unsupported_semantic_code()` —
  invokes `NwjsLaunchAdapter::trace(...)`, asserts the error downcasts to
  `RuntimeHarnessError` with kind `ResearchTierUnsupported` and detail
  `semanticCode == "utsushi.runtime.research_tier_unsupported"`.
- `nwjs_capture_and_smoke_validate_return_research_tier_unsupported()` —
  same shape for `capture` and `smoke_validate`. (The current adapter has
  no `capture`/`smoke_validate` impl; the trait's default would return a
  different error. UTSUSHI-148 adds these methods so all three operations
  return the same semantic code.)

### 8.4 CLI capability surface (in `utsushi-cli/src/main.rs::tests`)

- `capabilities_command_reports_browser_required_diagnostic_at_error_severity()` —
  replaces the assertion at lines 485-498 of
  `capabilities_command_reports_browser_host_diagnostic_without_launching_smoke`.
  Asserts `diagnostic["severity"] == "error"` and `details.errorCode ==
"utsushi.browser.chromium_unavailable"`.
- `capabilities_command_reports_nwjs_as_research_tier()` — new test.
  Registers `NwjsLaunchAdapter`, runs `utsushi capabilities`, asserts the
  NW.js adapter entry has a `research_tier_status` diagnostic with the
  research-tier semantic code AND the `limitations` array first entry
  mentions "research-tier" and "not advertised as an alpha capability."
- `capabilities_command_keeps_paths_redacted_in_all_new_diagnostics()` —
  parameterized over (broken UTSUSHI_BROWSER_BIN, broken configured path,
  research-tier NW.js). Asserts the output JSON does not contain the
  temp-dir prefix nor any private path string. Mirrors the existing
  pathRedaction regression test pattern.

### 8.5 CI skip flag semantics

`--skip-browser` is intentionally a recipe/job-level concern (per the
constraints section). UTSUSHI-148 does NOT add a runtime flag inside the
adapter. The plan documents what each test layer covers:

- `cargo test -p utsushi-fixture` — Chromium-absent assertions use either
  a temp-dir bogus path (no real Chromium needed) or the `fake_browser`
  shell script pattern that UTSUSHI-050 already established. Public CI
  passes regardless of whether Chromium is installed on the runner.
- `cargo test -p utsushi-cli` — same shape; capability listing tests use
  `BrowserLaunchAdapter::with_browser_program(<bogus>)` to deterministically
  reproduce the unavailable state.
- Integration smoke (`utsushi smoke <fixture-dir> --output ...`) on public
  CI — orchestrator-level concern; the CI recipe wraps the invocation with
  `if test -n "$SKIP_BROWSER"; then echo skip; else utsushi smoke ...; fi`.
  This node does NOT modify justfile/CI recipes; that is documented as a
  follow-up in section 10.3.

## 9. Verification commands

Per the DAG node (`UTSUSHI-148.verification`):

```
cargo test -p utsushi-core
pnpm exec vp run ts:test
```

Recommended additional local commands:

```
cargo test -p utsushi-fixture launch       # narrowed adapter test loop
cargo test -p utsushi-cli capabilities     # capability listing tests
cargo test -p utsushi-cli                  # CLI smoke
just check                                 # workspace gate
just test                                  # full test suite (Rust + TS)
node scripts/spec-dag.mjs validate         # DAG sanity
```

`pnpm exec vp run ts:test` is required by the DAG; UTSUSHI-148 doesn't add
TypeScript code, but the TS test suite consumes runtime evidence JSON via
`@itotori/localization-bridge-schema`. The new `utsushi.browser.*` and
`utsushi.runtime.*` semantic codes do not break that schema (they live in
diagnostic details, which are open-typed). No TS schema bump is required.

## 10. Risks and unknowns

### 10.1 Chromium binary discovery on macOS / Windows

Plan section 5.2 lists hardcoded `BROWSER_PLATFORM_PATHS` for macOS but
leaves Windows as a runtime-resolved `%ProgramFiles%` lookup. Risks:

- macOS Brave/Edge install paths vary by version; some users have Chromium
  via Homebrew (`/opt/homebrew/bin/chromium` on Apple Silicon). PATH lookup
  covers the Homebrew case; the `/Applications/...` paths cover the GUI
  install case. The list is documented as adapter-discovered common
  locations, not as guaranteed coverage. Operators with custom installs are
  expected to set `UTSUSHI_BROWSER_BIN`.
- Windows path resolution depends on `%ProgramFiles%` / `%ProgramFiles(x86)%`
  env vars. Path strings are quoted/space-bearing; existing
  `resolve_program_candidate` already handles slashes-in-program; spaces in
  paths are handled by the `Command::new(path)` shape. The plan does NOT
  add registry lookup (HKLM\\Software\\Clients\\StartMenuInternet) — too
  invasive for this slice. Operators on Windows with non-standard installs
  must set `UTSUSHI_BROWSER_BIN`.
- All three OSes: PATH lookup is the primary path; platform-specific dirs
  are a fallback. The detection label `PlatformPath` distinguishes the two
  for diagnostics.

### 10.2 Headless CI without Chromium installed

The acceptance criteria require that "supported environments" hard-fail on
Chromium absence. "Supported environment" is operator-declared: the CI
recipe says whether the lane is supposed to have Chromium. The adapter
itself cannot read CI configuration — it sees only the host. UTSUSHI-148's
posture is therefore:

- Adapter always probes and reports honestly. If Chromium is absent, the
  diagnostic is error-severity.
- CI recipes that intentionally lack Chromium wrap the `utsushi smoke`
  invocation with a `--skip-browser` test (or `$SKIP_BROWSER` env guard, or
  a `just utsushi-smoke-skippable` recipe variant). This is operator
  policy at the recipe layer, not adapter policy.

This split is the one defensible interpretation of "supported environments"
that doesn't require the adapter to introspect CI state. Migration of
existing CI lanes is covered in section 10.3.

### 10.3 Existing CI lanes that previously skipped silently

UTSUSHI-050 left the adapter as `warning` severity for missing Chromium,
meaning any existing CI lane that ran `utsushi capabilities` against the
browser adapter today gets a `warning` diagnostic and proceeds. UTSUSHI-148
flips that to `error` severity. CI recipes that consume the diagnostic and
gate on `severity == "error"` will now fail.

Mitigation:

- Audit the repo for consumers of `severity` in capability JSON before
  landing. Survey: `grep -rn "severity" --include="*.ts" --include="*.rs"`
  in `apps/`, `packages/`, and `scripts/`.
- If any lane consumes capability JSON and gates on severity, that lane
  needs an explicit `--skip-browser`-equivalent recipe pass.
- Document this as a known migration step in the PR description; the
  orchestrator's completion audit checks recipe consumers.

The current `roadmap/audits/AUDIT-UTSUSHI-050-20260618T045730Z.json` doesn't
list any consumer that gates on browser severity, but UTSUSHI-148's
implementation worker should re-grep before landing.

### 10.4 Coordination with UTSUSHI-031/032/033 (RPG Maker MV/MZ engine ports)

UTSUSHI-031 through UTSUSHI-033 are the planned RPG Maker MV/MZ engine port
nodes. They'll consume `BrowserLaunchAdapter` (or its EnginePort successor
per UTSUSHI-103). The contract tightening here is a clean upgrade for them:

- They get typed semantic codes for environmental failures, not opaque
  `LaunchFailed`. Their conformance harnesses can match on
  `utsushi.browser.chromium_unavailable` and emit a richer diagnostic.
- They lose the "host-capability dependent" caveat in capability listing
  output, which simplifies their advertising surface.
- No API/ABI break: `BrowserLaunchAdapter`'s public constructor signatures
  and `RuntimeAdapter` trait impl don't change. Existing tests in
  `utsushi-cli` that consume the descriptor continue to compile.

### 10.5 Coordination with UTSUSHI-103 EnginePort migration

UTSUSHI-103 (planned, two-slice plan in `.plan/UTSUSHI-103.md`) introduces
`EnginePort`. Section 7.2 of that plan explicitly defers
`BrowserLaunchAdapter` / `NwjsLaunchAdapter` migration: "They live above
RuntimeAdapter rather than EnginePort because they are launch-host shims,
not engine ports." UTSUSHI-148 is consistent with that: it tightens the
existing `RuntimeAdapter`-based contract without preempting the migration.

The new `RuntimeHarnessErrorKind::ChromiumUnavailable` / `ChromiumVersionMismatch`
/ `ChromiumDisplayUnavailable` / `ResearchTierUnsupported` variants are
additive on the `utsushi-core` enum. UTSUSHI-103 Slice A does not depend
on these and can land in either order.

### 10.6 Chromium `--version` invocation as a probe side-effect

The version probe spawns a subprocess at descriptor time. Risks:

- Performance: a subprocess spawn on every `descriptor()` call adds ~50ms
  on a warm cache, more on a cold cache. Mitigation: cache the probe result
  per `BrowserLaunchAdapter` instance for the lifetime of the adapter.
  The cache key is `(configured_program, UTSUSHI_BROWSER_BIN)`; a clear-cache
  helper is exposed for tests.
- Hostile binary: if `UTSUSHI_BROWSER_BIN` points to a malicious binary, the
  `--version` invocation runs it. This is acceptable: operators are
  responsible for what `UTSUSHI_BROWSER_BIN` resolves to, and `--version`
  is a standard query. Operators concerned about this can pin the binary
  by absolute path.
- Sandbox: the probe runs without `--no-sandbox` (it's just `--version`),
  so it works in restricted environments. The actual launch path still
  uses `--no-sandbox` per existing code.

### 10.7 Semantic-code namespace collision

`utsushi.browser.*` is engine-neutral by design (per the hard constraint).
A future engine that also uses Chromium (e.g. TyranoScript browser builds)
will share the same codes. Risk: an Itotori dashboard that wants
engine-specific narrative around `utsushi.browser.chromium_unavailable` may
need engine context elsewhere (e.g. on the harness's `RuntimeOperation` or
on the bridge unit ref). The plan considers this acceptable: the operational
remedy ("install Chromium" / "set UTSUSHI_BROWSER_BIN") is the same across
engines.

### 10.8 Reserved `display_unavailable` variant

Section 5.1 reserves `BrowserUnavailabilityReason::DisplayUnavailable` and
its semantic code `utsushi.browser.display_unavailable` without ever
producing it in this slice (gated behind a `strict_display_check` flag the
plan does not expose). Risk: a follow-up node that needs to emit the code
discovers the enum variant is dead code today. Mitigation: include the
variant in section 8 tests via a `#[cfg(test)] fn force_display_unavailable()`
construction helper, so the code path is exercised at test time. The
production gate remains closed.

## 11. Out of scope

- Actual MV/MZ engine port adapter implementation (UTSUSHI-031..033).
- Chromium installation/management automation: not the adapter's job.
- Alternate browser engines (Firefox, WebKit, Safari Technology Preview):
  the `BROWSER_CANDIDATES` list intentionally lists Chromium-compatible
  binaries only. A future node could add a non-Chromium adapter.
- `EnginePort` migration of `BrowserLaunchAdapter` / `NwjsLaunchAdapter`:
  UTSUSHI-103 defers this; UTSUSHI-148 is consistent with the deferral.
- CI recipe changes (`justfile` / GitHub Actions): the operator-policy
  layer of "supported environment" is recipe-side. The plan describes the
  contract (section 10.3) but does not edit recipes.
- TypeScript schema changes: semantic codes attach as diagnostic details,
  which are open-typed. No schema bump.
- Promotion of NW.js out of research-tier: that is a separate node when
  the orchestrator decides NW.js is worth implementing.
- Strict display checking (`utsushi.browser.display_unavailable` is reserved
  but not produced): a follow-up node enables it.
- New `--skip-browser` CLI flag on `utsushi smoke`: documented as
  recipe-level; the adapter has no opinion.

## 12. Implementation worker scoping

Recommendation: **one worker, single PR.** The change is tight and cohesive:

- All new code is in `crates/utsushi-fixture/src/launch_adapters.rs` plus
  four additive enum variants in `crates/utsushi-core/src/lib.rs`.
- Two existing tests in the same files are updated; the rest of the diff
  is purely additive (new tests, new private `browser_detection` module).
- Two docs (`subprojects-utsushi.md`, `alpha-localization-project-readiness.md`)
  receive surgical edits.

Estimated worker time: medium. Largest cost is the version-probe subprocess
plumbing + `fake_browser` shell fixture extensions + the new test matrix.

Sequencing within the PR (suggested commit order, single worker):

1. Add the four new `RuntimeHarnessErrorKind` variants in
   `utsushi-core/src/lib.rs` with code strings. Smoke test that downstream
   crates still compile.
2. Add `browser_detection` private module with `ChromiumProbeOutcome`,
   `BrowserUnavailabilityReason`, version parsing, and the probe entry
   point. Unit-test it in isolation.
3. Rewire `BrowserLaunchAdapter::resolve_browser_program` to use the new
   probe and return typed `RuntimeHarnessError` kinds. Update the existing
   tests at lines 1047-1077, 1207-1232, 1237-1259.
4. Update `browser_capability_contract` / descriptor / host-availability
   diagnostic per section 3.2. Add the new behavior tests.
5. Demote NW.js per section 3.3 / 6. Rename `nwjs_unsupported_capability_contract`
   to `nwjs_research_tier_contract`. Add `capture` and `smoke_validate`
   methods. Update the existing test at lines 1079-1099.
6. Update CLI test at `utsushi-cli/src/main.rs` lines 446-504 for the new
   error-severity diagnostic. Add the new research-tier capability test.
7. Update the two docs.
8. Run the full verification command list (section 9) locally.

The DAG-declared `parallelGroup: "runtime-adapters"` allows the worker to
land alongside other runtime-adapter nodes; no merge ordering constraint
applies because the four new enum variants and the descriptor rewrite are
additive to anything UTSUSHI-051 (Wine/Proton/native), UTSUSHI-103
(EnginePort substrate), or UTSUSHI-104+ (jump planner) plan.

## Plan ends here.
