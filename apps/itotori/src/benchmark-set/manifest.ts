import { createHash } from "node:crypto";
import type {
  CapabilityLevel,
  CatalogBenchmarkDemandBucket,
  CatalogBenchmarkLocalOwnership,
  CatalogBenchmarkSeedFinderFilter,
  CatalogBenchmarkSeedFinderReadModel,
  CatalogBenchmarkSeedProvenanceSummary,
  CatalogBenchmarkSeedReadiness,
  CatalogBenchmarkSeedRow,
  CatalogCompletenessPool,
  CatalogLanguageStatus,
  CatalogRawContentRedactionClass,
  CatalogSource,
  CatalogSourceRecordKind,
} from "@itotori/db";
import {
  capabilityLevelValues,
  catalogCompletenessPoolValues,
  catalogLanguageStatusValues,
  catalogRawContentRedactionClassValues,
} from "@itotori/db";

export const BENCHMARK_SET_MANIFEST_SCHEMA_VERSION = "itotori.benchmark_set_manifest.v0.1";
export const BENCHMARK_SET_SELECTOR_VERSION = "itotori.benchmark_set_selector.v0.1";

export type BenchmarkSetCapabilityFilters = {
  requiredCapabilities: CapabilityLevel[];
  adapterIds: string[];
  readiness: "supported";
  pools: CatalogCompletenessPool[];
  translationCompleteness: CatalogLanguageStatus[];
  demandBucket: CatalogBenchmarkDemandBucket | null;
  localOwnership: CatalogBenchmarkLocalOwnership | null;
  provenanceRequired: boolean;
  includeCandidateSeeds: boolean;
};

export type BenchmarkSetRunParameters = {
  parameterSetId: string;
  benchmarkProfileId: string;
  providerFamily: string;
  modelId: string;
  maxSeeds: number;
  batchSize: number;
  temperature: number;
  maxOutputTokens: number;
  evaluatorIds: string[];
  notes: string[];
};

export type BenchmarkSetSourceId = {
  catalogSource: CatalogSource;
  sourceId: string;
};

export type BenchmarkSetSeedProvenance = {
  catalogSource: CatalogSource;
  sourceId: string;
  sourceRecordKind: CatalogSourceRecordKind;
  sourceVersion: string | null;
  fixtureId: string | null;
  redactionClass: CatalogRawContentRedactionClass;
};

export type BenchmarkSetPrivateLocalAggregateSeed = {
  representation: "aggregate_only";
  redactionClass: "private_corpus";
  localEvidenceCount: number;
};

export type BenchmarkSetSelectedSeed = {
  seedId: string;
  workId: string;
  sourceIds: BenchmarkSetSourceId[];
  targetLocale: string;
  completenessPool: CatalogCompletenessPool;
  translationCompleteness: CatalogLanguageStatus[];
  demandBucket: CatalogBenchmarkDemandBucket;
  localOwnership: CatalogBenchmarkLocalOwnership;
  localEvidenceCount: number;
  readiness: CatalogBenchmarkSeedReadiness;
  selectionRank: number;
  sourceRank: number;
  sourceSeedRank: number | null;
  explanationCodes: string[];
  provenance: BenchmarkSetSeedProvenance[];
  privateLocalAggregate: BenchmarkSetPrivateLocalAggregateSeed | null;
};

export type BenchmarkSetSelectionProvenance = {
  selectorVersion: typeof BENCHMARK_SET_SELECTOR_VERSION;
  manifestSchemaVersion: typeof BENCHMARK_SET_MANIFEST_SCHEMA_VERSION;
  manifestId: string;
  manifestHash: string;
  selectedAt: string;
  sourceReadModelSchemaVersion: CatalogBenchmarkSeedFinderReadModel["schemaVersion"];
  sourceReadModelGeneratedAt: string;
  sourceReadModelHash: string;
  sourceFixtureIds: string[];
  normalizedRunParameters: BenchmarkSetRunParameters;
  selectedWorkIds: string[];
  inputRowCount: number;
  candidateRowCount: number;
  selectedRowCount: number;
  excludedRowCount: number;
  driftDiagnostic: string | null;
};

