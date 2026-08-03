import * as contracts from "./api-handler-contracts.js";
import * as deps from "./api-handler-dependencies.js";
import * as responses from "./api-handler-responses.js";
import * as shared from "./api-handler-shared.js";

type DraftBranchMutationServices = Pick<contracts.ItotoriApiServices, "authorization"> & {
  projectWorkflow: Pick<
    contracts.ItotoriApiServices["projectWorkflow"],
    "listLocaleBranchIdentities"
  >;
};

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
  await deps.requireOwnedBranchScope(services.projectWorkflow, {
    projectId,
    localeBranchId: body.project.localeBranchId,
  });
  // This legacy synchronous branch mutation never falls back to the retired
  // draft service. Every new-pipeline API localize request is wiki-first and
  // therefore QUALIFYING: Q5 is mandatory. This endpoint has neither a durable
  // run id nor a server-owned physical plan, so it must not enter the workflow
  // and later reach Q5 without patched-byte evidence. The dedicated launch-pass
  // action owns the saved operator config, creates the run, and supplies its
  // render-evidence plan to the exact same production pipeline.
  return responses.ok("branches.draft", {
    outcome: "refused",
    project: null,
    status: null,
    refusalMessage:
      "draft refused: qualifying localization must start through the configured launch-pass action so Q5 receives a server-owned patched-byte render plan",
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
