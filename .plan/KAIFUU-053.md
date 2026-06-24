# KAIFUU-053 — Capability-leveled engine detector registry

- **Branch**: `spec/kaifuu-053`
- **Worktree**: `/scratch/worktrees/itotori-spec-kaifuu-053`
- **Node**: KAIFUU-053
- **Scope**: Shared engine-fingerprint registry that reports identify / inventory / extract / patch levels per adapter. Recognition no longer implies usability. Cross-cutting: Rust core + TS schema + DB.
- **Worker scoping**: one worker, cross-cutting (Rust + TS + DB). The work is sequential (Rust contract first → TS mirror → DB schema → consumer wiring) and cannot be safely split without drift.

## Context

`crates/kaifuu-core/src/lib.rs` already defines `EngineAdapter`, `AdapterRegistry`,
`Capability` (~15 granular variants), `CapabilityStatus` (Supported / Limited /
Unsupported / RequiresUserInput), `CapabilityReport`, and `AdapterCapabilities`
(`reports: Vec<CapabilityReport>`). KAIFUU-172/173/174 (RealLive) and the Siglus
/ XP3 fixture detectors already emit `AdapterCapabilities`. The auditFocus is
that the current shape mixes operational granularity with detection level and
lets consumers infer "identified == usable". KAIFUU-053 layers a typed
**capability level** (a 4-rung ladder) on top of the existing per-capability
reports and exposes a registry query API so consumers must opt in to a level.

## Acceptance criteria mapping

1. Shared engine-fingerprint registry reports identify / inventory / extract /
   patch levels per adapter — `AdapterRegistry::level_for(adapter_id, level)`
   and `AdapterRegistry::adapters_supporting(level)` in `kaifuu-core`.
2. Recognition (identify) does NOT imply usability — registry returns
   `CapabilityLevel::Identify` only by default for newly-detected adapters; the
   higher rungs require explicit `Supported` status on the capability matrix.
3. Itotori-side consumer can distinguish supported vs identify-only —
   `apps/itotori/src/services` consumes the typed report; dashboard /
   CLI surfaces show "Identified only" badge for identify-only engines.
4. TS + Rust + DB schema mirror —
   `packages/localization-bridge-schema/src/index.ts` adds `CapabilityLevel`,
   `CapabilityLevelStatus`, `AdapterCapabilityMatrix`; DB migration adds an
   `engine_capability_reports` table whose enum columns mirror the Rust types.

## Crate placement and module layout

Extend `crates/kaifuu-core/src/lib.rs` with a new submodule
`crates/kaifuu-core/src/registry/mod.rs` plus `registry/capability.rs`:

- `registry/capability.rs` — `CapabilityLevel`, `CapabilityLevelStatus`,
  `AdapterCapabilityMatrix` (the 4-level matrix), `CapabilityLevelQuery`.
- `registry/mod.rs` — extends `AdapterRegistry` with typed-level queries that
  build on the existing `EngineAdapter::capabilities()` trait method.

Keep the existing `Capability` enum and `CapabilityReport` — the 4-level matrix
is derived from (or declared alongside) the per-capability reports; it does not
replace them. This avoids breaking the 5+ detectors that already emit reports
and keeps KAIFUU-001 / KAIFUU-006 contracts intact.

## Types (Rust)

```rust
// crates/kaifuu-core/src/registry/capability.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityLevel {
    Identify,
    Inventory,
    Extract,
    Patch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CapabilityLevelStatus {
    Supported,
    Partial { limitations: Vec<String> },
    Unsupported { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdapterCapabilityMatrix {
    pub adapter_id: String,
    pub identify: CapabilityLevelStatus,
    pub inventory: CapabilityLevelStatus,
    pub extract: CapabilityLevelStatus,
    pub patch: CapabilityLevelStatus,
}
```

`AdapterCapabilityMatrix::get(level)` returns the typed status. Helper
constructors: `identify_only(adapter_id, reason)`, `up_to(level)` for tests.

`AdapterCapabilities` (existing) gains:

```rust
pub struct AdapterCapabilities {
    // existing fields preserved (reports, access_contract, …)
    pub level_matrix: AdapterCapabilityMatrix,
}
```

Add a derivation helper `AdapterCapabilityMatrix::derive_from_reports(&[CapabilityReport]) -> Self`
mapping the existing granular `Capability` variants to the 4 rungs:

