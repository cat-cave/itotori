# CATALOG-007 - MV/MZ local corpus readiness integration

- **Node**: CATALOG-007
- **Title**: MV/MZ local corpus readiness integration
- **Branch**: `spec/catalog-007`
- **Worktree**: `/scratch/worktrees/itotori-spec-catalog-007`
- **Author**: planning worker (orchestrator)
- **Date**: 2026-06-27
- **Status target**: claimed -> ready_for_review after implementation and audit
- **Claim source**: `roadmap/spec-dag.json` committed export shows
  `status: "claimed"`, `owner: "orchestrator-catalog-007"`, and
  `branch: "spec/catalog-007"`.

## Goal

Attach aggregate-safe local corpus evidence to RPG Maker MV/MZ
capability/readiness output after both independent inputs exist:

1. a public MV/MZ fixture adapter capability/readiness matrix, and
2. a local corpus scan sidecar with redacted MV/MZ engine evidence.

The key constraint is dependency direction. Public adapter work must complete
and remain testable without any private or local corpus scan. Local sidecars
augment readiness as evidence, not as a prerequisite for adapter support.

## Current Repo Context

Relevant surfaces already present:

- `apps/itotori/src/services/catalog-local-scan.ts`
  - Emits `catalog.local_corpus_sidecar.v0.1`.
  - Emits `localEngineEvidence` with
    `schemaVersion: "catalog.local_corpus_engine_evidence.v0.1"`,
    `adapterId: "local-scan:rpg_maker_mv_mz"`, `engineSource:
    "local_scan"`, aggregate `markerKinds`, `extensionCounts`, and
    `fileKindCounts`.
  - Explicitly states local scan evidence does not claim registered Kaifuu
    adapter execution, extraction, decryption, inventory, or patch support.
- `packages/itotori-db/src/repositories/catalog-repository.ts`
  - Persists local scans through `recordLocalScan()`.
  - Stores local scan entry `signals` and aggregate engine fields.
  - Already uses local scan rows in aggregate-safe catalog benchmark seed
    output without exposing local scan entry ids or path hashes.
- `packages/itotori-db/src/repositories/engine-capability-report-repository.ts`
  - Persists strict adapter matrices in `itotori_engine_capability_reports`,
    one row per `(adapter_id, level)`.
  - Supports only capability `statusKind`, `limitations`, `reason`, and
    `reportedAt`; it intentionally does not carry evidence provenance today.
- `apps/itotori/src/services/engine-capability-report.ts`
  - Produces app-level `AdapterCapabilitySummary`.
  - Computes `supported`, `partial`, and `identify_only` badges from strict
    capability rows.
- `apps/itotori/src/dashboard.ts`
  - `renderEngineCapabilityRows()` is a pure renderer for adapter capability
    summaries and is already unit-tested.
- `fixtures/public/kaifuu-encrypted-matrix/expected/rpg-maker-mv-mz-key-validation-success-v0.1.json`
  - Existing public synthetic MV/MZ key evidence fixture.
  - It is fixture-safe and explicitly does not claim decrypt/extract/patch.
- `docs/fixtures-and-corpora.md`
  - Defines public fixture vs private-local corpus rules, aggregate metrics
    policy, and forbidden leakage classes.

Important handoff from CATALOG-003:

- CATALOG-003 is done and its acceptance says capability merge into catalog
  readiness records is owned by KAIFUU-053 and CATALOG-007.
- CATALOG-007 should consume the local scanner sidecar shape, not redesign the
  scanner or make public CI depend on `fixtures/private-local/`.

## Deliverables

1. **MV/MZ local readiness sidecar mapping**
   - Add a typed mapping layer that accepts `CatalogLocalEngineEvidence` from
     scanner sidecars and converts only MV/MZ aggregate facts into capability
     evidence rows.
   - Canonicalize local scanner adapter id
     `local-scan:rpg_maker_mv_mz` into the public adapter id used by the MV/MZ
     fixture adapter, while preserving evidence source as private-local
     aggregate evidence.

2. **Capability evidence merge fixture**
   - Add a deterministic public fixture that combines:
     - a public MV/MZ adapter matrix from fixture output, and
     - synthetic local-scan-shaped sidecar evidence.
   - The fixture must demonstrate merge ordering and separation:
     public support status remains public fixture support; local evidence is an
     attached aggregate source, not a status override.

3. **Private-local aggregate-safe renderer**
   - Extend the engine capability read model / renderer to show separate
     evidence columns or sections, for example:
     `Public fixture support` and `Private-local aggregate evidence`.
   - Render aggregate local counts and evidence classes only. Do not render
     private scan ids, entry ids, path hashes, filenames, text, keys, helper
     logs, screenshots, or raw local signal blobs.

