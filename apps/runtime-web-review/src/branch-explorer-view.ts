// MV/MZ branch explorer dashboard VIEW (UTSUSHI-068).
//
// Renders the UTSUSHI-067 branch-coverage page (see ./branch-explorer.ts) as a
// reviewer-facing dashboard. Like the runtime status dashboard (./dashboard.ts),
// this app ships NO live server and NO UI framework: the view is a plain-DOM
// render function that fetches the 067 page (MSW-fronted in tests) and writes
// HTML into a host element, plus interactive filter + pagination controls that
// re-render the same element with an updated 067 query.
//
// Every branch row surfaces the six fields a reviewer scans: branch id, route
// key, coverage status, route-map links, trace evidence, and reachable text
// count. Artifact links are the MANAGED `/artifact-store/` links the 067 API
// derives — never a raw filesystem path, `file:` URL, or `<img>` of a game
// asset.

import {
  BRANCH_EXPLORER_DEFAULT_ENDPOINT,
  COVERAGE_STATUS_VALUES,
  fetchBranchCoveragePage,
  type BranchArtifactLink,
  type BranchExplorerQuery,
  type BranchExplorerRecord,
  type BranchExplorerResponse,
} from "./branch-explorer.js";
import { type CoverageStatus } from "./branch-coverage.js";

// The last in-flight render promise per host element. An interaction (status
// filter change / pagination click) kicks off an async re-render; tests await
// `branchExplorerPending(root)` to observe the settled view without racing.
const pending = new WeakMap<HTMLElement, Promise<void>>();

export function branchExplorerPending(root: HTMLElement): Promise<void> {
  return pending.get(root) ?? Promise.resolve();
}

// Render the branch explorer view into `root`: fetch the 067 page for `query`,
// render the coverage table + controls, and wire the controls to re-render.
export async function renderBranchExplorer(
  root: HTMLElement,
  endpoint = BRANCH_EXPLORER_DEFAULT_ENDPOINT,
  query: BranchExplorerQuery = {},
): Promise<void> {
  root.innerHTML = `<main style="${pageStyle()}"><h1 style="${titleStyle()}">Branch coverage explorer</h1><p>Loading branch coverage...</p></main>`;
  try {
    const page = await fetchBranchCoveragePage(endpoint, query);
    root.innerHTML = renderBranchExplorerPage(page);
    wireControls(root, endpoint, page);
  } catch (error) {
    root.innerHTML = `
      <main style="${pageStyle()}" data-route="branch-explorer">
        <h1 style="${titleStyle()}">Branch coverage explorer</h1>
        <p role="alert">Branch coverage could not load from the read model.</p>
        <pre>${escapeHtml(error instanceof Error ? error.message : String(error))}</pre>
      </main>
    `;
  }
}

// Pure render: turn a settled 067 page into the dashboard HTML. Exported so a
// host (or test) can render a page snapshot without the fetch/interaction wiring.
export function renderBranchExplorerPage(page: BranchExplorerResponse): string {
  return `
    <main style="${pageStyle()}" data-route="branch-explorer" data-adapter-id="${escapeHtml(page.adapterId)}">
      <header style="margin-bottom: 1.5rem">
        <p style="margin: 0 0 .25rem; color: #53606f; font-size: .875rem">Branch coverage</p>
        <h1 style="${titleStyle()}">Branch coverage explorer</h1>
      </header>
      ${renderSummary(page)}
      ${renderControls(page)}
      ${renderCoverageTable(page.records)}
      ${renderPagination(page)}
    </main>
  `;
}

function renderSummary(page: BranchExplorerResponse): string {
  const summary = page.summary;
  return `
    <section aria-label="Branch coverage summary" style="${panelStyle()}">
      <h2 style="${headingStyle()}">Coverage summary</h2>
      <dl style="${definitionGridStyle()}">
        ${summaryField("Branches", "branch-count", summary.branchCount)}
        ${summaryField("Visited", "visited", summary.visited)}
        ${summaryField("Unvisited", "unvisited", summary.unvisited)}
        ${summaryField("Ambiguous", "ambiguous", summary.ambiguous)}
        ${summaryField("Unreachable", "unreachable", summary.unreachable)}
        ${summaryField("Reachable text", "total-reachable-text", summary.totalReachableText)}
        ${summaryField("Covered text", "covered-reachable-text", summary.coveredReachableText)}
      </dl>
    </section>
  `;
}

