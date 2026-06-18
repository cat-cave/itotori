# Utsushi Fidelity Policy

Utsushi exists to collect runtime evidence for Kaifuu and Itotori. It does not
need to be a pixel-perfect commercial port of every engine before it is useful,
but it must never pretend that weak evidence is stronger than it is. Every
runtime-facing report must make its evidence tier explicit.

## Evidence Tiers

| Tier | Name            | Evidence                                                                          | Allowed claim                                                                            |
| ---- | --------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| E0   | Static          | Parsed files, bridge bundles, patch manifests, hashes, schema validation          | The files are structurally understood and patchable.                                     |
| E1   | Runtime Trace   | A runner loaded the content and emitted deterministic trace events                | The content can be reached by a known runtime path under the stated adapter assumptions. |
| E2   | Frame Capture   | Screenshots or frame captures were produced at known script positions             | The rendered frame was observed, but visual correctness still requires comparison.       |
| E3   | Replay Review   | A branchable playback session with navigation, screenshots, and annotations       | A reviewer or agent can inspect localized behavior at tracked points.                    |
| E4   | Fidelity Target | Engine behavior is validated against reference output for the covered feature set | The adapter is intended to approximate the original runtime for that feature scope.      |

Reports may include multiple tiers. The lowest tier involved in a claim must be
visible beside the claim. For example, a patch can be "E0 valid" and still have
no evidence that the localized line renders in-game.

## Runtime Evidence Schema

Runtime evidence v0.2 exposes `evidenceTier` as the canonical claim tier and
keeps `fidelityTier` as an adapter capability label. Dashboards and audit records
must render `evidenceTier` when present and must not promote adapter capability
above the evidence actually present in the report.

| `fidelityTier`       | Maximum `evidenceTier` | Dashboard wording constraint                                    |
| -------------------- | ---------------------- | --------------------------------------------------------------- |
| `trace_only`         | E1 Runtime Trace       | May claim trace reachability only.                              |
| `layout_probe`       | E2 Frame Capture       | May claim captured frames only; never engine or pixel fidelity. |
| `replay_review`      | E3 Replay Review       | May claim branchable review, not reference fidelity.            |
| `reference_fidelity` | E4 Fidelity Target     | Requires reference-runtime comparison evidence.                 |

E0 evidence is produced by static bridge, patch, hash, and schema checks. When a
legacy v0.1 report lacks `evidenceTier`, dashboards may derive E1 from
`trace_only` and E2 from `layout_probe`, but they must label that as legacy
evidence. When both fields are present, `evidenceTier` is authoritative.

## Adapter Capability Contract

Utsushi Rust adapters report capability through `RuntimeAdapterDescriptor` in
`utsushi-core`. The descriptor must be reviewed as evidence metadata, not as a
marketing claim.

| Runtime capability enum | Meaning                                                               | Minimum honest tier |
| ----------------------- | --------------------------------------------------------------------- | ------------------- |
| `Trace`                 | The adapter can load content and emit deterministic trace events.     | E1                  |
| `BranchDiscovery`       | The adapter can identify runtime branch or choice points.             | E1                  |
| `FrameCapture`          | The adapter can emit screenshot artifact references for known frames. | E2                  |
| `SmokeValidation`       | The adapter can run a bounded pass/fail runtime evidence check.       | E1 or E2 by output  |
| `ReplayReview`          | The adapter can produce branchable playback or review sessions.       | E3                  |
| `ReferenceComparison`   | The adapter can compare covered behavior against reference output.    | E4                  |

Adapter descriptors also declare an `ApproximationTier`: `none`,
`deterministic_fixture`, `layout_probe`, `engine_partial`, or
`reference_matched`. Any descriptor below `reference_matched` must include
limitations, and every non-`reference_fidelity` report must include
`approximations` in the runtime evidence payload. The registry must reject an
adapter whose evidence ceiling is stronger than its fidelity tier permits.

Fixture evidence is intentionally useful before pixel-perfect emulation. The
fixture adapter can prove trace reachability and produce deterministic capture
references, but it cannot prove commercial engine behavior, branch coverage, or
pixel equivalence. Those limits belong in both the adapter descriptor and each
runtime report.

## Runtime Environment Matrix

| Environment          | Purpose                                           | Alpha status             | Notes                                                                                    |
| -------------------- | ------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------- |
| Native Linux CLI     | Deterministic traces and fixture captures         | Required                 | Must run in public CI for synthetic fixtures.                                            |
| Native macOS CLI     | Developer parity                                  | Supported when available | Not a CI blocker unless macOS-specific code is introduced.                               |
| Native Windows CLI   | Engine compatibility and user workflows           | Supported when available | Required once an engine depends on Windows-native behavior.                              |
| Wine/Proton wrapper  | Cross-platform launch for Windows games           | Planned                  | Utsushi may call Wine, but reports must identify it as Wine-backed evidence.             |
| Browser/WASM runtime | Playable review and sharable inspection           | Planned                  | Good enough for review workflows before it is a complete port.                           |
| Remote probe host    | Agent-friendly access to a Windows or GPU machine | Planned                  | Required for scalable engine development, but not required for early synthetic fixtures. |

