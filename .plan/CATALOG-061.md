# CATALOG-061 - Opportunity ranking service

- **Node**: CATALOG-061
- **Title**: Opportunity ranking service
- **Branch**: `spec/catalog-061`
- **Worktree**: `/scratch/worktrees/itotori-spec-catalog-061`
- **Author**: planning worker
- **Date**: 2026-06-27
- **Status target**: claimed -> ready_for_review after implementation and audit

## Goal

Build a catalog opportunity ranking surface for choosing localization projects
from the existing catalog facts, not from hidden heuristics. The output should
rank candidate works across engine/readiness pools and explain each score using
public catalog metadata plus aggregate-safe private-local signals.

This should extend the current catalog read-model pattern rather than replace
it:

- `CatalogAlphaBenchmarkOpportunityRanking` already ranks completeness pools and
  demotes open platform-language conflicts.
- `CatalogBenchmarkSeedFinderReadModel` already combines completeness, DLsite
  demand buckets, local ownership, capability readiness, provenance, and
  leakage tests.
- CATALOG-007 already split strict adapter support from source-split capability
  evidence, with public fixture evidence separated from private-local aggregate
  evidence.

CATALOG-061 should be a broader opportunity read model that reuses those inputs
while making the weighted contribution of each factor explicit.

## Existing Surfaces To Reuse

- `packages/itotori-db/src/repositories/catalog-repository.ts`
  - Current catalog read models live here.
  - Existing helpers assemble completeness pools, conflict reviews, demand
    buckets, local ownership, provenance summaries, and adapter readiness.
  - Existing ranking code uses deterministic score + title/work-id tie breaks.
- `packages/itotori-db/src/services/catalog-platform-language-conflicts.ts`
  - Produces explainable official-English platform conflict facts that should
    demote false untranslated candidates.
- `packages/itotori-db/src/repositories/engine-capability-report-repository.ts`
  - Holds strict capability matrices and CATALOG-007 evidence splits:
    `publicFixture` vs `privateLocalAggregate`.
- `apps/itotori/src/services/catalog-local-capability-evidence.ts`
  - Maps MV/MZ local scanner sidecars into aggregate-only capability evidence.
- `apps/itotori/src/api-handlers.ts`,
  `apps/itotori/src/api-schema.ts`,
  `apps/itotori/src/services/database-services.ts`
  - Existing GET catalog APIs: conflicts, completeness, benchmark seeds.
- `fixtures/catalog-benchmark-seeds/fixture.json` and
  `fixtures/public/catalog-benchmark-seeds.manifest.json`
  - Existing deterministic public ranking fixture and leakage policy.
- `apps/itotori/test/dashboard.test.ts` and `apps/itotori/test/api-fixtures.ts`
  - Existing dashboard/API fixture validation style.
- `docs/fixtures-and-corpora.md`
  - Public fixture and private-local aggregate privacy contract.

## Deliverables Mapped To Files

### 1. Opportunity scoring service

Files/modules:

- Add `packages/itotori-db/src/services/catalog-opportunity-ranking.ts`
- Add `packages/itotori-db/test/catalog-opportunity-ranking.test.ts`
- Export service types from `packages/itotori-db/src/index.ts`

Service responsibilities:

- Define `CatalogOpportunityScoreInput`, `CatalogOpportunityScoreBreakdown`,
  `CatalogOpportunityFactor`, and `CatalogOpportunityDecision`.
- Score only normalized inputs passed by the repository. Keep the service pure
  and deterministic.
- Emit explicit factor rows, for example:
  - `translation_completeness`
  - `local_ownership`
  - `dlsite_demand`
  - `platform_language_conflict`
  - `market_prevalence`
  - `adapter_readiness`
  - `runtime_evidence_readiness`
  - `existing_translation_status`
  - `benchmark_usefulness`
  - `unknown_evidence`
- Each factor should include `weight`, `rawValue`, `weightedScore`,
  `evidenceRefs`, and a short `explanationCode`.
- Use closed enums and small numeric weights. No score-affecting free-form
  string parsing.

Initial weighting direction:

- Positive: no-English / MTL-only / fan-partial gaps, high DLsite demand,
  local ownership, extract/patch-capable adapters, useful benchmark coverage,
  public or aggregate-safe provenance.
