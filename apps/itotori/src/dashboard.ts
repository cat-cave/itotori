import type {
  BenchmarkReportSummary,
  CostDrilldownPage,
  CostDrilldownRow,
  DashboardDecisionReadModel,
  DashboardPendingDecision,
  ProjectCostReport,
  ProjectDashboardStatus,
  RuntimeDashboardStatus,
} from "@itotori/db";
import {
  assertDashboardDecisionReadModel,
  assertItotoriApiResponse,
  assertItotoriApiErrorResponse,
  assertProjectCostDrilldownResponse,
  assertProjectDashboardStatus,
  assertReviewerQueueDashboardReadModel,
  type ApiErrorResponse,
  type ApiProjectsResponse,
  type ItotoriApiRouteId,
} from "./api-schema.js";
import {
  loadStyleGuideContext,
  renderStyleGuideBuilderPanel,
  styleGuideBuilderStyles,
  type StyleGuideBuilderContext,
} from "./style-guide-builder.js";
import type { AdapterCapabilityEvidenceSummary } from "./services/engine-capability-report.js";
import type {
  ReviewerQueueDashboardReadModel,
  ReviewerQueueDashboardRow,
} from "./reviewer/index.js";

export type DashboardEndpoints = {
  projects: string;
  status: string;
  decisions: string;
  reviewerQueue: string;
  cost: string;
  costDrilldown: string;
  benchmarks: string;
  runtime: string;
};

// ITOTORI-027 — the indie-localization cost target the dashboard tracks
// EMPIRICALLY. The progress bar compares real recorded billed cost
// (ProjectCostReport.billedMicrosUsd, sourced from OpenRouter's
// usage.cost) against this ceiling; it is never an estimate.
export const INDIE_LOCALIZATION_COST_TARGET_MICROS_USD = 25_000_000;

export type DashboardEndpointConfig = Partial<DashboardEndpoints> | string;

type DashboardReadRouteId =
  | "projects.list"
  | "projects.status"
  | "projects.decisions"
  | "reviewer.queue"
  | "projects.cost"
  | "projects.costDrilldown"
  | "projects.benchmarks"
  | "runtime.status";

type BenchmarkReportsResponse = { reports: BenchmarkReportSummary[] };

type DashboardReadResponses = {
  "projects.list": ApiProjectsResponse;
  "projects.status": ProjectDashboardStatus;
  "projects.decisions": DashboardDecisionReadModel;
  "reviewer.queue": ReviewerQueueDashboardReadModel;
  "projects.cost": ProjectCostReport;
  "projects.costDrilldown": CostDrilldownPage;
  "projects.benchmarks": BenchmarkReportsResponse;
  "runtime.status": RuntimeDashboardStatus;
};

/**
 * ITOTORI-056 — dashboard panel state model. A panel NEVER presents
 * unqueried or failed data as a confirmed empty state. The four states:
 *  - `unknown`     — the panel's data source has not been queried yet.
 *  - `unavailable` — the query was attempted but failed/errored.
 *  - `empty`       — the query succeeded and genuinely returned no data.
 *  - `populated`   — the query succeeded and returned data (rendered).
 *
 * The style-guide, glossary, jobs, and benchmark panels each carry one of
 * these states so a reviewer can tell "the API has not been asked yet"
 * apart from "the API answered with nothing" and "the API call failed".
 */
export type DashboardPanelState<T> =
  | { state: "unknown" }
  | { state: "unavailable"; error: string; apiError?: DashboardApiErrorDetail }
  | { state: "empty" }
  | { state: "populated"; data: T };

/**
 * ITOTORI-057 — the structured, actionable detail parsed from a typed API
 * error response (`{ code, error }`). The dashboard shell renders the
 * `code` + `message` when the failing response carried a typed body so a
 * reviewer sees the actionable reason (e.g. `[forbidden] not permitted to
 * read cost`) instead of an opaque HTTP status. When the body was
 * malformed / missing / unreadable, `code` and `message` are `null` and
 * the shell falls back to a SAFE generic state (no crash, no fabricated
 * code). `routeId` + `status` are always present so the fallback still
 * points at the failing route.
 */
export type DashboardApiErrorDetail = {
  routeId: string;
  status: number;
  code: ApiErrorResponse["code"] | null;
  message: string | null;
};

/**
 * ITOTORI-057 — the error `fetchApi` throws when a dashboard read fails.
 * Carries the typed {@link DashboardApiErrorDetail} so the renderers can
 * surface `code` + `message` distinctly from the generic route/status
 * fallback. The base `Error.message` keeps the `failed to load <routeId>:
 * <status>` form so existing logs / assertions stay meaningful.
 */
export class DashboardApiError extends Error {
  readonly routeId: string;
  readonly status: number;
  readonly code: ApiErrorResponse["code"] | null;
  readonly typedMessage: string | null;

  constructor(detail: DashboardApiErrorDetail) {
    super(`failed to load ${detail.routeId}: ${detail.status}`);
    this.name = "DashboardApiError";
    this.routeId = detail.routeId;
    this.status = detail.status;
    this.code = detail.code;
    this.typedMessage = detail.message;
  }

  get detail(): DashboardApiErrorDetail {
    return {
      routeId: this.routeId,
      status: this.status,
      code: this.code,
      message: this.typedMessage,
    };
  }
}

/**
 * ITOTORI-057 — parse a typed {@link ApiErrorResponse} (`{ code, error }`)
 * from a failed request body. Returns `null` for ANY malformed / missing /
 * non-conforming body so the caller can fall back to a safe generic state
 * instead of crashing or rendering a half-parsed code. Pure + throw-free so
 * it is unit-testable without a `Response`.
 */
export function parseTypedApiError(body: unknown): ApiErrorResponse | null {
  try {
    assertItotoriApiErrorResponse(body);
    return body;
  } catch {
    return null;
  }
}

type DashboardData =
  | {
      state: "ready";
      projects: ProjectDashboardStatus[];
      status: ProjectDashboardStatus;
      decisions: DashboardDecisionReadModel;
      reviewerQueue: ReviewerQueueDashboardReadModel;
      costDrilldown: CostDrilldownPage;
      runtime: RuntimeDashboardStatus;
      // ITOTORI-056 — the four panel states. Each panel renders its state
      // distinctly so unqueried / failed data is never shown as confirmed
      // empty. `cost` backs both the Jobs panel (via recentRuns) and the
      // Model cost panel; `benchmarks` backs the Benchmarks, QA agent
      // metrics, and Benchmark reports panels.
      styleGuide: DashboardPanelState<StyleGuideBuilderContext>;
      glossary: DashboardPanelState<unknown[]>;
      jobs: DashboardPanelState<ProjectCostReport["recentRuns"]>;
      benchmarks: DashboardPanelState<BenchmarkReportSummary[]>;
      cost: DashboardPanelState<ProjectCostReport>;
    }
  | {
      state: "empty";
      projects: ProjectDashboardStatus[];
    };

const defaultDashboardEndpoints: DashboardEndpoints = {
  projects: "/api/projects",
  status: "/api/projects/status",
  decisions: "/api/projects/decisions",
  reviewerQueue: "/api/reviewer/queue",
  cost: "/api/projects/cost",
  costDrilldown: "/api/projects/cost/drilldown",
  benchmarks: "/api/projects/benchmarks",
  runtime: "/api/runtime/v0.2/status",
};

export async function fetchProjectStatus(
  endpoint = defaultDashboardEndpoints.status,
): Promise<ProjectDashboardStatus> {
  const status = await fetchApi("projects.status", endpoint);
  assertProjectDashboardStatus(status);
  return status;
}

export async function fetchDashboardDecisions(
  endpoint = defaultDashboardEndpoints.decisions,
): Promise<DashboardDecisionReadModel> {
  const decisions = await fetchApi("projects.decisions", endpoint);
  assertDashboardDecisionReadModel(decisions);
  return decisions;
}

export async function fetchDashboardData(
  endpointConfig: DashboardEndpointConfig = {},
): Promise<DashboardData> {
  const endpoints = resolveDashboardEndpoints(endpointConfig);
  const projectsResponse = await fetchApi("projects.list", endpoints.projects);

  if (projectsResponse.projects.length === 0) {
    return { state: "empty", projects: [] };
  }

  // `status` is the project shell context (header strip, branch/locale
  // panels, decision cross-check). It stays a HARD dependency: if it fails
  // the whole dashboard renders the error state, since every panel below
  // relies on the project/branch identity it carries.
  const status = await fetchApi("projects.status", endpoints.status);
  assertProjectDashboardStatus(status);

  // ITOTORI-056 — the panel-source queries settle INDEPENDENTLY so a single
  // failed read degrades JUST the panel it backs (unavailable) instead of
  // collapsing the whole dashboard. `decisions`, `runtime`, `reviewerQueue`,
  // and `costDrilldown` stay required (their panels are not in the 4-state
  // scope and they share no source with the four panels); `cost` and
  // `benchmarks` are isolated because they back the Jobs and Benchmark
  // panels, and `styleGuide` is isolated because it backs the Style guide
  // panel.
  const [decisions, costDrilldown, runtime, reviewerQueue] = await Promise.all([
    fetchApi("projects.decisions", endpoints.decisions).then((value) => {
      assertDecisionReadMatchesStatus(status, value);
      return value;
    }),
    fetchApi("projects.costDrilldown", endpoints.costDrilldown),
    fetchApi("runtime.status", endpoints.runtime),
    fetchReviewerQueueForStatus(endpoints.reviewerQueue, status),
  ]);
  assertReviewerQueueDashboardReadModel(reviewerQueue);

  const [costResult, benchmarksResult] = await Promise.allSettled([
    fetchApi("projects.cost", endpoints.cost),
    fetchApi("projects.benchmarks", endpoints.benchmarks),
  ]);
  const cost = costPanelState(costResult);
  const benchmarks = benchmarksPanelState(benchmarksResult);
  const styleGuide = await styleGuidePanelState(status);

  return {
    state: "ready",
    projects: projectsResponse.projects,
    status,
    decisions,
    reviewerQueue,
    costDrilldown,
    runtime,
    styleGuide,
    // ITOTORI-056 — the glossary has no API-backed query wired yet, so it
    // is ALWAYS `unknown`. Rendering it as `empty` ("No glossary entries
    // were returned by the API") would present unqueried data as a
    // confirmed empty state — exactly the conflation this state model
    // exists to prevent.
    glossary: { state: "unknown" },
    jobs: jobsPanelState(cost),
    benchmarks,
    cost,
  };
}

