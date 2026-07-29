import * as contracts from "./api-handler-contracts.js";
import * as deps from "./api-handler-dependencies.js";
import * as responses from "./api-handler-responses.js";
import * as shared from "./api-handler-shared.js";

type DraftBranchMutationServices = Pick<
  contracts.ItotoriApiServices,
  "authorization" | "localizationSubstrate"
> & {
  projectWorkflow: Pick<
    contracts.ItotoriApiServices["projectWorkflow"],
    "getDashboardStatus" | "listLocaleBranchIdentities"
  >;
};

function failedDraftWorkflowResponse(
  report: Awaited<ReturnType<typeof deps.runApiLocalize>>,
): contracts.ApiJsonResponse | null {
  const failures: string[] = [];
  if (report.finalized.length === 0) failures.push("no units finalized");
  if (report.patchId === null) failures.push("no patch produced");
  if (report.buildLqa.some(({ verdict }) => verdict.verdict !== "PASS")) {
    failures.push("Build-LQA did not pass");
  }
  if (failures.length === 0) return null;
  return responses.errorBody(
    422,
    "workflow_failed",
    `draft workflow failed: ${failures.join("; ")}`,
  );
}

export async function routeDraftBranchMutation(
  request: contracts.ItotoriApiRequest,
  projectId: string,
  services: DraftBranchMutationServices,
): Promise<contracts.ApiJsonResponse> {
  const body = deps.parseDraftBranchRequest(request.body);
  responses.assertPathProject(projectId, body.project.projectId);
  await shared.requireApiPermission(services, contracts.apiMutationPermissionGates.branchDraft);
  // policy — derive the branch scope from the SERVER-SIDE ownership
  // lookup; a client-supplied ProjectState carrying a foreign/forged
  // localeBranchId is refused here before the new pipeline runs.
  const scope = await deps.requireOwnedBranchScope(services.projectWorkflow, {
    projectId,
    localeBranchId: body.project.localeBranchId,
  });
  const scopedProject = { ...body.project, localeBranchId: scope.localeBranchId };
  // New-pipeline path: draft routes ONLY through composition `runLocalization`.
  // The old `projectWorkflow.draftProject` path is unreachable from this route.
  // The live substrate (WorkflowPortDeps assemblers over decode facts + bible)
  // is installed by the production DB service. A missing one is still a loud
  // configuration failure; this route never falls back to the old service.
  const substrate = deps.configuredServicePort(services, "localizationSubstrate");
  if (substrate === undefined) {
    return responses.ok("branches.draft", {
      outcome: "refused",
      project: null,
      status: null,
      refusalMessage:
        "draft is not configured in this API build (localizationSubstrate port missing — the new-pipeline WorkflowPortDeps assemblers are not installed)",
    });
  }
  const localizeFields = responses.parseNewPipelineDraftFields(request.body);
  if (localizeFields === null) {
    return responses.ok("branches.draft", {
      outcome: "refused",
      project: null,
      status: null,
      refusalMessage:
        "draft refused: new-pipeline localize requires runMode + structure + bridge on the request body (localizationSubstrate is installed)",
    });
  }
  const report = await deps.runApiLocalize(
    {
      runMode: localizeFields.runMode,
      structureJson: localizeFields.structure,
      bridge: localizeFields.bridge,
      ...(localizeFields.contextScope === undefined
        ? {}
        : { contextScope: localizeFields.contextScope }),
      ...(localizeFields.outputScope === undefined
        ? {}
        : { outputScope: localizeFields.outputScope }),
    },
    {
      resolvePortSource: (request, perRun) => substrate.resolvePortSource(request, perRun),
    },
  );
  const failureResponse = failedDraftWorkflowResponse(report);
  if (failureResponse !== null) return failureResponse;
  const status = await services.projectWorkflow.getDashboardStatus();
  // gate-mutation-route-status-echo — see POST /api/imports/bridge: the
  // success body echoes the full dashboard status, so the same
  // catalog.read gate + redaction applies (recentRuns / recentEvents
  // stripped for a non-holder).
  const canReadStatus = await shared.resolveProjectReadPermission(services);
  // The new pipeline stores drafts in the CAS, not ProjectState.drafts. Echo
  // the scoped project identity + target locale so the Studio envelope stays
  // typed; the run report's shippable posture is the proof the driver ran.
  const project = {
    ...scopedProject,
    targetLocale: body.targetLocale,
  };
  return responses.ok("branches.draft", {
    outcome: "drafted",
    project,
    status: canReadStatus ? status : shared.redactProjectDashboardStatus(status),
    refusalMessage: null,
  });
}

