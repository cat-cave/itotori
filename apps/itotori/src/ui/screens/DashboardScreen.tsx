// fnd-spa-shell — the Workbench dashboard screen.
//
// Parity port of the deleted HTML-string `dashboard.ts` workbench for the
// panels: Projects, project Status (the summary strip), Model cost, open QA
// findings, and iteration telemetry. Every panel
// consumes `/api/*` THROUGH the typed client (`useApiQuery`) and settles into
// loading / empty / error / populated independently, so one failed read
// degrades only its panel — never the whole dashboard, and never shows an
// unqueried read as a confirmed empty. Rendered with `@itotori/ds`
// components (Panel / DataTable / StatReadout / ProgressBar / Badge), no
// bespoke HTML strings.

import type { ReactNode } from "react";
import type {
  ProjectDashboardStatus,
} from "@itotori/db";
import { Badge, DataTable, Pagination, Panel } from "@itotori/ds";
import type { ApiCallState } from "../../api-client.js";
import type {
  ApiDashboardDecisionsResponse,
  ApiJobsRunTableResponse,
  ApiProjectsResponse,
  JobsRunTableRow,
} from "../../api-schema.js";
import { useApiQuery, usePolledApiQuery } from "../use-api-resource.js";
import { useOffsetPager } from "../use-offset-pager.js";
import { decisionGroupSignal, groupedBranchDecisions } from "../format.js";
import { EmptyState, ErrorState, LoadingState, ShellHeader } from "../states.js";
import { VirtualList } from "../virtual-list.js";
import { CostDrilldownPanel } from "./CostDrilldownPanel.js";
import { QaFindingsBand } from "./DecisionsBand.js";
import { PassLedgerPanel } from "./PassLedgerPanel.js";
import { PORTFOLIO_PROGRESS_POLL_MS, PortfolioProgressPanel } from "./PortfolioProgressPanel.js";
import { ProgressInstrumentPanel } from "./ProgressInstrumentPanel.js";
import { CatalogOpportunitiesPanel } from "./DashboardCatalogOpportunitiesPanel.js";

const DASHBOARD_JOBS_PAGE_SIZE = 100;

export function DashboardScreen(): ReactNode {
  // Live portfolio: poll `projects.list` so concurrent project progress advances
  // without a manual refresh. Sibling panels share the same polled state.
  const projects = usePolledApiQuery("projects.list", {}, "projects", PORTFOLIO_PROGRESS_POLL_MS);
  const status = useApiQuery("projects.status", {}, "status");
  const decisions = useApiQuery("projects.decisions", {}, "decisions");
  const cost = useApiQuery("projects.cost", {}, "cost");
  const overview = useApiQuery("projects.overview", {}, "dashboard:overview-telemetry");
  const opportunities = useApiQuery(
    "catalog.opportunities",
    { query: { includeDemoted: true, limit: 5 } },
    "catalog.opportunities:dashboard-panel",
  );

  return (
    <main className="itotori-shell" data-screen="dashboard" data-state={projects.state}>
      <ShellHeader eyebrow="Workbench" title="Itotori dashboard">
        <StatusStrip status={status} decisions={decisions} />
      </ShellHeader>

      {/* xs-loop-spine-ui — the iterative-loop spine, visible end-to-end
          (flag → correct → iterate → launch → rescore → confidence) at the
          top of the overview so the whole handoff chain is legible at a
          glance. Read-only legibility; the detailed panels follow. */}

      <FirstRunPanel projects={projects} />

      <PortfolioProgressPanel projects={projects} />

      <QaFindingsBand />

      <ProgressInstrumentPanel />

      <PassLedgerPanel />

      <section className="itotori-section-grid" aria-label="Dashboard sections">
        <ProjectsPanel projects={projects} />
        <CatalogOpportunitiesPanel opportunities={opportunities} />
        <JobsRunTablePanel status={status} />
        <CostDrilldownPanel cost={cost} overview={overview} />
        <QaFindingsPanel decisions={decisions} />
      </section>
    </main>
  );
}

