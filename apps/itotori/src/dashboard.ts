import type {
  DashboardDecisionReadModel,
  DashboardPendingDecision,
  ProjectCostReport,
  ProjectDashboardStatus,
  RuntimeDashboardStatus,
} from "@itotori/db";
import {
  assertDashboardDecisionReadModel,
  assertItotoriApiResponse,
  assertProjectDashboardStatus,
  type ApiProjectsResponse,
  type ItotoriApiRouteId,
} from "./api-schema.js";
import {
  loadStyleGuideContext,
  renderStyleGuideBuilderPanel,
  styleGuideBuilderStyles,
  type StyleGuideBuilderContext,
} from "./style-guide-builder.js";

export type DashboardEndpoints = {
  projects: string;
  status: string;
  decisions: string;
  cost: string;
  runtime: string;
};

export type DashboardEndpointConfig = Partial<DashboardEndpoints> | string;

type DashboardReadRouteId =
  | "projects.list"
  | "projects.status"
  | "projects.decisions"
  | "projects.cost"
  | "runtime.status";

type DashboardReadResponses = {
  "projects.list": ApiProjectsResponse;
  "projects.status": ProjectDashboardStatus;
  "projects.decisions": DashboardDecisionReadModel;
  "projects.cost": ProjectCostReport;
  "runtime.status": RuntimeDashboardStatus;
};

type DashboardData =
  | {
      state: "ready";
      projects: ProjectDashboardStatus[];
      status: ProjectDashboardStatus;
      decisions: DashboardDecisionReadModel;
      cost: ProjectCostReport;
      runtime: RuntimeDashboardStatus;
      styleGuide: StyleGuideBuilderContext;
    }
  | {
      state: "empty";
      projects: ProjectDashboardStatus[];
    };

const defaultDashboardEndpoints: DashboardEndpoints = {
  projects: "/api/projects",
  status: "/api/projects/status",
  decisions: "/api/projects/decisions",
  cost: "/api/projects/cost",
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

  const [status, decisions, cost, runtime] = await Promise.all([
    fetchApi("projects.status", endpoints.status),
    fetchApi("projects.decisions", endpoints.decisions),
    fetchApi("projects.cost", endpoints.cost),
    fetchApi("runtime.status", endpoints.runtime),
  ]);
  assertDecisionReadMatchesStatus(status, decisions);
  const styleGuide = await loadStyleGuideContext(styleGuideInputFromStatus(status));

  return {
    state: "ready",
    projects: projectsResponse.projects,
    status,
    decisions,
    cost,
    runtime,
    styleGuide,
  };
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
    throw new Error(`failed to load ${routeId}: ${response.status}`);
  }
  const body = await response.json();
  assertItotoriApiResponse(routeId as ItotoriApiRouteId, body);
  return body as DashboardReadResponses[RouteId];
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
        <pre>${escapeHtml(message)}</pre>
      </section>
    </main>
  `;
}

function renderWorkbench(
  root: HTMLElement,
  data: Extract<DashboardData, { state: "ready" }>,
): void {
  const { status, cost, runtime, projects } = data;
  const { decisions, styleGuide } = data;
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
        ${navLink("Pending decisions", "pending-decisions")}
        ${navLink("Runtime evidence", "runtime-evidence")}
        ${navLink("Benchmarks", "benchmarks")}
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
        ${renderStyleGuide(styleGuide)}
        ${renderGlossary()}
        ${renderJobs(cost)}
        ${renderQaFindings(decisions)}
        ${renderRuntimeEvidence(runtime)}
        ${renderBenchmarks(cost, status)}
        ${renderCost(cost)}
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

function renderStyleGuide(context: StyleGuideBuilderContext): string {
  return panel("style-guide", "Style guide", renderStyleGuideBuilderPanel(context));
}

function renderGlossary(): string {
  return panel("glossary", "Glossary", emptyText("No glossary entries were returned by the API."));
}

function renderJobs(cost: ProjectCostReport): string {
  if (cost.recentRuns.length === 0) {
    return panel("jobs", "Jobs", emptyText("No job or provider runs were returned by the API."));
  }
  const rows = cost.recentRuns
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
  return panel(
    "jobs",
    "Jobs",
    `
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
    `,
  );
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

function renderRuntimeEvidence(runtime: RuntimeDashboardStatus): string {
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
        <div><dt>Frames</dt><dd>${runtime.frameCaptureCount}</dd></div>
        <div><dt>Screenshots</dt><dd>${runtime.screenshotArtifactCount}</dd></div>
        <div><dt>Recordings</dt><dd>${runtime.recordingArtifactCount}</dd></div>
      </dl>
    `,
  );
}

