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
- `0.2.0` defines branch-scoped asset policy records exported as
  `AssetPolicyBundleV02`, `AssetPolicyDecisionV02`, enum-backed asset policy
  surfaces, and `assertAssetPolicyBundleV02`. The contract covers image text,
  UI art/textures, song title metadata, font substitution policy, credits, and
  video text or replacement decisions.
- `0.2.0` defines benchmark and cost report records exported as
  `BenchmarkReportV02`, provider/cost/token ledger records, localization
  benchmark finding records, deterministic QA records, QA-agent evaluation
  records, human evaluation records, and `assertBenchmarkReportV02`.
- `0.2.0` defines the alpha vertical proof manifest exported as
  `AlphaVerticalProofManifestV02` and `assertAlphaVerticalProofManifestV02`.
  It ties a public fixture id, engine profile, source revision, bridge unit
  refs, runtime target ids, patch/export/result artifact refs, provider proof
  ids, benchmark output refs, and content hashes without embedding raw provider
  text, secrets, or private-local corpus paths.

`PolicyRecordV02.scope` is a known surface category, not freeform text. Use a
value from the exported `POLICY_SCOPES` list, which currently mirrors
`SURFACE_KINDS`.

The v0.2 bridge JSON example lives at `test/examples/bridge-v0.2.json`.
`test/examples/asset-policy-v0.2.json` is an asset policy fixture, not a bridge
bundle.
`test/examples/triage-v0.2.json` is a triage fixture, not a bridge bundle.
`test/examples/runtime-evidence-v0.2.json` is a runtime evidence fixture, not a
bridge bundle.
`test/examples/benchmark-report-v0.2.json` is a benchmark report fixture, not a
bridge bundle; it includes a raw MTL baseline as a normal compared system.
`test/examples/alpha-vertical-proof-manifest-v0.2.json` is an alpha proof
manifest fixture that links the public hello-game fixture evidence across
Itotori, Kaifuu, and Utsushi artifact surfaces.
`test/examples/contract-fixtures-v0.2.json` is the manifest consumed by both
TypeScript and Rust validation. It lists all committed valid fixtures and all
committed invalid fixtures with the semantic error each invalid case must
produce. `test/examples/contract-compatibility-v0.2.json` is the compatibility
report for the full fixture suite.

Invalid fixtures live under `test/examples/invalid/` and are expected to fail
with semantic validation errors. Migration notes from v0.1 are in
`MIGRATING-0.2.md`.

## Full Contract Fixture Validation

The SHARED-010 fixture suite covers bridge, patch export, patch result, delta
metadata, runtime evidence, benchmark report, asset policy, triage/finding, and
permission/local-user contracts. TypeScript remains the source of truth and Rust
validates the same manifest as a downstream parity check.

Use these commands for the cross-language contract gate:

```sh
just contract-validate
pnpm --filter @itotori/localization-bridge-schema test
cargo test -p kaifuu-core shared_contract_fixture_suite
```

`just schema` runs the TypeScript schema typecheck, tests, and build. Full PR
verification should still run the workspace targets named by the spec.

## Asset Policy

`AssetPolicyBundleV02` records Itotori-owned non-dialogue asset decisions for a
specific locale branch. `localeBranch.localeBranchId` and
`localeBranch.targetLocale` scope every decision in the bundle; use a separate
bundle or branch when the same asset needs a different locale decision.

Each decision names an `assetSurfaceKind` from `ASSET_POLICY_SURFACE_KINDS`, a
source asset ref, source hash/revision metadata, one `policyAction`, the source
of the observed text (`metadata`, `manual_transcription`, `ocr_hint`, or
`not_applicable`), and a `patchMode`. Patch modes describe required downstream
work: for example, `region_redraw_required` and `asset_replacement_required`
are requirements, not completed edits.

Textless `ui_art`, `font`, and `video` decisions use
`textSourceKind: "not_applicable"` and may omit `sourceText`; text-bearing
decisions still record the observed source text. When a decision includes a
`patchRef`, the referenced asset kind must be compatible with both the asset
policy surface and the patch mode, so font substitution cannot point at image,
audio, or video patch assets.

`metadata_only` is intentionally metadata-first. The guard requires
`runtimeExpectation.expectationKind: "metadata_only"` for these records so they
cannot imply visible OCR, image editing, video editing, or runtime screenshot
validation. Image, UI art, and video policy can still be represented before the
editing pipeline exists by recording the desired text when present, branch, and
required patch mode.

## Runtime Evidence

`RuntimeEvidenceReportV02.evidenceTier` is the canonical claim tier: `E0`,
`E1`, `E2`, `E3`, or `E4`. `fidelityTier` describes adapter capability and caps
the report claim: `trace_only` can claim at most E1, `layout_probe` at most E2,
`replay_review` at most E3, and `reference_fidelity` at most E4.

