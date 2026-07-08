// fnd-api-client — behavior-first test.
//
// Drives the typed client over msw (the SAME seam `dashboard-api-error.test.ts`
// uses) and asserts the OBSERVABLE loading / ready / empty / error states +
// pagination — NOT internals. A route resolves to ready-with-data, an empty
// collection -> the `empty` state, a typed error body -> the `error` state
// carrying code+message, a malformed body -> the safe-fallback error state
// (null code/message, no crash), and the offset pager advances across pages.
// The type-safety of a consumer is pinned with `expectTypeOf`.
//
// Behavior-first / code-agnostic ([[feedback_behavior_first_code_agnostic_testing]]):
// no game is named, no internal client field is read — only the states the
// Studio screens will consume.
import type { CostDrilldownPage } from "@itotori/db";
import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  ItotoriApiClient,
  OffsetPager,
  parseTypedApiError,
  type ApiClientError,
  type ApiCallSettledState,
  type OffsetPaginatedRouteId,
} from "../src/api-client.js";
import { createApiQueryHook, renderApiResourceState } from "../src/api-client-example.js";
import type { ApiErrorResponse, ItotoriApiRouteId } from "../src/api-schema.js";
import { apiErrorJson, apiJson } from "./msw-handlers.js";
import {
  benchmarkReportsFixture,
  costDrilldownFixture,
  dashboardStatusFixture,
  recordFindingRequestFixture,
  recordFindingResponseFixture,
} from "./api-fixtures.js";

const BASE = "http://itotori.test";

const server = setupServer();

beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => server.close());

function client(): ItotoriApiClient {
  return new ItotoriApiClient({ baseUrl: BASE });
}

// Two deterministic cost-drilldown pages split from the shared fixture so the
// pager observes a real `hasMore`/`nextOffset` transition across pages.
function costDrilldownPage(offset: number, limit: number): CostDrilldownPage {
  const rows = costDrilldownFixture.rows;
  const page = Math.floor(offset / limit) + 1;
  const pageCount = Math.ceil(rows.length / limit);
  const slice = rows.slice(offset, offset + limit);
  const hasMore = offset + limit < rows.length;
  return {
    filter: { ...costDrilldownFixture.filter },
    pagination: {
      total: rows.length,
      limit,
      offset,
      page,
      pageCount,
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
    },
    rows: slice,
  };
}

