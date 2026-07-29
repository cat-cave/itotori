import * as contracts from "./api-handler-contracts.js";
import * as deps from "./api-handler-dependencies.js";
import * as responses from "./api-handler-responses.js";
import * as shared from "./api-handler-shared.js";

export async function routeProjectAndAuthReads(
  request: contracts.ItotoriApiRequest,
  services: contracts.ItotoriReadOnlyApiServices,
): Promise<contracts.ApiJsonResponse | null> {
  if (request.method === "GET" && request.pathname === "/api/projects") {
    const canRead = await shared.resolveProjectReadPermission(services);
    const projects = await services.projectWorkflow.listPortfolio();
    return responses.ok("projects.list", {
      projects: canRead ? projects : projects.map(shared.redactProjectPortfolioEntry),
    });
  }

  if (request.method === "GET" && request.pathname === "/api/projects/status") {
    // The read gate is resolved BEFORE (and independently of) the requested
    // scope, so naming a project can never widen what an unprivileged caller
    // sees — it only narrows which project the same gated payload describes.
    const canRead = await shared.resolveProjectReadPermission(services);
    const status = await services.projectWorkflow.getDashboardStatus(
      deps.parseProjectScopeQuery(request.search, "project status"),
    );
    return responses.ok(
      "projects.status",
      canRead ? status : shared.redactProjectDashboardStatus(status),
    );
  }

  if (request.method === "GET" && request.pathname === "/api/projects/overview") {
    const canRead = await shared.resolveProjectReadPermission(services);
    // The journal repository's read authority is `catalog.read`; compose it
    // only when that boundary has granted the caller access. Steering remains
    // a separate `draft.write` capability.
    const canSteer = await shared.resolveSteerPermission(services);
    const overview = await services.projectWorkflow.getProjectOverview({
      ...deps.parseProjectOverviewFilter(request.search),
      includeJournal: canRead,
      canSteer,
    });
    return responses.ok(
      "projects.overview",
      canRead
        ? overview
        : deps.redactProjectOverviewReadModel(overview, {
            progress: shared.redactProjectDashboardStatus(overview.progress),
            cost: shared.redactProjectCostReport(overview.cost),
            telemetry: shared.redactProjectTelemetryTimeseries(overview.telemetry),
            costDrilldown: shared.redactCostDrilldownPage(overview.costDrilldown),
          }),
    );
  }

  if (request.method === "GET" && request.pathname === "/api/projects/decisions") {
    return responses.ok(
      "projects.decisions",
      await services.projectWorkflow.getDashboardDecisions(
        deps.parseProjectScopeQuery(request.search, "project decisions"),
      ),
    );
  }

  if (request.method === "GET" && request.pathname === "/api/projects/cost") {
    const canRead = await shared.resolveProjectReadPermission(services);
    const cost = await services.projectWorkflow.getCostReport(
      deps.parseProjectScopeQuery(request.search, "project cost"),
    );
    return responses.ok("projects.cost", canRead ? cost : shared.redactProjectCostReport(cost));
  }

  if (request.method === "GET" && request.pathname === "/api/projects/cost/drilldown") {
    // gate-project-status-and-cost-reads — the drilldown rows carry the run
    // ledger + provider/adapter metadata, so an unprivileged caller receives a
    // rows-stripped view (pagination aggregates only), mirroring the cost
    // report's `recentRuns` redaction.
    const canRead = await shared.resolveProjectReadPermission(services);
    const page = await services.projectWorkflow.getCostDrilldown(
      deps.parseCostDrilldownFilter(request.search),
    );
    return responses.ok(
      "projects.costDrilldown",
      canRead ? page : shared.redactCostDrilldownPage(page),
    );
  }

  if (request.method === "GET" && request.pathname === "/api/projects/benchmarks") {
    return responses.ok("projects.benchmarks", {
      reports: await services.projectWorkflow.getBenchmarkReports(
        deps.parseProjectScopeQuery(request.search, "project benchmarks"),
      ),
    });
  }

  if (request.method === "GET" && request.pathname === "/api/jobs/run-table") {
    const canRead = await shared.resolveProjectReadPermission(services);
    const page = await services.jobs.loadRunTable(deps.parseJobsRunTableQuery(request.search));
    return responses.ok("jobs.runTable", canRead ? page : shared.redactJobsRunTable(page));
  }

  if (request.method === "GET" && request.pathname === "/api/settings/model-routing") {
    const projectId = deps.parseModelRoutingSettingsQuery(request.search);
    await shared.requireApiPermission(
      services,
      contracts.apiMutationPermissionGates.modelRoutingRead,
    );
    return responses.ok(
      "settings.modelRouting.get",
      deps.modelRoutingSettingsResponseBody(await services.modelRouting.loadSettings(projectId)),
    );
  }

  const branchPolicyRoute = deps.parseBranchPolicySettingsApiRoute(request.pathname);
  if (request.method === "GET" && branchPolicyRoute !== null) {
    await shared.requireApiPermission(
      services,
      contracts.apiMutationPermissionGates.branchPolicyRead,
    );
    const scope = await deps.requireOwnedBranchScope(services.projectWorkflow, {
      projectId: branchPolicyRoute.projectId,
      localeBranchId: branchPolicyRoute.localeBranchId,
    });
    return responses.ok(
      "settings.branchPolicy.get",
      await services.branchPolicy.loadSettings({
        projectId: scope.projectId,
        localeBranchId: scope.localeBranchId,
      }),
    );
  }

  const translationScopeRoute = deps.parseTranslationScopeSettingsApiRoute(request.pathname);
  if (request.method === "GET" && translationScopeRoute !== null) {
    await shared.requireApiPermission(
      services,
      contracts.apiMutationPermissionGates.translationScopeRead,
    );
    const scope = await deps.requireOwnedBranchScope(services.projectWorkflow, {
      projectId: translationScopeRoute.projectId,
      localeBranchId: translationScopeRoute.localeBranchId,
    });
    return responses.ok(
      "settings.translationScope.get",
      await services.translationScope.loadSettings({
        projectId: scope.projectId,
        localeBranchId: scope.localeBranchId,
      }),
    );
  }

  if (request.method === "GET" && request.pathname === "/api/auth/members") {
    const accountId = deps.parseAuthMembersListQuery(request.search);
    await shared.requireApiPermission(services, contracts.apiMutationPermissionGates.membersList);
    return responses.ok("auth.members.list", {
      schemaVersion: "itotori.auth.members.v0",
      accountId,
      members: (await services.authMembers.listMembers(accountId)).map(deps.memberRecordBody),
    });
  }

  if (request.method === "GET" && request.pathname === "/api/auth/billing/seat-usage") {
    const accountId = deps.parseAuthBillingSeatUsageQuery(request.search);
    await shared.requireApiPermission(
      services,
      contracts.apiMutationPermissionGates.billingSeatUsage,
    );
    return responses.ok(
      "auth.billing.seatUsage",
      deps.authBillingSeatUsageResponseBody(await services.authBilling.loadSeatUsage(accountId)),
    );
  }

  if (request.method === "GET" && request.pathname === "/api/auth/permission-sets") {
    const accountId = deps.parseAuthPermissionSetsListQuery(request.search);
    await shared.requireApiPermission(
      services,
      contracts.apiMutationPermissionGates.permissionSetsList,
    );
    return responses.ok(
      "auth.permissionSets.list",
      deps.permissionSetsListResponseBody({
        accountId,
        permissionSets: await services.authPermissions.listPermissionSets(accountId),
      }),
    );
  }

  if (request.method === "GET" && request.pathname === "/api/auth/identity") {
    return responses.ok(
      "auth.identity",
      shared.authIdentityResponseBody(await services.authIdentity.loadIdentity()),
    );
  }

  // fnd-caps-context — the actor's Studio capability permission VIEW
  // (canFlag / canSteer / canReveal). Resolved from exact
  // permission grants through the auth-002 effective-permission resolver;
  // never branches on a role name. No permission is required to *read* the
  // view itself (a missing grant simply yields canX=false + a denial reason).
  if (request.method === "GET" && request.pathname === "/api/auth/capabilities") {
    const actorUserId = shared.parseAuthCapabilitiesActorQuery(request.search);
    const view = await deps.resolveStudioCapabilityPermissionView(
      services.authorization,
      actorUserId,
    );
    return responses.ok("auth.capabilities", shared.authCapabilitiesResponseBody(view));
  }

  if (request.method === "GET" && request.pathname === "/api/runtime/v0.2/status") {
    // gate-runtime-status-reads-and-redact-evidence-previews — the runtime
    // status read requires catalog.read for the DETAILED evidence report.
    // An unprivileged / absent-permission caller instead receives a redacted
    // summary that omits the evidence-text previews, finding free text, and
    // artifact URIs/hashes.
    const canRead = await shared.resolveProjectReadPermission(services);
    const status = await services.projectWorkflow.getRuntimeStatus(
      deps.parseRuntimeRunIdQuery(request.search),
      deps.parseProjectScopeQuery(request.search, "runtime status", ["runtimeRunId"]),
    );
    if (canRead) {
      return responses.ok("runtime.status", status);
    }
    const redacted = shared.redactRuntimeDashboardStatus(status);
    // Reject a leakage-shaped redaction before it can be emitted.
    deps.assertRedactedRuntimeDashboardStatus(redacted);
    return responses.ok("runtime.status", redacted);
  }

  return null;
}
