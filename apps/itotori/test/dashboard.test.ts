// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { renderDashboard, type DashboardEndpoints } from "../src/dashboard.js";
import {
  apiMutationContract,
  benchmarkReportsFixture,
  bridgeImportResponseFixture,
  dashboardDecisionsFixture,
  dashboardStatusFixture,
  draftBranchResponseFixture,
  recordBenchmarkResponseFixture,
  recordDecisionResponseFixture,
  recordFindingResponseFixture,
  runtimeEvidenceIngestResponseFixture,
  type ApiMutationContractEntry,
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
    expect(root.textContent).toContain("Reviewer queue");
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

    const reviewerQueue = root.querySelector('[aria-label="Reviewer queue"]');
    expect(reviewerQueue?.textContent).toContain("Pending");
    expect(reviewerQueue?.textContent).toContain("Resolved");
    expect(reviewerQueue?.textContent).toContain("Deferred");
    expect(reviewerQueue?.textContent).toContain("Escalated");
    expect(reviewerQueue?.textContent).toContain("Batch applied");
    expect(reviewerQueue?.textContent).toContain("ITOTORI-023 pending decision");
    expect(reviewerQueue?.textContent).toContain("ITOTORI-023 batch_applied decision");
    const selected = reviewerQueue?.querySelectorAll('input[name="selection"]:checked');
    expect(selected?.length).toBe(1);
    expect((selected?.item(0) as HTMLInputElement | undefined)?.value).toContain(
      "@source-revision-itotori-023",
    );

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

    // ITOTORI-027 — the $25 indie-localization target is tracked from the
    // REAL recorded billed cost, not an estimate.
    const cost = root.querySelector('[aria-label="Model cost"]');
    expect(cost?.textContent).toContain("Spent (real)");
    expect(cost?.textContent).toContain("Target");
    expect(cost?.textContent).toContain("$25.000000");
    expect(cost?.querySelector('[aria-label="Indie localization cost target"]')).not.toBeNull();

    // ITOTORI-027 — benchmark views + report drilldown from real recorded
    // benchmark reports.
    const [report] = benchmarkReportsFixture;
    expect(report).toBeDefined();
    const benchmarks = root.querySelector('[aria-label="Benchmarks"]');
    expect(benchmarks?.textContent).toContain(report!.benchmarkName);
    const drilldown = root.querySelector(`#benchmark-report-${report!.benchmarkRunId}`);
    expect(drilldown).not.toBeNull();
    expect(drilldown?.textContent).toContain(report!.benchmarkRunId);

    // ITOTORI-027 — QA false positives / false negatives are represented.
    const qaMetrics = root.querySelector('[aria-label="QA agent metrics"]');
    expect(qaMetrics?.textContent).toContain("False positives");
    expect(qaMetrics?.textContent).toContain("False negatives");
    const qaAgent = report!.qaAgents[0];
    expect(qaAgent).toBeDefined();
    expect(qaMetrics?.textContent).toContain(qaAgent!.qaAgentId);
    expect(qaMetrics?.querySelector(".qa-fp")).not.toBeNull();
    expect(qaMetrics?.querySelector(".qa-fn")).not.toBeNull();

    // ITOTORI-053 — the paginated cost drilldown table renders zero-vs-unknown
    // as DISTINCT states and exposes the per-row provider adapter metadata
    // WITHOUT any raw provider payload.
    const drilldownPanel = root.querySelector('[aria-label="Cost drilldown"]');
    expect(drilldownPanel).not.toBeNull();
    // Pagination metadata is surfaced.
    expect(drilldownPanel?.textContent).toContain("Total");
    expect(drilldownPanel?.textContent).toContain("Page");
    // Zero vs unknown render distinctly.
    const billedCell = drilldownPanel?.querySelector('[data-cost-state="billed"]');
    const zeroCell = drilldownPanel?.querySelector('td [data-cost-state="zero"]');
    const unknownCell = drilldownPanel?.querySelector('td [data-cost-state="unknown"]');
    expect(zeroCell).not.toBeNull();
    expect(unknownCell).not.toBeNull();
    expect(billedCell).not.toBeNull();
    expect(zeroCell?.textContent).toContain("$0.000000 (zero)");
    expect(unknownCell?.textContent?.trim()).toBe("unknown");
    expect(zeroCell?.textContent).not.toBe(unknownCell?.textContent);
    // A per-row adapter-metadata drilldown exists and shows curated metadata…
    const adapterDrilldown = drilldownPanel?.querySelector(".adapter-metadata-drilldown");
    expect(adapterDrilldown).not.toBeNull();
    expect(adapterDrilldown?.textContent).toContain("Adapter metadata");
    expect(drilldownPanel?.textContent).toContain("providerRouting");
    // …but no raw provider payload key ever appears.
    expect(drilldownPanel?.textContent).not.toContain("rawResponse");
    expect(drilldownPanel?.textContent).not.toContain("leaked body");
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
    // ITOTORI-027 — the benchmark MSW handler shape is checked against the
    // real BenchmarkReportSummary schema so it cannot drift.
    expect(() =>
      apiJson("projects.benchmarks", { reports: benchmarkReportsFixture }),
    ).not.toThrow();
    expect(() =>
      apiJson("projects.benchmarks", {
        reports: [
          {
            ...benchmarkReportsFixture[0],
            qaAgents: [{ ...benchmarkReportsFixture[0]!.qaAgents[0], falsePositives: -1 }],
          },
        ],
      } as never),
    ).toThrow("falsePositives");
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

  // ITOTORI-114 — KIND-SPECIFIC nullable-field invariants (fail-closed). A
  // decision record whose fields contradict its decisionKind must be
  // REJECTED by the read-model schema, never silently accepted or mis-counted.
  describe("decision read-model kind-specific invariants (ITOTORI-114)", () => {
    const [projectFinding, localeBranchFinding, runtimeValidation] =
      dashboardDecisionsFixture.pendingDecisions;

    it("accepts a valid record of each decision kind", () => {
      // The base fixture carries one valid record of each kind, including a
      // runtime_validation that legitimately carries branch context.
      expect(() => apiJson("projects.decisions", dashboardDecisionsFixture)).not.toThrow();
      expect(projectFinding!.decisionKind).toBe("project_finding");
      expect(projectFinding!.localeBranchId).toBeNull();
      expect(projectFinding!.runtimeRunId).toBeNull();
      expect(localeBranchFinding!.decisionKind).toBe("locale_branch_finding");
      expect(localeBranchFinding!.localeBranchId).not.toBeNull();
      expect(runtimeValidation!.decisionKind).toBe("runtime_validation");
      expect(runtimeValidation!.runtimeRunId).not.toBeNull();
    });

    it("rejects a project_finding that carries a localeBranchId", () => {
      expect(() =>
        apiJson("projects.decisions", {
          ...dashboardDecisionsFixture,
          pendingDecisions: [
            { ...projectFinding!, localeBranchId: "locale-1" },
            localeBranchFinding!,
            runtimeValidation!,
          ],
        }),
      ).toThrow("localeBranchId");
    });

    it("rejects a project_finding that carries a runtimeRunId", () => {
      expect(() =>
        apiJson("projects.decisions", {
          ...dashboardDecisionsFixture,
          pendingDecisions: [
            { ...projectFinding!, runtimeRunId: "runtime-9", runtimeStatus: "failed" },
            localeBranchFinding!,
            runtimeValidation!,
          ],
        }),
      ).toThrow("runtimeRunId");
    });

    it("rejects a locale_branch_finding missing its localeBranchId", () => {
      expect(() =>
        apiJson("projects.decisions", {
          ...dashboardDecisionsFixture,
          pendingDecisions: [
            projectFinding!,
            {
              ...localeBranchFinding!,
              localeBranchId: null,
              targetLocale: null,
              branchStatus: null,
            },
            runtimeValidation!,
          ],
        }),
      ).toThrow("localeBranchId");
    });

    it("rejects a runtime_validation missing its runtimeRunId", () => {
      expect(() =>
        apiJson("projects.decisions", {
          ...dashboardDecisionsFixture,
          pendingDecisions: [
            projectFinding!,
            localeBranchFinding!,
            { ...runtimeValidation!, runtimeRunId: null, runtimeStatus: null },
          ],
        }),
      ).toThrow("runtimeRunId");
    });

    it("does not count a runtime_validation (even with a localeBranchId) as a branch finding", () => {
      // The fixture's runtime_validation carries localeBranchId "locale-1".
      // It is counted by decisionKind — as a runtime validation, never as a
      // locale branch finding. A count that folds it into the branch total
      // (2 instead of 1) is a contradictory read-model and is rejected.
      expect(runtimeValidation!.localeBranchId).not.toBeNull();
      expect(() =>
        apiJson("projects.decisions", {
          ...dashboardDecisionsFixture,
          counts: {
            ...dashboardDecisionsFixture.counts,
            localeBranchFindingDecisionCount: 2,
            runtimeValidationDecisionCount: 0,
          },
        }),
      ).toThrow("localeBranchFindingDecisionCount");
    });
  });

  // ITOTORI-051 — the dashboard MSW server now also installs the project
  // mutation handlers (POST routes). The dashboard itself only reads on the
  // initial render, so the mutation handlers are inert for the render flow
  // above (acceptance: existing read-route + import MSW coverage stays
  // UNCHANGED). This block pins the literal acceptance criterion: a
  // mutation API shape change FAILS this dashboard contract test instead of
  // silently diverging. The exhaustive per-route SUCCESS / validation-
  // failure / denial / drift coverage lives in `msw-mutation-handlers.test.ts`;
  // this block is the dashboard-level smoke check that the mutation
  // handlers are registered + contract-anchored alongside the read handlers
  // the dashboard test already asserts against.
  describe("ITOTORI-051 dashboard MSW mutation contract (drift smoke)", () => {
    it.each(apiMutationContract)(
      "a $routeId mutation response shape change fails this dashboard contract test",
      (entry: ApiMutationContractEntry) => {
        // The mutation handlers are part of the SAME `itotoriApiMswHandlers`
        // array the dashboard server spreads in (line 13). Each mutation
        // response fixture MUST stay contract-valid; a drifted shape (a
        // dropped required field) is rejected by the route asserter, so a
        // backend rename / drop / widening surfaces here instead of silently
        // passing the dashboard suite.
        const fixture = mutationResponseFixtureFor(entry.routeId);
        expect(() => apiJson(entry.routeId, fixture)).not.toThrow();
        const drifted: Record<string, unknown> = { ...(fixture as Record<string, unknown>) };
        delete drifted[entry.requiredResponseField];
        expect(() => apiJson(entry.routeId, drifted as never)).toThrow(entry.requiredResponseField);
      },
    );

    // Explicit, easy-to-point-at proof on `findings.record` + `decisions.record`
    // (the two routes the reviewer queue dashboard wires up to): a deliberate
    // enum widening on the response is caught, and the original passes once
    // the drift is reverted.
    it("rejects a widened status enum on findings.record and decisions.record", () => {
      const widenedFinding: Record<string, unknown> = {
        ...recordFindingResponseFixture,
        status: "drafted",
      };
      expect(() => apiJson("findings.record", widenedFinding as never)).toThrow("status");
      expect(() => apiJson("findings.record", recordFindingResponseFixture)).not.toThrow();

      const widenedDecision: Record<string, unknown> = {
        ...recordDecisionResponseFixture,
        eventKind: "triage_invented_kind",
      };
      expect(() => apiJson("decisions.record", widenedDecision as never)).toThrow("eventKind");
      expect(() => apiJson("decisions.record", recordDecisionResponseFixture)).not.toThrow();
    });
  });
});

function mutationResponseFixtureFor(routeId: ApiMutationContractEntry["routeId"]): unknown {
  switch (routeId) {
    case "imports.bridge":
      return bridgeImportResponseFixture;
    case "branches.draft":
      return draftBranchResponseFixture;
    case "findings.record":
      return recordFindingResponseFixture;
    case "decisions.record":
      return recordDecisionResponseFixture;
    case "benchmarks.record":
      return recordBenchmarkResponseFixture;
    case "runtimeEvidence.ingest":
      return runtimeEvidenceIngestResponseFixture;
  }
}
