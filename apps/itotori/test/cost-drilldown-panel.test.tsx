// @vitest-environment jsdom
// ovw-cost-zdr-drilldown-ui — behavior-first test for the Overview cost / ZDR
// drilldown.
//
// Mounts the real `CostDrilldown` panel group over msw-intercepted
// `/api/projects/cost` + `/api/projects/cost/drilldown` and asserts the
// OBSERVABLE behavior: the Model-cost SUMMARY renders the byKind breakdown +
// the cache-reuse / zero-run totals, the COST LEDGER renders each provider-run
// row with its DISTINCT cost display state (BILLED / ZERO / UNKNOWN micros-USD)
// + the ACTUALLY-SERVED (model, provider) pair recorded in the ledger (with the
// requested pair surfaced honestly when it differs), and the ledger pages
// through the server-paginated route via the fnd-api-client OffsetPager. All
// consumed THROUGH the typed client (no ad-hoc fetch); loading / empty / error
// surface instead of a blank or fabricated panel.
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named; only the
// rendered states / pairs / pagination are asserted, over msw.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { CostDrilldownPage, CostDrilldownRow, ProjectCostReport } from "@itotori/db";
import { CostDrilldown } from "../src/ui/screens/CostDrilldownPanel.js";
import { apiJson } from "./msw-handlers.js";
import { costDrilldownFixture, costReportFixture } from "./api-fixtures.js";

// The three fixture rows each carry one of the DISTINCT cost states
// (billed / zero / unknown) — the canonical state-variety seed.
const STATE_ROWS = costDrilldownFixture.rows;