export type BenchmarkSetManifest = {
  schemaVersion: typeof BENCHMARK_SET_MANIFEST_SCHEMA_VERSION;
  manifestId: string;
  targetLocale: string;
  sourceSeedIds: string[];
  capabilityFilters: BenchmarkSetCapabilityFilters;
  runParameters: BenchmarkSetRunParameters;
  selectedSeeds: BenchmarkSetSelectedSeed[];
  selectionProvenance: BenchmarkSetSelectionProvenance;
};

export type BenchmarkSetSelectionInput = {
  targetLocale?: string;
  selectedAt: string;
  sourceFixtureIds?: string[];
  capabilityFilters?: Partial<BenchmarkSetCapabilityFilters>;
  runParameters: BenchmarkSetRunParameters;
};

export type BenchmarkSetManifestDriftDiagnostic = {
  previousManifestId: string;
  nextManifestId: string;
  changedFields: string[];
};

const allBenchmarkPools = [
  catalogCompletenessPoolValues.noEnglish,
  catalogCompletenessPoolValues.fanPartial,
  catalogCompletenessPoolValues.mtlOnly,
  catalogCompletenessPoolValues.unknown,
  catalogCompletenessPoolValues.conflict,
] as CatalogCompletenessPool[];

const allSelectionTranslationStatuses = [
  catalogLanguageStatusValues.none,
  catalogLanguageStatusValues.fanPartial,
  catalogLanguageStatusValues.mtl,
  catalogLanguageStatusValues.interfaceOnly,
  catalogLanguageStatusValues.unknown,
] as CatalogLanguageStatus[];

export const defaultBenchmarkSetCapabilityFilters: BenchmarkSetCapabilityFilters = {
  requiredCapabilities: [],
  adapterIds: [],
  readiness: "supported",
  pools: allBenchmarkPools,
  translationCompleteness: allSelectionTranslationStatuses,
  demandBucket: null,
  localOwnership: null,
  provenanceRequired: false,
  includeCandidateSeeds: false,
};

export const benchmarkSetManifestJsonSchema = {
  $id: "https://itotori.local/schemas/benchmark-set-manifest.v0.1.json",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "manifestId",
    "targetLocale",
    "sourceSeedIds",
    "capabilityFilters",
    "runParameters",
    "selectedSeeds",
    "selectionProvenance",
  ],
  properties: {
    schemaVersion: { const: BENCHMARK_SET_MANIFEST_SCHEMA_VERSION },
    manifestId: { type: "string", pattern: "^benchmark-set-sha256-[a-f0-9]{16}$" },
    targetLocale: { type: "string", minLength: 2 },
    sourceSeedIds: { type: "array", items: { type: "string", minLength: 1 } },
    capabilityFilters: {
      type: "object",
      additionalProperties: false,
      required: [
        "requiredCapabilities",
        "adapterIds",
        "readiness",
        "pools",
        "translationCompleteness",
        "demandBucket",
        "localOwnership",
        "provenanceRequired",
        "includeCandidateSeeds",
      ],
      properties: {
        requiredCapabilities: {
          type: "array",
          items: { enum: Object.values(capabilityLevelValues) },
        },
        adapterIds: { type: "array", items: { type: "string", minLength: 1 } },
        readiness: { const: "supported" },
        pools: { type: "array", items: { type: "string" } },
        translationCompleteness: { type: "array", items: { type: "string" } },
        demandBucket: {
          anyOf: [{ enum: ["none", "low", "medium", "high", "very_high"] }, { type: "null" }],
        },
        localOwnership: {
          anyOf: [{ enum: ["owned", "not_owned", "unknown"] }, { type: "null" }],
        },
        provenanceRequired: { type: "boolean" },
        includeCandidateSeeds: { type: "boolean" },
      },
    },
    runParameters: {
      type: "object",
      additionalProperties: false,
      required: [
        "parameterSetId",
        "benchmarkProfileId",
        "providerFamily",
        "modelId",
        "maxSeeds",
        "batchSize",
        "temperature",
        "maxOutputTokens",
        "evaluatorIds",
        "notes",
      ],
      properties: {
        parameterSetId: { type: "string", minLength: 1 },
        benchmarkProfileId: { type: "string", minLength: 1 },
        providerFamily: { type: "string", minLength: 1 },
        modelId: { type: "string", minLength: 1 },
        maxSeeds: { type: "integer", minimum: 1 },
        batchSize: { type: "integer", minimum: 1 },
        temperature: { type: "number", minimum: 0 },
        maxOutputTokens: { type: "integer", minimum: 1 },
        evaluatorIds: { type: "array", items: { type: "string", minLength: 1 } },
        notes: { type: "array", items: { type: "string" } },
      },
    },
    selectedSeeds: { type: "array", items: { type: "object" } },
    selectionProvenance: {
      type: "object",
      required: [
        "selectorVersion",
        "manifestSchemaVersion",
        "manifestId",
        "manifestHash",
        "selectedAt",
        "sourceReadModelSchemaVersion",
        "sourceReadModelGeneratedAt",
        "sourceReadModelHash",
        "sourceFixtureIds",
        "normalizedRunParameters",
        "selectedWorkIds",
        "inputRowCount",
        "candidateRowCount",
        "selectedRowCount",
        "excludedRowCount",
        "driftDiagnostic",
      ],
    },
  },
} as const;