- Negative: official-English conflict, open language status conflict,
  unsupported extract/patch, no provenance when provenance is required,
  unknown engine/readiness when the candidate is otherwise high-demand.
- Neutral or diagnostic-only: unknown evidence that should be surfaced but not
  silently treated as negative.

### 2. Ranked opportunity API/read model

Files/modules:

- Update `packages/itotori-db/src/repositories/catalog-repository.ts`
- Update `packages/itotori-db/src/index.ts`
- Update `packages/itotori-db/test/catalog-opportunity-ranking-read-model.test.ts`
- Update `apps/itotori/src/api-handlers.ts`
- Update `apps/itotori/src/api-schema.ts`
- Update `apps/itotori/src/services/database-services.ts`
- Update `apps/itotori/test/server.test.ts` or add an API-focused app test

Read model shape:

- Add `catalogOpportunityRanking(actor, filter)` to
  `ItotoriCatalogRepositoryPort` and `ItotoriCatalogRepository`.
- Return `schemaVersion: "catalog.opportunity_ranking.v0.1"`,
  `targetLanguage`, `generatedAt`, `weightsVersion`, and `rows`.
- Each row should include:
  - stable catalog identity: `workId`, `canonicalTitle`, `originalLanguage`,
    safe `sourceIds`
  - `engineName`, `adapterId`, and readiness statuses
  - `completenessPool` and `translationStatuses`
  - DLsite demand facts summarized as public numeric facts:
    sales/download count, rating average/count, wishlist count, best rank,
    work type
  - `localOwnership` and aggregate local evidence count only
  - `marketPrevalence` as a public/aggregate bucket, not raw private corpus
    membership
  - `decision`: `candidate` | `demoted` | `excluded`
  - `rank`, `score`, `factorBreakdown`, `explanationCodes`, `provenance`
  - `demotions` for platform-language and other open conflicts
- Add GET `/api/catalog/opportunities` with query filters mirroring existing
  catalog endpoints:
  - `targetLanguage`
  - `includeDemoted`
  - `limit`
  - optional `engine`, `pool`, `minCapabilityLevel`, `localOwnership`,
    `demandBucket`
- Validate the response in `api-schema.ts` like
  `assertCatalogBenchmarkSeedFinderReadModel`; reject malformed factor rows and
  non-finite scores.

Implementation notes:

- Prefer extracting shared helper functions from the existing seed finder only
  when needed by both read models. Avoid broad refactors in the first worker
  slice.
- Preserve existing `catalogBenchmarkSeedFinder` behavior and fixtures.
- Query capability matrix rows and evidence rows through
  `EngineCapabilityReportRepository` or equivalent selected rows so
  CATALOG-007 evidence separation is visible in opportunity explanations.

### 3. Opportunity dashboard seed fixture

Files/modules:

- Add `fixtures/catalog-opportunities/fixture.json`
- Add `fixtures/public/catalog-opportunities.manifest.json`
- Update `fixtures/validate-public-manifests.mjs` only if the existing manifest
  schema cannot express the fixture role; prefer no validator change.
- Add `apps/itotori/src/catalog/opportunity-fixtures.ts` or
  `apps/itotori/src/services/catalog-opportunity-dashboard-fixtures.ts`
- Add `apps/itotori/test/catalog-opportunity-dashboard-fixtures.test.ts`
- Optionally update `apps/itotori/test/api-fixtures.ts` if the main dashboard
  consumes the opportunity fixture directly.

Fixture coverage:

- Include rows for RPG Maker MV/MZ, RGSS3/VX Ace, KiriKiri XP3, TyranoScript,
  Unity, Siglus, Wolf, MTL-only, fan-partial, no-English,
  official-English-conflict, and demand-ranked pools.
- Include DLsite sales/download count, rating summary, wishlist count, rank,
  and work type facts, with expected factor contributions.
- Include public capability/readiness evidence and CATALOG-007 style
  private-local aggregate evidence without raw local details.
- Include expected ranking output with deterministic scores and tie breaks.
- Include public leakage policy forbidden substrings aligned with
  `fixtures/catalog-benchmark-seeds/fixture.json` and CATALOG-007 tests:
  `/home`, `/tmp`, `/scratch`, Windows drive prefixes, `file:`, retail
  filename extensions, `pathHash`, `localScanEntryId`, `rawText`,
  `SECRET_KEY`, screenshots, raw hashes, and private story/title sentinels.

