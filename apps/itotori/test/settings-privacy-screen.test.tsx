// @vitest-environment jsdom
// set-privacy-zdr-ui — behavior-first test for Settings > Privacy posture.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { App } from "../src/ui/App.js";
import { apiJson, authCapabilitiesMswHandler, authIdentityMswHandler } from "./msw-handlers.js";
import { costReportFixture, dashboardStatusFixture } from "./api-fixtures.js";

const server = setupServer(
  authCapabilitiesMswHandler,
  authIdentityMswHandler,
  http.get("*/api/projects/status", () => apiJson("projects.status", dashboardStatusFixture)),
  http.get("*/api/projects/cost", () => apiJson("projects.cost", costReportFixture)),
  http.get("*/api/projects", () =>
    apiJson("projects.list", { projects: [dashboardStatusFixture] }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

describe("Settings privacy posture", () => {
  it("surfaces account-wide ZDR evidence and privacy defaults without a project ZDR toggle", async () => {
    render(<App location={{ pathname: "/settings/privacy", search: "" }} />);

    expect(await screen.findByRole("heading", { name: "Privacy posture" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Privacy" })).toHaveAttribute("aria-selected", "true");

    const panel = screen.getByRole("region", { name: /privacy \/ zdr/i });
    expect(panel).toHaveAttribute("data-panel-id", "privacy-zdr");
    expect(await within(panel).findByText("zdr=true")).toBeInTheDocument();
    expect(within(panel).getByText(/data_collection=none/)).toBeInTheDocument();
    expect(within(panel).getByText(/assertOpenRouterZdrAccount/)).toBeInTheDocument();
    expect(within(panel).getByText("retention")).toBeInTheDocument();
    expect(within(panel).getByText("redactShared")).toBeInTheDocument();
    expect(within(panel).getByText("true")).toBeInTheDocument();

    expect(panel.querySelector('[data-project-zdr-toggle="absent"]')).not.toBeNull();
    expect(
      within(panel).queryByRole("checkbox", { name: /zdr|zero data retention|data collection/i }),
    ).not.toBeInTheDocument();
    expect(
      within(panel).queryByRole("button", { name: /enable zdr|disable zdr|save privacy/i }),
    ).not.toBeInTheDocument();
  });
});
