// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupServer } from "msw/node";
import { branchExplorerPending, renderBranchExplorer } from "../src/branch-explorer-view.js";
import { BRANCH_EXPLORER_DEFAULT_PAGE_SIZE } from "../src/branch-explorer.js";
import { type CoverageStatus } from "../src/branch-coverage.js";
import {
  BRANCH_EXPLORER_ERROR_ENDPOINT,
  BRANCH_EXPLORER_LARGE_ENDPOINT,
  BRANCH_EXPLORER_TEST_ENDPOINT,
  LARGE_BRANCHES_PER_STATUS,
  branchExplorerHandlers,
} from "./branch-explorer.fixtures.js";

const server = setupServer(...branchExplorerHandlers);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  document.body.innerHTML = "";
  server.resetHandlers();
});
afterAll(() => server.close());

// Per-state counts in the small synthetic fixture (mirrors branch-explorer.test).
const EXPECTED_COUNTS: Record<CoverageStatus, number> = {
  visited: 3,
  unvisited: 2,
  ambiguous: 2,
  unreachable: 2,
};
const TOTAL_RECORDS = 9;

function mount(): HTMLElement {
  const root = document.createElement("div");
  document.body.append(root);
  return root;
}

function rows(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("tbody tr[data-branch-id]")];
}

function pageIndicator(root: HTMLElement): string {
  return root.querySelector('[data-role="page-indicator"]')?.textContent?.trim() ?? "";
}

// Interactions kick off an async re-render; await the settled view.
async function settle(root: HTMLElement): Promise<void> {
  await branchExplorerPending(root);
}

