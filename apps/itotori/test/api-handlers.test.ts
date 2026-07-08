import { readdirSync, readFileSync } from "node:fs";
import * as ts from "typescript";
import {
  AssetLocalizationDecisionRepositoryError,
  AuthorizationError,
  ItotoriProjectRepository,
  assetLocalizationDecisionAssetKindValues,
  localUserId,
  permissionValues,
  reviewerQueueActionValues,
  type CandidateAssetRecord,
  type CatalogCompletenessPool,
  type CatalogConfidence,
  type CatalogConflictReviewReadModel,
  type CatalogConflictStatus,
  type CatalogLanguageStatus,
  type CatalogLanguageStatusScope,
  type LocaleBranchIdentity,
  type Permission,
  type ProjectCostReport,
} from "@itotori/db";
import { describe, expect, it, vi } from "vitest";
import { findUncoveredProjectWorkflowMutations } from "./api-mutation-coverage-guard.js";
import { assertForbiddenApiMutation } from "../../../packages/itotori-db/test/authorization-test-helpers.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import {
  apiMutationPermissionGates,
  handleItotoriApiRequest,
  isItotoriApiPath,
  readOnlyApiServices,
  type ApiMutationPermissionGate,
  type ItotoriApiRequest,
  type ItotoriApiServices,
} from "../src/api-handlers.js";
import { withDatabaseReadOnlyApiServices } from "../src/services/database-services.js";
import { ItotoriProjectWorkflowService } from "../src/services/project-workflow.js";
import {
  REDACTED_RUNTIME_FINDING_MESSAGE,
  assertRedactedRuntimeDashboardStatus,
} from "../src/api-schema.js";
import { translateTextFixture } from "../src/asset-decisions/decision-fixtures.js";
import {
  fixtureAllAllowedPreview,
  readyContextFixture,
  reviewQueueDashboardFixtures,
  reviewerBatchPreviewStatusValues,
  type BatchPreviewItem,
  type ReviewerBatchExecuteResult,
  type ReviewerQueueDashboardReadModel,
  type ReviewerSingleActionRequest,
  type ReviewerSingleActionResult,
} from "../src/reviewer/index.js";
import {
  workspaceAssetBrowseFixture,
  workspaceComparisonFixture,
  workspaceDeniedComparisonFixture,
  workspaceProjectBrowseFixture,
  workspaceSceneBrowseFixture,
  workspaceSearchFixture,
} from "../src/workspace/index.js";
import {
  benchmarkReportFixture,
  benchmarkReportsFixture,
  bridgeFixture,
  catalogBenchmarkSeedsFixture,
  catalogCompletenessFixture,
  catalogConflictReviewFixture,
  catalogOpportunitiesFixture,
  costDrilldownFixture,
  costReportFixture,
  dashboardDecisionsFixture,
  dashboardStatusFixture,
  decisionEventFixture,
  findingRecordFixture,
  nonJapaneseTargetProjectFixture,
  projectOverviewFixture,
  projectFixture,
  runtimeIngestResultFixture,
  runtimeReportFixture,
  runtimeStatusFixture,
  terminologySearchFixture,
} from "./api-fixtures.js";

const deniedActor = { userId: "api-user-without-required-permission" };

const assetDecisionApiFixture = translateTextFixture({
  projectId: "project-1",
  localeBranchId: "locale-1",
  assetRef: { kind: "bridgeAssetRef", ref: "asset-image-1", assetKey: "cg/title.png" },
});

const candidateAssetApiFixture: CandidateAssetRecord = {
  assetRef: { kind: "bridgeAssetRef", ref: "asset-image-2", assetKey: "cg/menu.png" },
  assetKind: assetLocalizationDecisionAssetKindValues.uiArt,
  displayLabel: "cg/menu.png",
};

type ApiMutationPermissionGateId = keyof typeof apiMutationPermissionGates;
type MutatingProjectWorkflowService = Exclude<
  keyof ItotoriApiServices["projectWorkflow"],
  | "listLocaleBranchIdentities"
  | "getDashboardStatus"
  | "getDashboardDecisions"
  | "getRuntimeStatus"
  | "getCostReport"
  | "getCostDrilldown"
  | "getBenchmarkReports"
>;

type ApiMutationPermissionCase = {
  gateId: ApiMutationPermissionGateId;
  name: string;
  request: ItotoriApiRequest;
  route: string;
  permissionKey: ApiMutationPermissionGate["permissionKey"];
  permission: Permission;
  service: MutatingProjectWorkflowService;
  successFixture: string;
  denialFixture: string;
};

type ApiMutationRoute = {
  route: string;
  service: MutatingProjectWorkflowService;
};

const readOnlyProjectWorkflowServices = new Set<keyof ItotoriApiServices["projectWorkflow"]>([
  "listLocaleBranchIdentities",
  "getDashboardStatus",
  "getDashboardDecisions",
  "getRuntimeStatus",
  "getCostReport",
  "getCostDrilldown",
  "getBenchmarkReports",
]);

const readOnlyPostApiRoutes = new Set([
  "POST /api/reviewer/queue/batch-preview",
  "POST /api/reviewer/queue/batch-confirm",
  // ITOTORI-118 — the correction submit mutates via the workspace correction
  // service (gated on queue.manage), not via a projectWorkflow call.
  "POST /api/workspace/corrections",
]);

const apiMutationPermissionMatrix = [
  apiGate("bridgeImport", post("/api/imports/bridge", { bridge: bridgeFixture }), "importBridge"),
  apiGate(
    "branchDraft",
    post("/api/projects/project-1/branches", {
      project: projectFixture,
      targetLocale: "fr-FR",
    }),
    "draftProject",
  ),
  apiGate(
    "findingRecord",
    post("/api/projects/project-1/findings", {
      localeBranchId: "locale-1",
      finding: findingRecordFixture,
    }),
    "recordFinding",
  ),
  apiGate(
    "decisionRecord",
    post("/api/projects/project-1/decisions", {
      localeBranchId: "locale-1",
      event: decisionEventFixture,
    }),
    "recordDecision",
  ),
  apiGate(
    "benchmarkRecord",
    post("/api/projects/project-1/benchmarks", {
      benchmarkReport: benchmarkReportFixture,
    }),
    "recordBenchmarkReport",
  ),
  apiGate(
    "runtimeEvidenceIngest",
    post("/api/projects/project-1/runtime-evidence", {
      project: projectFixture,
      runtimeReport: runtimeReportFixture,
    }),
    "ingestRuntimeReport",
  ),
] as const satisfies readonly ApiMutationPermissionCase[];