## Platform Baseline

Utsushi reports must make platform assumptions explicit enough that a reviewer
can distinguish deterministic fixture evidence from host-specific runtime
behavior.

| Area                  | Alpha assumption                                                                                                                                   | Reported values                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Linux CI baseline     | Ubuntu 24.04 LTS, x86_64, headless execution, Rust from `rust-toolchain.toml`, Node >= 24.14.0.                                                    | `host.os`, `host.osVersion`, `host.arch`, `host.kernel`, tool versions.                                      |
| macOS developer use   | macOS 14 or newer on arm64 or x86_64 is supported when available, but is not an alpha CI gate.                                                     | Same host fields plus `host.buildVersion` when available.                                                    |
| Windows developer use | Windows 11 23H2 or newer on x86_64 is supported when available; Windows-native behavior is not an alpha CI gate.                                   | Same host fields plus `host.buildNumber` and drive/path mode.                                                |
| Display/headless      | E0 and E1 require no display. E2 fixture captures must run under headless software rendering.                                                      | `display.mode` as `none`, `xvfb`, `wayland-headless`, `browser-headless`, or `native`.                       |
| GPU                   | Hardware acceleration is optional before E4. E2 claims must pass with software rendering.                                                          | `gpu.accelerated`, renderer name, device id when available, driver version, and capture scale.               |
| Wine/Proton           | Not required for alpha readiness. Planned Windows-game probes assume a Linux x86_64 host with Wine 9.x or Proton 9.x or newer and a 64-bit prefix. | Wine or Proton version, host OS, prefix architecture, DXVK/VKD3D state, and whether evidence is Wine-backed. |
| Browser review        | Browser/WASM review assumes Chromium 124 or newer, or the browser engine pinned by CI tooling.                                                     | Browser name, engine, version, user agent, viewport, device scale factor, and headless flag.                 |
| Filesystem paths      | Portable artifacts use UTF-8 relative paths with forward slashes under the run artifact directory.                                                 | Artifact root, path separator, case sensitivity, symlink policy, and any absolute path redaction.            |
| Locale and fonts      | CI fixture runs use `C.UTF-8` or `en_US.UTF-8`; localized review runs must state their BCP 47 locale and installed font fallback set.              | `LANG`, `LC_ALL`, source/target locale, font family, fallback family, and missing glyph count.               |

Reports should record these values in an `environment` object. Schema versions
that still expose `environment` as a string must include a companion
`environmentDetails` object or store the object in artifact metadata. A report
with missing platform fields may still be useful, but its limitations must say
which assumptions are unknown and the report must not be used for E4 claims.

## Capability Matrix

| Capability                        | Static parser | Runtime trace | Screenshot capture | VM/playback                                            |
| --------------------------------- | ------------- | ------------- | ------------------ | ------------------------------------------------------ |
| Confirms schema validity          | Yes           | Yes           | Yes                | Yes                                                    |
| Confirms patch bytes or manifests | Yes           | Partial       | Partial            | Partial                                                |
| Confirms line reachability        | No            | Yes           | Yes                | Yes                                                    |
| Confirms rendered text exists     | No            | No            | Yes                | Yes                                                    |
| Confirms visual layout quality    | No            | No            | Partial            | Partial                                                |
| Confirms branch navigation        | No            | Partial       | Partial            | Yes                                                    |
| Confirms engine-perfect behavior  | No            | No            | No                 | Only when explicitly tested against reference behavior |

Screenshots are evidence, not proof of complete quality. They are especially
valuable for catching broken markup, overflow, missing glyphs, bad wrapping,
wrong branch jumps, or untranslated image text.

## Artifact Requirements

Every Utsushi runtime artifact must include:

- `evidenceTier`: one of `E0`, `E1`, `E2`, `E3`, or `E4`.
- `adapter`: the runtime adapter or engine family that produced it.
- `environment`: structured host, display, GPU, wrapper, browser, filesystem,
  locale, and font details, or a legacy string plus equivalent metadata.
- `inputHash`: hash of the bridge, patch, script, or game profile input.
- `outputHash`: hash of the report or captured artifact payload when practical.
- `limitations`: explicit caveats for unsupported engine features.
- `createdAt`: timestamp generated by the tool.

When an artifact is derived from screenshots or recordings, the report must also
include dimensions, count, encoding, and a storage path or content-addressed id.

## Artifact Limits

Default limits keep CI and agent runs predictable:

