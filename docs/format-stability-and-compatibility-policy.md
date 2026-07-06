# Format Stability and Compatibility Policy

> **Beta definition (2026-07-06).** Closes spec-DAG node
> `[[beta-schema-stability-policy]]` (Beta user-install-readiness epic), as a
> sibling to `[[beta-semver-versioning-and-release-policy]]`. The product
> SEMVER and the publishable surface are documented in
> [versioning-and-release-policy.md](versioning-and-release-policy.md); this
> doc adds the THIRD axis — a per-format **stability tier** — and the
> backward-compatibility / version-negotiation rules a user relies on so that
> an in-progress localization survives a tool update (or fails loudly with a
> migration path) instead of silently breaking.

Single source of truth for the **stability tier** each public format occupies,
the **backward-compatibility policy** that governs how a `schemaVersion`
marker may move, and the **version-negotiation** a loader performs on read.

**Source of truth:** `PUBLIC_FORMAT_STABILITY` in
[`packages/localization-bridge-schema/src/format-stability.ts`](../packages/localization-bridge-schema/src/format-stability.ts).
The product version (`ITOTORI_PRODUCT_VERSION`) and the publishable surface
are defined in
[`product-version.ts`](../packages/localization-bridge-schema/src/product-version.ts);
this policy governs how a format within that surface evolves and how a
version mismatch is surfaced to a user.

## The three axes

1. **Product version** (`ITOTORI_PRODUCT_VERSION`, currently `0.1.0`) — the
   whole product at a point in time; what `itotori --version` reports.
2. **Per-format `schemaVersion` marker** — the wire shape of one specific
   artifact (e.g. bridge `"0.2.0"`, `.kaifuu` `"0.3.0"`). Moves independently
   of the product cadence.
3. **Per-format stability tier** (this doc) — the compatibility promise a
   format makes: how its readers react to a version mismatch. The tier ladder
   is monotone (`experimental → beta → stable`); a format moves up as the
   product matures and never backwards without a product major bump.

## Stability tiers

- **`experimental`** — the format may change incompatibly at any time, even on
  a patch. No migration path is promised. A loader MAY accept these
  best-effort but must warn. Reserved for in-flight research formats that have
  not been promoted onto the publishable surface.
- **`beta`** — the format is stable within a single product MINOR. Readers pin
  exactly one `schemaVersion` literal (no-legacy-compat); a version mismatch
  is a typed `FormatVersionMismatchError` carrying a migration path, raised on
  load BEFORE any filesystem or state work. A user's in-progress localization
  survives a tool update by following the migration path (regenerate the
  artifact with the current tool), or fails LOUDLY with a documented remedy.
  **Every publishable-surface format is `beta` while the product version is
  `0.x`.**
- **`stable`** — reserved for the post-`1.0.0` public formats. Only additive,
  optional changes are permitted; an incompatible change requires a new
  `schemaVersion` AND a product major bump. On load, a `stable` reader accepts
  its declared literal and rejects everything else with the same typed
  migration-path error.

## Backward-compatibility and upgrade policy

The rule a beta user relies on:

> A public-format artifact either loads under the current tool, or the loader
> fails LOUDLY with a typed `FormatVersionMismatchError` naming the format, the
> observed and supported literals, and a migration path. The one outcome that
> is NEVER acceptable is a silent break — a prior-version artifact being
> mis-parsed, truncated, or half-applied.

Mechanism:

- **No-legacy-compat on read.** Each reader pins exactly one `schemaVersion`
  literal and rejects every other literal at the top of the guard, before any
  structural work. The pair-policy `v0.3` parser
  ([`packages/localization-bridge-schema/src/pair-policy.v0.3.ts`](../packages/localization-bridge-schema/src/pair-policy.v0.3.ts))
  was the canonical precedent; the bridge and delta readers now route through
  the shared `assertFormatVersion` for the same shape.
