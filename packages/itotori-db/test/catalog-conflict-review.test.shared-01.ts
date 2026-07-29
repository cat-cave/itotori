import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import {
  catalogConflictOriginMetadataDropDiagnostic,
  catalogConflictOriginMetadataDropDiagnosticCode,
  ItotoriCatalogRepository,
} from "../src/repositories/catalog-repository.js";
import { catalogPlatformLanguageConflictOriginValues } from "../src/services/catalog-platform-language-conflicts.js";
import {
  catalogCandidateMatchStatusValues,
  catalogConflictKindValues,
  catalogConflictStatusValues,
  catalogConflictSubjectKindValues,
  catalogConfidenceValues,
  catalogExternalIdKindValues,
  catalogLanguageStatusValues,
  catalogSourceRecordKindValues,
  catalogSourceValues,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };
const fixture = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/catalog-conflict-review/conflicts.json", import.meta.url),
    "utf8",
  ),
) as {
  fetchedAt: string;
  cases: {
    caseId: string;
    reasonCode: string;
    severity: "error" | "warning" | "info";
    status: string;
    reviewerId?: string;
    resolutionAction?: string;
  }[];
};

export async function seedConflictReviewFixture(repo: ItotoriCatalogRepository): Promise<{
  provenance: Record<"dlsite" | "egs" | "steam" | "vndb", string>;
  works: Record<
    | "duplicate"
    | "duplicateCompeting"
    | "fuzzyA"
    | "fuzzyB"
    | "sourceDisagreement"
    | "resolved"
    | "stale",
    string
  >;
  externalIds: Record<"duplicateDlsite", string>;
  conflicts: Record<"duplicateExternalId" | "sourceDisagreement" | "resolved", string>;
  candidates: Record<"fuzzyA" | "fuzzyB" | "stale", string>;
}> {
  const provenance = {
    dlsite: uuid(1001),
    egs: uuid(1002),
    steam: uuid(1003),
    vndb: uuid(1004),
  };
  await Promise.all([
    provenanceRecord(repo, provenance.dlsite, catalogSourceValues.dlsite, "RJCAT010"),
    provenanceRecord(repo, provenance.egs, catalogSourceValues.egs, "egs-cat-010"),
    provenanceRecord(repo, provenance.steam, catalogSourceValues.steam, "steam-cat-010"),
    provenanceRecord(repo, provenance.vndb, catalogSourceValues.vndb, "v-cat-010"),
  ]);

  const works = {
    duplicate: uuid(2001),
    duplicateCompeting: uuid(2002),
    fuzzyA: uuid(2003),
    fuzzyB: uuid(2004),
    sourceDisagreement: uuid(2005),
    resolved: uuid(2006),
    stale: uuid(2007),
  };
  const externalIds = {
    duplicateDlsite: uuid(3001),
  };
  const conflicts = {
    duplicateExternalId: uuid(4001),
    sourceDisagreement: uuid(4002),
    resolved: uuid(4003),
  };
  const candidates = {
    fuzzyA: uuid(5001),
    fuzzyB: uuid(5002),
    stale: uuid(5003),
  };

  await repo.upsertWork(localActor, {
    workId: works.duplicateCompeting,
    canonicalTitle: "Catalog 010 competing external ID claimant",
    originalLanguage: "ja-JP",
  });

  await repo.upsertWork(localActor, {
    workId: works.duplicate,
    canonicalTitle: "Catalog 010 duplicate external ID",
    originalLanguage: "ja-JP",
    externalIds: [
      {
        externalIdId: externalIds.duplicateDlsite,
        catalogSource: catalogSourceValues.dlsite,
        sourceId: "RJCAT010",
        externalIdKind: catalogExternalIdKindValues.storeProduct,
        sourceProvenanceId: provenance.dlsite,
      },
    ],
    conflicts: [
      {
        conflictId: conflicts.duplicateExternalId,
        conflictKind: catalogConflictKindValues.externalId,
        summary: "DLsite store id was claimed by more than one candidate identity.",
        detectedAt: fixture.fetchedAt,
        metadata: { reasonCode: "duplicate_external_id", severity: "error" },
        evidence: [
          {
            conflictEvidenceId: uuid(6001),
            subjectKind: catalogConflictSubjectKindValues.externalId,
            subjectId: externalIds.duplicateDlsite,
          },
          {
            conflictEvidenceId: uuid(6004),
            subjectKind: catalogConflictSubjectKindValues.work,
            subjectId: works.duplicateCompeting,
          },
        ],
      },
    ],
  });

  await repo.upsertWork(localActor, {
    workId: works.fuzzyA,
    canonicalTitle: "Moonlit Catalog Fixture",
    originalLanguage: "ja-JP",
    firstReleaseYear: 2020,
  });
  await repo.upsertWork(localActor, {
    workId: works.fuzzyB,
    canonicalTitle: "Moonlight Catalog Fixture",
    originalLanguage: "ja-JP",
    firstReleaseYear: 2020,
  });
  await repo.upsertWork(localActor, {
    workId: works.stale,
    canonicalTitle: "Stale Catalog Fixture",
    originalLanguage: "ja-JP",
    firstReleaseYear: 2019,
  });

  await repo.recordCatalogCandidateMatch(localActor, {
    candidateId: candidates.fuzzyA,
    sourceCatalogSource: catalogSourceValues.egs,
    sourceId: "egs-cat-010",
    sourceTitle: "Moonlit Catalog",
    sourceProvenanceId: provenance.egs,
    targetWorkId: works.fuzzyA,
    score: 910,
    matchedFields: { title: { score: 810 }, releaseYear: { score: 100 } },
    status: catalogCandidateMatchStatusValues.reviewPending,
    diagnosticCode: "catalog.fuzzy_candidate.generated",
    generatorVersion: "deterministic-title-year.v0.1",
  });
  await repo.recordCatalogCandidateMatch(localActor, {
    candidateId: candidates.fuzzyB,
    sourceCatalogSource: catalogSourceValues.egs,
    sourceId: "egs-cat-010",
    sourceTitle: "Moonlit Catalog",
    sourceProvenanceId: provenance.egs,
    targetWorkId: works.fuzzyB,
    score: 870,
    matchedFields: { title: { score: 770 }, releaseYear: { score: 100 } },
    status: catalogCandidateMatchStatusValues.reviewPending,
    diagnosticCode: "catalog.fuzzy_candidate.generated",
    generatorVersion: "deterministic-title-year.v0.1",
  });
  await repo.recordCatalogCandidateMatch(localActor, {
    candidateId: candidates.stale,
    sourceCatalogSource: catalogSourceValues.egs,
    sourceId: "egs-stale-cat-010",
    sourceTitle: "Stale Catalog",
    sourceProvenanceId: provenance.egs,
    targetWorkId: works.stale,
    score: 700,
    matchedFields: { title: { score: 700 } },
    status: catalogCandidateMatchStatusValues.duplicateSource,
    diagnosticCode: "catalog.fuzzy_candidate.duplicate_source",
    generatorVersion: "deterministic-title-year.v0.1",
  });

  const noneStatusId = uuid(7001);
  const officialStatusId = uuid(7002);
  await repo.upsertWork(localActor, {
    workId: works.sourceDisagreement,
    canonicalTitle: "Source disagreement fixture",
    originalLanguage: "ja-JP",
    languageStatuses: [
      {
        languageStatusId: noneStatusId,
        language: "en-US",
        status: catalogLanguageStatusValues.none,
        sourceProvenanceId: provenance.vndb,
        confidence: catalogConfidenceValues.medium,
      },
      {
        languageStatusId: officialStatusId,
        language: "en-US",
        status: catalogLanguageStatusValues.officialFull,
        sourceProvenanceId: provenance.steam,
        confidence: catalogConfidenceValues.high,
      },
    ],
    conflicts: [
      {
        conflictId: conflicts.sourceDisagreement,
        conflictKind: catalogConflictKindValues.languageStatus,
        summary: "VNDB and Steam disagree on English availability.",
        detectedAt: fixture.fetchedAt,
        metadata: { reasonCode: "source_disagreement", severity: "warning" },
        evidence: [
          {
            conflictEvidenceId: uuid(6002),
            subjectKind: catalogConflictSubjectKindValues.languageStatus,
            subjectId: noneStatusId,
            sourceProvenanceId: provenance.vndb,
          },
          {
            conflictEvidenceId: uuid(6003),
            subjectKind: catalogConflictSubjectKindValues.languageStatus,
            subjectId: officialStatusId,
            sourceProvenanceId: provenance.steam,
            evidencePosition: 1,
          },
        ],
      },
    ],
  });

  await repo.upsertWork(localActor, {
    workId: works.resolved,
    canonicalTitle: "Resolved conflict fixture",
    originalLanguage: "ja-JP",
    conflicts: [
      {
        conflictId: conflicts.resolved,
        conflictKind: catalogConflictKindValues.languageStatus,
        status: catalogConflictStatusValues.resolved,
        summary: "Reviewer merged the prior fuzzy candidates into one canonical work.",
        detectedAt: fixture.fetchedAt,
        metadata: {
          reasonCode: "source_disagreement",
          severity: "info",
          reviewerId: "reviewer-catalog-010",
          resolutionAction: "merged_into_canonical_work",
          resolvedAt: "2026-06-17T13:00:00.000Z",
          priorCandidateIds: [candidates.fuzzyA, candidates.fuzzyB],
        },
      },
    ],
  });

  return { provenance, works, externalIds, conflicts, candidates };
}

export async function provenanceRecord(
  repo: ItotoriCatalogRepository,
  sourceProvenanceId: string,
  catalogSource: (typeof catalogSourceValues)[keyof typeof catalogSourceValues],
  sourceId: string,
): Promise<void> {
  await repo.recordSourceProvenance(localActor, {
    sourceProvenanceId,
    catalogSource,
    sourceRecordKind: catalogSourceRecordKindValues.recordedFixture,
    sourceId,
    sourceVersion: "fixture-2026-06-17",
    requestId: `catalog-conflict-review:${catalogSource}:${sourceId}`,
    httpStatus: 200,
    ok: true,
    payloadHash: hash(`${catalogSource}:${sourceId}`),
    payload: { catalogSource, sourceId },
    fetchedAt: fixture.fetchedAt,
  });
}

export function uuid(id: number): string {
  return `019ed004-0000-7000-8000-${String(id).padStart(12, "0")}`;
}

export function hash(input: string): string {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}