describe("Itotori API handlers", () => {
  it("routes project and runtime status reads, gating project reads on catalog.read", async () => {
    const services = serviceFixture();

    const projects = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/projects" },
      services,
    );
    const projectStatus = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/projects/status" },
      services,
    );
    const projectOverview = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/projects/overview" },
      services,
    );
    const runtimeStatus = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/hello/status" },
      services,
    );
    const runtimeV02Status = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/runtime/v0.2/status" },
      services,
    );
    const costStatus = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/projects/cost" },
      services,
    );
    const benchmarkReports = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/projects/benchmarks" },
      services,
    );
    const decisions = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/projects/decisions" },
      services,
    );
    const catalogConflicts = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/catalog/conflicts" },
      services,
    );
    const catalogCompleteness = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/catalog/completeness" },
      services,
    );
    const catalogBenchmarkSeeds = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/catalog/benchmark-seeds" },
      services,
    );
    const catalogOpportunities = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/catalog/opportunities" },
      services,
    );
    const terminologySearch = await handleItotoriApiRequest(
      {
        method: "GET",
        pathname: "/api/terminology/search",
        search: "?localeBranchId=locale-1&q=Hero",
      },
      services,
    );

    expect(projects).toEqual({ statusCode: 200, body: { projects: [dashboardStatusFixture] } });
    expect(projectStatus).toEqual({ statusCode: 200, body: dashboardStatusFixture });
    expect(projectOverview).toEqual({ statusCode: 200, body: projectOverviewFixture });
    expect(projects.body.projects[0]?.localeBranches).toEqual([
      expect.objectContaining({ localeBranchId: "locale-1", targetLocale: "en-US" }),
      expect.objectContaining({
        localeBranchId: "019ed065-0000-7000-8000-000000000110",
        targetLocale: "fr-FR",
      }),
    ]);
    expect(projectStatus.body.localeBranches).toEqual([
      expect.objectContaining({ localeBranchId: "locale-1", targetLocale: "en-US" }),
      expect.objectContaining({
        localeBranchId: "019ed065-0000-7000-8000-000000000110",
        targetLocale: "fr-FR",
      }),
    ]);
    expect(runtimeStatus).toEqual({ statusCode: 200, body: runtimeStatusFixture });
    expect(runtimeV02Status).toEqual({ statusCode: 200, body: runtimeStatusFixture });
    expect(runtimeV02Status.body).toMatchObject({
      traceEvents: [
        {
          runtimeEventId: "runtime-1:trace-1",
          bridgeUnitId: "bridge-unit-1",
          sourceUnitKey: "hello.scene.001.line.001",
          draftId: "locale-1:bridge-unit-1",
        },
      ],
      artifacts: expect.arrayContaining([
        expect.objectContaining({
          artifactId: "runtime-1:screenshot-1",
          uri: "artifacts/utsushi/runtime/runtime-1/screenshots/screenshot-1.png",
          hash: "sha256:runtime-screenshot",
          mediaType: "image/png",
        }),
      ]),
    });
    expect(costStatus).toEqual({ statusCode: 200, body: costReportFixture });
    expect(benchmarkReports).toEqual({
      statusCode: 200,
      body: { reports: benchmarkReportsFixture },
    });
    expect(services.projectWorkflow.getBenchmarkReports).toHaveBeenCalledTimes(1);
    expect(decisions).toEqual({ statusCode: 200, body: dashboardDecisionsFixture });
    expect(catalogConflicts).toEqual({ statusCode: 200, body: catalogConflictReviewFixture });
    expect(catalogCompleteness).toEqual({ statusCode: 200, body: catalogCompletenessFixture });
    expect(catalogBenchmarkSeeds).toEqual({ statusCode: 200, body: catalogBenchmarkSeedsFixture });
    expect(catalogOpportunities).toEqual({ statusCode: 200, body: catalogOpportunitiesFixture });
    expect(terminologySearch).toEqual({ statusCode: 200, body: terminologySearchFixture });
    expect(services.projectWorkflow.getDashboardStatus).toHaveBeenCalledTimes(2);
    expect(services.projectWorkflow.getProjectOverview).toHaveBeenCalledTimes(1);
    expect(services.projectWorkflow.getRuntimeStatus).toHaveBeenCalledTimes(2);
    expect(services.projectWorkflow.getRuntimeStatus).toHaveBeenNthCalledWith(1, undefined);
    expect(services.projectWorkflow.getRuntimeStatus).toHaveBeenNthCalledWith(2, undefined);
    expect(services.projectWorkflow.getCostReport).toHaveBeenCalledTimes(1);
    expect(services.projectWorkflow.getDashboardDecisions).toHaveBeenCalledTimes(1);
    expect(services.catalogRepository.catalogConflictReview).toHaveBeenCalledWith({});
    expect(services.catalogRepository.catalogCompletenessBenchmarkPools).toHaveBeenCalledWith({});
    expect(services.catalogRepository.catalogBenchmarkSeedFinder).toHaveBeenCalledWith({});
    expect(services.catalogRepository.catalogOpportunityRanking).toHaveBeenCalledWith({});
    expect(services.terminologyRepository.searchTerms).toHaveBeenCalledWith({
      localeBranchId: "locale-1",
      query: "Hero",
    });
    // gate-project-status-and-cost-reads — /api/projects, /status, and /cost
    // now resolve the catalog.read gate. serviceFixture grants it, so the
    // full detail is returned.
    // gate-runtime-status-reads-and-redact-evidence-previews — the two
    // runtime status reads (/api/hello/status + /api/runtime/v0.2/status)
    // additionally resolve the same catalog.read gate for the detailed
    // evidence report. 4 project reads + 2 runtime reads = 6 gate checks.
    expect(services.authorization.requirePermission).toHaveBeenCalledWith(
      permissionValues.catalogRead,
    );
    expect(services.authorization.requirePermission).toHaveBeenCalledTimes(6);
  });

  it("returns full project/cost detail to a caller holding catalog.read", async () => {
    const services = serviceFixture();

    const projects = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/projects" },
      services,
    );
    const status = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/projects/status" },
      services,
    );
    const cost = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/projects/cost" },
      services,
    );

    // Privileged callers see the full run ledger + translation-memory
    // targetText + provider/model/routing internals.
    expect((cost.body as ProjectCostReport).recentRuns).toHaveLength(2);
    expect((cost.body as ProjectCostReport).translationMemoryReuse.recentEvents).toHaveLength(1);
    expect(projects.body.projects[0]?.cost.recentRuns).toHaveLength(2);
    expect(status.body.cost.recentRuns).toHaveLength(2);
    for (const response of [projects, status, cost]) {
      const serialized = JSON.stringify(response.body);
      expect(serialized).toContain("Hello again.");
      expect(serialized).toContain("openrouter");
      expect(serialized).toContain("provider-run-1");
    }
  });

  it("redacts project/status/cost reads to a public summary without catalog.read", async () => {
    const services = serviceFixture();
    vi.mocked(services.authorization.requirePermission).mockImplementation(async (permission) => {
      if (permission === permissionValues.catalogRead) {
        throw new AuthorizationError({ userId: "api-user-without-catalog-read" }, permission);
      }
    });

    const projects = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/projects" },
      services,
    );
    const status = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/projects/status" },
      services,
    );
    const cost = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/projects/cost" },
      services,
    );

    const costBody = cost.body as ProjectCostReport;
    const dashboardCosts = [
      projects.body.projects[0]?.cost,
      status.body.cost,
      costBody,
    ] as ProjectCostReport[];

    for (const redacted of dashboardCosts) {
      // Run-ledger detail (provider/model/routing internals) is stripped.
      expect(redacted.recentRuns).toEqual([]);
      // Translation-memory reuse events (carrying targetText) are stripped.
      expect(redacted.translationMemoryReuse.recentEvents).toEqual([]);
      // Safe aggregates survive so the public dashboard still renders.
      expect(redacted.runCount).toBe(2);
      expect(redacted.billedMicrosUsd).toBe(2180);
      expect(redacted.totalsByCostKind).toHaveLength(2);
      expect(redacted.translationMemoryReuse.reuseEventCount).toBe(1);
    }

    // The sensitive strings must be ABSENT from every unprivileged response.
    for (const response of [projects, status, cost]) {
      const serialized = JSON.stringify(response.body);
      // translation-memory targetText
      expect(serialized).not.toContain("Hello again.");
      // provider / model / routing internals + run-ledger identity
      expect(serialized).not.toContain("provider-run-1");
      expect(serialized).not.toContain("openrouter");
      expect(serialized).not.toContain("itotori-fake-draft-v0");
      expect(serialized).not.toContain("routingPosture");
    }

    // Non-sensitive dashboard identity/counts remain visible.
    expect(status.body.projectId).toBe(dashboardStatusFixture.projectId);
    expect(status.body.unitCount).toBe(dashboardStatusFixture.unitCount);
  });

  it("serves the cost drilldown with parsed project/system/time filters + pagination", async () => {
    const services = serviceFixture();

    const response = await handleItotoriApiRequest(
      {
        method: "GET",
        pathname: "/api/projects/cost/drilldown",
        search:
          "?projectId=project-1&systemId=system-reallive&from=2026-06-17T00:00:00.000Z&to=2026-06-17T23:59:59.000Z&limit=2&offset=0",
      },
      services,
    );

    expect(response.statusCode).toBe(200);
    expect(services.projectWorkflow.getCostDrilldown).toHaveBeenCalledWith({
      projectId: "project-1",
      systemId: "system-reallive",
      from: new Date("2026-06-17T00:00:00.000Z"),
      to: new Date("2026-06-17T23:59:59.000Z"),
      limit: 2,
      offset: 0,
    });
    const body = response.body as typeof costDrilldownFixture;
    // Distinct cost states are carried through the API verbatim.
    const states = body.rows.map((row) => row.cost.state);
    expect(states).toEqual(["billed", "zero", "unknown"]);
    // Provider adapter metadata is exposed, but no raw provider payload key.
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("providerRouting");
    expect(serialized).not.toContain("rawResponse");
  });

  it("rejects a malformed cost drilldown filter with a bad request", async () => {
    const services = serviceFixture();

    const response = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/projects/cost/drilldown", search: "?limit=0" },
      services,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ code: "bad_request" });
    expect(services.projectWorkflow.getCostDrilldown).not.toHaveBeenCalled();
  });

  it("redacts cost drilldown rows without catalog.read but keeps pagination totals", async () => {
    const services = serviceFixture();
    vi.mocked(services.authorization.requirePermission).mockImplementation(async (permission) => {
      if (permission === permissionValues.catalogRead) {
        throw new AuthorizationError({ userId: "api-user-without-catalog-read" }, permission);
      }
    });

    const response = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/projects/cost/drilldown" },
      services,
    );

    expect(response.statusCode).toBe(200);
    const body = response.body as typeof costDrilldownFixture;
    // Privileged row detail (provider/adapter metadata) is stripped…
    expect(body.rows).toEqual([]);
    // …but the safe pagination aggregates survive.
    expect(body.pagination.total).toBe(costDrilldownFixture.pagination.total);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("providerRouting");
    expect(serialized).not.toContain("provider-run-billed");
  });

  it("returns the full runtime evidence report to a caller holding catalog.read", async () => {
    const services = serviceFixture();

    for (const pathname of ["/api/hello/status", "/api/runtime/v0.2/status"]) {
      const response = await handleItotoriApiRequest({ method: "GET", pathname }, services);
      // Privileged callers see the full detail: evidence-text previews,
      // finding free text, and artifact URIs + hashes.
      expect(response).toEqual({ statusCode: 200, body: runtimeStatusFixture });
      const serialized = JSON.stringify(response.body);
      expect(serialized).toContain("Hello, {player}.");
      expect(serialized).toContain("Observed runtime text did not match the draft text.");
      expect(serialized).toContain(
        "artifacts/utsushi/runtime/runtime-1/screenshots/screenshot-1.png",
      );
      expect(serialized).toContain("sha256:runtime-screenshot");
    }
  });

  it("redacts /api/runtime/v0.2/status evidence previews without catalog.read", async () => {
    const services = serviceFixture();
    vi.mocked(services.authorization.requirePermission).mockImplementation(async (permission) => {
      if (permission === permissionValues.catalogRead) {
        throw new AuthorizationError({ userId: "api-user-without-catalog-read" }, permission);
      }
    });

    for (const pathname of ["/api/hello/status", "/api/runtime/v0.2/status"]) {
      const response = await handleItotoriApiRequest({ method: "GET", pathname }, services);
      const body = response.body as typeof runtimeStatusFixture;

      // Evidence-text previews (observedText/promptText) are stripped.
      for (const event of body.traceEvents) {
        expect(event.textPreview).toBeNull();
      }
      // Finding FREE TEXT is stripped to the redaction sentinel.
      for (const finding of body.findings) {
        expect(finding.message).toBe(REDACTED_RUNTIME_FINDING_MESSAGE);
      }
      // Managed artifact URIs + content hashes are stripped.
      for (const artifact of body.artifacts) {
        expect(artifact.uri).toBeNull();
        expect(artifact.hash).toBeNull();
      }

      // The sensitive strings must be ABSENT from the unprivileged response
      // (the fixture actually contains them — see the privileged test above).
      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain("Hello, {player}.");
      expect(serialized).not.toContain("Observed runtime text did not match the draft text.");
      expect(serialized).not.toContain(
        "artifacts/utsushi/runtime/runtime-1/screenshots/screenshot-1.png",
      );
      expect(serialized).not.toContain("sha256:runtime-screenshot");
      expect(serialized).not.toContain("sha256:runtime-trace");

      // Safe aggregates + non-sensitive ids survive so the public dashboard
      // still renders.
      expect(body.finalStatus).toBe(runtimeStatusFixture.finalStatus);
      expect(body.validationFindingCount).toBe(runtimeStatusFixture.validationFindingCount);
      expect(body.textEventCount).toBe(runtimeStatusFixture.textEventCount);
      expect(body.traceEvents[0]?.runtimeEventId).toBe("runtime-1:trace-1");
      expect(body.findings[0]?.findingKind).toBe("text_mismatch");
      expect(body.artifacts[0]?.artifactId).toBe("runtime-1:screenshot-1");
    }
  });

  it("rejects a leakage-shaped redacted runtime status before it can be emitted", () => {
    // The unredacted fixture carries evidence text / finding free text /
    // artifact URIs — the redacted-shape validator must reject it.
    expect(() => assertRedactedRuntimeDashboardStatus(runtimeStatusFixture)).toThrow(
      /textPreview must be redacted/u,
    );
    // A response that only redacts the trace preview but still leaks the
    // finding free text is also rejected.
    expect(() =>
      assertRedactedRuntimeDashboardStatus({
        ...runtimeStatusFixture,
        traceEvents: runtimeStatusFixture.traceEvents.map((event) => ({
          ...event,
          textPreview: null,
        })),
      }),
    ).toThrow(/message must be redacted/u);
    // A response that redacts previews + finding text but still leaks an
    // artifact URI is rejected.
    expect(() =>
      assertRedactedRuntimeDashboardStatus({
        ...runtimeStatusFixture,
        traceEvents: runtimeStatusFixture.traceEvents.map((event) => ({
          ...event,
          textPreview: null,
        })),
        findings: runtimeStatusFixture.findings.map((finding) => ({
          ...finding,
          message: REDACTED_RUNTIME_FINDING_MESSAGE,
        })),
      }),
    ).toThrow(/uri must be redacted/u);
  });

  it("routes reviewer queue dashboard, detail, batch preview, and batch confirm through typed services", async () => {
    const services = serviceFixture();
    const batchBody = {
      action: reviewerQueueActionValues.approve,
      actorUserId: "reviewer-user",
      selections: [
        {
          reviewItemId: "reviewer-queue-1",
          expectedSourceRevisionId: "source-revision-1",
        },
      ],
    };

    const dashboard = await handleItotoriApiRequest(
      {
        method: "GET",
        pathname: "/api/reviewer/queue",
        search: "?localeBranchId=locale-1&actorUserId=reviewer-user",
      },
      services,
    );
    const detail = await handleItotoriApiRequest(
      {
        method: "GET",
        pathname: "/api/reviewer/queue/reviewer-queue-1/detail",
        search: "?actorUserId=reviewer-user",
      },
      services,
    );
    const preview = await handleItotoriApiRequest(
      {
        method: "POST",
        pathname: "/api/reviewer/queue/batch-preview",
        body: batchBody,
      },
      services,
    );
    const confirm = await handleItotoriApiRequest(
      {
        method: "POST",
        pathname: "/api/reviewer/queue/batch-confirm",
        body: batchBody,
      },
      services,
    );

    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body).toMatchObject({
      schemaVersion: "reviewer.queue_dashboard.v0.1",
      localeBranchId: "locale-1",
      aggregate: expect.objectContaining({
        pending: 1,
        resolved: 1,
        deferred: 1,
        escalated: 1,
        batch_applied: 1,
      }),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).toMatchObject({
      reviewItemId: "reviewer-queue-1",
      permission: expect.objectContaining({
        actorUserId: "reviewer-user",
        canReadQueue: true,
      }),
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.body).toMatchObject({
      request: expect.objectContaining({
        actorUserId: "reviewer-user",
        selections: [
          {
            reviewItemId: "reviewer-queue-1",
            expectedSourceRevisionId: "source-revision-1",
          },
        ],
      }),
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.body).toMatchObject({
      request: expect.objectContaining({ actorUserId: "reviewer-user" }),
      appliedAll: true,
      refusedAll: false,
    });
    expect(services.reviewerQueue.loadDashboard).toHaveBeenCalledWith(
      expect.objectContaining({
        localeBranchId: "locale-1",
        permission: expect.objectContaining({ actorUserId: "reviewer-user" }),
      }),
    );
    expect(services.reviewerQueue.loadDetailContext).toHaveBeenCalledTimes(1);
    expect(services.reviewerQueue.previewBatch).toHaveBeenCalledTimes(1);
    expect(services.reviewerQueue.executeBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { userId: "reviewer-user" },
        request: batchBody,
        permission: expect.objectContaining({
          actorUserId: "reviewer-user",
          canReadQueue: true,
          canManageQueue: true,
        }),
      }),
    );
  });

  it("returns a closed reviewer batch refusal when queue.manage is denied", async () => {
    const services = serviceFixture();
    vi.mocked(services.authorization.requirePermission).mockImplementation(async (permission) => {
      if (permission === permissionValues.queueManage) {
        throw new AuthorizationError({ userId: "missing-manage" }, permission);
      }
    });

    const response = await handleItotoriApiRequest(
      {
        method: "POST",
        pathname: "/api/reviewer/queue/batch-confirm",
        body: {
          action: reviewerQueueActionValues.approve,
          actorUserId: "missing-manage",
          selections: [
            {
              reviewItemId: "reviewer-queue-1",
              expectedSourceRevisionId: "source-revision-1",
            },
          ],
        },
      },
      services,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      refusedAll: true,
      appliedAll: false,
      applied: [
        expect.objectContaining({
          kind: "refused",
          status: reviewerBatchPreviewStatusValues.permissionDeniedManage,
        }),
      ],
    });
    expect(services.reviewerQueue.executeBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        permission: expect.objectContaining({ canManageQueue: false }),
      }),
    );
  });

  it("routes a single-item reviewer action through the typed service and returns the new state", async () => {
    const services = serviceFixture();
    const response = await handleItotoriApiRequest(
      {
        method: "POST",
        pathname: "/api/reviewer/queue/reviewer-queue-7/action",
        body: {
          action: reviewerQueueActionValues.approve,
          actorUserId: "reviewer-user",
          expectedSourceRevisionId: "source-revision-1",
        },
      },
      services,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      request: expect.objectContaining({
        reviewItemId: "reviewer-queue-7",
        action: reviewerQueueActionValues.approve,
        actorUserId: "reviewer-user",
      }),
      applied: true,
      refused: false,
      outcome: expect.objectContaining({
        kind: "applied",
        reviewItemId: "reviewer-queue-7",
        result: expect.objectContaining({
          transition: expect.objectContaining({ nextState: "accepted" }),
        }),
      }),
    });
    // Reuses the batch route's actor-gating: the SAME resolved permission
    // view (queue.read + queue.manage) flows into the single-item service.
    expect(services.reviewerQueue.actionSingleItem).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { userId: "reviewer-user" },
        request: expect.objectContaining({
          reviewItemId: "reviewer-queue-7",
          action: reviewerQueueActionValues.approve,
          expectedSourceRevisionId: "source-revision-1",
        }),
        permission: expect.objectContaining({
          actorUserId: "reviewer-user",
          canReadQueue: true,
          canManageQueue: true,
        }),
      }),
    );
    expect(services.reviewerQueue.executeBatch).not.toHaveBeenCalled();
  });

  it("threads a reviewer-supplied defer reason through the single-item action body", async () => {
    const services = serviceFixture();
    const response = await handleItotoriApiRequest(
      {
        method: "POST",
        pathname: "/api/reviewer/queue/reviewer-queue-7/action",
        body: {
          action: reviewerQueueActionValues.defer,
          actorUserId: "reviewer-user",
          expectedSourceRevisionId: "source-revision-1",
          deferReason: "waiting on runtime evidence",
        },
      },
      services,
    );

    expect(response.statusCode).toBe(200);
    expect(services.reviewerQueue.actionSingleItem).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          action: reviewerQueueActionValues.defer,
          deferReason: "waiting on runtime evidence",
        }),
      }),
    );
  });

  it("maps a single-item action refused for queue.manage to a 403 forbidden", async () => {
    const services = serviceFixture();
    vi.mocked(services.reviewerQueue.actionSingleItem).mockResolvedValueOnce(
      refusedSingleActionResult(
        "reviewer-queue-7",
        reviewerQueueActionValues.approve,
        reviewerBatchPreviewStatusValues.permissionDeniedManage,
        "user reviewer-user is missing permission queue.manage",
      ),
    );

    const response = await handleItotoriApiRequest(
      {
        method: "POST",
        pathname: "/api/reviewer/queue/reviewer-queue-7/action",
        body: {
          action: reviewerQueueActionValues.approve,
          actorUserId: "reviewer-user",
          expectedSourceRevisionId: "source-revision-1",
        },
      },
      services,
    );

    expect(response.statusCode).toBe(403);
    expect(response.body).toMatchObject({ code: "forbidden" });
  });

  it("maps a single-item action on an unknown item to a 404 not_found", async () => {
    const services = serviceFixture();
    vi.mocked(services.reviewerQueue.actionSingleItem).mockResolvedValueOnce(
      refusedSingleActionResult(
        "reviewer-queue-missing",
        reviewerQueueActionValues.approve,
        reviewerBatchPreviewStatusValues.notFound,
        "reviewer queue item reviewer-queue-missing not found",
      ),
    );

    const response = await handleItotoriApiRequest(
      {
        method: "POST",
        pathname: "/api/reviewer/queue/reviewer-queue-missing/action",
        body: {
          action: reviewerQueueActionValues.approve,
          actorUserId: "reviewer-user",
          expectedSourceRevisionId: "source-revision-1",
        },
      },
      services,
    );

    expect(response.statusCode).toBe(404);
    expect(response.body).toMatchObject({ code: "not_found" });
  });

  it("maps an already-actioned single item (invalid transition) to a 400 bad_request", async () => {
    const services = serviceFixture();
    vi.mocked(services.reviewerQueue.actionSingleItem).mockResolvedValueOnce(
      refusedSingleActionResult(
        "reviewer-queue-7",
        reviewerQueueActionValues.approve,
        reviewerBatchPreviewStatusValues.invalidTransition,
        "reviewer queue item reviewer-queue-7 is already accepted",
      ),
    );

    const response = await handleItotoriApiRequest(
      {
        method: "POST",
        pathname: "/api/reviewer/queue/reviewer-queue-7/action",
        body: {
          action: reviewerQueueActionValues.approve,
          actorUserId: "reviewer-user",
          expectedSourceRevisionId: "source-revision-1",
        },
      },
      services,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ code: "bad_request" });
  });

  it("rejects an unsupported single-item action verb with a 400 bad_request", async () => {
    const services = serviceFixture();
    const response = await handleItotoriApiRequest(
      {
        method: "POST",
        pathname: "/api/reviewer/queue/reviewer-queue-7/action",
        body: {
          // update_glossary is a batch/agentic-loop verb, not a per-item verb.
          action: reviewerQueueActionValues.updateGlossary,
          actorUserId: "reviewer-user",
          expectedSourceRevisionId: "source-revision-1",
        },
      },
      services,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ code: "bad_request" });
    expect(services.reviewerQueue.actionSingleItem).not.toHaveBeenCalled();
  });

  it("rejects a GET on the single-item action route with 405 method_not_allowed", async () => {
    const services = serviceFixture();
    const response = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/reviewer/queue/reviewer-queue-7/action" },
      services,
    );

    expect(response.statusCode).toBe(405);
    expect(response.body).toMatchObject({ code: "method_not_allowed" });
    expect(services.reviewerQueue.actionSingleItem).not.toHaveBeenCalled();
  });

  it("returns denied reviewer detail without calling the evidence-backed detail service", async () => {
    const services = serviceFixture();
    vi.mocked(services.authorization.requirePermission).mockImplementation(async (permission) => {
      if (permission === permissionValues.queueRead) {
        throw new AuthorizationError({ userId: "missing-read" }, permission);
      }
    });

    const response = await handleItotoriApiRequest(
      {
        method: "GET",
        pathname: "/api/reviewer/queue/reviewer-queue-denied/detail",
        search: "?actorUserId=missing-read",
      },
      services,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      reviewItemId: "reviewer-queue-denied",
      permission: expect.objectContaining({
        actorUserId: "missing-read",
        canReadQueue: false,
      }),
    });
    expect(services.reviewerQueue.loadDetailContext).not.toHaveBeenCalled();
  });

  it("passes the requested runtime run id to the runtime status read model", async () => {
    const services = serviceFixture();

    const response = await handleItotoriApiRequest(
      {
        method: "GET",
        pathname: "/api/runtime/v0.2/status",
        search: "?runtimeRunId=runtime-older",
      },
      services,
    );

    expect(response).toEqual({ statusCode: 200, body: runtimeStatusFixture });
    expect(services.projectWorkflow.getRuntimeStatus).toHaveBeenCalledWith("runtime-older");
  });

  it("routes asset-decision active and candidate reads through typed services", async () => {
    const services = serviceFixture();

    const active = await handleItotoriApiRequest(
      {
        method: "GET",
        pathname: "/api/projects/project-1/locale-branches/locale-1/asset-decisions",
      },
      services,
    );
    const candidates = await handleItotoriApiRequest(
      {
        method: "GET",
        pathname: "/api/projects/project-1/locale-branches/locale-1/asset-decisions/candidates",
        search: "?assetKind=ui_art",
      },
      services,
    );

    expect(active).toEqual({ statusCode: 200, body: { decisions: [assetDecisionApiFixture] } });
    expect(candidates).toEqual({
      statusCode: 200,
      body: { candidateAssets: [candidateAssetApiFixture] },
    });
    expect(services.assetDecisions.loadActiveDecisions).toHaveBeenCalledWith(
      "project-1",
      "locale-1",
      {},
    );
    expect(services.assetDecisions.loadCandidateAssets).toHaveBeenCalledWith(
      "project-1",
      "locale-1",
      { kindFilter: "ui_art" },
    );
  });

  it.each([
    {
      name: "encoded slash in project id",
      pathname: "/api/projects/project%2Fbad/locale-branches/locale-1/asset-decisions",
      search: "",
      error: /projectId/u,
    },
    {
      name: "unknown query parameter",
      pathname: "/api/projects/project-1/locale-branches/locale-1/asset-decisions",
      search: "?typo=1",
      error: /unknown asset decisions query parameter: typo/u,
    },
    {
      name: "unknown asset kind",
      pathname: "/api/projects/project-1/locale-branches/locale-1/asset-decisions/candidates",
      search: "?assetKind=script",
      error: /assetKind/u,
    },
  ])("rejects malformed asset-decision reads: $name", async ({ pathname, search, error }) => {
    const services = serviceFixture();

    const response = await handleItotoriApiRequest({ method: "GET", pathname, search }, services);

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ code: "bad_request" });
    expect(response.body.error).toMatch(error);
    expect(services.assetDecisions.loadActiveDecisions).not.toHaveBeenCalled();
    expect(services.assetDecisions.loadCandidateAssets).not.toHaveBeenCalled();
  });

  it("returns forbidden when asset-decision read permissions are denied", async () => {
    const services = serviceFixture();
    services.assetDecisions.loadActiveDecisions.mockRejectedValueOnce(
      new AuthorizationError(deniedActor, permissionValues.catalogRead),
    );

    const response = await handleItotoriApiRequest(
      {
        method: "GET",
        pathname: "/api/projects/project-1/locale-branches/locale-1/asset-decisions",
      },
      services,
    );

    expect(response.statusCode).toBe(403);
    expect(response.body).toMatchObject({ code: "forbidden" });
    expect(services.assetDecisions.loadActiveDecisions).toHaveBeenCalledTimes(1);
  });

  it("returns not found when the asset-decision project branch does not exist", async () => {
    const services = serviceFixture();
    services.assetDecisions.loadCandidateAssets.mockRejectedValueOnce(
      new AssetLocalizationDecisionRepositoryError(
        "asset_decision_not_found",
        "locale branch missing-locale was not found for project project-1",
      ),
    );

    const response = await handleItotoriApiRequest(
      {
        method: "GET",
        pathname:
          "/api/projects/project-1/locale-branches/missing-locale/asset-decisions/candidates",
      },
      services,
    );

    expect(response.statusCode).toBe(404);
    expect(response.body).toMatchObject({ code: "not_found" });
    expect(services.assetDecisions.loadCandidateAssets).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      query: "?source=dlsite",
      filter: { source: "dlsite" },
    },
    {
      query: "?severity=warning",
      filter: { severity: "warning" },
    },
    {
      query: "?status=resolved",
      filter: { status: "resolved" },
    },
    {
      query: "?catalogRecordId=work-duplicate",
      filter: { catalogRecordId: "work-duplicate" },
    },
  ])(
    "passes catalog conflict review filter $query to the read model",
    async ({ query, filter }) => {
      const services = serviceFixture();

      const response = await handleItotoriApiRequest(
        { method: "GET", pathname: "/api/catalog/conflicts", search: query },
        services,
      );

      expect(response).toEqual({ statusCode: 200, body: catalogConflictReviewFixture });
      expect(services.catalogRepository.catalogConflictReview).toHaveBeenCalledWith(filter);
      expect(services.authorization.requirePermission).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      query: "?targetLanguage=en-US",
      filter: { targetLanguage: "en-US" },
    },
    {
      query: "?pool=mtl_only",
      filter: { pool: "mtl_only" },
    },
    {
      query: "?targetLanguage=en-US&pool=conflict",
      filter: { targetLanguage: "en-US", pool: "conflict" },
    },
  ])("passes catalog completeness filter $query to the read model", async ({ query, filter }) => {
    const services = serviceFixture();

    const response = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/catalog/completeness", search: query },
      services,
    );

    expect(response).toEqual({ statusCode: 200, body: catalogCompletenessFixture });
    expect(services.catalogRepository.catalogCompletenessBenchmarkPools).toHaveBeenCalledWith(
      filter,
    );
    expect(services.authorization.requirePermission).not.toHaveBeenCalled();
  });

  it.each([
    {
      query: "?targetLanguage=",
      error: /targetLanguage/u,
    },
    {
      query: "?pool=official_english_conflict",
      error: /pool/u,
    },
    {
      query: "?targetLanguage=en-US&typo=1",
      error: /unknown catalog completeness query parameter: typo/u,
    },
  ])("rejects malformed catalog completeness query $query", async ({ query, error }) => {
    const services = serviceFixture();

    const response = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/catalog/completeness", search: query },
      services,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ code: "bad_request" });
    expect(response.body.error).toMatch(error);
    expect(services.catalogRepository.catalogCompletenessBenchmarkPools).not.toHaveBeenCalled();
  });

  it.each([
    {
      query: "?source=made_up_source",
      error: /source/u,
    },
    {
      query: "?severity=fatal",
      error: /severity/u,
    },
    {
      query: "?status=made_up_status",
      error: /status/u,
    },
    {
      query: "?catalogRecordId=",
      error: /catalogRecordId/u,
    },
    {
      query: "?catalogRecordId=work-duplicate&typo=1",
      error: /unknown catalog conflict query parameter: typo/u,
    },
  ])("rejects malformed catalog conflict review query $query", async ({ query, error }) => {
    const services = serviceFixture();

    const response = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/catalog/conflicts", search: query },
      services,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ code: "bad_request" });
    expect(response.body.error).toMatch(error);
    expect(services.catalogRepository.catalogConflictReview).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "local path",
      body: {
        ...catalogConflictReviewFixture,
        rows: [{ ...catalogConflictReviewFixture.rows[0]!, localPath: "/home/private/RJ010" }],
      },
      error: /localPath/u,
    },
    {
      name: "source id",
      body: {
        ...catalogConflictReviewFixture,
        rows: [
          {
            ...catalogConflictReviewFixture.rows[0]!,
            sourceIds: [
              ...catalogConflictReviewFixture.rows[0]!.sourceIds,
              {
                catalogSource: "dlsite",
                sourceId: "file:/home/private/RJ010.zip/story.ks",
              },
            ],
          },
        ],
      },
      error: /sourceId/u,
    },
    {
      name: "raw payload",
      body: {
        ...catalogConflictReviewFixture,
        rows: [
          {
            ...catalogConflictReviewFixture.rows[0]!,
            provenance: [
              {
                ...catalogConflictReviewFixture.rows[0]!.provenance[0]!,
                rawPayload: { localPath: "/home/private/RJ010.json" },
              },
            ],
          },
        ],
      },
      error: /rawPayload/u,
    },
    {
      name: "private metadata",
      body: {
        ...catalogConflictReviewFixture,
        rows: [
          {
            ...catalogConflictReviewFixture.rows[0]!,
            sourceIds: [
              {
                ...catalogConflictReviewFixture.rows[0]!.sourceIds[0]!,
                privateMetadata: { scanner: "local-importer" },
              },
            ],
          },
        ],
      },
      error: /privateMetadata/u,
    },
    {
      name: "local catalog source",
      body: {
        ...catalogConflictReviewFixture,
        rows: [
          {
            ...catalogConflictReviewFixture.rows[0]!,
            provenance: [
              {
                ...catalogConflictReviewFixture.rows[0]!.provenance[0]!,
                catalogSource: "local_corpus",
                sourceId: "local-conflict-secret",
                sourceRecordKind: "local_scan",
              },
            ],
          },
        ],
      },
      error: /catalogSource/u,
    },
  ])("does not expose private catalog conflict $name fields", async ({ body, error }) => {
    const services = serviceFixture();
    services.catalogRepository.catalogConflictReview.mockResolvedValueOnce(body);

    const response = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/catalog/conflicts" },
      services,
    );

    expect(response.statusCode).toBe(500);
    expect(response.body).toMatchObject({ code: "internal_error" });
    expect(response.body.error).toMatch(error);
  });

  it.each([
    {
      name: "status",
      field: /\.status must be one of/u,
      invalid: "totally-invalid-status",
      body: {
        ...catalogConflictReviewFixture,
        rows: [{ ...catalogConflictReviewFixture.rows[0]!, status: "totally-invalid-status" }],
      },
    },
    {
      name: "conflictKind",
      field: /\.conflictKind must be one of/u,
      invalid: "totally-invalid-conflict-kind",
      body: {
        ...catalogConflictReviewFixture,
        rows: [
          {
            ...catalogConflictReviewFixture.rows[0]!,
            conflictKind: "totally-invalid-conflict-kind",
          },
        ],
      },
    },
    {
      name: "externalIdKind",
      field: /\.externalIdKind must be one of/u,
      invalid: "totally-invalid-external-id-kind",
      body: {
        ...catalogConflictReviewFixture,
        rows: [
          {
            ...catalogConflictReviewFixture.rows[0]!,
            exactLinkRefs: [
              {
                ...catalogConflictReviewFixture.rows[0]!.exactLinkRefs[0]!,
                externalIdKind: "totally-invalid-external-id-kind",
              },
            ],
          },
        ],
      },
    },
    {
      name: "catalogSource",
      field: /\.catalogSource must be one of/u,
      invalid: "totally-invalid-source",
      body: {
        ...catalogConflictReviewFixture,
        rows: [
          {
            ...catalogConflictReviewFixture.rows[0]!,
            sourceIds: [
              {
                ...catalogConflictReviewFixture.rows[0]!.sourceIds[0]!,
                catalogSource: "totally-invalid-source",
              },
            ],
          },
        ],
      },
    },
    {
      name: "sourceRecordKind",
      field: /\.sourceRecordKind must be one of/u,
      invalid: "totally-invalid-record-kind",
      body: {
        ...catalogConflictReviewFixture,
        rows: [
          {
            ...catalogConflictReviewFixture.rows[0]!,
            provenance: [
              {
                ...catalogConflictReviewFixture.rows[0]!.provenance[0]!,
                sourceRecordKind: "totally-invalid-record-kind",
              },
            ],
          },
        ],
      },
    },
  ])(
    "rejects arbitrary strings for the catalog conflict enum field $name",
    async ({ body, field, invalid }) => {
      const services = serviceFixture();
      services.catalogRepository.catalogConflictReview.mockResolvedValueOnce(
        body as CatalogConflictReviewReadModel,
      );

      const response = await handleItotoriApiRequest(
        { method: "GET", pathname: "/api/catalog/conflicts" },
        services,
      );

      expect(response.statusCode).toBe(500);
      expect(response.body).toMatchObject({ code: "internal_error" });
      expect(response.body.error).toMatch(field);
      expect(response.body.error).toContain(invalid);
    },
  );

  it("accepts valid enum values for every catalog conflict enum field", async () => {
    const services = serviceFixture();
    const body: CatalogConflictReviewReadModel = {
      ...catalogConflictReviewFixture,
      rows: [
        {
          ...catalogConflictReviewFixture.rows[0]!,
          status: "duplicate_source",
          conflictKind: "title",
          exactLinkRefs: [
            {
              ...catalogConflictReviewFixture.rows[0]!.exactLinkRefs[0]!,
              externalIdKind: "release_record",
            },
          ],
          sourceIds: [
            {
              ...catalogConflictReviewFixture.rows[0]!.sourceIds[0]!,
              catalogSource: "egs",
            },
          ],
          provenance: [
            {
              ...catalogConflictReviewFixture.rows[0]!.provenance[0]!,
              catalogSource: "egs",
              sourceRecordKind: "normalized_record",
            },
          ],
        },
      ],
    };
    services.catalogRepository.catalogConflictReview.mockResolvedValueOnce(body);

    const response = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/catalog/conflicts" },
      services,
    );

    expect(response).toEqual({ statusCode: 200, body });
  });

  it.each([
    {
      name: "local path",
      body: {
        ...catalogCompletenessFixture,
        pools: {
          ...catalogCompletenessFixture.pools,
          mtl_only: [
            {
              ...catalogCompletenessFixture.pools.mtl_only[0]!,
              localPath: "/home/private/catalog/work",
            },
          ],
        },
      },
      error: /localPath/u,
    },
    {
      name: "status source id",
      body: {
        ...catalogCompletenessFixture,
        pools: {
          ...catalogCompletenessFixture.pools,
          mtl_only: [
            {
              ...catalogCompletenessFixture.pools.mtl_only[0]!,
              statuses: [
                {
                  ...catalogCompletenessFixture.pools.mtl_only[0]!.statuses[0]!,
                  source: {
                    ...catalogCompletenessFixture.pools.mtl_only[0]!.statuses[0]!.source!,
                    sourceId: "/scratch/private/catalog/source.ks",
                  },
                },
              ],
            },
          ],
        },
      },
      error: /sourceId/u,
    },
    {
      name: "raw payload",
      body: {
        ...catalogCompletenessFixture,
        pools: {
          ...catalogCompletenessFixture.pools,
          mtl_only: [
            {
              ...catalogCompletenessFixture.pools.mtl_only[0]!,
              statuses: [
                {
                  ...catalogCompletenessFixture.pools.mtl_only[0]!.statuses[0]!,
                  source: {
                    ...catalogCompletenessFixture.pools.mtl_only[0]!.statuses[0]!.source!,
                    rawPayload: { localPath: "/home/private/catalog/source.json" },
                  },
                },
              ],
            },
          ],
        },
      },
      error: /rawPayload/u,
    },
    {
      name: "private metadata",
      body: {
        ...catalogCompletenessFixture,
        pools: {
          ...catalogCompletenessFixture.pools,
          mtl_only: [
            {
              ...catalogCompletenessFixture.pools.mtl_only[0]!,
              statuses: [
                {
                  ...catalogCompletenessFixture.pools.mtl_only[0]!.statuses[0]!,
                  privateMetadata: { scanner: "local-importer" },
                },
              ],
            },
          ],
        },
      },
      error: /privateMetadata/u,
    },
    {
      name: "private redaction provenance",
      body: {
        ...catalogCompletenessFixture,
        pools: {
          ...catalogCompletenessFixture.pools,
          mtl_only: [
            {
              ...catalogCompletenessFixture.pools.mtl_only[0]!,
              statuses: [
                {
                  ...catalogCompletenessFixture.pools.mtl_only[0]!.statuses[0]!,
                  rawContentRedactionClass: "private_corpus",
                  source: {
                    ...catalogCompletenessFixture.pools.mtl_only[0]!.statuses[0]!.source!,
                    catalogSource: "local_corpus",
                    sourceRecordKind: "local_scan",
                    rawContentRedactionClass: "private_corpus",
                  },
                },
              ],
            },
          ],
        },
      },
      error: /rawContentRedactionClass/u,
    },
  ])("does not expose private catalog completeness $name fields", async ({ body, error }) => {
    const services = serviceFixture();
    services.catalogRepository.catalogCompletenessBenchmarkPools.mockResolvedValueOnce(body);

    const response = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/catalog/completeness" },
      services,
    );

    expect(response.statusCode).toBe(500);
    expect(response.body).toMatchObject({ code: "internal_error" });
    expect(response.body.error).toMatch(error);
  });

  it.each([
    {
      name: "language status",
      body: {
        ...catalogCompletenessFixture,
        pools: {
          ...catalogCompletenessFixture.pools,
          mtl_only: [
            {
              ...catalogCompletenessFixture.pools.mtl_only[0]!,
              statuses: [
                {
                  ...catalogCompletenessFixture.pools.mtl_only[0]!.statuses[0]!,
                  status: "totally_translated" as CatalogLanguageStatus,
                },
              ],
            },
          ],
        },
      },
      error: /statuses\[0\]\.status must be one of/u,
    },
    {
      name: "language status scope",
      body: {
        ...catalogCompletenessFixture,
        pools: {
          ...catalogCompletenessFixture.pools,
          mtl_only: [
            {
              ...catalogCompletenessFixture.pools.mtl_only[0]!,
              statuses: [
                {
                  ...catalogCompletenessFixture.pools.mtl_only[0]!.statuses[0]!,
                  statusScope: "galaxy" as CatalogLanguageStatusScope,
                },
              ],
            },
          ],
        },
      },
      error: /statuses\[0\]\.statusScope must be one of/u,
    },
    {
      name: "confidence",
      body: {
        ...catalogCompletenessFixture,
        pools: {
          ...catalogCompletenessFixture.pools,
          mtl_only: [
            {
              ...catalogCompletenessFixture.pools.mtl_only[0]!,
              statuses: [
                {
                  ...catalogCompletenessFixture.pools.mtl_only[0]!.statuses[0]!,
                  confidence: "absolutely_certain" as CatalogConfidence,
                },
              ],
            },
          ],
        },
      },
      error: /statuses\[0\]\.confidence must be one of/u,
    },
    {
      name: "conflict status",
      body: {
        ...catalogCompletenessFixture,
        pools: {
          ...catalogCompletenessFixture.pools,
          mtl_only: [
            {
              ...catalogCompletenessFixture.pools.mtl_only[0]!,
              conflicts: [
                {
                  conflictId: "conflict-invalid",
                  status: "escalated" as CatalogConflictStatus,
                  reasonCode: "language_status_disagreement",
                  sourceIds: [{ catalogSource: "egs", sourceId: "egs-mtl" }],
                  privateSourceCount: 0,
                },
              ],
            },
          ],
        },
      },
      error: /conflicts\[0\]\.status must be one of/u,
    },
    {
      name: "report pool",
      body: {
        ...catalogCompletenessFixture,
        publicReport: {
          ...catalogCompletenessFixture.publicReport,
          pools: [
            {
              pool: "hyper_only" as CatalogCompletenessPool,
              workCount: 0,
              sourceIds: [],
            },
          ],
        },
      },
      error: /publicReport\.pools\[0\]\.pool must be one of/u,
    },
    {
      name: "report status",
      body: {
        ...catalogCompletenessFixture,
        publicReport: {
          ...catalogCompletenessFixture.publicReport,
          statuses: [
            {
              status: "ultra_translated" as CatalogLanguageStatus,
              factCount: 0,
              sourceIds: [],
            },
          ],
        },
      },
      error: /publicReport\.statuses\[0\]\.status must be one of/u,
    },
  ])("rejects invalid catalog completeness enum $name", async ({ body, error }) => {
    const services = serviceFixture();
    services.catalogRepository.catalogCompletenessBenchmarkPools.mockResolvedValueOnce(body);

    const response = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/catalog/completeness" },
      services,
    );

    expect(response.statusCode).toBe(500);
    expect(response.body).toMatchObject({ code: "internal_error" });
    expect(response.body.error).toMatch(error);
  });

  it("accepts valid catalog completeness enum values including conflict status", async () => {
    const services = serviceFixture();
    services.catalogRepository.catalogCompletenessBenchmarkPools.mockResolvedValueOnce({
      ...catalogCompletenessFixture,
      pools: {
        ...catalogCompletenessFixture.pools,
        mtl_only: [
          {
            ...catalogCompletenessFixture.pools.mtl_only[0]!,
            conflicts: [
              {
                conflictId: "conflict-valid",
                status: "open" as CatalogConflictStatus,
                reasonCode: "language_status_disagreement",
                sourceIds: [{ catalogSource: "egs", sourceId: "egs-mtl" }],
                privateSourceCount: 0,
              },
            ],
          },
        ],
      },
    });

    const response = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/catalog/completeness" },
      services,
    );

    expect(response.statusCode).toBe(200);
  });

  it.each([
    {
      query: "?targetLanguage=en-US",
      filter: { targetLanguage: "en-US" },
    },
    {
      query: "?pools=no_english,mtl_only",
      filter: { pools: ["no_english", "mtl_only"] },
    },
    {
      query: "?adapterIds=kaifuu.rpg-maker-mv-mz,kaifuu.reallive",
      filter: { adapterIds: ["kaifuu.rpg-maker-mv-mz", "kaifuu.reallive"] },
    },
    {
      query: "?requiredCapabilities=extract&requiredCapabilities=patch",
      filter: { requiredCapabilities: ["extract", "patch"] },
    },
    {
      query: "?requiredCapabilities=extract,patch",
      filter: { requiredCapabilities: ["extract", "patch"] },
    },
    {
      query: "?minCapabilityLevel=inventory&requiredCapabilities=extract,patch",
      filter: {
        minCapabilityLevel: "inventory",
        requiredCapabilities: ["extract", "patch"],
      },
    },
    {
      query:
        "?targetLanguage=en-US&pools=conflict&pools=unknown&adapterIds=kaifuu.rpg-maker-mv-mz&adapterIds=kaifuu.reallive&minCapabilityLevel=extract&requiredCapabilities=identify&requiredCapabilities=patch&demandBucket=very_high&translationCompleteness=none,mtl&translationCompleteness=unknown&provenanceRequired=true&localOwnership=owned&includeDemoted=true&limit=25",
      filter: {
        targetLanguage: "en-US",
        pools: ["conflict", "unknown"],
        adapterIds: ["kaifuu.rpg-maker-mv-mz", "kaifuu.reallive"],
        minCapabilityLevel: "extract",
        requiredCapabilities: ["identify", "patch"],
        demandBucket: "very_high",
        translationCompleteness: ["none", "mtl", "unknown"],
        provenanceRequired: true,
        localOwnership: "owned",
        includeDemoted: true,
        limit: 25,
      },
    },
  ])("passes catalog benchmark seed filter $query to the read model", async ({ query, filter }) => {
    const services = serviceFixture();

    const response = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/catalog/benchmark-seeds", search: query },
      services,
    );

    expect(response).toEqual({ statusCode: 200, body: catalogBenchmarkSeedsFixture });
    expect(services.catalogRepository.catalogBenchmarkSeedFinder).toHaveBeenCalledWith(filter);
    expect(services.authorization.requirePermission).not.toHaveBeenCalled();
  });

  it("normalizes empty catalog benchmark seed adapterIds query values like other list filters", async () => {
    const services = serviceFixture();

    const response = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/catalog/benchmark-seeds", search: "?adapterIds=, %20 ," },
      services,
    );

    expect(response).toEqual({ statusCode: 200, body: catalogBenchmarkSeedsFixture });
    expect(services.catalogRepository.catalogBenchmarkSeedFinder).toHaveBeenCalledWith({});
  });

  it("rejects catalog benchmark seed rows that include runtime evidence readiness", async () => {
    const services = serviceFixture();
    const body = {
      ...catalogBenchmarkSeedsFixture,
      rows: [
        {
          ...catalogBenchmarkSeedsFixture.rows[0]!,
          runtimeEvidenceReadiness: "partial_public_and_aggregate",
        },
      ],
    } as unknown as typeof catalogBenchmarkSeedsFixture;
    services.catalogRepository.catalogBenchmarkSeedFinder.mockResolvedValueOnce(body);

    const response = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/catalog/benchmark-seeds" },
      services,
    );

    expect(response.statusCode).toBe(500);
    expect(response.body).toMatchObject({ code: "internal_error" });
    expect(response.body.error).toMatch(/runtimeEvidenceReadiness/u);
  });

  it.each([
    {
      query: "?targetLanguage=en-US",
      filter: { targetLanguage: "en-US" },
    },
    {
      query:
        "?targetLanguage=en-US&includeDemoted=true&limit=25&engine=rpg-maker-mv-mz&pool=no_english&minCapabilityLevel=extract&localOwnership=owned&demandBucket=very_high",
      filter: {
        targetLanguage: "en-US",
        includeDemoted: true,
        limit: 25,
        engine: "rpg-maker-mv-mz",
        pool: "no_english",
        minCapabilityLevel: "extract",
        localOwnership: "owned",
        demandBucket: "very_high",
      },
    },
  ])("passes catalog opportunity filter $query to the read model", async ({ query, filter }) => {
    const services = serviceFixture();

    const response = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/catalog/opportunities", search: query },
      services,
    );

    expect(response).toEqual({ statusCode: 200, body: catalogOpportunitiesFixture });
    expect(services.catalogRepository.catalogOpportunityRanking).toHaveBeenCalledWith(filter);
    expect(services.authorization.requirePermission).not.toHaveBeenCalled();
  });

  it("accepts real-shaped catalog opportunity factor rows including DLsite work type", async () => {
    const services = serviceFixture();

    const response = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/catalog/opportunities" },
      services,
    );

    expect(response).toEqual({ statusCode: 200, body: catalogOpportunitiesFixture });
    expect(response.body.rows[0]?.factorBreakdown.map((factor) => factor.factor)).toEqual([
      "translation_completeness",
      "local_ownership",
      "dlsite_demand",
      "platform_language_conflict",
      "market_prevalence",
      "adapter_readiness",
      "runtime_evidence_readiness",
      "dlsite_work_type",
      "existing_translation_status",
      "benchmark_usefulness",
      "unknown_evidence",
    ]);
  });

  it("accepts catalog opportunity rows with partial runtime evidence readiness and fractional evidence counts", async () => {
    const services = serviceFixture();
    const readinessStates = [
      {
        status: "partial_public_and_aggregate",
        publicFixtureEvidenceCount: 0.5,
        privateLocalAggregateEvidenceCount: 0.5,
      },
      {
        status: "partial_public_fixture",
        publicFixtureEvidenceCount: 0.5,
        privateLocalAggregateEvidenceCount: 0,
      },
      {
        status: "partial_private_local_aggregate",
        publicFixtureEvidenceCount: 0,
        privateLocalAggregateEvidenceCount: 0.5,
      },
    ];
    const body = {
      ...catalogOpportunitiesFixture,
      rows: readinessStates.map((runtimeEvidenceReadiness, index) => ({
        ...catalogOpportunitiesFixture.rows[0]!,
        rank: index + 1,
        workId: `work-opportunity-partial-${index + 1}`,
        localEvidenceCount: 0.5,
        runtimeEvidenceReadiness,
      })),
    } as unknown as typeof catalogOpportunitiesFixture;
    services.catalogRepository.catalogOpportunityRanking.mockResolvedValueOnce(body);

    const response = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/catalog/opportunities" },
      services,
    );

    expect(response).toEqual({ statusCode: 200, body });
  });

  it.each([
    {
      query: "?targetLanguage=",
      error: /targetLanguage/u,
    },
    {
      query: "?includeDemoted=1",
      error: /includeDemoted/u,
    },
    {
      query: "?limit=0",
      error: /limit/u,
    },
    {
      query: "?engine=",
      error: /engine/u,
    },
    {
      query: "?pool=official_english_conflict",
      error: /pool/u,
    },
    {
      query: "?minCapabilityLevel=runtime",
      error: /minCapabilityLevel/u,
    },
    {
      query: "?localOwnership=aggregate_seen",
      error: /localOwnership/u,
    },
    {
      query: "?demandBucket=viral",
      error: /demandBucket/u,
    },
    {
      query: "?targetLanguage=en-US&typo=1",
      error: /unknown catalog opportunity query parameter: typo/u,
    },
  ])("rejects malformed catalog opportunity query $query", async ({ query, error }) => {
    const services = serviceFixture();

    const response = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/catalog/opportunities", search: query },
      services,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ code: "bad_request" });
    expect(response.body.error).toMatch(error);
    expect(services.catalogRepository.catalogOpportunityRanking).not.toHaveBeenCalled();
  });

  it.each([
    {
      query: "?targetLanguage=",
      error: /targetLanguage/u,
    },
    {
      query: "?pools=official_full",
      error: /pools/u,
    },
    {
      query: "?minCapabilityLevel=runtime",
      error: /minCapabilityLevel/u,
    },
    {
      query: "?requiredCapabilities=runtime",
      error: /requiredCapabilities/u,
    },
    {
      query: "?requiredCapabilities=extract,runtime",
      error: /requiredCapabilities/u,
    },
    {
      query: "?provenanceRequired=yes",
      error: /provenanceRequired/u,
    },
    {
      query: "?translationCompleteness=official_partial",
      error: /translationCompleteness/u,
    },
    {
      query: "?localOwnership=local_path",
      error: /localOwnership/u,
    },
    {
      query: "?includeDemoted=1",
      error: /includeDemoted/u,
    },
    {
      query: "?limit=0",
      error: /limit/u,
    },
    {
      query: "?typo=1",
      error: /unknown catalog benchmark seed query parameter: typo/u,
    },
  ])("rejects malformed catalog benchmark seed query $query", async ({ query, error }) => {
    const services = serviceFixture();

    const response = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/catalog/benchmark-seeds", search: query },
      services,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ code: "bad_request" });
    expect(response.body.error).toMatch(error);
    expect(services.catalogRepository.catalogBenchmarkSeedFinder).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "local path",
      body: {
        ...catalogBenchmarkSeedsFixture,
        rows: [{ ...catalogBenchmarkSeedsFixture.rows[0]!, localPath: "/home/local/game" }],
      },
      error: /localPath/u,
    },
    {
      name: "raw payload",
      body: {
        ...catalogBenchmarkSeedsFixture,
        rows: [
          {
            ...catalogBenchmarkSeedsFixture.rows[0]!,
            provenance: [
              {
                ...catalogBenchmarkSeedsFixture.rows[0]!.provenance[0]!,
                rawPayload: { private: true },
              },
            ],
          },
        ],
      },
      error: /rawPayload/u,
    },
    {
      name: "payload hash",
      body: {
        ...catalogBenchmarkSeedsFixture,
        rows: [
          {
            ...catalogBenchmarkSeedsFixture.rows[0]!,
            provenance: [
              {
                ...catalogBenchmarkSeedsFixture.rows[0]!.provenance[0]!,
                payloadHash: "sha256:fixture",
              },
            ],
          },
        ],
      },
      error: /payloadHash/u,
    },
    {
      name: "private title string",
      body: {
        ...catalogBenchmarkSeedsFixture,
        rows: [
          {
            ...catalogBenchmarkSeedsFixture.rows[0]!,
            canonicalTitle: "private-story-title",
          },
        ],
      },
      error: /canonicalTitle/u,
    },
    {
      name: "private source id string",
      body: {
        ...catalogBenchmarkSeedsFixture,
        rows: [
          {
            ...catalogBenchmarkSeedsFixture.rows[0]!,
            sourceIds: [
              {
                ...catalogBenchmarkSeedsFixture.rows[0]!.sourceIds[0]!,
                sourceId: "file:/home/private/RJSEED001.zip/story.ks",
              },
            ],
          },
        ],
      },
      error: /sourceId/u,
    },
    {
      name: "private fixture id string",
      body: {
        ...catalogBenchmarkSeedsFixture,
        rows: [
          {
            ...catalogBenchmarkSeedsFixture.rows[0]!,
            provenance: [
              {
                ...catalogBenchmarkSeedsFixture.rows[0]!.provenance[0]!,
                fixtureId: "catalog-benchmark-seeds/private-title.zip/member.json",
              },
            ],
          },
        ],
      },
      error: /fixtureId/u,
    },
    {
      name: "private explanation code string",
      body: {
        ...catalogBenchmarkSeedsFixture,
        rows: [
          {
            ...catalogBenchmarkSeedsFixture.rows[0]!,
            explanationCodes: ["demoted_open_conflict:/tmp/private/archive.zip/member.ks"],
          },
        ],
      },
      error: /explanationCodes/u,
    },
  ])("does not expose private catalog benchmark seed $name fields", async ({ body, error }) => {
    const services = serviceFixture();
    services.catalogRepository.catalogBenchmarkSeedFinder.mockResolvedValueOnce(body);

    const response = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/catalog/benchmark-seeds" },
      services,
    );

    expect(response.statusCode).toBe(500);
    expect(response.body).toMatchObject({ code: "internal_error" });
    expect(response.body.error).toMatch(error);
  });

  it.each([
    {
      name: "catalog source",
      body: {
        ...catalogBenchmarkSeedsFixture,
        rows: [
          {
            ...catalogBenchmarkSeedsFixture.rows[0]!,
            sourceIds: [
              {
                ...catalogBenchmarkSeedsFixture.rows[0]!.sourceIds[0]!,
                catalogSource: "unsupported_source",
              },
            ],
          },
        ],
      },
      error: /catalogSource/u,
    },
    {
      name: "external id kind",
      body: {
        ...catalogBenchmarkSeedsFixture,
        rows: [
          {
            ...catalogBenchmarkSeedsFixture.rows[0]!,
            sourceIds: [
              {
                ...catalogBenchmarkSeedsFixture.rows[0]!.sourceIds[0]!,
                externalIdKind: "private_archive_member",
              },
            ],
          },
        ],
      },
      error: /externalIdKind/u,
    },
    {
      name: "translation status",
      body: {
        ...catalogBenchmarkSeedsFixture,
        rows: [
          {
            ...catalogBenchmarkSeedsFixture.rows[0]!,
            translationStatuses: [
              {
                ...catalogBenchmarkSeedsFixture.rows[0]!.translationStatuses[0]!,
                status: "partial",
              },
            ],
          },
        ],
      },
      error: /status/u,
    },
    {
      name: "translation confidence",
      body: {
        ...catalogBenchmarkSeedsFixture,
        rows: [
          {
            ...catalogBenchmarkSeedsFixture.rows[0]!,
            translationStatuses: [
              {
                ...catalogBenchmarkSeedsFixture.rows[0]!.translationStatuses[0]!,
                confidence: "certain",
              },
            ],
          },
        ],
      },
      error: /confidence/u,
    },
    {
      name: "translation status scope",
      body: {
        ...catalogBenchmarkSeedsFixture,
        rows: [
          {
            ...catalogBenchmarkSeedsFixture.rows[0]!,
            translationStatuses: [
              {
                ...catalogBenchmarkSeedsFixture.rows[0]!.translationStatuses[0]!,
                statusScope: "archive_member",
              },
            ],
          },
        ],
      },
      error: /statusScope/u,
    },
    {
      name: "provenance source record kind",
      body: {
        ...catalogBenchmarkSeedsFixture,
        rows: [
          {
            ...catalogBenchmarkSeedsFixture.rows[0]!,
            provenance: [
              {
                ...catalogBenchmarkSeedsFixture.rows[0]!.provenance[0]!,
                sourceRecordKind: "local_scan",
              },
            ],
          },
        ],
      },
      error: /sourceRecordKind/u,
    },
    {
      name: "provenance redaction class",
      body: {
        ...catalogBenchmarkSeedsFixture,
        rows: [
          {
            ...catalogBenchmarkSeedsFixture.rows[0]!,
            provenance: [
              {
                ...catalogBenchmarkSeedsFixture.rows[0]!.provenance[0]!,
                redactionClass: "private_corpus",
              },
            ],
          },
        ],
      },
      error: /redactionClass/u,
    },
  ])("rejects non-public catalog benchmark seed enum-shaped $name", async ({ body, error }) => {
    const services = serviceFixture();
    services.catalogRepository.catalogBenchmarkSeedFinder.mockResolvedValueOnce(body);

    const response = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/catalog/benchmark-seeds" },
      services,
    );

    expect(response.statusCode).toBe(500);
    expect(response.body).toMatchObject({ code: "internal_error" });
    expect(response.body.error).toMatch(error);
  });

  it.each([
    {
      name: "unsupported factor name",
      body: {
        ...catalogOpportunitiesFixture,
        rows: [
          {
            ...catalogOpportunitiesFixture.rows[0]!,
            factorBreakdown: [
              {
                ...catalogOpportunitiesFixture.rows[0]!.factorBreakdown[0]!,
                factor: "private_repository_signal",
              },
            ],
          },
        ],
      },
      error: /factor/u,
    },
    {
      name: "non-finite score",
      body: {
        ...catalogOpportunitiesFixture,
        rows: [{ ...catalogOpportunitiesFixture.rows[0]!, score: Number.POSITIVE_INFINITY }],
      },
      error: /score/u,
    },
    {
      name: "non-finite factor weighted score",
      body: {
        ...catalogOpportunitiesFixture,
        rows: [
          {
            ...catalogOpportunitiesFixture.rows[0]!,
            factorBreakdown: [
              {
                ...catalogOpportunitiesFixture.rows[0]!.factorBreakdown[0]!,
                weightedScore: Number.NaN,
              },
            ],
          },
        ],
      },
      error: /weightedScore/u,
    },
    {
      name: "malformed factor row",
      body: {
        ...catalogOpportunitiesFixture,
        rows: [
          {
            ...catalogOpportunitiesFixture.rows[0]!,
            factorBreakdown: [
              {
                ...catalogOpportunitiesFixture.rows[0]!.factorBreakdown[0]!,
                rawPath: "/home/private/game",
              },
            ],
          },
        ],
      },
      error: /rawPath/u,
    },
    {
      name: "private evidence ref",
      body: {
        ...catalogOpportunitiesFixture,
        rows: [
          {
            ...catalogOpportunitiesFixture.rows[0]!,
            factorBreakdown: [
              {
                ...catalogOpportunitiesFixture.rows[0]!.factorBreakdown[0]!,
                evidenceRefs: ["localScanEntryId:local-scan-entry-secret"],
              },
            ],
          },
        ],
      },
      error: /evidenceRefs/u,
    },
    {
      name: "private source id",
      body: {
        ...catalogOpportunitiesFixture,
        rows: [
          {
            ...catalogOpportunitiesFixture.rows[0]!,
            sourceIds: [
              {
                ...catalogOpportunitiesFixture.rows[0]!.sourceIds[0]!,
                sourceId: "file:/scratch/private/archive.zip/member.json",
              },
            ],
          },
        ],
      },
      error: /sourceId/u,
    },
  ])("rejects malformed or private catalog opportunity $name fields", async ({ body, error }) => {
    const services = serviceFixture();
    services.catalogRepository.catalogOpportunityRanking.mockResolvedValueOnce(body);

    const response = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/catalog/opportunities" },
      services,
    );

    expect(response.statusCode).toBe(500);
    expect(response.body).toMatchObject({ code: "internal_error" });
    expect(response.body.error).toMatch(error);
  });

  it.each([
    {
      query: "?projectId=project-1&localeBranchId=locale-1&q=Hero&limit=5",
      filter: { projectId: "project-1", localeBranchId: "locale-1", query: "Hero", limit: 5 },
    },
    {
      query: "?localeBranchId=locale-1&q=Hero&includeDeprecated=true",
      filter: { localeBranchId: "locale-1", query: "Hero", includeDeprecated: true },
    },
  ])("passes terminology search filter $query to the read model", async ({ query, filter }) => {
    const services = serviceFixture();

    const response = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/terminology/search", search: query },
      services,
    );

    expect(response).toEqual({ statusCode: 200, body: terminologySearchFixture });
    expect(services.terminologyRepository.searchTerms).toHaveBeenCalledWith(filter);
    expect(services.authorization.requirePermission).not.toHaveBeenCalled();
  });

  it.each([
    {
      query: "?q=Hero",
      error: /localeBranchId/u,
    },
    {
      query: "?localeBranchId=locale-1",
      error: /q must be non-empty/u,
    },
    {
      query: "?localeBranchId=locale-1&q=Hero&limit=0",
      error: /limit/u,
    },
  ])("rejects malformed terminology search query $query", async ({ query, error }) => {
    const services = serviceFixture();

    const response = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/terminology/search", search: query },
      services,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ code: "bad_request" });
    expect(response.body.error).toMatch(error);
    expect(services.terminologyRepository.searchTerms).not.toHaveBeenCalled();
  });

  it("serves project cost reports with unknown token source component counters", async () => {
    const services = serviceFixture();
    const report: ProjectCostReport = {
      ...costReportFixture,
      recentRuns: [
        {
          ...costReportFixture.recentRuns[0]!,
          tokenCountSource: "unknown",
          promptTokens: 12,
          completionTokens: 8,
          reasoningTokens: 3,
          cachedInputTokens: 2,
          totalTokens: null,
        },
      ],
    };
    services.projectWorkflow.getCostReport.mockResolvedValueOnce(report);

    const response = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/projects/cost" },
      services,
    );

    expect(response).toEqual({ statusCode: 200, body: report });
  });

  it.each([
    {
      name: "reasoning-token drift",
      report: {
        ...costReportFixture,
        recentRuns: [
          {
            ...costReportFixture.recentRuns[0]!,
            reasoningTokens: 3,
            totalTokens: 20,
          },
        ],
      },
      error: /reasoningTokens/u,
    },
    {
      name: "unknown source token totals",
      report: {
        ...costReportFixture,
        recentRuns: [
          {
            ...costReportFixture.recentRuns[0]!,
            tokenCountSource: "unknown",
          },
        ],
      },
      error: /unknown token source/u,
    },
    {
      name: "typo token source",
      report: {
        ...costReportFixture,
        recentRuns: [
          {
            ...costReportFixture.recentRuns[0]!,
            tokenCountSource: "provider-reported",
          },
        ],
      } as unknown as ProjectCostReport,
      error: /tokenCountSource/u,
    },
  ])("rejects impossible project cost reports with $name", async ({ report, error }) => {
    const services = serviceFixture();
    services.projectWorkflow.getCostReport.mockResolvedValueOnce(report);

    const response = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/projects/cost" },
      services,
    );

    expect(response.statusCode).toBe(500);
    expect(response.body).toMatchObject({ code: "internal_error" });
    expect(response.body.error).toMatch(error);
  });

  it.each(apiMutationPermissionMatrix)(
    "checks permissions before the $name mutation",
    async ({ request, permission, service }) => {
      const services = serviceFixture();

      const response = await handleItotoriApiRequest(request, services);

      expect(response.statusCode).toBe(200);
      expect(services.authorization.requirePermission).toHaveBeenCalledWith(permission);
      expect(services.projectWorkflow[service]).toHaveBeenCalledTimes(1);
    },
  );

  it("passes explicit non-Japanese-to-English draft locale pairs through the API", async () => {
    const services = serviceFixture();

    const response = await handleItotoriApiRequest(
      post("/api/projects/project-de-en/branches", {
        project: nonJapaneseTargetProjectFixture,
        targetLocale: "en-US",
      }),
      services,
    );

    expect(response.statusCode).toBe(200);
    expect(services.projectWorkflow.draftProject).toHaveBeenCalledWith(
      { ...nonJapaneseTargetProjectFixture, localeBranchId: "locale-de-en-us" },
      "en-US",
    );
  });

  describe("ITOTORI-050 server-side project/branch ownership scoping", () => {
    it("drafts an in-scope branch and writes with the SERVER-SIDE branch id", async () => {
      const services = serviceFixture();

      const response = await handleItotoriApiRequest(
        post("/api/projects/project-1/branches", {
          project: projectFixture,
          targetLocale: "fr-FR",
        }),
        services,
      );

      expect(response.statusCode).toBe(200);
      // The write is keyed on the server-side authoritative branch, not the
      // client's copy — proving the client cannot smuggle a foreign branch.
      expect(services.projectWorkflow.draftProject).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: "project-1", localeBranchId: "locale-1" }),
        "fr-FR",
      );
      expect(services.projectWorkflow.listLocaleBranchIdentities).toHaveBeenCalledWith("project-1");
    });

    it("refuses a branch draft whose client-supplied ProjectState carries a FORGED branch id", async () => {
      const services = serviceFixture();

      const response = await handleItotoriApiRequest(
        post("/api/projects/project-1/branches", {
          // Attacker keeps the owned projectId (passes assertPathProject) but
          // forges a branch id the server does not attribute to project-1.
          project: { ...projectFixture, localeBranchId: "locale-owned-by-someone-else" },
          targetLocale: "fr-FR",
        }),
        services,
      );

      expect(response.statusCode).toBe(403);
      expect(response.body).toMatchObject({ code: "forbidden" });
      expect(services.projectWorkflow.draftProject).not.toHaveBeenCalled();
    });

    it("refuses a branch draft against an UNKNOWN / out-of-scope project", async () => {
      const services = serviceFixture();

      const response = await handleItotoriApiRequest(
        post("/api/projects/project-not-owned/branches", {
          project: {
            ...projectFixture,
            projectId: "project-not-owned",
            localeBranchId: "locale-1",
          },
          targetLocale: "fr-FR",
        }),
        services,
      );

      expect(response.statusCode).toBe(403);
      expect(response.body).toMatchObject({ code: "forbidden" });
      expect(services.projectWorkflow.draftProject).not.toHaveBeenCalled();
    });

    it("refuses runtime-evidence ingest whose ProjectState carries a foreign branch id", async () => {
      const services = serviceFixture();

      const response = await handleItotoriApiRequest(
        post("/api/projects/project-1/runtime-evidence", {
          project: { ...projectFixture, localeBranchId: "locale-forged" },
          runtimeReport: runtimeReportFixture,
        }),
        services,
      );

      expect(response.statusCode).toBe(403);
      expect(response.body).toMatchObject({ code: "forbidden" });
      expect(services.projectWorkflow.ingestRuntimeReport).not.toHaveBeenCalled();
    });

    it("ingests in-scope runtime-evidence with the server-side branch id", async () => {
      const services = serviceFixture();

      const response = await handleItotoriApiRequest(
        post("/api/projects/project-1/runtime-evidence", {
          project: projectFixture,
          runtimeReport: runtimeReportFixture,
        }),
        services,
      );

      expect(response.statusCode).toBe(200);
      expect(services.projectWorkflow.ingestRuntimeReport).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: "project-1", localeBranchId: "locale-1" }),
        runtimeReportFixture,
      );
    });

    it("refuses a finding record naming a foreign branch id", async () => {
      const services = serviceFixture();

      const response = await handleItotoriApiRequest(
        post("/api/projects/project-1/findings", {
          localeBranchId: "locale-forged",
          finding: findingRecordFixture,
        }),
        services,
      );

      expect(response.statusCode).toBe(403);
      expect(response.body).toMatchObject({ code: "forbidden" });
      expect(services.projectWorkflow.recordFinding).not.toHaveBeenCalled();
    });

    it("records a project-scoped finding (no branch id) once the project is server-side verified", async () => {
      const services = serviceFixture();

      const response = await handleItotoriApiRequest(
        post("/api/projects/project-1/findings", { finding: findingRecordFixture }),
        services,
      );

      expect(response.statusCode).toBe(200);
      expect(services.projectWorkflow.recordFinding).toHaveBeenCalledTimes(1);
    });

    it("refuses a decision record against an unknown project", async () => {
      const services = serviceFixture();

      const response = await handleItotoriApiRequest(
        post("/api/projects/project-not-owned/decisions", {
          localeBranchId: "locale-1",
          event: decisionEventFixture,
        }),
        services,
      );

      expect(response.statusCode).toBe(403);
      expect(response.body).toMatchObject({ code: "forbidden" });
      expect(services.projectWorkflow.recordDecision).not.toHaveBeenCalled();
    });

    it("refuses a benchmark whose (real) branch is not owned by the project in the path", async () => {
      const services = serviceFixture();

      // The report's branch (019ed006-…-b1) is a real branch of project-1, but
      // it is submitted under project-de-en, which does NOT own it. The
      // server-side ownership check refuses it before recording.
      const response = await handleItotoriApiRequest(
        post("/api/projects/project-de-en/benchmarks", {
          benchmarkReport: benchmarkReportFixture,
        }),
        services,
      );

      expect(response.statusCode).toBe(403);
      expect(response.body).toMatchObject({ code: "forbidden" });
      expect(services.projectWorkflow.recordBenchmarkReport).not.toHaveBeenCalled();
    });

    it("checks the ownership scope only AFTER the permission gate", async () => {
      const services = serviceFixture();
      services.authorization.requirePermission.mockRejectedValueOnce(
        new AuthorizationError(deniedActor, permissionValues.draftWrite),
      );

      const response = await handleItotoriApiRequest(
        post("/api/projects/project-1/branches", {
          project: { ...projectFixture, localeBranchId: "locale-forged" },
          targetLocale: "fr-FR",
        }),
        services,
      );

      // A missing permission is refused before the scope lookup runs at all.
      expect(response.statusCode).toBe(403);
      expect(services.projectWorkflow.listLocaleBranchIdentities).not.toHaveBeenCalled();
      expect(services.projectWorkflow.draftProject).not.toHaveBeenCalled();
    });
  });

  it("rejects malformed request bodies before checking permissions", async () => {
    const services = serviceFixture();

    const response = await handleItotoriApiRequest(
      post("/api/imports/bridge", { bridge: { schemaVersion: "bad" } }),
      services,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ code: "bad_request" });
    expect(services.authorization.requirePermission).not.toHaveBeenCalled();
    expect(services.projectWorkflow.importBridge).not.toHaveBeenCalled();
  });

  it("returns forbidden when permission middleware rejects a mutation", async () => {
    const services = serviceFixture();
    services.authorization.requirePermission.mockRejectedValueOnce(
      new AuthorizationError({ userId: "missing-grant" }, permissionValues.projectImport),
    );

    const response = await handleItotoriApiRequest(
      post("/api/imports/bridge", { bridge: bridgeFixture }),
      services,
    );

    expect(response.statusCode).toBe(403);
    expect(response.body).toMatchObject({ code: "forbidden" });
    expect(services.projectWorkflow.importBridge).not.toHaveBeenCalled();
  });

  describe("gate-mutation-route-status-echo — redact the success-body status echo", () => {
    // The POST /api/imports/bridge + POST .../branches (draft) success bodies
    // echo getDashboardStatus(), which embeds cost.recentRuns (provider/model
    // + routing internals) + translation-memory reuse events. A caller without
    // catalog.read — the same gate the sibling read routes enforce — must
    // receive the redacted public summary; a holder still gets the full echo.
    const mutationStatusEchoRoutes = [
      {
        name: "imports.bridge",
        request: post("/api/imports/bridge", { bridge: bridgeFixture }),
      },
      {
        name: "branches.draft",
        request: post("/api/projects/project-1/branches", {
          project: projectFixture,
          targetLocale: "fr-FR",
        }),
      },
    ] as const;

    it.each(mutationStatusEchoRoutes)(
      "echoes the FULL status to a $name caller holding catalog.read",
      async ({ request }) => {
        const services = serviceFixture();

        const response = await handleItotoriApiRequest(request, services);

        expect(response.statusCode).toBe(200);
        const status = (response.body as { status: typeof dashboardStatusFixture }).status;
        // Privileged callers see the run ledger + translation-memory reuse
        // events verbatim — same shape the read routes return.
        expect(status.cost.recentRuns).toHaveLength(costReportFixture.recentRuns.length);
        expect(status.cost.translationMemoryReuse.recentEvents).toHaveLength(
          costReportFixture.translationMemoryReuse.recentEvents.length,
        );
        const serialized = JSON.stringify(response.body);
        expect(serialized).toContain("provider-run-1");
        expect(serialized).toContain("openrouter");
        // catalog.read was resolved for the echo gate (in addition to the
        // mutation's own write permission).
        expect(services.authorization.requirePermission).toHaveBeenCalledWith(
          permissionValues.catalogRead,
        );
      },
    );

    it.each(mutationStatusEchoRoutes)(
      "REDACTS the $name status echo (recentRuns/recentEvents) without catalog.read",
      async ({ request }) => {
        const services = serviceFixture();
        vi.mocked(services.authorization.requirePermission).mockImplementation(
          async (permission) => {
            if (permission === permissionValues.catalogRead) {
              throw new AuthorizationError({ userId: "api-user-without-catalog-read" }, permission);
            }
          },
        );

        const response = await handleItotoriApiRequest(request, services);

        expect(response.statusCode).toBe(200);
        const status = (response.body as { status: typeof dashboardStatusFixture }).status;
        // Run-ledger detail (provider/model/routing internals) is stripped.
        expect(status.cost.recentRuns).toEqual([]);
        // Translation-memory reuse events (carrying targetText) are stripped.
        expect(status.cost.translationMemoryReuse.recentEvents).toEqual([]);
        // Safe aggregates survive so the public dashboard still renders.
        expect(status.cost.runCount).toBe(costReportFixture.runCount);
        expect(status.cost.billedMicrosUsd).toBe(costReportFixture.billedMicrosUsd);
        expect(status.cost.totalsByCostKind).toHaveLength(
          costReportFixture.totalsByCostKind.length,
        );
        expect(status.cost.translationMemoryReuse.reuseEventCount).toBe(
          costReportFixture.translationMemoryReuse.reuseEventCount,
        );
        // The sensitive strings must be ABSENT from the unprivileged echo.
        const serialized = JSON.stringify(response.body);
        expect(serialized).not.toContain("provider-run-1");
        expect(serialized).not.toContain("openrouter");
        expect(serialized).not.toContain("itotori-fake-draft-v0");
        expect(serialized).not.toContain("routingPosture");
        // Non-sensitive dashboard identity/counts remain visible.
        expect(status.projectId).toBe(dashboardStatusFixture.projectId);
        expect(status.unitCount).toBe(dashboardStatusFixture.unitCount);
      },
    );
  });

  it.each(apiMutationPermissionMatrix)(
    "returns forbidden before invoking the $name mutation when authorization rejects",
    async ({ request, permission, service }) => {
      const services = serviceFixture();
      services.authorization.requirePermission.mockRejectedValueOnce(
        new AuthorizationError(deniedActor, permission),
      );

      const response = await handleItotoriApiRequest(request, services);

      assertForbiddenApiMutation(response, { actor: deniedActor, permission });
      expect(services.projectWorkflow[service]).not.toHaveBeenCalled();
    },
  );

  it("keeps the API mutation permission matrix aligned with handler gates", () => {
    const sourcePermissionGateIds = sourceApiPermissionGateIds();
    const sourceMutationRoutes = sourceApiMutationRoutes();
    assertNoUndeclaredAppPermissionCalls();

    // SHARED-026 — shape-robust coverage: every mutating projectWorkflow call,
    // regardless of routing shape (route-table / switch / helper-predicate),
    // must be preceded by a requireApiPermission gate. See
    // api-mutation-coverage-guard.test.ts for the negative fixtures.
    const apiHandlersSourceUrl = new URL("../src/api-handlers.ts", import.meta.url);
    expect(
      findUncoveredProjectWorkflowMutations(
        readFileSync(apiHandlersSourceUrl, "utf8"),
        apiHandlersSourceUrl.pathname,
      ),
    ).toEqual([]);

    expect(apiMutationPermissionMatrix.map(({ gateId }) => gateId).sort()).toEqual(
      sourcePermissionGateIds.sort(),
    );
    expect(apiMutationPermissionMatrix.map(({ gateId }) => gateId).sort()).toEqual(
      Object.keys(apiMutationPermissionGates).sort(),
    );
    expect(matrixMutationRoutes()).toEqual(sourceMutationRoutes);
    expect(
      apiMutationPermissionMatrix.map(
        ({ name, route, permission, successFixture, denialFixture }) => ({
          mutation: name,
          route,
          requiredPermission: permission,
          successFixture,
          denialFixture,
        }),
      ),
    ).toMatchInlineSnapshot(`
      [
        {
          "denialFixture": "permission middleware rejects as api-user-without-required-permission",
          "mutation": "bridge import",
          "requiredPermission": "project.import",
          "route": "POST /api/imports/bridge",
          "successFixture": "api-handlers.test.ts bridge import success fixture",
        },
        {
          "denialFixture": "permission middleware rejects as api-user-without-required-permission",
          "mutation": "branch draft",
          "requiredPermission": "draft.write",
          "route": "POST /api/projects/:projectId/branches",
          "successFixture": "api-handlers.test.ts branch draft success fixture",
        },
        {
          "denialFixture": "permission middleware rejects as api-user-without-required-permission",
          "mutation": "finding record",
          "requiredPermission": "runtime.ingest",
          "route": "POST /api/projects/:projectId/findings",
          "successFixture": "api-handlers.test.ts finding record success fixture",
        },
        {
          "denialFixture": "permission middleware rejects as api-user-without-required-permission",
          "mutation": "decision record",
          "requiredPermission": "runtime.ingest",
          "route": "POST /api/projects/:projectId/decisions",
          "successFixture": "api-handlers.test.ts decision record success fixture",
        },
        {
          "denialFixture": "permission middleware rejects as api-user-without-required-permission",
          "mutation": "benchmark record",
          "requiredPermission": "runtime.ingest",
          "route": "POST /api/projects/:projectId/benchmarks",
          "successFixture": "api-handlers.test.ts benchmark record success fixture",
        },
        {
          "denialFixture": "permission middleware rejects as api-user-without-required-permission",
          "mutation": "runtime evidence ingest",
          "requiredPermission": "runtime.ingest",
          "route": "POST /api/projects/:projectId/runtime-evidence",
          "successFixture": "api-handlers.test.ts runtime evidence ingest success fixture",
        },
      ]
    `);
  });

  it("allows failed runtime evidence ingest results with validation findings", async () => {
    const services = serviceFixture();
    services.projectWorkflow.ingestRuntimeReport.mockResolvedValueOnce({
      project: projectFixture,
      result: {
        ...runtimeIngestResultFixture,
        status: "hello_world_failed",
      },
    });

    const response = await handleItotoriApiRequest(
      post("/api/projects/project-1/runtime-evidence", {
        project: projectFixture,
        runtimeReport: { ...runtimeReportFixture, status: "failed" },
      }),
      services,
    );

    expect(response).toMatchObject({
      statusCode: 200,
      body: { status: "hello_world_failed", runtimeReportId: "runtime-1" },
    });
  });

  it.skipIf(!process.env.DATABASE_URL)(
    "keeps runtime patch result artifacts independent through the API workflow",
    async () => {
      const context = await isolatedMigratedContext();
      try {
        const actor = { userId: localUserId };
        const repository = new ItotoriProjectRepository(context.db);
        const workflow = new ItotoriProjectWorkflowService(repository, actor);
        const project = await workflow.importBridge(bridgeFixture);
        const services: ItotoriApiServices = {
          authorization: {
            requirePermission: vi.fn<[Permission], Promise<void>>(async () => {}),
          },
          projectWorkflow: workflow,
        };

        const firstReport = {
          ...runtimeReportFixture,
          runtimeReportId: "runtime-api-1",
        };
        const secondReport = {
          ...runtimeReportFixture,
          runtimeReportId: "runtime-api-2",
        };

        const firstResponse = await handleItotoriApiRequest(
          post(`/api/projects/${project.projectId}/runtime-evidence`, {
            project,
            runtimeReport: firstReport,
          }),
          services,
        );
        const secondResponse = await handleItotoriApiRequest(
          post(`/api/projects/${project.projectId}/runtime-evidence`, {
            project,
            runtimeReport: secondReport,
          }),
          services,
        );

        expect(firstResponse).toMatchObject({
          statusCode: 200,
          body: {
            patchResultId: "runtime-api-1:patch-result",
            runtimeReportId: "runtime-api-1",
          },
        });
        expect(secondResponse).toMatchObject({
          statusCode: 200,
          body: {
            patchResultId: "runtime-api-2:patch-result",
            runtimeReportId: "runtime-api-2",
          },
        });

        const patchResults = await context.pool.query<{
          artifact_id: string;
          runtime_report_id: string;
          final_status: string;
        }>(
          `
          select
            artifact_id,
            metadata->>'runtimeReportId' as runtime_report_id,
            metadata->>'finalStatus' as final_status
          from itotori_artifacts
          where artifact_kind = 'patch_result'
          order by artifact_id
        `,
        );
        expect(patchResults.rows).toEqual([
          {
            artifact_id: "runtime-api-1:patch-result",
            runtime_report_id: "runtime-api-1",
            final_status: "hello_world_passed",
          },
          {
            artifact_id: "runtime-api-2:patch-result",
            runtime_report_id: "runtime-api-2",
            final_status: "hello_world_passed",
          },
        ]);

        const runs = await context.pool.query<{
          runtime_run_id: string;
          patch_result_artifact_id: string;
        }>(
          `
          select runtime_run_id, patch_result_artifact_id
          from itotori_runtime_evidence_runs
          order by runtime_run_id
        `,
        );
        expect(runs.rows).toEqual([
          {
            runtime_run_id: "runtime-api-1",
            patch_result_artifact_id: "runtime-api-1:patch-result",
          },
          {
            runtime_run_id: "runtime-api-2",
            patch_result_artifact_id: "runtime-api-2:patch-result",
          },
        ]);

        const evidenceRows = await context.pool.query<{
          runtime_run_id: string;
          runtime_evidence_id: string;
          evidence_kind: string;
          artifact_id: string | null;
          adapter_local_evidence_id: string | null;
        }>(
          `
          select
            runtime_run_id,
            runtime_evidence_id,
            evidence_kind,
            artifact_id,
            metadata->>'adapterLocalEvidenceId' as adapter_local_evidence_id
          from itotori_runtime_evidence_items
          order by runtime_run_id, evidence_kind
        `,
        );
        expect(evidenceRows.rows).toEqual([
          {
            runtime_run_id: "runtime-api-1",
            runtime_evidence_id: "runtime-api-1:frame-1",
            evidence_kind: "capture",
            artifact_id: "runtime-api-1:frame-1",
            adapter_local_evidence_id: "frame-1",
          },
          {
            runtime_run_id: "runtime-api-1",
            runtime_evidence_id: "runtime-api-1:runtime-text-1",
            evidence_kind: "trace_event",
            artifact_id: null,
            adapter_local_evidence_id: "runtime-text-1",
          },
          {
            runtime_run_id: "runtime-api-2",
            runtime_evidence_id: "runtime-api-2:frame-1",
            evidence_kind: "capture",
            artifact_id: "runtime-api-2:frame-1",
            adapter_local_evidence_id: "frame-1",
          },
          {
            runtime_run_id: "runtime-api-2",
            runtime_evidence_id: "runtime-api-2:runtime-text-1",
            evidence_kind: "trace_event",
            artifact_id: null,
            adapter_local_evidence_id: "runtime-text-1",
          },
        ]);

        const frameArtifacts = await context.pool.query<{
          artifact_id: string;
          runtime_report_id: string | null;
          adapter_local_artifact_id: string | null;
        }>(
          `
          select
            artifact_id,
            metadata->>'runtimeReportId' as runtime_report_id,
            metadata->>'adapterLocalArtifactId' as adapter_local_artifact_id
          from itotori_artifacts
          where artifact_kind = 'frame_capture'
          order by artifact_id
        `,
        );
        expect(frameArtifacts.rows).toEqual([
          {
            artifact_id: "runtime-api-1:frame-1",
            runtime_report_id: "runtime-api-1",
            adapter_local_artifact_id: "frame-1",
          },
          {
            artifact_id: "runtime-api-2:frame-1",
            runtime_report_id: "runtime-api-2",
            adapter_local_artifact_id: "frame-1",
          },
        ]);
      } finally {
        await context.close();
      }
    },
  );

  it("identifies API paths without claiming static assets", () => {
    expect(isItotoriApiPath("/api/projects/status")).toBe(true);
    expect(isItotoriApiPath("/api/projects/project-1/findings")).toBe(true);
    expect(isItotoriApiPath("/assets/main.js")).toBe(false);
  });
});

