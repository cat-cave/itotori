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
    expect(screen.getByText("Opportunity API Fixture")).toBeInTheDocument();
    expect(screen.getByText("work-opportunity")).toBeInTheDocument();

    const table = screen.getByRole("table", {
      name: "Catalog candidates with demand, ownership, and completeness",
    });
    expect(within(table).getByRole("columnheader", { name: "Demand" })).toBeInTheDocument();
    expect(within(table).getByText("Very high")).toBeInTheDocument();
    expect(within(table).getByText(/61,240 DL/u)).toBeInTheDocument();
    expect(within(table).getByText(/12,040 wishlists/u)).toBeInTheDocument();
    expect(within(table).getAllByText("Owned")).toHaveLength(2);
    expect(within(table).getByText("2 local signals")).toBeInTheDocument();
    expect(within(table).getByText("No English")).toBeInTheDocument();
  });
});
