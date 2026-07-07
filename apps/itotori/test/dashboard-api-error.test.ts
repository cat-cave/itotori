// @vitest-environment jsdom
//
// ITOTORI-057 — pins the typed API error rendering in the dashboard shell.
// A failed read that carries a typed `{ code, error }` body surfaces the
// actionable code + message (in both the whole-shell error state and the
// per-panel unavailable notice), while a malformed / missing / unreadable
// error body falls back to a SAFE generic state — never a crash, never a
// fabricated code.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  DashboardApiError,
  parseTypedApiError,
  renderDashboard,
  type DashboardEndpoints,
} from "../src/dashboard.js";
import { itotoriApiMswHandlers, apiErrorJson } from "./msw-handlers.js";
import type { ApiErrorResponse } from "../src/api-schema.js";

const server = setupServer(...itotoriApiMswHandlers);

const dashboardEndpoints: DashboardEndpoints = {
  projects: "http://itotori.test/api/projects",
  status: "http://itotori.test/api/projects/status",
  decisions: "http://itotori.test/api/projects/decisions",
  reviewerQueue: "http://itotori.test/api/reviewer/queue",
  cost: "http://itotori.test/api/projects/cost",
  costDrilldown: "http://itotori.test/api/projects/cost/drilldown",
  benchmarks: "http://itotori.test/api/projects/benchmarks",
  runtime: "http://itotori.test/api/runtime/v0.2/status",
};

beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  document.body.innerHTML = "";
});
afterAll(() => server.close());

async function renderRoot(): Promise<HTMLElement> {
  const root = document.createElement("div");
  document.body.append(root);
  await renderDashboard(root, dashboardEndpoints);
  return root;
}

describe("ITOTORI-057 parseTypedApiError (pure parser)", () => {
  it.each([
    ["bad_request", "a typed bad_request body"],
    ["forbidden", "a typed forbidden body"],
    ["not_found", "a typed not_found body"],
    ["method_not_allowed", "a typed method_not_allowed body"],
    ["internal_error", "a typed internal_error body"],
  ])("returns the typed body for code=%s (%s)", (code) => {
    const body: ApiErrorResponse = { error: `reason for ${code}`, code };
    expect(parseTypedApiError(body)).toEqual(body);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a non-object string", "internal_error"],
    ["a body missing the error string", { code: "bad_request" }],
    ["a body missing the code", { error: "nope" }],
    ["a body with an unknown code enum", { error: "nope", code: "unknown_kind" }],
    ["a body with a non-string error", { error: 5, code: "bad_request" }],
    ["a body with a non-string code", { error: "nope", code: 5 }],
    ["a body with an extra leaked field", { error: "nope", code: "bad_request", extra: 1 }],
    ["an array body", [{ error: "nope", code: "bad_request" }]],
  ])("returns null (safe fallback) for %s", (_label, value) => {
    expect(parseTypedApiError(value)).toBeNull();
  });
});

describe("ITOTORI-057 DashboardApiError", () => {
  it("keeps the route+status fallback message and carries the typed detail", () => {
    const error = new DashboardApiError({
      routeId: "projects.cost",
      status: 403,
      code: "forbidden",
      message: "not permitted to read cost",
    });
    // The base Error.message keeps the existing `failed to load <route>:
    // <status>` form so logs / existing assertions stay meaningful.
    expect(error.message).toBe("failed to load projects.cost: 403"); // itotori-225-audit-allow: route id + HTTP status, not a model cost
    expect(error.routeId).toBe("projects.cost");
    expect(error.status).toBe(403);
    expect(error.code).toBe("forbidden");
    expect(error.typedMessage).toBe("not permitted to read cost");
    expect(error.detail).toEqual({
      routeId: "projects.cost",
      status: 403,
      code: "forbidden",
      message: "not permitted to read cost",
    });
  });

  it("falls back to null code/message when the body was malformed", () => {
    const error = new DashboardApiError({
      routeId: "projects.cost",
      status: 502,
      code: null,
      message: null,
    });
    expect(error.message).toBe("failed to load projects.cost: 502"); // itotori-225-audit-allow: route id + HTTP status, not a model cost
    expect(error.code).toBeNull();
    expect(error.typedMessage).toBeNull();
  });
});