function post(pathname: string, body: unknown): ItotoriApiRequest {
  return { method: "POST", pathname, body };
}

function localeBranchIdentityFixture(
  projectId: string,
  localeBranchId: string,
): LocaleBranchIdentity {
  return {
    localeBranchId,
    projectId,
    sourceBundleId: `${projectId}:source-bundle`,
    sourceBundleRevisionId: `${projectId}:source-bundle:rev-1`,
    sourceLocale: "ja-JP",
    targetLocale: "en-US",
    branchName: localeBranchId,
    status: "active",
  };
}

/**
 * ITOTORI-050 — the SERVER-SIDE ownership set the scoping policy reads. Only
 * the branches the fixtures legitimately own are returned; any other
 * project/branch id resolves to an empty set (unknown project) and is refused.
 */
function ownedLocaleBranchIdentitiesFixture(projectId: string): LocaleBranchIdentity[] {
  const ownedBranchIdsByProject: Record<string, string[]> = {
    "project-1": ["locale-1", "019ed006-0000-7000-8000-0000000000b1"],
    "project-de-en": ["locale-de-en-us"],
  };
  const branchIds = ownedBranchIdsByProject[projectId] ?? [];
  return branchIds.map((localeBranchId) => localeBranchIdentityFixture(projectId, localeBranchId));
}

