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
import type { ProjectCostReport, ProjectDashboardStatus } from "@itotori/db";
import { Badge, DataTable, Panel, ProgressBar, StatReadout } from "@itotori/ds";
import type { ApiCallState } from "../../api-client.js";
import type {
  ApiDashboardDecisionsResponse,
  ApiProjectsResponse,
  ApiReviewerQueueDashboardResponse,
} from "../../api-schema.js";
import { useApiQuery } from "../use-api-resource.js";
import {
  INDIE_LOCALIZATION_COST_TARGET_MICROS_USD,
  decisionGroupSignal,
  formatMicrosUsd,
  formatSignedMicrosUsd,
  groupedBranchDecisions,
  plural,
} from "../format.js";
import { EmptyState, ErrorState, LoadingState, ShellHeader } from "../states.js";
import { ProgressInstrumentPanel } from "./ProgressInstrumentPanel.js";

export function DashboardScreen(): ReactNode {
  const projects = useApiQuery("projects.list", {}, "projects");
  const status = useApiQuery("projects.status", {}, "status");
  const decisions = useApiQuery("projects.decisions", {}, "decisions");
  const cost = useApiQuery("projects.cost", {}, "cost");

  return (
    <main className="itotori-shell" data-screen="dashboard" data-state={projects.state}>
      <ShellHeader eyebrow="Workbench" title="Itotori dashboard">
        <StatusStrip status={status} decisions={decisions} />
      </ShellHeader>

      <PendingDecisionsBand decisions={decisions} />

      <ProgressInstrumentPanel />

      <section className="itotori-section-grid" aria-label="Dashboard sections">
        <ProjectsPanel projects={projects} />
        <ReviewerQueuePanel status={status} />
        <CostPanel cost={cost} />
        <QaFindingsPanel decisions={decisions} />
      </section>
    </main>
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
// Reviewer queue panel — scoped to the status's selected locale branch
// ---------------------------------------------------------------------------

function ReviewerQueuePanel({
  status,
}: {
  status: ApiCallState<ProjectDashboardStatus>;
}): ReactNode {
  if (status.state === "loading") {
    return (
      <Panel title="Reviewer queue" eyebrow="Human review">
        <LoadingState label="Loading project context…" />
      </Panel>
    );
  }
  if (status.state === "error") {
    return (
      <Panel title="Reviewer queue" eyebrow="Human review">
        <ErrorState title="Reviewer queue" error={status.error} />
      </Panel>
    );
  }
  const selectedLocaleBranchId =
    status.state === "ready" ? status.data.selectedLocaleBranchId : null;
  if (selectedLocaleBranchId === null) {
    return (
      <Panel title="Reviewer queue" eyebrow="Human review">
        <EmptyState
          title="No locale branch selected"
          message="Select a locale branch to scope the reviewer queue."
        />
      </Panel>
    );
  }
  return <ReviewerQueueBody localeBranchId={selectedLocaleBranchId} />;
}

function ReviewerQueueBody({ localeBranchId }: { localeBranchId: string }): ReactNode {
  const queue = useApiQuery(
    "reviewer.queue",
    { query: { localeBranchId } },
    `reviewer.queue:${localeBranchId}`,
  );
  return (
    <Panel title="Reviewer queue" eyebrow="Human review">
      {queue.state === "loading" && <LoadingState label="Loading reviewer queue…" />}
      {queue.state === "empty" && (
        <EmptyState
          title="Reviewer queue"
          message="No reviewer queue items were returned by the API."
        />
      )}
      {queue.state === "error" && <ErrorState title="Reviewer queue" error={queue.error} />}
      {queue.state === "ready" && <ReviewerQueueContent queue={queue.data} />}
    </Panel>
  );
}

function ReviewerQueueContent({ queue }: { queue: ApiReviewerQueueDashboardResponse }): ReactNode {
  return (
    <>
      <div className="itotori-metric-row" aria-label="Reviewer queue aggregate">
        <StatReadout label="Pending" value={queue.aggregate.pending} />
        <StatReadout label="Resolved" value={queue.aggregate.resolved} />
        <StatReadout label="Deferred" value={queue.aggregate.deferred} />
        <StatReadout label="Escalated" value={queue.aggregate.escalated} />
        <StatReadout label="Batch applied" value={queue.aggregate.batch_applied} />
      </div>
      <DataTable
        caption="Reviewer queue items"
        columns={[
          {
            key: "state",
            header: "State",
            render: (row) => <Badge status={row.dashboardState} />,
          },
          {
            key: "item",
            header: "Item",
            render: (row) => (
              <span>
                <a href={row.detailPath}>{row.summary}</a>
                <br />
                <code>{row.reviewItemId}</code>
              </span>
            ),
          },
          { key: "kind", header: "Kind", render: (row) => row.itemKind },
          { key: "last", header: "Last action", render: (row) => row.lastAction ?? "none" },
          { key: "batch", header: "Batch id", render: (row) => row.batchActionId ?? "none" },
        ]}
        rows={queue.rows}
        getRowKey={(row) => row.reviewItemId}
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

// ---------------------------------------------------------------------------
// Model cost panel + the empirical $25 indie cost target
// ---------------------------------------------------------------------------

function CostPanel({ cost }: { cost: ApiCallState<ProjectCostReport> }): ReactNode {
  return (
    <Panel title="Model cost" eyebrow="Spend" data-panel-state={cost.state}>
      {cost.state === "loading" && <LoadingState label="Loading cost report…" />}
      {cost.state === "empty" && (
        <EmptyState title="Model cost" message="No cost report was returned by the API." />
      )}
      {cost.state === "error" && <ErrorState title="Model cost" error={cost.error} />}
      {cost.state === "ready" && <CostReport cost={cost.data} />}
    </Panel>
  );
}

function CostReport({ cost }: { cost: ProjectCostReport }): ReactNode {
  const target = INDIE_LOCALIZATION_COST_TARGET_MICROS_USD;
  const spent = cost.billedMicrosUsd;
  const percentage = target <= 0 ? 0 : Math.round((spent / target) * 100);
  const remaining = target - spent;
  const overBudget = remaining < 0;
  return (
    <>
      <div className="itotori-cost-target" aria-label="Indie localization cost target">
        <StatReadout label="Spent (real)" value={formatMicrosUsd(spent)} mono />
        <StatReadout label="Target" value={formatMicrosUsd(target)} mono />
        <StatReadout
          label={overBudget ? "Over budget" : "Remaining"}
          value={formatSignedMicrosUsd(remaining)}
          deltaTone={overBudget ? "critical" : "ok"}
          mono
        />
        <StatReadout label="Used" value={`${percentage}%`} />
      </div>
      <ProgressBar
        value={Math.max(0, Math.min(100, percentage))}
        max={100}
        tone={overBudget ? "amber" : "mint"}
        label={`${percentage}% of $25 target used`}
        showValue
      />
      <div className="itotori-metric-row" aria-label="Cost totals">
        <StatReadout label="Billed" value={formatMicrosUsd(cost.billedMicrosUsd)} mono />
        <StatReadout label="Runs" value={cost.runCount} />
        <StatReadout label="Zero-cost runs" value={cost.zeroRunCount} />
        <StatReadout
          label="TM avoided"
          value={cost.translationMemoryReuse.providerCallAvoidedCount}
        />
        <StatReadout
          label="TM tokens saved"
          value={cost.translationMemoryReuse.estimatedTotalTokensSaved}
        />
      </div>
      <DataTable
        caption="Cost by kind"
        columns={[
          { key: "kind", header: "Kind", render: (e) => e.costKind },
          { key: "runs", header: "Runs", align: "end", render: (e) => e.runCount },
          {
            key: "amount",
            header: "Amount",
            align: "end",
            render: (e) => formatMicrosUsd(e.amountMicrosUsd),
          },
          { key: "tokens", header: "Tokens", align: "end", render: (e) => e.totalTokens },
        ]}
        rows={cost.totalsByCostKind}
        getRowKey={(e) => e.costKind}
        emptyLabel="No recorded cost by kind."
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Pending decisions (band + QA findings panel)
// ---------------------------------------------------------------------------

type DecisionRow = { decision: string; area: string; signal: string };

function decisionRows(decisions: ApiDashboardDecisionsResponse): DecisionRow[] {
  const rows: DecisionRow[] = [];
  const projectCount = decisions.counts.projectFindingDecisionCount;
  if (projectCount > 0) {
    rows.push({
      decision: `${projectCount} project-level finding ${plural(projectCount, "decision")} pending`,
      area: "Project",
      signal: decisionGroupSignal(decisions.pendingDecisions, "project_finding"),
    });
  }
  for (const branch of groupedBranchDecisions(decisions.pendingDecisions)) {
    rows.push({
      decision: `${branch.count} locale branch finding ${plural(branch.count, "decision")} pending`,
      area: branch.area,
      signal: branch.signal,
    });
  }
  const runtimeCount = decisions.counts.runtimeValidationDecisionCount;
  if (runtimeCount > 0) {
    rows.push({
      decision: `${runtimeCount} runtime validation ${plural(runtimeCount, "decision")} pending`,
      area: "Runtime evidence",
      signal: decisionGroupSignal(decisions.pendingDecisions, "runtime_validation"),
    });
  }
  return rows;
}

function PendingDecisionsBand({
  decisions,
}: {
  decisions: ApiCallState<ApiDashboardDecisionsResponse>;
}): ReactNode {
  const headline =
    decisions.state === "ready"
      ? decisions.data.counts.pendingDecisionCount === 0
        ? "No pending decisions"
        : `${decisions.data.counts.pendingDecisionCount} pending ${plural(
            decisions.data.counts.pendingDecisionCount,
            "decision",
          )}`
      : "Pending decisions";
  const rows = decisions.state === "ready" ? decisionRows(decisions.data) : [];
  return (
    <section
      className="itotori-decision-band"
      aria-label="Pending decisions"
      id="pending-decisions"
    >
      <Panel title={headline} eyebrow="Pending decisions" tone="mint">
        {decisions.state === "loading" && <LoadingState label="Loading decisions…" />}
        {decisions.state === "error" && (
          <ErrorState title="Pending decisions" error={decisions.error} />
        )}
        {(decisions.state === "ready" || decisions.state === "empty") &&
          (rows.length === 0 ? (
            <p className="itotori-empty-copy">No pending decisions returned.</p>
          ) : (
            <DataTable
              caption="Pending decisions"
              columns={[
                { key: "decision", header: "Decision", render: (r) => r.decision },
                { key: "area", header: "Area", render: (r) => r.area },
                { key: "signal", header: "Signal", render: (r) => <Badge status={r.signal} /> },
              ]}
              rows={rows}
              getRowKey={(_r, i) => String(i)}
            />
          ))}
      </Panel>
    </section>
  );
}

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