4. **Dashboard/read-model integration test**
   - Add coverage that imports public adapter matrix rows and local sidecar
     aggregate evidence, then verifies the dashboard/read model distinguishes
     the two evidence classes and passes leakage assertions.

## Implementation Slices

### Slice 1 - Evidence Types And Persistence

Owned files/modules:

- `packages/itotori-db/migrations/00xx_engine_capability_evidence.sql`
- `packages/itotori-db/src/schema.ts`
- `packages/itotori-db/src/repositories/engine-capability-report-repository.ts`
- `packages/itotori-db/src/index.ts`
- `packages/itotori-db/test/engine-capability-report-repository.test.ts`
- `packages/itotori-db/test/migrations-parity.test.ts`

Plan:

- Keep `itotori_engine_capability_reports` as the strict support matrix. Do
  not add local evidence fields to those rows that could imply private corpus
  evidence is required for support.
- Add a separate table, tentatively
  `itotori_engine_capability_evidence`, keyed independently from the support
  matrix:
  - `engine_capability_evidence_id`
  - `adapter_id`
  - `level`
  - `evidence_source`: `public_fixture` | `private_local_aggregate`
  - `evidence_kind`: small enum/string such as `adapter_matrix`,
    `local_corpus_sidecar`, `key_validation`, `engine_marker_count`
  - `schema_version`
  - `status`: `present` | `partial` | `missing` | `unknown`
  - `aggregate_counts`: JSON object with numeric counts only
  - `evidence_labels`: JSON string array from a fixed allowlist, such as
    `rpgmaker_mv_metadata`, `encrypted_asset_extension`, `system_json_layout`
  - `limitations`: JSON string array
  - `reported_at`
  - optional `public_fixture_id` for public fixture evidence
  - optional `local_scan_id_hash` or `corpus_label_hash` only if required for
    deduplication; prefer omitting this from public read models.
- Add repository methods:
  - `recordCapabilityEvidence(actor, input)`
  - `listMatricesWithEvidence()`
  - `readCapabilityReadiness(adapterId)`
- Validate evidence input before SQL:
  - no raw signal blobs;
  - aggregate counts are finite non-negative integers;
  - labels come from an allowlist;
  - private-local evidence cannot carry fixture paths, local paths, hashes,
    filenames, screenshots, raw text, or key material.
- Add DB tests for:
  - strict matrix rows still round-trip unchanged;
  - public fixture evidence and private-local aggregate evidence can attach to
    the same adapter;
  - local evidence cannot promote an unsupported matrix level to supported;
  - leakage-shaped strings are rejected before persistence.

Acceptance covered:

- Public adapter matrix remains independent.
- Local sidecars attach after scanner and adapter outputs exist.
- Public and private evidence are separated at persistence/read-model level.

### Slice 2 - MV/MZ Sidecar Mapping

Owned files/modules:

- `apps/itotori/src/services/catalog-local-scan.ts` if only exported types or
  constants are needed.
- `apps/itotori/src/services/engine-capability-report.ts`
- New app service if clearer:
  `apps/itotori/src/services/catalog-local-capability-evidence.ts`
- `apps/itotori/test/catalog-local-capability-evidence.test.ts`
- `apps/itotori/test/catalog-local-scan.test.ts` only for non-breaking type
  assertions, not scanner behavior redesign.

Plan:

- Add a pure function, tentatively
  `mapLocalEngineEvidenceToCapabilityEvidence(sidecarEntry)`, that reads
  `CatalogLocalEngineEvidence`.
- Accept only:
  - `schemaVersion: "catalog.local_corpus_engine_evidence.v0.1"`;
  - `engineName: "rpg_maker_mv_mz"`;
  - `engineSource: "local_scan"`;
  - scanner producer/version fields from the known local scanner.
- Map local evidence into public adapter namespace with explicit source split:
  - source adapter: `local-scan:rpg_maker_mv_mz`;
  - target adapter: the public MV/MZ adapter id chosen by the adapter worker;
  - source class: `private_local_aggregate`;
  - evidence kind: `local_corpus_sidecar`;
  - supported level attachment: `identify` evidence only unless a future
    sidecar schema adds aggregate-safe inventory/extract/patch facts.
- Preserve local readiness as evidence labels and limitations:
  - if local sidecar says `identify: "partial"`, attach a limitation like
    `local scan marker evidence only; no adapter execution claimed`;
  - never convert `partial` or marker presence into matrix `supported`.