function apiGate(
  gateId: ApiMutationPermissionGateId,
  request: ItotoriApiRequest,
  service: MutatingProjectWorkflowService,
): ApiMutationPermissionCase {
  const gate = apiMutationPermissionGates[gateId];
  return {
    gateId,
    name: gate.mutation,
    request,
    route: apiMutationRouteId(request),
    permissionKey: gate.permissionKey,
    permission: gate.permission,
    service,
    successFixture: `api-handlers.test.ts ${gate.mutation} success fixture`,
    denialFixture: `permission middleware rejects as ${deniedActor.userId}`,
  };
}

function matrixMutationRoutes(): ApiMutationRoute[] {
  return apiMutationPermissionMatrix
    .map(({ route, service }) => ({ route, service }))
    .sort(compareApiMutationRoutes);
}

function apiMutationRouteId(request: ItotoriApiRequest): string {
  if (request.method !== "POST") {
    throw new Error(
      `API mutation matrix entry must use POST: ${request.method} ${request.pathname}`,
    );
  }
  const projectRoute = /^\/api\/projects\/[^/]+\/([^/]+)$/u.exec(request.pathname);
  if (projectRoute?.[1]) {
    return `POST /api/projects/:projectId/${projectRoute[1]}`;
  }
  return `POST ${request.pathname}`;
}

