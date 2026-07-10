# Utsushi Subproject

> **Alpha definition (2026-06-24).** The redefined alpha gates live at the top
> of [`project-readiness.md`](project-readiness.md).
> Alpha-ready means the architecture-proven dogfood point — substrate
> extensions M.1–M.3 (`UTSUSHI-222`/`223`/`224`) plus a non-synthetic engine
> port crate (`UTSUSHI-200`), validated against multi-engine real bytes.
> Sections below that describe Utsushi as the "runtime evidence layer" or the
> alpha runtime path for a specific engine describe the long-term contract,
> not the alpha gate. Full runtime evidence on the configured RealLive target
> via the 22-node decomposition (`UTSUSHI-201..221`) is continuous-tier
> post-alpha.

Utsushi owns runtime validation evidence: trace, replay, capture, smoke reports, and future playable review slices.

The scaffold implements a fixture runtime. It optimizes for validation usefulness first; pixel-perfect compatibility is an upside target, not the entry bar.

## First Useful Target

Utsushi is the runtime evidence layer for Itotori and Kaifuu, and that evidence
contract is the product bar. Engine VMs, WASM playback, browser review, Wine
launchers, screenshot capture, and embedded demos are implementation strategies
under that bar. They are not vanity projects, but they are also not optional
when they are the only credible way to provide the runtime control Itotori needs.

The degenerate useful case is:

1. Kaifuu patches a small real-engine project.
2. Utsushi runs or probes that patched project through the best available
   runtime path.
3. Utsushi emits a typed report saying which bridge units were observed, which
   branch or choice points were reachable, which screenshots or frames were
   captured, and what the evidence cannot prove.
4. Itotori ingests that report so humans and QA agents can review source,
   translation, runtime evidence, findings, and feedback together.

That is valuable even before Utsushi can emulate a full engine, but it is not a
license for half-measures. It catches broken protected markup, missing text,
wrong patch output, glyph/font problems, line overflow, branch reachability
gaps, untranslated UI/image surfaces, and runtime-only strings that static
extraction missed.

The first instrument-existing-runtime proof should be an RPG Maker MV/MZ
validation probe that uses the existing MV/MZ runtime where possible, such as
browser or NW.js-style launch/capture plus injected observation hooks. That is
not because Utsushi is afraid of building runtimes; it is because RPG Maker
already ships a web-shaped runtime that can plausibly deliver trace, branch,
snapshot, screenshot, and review evidence faster than a ground-up port. A
Rust-side adapter still owns orchestration, capability reporting, artifact
storage, semantic errors, and normalized runtime evidence.

For engines where the native runtime cannot provide controlled playback,
deterministic jumping, snapshots, recordings, embedded browser demos, or
agent-inspectable state, a full or partial VM is the correct direction. The
existence of `siglus_rs` is evidence that this path is practical for at least
some commercial VN engines. The product decision is that Utsushi must support
controlled playback when Itotori needs it. Engine-specific specs can then choose
the implementation strategy, such as wrapping, instrumentation, Wine/native
launch, browser runtime, partial VM, or reference VM, against that already-agreed
feature bar.

Siglus is the first full VM proof candidate after Kaifuu has established the
key/profile boundary and scene/gameexe parsing handoff. Ren'Py should prefer
instrumentation of the existing runtime unless a bounded replay subset proves
useful enough to justify a port. Utsushi roadmap specs are implementable
engine-port slices, not feasibility reports or decisions about whether runtime
work should exist.

### Native ports are co-equal product

Native and WASM Utsushi engine ports are co-equal product to Kaifuu adapters,
not optional polish layered on top of a real-runtime wrapper. The shipped
validation path for any engine is always a native Utsushi port (Rust, or
Rust-compiled-to-WASM for browser review). That is what users, agents, and CI
exercise.

Reference-capture from external runtimes (NW.js, browser, Wine, a vendor VM)
remains useful, but only as a _developer-time porting aid_: during port
development the worker can drive the original runtime to produce reference
traces and frames against which the Rust/WASM port's output is validated. Those
captured references are inputs to the port's conformance tests; they are not a
shipped validation path. A configuration that ships "wrap the original runtime
and call it Utsushi evidence" is not a port — it is a stopgap, and an engine in
that state is not yet claimed-support.

## Runtime Strategy Bar

Every real-engine runtime adapter should be classified by the strongest control
surface it can honestly provide:

| Strategy                 | When it is acceptable                                                                 | When it is not enough                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Static probe             | E0 structure, route hints, asset links, and launch planning.                          | Any claim that localized text was observed in a running game.                         |
| Launch/capture wrapper   | The original runtime can be launched, navigated, captured, and bounded reliably.      | Jump-to-moment, branch control, embedded demos, or agent state inspection are needed. |
| Instrumented runtime     | Hooks can observe text, choices, scene state, screenshots, and deterministic markers. | Hooks are brittle, host-specific, or cannot produce stable replay/snapshot semantics. |
| Partial VM/playback core | Enough script semantics can be implemented for review, replay, branch, and snapshots. | The feature needs pixel/reference fidelity outside the implemented semantic subset.   |
| Reference runtime/VM     | Engine behavior is matched against reference output for a declared feature profile.   | The profile is too broad to validate or cannot be tested against reference behavior.  |

