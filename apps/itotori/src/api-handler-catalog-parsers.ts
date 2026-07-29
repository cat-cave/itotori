import {
  assetLocalizationDecisionAssetKindList,
  capabilityLevelValues,
  catalogCandidateMatchStatusValues,
  catalogCompletenessPoolValues,
  catalogConflictStatusValues,
  catalogLanguageStatusValues,
  catalogSourceValues,
  type AssetLocalizationDecisionAssetKind,
  type CapabilityLevel,
  type CatalogBenchmarkDemandBucket,
  type CatalogBenchmarkLocalOwnership,
  type CatalogBenchmarkSeedFinderFilter,
  type CatalogCompletenessPool,
  type CatalogCompletenessPoolFilter,
  type CatalogConflictReviewFilter,
  type CatalogConflictReviewSeverity,
  type CatalogConflictReviewStatus,
  type CatalogLanguageStatus,
  type CatalogOpportunityRankingFilter,
  type CatalogSource,
  type TerminologySearchInput,
} from "@itotori/db";
import { ApiValidationError } from "./api-schema.js";
import { nonEmptyParam } from "./api-handler-core-parsers.js";

export function parseAssetDecisionReadFilter(search = ""): {
  kindFilter?: AssetLocalizationDecisionAssetKind;
} {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  assertKnownQueryParams(params, ["assetKind"], "asset decisions");
  const assetKind = params.get("assetKind");
  if (assetKind === null) {
    return {};
  }
  return {
    kindFilter: enumParam(assetKind, assetLocalizationDecisionAssetKindList, "assetKind"),
  };
}

export function parseCatalogOpportunityRankingFilter(search = ""): CatalogOpportunityRankingFilter {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  assertKnownQueryParams(
    params,
    [
      "targetLanguage",
      "includeDemoted",
      "limit",
      "engine",
      "pool",
      "minCapabilityLevel",
      "localOwnership",
      "demandBucket",
    ],
    "catalog opportunity",
  );
  const filter: CatalogOpportunityRankingFilter = {};
  const targetLanguage = params.get("targetLanguage");
  if (targetLanguage !== null) {
    if (targetLanguage.trim().length === 0) {
      throw new ApiValidationError("targetLanguage must be non-empty");
    }
    filter.targetLanguage = targetLanguage;
  }
  const includeDemoted = params.get("includeDemoted");
  if (includeDemoted !== null) {
    filter.includeDemoted = booleanParam(includeDemoted, "includeDemoted");
  }
  const limit = params.get("limit");
  if (limit !== null) {
    const parsedLimit = Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 500) {
      throw new ApiValidationError("limit must be an integer from 1 through 500");
    }
    filter.limit = parsedLimit;
  }
  const engine = params.get("engine");
  if (engine !== null) {
    if (engine.trim().length === 0) {
      throw new ApiValidationError("engine must be non-empty");
    }
    filter.engine = engine;
  }
  const pool = params.get("pool");
  if (pool !== null) {
    filter.pool = enumParam(
      pool,
      Object.values(catalogCompletenessPoolValues) as CatalogCompletenessPool[],
      "pool",
    );
  }
  const minCapabilityLevel = params.get("minCapabilityLevel");
  if (minCapabilityLevel !== null) {
    filter.minCapabilityLevel = enumParam(
      minCapabilityLevel,
      Object.values(capabilityLevelValues) as CapabilityLevel[],
      "minCapabilityLevel",
    );
  }
  const localOwnership = params.get("localOwnership");
  if (localOwnership !== null) {
    filter.localOwnership = enumParam(
      localOwnership,
      catalogBenchmarkLocalOwnershipValues,
      "localOwnership",
    );
  }
  const demandBucket = params.get("demandBucket");
  if (demandBucket !== null) {
    filter.demandBucket = enumParam(demandBucket, catalogBenchmarkDemandBuckets, "demandBucket");
  }
  return filter;
}

