// fnd-spa-shell — the full categorized reviewer-queue screen.
//
// The Workbench dashboard carries a COMPACT reviewer-queue panel (a flat table
// scoped to the selected locale branch). This is the full-page surface: the
// same `reviewer.queue` read model, but rendered as a CATEGORIZED queue — items
// grouped by `itemKind` (QA / style / glossary / feedback / runtime evidence)
// behind a `NavPills` category filter, each row carrying a derived SEVERITY
// badge (from the item's `priority`), and the collection PAGINATED client-side
// (the `reviewer.queue` route returns the whole branch queue in one read model
// — it has no server-side offset `pagination` field, so the page window is
// walked over the returned `rows` here).
//
// Follows the app-shell pattern the ~50 downstream screen nodes inherit: parse
// the route → read `/api/reviewer/queue` THROUGH the typed `ItotoriApiClient`
// (`useApiQuery`, never an ad-hoc fetch) → settle into loading / empty / error /
// ready → paint with `@itotori/ds` (Panel / NavPills / DataTable / Badge /
// StatReadout), tokens-never-literals, severity → Badge tone via `statusTone`.

import { useState, type ReactNode } from "react";
import type { ReviewerQueueItemKind } from "@itotori/db";
import {
  Badge,
  DataTable,
  NavPills,
  Pagination,
  Panel,
  StatReadout,
  type NavPillItem,
} from "@itotori/ds";
import type { ReviewerQueueDashboardRow } from "../../reviewer/index.js";
import type { ApiReviewerQueueDashboardResponse } from "../../api-schema.js";
import { useApiQuery } from "../use-api-resource.js";
import { useSelectedLocaleBranch } from "../use-selected-locale-branch.js";
import { EmptyState, ErrorState, LoadingState, ShellHeader } from "../states.js";

const reviewerQueueItemKindValues = {
  qa: "qa",
  style: "style",
  glossary: "glossary",
  feedback: "feedback",
  runtimeEvidence: "runtime_evidence",
} as const satisfies Record<string, ReviewerQueueItemKind>;

// ---------------------------------------------------------------------------
// Route identity — `/reviewer-queue` (bare). `/reviewer-queue/batch` and
// `/reviewer-queue/:id` are dispatched earlier in the shell (legacy batch +
// reviewer detail), so this trailing-slash-only regex never collides with
// them. An optional `?localeBranchId=` query scopes the queue explicitly;
// omitted, the screen falls back to the project's selected locale branch.
// ---------------------------------------------------------------------------

export const reviewerQueueRoutePathRegex = /^\/reviewer-queue\/?$/u;

export type ReviewerQueueRouteParams = {
  localeBranchId: string | null;
};

export function parseReviewerQueueRoute(
  pathname: string,
  search: string,
): ReviewerQueueRouteParams | null {
  if (!reviewerQueueRoutePathRegex.test(pathname)) {
    return null;
  }
  const params = new URLSearchParams(search);
  const raw = params.get("localeBranchId");
  return { localeBranchId: raw !== null && raw.length > 0 ? raw : null };
}

// ---------------------------------------------------------------------------
// Severity — the `reviewer.queue` read model carries no explicit severity
// field; it carries a numeric `priority` (higher = more urgent; observed
// production priorities span 0..40 across the repair-rerun stages). We band it
// into the SAME closed severity vocabulary the reviewer-detail QA-findings
// panel renders (`blocker` / `major` / `minor` / `info`) so a single Badge tone
// mapping (`statusTone`: blocker → critical, the rest → neutral) covers both
// surfaces. If the route later carries a first-class severity, swap this
// derivation for the field — the rendering does not change.
// ---------------------------------------------------------------------------

export type ReviewerQueueSeverity = "blocker" | "major" | "minor" | "info";

export function severityForPriority(priority: number): ReviewerQueueSeverity {
  if (priority >= 30) {
    return "blocker";
  }
  if (priority >= 15) {
    return "major";
  }
  if (priority >= 5) {
    return "minor";
  }
  return "info";
}

// ---------------------------------------------------------------------------
// Categories — the closed `itemKind` set, in a stable display order with
// human labels. Only kinds PRESENT in the loaded queue become pills.
// ---------------------------------------------------------------------------

const ALL_CATEGORY_ID = "all";

const CATEGORY_ORDER: readonly ReviewerQueueItemKind[] = [
  reviewerQueueItemKindValues.qa,
  reviewerQueueItemKindValues.style,
  reviewerQueueItemKindValues.glossary,
  reviewerQueueItemKindValues.feedback,
  reviewerQueueItemKindValues.runtimeEvidence,
];

const CATEGORY_LABEL: Record<ReviewerQueueItemKind, string> = {
  [reviewerQueueItemKindValues.qa]: "QA",
  [reviewerQueueItemKindValues.style]: "Style",
  [reviewerQueueItemKindValues.glossary]: "Glossary",
  [reviewerQueueItemKindValues.feedback]: "Feedback",
  [reviewerQueueItemKindValues.runtimeEvidence]: "Runtime evidence",
};

