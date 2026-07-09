// fnd-api-client — the typed DATA LAYER the Studio screens consume.
//
// This is a UI-FOUNDATION leaf (DAG node fnd-api-client): a TYPED API client
// generated from `api-schema.ts` (the ItotoriApiRouteId union + the route /
// response / error types) and `api-contract.ts` (the ITOTORI_API_ROUTES
// registry — the SINGLE authority for method / path / path-params). It does
// NOT re-implement the contract: every call's request + response types come
// straight from api-schema.ts, every response is validated by the SAME
// `assertItotoriApiResponse` guard the server + contract harness use, and the
// error state carries the SAME typed `ApiErrorResponse` (`{ code, error }`)
// the existing dashboard error model (`DashboardApiError` in dashboard.ts)
// built — reusing `assertItotoriApiErrorResponse` for the safe-fallback parse.
// No game is hardcoded anywhere: a route id + config is the only identity.
//
// The client returns a discriminated `{ loading | ready | empty | error }`
// state per call (loading is the synchronous initial state of the stateful
// `ApiResource` returned by `query()`; `request()` returns the settled
// `ready | empty | error` states). PAGINATION primitives (`OffsetPager`) walk
// the offset-paginated route(s) per the api-schema `pagination` shape.
//
// This is the CLIENT CORE, independent of the SPA shell (fnd-spa-shell).
// A minimal type-safe consumption example lives in `api-client-example.ts`;
// the shell binding lives at `ui/use-api-resource.ts` (`useApiQuery` /
// `useApiResource` — the React `useSyncExternalStore` adapter for
// `ApiResource`).

import type {
  CostDrilldownPagination,
  ProjectDashboardStatus,
  RuntimeDashboardStatus,
} from "@itotori/db";
import { ITOTORI_API_ROUTES, interpolateRoutePath } from "./api-contract.js";
import {
  assertItotoriApiResponse,
  assertItotoriApiErrorResponse,
  type ApiAssetDecisionsResponse,
  type ApiCandidateAssetsResponse,
  type ApiCatalogBenchmarkSeedsResponse,
  type ApiCatalogCompletenessResponse,
  type ApiCatalogConflictReviewResponse,
  type ApiCatalogOpportunitiesResponse,
  type ApiDashboardDecisionsResponse,
  type ApiErrorResponse,
  type ApiBenchmarkReportsResponse,
  type ApiBmkCockpitResponse,
  type ApiBmkCockpitHistoryResponse,
  type ApiLaunchPassRequest,
  type ApiLaunchPassResponse,
  type ApiPlayRouteMapResponse,
  type ApiPlaySceneCoverageResponse,
  type ApiPlaySetSceneCoverageRequest,
  type ApiPlaySetSceneCoverageResponse,
  type ApiProjectCostDrilldownResponse,
  type ApiProjectCostResponse,
  type ApiProjectOverviewResponse,
  type ApiProjectImportRequest,
  type ApiProjectImportResponse,
  type ApiProjectsResponse,
  type ApiJobsRunTableResponse,
  type ApiQueueHealthResponse,
  type ApiRecordBenchmarkRequest,
  type ApiRecordBenchmarkResponse,
  type ApiRecordDecisionRequest,
  type ApiRecordDecisionResponse,
  type ApiRecordFindingRequest,
  type ApiRecordFindingResponse,
  type ApiReviewerBatchExecuteRequest,
  type ApiReviewerBatchExecuteResponse,
  type ApiReviewerBatchPreviewRequest,
  type ApiReviewerBatchPreviewResponse,
  type ApiReviewerDetailResponse,
  type ApiReviewerQueueDashboardResponse,
  type ApiReviewerSingleActionRequest,
  type ApiReviewerSingleActionResponse,
  type ApiRuntimeEvidenceRequest,
  type ApiRuntimeEvidenceResponse,
  type ApiAcceptMemberInvitationRequest,
  type ApiConfigureAuthSsoSettingsRequest,
  type ApiConfigureAuthSsoSettingsResponse,
  type ApiInviteMemberRequest,
  type ApiMemberInvitationResponse,
  type ApiMemberResponse,
  type ApiMembersListResponse,
  type ApiRemoveMemberRequest,
  type ApiRemoveMemberResponse,
  type ApiAuthCapabilitiesResponse,
  type ApiTerminologySearchResponse,
  type ApiWikiEntriesResponse,
  type ApiWorkspaceAssetBrowseResponse,
  type ApiWorkspaceComparisonResponse,
  type ApiWorkspaceCorrectionPreviewResponse,
  type ApiWorkspaceCorrectionSubmitRequest,
  type ApiWorkspaceCorrectionSubmitResponse,
  type ApiWorkspaceProjectBrowseResponse,
  type ApiWorkspaceSceneBrowseResponse,
  type ApiWorkspaceSearchResponse,
  type ApiDraftBranchRequest,
  type ApiDraftBranchResponse,
  type ItotoriApiRouteId,
} from "./api-schema.js";