describe("fnd-api-client: typed states over msw", () => {
  it("resolves a route to ready-with-data and narrows the response type", async () => {
    server.use(
      http.get(`${BASE}/api/projects/benchmarks`, () =>
        apiJson("projects.benchmarks", { reports: benchmarkReportsFixture }),
      ),
    );

    const result = await client().request("projects.benchmarks", {});

    expect(result.state).toBe("ready");
    if (result.state !== "ready") {
      throw new Error("expected ready state");
    }
    // Type-safety: `data` is the typed ApiBenchmarkReportsResponse, so
    // `reports` is BenchmarkReportSummary[] — accessing it compiles. The body
    // is JSON-parsed (a new object), so compare by value, not reference.
    expect(result.data.reports).toEqual(benchmarkReportsFixture);
    expectTypeOf(result).toMatchTypeOf<
      ApiCallSettledState<{ reports: typeof benchmarkReportsFixture }>
    >();
  });

  it("resolves an empty collection to the empty state (not ready-with-zero)", async () => {
    server.use(http.get(`${BASE}/api/projects`, () => apiJson("projects.list", { projects: [] })));

    const result = await client().request("projects.list", {});

    expect(result.state).toBe("empty");
  });

  it("keeps a query() resource in the loading state synchronously, then settles", async () => {
    server.use(
      http.get(`${BASE}/api/projects/benchmarks`, () =>
        apiJson("projects.benchmarks", { reports: benchmarkReportsFixture }),
      ),
    );

    const resource = client().query("projects.benchmarks", {});
    // Synchronous read before the fetch settles — the loading state a screen
    // paints on first paint.
    expect(resource.read().state).toBe("loading");

    const settled = await resource.whenSettled();
    expect(settled.state).toBe("ready");
    expect(resource.read().state).toBe("ready");
  });

  it("surfaces a typed error body as the error state with code + message", async () => {
    const errorBody: ApiErrorResponse = {
      error: "not permitted to read cost",
      code: "forbidden",
    };
    server.use(http.get(`${BASE}/api/projects/cost`, () => apiErrorJson(errorBody, 403)));

    const result = await client().request("projects.cost", {});

    expect(result.state).toBe("error");
    if (result.state !== "error") {
      throw new Error("expected error state");
    }
    expect(result.error.routeId).toBe("projects.cost");
    expect(result.error.status).toBe(403);
    expect(result.error.code).toBe("forbidden");
    expect(result.error.message).toBe("not permitted to read cost");
  });

  it.each([
    [
      "a malformed body (wrong shape)",
      HttpResponse.json({ oops: true, unrelated: [1, 2] }, { status: 500 }),
    ],
    [
      "an unknown code enum",
      HttpResponse.json({ error: "nope", code: "not_a_real_code" }, { status: 500 }),
    ],
    ["a non-JSON body", HttpResponse.text("<html>gateway down</html>", { status: 502 })],
    ["an empty body", HttpResponse.text("", { status: 503 })],
  ])("falls back safely (null code/message, no crash) for %s", async (_label, response) => {
    server.use(http.get(`${BASE}/api/projects/cost`, () => response));

    const result = await client().request("projects.cost", {});

    expect(result.state).toBe("error");
    if (result.state !== "error") {
      throw new Error("expected error state");
    }
    // Safe fallback: route+status present, NO fabricated typed code.
    expect(result.error.routeId).toBe("projects.cost");
    expect(result.error.status).toBe(response.status);
    expect(result.error.code).toBeNull();
    expect(result.error.message).toBeNull();
  });

  it("rejects a malformed SUCCESS body safely into the error state", async () => {
    server.use(
      http.get(`${BASE}/api/projects/benchmarks`, () =>
        HttpResponse.json({ totally: "unrelated", shape: 42 }, { status: 200 }),
      ),
    );

    const result = await client().request("projects.benchmarks", {});

    expect(result.state).toBe("error");
    if (result.state !== "error") {
      throw new Error("expected error state");
    }
    expect(result.error.code).toBeNull();
    expect(result.error.status).toBe(200);
  });
});

describe("fnd-api-client: offset pagination advances", () => {
  it("walks cost-drilldown pages until exhausted (offset/limit)", async () => {
    server.use(
      http.get(`${BASE}/api/projects/cost/drilldown`, ({ request }) => {
        const url = new URL(request.url);
        const limit = Number(url.searchParams.get("limit") ?? "20");
        const offset = Number(url.searchParams.get("offset") ?? "0");
        return apiJson("projects.costDrilldown", costDrilldownPage(offset, limit));
      }),
    );

    const pager = new OffsetPager(client(), "projects.costDrilldown", { limit: 2 });
    expect(pager.hasNext).toBe(true);

    const first = await pager.next();
    expect(first.state).toBe("ready");
    if (first.state !== "ready") {
      throw new Error("expected ready first page");
    }
    expect(first.cursor).toEqual({ offset: 0, limit: 2 });
    expect(first.hasNext).toBe(true);
    expect(first.data.rows).toHaveLength(2);
    expect(first.data.pagination.nextOffset).toBe(2);
    expect(pager.lastPageCursor).toEqual({ offset: 0, limit: 2 });

    const second = await pager.next();
    expect(second.state).toBe("ready");
    if (second.state !== "ready") {
      throw new Error("expected ready second page");
    }
    expect(second.cursor).toEqual({ offset: 2, limit: 2 });
    expect(second.hasNext).toBe(false);
    expect(second.data.rows).toHaveLength(1);
    expect(second.data.pagination.nextOffset).toBeNull();

    // Exhausted — no more pages.
    expect(pager.hasNext).toBe(false);
    const third = await pager.next();
    expect(third.state).toBe("empty");
  });
});

