import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import {
  capabilityEvidenceLabelValues,
  EngineCapabilityReportRepository,
} from "../src/repositories/engine-capability-report-repository.js";
import {
  type CatalogOpportunityFactorName,
  type CatalogOpportunityRankingReadModel,
  ItotoriCatalogRepository,
  type CatalogSourceProvenanceRecord,
} from "../src/repositories/catalog-repository.js";
import { catalogPlatformLanguageConflictReasonCode } from "../src/services/catalog-platform-language-conflicts.js";
import {
  capabilityLevelValues,
  catalogConfidenceValues,
  catalogConflictKindValues,
  catalogConflictStatusValues,
  catalogConflictSubjectKindValues,
  catalogDemandFactKindValues,
  catalogEngineSourceValues,
  catalogExternalIdKindValues,
  catalogLanguageStatusValues,
  catalogPathRedactionClassValues,
  catalogRawContentRedactionClassValues,
  catalogReleaseKindValues,
  catalogSourceRecordKindValues,
  catalogSourceValues,
  engineCapabilityEvidenceKindValues,
  engineCapabilityEvidenceSourceValues,
  engineCapabilityEvidenceStatusValues,
  type EngineCapabilityEvidenceStatus,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };
const fetchedAt = "2026-06-27T12:00:00.000Z";

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

async function recordOpportunityCapability(repo: EngineCapabilityReportRepository): Promise<void> {
  await repo.writeMatrix(localActor, {
    adapterId: "rpg-maker-mv",
    identify: { kind: "supported" },
    inventory: { kind: "supported" },
    extract: { kind: "supported" },
    patch: { kind: "supported" },
  });
  await repo.writeMatrix(localActor, {
    adapterId: "identify-only-engine",
    identify: { kind: "supported" },
    inventory: { kind: "unsupported", reason: "inventory fixture unavailable" },
    extract: { kind: "unsupported", reason: "extract fixture unavailable" },
    patch: { kind: "unsupported", reason: "patch fixture unavailable" },
  });
  await repo.recordCapabilityEvidence(localActor, {
    adapterId: "rpg-maker-mv",
    level: capabilityLevelValues.extract,
    evidenceSource: engineCapabilityEvidenceSourceValues.publicFixture,
    evidenceKind: engineCapabilityEvidenceKindValues.adapterMatrix,
    schemaVersion: "catalog.capability_evidence.v0.1",
    status: engineCapabilityEvidenceStatusValues.present,
    aggregateCounts: { fixture_rows: 1 },
    evidenceLabels: [capabilityEvidenceLabelValues.publicFixtureMatrix],
    publicFixtureId: "catalog-opportunity-ranking-rpg-maker-mv",
  });
  await repo.recordCapabilityEvidence(localActor, {
    adapterId: "rpg-maker-mv",
    level: capabilityLevelValues.extract,
    evidenceSource: engineCapabilityEvidenceSourceValues.privateLocalAggregate,
    evidenceKind: engineCapabilityEvidenceKindValues.localCorpusSidecar,
    schemaVersion: "catalog.local_corpus_engine_evidence.v0.1",
    status: engineCapabilityEvidenceStatusValues.present,
    aggregateCounts: { marker_kinds: 2 },
    evidenceLabels: [capabilityEvidenceLabelValues.localCorpusMarkerEvidence],
  });
}

async function recordRuntimeEvidenceCapability(
  repo: EngineCapabilityReportRepository,
  adapterId: string,
  status: EngineCapabilityEvidenceStatus,
): Promise<void> {
  await repo.writeMatrix(localActor, {
    adapterId,
    identify: { kind: "supported" },
    inventory: { kind: "supported" },
    extract: { kind: "supported" },
    patch: { kind: "supported" },
  });
  await repo.recordCapabilityEvidence(localActor, {
    adapterId,
    level: capabilityLevelValues.extract,
    evidenceSource: engineCapabilityEvidenceSourceValues.privateLocalAggregate,
    evidenceKind: engineCapabilityEvidenceKindValues.localCorpusSidecar,
    schemaVersion: "catalog.local_corpus_engine_evidence.v0.1",
    status,
    aggregateCounts: {
      marker_kinds: status === engineCapabilityEvidenceStatusValues.missing ? 0 : 1,
    },
    evidenceLabels: [capabilityEvidenceLabelValues.localCorpusMarkerEvidence],
  });
}

