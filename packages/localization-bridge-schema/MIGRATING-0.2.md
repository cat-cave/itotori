# Migrating Bridge Bundles From 0.1.0 To 0.2.0

Bridge schema `0.2.0` is a versioned expansion, not an in-place mutation of
the fixture-only `0.1.0` contract. The existing `BridgeBundle`,
`PatchExport`, `RuntimeVerificationReport`, and v0.1 guard exports remain for
the hello-world pipeline. New bridge inventory producers should emit
`BridgeBundleV02` and validate with `assertBridgeBundleV02`.

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

## Field Mapping

| 0.1.0 field                                      | 0.2.0 field                            | Migration note                                                                                                       |
| ------------------------------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion: "0.1.0"`                         | `schemaVersion: "0.2.0"`               | Versioned readers must dispatch explicitly.                                                                          |
| `bridgeId`                                       | `bridgeId`                             | Must be a valid UUID7 string.                                                                                        |
| none                                             | `sourceGame`                           | Identifies the source game version and extraction profile revision used for this bundle.                             |
| `sourceBundleHash`                               | `sourceBundleHash`                     | Must be a canonical lowercase `sha256:` hash with a 64-hex SHA-256 digest.                                           |
| none                                             | `sourceBundleRevision`                 | Mirrors the bundle content hash when `revisionKind` is `content_hash`; delta metadata traces back to this revision.  |
| none                                             | `hashStrategy`                         | Declares per-scope hash rules for source profile, bundle, asset, unit, patch export, and delta package hashes.       |
| `extractorName`, `extractorVersion`              | `extractor.name`, `extractor.version`  | Removes fixture-specific extractor naming from the shared shape.                                                     |
| none                                             | `assets[]`                             | Assets are first-class and carry UUID7 ids, neutral `assetKind`, source hash, and `sourceRevision`.                  |
| `units[].bridgeUnitId`                           | `units[].bridgeUnitId`                 | Must be a valid UUID7 string.                                                                                        |
| none                                             | `units[].surfaceId`                    | Stable UUID7 id for the reviewable surface.                                                                          |
| `units[].textSurface`                            | `units[].surfaceKind`                  | Uses the v0.2 `SURFACE_KINDS` enum. `dialogue` and `narration` are distinct.                                         |
| `units[].speaker?: string`                       | `units[].speaker?: SpeakerContextV02`  | Raw speaker strings are invalid. Use `known`, `parser_unknown`, `reader_unknown`, or `not_applicable`.               |
| `units[].protectedSpans[]`                       | `units[].spans[]`                      | Uses `spanKind`, UUID7 `spanId`, UTF-8 `startByte`/`endByte`, and enum `preserveMode`.                               |
| `protectedSpans[].start`, `protectedSpans[].end` | `spans[].startByte`, `spans[].endByte` | Offsets are UTF-8 byte offsets into `sourceText`, half-open `[startByte, endByte)`.                                  |
| none                                             | `units[].sourceRevision`               | Required for stale patch/export rejection.                                                                           |
| `patchRef.assetId: string`                       | `patchRef.assetId: UUID7`              | References a bridge asset, not an engine-private path.                                                               |
| `patchRef.writeMode`                             | `patchRef.writeMode`                   | Uses `PATCH_WRITE_MODES`, including asset and metadata write modes.                                                  |
| none                                             | `units[].context`                      | Holds route, choice, UI, tutorial, database, song, image text, metadata, and speaker-name context.                   |
| none                                             | `units[].runtimeExpectation`           | Tells Utsushi whether to trace text, probe layout, inspect a screenshot region, or treat a surface as metadata-only. |
| none                                             | `policyRecords[]`                      | Locale-scoped romanization and do-not-translate decisions use enum-backed policy categories.                         |
| none                                             | `policyRecords[].scope`                | Optional surface-category scope from `POLICY_SCOPES`; use `targetLocale` or `localeBranchId` for locale scope.       |

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

- v0.1 hello-world payloads should keep using the existing v0.1 guard until the
  Kaifuu, Itotori, and Utsushi fixture pipeline is intentionally versioned.
- v0.2 hashes use canonical lowercase `sha256:` strings plus `hashStrategy` to
  name the algorithm, normalization, and source scope. The current source-unit
  text strategy is `utf8-nfc-lf-json-stable-v1` with explicit source fields;
  the source-asset strategy uses `bytes` so binary asset hashing is not
  confused with text normalization.
- v0.2 patch exports carry source game/profile, source bundle revision, and
  per-entry source hash/revision metadata. Patch application compatibility is
  decided by `sourceUnitKey` plus unit-level `sourceHash`. A bundle hash change
  must be reported for traceability, but it must not invalidate unchanged units
  whose unit hash still matches.
- `evaluatePatchExportCompatibilityV02` returns compatible and incompatible
  unit lists. `source_hash_mismatch` includes both expected and actual source
  hashes so stale patches cannot pass silently.
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
