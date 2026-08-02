# Regenerating Bridge Bundles From 0.1.0 To 0.2.0

Bridge schema `0.2.0` is a versioned expansion, not an in-place mutation of
the historical `0.1.0` contract. Current readers accept exactly v0.2 and reject
v0.1 with `FormatVersionMismatchError` before interpreting fields or causing a
persisted effect. There is no public v0.1 reader, converter, or compatibility
shim.

The supported upgrade is authoritative-source regeneration: run a current
extractor against the original game source with its real extraction profile,
emit `BridgeBundleV02`, and validate it with `assertBridgeBundleV02` before
import. Do not manufacture v0.2 identities, provenance, hashes, asset
inventory, or runtime expectations from a v0.1 JSON document; that document
does not contain enough authority to derive them truthfully.

## Authority

The hand-edited TypeScript source in `src/index.ts` is the contract authority
for v0.2. JSON Schema artifacts and Rust serde structs are downstream bindings:
they must be generated from, or manually kept in sync with, the TypeScript
schema package and validated against the same versioned fixtures. Generated
artifacts should carry generated-file headers and must not become the semantic
source of truth.

Until a repository generator is selected, the v0.2 binding authority consists
of:

- `src/index.ts` exported v0.2 types, enum lists, and runtime guard.
- `test/examples/bridge-v0.2.json` as the JSON compatibility example.
- Schema package tests that validate positive and negative v0.2 payloads.

## Regeneration Procedure

1. Locate the original game source and the extraction-profile revision that
   define the intended inventory. A v0.1 JSON artifact is not an authoritative
   substitute for either input.
2. Run a v0.2-capable Kaifuu extractor against those inputs. The extractor must
   derive source-unit and asset identities, hashes, provenance, protected-span
   semantics, and runtime expectations from the source.
3. Validate the newly emitted artifact with `assertBridgeBundleV02`. Any
   version other than exact `0.2.0`, including historical `0.1.0`, is a typed
   refusal.
4. Import only the validated v0.2 artifact. Preserve the historical artifact
   separately if an audit trail requires it; do not rewrite it in place.

The v0.2 shape includes required facts that v0.1 never recorded, including
`sourceGame`, `sourceBundleRevision`, `hashStrategy`, asset inventory,
`surfaceId`, per-unit source revision, structured speaker context, and runtime
expectations. Any generic field-mapping converter would have to guess those
facts, so none is supported.

## Speaker Unknown States

Do not collapse unknown speakers into a single string or boolean.

- `parser_unknown`: Kaifuu could not determine a speaker identity from source
  data. This is an extraction uncertainty.
- `reader_unknown`: the source intentionally hides the speaker from the player,
  while the parser may still know a stable identity. This is narrative state
  and must survive localization.
- `known`: the parser knows the speaker and the reader-visible name is not
  intentionally concealed.
- `not_applicable`: narration or metadata has no speaker.

## Compatibility Notes

- Historical v0.1 payloads are useful only as rejection/regeneration fixtures;
  current product readers do not accept them.
- v0.2 hashes use canonical lowercase `sha256:` strings plus `hashStrategy` to
  name the algorithm, normalization, and source scope. The current source-unit
  text strategy is `utf8-lf-json-stable-v1` with explicit source fields;
  the source-asset strategy uses `bytes` so binary asset hashing is not
  confused with text normalization.
- v0.2 patch exports carry source game/profile, source bundle revision, and
  per-entry source hash/revision metadata. Patch application compatibility is
  decided by `sourceUnitKey`, the current `bridgeUnitId` selected for that
  source unit, and unit-level `sourceHash`. A bundle hash change must be
  reported for traceability, but it must not invalidate unchanged units whose
  unit hash still matches.
- For `preserveMode: "map"` spans, `protectedSpanMappings[]` can carry optional
  `sourceSpanId` and/or paired `sourceStartByte`/`sourceEndByte` coordinates so
  reordered or duplicate raw spans are matched by source identity and explicit
  target byte range, not source span order. Raw-only mappings remain a valid
  v0.2 shape when their raw occurrence is unambiguous. A supplied
  `sourceSpanId` names exactly one source span, so reusing it within an entry is
  rejected with `kaifuu.patch_export.duplicate_source_span_identity`. Two
  mappings with the same `raw` need distinct source identities and explicit
  target ranges.
- `evaluatePatchExportCompatibilityV02` returns compatible and incompatible
  unit lists. `source_hash_mismatch` includes both expected and actual source
  hashes so stale patches cannot pass silently. `bridge_unit_id_mismatch`
  includes `actualBridgeUnitId` so a patch entry cannot pass by source key and
  hash while naming another bridge unit.
- `PatchResultV02.status: "incompatible_source"` requires a
  `sourceCompatibility` report. Use it when patch application rejects or skips
  stale entries.
- `DeltaPackageMetadataV02` traces delta packages to the source bridge, source
  game/profile revision, source bundle revision, generated patch export id/hash,
  target locale, and hash strategy.
- v0.2 rejects non-UUID7 ids for bridge, asset, unit, surface, span, source
  revision, choice, route, speaker, policy, and locale branch ids.
- v0.2 rejects unknown category strings for known enums such as surface kinds,
  asset kinds, span kinds, policy actions, policy record kinds, patch write
  modes, runtime expectations, UI areas, database kinds, metadata scopes, and
  image replacement modes. Policy record `scope` is also enum-backed and uses
  the exported `POLICY_SCOPES` list.
- v0.2 examples are intentionally locale-neutral and use `fr-FR` as the target
  locale to avoid baking a JP-to-EN assumption into the shared contract.
- `AssetPolicyBundleV02` is a separate v0.2 payload for branch-scoped
  non-dialogue asset decisions. It references source assets and source
  revisions but does not mutate `BridgeBundleV02`; consumers should treat
  `metadata_only` asset policy records as metadata-first decisions, not as
  completed OCR, image redraw, video editing, or runtime visual validation.