### 4. Dashboard/read-model integration

Files/modules:

- If surfacing in the current dashboard:
  - update `apps/itotori/src/dashboard.ts`
  - update `apps/itotori/test/dashboard.test.ts`
  - update `apps/itotori/test/msw-handlers.ts`
  - update `apps/itotori/test/api-fixtures.ts`
- If keeping dashboard seed fixture separate for this node:
  - keep writes confined to the fixture service/test named above and leave the
    main dashboard for a follow-up node.

Recommended scope:

- For CATALOG-061, add a compact opportunity fixture/read-model renderer test
  first. Only wire into the main dashboard if the API shape is stable and the
  change stays small.
- The dashboard presentation should show score, decision, top factor
  contributions, demotion reason, engine/readiness, demand bucket, and local
  ownership. It must not render raw private evidence.

## Proposed Worker Split

### Worker A - DB scoring and read model

Write scope:

- `packages/itotori-db/src/services/catalog-opportunity-ranking.ts`
- `packages/itotori-db/src/repositories/catalog-repository.ts`
- `packages/itotori-db/src/index.ts`
- `packages/itotori-db/test/catalog-opportunity-ranking.test.ts`
- `packages/itotori-db/test/catalog-opportunity-ranking-read-model.test.ts`

Do not touch app API/dashboard files or fixture manifests.

Expected output:

- Pure scoring service with factor breakdown tests.
- Repository read model that ranks synthetic DB records and preserves existing
  benchmark seed finder behavior.

### Worker B - Public fixture and manifest

Write scope:

- `fixtures/catalog-opportunities/**`
- `fixtures/public/catalog-opportunities.manifest.json`
- `fixtures/validate-public-manifests.mjs` only if unavoidable

Do not touch TypeScript code except by asking first.

Expected output:

- Deterministic public opportunity fixture with expected read-model output.
- Valid public manifest with hashes and byte counts.
- Leakage policy embedded in fixture notes/test inputs.

### Worker C - API and app fixture wiring

Write scope:

- `apps/itotori/src/api-handlers.ts`
- `apps/itotori/src/api-schema.ts`
- `apps/itotori/src/services/database-services.ts`
- `apps/itotori/test/server.test.ts` or a dedicated API test
- `apps/itotori/src/services/catalog-opportunity-dashboard-fixtures.ts`
- `apps/itotori/test/catalog-opportunity-dashboard-fixtures.test.ts`

Do not touch DB scoring files or public fixture manifests.

Expected output:

- GET `/api/catalog/opportunities` returns schema-validated opportunity rows.
- App fixture test proves dashboard/read-model data can be consumed without
  private leakage.

### Worker D - Dashboard panel, only if accepted into active scope

Write scope:

- `apps/itotori/src/dashboard.ts`
- `apps/itotori/test/dashboard.test.ts`
- `apps/itotori/test/msw-handlers.ts`
- `apps/itotori/test/api-fixtures.ts`

Do not touch DB repository/scoring or fixture manifests.

Expected output:

- Dashboard renders a compact Opportunity section from API-backed fixture data.
- Existing dashboard sections still render and schema checks still fail closed.

## Acceptance And Verification Mapping

- Acceptance: required pools and engines can be ranked with explainable
  evidence.
  - Worker A tests seed all listed pools/engine labels and assert deterministic
    ranked rows.
  - Worker B fixture includes the public expected-output artifact.
  - Verify with `pnpm --filter @itotori/db test` and
    `pnpm --filter @itotori/app test`.

- Acceptance: output distinguishes prevalence, demand, local ownership,
  translation completeness, adapter readiness, runtime evidence readiness,
  benchmark usefulness, and unknown evidence.
  - Scoring service tests assert one factor row per dimension.
  - Read-model tests assert unknown evidence is explicit and not hidden in an
    unexplained score.

- Acceptance: DLsite sales, rating, wishlist, rank, and work_type facts
  influence ranking through explicit weights or rule explanations.
  - DB tests should seed each `catalogDemandFactKindValues` case and assert
    factor contribution or diagnostic explanation code.
  - Use existing `catalog-dlsite-demand.test.ts` importer facts as the source
    shape reference.

- Acceptance: platform-language conflicts demote false untranslated candidates
  before benchmark or alpha project selection.
  - Reuse conflict rows from `catalogPlatformLanguageConflictReasonCode`.
  - Tests assert conflict rows become `decision: "demoted"` with a negative
    factor/demotion, and excluded from default candidate rows unless
    `includeDemoted` is true.

