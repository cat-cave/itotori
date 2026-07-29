import type { CostDrilldownFilter } from "@itotori/db";
import { ApiValidationError, type LoadJobsRunTableOptions } from "./api-schema.js";
import type { ProjectOverviewReadModelOptions } from "./project-overview-read-model.js";

export function parseCostDrilldownFilter(search = ""): CostDrilldownFilter {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  assertKnownQueryParams(
    params,
    ["projectId", "systemId", "from", "to", "limit", "offset"],
    "cost drilldown",
  );
  return parseCostDrilldownParams(params);
}

export function parseJobsRunTableQuery(search = ""): LoadJobsRunTableOptions {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  assertKnownQueryParams(params, ["projectId", "limit", "offset"], "jobs run table");
  const options: LoadJobsRunTableOptions = {};
  // SECURITY (jobs-run-table cross-project leak, P1) — the run table is a
  // PROJECT-SCOPED read. `projectId` is REQUIRED: an omitted projectId must
  // NOT fall through to an all-projects read. We fail closed at the route
  // boundary with a 400 before the service is ever consulted; the read model
  // itself also refuses a missing/empty scope (defense in depth).
  const projectId = params.get("projectId");
  if (projectId === null) {
    throw new ApiValidationError("projectId is required");
  }
  options.projectId = nonEmptyParam(projectId, "projectId");
  const limit = parseNonNegativeIntParam(params.get("limit"), "limit");
  if (limit !== undefined) {
    if (limit < 1) {
      throw new ApiValidationError("limit must be a positive integer");
    }
    options.limit = limit;
  }
  const offset = parseNonNegativeIntParam(params.get("offset"), "offset");
  if (offset !== undefined) {
    options.offset = offset;
  }
  return options;
}

export function parseAuthMembersListQuery(search = ""): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  assertKnownQueryParams(params, ["accountId"], "auth members list");
  const accountId = params.get("accountId");
  if (accountId === null || accountId.length === 0) {
    throw new ApiValidationError("accountId is required");
  }
  return accountId;
}

export function parseModelRoutingSettingsQuery(search = ""): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  assertKnownQueryParams(params, ["projectId"], "model routing settings");
  const projectId = params.get("projectId");
  if (projectId === null || projectId.length === 0) {
    throw new ApiValidationError("projectId is required");
  }
  return projectId;
}

export function parseAuthBillingSeatUsageQuery(search = ""): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  assertKnownQueryParams(params, ["accountId"], "auth billing seat usage");
  const accountId = params.get("accountId");
  if (accountId === null || accountId.length === 0) {
    throw new ApiValidationError("accountId is required");
  }
  return accountId;
}

export function parseAuthPermissionSetsListQuery(search = ""): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  assertKnownQueryParams(params, ["accountId"], "auth permission sets list");
  const accountId = params.get("accountId");
  if (accountId === null || accountId.length === 0) {
    throw new ApiValidationError("accountId is required");
  }
  return accountId;
}

/**
 * The optional PROJECT SCOPE shared by every project-scoped read route. The
 * product runs several localizations at once, so each of these reads names its
 * project explicitly; an ABSENT scope keeps its established meaning (the
 * workspace's most recently updated project) so existing callers are
 * unaffected. The value is only ever forwarded to a repository query — no read
 * path filters a wider result set down in application code.
 */
export function parseProjectScopeQuery(
  search: string | undefined,
  label: string,
  alsoAllowed: readonly string[] = [],
): string | undefined {
  const raw = search ?? "";
  const params = new URLSearchParams(raw.startsWith("?") ? raw.slice(1) : raw);
  assertKnownQueryParams(params, ["projectId", ...alsoAllowed], label);
  const projectId = params.get("projectId");
  if (projectId === null) {
    return undefined;
  }
  return nonEmptyParam(projectId, "projectId");
}

export function parseProjectOverviewFilter(search = ""): ProjectOverviewReadModelOptions {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  assertKnownQueryParams(
    params,
    [
      "projectId",
      "systemId",
      "from",
      "to",
      "limit",
      "offset",
      "journalLocaleBranchId",
      "journalLimit",
      "journalOffset",
    ],
    "project overview",
  );
  const costDrilldown = parseCostDrilldownParams(params);
  const journalLocaleBranchId = params.get("journalLocaleBranchId");
  const journalLimit = parseNonNegativeIntParam(params.get("journalLimit"), "journalLimit");
  if (journalLimit !== undefined && journalLimit < 1) {
    throw new ApiValidationError("journalLimit must be a positive integer");
  }
  const journalOffset = parseNonNegativeIntParam(params.get("journalOffset"), "journalOffset");
  return {
    // The overview's project scope and its embedded cost-drilldown scope are the
    // SAME `projectId` parameter: `parseCostDrilldownParams` already reads it,
    // so the composed read model and its drilldown page cannot disagree.
    ...(costDrilldown.projectId === undefined ? {} : { projectId: costDrilldown.projectId }),
    costDrilldown,
    journal: {
      ...(journalLocaleBranchId !== null
        ? { localeBranchId: nonEmptyParam(journalLocaleBranchId, "journalLocaleBranchId") }
        : {}),
      ...(journalLimit !== undefined ? { limit: journalLimit } : {}),
      ...(journalOffset !== undefined ? { offset: journalOffset } : {}),
    },
  };
}

function parseCostDrilldownParams(params: URLSearchParams): CostDrilldownFilter {
  const filter: CostDrilldownFilter = {};
  const projectId = params.get("projectId");
  if (projectId !== null) {
    if (projectId.trim().length === 0) {
      throw new ApiValidationError("projectId must be non-empty");
    }
    filter.projectId = projectId;
  }
  const systemId = params.get("systemId");
  if (systemId !== null) {
    if (systemId.trim().length === 0) {
      throw new ApiValidationError("systemId must be non-empty");
    }
    filter.systemId = systemId;
  }
  const from = parseIsoDateParam(params.get("from"), "from");
  if (from !== undefined) {
    filter.from = from;
  }
  const to = parseIsoDateParam(params.get("to"), "to");
  if (to !== undefined) {
    filter.to = to;
  }
  if (filter.from && filter.to && filter.from.getTime() > filter.to.getTime()) {
    throw new ApiValidationError("from must not be after to");
  }
  const limit = parseNonNegativeIntParam(params.get("limit"), "limit");
  if (limit !== undefined) {
    if (limit < 1) {
      throw new ApiValidationError("limit must be a positive integer");
    }
    filter.limit = limit;
  }
  const offset = parseNonNegativeIntParam(params.get("offset"), "offset");
  if (offset !== undefined) {
    filter.offset = offset;
  }
  return filter;
}

export function nonEmptyParam(value: string, label: string): string {
  if (value.trim().length === 0) {
    throw new ApiValidationError(`${label} must be non-empty`);
  }
  return value;
}

function parseIsoDateParam(raw: string | null, label: string): Date | undefined {
  if (raw === null) {
    return undefined;
  }
  const millis = Date.parse(raw);
  if (Number.isNaN(millis)) {
    throw new ApiValidationError(`${label} must be an ISO-8601 date-time`);
  }
  return new Date(millis);
}

function parseNonNegativeIntParam(raw: string | null, label: string): number | undefined {
  if (raw === null) {
    return undefined;
  }
  if (!/^\d+$/u.test(raw.trim())) {
    throw new ApiValidationError(`${label} must be a non-negative integer`);
  }
  return Number.parseInt(raw.trim(), 10);
}

function assertKnownQueryParams(
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