async function recordExtractAdapterMatrixCapability(
  repo: EngineCapabilityReportRepository,
  adapterId: string,
): Promise<void> {
  await repo.writeMatrix(localActor, {
    adapterId,
    identify: { kind: "supported" },
    inventory: { kind: "supported" },
    extract: { kind: "supported" },
    patch: { kind: "supported" },
  });
  await repo.recordCapabilityEvidence(localActor, {
    adapterId,
    level: capabilityLevelValues.extract,
    evidenceSource: engineCapabilityEvidenceSourceValues.publicFixture,
    evidenceKind: engineCapabilityEvidenceKindValues.adapterMatrix,
    schemaVersion: "catalog.capability_evidence.v0.1",
    status: engineCapabilityEvidenceStatusValues.present,
    aggregateCounts: { fixture_rows: 1 },
    evidenceLabels: [capabilityEvidenceLabelValues.publicFixtureMatrix],
    publicFixtureId: `catalog-opportunity-ranking-${adapterId}`,
  });
}

async function recordOpportunityCatalog(
  repo: ItotoriCatalogRepository,
  provenance: Record<
    "dlsite1" | "dlsite2" | "vndb" | "conflict" | "localPrivate",
    CatalogSourceProvenanceRecord
  >,
): Promise<{
  tieAlpha: string;
  tieBeta: string;
  partial: string;
  conflict: string;
  conflictId: string;
}> {
  const tieAlpha = uuid(101);
  const tieBeta = uuid(102);
  const partial = uuid(103);
  const conflict = uuid(104);
  const conflictId = uuid(900);

  await repo.upsertWork(
    localActor,
    opportunityWorkInput(tieAlpha, "Alpha tie candidate", provenance.dlsite1, "RJOPP001"),
  );
  await repo.upsertWork(
    localActor,
    opportunityWorkInput(tieBeta, "Beta tie candidate", provenance.dlsite2, "RJOPP002"),
  );
  await repo.upsertWork(localActor, {
    workId: partial,
    canonicalTitle: "Partial adapter candidate",
    originalLanguage: "ja-JP",
    engine: {
      engineName: "identify-only-engine",
      engineSource: catalogEngineSourceValues.vndb,
      engineConfidence: catalogConfidenceValues.medium,
      engineProvenanceId: provenance.vndb.sourceProvenanceId,
    },
    externalIds: [externalId(203, provenance.vndb, "vOppPartial")],
    languageStatuses: [
      languageStatus(403, catalogLanguageStatusValues.fanPartial, provenance.vndb),
    ],
    demandFacts: [
      demandFact(540, provenance.vndb, "vOppPartial", catalogDemandFactKindValues.ratingSummary, {
        count: 300,
        average: 4.1,
      }),
    ],
  });
  await repo.upsertWork(localActor, {
    ...opportunityWorkInput(conflict, "Conflict demand candidate", provenance.conflict, "RJOPP004"),
    conflicts: [
      {
        conflictId,
        conflictKind: catalogConflictKindValues.languageStatus,
        status: catalogConflictStatusValues.open,
        summary: "Synthetic official English platform conflict",
        detectedAt: fetchedAt,
        metadata: {
          reasonCode: catalogPlatformLanguageConflictReasonCode,
          severity: "warning",
          targetLanguage: "en-US",
          platformScope: "pc",
          sources: [
            { catalogSource: catalogSourceValues.dlsite, sourceId: "RJOPP004" },
            { catalogSource: catalogSourceValues.steam, sourceId: "steam:RJOPP004" },
          ],
        },
        evidence: [
          {
            conflictEvidenceId: uuid(901),
            subjectKind: catalogConflictSubjectKindValues.work,
            subjectId: conflict,
            sourceProvenanceId: provenance.conflict.sourceProvenanceId,
            evidencePosition: 0,
          },
        ],
      },
    ],
  });

  await repo.recordLocalScan(localActor, {
    localScanId: uuid(700),
    scanRootLabel: "opportunity aggregate fixture",
    scanRootPathHash: hash("/home/private/opportunity-root"),
    scannerName: "catalog-opportunity-ranking-test",
    scannerVersion: "0.0.0",
    startedAt: fetchedAt,
    completedAt: "2026-06-27T12:03:00.000Z",
    entries: [
      localScanEntry(701, tieAlpha, provenance.localPrivate, "/home/private/RJOPP001.zip/story.ks"),
      localScanEntry(702, tieBeta, provenance.localPrivate, "/tmp/private/RJOPP002.zip/story.ks"),
      {
        ...localScanEntry(703, conflict, provenance.localPrivate, "C:\\private\\RJOPP004.zip"),
        metadata: {
          localScanEntryId: "local-scan-entry-secret",
          title: "private-story-title",
          rawText: "SECRET_KEY",
          archiveMember: "RJOPP004.zip/story.ks",
        },
      },
    ],
  });

  return { tieAlpha, tieBeta, partial, conflict, conflictId };
}

