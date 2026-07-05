import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupServer } from "msw/node";
import {
  BRANCH_EXPLORER_DEFAULT_ENDPOINT,
  buildBranchCoveragePage,
  COVERAGE_STATUS_VALUES,
  fetchBranchCoveragePage,
  type BranchExplorerRecord,
  type BranchExplorerResponse,
} from "../src/branch-explorer.js";
import { seedBranchCoverageReadModel, type CoverageStatus } from "../src/branch-coverage.js";
import {
  BRANCH_EXPLORER_ERROR_ENDPOINT,
  BRANCH_EXPLORER_TEST_ENDPOINT,
  branchExplorerHandlers,
  syntheticBranchCoverageModel,
} from "./branch-explorer.fixtures.js";

const server = setupServer(...branchExplorerHandlers);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// Expected per-state counts in the synthetic fixture.
const EXPECTED_COUNTS: Record<CoverageStatus, number> = {
  visited: 3,
  unvisited: 2,
  ambiguous: 2,
  unreachable: 2,
};
const TOTAL_RECORDS = 9;

function assertRequiredFields(record: BranchExplorerRecord): void {
  expect(typeof record.branchId).toBe("string");
  expect(Array.isArray(record.routeMapIds)).toBe(true);
  expect(COVERAGE_STATUS_VALUES).toContain(record.coverageStatus);
  expect(Array.isArray(record.observedTraceIds)).toBe(true);
  expect(typeof record.reachableTextCount).toBe("number");
  expect(Array.isArray(record.artifactLinks)).toBe(true);
}

async function collectAllPages(
  status: CoverageStatus | null,
  pageSize: number,
): Promise<BranchExplorerResponse[]> {
  const pages: BranchExplorerResponse[] = [];
  let page = 1;
  for (;;) {
    const response = await fetchBranchCoveragePage(BRANCH_EXPLORER_TEST_ENDPOINT, {
      page,
      pageSize,
      ...(status === null ? {} : { status }),
    });
    pages.push(response);
    if (!response.page.hasNext) {
      break;
    }
    page += 1;
  }
  return pages;
}

