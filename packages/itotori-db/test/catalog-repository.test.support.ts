import { createHash } from "node:crypto";

import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import type { ItotoriDatabase } from "../src/connection.js";
import {
  type CatalogOpportunityFactorName,
  type CatalogOpportunityRow,
  ItotoriCatalogRepository,
  type CatalogSourceProvenanceRecord,
} from "../src/repositories/catalog-repository.js";
import {
  capabilityLevelStatusKindValues,
  capabilityLevelValues,
  catalogConfidenceValues,
  catalogEngineSourceValues,
  catalogExternalIdKindValues,
  catalogLanguageStatusValues,
  catalogRawContentRedactionClassValues,
  catalogReleaseKindValues,
  catalogSourceRecordKindValues,
  catalogSourceValues,
  engineCapabilityEvidence,
  engineCapabilityEvidenceKindValues,
  engineCapabilityEvidenceSourceValues,
  engineCapabilityEvidenceStatusValues,
  engineCapabilityReports,
} from "../src/schema.js";

const localActor: AuthorizationActor = { userId: localUserId };
const fetchedAt = "2026-06-17T12:00:00.000Z";

/**
 * Asserts a catalog artifact-mapping validation failure exposes the expected
 * stable machine-readable code (not merely a matching message string), and
 * returns the caught error so callers can additionally assert the message.
 */

export async function recordWorkWithRelease(
  repo: ItotoriCatalogRepository,
  workId: string,
  releaseId: string,
  title: string,
): Promise<void> {
  await repo.upsertWork(localActor, {
    workId,
    canonicalTitle: title,
    originalLanguage: "ja-JP",
    releases: [
      {
        releaseId,
        catalogSource: catalogSourceValues.dlsite,
        sourceReleaseId: releaseId,
        releaseTitle: title,
        releaseKind: catalogReleaseKindValues.original,
        platform: "pc",
        language: "ja-JP",
      },
    ],
  });
}

export async function recordRuntimeReadinessCapabilityEvidence(
  db: ItotoriDatabase,
  input: {
    adapterId: string;
    idBase: number;
    publicFixture: boolean;
    privateLocalAggregate: boolean;
    publicFixtureKind?: (typeof engineCapabilityEvidenceKindValues)[
      | "keyValidation"
      | "adapterMatrix"];
  },
): Promise<void> {
  await db.insert(engineCapabilityReports).values(
    Object.values(capabilityLevelValues).map((level, index) => ({
      engineCapabilityReportId: uuid(input.idBase + index),
      adapterId: input.adapterId,
      level,
      statusKind: capabilityLevelStatusKindValues.supported,
      limitations: [],
      reason: null,
    })),
  );

  const evidenceRows: (typeof engineCapabilityEvidence.$inferInsert)[] = [];
  if (input.publicFixture) {
    evidenceRows.push({
      engineCapabilityEvidenceId: uuid(input.idBase + 10),
      adapterId: input.adapterId,
      level: capabilityLevelValues.extract,
      evidenceSource: engineCapabilityEvidenceSourceValues.publicFixture,
      evidenceKind: input.publicFixtureKind ?? engineCapabilityEvidenceKindValues.keyValidation,
      schemaVersion: "catalog.capability_evidence.v0.1",
      status: engineCapabilityEvidenceStatusValues.present,
      aggregateCounts: { fixture_rows: 1 },
      evidenceLabels: [],
      limitations: [],
      publicFixtureId: `${input.adapterId}-runtime-fixture`,
    });
  }
  if (input.privateLocalAggregate) {
    evidenceRows.push({
      engineCapabilityEvidenceId: uuid(input.idBase + 11),
      adapterId: input.adapterId,
      level: capabilityLevelValues.extract,
      evidenceSource: engineCapabilityEvidenceSourceValues.privateLocalAggregate,
      evidenceKind: engineCapabilityEvidenceKindValues.localCorpusSidecar,
      schemaVersion: "catalog.local_corpus_engine_evidence.v0.1",
      status: engineCapabilityEvidenceStatusValues.present,
      aggregateCounts: { marker_kinds: 1 },
      evidenceLabels: [],
      limitations: [],
      publicFixtureId: null,
    });
  }
  await db.insert(engineCapabilityEvidence).values(evidenceRows);
}

