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
import type { ProjectDashboardStatus } from "@itotori/db";
import { Badge, DataTable, Panel, StatReadout } from "@itotori/ds";
import type { ApiCallState } from "../../api-client.js";
import type {
  ApiDashboardDecisionsResponse,
  ApiProjectsResponse,
  ApiReviewerQueueDashboardResponse,
} from "../../api-schema.js";
import { useApiQuery } from "../use-api-resource.js";
import { decisionGroupSignal, groupedBranchDecisions } from "../format.js";
import { EmptyState, ErrorState, LoadingState, ShellHeader } from "../states.js";
import { CostDrilldownPanel } from "./CostDrilldownPanel.js";
import { DecisionsBand } from "./DecisionsBand.js";
import { PassLedgerPanel } from "./PassLedgerPanel.js";
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

      <DecisionsBand />

      <ProgressInstrumentPanel />

      <PassLedgerPanel />

      <section className="itotori-section-grid" aria-label="Dashboard sections">
        <ProjectsPanel projects={projects} />
        <ReviewerQueuePanel status={status} />
        <CostDrilldownPanel cost={cost} />
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