// Coverage filter controls: a status <select> (all four states + "all") and a
// page-size <select>. Both carry `data-control` hooks so interaction tests can
// drive them. The selected status is derived from the page's active filter so
// the control always reflects the rendered slice.
function renderControls(page: BranchExplorerResponse): string {
  const active = page.filter.coverageStatus;
  const statusOptions = [
    { value: "", label: "All statuses" },
    ...COVERAGE_STATUS_VALUES.map((status) => ({ value: status, label: labelFor(status) })),
  ]
    .map(
      (option) =>
        `<option value="${escapeHtml(option.value)}"${option.value === (active ?? "") ? " selected" : ""}>${escapeHtml(option.label)}</option>`,
    )
    .join("");
  return `
    <form aria-label="Coverage filters" style="${panelStyle()}" onsubmit="return false">
      <label style="${labelStyle()}">
        Coverage status
        <select data-control="status-filter" aria-label="Filter by coverage status">${statusOptions}</select>
      </label>
      <span data-role="active-filter" style="margin-left: .75rem; color: #53606f">
        Showing ${escapeHtml(active === null ? "all statuses" : labelFor(active))}
        (${page.page.totalRecords} branch${page.page.totalRecords === 1 ? "" : "es"})
      </span>
    </form>
  `;
}

function renderCoverageTable(records: BranchExplorerRecord[]): string {
  const rows =
    records.length === 0
      ? `<tr><td colspan="6" data-role="empty-row">No branches match the current filter.</td></tr>`
      : records.map(renderCoverageRow).join("");
  return `
    <section aria-label="Branch coverage" style="${panelStyle()}">
      <h2 style="${headingStyle()}">Branches</h2>
      <div style="overflow-x:auto">
        <table style="${tableStyle()}">
          <thead>
            <tr>
              <th>Branch id</th>
              <th>Route key</th>
              <th>Coverage status</th>
              <th>Route-map links</th>
              <th>Trace evidence</th>
              <th>Reachable text</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderCoverageRow(record: BranchExplorerRecord): string {
  const routeMapLinks = record.artifactLinks.filter((link) => link.rel === "route-map");
  const traceLinks = record.artifactLinks.filter((link) => link.rel === "runtime-trace");
  return `
    <tr data-branch-id="${escapeHtml(record.branchId)}" data-coverage-status="${escapeHtml(record.coverageStatus)}">
      <td>${escapeHtml(record.branchId)}</td>
      <td>${escapeHtml(record.routeKey ?? "unlinked")}</td>
      <td data-field="coverage-status">${coverageBadge(record.coverageStatus)}</td>
      <td data-field="route-map-links">${renderArtifactLinks(routeMapLinks, record.routeMapIds, "no route map")}</td>
      <td data-field="trace-evidence">${renderArtifactLinks(traceLinks, record.observedTraceIds, "none observed")}</td>
      <td data-field="reachable-text-count">${record.reachableTextCount}</td>
    </tr>
  `;
}

// Render a record's managed artifact links as anchors into the artifact store.
// A link with a non-managed href is shown as a diagnostic, never a live anchor
// (defence-in-depth even though the 067 API only ever mints managed hrefs). An
// empty set falls back to the record's raw ref ids (as text) plus a placeholder.
function renderArtifactLinks(
  links: BranchArtifactLink[],
  fallbackRefIds: string[],
  emptyLabel: string,
): string {
  if (links.length === 0) {
    if (fallbackRefIds.length === 0) {
      return emptyLabel;
    }
    return fallbackRefIds.map((refId) => escapeHtml(refId)).join("<br>");
  }
  return links
    .map((link) => {
      if (!isManagedArtifactHref(link.href)) {
        return diagnostic(`blocked unmanaged artifact link: ${link.refId}`);
      }
      return `<a href="${escapeHtml(link.href)}" target="_blank" rel="noreferrer">${escapeHtml(link.refId)}</a>`;
    })
    .join("<br>");
}

// Pagination controls: prev / next buttons (disabled at the ends) and a page
// indicator. `data-control` hooks let interaction tests click through pages.
function renderPagination(page: BranchExplorerResponse): string {
  const info = page.page;
  const totalPages = info.totalPages === 0 ? 0 : info.totalPages;
  return `
    <nav aria-label="Branch coverage pagination" style="${paginationStyle()}">
      <button type="button" data-control="prev-page"${info.hasPrev ? "" : " disabled"}>Previous</button>
      <span data-role="page-indicator">Page ${info.page} of ${totalPages}</span>
      <button type="button" data-control="next-page"${info.hasNext ? "" : " disabled"}>Next</button>
      <span data-role="page-size" style="margin-left: .75rem; color: #53606f">${info.pageSize} per page</span>
    </nav>
  `;
}

// Wire the status filter + pagination controls to re-render `root` with an
// updated 067 query. Changing the status resets to page 1; the page size is
// carried across every interaction so the view stays bounded on large maps.
function wireControls(root: HTMLElement, endpoint: string, page: BranchExplorerResponse): void {
  const pageSize = page.page.pageSize;
  const activeStatus = page.filter.coverageStatus;

  const rerender = (query: BranchExplorerQuery): void => {
    const promise = renderBranchExplorer(root, endpoint, query);
    pending.set(root, promise);
  };

  const statusFilter = root.querySelector<HTMLSelectElement>('[data-control="status-filter"]');
  statusFilter?.addEventListener("change", () => {
    const value = statusFilter.value;
    const status = value === "" ? undefined : (value as CoverageStatus);
    rerender({ page: 1, pageSize, ...(status === undefined ? {} : { status }) });
  });

  const prev = root.querySelector<HTMLButtonElement>('[data-control="prev-page"]');
  prev?.addEventListener("click", () => {
    if (!page.page.hasPrev) {
      return;
    }
    rerender({
      page: page.page.page - 1,
      pageSize,
      ...(activeStatus === null ? {} : { status: activeStatus }),
    });
  });

  const next = root.querySelector<HTMLButtonElement>('[data-control="next-page"]');
  next?.addEventListener("click", () => {
    if (!page.page.hasNext) {
      return;
    }
    rerender({
      page: page.page.page + 1,
      pageSize,
      ...(activeStatus === null ? {} : { status: activeStatus }),
    });
  });
}

function coverageBadge(status: CoverageStatus): string {
  const color = coverageColor(status);
  return `<span data-coverage-badge="${escapeHtml(status)}" style="display:inline-block; padding:.1rem .5rem; border-radius:999px; background:${color.bg}; color:${color.fg}; font-weight:600; font-size:.8125rem">${escapeHtml(labelFor(status))}</span>`;
}

function coverageColor(status: CoverageStatus): { bg: string; fg: string } {
  switch (status) {
    case "visited":
      return { bg: "#dcfce7", fg: "#166534" };
    case "unvisited":
      return { bg: "#e5e7eb", fg: "#374151" };
    case "ambiguous":
      return { bg: "#fef9c3", fg: "#854d0e" };
    case "unreachable":
      return { bg: "#fee2e2", fg: "#991b1b" };
  }
}

function labelFor(status: CoverageStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function summaryField(label: string, metricId: string, count: number): string {
  return `<dt>${escapeHtml(label)}</dt><dd data-summary="${escapeHtml(metricId)}">${count}</dd>`;
}

// A managed artifact-store link points only at the 067-minted branch-coverage
// mount. Reject anything with a scheme, backslash, or path traversal.
function isManagedArtifactHref(href: string): boolean {
  return (
    href.startsWith("/artifact-store/artifacts/utsushi/branch-coverage/") &&
    !href.includes("\\") &&
    !href.split("/").some((segment) => segment === "." || segment === "..")
  );
}

function diagnostic(value: string): string {
  return `<span role="status" style="color:#b91c1c; font-weight:600">${escapeHtml(value)}</span>`;
}

function pageStyle(): string {
  return "font-family: system-ui, sans-serif; margin: 2rem; color: #111827; max-width: 1280px";
}

function titleStyle(): string {
  return "margin: 0 0 .5rem";
}

function panelStyle(): string {
  return "border: 1px solid #d1d5db; border-radius: 8px; padding: 1rem; margin-bottom: 1rem";
}

function paginationStyle(): string {
  return "display: flex; align-items: center; gap: .75rem; margin-bottom: 1rem";
}

function headingStyle(): string {
  return "margin: 0 0 .75rem; font-size: 1.25rem";
}

function labelStyle(): string {
  return "display: inline-flex; flex-direction: column; gap: .25rem; font-size: .875rem";
}

function definitionGridStyle(): string {
  return "display: grid; grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr)); gap: .35rem .75rem; margin: 0";
}

function tableStyle(): string {
  return "border-collapse: collapse; width: 100%; font-size: .875rem";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
