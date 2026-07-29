import { type CatalogBenchmarkSeedFinderReadModel } from "../src/repositories/catalog-repository.js";

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
