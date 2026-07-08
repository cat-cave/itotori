// @vitest-environment jsdom
// ovw-decisions-band-ui — behavior-first test for the Overview pending-decisions
// band.
//
// Mounts the real `DecisionsBand` panel over an msw-intercepted
// `/api/projects/decisions` and asserts the OBSERVABLE behavior: each pending
// decision renders as a row WITH a JUMP-TO link into the reviewer queue (the
// triage surface), scoped to the decision's locale branch when present and
// addressable to the specific decision via `?decisionId=` — all sourced from
// the read model THROUGH the typed client (no ad-hoc fetch). The category
// NavPills filter the queue; loading / empty / error surface instead of a blank
// or fabricated panel.
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named; only the
// rendered decisions + jump targets + states are asserted, over msw.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { DashboardDecisionReadModel } from "@itotori/db";
import { DecisionsBand } from "../src/ui/screens/DecisionsBand.js";
import { apiJson } from "./msw-handlers.js";
import { dashboardDecisionsFixture } from "./api-fixtures.js";

const server = setupServer(
  http.get("*/api/projects/decisions", () =>
    apiJson("projects.decisions", dashboardDecisionsFixture),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

describe("Overview pending-decisions band", () => {
  it("renders each pending decision with a jump-to link into the reviewer queue", async () => {
    render(<DecisionsBand />);

    // Panel headline settles to the sourced pending count (3 pending decisions).
    expect(
      await screen.findByRole("heading", { name: /3 pending decisions/i }),
    ).toBeInTheDocument();

    // AGGREGATE: the count breakouts render as ds StatReadouts.
    const aggregate = screen.getByLabelText("Pending decisions aggregate");
    expect(aggregate).toHaveTextContent("Pending");
    expect(aggregate).toHaveTextContent("3");
    expect(aggregate).toHaveTextContent("Project");
    expect(aggregate).toHaveTextContent("1");
    expect(aggregate).toHaveTextContent("Locale branch");
    expect(aggregate).toHaveTextContent("Runtime");

    // JUMP-TO: the project-level decision (no branch) links into the reviewer
    // queue addressable by decisionId only.
    const projectLink = await screen.findByRole("link", {
      name: "Project terminology review",
    });
    expect(projectLink).toHaveAccessibleName("Project terminology review");
    expect(projectLink).toHaveAttribute("data-jump-to", "reviewer-queue");
    expect(projectLink).toHaveAttribute("data-decision-id", "project_finding:finding-project-1");
    expect(projectLink.getAttribute("href")).toBe(
      "/reviewer-queue?decisionId=project_finding%3Afinding-project-1",
    );

    // JUMP-TO: the locale-branch decision links into the reviewer queue scoped
    // to its branch + addressable by decisionId.
    const branchLink = screen.getByRole("link", { name: "Protected span moved" });
    expect(branchLink.getAttribute("href")).toBe(
      "/reviewer-queue?localeBranchId=locale-1&decisionId=locale_branch_finding%3Afinding-locale-1",
    );

    // JUMP-TO: the runtime-validation decision links into the reviewer queue
    // scoped to its branch (the runtime run's branch context) + decisionId.
    const runtimeLink = screen.getByRole("link", { name: "Runtime validation: text_mismatch" });
    expect(runtimeLink.getAttribute("href")).toBe(
      "/reviewer-queue?localeBranchId=locale-1&decisionId=runtime_validation%3Afinding-runtime-1",
    );

    // SIGNAL: the runtime decision's status badge surfaces its sourced
    // runtimeStatus (`failed`), never a fabricated neutral.
    const runtimeRow = runtimeLink.closest("tr");
    expect(runtimeRow).not.toBeNull();
    expect(runtimeRow).toHaveTextContent("failed");

    // SCOPE: the project row's scope reads "Project"; the runtime row reads its
    // run id.
    expect(runtimeRow).toHaveTextContent("Runtime run runtime-1");
    const projectRow = projectLink.closest("tr");
    expect(projectRow).not.toBeNull();
    expect(projectRow).toHaveTextContent("Project");
  });

  it("filters the queue by the decision-kind NavPills", async () => {
    render(<DecisionsBand />);
    // Wait for ready.
    expect(
      await screen.findByRole("link", { name: "Project terminology review" }),
    ).toBeInTheDocument();

    // All three decisions are present initially.
    expect(screen.getByRole("link", { name: "Protected span moved" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Runtime validation: text_mismatch" }),
    ).toBeInTheDocument();

    // The "Runtime" pill filters the queue to the runtime decision only.
    const nav = screen.getByLabelText("Pending decision categories");
    fireEvent.click(within(nav).getByRole("tab", { name: /Runtime/i }));

    expect(
      screen.getByRole("link", { name: "Runtime validation: text_mismatch" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Project terminology review" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Protected span moved" })).toBeNull();
  });

  it("paginates the queue when more than a page of decisions is returned", async () => {
    // 2 pages worth of branch decisions (> PAGE_SIZE=8) -> pagination renders.
    const many: DashboardDecisionReadModel = {
      projectId: "project-1",
      counts: {
        pendingDecisionCount: 10,
        projectFindingDecisionCount: 0,
        localeBranchFindingDecisionCount: 10,
        runtimeValidationDecisionCount: 0,
      },
      pendingDecisions: Array.from({ length: 10 }, (_, index) => ({
        ...dashboardDecisionsFixture.pendingDecisions[1],
        decisionId: `locale_branch_finding:finding-${index}`,
        title: `Branch decision ${index}`,
        targetLocale: "en-US",
      })),
    };
    server.use(http.get("*/api/projects/decisions", () => apiJson("projects.decisions", many)));

    render(<DecisionsBand />);
    const pagination = await screen.findByLabelText("Pending decisions pagination");
    expect(pagination).toHaveTextContent("Page 1 of 2");
    expect(pagination).toHaveTextContent("10 items");
  });

  it("shows the loading surface before the read model settles", () => {
    render(<DecisionsBand />);
    // The typed resource starts in `loading`; the panel paints the loading
    // surface synchronously on first render, before the fetch resolves.
    expect(screen.getByText("Loading decisions…")).toBeInTheDocument();
  });

  it("surfaces the empty state when no pending decisions are returned", async () => {
    server.use(
      http.get("*/api/projects/decisions", () =>
        apiJson("projects.decisions", {
          projectId: "project-1",
          counts: {
            pendingDecisionCount: 0,
            projectFindingDecisionCount: 0,
            localeBranchFindingDecisionCount: 0,
            runtimeValidationDecisionCount: 0,
          },
          pendingDecisions: [],
        }),
      ),
    );
    render(<DecisionsBand />);
    expect(await screen.findByText("No pending decisions returned.")).toBeInTheDocument();
  });

  it("surfaces a typed error state instead of a blank panel", async () => {
    server.use(
      http.get("*/api/projects/decisions", () =>
        HttpResponse.json(
          { code: "forbidden", error: "not permitted to read decisions" },
          { status: 403 },
        ),
      ),
    );
    render(<DecisionsBand />);
    expect(await screen.findByText("not permitted to read decisions")).toBeInTheDocument();
  });
});