- Identify ← `Capability::Detection`
- Inventory ← `Capability::AssetListing` + `AssetInventory`
- Extract ← `Capability::Extraction` (and the layered-access content
  capabilities the access contract already gates)
- Patch ← `Capability::Patching` / `LineParityPatching` / `AssetTextPatching` /
  `DeltaPatching`

`derive_from_reports` is convenience-only; adapters MUST explicitly set
`level_matrix` so identify-only engines can never accidentally bubble up to
Patch from a granular report drift.

## Registry trait additions

```rust
impl AdapterRegistry {
    pub fn level_for(&self, adapter_id: &str, level: CapabilityLevel)
        -> Option<&CapabilityLevelStatus>;
    pub fn adapters_supporting(&self, level: CapabilityLevel)
        -> Vec<&dyn EngineAdapter>;
    pub fn matrices(&self) -> Vec<&AdapterCapabilityMatrix>;
}
```

`adapters_supporting(level)` returns adapters whose status at that rung is
`Supported` only (not Partial, not Unsupported). A separate
`adapters_at_least(level)` may be added if needed but the constraint is strict
by default — that is the whole point of KAIFUU-053.

## Existing detector migration

Update each detector's `capabilities()` to populate `level_matrix` explicitly:

- `crates/kaifuu-engine-fixture/src/lib.rs` — fixture (the main detector at
  `:1194`). Identify Supported, Inventory Supported, Extract Supported, Patch
  Partial (line-parity only).
- `crates/kaifuu-engine-fixture/src/lib.rs` — XP3 detector. Identify Supported;
  Inventory/Extract derived from current reports; Patch Unsupported with reason
  pointing at KAIFUU-XP3 patch backlog.
- `crates/kaifuu-engine-fixture/src/lib.rs` — Siglus detector. Identify
  Supported; higher rungs Unsupported with reason.
- `crates/kaifuu-reallive/src/lib.rs` — RealLive adapter (KAIFUU-172). Identify
  Supported, Inventory Supported (KAIFUU-174 text inventory), Extract Partial
  (Scene parser KAIFUU-173 covers text but not all asset surfaces), Patch
  Unsupported (no patch path yet).
- `crates/kaifuu-vault-source/src/` — NOT an `EngineAdapter`; out of scope per
  hard constraints (called out explicitly in "Out of scope").

Each detector keeps its existing per-`Capability` reports; the new
`level_matrix` is declared alongside them. The fixture detector at
`crates/kaifuu-engine-fixture/src/lib.rs:1194` becomes the reference example.

## TS mirror

Extend `packages/localization-bridge-schema/src/index.ts`:

```ts
export const CapabilityLevel = z.enum(["identify", "inventory", "extract", "patch"]);
export const CapabilityLevelStatus = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("supported") }),
  z.object({ kind: z.literal("partial"), limitations: z.array(z.string()) }),
  z.object({ kind: z.literal("unsupported"), reason: z.string() }),
]);
export const AdapterCapabilityMatrix = z.object({
  adapterId: z.string(),
  identify: CapabilityLevelStatus,
  inventory: CapabilityLevelStatus,
  extract: CapabilityLevelStatus,
  patch: CapabilityLevelStatus,
});
```

Bump the shared schema version if/where the bridge already tracks one (check
the existing `BRIDGE_SCHEMA_VERSION_V02` constant in
`crates/kaifuu-core/src/contracts.rs`); the new structures attach to the
existing v0.2 surface as additive fields, so a minor version bump is sufficient
— no breaking change.

## DB persistence

New migration: `packages/itotori-db/migrations/0017_engine_capability_reports.sql`
(use the next free index at implementation time; current head is 0016+).

```sql
CREATE TYPE capability_level_enum AS ENUM ('identify','inventory','extract','patch');
CREATE TYPE capability_level_status_kind AS ENUM ('supported','partial','unsupported');

CREATE TABLE engine_capability_reports (
  id              UUID PRIMARY KEY,
  adapter_id      TEXT NOT NULL,
  level           capability_level_enum NOT NULL,
  status_kind     capability_level_status_kind NOT NULL,
  limitations     JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason          TEXT,
  reported_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (adapter_id, level),
  CHECK (
    (status_kind = 'supported'   AND reason IS NULL AND limitations = '[]'::jsonb)
    OR (status_kind = 'partial'  AND reason IS NULL AND jsonb_typeof(limitations) = 'array' AND jsonb_array_length(limitations) > 0)
    OR (status_kind = 'unsupported' AND reason IS NOT NULL)
  )
);
```