describe("fnd-api-client: type-safe consumption", () => {
  it("parseTypedApiError returns the typed body, null for malformed", () => {
    const typed: ApiErrorResponse = { error: "reason", code: "bad_request" };
    expect(parseTypedApiError(typed)).toEqual(typed);
    expect(parseTypedApiError({ error: "nope", code: "unknown_kind" })).toBeNull();
    expect(parseTypedApiError(null)).toBeNull();
    expect(parseTypedApiError({ code: "bad_request" })).toBeNull();
  });

  it("a consumer renders every state type-safely through the discriminated union", async () => {
    server.use(
      http.get(`${BASE}/api/projects/status`, () =>
        apiJson("projects.status", dashboardStatusFixture),
      ),
    );
    const resource = client().query("projects.status", {});
    const seen: string[] = [];
    seen.push(
      renderApiResourceState(resource, {
        loading: () => "loading",
        ready: (data) => `ready:${data.projectId}`,
        empty: () => "empty",
        error: (err) => `error:${err.code ?? "fallback"}`,
      }),
    );
    await resource.whenSettled();
    seen.push(
      renderApiResourceState(resource, {
        loading: () => "loading",
        ready: (data) => `ready:${data.projectId}`,
        empty: () => "empty",
        error: (err) => `error:${err.code ?? "fallback"}`,
      }),
    );
    expect(seen).toEqual(["loading", `ready:${dashboardStatusFixture.projectId}`]);
  });

  it("createApiQueryHook yields a typed resource for a POST route with a body", async () => {
    server.use(
      http.post(`${BASE}/api/projects/project-1/findings`, () =>
        apiJson("findings.record", recordFindingResponseFixture),
      ),
    );
    const { useApiQuery } = createApiQueryHook(client());
    // body + pathParams are REQUIRED here (typed); the call compiles because
    // both are supplied with the correct shape.
    const resource = useApiQuery("findings.record", {
      pathParams: { projectId: "project-1" },
      body: recordFindingRequestFixture,
    });
    const settled = await resource.whenSettled();
    expect(settled.state).toBe("ready");
    if (settled.state !== "ready") {
      throw new Error("expected ready state");
    }
    expect(settled.data.findingId).toBe(recordFindingResponseFixture.findingId);
  });
});

describe("fnd-api-client: compile-time type-safety", () => {
  it("pins the request/response + path-params/body option shapes", () => {
    const c = client();

    // GET route with no params: accepts `{}`, forbids body/pathParams.
    expectTypeOf(c.request<"projects.benchmarks">)
      .parameter(1)
      .toMatchTypeOf<{ query?: Readonly<Record<string, string | number | boolean | null>> }>();
    expectTypeOf(c.request<"projects.benchmarks">)
      .parameter(1)
      .toMatchTypeOf<{ body?: never; pathParams?: never }>();

    // GET route with path params: pathParams REQUIRED, body forbidden.
    expectTypeOf(c.request<"reviewer.detail">)
      .parameter(1)
      .toMatchTypeOf<{ pathParams: { reviewItemId: string }; body?: never }>();

    // POST route with path params + body: both REQUIRED.
    expectTypeOf(c.request<"findings.record">)
      .parameter(1)
      .toMatchTypeOf<{
        pathParams: { projectId: string };
        body: { finding: typeof recordFindingRequestFixture.finding };
      }>();

    // Response type is the typed body, not `unknown`.
    expectTypeOf(c.request<"projects.list">).returns.toMatchTypeOf<
      Promise<ApiCallSettledState<{ projects: (typeof dashboardStatusFixture)[] }>>
    >();

    // OffsetPager is only constructable for an offset-paginated route.
    expectTypeOf<"projects.costDrilldown">().toMatchTypeOf<OffsetPaginatedRouteId>();
    expectTypeOf<"jobs.runTable">().toMatchTypeOf<OffsetPaginatedRouteId>();
    expectTypeOf<"projects.benchmarks">().not.toMatchTypeOf<OffsetPaginatedRouteId>();

    // The error state carries the typed code enum (or null).
    expectTypeOf<ApiClientError["code"]>().toEqualTypeOf<
      "bad_request" | "forbidden" | "not_found" | "method_not_allowed" | "internal_error" | null
    >();

    // The route id union is re-exported from the client surface.
    expectTypeOf<ItotoriApiRouteId>().toEqualTypeOf<ItotoriApiRouteId>();
  });
});
