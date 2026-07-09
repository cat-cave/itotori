// @vitest-environment jsdom
// np-candidate-browse-ui - behavior-first test for the catalog candidate browser.
//
// Mounts the real App shell at `/catalog` over an msw-intercepted
// `catalog.opportunities` response and asserts the acceptance-critical fields:
// demand, local ownership, and completeness all render from the existing read
// model through the typed client.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { App } from "../src/ui/App.js";
import {
  catalogOpportunitiesFixture,
  costReportFixture,
  dashboardStatusFixture,
} from "./api-fixtures.js";
import { apiJson, authCapabilitiesMswHandler, authIdentityMswHandler } from "./msw-handlers.js";

const server = setupServer(
  authCapabilitiesMswHandler,
  authIdentityMswHandler,
  http.get("*/api/projects", () =>
    apiJson("projects.list", { projects: [dashboardStatusFixture] }),
  ),
  http.get("*/api/projects/status", () => apiJson("projects.status", dashboardStatusFixture)),
  http.get("*/api/projects/cost", () => apiJson("projects.cost", costReportFixture)),
  http.get("*/api/catalog/opportunities", () =>
    apiJson("catalog.opportunities", catalogOpportunitiesFixture),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

describe("Catalog candidate browser", () => {
  it("lists catalog candidates with demand, owned, and completeness from catalog.opportunities", async () => {
    render(<App location={{ pathname: "/catalog", search: "" }} />);

    const main = await screen.findByRole("main");
    expect(main).toHaveAttribute("data-screen", "catalog-candidate-browser");
    expect(main).toHaveAttribute("data-state", "ready");

    const browser = await screen.findByLabelText("Catalog candidate browser");
    expect(browser).toHaveAttribute("data-target-language", "en-US");
    expect(browser).toHaveAttribute("data-row-count", "1");

    expect(await screen.findByRole("heading", { name: "Catalog candidates" })).toBeInTheDocument();

    const readinessMatrix = screen.getByRole("table", {
      name: "Per-candidate readiness matrix",
    });
    expect(
      within(readinessMatrix).getByRole("columnheader", { name: "Identify" }),
    ).toBeInTheDocument();
    expect(
      within(readinessMatrix).getByRole("columnheader", { name: "Inventory" }),
    ).toBeInTheDocument();
    expect(
      within(readinessMatrix).getByRole("columnheader", { name: "Extract" }),
    ).toBeInTheDocument();
    expect(
      within(readinessMatrix).getByRole("columnheader", { name: "Patch" }),
    ).toBeInTheDocument();
    expect(
      within(readinessMatrix).getByRole("columnheader", { name: "Runtime" }),
    ).toBeInTheDocument();
    expect(within(readinessMatrix).getByText("kaifuu.rpg-maker-mv-mz")).toBeInTheDocument();
    expect(
      within(readinessMatrix).getByText("engineCapabilityReports/kaifuu.rpg-maker-mv-mz"),
    ).toBeInTheDocument();
    expect(within(readinessMatrix).getAllByText("Supported")).toHaveLength(4);
    expect(within(readinessMatrix).getByText("Partial")).toBeInTheDocument();
    expect(
      within(readinessMatrix).getByText(
        "Public + aggregate - 1 public fixture; 2 private aggregates",
      ),
    ).toBeInTheDocument();

    const table = screen.getByRole("table", {
      name: "Catalog candidates with demand, ownership, and completeness",
    });
    expect(within(table).getByText("Opportunity API Fixture")).toBeInTheDocument();
    expect(within(table).getByText("work-opportunity")).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Demand" })).toBeInTheDocument();
    expect(within(table).getByText("Very high")).toBeInTheDocument();
    expect(within(table).getByText(/61,240 DL/u)).toBeInTheDocument();
    expect(within(table).getByText(/12,040 wishlists/u)).toBeInTheDocument();
    expect(within(table).getAllByText("Owned")).toHaveLength(2);
    expect(within(table).getByText("2 local signals")).toBeInTheDocument();
    expect(within(table).getByText("No English")).toBeInTheDocument();
  });
});
