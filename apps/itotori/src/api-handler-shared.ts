import * as contracts from "./api-handler-contracts.js";
import * as deps from "./api-handler-dependencies.js";

type ApiAuthorizationDependency = {
  authorization: Pick<deps.ItotoriAuthorizationPort, "requirePermission">;
};
export async function requireApiPermission(
  services: ApiAuthorizationDependency,
  gate: contracts.ApiMutationPermissionGate,
): Promise<void> {
  await services.authorization.requirePermission(gate.permission);
}

/**
 * fnd-caps-context — optional `?actorUserId=` for the capabilities read.
 * Defaults to the local-user actor (the SPA's default authorization actor).
 */
export function parseAuthCapabilitiesActorQuery(search: string | undefined): string {
  if (search === undefined || search === "" || search === "?") {
    return "local-user";
  }
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const actorUserId = params.get("actorUserId");
  if (actorUserId === null || actorUserId.trim() === "") {
    return "local-user";
  }
  return actorUserId;
}

export function authCapabilitiesResponseBody(
  view: Awaited<ReturnType<typeof deps.resolveStudioCapabilityPermissionView>>,
): deps.ApiAuthCapabilitiesResponse {
  return {
    schemaVersion: "itotori.auth.capabilities.v0",
    actorUserId: view.actorUserId,
    canFlag: view.canFlag,
    canSteer: view.canSteer,
    canReveal: view.canReveal,
    denials: view.denials,
    denialReasons: view.denialReasons,
  };
}

export function authIdentityResponseBody(
  identity: deps.ActorIdentityRecord,
): deps.ApiAuthIdentityResponse {
  return {
    schemaVersion: "itotori.auth.identity.v0",
    actorUserId: identity.actorUserId,
    userId: identity.userId,
    principalId: identity.principalId,
    email: identity.email,
    displayName: identity.displayName,
    accounts: identity.accounts.map((account) => ({
      membershipId: account.membershipId,
      accountId: account.accountId,
      accountSlug: account.accountSlug,
      accountName: account.accountName,
      permissionSetIds: account.permissionSetIds,
      createdAt: account.createdAt.toISOString(),
    })),
  };
}

export async function tryApiPermission(
  services: ApiAuthorizationDependency,
  permission: deps.Permission,
): Promise<[boolean, string | null]> {
  try {
    await services.authorization.requirePermission(permission);
    return [true, null];
  } catch (error) {
    if (error instanceof deps.AuthorizationError) {
      return [false, error.message];
    }
    throw error;
  }
}

/**
 * gate-project-status-and-cost-reads — the project dashboard / list / cost
 * read paths require this explicit READ permission to return the full
 * detail. An unprivileged / absent-permission caller instead receives a
 * redacted public dashboard summary (aggregate status + counts only). The
 * gate reuses `catalog.read`, the same permission the sibling
 * ledger-count reads (`countZdrEnforcedByPair`, `countCostKindsByPair`)
 * and the cost report repository read enforce, so the HTTP boundary and
 * the repository defense-in-depth check agree on the required permission.
 */
export async function resolveProjectReadPermission(
  services: ApiAuthorizationDependency,
): Promise<boolean> {
  const [canRead] = await tryApiPermission(services, deps.permissionValues.catalogRead);
  return canRead;
}

/**
 * Resolve the independent mutation capability surfaced to the overview launch
 * action. Journal provenance itself is read under `catalog.read` above.
 */
export async function resolveSteerPermission(
  services: ApiAuthorizationDependency,
): Promise<boolean> {
  const [canRead] = await tryApiPermission(services, deps.permissionValues.draftWrite);
  return canRead;
}

/**
 * gate-project-status-and-cost-reads — the redacted PUBLIC cost summary.
 * Keeps only safe aggregates (run/token/USD totals + the translation
 * memory reuse counts). Strips the run-ledger detail (`recentRuns`, which
 * carries provider/model/routing internals) and the translation-memory
 * reuse events (which carry `targetText`). These are privileged-only.
 */
