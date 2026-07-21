// MV/MZ branch explorer dashboard API.
//
// Exposes the `BranchCoverageReadModel` (see ./branch-coverage.ts) as a
// paginated, filterable dashboard API. Like the runtime status dashboard
// (./dashboard.ts), this app ships NO live HTTP server: the "API route" is a
// pure server-side page builder (`buildBranchCoveragePage`) plus a client
// fetch function (`fetchBranchCoveragePage`) that a host serves and that the
// tests front with MSW. The data is DERIVED entirely from the joined read
// model — no runtime host, browser playback, or screenshot capture.
//
// Every response record carries the six fields the branch explorer needs:
// branch id, route-map id(s), coverage status, observed trace ids, reachable
// text count, and artifact links (deterministically derived from the trace
// ids + route-map ids).

import {
  type BranchCoverageReadModel,
  type BranchCoverageRecord,
  type BranchCoverageSummary,
  type CoverageStatus,
} from "./branch-coverage.js";

export const BRANCH_EXPLORER_SCHEMA_VERSION = "utsushi.branch_explorer.v0.1";

// The default endpoint the client hits; a host serves the page builder here.
export const BRANCH_EXPLORER_DEFAULT_ENDPOINT = "/api/utsushi/v0.1/branch-coverage";

export const BRANCH_EXPLORER_DEFAULT_PAGE_SIZE = 20;
export const BRANCH_EXPLORER_MAX_PAGE_SIZE = 100;

// The four coverage states, re-exported for query validation.
export const COVERAGE_STATUS_VALUES = [
  "visited",
  "unvisited",
  "ambiguous",
  "unreachable",
] as const satisfies readonly CoverageStatus[];

export function isCoverageStatus(value: string): value is CoverageStatus {
  return (COVERAGE_STATUS_VALUES as readonly string[]).includes(value);
}

// A managed artifact-store link derived from a branch-coverage record. Points
// only at the managed `/artifact-store/` mount (never a raw fs / file: URL).
export type BranchArtifactLinkRel = "runtime-trace" | "route-map";

export type BranchArtifactLink = {
  rel: BranchArtifactLinkRel;
  refId: string;
  href: string;
  mediaType: string;
};

// One branch explorer API record: the read-model record plus its derived
// artifact links. Carries all six required fields.
export type BranchExplorerRecord = {
  branchId: string;
  routeKey?: string;
  routeMapIds: string[];
  coverageStatus: CoverageStatus;
  observedTraceIds: string[];
  reachableTextCount: number;
  artifactLinks: BranchArtifactLink[];
};

export type BranchExplorerQuery = {
  page?: number;
  pageSize?: number;
  status?: CoverageStatus | null;
};

export type BranchExplorerPageInfo = {
  page: number;
  pageSize: number;
  totalRecords: number;
  totalPages: number;
  hasPrev: boolean;
  hasNext: boolean;
};

export type BranchExplorerResponse = {
  schemaVersion: string;
  adapterId: string;
  filter: { coverageStatus: CoverageStatus | null };
  page: BranchExplorerPageInfo;
  records: BranchExplorerRecord[];
  summary: BranchCoverageSummary;
};

export type BranchExplorerError = {
  error: { code: string; message: string };
};

// Derive the managed artifact-store links for a record. One `runtime-trace`
// link per observed trace id, one `route-map` link per route-map id. Pure and
// deterministic — the same record always yields the same links.
function deriveArtifactLinks(
  adapterId: string,
  record: BranchCoverageRecord,
): BranchArtifactLink[] {
  const base = `/artifact-store/artifacts/utsushi/branch-coverage/${encodeURIComponent(adapterId)}`;
  const links: BranchArtifactLink[] = [];
  for (const traceId of record.observedTraceIds) {
    links.push({
      rel: "runtime-trace",
      refId: traceId,
      href: `${base}/traces/${encodeURIComponent(traceId)}.json`,
      mediaType: "application/json",
    });
  }
  for (const routeMapId of record.routeMapIds) {
    links.push({
      rel: "route-map",
      refId: routeMapId,
      href: `${base}/route-maps/${encodeURIComponent(routeMapId)}.json`,
      mediaType: "application/json",
    });
  }
  return links;
}

function toExplorerRecord(adapterId: string, record: BranchCoverageRecord): BranchExplorerRecord {
  return {
    branchId: record.branchId,
    ...(record.routeKey === undefined ? {} : { routeKey: record.routeKey }),
    routeMapIds: record.routeMapIds,
    coverageStatus: record.coverageStatus,
    observedTraceIds: record.observedTraceIds,
    reachableTextCount: record.reachableTextCount,
    artifactLinks: deriveArtifactLinks(adapterId, record),
  };
}