// ---------------------------------------------------------------------------
// Route → TypeScript type map. A typed VIEW of the api-schema.ts body types
// (NOT a parallel type set): each entry associates a route id with its
// response body type, its request body type (POST routes only), its path
// params shape, and — for collection routes — the top-level key whose array
// emptiness defines the `empty` state. This is the contract authority's TS
// surface; the deep validation stays with `assertItotoriApiResponse`.
// ---------------------------------------------------------------------------

interface ItotoriApiRouteTypeMap {
  "assetDecisions.active": {
    response: ApiAssetDecisionsResponse;
    pathParams: { projectId: string; localeBranchId: string };
    collectionKey: "decisions";
  };
  "assetDecisions.candidates": {
    response: ApiCandidateAssetsResponse;
    pathParams: { projectId: string; localeBranchId: string };
    collectionKey: "candidateAssets";
  };
  "catalog.benchmarkSeeds": {
    response: ApiCatalogBenchmarkSeedsResponse;
    collectionKey: "rows";
  };
  "catalog.completeness": {
    response: ApiCatalogCompletenessResponse;
  };
  "catalog.conflicts": {
    response: ApiCatalogConflictReviewResponse;
    collectionKey: "rows";
  };
  "catalog.opportunities": {
    response: ApiCatalogOpportunitiesResponse;
    collectionKey: "rows";
  };
  "reviewer.queue": {
    response: ApiReviewerQueueDashboardResponse;
    collectionKey: "rows";
  };
  "reviewer.detail": {
    response: ApiReviewerDetailResponse;
    pathParams: { reviewItemId: string };
  };
  "reviewer.batchPreview": {
    response: ApiReviewerBatchPreviewResponse;
    request: ApiReviewerBatchPreviewRequest;
    collectionKey: "items";
  };
  "reviewer.batchExecute": {
    response: ApiReviewerBatchExecuteResponse;
    request: ApiReviewerBatchExecuteRequest;
  };
  "reviewer.itemAction": {
    response: ApiReviewerSingleActionResponse;
    pathParams: { reviewItemId: string };
    request: ApiReviewerSingleActionRequest;
  };
  "terminology.search": {
    response: ApiTerminologySearchResponse;
    collectionKey: "results";
  };
  "wiki.entries": {
    response: ApiWikiEntriesResponse;
    collectionKey: "entries";
  };
  "workspace.projects": {
    response: ApiWorkspaceProjectBrowseResponse;
    collectionKey: "projects";
  };
  "workspace.scenes": {
    response: ApiWorkspaceSceneBrowseResponse;
    collectionKey: "scenes";
  };
  "workspace.assets": {
    response: ApiWorkspaceAssetBrowseResponse;
    collectionKey: "assets";
  };
  "workspace.comparison": {
    response: ApiWorkspaceComparisonResponse;
    collectionKey: "cells";
  };
  "workspace.search": {
    response: ApiWorkspaceSearchResponse;
    collectionKey: "results";
  };
  "workspace.correctionPreview": {
    response: ApiWorkspaceCorrectionPreviewResponse;
    collectionKey: "units";
  };
  "workspace.correctionSubmit": {
    response: ApiWorkspaceCorrectionSubmitResponse;
    request: ApiWorkspaceCorrectionSubmitRequest;
  };
  "projects.list": {
    response: ApiProjectsResponse;
    collectionKey: "projects";
  };
  "projects.status": {
    response: ProjectDashboardStatus;
  };
  "projects.overview": {
    response: ApiProjectOverviewResponse;
  };
  "projects.decisions": {
    response: ApiDashboardDecisionsResponse;
    collectionKey: "pendingDecisions";
  };
  "projects.cost": {
    response: ApiProjectCostResponse;
  };
  "projects.costDrilldown": {
    response: ApiProjectCostDrilldownResponse;
    collectionKey: "rows";
  };
  "projects.benchmarks": {
    response: ApiBenchmarkReportsResponse;
    collectionKey: "reports";
  };
  "projects.bmkCockpit": {
    response: ApiBmkCockpitResponse;
    pathParams: { projectId: string };
  };
  "projects.bmkCockpitHistory": {
    response: ApiBmkCockpitHistoryResponse;
    pathParams: { projectId: string };
  };
  "jobs.runTable": {
    response: ApiJobsRunTableResponse;
    collectionKey: "rows";
  };
  "runtime.status": {
    response: RuntimeDashboardStatus;
  };
  "queue.health": {
    response: ApiQueueHealthResponse;
  };
  "imports.bridge": {
    response: ApiProjectImportResponse;
    request: ApiProjectImportRequest;
  };
  "branches.draft": {
    response: ApiDraftBranchResponse;
    pathParams: { projectId: string };
    request: ApiDraftBranchRequest;
  };
  "findings.record": {
    response: ApiRecordFindingResponse;
    pathParams: { projectId: string };
    request: ApiRecordFindingRequest;
  };
  "decisions.record": {
    response: ApiRecordDecisionResponse;
    pathParams: { projectId: string };
    request: ApiRecordDecisionRequest;
  };
  "benchmarks.record": {
    response: ApiRecordBenchmarkResponse;
    pathParams: { projectId: string };
    request: ApiRecordBenchmarkRequest;
  };
  "runtimeEvidence.ingest": {
    response: ApiRuntimeEvidenceResponse;
    pathParams: { projectId: string };
    request: ApiRuntimeEvidenceRequest;
  };
  "auth.ssoSettings.configure": {
    response: ApiConfigureAuthSsoSettingsResponse;
    request: ApiConfigureAuthSsoSettingsRequest;
  };
  "auth.members.list": {
    response: ApiMembersListResponse;
    collectionKey: "members";
  };
  // fnd-caps-context — Studio capability permission view for the SPA caps provider.
  "auth.capabilities": {
    response: ApiAuthCapabilitiesResponse;
  };
  "auth.members.invite": {
    response: ApiMemberInvitationResponse;
    request: ApiInviteMemberRequest;
  };
  "auth.members.accept": {
    response: ApiMemberResponse;
    pathParams: { invitationId: string };
    request: ApiAcceptMemberInvitationRequest;
  };
  "auth.members.remove": {
    response: ApiRemoveMemberResponse;
    pathParams: { membershipId: string };
    request: ApiRemoveMemberRequest;
  };
  // ovw-launch-pass-action — drive the next localization pass via the driver.
  // Project-scoped (path param); the body carries the locale branch the pass is
  // scoped to (server-verified against the project's ownership set).
  "projects.launchPass": {
    response: ApiLaunchPassResponse;
    pathParams: { projectId: string };
    request: ApiLaunchPassRequest;
  };
  // play-routemap-ui — route/choice tree with coverage from route-choice maps.
  "play.routeMap": {
    response: ApiPlayRouteMapResponse;
    pathParams: { projectId: string; localeBranchId: string };
    collectionKey: "nodes";
  };
  // play-mark-validated — per-scene coverage for the Play RouteMap.
  "play.sceneCoverage": {
    response: ApiPlaySceneCoverageResponse;
    pathParams: { projectId: string; localeBranchId: string };
    collectionKey: "nodes";
  };
  "play.setSceneCoverage": {
    response: ApiPlaySetSceneCoverageResponse;
    pathParams: { projectId: string; localeBranchId: string };
    request: ApiPlaySetSceneCoverageRequest;
  };
}