describe("branch explorer dashboard view (UTSUSHI-068)", () => {
  it("renders every required field per branch row from the 067 page", async () => {
    const root = mount();
    await renderBranchExplorer(root, BRANCH_EXPLORER_TEST_ENDPOINT, { pageSize: 100 });

    expect(root.querySelector('[data-route="branch-explorer"]')).not.toBeNull();
    expect(rows(root)).toHaveLength(TOTAL_RECORDS);

    // A visited branch surfaces status, route-map link, trace evidence, count.
    const visited = root.querySelector<HTMLElement>('tr[data-branch-id="mvmz.explorer.visited.2"]');
    expect(visited).not.toBeNull();
    expect(visited?.querySelector('[data-field="coverage-status"]')?.textContent).toContain(
      "Visited",
    );
    expect(visited?.textContent).toContain("route_visited_b");
    // Reachable text count is rendered from the record.
    expect(visited?.querySelector('[data-field="reachable-text-count"]')?.textContent?.trim()).toBe(
      "3",
    );
    // Trace evidence: both observed trace ids appear.
    const traceCell = visited?.querySelector('[data-field="trace-evidence"]');
    expect(traceCell?.textContent).toContain("trace-v2a");
    expect(traceCell?.textContent).toContain("trace-v2b");
    // Route-map link is a MANAGED artifact-store anchor for this branch.
    const routeCell = visited?.querySelector('[data-field="route-map-links"]');
    const routeLink = routeCell?.querySelector<HTMLAnchorElement>("a");
    expect(routeLink?.getAttribute("href")).toMatch(
      /^\/artifact-store\/artifacts\/utsushi\/branch-coverage\//,
    );
  });

  it("renders managed artifact links only — never raw paths or game-asset media", async () => {
    const root = mount();
    await renderBranchExplorer(root, BRANCH_EXPLORER_TEST_ENDPOINT, { pageSize: 100 });

    const links = [...root.querySelectorAll<HTMLAnchorElement>("a")];
    expect(links.length).toBeGreaterThan(0);
    expect(
      links.every((link) =>
        link.getAttribute("href")!.startsWith("/artifact-store/artifacts/utsushi/branch-coverage/"),
      ),
    ).toBe(true);
    expect(root.innerHTML).not.toContain("/tmp/");
    expect(root.innerHTML).not.toContain("file:");
    // Never an <img>/<video> of a game asset.
    expect(root.querySelector("img, video")).toBeNull();
  });

  it("shows the per-state coverage summary", async () => {
    const root = mount();
    await renderBranchExplorer(root, BRANCH_EXPLORER_TEST_ENDPOINT, { pageSize: 100 });

    expect(root.querySelector('[data-summary="branch-count"]')?.textContent).toBe(
      String(TOTAL_RECORDS),
    );
    for (const status of Object.keys(EXPECTED_COUNTS) as CoverageStatus[]) {
      expect(root.querySelector(`[data-summary="${status}"]`)?.textContent).toBe(
        String(EXPECTED_COUNTS[status]),
      );
    }
  });

  it("filters by coverage status when the status control changes", async () => {
    const root = mount();
    await renderBranchExplorer(root, BRANCH_EXPLORER_TEST_ENDPOINT, { pageSize: 100 });
    expect(rows(root)).toHaveLength(TOTAL_RECORDS);

    const select = root.querySelector<HTMLSelectElement>('[data-control="status-filter"]')!;
    select.value = "ambiguous";
    select.dispatchEvent(new Event("change"));
    await settle(root);

    const filtered = rows(root);
    expect(filtered).toHaveLength(EXPECTED_COUNTS.ambiguous);
    expect(filtered.every((row) => row.getAttribute("data-coverage-status") === "ambiguous")).toBe(
      true,
    );
    expect(root.querySelector('[data-role="active-filter"]')?.textContent).toContain("Ambiguous");

    // The control reflects the active filter after the re-render.
    const selectAfter = root.querySelector<HTMLSelectElement>('[data-control="status-filter"]')!;
    expect(selectAfter.value).toBe("ambiguous");

    // Switching back to "all" restores the full set.
    selectAfter.value = "";
    selectAfter.dispatchEvent(new Event("change"));
    await settle(root);
    expect(rows(root)).toHaveLength(TOTAL_RECORDS);
  });

  it("navigates pages with the next / previous controls", async () => {
    const root = mount();
    const pageSize = 4;
    await renderBranchExplorer(root, BRANCH_EXPLORER_TEST_ENDPOINT, { pageSize });

    expect(pageIndicator(root)).toBe("Page 1 of 3");
    expect(rows(root)).toHaveLength(pageSize);
    const firstPageIds = rows(root).map((r) => r.getAttribute("data-branch-id"));
    expect(root.querySelector<HTMLButtonElement>('[data-control="prev-page"]')?.disabled).toBe(
      true,
    );

    root.querySelector<HTMLButtonElement>('[data-control="next-page"]')!.click();
    await settle(root);

    expect(pageIndicator(root)).toBe("Page 2 of 3");
    const secondPageIds = rows(root).map((r) => r.getAttribute("data-branch-id"));
    // Page 2 holds different branches than page 1 (no overlap).
    expect(secondPageIds.some((id) => firstPageIds.includes(id))).toBe(false);

    root.querySelector<HTMLButtonElement>('[data-control="next-page"]')!.click();
    await settle(root);
    expect(pageIndicator(root)).toBe("Page 3 of 3");
    // Last page: next is disabled, prev is enabled.
    expect(root.querySelector<HTMLButtonElement>('[data-control="next-page"]')?.disabled).toBe(
      true,
    );
    expect(root.querySelector<HTMLButtonElement>('[data-control="prev-page"]')?.disabled).toBe(
      false,
    );

    // Walk back a page.
    root.querySelector<HTMLButtonElement>('[data-control="prev-page"]')!.click();
    await settle(root);
    expect(pageIndicator(root)).toBe("Page 2 of 3");
    expect(rows(root).map((r) => r.getAttribute("data-branch-id"))).toEqual(secondPageIds);
  });

  it("combines a status filter with pagination", async () => {
    const root = mount();
    await renderBranchExplorer(root, BRANCH_EXPLORER_TEST_ENDPOINT, { pageSize: 2 });

    const select = root.querySelector<HTMLSelectElement>('[data-control="status-filter"]')!;
    select.value = "visited";
    select.dispatchEvent(new Event("change"));
    await settle(root);

    // 3 visited branches at page size 2 -> page 1 of 2 with 2 rows.
    expect(pageIndicator(root)).toBe("Page 1 of 2");
    expect(rows(root)).toHaveLength(2);
    expect(rows(root).every((row) => row.getAttribute("data-coverage-status") === "visited")).toBe(
      true,
    );

    root.querySelector<HTMLButtonElement>('[data-control="next-page"]')!.click();
    await settle(root);
    // Page 2 keeps the visited filter and holds the remaining 1 row.
    expect(pageIndicator(root)).toBe("Page 2 of 2");
    expect(rows(root)).toHaveLength(1);
    expect(rows(root)[0]?.getAttribute("data-coverage-status")).toBe("visited");
    expect(root.querySelector('[data-role="active-filter"]')?.textContent).toContain("Visited");
  });

  it("keeps a LARGE route map navigable through filter + pagination", async () => {
    const root = mount();
    // Default page size — the large map has 4 * LARGE_BRANCHES_PER_STATUS
    // branches, far more than one page.
    await renderBranchExplorer(root, BRANCH_EXPLORER_LARGE_ENDPOINT);

    const totalBranches = 4 * LARGE_BRANCHES_PER_STATUS;
    expect(root.querySelector('[data-summary="branch-count"]')?.textContent).toBe(
      String(totalBranches),
    );
    // The view NEVER dumps the whole map: a page is bounded by the page size.
    expect(rows(root)).toHaveLength(BRANCH_EXPLORER_DEFAULT_PAGE_SIZE);
    const totalPages = Math.ceil(totalBranches / BRANCH_EXPLORER_DEFAULT_PAGE_SIZE);
    expect(pageIndicator(root)).toBe(`Page 1 of ${totalPages}`);

    // Filter to one state to shrink the working set, then page through ALL of it.
    const select = root.querySelector<HTMLSelectElement>('[data-control="status-filter"]')!;
    select.value = "unreachable";
    select.dispatchEvent(new Event("change"));
    await settle(root);

    const filteredPages = Math.ceil(LARGE_BRANCHES_PER_STATUS / BRANCH_EXPLORER_DEFAULT_PAGE_SIZE);
    expect(pageIndicator(root)).toBe(`Page 1 of ${filteredPages}`);

    const seen = new Set<string>();
    for (let i = 0; ; i += 1) {
      for (const row of rows(root)) {
        expect(row.getAttribute("data-coverage-status")).toBe("unreachable");
        seen.add(row.getAttribute("data-branch-id")!);
      }
      const next = root.querySelector<HTMLButtonElement>('[data-control="next-page"]')!;
      if (next.disabled) {
        expect(pageIndicator(root)).toBe(`Page ${filteredPages} of ${filteredPages}`);
        break;
      }
      expect(i).toBeLessThan(filteredPages); // guard against a runaway loop
      next.click();
      await settle(root);
    }
    // Every unreachable branch was reachable via pagination — none dropped.
    expect(seen.size).toBe(LARGE_BRANCHES_PER_STATUS);
  });

  it("renders the error-state fixture as an alert, not a crash", async () => {
    const root = mount();
    await renderBranchExplorer(root, BRANCH_EXPLORER_ERROR_ENDPOINT);

    expect(root.querySelector('[role="alert"]')).not.toBeNull();
    expect(root.textContent).toContain("branch coverage read model is unavailable");
    expect(root.querySelector("table")).toBeNull();
  });
});
