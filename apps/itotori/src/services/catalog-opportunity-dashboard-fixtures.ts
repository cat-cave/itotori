import { readFileSync } from "node:fs";

const catalogOpportunityFixtureUrl = new URL(
  "../../../../fixtures/catalog-opportunities/fixture.json",
  import.meta.url,
);

export type CatalogOpportunityDashboardSeedFactor = {
  factor: string;
  weightedScore: number;
  explanationCode: string;
};

export type CatalogOpportunityDashboardSeedRow = {
  rank: number;
  workId: string;
  canonicalTitle: string;
  engineName: string | null;
  completenessPool: string;
  demandBucket: string;
  decision: "candidate" | "demoted" | "excluded";
  score: number;
  topFactors: CatalogOpportunityDashboardSeedFactor[];
  demotionCodes: string[];
  explanationCodes: string[];
};

export type CatalogOpportunityDashboardSeedFixture = {
  schemaVersion: "catalog.opportunity_dashboard_seed.v0.1";
  fixtureId: string;
  targetLanguage: string;
  generatedAt: string;
  rows: CatalogOpportunityDashboardSeedRow[];
};

export function loadCatalogOpportunityDashboardSeedFixture(
  url: URL = catalogOpportunityFixtureUrl,
): CatalogOpportunityDashboardSeedFixture {
  const fixture = asRecord(JSON.parse(readFileSync(url, "utf8")), "catalog opportunity fixture");
  assertStringLiteral(
    fixture.schemaVersion,
    "catalog.opportunity_ranking.fixture.v0.1",
    "fixture.schemaVersion",
  );
  const fixtureId = assertString(fixture.fixtureId, "fixture.fixtureId");
  const targetLanguage = assertString(fixture.targetLanguage, "fixture.targetLanguage");
  const generatedAt = assertString(fixture.generatedAt, "fixture.generatedAt");
  assertDateLike(generatedAt, "fixture.generatedAt");

  const readModel = asRecord(fixture.expectedDefaultReadModel, "fixture.expectedDefaultReadModel");
  assertStringLiteral(
    readModel.schemaVersion,
    "catalog.opportunity_ranking.v0.1",
    "fixture.expectedDefaultReadModel.schemaVersion",
  );
  const rows = asArray(readModel.rows, "fixture.expectedDefaultReadModel.rows").map(
    (rowValue, index): CatalogOpportunityDashboardSeedRow =>
      dashboardSeedRow(rowValue, `fixture.expectedDefaultReadModel.rows[${index}]`),
  );

  const seed: CatalogOpportunityDashboardSeedFixture = {
    schemaVersion: "catalog.opportunity_dashboard_seed.v0.1",
    fixtureId,
    targetLanguage,
    generatedAt,
    rows,
  };
  assertFixtureOutputHasNoForbiddenPrivateSubstrings(
    seed,
    fixture.publicLeakagePolicy,
    "catalog opportunity dashboard seed",
  );
  return seed;
}

function dashboardSeedRow(value: unknown, label: string): CatalogOpportunityDashboardSeedRow {
  const row = asRecord(value, label);
  const factorRows = asArray(row.factorBreakdown, `${label}.factorBreakdown`).map(
    (factorValue, index) => dashboardSeedFactor(factorValue, `${label}.factorBreakdown[${index}]`),
  );
  return {
    rank: assertNonNegativeInteger(row.rank, `${label}.rank`),
    workId: assertString(row.workId, `${label}.workId`),
    canonicalTitle: assertString(row.canonicalTitle, `${label}.canonicalTitle`),
    engineName: assertNullableString(row.engineName, `${label}.engineName`),
    completenessPool: assertString(row.completenessPool, `${label}.completenessPool`),
    demandBucket: assertString(row.demandBucket, `${label}.demandBucket`),
    decision: assertDecision(row.decision, `${label}.decision`),
    score: assertFiniteNumber(row.score, `${label}.score`),
    topFactors: factorRows
      .sort((left, right) => {
        const scoreOrder = Math.abs(right.weightedScore) - Math.abs(left.weightedScore);
        return scoreOrder === 0 ? left.factor.localeCompare(right.factor) : scoreOrder;
      })
      .slice(0, 3),
    demotionCodes: demotionCodes(row.demotions, `${label}.demotions`),
    explanationCodes: asArray(row.explanationCodes, `${label}.explanationCodes`).map(
      (entry, index) => assertString(entry, `${label}.explanationCodes[${index}]`),
    ),
  };
}

function dashboardSeedFactor(
  value: unknown,
  label: string,
): CatalogOpportunityDashboardSeedFactor {
  const factor = asRecord(value, label);
  return {
    factor: assertString(factor.factor, `${label}.factor`),
    weightedScore: assertFiniteNumber(factor.weightedScore, `${label}.weightedScore`),
    explanationCode: assertString(factor.explanationCode, `${label}.explanationCode`),
  };
}

function demotionCodes(value: unknown, label: string): string[] {
  if (value === undefined) {
    return [];
  }
  return asArray(value, label).map((entry, index) => {
    const demotion = asRecord(entry, `${label}[${index}]`);
    return assertString(
      demotion.explanationCode ?? demotion.reasonCode ?? demotion.kind,
      `${label}[${index}].code`,
    );
  });
}

function assertFixtureOutputHasNoForbiddenPrivateSubstrings(
  seed: CatalogOpportunityDashboardSeedFixture,
  policyValue: unknown,
  label: string,
): void {
  const policy = asRecord(policyValue, "fixture.publicLeakagePolicy");
  const forbidden = asArray(
    policy.forbiddenPrivateSubstrings,
    "fixture.publicLeakagePolicy.forbiddenPrivateSubstrings",
  ).map((entry, index) =>
    assertString(entry, `fixture.publicLeakagePolicy.forbiddenPrivateSubstrings[${index}]`),
  );
  const serialized = JSON.stringify(seed);
  for (const substring of forbidden) {
    if (substring.length > 0 && serialized.includes(substring)) {
      throw new Error(`${label} must not include forbidden private substring ${substring}`);
    }
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function assertNullableString(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }
  return assertString(value, label);
}

function assertStringLiteral<T extends string>(value: unknown, expected: T, label: string): T {
  if (value !== expected) {
    throw new Error(`${label} must be ${expected}`);
  }
  return expected;
}

function assertNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function assertFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function assertDateLike(value: string, label: string): void {
  if (Number.isNaN(new Date(value).getTime())) {
    throw new Error(`${label} must be a date`);
  }
}

function assertDecision(value: unknown, label: string): "candidate" | "demoted" | "excluded" {
  if (value !== "candidate" && value !== "demoted" && value !== "excluded") {
    throw new Error(`${label} must be candidate, demoted, or excluded`);
  }
  return value;
}