/** The typed response body a route returns (from api-schema.ts). */
export type ApiRouteResponse<R extends ItotoriApiRouteId> = ItotoriApiRouteTypeMap[R]["response"];

/** The typed request body a POST route accepts (from api-schema.ts); `void` for GET routes. */
export type ApiRouteRequestBody<R extends ItotoriApiRouteId> = ItotoriApiRouteTypeMap[R] extends {
  request: infer B;
}
  ? B
  : void;

/** The path-params shape a route requires; `void` for routes with no path params. */
export type ApiRoutePathParams<R extends ItotoriApiRouteId> = ItotoriApiRouteTypeMap[R] extends {
  pathParams: infer P;
}
  ? P
  : void;

// ---------------------------------------------------------------------------
// Per-call request options. Conditionally REQUIRE `pathParams` / `body` only
// for routes that have them, and FORBID them (`?: never`) for routes that do
// not — so a caller cannot pass a body to a GET route or omit a required path
// param. `exactOptionalPropertyTypes`-clean (no explicit `undefined`).
// ---------------------------------------------------------------------------

type ApiRequestOptionsBase<R extends ItotoriApiRouteId> = {
  /** Query-string params (added after the path template is interpolated). */
  query?: Readonly<Record<string, string | number | boolean | null>>;
  /**
   * Override the default `empty` detection. By default a route with a
   * `collectionKey` is `empty` when that collection array is length 0; a
   * route without one is never `empty` (always `ready`). Supply this to
   * apply route-specific semantics (e.g. treat a zero-row page as `ready`).
   */
  isEmpty?: (data: ApiRouteResponse<R>) => boolean;
};