export function parseCatalogCompletenessPoolFilter(search = ""): CatalogCompletenessPoolFilter {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  assertKnownQueryParams(params, ["targetLanguage", "pool"], "catalog completeness");
  const filter: CatalogCompletenessPoolFilter = {};
  const targetLanguage = params.get("targetLanguage");
  if (targetLanguage !== null) {
    if (targetLanguage.trim().length === 0) {
      throw new ApiValidationError("targetLanguage must be non-empty");
    }
    filter.targetLanguage = targetLanguage;
  }
  const pool = params.get("pool");
  if (pool !== null) {
    filter.pool = enumParam(
      pool,
      Object.values(catalogCompletenessPoolValues) as CatalogCompletenessPool[],
      "pool",
    );
  }
  return filter;
}

const catalogBenchmarkDemandBuckets: CatalogBenchmarkDemandBucket[] = [
  "none",
  "low",
  "medium",
  "high",
  "very_high",
];

const catalogBenchmarkLocalOwnershipValues: CatalogBenchmarkLocalOwnership[] = [
  "owned",
  "not_owned",
  "unknown",
];

export function parseCatalogBenchmarkSeedFinderFilter(
  search = "",
): CatalogBenchmarkSeedFinderFilter {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  assertKnownQueryParams(
    params,
    [
      "targetLanguage",
      "pools",
      "adapterIds",
      "minCapabilityLevel",
      "requiredCapabilities",
      "demandBucket",
      "translationCompleteness",
      "provenanceRequired",
      "localOwnership",
      "includeDemoted",
      "limit",
    ],
    "catalog benchmark seed",
  );
  const filter: CatalogBenchmarkSeedFinderFilter = {};
  const targetLanguage = params.get("targetLanguage");
  if (targetLanguage !== null) {
    if (targetLanguage.trim().length === 0) {
      throw new ApiValidationError("targetLanguage must be non-empty");
    }
    filter.targetLanguage = targetLanguage;
  }
  const pools = listParam(params, "pools");
  if (pools.length > 0) {
    filter.pools = pools.map((pool) =>
      enumParam(
        pool,
        Object.values(catalogCompletenessPoolValues) as CatalogCompletenessPool[],
        "pools",
      ),
    );
  }
  const adapterIds = listParam(params, "adapterIds");
  if (adapterIds.length > 0) {
    filter.adapterIds = adapterIds;
  }
  const minCapabilityLevel = params.get("minCapabilityLevel");
  if (minCapabilityLevel !== null) {
    filter.minCapabilityLevel = enumParam(
      minCapabilityLevel,
      Object.values(capabilityLevelValues) as CapabilityLevel[],
      "minCapabilityLevel",
    );
  }
  const requiredCapabilities = listParam(params, "requiredCapabilities");
  if (requiredCapabilities.length > 0) {
    filter.requiredCapabilities = requiredCapabilities.map((capability) =>
      enumParam(
        capability,
        Object.values(capabilityLevelValues) as CapabilityLevel[],
        "requiredCapabilities",
      ),
    );
  }
  const demandBucket = params.get("demandBucket");
  if (demandBucket !== null) {
    filter.demandBucket = enumParam(demandBucket, catalogBenchmarkDemandBuckets, "demandBucket");
  }
  const translationCompleteness = listParam(params, "translationCompleteness");
  if (translationCompleteness.length > 0) {
    filter.translationCompleteness = translationCompleteness.map((status) =>
      enumParam(
        status,
        Object.values(catalogLanguageStatusValues) as CatalogLanguageStatus[],
        "translationCompleteness",
      ),
    );
  }
  const provenanceRequired = params.get("provenanceRequired");
  if (provenanceRequired !== null) {
    filter.provenanceRequired = booleanParam(provenanceRequired, "provenanceRequired");
  }
  const localOwnership = params.get("localOwnership");
  if (localOwnership !== null) {
    filter.localOwnership = enumParam(
      localOwnership,
      catalogBenchmarkLocalOwnershipValues,
      "localOwnership",
    );
  }
  const includeDemoted = params.get("includeDemoted");
  if (includeDemoted !== null) {
    filter.includeDemoted = booleanParam(includeDemoted, "includeDemoted");
  }
  const limit = params.get("limit");
  if (limit !== null) {
    const parsedLimit = Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 500) {
      throw new ApiValidationError("limit must be an integer from 1 through 500");
    }
    filter.limit = parsedLimit;
  }
  return filter;
}