The CHECK constraint mirrors the Rust enum discriminator — `Supported` has no
limitations/reason; `Partial` requires at least one limitation; `Unsupported`
requires a reason. This prevents string-typed drift from sneaking in.

## Itotori-side consumer

- `apps/itotori/src/services/` (likely a new
  `engine-capability-report.ts` service, or extending an existing detection
  service — confirm during implementation): pulls matrices from
  `engine_capability_reports`, exposes `isUsable(adapterId, level)` typed by
  the Zod enum.
- `apps/itotori/src/dashboard.ts` and `apps/itotori/src/cli.ts`: render an
  "Identified only" badge / row for adapters whose `extract` is not
  `supported`. Decision points that previously branched on "adapter detected"
  now branch on the typed level.

## Test plan

- Rust unit tests in `crates/kaifuu-core/src/registry/capability.rs`:
  - Round-trip: `AdapterCapabilityMatrix` → JSON → matrix, all four rungs.
  - `adapters_supporting(Extract)` excludes adapters whose extract is
    `Partial` or `Unsupported`, even if their identify is `Supported`.
  - `adapters_supporting(Identify)` includes identify-only adapters.
  - `derive_from_reports` does NOT promote an adapter past its declared
    `level_matrix` — declared matrix wins.
- Detector regression tests in `kaifuu-engine-fixture` and `kaifuu-reallive`:
  each detector emits a stable matrix (snapshot test).
- TS schema parity: `pnpm exec vp run ts:test` covers a fixture in
  `packages/localization-bridge-schema/__fixtures__/` that round-trips through
  both validators; new contract fixture
  `engine-capability-report-v0.2(.json)` exercises Supported / Partial /
  Unsupported branches.
- DB migration test: `packages/itotori-db` integration test inserts each
  status_kind branch, asserts CHECK constraint rejects mismatched shapes
  (e.g. `supported` with non-null `reason`).
- Itotori service test: identify-only adapter is reported as not usable
  for Extract/Patch in the dashboard surface.

## Verification commands

- `cargo test -p kaifuu-core registry`
- `cargo test -p kaifuu-engine-fixture`
- `cargo test -p kaifuu-reallive`
- `cargo test --workspace`
- `pnpm exec vp run ts:test`
- `pnpm --filter itotori-db test`
- `just check`
- `just test`

## Risks

- **Detector report drift**: existing detectors emit granular
  `CapabilityReport`s today; adding a parallel `level_matrix` without
  enforcing consistency risks divergence. Mitigation: a `cargo test` in
  `kaifuu-core` that asserts every registered adapter's `level_matrix` is at
  least as conservative as `derive_from_reports` would compute (i.e. declared
  level cannot claim more than the per-capability reports support).
- **TS / Rust schema drift**: the same risk that the contract-fixtures
  framework already mitigates — add the new matrix kind to
  `CONTRACT_FIXTURE_KINDS_V02` (in `crates/kaifuu-core/src/contracts.rs`) so
  the parity report KAIFUU-053 produces is checked both ways.
- **Capability ladder evolution**: identifying a fifth rung later (e.g.
  "round-trip verify") requires schema migration. Mitigation: enum is closed,
  versioned with the schema; document the next-rung policy in
  `docs/kaifuu-engine-playbook.md` as part of the work.
- **DB enum migration cost**: adding new enum values later requires Postgres
  `ALTER TYPE`. Accept this — the four rungs are stable.

## Out of scope

- New engine adapters (RealLive patch path, Siglus extract, XP3 patch).
- KAIFUU-176 vault-source adapter capability changes — vault source is not an
  `EngineAdapter`; its capability surface is governed by KAIFUU-052 / 176.
- Refactoring the existing `Capability` enum (15+ variants) into the 4-rung
  ladder. The two layers coexist; granular reports remain the source of truth
  for operational gating.
- Reworking the existing layered-access contract — it stays in place; the
  4-rung matrix sits above it.

## Implementation order

1. Rust types in `kaifuu-core` + tests.
2. Detector migrations (fixture, XP3, Siglus, RealLive) with snapshot tests.
3. TS mirror in `packages/localization-bridge-schema` + contract fixture.
4. DB migration + migration test.
5. Itotori service / dashboard / CLI wiring.
6. Documentation update in `docs/kaifuu-engine-playbook.md` describing the
   ladder and the "identify-only" surface.