/**
 * ITOTORI-053 — fetch a single filtered/paginated cost-drilldown page. The
 * dashboard's initial render consumes the first page via `fetchDashboardData`;
 * a paging/filtering client re-fetches with `filter` (project/system/time +
 * limit/offset) to walk the deterministic pages.
 */
export async function fetchCostDrilldown(
  endpoint: string,
  filter: {
    projectId?: string;
    systemId?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<CostDrilldownPage> {
  let target = endpoint;
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined) {
      target = withQueryParam(target, key, String(value));
    }
  }
  const page = await fetchApi("projects.costDrilldown", target);
  assertProjectCostDrilldownResponse(page);
  return page;
}

export async function renderDashboard(
  root: HTMLElement,
  endpointConfig: DashboardEndpointConfig = {},
): Promise<void> {
  renderLoading(root);
  try {
    const data = await fetchDashboardData(endpointConfig);
    if (data.state === "empty") {
      renderEmpty(root);
      return;
    }
    renderWorkbench(root, data);
  } catch (error) {
    renderError(root, error);
  }
}

async function fetchApi<RouteId extends DashboardReadRouteId>(
  routeId: RouteId,
  endpoint: string,
): Promise<DashboardReadResponses[RouteId]> {
  const response = await fetch(resolveUrl(endpoint));
  if (!response.ok) {
    // ITOTORI-057 — parse the typed error body (`{ code, error }`) when the
    // failing response carries one so the shell can render actionable
    // code + message. A malformed / missing / unreadable body resolves to
    // `null` fields (safe fallback) — the thrown DashboardApiError still
    // carries the route + status so the generic fallback points at the
    // failing route instead of crashing.
    throw await readDashboardApiError(routeId, response);
  }
  const body = await response.json();
  assertItotoriApiResponse(routeId as ItotoriApiRouteId, body);
  return body as DashboardReadResponses[RouteId];
}

// ITOTORI-057 — read a failed `Response` and build a DashboardApiError. The
// typed body is parsed best-effort: any JSON parse failure, schema mismatch,
// or empty body resolves to `null` code/message (safe fallback) so a
// malformed error body never breaks the shell.
async function readDashboardApiError(
  routeId: string,
  response: Response,
): Promise<DashboardApiError> {
  let code: ApiErrorResponse["code"] | null = null;
  let message: string | null = null;
  try {
    const body = await response.json();
    const typed = parseTypedApiError(body);
    if (typed !== null) {
      code = typed.code;
      message = typed.error;
    }
  } catch {
    // Body was not JSON / empty / unreadable — fall back safely.
  }
  return new DashboardApiError({ routeId, status: response.status, code, message });
}

// ITOTORI-056 — fetch the reviewer queue for the status's selected locale
// branch. When no branch is selected the queue is structurally empty (no
// branch to scope items to); this is NOT the same as the panel `empty`
// state, it is a valid zero-row read model returned inline.
async function fetchReviewerQueueForStatus(
  endpoint: string,
  status: ProjectDashboardStatus,
): Promise<ReviewerQueueDashboardReadModel> {
  if (status.selectedLocaleBranchId === null) {
    return emptyReviewerQueue(status.projectId);
  }
  return fetchApi(
    "reviewer.queue",
    withQueryParam(endpoint, "localeBranchId", status.selectedLocaleBranchId),
  );
}

// ITOTORI-056 — derive the per-panel state for each of the four panels from
// the settled promise of its data-source query. A rejected promise becomes
// `unavailable` (never `empty`); a fulfilled promise becomes `empty` or
// `populated` based on whether the payload genuinely carries data.