export function toCatalogBenchmarkSeedFinderFilter(
  input: BenchmarkSetSelectionInput,
): CatalogBenchmarkSeedFinderFilter {
  const capabilityFilters = normalizeCapabilityFilters(input.capabilityFilters);
  const filter: CatalogBenchmarkSeedFinderFilter = {
    pools: capabilityFilters.pools,
    translationCompleteness: capabilityFilters.translationCompleteness,
    provenanceRequired: capabilityFilters.provenanceRequired,
    includeDemoted: false,
    limit: 500,
  };
  if (input.targetLocale !== undefined) {
    filter.targetLanguage = input.targetLocale;
  }
  const minCapabilityLevel = highestCapabilityLevel(capabilityFilters.requiredCapabilities);
  if (minCapabilityLevel !== null) {
    filter.minCapabilityLevel = minCapabilityLevel;
  }
  if (capabilityFilters.adapterIds.length > 0) {
    filter.adapterIds = capabilityFilters.adapterIds;
  }
  if (capabilityFilters.demandBucket !== null) {
    filter.demandBucket = capabilityFilters.demandBucket;
  }
  if (capabilityFilters.localOwnership !== null) {
    filter.localOwnership = capabilityFilters.localOwnership;
  }
  return filter;
}

export function selectBenchmarkSet(
  readModel: CatalogBenchmarkSeedFinderReadModel,
  input: BenchmarkSetSelectionInput,
): BenchmarkSetManifest {
  const targetLocale = input.targetLocale ?? readModel.targetLanguage;
  if (targetLocale !== readModel.targetLanguage) {
    throw new Error(
      `benchmark set targetLocale '${targetLocale}' does not match source read model targetLanguage '${readModel.targetLanguage}'`,
    );
  }
  assertDateLike(input.selectedAt, "selectedAt");
  assertRunParameters(input.runParameters);
  const capabilityFilters = normalizeCapabilityFilters(input.capabilityFilters);
  const candidates = readModel.rows.filter((row) =>
    rowMatchesCapabilityFilters(row, capabilityFilters),
  );
  const selectedRows = candidates
    .sort(compareSeedRowsForManifest)
    .slice(0, input.runParameters.maxSeeds);
  const selectedSeeds = selectedRows.map((row, index) =>
    selectedSeedFromRow(row, targetLocale, index + 1),
  );
  const sourceSeedIds = selectedSeeds.map((seed) => seed.seedId);
  const sourceReadModelHash = publicSafeSourceReadModelHash(readModel);
  const manifestHashBody = {
    targetLocale,
    sourceSeedIds,
    capabilityFilters,
    runParameters: input.runParameters,
    selectedSeeds,
    selectorVersion: BENCHMARK_SET_SELECTOR_VERSION,
    sourceReadModelHash,
  };
  const manifestHash = sha256Stable(manifestHashBody);
  const manifestId = `benchmark-set-sha256-${manifestHash.slice(0, 16)}`;
  const manifest: BenchmarkSetManifest = {
    schemaVersion: BENCHMARK_SET_MANIFEST_SCHEMA_VERSION,
    manifestId,
    targetLocale,
    sourceSeedIds,
    capabilityFilters,
    runParameters: input.runParameters,
    selectedSeeds,
    selectionProvenance: {
      selectorVersion: BENCHMARK_SET_SELECTOR_VERSION,
      manifestSchemaVersion: BENCHMARK_SET_MANIFEST_SCHEMA_VERSION,
      manifestId,
      manifestHash,
      selectedAt: input.selectedAt,
      sourceReadModelSchemaVersion: readModel.schemaVersion,
      sourceReadModelGeneratedAt: dateToIso(readModel.generatedAt),
      sourceReadModelHash,
      sourceFixtureIds: [...(input.sourceFixtureIds ?? [])].sort(),
      normalizedRunParameters: input.runParameters,
      selectedWorkIds: sourceSeedIds,
      inputRowCount: readModel.rows.length,
      candidateRowCount: candidates.length,
      selectedRowCount: selectedSeeds.length,
      excludedRowCount: readModel.rows.length - candidates.length,
      driftDiagnostic: null,
    },
  };
  assertBenchmarkSetManifest(manifest);
  assertBenchmarkSetManifestPublicSafe(manifest);
  return manifest;
}

