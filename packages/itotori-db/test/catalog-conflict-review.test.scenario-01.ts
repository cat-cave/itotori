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

import {
  seedConflictReviewFixture,
  provenanceRecord,
  uuid,
  hash,
} from "./catalog-conflict-review.test.shared-01.js";

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

      await expect(
        repo.catalogConflictReview(localActor, { source: catalogSourceValues.steam }),
      ).resolves.toEqual({
        rows: expect.arrayContaining([
          expect.objectContaining({
            reviewId: `catalog-conflict:${seeded.conflicts.sourceDisagreement}`,
          }),
        ]),
      });
      await expect(repo.catalogConflictReview(localActor, { severity: "error" })).resolves.toEqual({
        rows: [expect.objectContaining({ reasonCode: "duplicate_external_id" })],
      });
      await expect(
        repo.catalogConflictReview(localActor, { status: catalogConflictStatusValues.resolved }),
      ).resolves.toEqual({
        rows: [
          expect.objectContaining({ reviewId: `catalog-conflict:${seeded.conflicts.resolved}` }),
        ],
      });
      await expect(
        repo.catalogConflictReview(localActor, { catalogRecordId: seeded.works.fuzzyB }),
      ).resolves.toEqual({
        rows: expect.arrayContaining([
          expect.objectContaining({ reviewId: `catalog-candidate:${seeded.candidates.fuzzyB}` }),
        ]),
      });
      await expect(
        repo.catalogConflictReview(localActor, {
          catalogRecordId: seeded.works.duplicateCompeting,
        }),
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