export function parseCatalogConflictReviewFilter(search = ""): CatalogConflictReviewFilter {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  assertKnownQueryParams(
    params,
    ["source", "severity", "status", "catalogRecordId"],
    "catalog conflict",
  );
  const filter: CatalogConflictReviewFilter = {};
  const source = params.get("source");
  if (source !== null) {
    filter.source = enumParam(
      source,
      Object.values(catalogSourceValues) as CatalogSource[],
      "source",
    );
  }
  const severity = params.get("severity");
  if (severity !== null) {
    filter.severity = enumParam(
      severity,
      ["error", "warning", "info"] as CatalogConflictReviewSeverity[],
      "severity",
    );
  }
  const status = params.get("status");
  if (status !== null) {
    filter.status = enumParam(
      status,
      [
        ...Object.values(catalogConflictStatusValues),
        ...Object.values(catalogCandidateMatchStatusValues),
      ] as CatalogConflictReviewStatus[],
      "status",
    );
  }
  const catalogRecordId = params.get("catalogRecordId");
  if (catalogRecordId !== null) {
    if (catalogRecordId.trim().length === 0) {
      throw new ApiValidationError("catalogRecordId must be non-empty");
    }
    filter.catalogRecordId = catalogRecordId;
  }
  return filter;
}

export function parseRuntimeRunIdQuery(search = ""): string | undefined {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const runtimeRunId = params.get("runtimeRunId");
  if (runtimeRunId === null) {
    return undefined;
  }
  if (runtimeRunId.trim().length === 0) {
    throw new ApiValidationError("runtimeRunId must be non-empty");
  }
  return runtimeRunId;
}

export function parseTerminologySearchInput(search = ""): TerminologySearchInput {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const localeBranchId = params.get("localeBranchId");
  const query = params.get("q");
  if (localeBranchId === null || localeBranchId.trim().length === 0) {
    throw new ApiValidationError("localeBranchId must be non-empty");
  }
  if (query === null || query.trim().length === 0) {
    throw new ApiValidationError("q must be non-empty");
  }
  const input: TerminologySearchInput = {
    localeBranchId,
    query,
  };
  const projectId = params.get("projectId");
  if (projectId !== null) {
    if (projectId.trim().length === 0) {
      throw new ApiValidationError("projectId must be non-empty");
    }
    input.projectId = projectId;
  }
  const limit = params.get("limit");
  if (limit !== null) {
    const parsedLimit = Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      throw new ApiValidationError("limit must be an integer from 1 through 100");
    }
    input.limit = parsedLimit;
  }
  const includeDeprecated = params.get("includeDeprecated");
  if (includeDeprecated !== null) {
    if (includeDeprecated !== "true" && includeDeprecated !== "false") {
      throw new ApiValidationError("includeDeprecated must be true or false");
    }
    input.includeDeprecated = includeDeprecated === "true";
  }
  return input;
}

export function parseWikiObjectSnapshotQuery(search = ""): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  assertKnownQueryParams(params, ["snapshotId"], "wiki list");
  const snapshotId = params.get("snapshotId");
  if (snapshotId === null) throw new ApiValidationError("wiki list requires snapshotId");
  return nonEmptyParam(snapshotId, "snapshotId");
}

export function enumParam<T extends string>(
  value: string,
  allowed: readonly T[],
  label: string,
): T {
  if (!allowed.includes(value as T)) {
    throw new ApiValidationError(`${label} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

export function booleanParam(value: string, label: string): boolean {
  if (value !== "true" && value !== "false") {
    throw new ApiValidationError(`${label} must be true or false`);
  }
  return value === "true";
}

export function listParam(params: URLSearchParams, key: string): string[] {
  return params
    .getAll(key)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function assertKnownQueryParams(
  params: URLSearchParams,
  allowedKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of params.keys()) {
    if (!allowed.has(key)) {
      throw new ApiValidationError(`unknown ${label} query parameter: ${key}`);
    }
  }
}