function opportunityWorkInput(
  workId: string,
  canonicalTitle: string,
  provenanceRecord: CatalogSourceProvenanceRecord,
  sourceId: string,
): Parameters<ItotoriCatalogRepository["upsertWork"]>[1] {
  return {
    workId,
    canonicalTitle,
    originalLanguage: "ja-JP",
    engine: {
      engineName: "rpg-maker-mv",
      engineSource: catalogEngineSourceValues.dlsiteWorktypeInferred,
      engineConfidence: catalogConfidenceValues.high,
      engineProvenanceId: provenanceRecord.sourceProvenanceId,
    },
    externalIds: [externalId(Number(sourceId.slice(-3)) + 200, provenanceRecord, sourceId)],
    releases: [
      release(Number(sourceId.slice(-3)) + 300, provenanceRecord, sourceId, canonicalTitle),
    ],
    languageStatuses: [
      languageStatus(
        Number(sourceId.slice(-3)) + 400,
        catalogLanguageStatusValues.none,
        provenanceRecord,
      ),
    ],
    demandFacts: [
      demandFact(
        Number(sourceId.slice(-3)) + 500,
        provenanceRecord,
        sourceId,
        catalogDemandFactKindValues.dlCount,
        {
          count: 12_000,
        },
      ),
      demandFact(
        Number(sourceId.slice(-3)) + 510,
        provenanceRecord,
        sourceId,
        catalogDemandFactKindValues.wishlistCount,
        {
          count: 7_000,
        },
      ),
      demandFact(
        Number(sourceId.slice(-3)) + 520,
        provenanceRecord,
        sourceId,
        catalogDemandFactKindValues.rank,
        {
          rank: 8,
        },
      ),
      demandFact(
        Number(sourceId.slice(-3)) + 530,
        provenanceRecord,
        sourceId,
        catalogDemandFactKindValues.ratingSummary,
        {
          average: 4.6,
          count: 500,
        },
      ),
      demandFact(
        Number(sourceId.slice(-3)) + 540,
        provenanceRecord,
        sourceId,
        catalogDemandFactKindValues.workType,
        {
          workType: "RPG",
        },
      ),
    ],
  };
}

