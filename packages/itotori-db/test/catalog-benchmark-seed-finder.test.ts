import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import { EngineCapabilityReportRepository } from "../src/repositories/engine-capability-report-repository.js";
import {
  type CatalogBenchmarkSeedFinderReadModel,
  ItotoriCatalogRepository,
  type CatalogSourceProvenanceRecord,
} from "../src/repositories/catalog-repository.js";
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
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };
const fetchedAt = "2026-06-27T12:00:00.000Z";
const publicSeedFinderFixture = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/catalog-benchmark-seeds/fixture.json", import.meta.url),
    "utf8",
  ),
) as {
  expectedDefaultReadModel: Omit<CatalogBenchmarkSeedFinderReadModel, "generatedAt"> & {
    generatedAt: string;
  };
  publicLeakagePolicy: { forbiddenSubstrings: string[] };
};

describe("catalogBenchmarkSeedFinder", () => {
  it("returns readiness-aware aggregate-safe benchmark seeds with deterministic ranking and filters", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const capabilityRepo = new EngineCapabilityReportRepository(context.db);
      const provenance = await recordSeedFinderProvenance(repo);
      await recordCapabilityMatrices(capabilityRepo);
      const ids = await recordSeedFinderCatalog(repo, provenance);

      const readModel = await repo.catalogBenchmarkSeedFinder(localActor, { limit: 20 });
      expect(readModel.schemaVersion).toBe("catalog.benchmark_seed_finder.v0.1");
      expect(
        normalizeBenchmarkSeedReadModel(
          readModel,
          publicSeedFinderFixture.expectedDefaultReadModel.generatedAt,
        ),
      ).toEqual(publicSeedFinderFixture.expectedDefaultReadModel);
      expect(readModel.rows.map((row) => row.workId)).toContain(ids.noEnglishOwned);
      expect(readModel.rows.map((row) => row.workId)).toContain(ids.fanPartialIdentifyOnly);
      expect(readModel.rows.map((row) => row.workId)).toContain(ids.mtlPartialExtract);
      expect(readModel.rows.map((row) => row.workId)).not.toContain(ids.conflict);

      const rankedIds = readModel.rows.map((row) => row.workId);
      expect(rankedIds.indexOf(ids.noEnglishOwned)).toBeLessThan(
        rankedIds.indexOf(ids.fanPartialIdentifyOnly),
      );

      const noEnglishOwned = requiredTestRow(
        readModel.rows.filter((row) => row.workId === ids.noEnglishOwned),
        "owned no-English seed",
      );
      expect(noEnglishOwned).toMatchObject({
        completenessPool: "no_english",
        decision: "seed",
        seedRank: 1,
        localOwnership: "owned",
        localEvidenceCount: 2,
        demandBucket: "very_high",
        readiness: {
          adapterId: "rpg-maker-mv",
          identify: "supported",
          inventory: "supported",
          extract: "supported",
          patch: "supported",
          helper: "unknown",
          runtime: "unknown",
        },
      });
      expect(noEnglishOwned.sourceIds).toEqual([
        {
          catalogSource: catalogSourceValues.dlsite,
          sourceId: "RJSEED001",
          externalIdKind: catalogExternalIdKindValues.storeProduct,
        },
      ]);
      expect(noEnglishOwned.provenance).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            catalogSource: catalogSourceValues.dlsite,
            sourceId: "RJSEED001",
            fixtureId: "catalog-benchmark-seeds/dlsite/RJSEED001.json",
            redactionClass: catalogRawContentRedactionClassValues.publicMetadata,
          }),
        ]),
      );
      expect(noEnglishOwned.explanationCodes).toEqual(
        expect.arrayContaining([
          "demand_bucket:very_high",
          "helper_readiness_unknown",
          "local_ownership:owned",
          "pool:no_english",
          "runtime_readiness_unknown",
        ]),
      );

      const fanPartial = requiredTestRow(
        readModel.rows.filter((row) => row.workId === ids.fanPartialIdentifyOnly),
        "fan-partial row",
      );
      expect(fanPartial).toMatchObject({
        completenessPool: "fan_partial",
        decision: "candidate",
        demandBucket: "medium",
        readiness: expect.objectContaining({
          identify: "supported",
          inventory: "unsupported",
          extract: "unsupported",
          patch: "unsupported",
        }),
      });

      const mtlPartial = requiredTestRow(
        readModel.rows.filter((row) => row.workId === ids.mtlPartialExtract),
        "MTL partial row",
      );
      expect(mtlPartial).toMatchObject({
        completenessPool: "mtl_only",
        decision: "candidate",
        readiness: expect.objectContaining({ extract: "partial" }),
      });

      const extractReady = await repo.catalogBenchmarkSeedFinder(localActor, {
        minCapabilityLevel: capabilityLevelValues.extract,
        limit: 20,
      });
      expect(extractReady.rows.map((row) => row.workId)).toContain(ids.noEnglishOwned);
      expect(extractReady.rows.map((row) => row.workId)).not.toContain(ids.fanPartialIdentifyOnly);
      expect(extractReady.rows.map((row) => row.workId)).not.toContain(ids.mtlPartialExtract);

      const localOwned = await repo.catalogBenchmarkSeedFinder(localActor, {
        localOwnership: "owned",
        limit: 20,
      });
      expect(localOwned.rows.map((row) => row.workId)).toEqual([ids.noEnglishOwned]);

      const veryHighDemand = await repo.catalogBenchmarkSeedFinder(localActor, {
        demandBucket: "very_high",
        limit: 20,
      });
      expect(veryHighDemand.rows.map((row) => row.workId)).toEqual([ids.noEnglishOwned]);

      const noEnglish = await repo.catalogBenchmarkSeedFinder(localActor, {
        translationCompleteness: [catalogLanguageStatusValues.none],
        limit: 20,
      });
      expect(noEnglish.rows.every((row) => row.completenessPool === "no_english")).toBe(true);
    } finally {
      await context.close();
    }
  });

  it("keeps conflicts and unrecorded rows explainable without leaking local corpus details", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const capabilityRepo = new EngineCapabilityReportRepository(context.db);
      const provenance = await recordSeedFinderProvenance(repo);
      await recordCapabilityMatrices(capabilityRepo);
      const ids = await recordSeedFinderCatalog(repo, provenance);

      const withDemotions = await repo.catalogBenchmarkSeedFinder(localActor, {
        includeDemoted: true,
        limit: 20,
      });
      const conflict = requiredTestRow(
        withDemotions.rows.filter((row) => row.workId === ids.conflict),
        "demoted conflict row",
      );
      expect(conflict).toMatchObject({ decision: "demoted" });
      expect(conflict.explanationCodes).toEqual(
        expect.arrayContaining([`demoted_open_conflict:${ids.conflictId}`]),
      );

      const requestedConflict = await repo.catalogBenchmarkSeedFinder(localActor, {
        pools: ["conflict"],
        limit: 20,
      });
      expect(requestedConflict.rows).toEqual([
        expect.objectContaining({
          workId: ids.conflict,
          completenessPool: "conflict",
          decision: "seed",
          explanationCodes: expect.arrayContaining(["conflict_pool_requested"]),
        }),
      ]);

      const withExcluded = await repo.catalogBenchmarkSeedFinder(localActor, {
        provenanceRequired: true,
        includeDemoted: true,
        limit: 20,
      });
      const unrecorded = requiredTestRow(
        withExcluded.rows.filter((row) => row.workId === ids.unrecorded),
        "unrecorded row",
      );
      expect(unrecorded).toMatchObject({ decision: "excluded", provenance: [] });
      expect(unrecorded.explanationCodes).toEqual(
        expect.arrayContaining(["excluded_provenance_required", "unrecorded_or_local_only"]),
      );

      const publicPayload = JSON.stringify(withDemotions);
      for (const forbidden of publicSeedFinderFixture.publicLeakagePolicy.forbiddenSubstrings) {
        expect(publicPayload).not.toContain(forbidden);
      }
      expect(publicPayload).not.toMatch(/\/home|\/tmp|[A-Z]:\\\\|file:|\.zip/u);
      expect(publicPayload).not.toContain("private-story-title");
      expect(publicPayload).not.toContain("local-scan-entry-secret");
      expect(publicPayload).not.toContain("path_hash");
      expect(publicPayload).not.toContain("rawPayloadSecret");
      expect(publicPayload).not.toContain(hash("/home/private/RJSEED001.zip/story.ks"));
    } finally {
      await context.close();
    }
  });
});