function sourceApiPermissionGateIds(): ApiMutationPermissionGateId[] {
  const sourceUrl = new URL("../src/api-handlers.ts", import.meta.url);
  const source = readFileSync(sourceUrl, "utf8");
  const sourceFile = ts.createSourceFile(sourceUrl.pathname, source, ts.ScriptTarget.Latest, true);
  const gateIds: ApiMutationPermissionGateId[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callName = callExpressionName(node.expression);
      if (callName === "requireApiPermission") {
        gateIds.push(apiGateIdFromCall(node));
      }
      if (
        callName === "requirePermission" &&
        !isInsideFunction(node, "requireApiPermission") &&
        !isInsideFunction(node, "tryApiPermission")
      ) {
        throw new Error(
          `undeclared API permission call at ${sourceLocation(sourceFile, node)}; route permission gates must use apiMutationPermissionGates and requireApiPermission`,
        );
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return gateIds;
}

function sourceApiMutationRoutes(): ApiMutationRoute[] {
  const sourceUrl = new URL("../src/api-handlers.ts", import.meta.url);
  const source = readFileSync(sourceUrl, "utf8");
  const sourceFile = ts.createSourceFile(sourceUrl.pathname, source, ts.ScriptTarget.Latest, true);
  const routeFunction = sourceFile.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === "routeItotoriApiRequest",
  );
  if (!routeFunction?.body) {
    throw new Error("routeItotoriApiRequest must exist for API mutation route coverage");
  }

  const routes: ApiMutationRoute[] = [];
  for (const statement of routeFunction.body.statements) {
    if (ts.isIfStatement(statement)) {
      const pathname = postRoutePathname(statement.expression);
      if (pathname !== undefined) {
        routes.push(
          ...mutationRoutesForNode(sourceFile, `POST ${pathname}`, statement.thenStatement),
        );
      }
      continue;
    }
    if (
      ts.isSwitchStatement(statement) &&
      statement.expression.getText(sourceFile) === "projectRoute.resource"
    ) {
      for (const clause of statement.caseBlock.clauses) {
        if (!ts.isCaseClause(clause) || !ts.isStringLiteral(clause.expression)) {
          continue;
        }
        routes.push(
          ...mutationRoutesForNode(
            sourceFile,
            `POST /api/projects/:projectId/${clause.expression.text}`,
            clause,
          ),
        );
      }
    }
  }

  return routes.sort(compareApiMutationRoutes);
}

function postRoutePathname(expression: ts.Expression): string | undefined {
  if (ts.isParenthesizedExpression(expression)) {
    return postRoutePathname(expression.expression);
  }
  if (
    !ts.isBinaryExpression(expression) ||
    expression.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    return undefined;
  }
  const left = equalityText(expression.left);
  const right = equalityText(expression.right);
  if (left?.property === "method" && left.value === "POST" && right?.property === "pathname") {
    return right.value;
  }
  if (right?.property === "method" && right.value === "POST" && left?.property === "pathname") {
    return left.value;
  }
  return undefined;
}

function equalityText(
  expression: ts.Expression,
): { property: "method" | "pathname"; value: string } | undefined {
  if (
    !ts.isBinaryExpression(expression) ||
    expression.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
  ) {
    return undefined;
  }
  const left = requestPropertyName(expression.left);
  const right = requestPropertyName(expression.right);
  if (left !== undefined && ts.isStringLiteral(expression.right)) {
    return { property: left, value: expression.right.text };
  }
  if (right !== undefined && ts.isStringLiteral(expression.left)) {
    return { property: right, value: expression.left.text };
  }
  return undefined;
}

function requestPropertyName(expression: ts.Expression): "method" | "pathname" | undefined {
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "request" &&
    (expression.name.text === "method" || expression.name.text === "pathname")
  ) {
    return expression.name.text;
  }
  return undefined;
}

