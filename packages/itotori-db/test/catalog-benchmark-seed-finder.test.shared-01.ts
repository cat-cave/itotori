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

export async function recordCapabilityMatrices(
  repo: EngineCapabilityReportRepository,
): Promise<void> {
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
  await repo.writeMatrix(localActor, {
    adapterId: "ambiguous-engine-alpha",
    identify: { kind: "supported" },
    inventory: { kind: "supported" },
    extract: { kind: "supported" },
    patch: { kind: "supported" },
  });
  await repo.writeMatrix(localActor, {
    adapterId: "ambiguous-engine-beta",
    identify: { kind: "supported" },
    inventory: { kind: "supported" },
    extract: { kind: "unsupported", reason: "beta extractor not available" },
    patch: { kind: "unsupported", reason: "beta patcher not available" },
  });
  await repo.writeMatrix(localActor, {
    adapterId: "patch-only-engine",
    identify: { kind: "supported" },
    inventory: { kind: "unsupported", reason: "inventory fixture unavailable" },
    extract: { kind: "supported" },
    patch: { kind: "supported" },
  });
}

export async function recordAmbiguousAdapterWork(
  repo: ItotoriCatalogRepository,
  provenanceRecord: CatalogSourceProvenanceRecord,
): Promise<string> {
  const workId = uuid(106);
  await repo.upsertWork(localActor, {
    workId,
    canonicalTitle: "Benchmark ambiguous adapter",
    originalLanguage: "ja-JP",
    engine: {
      engineName: "ambiguous-engine",
      engineSource: catalogEngineSourceValues.manual,
      engineConfidence: catalogConfidenceValues.medium,
      engineProvenanceId: provenanceRecord.sourceProvenanceId,
    },
    externalIds: [externalId(206, provenanceRecord, "RJAMBIG")],
    languageStatuses: [languageStatus(406, catalogLanguageStatusValues.none, provenanceRecord)],
  });
  return workId;
}

export async function recordPatchOnlyCapabilityBait(
  repo: ItotoriCatalogRepository,
  provenanceRecord: CatalogSourceProvenanceRecord,
): Promise<string> {
  const workId = uuid(107);
  await repo.upsertWork(localActor, {
    workId,
    canonicalTitle: "AAA Benchmark patch-only bait",
    originalLanguage: "ja-JP",
    engine: {
      engineName: "patch-only-engine",
      engineSource: catalogEngineSourceValues.manual,
      engineConfidence: catalogConfidenceValues.high,
      engineProvenanceId: provenanceRecord.sourceProvenanceId,
    },
    externalIds: [externalId(207, provenanceRecord, "RJPATCHBAIT")],
    languageStatuses: [languageStatus(407, catalogLanguageStatusValues.none, provenanceRecord)],
    demandFacts: [
      demandFact(507, provenanceRecord, "RJPATCHBAIT", catalogDemandFactKindValues.dlCount, {
        count: 50_000,
      }),
    ],
  });
  await repo.recordLocalScan(localActor, {
    localScanId: uuid(800),
    scanRootLabel: "benchmark patch-only bait fixture",
    scanRootPathHash: hash("/home/private/patch-only-bait-root"),
    scannerName: "catalog-benchmark-seed-test",
    scannerVersion: "0.0.0",
    startedAt: fetchedAt,
    completedAt: "2026-06-27T12:04:00.000Z",
    entries: [
      {
        localScanEntryId: uuid(801),
        workId,
        pathHash: hash("/home/private/RJPATCHBAIT.zip/story.ks"),
        pathRedactionClass: catalogPathRedactionClassValues.privatePathHash,
        owned: true,
        engineName: "patch-only-engine",
        engineSource: catalogEngineSourceValues.localScan,
        engineConfidence: catalogConfidenceValues.high,
        sourceProvenanceId: provenanceRecord.sourceProvenanceId,
      },
    ],
  });
  return workId;
}

export async function recordSeedFinderCatalog(
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
      demandFact(503, provenance.vndb, "vSeedFan", catalogDemandFactKindValues.ratingSummary, {
        count: 320,
        mean: 4.2,
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

export async function recordSeedFinderProvenance(
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

export async function provenance(
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

export function externalId(
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

export function release(
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

export function languageStatus(
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