export function diagnoseBenchmarkSetManifestDrift(
  previous: BenchmarkSetManifest,
  next: BenchmarkSetManifest,
): BenchmarkSetManifestDriftDiagnostic | null {
  assertBenchmarkSetManifest(previous, "previous");
  assertBenchmarkSetManifest(next, "next");
  if (stableStringify(previous) === stableStringify(next)) {
    return null;
  }
  return {
    previousManifestId: previous.manifestId,
    nextManifestId: next.manifestId,
    changedFields: changedTopLevelManifestFields(previous, next),
  };
}

export function assertBenchmarkSetManifest(
  value: unknown,
  label = "BenchmarkSetManifest",
): asserts value is BenchmarkSetManifest {
  const manifest = asRecord(value, label);
  assertOnlyKeys(
    manifest,
    [
      "schemaVersion",
      "manifestId",
      "targetLocale",
      "sourceSeedIds",
      "capabilityFilters",
      "runParameters",
      "selectedSeeds",
      "selectionProvenance",
    ],
    label,
  );
  assertLiteral(
    manifest.schemaVersion,
    BENCHMARK_SET_MANIFEST_SCHEMA_VERSION,
    `${label}.schemaVersion`,
  );
  assertString(manifest.manifestId, `${label}.manifestId`);
  assertString(manifest.targetLocale, `${label}.targetLocale`);
  const sourceSeedIds = assertStringArray(manifest.sourceSeedIds, `${label}.sourceSeedIds`);
  const filters = asRecord(manifest.capabilityFilters, `${label}.capabilityFilters`);
  assertOnlyKeys(
    filters,
    [
      "requiredCapabilities",
      "adapterIds",
      "readiness",
      "pools",
      "translationCompleteness",
      "demandBucket",
      "localOwnership",
      "provenanceRequired",
      "includeCandidateSeeds",
    ],
    `${label}.capabilityFilters`,
  );
  const requiredCapabilities = asArray(
    filters.requiredCapabilities,
    `${label}.capabilityFilters.requiredCapabilities`,
  );
  for (const [index, capability] of requiredCapabilities.entries()) {
    if (!Object.values(capabilityLevelValues).includes(capability as CapabilityLevel)) {
      throw new Error(`${label}.capabilityFilters.requiredCapabilities[${index}] is invalid`);
    }
  }
  assertStringArray(filters.adapterIds, `${label}.capabilityFilters.adapterIds`);
  assertLiteral(filters.readiness, "supported", `${label}.capabilityFilters.readiness`);
  asArray(filters.pools, `${label}.capabilityFilters.pools`);
  asArray(filters.translationCompleteness, `${label}.capabilityFilters.translationCompleteness`);
  assertBoolean(filters.provenanceRequired, `${label}.capabilityFilters.provenanceRequired`);
  assertBoolean(filters.includeCandidateSeeds, `${label}.capabilityFilters.includeCandidateSeeds`);
  const runParameters = asRecord(manifest.runParameters, `${label}.runParameters`);
  assertOnlyKeys(
    runParameters,
    [
      "parameterSetId",
      "benchmarkProfileId",
      "providerFamily",
      "modelId",
      "maxSeeds",
      "batchSize",
      "temperature",
      "maxOutputTokens",
      "evaluatorIds",
      "notes",
    ],
    `${label}.runParameters`,
  );
  assertRunParameters(runParameters);
  const selectedSeeds = asArray(manifest.selectedSeeds, `${label}.selectedSeeds`);
  if (selectedSeeds.length !== sourceSeedIds.length) {
    throw new Error(`${label}.sourceSeedIds must match selectedSeeds length`);
  }
  for (const [index, seedValue] of selectedSeeds.entries()) {
    const seed = asRecord(seedValue, `${label}.selectedSeeds[${index}]`);
    assertOnlyKeys(
      seed,
      [
        "seedId",
        "workId",
        "sourceIds",
        "targetLocale",
        "completenessPool",
        "translationCompleteness",
        "demandBucket",
        "localOwnership",
        "localEvidenceCount",
        "readiness",
        "selectionRank",
        "sourceRank",
        "sourceSeedRank",
        "explanationCodes",
        "provenance",
        "privateLocalAggregate",
      ],
      `${label}.selectedSeeds[${index}]`,
    );
    const seedId = assertString(seed.seedId, `${label}.selectedSeeds[${index}].seedId`);
    if (seedId !== sourceSeedIds[index]) {
      throw new Error(`${label}.sourceSeedIds[${index}] must match selected seedId`);
    }
    assertString(seed.workId, `${label}.selectedSeeds[${index}].workId`);
    asArray(seed.sourceIds, `${label}.selectedSeeds[${index}].sourceIds`);
    asArray(seed.provenance, `${label}.selectedSeeds[${index}].provenance`);
    assertInteger(seed.selectionRank, `${label}.selectedSeeds[${index}].selectionRank`);
  }
  const provenance = asRecord(manifest.selectionProvenance, `${label}.selectionProvenance`);
  assertOnlyKeys(
    provenance,
    [
      "selectorVersion",
      "manifestSchemaVersion",
      "manifestId",
      "manifestHash",
      "selectedAt",
      "sourceReadModelSchemaVersion",
      "sourceReadModelGeneratedAt",
      "sourceReadModelHash",
      "sourceFixtureIds",
      "normalizedRunParameters",
      "selectedWorkIds",
      "inputRowCount",
      "candidateRowCount",
      "selectedRowCount",
      "excludedRowCount",
      "driftDiagnostic",
    ],
    `${label}.selectionProvenance`,
  );
  assertLiteral(
    provenance.selectorVersion,
    BENCHMARK_SET_SELECTOR_VERSION,
    `${label}.selectionProvenance.selectorVersion`,
  );
  assertDateLike(provenance.selectedAt, `${label}.selectionProvenance.selectedAt`);
  assertString(provenance.manifestId, `${label}.selectionProvenance.manifestId`);
  assertString(provenance.manifestHash, `${label}.selectionProvenance.manifestHash`);
  assertString(provenance.sourceReadModelHash, `${label}.selectionProvenance.sourceReadModelHash`);
}