- Avoid coupling to private paths by consuming sidecar objects already emitted
  by scanner tests or public synthetic merge fixtures.
- Add tests with synthetic sidecar objects that include forbidden raw-looking
  fields inside ignored signal objects and assert mapper output omits them.

Acceptance covered:

- Local corpus sidecars can attach MV/MZ capability evidence after scanner and
  adapter outputs exist.
- Adapter work is not blocked because mapper can be tested against synthetic
  sidecar-shaped input and a fixture adapter id.

### Slice 3 - Capability Evidence Merge Fixture

Owned files/modules:

- `fixtures/catalog-capability-evidence/mv-mz-merge-fixture.json` or
  `fixtures/catalog-mv-mz-readiness/fixture.json`
- `fixtures/public/catalog-capability-evidence.manifest.json` or matching
  manifest name
- `fixtures/public/manifest.schema.json` only if current schema cannot express
  the new fixture; prefer no schema change.
- `fixtures/validate-public-manifests.mjs` only if the validator needs a new
  role allowlist; prefer existing roles.
- App/DB tests that load the fixture.

Plan:

- Build a public synthetic merge fixture, not a private-local fixture:
  - public adapter matrix for MV/MZ with clear fixture-safe status;
  - sidecar-shaped local aggregate evidence using fake counts and safe labels;
  - expected merged read model.
- Reuse or cite
  `fixtures/public/kaifuu-encrypted-matrix/expected/rpg-maker-mv-mz-key-validation-success-v0.1.json`
  as the existing public fixture evidence where appropriate.
- Fixture expected output must contain separate fields:
  - `supportEvidence.publicFixture`
  - `supportEvidence.privateLocalAggregate`
  - or equivalent names that make separation obvious.
- Fixture leakage policy should include forbidden substrings:
  `/home`, `/tmp`, Windows drive prefixes, `file:`, `.rpgmvp` private
  filename-like strings, `SECRET_KEY`, `screenshot`, `pathHash`,
  `localScanEntryId`, `rawText`, and private story/title sentinel strings.
- Validate manifest hashes and byte counts.

Acceptance covered:

- Capability evidence merge fixture exists.
- No private-local corpus is required to run public fixture tests.

### Slice 4 - Read Model And Renderer Integration

Owned files/modules:

- `apps/itotori/src/services/engine-capability-report.ts`
- `apps/itotori/src/dashboard.ts`
- `apps/itotori/test/engine-capability-report.test.ts`
- `apps/itotori/test/dashboard.test.ts` if the full dashboard gets the new
  read model.
- `apps/itotori/src/cli-handlers.ts` if
  `engine-capabilities-list` should include evidence summaries.

Plan:

- Extend app-level summary from `AdapterCapabilitySummary` to include
  aggregate-safe evidence summaries, for example:

  ```ts
  type AdapterCapabilityEvidenceSummary = {
    publicFixture: {
      present: boolean;
      fixtureIds: string[];
      levels: Record<CapabilityLevel, "present" | "missing" | "unknown">;
    };
    privateLocalAggregate: {
      present: boolean;
      corpusCount: number;
      entryCount: number;
      markerKinds: string[];
      levels: Record<CapabilityLevel, "present" | "missing" | "unknown">;
      limitations: string[];
    };
  };
  ```

- Keep capability status fields as they are: `identify`, `inventory`,
  `extract`, and `patch` still come from strict adapter matrix rows.
- Update `renderEngineCapabilityRows()` to display evidence without collapsing:
  - adapter badge from strict matrix;
  - public fixture support/evidence label;
  - private-local aggregate evidence label/counts;
  - limitations in tooltip/title text only after escaping.
- Update `engine-capabilities-list` JSON output to include the same evidence
  summaries if downstream dashboard tooling reads the CLI report.
- Add renderer tests:
  - public support present, no local evidence;
  - public support plus local aggregate evidence;
  - local aggregate evidence present while extract remains unsupported;
  - no private sentinel string appears in rendered HTML.

Acceptance covered:

- Readiness output distinguishes public fixture support from private-local
  aggregate evidence.
- Renderer is aggregate-safe.

### Slice 5 - Dashboard / Read-Model Integration Test

Owned files/modules:

- `packages/itotori-db/test/engine-capability-report-repository.test.ts`
- `apps/itotori/test/engine-capability-report.test.ts`
- `apps/itotori/test/dashboard.test.ts`
- Optional new integration test:
  `apps/itotori/test/engine-capability-readiness-integration.test.ts`

