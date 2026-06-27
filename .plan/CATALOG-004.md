# CATALOG-004 - Benchmark seed finder

- **Node**: CATALOG-004
- **Title**: Benchmark seed finder
- **Branch**: `spec/catalog-004`
- **Worktree**: `/scratch/worktrees/itotori-spec-catalog-004`
- **Author**: planning worker (orchestrator)
- **Date**: 2026-06-27
- **Status target**: claimed -> ready_for_review after implementation and audit
- **Claim source**: `roadmap/spec-dag.json` committed export shows
  `status: "claimed"`, `owner: "orchestrator-catalog-004"`, and
  `branch: "spec/catalog-004"`.

## Goal

Build a readiness-aware benchmark seed finder that selects credible corpus
candidates from catalog completeness, local ownership evidence, recorded
importer provenance, DLsite demand facts, engine capability reports, and current
translation status. The output must be useful to cost and quality benchmark
flows without leaking private-local corpus details.

This is not a crawler, adapter, or benchmark runner. It is a typed read model
and API surface that explains why a work is selectable, demoted, or excluded.

## QD And Repo Context

The committed qd export gives these CATALOG-004 deliverables:

- Benchmark seed finder queries.
- Readiness-aware benchmark fixture set.
- Private-local aggregate-safe benchmark seed output.
- Benchmark seed API/read model fixture.

Acceptance in the export requires these distinctions:

- local ownership;
- translation completeness, including MTL-only, fan-partial, no-English, and
  conflict pools;
- CATALOG-011 recorded importer provenance;
- DLsite demand evidence;
- engine readiness split into `identify`, `inventory`, `extract`, `patch`,
  helper, and runtime capability levels;
- benchmark usefulness and explainable selection.

Relevant current surfaces:

- `packages/itotori-db/src/repositories/catalog-repository.ts` already exposes
  `catalogCompletenessBenchmarkPools()` and
  `catalogAlphaBenchmarkOpportunityRanking()`.
- `packages/itotori-db/src/repositories/catalog-repository.ts` persists works,
  releases, language statuses, demand facts, local scans, seed targets, source
  provenance, and conflicts.
- `packages/itotori-db/src/repositories/engine-capability-report-repository.ts`
  persists `identify` / `inventory` / `extract` / `patch` adapter matrices.
- `apps/itotori/src/services/catalog-local-scan.ts` emits redacted local corpus
  sidecars with HMAC path hashes and aggregate engine evidence.
- `apps/itotori/src/api-handlers.ts` already exposes catalog completeness at
  `GET /api/catalog/completeness`.
- `fixtures/catalog-recorded-importers/` and
  `fixtures/public/catalog-recorded-importers.manifest.json` are the public
  recorded importer evidence pool.

`./bin/qd status --json` and `./bin/qd ready --json` were attempted from this
worktree but could not open `.qd/qd.db` because that database is on a read-only
filesystem. Use `roadmap/spec-dag.json` as the durable qd context for this
planning slice.

## Deliverables

1. **DB read model and repository query**
   - Add a `catalogBenchmarkSeedFinder()` read method to
     `CatalogRepositoryPort` / `ItotoriCatalogRepository`.
   - Return a typed `CatalogBenchmarkSeedFinderReadModel` with
     `schemaVersion: "catalog.benchmark_seed_finder.v0.1"`.
   - Inputs should include `targetLanguage`, optional `pools`, optional
     `minCapabilityLevel`, optional `demandBucket`, optional
     `translationCompleteness`, optional `includeDemoted`, and `limit`.

2. **Readiness and explanation fields**
   - Each seed row must include stable catalog ids, public source ids,
     completeness pool, translation status facts, local ownership bucket,
     demand bucket, readiness matrix, selection decision, rank, seed rank, and
     explanation codes.
   - Readiness must keep these axes separate:
     `identify`, `inventory`, `extract`, `patch`, `helper`, and `runtime`.
     `helper` and `runtime` may initially be `unknown` with explicit
     explanation codes when no durable source exists yet; do not collapse them
     into `extract` or `patch`.

3. **Aggregate-safe output**
   - Public/API rows must not include private local paths, filenames, path
     hashes, local scan entry ids, raw source payloads, story text, screenshots,
     or corpus records.
   - Local ownership is exposed as aggregate fields such as
     `localOwnership: "owned" | "not_owned" | "unknown"` and counts like
     `localEvidenceCount`, not raw entry identities.

4. **Fixture set**
   - Add public deterministic fixtures for seed-finder inputs and output,
     preferably under `fixtures/catalog-benchmark-seeds/` with a matching
     `fixtures/public/catalog-benchmark-seeds.manifest.json`.
   - Fixture coverage must include MTL-only, fan-partial, no-English, conflict,
     demand-ranked, local-owned, readiness-filtered, and demoted rows.

5. **API and app-facing service**
   - Add `GET /api/catalog/benchmark-seeds` or an equivalently named catalog API
     route that returns the read model.
   - Add an app-level service wrapper if needed, likely
     `apps/itotori/src/services/catalog-benchmark-seeds.ts`, keeping API
     handlers thin.

