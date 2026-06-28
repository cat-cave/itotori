import { readFileSync } from "node:fs";
import Ajv from "ajv";
import {
  capabilityLevelValues,
  type CatalogBenchmarkSeedFinderReadModel,
  type CatalogBenchmarkSeedRow,
} from "@itotori/db";
import { describe, expect, it } from "vitest";
import {
  BENCHMARK_SET_MANIFEST_SCHEMA_VERSION,
  BENCHMARK_SET_SELECTOR_VERSION,
  assertBenchmarkSetManifest,
  assertBenchmarkSetManifestPublicSafe,
  benchmarkSetManifestJsonSchema,
  diagnoseBenchmarkSetManifestDrift,
  selectBenchmarkSet,
  toCatalogBenchmarkSeedFinderFilter,
  type BenchmarkSetCapabilityFilters,
  type BenchmarkSetRunParameters,
} from "../src/benchmark-set/index.js";

const catalog004Fixture = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/catalog-benchmark-seeds/fixture.json", import.meta.url),
    "utf8",
  ),
) as {
  fixtureId: string;
  expectedDefaultReadModel: CatalogBenchmarkSeedFinderReadModel & { generatedAt: string };
};

const selectorFixture = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/catalog-benchmark-sets/fixture.json", import.meta.url),
    "utf8",
  ),
) as {
  fixtureId: string;
  sourceFixtureIds: string[];
  selectedAt: string;
  runParameters: BenchmarkSetRunParameters;
  cases: Array<{
    name: string;
    capabilityFilters: Partial<BenchmarkSetCapabilityFilters>;
    expectedWorkIds: string[];
    expectedPrivateAggregateWorkIds?: string[];
  }>;
  publicLeakagePolicy: { forbiddenSubstrings: string[] };
};