function mutationRoutesForNode(
  sourceFile: ts.SourceFile,
  route: string,
  node: ts.Node,
): ApiMutationRoute[] {
  const services = mutatingProjectWorkflowCalls(node);
  if (services.length === 0) {
    if (readOnlyPostApiRoutes.has(route)) {
      return [];
    }
    throw new Error(
      `POST API route ${route} has no mutating projectWorkflow call at ${sourceLocation(sourceFile, node)}; add an explicit readonly exception if this route is intentionally non-mutating`,
    );
  }
  return services.map((service) => ({ route, service }));
}

function mutatingProjectWorkflowCalls(node: ts.Node): MutatingProjectWorkflowService[] {
  const services: MutatingProjectWorkflowService[] = [];

  function visit(current: ts.Node): void {
    if (ts.isCallExpression(current)) {
      const service = projectWorkflowServiceName(current.expression);
      if (service !== undefined && !readOnlyProjectWorkflowServices.has(service)) {
        services.push(service as MutatingProjectWorkflowService);
      }
    }
    ts.forEachChild(current, visit);
  }

  visit(node);
  return services;
}

function projectWorkflowServiceName(
  expression: ts.Expression,
): keyof ItotoriApiServices["projectWorkflow"] | undefined {
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "projectWorkflow" &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === "services"
  ) {
    return expression.name.text as keyof ItotoriApiServices["projectWorkflow"];
  }
  return undefined;
}