function normalizePageSize(value: number | undefined): number {
  if (value === undefined) {
    return BRANCH_EXPLORER_DEFAULT_PAGE_SIZE;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`pageSize must be a positive integer, got ${JSON.stringify(value)}`);
  }
  if (value > BRANCH_EXPLORER_MAX_PAGE_SIZE) {
    throw new Error(`pageSize ${value} exceeds max ${BRANCH_EXPLORER_MAX_PAGE_SIZE}`);
  }
  return value;
}

function normalizePage(value: number | undefined): number {
  if (value === undefined) {
    return 1;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`page must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

// Server-side route handler logic: filter the read model by coverage status,
// paginate, and attach derived artifact links. Pure — the same read model +
// query always produce the same page. This is what a host route serves and
// what the MSW handlers front in the tests.
export function buildBranchCoveragePage(
  model: BranchCoverageReadModel,
  query: BranchExplorerQuery = {},
): BranchExplorerResponse {
  const status = query.status ?? null;
  const pageSize = normalizePageSize(query.pageSize);
  const page = normalizePage(query.page);

  const filtered =
    status === null
      ? model.records
      : model.records.filter((record) => record.coverageStatus === status);

  const totalRecords = filtered.length;
  const totalPages = totalRecords === 0 ? 0 : Math.ceil(totalRecords / pageSize);
  const start = (page - 1) * pageSize;
  const slice = filtered.slice(start, start + pageSize);

  return {
    schemaVersion: BRANCH_EXPLORER_SCHEMA_VERSION,
    adapterId: model.adapterId,
    filter: { coverageStatus: status },
    page: {
      page,
      pageSize,
      totalRecords,
      totalPages,
      hasPrev: page > 1,
      hasNext: page < totalPages,
    },
    records: slice.map((record) => toExplorerRecord(model.adapterId, record)),
    summary: model.summary,
  };
}

// Parse a request URL's query string into a `BranchExplorerQuery`. Used by a
// host route (or an MSW handler) to turn `?page=&pageSize=&status=` into the
// typed query. Rejects an unknown coverage status.
export function parseBranchExplorerQuery(url: URL): BranchExplorerQuery {
  const query: BranchExplorerQuery = {};

  const pageParam = url.searchParams.get("page");
  if (pageParam !== null) {
    query.page = Number(pageParam);
  }

  const pageSizeParam = url.searchParams.get("pageSize");
  if (pageSizeParam !== null) {
    query.pageSize = Number(pageSizeParam);
  }

  const statusParam = url.searchParams.get("status");
  if (statusParam !== null && statusParam !== "") {
    if (!isCoverageStatus(statusParam)) {
      throw new Error(`unknown coverage status filter ${JSON.stringify(statusParam)}`);
    }
    query.status = statusParam;
  }

  return query;
}

function appendQuery(searchParams: URLSearchParams, query: BranchExplorerQuery): void {
  if (query.page !== undefined) {
    searchParams.set("page", String(query.page));
  }
  if (query.pageSize !== undefined) {
    searchParams.set("pageSize", String(query.pageSize));
  }
  if (query.status !== undefined && query.status !== null) {
    searchParams.set("status", query.status);
  }
}

function buildRequestUrl(endpoint: string, query: BranchExplorerQuery): string {
  const url = endpoint.startsWith("http")
    ? new URL(endpoint)
    : new URL(endpoint, window.location.href);
  appendQuery(url.searchParams, query);
  return url.toString();
}

function isBranchExplorerError(value: unknown): value is BranchExplorerError {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return false;
  }
  const { error } = value as { error: unknown };
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { message?: unknown }).message === "string"
  );
}

// Client-side fetch: build the query URL, request the page, and surface API
// error responses as thrown errors (so the UI can render an error state).
export async function fetchBranchCoveragePage(
  endpoint: string = BRANCH_EXPLORER_DEFAULT_ENDPOINT,
  query: BranchExplorerQuery = {},
): Promise<BranchExplorerResponse> {
  const response = await fetch(buildRequestUrl(endpoint, query));
  if (!response.ok) {
    let detail = "";
    try {
      const body: unknown = await response.json();
      if (isBranchExplorerError(body)) {
        detail = `: ${body.error.message}`;
      }
    } catch {
      // Non-JSON error body — fall back to the status code alone.
    }
    throw new Error(`failed to load branch coverage: ${response.status}${detail}`);
  }
  return (await response.json()) as BranchExplorerResponse;
}