async function recordCapabilityMatrices(repo: EngineCapabilityReportRepository): Promise<void> {
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
  await repo.writeMatrix(localActor, {
    adapterId: "partial-extract-engine",
    identify: { kind: "supported" },
    inventory: { kind: "supported" },
    extract: { kind: "partial", limitations: ["text archives require manual split"] },
    patch: { kind: "unsupported", reason: "patch fixture unavailable" },
  });
}

async function recordSeedFinderCatalog(
  repo: ItotoriCatalogRepository,
  provenance: Record<string, CatalogSourceProvenanceRecord>,
): Promise<{
  noEnglishOwned: string;
  fanPartialIdentifyOnly: string;
  mtlPartialExtract: string;
  conflict: string;
  conflictId: string;
  unrecorded: string;
}> {
  const noEnglishOwned = uuid(101);
  const fanPartialIdentifyOnly = uuid(102);
  const mtlPartialExtract = uuid(103);
  const conflict = uuid(104);
  const unrecorded = uuid(105);
  const conflictId = uuid(900);

  await repo.upsertWork(localActor, {
    workId: noEnglishOwned,
    canonicalTitle: "Benchmark no-English owned",
    originalLanguage: "ja-JP",
    engine: {
      engineName: "rpg-maker-mv",
      engineSource: catalogEngineSourceValues.dlsiteWorktypeInferred,
      engineConfidence: catalogConfidenceValues.high,
      engineProvenanceId: provenance.dlsite.sourceProvenanceId,
    },
    externalIds: [externalId(201, provenance.dlsite, "RJSEED001")],
    releases: [release(301, provenance.dlsite, "RJSEED001", "Benchmark no-English owned")],
    languageStatuses: [languageStatus(401, catalogLanguageStatusValues.none, provenance.dlsite)],
    demandFacts: [
      demandFact(501, provenance.dlsite, "RJSEED001", catalogDemandFactKindValues.dlCount, {
        count: 18_420,
      }),
      demandFact(502, provenance.dlsite, "RJSEED001", catalogDemandFactKindValues.wishlistCount, {
        count: 9_321,
      }),
    ],
  });

  await repo.upsertWork(localActor, {
    workId: fanPartialIdentifyOnly,
    canonicalTitle: "Benchmark fan partial identify-only",
    originalLanguage: "ja-JP",
    engine: {
      engineName: "identify-only-engine",
      engineSource: catalogEngineSourceValues.vndb,
      engineConfidence: catalogConfidenceValues.medium,
      engineProvenanceId: provenance.vndb.sourceProvenanceId,
    },
    externalIds: [externalId(202, provenance.vndb, "vSeedFan")],
    languageStatuses: [
      languageStatus(402, catalogLanguageStatusValues.fanPartial, provenance.vndb),
    ],
    demandFacts: [
      demandFact(503, provenance.vndb, "vSeedFan", catalogDemandFactKindValues.dlCount, {
        count: 1_400,
      }),
    ],
  });

  await repo.upsertWork(localActor, {
    workId: mtlPartialExtract,
    canonicalTitle: "Benchmark MTL partial extract",
    originalLanguage: "ja-JP",
    engine: {
      engineName: "partial-extract-engine",
      engineSource: catalogEngineSourceValues.manual,
      engineConfidence: catalogConfidenceValues.medium,
      engineProvenanceId: provenance.dlsiteMtl.sourceProvenanceId,
    },
    externalIds: [externalId(203, provenance.dlsiteMtl, "RJSEED003")],
    languageStatuses: [languageStatus(403, catalogLanguageStatusValues.mtl, provenance.dlsiteMtl)],
    demandFacts: [
      demandFact(504, provenance.dlsiteMtl, "RJSEED003", catalogDemandFactKindValues.rank, {
        rank: 44,
      }),
    ],
  });

  await repo.upsertWork(localActor, {
    workId: conflict,
    canonicalTitle: "Benchmark conflict row",
    originalLanguage: "ja-JP",
    engine: {
      engineName: "rpg-maker-mv",
      engineSource: catalogEngineSourceValues.dlsiteWorktypeInferred,
      engineConfidence: catalogConfidenceValues.high,
      engineProvenanceId: provenance.conflict.sourceProvenanceId,
    },
    externalIds: [externalId(204, provenance.conflict, "RJSEED004")],
    languageStatuses: [languageStatus(404, catalogLanguageStatusValues.none, provenance.conflict)],
    conflicts: [
      {
        conflictId,
        conflictKind: catalogConflictKindValues.languageStatus,
        status: catalogConflictStatusValues.open,
        summary: "Synthetic language status disagreement",
        detectedAt: fetchedAt,
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

  await repo.upsertWork(localActor, {
    workId: unrecorded,
    canonicalTitle: "Benchmark unrecorded local-only",
    originalLanguage: "ja-JP",
    engine: {
      engineName: "rpg-maker-mv",
      engineSource: catalogEngineSourceValues.localScan,
      engineConfidence: catalogConfidenceValues.low,
      engineProvenanceId: provenance.localPrivate.sourceProvenanceId,
    },
    languageStatuses: [
      {
        languageStatusId: uuid(405),
        language: "en-US",
        status: catalogLanguageStatusValues.none,
        confidence: catalogConfidenceValues.low,
        observedAt: fetchedAt,
      },
    ],
  });

  await repo.recordLocalScan(localActor, {
    localScanId: uuid(700),
    scanRootLabel: "benchmark seed local fixture",
    scanRootPathHash: hash("/home/private/benchmark-root"),
    scannerName: "catalog-benchmark-seed-test",
    scannerVersion: "0.0.0",
    startedAt: fetchedAt,
    completedAt: "2026-06-27T12:03:00.000Z",
    entries: [
      {
        localScanEntryId: uuid(701),
        workId: noEnglishOwned,
        pathHash: hash("/home/private/RJSEED001.zip/story.ks"),
        pathRedactionClass: catalogPathRedactionClassValues.privatePathHash,
        owned: true,
        engineName: "rpg-maker-mv",
        engineSource: catalogEngineSourceValues.localScan,
        engineConfidence: catalogConfidenceValues.high,
        sourceProvenanceId: provenance.localPrivate.sourceProvenanceId,
        signals: { rawPayloadSecret: "file:/home/private/RJSEED001.zip" },
        metadata: {
          localScanEntryId: "local-scan-entry-secret",
          title: "private-story-title",
          archiveMember: "RJSEED001.zip/story.ks",
        },
      },
      {
        localScanEntryId: uuid(702),
        workId: noEnglishOwned,
        pathHash: hash("/tmp/private/RJSEED001-copy.zip/data.ks"),
        pathRedactionClass: catalogPathRedactionClassValues.privatePathHash,
        owned: true,
        engineName: "rpg-maker-mv",
        engineSource: catalogEngineSourceValues.localScan,
        engineConfidence: catalogConfidenceValues.medium,
        sourceProvenanceId: provenance.localPrivate.sourceProvenanceId,
      },
      {
        localScanEntryId: uuid(703),
        workId: unrecorded,
        pathHash: hash("C:\\private\\unrecorded.zip"),
        pathRedactionClass: catalogPathRedactionClassValues.privatePathHash,
        owned: false,
        engineName: "rpg-maker-mv",
        engineSource: catalogEngineSourceValues.localScan,
        engineConfidence: catalogConfidenceValues.medium,
        sourceProvenanceId: provenance.localPrivate.sourceProvenanceId,
      },
    ],
  });

  return {
    noEnglishOwned,
    fanPartialIdentifyOnly,
    mtlPartialExtract,
    conflict,
    conflictId,
    unrecorded,
  };
}

async function recordSeedFinderProvenance(
  repo: ItotoriCatalogRepository,
): Promise<
  Record<
    "dlsite" | "vndb" | "dlsiteMtl" | "conflict" | "localPrivate",
    CatalogSourceProvenanceRecord
  >
> {
  const dlsite = await provenance(repo, 1, catalogSourceValues.dlsite, "RJSEED001", {
    fixtureId: "catalog-benchmark-seeds/dlsite/RJSEED001.json",
  });
  const vndb = await provenance(repo, 2, catalogSourceValues.vndb, "vSeedFan", {
    fixtureId: "catalog-benchmark-seeds/vndb/vSeedFan.json",
  });
  const dlsiteMtl = await provenance(repo, 3, catalogSourceValues.dlsite, "RJSEED003", {
    fixtureId: "catalog-benchmark-seeds/dlsite/RJSEED003.json",
  });
  const conflict = await provenance(repo, 4, catalogSourceValues.dlsite, "RJSEED004", {
    fixtureId: "catalog-benchmark-seeds/dlsite/RJSEED004.json",
  });
  const localPrivate = await repo.recordSourceProvenance(localActor, {
    sourceProvenanceId: uuid(5),
    catalogSource: catalogSourceValues.localCorpus,
    sourceRecordKind: catalogSourceRecordKindValues.localScan,
    sourceId: "local-private-source",
    sourceVersion: "private-local-scan-v1",
    ok: true,
    rawContentRedactionClass: catalogRawContentRedactionClassValues.privateCorpus,
    payload: {
      rawPayloadSecret: "file:/home/private/private-story-title.zip",
    },
    fetchedAt,
    metadata: { rawPayloadSecret: "file:/tmp/private/local-scan-entry-secret.zip" },
  });
  return { dlsite, vndb, dlsiteMtl, conflict, localPrivate };
}

async function provenance(
  repo: ItotoriCatalogRepository,
  id: number,
  catalogSource: (typeof catalogSourceValues)[keyof typeof catalogSourceValues],
  sourceId: string,
  options: { fixtureId: string },
): Promise<CatalogSourceProvenanceRecord> {
  return repo.recordSourceProvenance(localActor, {
    sourceProvenanceId: uuid(id),
    catalogSource,
    sourceRecordKind: catalogSourceRecordKindValues.recordedFixture,
    sourceId,
    sourceVersion: "catalog-benchmark-seed-fixture-v1",
    requestId: `fixture:${catalogSource}:${sourceId}`,
    httpStatus: 200,
    ok: true,
    payloadHash: hash(`${catalogSource}:${sourceId}`),
    rawContentRedactionClass: catalogRawContentRedactionClassValues.publicMetadata,
    payload: { catalogSource, sourceId },
    fetchedAt,
    metadata: { fixtureId: options.fixtureId },
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
    parserVersion: "catalog-benchmark-seed-test.v0.1",
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
    parserVersion: "catalog-benchmark-seed-test.v0.1",
    metadata: { sourceField: factKind },
  };
}

function uuid(id: number): string {
  return `019ed104-0000-7000-8000-${String(id).padStart(12, "0")}`;
}

function hash(input: string): string {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

function requiredTestRow<T>(rows: T[], label: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`expected ${label}`);
  }
  return row;
}

function normalizeBenchmarkSeedReadModel(
  readModel: CatalogBenchmarkSeedFinderReadModel,
  generatedAt: string,
): unknown {
  return {
    ...JSON.parse(JSON.stringify(readModel)),
    generatedAt,
  };
}
