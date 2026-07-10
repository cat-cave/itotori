// fnd-spa-shell — the full categorized reviewer-queue screen.
//
// The Workbench dashboard carries a COMPACT reviewer-queue panel (a flat table
// scoped to the selected locale branch). This is the full-page surface: the
// same `reviewer.queue` read model, but rendered as a CATEGORIZED queue — items
// grouped by `itemKind` (QA / style / glossary / feedback / runtime evidence)
// behind a `NavPills` category filter, each row carrying a derived SEVERITY badge
// (from the item's `priority`). The collection is SERVER-PAGINATED via
// `OffsetPager` and the visible page is virtualized so large branches do not
// mount thousands of rows at once.
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
import { useOffsetPager } from "../use-offset-pager.js";
import { EmptyState, ErrorState, LoadingState, ShellHeader } from "../states.js";
import { VirtualList } from "../virtual-list.js";

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

/** Server page size over branch queue rows. */
const REVIEWER_QUEUE_PAGE_SIZE = 100;

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
  const queue = useOffsetPager(
    "reviewer.queue",
    { query: { localeBranchId }, limit: REVIEWER_QUEUE_PAGE_SIZE },
    `reviewer.queue:${localeBranchId}`,
  );
  return (
    <main
      className="itotori-shell reviewer-queue"
      data-screen="reviewer-queue"
      data-state={queue.phase}
      data-locale-branch-id={localeBranchId}
    >
      <ShellHeader eyebrow="Human review" title="Reviewer queue" />
      <ReviewerQueuePagerBody pager={queue} />
    </main>
  );
}

function ReviewerQueuePagerBody({
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
  return <ReviewerQueueReady page={page.data} pager={pager} />;
}

// ---------------------------------------------------------------------------
// Ready — category filter + severity table + client-side pagination. Holds the
// active-category + page cursor; changing the category resets the page window.
// ---------------------------------------------------------------------------

function ReviewerQueueReady({
  page,
  pager,
}: {
  page: ApiReviewerQueueDashboardResponse;
  pager: ReturnType<typeof useOffsetPager<"reviewer.queue">>;
}): ReactNode {
  const [activeCategory, setActiveCategory] = useState<string>(ALL_CATEGORY_ID);

  const categoryItems = buildCategoryItems(page.rows);
  // Guard against a stale pill (category filtered out on a data change).
  const effectiveCategory = categoryItems.some((item) => item.id === activeCategory)
    ? activeCategory
    : ALL_CATEGORY_ID;

  const filteredRows =
    effectiveCategory === ALL_CATEGORY_ID
      ? page.rows
      : page.rows.filter((row) => row.itemKind === effectiveCategory);

  const selectCategory = (id: string): void => {
    setActiveCategory(id);
  };

  return (
    <section
      className="reviewer-queue__body"
      aria-label="Reviewer queue"
      data-active-category={effectiveCategory}
      data-page={page.pagination.page}
      data-page-count={page.pagination.pageCount}
    >
      <AggregateStrip queue={page} />
      <NavPills
        items={categoryItems}
        activeId={effectiveCategory}
        onSelect={selectCategory}
        label="Reviewer queue categories"
      />
      <Panel title="Categorized items" eyebrow="Severity" className="reviewer-queue__panel">
        {filteredRows.length === 0 ? (
          <p className="itotori-empty-copy">No reviewer items in this category.</p>
        ) : (
          <VirtualList
            ariaLabel="Reviewer queue virtualized rows"
            items={filteredRows}
            getItemKey={(row) => row.reviewItemId}
            itemHeight={112}
            viewportHeight={520}
            renderItem={(row) => <ReviewerQueueVirtualRow row={row} />}
          />
        )}
        <Pagination
          label="Reviewer queue pagination"
          page={Math.max(0, page.pagination.page - 1)}
          pageCount={Math.max(1, page.pagination.pageCount)}
          totalItems={page.pagination.total}
          onPrevious={pager.previous}
          onNext={pager.next}
        />
      </Panel>
    </section>
  );
}

function ReviewerQueueVirtualRow({ row }: { row: ReviewerQueueDashboardRow }): ReactNode {
  const severity = severityForPriority(row.priority);
  return (
    <article className="itotori-virtual-list__row" data-review-item-id={row.reviewItemId}>
      <span>
        <span className="itotori-virtual-list__label">Item</span>
        <span className="itotori-virtual-list__value">
          <a href={row.detailPath}>{row.summary}</a>
          <br />
          <code>{row.reviewItemId}</code>
        </span>
      </span>
      <span>
        <span className="itotori-virtual-list__label">Category / state</span>
        <span className="itotori-virtual-list__value">
          {CATEGORY_LABEL[row.itemKind]} <Badge status={row.dashboardState} />
          <br />
          {row.lastAction ?? "none"}
        </span>
      </span>
      <span>
        <span className="itotori-virtual-list__label">Severity</span>
        <span className="itotori-virtual-list__value">
          <Badge status={severity}>{severity}</Badge>
          <br />
          priority {row.priority}
        </span>
      </span>
    </article>
  );
}

function AggregateStrip({
  queue,
}: {
  queue: ApiReviewerQueueDashboardResponse;
}): ReactNode {
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
