// ovw-decisions-band-ui — the Overview screen's open-QA-findings band.
//
// A panel WITHIN the Workbench dashboard (not a new route): the open QA
// findings backed by `projects.decisions` (the /api route + read model EXIST).
// It CONSUMES the read model THROUGH the typed client (`useApiQuery`, never an
// ad-hoc fetch) and paints each finding with a real follow-up surface: a
// branch-scoped finding opens patch iteration (result revision), while a
// project-scoped finding opens the Wiki (canonical context correction). The
// dashboard is read-only and offers no workflow mutation.
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
// Categories — the closed finding-kind set, in a stable display order with
// human labels. Only kinds PRESENT in the loaded findings become pills (the
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

/** Client-side page window size over the returned open findings. */
const PAGE_SIZE = 8;

// ---------------------------------------------------------------------------
// Pure derivation — the per-row view model + the follow-up link.
// ---------------------------------------------------------------------------

/** An open finding's scope label, derived from its kind + nullable fields. */
export function findingScope(decision: DashboardPendingDecision): string {
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
 * The next real workflow surface for an open finding. Branch-scoped findings
 * open the patch-iteration surface, where feedback creates a result revision;
 * project-scoped findings open the Wiki, which resolves the selected branch
 * and records canonical context without fabricating a line target.
 */
export function findingFollowupPath(decision: DashboardPendingDecision): string {
  if (decision.localeBranchId !== null) {
    return `/play/patches?${new URLSearchParams({
      localeBranchId: decision.localeBranchId,
    }).toString()}`;
  }
  return "/wiki";
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

export function QaFindingsBand(): ReactNode {
  const decisions = useApiQuery("projects.decisions", {}, "decisions");
  return <QaFindingsBandPanel decisions={decisions} />;
}

/**
 * The state-bound panel body. Exported (and the prop is the resolved
 * `ApiCallState`) so a behavior-first test can mount the band over msw via the
 * self-contained {@link QaFindingsBand} and so the dashboard may host the panel
 * without re-issuing the read.
 */
export function QaFindingsBandPanel({
  decisions,
}: {
  decisions: ApiCallState<ApiDashboardDecisionsResponse>;
}): ReactNode {
  const count = decisions.state === "ready" ? decisions.data.counts.pendingDecisionCount : null;
  const headline =
    count === null
      ? "Open QA findings"
      : count === 0
        ? "No open QA findings"
        : `${count} open ${plural(count, "QA finding")}`;
  return (
    <section className="itotori-decisions-band" aria-label="Open QA findings" id="open-qa-findings">
      <Panel
        title={headline}
        eyebrow="QA"
        tone="mint"
        className="itotori-panel--decisions"
        data-panel-state={decisions.state}
      >
        {decisions.state === "loading" && <LoadingState label="Loading QA findings…" />}
        {decisions.state === "error" && (
          <ErrorState title="Open QA findings" error={decisions.error} />
        )}
        {(decisions.state === "ready" || decisions.state === "empty") && (
          <QaFindingsBandReady decisions={decisions.state === "ready" ? decisions.data : null} />
        )}
      </Panel>
    </section>
  );
}

function QaFindingsBandReady({
  decisions,
}: {
  decisions: ApiDashboardDecisionsResponse | null;
}): ReactNode {
  if (decisions === null || decisions.pendingDecisions.length === 0) {
    return <EmptyState title="Open QA findings" message="No open QA findings returned." />;
  }
  return (
    <>
      <div className="itotori-metric-row" aria-label="Open QA findings aggregate">
        <StatReadout label="Open" value={decisions.counts.pendingDecisionCount} />
        <StatReadout label="Project" value={decisions.counts.projectFindingDecisionCount} />
        <StatReadout
          label="Locale branch"
          value={decisions.counts.localeBranchFindingDecisionCount}
        />
        <StatReadout label="Runtime" value={decisions.counts.runtimeValidationDecisionCount} />
      </div>
      <QaFindingsTable pendingDecisions={decisions.pendingDecisions} />
    </>
  );
}

function QaFindingsTable({
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
        label="Open QA finding categories"
      />
      <DataTable
        caption="Open QA findings"
        columns={[
          {
            key: "finding",
            header: "Finding",
            render: (decision) => {
              const href = findingFollowupPath(decision);
              const surface =
                decision.localeBranchId === null ? "context-correction" : "patch-iteration";
              return (
                <span>
                  <a href={href} data-jump-to={surface} data-finding-id={decision.findingId}>
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
            render: (decision) => findingScope(decision),
          },
          {
            key: "signal",
            header: "Signal",
            render: (decision) => <Badge status={decisionSignal(decision)} />,
          },
        ]}
        rows={pageRows}
        getRowKey={(decision) => decision.decisionId}
        emptyLabel="No open QA findings in this category."
      />
      <Pagination
        label="Open QA findings pagination"
        page={safePage}
        pageCount={pageCount}
        totalItems={filtered.length}
        onPrevious={() => setPage((current) => Math.max(0, current - 1))}
        onNext={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
      />
    </>
  );
}