function compareApiMutationRoutes(left: ApiMutationRoute, right: ApiMutationRoute): number {
  return `${left.route} ${left.service}`.localeCompare(`${right.route} ${right.service}`);
}

function apiGateIdFromCall(node: ts.CallExpression): ApiMutationPermissionGateId {
  const gate = node.arguments[1];
  if (
    gate === undefined ||
    !ts.isPropertyAccessExpression(gate) ||
    gate.expression.getText() !== "apiMutationPermissionGates"
  ) {
    throw new Error(
      `API permission call at ${sourceLocation(node.getSourceFile(), node)} must pass apiMutationPermissionGates.<gateId>`,
    );
  }
  return gate.name.text as ApiMutationPermissionGateId;
}

function assertNoUndeclaredAppPermissionCalls(): void {
  const sourceDir = new URL("../src/", import.meta.url);
  for (const sourceUrl of appSourceFiles(sourceDir)) {
    if (
      sourceUrl.pathname.endsWith("/auth.ts") ||
      sourceUrl.pathname.endsWith("/api-handlers.ts")
    ) {
      continue;
    }
    const source = readFileSync(sourceUrl, "utf8");
    const sourceFile = ts.createSourceFile(
      sourceUrl.pathname,
      source,
      ts.ScriptTarget.Latest,
      true,
    );

    function visit(node: ts.Node): void {
      if (
        ts.isCallExpression(node) &&
        callExpressionName(node.expression) === "requirePermission"
      ) {
        throw new Error(
          `undeclared app permission call at ${sourceLocation(sourceFile, node)}; app mutation gates must be represented by apiMutationPermissionGates or a documented follow-up`,
        );
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }
}

function appSourceFiles(directory: URL): URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryUrl = new URL(entry.name, directory);
    if (entry.isDirectory()) {
      return appSourceFiles(new URL(`${entry.name}/`, directory));
    }
    return entry.name.endsWith(".ts") ? [entryUrl] : [];
  });
}

function callExpressionName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  return undefined;
}