describe("benchmark set selector", () => {
  it("selects stable manifests for CATALOG-004 fixture pools and readiness filters", () => {
    const readModel = catalog004ReadModelWithConflict();

    for (const fixtureCase of selectorFixture.cases) {
      const manifest = selectBenchmarkSet(readModel, {
        targetLocale: readModel.targetLanguage,
        selectedAt: selectorFixture.selectedAt,
        sourceFixtureIds: selectorFixture.sourceFixtureIds,
        runParameters: selectorFixture.runParameters,
        capabilityFilters: fixtureCase.capabilityFilters,
      });
      const repeated = selectBenchmarkSet(readModel, {
        targetLocale: readModel.targetLanguage,
        selectedAt: selectorFixture.selectedAt,
        sourceFixtureIds: selectorFixture.sourceFixtureIds,
        runParameters: selectorFixture.runParameters,
        capabilityFilters: fixtureCase.capabilityFilters,
      });

      expect(repeated).toEqual(manifest);
      expect(diagnoseBenchmarkSetManifestDrift(manifest, repeated)).toBeNull();
      expect(manifest.sourceSeedIds).toEqual(fixtureCase.expectedWorkIds);
      expect(manifest.selectionProvenance.selectedWorkIds).toEqual(fixtureCase.expectedWorkIds);
      expect(manifest.selectionProvenance.selectorVersion).toBe(BENCHMARK_SET_SELECTOR_VERSION);
      expect(manifest.selectionProvenance.manifestSchemaVersion).toBe(
        BENCHMARK_SET_MANIFEST_SCHEMA_VERSION,
      );
      expect(manifest.selectionProvenance.manifestId).toBe(manifest.manifestId);
      expect(manifest.selectionProvenance.normalizedRunParameters).toEqual(
        selectorFixture.runParameters,
      );
      expect(manifest.selectionProvenance.sourceFixtureIds).toEqual(selectorFixture.sourceFixtureIds);
      assertBenchmarkSetManifest(manifest);
      assertBenchmarkSetManifestPublicSafe(manifest);

      const privateAggregateIds = manifest.selectedSeeds
        .filter((seed) => seed.privateLocalAggregate !== null)
        .map((seed) => seed.workId);
      expect(privateAggregateIds).toEqual(fixtureCase.expectedPrivateAggregateWorkIds ?? []);
    }
  });

  it("maps set-level capability requirements to the existing seed finder filter", () => {
    const filter = toCatalogBenchmarkSeedFinderFilter({
      targetLocale: "en-US",
      selectedAt: selectorFixture.selectedAt,
      runParameters: selectorFixture.runParameters,
      capabilityFilters: {
        requiredCapabilities: [
          capabilityLevelValues.identify,
          capabilityLevelValues.inventory,
          capabilityLevelValues.patch,
        ],
        adapterIds: ["rpg-maker-mv"],
        pools: ["no_english"],
        translationCompleteness: ["none"],
        provenanceRequired: true,
      },
    });

    expect(filter).toMatchObject({
      targetLanguage: "en-US",
      minCapabilityLevel: capabilityLevelValues.patch,
      pools: ["no_english"],
      translationCompleteness: ["none"],
      provenanceRequired: true,
      includeDemoted: false,
      limit: 500,
    });
  });

  it("requires explicit adapter ids for capability-filtered manifests", () => {
    const readModel = catalog004ReadModelWithConflict();
    expect(() =>
      selectBenchmarkSet(readModel, {
        targetLocale: "en-US",
        selectedAt: selectorFixture.selectedAt,
        runParameters: selectorFixture.runParameters,
        capabilityFilters: {
          requiredCapabilities: [capabilityLevelValues.extract],
          pools: ["no_english"],
        },
      }),
    ).toThrow(/explicit adapterIds/u);
  });

  it("validates schema shape and rejects unknown fields", () => {
    const manifest = selectBenchmarkSet(catalog004ReadModelWithConflict(), {
      targetLocale: "en-US",
      selectedAt: selectorFixture.selectedAt,
      sourceFixtureIds: selectorFixture.sourceFixtureIds,
      runParameters: selectorFixture.runParameters,
      capabilityFilters: selectorFixture.cases[0]!.capabilityFilters,
    });
    const ajv = new Ajv({ strict: false });
    expect(ajv.validate(benchmarkSetManifestJsonSchema, manifest)).toBe(true);
    expect(() => assertBenchmarkSetManifest({ ...manifest, extra: true })).toThrow(/not allowed/u);
    expect(() =>
      assertBenchmarkSetManifest({
        ...manifest,
        runParameters: { ...manifest.runParameters, unsafeField: "nope" },
      }),
    ).toThrow(/not allowed/u);
  });

  it("redacts private-local aggregate details and rejects unsafe serialized output", () => {
    const manifest = selectBenchmarkSet(catalog004ReadModelWithConflict(), {
      targetLocale: "en-US",
      selectedAt: selectorFixture.selectedAt,
      sourceFixtureIds: selectorFixture.sourceFixtureIds,
      runParameters: selectorFixture.runParameters,
      capabilityFilters: selectorFixture.cases[0]!.capabilityFilters,
    });
    const serialized = JSON.stringify(manifest);

    expect(serialized).not.toContain("Benchmark unrecorded local-only");
    for (const forbidden of selectorFixture.publicLeakagePolicy.forbiddenSubstrings) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).not.toMatch(/\/home|\/tmp|file:|\.zip|path_hash/u);

    expect(() =>
      assertBenchmarkSetManifestPublicSafe({
        ...manifest,
        runParameters: {
          ...manifest.runParameters,
          notes: [...manifest.runParameters.notes, "/home/private/private-story-title.ks"],
        },
      }),
    ).toThrow(/forbidden private\/local detail/u);
  });

  it("documents drift when normalized run parameters change", () => {
    const readModel = catalog004ReadModelWithConflict();
    const baseline = selectBenchmarkSet(readModel, {
      targetLocale: "en-US",
      selectedAt: selectorFixture.selectedAt,
      runParameters: selectorFixture.runParameters,
      capabilityFilters: selectorFixture.cases[0]!.capabilityFilters,
    });
    const changed = selectBenchmarkSet(readModel, {
      targetLocale: "en-US",
      selectedAt: selectorFixture.selectedAt,
      runParameters: { ...selectorFixture.runParameters, maxSeeds: 1 },
      capabilityFilters: selectorFixture.cases[0]!.capabilityFilters,
    });

    expect(diagnoseBenchmarkSetManifestDrift(baseline, changed)).toEqual(
      expect.objectContaining({
        previousManifestId: baseline.manifestId,
        nextManifestId: changed.manifestId,
        changedFields: expect.arrayContaining(["sourceSeedIds", "runParameters", "selectedSeeds"]),
      }),
    );
  });
});

function catalog004ReadModelWithConflict(): CatalogBenchmarkSeedFinderReadModel {
  const defaultReadModel = catalog004Fixture.expectedDefaultReadModel;
  const rows = defaultReadModel.rows.map((row) => ({ ...row }));
  rows.push(conflictRow(rows[0]!));
  return {
    schemaVersion: defaultReadModel.schemaVersion,
    targetLanguage: defaultReadModel.targetLanguage,
    generatedAt: new Date(defaultReadModel.generatedAt),
    rows,
  };
}

function conflictRow(template: CatalogBenchmarkSeedRow): CatalogBenchmarkSeedRow {
  return {
    ...template,
    workId: "019ed104-0000-7000-8000-000000000104",
    canonicalTitle: "Benchmark conflict row must not appear in manifest output",
    sourceIds: [
      {
        catalogSource: "dlsite",
        sourceId: "RJSEED004",
        externalIdKind: "store_product",
      },
    ],
    completenessPool: "conflict",
    translationStatuses: [
      {
        language: "en-US",
        status: "none",
        confidence: "high",
        statusScope: "work",
        platform: null,
      },
    ],
    localOwnership: "unknown",
    localEvidenceCount: 0,
    demandBucket: "none",
    provenance: [
      {
        catalogSource: "dlsite",
        sourceId: "RJSEED004",
        sourceRecordKind: "recorded_fixture",
        sourceVersion: "catalog-benchmark-seed-fixture-v1",
        fixtureId: "catalog-benchmark-seeds/dlsite/RJSEED004.json",
        redactionClass: "public_metadata",
      },
    ],
    decision: "seed",
    rank: 99,
    seedRank: 99,
    explanationCodes: ["conflict_pool_requested", "pool:conflict"],
  };
}