const server = setupServer(
  http.get("*/api/projects/cost", () => apiJson("projects.cost", costReportFixture)),
  http.get("*/api/projects/cost/drilldown", () =>
    apiJson("projects.costDrilldown", costDrilldownFixture),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

/** The ledger Panel's root `<section>` (scoped queries avoid label collisions). */
async function ledgerSection(): Promise<HTMLElement> {
  const heading = await screen.findByRole("heading", { name: "Cost ledger" });
  const section = heading.closest("section");
  if (section === null) {
    throw new Error("Cost ledger panel section was not rendered");
  }
  return section;
}

// Build a deterministic offset-paginated page slicing `rows` so the OffsetPager
// observes a real hasMore / nextOffset transition across pages. Mirrors the
// shape the api-client pagination test uses.
function pageOf(rows: CostDrilldownRow[], offset: number, limit: number): CostDrilldownPage {
  const slice = rows.slice(offset, offset + limit);
  const hasMore = offset + limit < rows.length;
  return {
    filter: { ...costDrilldownFixture.filter },
    pagination: {
      total: rows.length,
      limit,
      offset,
      page: Math.floor(offset / limit) + 1,
      pageCount: Math.ceil(rows.length / limit),
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
    },
    rows: slice,
  };
}

// Replicate the three state rows into a larger ledger so the COST_DRILLDOWN_PAGE
// (10) yields two real pages. Each replica keeps its seed's cost state + served
// pair but gets a unique providerRunId so the table keys + row text are stable.
function ledgerOfSize(count: number): CostDrilldownRow[] {
  const rows: CostDrilldownRow[] = [];
  for (let index = 0; index < count; index += 1) {
    const seed = STATE_ROWS[index % STATE_ROWS.length]!;
    rows.push({ ...seed, providerRunId: `provider-run-${index}` });
  }
  return rows;
}

describe("Overview cost / ZDR drilldown — summary + ledger", () => {
  it("renders the byKind breakdown + cache-reuse + zero-run totals from the cost report", async () => {
    render(<CostDrilldown />);

    // Summary panel headline.
    expect(await screen.findByRole("heading", { name: "Model cost" })).toBeInTheDocument();

    // byKind breakdown table renders (caption) with the recorded kinds.
    expect(await screen.findByText("Cost by kind")).toBeInTheDocument();
    expect(screen.getByText("billed")).toBeInTheDocument();
    expect(screen.getByText("zero")).toBeInTheDocument();

    // Cache reuse + zero-run totals render as sourced StatReadouts in the
    // Cost totals row.
    const totals = screen.getByLabelText("Cost totals");
    expect(totals).toHaveTextContent("Zero-cost runs");
    expect(totals).toHaveTextContent(String(costReportFixture.zeroRunCount));
    expect(totals).toHaveTextContent("TM avoided");
    expect(totals).toHaveTextContent(
      String(costReportFixture.translationMemoryReuse.providerCallAvoidedCount),
    );
  });

  it("renders each ledger row's cost state (billed / zero / unknown) + the served pair", async () => {
    render(<CostDrilldown />);

    const ledger = await ledgerSection();

    // The THREE distinct cost display states render as badges — zero and
    // unknown are NEVER collapsed (a $0.00 billed record vs an unrecorded cost).
    expect(within(ledger).getByText("Billed")).toBeInTheDocument();
    expect(within(ledger).getByText("Zero")).toBeInTheDocument();
    expect(within(ledger).getByText("Unknown")).toBeInTheDocument();

    // The billed row's real micros-USD amount surfaces (honest source of truth).
    const billedRow = STATE_ROWS.find((row) => row.cost.state === "billed")!;
    const billedAmount = `$${(billedRow.cost.amountMicrosUsd / 1_000_000).toFixed(6)}`;
    expect(within(ledger).getByText(billedAmount)).toBeInTheDocument();

    // The ACTUALLY-SERVED pair (actualModelId + upstreamProvider) from the
    // ledger renders; the billed row served via a DIFFERENT upstream than its
    // curated provider name, so the requested pair is surfaced honestly.
    expect(within(ledger).getByText("via fixture-upstream")).toBeInTheDocument();
    // The route-vs-serve mismatch is visible (requested pair + provider name).
    expect(
      within(ledger).getByText("requested itotori-fake-draft-v0 (openrouter)", { exact: false }),
    ).toBeInTheDocument();
  });

  it("pages through the server-paginated ledger via the OffsetPager", async () => {
    // 13 ledger rows at COST_DRILLDOWN_PAGE_SIZE (10) -> two pages (10 + 3).
    const rows = ledgerOfSize(13);
    server.use(
      http.get("*/api/projects/cost/drilldown", ({ request }) => {
        const url = new URL(request.url);
        const limit = Number(url.searchParams.get("limit") ?? "10");
        const offset = Number(url.searchParams.get("offset") ?? "0");
        return apiJson("projects.costDrilldown", pageOf(rows, offset, limit));
      }),
    );

    render(<CostDrilldown />);
    // Wait for the first page to settle.
    expect(await screen.findByText("provider-run-0")).toBeInTheDocument();

    // Page 1 of 2 with 13 total runs.
    const pagination = screen.getByLabelText("Cost ledger pagination");
    expect(pagination).toHaveTextContent("Page 1 of 2");
    expect(pagination).toHaveTextContent("13 runs");

    // The first page holds 10 rows (provider-run-9 visible, provider-run-10 not).
    expect(screen.getByText("provider-run-9")).toBeInTheDocument();
    expect(screen.queryByText("provider-run-10")).toBeNull();

    // Advance to the second page via the ds Pagination -> the OffsetPager
    // fetches the next offset.
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("provider-run-10")).toBeInTheDocument();
    const paginationAfter = screen.getByLabelText("Cost ledger pagination");
    expect(paginationAfter).toHaveTextContent("Page 2 of 2");
    expect(paginationAfter).toHaveTextContent("13 runs");
    // The first page's last row is no longer visible.
    expect(screen.queryByText("provider-run-9")).toBeNull();

    // Stepping back re-renders the cached first page (NO refetch needed).
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(await screen.findByText("provider-run-9")).toBeInTheDocument();
    expect(screen.queryByText("provider-run-10")).toBeNull();
  });

  it("shows the loading surface before the ledger settles", () => {
    render(<CostDrilldown />);
    // The OffsetPager starts in `loading`; the ledger paints its loading
    // surface synchronously on first render, before the fetch resolves.
    expect(screen.getByText("Loading cost ledger…")).toBeInTheDocument();
  });

  it("surfaces the empty state when no provider-run rows were recorded", async () => {
    server.use(
      http.get("*/api/projects/cost/drilldown", () =>
        apiJson("projects.costDrilldown", pageOf([], 0, 10)),
      ),
    );
    render(<CostDrilldown />);
    expect(await screen.findByText("No provider-run cost rows were recorded.")).toBeInTheDocument();
  });

  it("surfaces a typed error state for the ledger instead of a blank panel", async () => {
    server.use(
      http.get("*/api/projects/cost/drilldown", () =>
        HttpResponse.json(
          { code: "forbidden", error: "not permitted to read the cost ledger" },
          { status: 403 },
        ),
      ),
    );
    render(<CostDrilldown />);
    expect(await screen.findByText("not permitted to read the cost ledger")).toBeInTheDocument();
  });

  it("surfaces a typed error state for the cost summary instead of a blank panel", async () => {
    server.use(
      http.get("*/api/projects/cost", () =>
        HttpResponse.json(
          { code: "forbidden", error: "not permitted to read cost" },
          { status: 403 },
        ),
      ),
    );
    render(<CostDrilldown />);
    expect(await screen.findByText("not permitted to read cost")).toBeInTheDocument();
  });
});

// Pin the fixture invariant the state-variety assertion relies on (the three
// rows carry the three distinct cost states) so a fixture edit that silently
// collapses zero/unknown fails here rather than weakening the render assertion.
describe("Overview cost / ZDR drilldown — fixture invariant", () => {
  it("the seed ledger carries one row per distinct cost state", () => {
    const states = new Set(STATE_ROWS.map((row) => row.cost.state));
    expect(states).toEqual(new Set(["billed", "zero", "unknown"]));
  });

  it("the seed cost report records a non-negative billed total + zero-run + reuse counts", () => {
    const report: ProjectCostReport = costReportFixture;
    expect(report.billedMicrosUsd).toBeGreaterThanOrEqual(0);
    expect(report.zeroRunCount).toBeGreaterThanOrEqual(0);
    expect(report.translationMemoryReuse.providerCallAvoidedCount).toBeGreaterThanOrEqual(0);
  });
});
