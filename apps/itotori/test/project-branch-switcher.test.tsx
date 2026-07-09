// @vitest-environment jsdom
// shell-project-branch-switcher (HI-FI STUDIO EPIC · Shell) — behavior-first
// test for the project + locale-branch switcher.
//
// Asserts the OBSERVABLE behavior a viewer sees, per the acceptance:
//   1. the switcher lists the projects the typed client sees and, for the
//      effective project, its locale branches (game-agnostic — only ids +
//      names / locales, no title baked in);
//   2. picking a branch switches the shell context — the status-bar Branch
//      cell reflects the picked branch (the client-state overlay model the
//      hi-fi store uses);
//   3. picking a project switches the effective project and resets the branch;
//   4. loading / empty / error degrade the panel without crashing the chrome.
//
// The PURE builders + the effective-selection reconciliation rule are asserted
// without a DOM; the DOM suite asserts the rendered disclosure + the switch
// driving the chrome through the REAL ShellFrame.
//
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named; only
// the rendered switcher states + the effective-selection behavior are asserted,
// over the real `projects.list` / `projects.status` shapes.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { LocaleBranchStatus, ProjectDashboardStatus } from "@itotori/db";
import { RedactionGovernor } from "../src/ui/redaction-governor.js";
import { ShellFrame } from "../src/ui/shell-frame.js";
import { ShellSelectionProvider } from "../src/ui/shell-selection.js";
import {
  ProjectBranchSwitcher,
  buildSwitcherBranches,
  buildSwitcherProjects,
  resolveEffectiveSelection,
  selectBranchesForProject,
  serverSelectionFromStatus,
} from "../src/ui/project-branch-switcher.js";
import { apiJson } from "./msw-handlers.js";
import { costReportFixture, dashboardStatusFixture } from "./api-fixtures.js";

// ---------------------------------------------------------------------------
// Fixtures — a SECOND project so the switcher lists more than one (the shared
// fixture is a single project). Built off the real ProjectDashboardStatus shape
// so the typed client's `assertItotoriApiResponse` accepts the response.
// ---------------------------------------------------------------------------

const EN_US_BRANCH: LocaleBranchStatus = {
  localeBranchId: "locale-1",
  targetLocale: "en-US",
  status: "active",
  currentStyleGuidePolicyVersionId: null,
  unitCount: 1,
  translatedUnitCount: 1,
  openFindingCount: 1,
  artifactCount: 3,
};

const FR_FR_BRANCH: LocaleBranchStatus = {
  localeBranchId: "019ed065-0000-7000-8000-000000000110",
  targetLocale: "fr-FR",
  status: "active",
  currentStyleGuidePolicyVersionId: "019ed065-0000-7000-8000-000000000120",
  unitCount: 1,
  translatedUnitCount: 1,
  openFindingCount: 0,
  artifactCount: 1,
};

const DE_DE_BRANCH: LocaleBranchStatus = {
  localeBranchId: "locale-de",
  targetLocale: "de-DE",
  status: "active",
  currentStyleGuidePolicyVersionId: null,
  unitCount: 2,
  translatedUnitCount: 1,
  openFindingCount: 0,
  artifactCount: 0,
};

/** The active project (server-selected branch = fr-FR) with two branches. */
const activeProject: ProjectDashboardStatus = {
  ...dashboardStatusFixture,
  localeBranches: [EN_US_BRANCH, FR_FR_BRANCH],
  selectedLocaleBranchId: FR_FR_BRANCH.localeBranchId,
};

/** A second project the viewer can switch to (its own branch set). */
const otherProject: ProjectDashboardStatus = {
  ...dashboardStatusFixture,
  projectId: "project-2",
  projectKey: "project-2",
  name: "project-2",
  sourceLocale: "ja-JP",
  localeBranches: [DE_DE_BRANCH],
  selectedLocaleBranchId: DE_DE_BRANCH.localeBranchId,
};

const projectsListBody = { projects: [activeProject, otherProject] };

