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

import {
  recordOpportunityCapability,
  recordRuntimeEvidenceCapability,
  recordExtractAdapterMatrixCapability,
  recordOpportunityCatalog,
  opportunityWorkInput,
  opportunityWorkInputWithEngine,
  recordOpportunityProvenance,
  provenance,
  externalId,
  release,
  languageStatus,
  demandFact,
  localScanEntry,
} from "./catalog-opportunity-ranking-read-model.test.shared-01.js";

export function uuid(id: number): string {
  return `019ed104-0000-7000-8000-${String(id).padStart(12, "0")}`;
}

export function hash(input: string): string {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

export function requiredTestRow(
  rows: CatalogOpportunityRankingReadModel["rows"],
  workId: string,
): CatalogOpportunityRankingReadModel["rows"][number] {
  const row = rows.find((candidate) => candidate.workId === workId);
  if (row === undefined) {
    throw new Error(`expected opportunity row ${workId}`);
  }
  return row;
}

export function factorScore(
  row: CatalogOpportunityRankingReadModel["rows"][number],
  factorName: CatalogOpportunityFactorName,
): number {
  const factor = row.factorBreakdown.find((entry) => entry.factor === factorName);
  if (factor === undefined) {
    throw new Error(`expected factor ${factorName}`);
  }
  return factor.weightedScore;
}

export function expectSerializedSafe(readModel: CatalogOpportunityRankingReadModel): void {
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