export type ApiRequestOptionsFor<R extends ItotoriApiRouteId> = ApiRequestOptionsBase<R> &
  (ItotoriApiRouteTypeMap[R] extends { pathParams: infer P }
    ? { pathParams: P }
    : { pathParams?: never }) &
  (ItotoriApiRouteTypeMap[R] extends { request: infer B } ? { body: B } : { body?: never });

// ---------------------------------------------------------------------------
// States. A call is either `loading` (the synchronous initial state of an
// `ApiResource`) or one of the settled `ready | empty | error` states. The
// error state carries the typed `ApiErrorResponse` code + message with a SAFE
// fallback (`null` code/message) for malformed / missing / unreadable bodies,
// mirroring `DashboardApiError` / `DashboardApiErrorDetail` in dashboard.ts.
// ---------------------------------------------------------------------------

/**
 * The structured typed-error detail carried by the `error` state. Mirrors
 * `DashboardApiErrorDetail`: `routeId` + `status` are always present so a
 * fallback still points at the failing route; `code` + `message` are the
 * parsed typed `ApiErrorResponse` values, or `null` when the body was
 * malformed / missing / unreadable (safe fallback — never a fabricated code).
 */
export type ApiClientError = {
  routeId: ItotoriApiRouteId;
  status: number;
  code: ApiErrorResponse["code"] | null;
  message: string | null;
};

export type ApiCallSettledState<T> =
  | { state: "ready"; data: T }
  | { state: "empty" }
  | { state: "error"; error: ApiClientError };

export type ApiCallState<T> = { state: "loading" } | ApiCallSettledState<T>;

