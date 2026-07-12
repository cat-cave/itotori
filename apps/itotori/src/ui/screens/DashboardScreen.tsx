// fnd-spa-shell — the Workbench dashboard screen.
//
// Parity port of the deleted HTML-string `dashboard.ts` workbench for the
// five panels the acceptance names: Projects, project Status (the summary
// strip), Model cost, the Reviewer queue, and Pending decisions. Every panel
// consumes `/api/*` THROUGH the typed client (`useApiQuery`) and settles into
// loading / empty / error / populated independently, so one failed read
// degrades only its panel — never the whole dashboard, and never shows an
// unqueried read as a confirmed empty. Rendered with `@itotori/ds`
// components (Panel / DataTable / StatReadout / ProgressBar / Badge), no
// bespoke HTML strings.

import type { ReactNode } from "react";
import type {
  CatalogBenchmarkDemandBucket,
  CatalogBenchmarkLocalOwnership,
  CatalogCompletenessPool,
  CatalogOpportunityFactor,
  CatalogOpportunityRankingReadModel,
  CatalogOpportunityRow,
  JobsRunTableRow,
  ProjectDashboardStatus,
} from "@itotori/db";
import { Badge, DataTable, Pagination, Panel, StatReadout } from "@itotori/ds";
import type { ApiCallState } from "../../api-client.js";
import type {
  ApiDashboardDecisionsResponse,
  ApiJobsRunTableResponse,
  ApiProjectsResponse,
  ApiReviewerQueueDashboardResponse,
} from "../../api-schema.js";
import { useApiQuery } from "../use-api-resource.js";
import { useSelectedLocaleBranch } from "../use-selected-locale-branch.js";
import { useOffsetPager } from "../use-offset-pager.js";
import { decisionGroupSignal, groupedBranchDecisions } from "../format.js";
import { EmptyState, ErrorState, LoadingState, ShellHeader } from "../states.js";
import { VirtualList } from "../virtual-list.js";
import { BenchmarkHeadlineTile } from "./BenchmarkHeadlineTile.js";
import { CostDrilldownPanel } from "./CostDrilldownPanel.js";
import { DecisionsBand } from "./DecisionsBand.js";
import { LoopSpinePanel } from "./LoopSpinePanel.js";
import { PassLedgerPanel } from "./PassLedgerPanel.js";
import { ProgressInstrumentPanel } from "./ProgressInstrumentPanel.js";

const DASHBOARD_REVIEWER_QUEUE_PAGE_SIZE = 50;
const DASHBOARD_JOBS_PAGE_SIZE = 100;

export function DashboardScreen(): ReactNode {
  const projects = useApiQuery("projects.list", {}, "projects");
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
          (flag → decide → correct → launch → rescore → confidence) at the
          top of the overview so the whole handoff chain is legible at a
          glance. Read-only legibility; the detailed panels follow. */}
      <LoopSpinePanel />

      <FirstRunPanel projects={projects} />

      <DecisionsBand />

      <ProgressInstrumentPanel />

      <PassLedgerPanel />

      <BenchmarkHeadlineTile />

      <section className="itotori-section-grid" aria-label="Dashboard sections">
        <ProjectsPanel projects={projects} />
        <CatalogOpportunitiesPanel opportunities={opportunities} />
        <ReviewerQueuePanel status={status} />
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

// ---------------------------------------------------------------------------
// Catalog opportunities panel — compact dashboard view backed by the same
// aggregate-safe read model as /catalog.
// ---------------------------------------------------------------------------

const DEMAND_BUCKET_LABELS: Readonly<Record<CatalogBenchmarkDemandBucket, string>> = {
  very_high: "Very high",
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "None",
};

const OWNERSHIP_LABELS: Readonly<Record<CatalogBenchmarkLocalOwnership, string>> = {
  owned: "Owned",
  not_owned: "Not owned",
  unknown: "Unknown",
};

const COMPLETENESS_LABELS: Readonly<Record<CatalogCompletenessPool, string>> = {
  no_english: "No English",
  mtl_only: "MTL only",
  fan_partial: "Fan partial",
  unknown: "Unknown",
  conflict: "Conflict",
};

const COMPLETENESS_STATUS: Readonly<Record<CatalogCompletenessPool, string>> = {
  no_english: "blocker",
  mtl_only: "warning",
  fan_partial: "warning",
  unknown: "stale",
  conflict: "failed",
};

const opportunityNumberFormatter = new Intl.NumberFormat("en-US");

function CatalogOpportunitiesPanel({
  opportunities,
}: {
  opportunities: ApiCallState<CatalogOpportunityRankingReadModel>;
}): ReactNode {
  return (
    <Panel
      title="Catalog opportunities"
      eyebrow="Project selection"
      className="itotori-panel--catalog-opportunities"
    >
      {opportunities.state === "loading" && (
        <LoadingState label="Loading catalog opportunities..." />
      )}
      {opportunities.state === "empty" && (
        <EmptyState
          title="Catalog opportunities"
          message="No catalog opportunity rows were returned by the API."
        />
      )}
      {opportunities.state === "error" && (
        <ErrorState title="Catalog opportunities" error={opportunities.error} />
      )}
      {opportunities.state === "ready" && (
        <CatalogOpportunitiesContent opportunities={opportunities.data} />
      )}
    </Panel>
  );
}