export function assertBenchmarkSetManifestPublicSafe(manifest: BenchmarkSetManifest): void {
  const serialized = JSON.stringify(manifest);
  const forbiddenPatterns = [
    /\/home\//u,
    /\/tmp\//u,
    /fixtures\/private-local/u,
    /file:/u,
    /[A-Z]:\\\\/u,
    /\.zip/u,
    /path_hash/u,
    /rawPayload/u,
    /sourceText/u,
    /storyText/u,
    /filename/u,
    /private-story-title/u,
    /local-scan-entry-secret/u,
  ];
  for (const pattern of forbiddenPatterns) {
    if (pattern.test(serialized)) {
      throw new Error(`benchmark set manifest includes forbidden private/local detail ${pattern}`);
    }
  }
  for (const seed of manifest.selectedSeeds) {
    if (seed.privateLocalAggregate !== null) {
      if (
        seed.privateLocalAggregate.representation !== "aggregate_only" ||
        seed.privateLocalAggregate.redactionClass !==
          catalogRawContentRedactionClassValues.privateCorpus
      ) {
        throw new Error(`private-local seed ${seed.seedId} must be aggregate-only redacted`);
      }
      if (seed.sourceIds.length > 0 || seed.provenance.length > 0) {
        throw new Error(`private-local seed ${seed.seedId} must not expose raw source identity`);
      }
    }
  }
}

