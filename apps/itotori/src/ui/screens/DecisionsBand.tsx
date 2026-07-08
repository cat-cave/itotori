// ovw-decisions-band-ui — the Overview screen's pending-decisions band.
//
// A panel WITHIN the Workbench dashboard (not a new route): the queue of items
// awaiting a decision, backed by `projects.decisions` (the /api route + read
// model EXIST). It CONSUMES the read model THROUGH the typed client
// (`useApiQuery`, never an ad-hoc fetch) and paints each pending decision as a
// row with a JUMP-TO link into the reviewer queue — the surface where a
// decision is triaged — scoped to the decision's locale branch when present and
// addressable to the specific decision via `?decisionId=`. The read model
// carries no per-item `detailPath`, so the jump target is derived purely from
// the row's typed fields (projectId / localeBranchId / decisionId); the
// reviewer-queue route parser reads only `localeBranchId` and ignores the
// addressable `decisionId` anchor, so the link is forward-compatible (the
// destination may later highlight the item) without a contract edit.
//
// Follows the app-shell pattern the ~50 downstream screen nodes inherit:
// `useApiQuery("projects.decisions")` -> ds paint (Panel / NavPills / DataTable
// / Badge / Pagination), settling into loading / empty / error / ready so a
// failed read degrades only this panel. className-based, ds tokens, no literal
// styles, no game named. [[feedback_behavior_first_code_agnostic_testing]].

import { useState, type ReactNode } from "react";
import type { DashboardPendingDecision, DashboardPendingDecisionKind } from "@itotori/db";
import {
  Badge,
  DataTable,
  NavPills,
  Pagination,
  Panel,
  StatReadout,
  type NavPillItem,
} from "@itotori/ds";
import type { ApiCallState } from "../../api-client.js";
import type { ApiDashboardDecisionsResponse } from "../../api-schema.js";
import { useApiQuery } from "../use-api-resource.js";
import { decisionSignal, plural } from "../format.js";
import { EmptyState, ErrorState, LoadingState } from "../states.js";

// ---------------------------------------------------------------------------
// Categories — the closed `decisionKind` set, in a stable display order with
// human labels. Only kinds PRESENT in the loaded decisions become pills (the
// band never offers a filter that would show zero rows).
// ---------------------------------------------------------------------------

const ALL_CATEGORY_ID = "all";

const CATEGORY_ORDER: readonly DashboardPendingDecisionKind[] = [
  "project_finding",
  "locale_branch_finding",
  "runtime_validation",
];

const CATEGORY_LABEL: Record<DashboardPendingDecisionKind, string> = {
  project_finding: "Project",
  locale_branch_finding: "Locale branch",
  runtime_validation: "Runtime",
};

/** Client-side page window size over the returned pending decisions. */
const PAGE_SIZE = 8;

// ---------------------------------------------------------------------------
// Pure derivation — the per-row view model + the jump-to link.
// ---------------------------------------------------------------------------

/** A pending decision's scope label, derived from its kind + nullable fields. */
export function decisionScope(decision: DashboardPendingDecision): string {
  switch (decision.decisionKind) {
    case "project_finding":
      return "Project";
    case "locale_branch_finding":
      return decision.targetLocale ?? decision.localeBranchId ?? "Locale branch";
    case "runtime_validation":
      return decision.runtimeRunId !== null
        ? `Runtime run ${decision.runtimeRunId}`
        : "Runtime validation";
  }
}

/**
 * The jump-to link for a pending decision: the reviewer queue (the surface a
 * decision is triaged on), scoped to the decision's locale branch when present
 * and addressable to the specific decision via `?decisionId=`. The destination
 * parser ignores the unknown anchor, so the link is forward-compatible without
 * a route edit.
 */
export function decisionJumpPath(decision: DashboardPendingDecision): string {
  const params = new URLSearchParams();
  if (decision.localeBranchId !== null) {
    params.set("localeBranchId", decision.localeBranchId);
  }
  params.set("decisionId", decision.decisionId);
  return `/reviewer-queue?${params.toString()}`;
}