| Artifact            | Soft ceiling              | Hard ceiling            | Default behavior                                                                     |
| ------------------- | ------------------------- | ----------------------- | ------------------------------------------------------------------------------------ |
| Runtime report JSON | 10 MiB                    | 25 MiB                  | Compact optional fields above soft ceiling; reject the report above hard ceiling.    |
| Single screenshot   | 5 MiB                     | 15 MiB                  | Warn above soft ceiling; reject that capture above hard ceiling.                     |
| Screenshot set      | 100 MiB                   | 250 MiB                 | Stop taking optional captures above soft ceiling; fail required E2 runs above hard.  |
| Recording           | 500 MiB local-only        | 1 GiB local-only        | Never upload in public CI; reject above hard ceiling.                                |
| Trace event count   | 100,000 events            | 250,000 events          | Truncate optional event payloads above soft ceiling; reject as runaway above hard.   |
| Per-run aggregate   | 750 MiB local, 250 MiB CI | 1 GiB local, 500 MiB CI | Stop optional capture once soft budget is exhausted; fail the run above hard budget. |

Limit enforcement is part of the artifact contract:

- Reports must include an `artifactLimits` block with the default ceiling, any
  override value, whether the override was used, the actor or CI job that set it,
  and the reason.
- Overrides may raise soft ceilings for local research runs, but may not raise
  hard ceilings in public CI. A CI override without a recorded reason is a
  failure.
- Trace truncation must keep deterministic ordering, retain event counts per
  bridge unit, set `truncated: true`, and record the number of omitted events.
- Screenshot and recording payloads are binary evidence and must not be
  truncated in place. Oversized required captures make the report `failed`;
  oversized optional captures are omitted and listed in `limitations`.
- Runtime report JSON may compact optional event payloads, but it must not drop
  required hashes, environment details, tier labels, limitations, or bridge-unit
  links.
- Public CI fails when a hard ceiling is exceeded, when required E1/E2 evidence
  is omitted because of size, or when the artifact limit summary is missing.
- CI retention is 14 days for report JSON, manifests, and screenshots unless a
  release or audit explicitly promotes them. Local recordings are retained for 7
  days by default and must not be committed.

## Wording Rules

Use precise claims:

- Say "E0 bridge-valid" rather than "runtime-valid" when only static checks ran.
- Say "E1 trace-reachable" when a runtime emitted trace events but no frame was
  captured.
- Say "E2 captured" when screenshots exist.
- Say "E3 replayable" only when branch/jump controls and review annotations are
  available.
- Say "E4 fidelity-targeted" only for features compared against a reference
  runtime or engine-specific conformance fixture.

Avoid unqualified claims such as "works in-game", "fully verified", "pixel
perfect", or "engine-compatible" unless the report includes the tier and scope
that justify the statement.

## Project Boundaries

Kaifuu owns extraction, patching, encryption/decryption, delta packages, and
round-trip verification. It can produce E0 evidence without Utsushi.

Itotori owns localization state, agent decisions, QA, feedback, and human review.
It consumes Utsushi evidence but must preserve the tier and limitations in its
own dashboard and audit records.

Utsushi owns runtime probes, traces, captures, replay sessions, and VM/playback
adapters. It must be useful even when imperfect, as long as its reports state the
capability level honestly.

Engine VMs are not vanity scope and they are not forbidden complexity. A
real-engine target may use an existing runtime when that produces stronger
validated evidence for the current dependency slice. For RPG Maker MV/MZ, that
means launching or instrumenting the browser/NW.js runtime and capturing trace
plus frame evidence; Rust runtime-port work is tracked by separate Utsushi P3
port slices. For engines where the native runtime cannot provide
controlled playback, deterministic jumping, snapshot state, embedded review, or
agent-inspectable evidence, a partial or full VM is the expected path. A weak
wrapper that cannot support the envisioned Itotori workflows must not be treated
as an adequate substitute just because it is simpler.

## Alpha Bar

For alpha readiness, Utsushi must support synthetic fixture evidence through E2
and the MV/MZ vertical must include `UTSUSHI-119` patched-output runtime proof:

1. Produce an E1 runtime trace for the patched fixture.
2. Produce an E2 frame capture artifact for the patched fixture.
3. Include evidence tier, adapter, environment, hashes, and limitations in each
   report.
4. Allow Itotori to ingest the report without weakening the tier language.
5. Consume Kaifuu `PatchResult` and `SHARED-025` manifest ids when claiming
   that a localized line was observed after patching.

Engine-specific VM/playback work can start before E4 fidelity is possible, but
must label itself as E1, E2, or E3 until reference comparison exists. A partial VM
can still be a successful product milestone when it supports controlled playback,
jump-to-moment review, snapshots, recordings, browser embedding, and repeatable
agent validation inside a declared feature profile.

The first real-engine alpha proof should be an RPG Maker MV/MZ validation probe
that demonstrates at least one patched project can produce evidence useful to
Itotori review: reachable text or choice trace, screenshot artifact references,
semantic launch/capture errors when unsupported, and visible fidelity limits.
Static route analysis may accompany that report, but it must remain E0 unless an
actual runtime path observed the content.

The first VM-track proof should build concrete controlled-playback primitives,
not a decision report. Specs in the roadmap should implement the agreed
direction: reusable session state, jump targets, snapshots, replay metadata,
recording hooks, browser embedding contracts, and adapter capability boundaries.
Engine-specific adapter specs can then implement those primitives for RPG Maker,
Siglus, KiriKiri, or another selected engine profile.