function settleError(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

// ITOTORI-057 — extract the structured typed-error detail from a rejected
// panel query so the unavailable notice can render code + message. Returns
// `undefined` for any non-DashboardApiError (e.g. a thrown builder load),
// leaving that panel on the safe generic fallback.
function settleApiError(reason: unknown): DashboardApiErrorDetail | undefined {
  return reason instanceof DashboardApiError ? reason.detail : undefined;
}

// ITOTORI-057 — build an `unavailable` panel state, threading the typed
// detail ONLY when it exists. The conditional inclusion keeps the state
// clean under `exactOptionalPropertyTypes` (no explicit `undefined`), and a
// malformed / non-typed failure resolves to the safe generic fallback.
function unavailablePanelState<T>(reasonOrError: unknown): DashboardPanelState<T> {
  const apiError = settleApiError(reasonOrError);
  if (apiError === undefined) {
    return { state: "unavailable", error: settleError(reasonOrError) };
  }
  return { state: "unavailable", error: settleError(reasonOrError), apiError };
}

function costPanelState(
  result: PromiseSettledResult<ProjectCostReport>,
): DashboardPanelState<ProjectCostReport> {
  if (result.status === "rejected") {
    return unavailablePanelState(result.reason);
  }
  // The cost report is a structured read-model: once it loads it is
  // `populated` (it carries totals / TM reuse even with zero runs). The
  // Jobs panel derives its own `empty` vs `populated` from recentRuns.
  return { state: "populated", data: result.value };
}

function benchmarksPanelState(
  result: PromiseSettledResult<BenchmarkReportsResponse>,
): DashboardPanelState<BenchmarkReportSummary[]> {
  if (result.status === "rejected") {
    return unavailablePanelState(result.reason);
  }
  const reports = result.value.reports;
  return reports.length === 0 ? { state: "empty" } : { state: "populated", data: reports };
}

function jobsPanelState(
  cost: DashboardPanelState<ProjectCostReport>,
): DashboardPanelState<ProjectCostReport["recentRuns"]> {
  switch (cost.state) {
    case "unknown":
      return { state: "unknown" };
    case "unavailable":
      // ITOTORI-057 — Jobs shares the cost query, so it inherits the cost
      // panel's typed error detail (code + message) when the cost read
      // failed with a typed body. The conditional keeps the property
      // absent (not explicit undefined) under exactOptionalPropertyTypes.
      return cost.apiError === undefined
        ? { state: "unavailable", error: cost.error }
        : { state: "unavailable", error: cost.error, apiError: cost.apiError };
    case "empty":
      return { state: "empty" };
    case "populated":
      return cost.data.recentRuns.length === 0
        ? { state: "empty" }
        : { state: "populated", data: cost.data.recentRuns };
  }
}

// ITOTORI-127 — a missing style-guide route context (no selected locale
// branch, or no policy version on the selected branch) degrades to a
// PANEL-SCOPED `unavailable` state naming the missing piece, instead of
// collapsing the whole dashboard. The rest of the dashboard still renders;
// only the style-guide panel shows why its context is missing. The builder
// load throwing is also `unavailable` (carrying the thrown error); a
// successful load is `populated`. It is never `empty` — once the builder
// resolves it carries a policy / proposal view to render.
async function styleGuidePanelState(
  status: ProjectDashboardStatus,
): Promise<DashboardPanelState<StyleGuideBuilderContext>> {
  const localeBranchId = status.selectedLocaleBranchId;
  const policyVersionId = status.currentStyleGuidePolicyVersionId;
  // ITOTORI-127 — name the specific missing route-context piece so the
  // unavailable notice tells a reviewer WHY the style-guide panel could not
  // load (no branch selected vs. branch selected but no policy version),
  // instead of an opaque "not queried" state. The inline null checks keep
  // TypeScript narrowing both ids to `string` for the load below.
  if (localeBranchId === null) {
    return { state: "unavailable", error: "no locale branch is selected" };
  }
  if (policyVersionId === null) {
    return {
      state: "unavailable",
      error: "the selected locale branch has no style-guide policy version",
    };
  }
  try {
    const context = await loadStyleGuideContext({
      localeBranchId,
      policyVersionId,
      fixtureState: "empty_policy",
      permissionProfile: "reviewer",
    });
    return { state: "populated", data: context };
  } catch (error) {
    return unavailablePanelState(error);
  }
}

function renderLoading(root: HTMLElement): void {
  root.innerHTML = `
    ${dashboardStyles()}
    <main class="itotori-shell" data-state="loading">
      <header class="shell-header">
        <div>
          <p class="eyebrow">Workbench</p>
          <h1>Itotori dashboard</h1>
        </div>
      </header>
      <section class="state-panel" aria-label="Dashboard loading">
        <h2>Loading dashboard</h2>
        <p role="status">Loading project, branch, QA, runtime, and benchmark data...</p>
      </section>
    </main>
  `;
}

function renderEmpty(root: HTMLElement): void {
  root.innerHTML = `
    ${dashboardStyles()}
    <main class="itotori-shell" data-state="empty">
      <header class="shell-header">
        <div>
          <p class="eyebrow">Workbench</p>
          <h1>Itotori dashboard</h1>
        </div>
      </header>
      <section class="state-panel" aria-label="No projects">
        <h2>No projects</h2>
        <p>No projects were returned by the API.</p>
      </section>
    </main>
  `;
}

function renderError(root: HTMLElement, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  // ITOTORI-057 — when the failure is a typed API error, surface the
  // actionable `code` + `message` above the generic route/status fallback.
  // A malformed / missing error body resolves to the safe fallback block
  // (no fabricated code) so the shell never crashes on a bad error body.
  const apiError = error instanceof DashboardApiError ? error.detail : undefined;
  root.innerHTML = `
    ${dashboardStyles()}
    <main class="itotori-shell" data-state="error">
      <header class="shell-header">
        <div>
          <p class="eyebrow">Workbench</p>
          <h1>Itotori dashboard</h1>
        </div>
      </header>
      <section class="state-panel state-panel-error" aria-label="Dashboard error">
        <h2>Dashboard unavailable</h2>
        <p role="alert">Dashboard data could not load.</p>
        ${renderApiErrorDetail(apiError)}
        <pre>${escapeHtml(message)}</pre>
      </section>
    </main>
  `;
}

// ITOTORI-057 — render the typed API error code + message when the failing
// response carried a typed body. Returns the safe fallback notice when the
// body was malformed / missing (a typed body that failed schema assertion),
// and an empty string for non-API errors (e.g. a network failure thrown
// before any response) so the caller's generic alert + <pre> stay the only
// surface. The code is stamped as `data-api-error-code` so a test (or a
// reviewer inspecting the DOM) can tell a typed failure from a safe
// fallback (`data-api-error-code="unavailable"`).
function renderApiErrorDetail(apiError: DashboardApiErrorDetail | undefined): string {
  if (apiError === undefined) {
    return "";
  }
  if (apiError.code !== null && apiError.message !== null) {
    return `
      <p class="api-error-detail" role="note" data-api-error-code="${escapeHtml(apiError.code)}">
        <code class="api-error-code">${escapeHtml(apiError.code)}</code>
        <span class="api-error-message">${escapeHtml(apiError.message)}</span>
      </p>
    `;
  }
  return `
    <p
      class="api-error-detail api-error-detail-fallback"
      role="note"
      data-api-error-code="unavailable"
    >The API response did not include a typed error body.</p>
  `;
}

function renderWorkbench(
  root: HTMLElement,
  data: Extract<DashboardData, { state: "ready" }>,
): void {
  const { status, costDrilldown, runtime, projects } = data;
  const { decisions, reviewerQueue, styleGuide, glossary, jobs, benchmarks, cost } = data;
  root.innerHTML = `
    ${dashboardStyles()}
    ${styleGuideBuilderStyles()}
    <main class="itotori-shell" data-state="ready">
      <header class="shell-header">
        <div>
          <p class="eyebrow">Workbench</p>
          <h1>Itotori dashboard</h1>
        </div>
        <dl class="status-strip" aria-label="Project summary">
          <div><dt>Project</dt><dd>${escapeHtml(status.name)}</dd></div>
          <div><dt>Status</dt><dd>${statusBadge(status.status)}</dd></div>
          <div><dt>Source</dt><dd>${escapeHtml(status.sourceLocale)}</dd></div>
          <div><dt>Branches</dt><dd>${status.branchCount}</dd></div>
          <div><dt>Open QA</dt><dd>${decisions.counts.pendingDecisionCount}</dd></div>
          <div><dt>Latest event</dt><dd>${escapeHtml(status.latestEventKind ?? "none")}</dd></div>
        </dl>
      </header>

      <nav class="workbench-nav" aria-label="Workbench sections">
        ${navLink("Projects", "projects")}
        ${navLink("Import status", "import-status")}
        ${navLink("Locale branches", "locale-branches")}
        ${navLink("Style guide", "style-guide")}
        ${navLink("Glossary", "glossary")}
        ${navLink("Jobs", "jobs")}
        ${navLink("QA findings", "qa-findings")}
        ${navLink("Reviewer queue", "reviewer-queue")}
        ${navLink("Pending decisions", "pending-decisions")}
        ${navLink("Runtime evidence", "runtime-evidence")}
        ${navLink("Cost target", "cost")}
        ${navLink("Cost drilldown", "cost-drilldown")}
        ${navLink("Benchmarks", "benchmarks")}
        ${navLink("QA agent metrics", "qa-agent-metrics")}
        ${navLink("Benchmark reports", "benchmark-reports")}
      </nav>

      <section class="decision-band" aria-label="Pending decisions" id="pending-decisions">
        <div>
          <p class="eyebrow">Pending decisions</p>
          <h2>${decisionHeadline(decisions)}</h2>
        </div>
        ${renderPendingDecisionList(decisions)}
      </section>

      <section class="section-grid" aria-label="Dashboard sections">
        ${renderProjects(projects)}
        ${renderImportStatus(status)}
        ${renderLocaleBranches(status)}
        ${renderStyleGuidePanel(styleGuide)}
        ${renderGlossaryPanel(glossary)}
        ${renderJobsPanel(jobs)}
        ${renderQaFindings(decisions)}
        ${renderReviewerQueue(reviewerQueue)}
        ${renderRuntimeEvidence(runtime)}
        ${renderCostPanel(cost)}
        ${renderCostDrilldown(costDrilldown)}
        ${renderBenchmarksPanel(benchmarks, cost, status)}
        ${renderQaAgentMetricsPanel(benchmarks)}
        ${renderBenchmarkReportsPanel(benchmarks)}
      </section>
    </main>
  `;
}

function renderProjects(projects: ProjectDashboardStatus[]): string {
  const rows = projects
    .map(
      (project) => `
        <tr>
          <td>${escapeHtml(project.name)}</td>
          <td>${escapeHtml(project.projectKey)}</td>
          <td>${statusBadge(project.status)}</td>
          <td>${escapeHtml(project.sourceLocale)}</td>
          <td>${project.branchCount}</td>
          <td>${project.findingCount}</td>
        </tr>
      `,
    )
    .join("");
  return panel(
    "projects",
    "Projects",
    `
      <table>
        <thead>
          <tr>
            <th>Project</th>
            <th>Key</th>
            <th>Status</th>
            <th>Source</th>
            <th>Branches</th>
            <th>Findings</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `,
  );
}

function renderImportStatus(status: ProjectDashboardStatus): string {
  const importStatus = status.importStatus;
  return panel(
    "import-status",
    "Import status",
    `
      <dl class="metric-list">
        <div><dt>Bridge</dt><dd>${escapeHtml(importStatus.bridgeId)}</dd></div>
        <div><dt>Bundle revision</dt><dd>${escapeHtml(importStatus.sourceBundleRevisionId)}</dd></div>
        <div><dt>Units</dt><dd>${formatDiff(importStatus.units, importStatus.unitCount)}</dd></div>
        <div><dt>Assets</dt><dd>${formatDiff(importStatus.assets, importStatus.assetCount)}</dd></div>
        <div><dt>Source revisions</dt><dd>${importStatus.sourceRevisions.added} new / ${importStatus.sourceRevisions.existing} existing</dd></div>
        <div><dt>Validation failures</dt><dd>${importStatus.validationFailureCount}</dd></div>
        <div><dt>Catalog</dt><dd>${escapeHtml(importStatus.futureReferences.catalogWorkId ?? "pending")}</dd></div>
        <div><dt>Readiness</dt><dd>${escapeHtml(importStatus.futureReferences.readinessProfileId ?? "pending")}</dd></div>
      </dl>
    `,
  );
}

function renderLocaleBranches(status: ProjectDashboardStatus): string {
  if (status.localeBranches.length === 0) {
    return panel("locale-branches", "Locale branches", emptyText("No locale branches returned."));
  }
  const rows = status.localeBranches
    .map(
      (branch) => `
        <tr>
          <td>${escapeHtml(branch.targetLocale)}</td>
          <td>${statusBadge(branch.status)}</td>
          <td>${branch.translatedUnitCount}/${branch.unitCount}</td>
          <td>${progressBar(branch.translatedUnitCount, branch.unitCount)}</td>
          <td>${branch.openFindingCount}</td>
          <td>${branch.artifactCount}</td>
        </tr>
      `,
    )
    .join("");
  return panel(
    "locale-branches",
    "Locale branches",
    `
      <table>
        <thead>
          <tr>
            <th>Locale</th>
            <th>Status</th>
            <th>Translated</th>
            <th>Progress</th>
            <th>Open QA</th>
            <th>Artifacts</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `,
  );
}

// ITOTORI-056 — the four panel-state-aware renderers. Each one carries a
// `data-panel-state` attribute so a test (or a reviewer inspecting the DOM)
// can tell `unknown` / `unavailable` / `empty` / `populated` apart. The
// non-populated states render a state notice INSTEAD of any data-derived
// body, so unqueried or failed data is never shown as a confirmed empty.

function renderStyleGuidePanel(state: DashboardPanelState<StyleGuideBuilderContext>): string {
  if (state.state !== "populated") {
    return statePanel(
      "style-guide",
      "Style guide",
      state,
      stateNotice(state, "Style guide", "No style-guide policy was returned by the API.")!,
    );
  }
  return statePanel("style-guide", "Style guide", state, renderStyleGuideBuilderPanel(state.data));
}

function renderGlossaryPanel(state: DashboardPanelState<unknown[]>): string {
  return statePanel(
    "glossary",
    "Glossary",
    state,
    state.state === "populated"
      ? ""
      : stateNotice(state, "Glossary", "No glossary entries were returned by the API.")!,
  );
}

function renderJobsPanel(state: DashboardPanelState<ProjectCostReport["recentRuns"]>): string {
  if (state.state !== "populated") {
    return statePanel(
      "jobs",
      "Jobs",
      state,
      stateNotice(state, "Jobs", "No job or provider runs were returned by the API.")!,
    );
  }
  return statePanel("jobs", "Jobs", state, renderJobsTable(state.data));
}

function renderJobsTable(runs: ProjectCostReport["recentRuns"]): string {
  const rows = runs
    .map(
      (run) => `
        <tr>
          <td>${escapeHtml(run.taskKind)}</td>
          <td>${statusBadge(run.status)}</td>
          <td>${escapeHtml(run.providerFamily)} / ${escapeHtml(run.providerName)}</td>
          <td>${escapeHtml(run.actualModelId)}</td>
          <td>${escapeHtml(run.promptPresetId)}@${escapeHtml(run.promptTemplateVersion)}</td>
          <td>${run.retryCount}</td>
          <td>${formatFallback(run)}</td>
          <td>${formatDataPolicy(run)}</td>
          <td>${formatMicrosUsd(run.amountMicrosUsd)}</td>
          <td>${formatTokens(run.totalTokens)}</td>
        </tr>
      `,
    )
    .join("");
  return `
    <table>
      <thead>
        <tr>
          <th>Task</th>
          <th>Status</th>
          <th>Provider</th>
          <th>Model</th>
          <th>Prompt</th>
          <th>Retries</th>
          <th>Fallback</th>
          <th>Data policy</th>
          <th>Cost</th>
          <th>Tokens</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderQaFindings(decisions: DashboardDecisionReadModel): string {
  const rows = qaFindingRows(decisions);
  if (rows.length === 0) {
    return panel("qa-findings", "QA findings", emptyText("No open QA findings returned."));
  }
  return panel(
    "qa-findings",
    "QA findings",
    `
      <table>
        <thead>
          <tr>
            <th>Area</th>
            <th>Open</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${rows.join("")}</tbody>
      </table>
    `,
  );
}

function renderReviewerQueue(queue: ReviewerQueueDashboardReadModel): string {
  const rows = queue.rows.map(renderReviewerQueueRow).join("");
  if (queue.rows.length === 0) {
    return panel(
      "reviewer-queue",
      "Reviewer queue",
      emptyText("No reviewer queue items were returned by the API."),
    );
  }
  const selectedRows = queue.rows.filter((row) => row.selectedForBatch);
  return panel(
    "reviewer-queue",
    "Reviewer queue",
    `
      <dl class="metric-list metric-list-compact">
        <div><dt>Pending</dt><dd>${queue.aggregate.pending}</dd></div>
        <div><dt>Resolved</dt><dd>${queue.aggregate.resolved}</dd></div>
        <div><dt>Deferred</dt><dd>${queue.aggregate.deferred}</dd></div>
        <div><dt>Escalated</dt><dd>${queue.aggregate.escalated}</dd></div>
        <div><dt>Batch applied</dt><dd>${queue.aggregate.batch_applied}</dd></div>
      </dl>
      <form action="/reviewer-queue/batch" method="get" class="queue-batch-form">
        <input
          type="hidden"
          name="action"
          value="${escapeHtml(queue.defaultBatchRequest.action)}"
        />
        <input
          type="hidden"
          name="actorUserId"
          value="${escapeHtml(queue.permission.actorUserId)}"
        />
        <table>
          <thead>
            <tr>
              <th>Batch</th>
              <th>State</th>
              <th>Item</th>
              <th>Kind</th>
              <th>Last action</th>
              <th>Batch id</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <button type="submit"${selectedRows.length === 0 ? ' disabled aria-disabled="true"' : ""}>
          Preview batch
        </button>
      </form>
    `,
  );
}

function renderReviewerQueueRow(row: ReviewerQueueDashboardRow): string {
  const selectionValue = `${row.reviewItemId}@${row.sourceRevisionId}`;
  return `
    <tr
      data-review-item-id="${escapeHtml(row.reviewItemId)}"
      data-dashboard-state="${escapeHtml(row.dashboardState)}"
    >
      <td>
        <input
          type="checkbox"
          name="selection"
          value="${escapeHtml(selectionValue)}"
          ${row.selectedForBatch ? "checked" : ""}
          aria-label="Select ${escapeHtml(row.summary)}"
        />
      </td>
      <td>${statusBadge(row.dashboardState)}</td>
      <td>
        <a href="${escapeHtml(row.detailPath)}">${escapeHtml(row.summary)}</a>
        <div><code>${escapeHtml(row.reviewItemId)}</code></div>
      </td>
      <td>${escapeHtml(row.itemKind)}</td>
      <td>${escapeHtml(row.lastAction ?? "none")}</td>
      <td>${escapeHtml(row.batchActionId ?? "none")}</td>
    </tr>
  `;
}

function renderRuntimeEvidence(runtime: RuntimeDashboardStatus): string {
  // Frames / Screenshots are DERIVED from the real persisted runtime
  // artifacts (artifact_kind `frame_capture` / `screenshot`, emitted by the
  // engine port's substrate frame sink), NOT from the scalar summary counters.
  // The scalar `frameCaptureCount` / `screenshotArtifactCount` both resolve to
  // the total capture count (a single capture is counted as both a frame and a
  // screenshot), so rendering them would present a phantom / double-counted
  // number as a live measurement. Counting the actual artifacts keeps each
  // metric backed by a real producer.
  const frameCaptureCount = countRuntimeArtifactsByKind(runtime, "frame_capture");
  const screenshotCount = countRuntimeArtifactsByKind(runtime, "screenshot");
  return panel(
    "runtime-evidence",
    "Runtime evidence",
    `
      <dl class="metric-list">
        <div><dt>Final status</dt><dd>${statusBadge(runtime.finalStatus)}</dd></div>
        <div><dt>Report</dt><dd>${escapeHtml(runtime.runtimeReportId ?? "none")}</dd></div>
        <div><dt>Runtime status</dt><dd>${escapeHtml(runtime.runtimeStatus ?? "none")}</dd></div>
        <div><dt>Fidelity tier</dt><dd>${escapeHtml(runtime.fidelityTier ?? "none")}</dd></div>
        <div><dt>Evidence tier</dt><dd>${escapeHtml(runtime.evidenceTier ?? "none")}</dd></div>
        <div><dt>Text events</dt><dd>${runtime.textEventCount}</dd></div>
        <div><dt>Frames</dt><dd data-metric="frame-captures">${frameCaptureCount}</dd></div>
        <div><dt>Screenshots</dt><dd data-metric="screenshots">${screenshotCount}</dd></div>
        <div><dt>Recordings</dt><dd>${runtime.recordingArtifactCount}</dd></div>
      </dl>
    `,
  );
}

function countRuntimeArtifactsByKind(
  runtime: RuntimeDashboardStatus,
  artifactKind: string,
): number {
  return runtime.artifacts.filter((artifact) => artifact.artifactKind === artifactKind).length;
}

// ITOTORI-027 — benchmark dashboard view driven by REAL recorded
// benchmark reports (persisted benchmark_report artifacts), not a
// cost-run heuristic. Each row is a recorded run with its quality
// penalty + QA-agent count; the provider-run cost that the same
// benchmark generated is tracked through the ledger (Jobs / Model cost).
//
// ITOTORI-056 — the panel now distinguishes the four query states. The
// benchmark cost metric is only rendered when the cost query also
// resolved (populated); otherwise it degrades to an explicit
// "unavailable" so a failed cost read is never shown as a $0.00.
function renderBenchmarksPanel(
  state: DashboardPanelState<BenchmarkReportSummary[]>,
  cost: DashboardPanelState<ProjectCostReport>,
  status: ProjectDashboardStatus,
): string {
  if (state.state !== "populated") {
    return statePanel(
      "benchmarks",
      "Benchmarks",
      state,
      stateNotice(
        state,
        "Benchmarks",
        status.latestEventKind?.includes("benchmark") === true
          ? `Latest benchmark event: ${status.latestEventKind}`
          : "No benchmark reports were returned by the API.",
      )!,
    );
  }
  const reports = state.data;
  const benchmarkCostRuns =
    cost.state === "populated"
      ? cost.data.recentRuns.filter((run) => run.taskKind.includes("benchmark"))
      : [];
  const benchmarkCostMicros = benchmarkCostRuns.reduce(
    (sum, run) => sum + (run.amountMicrosUsd ?? 0),
    0,
  );
  const benchmarkCostCell =
    cost.state === "populated"
      ? formatMicrosUsd(benchmarkCostMicros)
      : `<span class="panel-state-inline" data-panel-state-notice="unavailable">unavailable</span>`;
  const rows = reports
    .map(
      (report) => `
        <tr>
          <td><a href="#benchmark-report-${escapeHtml(report.benchmarkRunId)}">${escapeHtml(report.benchmarkName)}</a></td>
          <td>${statusBadge(report.status)}</td>
          <td>${escapeHtml(report.sourceLocale)} &rarr; ${escapeHtml(report.targetLocale)}</td>
          <td>${report.systemCount}</td>
          <td>${report.findingCount}</td>
          <td>${report.penaltyTotal}</td>
          <td>${report.qaAgents.length}</td>
        </tr>
      `,
    )
    .join("");
  return statePanel(
    "benchmarks",
    "Benchmarks",
    state,
    `
      <dl class="metric-list metric-list-compact">
        <div><dt>Reports</dt><dd>${reports.length}</dd></div>
        <div><dt>QA evaluations</dt><dd>${reports.reduce((sum, report) => sum + report.qaAgents.length, 0)}</dd></div>
        <div><dt>Benchmark cost</dt><dd>${benchmarkCostCell}</dd></div>
        <div><dt>Runs</dt><dd>${benchmarkCostRuns.length}</dd></div>
      </dl>
      <table>
        <thead>
          <tr>
            <th>Benchmark</th>
            <th>Status</th>
            <th>Locales</th>
            <th>Systems</th>
            <th>Findings</th>
            <th>Penalty</th>
            <th>QA agents</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `,
  );
}

// ITOTORI-027 — QA-agent metrics with an explicit false-positive /
// false-negative representation. Counts are the recorded per-agent
// calibration (never re-estimated); precision/recall/F1 are the recorded
// metrics from the benchmark report.
//
// ITOTORI-056 — derives its state from the same benchmarks query as the
// Benchmarks panel. `populated` reports with zero QA-agent evaluations
// resolve to the panel's own `empty` state (the benchmarks query
// answered, there is just nothing to calibrate against).
function renderQaAgentMetricsPanel(state: DashboardPanelState<BenchmarkReportSummary[]>): string {
  if (state.state === "populated") {
    const agents = state.data.flatMap((report) =>
      report.qaAgents.map((agent) => ({ report, agent })),
    );
    if (agents.length === 0) {
      return statePanel(
        "qa-agent-metrics",
        "QA agent metrics",
        { state: "empty" },
        stateNotice(
          { state: "empty" },
          "QA agent metrics",
          "No QA-agent evaluations were returned by the API.",
        )!,
      );
    }
    const totals = agents.reduce(
      (acc, { agent }) => ({
        truePositives: acc.truePositives + agent.truePositives,
        falsePositives: acc.falsePositives + agent.falsePositives,
        falseNegatives: acc.falseNegatives + agent.falseNegatives,
      }),
      { truePositives: 0, falsePositives: 0, falseNegatives: 0 },
    );
    const rows = agents
      .map(
        ({ report, agent }) => `
          <tr>
            <td>${escapeHtml(agent.qaAgentId)}@${escapeHtml(agent.qaAgentVersion)}</td>
            <td>${escapeHtml(report.benchmarkName)}</td>
            <td>${escapeHtml(agent.evaluatedSystemId)}</td>
            <td>${agent.truePositives}</td>
            <td class="qa-fp">${agent.falsePositives}</td>
            <td class="qa-fn">${agent.falseNegatives}</td>
            <td>${formatRatio(agent.seededPrecision)}</td>
            <td>${formatRatio(agent.seededRecall)}</td>
            <td>${formatRatio(agent.f1)}</td>
          </tr>
        `,
      )
      .join("");
    return statePanel(
      "qa-agent-metrics",
      "QA agent metrics",
      state,
      `
        <dl class="metric-list metric-list-compact">
          <div><dt>True positives</dt><dd>${totals.truePositives}</dd></div>
          <div><dt>False positives</dt><dd class="qa-fp">${totals.falsePositives}</dd></div>
          <div><dt>False negatives</dt><dd class="qa-fn">${totals.falseNegatives}</dd></div>
          <div><dt>Evaluations</dt><dd>${agents.length}</dd></div>
        </dl>
        <table>
          <thead>
            <tr>
              <th>QA agent</th>
              <th>Benchmark</th>
              <th>System</th>
              <th>TP</th>
              <th>FP</th>
              <th>FN</th>
              <th>Precision</th>
              <th>Recall</th>
              <th>F1</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      `,
    );
  }
  const notice = stateNotice(
    state,
    "QA agent metrics",
    "No QA-agent evaluations were returned by the API.",
  );
  return statePanel("qa-agent-metrics", "QA agent metrics", state, notice ?? "");
}

// ITOTORI-027 — per-report drilldown. Each recorded benchmark report is
// rendered as an anchored details block (linked from the Benchmarks
// table) exposing the full quality + QA-agent breakdown.
function renderBenchmarkReportsPanel(state: DashboardPanelState<BenchmarkReportSummary[]>): string {
  if (state.state !== "populated") {
    return statePanel(
      "benchmark-reports",
      "Benchmark reports",
      state,
      stateNotice(state, "Benchmark reports", "No benchmark reports were returned by the API.")!,
    );
  }
  const body = state.data.map(renderBenchmarkReportDetail).join("");
  return statePanel("benchmark-reports", "Benchmark reports", state, body);
}

function renderBenchmarkReportDetail(report: BenchmarkReportSummary): string {
  const qaRows = report.qaAgents
    .map(
      (agent) => `
        <tr>
          <td>${escapeHtml(agent.qaAgentId)}@${escapeHtml(agent.qaAgentVersion)}</td>
          <td>${escapeHtml(agent.evaluatedSystemId)}</td>
          <td>${agent.truePositives}</td>
          <td class="qa-fp">${agent.falsePositives}</td>
          <td class="qa-fn">${agent.falseNegatives}</td>
          <td>${formatRatio(agent.seededPrecision)}</td>
          <td>${formatRatio(agent.seededRecall)}</td>
          <td>${formatRatio(agent.f1)}</td>
        </tr>
      `,
    )
    .join("");
  const qaTable =
    report.qaAgents.length === 0
      ? emptyText("No QA-agent evaluations recorded for this benchmark.")
      : `
        <table>
          <thead>
            <tr>
              <th>QA agent</th>
              <th>System</th>
              <th>TP</th>
              <th>FP</th>
              <th>FN</th>
              <th>Precision</th>
              <th>Recall</th>
              <th>F1</th>
            </tr>
          </thead>
          <tbody>${qaRows}</tbody>
        </table>
      `;
  return `
    <details class="report-drilldown" id="benchmark-report-${escapeHtml(report.benchmarkRunId)}">
      <summary>${escapeHtml(report.benchmarkName)} — ${statusBadge(report.status)}</summary>
      <dl class="metric-list metric-list-compact">
        <div><dt>Run id</dt><dd><code>${escapeHtml(report.benchmarkRunId)}</code></dd></div>
        <div><dt>Locales</dt><dd>${escapeHtml(report.sourceLocale)} &rarr; ${escapeHtml(report.targetLocale)}</dd></div>
        <div><dt>Systems</dt><dd>${report.systemCount}</dd></div>
        <div><dt>Findings</dt><dd>${report.findingCount}</dd></div>
        <div><dt>Penalty</dt><dd>${report.penaltyTotal}</dd></div>
        <div><dt>Recorded</dt><dd>${escapeHtml(report.createdAt)}</dd></div>
      </dl>
      ${qaTable}
    </details>
  `;
}

// ITOTORI-056 — the Model cost panel shares the cost query with the Jobs
// panel. When the cost query is unavailable the panel renders the
// unavailable notice instead of a phantom $0.00 target; when populated it
// renders the real recorded cost report (target + ledger + TM reuse).
function renderCostPanel(cost: DashboardPanelState<ProjectCostReport>): string {
  if (cost.state !== "populated") {
    return statePanel(
      "cost",
      "Model cost",
      cost,
      stateNotice(cost, "Model cost", "No cost report was returned by the API.")!,
    );
  }
  return statePanel("cost", "Model cost", cost, renderCostReport(cost.data));
}

function renderCostReport(cost: ProjectCostReport): string {
  const rows = cost.totalsByCostKind
    .map(
      (entry) => `
        <tr>
          <td>${escapeHtml(entry.costKind)}</td>
          <td>${entry.runCount}</td>
          <td>${formatMicrosUsd(entry.amountMicrosUsd)}</td>
          <td>${entry.totalTokens}</td>
        </tr>
      `,
    )
    .join("");
  const reuseRows = cost.translationMemoryReuse.recentEvents
    .map(
      (event) => `
        <tr>
          <td>${escapeHtml(event.targetBridgeUnitId)}</td>
          <td>${escapeHtml(event.reuseStatus)}</td>
          <td>${escapeHtml(event.matchKind)}</td>
          <td>${event.providerCallAvoided ? "yes" : "no"}</td>
          <td>${event.estimatedTotalTokensSaved}</td>
        </tr>
      `,
    )
    .join("");
  return `
    ${renderCostTarget(cost)}
    <dl class="metric-list metric-list-compact">
      <div><dt>Billed</dt><dd>${formatMicrosUsd(cost.billedMicrosUsd)}</dd></div>
      <div><dt>Runs</dt><dd>${cost.runCount}</dd></div>
      <div><dt>Zero-cost runs</dt><dd>${cost.zeroRunCount}</dd></div>
      <div>
        <dt>TM avoided</dt>
        <dd>${cost.translationMemoryReuse.providerCallAvoidedCount}</dd>
      </div>
      <div>
        <dt>TM tokens saved</dt>
        <dd>${cost.translationMemoryReuse.estimatedTotalTokensSaved}</dd>
      </div>
    </dl>
    <table>
      <thead>
        <tr>
          <th>Kind</th>
          <th>Runs</th>
          <th>Amount</th>
          <th>Tokens</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <table>
      <thead>
        <tr>
          <th>TM unit</th>
          <th>Status</th>
          <th>Match</th>
          <th>Avoided</th>
          <th>Tokens saved</th>
        </tr>
      </thead>
      <tbody>${reuseRows || `<tr><td colspan="5">No translation memory reuse.</td></tr>`}</tbody>
    </table>
  `;
}

// ITOTORI-053 — the paginated cost drilldown table. It CONSUMES the filtered
// `/api/projects/cost/drilldown` API (project/system/time filters +
// deterministic pagination), renders each ledger row's cost as one of three
// DISTINCT states (billed / zero / unknown — a $0.00 record renders
// differently from an unrecorded one), and exposes the row's provider adapter
// metadata via a per-row `<details>` drilldown WITHOUT any raw provider
// payload (projected server-side by sanitizeAdapterMetadata — a default-deny
// projection of known-safe fields, so no raw payload can surface).
function renderCostDrilldown(page: CostDrilldownPage): string {
  const { pagination, filter } = page;
  const rows = page.rows.map(renderCostDrilldownRow).join("");
  const table =
    page.rows.length === 0
      ? emptyText("No provider runs matched the drilldown filters.")
      : `
      <table>
        <thead>
          <tr>
            <th>Started</th>
            <th>System</th>
            <th>Task</th>
            <th>Status</th>
            <th>Provider</th>
            <th>Model</th>
            <th>Cost</th>
            <th>Adapter metadata</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  return panel(
    "cost-drilldown",
    "Cost drilldown",
    `
      <dl class="metric-list metric-list-compact" aria-label="Cost drilldown filters">
        <div><dt>Project</dt><dd>${escapeHtml(filter.projectId)}</dd></div>
        <div><dt>System</dt><dd>${escapeHtml(filter.systemId ?? "all")}</dd></div>
        <div><dt>From</dt><dd>${escapeHtml(filter.from ?? "any")}</dd></div>
        <div><dt>To</dt><dd>${escapeHtml(filter.to ?? "any")}</dd></div>
      </dl>
      <dl class="metric-list metric-list-compact" aria-label="Cost drilldown pagination">
        <div><dt>Total</dt><dd>${pagination.total}</dd></div>
        <div><dt>Page</dt><dd>${pagination.page} / ${Math.max(pagination.pageCount, 1)}</dd></div>
        <div><dt>Page size</dt><dd>${pagination.limit}</dd></div>
        <div><dt>Offset</dt><dd>${pagination.offset}</dd></div>
        <div>
          <dt>Next offset</dt>
          <dd>${pagination.nextOffset === null ? "none" : pagination.nextOffset}</dd>
        </div>
      </dl>
      ${table}
    `,
  );
}

function renderCostDrilldownRow(row: CostDrilldownRow): string {
  return `
    <tr data-cost-state="${escapeHtml(row.cost.state)}">
      <td>${escapeHtml(row.startedAt)}</td>
      <td>${escapeHtml(row.systemId ?? "none")}</td>
      <td>${escapeHtml(row.taskKind)}</td>
      <td>${statusBadge(row.status)}</td>
      <td>${escapeHtml(row.provider.providerFamily)} / ${escapeHtml(row.provider.providerName)}</td>
      <td>${escapeHtml(row.provider.actualModelId)}</td>
      <td>${renderCostDrilldownCost(row.cost)}</td>
      <td>${renderProviderAdapterMetadata(row)}</td>
    </tr>
  `;
}

// ITOTORI-053 — zero vs unknown are rendered as DISTINCT cells: a $0.00 billed
// record shows an explicit "$0.000000 (zero)" while an unrecorded cost shows
// "unknown". They are never collapsed to the same display. The billed cell
// renders the ledger-stored micros (formatMicrosUsd), NOT the canonical
// ProviderCost.amountUsd — the drilldown row only has integer micros.
function renderCostDrilldownCost(cost: CostDrilldownRow["cost"]): string {
  if (cost.state === "unknown") {
    return `<span class="cost-state cost-state-unknown" data-cost-state="unknown">unknown</span>`;
  }
  if (cost.state === "zero") {
    return `<span class="cost-state cost-state-zero" data-cost-state="zero">$0.000000 (zero)</span>`;
  }
  return `<span class="cost-state cost-state-billed" data-cost-state="billed">${formatMicrosUsd(
    cost.amountMicrosUsd,
  )}</span>`;
}

// ITOTORI-053 — per-row provider adapter metadata drilldown. Exposes the
// (model, provider) identity + the CURATED adapter metadata. The raw provider
// payload is already stripped at the repository boundary
// (sanitizeAdapterMetadata — a default-deny projection, so only known-safe
// fields surface), so the JSON rendered here can never contain a raw
// request/response body.
function renderProviderAdapterMetadata(row: CostDrilldownRow): string {
  const provider = row.provider;
  return `
    <details class="adapter-metadata-drilldown">
      <summary>Adapter metadata</summary>
      <dl class="metric-list metric-list-compact">
        <div><dt>Provider id</dt><dd>${escapeHtml(provider.providerId)}</dd></div>
        <div><dt>Endpoint</dt><dd>${escapeHtml(provider.endpointFamily)}</dd></div>
        <div><dt>Requested model</dt><dd>${escapeHtml(provider.requestedModelId)}</dd></div>
        <div><dt>Actual model</dt><dd>${escapeHtml(provider.actualModelId)}</dd></div>
        <div><dt>Upstream</dt><dd>${escapeHtml(provider.upstreamProvider ?? "none")}</dd></div>
        <div>
          <dt>Route settings</dt>
          <dd>${escapeHtml(provider.routeSettingsHash ?? "none")}</dd>
        </div>
      </dl>
      <pre class="adapter-metadata-json">${escapeHtml(
        JSON.stringify(provider.adapterMetadata, null, 2),
      )}</pre>
    </details>
  `;
}

// ITOTORI-027 — track the $25 indie-localization target EMPIRICALLY:
// the spent figure is the real recorded billed cost
// (ProjectCostReport.billedMicrosUsd, sourced from OpenRouter usage.cost),
// never an estimate. The remaining line goes negative once real spend
// exceeds the target so an over-budget run is visible, not hidden.
function renderCostTarget(cost: ProjectCostReport): string {
  const target = INDIE_LOCALIZATION_COST_TARGET_MICROS_USD;
  const spent = cost.billedMicrosUsd;
  const percentage = target <= 0 ? 0 : Math.round((spent / target) * 100);
  const remainingMicros = target - spent;
  const overBudget = remainingMicros < 0;
  return `
    <div class="cost-target" aria-label="Indie localization cost target">
      <dl class="metric-list metric-list-compact">
        <div><dt>Spent (real)</dt><dd>${formatMicrosUsd(spent)}</dd></div>
        <div><dt>Target</dt><dd>${formatMicrosUsd(target)}</dd></div>
        <div>
          <dt>${overBudget ? "Over budget" : "Remaining"}</dt>
          <dd class="${overBudget ? "qa-fp" : ""}">${formatSignedMicrosUsd(remainingMicros)}</dd>
        </div>
        <div><dt>Used</dt><dd>${percentage}%</dd></div>
      </dl>
      <div
        class="progress${overBudget ? " progress-over" : ""}"
        aria-label="${percentage}% of $25 target used"
      >
        <span style="width: ${Math.max(0, Math.min(100, percentage))}%"></span>
      </div>
    </div>
  `;
}

function renderPendingDecisionList(decisions: DashboardDecisionReadModel): string {
  const rows = pendingDecisionRows(decisions);
  if (rows.length === 0) {
    return `<p class="empty-copy">No pending decisions returned.</p>`;
  }
  return `
    <table>
      <thead>
        <tr>
          <th>Decision</th>
          <th>Area</th>
          <th>Signal</th>
        </tr>
      </thead>
      <tbody>${rows.join("")}</tbody>
    </table>
  `;
}

function pendingDecisionRows(decisions: DashboardDecisionReadModel): string[] {
  const rows: string[] = [];
  const projectCount = decisions.counts.projectFindingDecisionCount;
  if (projectCount > 0) {
    rows.push(`
      <tr>
        <td>${projectCount} project-level finding ${plural(projectCount, "decision")} pending</td>
        <td>Project</td>
        <td>${escapeHtml(decisionGroupSignal(decisions.pendingDecisions, "project_finding"))}</td>
      </tr>
    `);
  }
  for (const branch of groupedBranchDecisions(decisions.pendingDecisions)) {
    rows.push(`
      <tr>
        <td>${branch.count} locale branch finding ${plural(branch.count, "decision")} pending</td>
        <td>${escapeHtml(branch.area)}</td>
        <td>${escapeHtml(branch.signal)}</td>
      </tr>
    `);
  }
  const runtimeCount = decisions.counts.runtimeValidationDecisionCount;
  if (runtimeCount > 0) {
    rows.push(`
      <tr>
        <td>${runtimeCount} runtime validation ${plural(runtimeCount, "decision")} pending</td>
        <td>Runtime evidence</td>
        <td>${escapeHtml(decisionGroupSignal(decisions.pendingDecisions, "runtime_validation"))}</td>
      </tr>
    `);
  }
  return rows;
}

function decisionHeadline(decisions: DashboardDecisionReadModel): string {
  const count = decisions.counts.pendingDecisionCount;
  if (count === 0) {
    return "No pending decisions";
  }
  return `${count} pending ${plural(count, "decision")}`;
}

function qaFindingRows(decisions: DashboardDecisionReadModel): string[] {
  const rows: string[] = [];
  const projectCount = decisions.counts.projectFindingDecisionCount;
  if (projectCount > 0) {
    rows.push(`
      <tr>
        <td>Project-level findings</td>
        <td>${projectCount}</td>
        <td>${escapeHtml(decisionGroupSignal(decisions.pendingDecisions, "project_finding"))}</td>
      </tr>
    `);
  }
  for (const branch of groupedBranchDecisions(decisions.pendingDecisions)) {
    rows.push(`
      <tr>
        <td>${escapeHtml(branch.area)}</td>
        <td>${branch.count}</td>
        <td>${escapeHtml(branch.signal)}</td>
      </tr>
    `);
  }
  const runtimeCount = decisions.counts.runtimeValidationDecisionCount;
  if (runtimeCount > 0) {
    rows.push(`
      <tr>
        <td>Runtime validation</td>
        <td>${runtimeCount}</td>
        <td>${escapeHtml(decisionGroupSignal(decisions.pendingDecisions, "runtime_validation"))}</td>
      </tr>
    `);
  }
  return rows;
}

function groupedBranchDecisions(
  pendingDecisions: DashboardPendingDecision[],
): Array<{ area: string; count: number; signal: string }> {
  const groups = new Map<string, { area: string; count: number; signal: string }>();
  for (const decision of pendingDecisions) {
    if (decision.decisionKind !== "locale_branch_finding") {
      continue;
    }
    const area = decision.targetLocale ?? decision.localeBranchId ?? "Locale branch";
    const existing = groups.get(area);
    if (existing === undefined) {
      groups.set(area, {
        area,
        count: 1,
        signal: decision.branchStatus ?? decisionSignal(decision),
      });
      continue;
    }
    existing.count += 1;
  }
  return [...groups.values()];
}

function decisionGroupSignal(
  pendingDecisions: DashboardPendingDecision[],
  decisionKind: DashboardPendingDecision["decisionKind"],
): string {
  const decision = pendingDecisions.find((candidate) => candidate.decisionKind === decisionKind);
  return decision === undefined ? "pending" : decisionSignal(decision);
}

function decisionSignal(decision: DashboardPendingDecision): string {
  if (decision.decisionKind === "runtime_validation") {
    return decision.runtimeStatus ?? decision.branchStatus ?? "pending";
  }
  return decision.qualityCategory ?? decision.severity;
}

function panel(id: string, title: string, body: string): string {
  return `
    <section class="panel" id="${id}" aria-label="${escapeHtml(title)}">
      <header class="panel-header">
        <h2>${escapeHtml(title)}</h2>
      </header>
      ${body}
    </section>
  `;
}

// ITOTORI-056 — a `panel` variant that stamps the panel's query state on
// the section element (`data-panel-state`) so the four states are
// distinguishable in the DOM. Used by the style-guide, glossary, jobs,
// benchmarks, QA agent metrics, benchmark reports, and Model cost panels.
function statePanel<T>(
  id: string,
  title: string,
  panelState: DashboardPanelState<T>,
  body: string,
): string {
  return `
    <section
      class="panel"
      id="${id}"
      aria-label="${escapeHtml(title)}"
      data-panel-state="${panelState.state}"
    >
      <header class="panel-header">
        <h2>${escapeHtml(title)}</h2>
      </header>
      ${body}
    </section>
  `;
}

// ITOTORI-057 — render the typed API error code + message as an inline
// badge appended to a panel's unavailable notice. Returns an empty string
// when the panel has no typed detail (safe fallback), so the base notice
// stays the only surface and is never decorated with a fabricated code.
function renderApiErrorInline(apiError: DashboardApiErrorDetail | undefined): string {
  if (apiError === undefined || apiError.code === null || apiError.message === null) {
    return "";
  }
  return ` <span class="api-error-inline" data-api-error-code="${escapeHtml(apiError.code)}"><code>${escapeHtml(
    apiError.code,
  )}</code> ${escapeHtml(apiError.message)}</span>`;
}

// ITOTORI-056 — render the state notice for any non-populated panel state.
// Returns `null` when the panel is `populated` so the caller can fall
// through to its data-driven body via `??`. The notices are worded so a
// reviewer can tell "not queried yet" (unknown), "the call failed"
// (unavailable), and "the API answered with nothing" (empty) apart — they
// are never collapsed into a single "empty" string.
//
// ITOTORI-057 — the unavailable notice appends the typed API error code +
// message when the failing response carried a typed body, so a reviewer
// sees the actionable reason inline (e.g. `[forbidden] not permitted`).
function stateNotice(
  panelState: DashboardPanelState<unknown>,
  panelName: string,
  emptyMessage: string,
): string | null {
  switch (panelState.state) {
    case "unknown":
      return `<p class="panel-state panel-state-unknown" role="status" data-panel-state-notice="unknown">${escapeHtml(
        `${panelName} data has not been queried yet.`,
      )}</p>`;
    case "unavailable":
      return `<p class="panel-state panel-state-unavailable" role="alert" data-panel-state-notice="unavailable">${escapeHtml(
        `${panelName} data could not be loaded: ${panelState.error}`,
      )}${renderApiErrorInline(panelState.apiError)}</p>`;
    case "empty":
      return `<p class="panel-state panel-state-empty" data-panel-state-notice="empty">${escapeHtml(
        emptyMessage,
      )}</p>`;
    case "populated":
      return null;
  }
}

function navLink(label: string, id: string): string {
  return `<a href="#${id}">${escapeHtml(label)}</a>`;
}

function emptyText(message: string): string {
  return `<p class="empty-copy">${escapeHtml(message)}</p>`;
}

function statusBadge(value: string): string {
  const tone = value.includes("failed") || value.includes("error") ? "critical" : "neutral";
  return `<span class="badge badge-${tone}">${escapeHtml(value)}</span>`;
}

function progressBar(value: number, max: number): string {
  const percentage = max <= 0 ? 0 : Math.round((value / max) * 100);
  return `
    <div class="progress" aria-label="${percentage}% translated">
      <span style="width: ${Math.max(0, Math.min(100, percentage))}%"></span>
    </div>
  `;
}

function resolveDashboardEndpoints(config: DashboardEndpointConfig): DashboardEndpoints {
  if (typeof config === "string") {
    const origin = endpointOrigin(config);
    if (!origin) {
      return { ...defaultDashboardEndpoints, status: config };
    }
    return {
      projects: `${origin}/api/projects`,
      status: `${origin}/api/projects/status`,
      decisions: `${origin}/api/projects/decisions`,
      reviewerQueue: `${origin}/api/reviewer/queue`,
      cost: `${origin}/api/projects/cost`,
      costDrilldown: `${origin}/api/projects/cost/drilldown`,
      benchmarks: `${origin}/api/projects/benchmarks`,
      runtime: `${origin}/api/runtime/v0.2/status`,
    };
  }
  return { ...defaultDashboardEndpoints, ...config };
}

function emptyReviewerQueue(projectId: string): ReviewerQueueDashboardReadModel {
  return {
    schemaVersion: "reviewer.queue_dashboard.v0.1",
    localeBranchId: projectId,
    generatedAt: new Date(),
    permission: {
      actorUserId: "local-user",
      canReadQueue: true,
      canManageQueue: false,
      denialReasons: [],
    },
    rows: [],
    aggregate: {
      pending: 0,
      resolved: 0,
      deferred: 0,
      escalated: 0,
      batch_applied: 0,
    },
    defaultBatchRequest: {
      action: "approve",
      actorUserId: "local-user",
      selections: [],
    },
  };
}

function withQueryParam(endpoint: string, key: string, value: string | null): string {
  if (value === null) {
    return endpoint;
  }
  const base =
    typeof window === "undefined" || window.location.href === "about:blank"
      ? "http://itotori.test"
      : window.location.href;
  const url = new URL(endpoint, base);
  url.searchParams.set(key, value);
  if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) {
    return url.toString();
  }
  return `${url.pathname}${url.search}`;
}

