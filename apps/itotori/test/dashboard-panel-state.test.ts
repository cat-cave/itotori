// @vitest-environment jsdom
//
// ITOTORI-056 — pins the dashboard panel state model. The style-guide,
// glossary, jobs, and benchmark sections each carry one of four query
// states — `unknown` (not queried), `unavailable` (query failed),
// `empty` (queried, genuinely no data), `populated` (has data) — stamped
// on the panel element as `data-panel-state`. A panel NEVER presents
// unqueried or failed data as a confirmed empty state.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ProjectCostReport } from "@itotori/db";
import { renderDashboard, type DashboardEndpoints } from "../src/dashboard.js";
import {
  benchmarkReportsFixture,
  costReportFixture,
  dashboardStatusFixture,
} from "./api-fixtures.js";
import { apiJson, itotoriApiMswHandlers } from "./msw-handlers.js";

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

async function renderReadyRoot(): Promise<HTMLElement> {
  const root = document.createElement("div");
  document.body.append(root);
  await renderDashboard(root, dashboardEndpoints);
  return root;
}

// ITOTORI-056 — a valid cost report whose recentRuns list is genuinely
// empty. Used to drive the Jobs panel into its `empty` state WITHOUT
// making the cost query fail (the API answered, there are just no runs).
const emptyRecentRunsCostReport: ProjectCostReport = {
  ...costReportFixture,
  runCount: 0,
  billedMicrosUsd: 0,
  zeroRunCount: 0,
  totalsByCostKind: [
    {
      costKind: "billed",
      runCount: 0,
      amountMicrosUsd: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
    {
      costKind: "zero",
      runCount: 0,
      amountMicrosUsd: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
  ],
  recentRuns: [],
  translationMemoryReuse: {
    reuseEventCount: 0,
    appliedCount: 0,
    suggestedCount: 0,
    providerCallAvoidedCount: 0,
    estimatedPromptTokensSaved: 0,
    estimatedCompletionTokensSaved: 0,
    estimatedTotalTokensSaved: 0,
    estimatedCostUsdSaved: null,
    recentEvents: [],
  },
};

describe("ITOTORI-056 dashboard panel state model", () => {
  it("a populated API-backed panel renders its data with data-panel-state=populated", async () => {
    const root = await renderReadyRoot();

    const jobs = root.querySelector('#jobs[data-panel-state="populated"]');
    expect(jobs).not.toBeNull();
    // The real recentRuns rows render — the cost fixture carries a
    // benchmark_qa run, which only appears when the Jobs panel is populated.
    expect(jobs?.textContent).toContain("benchmark_qa");
    expect(jobs?.textContent).toContain("draft_translation");

    const benchmarks = root.querySelector('#benchmarks[data-panel-state="populated"]');
    expect(benchmarks).not.toBeNull();
    const [report] = benchmarkReportsFixture;
    expect(report).toBeDefined();
    expect(benchmarks?.textContent).toContain(report!.benchmarkName);

    const styleGuide = root.querySelector('#style-guide[data-panel-state="populated"]');
    expect(styleGuide).not.toBeNull();
    expect(styleGuide?.textContent).toContain(
      dashboardStatusFixture.currentStyleGuidePolicyVersionId!,
    );
  });

  describe("glossary panel is always unknown (never presented as empty)", () => {
    it("renders data-panel-state=unknown and NOT the legacy empty message", async () => {
      const root = await renderReadyRoot();

      const glossary = root.querySelector("#glossary");
      expect(glossary?.getAttribute("data-panel-state")).toBe("unknown");
      // The legacy copy claimed the API returned no entries — but the
      // glossary API is not queried at all, so that confirmed-empty copy
      // must never appear.
      expect(glossary?.textContent).not.toContain("No glossary entries were returned by the API.");
      // The unknown notice must be present and clearly say "not queried".
      expect(glossary?.textContent).toContain("not been queried");
      expect(glossary?.querySelector('[data-panel-state-notice="unknown"]')).not.toBeNull();
    });
  });

  describe("jobs panel (cost-backed) distinguishes empty vs unavailable vs populated", () => {
    it("renders data-panel-state=empty when the cost API answers with zero runs", async () => {
      server.use(
        http.get("http://itotori.test/api/projects/cost", () =>
          apiJson("projects.cost", emptyRecentRunsCostReport),
        ),
      );
      const root = await renderReadyRoot();

      const jobs = root.querySelector("#jobs");
      expect(jobs?.getAttribute("data-panel-state")).toBe("empty");
      expect(jobs?.querySelector('[data-panel-state-notice="empty"]')).not.toBeNull();
      expect(jobs?.textContent).toContain("No job or provider runs were returned by the API.");
      // A genuinely-empty jobs panel renders the empty notice, NOT the
      // unavailable notice.
      expect(jobs?.querySelector('[data-panel-state-notice="unavailable"]')).toBeNull();
      expect(jobs?.querySelector('[data-panel-state-notice="unknown"]')).toBeNull();
    });

    it("renders data-panel-state=unavailable when the cost API fails (not empty)", async () => {
      server.use(
        http.get("http://itotori.test/api/projects/cost", () =>
          HttpResponse.json({ error: "cost offline", code: "internal_error" }, { status: 500 }),
        ),
      );
      const root = await renderReadyRoot();

      const jobs = root.querySelector("#jobs");
      expect(jobs?.getAttribute("data-panel-state")).toBe("unavailable");
      expect(jobs?.querySelector('[data-panel-state-notice="unavailable"]')).not.toBeNull();
      // A failed cost read must NEVER surface as a confirmed empty state.
      expect(jobs?.querySelector('[data-panel-state-notice="empty"]')).toBeNull();
      expect(jobs?.textContent).not.toContain("No job or provider runs were returned by the API.");
      // The rest of the dashboard still renders (the failed panel is
      // isolated, not collapsed into the whole-dashboard error state).
      expect(root.querySelector('[data-state="ready"]')).not.toBeNull();
      expect(root.querySelector('[data-state="error"]')).toBeNull();
    });
  });

  describe("benchmark panels distinguish empty vs unavailable vs populated", () => {
    it("renders data-panel-state=empty when the benchmarks API answers with zero reports", async () => {
      server.use(
        http.get("http://itotori.test/api/projects/benchmarks", () =>
          apiJson("projects.benchmarks", { reports: [] }),
        ),
      );
      const root = await renderReadyRoot();

      for (const id of ["benchmarks", "benchmark-reports"]) {
        const panel = root.querySelector(`#${id}`);
        expect(panel?.getAttribute("data-panel-state")).toBe("empty");
        expect(panel?.querySelector('[data-panel-state-notice="empty"]')).not.toBeNull();
        expect(panel?.querySelector('[data-panel-state-notice="unavailable"]')).toBeNull();
      }
      // QA agent metrics derive from the same query; zero reports (and
      // therefore zero agent evaluations) resolve to empty too.
      const qaMetrics = root.querySelector("#qa-agent-metrics");
      expect(qaMetrics?.getAttribute("data-panel-state")).toBe("empty");
    });

    it("renders data-panel-state=unavailable when the benchmarks API fails (not empty)", async () => {
      server.use(
        http.get("http://itotori.test/api/projects/benchmarks", () =>
          HttpResponse.json(
            { error: "benchmarks offline", code: "internal_error" },
            { status: 500 },
          ),
        ),
      );
      const root = await renderReadyRoot();

      for (const id of ["benchmarks", "qa-agent-metrics", "benchmark-reports"]) {
        const panel = root.querySelector(`#${id}`);
        expect(panel?.getAttribute("data-panel-state")).toBe("unavailable");
        expect(panel?.querySelector('[data-panel-state-notice="unavailable"]')).not.toBeNull();
        // A failed benchmarks read must NEVER surface as a confirmed empty state.
        expect(panel?.querySelector('[data-panel-state-notice="empty"]')).toBeNull();
        expect(panel?.textContent).not.toContain("No benchmark reports were returned by the API.");
      }
      // The rest of the dashboard still renders.
      expect(root.querySelector('[data-state="ready"]')).not.toBeNull();
      // Jobs (cost-backed) is unaffected by the benchmarks failure.
      expect(root.querySelector('#jobs[data-panel-state="populated"]')).not.toBeNull();
    });
  });

  describe("style-guide panel degrades to unavailable when context is missing (ITOTORI-127)", () => {
    it("renders data-panel-state=unavailable naming the reason when no locale branch is selected", async () => {
      server.use(
        http.get("http://itotori.test/api/projects/status", () =>
          apiJson("projects.status", {
            ...dashboardStatusFixture,
            // No locale branch + no style-guide policy version → the
            // builder has no route context → the panel degrades to a
            // panel-scoped unavailable state naming why, NOT unknown and
            // NOT a whole-dashboard failure.
            selectedLocaleBranchId: null,
            currentStyleGuidePolicyVersionId: null,
          }),
        ),
        http.get("http://itotori.test/api/projects", () =>
          apiJson("projects.list", {
            projects: [
              {
                ...dashboardStatusFixture,
                selectedLocaleBranchId: null,
                currentStyleGuidePolicyVersionId: null,
              },
            ],
          }),
        ),
      );
      const root = await renderReadyRoot();

      const styleGuide = root.querySelector("#style-guide");
      expect(styleGuide?.getAttribute("data-panel-state")).toBe("unavailable");
      expect(styleGuide?.querySelector('[data-panel-state-notice="unavailable"]')).not.toBeNull();
      // The unavailable notice names WHY the context is missing.
      expect(styleGuide?.textContent).toContain("could not be loaded");
      expect(styleGuide?.textContent).toContain("no locale branch is selected");
      // A missing context is never presented as confirmed empty or unqueried.
      expect(styleGuide?.querySelector('[data-panel-state-notice="empty"]')).toBeNull();
      expect(styleGuide?.querySelector('[data-panel-state-notice="unknown"]')).toBeNull();
      expect(styleGuide?.textContent).not.toContain("not been queried");
      // ITOTORI-127 — the rest of the dashboard still renders (the missing
      // style-guide context degrades to a PANEL-scoped state, not a
      // whole-dashboard error).
      expect(root.querySelector('[data-state="ready"]')).not.toBeNull();
      expect(root.querySelector('[data-state="error"]')).toBeNull();
      expect(root.querySelector('#jobs[data-panel-state="populated"]')).not.toBeNull();
      expect(root.querySelector("#projects")).not.toBeNull();
    });

    it("renders data-panel-state=unavailable naming the policy version when a branch has no policy", async () => {
      server.use(
        http.get("http://itotori.test/api/projects/status", () =>
          apiJson("projects.status", {
            ...dashboardStatusFixture,
            // A locale branch IS selected, but it carries no style-guide
            // policy version → the panel names the policy-version gap.
            currentStyleGuidePolicyVersionId: null,
          }),
        ),
        http.get("http://itotori.test/api/projects", () =>
          apiJson("projects.list", {
            projects: [{ ...dashboardStatusFixture, currentStyleGuidePolicyVersionId: null }],
          }),
        ),
      );
      const root = await renderReadyRoot();

      const styleGuide = root.querySelector("#style-guide");
      expect(styleGuide?.getAttribute("data-panel-state")).toBe("unavailable");
      expect(styleGuide?.querySelector('[data-panel-state-notice="unavailable"]')).not.toBeNull();
      expect(styleGuide?.textContent).toContain("could not be loaded");
      expect(styleGuide?.textContent).toContain(
        "the selected locale branch has no style-guide policy version",
      );
      expect(styleGuide?.querySelector('[data-panel-state-notice="unknown"]')).toBeNull();
      // The rest of the dashboard still renders.
      expect(root.querySelector('[data-state="ready"]')).not.toBeNull();
      expect(root.querySelector('[data-state="error"]')).toBeNull();
    });

    it("renders data-panel-state=populated when the builder route context is present", async () => {
      const root = await renderReadyRoot();

      const styleGuide = root.querySelector("#style-guide");
      expect(styleGuide?.getAttribute("data-panel-state")).toBe("populated");
      // The populated style-guide panel renders the builder context, not a
      // state notice.
      expect(styleGuide?.querySelector("[data-panel-state-notice]")).toBeNull();
    });
  });

  describe("isolated panel failure does not collapse the whole dashboard", () => {
    it("keeps the dashboard ready when BOTH cost and benchmarks fail", async () => {
      server.use(
        http.get("http://itotori.test/api/projects/cost", () =>
          HttpResponse.json({ error: "cost offline", code: "internal_error" }, { status: 500 }),
        ),
        http.get("http://itotori.test/api/projects/benchmarks", () =>
          HttpResponse.json(
            { error: "benchmarks offline", code: "internal_error" },
            { status: 500 },
          ),
        ),
      );
      const root = await renderReadyRoot();

      expect(root.querySelector('[data-state="ready"]')).not.toBeNull();
      expect(root.querySelector('[data-state="error"]')).toBeNull();
      expect(root.querySelector('#jobs[data-panel-state="unavailable"]')).not.toBeNull();
      expect(root.querySelector('#benchmarks[data-panel-state="unavailable"]')).not.toBeNull();
      // The Model cost panel shares the cost query and is unavailable too.
      expect(root.querySelector('#cost[data-panel-state="unavailable"]')).not.toBeNull();
    });
  });
});