- **Typed migration-path error.** A mismatch raises
  `FormatVersionMismatchError` (not a bare `Error`) carrying `formatId`,
  `observed`, `supported`, `stabilityTier`, `knownLegacyVersions`, and
  `migrationPath`. A wrapping CLI surfaces these directly.
- **Known-legacy vs unknown (newer-tool) mismatches.** Each declaration
  enumerates its `knownLegacyVersions`; the error distinguishes "this file is
  from an older tool — follow the migration path" from "this file is from a
  newer tool — upgrade itotori".
- **Forward-only formats.** Migrations and the `.kaifuu` apply path are
  forward-only by design; there is no rollback path. A version mismatch on
  load is the loud failure that prevents a partial / silent rollback.
- **Product version is the umbrella.** A release note names the product
  version plus any `schemaVersion` markers that moved, plus any
  no-legacy-compat removals (see [versioning-and-release-policy.md](versioning-and-release-policy.md)
  §"Cutting a release").

## Per-format tier assignments

The registry `PUBLIC_FORMAT_STABILITY` is the source of truth; this table is
its human rendering. `since` is the product version under which the current
`schemaVersion` + `stabilityTier` combination became authoritative.

| Format                                                          | `schemaVersion`               | Tier   | Known legacy                                                         | since   |
| --------------------------------------------------------------- | ----------------------------- | ------ | -------------------------------------------------------------------- | ------- |
| **localization-bridge-schema** (bridge bundle + delta metadata) | `0.2.0`                       | `beta` | `0.1.0`                                                              | `0.1.0` |
| **kaifuu-delta-package** (`.kaifuu` engine delta)               | `0.3.0`                       | `beta` | `0.2.0`                                                              | `0.1.0` |
| **pair-policy** (agentic-loop pair selection)                   | `itotori.pair-policy.v0.3`    | `beta` | `0.1`, `itotori.pair-policy.v0.1`, `0.2`, `itotori.pair-policy.v0.2` | `0.1.0` |
| **itotori-api-contract** (dashboard/SPA REST surface)           | `*.v0.1` (per-route literals) | `beta` | —                                                                    | `0.1.0` |
| **itotori-db-schema** (Postgres schema + migration registry)    | `0057` (migration head)       | `beta` | —                                                                    | `0.1.0` |

### localization-bridge-schema

- **Authority:** [`packages/localization-bridge-schema/src/index.ts`](../packages/localization-bridge-schema/src/index.ts).
- **Version-negotiation:** `assertBridgeBundleV02` and
  `assertDeltaPackageMetadataV02` call `assertFormatVersion(BRIDGE_FORMAT_STABILITY, …)`
  as their first check. A v0.1 bundle raises `FormatVersionMismatchError` with
  the migration path before any field-level validation. The legacy v0.1 reader
  `assertBridgeBundle` remains available ONLY for the hello-world fixture
  pipeline; production paths route through the v0.2 guard.
- **Migration path (v0.1 → v0.2):** regenerate the bridge bundle with a
  v0.2-capable extractor (kaifuu `>= product 0.1.0`); the field mapping lives
  in
  [`packages/localization-bridge-schema/MIGRATING-0.2.md`](../packages/localization-bridge-schema/MIGRATING-0.2.md).
- **Cross-version pin:** [`packages/localization-bridge-schema/test/cross-version-compatibility.test.ts`](../packages/localization-bridge-schema/test/cross-version-compatibility.test.ts).

### kaifuu-delta-package

- **Authority:** [`crates/kaifuu-delta/src/lib.rs`](../crates/kaifuu-delta/src/lib.rs).
- **Version-negotiation:** `validate_package_shape` rejects any package whose
  `schemaVersion != "0.3.0"` (or whose `format != "kaifuu-delta-package"`)
  before any filesystem work, as the string error
  `unsupported delta schema version <observed>`. The v0.2.0 loader was deleted
  in KAIFUU-238 (no-legacy-compat): there is no compatibility shim for
  packages without the `sourceProvenance` envelope.
