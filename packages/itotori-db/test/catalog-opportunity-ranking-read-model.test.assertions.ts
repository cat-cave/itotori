import { expect } from "vitest";

import {
  type CatalogOpportunityFactorName,
  type CatalogOpportunityRankingReadModel,
} from "../src/repositories/catalog-repository.js";

import { hash } from "./catalog-opportunity-ranking-read-model.test.fixtures.js";

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