function opportunityWorkInputWithEngine(
  workId: string,
  canonicalTitle: string,
  provenanceRecord: CatalogSourceProvenanceRecord,
  sourceId: string,
  engineName: string,
): Parameters<ItotoriCatalogRepository["upsertWork"]>[1] {
  const input = opportunityWorkInput(workId, canonicalTitle, provenanceRecord, sourceId);
  if (input.engine === undefined) {
    throw new Error("opportunityWorkInput should include engine metadata");
  }
  return {
    ...input,
    engine: {
      ...input.engine,
      engineName,
    },
  };
}

async function recordOpportunityProvenance(
  repo: ItotoriCatalogRepository,
): Promise<
  Record<
    "dlsite1" | "dlsite2" | "vndb" | "conflict" | "localPrivate",
    CatalogSourceProvenanceRecord
  >
> {
  const dlsite1 = await provenance(repo, 1, catalogSourceValues.dlsite, "RJOPP001");
  const dlsite2 = await provenance(repo, 2, catalogSourceValues.dlsite, "RJOPP002");
  const vndb = await provenance(repo, 3, catalogSourceValues.vndb, "vOppPartial");
  const conflict = await provenance(repo, 4, catalogSourceValues.dlsite, "RJOPP004");
  const localPrivate = await repo.recordSourceProvenance(localActor, {
    sourceProvenanceId: uuid(5),
    catalogSource: catalogSourceValues.localCorpus,
    sourceRecordKind: catalogSourceRecordKindValues.localScan,
    sourceId: "private-local-opportunity-source",
    sourceVersion: "private-local-opportunity-v1",
    ok: true,
    rawContentRedactionClass: catalogRawContentRedactionClassValues.privateCorpus,
    payload: { rawText: "file:/home/private/private-story-title.zip" },
    fetchedAt,
    metadata: { rawPayloadSecret: "file:/tmp/private/local-scan-entry-secret.zip" },
  });
  return { dlsite1, dlsite2, vndb, conflict, localPrivate };
}

async function provenance(
  repo: ItotoriCatalogRepository,
  id: number,
  catalogSource: (typeof catalogSourceValues)[keyof typeof catalogSourceValues],
  sourceId: string,
): Promise<CatalogSourceProvenanceRecord> {
  return repo.recordSourceProvenance(localActor, {
    sourceProvenanceId: uuid(id),
    catalogSource,
    sourceRecordKind: catalogSourceRecordKindValues.recordedFixture,
    sourceId,
    sourceVersion: "catalog-opportunity-ranking-fixture-v1",
    requestId: `fixture:${catalogSource}:${sourceId}`,
    httpStatus: 200,
    ok: true,
    payloadHash: hash(`${catalogSource}:${sourceId}`),
    rawContentRedactionClass: catalogRawContentRedactionClassValues.publicMetadata,
    payload: { catalogSource, sourceId },
    fetchedAt,
    metadata: { fixtureId: `catalog-opportunities/${sourceId}.json` },
  });
}

function externalId(
  id: number,
  provenanceRecord: CatalogSourceProvenanceRecord,
  sourceId: string,
): NonNullable<Parameters<ItotoriCatalogRepository["upsertWork"]>[1]["externalIds"]>[number] {
  return {
    externalIdId: uuid(id),
    catalogSource: provenanceRecord.catalogSource,
    sourceId,
    externalIdKind: catalogExternalIdKindValues.storeProduct,
    sourceProvenanceId: provenanceRecord.sourceProvenanceId,
    confidence: catalogConfidenceValues.high,
  };
}

function release(
  id: number,
  provenanceRecord: CatalogSourceProvenanceRecord,
  sourceReleaseId: string,
  title: string,
): NonNullable<Parameters<ItotoriCatalogRepository["upsertWork"]>[1]["releases"]>[number] {
  return {
    releaseId: uuid(id),
    catalogSource: provenanceRecord.catalogSource,
    sourceReleaseId,
    releaseTitle: title,
    releaseKind: catalogReleaseKindValues.original,
    platform: "pc",
    language: "ja-JP",
    releaseYear: 2024,
    sourceProvenanceId: provenanceRecord.sourceProvenanceId,
  };
}