function normalizeCapabilityFilters(
  value: Partial<BenchmarkSetCapabilityFilters> = {},
): BenchmarkSetCapabilityFilters {
  const requiredCapabilities = sortedUnique(
    value.requiredCapabilities ?? defaultBenchmarkSetCapabilityFilters.requiredCapabilities,
  );
  const adapterIds = sortedUnique(
    value.adapterIds ?? defaultBenchmarkSetCapabilityFilters.adapterIds,
  );
  if (requiredCapabilities.length > 0 && adapterIds.length === 0) {
    throw new Error("benchmark set capability filters require explicit adapterIds");
  }
  return {
    requiredCapabilities,
    adapterIds,
    readiness: "supported",
    pools: sortedUnique(value.pools ?? defaultBenchmarkSetCapabilityFilters.pools),
    translationCompleteness: sortedUnique(
      value.translationCompleteness ?? defaultBenchmarkSetCapabilityFilters.translationCompleteness,
    ),
    demandBucket: value.demandBucket ?? null,
    localOwnership: value.localOwnership ?? null,
    provenanceRequired: value.provenanceRequired ?? false,
    includeCandidateSeeds: value.includeCandidateSeeds ?? false,
  };
}

function rowMatchesCapabilityFilters(
  row: CatalogBenchmarkSeedRow,
  filters: BenchmarkSetCapabilityFilters,
): boolean {
  if (row.decision === "excluded" || row.decision === "demoted") {
    return false;
  }
  if (row.decision === "candidate" && !filters.includeCandidateSeeds) {
    return false;
  }
  if (!filters.pools.includes(row.completenessPool)) {
    return false;
  }
  if (filters.demandBucket !== null && row.demandBucket !== filters.demandBucket) {
    return false;
  }
  if (filters.localOwnership !== null && row.localOwnership !== filters.localOwnership) {
    return false;
  }
  if (filters.provenanceRequired && row.provenance.length === 0) {
    return false;
  }
  const statuses = row.translationStatuses.map((status) => status.status);
  if (!statuses.some((status) => filters.translationCompleteness.includes(status))) {
    return false;
  }
  if (
    filters.adapterIds.length > 0 &&
    (row.readiness.adapterId === null || !filters.adapterIds.includes(row.readiness.adapterId))
  ) {
    return false;
  }
  if (
    filters.requiredCapabilities.length > 0 &&
    !filters.requiredCapabilities.every(
      (capability) => row.readiness[capability] === filters.readiness,
    )
  ) {
    return false;
  }
  return true;
}