function renderBenchmarks(cost: ProjectCostReport, status: ProjectDashboardStatus): string {
  const benchmarkRuns = cost.recentRuns.filter((run) => run.taskKind.includes("benchmark"));
  if (benchmarkRuns.length === 0) {
    return panel(
      "benchmarks",
      "Benchmarks",
      emptyText(
        status.latestEventKind?.includes("benchmark") === true
          ? `Latest benchmark event: ${status.latestEventKind}`
          : "No benchmark runs were returned by the API.",
      ),
    );
  }
  const rows = benchmarkRuns
    .map(
      (run) => `
        <tr>
          <td>${escapeHtml(run.taskKind)}</td>
          <td>${statusBadge(run.status)}</td>
          <td>${escapeHtml(run.promptPresetId)}@${escapeHtml(run.promptTemplateVersion)}</td>
          <td>${run.retryCount}</td>
          <td>${formatFallback(run)}</td>
          <td>${formatDataPolicy(run)}</td>
          <td>${formatMicrosUsd(run.amountMicrosUsd)}</td>
        </tr>
      `,
    )
    .join("");
  return panel(
    "benchmarks",
    "Benchmarks",
    `
      <table>
        <thead>
          <tr>
            <th>Run</th>
            <th>Status</th>
            <th>Prompt</th>
            <th>Retries</th>
            <th>Fallback</th>
            <th>Data policy</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `,
  );
}

function renderCost(cost: ProjectCostReport): string {
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
  return panel(
    "cost",
    "Model cost",
    `
      <dl class="metric-list metric-list-compact">
        <div><dt>Billed</dt><dd>${formatMicrosUsd(cost.billedMicrosUsd)}</dd></div>
        <div><dt>Estimated</dt><dd>${formatMicrosUsd(cost.estimatedMicrosUsd)}</dd></div>
        <div><dt>Runs</dt><dd>${cost.runCount}</dd></div>
        <div><dt>Unknown</dt><dd>${cost.unknownRunCount}</dd></div>
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
    `,
  );
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
      cost: `${origin}/api/projects/cost`,
      runtime: `${origin}/api/runtime/v0.2/status`,
    };
  }
  return { ...defaultDashboardEndpoints, ...config };
}

function styleGuideInputFromStatus(status: ProjectDashboardStatus) {
  const localeBranchId = status.localeBranches[0]?.localeBranchId ?? "locale-1";
  return {
    localeBranchId,
    policyVersionId: "019ed065-0000-7000-8000-000000000020",
    fixtureState: "empty_policy" as const,
    permissionProfile: "reviewer" as const,
  };
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
  const dataCollection = stringValue(run.dataHandling.dataCollection) ?? "unknown";
  const trainingUse = stringValue(run.dataHandling.trainingUse) ?? "unknown";
  const inputOutputLogging = stringValue(run.accountPrivacy?.inputOutputLogging);
  const policy = `collection:${dataCollection} training:${trainingUse}`;
  return escapeHtml(
    inputOutputLogging === undefined ? policy : `${policy} io:${inputOutputLogging}`,
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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

      .empty-copy {
        margin: 0;
        color: #56636d;
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