/** Client-side page window size over the returned queue rows. */
const PAGE_SIZE = 8;

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function ReviewerQueueScreen({ route }: { route: ReviewerQueueRouteParams }): ReactNode {
  const selected = useSelectedLocaleBranch({
    explicitLocaleBranchId: route.localeBranchId,
    depsKey: "reviewer-queue:selected-branch",
  });
  if (selected.state === "loading") {
    return (
      <main
        className="itotori-shell reviewer-queue"
        data-screen="reviewer-queue"
        data-state="loading"
      >
        <ShellHeader eyebrow="Human review" title="Reviewer queue" />
        <LoadingState label="Loading project context…" />
      </main>
    );
  }
  if (selected.state === "error") {
    return (
      <main
        className="itotori-shell reviewer-queue"
        data-screen="reviewer-queue"
        data-state="error"
      >
        <ShellHeader eyebrow="Human review" title="Reviewer queue" />
        <ErrorState title="Reviewer queue" error={selected.error} />
      </main>
    );
  }
  if (selected.state === "empty") {
    return (
      <main
        className="itotori-shell reviewer-queue"
        data-screen="reviewer-queue"
        data-state="empty"
      >
        <ShellHeader eyebrow="Human review" title="Reviewer queue" />
        <EmptyState
          title="No locale branch selected"
          message="Select a locale branch to scope the reviewer queue."
        />
      </main>
    );
  }
  return <ReviewerQueueForBranch localeBranchId={selected.data.localeBranchId} />;
}

function ReviewerQueueForBranch({ localeBranchId }: { localeBranchId: string }): ReactNode {
  const queue = useApiQuery(
    "reviewer.queue",
    { query: { localeBranchId } },
    `reviewer.queue:${localeBranchId}`,
  );
  return (
    <main
      className="itotori-shell reviewer-queue"
      data-screen="reviewer-queue"
      data-state={queue.state}
      data-locale-branch-id={localeBranchId}
    >
      <ShellHeader eyebrow="Human review" title="Reviewer queue" />
      {queue.state === "loading" && <LoadingState label="Loading reviewer queue…" />}
      {queue.state === "empty" && (
        <EmptyState
          title="Reviewer queue"
          message="No reviewer queue items were returned by the API."
        />
      )}
      {queue.state === "error" && <ErrorState title="Reviewer queue" error={queue.error} />}
      {queue.state === "ready" && <ReviewerQueueReady queue={queue.data} />}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Ready — category filter + severity table + client-side pagination. Holds the
// active-category + page cursor; changing the category resets the page window.
// ---------------------------------------------------------------------------

function ReviewerQueueReady({ queue }: { queue: ApiReviewerQueueDashboardResponse }): ReactNode {
  const [activeCategory, setActiveCategory] = useState<string>(ALL_CATEGORY_ID);
  const [page, setPage] = useState(0);

  const categoryItems = buildCategoryItems(queue.rows);
  // Guard against a stale pill (category filtered out on a data change).
  const effectiveCategory = categoryItems.some((item) => item.id === activeCategory)
    ? activeCategory
    : ALL_CATEGORY_ID;

  const filteredRows =
    effectiveCategory === ALL_CATEGORY_ID
      ? queue.rows
      : queue.rows.filter((row) => row.itemKind === effectiveCategory);

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageStart = safePage * PAGE_SIZE;
  const pageRows = filteredRows.slice(pageStart, pageStart + PAGE_SIZE);

  const selectCategory = (id: string): void => {
    setActiveCategory(id);
    setPage(0);
  };

  return (
    <section
      className="reviewer-queue__body"
      aria-label="Reviewer queue"
      data-active-category={effectiveCategory}
      data-page={safePage + 1}
      data-page-count={pageCount}
    >
      <AggregateStrip queue={queue} />
      <NavPills
        items={categoryItems}
        activeId={effectiveCategory}
        onSelect={selectCategory}
        label="Reviewer queue categories"
      />
      <Panel title="Categorized items" eyebrow="Severity" className="reviewer-queue__panel">
        <DataTable
          caption="Reviewer queue items by category and severity"
          columns={[
            {
              key: "severity",
              header: "Severity",
              render: (row) => {
                const severity = severityForPriority(row.priority);
                return <Badge status={severity}>{severity}</Badge>;
              },
            },
            {
              key: "category",
              header: "Category",
              render: (row) => CATEGORY_LABEL[row.itemKind],
            },
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
            {
              key: "priority",
              header: "Priority",
              align: "end",
              render: (row) => row.priority,
            },
            {
              key: "last",
              header: "Last action",
              render: (row) => row.lastAction ?? "none",
            },
          ]}
          rows={pageRows}
          getRowKey={(row: ReviewerQueueDashboardRow) => row.reviewItemId}
          emptyLabel="No reviewer items in this category."
        />
        <Pagination
          label="Reviewer queue pagination"
          page={safePage}
          pageCount={pageCount}
          totalItems={filteredRows.length}
          onPrevious={() => setPage((current) => Math.max(0, current - 1))}
          onNext={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
        />
      </Panel>
    </section>
  );
}

function AggregateStrip({ queue }: { queue: ApiReviewerQueueDashboardResponse }): ReactNode {
  return (
    <div className="itotori-metric-row" aria-label="Reviewer queue aggregate">
      <StatReadout label="Pending" value={queue.aggregate.pending} />
      <StatReadout label="Resolved" value={queue.aggregate.resolved} />
      <StatReadout label="Deferred" value={queue.aggregate.deferred} />
      <StatReadout label="Escalated" value={queue.aggregate.escalated} />
      <StatReadout label="Batch applied" value={queue.aggregate.batch_applied} />
    </div>
  );
}

function buildCategoryItems(rows: readonly ReviewerQueueDashboardRow[]): NavPillItem[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.itemKind, (counts.get(row.itemKind) ?? 0) + 1);
  }
  const items: NavPillItem[] = [{ id: ALL_CATEGORY_ID, label: "All", badge: rows.length }];
  for (const kind of CATEGORY_ORDER) {
    const count = counts.get(kind);
    if (count !== undefined) {
      items.push({ id: kind, label: CATEGORY_LABEL[kind], badge: count });
    }
  }
  return items;
}
