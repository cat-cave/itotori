import { readdirSync, readFileSync } from "node:fs";
import * as ts from "typescript";
import {
  AuthorizationError,
  ItotoriProjectRepository,
  localUserId,
  permissionValues,
  type Permission,
  type ProjectCostReport,
} from "@itotori/db";
import { describe, expect, it, vi } from "vitest";
import { assertForbiddenApiMutation } from "../../../packages/itotori-db/test/authorization-test-helpers.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import {
  apiMutationPermissionGates,
  handleItotoriApiRequest,
  isItotoriApiPath,
  type ApiMutationPermissionGate,
  type ItotoriApiRequest,
  type ItotoriApiServices,
} from "../src/api-handlers.js";
import { ItotoriProjectWorkflowService } from "../src/services/project-workflow.js";
import {
  benchmarkReportFixture,
  bridgeFixture,
  catalogCompletenessFixture,
  catalogConflictReviewFixture,
  costReportFixture,
  dashboardDecisionsFixture,
  dashboardStatusFixture,
  decisionEventFixture,
  findingRecordFixture,
  projectFixture,
  runtimeIngestResultFixture,
  runtimeReportFixture,
  runtimeStatusFixture,
} from "./api-fixtures.js";

const deniedActor = { userId: "api-user-without-required-permission" };

type ApiMutationPermissionGateId = keyof typeof apiMutationPermissionGates;
type MutatingProjectWorkflowService = Exclude<
  keyof ItotoriApiServices["projectWorkflow"],
  "getDashboardStatus" | "getDashboardDecisions" | "getRuntimeStatus" | "getCostReport"
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
  "getDashboardStatus",
  "getDashboardDecisions",
  "getRuntimeStatus",
  "getCostReport",
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
      localeBranchId: "locale-1",
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
  it("routes project and runtime status reads without permission checks", async () => {
    const services = serviceFixture();

    const projects = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/projects" },
      services,
    );
    const projectStatus = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/projects/status" },
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

    expect(projects).toEqual({ statusCode: 200, body: { projects: [dashboardStatusFixture] } });
    expect(projectStatus).toEqual({ statusCode: 200, body: dashboardStatusFixture });
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
    expect(decisions).toEqual({ statusCode: 200, body: dashboardDecisionsFixture });
    expect(catalogConflicts).toEqual({ statusCode: 200, body: catalogConflictReviewFixture });
    expect(catalogCompleteness).toEqual({ statusCode: 200, body: catalogCompletenessFixture });
    expect(services.projectWorkflow.getDashboardStatus).toHaveBeenCalledTimes(2);
    expect(services.projectWorkflow.getRuntimeStatus).toHaveBeenCalledTimes(2);
    expect(services.projectWorkflow.getRuntimeStatus).toHaveBeenNthCalledWith(1, undefined);
    expect(services.projectWorkflow.getRuntimeStatus).toHaveBeenNthCalledWith(2, undefined);
    expect(services.projectWorkflow.getCostReport).toHaveBeenCalledTimes(1);
    expect(services.projectWorkflow.getDashboardDecisions).toHaveBeenCalledTimes(1);
    expect(services.catalogRepository.catalogConflictReview).toHaveBeenCalledWith({});
    expect(services.catalogRepository.catalogCompletenessBenchmarkPools).toHaveBeenCalledWith({});
    expect(services.authorization.requirePermission).not.toHaveBeenCalled();
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
      if (callName === "requirePermission" && !isInsideFunction(node, "requireApiPermission")) {
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
      getDashboardStatus: vi.fn(async () => dashboardStatusFixture),
      getRuntimeStatus: vi.fn(async () => runtimeStatusFixture),
      getDashboardDecisions: vi.fn(async () => dashboardDecisionsFixture),
      getCostReport: vi.fn(async () => costReportFixture),
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
    },
  };
}
