# Localization Bridge Schema

Neutral JSON-compatible contracts shared by Itotori, Kaifuu, and Utsushi.

The bridge package is intentionally independent from any one subproject. Kaifuu emits and consumes patchable bridge data, Itotori localizes and evaluates it, and Utsushi emits runtime evidence linked back to bridge units.

## Versions

- `0.1.0` remains the fixture hello-world contract exported as `BridgeBundle`,
  `PatchExport`, `RuntimeVerificationReport`, and their existing guards.
- `0.2.0` adds the bridge domain model exported as `BridgeBundleV02`,
  enum-backed category lists, bundle-level asset reference integrity, and
  `assertBridgeBundleV02`.

`PolicyRecordV02.scope` is a known surface category, not freeform text. Use a
value from the exported `POLICY_SCOPES` list, which currently mirrors
`SURFACE_KINDS`.

The v0.2 JSON example lives at `test/examples/bridge-v0.2.json`. Migration notes
from v0.1 are in `MIGRATING-0.2.md`.

## Binding Authority

Per ADR 0001, the TypeScript source in `src/index.ts` is the hand-edited
contract authority. JSON Schema artifacts and Rust serde structs are downstream
bindings that must validate against the same versioned fixtures; generated
outputs should not be patched directly.
