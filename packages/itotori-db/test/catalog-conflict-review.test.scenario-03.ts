import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import {
  catalogConflictOriginMetadataDropDiagnosticCode,
  ItotoriCatalogRepository,
} from "../src/repositories/catalog-repository.js";
import { catalogPlatformLanguageConflictOriginValues } from "../src/services/catalog-platform-language-conflicts.js";
import { catalogConflictKindValues } from "../src/schema.js";
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

import { uuid } from "./catalog-conflict-review.test.shared-01.js";

describe("catalogConflictReview conflictOrigin observability", () => {
  it("emits a process warning for an expected-but-missing origin drop while preserving the safe default", async () => {
    const context = await isolatedMigratedContext();
    const warnings: Error[] = [];
    const onWarning = (warning: Error): void => {
      warnings.push(warning);
    };
    process.on("warning", onWarning);
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const droppedWorkId = uuid(7101);
      const droppedConflictId = uuid(7102);
      const legacyWorkId = uuid(7103);
      const legacyConflictId = uuid(7104);
      const presentWorkId = uuid(7105);
      const presentConflictId = uuid(7106);

      // Expected-but-missing: augment-shaped (targetLanguage present) but origin dropped.
      await repo.upsertWork(localActor, {
        workId: droppedWorkId,
        canonicalTitle: "Dropped origin fixture",
        originalLanguage: "ja-JP",
        conflicts: [
          {
            conflictId: droppedConflictId,
            conflictKind: catalogConflictKindValues.languageStatus,
            summary: "Origin metadata dropped after augment.",
            detectedAt: fixture.fetchedAt,
            metadata: {
              reasonCode: "source_disagreement",
              severity: "warning",
              targetLanguage: "en-US",
            },
          },
        ],
      });
      // Legitimately-absent: minimal legacy metadata, no targetLanguage.
      await repo.upsertWork(localActor, {
        workId: legacyWorkId,
        canonicalTitle: "Legacy originless fixture",
        originalLanguage: "ja-JP",
        conflicts: [
          {
            conflictId: legacyConflictId,
            conflictKind: catalogConflictKindValues.languageStatus,
            summary: "Legacy conflict without origin.",
            detectedAt: fixture.fetchedAt,
            metadata: { reasonCode: "source_disagreement", severity: "warning" },
          },
        ],
      });
      // Origin present: repository-derived, unchanged.
      await repo.upsertWork(localActor, {
        workId: presentWorkId,
        canonicalTitle: "Origin present fixture",
        originalLanguage: "ja-JP",
        conflicts: [
          {
            conflictId: presentConflictId,
            conflictKind: catalogConflictKindValues.languageStatus,
            summary: "Repository-derived conflict with origin stamped.",
            detectedAt: fixture.fetchedAt,
            metadata: {
              reasonCode: "source_disagreement",
              severity: "warning",
              targetLanguage: "en-US",
              conflictOrigin: catalogPlatformLanguageConflictOriginValues.repositoryDerived,
            },
          },
        ],
      });

      const review = await repo.catalogConflictReview(localActor);
      // Flush any nextTick-scheduled process warnings.
      await new Promise((resolve) => setImmediate(resolve));

      const byReviewId = new Map(review.rows.map((row) => [row.reviewId, row]));
      const droppedRow = byReviewId.get(`catalog-conflict:${droppedConflictId}`);
      const legacyRow = byReviewId.get(`catalog-conflict:${legacyConflictId}`);
      const presentRow = byReviewId.get(`catalog-conflict:${presentConflictId}`);

      // Safe default preserved on the dropped and legacy rows; present row unchanged.
      expect(droppedRow?.conflictOrigin).toBe(
        catalogPlatformLanguageConflictOriginValues.fixtureAuthored,
      );
      expect(legacyRow?.conflictOrigin).toBe(
        catalogPlatformLanguageConflictOriginValues.fixtureAuthored,
      );
      expect(presentRow?.conflictOrigin).toBe(
        catalogPlatformLanguageConflictOriginValues.repositoryDerived,
      );

      // Exactly one diagnostic fired, for the dropped conflict only (no noise on the
      // legitimately-absent legacy row nor the origin-present row).
      const originWarnings = warnings.filter(
        (warning) =>
          (warning as { code?: string }).code === catalogConflictOriginMetadataDropDiagnosticCode,
      );
      expect(originWarnings).toHaveLength(1);
      expect(originWarnings[0]?.message).toContain(droppedConflictId);
    } finally {
      process.off("warning", onWarning);
      await context.close();
    }
  });
});