export async function routeProjectMutations(
  request: contracts.ItotoriApiRequest,
  services: contracts.ItotoriApiServices,
): Promise<contracts.ApiJsonResponse> {
  const projectRoute = responses.parseProjectRoute(request.pathname);
  if (!projectRoute) {
    return responses.notFound(request.pathname);
  }

  if (request.method !== "POST") {
    return responses.methodNotAllowed(["POST"]);
  }

  switch (projectRoute.resource) {
    case "branches":
      return await routeDraftBranchMutation(request, projectRoute.projectId, services);
    case "findings": {
      const body = deps.parseRecordFindingRequest(request.body);
      await shared.requireApiPermission(
        services,
        contracts.apiMutationPermissionGates.findingRecord,
      );
      // policy — verify the project (and, when supplied, the branch)
      // server-side before recording; a foreign/forged branch id is refused.
      const scope = await deps.resolveProjectMutationScope(services.projectWorkflow, {
        projectId: projectRoute.projectId,
        ...(body.localeBranchId === undefined ? {} : { clientLocaleBranchId: body.localeBranchId }),
      });
      const scopedBody = responses.scopeRecordBranch(body, scope.localeBranchId);
      const result = await services.projectWorkflow.recordFinding(scope.projectId, scopedBody);
      return responses.ok("findings.record", result);
    }
    case "benchmarks": {
      const body = deps.parseRecordBenchmarkRequest(request.body);
      await shared.requireApiPermission(
        services,
        contracts.apiMutationPermissionGates.benchmarkRecord,
      );
      // policy — the benchmark self-identifies its branch (the parser
      // already rejects a report without one); verify that branch is
      // server-side owned by the project before recording.
      const benchmarkLocaleBranchId = body.benchmarkReport.localeBranchId;
      if (benchmarkLocaleBranchId === undefined) {
        throw new deps.ApiValidationError(
          "ApiRecordBenchmarkRequest.benchmarkReport.localeBranchId is required",
        );
      }
      const scope = await deps.requireOwnedBranchScope(services.projectWorkflow, {
        projectId: projectRoute.projectId,
        localeBranchId: benchmarkLocaleBranchId,
      });
      const result = await services.projectWorkflow.recordBenchmarkReport(scope.projectId, body);
      return responses.ok("benchmarks.record", result);
    }
    case "runtime-evidence": {
      const body = deps.parseRuntimeEvidenceRequest(request.body);
      responses.assertPathProject(projectRoute.projectId, body.project.projectId);
      await shared.requireApiPermission(
        services,
        contracts.apiMutationPermissionGates.runtimeEvidenceIngest,
      );
      // policy — verify the client-supplied ProjectState's branch is
      // server-side owned by the project; write with the authoritative branch
      // id so a forged ProjectState cannot ingest evidence into a foreign
      // branch.
      const scope = await deps.requireOwnedBranchScope(services.projectWorkflow, {
        projectId: projectRoute.projectId,
        localeBranchId: body.project.localeBranchId,
      });
      const scopedProject = { ...body.project, localeBranchId: scope.localeBranchId };
      const result = await services.projectWorkflow.ingestRuntimeReport(
        scopedProject,
        body.runtimeReport,
      );
      return responses.ok("runtimeEvidence.ingest", result.result);
    }
    case "launch-pass": {
      // ovw-launch-pass-action — drive the next pass via the driver.
      // `canSteer`-gated (draft.write). The locale branch is
      // VERIFIED server-side against the project's ownership set (a forged
      // branch is refused before the driver runs — policy), then the
      // authoritative branch id is handed to the driver.
      const body = deps.parseLaunchPassRequest(request.body);
      await shared.requireApiPermission(services, contracts.apiMutationPermissionGates.launchPass);
      const scope = await deps.requireOwnedBranchScope(services.projectWorkflow, {
        projectId: projectRoute.projectId,
        localeBranchId: body.localeBranchId,
      });
      const outcome = await services.projectWorkflow.launchNextLocalizationPass({
        projectId: scope.projectId,
        localeBranchId: scope.localeBranchId,
      });
      return responses.ok("projects.launchPass", deps.launchPassResponseBody(outcome));
    }
  }
}