describe("ITOTORI-057 whole-shell error renders typed code + message", () => {
  it("renders the typed code + message when the failing body is typed", async () => {
    server.use(
      http.get("http://itotori.test/api/projects", () =>
        apiErrorJson(
          { error: "the ledger is offline for maintenance", code: "internal_error" },
          500,
        ),
      ),
    );
    const root = await renderRoot();

    expect(root.querySelector('[data-state="error"]')).not.toBeNull();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      "Dashboard data could not load.",
    );
    // The actionable typed code + message render distinctly.
    const detail = root.querySelector(".api-error-detail");
    expect(detail).not.toBeNull();
    expect(detail?.getAttribute("data-api-error-code")).toBe("internal_error");
    expect(detail?.querySelector(".api-error-code")?.textContent).toBe("internal_error");
    expect(detail?.querySelector(".api-error-message")?.textContent).toContain(
      "the ledger is offline for maintenance",
    );
    // The generic route/status fallback is still present underneath.
    expect(root.textContent).toContain("failed to load projects.list: 500");
  });

  it.each([
    [
      "a malformed body (wrong shape)",
      HttpResponse.json({ oops: true, unrelated: ["fields"] }, { status: 500 }),
    ],
    [
      "an unknown code enum",
      HttpResponse.json({ error: "nope", code: "not_a_real_code" }, { status: 500 }),
    ],
    ["a non-JSON body", HttpResponse.text("<html>gateway down</html>", { status: 502 })],
    ["an empty body", HttpResponse.text("", { status: 503 })],
  ])("falls back safely for %s (no crash, no fabricated code)", async (_label, response) => {
    server.use(http.get("http://itotori.test/api/projects", () => response));
    const root = await renderRoot();

    // The shell still renders the error state — the malformed body never
    // breaks it.
    expect(root.querySelector('[data-state="error"]')).not.toBeNull();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      "Dashboard data could not load.",
    );
    // The safe fallback detail renders, NOT a typed code.
    const fallback = root.querySelector(".api-error-detail-fallback");
    expect(fallback).not.toBeNull();
    expect(fallback?.getAttribute("data-api-error-code")).toBe("unavailable");
    expect(fallback?.textContent).toContain("did not include a typed error body");
    // No fabricated typed code is ever rendered.
    expect(
      root.querySelector('.api-error-detail[data-api-error-code="internal_error"]'),
    ).toBeNull();
    expect(root.querySelector(".api-error-code")).toBeNull();
  });
});

describe("ITOTORI-057 per-panel unavailable notice renders typed code + message", () => {
  it("renders the typed code inline when the cost query fails with a typed body", async () => {
    server.use(
      http.get("http://itotori.test/api/projects/cost", () =>
        apiErrorJson({ error: "not permitted to read cost", code: "forbidden" }, 403),
      ),
    );
    const root = await renderRoot();

    // The dashboard stays ready — the failed panel is isolated.
    expect(root.querySelector('[data-state="ready"]')).not.toBeNull();
    expect(root.querySelector('[data-state="error"]')).toBeNull();

    // Both Jobs and Model cost share the cost query and inherit the typed
    // detail. The unavailable notice carries the inline code + message.
    for (const id of ["jobs", "cost"]) {
      const panel = root.querySelector(`#${id}`);
      expect(panel?.getAttribute("data-panel-state")).toBe("unavailable");
      const notice = panel?.querySelector('[data-panel-state-notice="unavailable"]');
      expect(notice).not.toBeNull();
      const inline = notice?.querySelector(".api-error-inline");
      expect(inline).not.toBeNull();
      expect(inline?.getAttribute("data-api-error-code")).toBe("forbidden");
      expect(inline?.querySelector("code")?.textContent).toBe("forbidden");
      expect(inline?.textContent).toContain("not permitted to read cost");
    }
  });

  it("falls back safely (no inline code) when the benchmarks query fails with a malformed body", async () => {
    server.use(
      http.get("http://itotori.test/api/projects/benchmarks", () =>
        HttpResponse.json({ totally: "unrelated", shape: 42 }, { status: 500 }),
      ),
    );
    const root = await renderRoot();

    expect(root.querySelector('[data-state="ready"]')).not.toBeNull();
    for (const id of ["benchmarks", "qa-agent-metrics", "benchmark-reports"]) {
      const panel = root.querySelector(`#${id}`);
      expect(panel?.getAttribute("data-panel-state")).toBe("unavailable");
      const notice = panel?.querySelector('[data-panel-state-notice="unavailable"]');
      expect(notice).not.toBeNull();
      // Safe fallback: NO inline typed code is rendered for a malformed body.
      expect(notice?.querySelector(".api-error-inline")).toBeNull();
      // The generic unavailable copy is still present.
      expect(notice?.textContent).toContain("could not be loaded");
    }
  });
});
