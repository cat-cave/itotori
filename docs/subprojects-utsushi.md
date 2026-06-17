# Utsushi Subproject

Utsushi owns runtime validation evidence: trace, replay, capture, smoke reports, and future playable review slices.

The scaffold implements a fixture runtime. It optimizes for validation usefulness first; pixel-perfect compatibility is an upside target, not the entry bar.

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