describe("branch explorer API (UTSUSHI-067)", () => {
  it("serves records with all six required fields plus managed artifact links", async () => {
    const response = await fetchBranchCoveragePage(BRANCH_EXPLORER_TEST_ENDPOINT, {
      pageSize: 100,
    });

    expect(response.schemaVersion).toBe("utsushi.branch_explorer.v0.1");
    expect(response.adapterId).toBe("utsushi-synthetic");
    expect(response.records).toHaveLength(TOTAL_RECORDS);

    for (const record of response.records) {
      assertRequiredFields(record);
      // Artifact links are managed-store links derived from trace + route ids;
      // never a raw filesystem / file: URL.
      const expectedLinks = record.observedTraceIds.length + record.routeMapIds.length;
      expect(record.artifactLinks).toHaveLength(expectedLinks);
      for (const link of record.artifactLinks) {
        expect(link.href.startsWith("/artifact-store/artifacts/utsushi/branch-coverage/")).toBe(
          true,
        );
        expect(link.href).not.toContain("/tmp/");
        expect(link.href).not.toContain("file:");
        expect(["runtime-trace", "route-map"]).toContain(link.rel);
      }
    }
  });

  it("covers all four coverage states through the same fixture", async () => {
    const response = await fetchBranchCoveragePage(BRANCH_EXPLORER_TEST_ENDPOINT, {
      pageSize: 100,
    });
    const seen = new Map<CoverageStatus, number>();
    for (const record of response.records) {
      seen.set(record.coverageStatus, (seen.get(record.coverageStatus) ?? 0) + 1);
    }
    for (const status of COVERAGE_STATUS_VALUES) {
      expect(seen.get(status)).toBe(EXPECTED_COUNTS[status]);
    }
    expect(response.summary).toEqual(syntheticBranchCoverageModel().summary);
  });

  it("filters by each coverage status", async () => {
    for (const status of COVERAGE_STATUS_VALUES) {
      const response = await fetchBranchCoveragePage(BRANCH_EXPLORER_TEST_ENDPOINT, {
        status,
        pageSize: 100,
      });
      expect(response.filter.coverageStatus).toBe(status);
      expect(response.page.totalRecords).toBe(EXPECTED_COUNTS[status]);
      expect(response.records).toHaveLength(EXPECTED_COUNTS[status]);
      expect(response.records.every((record) => record.coverageStatus === status)).toBe(true);
    }
  });

  it("paginates the full result set with correct page metadata and no gaps", async () => {
    const pageSize = 4;
    const pages = await collectAllPages(null, pageSize);

    expect(pages).toHaveLength(Math.ceil(TOTAL_RECORDS / pageSize)); // 3 pages
    pages.forEach((response, index) => {
      const pageNumber = index + 1;
      expect(response.page.page).toBe(pageNumber);
      expect(response.page.pageSize).toBe(pageSize);
      expect(response.page.totalRecords).toBe(TOTAL_RECORDS);
      expect(response.page.totalPages).toBe(pages.length);
      expect(response.page.hasPrev).toBe(pageNumber > 1);
      expect(response.page.hasNext).toBe(pageNumber < pages.length);
    });

    // Every page but the last is full; the tail holds the remainder.
    const nonLast = pages.slice(0, -1);
    expect(nonLast.every((response) => response.records.length === pageSize)).toBe(true);

    // Concatenating pages reproduces the full set exactly once, in order.
    const branchIds = pages.flatMap((response) => response.records.map((r) => r.branchId));
    expect(new Set(branchIds).size).toBe(TOTAL_RECORDS);
    expect(branchIds).toHaveLength(TOTAL_RECORDS);
    const expectedOrder = syntheticBranchCoverageModel().records.map((r) => r.branchId);
    expect(branchIds).toEqual(expectedOrder);
  });

  it("combines a status filter with pagination", async () => {
    const pageSize = 2;
    const pages = await collectAllPages("visited", pageSize);

    const ids = pages.flatMap((response) => response.records.map((r) => r.branchId));
    expect(ids).toHaveLength(EXPECTED_COUNTS.visited);
    expect(new Set(ids).size).toBe(EXPECTED_COUNTS.visited);
    expect(pages.every((response) => response.filter.coverageStatus === "visited")).toBe(true);
    expect(
      pages.every((response) => response.records.every((r) => r.coverageStatus === "visited")),
    ).toBe(true);
    // 3 visited records at page size 2 -> pages of 2 then 1.
    expect(pages.map((response) => response.records.length)).toEqual([2, 1]);
  });

  it("rejects an unknown status filter with a 400 the client surfaces as an error", async () => {
    await expect(
      fetch(`${BRANCH_EXPLORER_TEST_ENDPOINT}?status=bogus`).then((r) => r.status),
    ).resolves.toBe(400);
  });

  it("surfaces the error-state fixture as a thrown error", async () => {
    await expect(fetchBranchCoveragePage(BRANCH_EXPLORER_ERROR_ENDPOINT)).rejects.toThrow(
      /failed to load branch coverage: 500: branch coverage read model is unavailable/,
    );
  });

  it("exposes the UTSUSHI-009 seed read model without a live runtime", () => {
    // Pure + synchronous: the page builder derives everything from the joined
    // read model — no network, browser, or screenshot.
    const page = buildBranchCoveragePage(seedBranchCoverageReadModel());
    expect(page).not.toBeInstanceOf(Promise);
    expect(page.page.totalRecords).toBe(4);
    expect(page.records.map((r) => r.coverageStatus).sort()).toEqual([
      "ambiguous",
      "unreachable",
      "unvisited",
      "visited",
    ]);
    // The seed's visited branch carries its trace + route-map artifact links.
    const visited = page.records.find((r) => r.coverageStatus === "visited");
    // The seed's visited branch has two observed trace ids + one route map.
    expect(new Set(visited?.artifactLinks.map((l) => l.rel))).toEqual(
      new Set(["route-map", "runtime-trace"]),
    );
    expect(visited?.artifactLinks).toHaveLength(3);
  });

  it("uses a namespaced default endpoint", () => {
    expect(BRANCH_EXPLORER_DEFAULT_ENDPOINT).toBe("/api/utsushi/v0.1/branch-coverage");
  });
});