function selectedSeedFromRow(
  row: CatalogBenchmarkSeedRow,
  targetLocale: string,
  selectionRank: number,
): BenchmarkSetSelectedSeed {
  return {
    seedId: row.workId,
    workId: row.workId,
    sourceIds: row.sourceIds
      .map((sourceId) => ({
        catalogSource: sourceId.catalogSource,
        sourceId: sourceId.sourceId,
      }))
      .sort(compareSourceIds),
    targetLocale,
    completenessPool: row.completenessPool,
    translationCompleteness: sortedUnique(row.translationStatuses.map((status) => status.status)),
    demandBucket: row.demandBucket,
    localOwnership: row.localOwnership,
    localEvidenceCount: row.localEvidenceCount,
    readiness: row.readiness,
    selectionRank,
    sourceRank: row.rank,
    sourceSeedRank: row.seedRank,
    explanationCodes: [...row.explanationCodes].sort(),
    provenance: row.provenance.map(redactedProvenance).sort(compareProvenance),
    privateLocalAggregate:
      row.sourceIds.length === 0 && row.provenance.length === 0 && row.localEvidenceCount > 0
        ? {
            representation: "aggregate_only",
            redactionClass: catalogRawContentRedactionClassValues.privateCorpus,
            localEvidenceCount: row.localEvidenceCount,
          }
        : null,
  };
}

function publicSafeSourceReadModelHash(readModel: CatalogBenchmarkSeedFinderReadModel): string {
  return sha256Stable({
    schemaVersion: readModel.schemaVersion,
    targetLanguage: readModel.targetLanguage,
    generatedAt: dateToIso(readModel.generatedAt),
    rows: readModel.rows.map(publicSafeSourceReadModelRow),
  });
}

function publicSafeSourceReadModelRow(row: CatalogBenchmarkSeedRow): unknown {
  return {
    workId: row.workId,
    originalLanguage: row.originalLanguage,
    sourceIds: row.sourceIds
      .map((sourceId) => ({
        catalogSource: sourceId.catalogSource,
        sourceId: sourceId.sourceId,
        externalIdKind: sourceId.externalIdKind,
      }))
      .sort((left, right) =>
        compareSourceIds(
          { catalogSource: left.catalogSource, sourceId: left.sourceId },
          { catalogSource: right.catalogSource, sourceId: right.sourceId },
        ),
      ),
    completenessPool: row.completenessPool,
    translationStatuses: row.translationStatuses
      .map((status) => ({
        language: status.language,
        status: status.status,
        confidence: status.confidence,
        statusScope: status.statusScope,
        platform: status.platform,
      }))
      .sort(
        (left, right) =>
          left.language.localeCompare(right.language) ||
          left.status.localeCompare(right.status) ||
          String(left.platform ?? "").localeCompare(String(right.platform ?? "")),
      ),
    localOwnership: row.localOwnership,
    localEvidenceCount: row.localEvidenceCount,
    demandBucket: row.demandBucket,
    readiness: row.readiness,
    provenance: row.provenance
      .filter(
        (provenance) =>
          provenance.redactionClass !== catalogRawContentRedactionClassValues.privateCorpus,
      )
      .map(redactedProvenance)
      .sort(compareProvenance),
    decision: row.decision,
    rank: row.rank,
    seedRank: row.seedRank,
    explanationCodes: [...row.explanationCodes].sort(),
  };
}

function redactedProvenance(
  provenance: CatalogBenchmarkSeedProvenanceSummary,
): BenchmarkSetSeedProvenance {
  return {
    catalogSource: provenance.catalogSource,
    sourceId: provenance.sourceId,
    sourceRecordKind: provenance.sourceRecordKind,
    sourceVersion: provenance.sourceVersion,
    fixtureId: provenance.fixtureId,
    redactionClass: provenance.redactionClass,
  };
}