- Acceptance: ranking can be generated from public fixtures and private-local
  aggregate sidecars without leaking private data.
  - Fixture tests serialize full output and check forbidden substrings.
  - DB scoring must accept only aggregate local ownership/count/readiness
    summaries, not scanner entry ids, path hashes, filenames, raw text,
    screenshots, helper logs, or keys.

- Node verification commands:
  - `pnpm --filter @itotori/app test`
  - `pnpm --filter @itotori/db test`
  - Manual: Opportunity ranking fixture review

Recommended extra checks before audit:

- `pnpm exec node fixtures/validate-public-manifests.mjs`
- Focused tests:
  - `pnpm --filter @itotori/db test -- catalog-opportunity`
  - `pnpm --filter @itotori/app test -- catalog-opportunity`

## Data Privacy And Leakage Constraints

- Public output may include public source ids, source provenance ids,
  public fixture ids, aggregate counts, buckets, redaction classes, and
  high-level explanation codes.
- Public output must not include private paths, local corpus filenames,
  path hashes, local scan entry ids, raw scanner signals, screenshots, raw
  extracted text, helper logs, key material, storefront/account identifiers, or
  raw private hash lists.
- Private-local evidence may influence ranking only through aggregate fields:
  owned/not-owned/unknown, count buckets, engine counts, adapter evidence source
  class, and CATALOG-007 aggregate capability evidence labels.
- Do not make private-local evidence a prerequisite for public fixture CI.
- Avoid tiny private histogram bins that identify a single local game unless
  represented as a coarse bucket.
- Reuse or centralize the CATALOG-007 leakage guard before accepting new
  opportunity sidecars. The CATALOG-007 audit promoted a P3 about key-value
  private paths such as `source=/private/corpus`; CATALOG-061 should treat that
  as an audit risk for all new explanation fields.

## Audit Risks

- **Popularity mistaken for readiness**: high DLsite demand must not override
  unsupported adapter/runtime readiness. The score breakdown should make demand
  and readiness separate factors.
- **Private corpus leakage**: opportunity rows are attractive to display and
  export, so leakage checks must cover the full serialized read model.
- **Unexplainable opportunity scores**: every non-zero score contribution must
  appear in `factorBreakdown` with a stable explanation code and evidence ref.
- **Conflict demotion bypass**: platform-language conflicts must demote before
  default ranking/selection, not only appear as advisory text.
- **Regression of CATALOG-004/CATALOG-007 surfaces**: existing benchmark seed
  finder and capability evidence split tests must remain unchanged.
- **Engine-name normalization overreach**: fuzzy adapter matching can map
  unrelated engines if normalization is too loose. Tests should include
  similarly named engines and unknown adapters.
- **Fixture-shaped breadth**: supporting the listed engines in a public fixture
  does not imply real end-to-end engine support. Explanations should say
  readiness is from current evidence, not claim beta-level engine coverage.

## Integration Order

1. Worker A adds the pure scoring service and DB read model using synthetic
   inline test data. Keep API/dashboard untouched.
2. Worker B adds the public opportunity fixture and manifest once Worker A's
   read-model shape is stable.
3. Worker A updates/aligns DB tests to load the public fixture expected output
   and adds serialization leakage checks.
4. Worker C adds `/api/catalog/opportunities`, API schema validation, and app
   service wiring.
5. Worker C adds the opportunity dashboard seed fixture consumer test.
6. Worker D optionally wires the main dashboard panel if the orchestrator
   accepts that extra UI scope for CATALOG-061.
7. Run targeted tests, public manifest validation, then the node verification
   commands.
8. Audit with focus on score explainability, private leakage, and popularity vs
   readiness separation.

## Open Questions For Orchestrator

- Should the main dashboard panel be included in CATALOG-061, or should this
  node stop at API/read-model plus dashboard seed fixture?
- Should `CatalogAlphaBenchmarkOpportunityRanking` remain as a legacy alpha
  read model for now, or should the new opportunity ranking become the preferred
  endpoint while preserving old tests?
- Should the CATALOG-007 P3 leakage hardening be fixed inside Worker A before
  adding new opportunity leakage checks, or promoted to a prerequisite/follow-up
  node?