Launch/capture wrappers must be bounded as a whole lifecycle, not only as a
direct child process. The Rust harness starts launched runtimes in an isolated
Unix process group, applies deadlines to capture hooks, contains hook panics,
and terminates the process group on timeout or hook failure. Platforms without
process-tree cleanup support fail closed with a semantic harness error instead
of silently falling back to direct-child-only cleanup.

The first credible long-term Utsushi proof is not merely "a screenshot exists."
It is controlled playback evidence: jump to a known localized moment, observe the
line and state, capture an artifact, attach reviewer or agent findings, and
repeat the run deterministically enough that a failed validation is debuggable.

## Rust Engine Port Track

The practical alpha path starts with probes, launch/capture, and instrumentation
where those methods can produce useful evidence quickly. The Utsushi track also
includes full or partial Rust ports of common engines because they unlock a
stronger product shape: cross-platform play, browser/WASM review, deterministic
jump-to-moment, snapshots, recordings, agent-readable state, and patch validation
without depending on a brittle host runtime.

The substrate slices (`UTSUSHI-020` through `UTSUSHI-030`, plus `UTSUSHI-056`,
`UTSUSHI-103`, and `UTSUSHI-120`) are alpha-tier: they are the load-bearing
render-fidelity and conformance track that every claimed engine depends on. The
per-claimed-engine port slices (`UTSUSHI-031` through `UTSUSHI-039`, covering RPG
Maker MV/MZ, SiglusEngine, KiriKiri/KAG, and plain XP3) are likewise alpha-tier
and co-equal product to Kaifuu adapters, not nice-to-have polish. Engine port
work for unclaimed engines — Ren'Py, Wolf RPG Editor, BGI/Ethornell,
TyranoScript, RGSS3/VX Ace, Unity, and encrypted krkrz/TJS-heavy KiriKiri —
remains continuous research-tier work and stays in the roadmap as future
verticals rather than being deleted.

The roadmap contains executable Rust-port specs:

- `UTSUSHI-020` through `UTSUSHI-025` build the shared substrate in reviewable
  slices: VFS and asset packages, deterministic input and clocks, headless
  text/render/audio sinks, inspectable state and snapshots, WASM/embed ABI, and
  implementation-map validation.
- `UTSUSHI-026` through `UTSUSHI-030` build the conformance layer: profile and
  result schemas, trace and branch checks, snapshot checks, capture and
  recording artifact checks, and Itotori ingestion fixtures.
- `UTSUSHI-031` through `UTSUSHI-061` create engine-specific executable slices
  for RPG Maker MV/MZ, Siglus, KiriKiri/KAG, Ren'Py, Wolf RPG Editor,
  BGI/Ethornell, TyranoScript, RPG Maker VX Ace/RGSS3, and bounded Unity
  capture profiles. The later nodes also add a shared runtime observation hook
  protocol, a Siglus WASM split, focused Siglus opcode packs, and reference
  runtime trace/capture recording.

Each engine-port slice must produce code, fixtures, conformance output, and a
subsystem coverage map tied to tests. A worker can research an engine deeply,
but the accepted artifact cannot be a feasibility report. It must leave behind
an executable skeleton, a controlled playback smoke, or a concrete conformance
fixture that future workers can expand.

The intended pattern is one engine-focused worker per executable slice. The
first slice for an engine chooses one control surface and proves it: existing
runtime instrumentation, parser/replay, VM adapter smoke, archive handoff, or a
specific subsystem pack. Follow-up slices then expand concrete subsystems such
as KAG macro handling, Siglus opcode coverage, MV/MZ event commands, Wolf common
events, or BGI bytecode opcodes.

Current engine-port strategy:

- **SiglusEngine** is the first full VM proof candidate, sequenced after Kaifuu
  key/profile boundaries plus Scene.pck and Gameexe parsing make a clean runtime
  handoff possible.
- **RPG Maker MV/MZ** is the first instrument-existing-runtime proof because its
  browser/NW.js-shaped runtime can provide observation hooks and capture quickly.
- **Ren'Py** starts with existing-runtime instrumentation (`UTSUSHI-041`).
  Route replay (`UTSUSHI-040`) is a follow-up subset only after observed-runtime
  evidence boundaries are established.

## Runtime Evidence v0.2

Utsushi runtime reports use `RuntimeEvidenceReportV02` from
`@itotori/localization-bridge-schema`.

