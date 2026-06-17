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