function endpointOrigin(endpoint: string): string | null {
  try {
    const base =
      typeof window === "undefined" || window.location.href === "about:blank"
        ? "http://itotori.test"
        : window.location.href;
    return new URL(endpoint, base).origin;
  } catch {
    return null;
  }
}

function assertDecisionReadMatchesStatus(
  status: ProjectDashboardStatus,
  decisions: DashboardDecisionReadModel,
): void {
  if (decisions.projectId !== status.projectId) {
    throw new Error(
      `decision read project ${decisions.projectId} does not match status project ${status.projectId}`,
    );
  }
  if (decisions.counts.pendingDecisionCount > status.findingCount) {
    throw new Error("pending decision count exceeds project finding count");
  }
}

function resolveUrl(endpoint: string): string {
  if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) {
    return endpoint;
  }
  return endpoint;
}

function formatMicrosUsd(value: number | null): string {
  if (value === null) {
    return "unknown";
  }
  return `$${(value / 1_000_000).toFixed(6)}`;
}

function formatSignedMicrosUsd(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${(Math.abs(value) / 1_000_000).toFixed(6)}`;
}

function formatRatio(value: number): string {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  return `${(value * 100).toFixed(1)}%`;
}

function formatTokens(value: number | null): string {
  return value === null ? "unknown" : String(value);
}

function formatFallback(run: ProjectCostReport["recentRuns"][number]): string {
  if (!run.fallbackUsed) {
    return "none";
  }
  return escapeHtml(run.fallbackPlan.join(" -> "));
}

function formatDataPolicy(run: ProjectCostReport["recentRuns"][number]): string {
  // ITOTORI-227 — itotori's per-pair privacy registry was deleted;
  // privacy is enforced account-wide (ZDR posture asserted at startup)
  // plus per-request (`provider.zdr=true` for non-public input).
  // ITOTORI-230 — render the captured `routing_posture` posture
  // verbatim so the dashboard reflects the wire-level evidence rather
  // than a fixed string. Pre-migration sentinel rows render as
  // "pre-ITOTORI-230 (no captured posture)" so the operator can spot
  // unverifiable historical rows.
  const posture = run.routingPosture;
  if (posture._pre_itotori_230 === true) {
    return escapeHtml("pre-ITOTORI-230 (no captured posture)");
  }
  const zdr = posture.zdr === true ? "zdr=true" : "zdr=false";
  const dataCollection =
    typeof posture.data_collection === "string"
      ? `data_collection=${posture.data_collection}`
      : "data_collection=?";
  return escapeHtml(`${zdr}; ${dataCollection}`);
}

function formatDiff(diff: ProjectDashboardStatus["importStatus"]["units"], total: number): string {
  return `${total} (${diff.added} new / ${diff.updated} updated / ${diff.removed} removed)`;
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function dashboardStyles(): string {
  return `
    <style>
      :root {
        color: #182026;
        background: #f6f7f7;
        font-family:
          Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
          sans-serif;
      }

      body {
        margin: 0;
      }

      .itotori-shell {
        min-height: 100vh;
        padding: 24px;
        background: #f6f7f7;
        color: #182026;
      }

      .shell-header {
        display: grid;
        grid-template-columns: minmax(220px, 1fr) minmax(280px, 2fr);
        gap: 20px;
        align-items: start;
        margin-bottom: 18px;
      }

      .eyebrow {
        margin: 0 0 6px;
        color: #56636d;
        font-size: 0.78rem;
        font-weight: 700;
        letter-spacing: 0;
        text-transform: uppercase;
      }

      h1,
      h2 {
        margin: 0;
        letter-spacing: 0;
      }

      h1 {
        font-size: 1.75rem;
        line-height: 1.2;
      }

      h2 {
        font-size: 1.05rem;
        line-height: 1.3;
      }

      .status-strip {
        display: grid;
        grid-template-columns: repeat(6, minmax(96px, 1fr));
        gap: 1px;
        margin: 0;
        overflow: hidden;
        border: 1px solid #d8dee2;
        border-radius: 8px;
        background: #d8dee2;
      }

      .status-strip div,
      .metric-list div {
        padding: 12px;
        background: #ffffff;
      }

      dt {
        color: #56636d;
        font-size: 0.76rem;
        font-weight: 700;
      }

      dd {
        margin: 4px 0 0;
        font-weight: 700;
      }

      .workbench-nav {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 18px;
      }

      .workbench-nav a {
        display: inline-flex;
        min-height: 34px;
        align-items: center;
        border: 1px solid #c9d0d6;
        border-radius: 8px;
        padding: 0 12px;
        background: #ffffff;
        color: #24313a;
        font-size: 0.9rem;
        font-weight: 700;
        text-decoration: none;
      }

      .decision-band,
      .state-panel {
        margin-bottom: 18px;
        border: 1px solid #d7ddd1;
        border-radius: 8px;
        padding: 18px;
        background: #f9fbf4;
      }

      .decision-band {
        display: grid;
        grid-template-columns: minmax(220px, 0.55fr) minmax(320px, 1fr);
        gap: 16px;
        align-items: start;
      }

      .state-panel {
        max-width: 720px;
      }

      .state-panel-error {
        border-color: #e4beb8;
        background: #fff8f7;
      }

      pre {
        overflow: auto;
        border: 1px solid #e4beb8;
        border-radius: 8px;
        padding: 12px;
        background: #ffffff;
      }

      .section-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 16px;
      }

      .panel {
        min-width: 0;
        border: 1px solid #d8dee2;
        border-radius: 8px;
        padding: 16px;
        background: #ffffff;
      }

      .panel-header {
        margin-bottom: 12px;
      }

      .metric-list {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 1px;
        margin: 0 0 12px;
        overflow: hidden;
        border: 1px solid #d8dee2;
        border-radius: 8px;
        background: #d8dee2;
      }

      .metric-list-compact {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }

      table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
        font-size: 0.9rem;
      }

      th,
      td {
        border-bottom: 1px solid #e7ebee;
        padding: 10px 8px;
        text-align: left;
        vertical-align: top;
        overflow-wrap: anywhere;
      }

      th {
        color: #56636d;
        font-size: 0.76rem;
        font-weight: 800;
      }

      tr:last-child td {
        border-bottom: 0;
      }

      .badge {
        display: inline-flex;
        max-width: 100%;
        min-height: 24px;
        align-items: center;
        border-radius: 999px;
        padding: 0 8px;
        font-size: 0.78rem;
        font-weight: 800;
        line-height: 1.2;
        overflow-wrap: anywhere;
      }

      .badge-neutral {
        background: #eef3f7;
        color: #26333c;
      }

      .badge-critical {
        background: #ffe7e1;
        color: #8a2e1c;
      }

      .progress {
        width: 100%;
        height: 10px;
        overflow: hidden;
        border-radius: 999px;
        background: #e4e8eb;
      }

      .progress span {
        display: block;
        height: 100%;
        background: #2f7d68;
      }

      .progress-over span {
        background: #b4402c;
      }

      .cost-target {
        margin-bottom: 12px;
      }

      .qa-fp {
        color: #8a2e1c;
        font-weight: 800;
      }

      .qa-fn {
        color: #8a5a1c;
        font-weight: 800;
      }

      .report-drilldown {
        margin-bottom: 12px;
        border: 1px solid #d8dee2;
        border-radius: 8px;
        padding: 12px;
        background: #fbfcfd;
      }

      .report-drilldown summary {
        cursor: pointer;
        font-weight: 800;
      }

      .empty-copy {
        margin: 0;
        color: #56636d;
      }

      /* ITOTORI-056 — panel query-state notices. Each state gets a distinct
         tone so a reviewer can tell unknown / unavailable / empty apart at
         a glance; they are never collapsed to the same "empty" styling. */
      .panel-state {
        margin: 0;
        font-weight: 700;
      }

      .panel-state-unknown {
        color: #56636d;
      }

      .panel-state-unavailable {
        color: #8a2e1c;
      }

      .panel-state-empty {
        color: #56636d;
        font-weight: 400;
      }

      .panel-state-inline {
        color: #8a2e1c;
        font-weight: 800;
      }

      /* ITOTORI-057 — typed API error rendering. The actionable code +
         message render distinctly from the generic route/status fallback so
         a reviewer can act on a typed [forbidden] reason instead of an
         opaque HTTP status. */
      .api-error-detail {
        margin: 0 0 8px;
        display: flex;
        gap: 8px;
        align-items: baseline;
        color: #8a2e1c;
        font-weight: 700;
      }

      .api-error-detail-fallback {
        color: #56636d;
        font-weight: 400;
      }

      .api-error-code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.82rem;
        background: #ffe7e1;
        border-radius: 4px;
        padding: 1px 6px;
      }

      .api-error-inline {
        color: #8a2e1c;
        font-weight: 700;
      }

      .api-error-inline code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.82rem;
        background: #ffe7e1;
        border-radius: 4px;
        padding: 1px 6px;
      }

      @media (max-width: 920px) {
        .shell-header,
        .decision-band,
        .section-grid {
          grid-template-columns: 1fr;
        }

        .status-strip,
        .metric-list,
        .metric-list-compact {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }

      @media (max-width: 560px) {
        .itotori-shell {
          padding: 16px;
        }

        .status-strip,
        .metric-list,
        .metric-list-compact {
          grid-template-columns: 1fr;
        }
      }
    </style>
  `;
}

// KAIFUU-053: dashboard surface for the capability-leveled engine
// detector registry. Renders one row per adapter with an "Identified
// only" badge when extract is not Supported, plus per-rung typed
// statuses so consumers can distinguish identification from usability
// (acceptance criterion 3). The renderer is pure / dependency-free so
// it can be unit-tested without the DOM.
export type EngineCapabilityRow = {
  adapterId: string;
  badge: "supported" | "partial" | "unsupported" | "identify_only" | "unknown";
  identify: {
    kind: "supported" | "partial" | "unsupported";
    reason?: string;
    limitations?: string[];
  };
  inventory: {
    kind: "supported" | "partial" | "unsupported";
    reason?: string;
    limitations?: string[];
  };
  extract: {
    kind: "supported" | "partial" | "unsupported";
    reason?: string;
    limitations?: string[];
  };
  patch: { kind: "supported" | "partial" | "unsupported"; reason?: string; limitations?: string[] };
  evidence?: AdapterCapabilityEvidenceSummary;
};

export function renderEngineCapabilityRows(rows: ReadonlyArray<EngineCapabilityRow>): string {
  if (rows.length === 0) {
    return panel(
      "engine-capabilities",
      "Engine adapters",
      emptyText("No engine capability reports recorded yet."),
    );
  }
  const body = rows
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(row.adapterId)}</td>
          <td>${engineBadge(row.badge)}</td>
          <td>${renderEngineStatus(row.identify)}</td>
          <td>${renderEngineStatus(row.inventory)}</td>
          <td>${renderEngineStatus(row.extract)}</td>
          <td>${renderEngineStatus(row.patch)}</td>
          <td>${renderPublicFixtureEvidence(row.evidence)}</td>
          <td>${renderPrivateLocalAggregateEvidence(row.evidence)}</td>
        </tr>
      `,
    )
    .join("");
  return panel(
    "engine-capabilities",
    "Engine adapters",
    `
      <table>
        <thead>
          <tr>
            <th>Adapter</th>
            <th>Badge</th>
            <th>Identify</th>
            <th>Inventory</th>
            <th>Extract</th>
            <th>Patch</th>
            <th>Public fixture support</th>
            <th>Private-local aggregate evidence</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    `,
  );
}