6. **Docs or README note**
   - Add a short section to `docs/itotori-product-workflow.md` or
     `docs/itotori-scale-harness.md` only if implementation needs to name the
     API contract for downstream benchmark runners. Keep docs small and tied to
     the shipped read model.

## Acceptance Criteria

Implementation is acceptable when all of the following are true:

1. A repository test can import recorded catalog fixtures plus synthetic local
   scan and capability rows, then query benchmark seeds by:
   - MTL-only;
   - fan-partial;
   - no-English;
   - conflict;
   - demand-ranked;
   - readiness-filtered;
   - local-owned aggregate evidence.

2. Seed rows preserve separate readiness levels for `identify`, `inventory`,
   `extract`, `patch`, `helper`, and `runtime`; filtering by `extract` does not
   pass identify-only rows, and partial support is reported rather than treated
   as supported.

3. DLsite demand facts influence ranking through explainable buckets, not raw
   ad hoc score math. Recommended buckets:
   `none`, `low`, `medium`, `high`, and `very_high`, derived from persisted
   `dl_count`, `wishlist_count`, rank, and rating facts.

4. Recorded importer provenance is visible in every row that depends on it:
   source, source id, fixture id or source version where available, and
   redaction class. Rows without recorded provenance must carry an
   `unrecorded_or_local_only` explanation code and cannot satisfy provenance
   required filters.

5. Conflict rows are selectable only when requested or when
   `includeDemoted: true`; otherwise they are demoted with a reason naming the
   conflict id or review id.

6. API output passes a leakage test that stringifies the read model and rejects:
   `/home`, `/tmp`, Windows drive paths, `file:`, raw `.zip` member names,
   private story/title fixture strings, local scan entry ids, path hashes, and
   raw source payload fields.

7. Public fixtures and manifests validate, and public CI passes with no
   private-local directory present.

## Likely Files And Modules

DB package:

- `packages/itotori-db/migrations/0046_catalog_benchmark_seed_finder.sql`
  if a materialized table or index is needed. Prefer a pure read model first;
  add a migration only for durable indexes or cached seed outputs.
- `packages/itotori-db/src/schema.ts` if new enums, indexes, or cache tables
  are required.
- `packages/itotori-db/src/repositories/catalog-repository.ts` for read model
  types and `catalogBenchmarkSeedFinder()`.
- `packages/itotori-db/src/index.ts` for exported types.
- `packages/itotori-db/test/catalog-benchmark-seed-finder.test.ts` for the
  repository contract.
- `packages/itotori-db/test/migrations-parity.test.ts` if a migration is added.

App package:

- `apps/itotori/src/api-handlers.ts` for route wiring and query parsing.
- `apps/itotori/src/api-schema.ts` if response schema validation needs a typed
  route id.
- `apps/itotori/src/services/catalog-benchmark-seeds.ts` if app-level
  transformations should stay outside the API handler.
- `apps/itotori/test/catalog-benchmark-seeds-api.test.ts` for API behavior and
  leakage assertions.

Fixtures:

- `fixtures/catalog-benchmark-seeds/seed-finder-input.json`
- `fixtures/catalog-benchmark-seeds/expected-read-model.json`
- `fixtures/public/catalog-benchmark-seeds.manifest.json`

Do not modify private-local fixtures, and do not commit generated private scan
outputs.

## Query Contract

Recommended repository input:

```ts
export type CatalogBenchmarkSeedFinderFilter = {
  targetLanguage?: string;
  pools?: CatalogCompletenessPool[];
  minCapabilityLevel?: "identify" | "inventory" | "extract" | "patch";
  demandBucket?: "none" | "low" | "medium" | "high" | "very_high";
  translationCompleteness?: CatalogLanguageStatus[];
  provenanceRequired?: boolean;
  localOwnership?: "owned" | "not_owned" | "unknown";
  includeDemoted?: boolean;
  limit?: number;
};
```

Recommended row shape:

```ts
export type CatalogBenchmarkSeedRow = {
  workId: string;
  canonicalTitle: string;
  originalLanguage: string | null;
  sourceIds: Array<{ catalogSource: string; sourceId: string; externalIdKind: string }>;
  completenessPool: string;
  translationStatuses: Array<{ language: string; status: string; confidence: string }>;
  localOwnership: "owned" | "not_owned" | "unknown";
  localEvidenceCount: number;
  demandBucket: "none" | "low" | "medium" | "high" | "very_high";
  readiness: {
    adapterId: string | null;
    identify: string;
    inventory: string;
    extract: string;
    patch: string;
    helper: string;
    runtime: string;
  };
  decision: "seed" | "candidate" | "demoted" | "excluded";
  rank: number;
  seedRank: number | null;
  explanationCodes: string[];
};
```

The implementation may refine names, but it must preserve the same information
and leakage boundary.

## Ranking Guidance