Plan:

- Create an integration-style test that:
  1. records a public MV/MZ adapter matrix;
  2. records public fixture evidence;
  3. records synthetic local sidecar aggregate evidence through the mapper;
  4. reads merged summaries;
  5. renders them through dashboard row renderer.
- Assert:
  - adapter matrix can be recorded and listed without any local evidence;
  - adding local evidence changes only evidence summaries, not strict support
    status;
  - read model has separate `publicFixture` and `privateLocalAggregate`
    buckets;
  - rendered HTML names both classes separately;
  - stringified read model and HTML reject private leak sentinels.
- Keep this in public CI with synthetic inputs only.

Acceptance covered:

- MV/MZ public fixture adapter can complete without private/local scanning.
- Local corpus sidecars attach after both outputs exist.
- Dashboard/read-model integration behavior is covered.

## Test Commands

Plan-file verification:

```sh
nix develop --command pnpm exec vp check --no-lint .plan/CATALOG-007.md
```

Focused implementation verification:

```sh
pnpm --filter @itotori/db test -- engine-capability-report-repository
pnpm --filter @itotori/app test -- engine-capability-report
pnpm --filter @itotori/app test -- catalog-local-capability-evidence
pnpm --filter @itotori/app test -- dashboard
pnpm exec node fixtures/validate-public-manifests.mjs
```

Node verification from DAG:

```sh
pnpm --filter @itotori/app test
cargo test -p kaifuu-core
just check
```

If a migration is added:

```sh
pnpm --filter @itotori/db test -- migrations-parity
```

## Audit Risks And Mitigations

### Adapter Work Blocked By Private Corpus State

Risk:

- MV/MZ adapter support could accidentally require local scan evidence before
  reporting readiness.

Mitigation:

- Keep strict support matrix independent from evidence rows.
- Tests must prove adapter matrix listing works with no evidence rows.
- Mapper accepts already-produced sidecar objects and is invoked only by local
  corpus import/merge flows, not adapter registration.

### Private Corpus Leakage

Risk:

- Local scan `signals`, path hashes, filenames, raw text, key refs, helper
  dumps, screenshots, or local scan entry ids could leak into committed
  fixtures, read models, rendered HTML, or CLI JSON.

Mitigation:

- Store only allowlisted evidence labels and numeric aggregate counts.
- Reject leakage-shaped strings at repository/service boundaries.
- Add read-model and renderer stringification tests with forbidden sentinels.
- Do not persist full local sidecar `signals` into capability evidence rows.

### Public And Private Evidence Collapsed Together

Risk:

- A dashboard or API could make private-local aggregate evidence look like
  public fixture support, or make marker evidence look like extract/patch
  support.

Mitigation:

- Separate evidence source enum: `public_fixture` vs
  `private_local_aggregate`.
- Renderer has separate labels/columns.
- Local sidecar mapper attaches identify evidence and limitations only unless
  a future schema provides aggregate-safe inventory/extract/patch evidence.
- Tests assert local evidence does not change `adapterBadge()` or strict
  `isUsable()` behavior.

### Schema Drift With Scanner Sidecar

Risk:

- The mapper may silently accept old or incompatible local sidecar schema
  versions.

Mitigation:

- Mapper checks sidecar schema version and producer.
- Unsupported schema versions produce `unknown`/diagnostic evidence or are
  rejected by the local merge command, not silently merged.

## Recommended Parallel Worker Split

1. **DB/read-model worker**
   - Owns Slice 1 and DB parts of Slice 5.
   - Primary risk: schema/migration correctness and strict matrix independence.

2. **Mapper/fixture worker**
   - Owns Slice 2 and Slice 3.
   - Primary risk: sidecar schema mapping and public fixture leakage policy.

3. **Renderer/dashboard worker**
   - Owns Slice 4 and app-level parts of Slice 5.
   - Primary risk: public/private evidence separation in UI and CLI JSON.

Coordination contract:

- DB worker exposes `recordCapabilityEvidence()` and
  `listMatricesWithEvidence()` first.
- Mapper worker emits DB input objects only, not rendered read models.
- Renderer worker consumes the app-level summary shape and should not inspect
  raw local scan sidecars directly.

## Out Of Scope

- Implementing the MV/MZ public adapter itself.
- Running private-local corpus scans.
- Adding real private corpus files, screenshots, decrypted text, raw keys, or
  helper dumps.
- Promoting local marker evidence to extract or patch support.
- Changing the local scanner's existing redaction policy unless an integration
  test reveals a concrete leak.
