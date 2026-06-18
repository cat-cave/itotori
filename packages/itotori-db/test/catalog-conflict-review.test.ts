import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import { ItotoriCatalogRepository } from "../src/repositories/catalog-repository.js";
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

describe("catalogConflictReview read model", () => {
  it("returns provenance-preserving diagnostics for exact, fuzzy, resolved, and stale conflicts", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const seeded = await seedConflictReviewFixture(repo);

      const before = await repo.getWorkSnapshot(localActor, seeded.works.duplicate);
      const review = await repo.catalogConflictReview(localActor);
      const byReason = new Map(review.rows.map((row) => [row.reasonCode, row]));

      expect(byReason.get("duplicate_external_id")).toMatchObject({
        reviewId: `catalog-conflict:${seeded.conflicts.duplicateExternalId}`,
        catalogRecordId: seeded.works.duplicate,
        severity: "error",
        status: catalogConflictStatusValues.open,
        conflictKind: catalogConflictKindValues.externalId,
        exactLinkRefs: [
          expect.objectContaining({
            externalIdId: seeded.externalIds.duplicateDlsite,
            catalogSource: catalogSourceValues.dlsite,
            sourceId: "RJCAT010",
          }),
        ],
        candidateCatalogIds: [seeded.works.duplicate, seeded.works.duplicateCompeting],
        sourceIds: expect.arrayContaining([
          { catalogSource: catalogSourceValues.dlsite, sourceId: "RJCAT010" },
        ]),
        provenance: [
          expect.objectContaining({
            sourceProvenanceId: seeded.provenance.dlsite,
            catalogSource: catalogSourceValues.dlsite,
            sourceId: "RJCAT010",
          }),
        ],
      });

      const fuzzyA = review.rows.find(
        (row) => row.reviewId === `catalog-candidate:${seeded.candidates.fuzzyA}`,
      );
      expect(fuzzyA).toMatchObject({
        reviewId: `catalog-candidate:${seeded.candidates.fuzzyA}`,
        candidateIds: [seeded.candidates.fuzzyA, seeded.candidates.fuzzyB],
        candidateCatalogIds: [seeded.works.fuzzyA, seeded.works.fuzzyB],
        fuzzyScores: [
          expect.objectContaining({ candidateId: seeded.candidates.fuzzyA, score: 910 }),
          expect.objectContaining({ candidateId: seeded.candidates.fuzzyB, score: 870 }),
        ],
        severity: "warning",
        status: catalogCandidateMatchStatusValues.reviewPending,
      });

      const sourceDisagreement = review.rows.find(
        (row) => row.reviewId === `catalog-conflict:${seeded.conflicts.sourceDisagreement}`,
      );
      expect(sourceDisagreement).toMatchObject({
        reviewId: `catalog-conflict:${seeded.conflicts.sourceDisagreement}`,
        severity: "warning",
        status: catalogConflictStatusValues.open,
        provenance: expect.arrayContaining([
          expect.objectContaining({
            sourceProvenanceId: seeded.provenance.vndb,
            catalogSource: catalogSourceValues.vndb,
            sourceId: "v-cat-010",
          }),
          expect.objectContaining({
            sourceProvenanceId: seeded.provenance.steam,
            catalogSource: catalogSourceValues.steam,
            sourceId: "steam-cat-010",
          }),
        ]),
      });

      const resolved = review.rows.find(
        (row) => row.reviewId === `catalog-conflict:${seeded.conflicts.resolved}`,
      );
      expect(resolved).toMatchObject({
        reasonCode: "source_disagreement",
        severity: "info",
        status: catalogConflictStatusValues.resolved,
        resolution: {
          reviewerId: "reviewer-catalog-010",
          action: "merged_into_canonical_work",
          priorCandidateIds: [seeded.candidates.fuzzyA, seeded.candidates.fuzzyB],
        },
      });
      expect(resolved?.resolution?.resolvedAt).toEqual(new Date("2026-06-17T13:00:00.000Z"));

      const stale = review.rows.find((row) => row.reasonCode === "stale_candidate");
      expect(stale).toMatchObject({
        reviewId: `catalog-candidate:${seeded.candidates.stale}`,
        severity: "info",
        status: catalogCandidateMatchStatusValues.duplicateSource,
        candidateCatalogIds: [seeded.works.stale],
      });

      const reasonCodes = review.rows.map((row) => row.reasonCode);
      for (const expected of fixture.cases.map((entry) => entry.reasonCode)) {
        expect(reasonCodes).toContain(expected);
      }

      await expect(repo.catalogConflictReview(localActor, { source: catalogSourceValues.steam })).resolves.toEqual({
        rows: expect.arrayContaining([
          expect.objectContaining({ reviewId: `catalog-conflict:${seeded.conflicts.sourceDisagreement}` }),
        ]),
      });
      await expect(repo.catalogConflictReview(localActor, { severity: "error" })).resolves.toEqual({
        rows: [expect.objectContaining({ reasonCode: "duplicate_external_id" })],
      });
      await expect(
        repo.catalogConflictReview(localActor, { status: catalogConflictStatusValues.resolved }),
      ).resolves.toEqual({
        rows: [expect.objectContaining({ reviewId: `catalog-conflict:${seeded.conflicts.resolved}` })],
      });
      await expect(
        repo.catalogConflictReview(localActor, { catalogRecordId: seeded.works.fuzzyB }),
      ).resolves.toEqual({
        rows: expect.arrayContaining([
          expect.objectContaining({ reviewId: `catalog-candidate:${seeded.candidates.fuzzyB}` }),
        ]),
      });
      await expect(
        repo.catalogConflictReview(localActor, { catalogRecordId: seeded.works.duplicateCompeting }),
      ).resolves.toEqual({
        rows: [
          expect.objectContaining({
            reviewId: `catalog-conflict:${seeded.conflicts.duplicateExternalId}`,
            candidateCatalogIds: [seeded.works.duplicate, seeded.works.duplicateCompeting],
          }),
        ],
      });

      const after = await repo.getWorkSnapshot(localActor, seeded.works.duplicate);
      expect(after).toEqual(before);
    } finally {
      await context.close();
    }
  });
});

async function seedConflictReviewFixture(repo: ItotoriCatalogRepository): Promise<{
  provenance: Record<"dlsite" | "egs" | "steam" | "vndb", string>;
  works: Record<
    "duplicate" | "duplicateCompeting" | "fuzzyA" | "fuzzyB" | "sourceDisagreement" | "resolved" | "stale",
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

async function provenanceRecord(
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

function uuid(id: number): string {
  return `019ed004-0000-7000-8000-${String(id).padStart(12, "0")}`;
}

function hash(input: string): string {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}