- **Migration path (v0.2 → v0.3):** re-run `kaifuu diff` with the current tool
  to emit a `0.3.0` package (the new envelope carries the `partial` bit
  forward so apply can refuse partial-source packages).
- **Hash version is a SEPARATE axis:** `DELTA_HASH_VERSION` (currently
  `kaifuu-delta-root-v0.2`) is the domain-separation tag on the root-hash
  manifest; it moves independently of `DELTA_SCHEMA_VERSION`.

### pair-policy

- **Authority:** [`packages/localization-bridge-schema/src/pair-policy.v0.3.ts`](../packages/localization-bridge-schema/src/pair-policy.v0.3.ts).
- **Version-negotiation:** `parsePairPolicyV03` enumerates
  `KNOWN_LEGACY_PAIR_POLICY_VERSIONS` and rejects each (and an absent field)
  with `PairPolicyVersionMismatchError`. This was the canonical no-legacy-
  compat precedent that the shared `FormatVersionMismatchError` generalizes.
- **Migration path (v0.x → v0.3):** rewrite the file to the v0.3 shape — a
  single primary `(modelId, providerId)` pair plus per-stage postures;
  resilience is OpenRouter-side (`provider.order` + `allow_fallbacks` within
  the ZDR allow-list), so the legacy `alternateProviders[]` /
  `failoverPredicate` machinery was removed.

### itotori-api-contract

- **Authority:** [`apps/itotori/src/api-schema.ts`](../apps/itotori/src/api-schema.ts).
- **Version-negotiation:** there is no single umbrella literal — each read
  model carries its own `*.v0.1` `schemaVersion`, asserted verbatim by
  `assertItotoriApiResponse` on BOTH the server (before sending, in `ok()`)
  and the SPA (before rendering). A server emitting `workspace.project_browse.v0.2`
  against a `v0.1` client fails hard on both sides. Mutation routes are
  further pinned by the enumerated `apiMutationContract` drift suite
  ([`apps/itotori/test/msw-mutation-handlers.test.ts`](../apps/itotori/test/msw-mutation-handlers.test.ts),
  ITOTORI-051).
- **Migration path:** a version mismatch is a hard reject; redeploy the server
  and the SPA from the same product version. The strict-record helper
  (`asStrictRecord`) makes adding a server-side field without updating the
  schema a detected breaking change.

### itotori-db-schema

- **Authority:** [`packages/itotori-db/src/migrations.ts`](../packages/itotori-db/src/migrations.ts).
- **Version-negotiation:** the applied-migration-id set in
  `itotori_schema_migrations` IS the version; `itotori db-migrate` applies the
  forward-only registry up to the head. The checksum-immutability guard
  rejects any edit to an applied migration as `migration ${id} checksum
mismatch` — there is no rollback path, by design. The registry-parity test
  pins that every `.sql` file is registered and prefixes are strictly
  increasing.
- **Migration path:** run `itotori db-migrate`. A newer tool with migrations
  the database lacks applies them; an edited applied migration fails loudly.

## Relation to ADR 0001

[ADR 0001](adrs/0001-contract-source-of-truth.md) §"Versioning Rules"
established: every wire payload carries `schemaVersion`; additive fields
require old-and-new-reader fixtures when backward compatibility is promised;
renames / enum-meaning changes / deletions / identity-semantics changes
require a new schema version and migration notes. This policy is the
enforcement layer for those rules — the `FormatVersionMismatchError` is the
typed diagnostic ADR 0001's "require a migration note" clause produces on a
mismatched read.

## Verifying locally

The stability registry, the version-negotiation entry points, and the
cross-version pin are all covered by the bridge-schema package's test suite
(no network, no database):

```sh
pnpm --filter @itotori/localization-bridge-schema test -- --run \
  format-stability cross-version-compatibility schema pair-policy
pnpm --filter @itotori/localization-bridge-schema typecheck
```

The cross-language (TS ↔ Rust) contract fixture suite and the
`just contract-validate` gate live under a separate axis — see
[shared-contract-compatibility.md](shared-contract-compatibility.md).