const server = setupServer(
  http.get("*/api/projects", () => apiJson("projects.list", projectsListBody)),
  http.get("*/api/projects/status", () => apiJson("projects.status", activeProject)),
  http.get("*/api/projects/cost", () => apiJson("projects.cost", costReportFixture)),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

describe("project-branch-switcher — pure builders", () => {
  it("buildSwitcherProjects lists projects in order, de-duplicating by projectId (game-agnostic)", () => {
    const projects = buildSwitcherProjects([activeProject, otherProject, activeProject]);
    expect(projects.map((p) => p.projectId)).toEqual(["project-1", "project-2"]);
    expect(projects.map((p) => p.name)).toEqual(["project-1", "project-2"]);
    // Only the opaque ids + name — no title / work baked in.
    expect(projects[0]).toEqual({
      projectId: "project-1",
      projectKey: "project-1",
      name: "project-1",
    });
  });

  it("buildSwitcherBranches carries targetLocale + status for each branch", () => {
    const branches = buildSwitcherBranches([EN_US_BRANCH, FR_FR_BRANCH]);
    expect(branches.map((b) => b.targetLocale)).toEqual(["en-US", "fr-FR"]);
    expect(branches.map((b) => b.status)).toEqual(["active", "active"]);
  });

  it("selectBranchesForProject returns the project's branches, [] for unknown / null", () => {
    expect(
      selectBranchesForProject([activeProject, otherProject], "project-1").map(
        (b) => b.targetLocale,
      ),
    ).toEqual(["en-US", "fr-FR"]);
    expect(
      selectBranchesForProject([activeProject, otherProject], "project-2").map(
        (b) => b.targetLocale,
      ),
    ).toEqual(["de-DE"]);
    expect(selectBranchesForProject([activeProject, otherProject], "unknown")).toEqual([]);
    expect(selectBranchesForProject([activeProject, otherProject], null)).toEqual([]);
  });

  it("serverSelectionFromStatus reads projectId + selectedLocaleBranchId, null on null", () => {
    expect(serverSelectionFromStatus(activeProject)).toEqual({
      projectId: "project-1",
      localeBranchId: FR_FR_BRANCH.localeBranchId,
    });
    expect(serverSelectionFromStatus({ ...activeProject, selectedLocaleBranchId: null })).toEqual({
      projectId: "project-1",
      localeBranchId: null,
    });
    expect(serverSelectionFromStatus(null)).toEqual({ projectId: null, localeBranchId: null });
  });
});

describe("project-branch-switcher — resolveEffectiveSelection reconciliation", () => {
  const SERVER = { projectId: "project-1", localeBranchId: FR_FR_BRANCH.localeBranchId };

  it("falls back to the server selection when no override is set", () => {
    expect(resolveEffectiveSelection(SERVER, { projectId: null, localeBranchId: null })).toEqual(
      SERVER,
    );
  });

  it("a branch override wins within the server project", () => {
    expect(
      resolveEffectiveSelection(SERVER, {
        projectId: null,
        localeBranchId: EN_US_BRANCH.localeBranchId,
      }),
    ).toEqual({ projectId: "project-1", localeBranchId: EN_US_BRANCH.localeBranchId });
  });

  it("a project override wins AND invalidates the server-selected branch (it belongs to the server project)", () => {
    expect(
      resolveEffectiveSelection(SERVER, { projectId: "project-2", localeBranchId: null }),
    ).toEqual({
      projectId: "project-2",
      localeBranchId: null,
    });
  });

  it("a project + branch override carries both", () => {
    expect(
      resolveEffectiveSelection(SERVER, {
        projectId: "project-2",
        localeBranchId: DE_DE_BRANCH.localeBranchId,
      }),
    ).toEqual({ projectId: "project-2", localeBranchId: DE_DE_BRANCH.localeBranchId });
  });

  it("handles a null server selection", () => {
    expect(
      resolveEffectiveSelection(
        { projectId: null, localeBranchId: null },
        { projectId: "project-2", localeBranchId: null },
      ),
    ).toEqual({ projectId: "project-2", localeBranchId: null });
  });
});

describe("project-branch-switcher — disclosure behavior", () => {
  function mountSwitcher(
    serverSelection = serverSelectionFromStatus(activeProject),
    onSelect?: (selection: { projectId: string | null; localeBranchId: string | null }) => void,
  ): void {
    render(
      <ShellSelectionProvider>
        <ProjectBranchSwitcher
          serverSelection={serverSelection}
          {...(onSelect !== undefined ? { onSelect } : {})}
        />
      </ShellSelectionProvider>,
    );
  }

  function openPanel(): HTMLElement {
    fireEvent.click(screen.getByRole("button", { name: "Project & branch" }));
    return screen.getByRole("menu", { name: "Switch project and locale branch" });
  }

  it("renders a collapsed trigger and no panel until opened", () => {
    mountSwitcher();
    const trigger = screen.getByRole("button", { name: "Project & branch" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("lists every project + the effective project's branches when opened, marking the current selection", async () => {
    mountSwitcher();
    const panel = openPanel();
    // Projects: both, project-1 marked active (server selection).
    const projectGroup = await within(panel).findByRole("group", { name: "Project" });
    const projectOptions = within(projectGroup).getAllByRole("menuitemradio");
    expect(projectOptions.map((option) => option.textContent)).toEqual(["project-1", "project-2"]);
    expect(projectOptions[0]).toHaveAttribute("aria-checked", "true");
    expect(projectOptions[1]).toHaveAttribute("aria-checked", "false");

    // Branches: the EFFECTIVE project's branches (project-1 → en-US, fr-FR),
    // fr-FR marked active (server-selected branch).
    const branchGroup = await within(panel).findByRole("group", { name: "Branch" });
    const branchOptions = within(branchGroup).getAllByRole("menuitemradio");
    expect(branchOptions.map((option) => option.textContent)).toEqual(["en-US", "fr-FR"]);
    expect(branchOptions[0]).toHaveAttribute("aria-checked", "false");
    expect(branchOptions[1]).toHaveAttribute("aria-checked", "true");
  });

  it("switches branch on pick — marks the picked branch active + fires onSelect", async () => {
    const onSelect = vi.fn();
    mountSwitcher(serverSelectionFromStatus(activeProject), onSelect);
    const panel = openPanel();
    const branchGroup = await within(panel).findByRole("group", { name: "Branch" });
    fireEvent.click(within(branchGroup).getByText("en-US"));
    // The picked branch is now the active one.
    const reopened = screen.getByRole("menu", { name: "Switch project and locale branch" });
    const branches = within(within(reopened).getByRole("group", { name: "Branch" })).getAllByRole(
      "menuitemradio",
    );
    expect(branches[0]).toHaveAttribute("aria-checked", "true");
    expect(branches[1]).toHaveAttribute("aria-checked", "false");
    expect(onSelect).toHaveBeenCalledWith({
      projectId: "project-1",
      localeBranchId: EN_US_BRANCH.localeBranchId,
    });
  });

  it("switches project on pick — marks the picked project active + resets the branch", async () => {
    const onSelect = vi.fn();
    mountSwitcher(serverSelectionFromStatus(activeProject), onSelect);
    const panel = openPanel();
    const projectGroup = await within(panel).findByRole("group", { name: "Project" });
    fireEvent.click(within(projectGroup).getByText("project-2"));
    const reopened = screen.getByRole("menu", { name: "Switch project and locale branch" });
    const projects = within(within(reopened).getByRole("group", { name: "Project" })).getAllByRole(
      "menuitemradio",
    );
    expect(projects[0]).toHaveAttribute("aria-checked", "false");
    expect(projects[1]).toHaveAttribute("aria-checked", "true");
    // The branch list now reflects project-2's branches (de-DE); none is
    // active because the project switch reset the branch override.
    const branchOptions = within(
      within(reopened).getByRole("group", { name: "Branch" }),
    ).getAllByRole("menuitemradio");
    expect(branchOptions.map((option) => option.textContent)).toEqual(["de-DE"]);
    expect(branchOptions[0]).toHaveAttribute("aria-checked", "false");
    expect(onSelect).toHaveBeenCalledWith({ projectId: "project-2", localeBranchId: null });
  });

  it("degrades the panel to loading while the projects read is in flight", () => {
    server.use(http.get("*/api/projects", () => new Promise(() => {})));
    mountSwitcher();
    const panel = openPanel();
    expect(panel).toHaveTextContent("Loading…");
  });

  it("degrades the panel to unavailable when the projects read fails", async () => {
    server.use(
      http.get("*/api/projects", () =>
        HttpResponse.json({ code: "internal_error", error: "down" }, { status: 500 }),
      ),
    );
    mountSwitcher();
    const panel = openPanel();
    expect(await within(panel).findByText("Unavailable")).toBeInTheDocument();
  });
});

describe("project-branch-switcher — shell-frame wiring (switch drives the chrome)", () => {
  // Mounts the REAL ShellFrame so the switcher is exercised in its real mount
  // context: the status bar reads the SAME `projects.list` the switcher does,
  // so picking a branch updates the status-bar Branch cell end-to-end. The
  // status-bar cells are scoped via the `role="status"` region so the
  // assertion is unambiguous (the open switcher panel lists the same labels).
  function statusBar(): HTMLElement {
    return screen.getByRole("status", { name: "Shell status bar" });
  }

  it("picking a branch in the switcher updates the status-bar Branch cell", async () => {
    render(
      <RedactionGovernor>
        <ShellFrame location={{ pathname: "/", search: "" }} navigate={vi.fn()}>
          <div data-screen-stub />
        </ShellFrame>
      </RedactionGovernor>,
    );
    // The status bar initially reflects the server-selected branch (fr-FR).
    expect(await within(statusBar()).findByText("fr-FR")).toBeInTheDocument();

    // Open the switcher and pick the en-US branch.
    fireEvent.click(screen.getByRole("button", { name: "Project & branch" }));
    const panel = screen.getByRole("menu", { name: "Switch project and locale branch" });
    const branchGroup = await within(panel).findByRole("group", { name: "Branch" });
    fireEvent.click(within(branchGroup).getByText("en-US"));

    // The status-bar Branch cell now shows the picked branch (en-US).
    const branchCell = within(statusBar())
      .getByText("Branch")
      .closest('[data-shell-stat="branch"]');
    expect(branchCell).not.toBeNull();
    expect(branchCell).toHaveTextContent("en-US");
    // The source → branch cell reflects sourceLocale → picked branch too.
    const sourceCell = within(statusBar())
      .getByText("Source → Branch")
      .closest('[data-shell-stat="source-to-branch"]');
    expect(sourceCell).toHaveTextContent("ja-JP → en-US");
  });

  it("picking a different project in the switcher updates the status-bar Project + Branch cells", async () => {
    render(
      <RedactionGovernor>
        <ShellFrame location={{ pathname: "/", search: "" }} navigate={vi.fn()}>
          <div data-screen-stub />
        </ShellFrame>
      </RedactionGovernor>,
    );
    expect(await within(statusBar()).findByText("project-1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Project & branch" }));
    const panel = screen.getByRole("menu", { name: "Switch project and locale branch" });
    const projectGroup = await within(panel).findByRole("group", { name: "Project" });
    fireEvent.click(within(projectGroup).getByText("project-2"));
    // The Project cell now shows project-2; the branch cell has no selection
    // (the project switch reset the branch override → none selected).
    const projectCell = within(statusBar())
      .getByText("Project")
      .closest('[data-shell-stat="project"]');
    expect(projectCell).toHaveTextContent("project-2");
    const branchCell = within(statusBar())
      .getByText("Branch")
      .closest('[data-shell-stat="branch"]');
    expect(branchCell).toHaveTextContent("none selected");
  });
});