export function redactProjectCostReport(cost: deps.ProjectCostReport): deps.ProjectCostReport {
  return {
    ...cost,
    recentRuns: [],
    translationMemoryReuse: {
      ...cost.translationMemoryReuse,
      recentEvents: [],
    },
  };
}

export function redactProjectTelemetryTimeseries(
  telemetry: deps.ProjectTelemetryTimeseries,
): deps.ProjectTelemetryTimeseries {
  return {
    ...telemetry,
    rows: [],
    throughputSeries: [],
    costPerRunSeries: [],
  };
}

/**
 * gate-project-status-and-cost-reads — the redacted PUBLIC cost-drilldown
 * view. The rows carry the run ledger + provider/adapter metadata (privileged
 * detail), so they are stripped for unprivileged callers; the filter echo and
 * pagination aggregates are safe to keep. `hasMore`/`nextOffset` still reflect
 * the true total so a paging client behaves consistently.
 */
export function redactCostDrilldownPage(page: deps.CostDrilldownPage): deps.CostDrilldownPage {
  return {
    ...page,
    rows: [],
  };
}

export function redactJobsRunTable(page: deps.JobsRunTableReadModel): deps.JobsRunTableReadModel {
  return {
    ...page,
    rows: [],
  };
}

/**
 * gate-project-status-and-cost-reads — the redacted PUBLIC dashboard
 * summary. Every top-level field is a safe aggregate (project identity,
 * counts, locale-branch rollups); the only sensitive nested payload is the
 * embedded cost report, which is redacted to aggregates.
 */
export function redactProjectDashboardStatus(
  status: deps.ProjectDashboardStatus,
): deps.ProjectDashboardStatus {
  return {
    ...status,
    cost: redactProjectCostReport(status.cost),
  };
}

export function redactProjectPortfolioEntry(
  project: deps.ApiProjectsResponse["projects"][number],
): deps.ApiProjectsResponse["projects"][number] {
  return {
    ...redactProjectDashboardStatus(project),
    progress: {
      ...project.progress,
      blockers: [],
    },
  };
}

/**
 * gate-runtime-status-reads-and-redact-evidence-previews — the redacted
 * PUBLIC runtime status summary for unprivileged callers. Keeps the safe
 * aggregates (final/runtime status, tiers, counts, non-sensitive ids,
 * approximation/limitation/unsupported-capability metadata) and strips the
 * sensitive evidence payloads:
 *   - `traceEvents[].textPreview` — evidence text previews sourced from
 *     observedText / promptText → null.
 *   - `findings[].message` — finding free text → the redaction sentinel
 *     (a non-empty placeholder that keeps the shape valid while carrying no
 *     free text).
 *   - `artifacts[].uri` / `artifacts[].hash` — managed artifact locators
 *     and content hashes → null.
 */
export function redactRuntimeDashboardStatus(
  status: deps.RuntimeDashboardStatus,
): deps.RuntimeDashboardStatus {
  return {
    ...status,
    traceEvents: status.traceEvents.map((event) => ({
      ...event,
      textPreview: null,
    })),
    findings: status.findings.map((finding) => ({
      ...finding,
      message: deps.REDACTED_RUNTIME_FINDING_MESSAGE,
    })),
    artifacts: status.artifacts.map((artifact) => ({
      ...artifact,
      uri: null,
      hash: null,
    })),
  };
}

export function catalogContextPanelResponse(input: {
  projectId: string;
  localeBranchId: string;
  workId: string;
  localeBranch: deps.ProjectDashboardStatus["localeBranches"][number];
  catalog: deps.CatalogContextPanelCatalogReadModel;
}): deps.CatalogContextPanelReadModel {
  return {
    schemaVersion: "catalog.context_panel_route.v0.1",
    generatedAt: input.catalog.generatedAt,
    params: {
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      workId: input.workId,
    },
    row: input.catalog.row,
    releases: input.catalog.releases,
    projectState: {
      targetLanguage: input.localeBranch.targetLocale,
      localeBranch: input.localeBranch,
    },
  };
}