function buildCategoryItems(decisions: readonly DashboardPendingDecision[]): NavPillItem[] {
  const counts = new Map<string, number>();
  for (const decision of decisions) {
    counts.set(decision.decisionKind, (counts.get(decision.decisionKind) ?? 0) + 1);
  }
  const items: NavPillItem[] = [{ id: ALL_CATEGORY_ID, label: "All", badge: decisions.length }];
  for (const kind of CATEGORY_ORDER) {
    const count = counts.get(kind);
    if (count !== undefined) {
      items.push({ id: kind, label: CATEGORY_LABEL[kind], badge: count });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Panel — owns its `projects.decisions` read through the typed client.
// ---------------------------------------------------------------------------

export function DecisionsBand(): ReactNode {
  const decisions = useApiQuery("projects.decisions", {}, "decisions");
  return <DecisionsBandPanel decisions={decisions} />;
}

/**
 * The state-bound panel body. Exported (and the prop is the resolved
 * `ApiCallState`) so a behavior-first test can mount the band over msw via the
 * self-contained {@link DecisionsBand} and so the dashboard may host the panel
 * without re-issuing the read.
 */
export function DecisionsBandPanel({
  decisions,
}: {
  decisions: ApiCallState<ApiDashboardDecisionsResponse>;
}): ReactNode {
  const count = decisions.state === "ready" ? decisions.data.counts.pendingDecisionCount : null;
  const headline =
    count === null
      ? "Pending decisions"
      : count === 0
        ? "No pending decisions"
        : `${count} pending ${plural(count, "decision")}`;
  return (
    <section
      className="itotori-decisions-band"
      aria-label="Pending decisions"
      id="pending-decisions"
    >
      <Panel
        title={headline}
        eyebrow="Pending decisions"
        tone="mint"
        className="itotori-panel--decisions"
        data-panel-state={decisions.state}
      >
        {decisions.state === "loading" && <LoadingState label="Loading decisions…" />}
        {decisions.state === "error" && (
          <ErrorState title="Pending decisions" error={decisions.error} />
        )}
        {(decisions.state === "ready" || decisions.state === "empty") && (
          <DecisionsBandReady decisions={decisions.state === "ready" ? decisions.data : null} />
        )}
      </Panel>
    </section>
  );
}

function DecisionsBandReady({
  decisions,
}: {
  decisions: ApiDashboardDecisionsResponse | null;
}): ReactNode {
  if (decisions === null || decisions.pendingDecisions.length === 0) {
    return <EmptyState title="Pending decisions" message="No pending decisions returned." />;
  }
  return (
    <>
      <div className="itotori-metric-row" aria-label="Pending decisions aggregate">
        <StatReadout label="Pending" value={decisions.counts.pendingDecisionCount} />
        <StatReadout label="Project" value={decisions.counts.projectFindingDecisionCount} />
        <StatReadout
          label="Locale branch"
          value={decisions.counts.localeBranchFindingDecisionCount}
        />
        <StatReadout label="Runtime" value={decisions.counts.runtimeValidationDecisionCount} />
      </div>
      <DecisionsBandQueue pendingDecisions={decisions.pendingDecisions} />
    </>
  );
}

function DecisionsBandQueue({
  pendingDecisions,
}: {
  pendingDecisions: readonly DashboardPendingDecision[];
}): ReactNode {
  const [activeCategory, setActiveCategory] = useState<string>(ALL_CATEGORY_ID);
  const [page, setPage] = useState(0);

  const categoryItems = buildCategoryItems(pendingDecisions);
  // Guard against a stale pill (category filtered out on a data change).
  const effectiveCategory = categoryItems.some((item) => item.id === activeCategory)
    ? activeCategory
    : ALL_CATEGORY_ID;

  const filtered =
    effectiveCategory === ALL_CATEGORY_ID
      ? pendingDecisions
      : pendingDecisions.filter((decision) => decision.decisionKind === effectiveCategory);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageStart = safePage * PAGE_SIZE;
  const pageRows = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  const selectCategory = (id: string): void => {
    setActiveCategory(id);
    setPage(0);
  };

  return (
    <>
      <NavPills
        items={categoryItems}
        activeId={effectiveCategory}
        onSelect={selectCategory}
        label="Pending decision categories"
      />
      <DataTable
        caption="Pending decisions"
        columns={[
          {
            key: "decision",
            header: "Decision",
            render: (decision) => {
              const href = decisionJumpPath(decision);
              return (
                <span>
                  <a
                    href={href}
                    data-jump-to="reviewer-queue"
                    data-decision-id={decision.decisionId}
                  >
                    {decision.title}
                  </a>
                  <br />
                  <code>{decision.findingKind}</code>
                </span>
              );
            },
          },
          {
            key: "kind",
            header: "Kind",
            render: (decision) => CATEGORY_LABEL[decision.decisionKind],
          },
          {
            key: "scope",
            header: "Scope",
            render: (decision) => decisionScope(decision),
          },
          {
            key: "signal",
            header: "Signal",
            render: (decision) => <Badge status={decisionSignal(decision)} />,
          },
        ]}
        rows={pageRows}
        getRowKey={(decision) => decision.decisionId}
        emptyLabel="No pending decisions in this category."
      />
      <Pagination
        label="Pending decisions pagination"
        page={safePage}
        pageCount={pageCount}
        totalItems={filtered.length}
        onPrevious={() => setPage((current) => Math.max(0, current - 1))}
        onNext={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
      />
    </>
  );
}
