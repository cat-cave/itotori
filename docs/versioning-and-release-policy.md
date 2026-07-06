# Versioning and Release Policy

> Single source of truth for the **product version** of the itotori suite, the
> meaning of SEMVER across the publishable surface, and the relation between
> the product version and the format-level `schemaVersion` markers carried by
> every shipped artifact.

## The product version

The product version is the human-facing SEMVER of the itotori product as a
whole — the version a user sees from `itotori --version`, the version stamped
into release notes, and the version under which the public formats evolve.

**Source of truth:** `ITOTORI_PRODUCT_VERSION` in
[`packages/localization-bridge-schema/src/product-version.ts`](../packages/localization-bridge-schema/src/product-version.ts).

This constant lives in the shared contract package (the workspace leaf every
shippable app and package depends on) so that the CLI and the publishable
contracts reference **one** value. The CLI reports it verbatim:

```sh
itotori --version   # itotori <ITOTORI_PRODUCT_VERSION>
itotori -v          # alias
```

The current product version is **`0.1.0`** — the first real SEMVER cut.
Previously every `package.json` in the monorepo carried `0.0.0` with no release
policy; `0.1.0` replaces that non-version with an explicit, documented starting
point.

### Determinism

`ITOTORI_PRODUCT_VERSION` is a **source literal**. It is never derived at build
time from git state, wall-clock time, the environment, or the host. Any
checkout of a given commit therefore builds and reports exactly the same
version. The CLI test
[`apps/itotori/test/version.test.ts`](../apps/itotori/test/version.test.ts)
pins the reported value and regression-fails on a `0.0.0` rollback.

### Product version vs. internal package churn

Internal workspace packages (`@itotori/db`, `@itotori/localization-bridge-schema`,
`@itotori/app`, `@itotori/spec-dag-dashboard`, `@itotori/runtime-web-review`)
intentionally stay at `0.0.0` and are all `private: true` — they are **not
published** and their churn does not bump anything user-facing. The product
version is the single visible number; it moves when the **publishable surface**
moves, not on every internal refactor.

## What SEMVER means here

While the product version is `0.x.y` (pre-1.0):

- **Patch (`0.x.PATCH`):** backwards-compatible fixes — bug fixes, validator
  strictness tightenings that reject previously-invalid input, doc/test
  changes. No new required fields on any public artifact; no new enum values a
  strict consumer must handle.
- **Minor (`0.MINOR.0`):** anything compatible for existing artifacts plus new
  optional surface — new optional artifact fields, new enum values consumers
  may ignore, new CLI subcommands. Pre-1.0, incompatible changes to the public
  formats may also ride a minor bump (with a note in the release); pin to a
  specific format `schemaVersion` if you need stability.
- **Major (`1.0.0`):** the public formats are declared stable. From that point
  on, any incompatible change to a public artifact requires a major bump and a
  migration.

Internal package churn, refactors, and infrastructure-only changes do **not**
bump the product version.

## The publishable surface

The surface governed by this policy is:

1. **The itotori CLI** — `itotori --version` reports `ITOTORI_PRODUCT_VERSION`.
   The CLI is the primary product entry point.
2. **The bridge bundle** — `BridgeBundle` / `BridgeBundleV02` in
   [`packages/localization-bridge-schema/src/index.ts`](../packages/localization-bridge-schema/src/index.ts),
   with `schemaVersion: "0.1.0"` / `"0.2.0"`.
3. **The patch-export / delta format** — `PatchExportBundle` (`PATCH_EXPORT_BUNDLE_SCHEMA_VERSION = "itotori.patch-export-bundle.v2"`)
   and the `.kaifuu` delta package it produces.
4. **The API contract** — the `*.schemaVersion` literals pinned in
   [`apps/itotori/src/api-schema.ts`](../apps/itotori/src/api-schema.ts)
   (`reviewer.queue_dashboard.v0.1`, `workspace.*.v0.1`, etc.).

Every artifact on this surface carries a literal `schemaVersion` that strict
validators assert verbatim.

## Relation to the format-level `schemaVersion` markers

The product version and the per-format `schemaVersion` markers are **distinct
axes**, by design:

- The **product version** (`ITOTORI_PRODUCT_VERSION`) describes the whole
  product at a point in time and is what users see.
- A **`schemaVersion` marker** describes the wire shape of one specific
  artifact (e.g. `itotori.patch-export-bundle.v2`, `bridge v0.2`). It changes
  only when that artifact's shape changes, independent of the product cadence.

Rules:

- A format `schemaVersion` bump is a **subset** of a product release: every
  public-format change is released under a product version, but a product
  release may carry zero format changes.
- A `schemaVersion` marker only ever moves **in a direction the policy allows**
  (additive on a minor, breaking on a major / pre-1.0 minor). No-legacy-compat
  gates (e.g. the pair-policy `v0.3` parser rejecting `v0.1` / `v0.2` literals)
  are how the contract enforces this on read.
- The product version is the umbrella under which a coherent set of
  `schemaVersion` markers ship together; a release note names both the product
  version and any format markers that moved.

## Cutting a release

1. Bump `ITOTORI_PRODUCT_VERSION` in
   `packages/localization-bridge-schema/src/product-version.ts` per the SEMVER
   rules above.
2. If a public format shape changed, bump that format's `schemaVersion`
   constant and update its validator + fixtures + the cross-language
   compatibility report (`packages/localization-bridge-schema/test/examples/contract-compatibility-v0.2.json`).
3. Update the CLI version test only if pinning a new literal; the test asserts
   the version is a real SEMVER and not `0.0.0`, so a routine bump passes
   without edit.
4. Note the product version, any moved `schemaVersion` markers, and any
   no-legacy-compat removals in the release notes.