// ---------------------------------------------------------------------------
// Typed-error parsing — reuses `assertItotoriApiErrorResponse` (the api-schema
// authority) so a renamed `code` enum, a missing `error` string, or a leaked
// field resolves to `null` (safe fallback) instead of a crash or a
// half-parsed code. Mirrors `parseTypedApiError` in dashboard.ts; kept here
// (not imported from dashboard.ts) so the data layer stays BELOW the dashboard
// consumer in the dependency graph.
// ---------------------------------------------------------------------------

export function parseTypedApiError(body: unknown): ApiErrorResponse | null {
  try {
    assertItotoriApiErrorResponse(body);
    return body;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Default `empty` detection. Mirrors the `collectionKey` column of the type
// map above (a typed view, not a parallel schema). A route is `empty` by
// default when its collection array is length 0; routes without an entry are
// never `empty` (always `ready`).
// ---------------------------------------------------------------------------

const ITOTORI_API_COLLECTION_KEYS: Readonly<Partial<Record<ItotoriApiRouteId, string>>> = {
  "assetDecisions.active": "decisions",
  "assetDecisions.candidates": "candidateAssets",
  "catalog.benchmarkSeeds": "rows",
  "catalog.conflicts": "rows",
  "catalog.opportunities": "rows",
  "reviewer.queue": "rows",
  "reviewer.batchPreview": "items",
  "terminology.search": "results",
  "wiki.entries": "entries",
  "workspace.projects": "projects",
  "workspace.scenes": "scenes",
  "workspace.assets": "assets",
  "workspace.comparison": "cells",
  "workspace.search": "results",
  "workspace.correctionPreview": "units",
  "projects.list": "projects",
  "projects.decisions": "pendingDecisions",
  "projects.costDrilldown": "rows",
  "projects.benchmarks": "reports",
  "jobs.runTable": "rows",
  "play.routeMap": "nodes",
  // play-mark-validated — empty when no RouteMap nodes (no scenes to cover).
  "play.sceneCoverage": "nodes",
};

function defaultIsEmpty(routeId: ItotoriApiRouteId, data: unknown): boolean {
  const key = ITOTORI_API_COLLECTION_KEYS[routeId];
  if (key === undefined) {
    return false;
  }
  const collection = (data as Record<string, unknown> | null | undefined)?.[key];
  return Array.isArray(collection) && collection.length === 0;
}

// ---------------------------------------------------------------------------
// ApiResource — the stateful handle a consumer reads/subscribes to. Created
// in the `loading` state; transitions to the settled state when the
// underlying `request()` promise resolves. `read()` is synchronous so a
// consumer can render `loading` on first paint and re-render on subscribe.
// ---------------------------------------------------------------------------

export class ApiResource<T> {
  private state: ApiCallState<T>;
  private readonly listeners = new Set<() => void>();
  private readonly task: Promise<ApiCallSettledState<T>>;

  constructor(task: Promise<ApiCallSettledState<T>>) {
    this.state = { state: "loading" };
    this.task = task;
    void task.then((settled) => {
      this.state = settled;
      this.emit();
    });
  }

  /** The current state (`loading` until the call settles, then ready/empty/error). */
  read(): ApiCallState<T> {
    return this.state;
  }

  /** Subscribe to state transitions (fired once, when `loading` settles). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Await the settled state (ready/empty/error). */
  whenSettled(): Promise<ApiCallSettledState<T>> {
    return this.task;
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

// ---------------------------------------------------------------------------
// ItotoriApiClient — the typed client core.
// ---------------------------------------------------------------------------

export type ItotoriApiClientOptions = {
  /** Base origin for absolute URLs (e.g. `https://studio.itotori.dev`). Empty = relative. */
  baseUrl?: string;
  /** Inject a fetch (testing / SSR). Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
};

export type { ItotoriApiRouteId };

export class ItotoriApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ItotoriApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "";
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /**
   * Imperative typed call. Resolves to the settled `ready | empty | error`
   * state — never throws (network failures + malformed bodies resolve to the
   * `error` state with the safe-fallback detail). The response is validated
   * through `assertItotoriApiResponse` (the SAME guard the server + contract
   * harness use); a guard failure becomes an `error` state, not a crash.
   */
  async request<R extends ItotoriApiRouteId>(
    routeId: R,
    options: ApiRequestOptionsFor<R>,
  ): Promise<ApiCallSettledState<ApiRouteResponse<R>>> {
    const route = ITOTORI_API_ROUTES[routeId];
    const url = this.buildUrl(routeId, options);
    const init: RequestInit = {};
    if (route.method === "POST") {
      const body = (options as { body?: unknown }).body;
      init.method = "POST";
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    try {
      const response = await this.fetchImpl(url, init);
      if (!response.ok) {
        return { state: "error", error: await readApiClientError(routeId, response) };
      }
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        return {
          state: "error",
          error: { routeId, status: response.status, code: null, message: null },
        };
      }
      try {
        assertItotoriApiResponse(routeId, parsed);
      } catch (guardError) {
        const message = guardError instanceof Error ? guardError.message : String(guardError);
        return { state: "error", error: { routeId, status: response.status, code: null, message } };
      }
      const data = parsed as ApiRouteResponse<R>;
      const isEmpty =
        options.isEmpty ?? ((value: ApiRouteResponse<R>) => defaultIsEmpty(routeId, value));
      if (isEmpty(data)) {
        return { state: "empty" };
      }
      return { state: "ready", data };
    } catch (networkError) {
      const message = networkError instanceof Error ? networkError.message : String(networkError);
      return { state: "error", error: { routeId, status: 0, code: null, message } };
    }
  }

  /**
   * Stateful typed call. Returns an `ApiResource` synchronously in the
   * `loading` state; the resource transitions to the settled state when the
   * underlying `request()` resolves. This is the shape a UI hook/screen
   * consumes: `read()` for the current state, `subscribe()` for transitions,
   * `whenSettled()` to await.
   */
  query<R extends ItotoriApiRouteId>(
    routeId: R,
    options: ApiRequestOptionsFor<R>,
  ): ApiResource<ApiRouteResponse<R>> {
    const task = this.request<R>(routeId, options);
    return new ApiResource<ApiRouteResponse<R>>(task);
  }

  private buildUrl<R extends ItotoriApiRouteId>(
    routeId: R,
    options: ApiRequestOptionsFor<R>,
  ): string {
    const pathParams = (options as { pathParams?: Readonly<Record<string, string>> }).pathParams;
    const path = interpolateRoutePath(routeId, pathParams);
    const query = (
      options as { query?: Readonly<Record<string, string | number | boolean | null>> }
    ).query;
    const search = buildQueryString(query);
    const pathWithSearch = search === "" ? path : `${path}?${search}`;
    if (this.baseUrl === "") {
      return pathWithSearch;
    }
    return new URL(pathWithSearch, this.baseUrl).toString();
  }
}

// ---------------------------------------------------------------------------
// Pagination primitives. The api-schema currently carries ONE pagination
// shape — the offset-based pagination used by cost drilldown and jobs run-table
// (`{ total, limit, offset, page, pageCount, hasMore, nextOffset }`). The
// `OffsetPager` walks those pages, advancing the offset from each response's
// `nextOffset` until `hasMore` is false. A cursor-based primitive is the
// natural follow-on if/when a cursor-paginated route is added to the schema;
// `OffsetCursor` is shaped to extend to a `cursor` variant without forking.
// ---------------------------------------------------------------------------

export type OffsetCursor = {
  offset: number;
  limit: number;
};

/**
 * Route ids whose response carries an offset `pagination` field. Computed
 * from the api-schema response types, so `OffsetPager` is only callable for a
 * genuinely offset-paginated route.
 */
export type OffsetPaginatedRouteId = {
  [R in ItotoriApiRouteId]: ApiRouteResponse<R> extends { pagination: CostDrilldownPagination }
    ? R
    : never;
}[ItotoriApiRouteId];

export type OffsetPagerOptions<R extends OffsetPaginatedRouteId> = Omit<
  ApiRequestOptionsFor<R>,
  "isEmpty"
> & {
  /** Page size requested per fetch. */
  limit: number;
  /** Offset of the first page (defaults to 0). */
  initialOffset?: number;
};

export type OffsetPagerResult<R extends OffsetPaginatedRouteId> =
  | { state: "ready"; data: ApiRouteResponse<R>; cursor: OffsetCursor; hasNext: boolean }
  | { state: "empty" }
  | { state: "error"; error: ApiClientError };

export class OffsetPager<R extends OffsetPaginatedRouteId> {
  private readonly client: ItotoriApiClient;
  private readonly routeId: R;
  private readonly limit: number;
  private readonly options: OffsetPagerOptions<R>;
  private nextOffset: number | null;
  private lastCursor: OffsetCursor | null = null;

  constructor(client: ItotoriApiClient, routeId: R, options: OffsetPagerOptions<R>) {
    this.client = client;
    this.routeId = routeId;
    this.limit = options.limit;
    this.options = options;
    this.nextOffset = options.initialOffset ?? 0;
  }

  /** Whether a further page is available to fetch. */
  get hasNext(): boolean {
    return this.nextOffset !== null;
  }

  /** The cursor of the last fetched page, or `null` before the first fetch. */
  get lastPageCursor(): OffsetCursor | null {
    return this.lastCursor;
  }

  /**
   * Fetch the next page. Returns `ready` with the page + the cursor used +
   * `hasNext` (whether another page follows); `empty` once the pager is
   * exhausted (no `next()` left); `error` on a failed / malformed fetch (the
   * cursor is NOT advanced on error, so a retry re-fetches the same page).
   * Each successful page is returned `ready` even when its row array is empty
   * — page exhaustion is signalled by `hasNext: false`, not the `empty` state.
   */
  async next(): Promise<OffsetPagerResult<R>> {
    const offset = this.nextOffset;
    if (offset === null) {
      return { state: "empty" };
    }
    this.lastCursor = { offset, limit: this.limit };
    const result = await this.client.request<R>(this.routeId, this.buildOptions(offset));
    if (result.state === "ready") {
      const pagination = result.data.pagination;
      this.nextOffset = pagination.nextOffset;
      return {
        state: "ready",
        data: result.data,
        cursor: { offset, limit: this.limit },
        hasNext: pagination.nextOffset !== null,
      };
    }
    if (result.state === "error") {
      this.nextOffset = offset;
    }
    return result;
  }

  private buildOptions(offset: number): ApiRequestOptionsFor<R> {
    const base = this.options as Partial<ApiRequestOptionsFor<R>> & {
      query?: Readonly<Record<string, string | number | boolean | null>>;
    };
    const query: Record<string, string | number | boolean | null> = {
      ...base.query,
      limit: this.limit,
      offset,
    };
    return { ...base, query, isEmpty: () => false } as unknown as ApiRequestOptionsFor<R>;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function readApiClientError(
  routeId: ItotoriApiRouteId,
  response: Response,
): Promise<ApiClientError> {
  let code: ApiErrorResponse["code"] | null = null;
  let message: string | null = null;
  try {
    const body = await response.json();
    const typed = parseTypedApiError(body);
    if (typed !== null) {
      code = typed.code;
      message = typed.error;
    }
  } catch {
    // Body was not JSON / empty / unreadable — fall back safely.
  }
  return { routeId, status: response.status, code, message };
}

function buildQueryString(
  query: Readonly<Record<string, string | number | boolean | null>> | undefined,
): string {
  if (query === undefined) {
    return "";
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null) {
      continue;
    }
    params.set(key, String(value));
  }
  return params.toString();
}