function CatalogOpportunitiesContent({
  opportunities,
}: {
  opportunities: CatalogOpportunityRankingReadModel;
}): ReactNode {
  const rows = opportunities.rows.slice(0, 5);
  const candidateCount = opportunities.rows.filter((row) => row.decision === "candidate").length;
  const demotedCount = opportunities.rows.filter((row) => row.decision === "demoted").length;
  return (
    <>
      <div className="itotori-metric-row" aria-label="Catalog opportunities aggregate">
        <StatReadout label="Rows" value={opportunities.rows.length} />
        <StatReadout label="Candidates" value={candidateCount} />
        <StatReadout label="Demoted" value={demotedCount} />
        <StatReadout label="Target" value={opportunities.targetLanguage} />
      </div>
      <DataTable
        caption="Catalog opportunity rows"
        columns={[
          {
            key: "work",
            header: "Work",
            render: (row) => (
              <span>
                #{row.rank} {row.canonicalTitle}
                <br />
                <code>{row.workId}</code>
              </span>
            ),
          },
          {
            key: "decision",
            header: "Decision",
            render: (row) => (
              <span>
                <Badge status={row.decision} tone={decisionTone(row.decision)}>
                  {decisionLabel(row.decision)}
                </Badge>
                <br />
                {formatScore(row)}
              </span>
            ),
          },
          {
            key: "engine",
            header: "Engine / readiness",
            render: (row) => (
              <span>
                {row.engineName ?? "Unknown engine"}
                <br />
                {formatReadiness(row)}
              </span>
            ),
          },
          {
            key: "demand",
            header: "Demand / owned",
            render: (row) => (
              <span>
                <Badge status={row.demandFacts.demandBucket}>
                  {DEMAND_BUCKET_LABELS[row.demandFacts.demandBucket]}
                </Badge>{" "}
                <Badge
                  status={row.localOwnership}
                  tone={row.localOwnership === "owned" ? "ok" : "neutral"}
                >
                  {OWNERSHIP_LABELS[row.localOwnership]}
                </Badge>
                <br />
                {formatDemand(row)} / {formatLocalEvidence(row)}
              </span>
            ),
          },
          {
            key: "signals",
            header: "Signals",
            render: (row) => (
              <span>
                <Badge status={COMPLETENESS_STATUS[row.completenessPool]}>
                  {COMPLETENESS_LABELS[row.completenessPool]}
                </Badge>
                <br />
                {formatTopFactors(row)}
                <br />
                {formatDemotion(row)}
              </span>
            ),
          },
        ]}
        rows={rows}
        getRowKey={(row) => row.workId}
        emptyLabel="No catalog opportunities are currently ranked."
      />
      <p>
        <a href="/catalog">Open catalog candidates</a>
      </p>
    </>
  );
}

function decisionTone(decision: CatalogOpportunityRow["decision"]): "neutral" | "ok" | "critical" {
  if (decision === "candidate") {
    return "ok";
  }
  if (decision === "demoted") {
    return "critical";
  }
  return "neutral";
}

function decisionLabel(decision: CatalogOpportunityRow["decision"]): string {
  return decision.charAt(0).toUpperCase() + decision.slice(1);
}

function formatScore(row: CatalogOpportunityRow): string {
  return `Score ${row.score}`;
}

function formatReadiness(row: CatalogOpportunityRow): string {
  return `patch ${row.readiness.patch} / runtime ${row.readiness.runtime}`;
}

function formatDemand(row: CatalogOpportunityRow): string {
  const counts: string[] = [];
  if (row.demandFacts.dlCount !== null) {
    counts.push(`${opportunityNumberFormatter.format(row.demandFacts.dlCount)} DL`);
  }
  if (row.demandFacts.wishlistCount !== null) {
    counts.push(`${opportunityNumberFormatter.format(row.demandFacts.wishlistCount)} wishlists`);
  }
  return counts.length === 0 ? "no public demand counts" : counts.join(", ");
}

function formatLocalEvidence(row: CatalogOpportunityRow): string {
  const unit = row.localEvidenceCount === 1 ? "signal" : "signals";
  return `${row.localEvidenceCount} local ${unit}`;
}

function formatTopFactors(row: CatalogOpportunityRow): string {
  const factors = topContributingFactors(row.factorBreakdown);
  if (factors.length === 0) {
    return "factors: none";
  }
  return `factors: ${factors.map(formatFactorContribution).join(", ")}`;
}

function topContributingFactors(
  factors: readonly CatalogOpportunityFactor[],
): CatalogOpportunityFactor[] {
  return [...factors]
    .filter((factor) => factor.weightedScore !== 0)
    .sort((left, right) => Math.abs(right.weightedScore) - Math.abs(left.weightedScore))
    .slice(0, 2);
}

function formatFactorContribution(factor: CatalogOpportunityFactor): string {
  const signedScore =
    factor.weightedScore > 0 ? `+${factor.weightedScore}` : `${factor.weightedScore}`;
  return `${factor.factor.replaceAll("_", " ")} ${signedScore}`;
}