Runtime reports may include `runtimeCapabilities` and
`controlledPlaybackSession`. `runtimeCapabilities` declares the adapter boundary
as `static_trace`, `launch_capture`, `instrumented_runtime`, `partial_vm`, or
`reference_vm`, with feature-level `supported`, `partial`, or `unsupported`
claims and evidence ceilings. `controlledPlaybackSession` records the actual
operation and features used for a report. The base contract can honestly mark
`jump`, `snapshot`, `screenshot`, or `recording` as unsupported; those APIs are
not required just because an adapter supports trace or launch/capture evidence.

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

The shared schema only owns portability for runtime artifact refs. Managed
storage refs under `artifacts/utsushi/runtime/...` are required by Utsushi's
runtime artifact store and Itotori's DB projection, not by every contract
example. Itotori normalizes schema-portable refs into managed storage refs at
ingestion and preserves the original adapter-local ref in metadata.

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
- Patch compatibility is decided per `sourceUnitKey` by the current
  `bridgeUnitId` selected for that source unit and
  `PatchExportV02.entries[].sourceHash`. A changed bundle hash is reported for
  traceability but does not invalidate units whose unit-level source hash still
  matches.

Patch application must not silently apply stale entries. Use
`evaluatePatchExportCompatibilityV02` before applying a v0.2 patch export. A
source typo should produce `source_hash_mismatch` only for the affected unit,
with both `expectedSourceHash` and `actualSourceHash` present in the report.
When a patch entry names a different bridge unit than the current unit for its
`sourceUnitKey`, the report uses `bridge_unit_id_mismatch` and includes
`actualBridgeUnitId`.

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

Localization benchmark and QA-agent records must also follow
`itotori-lqa-1` from
`docs/adrs/0003-localization-quality-taxonomy.md` and
`docs/localization-quality-taxonomy.json`. Future report/finding schemas should
add `qualitySeverity`, `qualitySubcategory`, `rootCause`, and
`adjudicationState` rather than overloading the triage `severity` field.

Every finding requires concrete `evidence[]` and `provenance[]`. Provenance can
point to source annotations, style guide rules, model outputs, patching causes,
runtime evidence, human review notes, or deterministic checks. The triage guard
rejects fields whose name contains `confidence`; downstream scoring must be
backed by evidence and findings instead of LLM-style confidence values.

The v0.2 triage example lives at `test/examples/triage-v0.2.json` and includes
findings rooted in source annotation, style guide, model output, and patching
cause provenance.

## Benchmark And Cost Reports

`BenchmarkReportV02` is the shared report shape for localization benchmark,
quality, QA-agent, human evaluation, token, and cost summaries. It follows the
`itotori-lqa-1` taxonomy and the provider-recording policy from ADR 0002.

Every report records:

- benchmark run id, taxonomy id/version, creation timestamp, git commit, tool
  versions, command lines, deterministic seed, bridge schema version, fixture or
  corpus refs, source/target locales, engine profile, and benchmark split;
- compared systems using `systemKind`, including `raw_mtl_baseline` so raw MTL
  runs fit the same schema as Itotori drafts and repaired drafts;
- provider/model/prompt identity for every model-backed or recorded generation
  or QA run: provider family, endpoint family, provider name, requested model,
  actual model, optional upstream provider, prompt preset id, prompt template
  version, prompt hash, timestamp, retry/fallback metadata, token usage, and
  cost amount/source;
- a cost ledger with USD micro-unit totals by system and a flag for unknown
  cost records, keeping billed, provider-estimated, local-estimated, zero, and
  unknown costs distinct;
- benchmark finding records with taxonomy id/version, detector kind,
  `category`, optional `qualitySubcategory`, `qualitySeverity`, `rootCause`,
  affected refs, evidence, provenance, seeded-defect id when applicable, and
  `adjudicationState`;
- aggregate count buckets by quality severity, category, root cause, detector
  kind, and adjudication state, plus penalty totals;
- first-class deterministic QA, QA-agent evaluation, seeded-defect oracle, and
  human evaluation records.

The guard rejects confidence-only report fields, unresolved system/provider/
finding references, mismatched cost totals, mismatched finding count buckets,
unknown unadjudicated root causes on adjudicated findings, missing prompt preset
identity, and unscored QA-agent metric shapes. Every `llm_qa` provider run and
`llm_qa` finding must be covered by at least one QA-agent evaluation with the
same `evaluatedSystemId`; global QA-agent coverage across other systems is not
valid benchmark evidence. It does not make quality claims: public wording still
depends on `docs/quality-claims.md` and review scope.

## Binding Authority

Per ADR 0001, the TypeScript source in `src/index.ts` is the hand-edited
contract authority. JSON Schema artifacts and Rust serde structs are downstream
bindings that must validate against the same versioned fixtures; generated
outputs should not be patched directly.

The Rust compatibility scope for SHARED-010 is the full manifest-driven fixture
suite in `kaifuu-core::contracts`. It keeps `BridgeBundleV02::validate_json` for
the bridge serde contract and adds Rust semantic validators for asset policy,
benchmark, patch export/result, delta metadata, runtime evidence, standalone
finding, contract manifest/report, and permission/local-user fixtures.
