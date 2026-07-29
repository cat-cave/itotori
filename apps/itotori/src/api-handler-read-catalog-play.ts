import * as contracts from "./api-handler-contracts.js";
import * as deps from "./api-handler-dependencies.js";
import * as responses from "./api-handler-responses.js";
import * as shared from "./api-handler-shared.js";

export async function routeCatalogAndPlayReads(
  request: contracts.ItotoriApiRequest,
  services: contracts.ItotoriReadOnlyApiServices,
): Promise<contracts.ApiJsonResponse | null> {
  if (request.method === "GET" && request.pathname === "/api/catalog/conflicts") {
    return responses.ok(
      "catalog.conflicts",
      await services.catalogRepository.catalogConflictReview(
        deps.parseCatalogConflictReviewFilter(request.search),
      ),
    );
  }

  if (request.method === "GET" && request.pathname === "/api/catalog/completeness") {
    return responses.ok(
      "catalog.completeness",
      await services.catalogRepository.catalogCompletenessBenchmarkPools(
        deps.parseCatalogCompletenessPoolFilter(request.search),
      ),
    );
  }

  if (request.method === "GET" && request.pathname === "/api/catalog/benchmark-seeds") {
    return responses.ok(
      "catalog.benchmarkSeeds",
      await services.catalogRepository.catalogBenchmarkSeedFinder(
        deps.parseCatalogBenchmarkSeedFinderFilter(request.search),
      ),
    );
  }

  if (request.method === "GET" && request.pathname === "/api/catalog/opportunities") {
    return responses.ok(
      "catalog.opportunities",
      await services.catalogRepository.catalogOpportunityRanking(
        deps.parseCatalogOpportunityRankingFilter(request.search),
      ),
    );
  }

  if (request.method === "GET" && request.pathname === "/api/terminology/search") {
    return responses.ok(
      "terminology.search",
      await services.terminologyRepository.searchTerms(
        deps.parseTerminologySearchInput(request.search),
      ),
    );
  }

  const wikiObjectRoute = deps.parseWikiObjectApiRoute(request.pathname);
  if (request.method === "GET" && wikiObjectRoute !== null) {
    const wiki = services.wikiObjectApi;
    if (wiki === undefined)
      throw new Error("wiki is not configured in this API build (wikiObjectApi port missing)");
    const generatedAt = new Date().toISOString();
    if (wikiObjectRoute.resource === "list") {
      const snapshotId = deps.parseWikiObjectSnapshotQuery(request.search);
      const result = await wiki.list({ snapshotId });
      return responses.ok("wiki.list", {
        schemaVersion: "itotori.wiki.objects.v1",
        generatedAt,
        snapshotId,
        sourceObjects: result.sourceObjects,
        renderings: result.renderings,
      });
    }
    if (
      wikiObjectRoute.resource === "edit" ||
      wikiObjectRoute.resource === "feedback" ||
      wikiObjectRoute.resource === "apply"
    ) {
      return responses.methodNotAllowed(["POST"]);
    }
    const shown = await wiki.show(wikiObjectRoute.selector);
    if (shown === null) return responses.notFound(request.pathname);
    if (wikiObjectRoute.resource === "show") {
      return responses.ok("wiki.show", {
        schemaVersion: "itotori.wiki.object.v1",
        generatedAt,
        view: shown.view,
        history: shown.history,
        dependencyImpact: { dependents: shown.dependents },
      });
    }
    return responses.ok("wiki.history", {
      schemaVersion: "itotori.wiki.history.v1",
      generatedAt,
      view: shown.view,
      history: shown.history,
    });
  }

  const patchIterationRoute = deps.parsePatchIterationApiRoute(request.pathname);
  if (request.method === "GET" && patchIterationRoute !== null) {
    return responses.methodNotAllowed(["POST"]);
  }

  const playDeliveryRoute = deps.parsePlayDeliveryApiRoute(request.pathname);
  if (request.method === "GET" && playDeliveryRoute !== null) {
    const delivery = await services.playTesterResultRevision.loadSelectedExport({
      runId: playDeliveryRoute.runId,
    });
    if (delivery.export === null) {
      return responses.errorBody(
        404,
        "not_found",
        `selected delivered patch for run ${playDeliveryRoute.runId} was not found`,
      );
    }
    return responses.ok("play.delivery", deps.playDeliveryResponseBody(delivery));
  }

  const playRouteMapRoute = deps.parsePlayRouteMapApiRoute(request.pathname);
  if (request.method === "GET" && playRouteMapRoute !== null) {
    const scope = await deps.requireOwnedBranchScope(services.projectWorkflow, {
      projectId: playRouteMapRoute.projectId,
      localeBranchId: playRouteMapRoute.localeBranchId,
    });
    const model = await services.playRouteMap.loadRouteMap({
      actor: { userId: "local-user" },
      projectId: scope.projectId,
      localeBranchId: scope.localeBranchId,
    });
    return responses.ok("play.routeMap", model);
  }

  const unitFeedbackRoute = deps.parsePlayUnitFeedbackApiRoute(request.pathname);
  if (request.method === "GET" && unitFeedbackRoute !== null) {
    const scope = await deps.requireOwnedBranchScope(services.projectWorkflow, {
      projectId: unitFeedbackRoute.projectId,
      localeBranchId: unitFeedbackRoute.localeBranchId,
    });
    const bridgeUnitId = deps.nonEmptySearchParam(request.search ?? "", "bridgeUnitId");
    if (bridgeUnitId === null) {
      throw new deps.ApiValidationError("play.unitFeedback requires bridgeUnitId query parameter");
    }
    const notes = await services.unitFeedback.listUnitFeedback({
      projectId: scope.projectId,
      localeBranchId: scope.localeBranchId,
      bridgeUnitId,
    });
    const response: deps.ApiPlayUnitFeedbackResponse = {
      schemaVersion: "itotori.play.unit-feedback.v0",
      projectId: scope.projectId,
      localeBranchId: scope.localeBranchId,
      bridgeUnitId,
      notes: notes.map((note) => ({
        feedbackReportId: note.feedbackReportId,
        feedbackEvidenceId: note.feedbackEvidenceId,
        bridgeUnitId: note.bridgeUnitId,
        sceneId: note.sceneId,
        note: note.note,
        severity: note.severity,
        // An empty string is the persisted representation of an omitted
        // category. Preserve that absence as null rather than inventing one.
        category: note.category || null,
        triageLabel: note.triageLabel,
        contextStatus: note.contextStatus,
        contextCorrectionId: note.contextCorrectionId,
        reportedAt: note.reportedAt,
        duplicate: note.duplicate,
      })),
    };
    return responses.ok("play.unitFeedback", response);
  }

  const addressableUnitRoute = deps.parsePlayAddressableUnitApiRoute(request.pathname);
  if (request.method === "GET" && addressableUnitRoute !== null) {
    const scope = await deps.requireOwnedBranchScope(services.projectWorkflow, {
      projectId: addressableUnitRoute.projectId,
      localeBranchId: addressableUnitRoute.localeBranchId,
    });
    const [unit] = await services.addressableUnits.resolveAddressableBridgeUnits(
      { userId: "local-user" },
      {
        projectId: scope.projectId,
        localeBranchId: scope.localeBranchId,
        bridgeUnitIds: [addressableUnitRoute.bridgeUnitId],
      },
    );
    if (unit === undefined)
      throw new deps.ApiValidationError("addressable bridge unit is required");
    return responses.ok("play.addressableUnit", {
      schemaVersion: "itotori.play.addressable-unit.v0",
      projectId: scope.projectId,
      localeBranchId: scope.localeBranchId,
      unit,
    });
  }

  const catalogContextRoute = deps.parseCatalogContextPanelApiRoute(request.pathname);
  if (request.method === "GET" && catalogContextRoute !== null) {
    const scope = await deps.requireOwnedBranchScope(services.projectWorkflow, {
      projectId: catalogContextRoute.projectId,
      localeBranchId: catalogContextRoute.localeBranchId,
    });
    const dashboard = await services.projectWorkflow.getDashboardStatusForProject(
      catalogContextRoute.projectId,
    );
    if (dashboard.projectId !== scope.projectId) {
      return responses.errorBody(
        404,
        "not_found",
        `project dashboard status for ${scope.projectId} is not loaded`,
      );
    }
    const localeBranch =
      dashboard.localeBranches.find((branch) => branch.localeBranchId === scope.localeBranchId) ??
      null;
    if (localeBranch === null) {
      return responses.errorBody(
        404,
        "not_found",
        `locale branch ${scope.localeBranchId} is not present in project dashboard status`,
      );
    }
    const catalog = await services.catalogRepository.catalogContextPanelForWork({
      workId: catalogContextRoute.workId,
      targetLanguage: localeBranch.targetLocale,
    });
    if (catalog === null) {
      return responses.errorBody(
        404,
        "not_found",
        `catalog context for work ${catalogContextRoute.workId} was not found`,
      );
    }
    return responses.ok(
      "catalog.contextPanel",
      shared.catalogContextPanelResponse({
        projectId: scope.projectId,
        localeBranchId: scope.localeBranchId,
        workId: catalogContextRoute.workId,
        localeBranch,
        catalog,
      }),
    );
  }

  const assetDecisionRoute = deps.parseAssetDecisionApiRoute(request.pathname);
  if (request.method === "GET" && assetDecisionRoute !== null) {
    const filter = deps.parseAssetDecisionReadFilter(request.search);
    if (assetDecisionRoute.resource === "active") {
      return responses.ok("assetDecisions.active", {
        decisions: await services.assetDecisions.loadActiveDecisions(
          assetDecisionRoute.projectId,
          assetDecisionRoute.localeBranchId,
          filter,
        ),
      });
    }
    return responses.ok("assetDecisions.candidates", {
      candidateAssets: await services.assetDecisions.loadCandidateAssets(
        assetDecisionRoute.projectId,
        assetDecisionRoute.localeBranchId,
        filter,
      ),
    });
  }

  if (request.method === "GET" && request.pathname === "/api/queue/health") {
    return responses.ok("queue.health", await services.queueHealth.loadQueueHealth());
  }
  if (
    request.pathname === "/api/projects/status" ||
    request.pathname === "/api/projects/decisions" ||
    request.pathname === "/api/projects/cost" ||
    request.pathname === "/api/projects/cost/drilldown" ||
    request.pathname === "/api/projects/benchmarks" ||
    request.pathname === "/api/jobs/run-table" ||
    request.pathname === "/api/auth/members" ||
    request.pathname === "/api/auth/permission-sets" ||
    request.pathname === "/api/auth/identity" ||
    request.pathname === "/api/auth/capabilities" ||
    request.pathname === "/api/hello/status" ||
    request.pathname === "/api/runtime/v0.2/status" ||
    request.pathname === "/api/catalog/conflicts" ||
    request.pathname === "/api/catalog/completeness" ||
    request.pathname === "/api/catalog/benchmark-seeds" ||
    request.pathname === "/api/catalog/opportunities" ||
    request.pathname === "/api/terminology/search" ||
    request.pathname === "/api/queue/health" ||
    playDeliveryRoute !== null ||
    playRouteMapRoute !== null ||
    catalogContextRoute !== null ||
    assetDecisionRoute !== null
  ) {
    return responses.methodNotAllowed(["GET"]);
  }

  // Explicit write subresources defer to the full mutation handler; every
  // other WikiObject route is GET-only.
  if (wikiObjectRoute !== null) {
    if (
      request.method === "POST" &&
      (wikiObjectRoute.resource === "edit" ||
        wikiObjectRoute.resource === "feedback" ||
        wikiObjectRoute.resource === "apply")
    ) {
      return null;
    }
    return responses.methodNotAllowed(["GET"]);
  }

  // Not a read route this handler owns — defer to the mutation router.
  return null;
}