function compareSeedRowsForManifest(
  left: CatalogBenchmarkSeedRow,
  right: CatalogBenchmarkSeedRow,
): number {
  return (
    nullLast(left.seedRank, right.seedRank) ||
    left.rank - right.rank ||
    left.workId.localeCompare(right.workId)
  );
}

function compareSourceIds(left: BenchmarkSetSourceId, right: BenchmarkSetSourceId): number {
  return (
    left.catalogSource.localeCompare(right.catalogSource) ||
    left.sourceId.localeCompare(right.sourceId)
  );
}

function compareProvenance(
  left: BenchmarkSetSeedProvenance,
  right: BenchmarkSetSeedProvenance,
): number {
  return (
    left.catalogSource.localeCompare(right.catalogSource) ||
    left.sourceId.localeCompare(right.sourceId) ||
    left.sourceRecordKind.localeCompare(right.sourceRecordKind)
  );
}

function changedTopLevelManifestFields(
  previous: BenchmarkSetManifest,
  next: BenchmarkSetManifest,
): string[] {
  const keys = [
    "targetLocale",
    "sourceSeedIds",
    "capabilityFilters",
    "runParameters",
    "selectedSeeds",
    "selectionProvenance",
  ] as const;
  return keys.filter((key) => stableStringify(previous[key]) !== stableStringify(next[key]));
}

const capabilityOrder: CapabilityLevel[] = [
  capabilityLevelValues.identify,
  capabilityLevelValues.inventory,
  capabilityLevelValues.extract,
  capabilityLevelValues.patch,
];

function highestCapabilityLevel(values: readonly CapabilityLevel[]): CapabilityLevel | null {
  let highest: CapabilityLevel | null = null;
  for (const value of values) {
    if (highest === null || capabilityOrder.indexOf(value) > capabilityOrder.indexOf(highest)) {
      highest = value;
    }
  }
  return highest;
}

function assertOnlyKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      throw new Error(`${label}.${key} is not allowed`);
    }
  }
}

function assertRunParameters(
  value: Record<string, unknown>,
): asserts value is BenchmarkSetRunParameters {
  assertString(value.parameterSetId, "runParameters.parameterSetId");
  assertString(value.benchmarkProfileId, "runParameters.benchmarkProfileId");
  assertString(value.providerFamily, "runParameters.providerFamily");
  assertString(value.modelId, "runParameters.modelId");
  assertPositiveInteger(value.maxSeeds, "runParameters.maxSeeds");
  assertPositiveInteger(value.batchSize, "runParameters.batchSize");
  assertNonNegativeNumber(value.temperature, "runParameters.temperature");
  assertPositiveInteger(value.maxOutputTokens, "runParameters.maxOutputTokens");
  assertStringArray(value.evaluatorIds, "runParameters.evaluatorIds");
  assertStringArray(value.notes, "runParameters.notes");
}

function sha256Stable(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function dateToIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function nullLast(left: number | null, right: number | null): number {
  if (left === null && right === null) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return left - right;
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return Array.from(new Set(values)).sort();
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

function assertStringArray(value: unknown, label: string): string[] {
  return asArray(value, label).map((entry, index) => assertString(entry, `${label}[${index}]`));
}

function assertLiteral<T extends string>(
  value: unknown,
  expected: T,
  label: string,
): asserts value is T {
  if (value !== expected) {
    throw new Error(`${label} must be '${expected}'`);
  }
}

function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
}

function assertInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  return value as number;
}

function assertPositiveInteger(value: unknown, label: string): number {
  const parsed = assertInteger(value, label);
  if (parsed < 1) {
    throw new Error(`${label} must be >= 1`);
  }
  return parsed;
}

function assertNonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return value;
}

function assertDateLike(value: unknown, label: string): asserts value is string {
  const parsed = assertString(value, label);
  if (Number.isNaN(Date.parse(parsed))) {
    throw new Error(`${label} must be an ISO date-like string`);
  }
}