function FirstRunPanel({ projects }: { projects: ApiCallState<ApiProjectsResponse> }): ReactNode {
  const projectCount = projects.state === "ready" ? projects.data.projects.length : 0;
  const copy =
    projects.state === "loading"
      ? "Checking whether this workspace already has a project."
      : projects.state === "error"
        ? "Project inventory is unavailable; the guided setup can still show the required dashboard steps."
        : projectCount === 0
          ? "No projects are visible yet. Start here to set up the account, create a project, set a locale branch, and open the workspace."
          : "Open the guided path any time to create another project or set the next locale branch.";
  return (
    <Panel title="Guided first run" eyebrow="Setup" className="itotori-panel--first-run">
      <p>{copy}</p>
      <p>
        <a href="/onboarding">Start guided setup</a>
      </p>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Status summary strip (the project shell context header)
// ---------------------------------------------------------------------------

function StatusStrip({
  status,
  decisions,
}: {
  status: ApiCallState<ProjectDashboardStatus>;
  decisions: ApiCallState<ApiDashboardDecisionsResponse>;
}): ReactNode {
  if (status.state !== "ready") {
    return null;
  }
  const s = status.data;
  const openQa = decisions.state === "ready" ? decisions.data.counts.pendingDecisionCount : null;
  return (
    <dl className="itotori-status-strip" aria-label="Project summary">
      <div>
        <dt>Project</dt>
        <dd>{s.name}</dd>
      </div>
      <div>
        <dt>Status</dt>
        <dd>
          <Badge status={s.status} />
        </dd>
      </div>
      <div>
        <dt>Source</dt>
        <dd>{s.sourceLocale}</dd>
      </div>
      <div>
        <dt>Branches</dt>
        <dd>{s.branchCount}</dd>
      </div>
      <div>
        <dt>Open QA</dt>
        <dd>{openQa ?? "—"}</dd>
      </div>
      <div>
        <dt>Latest event</dt>
        <dd>{s.latestEventKind ?? "none"}</dd>
      </div>
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Projects panel
// ---------------------------------------------------------------------------

function ProjectsPanel({ projects }: { projects: ApiCallState<ApiProjectsResponse> }): ReactNode {
  return (
    <Panel title="Projects" eyebrow="Portfolio" className="itotori-panel--projects">
      {projects.state === "loading" && <LoadingState label="Loading projects…" />}
      {projects.state === "empty" && (
        <EmptyState title="No projects" message="No projects were returned by the API." />
      )}
      {projects.state === "error" && <ErrorState title="Projects" error={projects.error} />}
      {projects.state === "ready" && (
        <DataTable
          caption="Projects"
          columns={[
            { key: "name", header: "Project", render: (p) => p.name },
            { key: "key", header: "Key", render: (p) => <code>{p.projectKey}</code> },
            { key: "status", header: "Status", render: (p) => <Badge status={p.status} /> },
            { key: "source", header: "Source", render: (p) => p.sourceLocale },
            { key: "branches", header: "Branches", align: "end", render: (p) => p.branchCount },
            { key: "findings", header: "Findings", align: "end", render: (p) => p.findingCount },
          ]}
          rows={projects.data.projects}
          getRowKey={(p) => p.projectId}
        />
      )}
    </Panel>
  );
}

function JobsRunTablePanel({
  status,
}: {
  status: ApiCallState<ProjectDashboardStatus>;
}): ReactNode {
  if (status.state === "loading") {
    return (
      <Panel title="Jobs" eyebrow="Run table">
        <LoadingState label="Loading project context…" />
      </Panel>
    );
  }
  if (status.state === "error") {
    return (
      <Panel title="Jobs" eyebrow="Run table">
        <ErrorState title="Jobs" error={status.error} />
      </Panel>
    );
  }
  const projectId = status.state === "ready" ? status.data.projectId : null;
  if (projectId === null) {
    return (
      <Panel title="Jobs" eyebrow="Run table">
        <EmptyState title="Jobs" message="No project is selected for the jobs run table." />
      </Panel>
    );
  }
  return <JobsRunTableBody projectId={projectId} />;
}

function JobsRunTableBody({ projectId }: { projectId: string }): ReactNode {
  const pager = useOffsetPager(
    "jobs.runTable",
    { query: { projectId }, limit: DASHBOARD_JOBS_PAGE_SIZE },
    `jobs.runTable:${projectId}`,
  );
  const page = pager.page;
  return (
    <Panel title="Jobs" eyebrow="Run table">
      {page === null ? (
        pager.phase === "error" && pager.error !== null ? (
          <ErrorState title="Jobs" error={pager.error} />
        ) : (
          <LoadingState label="Loading jobs…" />
        )
      ) : page.data.rows.length === 0 && page.data.pagination.total === 0 ? (
        <EmptyState title="Jobs" message="No job runs were returned by the API." />
      ) : (
        <JobsRunTableContent page={page.data} pager={pager} />
      )}
    </Panel>
  );
}

function JobsRunTableContent({
  page,
  pager,
}: {
  page: ApiJobsRunTableResponse;
  pager: ReturnType<typeof useOffsetPager<"jobs.runTable">>;
}): ReactNode {
  return (
    <>
      <VirtualList
        ariaLabel="Jobs run table virtualized rows"
        items={page.rows}
        getItemKey={(row) => row.runId}
        itemHeight={108}
        viewportHeight={420}
        renderItem={(row) => <JobsRunTableRowView row={row} />}
      />
      <Pagination
        label="Jobs run table pagination"
        page={Math.max(0, page.pagination.page - 1)}
        pageCount={Math.max(1, page.pagination.pageCount)}
        totalItems={page.pagination.total}
        itemName="run"
        onPrevious={pager.previous}
        onNext={pager.next}
      />
    </>
  );
}

function JobsRunTableRowView({ row }: { row: JobsRunTableRow }): ReactNode {
  return (
    <article className="itotori-virtual-list__row" data-job-run-id={row.runId}>
      <span>
        <span className="itotori-virtual-list__label">Job</span>
        <span className="itotori-virtual-list__value">
          {row.task}
          <br />
          <code>{row.jobId ?? row.runId}</code>
        </span>
      </span>
      <span>
        <span className="itotori-virtual-list__label">Provider / model</span>
        <span className="itotori-virtual-list__value">
          {row.servedProvider}
          <br />
          {row.servedModel}
        </span>
      </span>
      <span>
        <span className="itotori-virtual-list__label">Status</span>
        <span className="itotori-virtual-list__value">
          <Badge status={row.status} />
          <br />
          {row.createdAt}
        </span>
      </span>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Model cost — the CostDrilldownPanel (summary + ledger drilldown) lives in
// its own module so the cost surface is one cohesive, independently testable
// panel group. Hosted here with the dashboard's shared `projects.cost` read.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// QA findings panel (the open-findings band lives in DecisionsBand.tsx)
// ---------------------------------------------------------------------------

function QaFindingsPanel({
  decisions,
}: {
  decisions: ApiCallState<ApiDashboardDecisionsResponse>;
}): ReactNode {
  const rows =
    decisions.state === "ready"
      ? [
          decisions.data.counts.projectFindingDecisionCount > 0 && {
            area: "Project-level findings",
            open: decisions.data.counts.projectFindingDecisionCount,
            signal: decisionGroupSignal(decisions.data.pendingDecisions, "project_finding"),
          },
          ...groupedBranchDecisions(decisions.data.pendingDecisions).map((b) => ({
            area: b.area,
            open: b.count,
            signal: b.signal,
          })),
          decisions.data.counts.runtimeValidationDecisionCount > 0 && {
            area: "Runtime validation",
            open: decisions.data.counts.runtimeValidationDecisionCount,
            signal: decisionGroupSignal(decisions.data.pendingDecisions, "runtime_validation"),
          },
        ].filter((r): r is { area: string; open: number; signal: string } => r !== false)
      : [];
  return (
    <Panel title="QA findings" eyebrow="Quality">
      {decisions.state === "loading" && <LoadingState label="Loading QA findings…" />}
      {decisions.state === "error" && <ErrorState title="QA findings" error={decisions.error} />}
      {(decisions.state === "ready" || decisions.state === "empty") &&
        (rows.length === 0 ? (
          <p className="itotori-empty-copy">No open QA findings returned.</p>
        ) : (
          <DataTable
            caption="QA findings"
            columns={[
              { key: "area", header: "Area", render: (r) => r.area },
              { key: "open", header: "Open", align: "end", render: (r) => r.open },
              { key: "signal", header: "Status", render: (r) => <Badge status={r.signal} /> },
            ]}
            rows={rows}
            getRowKey={(r) => r.area}
          />
        ))}
    </Panel>
  );
}
