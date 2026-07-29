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

import {
  recordCapabilityMatrices,
  recordAmbiguousAdapterWork,
  recordPatchOnlyCapabilityBait,
  recordSeedFinderCatalog,
  recordSeedFinderProvenance,
  provenance,
  externalId,
  release,
  languageStatus,
  demandFact,
  hash,
  uuid,
} from "./catalog-benchmark-seed-finder.test.shared-01.js";

export function requiredTestRow<T>(rows: T[], label: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`expected ${label}`);
  }
  return row;
}

export function normalizeBenchmarkSeedReadModel(
  readModel: CatalogBenchmarkSeedFinderReadModel,
  generatedAt: string,
): unknown {
  return {
    ...JSON.parse(JSON.stringify(readModel)),
    generatedAt,
  };
}
