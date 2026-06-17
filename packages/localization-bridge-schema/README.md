# Localization Bridge Schema

Neutral JSON-compatible contracts shared by Itotori, Kaifuu, and Utsushi.

The bridge package is intentionally independent from any one subproject. Kaifuu emits and consumes patchable bridge data, Itotori localizes and evaluates it, and Utsushi emits runtime evidence linked back to bridge units.

## Versions

- `0.1.0` remains the fixture hello-world contract exported as `BridgeBundle`,
  `PatchExport`, `RuntimeVerificationReport`, and their existing guards. v0.1
  bridge JSON is intentionally rejected by `assertBridgeBundleV02` and by the
  Rust v0.2 bridge contract validator; callers must route v0.1 data through the
  legacy guards.
- `0.2.0` adds the bridge domain model exported as `BridgeBundleV02`,
  enum-backed category lists, bundle-level asset reference integrity, source
  game/profile revision identity, hash strategy metadata, v0.2 patch
  export/result/delta metadata, and runtime guards.
- `0.2.0` defines Utsushi runtime evidence as
  `RuntimeEvidenceReportV02`, with explicit `evidenceTier` and
  `fidelityTier` enums, bridge-unit references, trace events, branch-point
  events, screenshot capture refs, recording refs, approximation records,
  validation findings, and `assertRuntimeEvidenceReportV02`.
- `0.2.0` also defines suite-wide triage records exported as
  `TriageBundleV02`, `TriageEventV02`, `TriageTaskV02`, `FindingRecordV02`,
  provenance/evidence/causality records, and `assertTriageBundleV02`.

`PolicyRecordV02.scope` is a known surface category, not freeform text. Use a
value from the exported `POLICY_SCOPES` list, which currently mirrors
`SURFACE_KINDS`.

The v0.2 bridge JSON example lives at `test/examples/bridge-v0.2.json`.
`test/examples/triage-v0.2.json` is a triage fixture, not a bridge bundle.
`test/examples/runtime-evidence-v0.2.json` is a runtime evidence fixture, not a
bridge bundle.
Invalid bridge fixtures live under `test/examples/invalid/` and are expected to
fail with semantic validation errors. Migration notes from v0.1 are in
`MIGRATING-0.2.md`.

## Runtime Evidence

`RuntimeEvidenceReportV02.evidenceTier` is the canonical claim tier: `E0`,
`E1`, `E2`, `E3`, or `E4`. `fidelityTier` describes adapter capability and caps
the report claim: `trace_only` can claim at most E1, `layout_probe` at most E2,
`replay_review` at most E3, and `reference_fidelity` at most E4.

Every trace event, capture, recording, branch point, approximation, or runtime
finding carries a `bridgeUnitRef` when it refers to localized content. The ref
contains `bridgeUnitId` and should include `sourceUnitKey` when available so
legacy hello-world bridge units and v0.2 UUID7 units remain traceable.

`reference_fidelity` or `E4` reports must include at least one passed
`referenceComparisons` record. Each comparison names either a reference runtime
or engine-specific conformance fixture, lists the covered bridge-unit refs, and
points at a portable `reference_comparison` artifact. Trace-only evidence,
captures, recordings, or adapter capability labels alone are not enough for E4.

Screenshots and recordings are represented through `artifactRef` records with a
portable `uri`, not embedded bytes. The guard rejects `data:` URIs, `file:` URIs,
absolute local paths, and Windows-style backslash paths. Utsushi fixture smoke
reports currently produce E2 evidence: deterministic text trace plus a referenced
screenshot artifact. They do not claim E4 pixel fidelity.

## Patch And Source Revisions

v0.2 source identity is deterministic and explicit:

- `sourceGame` identifies the game version and source extraction profile
  revision that produced the bundle.
- `sourceBundleHash` and `sourceBundleRevision` identify the full extracted
  source bundle for tracing reruns.
- `hashStrategy` declares per-scope `sha256` rules. Source units use
  `utf8-nfc-lf-json-stable-v1` text normalization with explicit source fields;
  source assets use `bytes` normalization for binary content.
- v0.2 hash strings are canonical lowercase SHA-256 digests in the form
  `sha256:` plus 64 hex characters.
- Patch compatibility is decided per `sourceUnitKey` by
  `PatchExportV02.entries[].sourceHash`. A changed bundle hash is reported for
  traceability but does not invalidate units whose unit-level source hash still
  matches.

Patch application must not silently apply stale entries. Use
`evaluatePatchExportCompatibilityV02` before applying a v0.2 patch export. A
source typo should produce `source_hash_mismatch` only for the affected unit,
with both `expectedSourceHash` and `actualSourceHash` present in the report.

Delta package metadata uses `DeltaPackageMetadataV02` to trace the package back
to the source bridge, source bundle revision, generated patch export id/hash,
target locale, and hash strategy.

## Triage Events And Findings

Triage uses append-only event records. A new event may point backward through
`causalLinks`, including to the event that caused a task, model output, patch
result, or finding. Events are not mutable status buckets; the guard rejects
event payloads with mutable status/update fields.

Findings use `severity: "P0" | "P1" | "P2" | "P3"` for implementation and
audit consequence. Localization issue class belongs in the separate
`qualityCategory` field, using `LOCALIZATION_QUALITY_CATEGORIES`; it is not a
replacement for severity.

Every finding requires concrete `evidence[]` and `provenance[]`. Provenance can
point to source annotations, style guide rules, model outputs, patching causes,
runtime evidence, human review notes, or deterministic checks. The triage guard
rejects fields whose name contains `confidence`; downstream scoring must be
backed by evidence and findings instead of LLM-style confidence values.

The v0.2 triage example lives at `test/examples/triage-v0.2.json` and includes
findings rooted in source annotation, style guide, model output, and patching
cause provenance.

## Binding Authority

Per ADR 0001, the TypeScript source in `src/index.ts` is the hand-edited
contract authority. JSON Schema artifacts and Rust serde structs are downstream
bindings that must validate against the same versioned fixtures; generated
outputs should not be patched directly.

The Rust compatibility scope for SHARED-002 is a focused v0.2 bridge bundle
validator in `kaifuu-core`. It deserializes the shared `bridge-v0.2.json`
fixture with serde and checks the same contract-critical semantics as the TS
guard: schema version, UUID7 identifiers, canonical SHA-256 hashes, revision
hash consistency, hash strategy scopes, asset reference integrity, patch refs,
protected span byte ranges, speaker knowledge states, and policy record scopes.
Runtime, patch, benchmark, and finding contracts are layered on top of this
bridge compatibility check; the TypeScript guard remains the runtime evidence
authority for SHARED-005.