function isInsideFunction(node: ts.Node, functionName: string): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (
      ts.isFunctionDeclaration(current) &&
      current.name !== undefined &&
      current.name.text === functionName
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function sourceLocation(sourceFile: ts.SourceFile, node: ts.Node): string {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${sourceFile.fileName}:${position.line + 1}:${position.character + 1}`;
}

function serviceFixture(): ItotoriApiServices {
  return {
    authorization: {
      requirePermission: vi.fn<[Permission], Promise<void>>(async () => {}),
    },
    projectWorkflow: {
      listLocaleBranchIdentities: vi.fn(async (projectId: string) =>
        ownedLocaleBranchIdentitiesFixture(projectId),
      ),
      getDashboardStatus: vi.fn(async () => dashboardStatusFixture),
      getProjectOverview: vi.fn(async () => projectOverviewFixture),
      getRuntimeStatus: vi.fn(async () => runtimeStatusFixture),
      getDashboardDecisions: vi.fn(async () => dashboardDecisionsFixture),
      getCostReport: vi.fn(async () => costReportFixture),
      getCostDrilldown: vi.fn(async () => costDrilldownFixture),
      getBenchmarkReports: vi.fn(async () => benchmarkReportsFixture),
      importBridge: vi.fn(async () => projectFixture),
      draftProject: vi.fn(async () => projectFixture),
      recordFinding: vi.fn(async () => ({
        findingId: findingRecordFixture.findingId,
        status: "open" as const,
      })),
      recordDecision: vi.fn(async () => ({
        decisionId: decisionEventFixture.eventId,
        eventKind: decisionEventFixture.eventKind,
        recorded: true,
      })),
      recordBenchmarkReport: vi.fn(async () => ({
        benchmarkRunId: benchmarkReportFixture.benchmarkRunId,
        artifactId: benchmarkReportFixture.benchmarkRunId,
        status: benchmarkReportFixture.status,
        systemCount: benchmarkReportFixture.systemsCompared.length,
        findingCount: benchmarkReportFixture.findingRecords.length,
      })),
      ingestRuntimeReport: vi.fn(async () => ({
        project: projectFixture,
        result: runtimeIngestResultFixture,
      })),
    },
    catalogRepository: {
      catalogConflictReview: vi.fn(async () => catalogConflictReviewFixture),
      catalogCompletenessBenchmarkPools: vi.fn(async () => catalogCompletenessFixture),
      catalogBenchmarkSeedFinder: vi.fn(async () => catalogBenchmarkSeedsFixture),
      catalogOpportunityRanking: vi.fn(async () => catalogOpportunitiesFixture),
    },
    terminologyRepository: {
      searchTerms: vi.fn(async () => terminologySearchFixture),
    },
    reviewerQueue: {
      loadDashboard: vi.fn(async ({ localeBranchId, permission }) => ({
        ...reviewerQueueDashboardApiFixture(),
        localeBranchId,
        permission,
      })),
      loadDetailContext: vi.fn(async ({ reviewItemId, permission }) => ({
        ...readyContextFixture(),
        reviewItemId,
        permission,
      })),
      previewBatch: vi.fn(async ({ request, permission }) => ({
        request,
        permission,
        items: [],
        aggregate: {
          total: 0,
          allowed: 0,
          denied: 0,
          stale: 0,
          notFound: 0,
          duplicate: 0,
          runtimeEvidenceInvariant: 0,
          invalidInput: 0,
          invalidTransition: 0,
          concurrentModification: 0,
          permissionDeniedRead: 0,
          permissionDeniedManage: 0,
        },
        allAllowed: false,
        permissionDenied: !permission.canReadQueue,
      })),
      executeBatch: vi.fn(async ({ request, permission }) =>
        makeApiBatchExecuteResult(request, permission),
      ),
      actionSingleItem: vi.fn(async ({ request, permission }) =>
        makeApiSingleActionResult(request, permission),
      ),
    },
    assetDecisions: {
      loadActiveDecisions: vi.fn(async () => [assetDecisionApiFixture]),
      loadCandidateAssets: vi.fn(async () => [candidateAssetApiFixture]),
    },
    workspace: {
      loadProjectBrowse: vi.fn(async ({ permission }) => ({
        ...workspaceProjectBrowseFixture(),
        permission,
      })),
      loadSceneBrowse: vi.fn(async ({ projectId, localeBranchId, permission }) => ({
        ...workspaceSceneBrowseFixture(),
        projectId,
        localeBranchId,
        permission,
      })),
      loadAssetBrowse: vi.fn(async ({ projectId, localeBranchId, permission }) => ({
        ...workspaceAssetBrowseFixture(),
        projectId,
        localeBranchId,
        permission,
      })),
      loadComparison: vi.fn(async ({ reviewItemId, permission }) =>
        permission.canReadQueue
          ? { ...workspaceComparisonFixture(), reviewItemId, permission }
          : workspaceDeniedComparisonFixture(reviewItemId),
      ),
      loadSearch: vi.fn(async ({ projectId, localeBranchId, query, mode, permission }) => ({
        ...workspaceSearchFixture(),
        projectId,
        localeBranchId,
        query,
        mode: mode ?? "all",
        permission,
      })),
    },
    workspaceCorrections: {
      loadPreview: vi.fn(async ({ localeBranchId, permission }) => ({
        schemaVersion: "workspace.correction_preview.v0.1" as const,
        generatedAt: new Date("2026-06-30T00:00:00Z"),
        permission,
        localeBranchId,
        units: [],
        diagnostics: [],
      })),
      submitCorrections: vi.fn(async ({ localeBranchId, permission }) => ({
        schemaVersion: "workspace.correction_submit.v0.1" as const,
        generatedAt: new Date("2026-06-30T00:00:00Z"),
        permission,
        localeBranchId,
        batchId: "workspace-correction-batch-test",
        batchLabel: null,
        submittedCount: permission.canManageQueue ? 1 : 0,
        edits: [],
        repairCandidateReportIds: [],
        decisionQueueReportIds: [],
        needsContextReportIds: [],
        affectedBridgeUnitIds: [],
        writebacks: [],
        scheduledRerunJobIds: [],
        diagnostics: permission.canManageQueue
          ? []
          : [
              {
                code: "workspace_correction_mutation_permission_denied" as const,
                message: "Workspace correction blocked: queue.manage missing",
              },
            ],
      })),
    },
  };
}

function makeApiBatchExecuteResult(
  request: Parameters<ItotoriApiServices["reviewerQueue"]["executeBatch"]>[0]["request"],
  permission: Parameters<ItotoriApiServices["reviewerQueue"]["executeBatch"]>[0]["permission"],
): ReviewerBatchExecuteResult {
  const preview = {
    ...fixtureAllAllowedPreview(),
    request,
    permission,
    allAllowed: permission.canManageQueue,
    permissionDenied: !permission.canReadQueue,
  };
  if (!permission.canManageQueue) {
    const denialReason =
      permission.denialReasons.find((reason) => reason.includes(permissionValues.queueManage)) ??
      `user ${permission.actorUserId} is missing permission queue.manage`;
    return {
      request,
      preview,
      applied: request.selections.map((selection) => ({
        kind: "refused" as const,
        reviewItemId: selection.reviewItemId,
        status: reviewerBatchPreviewStatusValues.permissionDeniedManage,
        code: "reviewer_batch_skipped" as const,
        message: denialReason,
        diagnostics: [
          {
            code: "reviewer_batch_permission_denied_manage",
            message: denialReason,
          },
        ],
      })),
      refusedAll: true,
      appliedAll: false,
    };
  }
  const item = fixtureAllAllowedPreview().items[0]?.item;
  if (item === null || item === undefined) {
    throw new Error("fixtureAllAllowedPreview must include an item");
  }
  return {
    request,
    preview,
    applied: request.selections.map((selection) => ({
      kind: "applied" as const,
      reviewItemId: selection.reviewItemId,
      result: {
        item: { ...item, reviewItemId: selection.reviewItemId },
        transition: {
          transitionId: `transition-${selection.reviewItemId}`,
          reviewItemId: selection.reviewItemId,
          localeBranchId: item.localeBranchId,
          sourceRevisionId: selection.expectedSourceRevisionId,
          itemKind: item.itemKind,
          action: request.action,
          priorState: item.state,
          nextState: "accepted",
          actorUserId: request.actorUserId,
          affectedArtifactIds: [],
          diagnostics: [],
          metadata: { batchActionId: "batch-action-api-test" },
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      },
    })),
    refusedAll: false,
    appliedAll: true,
  };
}

function makeApiSingleActionResult(
  request: ReviewerSingleActionRequest,
  permission: Parameters<ItotoriApiServices["reviewerQueue"]["executeBatch"]>[0]["permission"],
): ReviewerSingleActionResult {
  // Reuse the batch-of-one path so the mock mirrors what the real
  // ReviewerQueueApiService.actionSingleItem returns.
  const batch = makeApiBatchExecuteResult(
    {
      action: request.action,
      actorUserId: request.actorUserId,
      selections: [
        {
          reviewItemId: request.reviewItemId,
          expectedSourceRevisionId: request.expectedSourceRevisionId,
        },
      ],
    },
    permission,
  );
  const outcome = batch.applied[0];
  const templatePreview = fixtureAllAllowedPreview().items[0];
  if (outcome === undefined || templatePreview === undefined) {
    throw new Error("single action mock requires an outcome + preview template");
  }
  const preview: BatchPreviewItem = {
    ...templatePreview,
    reviewItemId: request.reviewItemId,
    expectedSourceRevisionId: request.expectedSourceRevisionId,
    action: request.action,
  };
  return {
    request,
    preview,
    outcome,
    applied: outcome.kind === "applied",
    refused: outcome.kind === "refused",
  };
}

function refusedSingleActionResult(
  reviewItemId: string,
  action: ReviewerSingleActionRequest["action"],
  status: (typeof reviewerBatchPreviewStatusValues)[keyof typeof reviewerBatchPreviewStatusValues],
  message: string,
): ReviewerSingleActionResult {
  const templatePreview = fixtureAllAllowedPreview().items[0];
  if (templatePreview === undefined) {
    throw new Error("single action refusal mock requires a preview template");
  }
  const preview: BatchPreviewItem = {
    ...templatePreview,
    reviewItemId,
    action,
    status,
    item: null,
    nextState: null,
    consequences: [],
    diagnostics: [{ code: "reviewer_single_action_refused", message }],
    message,
  };
  return {
    request: {
      reviewItemId,
      action: "approve",
      actorUserId: "reviewer-user",
      expectedSourceRevisionId: "source-revision-1",
    },
    preview,
    outcome: {
      kind: "refused",
      reviewItemId,
      status,
      code: "reviewer_queue_item_invalid_transition",
      message,
      diagnostics: [{ code: "reviewer_single_action_refused", message }],
    },
    applied: false,
    refused: true,
  };
}

function reviewerQueueDashboardApiFixture(): ReviewerQueueDashboardReadModel {
  const fixtures = reviewQueueDashboardFixtures();
  const rows = fixtures.decisions.map((decision) => ({
    reviewItemId: decision.item.reviewItemId,
    projectId: decision.item.projectId,
    localeBranchId: decision.item.localeBranchId,
    sourceRevisionId: decision.item.sourceRevisionId,
    itemKind: decision.item.itemKind,
    sourceItemRef: decision.item.sourceItemRef,
    summary: decision.item.summary,
    priority: decision.item.priority,
    state: decision.item.state,
    dashboardState: decision.dashboardState,
    lastAction: decision.lastAction,
    batchActionId: decision.batchActionId,
    findingId: decision.findingId,
    decisionId: decision.decisionId,
    detailPath: `/reviewer-queue/${encodeURIComponent(decision.item.reviewItemId)}`,
    selectedForBatch: decision.dashboardState === "pending",
    createdAt: decision.item.createdAt,
    updatedAt: decision.item.updatedAt,
    resolvedAt: decision.item.resolvedAt,
  }));
  return {
    schemaVersion: "reviewer.queue_dashboard.v0.1",
    localeBranchId: "locale-1",
    generatedAt: new Date("2026-06-26T00:00:00Z"),
    permission: {
      actorUserId: "reviewer-user",
      canReadQueue: true,
      canManageQueue: true,
      denialReasons: [],
    },
    rows,
    aggregate: {
      pending: rows.filter((row) => row.dashboardState === "pending").length,
      resolved: rows.filter((row) => row.dashboardState === "resolved").length,
      deferred: rows.filter((row) => row.dashboardState === "deferred").length,
      escalated: rows.filter((row) => row.dashboardState === "escalated").length,
      batch_applied: rows.filter((row) => row.dashboardState === "batch_applied").length,
    },
    defaultBatchRequest: {
      action: reviewerQueueActionValues.approve,
      actorUserId: "reviewer-user",
      selections: rows
        .filter((row) => row.selectedForBatch)
        .map((row) => ({
          reviewItemId: row.reviewItemId,
          expectedSourceRevisionId: row.sourceRevisionId,
        })),
    },
  };
}

describe("Itotori API handlers — localization workspace (ITOTORI-040)", () => {
  it("serves the project browse, scene, asset, comparison, and search read-models through the API", async () => {
    const services = serviceFixture();
    const projects = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/workspace/projects" },
      services,
    );
    const scenes = await handleItotoriApiRequest(
      {
        method: "GET",
        pathname: "/api/workspace/scenes",
        search: "?projectId=project-itotori-040&localeBranchId=locale-branch-itotori-040",
      },
      services,
    );
    const assets = await handleItotoriApiRequest(
      {
        method: "GET",
        pathname: "/api/workspace/assets",
        search: "?projectId=project-itotori-040&localeBranchId=locale-branch-itotori-040",
      },
      services,
    );
    const comparison = await handleItotoriApiRequest(
      {
        method: "GET",
        pathname: "/api/workspace/comparison",
        search: "?reviewItemId=reviewer-queue-itotori-040",
      },
      services,
    );
    const search = await handleItotoriApiRequest(
      {
        method: "GET",
        pathname: "/api/workspace/search",
        search:
          "?projectId=project-itotori-040&localeBranchId=locale-branch-itotori-040&query=世界&mode=all",
      },
      services,
    );
    expect(projects.statusCode).toBe(200);
    expect(scenes.statusCode).toBe(200);
    expect(assets.statusCode).toBe(200);
    expect(comparison.statusCode).toBe(200);
    expect(search.statusCode).toBe(200);
    // The handler validated each body via assertItotoriApiResponse before
    // returning it, so reaching 200 IS the read-through-API proof.
    expect((scenes.body as { localeBranchId: string }).localeBranchId).toBe(
      "locale-branch-itotori-040",
    );
    expect(services.workspace.loadComparison).toHaveBeenCalledWith(
      expect.objectContaining({ reviewItemId: "reviewer-queue-itotori-040" }),
    );
  });

  it("rejects unknown query params and missing branch scope", async () => {
    const services = serviceFixture();
    const missingScope = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/workspace/scenes" },
      services,
    );
    const unknownParam = await handleItotoriApiRequest(
      {
        method: "GET",
        pathname: "/api/workspace/search",
        search: "?projectId=p1&localeBranchId=b1&query=x&bogus=1",
      },
      services,
    );
    expect(missingScope.statusCode).toBe(400);
    expect(unknownParam.statusCode).toBe(400);
  });

  it("405s a non-GET workspace request", async () => {
    const services = serviceFixture();
    const response = await handleItotoriApiRequest(
      { method: "POST", pathname: "/api/workspace/projects", body: {} },
      services,
    );
    expect(response.statusCode).toBe(405);
  });

  it("returns a denied comparison read-model when queue.read is missing", async () => {
    const services = serviceFixture();
    (services.authorization.requirePermission as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        throw new AuthorizationError({ userId: "unauthorized-user" }, permissionValues.queueRead);
      },
    );
    const response = await handleItotoriApiRequest(
      {
        method: "GET",
        pathname: "/api/workspace/comparison",
        search: "?reviewItemId=reviewer-queue-itotori-040&actorUserId=unauthorized-user",
      },
      services,
    );
    expect(response.statusCode).toBe(200);
    expect((response.body as { cells: unknown[] }).cells).toHaveLength(0);
    expect(
      (response.body as { permission: { canReadQueue: boolean } }).permission.canReadQueue,
    ).toBe(false);
  });
});

describe("Itotori API handlers — workspace manual corrections (ITOTORI-118)", () => {
  const submitBody = {
    projectId: "project-1",
    localeBranchId: "branch-1",
    sourceBundleId: "bundle-1",
    targetLocale: "en-US",
    actorUserId: "reviewer-1",
    corrections: [
      {
        bridgeUnitId: "unit-a",
        sourceRevisionId: "rev-1",
        reason: "Typo fix",
        correctedText: "The hero.",
      },
    ],
  };

  it("GET preview reads through the API gated on queue.read", async () => {
    const services = serviceFixture();
    const response = await handleItotoriApiRequest(
      {
        method: "GET",
        pathname: "/api/workspace/corrections",
        search: "?localeBranchId=branch-1&reviewItemIds=item-1,item-2",
      },
      services,
    );
    expect(response.statusCode).toBe(200);
    expect((response.body as { schemaVersion: string }).schemaVersion).toBe(
      "workspace.correction_preview.v0.1",
    );
    expect(services.workspaceCorrections.loadPreview).toHaveBeenCalledWith(
      expect.objectContaining({ localeBranchId: "branch-1", reviewItemIds: ["item-1", "item-2"] }),
    );
  });

  it("POST submit records corrections through the API when queue.manage is held", async () => {
    const services = serviceFixture();
    const response = await handleItotoriApiRequest(
      { method: "POST", pathname: "/api/workspace/corrections", body: submitBody },
      services,
    );
    expect(response.statusCode).toBe(200);
    expect((response.body as { submittedCount: number }).submittedCount).toBe(1);
    expect(services.workspaceCorrections.submitCorrections).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1", localeBranchId: "branch-1" }),
    );
  });

  it("POST submit is refused (no mutation) when queue.manage is missing", async () => {
    const services = serviceFixture();
    (services.authorization.requirePermission as ReturnType<typeof vi.fn>).mockImplementation(
      async (permission) => {
        if (permission === permissionValues.queueManage) {
          throw new AuthorizationError({ userId: "reviewer-1" }, permissionValues.queueManage);
        }
      },
    );
    const response = await handleItotoriApiRequest(
      { method: "POST", pathname: "/api/workspace/corrections", body: submitBody },
      services,
    );
    expect(response.statusCode).toBe(200);
    expect((response.body as { submittedCount: number }).submittedCount).toBe(0);
    expect(
      (response.body as { diagnostics: Array<{ code: string }> }).diagnostics.map((d) => d.code),
    ).toContain("workspace_correction_mutation_permission_denied");
  });

  it("405s an unsupported method on the corrections route", async () => {
    const services = serviceFixture();
    const response = await handleItotoriApiRequest(
      { method: "DELETE", pathname: "/api/workspace/corrections" },
      services,
    );
    expect(response.statusCode).toBe(405);
  });
});

describe("ITOTORI-043 read-only API service factory (least-privilege query surface)", () => {
  const permissionFixture = {
    actorUserId: "reader-1",
    canReadQueue: true,
    canManageQueue: true,
    denialReasons: [] as string[],
  };

  // Every mutation method that MUST NOT be reachable through the read-only
  // surface, keyed by the shared service that owns it.
  const excludedMutations: Array<{ service: string; methods: string[] }> = [
    {
      service: "projectWorkflow",
      methods: [
        "importBridge",
        "draftProject",
        "recordFinding",
        "recordDecision",
        "recordBenchmarkReport",
        "ingestRuntimeReport",
      ],
    },
    { service: "reviewerQueue", methods: ["previewBatch", "executeBatch", "actionSingleItem"] },
    { service: "workspaceCorrections", methods: ["submitCorrections"] },
  ];

  it("projects the full services onto a surface carrying NO mutation methods at runtime", () => {
    const readOnly = readOnlyApiServices(serviceFixture()) as unknown as Record<
      string,
      Record<string, unknown>
    >;
    for (const { service, methods } of excludedMutations) {
      for (const method of methods) {
        expect(readOnly[service]?.[method], `${service}.${method} must be unreachable`).toBe(
          undefined,
        );
      }
    }
  });

  it("keeps the read (query) methods a handler needs, delegating to the shared services", async () => {
    const full = serviceFixture();
    const readOnly = readOnlyApiServices(full);

    expect(await readOnly.projectWorkflow.getDashboardStatus()).toBe(dashboardStatusFixture);
    expect(full.projectWorkflow.getDashboardStatus).toHaveBeenCalledTimes(1);

    await readOnly.reviewerQueue.loadDetailContext({
      reviewItemId: "review-1",
      permission: permissionFixture,
    });
    expect(full.reviewerQueue.loadDetailContext).toHaveBeenCalledTimes(1);

    await readOnly.workspaceCorrections.loadPreview({
      localeBranchId: "branch-1",
      reviewItemIds: [],
      permission: permissionFixture,
    });
    expect(full.workspaceCorrections.loadPreview).toHaveBeenCalledTimes(1);

    await readOnly.catalogRepository.catalogConflictReview();
    expect(full.catalogRepository.catalogConflictReview).toHaveBeenCalledTimes(1);
  });

  it("serves a representative read handler with only the reduced dependency surface", async () => {
    // The narrowed object literally has no mutation methods, yet a GET read
    // route resolves — proving the read handler needs only the read surface.
    const readOnly = readOnlyApiServices(serviceFixture());
    const response = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/projects/status" },
      readOnly as unknown as ItotoriApiServices,
    );
    expect(response.statusCode).toBe(200);
  });

  it("excludes mutation methods from the read-only surface at the TYPE level", () => {
    const readOnly = readOnlyApiServices(serviceFixture());
    // @ts-expect-error draftProject is a mutation excluded from the read-only surface
    void readOnly.projectWorkflow.draftProject;
    // @ts-expect-error executeBatch is a mutation excluded from the read-only surface
    void readOnly.reviewerQueue.executeBatch;
    // @ts-expect-error submitCorrections is a mutation excluded from the read-only surface
    void readOnly.workspaceCorrections.submitCorrections;
    expect(readOnly.workspace).toBeDefined();
  });

  it.skipIf(!process.env.DATABASE_URL)(
    "the DB-backed read-only factory hands a query callback the narrowed surface over real Postgres",
    async () => {
      await withDatabaseReadOnlyApiServices(
        { databaseUrl: process.env.DATABASE_URL, bootstrapLocalUser: true },
        async (services) => {
          // A representative read works against the real DB-backed services
          // (the server-side ownership lookup every read path relies on).
          const identities =
            await services.projectWorkflow.listLocaleBranchIdentities("itotori-043-absent");
          expect(Array.isArray(identities)).toBe(true);

          // Mutation services are structurally absent from what the factory hands over.
          const surface = services as unknown as Record<string, Record<string, unknown>>;
          for (const { service, methods } of excludedMutations) {
            for (const method of methods) {
              expect(surface[service]?.[method], `${service}.${method} must be unreachable`).toBe(
                undefined,
              );
            }
          }
        },
      );
    },
  );
});
