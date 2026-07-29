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

describe("catalogConflictOriginMetadataDropDiagnostic", () => {
  const languageStatus = catalogConflictKindValues.languageStatus;

  it("fires for an augment-shaped languageStatus conflict missing conflictOrigin", () => {
    const diagnostic = catalogConflictOriginMetadataDropDiagnostic({
      conflictId: "conflict-dropped",
      conflictKind: languageStatus,
      metadata: { reasonCode: "source_disagreement", severity: "warning", targetLanguage: "en-US" },
    });
    expect(diagnostic).not.toBeNull();
    expect(diagnostic).toMatchObject({
      code: catalogConflictOriginMetadataDropDiagnosticCode,
      conflictId: "conflict-dropped",
      conflictKind: languageStatus,
      targetLanguage: "en-US",
      observedConflictOrigin: null,
      safeDefault: catalogPlatformLanguageConflictOriginValues.fixtureAuthored,
    });
  });

  it("fires when conflictOrigin is present but not a valid origin value", () => {
    const diagnostic = catalogConflictOriginMetadataDropDiagnostic({
      conflictId: "conflict-garbage",
      conflictKind: languageStatus,
      metadata: { targetLanguage: "en-US", conflictOrigin: "not_a_real_origin" },
    });
    expect(diagnostic).not.toBeNull();
    expect(diagnostic?.observedConflictOrigin).toBe("not_a_real_origin");
  });

  it("does not fire when a valid conflictOrigin is present", () => {
    for (const origin of [
      catalogPlatformLanguageConflictOriginValues.fixtureAuthored,
      catalogPlatformLanguageConflictOriginValues.repositoryDerived,
    ]) {
      expect(
        catalogConflictOriginMetadataDropDiagnostic({
          conflictId: "conflict-present",
          conflictKind: languageStatus,
          metadata: { targetLanguage: "en-US", conflictOrigin: origin },
        }),
      ).toBeNull();
    }
  });

  it("does not fire for a legitimately-originless legacy/minimal conflict (no targetLanguage)", () => {
    expect(
      catalogConflictOriginMetadataDropDiagnostic({
        conflictId: "conflict-legacy",
        conflictKind: languageStatus,
        metadata: { reasonCode: "source_disagreement", severity: "warning" },
      }),
    ).toBeNull();
  });

  it("does not fire for non-platform-language conflict kinds", () => {
    expect(
      catalogConflictOriginMetadataDropDiagnostic({
        conflictId: "conflict-title",
        conflictKind: catalogConflictKindValues.title,
        metadata: { targetLanguage: "en-US" },
      }),
    ).toBeNull();
  });
});
