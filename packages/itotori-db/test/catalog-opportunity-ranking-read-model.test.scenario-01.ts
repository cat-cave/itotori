import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import {
  capabilityEvidenceLabelValues,
  EngineCapabilityReportRepository,
} from "../src/repositories/engine-capability-report-repository.js";
import { ItotoriCatalogRepository } from "../src/repositories/catalog-repository.js";
import { catalogPlatformLanguageConflictReasonCode } from "../src/services/catalog-platform-language-conflicts.js";
import {
  capabilityLevelValues,
  catalogConfidenceValues,
  catalogConflictKindValues,
  catalogConflictStatusValues,
  catalogEngineSourceValues,
  catalogExternalIdKindValues,
  catalogLanguageStatusValues,
  catalogSourceValues,
  engineCapabilityEvidenceKindValues,
  engineCapabilityEvidenceSourceValues,
  engineCapabilityEvidenceStatusValues,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };
const fetchedAt = "2026-06-27T12:00:00.000Z";

import {
  recordOpportunityCapability,
  recordRuntimeEvidenceCapability,
  recordExtractAdapterMatrixCapability,
  recordOpportunityCatalog,
  opportunityWorkInputWithEngine,
  recordOpportunityProvenance,
  provenance,
  languageStatus,
  localScanEntry,
  uuid,
  hash,
} from "./catalog-opportunity-ranking-read-model.test.shared-01.js";
import {
  requiredTestRow,
  factorScore,
  expectSerializedSafe,
} from "./catalog-opportunity-ranking-read-model.test.shared-02.js";
describe("catalogOpportunityRanking read model", () => {
  it("returns ranked aggregate-safe opportunities with explicit score factors and filters", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const capabilityRepo = new EngineCapabilityReportRepository(context.db);
      const provenance = await recordOpportunityProvenance(repo);
      await recordOpportunityCapability(capabilityRepo);
      const ids = await recordOpportunityCatalog(repo, provenance);

      const defaultModel = await repo.catalogOpportunityRanking(localActor, { limit: 20 });
      expect(defaultModel.schemaVersion).toBe("catalog.opportunity_ranking.v0.1");
      expect(defaultModel.weightsVersion).toBe("catalog.opportunity_ranking.weights.v0.1");
      expect(defaultModel.rows.map((row) => row.workId)).toEqual([
        ids.tieAlpha,
        ids.tieBeta,
        ids.partial,
      ]);

      const alpha = requiredTestRow(defaultModel.rows, ids.tieAlpha);
      expect(alpha).toMatchObject({
        rank: 1,
        canonicalTitle: "Alpha tie candidate",
        completenessPool: "no_english",
        decision: "candidate",
        demandFacts: {
          demandBucket: "very_high",
          dlCount: 12_000,
          ratingAverage: 4.6,
          ratingCount: 500,
          wishlistCount: 7_000,
          bestRank: 8,
          workType: "RPG",
        },
        localOwnership: "owned",
        localEvidenceCount: 1,
        marketPrevalence: "public_and_local_aggregate",
        runtimeEvidenceReadiness: {
          status: "private_local_aggregate",
          publicFixtureEvidenceCount: 0,
          privateLocalAggregateEvidenceCount: 1,
        },
      });
      expect(alpha.factorBreakdown.map((factor) => factor.factor)).toEqual([
        "translation_completeness",
        "local_ownership",
        "dlsite_demand",
        "platform_language_conflict",
        "market_prevalence",
        "adapter_readiness",
        "runtime_evidence_readiness",
        "dlsite_work_type",
        "existing_translation_status",
        "benchmark_usefulness",
        "unknown_evidence",
      ]);
      expect(alpha.explanationCodes).toEqual(
        expect.arrayContaining([
          "adapter_readiness:patch_supported",
          "dlsite_demand:very_high:rating_high",
          "dlsite_work_type:rpg",
          "runtime_evidence_readiness:private_local_aggregate",
          "translation_completeness:no_english",
          "unknown_evidence:none",
        ]),
      );
      expect(alpha.sourceIds).toEqual([
        {
          catalogSource: catalogSourceValues.dlsite,
          sourceId: "RJOPP001",
          externalIdKind: catalogExternalIdKindValues.storeProduct,
        },
      ]);

      const beta = requiredTestRow(defaultModel.rows, ids.tieBeta);
      expect(beta.rank).toBe(2);
      expect(beta.score).toBe(alpha.score);

      const extractReady = await repo.catalogOpportunityRanking(localActor, {
        minCapabilityLevel: capabilityLevelValues.extract,
        limit: 20,
      });
      expect(extractReady.rows.map((row) => row.workId)).toEqual([ids.tieAlpha, ids.tieBeta]);

      const owned = await repo.catalogOpportunityRanking(localActor, {
        localOwnership: "owned",
        limit: 20,
      });
      expect(owned.rows.map((row) => row.workId)).toEqual([ids.tieAlpha, ids.tieBeta]);

      const veryHighDemand = await repo.catalogOpportunityRanking(localActor, {
        demandBucket: "very_high",
        limit: 20,
      });
      expect(veryHighDemand.rows.map((row) => row.workId)).toEqual([ids.tieAlpha, ids.tieBeta]);
    } finally {
      await context.close();
    }
  });

  it("demotes conflict rows before default candidate selection and serializes no private evidence", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const capabilityRepo = new EngineCapabilityReportRepository(context.db);
      const provenance = await recordOpportunityProvenance(repo);
      await recordOpportunityCapability(capabilityRepo);
      const ids = await recordOpportunityCatalog(repo, provenance);

      const defaultModel = await repo.catalogOpportunityRanking(localActor, { limit: 20 });
      expect(defaultModel.rows.map((row) => row.workId)).not.toContain(ids.conflict);

      const withDemoted = await repo.catalogOpportunityRanking(localActor, {
        includeDemoted: true,
        limit: 20,
      });
      const conflict = requiredTestRow(withDemoted.rows, ids.conflict);
      expect(conflict).toMatchObject({
        decision: "demoted",
        demotions: [
          expect.objectContaining({
            conflictId: ids.conflictId,
            reasonCode: catalogPlatformLanguageConflictReasonCode,
          }),
        ],
      });
      expect(conflict.rank).toBeGreaterThan(requiredTestRow(withDemoted.rows, ids.partial).rank);
      expect(conflict.factorBreakdown).toContainEqual(
        expect.objectContaining({
          factor: "platform_language_conflict",
          weightedScore: -60,
          evidenceRefs: [ids.conflictId],
        }),
      );

      expectSerializedSafe(withDemoted);
    } finally {
      await context.close();
    }
  });

  it("does not count missing, unknown, or extract-only adapter matrix evidence as runtime readiness", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const capabilityRepo = new EngineCapabilityReportRepository(context.db);
      const presentProvenance = await provenance(repo, 21, catalogSourceValues.dlsite, "RJOPP021");
      const partialProvenance = await provenance(repo, 22, catalogSourceValues.dlsite, "RJOPP022");
      const missingProvenance = await provenance(repo, 23, catalogSourceValues.dlsite, "RJOPP023");
      const extractOnlyProvenance = await provenance(
        repo,
        24,
        catalogSourceValues.dlsite,
        "RJOPP024",
      );

      await recordRuntimeEvidenceCapability(capabilityRepo, "runtime-present-engine", "present");
      await recordRuntimeEvidenceCapability(capabilityRepo, "runtime-partial-engine", "partial");
      await recordRuntimeEvidenceCapability(capabilityRepo, "runtime-missing-engine", "missing");
      await recordExtractAdapterMatrixCapability(capabilityRepo, "extract-adapter-matrix-engine");
      await capabilityRepo.recordCapabilityEvidence(localActor, {
        adapterId: "runtime-missing-engine",
        level: capabilityLevelValues.extract,
        evidenceSource: engineCapabilityEvidenceSourceValues.privateLocalAggregate,
        evidenceKind: engineCapabilityEvidenceKindValues.localCorpusSidecar,
        schemaVersion: "catalog.local_corpus_engine_evidence.v0.1",
        status: engineCapabilityEvidenceStatusValues.unknown,
        aggregateCounts: { marker_kinds: 0 },
        evidenceLabels: [capabilityEvidenceLabelValues.localCorpusMarkerEvidence],
      });

      await repo.upsertWork(
        localActor,
        opportunityWorkInputWithEngine(
          uuid(121),
          "Present runtime evidence",
          presentProvenance,
          "RJOPP021",
          "runtime-present-engine",
        ),
      );
      await repo.upsertWork(
        localActor,
        opportunityWorkInputWithEngine(
          uuid(122),
          "Partial runtime evidence",
          partialProvenance,
          "RJOPP022",
          "runtime-partial-engine",
        ),
      );
      await repo.upsertWork(
        localActor,
        opportunityWorkInputWithEngine(
          uuid(123),
          "Missing runtime evidence",
          missingProvenance,
          "RJOPP023",
          "runtime-missing-engine",
        ),
      );
      await repo.upsertWork(
        localActor,
        opportunityWorkInputWithEngine(
          uuid(124),
          "Extract adapter matrix only",
          extractOnlyProvenance,
          "RJOPP024",
          "extract-adapter-matrix-engine",
        ),
      );

      const model = await repo.catalogOpportunityRanking(localActor, { limit: 20 });
      const present = requiredTestRow(model.rows, uuid(121));
      const partial = requiredTestRow(model.rows, uuid(122));
      const missing = requiredTestRow(model.rows, uuid(123));
      const extractOnly = requiredTestRow(model.rows, uuid(124));

      expect(present.runtimeEvidenceReadiness).toMatchObject({
        status: "private_local_aggregate",
        privateLocalAggregateEvidenceCount: 1,
      });
      expect(partial.runtimeEvidenceReadiness).toMatchObject({
        status: "partial_private_local_aggregate",
        privateLocalAggregateEvidenceCount: 0.5,
      });
      expect(missing.runtimeEvidenceReadiness).toMatchObject({
        status: "unknown",
        publicFixtureEvidenceCount: 0,
        privateLocalAggregateEvidenceCount: 0,
      });
      expect(extractOnly.runtimeEvidenceReadiness).toMatchObject({
        status: "unknown",
        publicFixtureEvidenceCount: 0,
        privateLocalAggregateEvidenceCount: 0,
      });
      expect(factorScore(present, "runtime_evidence_readiness")).toBeGreaterThan(
        factorScore(partial, "runtime_evidence_readiness"),
      );
      expect(factorScore(partial, "runtime_evidence_readiness")).toBeGreaterThan(0);
      expect(factorScore(missing, "runtime_evidence_readiness")).toBe(0);
      expect(factorScore(extractOnly, "runtime_evidence_readiness")).toBe(0);
      expect(missing.explanationCodes).toContain("runtime_evidence_readiness:unknown");
      expect(extractOnly.explanationCodes).toContain("runtime_evidence_readiness:unknown");
    } finally {
      await context.close();
    }
  });

  it("does not emit public opportunity rows for private-local-only works", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const capabilityRepo = new EngineCapabilityReportRepository(context.db);
      const provenance = await recordOpportunityProvenance(repo);
      await recordOpportunityCapability(capabilityRepo);
      const privateOnlyWorkId = uuid(130);

      await repo.upsertWork(localActor, {
        workId: privateOnlyWorkId,
        canonicalTitle: "PRIVATE_LOCAL_ONLY_SENTINEL_TITLE",
        originalLanguage: "ja-JP",
        engine: {
          engineName: "rpg-maker-mv",
          engineSource: catalogEngineSourceValues.localScan,
          engineConfidence: catalogConfidenceValues.medium,
          engineProvenanceId: provenance.localPrivate.sourceProvenanceId,
        },
        languageStatuses: [
          languageStatus(430, catalogLanguageStatusValues.none, provenance.localPrivate),
        ],
      });
      await repo.recordLocalScan(localActor, {
        localScanId: uuid(730),
        scanRootLabel: "private local opportunity fixture",
        scanRootPathHash: hash("/home/private/private-local-only-root"),
        scannerName: "catalog-opportunity-ranking-test",
        scannerVersion: "0.0.0",
        startedAt: fetchedAt,
        completedAt: "2026-06-27T12:04:00.000Z",
        entries: [
          {
            ...localScanEntry(
              731,
              privateOnlyWorkId,
              provenance.localPrivate,
              "/home/private/PRIVATE_LOCAL_ONLY_SENTINEL_TITLE.zip/story.ks",
            ),
            metadata: {
              title: "PRIVATE_LOCAL_ONLY_SENTINEL_TITLE",
              rawText: "PRIVATE_LOCAL_ONLY_SENTINEL_BODY",
            },
          },
        ],
      });

      const model = await repo.catalogOpportunityRanking(localActor, {
        includeDemoted: true,
        limit: 20,
      });
      const payload = JSON.stringify(model);
      expect(model.rows.map((row) => row.workId)).not.toContain(privateOnlyWorkId);
      expect(payload).not.toContain("PRIVATE_LOCAL_ONLY_SENTINEL_TITLE");
      expect(payload).not.toContain("PRIVATE_LOCAL_ONLY_SENTINEL_BODY");
    } finally {
      await context.close();
    }
  });

  it("scopes platform-language conflict demotion to the requested target language", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const capabilityRepo = new EngineCapabilityReportRepository(context.db);
      await recordOpportunityCapability(capabilityRepo);
      const publicProvenance = await provenance(repo, 24, catalogSourceValues.dlsite, "RJOPP024");
      const workId = uuid(124);
      const conflictId = uuid(924);
      const input = opportunityWorkInputWithEngine(
        workId,
        "Off-target conflict candidate",
        publicProvenance,
        "RJOPP024",
        "rpg-maker-mv",
      );

      await repo.upsertWork(localActor, {
        ...input,
        languageStatuses: [
          ...(input.languageStatuses ?? []),
          {
            ...languageStatus(425, catalogLanguageStatusValues.none, publicProvenance),
            language: "fr-FR",
          },
        ],
        conflicts: [
          {
            conflictId,
            conflictKind: catalogConflictKindValues.languageStatus,
            status: catalogConflictStatusValues.open,
            summary: "Synthetic French platform conflict",
            detectedAt: fetchedAt,
            metadata: {
              reasonCode: catalogPlatformLanguageConflictReasonCode,
              severity: "warning",
              targetLanguage: "fr-FR",
              platformScope: "pc",
            },
          },
        ],
      });

      const englishModel = await repo.catalogOpportunityRanking(localActor, {
        targetLanguage: "en-US",
        limit: 20,
      });
      const englishRow = requiredTestRow(englishModel.rows, workId);
      expect(englishRow.decision).toBe("candidate");
      expect(englishRow.demotions).toEqual([]);
      expect(englishRow.explanationCodes).toContain("platform_language_conflict:none");

      const frenchModel = await repo.catalogOpportunityRanking(localActor, {
        targetLanguage: "fr-FR",
        includeDemoted: true,
        limit: 20,
      });
      const frenchRow = requiredTestRow(frenchModel.rows, workId);
      expect(frenchRow.decision).toBe("demoted");
      expect(frenchRow.demotions).toEqual([
        expect.objectContaining({
          conflictId,
          reasonCode: catalogPlatformLanguageConflictReasonCode,
        }),
      ]);
    } finally {
      await context.close();
    }
  });
});
