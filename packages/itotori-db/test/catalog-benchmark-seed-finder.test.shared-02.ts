import { readFileSync } from "node:fs";

import { localUserId, type AuthorizationActor } from "../src/authorization.js";

import { type CatalogBenchmarkSeedFinderReadModel } from "../src/repositories/catalog-repository.js";

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
