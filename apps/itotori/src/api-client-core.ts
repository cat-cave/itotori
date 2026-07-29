import { API_ROUTES, interpolateRoutePath } from "./api-routes.js";
import {
  assertBrowserItotoriApiErrorResponse,
  assertBrowserItotoriApiResponse,
} from "./api-client-guards.js";
import type { ApiErrorResponse } from "./api-schema.js";
import type {
  ApiCallSettledState,
  ApiCallState,
  ApiClientError,
  ApiRequestOptionsFor,
  ApiRouteResponse,
  ItotoriApiRouteId,
} from "./api-client-types.js";

export function parseTypedApiError(body: unknown): ApiErrorResponse | null {
  try {
    assertBrowserItotoriApiErrorResponse(body);
    return body;
  } catch {
    return null;
  }
}

const API_COLLECTION_KEYS: Readonly<Partial<Record<ItotoriApiRouteId, string>>> = {
  "assetDecisions.active": "decisions",
  "assetDecisions.candidates": "candidateAssets",
  "catalog.benchmarkSeeds": "rows",
  "catalog.conflicts": "rows",
  "catalog.opportunities": "rows",
  "terminology.search": "results",
  "wiki.list": "sourceObjects",
  "projects.list": "projects",
  "projects.decisions": "pendingDecisions",
  "projects.costDrilldown": "rows",
  "projects.benchmarks": "reports",
  "jobs.runTable": "rows",
  "auth.members.list": "members",
  "auth.permissionSets.list": "permissionSets",
  "auth.sessions.list": "sessions",
  "play.routeMap": "nodes",
  "play.delivery": "units",
  "patchIteration.versions": "versions",
};

function defaultIsEmpty(routeId: ItotoriApiRouteId, data: unknown): boolean {
  const key = API_COLLECTION_KEYS[routeId];
  if (key === undefined) {
    return false;
  }
  const collection = (data as Record<string, unknown> | null | undefined)?.[key];
  return Array.isArray(collection) && collection.length === 0;
}

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

  read(): ApiCallState<T> {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  whenSettled(): Promise<ApiCallSettledState<T>> {
    return this.task;
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export type ItotoriApiClientOptions = {
  baseUrl?: string;
  fetch?: typeof fetch;
};

export class ItotoriApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ItotoriApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "";
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async request<R extends ItotoriApiRouteId>(
    routeId: R,
    options: ApiRequestOptionsFor<R>,
  ): Promise<ApiCallSettledState<ApiRouteResponse<R>>> {
    const route = API_ROUTES[routeId];
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
        assertBrowserItotoriApiResponse(routeId, parsed);
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
    return this.baseUrl === "" ? pathWithSearch : new URL(pathWithSearch, this.baseUrl).toString();
  }
}

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
    if (value !== null) {
      params.set(key, String(value));
    }
  }
  return params.toString();
}