export function runtimeReadinessWorkInput(input: {
  workId: string;
  title: string;
  provenance: CatalogSourceProvenanceRecord;
  sourceId: string;
  adapterId: string;
  languageStatusId: string;
}): Parameters<ItotoriCatalogRepository["upsertWork"]>[1] {
  return {
    workId: input.workId,
    canonicalTitle: input.title,
    originalLanguage: "ja-JP",
    engine: {
      engineName: input.adapterId,
      engineSource: catalogEngineSourceValues.manual,
      engineConfidence: catalogConfidenceValues.high,
      engineProvenanceId: input.provenance.sourceProvenanceId,
    },
    externalIds: [
      {
        externalIdId: `${input.workId}:dlsite`,
        catalogSource: catalogSourceValues.dlsite,
        sourceId: input.sourceId,
        externalIdKind: catalogExternalIdKindValues.storeProduct,
        sourceProvenanceId: input.provenance.sourceProvenanceId,
      },
    ],
    languageStatuses: [
      {
        languageStatusId: input.languageStatusId,
        language: "en-US",
        status: catalogLanguageStatusValues.none,
        sourceProvenanceId: input.provenance.sourceProvenanceId,
        confidence: catalogConfidenceValues.high,
        observedAt: fetchedAt,
      },
    ],
  };
}

export async function recordFixtureProvenance(repo: ItotoriCatalogRepository): Promise<{
  vndb: CatalogSourceProvenanceRecord;
  egs: CatalogSourceProvenanceRecord;
  dlsite: CatalogSourceProvenanceRecord;
  steam: CatalogSourceProvenanceRecord;
  igdb: CatalogSourceProvenanceRecord;
  wikidata: CatalogSourceProvenanceRecord;
  local: CatalogSourceProvenanceRecord;
}> {
  const [vndb, egs, dlsite, steam, igdb, wikidata, local] = await Promise.all([
    provenance(repo, 1, catalogSourceValues.vndb, "v17"),
    provenance(repo, 2, catalogSourceValues.egs, "12874"),
    provenance(repo, 3, catalogSourceValues.dlsite, "RJ349517"),
    provenance(repo, 4, catalogSourceValues.steam, "333600"),
    provenance(repo, 5, catalogSourceValues.igdb, "1942"),
    provenance(repo, 6, catalogSourceValues.wikidata, "Q123456"),
    provenance(repo, 7, catalogSourceValues.localCorpus, "local-owned-hash-001", {
      sourceRecordKind: catalogSourceRecordKindValues.localScan,
    }),
  ]);
  return { vndb, egs, dlsite, steam, igdb, wikidata, local };
}

export async function provenance(
  repo: ItotoriCatalogRepository,
  id: number,
  catalogSource: (typeof catalogSourceValues)[keyof typeof catalogSourceValues],
  sourceId: string,
  overrides: Partial<Parameters<ItotoriCatalogRepository["recordSourceProvenance"]>[1]> = {},
): Promise<CatalogSourceProvenanceRecord> {
  return repo.recordSourceProvenance(localActor, {
    sourceProvenanceId: uuid(id),
    catalogSource,
    sourceRecordKind: catalogSourceRecordKindValues.recordedFixture,
    sourceId,
    sourceVersion: "fixture-2026-06-17",
    requestId: `fixture:${catalogSource}:${sourceId}`,
    httpStatus: 200,
    ok: true,
    payloadHash: hash(`${catalogSource}:${sourceId}`),
    payload: { catalogSource, sourceId },
    fetchedAt,
    metadata: { fixture: true },
    ...overrides,
  });
}

export function completenessStatus(
  id: number,
  status: (typeof catalogLanguageStatusValues)[keyof typeof catalogLanguageStatusValues],
  sourceProvenanceId: string,
): NonNullable<Parameters<ItotoriCatalogRepository["upsertWork"]>[1]["languageStatuses"]>[number] {
  return {
    languageStatusId: uuid(id),
    language: "en-US",
    status,
    sourceProvenanceId,
    confidence: catalogConfidenceValues.high,
    observedAt: fetchedAt,
    importedAt: "2026-06-17T12:05:00.000Z",
    parserVersion: "catalog-completeness-fixture.v0.1",
    rawContentRedactionClass: catalogRawContentRedactionClassValues.publicMetadata,
  };
}

export function uuid(id: number): string {
  return `019ed004-0000-7000-8000-${String(id).padStart(12, "0")}`;
}

export function hash(input: string): string {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

export function requiredTestRow<T>(rows: T[], label: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`expected ${label}`);
  }
  return row;
}

export function requiredOpportunityRow(
  rows: CatalogOpportunityRow[],
  workId: string,
): CatalogOpportunityRow {
  const row = rows.find((candidate) => candidate.workId === workId);
  if (row === undefined) {
    throw new Error(`expected opportunity row ${workId}`);
  }
  return row;
}

export function runtimeEvidenceFactor(
  row: CatalogOpportunityRow,
): CatalogOpportunityRow["factorBreakdown"][number] {
  const factor = row.factorBreakdown.find(
    (entry) =>
      entry.factor === ("runtime_evidence_readiness" satisfies CatalogOpportunityFactorName),
  );
  if (factor === undefined) {
    throw new Error("expected runtime evidence readiness factor");
  }
  return factor;
}