function languageStatus(
  id: number,
  status: (typeof catalogLanguageStatusValues)[keyof typeof catalogLanguageStatusValues],
  provenanceRecord: CatalogSourceProvenanceRecord,
): NonNullable<Parameters<ItotoriCatalogRepository["upsertWork"]>[1]["languageStatuses"]>[number] {
  return {
    languageStatusId: uuid(id),
    language: "en-US",
    status,
    sourceProvenanceId: provenanceRecord.sourceProvenanceId,
    confidence: catalogConfidenceValues.high,
    observedAt: fetchedAt,
    importedAt: fetchedAt,
    parserVersion: "catalog-opportunity-ranking-test.v0.1",
    rawContentRedactionClass: catalogRawContentRedactionClassValues.publicMetadata,
  };
}

function demandFact(
  id: number,
  provenanceRecord: CatalogSourceProvenanceRecord,
  sourceId: string,
  factKind: (typeof catalogDemandFactKindValues)[keyof typeof catalogDemandFactKindValues],
  factValue: Record<string, unknown>,
): NonNullable<Parameters<ItotoriCatalogRepository["upsertWork"]>[1]["demandFacts"]>[number] {
  return {
    demandFactId: uuid(id),
    catalogSource: provenanceRecord.catalogSource,
    sourceId,
    factKind,
    factValue,
    sourceProvenanceId: provenanceRecord.sourceProvenanceId,
    observedAt: fetchedAt,
    parserVersion: "catalog-opportunity-ranking-test.v0.1",
    metadata: { sourceField: factKind },
  };
}

function localScanEntry(
  id: number,
  workId: string,
  provenanceRecord: CatalogSourceProvenanceRecord,
  privatePath: string,
): NonNullable<Parameters<ItotoriCatalogRepository["recordLocalScan"]>[1]["entries"]>[number] {
  return {
    localScanEntryId: uuid(id),
    workId,
    pathHash: hash(privatePath),
    pathRedactionClass: catalogPathRedactionClassValues.privatePathHash,
    owned: true,
    engineName: "rpg-maker-mv",
    engineSource: catalogEngineSourceValues.localScan,
    engineConfidence: catalogConfidenceValues.medium,
    sourceProvenanceId: provenanceRecord.sourceProvenanceId,
    signals: { rawText: `file:${privatePath}` },
  };
}

function uuid(id: number): string {
  return `019ed104-0000-7000-8000-${String(id).padStart(12, "0")}`;
}

function hash(input: string): string {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

function requiredTestRow(
  rows: CatalogOpportunityRankingReadModel["rows"],
  workId: string,
): CatalogOpportunityRankingReadModel["rows"][number] {
  const row = rows.find((candidate) => candidate.workId === workId);
  if (row === undefined) {
    throw new Error(`expected opportunity row ${workId}`);
  }
  return row;
}

function factorScore(
  row: CatalogOpportunityRankingReadModel["rows"][number],
  factorName: CatalogOpportunityFactorName,
): number {
  const factor = row.factorBreakdown.find((entry) => entry.factor === factorName);
  if (factor === undefined) {
    throw new Error(`expected factor ${factorName}`);
  }
  return factor.weightedScore;
}

function expectSerializedSafe(readModel: CatalogOpportunityRankingReadModel): void {
  const payload = JSON.stringify(readModel);
  for (const forbidden of [
    "/home",
    "/tmp",
    "/scratch",
    "C:\\",
    "file:",
    ".zip",
    ".ks",
    "pathHash",
    "localScanEntryId",
    "rawText",
    "SECRET_KEY",
    "screenshot",
    "private-story-title",
    "local-scan-entry-secret",
    hash("/home/private/RJOPP001.zip/story.ks"),
  ]) {
    expect(payload).not.toContain(forbidden);
  }
}