- `evidenceTier` is the claim tier (`E0` through `E4`); `fidelityTier` is only
  adapter capability and cannot raise the claim above the evidence present.
- Trace events, branch points, captures, recordings, approximations, and runtime
  findings link back to bridge content through `bridgeUnitRef`.
- Screenshots and recordings are `artifactRef` records with portable URIs. They
  are referenced by default, not embedded in runtime report JSON.
- The fixture runtime smoke path emits E2 evidence: deterministic text trace plus
  a referenced screenshot artifact. It does not perform reference-runtime pixel
  comparison and must not be described as E4 fidelity evidence.

### Conformance fixture builders

`utsushi-core` exposes its deterministic, engine-neutral conformance fixture
builders in the default public API. Downstream conformance tests may import
them directly; there is no `conformance-fixtures` Cargo feature or feature
handshake to enable. This keeps the test aid surface aligned with the shipped
crate and lets in-crate and cross-crate consumers exercise the same builders.

## Runtime Adapter Contract

Rust runtime adapters implement the `RuntimeAdapter` trait in `utsushi-core`.
The trait is engine-agnostic: adapters receive an input root and optional
artifact root, then emit shared runtime evidence JSON for supported operations.

Required API surface:

| API method          | Capability enum                      | Expected evidence shape                                               |
| ------------------- | ------------------------------------ | --------------------------------------------------------------------- |
| `trace`             | `RuntimeCapability::Trace`           | E1 or stronger report with deterministic trace events.                |
| `discover_branches` | `RuntimeCapability::BranchDiscovery` | Branch-point evidence when the adapter can enumerate runtime choices. |
| `capture`           | `RuntimeCapability::FrameCapture`    | E2 or stronger report with screenshot artifact references.            |
| `smoke_validate`    | `RuntimeCapability::SmokeValidation` | Small pass/fail evidence report for release and CI checks.            |

Every adapter registers a `RuntimeAdapterDescriptor` with its name, version,
capabilities, maximum fidelity tier, maximum evidence tier, runtime capability
contract, approximation tiers, and limitations. The capability contract names the
adapter boundary as static trace, launch/capture, instrumented runtime, partial
VM, or reference VM, then marks individual playback features as supported,
partial, or unsupported. `RuntimeAdapterRegistry` rejects duplicate adapter names
and rejects descriptors whose evidence ceiling exceeds the declared fidelity or
capability contract.

The Utsushi CLI owns runtime composition in
`crates/utsushi-cli/src/main.rs::runtime_registry`, where it explicitly registers
the fixture, browser, and NW.js diagnostic adapters. Future runtime adapters must
be registered there to become selectable through `utsushi <trace|capture|smoke>`.
Adapter crates expose adapter constructors and descriptor behavior, not composed
production registries.

The synthetic fixture adapter lives in `utsushi-fixture` and implements the same
trait as future adapters. Its descriptor advertises trace, frame capture, and
smoke validation, but not branch discovery or reference comparison. Its
approximation tier is `deterministic_fixture`, and its reports state that
captures are deterministic artifact references without pixel comparison. The
base fixture contract explicitly does not implement jump, snapshot, live
screenshot, or recording APIs.

The `utsushi-browser` adapter is the runtime evidence path for MV/MZ, which is a
**beta** (end-to-end, real-game-testing-ready) engine — RPG Maker MV/MZ
end-to-end on a real game is beta per
[`docs/project-readiness.md`](project-readiness.md), where alpha is the single
configured RealLive corpus only. It
uses the core bounded process harness to launch a Chromium-compatible browser
against `index.html` or `www/index.html`, captures a headless screenshot, and
ingests screenshot bytes through the managed runtime artifact store. Browser
evidence is capped at E2 layout-probe evidence: it proves bounded launch and
screenshot production, not RPG Maker scene hooks, jump control, or
reference-runtime fidelity.

Browser launch is a required capability for MV/MZ end-to-end runtime evidence,
which is a beta (real-game-testing-ready) tier, not alpha. A supported host
environment must provide Chromium on PATH or through `UTSUSHI_BROWSER_BIN`.
Missing Chromium, incompatible Chromium version, or other environmental
misconfiguration are hard errors with semantic codes in the `utsushi.browser.*`
namespace (e.g. `utsushi.browser.chromium_unavailable`,
`utsushi.browser.chromium_version_mismatch`). Public CI that intentionally lacks
Chromium must declare the skip at the recipe layer; the adapter itself does not
silently degrade.

The `utsushi-nwjs` adapter is research-tier. It remains registered so capability
output explicitly reports the research-tier status under the semantic code
`utsushi.runtime.research_tier_unsupported`. NW.js is NOT advertised as a supported
(beta) MV/MZ capability, and trace/capture/smoke calls against the adapter return the same
semantic code. A future NW.js implementation must define bounded process launch,
capture timing, screenshot extraction, and process-tree cleanup before it can be
promoted from research-tier.