function engineBadge(badge: EngineCapabilityRow["badge"]): string {
  const labels: Record<EngineCapabilityRow["badge"], { text: string; tone: string }> = {
    supported: { text: "Supported", tone: "neutral" },
    partial: { text: "Partial extract", tone: "neutral" },
    identify_only: { text: "Identified only", tone: "critical" },
    unsupported: { text: "Unsupported", tone: "critical" },
    unknown: { text: "Unknown", tone: "neutral" },
  };
  const { text, tone } = labels[badge];
  return `<span class="badge badge-${tone}">${escapeHtml(text)}</span>`;
}

function renderEngineStatus(status: EngineCapabilityRow["identify"]): string {
  switch (status.kind) {
    case "supported":
      return `<span class="badge badge-neutral">Supported</span>`;
    case "partial": {
      const detail = (status.limitations ?? []).join("; ");
      return `<span class="badge badge-neutral" title="${escapeHtml(detail)}">Partial</span>`;
    }
    case "unsupported": {
      const detail = status.reason ?? "";
      return `<span class="badge badge-critical" title="${escapeHtml(detail)}">Unsupported</span>`;
    }
  }
}

function renderPublicFixtureEvidence(evidence: AdapterCapabilityEvidenceSummary | undefined) {
  const publicFixture = (evidence ?? emptyDashboardCapabilityEvidence()).publicFixture;
  if (!publicFixture.present) {
    return `<span class="muted">No public fixture evidence</span>`;
  }
  const detailParts = [
    publicFixture.fixtureIds.length > 0
      ? `fixtures=${publicFixture.fixtureIds.join(", ")}`
      : undefined,
    publicFixture.evidenceKinds.length > 0
      ? `kinds=${publicFixture.evidenceKinds.join(", ")}`
      : undefined,
    publicFixture.limitations.length > 0
      ? `limitations=${publicFixture.limitations.join("; ")}`
      : undefined,
  ].filter((part): part is string => part !== undefined);
  const title = detailParts.length > 0 ? ` title="${escapeHtml(detailParts.join(" | "))}"` : "";
  return `<span class="badge badge-neutral"${title}>Public fixture evidence</span>`;
}