Keep the first implementation deterministic and explainable:

- Start from completeness pools produced by `catalogCompletenessBenchmarkPools`.
- Prefer rows with local ownership evidence, but do not require it unless the
  filter says so.
- Prefer higher demand buckets within the same completeness/readiness band.
- Prefer `extract` or `patch` readiness for benchmark flows that need source
  bytes; allow `identify`/`inventory` only when explicitly requested.
- Demote open conflicts unless conflict selection is requested.
- Keep ties stable by `canonicalTitle`, then `workId`.

Avoid hidden weighted scoring unless each component is emitted as an
explanation code or score component. Auditors must be able to reproduce why row
A outranked row B from the read model alone.

## Data Leakage Risks

Highest-risk fields:

- `catalogLocalScanEntries.pathHash`, `localScanEntryId`, `signals`,
  `metadata`, and detected local filenames.
- Raw scanner sidecar data from `apps/itotori/src/services/catalog-local-scan.ts`.
- `catalogSourceProvenance.payload` for any private or redacted source.
- Storefront payload fields that contain product page paths or request details.
- Fixture strings used only to test redaction, such as private titles, story
  text, screenshots, archive member names, and secret keys.

Mitigations:

- Build API rows from aggregate joins, not from serialized source records.
- Include `rawContentRedactionClass` summaries, never `payload`.
- Count local scan matches per work; do not expose the local entry id or path
  hash.
- Keep public fixture output synthetic and manifest-validated.
- Add a JSON string leakage test for both repository read model and API response.

## Audit Lanes

1. **Benchmark seed leakage**
   - Inspect read-model JSON and API JSON for local paths, filenames, hashes,
     source payloads, and private fixture strings.

2. **Recorded importer provenance bypass**
   - Confirm rows claiming public catalog evidence cite CATALOG-011 fixture
     provenance or carry an explicit local-only/unrecorded explanation.

3. **Readiness filters ignored**
   - Confirm identify-only, partial extract, supported extract, and supported
     patch rows behave differently under filters.

4. **Unexplainable selection**
   - Confirm rank, seed rank, demand bucket, demotions, and explanation codes
     make selection reproducible without reading private tables.

5. **Private-local absent CI**
   - Confirm tests pass without `fixtures/private-local/` or local scan outputs.

## Implementation Slices

### Slice A - DB Read Model

Owner: DB worker.

Deliver:

- `CatalogBenchmarkSeedFinderFilter`, `CatalogBenchmarkSeedFinderReadModel`,
  and `CatalogBenchmarkSeedRow`.
- `catalogBenchmarkSeedFinder()` in `ItotoriCatalogRepository`.
- Focused repository tests covering completeness pools, demand buckets,
  provenance refs, local ownership aggregation, readiness filters, conflict
  demotion, and leakage.

Suggested test command:

```sh
pnpm --filter @itotori/db test -- catalog-benchmark-seed-finder
```

If the package runner does not support file filtering, run:

```sh
pnpm --filter @itotori/db test
```

### Slice B - Fixture And Manifest

Owner: fixture worker, can run after Slice A row shape is stable.

Deliver:

- Public seed-finder input and expected read-model fixtures.
- Public manifest entry with hashes.
- Fixture validation updates.

Suggested test commands:

```sh
just fixtures-validate
pnpm --filter @itotori/db test
```

### Slice C - API Surface

Owner: app/API worker, starts after Slice A types are exported.

Deliver:

- `GET /api/catalog/benchmark-seeds` route.
- Query parsing for target language, pools, readiness, demand, local ownership,
  provenance requirement, demotion inclusion, and limit.
- API response schema/route id updates as needed.
- API tests with mocked services and leakage assertions.

Suggested test command:

```sh
pnpm --filter @itotori/app test -- catalog-benchmark-seeds
```

If file filtering is unavailable:

```sh
pnpm --filter @itotori/app test
```

### Slice D - Integration And Audit Hardening

Owner: final integration worker.

Deliver:

- Cross-package export wiring.
- Optional small docs note if downstream benchmark runners need the route name.
- Full verification and audit checklist evidence.

Suggested test commands:

```sh
pnpm --filter @itotori/db test
pnpm --filter @itotori/app test
just fixtures-validate
just check
```

## Verification Commands For The Final Worker

Minimum:

```sh
pnpm --filter @itotori/db test
pnpm --filter @itotori/app test
just check
```

Recommended when fixtures or migrations change:

```sh
just fixtures-validate
pnpm --filter @itotori/db test:db
just ci
```

`test:db` and `just ci` may require a local Postgres service; if unavailable,
record that explicitly and include the narrower passing commands.

## Out Of Scope

- Live provider calls, live DLsite/Steam/VNDB/EGS requests, or authenticated
  owned-library imports.
- New Kaifuu extraction or patch capability claims.
- Utsushi runtime adapter work.
- Running cost or quality benchmarks; this node only selects and explains seed
  candidates.
- Committing private-local corpus scans or sidecars.
