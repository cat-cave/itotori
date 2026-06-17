# Utsushi Subproject

Utsushi owns runtime validation evidence: trace, replay, capture, smoke reports, and future playable review slices.

The scaffold implements a fixture runtime. It optimizes for validation usefulness first; pixel-perfect compatibility is an upside target, not the entry bar.

## First Useful Target

Utsushi is not primarily "the Rust game engine project." It is the runtime
evidence layer for Itotori and Kaifuu. Engine VMs, WASM playback, browser
review, Wine launchers, and screenshot capture are adapter strategies under that
goal.

The degenerate useful case is:

1. Kaifuu patches a small real-engine project.
2. Utsushi runs or probes that patched project through the best available
   runtime path.
3. Utsushi emits a typed report saying which bridge units were observed, which
   branch or choice points were reachable, which screenshots or frames were
   captured, and what the evidence cannot prove.
4. Itotori ingests that report so humans and QA agents can review source,
   translation, runtime evidence, findings, and feedback together.

That is valuable even before Utsushi can emulate a full engine. It catches
broken protected markup, missing text, wrong patch output, glyph/font problems,
line overflow, branch reachability gaps, untranslated UI/image surfaces, and
runtime-only strings that static extraction missed.

The first real-engine proof should be an RPG Maker MV/MZ validation probe that
uses the existing MV/MZ runtime where possible, such as browser or NW.js-style
launch/capture plus injected observation hooks, rather than a Rust reimplementation
of RPG Maker. A Rust-side adapter still owns orchestration, capability reporting,
artifact storage, semantic errors, and normalized runtime evidence.

Full or partial VMs are justified later when they clearly improve branch
navigation, jump-to-moment review, deterministic replay, screenshot automation,
browser playback, or cross-platform validation beyond what launch/capture hooks
can provide. Siglus, KiriKiri, RPG Maker, and Ren'Py should be evaluated through
that build-vs-wrap lens before Utsushi commits to a large engine-port effort.

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
capabilities, maximum fidelity tier, maximum evidence tier, approximation tiers,
and limitations. `RuntimeAdapterRegistry` rejects duplicate adapter names and
rejects descriptors whose evidence ceiling exceeds the declared fidelity tier.

The synthetic fixture adapter lives in `utsushi-fixture` and uses the same trait
and registry path as future adapters. Its descriptor advertises trace, frame
capture, and smoke validation, but not branch discovery or reference comparison.
Its approximation tier is `deterministic_fixture`, and its reports state that
captures are deterministic screenshot references without pixel comparison.
