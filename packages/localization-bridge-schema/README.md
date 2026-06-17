# Localization Bridge Schema

Neutral JSON-compatible contracts shared by Itotori, Kaifuu, and Utsushi.

The bridge package is intentionally independent from any one subproject. Kaifuu emits and consumes patchable bridge data, Itotori localizes and evaluates it, and Utsushi emits runtime evidence linked back to bridge units.

## Versions

- `0.1.0` remains the fixture hello-world contract exported as `BridgeBundle`,
  `PatchExport`, `RuntimeVerificationReport`, and their existing guards.
- `0.2.0` adds the bridge domain model exported as `BridgeBundleV02`,
  enum-backed category lists, bundle-level asset reference integrity, source
  game/profile revision identity, hash strategy metadata, v0.2 patch
  export/result/delta metadata, and runtime guards.

`PolicyRecordV02.scope` is a known surface category, not freeform text. Use a
value from the exported `POLICY_SCOPES` list, which currently mirrors
`SURFACE_KINDS`.

The v0.2 JSON example lives at `test/examples/bridge-v0.2.json`. Migration notes
from v0.1 are in `MIGRATING-0.2.md`.

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

## Binding Authority

Per ADR 0001, the TypeScript source in `src/index.ts` is the hand-edited
contract authority. JSON Schema artifacts and Rust serde structs are downstream
bindings that must validate against the same versioned fixtures; generated
outputs should not be patched directly.
