// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { renderDashboard, type DashboardEndpoints } from "../src/dashboard.js";
import { dashboardDecisionsFixture, dashboardStatusFixture } from "./api-fixtures.js";
import { apiJson, itotoriApiMswHandlers } from "./msw-handlers.js";

const server = setupServer(...itotoriApiMswHandlers);

const dashboardEndpoints: DashboardEndpoints = {
  projects: "http://itotori.test/api/projects",
  status: "http://itotori.test/api/projects/status",
  decisions: "http://itotori.test/api/projects/decisions",
  cost: "http://itotori.test/api/projects/cost",
  runtime: "http://itotori.test/api/runtime/v0.2/status",
};

beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  document.body.innerHTML = "";
});
afterAll(() => server.close());

describe("Itotori dashboard", () => {
  it("renders the API-backed workbench shell with pending decisions", async () => {
    const root = document.createElement("div");
    document.body.append(root);

    await renderDashboard(root, dashboardEndpoints);

    expect(root.querySelector('[data-state="ready"]')).not.toBeNull();
    expect(root.textContent).toContain("Projects");
    expect(root.textContent).toContain("Import status");
    expect(root.textContent).toContain("Locale branches");
    expect(root.textContent).toContain("Style guide");
    expect(dashboardStatusFixture.selectedLocaleBranchId).toBe(
      "019ed065-0000-7000-8000-000000000110",
    );
    expect(dashboardStatusFixture.currentStyleGuidePolicyVersionId).toBe(
      "019ed065-0000-7000-8000-000000000120",
    );
    expect(root.textContent).toContain("019ed065-0000-7000-8000-000000000110");
    expect(root.textContent).toContain("019ed065-0000-7000-8000-000000000120");
    expect(root.textContent).not.toContain("019ed065-0000-7000-8000-000000000020");
    expect(root.textContent).toContain("Glossary");
    expect(root.textContent).toContain("Jobs");
    expect(root.textContent).toContain("QA findings");
    expect(root.textContent).toContain("Runtime evidence");
    expect(root.textContent).toContain("Benchmarks");

    const pendingDecisions = root.querySelector('[aria-label="Pending decisions"]');
    expect(pendingDecisions?.textContent).toContain("3 pending decisions");
    expect(pendingDecisions?.textContent).toContain("1 project-level finding decision pending");
    expect(pendingDecisions?.textContent).toContain("1 locale branch finding decision pending");
    expect(pendingDecisions?.textContent).toContain("1 runtime validation decision pending");
    expect(pendingDecisions?.textContent).toContain("Project");
    expect(pendingDecisions?.textContent).toContain("en-US");
    expect(pendingDecisions?.textContent).toContain("Runtime evidence");

    const qaFindings = root.querySelector('[aria-label="QA findings"]');
    expect(qaFindings?.textContent).toContain("Project-level findings");
    expect(qaFindings?.textContent).toContain("Runtime validation");

    const projectFindingCell = root
      .querySelector('[aria-label="Projects"] tbody tr')
      ?.children.item(5);
    expect(projectFindingCell?.textContent).toBe(
      String(dashboardDecisionsFixture.counts.pendingDecisionCount),
    );
    expect(dashboardDecisionsFixture.counts.pendingDecisionCount).toBe(
      dashboardStatusFixture.findingCount,
    );

    expect(root.textContent).toContain("runtime_ingested");
    expect(root.textContent).toContain("revision-1");
    expect(root.textContent).toContain("1 (1 new / 0 updated / 0 removed)");
    expect(root.textContent).toContain("Catalog");
    expect(root.textContent).toContain("Readiness");
    expect(root.textContent).toContain("1/1");
    expect(root.textContent).toContain("patch_result_recorded");
    expect(root.textContent).toContain("billed");
    expect(root.textContent).toContain("TM avoided");
    expect(root.textContent).toContain("TM tokens saved");
    expect(root.textContent).toContain("bridge-unit-repeat");
    expect(root.textContent).toContain("exact");
    expect(root.textContent).toContain("itotori-draft-default-v1");
    expect(root.textContent).toContain("benchmark_qa");
    expect(root.textContent).toContain("itotori-fake-qa-v0 -> itotori-fake-qa-v1");
    // ITOTORI-230 — the dashboard renders the captured routing posture
    // verbatim per row (zdr / data_collection fields); the fixture in
    // api-fixtures.ts uses the canonical alpha posture.
    expect(root.textContent).toContain("zdr=true; data_collection=deny");
    expect(root.textContent).toContain("hello_world_failed");
  });

  it("renders a loading state before API reads settle", async () => {
    const root = document.createElement("div");
    document.body.append(root);

    const render = renderDashboard(root, dashboardEndpoints);

    expect(root.querySelector('[data-state="loading"]')).not.toBeNull();
    expect(root.textContent).toContain("Loading dashboard");

    await render;
  });

  it("renders an empty state when the projects API returns no projects", async () => {
    server.use(
      http.get("http://itotori.test/api/projects", () =>
        apiJson("projects.list", { projects: [] }),
      ),
    );
    const root = document.createElement("div");
    document.body.append(root);

    await renderDashboard(root, dashboardEndpoints);

    expect(root.querySelector('[data-state="empty"]')).not.toBeNull();
    expect(root.textContent).toContain("No projects");
    expect(root.textContent).toContain("No projects were returned by the API.");
  });

  it("renders an error state when an API read fails", async () => {
    server.use(
      http.get("http://itotori.test/api/projects", () =>
        HttpResponse.json({ error: "offline", code: "internal_error" }, { status: 500 }),
      ),
    );
    const root = document.createElement("div");
    document.body.append(root);

    await renderDashboard(root, dashboardEndpoints);

    expect(root.querySelector('[data-state="error"]')).not.toBeNull();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      "Dashboard data could not load.",
    );
    expect(root.textContent).toContain("failed to load projects.list: 500");
  });

  it("checks MSW project fixtures against the real API response schema", () => {
    expect(() => apiJson("projects.status", dashboardStatusFixture)).not.toThrow();
    expect(() => apiJson("projects.decisions", dashboardDecisionsFixture)).not.toThrow();
    expect(() =>
      apiJson("projects.decisions", {
        ...dashboardDecisionsFixture,
        counts: {
          ...dashboardDecisionsFixture.counts,
          pendingDecisionCount: 2,
        },
      }),
    ).toThrow("pendingDecisionCount");
    expect(() =>
      apiJson("projects.list", {
        projects: [
          {
            projectId: "project-1",
            status: "runtime_ingested",
          },
        ],
      } as never),
    ).toThrow("projectKey");
  });
});