function formatDemotion(row: CatalogOpportunityRow): string {
  const demotion = row.demotions[0];
  if (demotion === undefined) {
    return "demotion: none";
  }
  return `demotion: ${demotion.reasonCode}`;
}

// ---------------------------------------------------------------------------
// Reviewer queue panel — scoped to the status's selected locale branch
// ---------------------------------------------------------------------------

function ReviewerQueuePanel({
  status,
}: {
  status: ApiCallState<ProjectDashboardStatus>;
}): ReactNode {
  const selected = useSelectedLocaleBranch({
    status,
    depsKey: "dashboard:reviewer-queue:selected-branch",
  });
  if (selected.state === "loading") {
    return (
      <Panel title="Reviewer queue" eyebrow="Human review">
        <LoadingState label="Loading project context…" />
      </Panel>
    );
  }
  if (selected.state === "error") {
    return (
      <Panel title="Reviewer queue" eyebrow="Human review">
        <ErrorState title="Reviewer queue" error={selected.error} />
      </Panel>
    );
  }
  if (selected.state === "empty") {
    return (
      <Panel title="Reviewer queue" eyebrow="Human review">
        <EmptyState
          title="No locale branch selected"
          message="Select a locale branch to scope the reviewer queue."
        />
      </Panel>
    );
  }
  return <ReviewerQueueBody localeBranchId={selected.data.localeBranchId} />;
}

function ReviewerQueueBody({ localeBranchId }: { localeBranchId: string }): ReactNode {
  const queue = useOffsetPager(
    "reviewer.queue",
    { query: { localeBranchId }, limit: DASHBOARD_REVIEWER_QUEUE_PAGE_SIZE },
    `reviewer.queue:${localeBranchId}`,
  );
  return (
    <Panel title="Reviewer queue" eyebrow="Human review">
      <ReviewerQueuePagerContent pager={queue} />
    </Panel>
  );
}

function ReviewerQueuePagerContent({
  pager,
}: {
  pager: ReturnType<typeof useOffsetPager<"reviewer.queue">>;
}): ReactNode {
  const page = pager.page;
  if (page === null) {
    if (pager.phase === "error" && pager.error !== null) {
      return <ErrorState title="Reviewer queue" error={pager.error} />;
    }
    return <LoadingState label="Loading reviewer queue…" />;
  }
  if (page.data.rows.length === 0 && page.data.pagination.total === 0) {
    return (
      <EmptyState
        title="Reviewer queue"
        message="No reviewer queue items were returned by the API."
      />
    );
  }
  return <ReviewerQueueContent queue={page.data} pager={pager} />;
}

function ReviewerQueueContent({
  queue,
  pager,
}: {
  queue: ApiReviewerQueueDashboardResponse;
  pager: ReturnType<typeof useOffsetPager<"reviewer.queue">>;
}): ReactNode {
  return (
    <>
      <div className="itotori-metric-row" aria-label="Reviewer queue aggregate">
        <StatReadout label="Pending" value={queue.aggregate.pending} />
        <StatReadout label="Resolved" value={queue.aggregate.resolved} />
        <StatReadout label="Deferred" value={queue.aggregate.deferred} />
        <StatReadout label="Escalated" value={queue.aggregate.escalated} />
        <StatReadout label="Batch applied" value={queue.aggregate.batch_applied} />
      </div>
      <VirtualList
        ariaLabel="Dashboard reviewer queue virtualized rows"
        items={queue.rows}
        getItemKey={(row) => row.reviewItemId}
        itemHeight={96}
        viewportHeight={360}
        renderItem={(row) => (
          <article className="itotori-virtual-list__row">
            <span>
              <span className="itotori-virtual-list__label">Item</span>
              <span className="itotori-virtual-list__value">
                <a href={row.detailPath}>{row.summary}</a>
                <br />
                <code>{row.reviewItemId}</code>
              </span>
            </span>
            <span>
              <span className="itotori-virtual-list__label">State / kind</span>
              <span className="itotori-virtual-list__value">
                <Badge status={row.dashboardState} /> {row.itemKind}
              </span>
            </span>
            <span>
              <span className="itotori-virtual-list__label">Last action</span>
              <span className="itotori-virtual-list__value">{row.lastAction ?? "none"}</span>
            </span>
          </article>
        )}
      />
      <Pagination
        label="Dashboard reviewer queue pagination"
        page={Math.max(0, queue.pagination.page - 1)}
        pageCount={Math.max(1, queue.pagination.pageCount)}
        totalItems={queue.pagination.total}
        onPrevious={pager.previous}
        onNext={pager.next}
      />
      <p>
        <a
          className="itotori-queue-batch-link"
          href={`/reviewer-queue/batch?action=${encodeURIComponent(
            queue.defaultBatchRequest.action,
          )}&actorUserId=${encodeURIComponent(queue.permission.actorUserId)}`}
        >
          Preview batch actions
        </a>
      </p>
    </>
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
          <code>{row.journalRunId}</code>
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
// QA findings panel (the pending-decisions band lives in DecisionsBand.tsx)
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