function renderPrivateLocalAggregateEvidence(
  evidence: AdapterCapabilityEvidenceSummary | undefined,
) {
  const privateLocal = (evidence ?? emptyDashboardCapabilityEvidence()).privateLocalAggregate;
  if (!privateLocal.present) {
    return `<span class="muted">No private-local aggregate evidence</span>`;
  }
  const counts = [
    `corpora=${privateLocal.corpusCount}`,
    `entries=${privateLocal.entryCount}`,
    ...Object.entries(privateLocal.aggregateCounts)
      .filter(([key]) => key !== "corpusCount" && key !== "entryCount")
      .map(([key, value]) => `${key}=${value}`),
  ];
  const details = [
    counts.join(" "),
    privateLocal.markerKinds.length > 0 ? `labels=${privateLocal.markerKinds.join(", ")}` : "",
    privateLocal.limitations.length > 0 ? `limitations=${privateLocal.limitations.join("; ")}` : "",
  ]
    .filter((part) => part.length > 0)
    .join(" | ");
  const label =
    privateLocal.entryCount > 0
      ? `Private-local aggregate (${privateLocal.entryCount})`
      : "Private-local aggregate";
  return `<span class="badge badge-neutral" title="${escapeHtml(details)}">${escapeHtml(label)}</span>`;
}

function emptyDashboardCapabilityEvidence(): AdapterCapabilityEvidenceSummary {
  return {
    publicFixture: {
      present: false,
      fixtureIds: [],
      evidenceKinds: [],
      levels: {
        identify: "unknown",
        inventory: "unknown",
        extract: "unknown",
        patch: "unknown",
      },
      limitations: [],
    },
    privateLocalAggregate: {
      present: false,
      corpusCount: 0,
      entryCount: 0,
      markerKinds: [],
      aggregateCounts: {},
      levels: {
        identify: "unknown",
        inventory: "unknown",
        extract: "unknown",
        patch: "unknown",
      },
      limitations: [],
    },
  };
}
