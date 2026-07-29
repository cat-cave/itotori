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

export function uuid(id: number): string {
  return `019ed104-0000-7000-8000-${String(id).padStart(12, "0")}`;
}

export function hash(input: string): string {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

export async function recordOpportunityCapability(
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

export async function recordRuntimeEvidenceCapability(
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

export async function recordExtractAdapterMatrixCapability(
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

export async function recordOpportunityCatalog(
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

export function opportunityWorkInput(
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

export function opportunityWorkInputWithEngine(
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

export async function recordOpportunityProvenance(
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

export async function provenance(
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
    parserVersion: "catalog-opportunity-ranking-test.v0.1",
    rawContentRedactionClass: catalogRawContentRedactionClassValues.publicMetadata,
  };
}

export function demandFact(
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

export function localScanEntry(
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
