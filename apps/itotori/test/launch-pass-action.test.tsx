// @vitest-environment jsdom
// HI-FI STUDIO EPIC · Overview — behavior-first test for the launch-pass action
// (spec/ovw-launch2).
//
// Mounts the REAL `LaunchPassAction` (and the `PassLedgerPanel` that hosts it)
// over an msw-intercepted `/api/projects/:projectId/launch-pass` and asserts
// the OBSERVABLE behavior:
//
//   1. a `canSteer` user sees the "Launch next pass" button; clicking it POSTs
//      to `projects.launchPass` (folds queued corrections + drives the next
//      pass via the driver) with the server-scoped locale branch, and the
//      started outcome renders in-strip;
//   2. a non-`canSteer` user sees the action HIDDEN (no button, no POST);
//   3. a driver REFUSAL surfaces as a visible alert, never a silent success.
//
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named; only
// the rendered button + the API POST it emits + the outcome surfaces are
// asserted, over msw, through the typed client (no ad-hoc fetch).

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ApiLaunchPassResponse } from "../src/api-schema.js";
import { LaunchPassAction, PassLedgerPanel } from "../src/ui/screens/PassLedgerPanel.js";
import { ToastProvider } from "../src/ui/toast-host.js";
import { apiJson } from "./msw-handlers.js";
import { projectOverviewFixture } from "./api-fixtures.js";

const LAUNCH_PATH = "*/api/projects/:projectId/launch-pass";
const OVERVIEW_PATH = "*/api/projects/overview";

const startedResponse: ApiLaunchPassResponse = {
  schemaVersion: "itotori.projects.launch-pass.v1",
  outcome: "started",
  journalRunId: "localization-journal-run-7",
  startedAt: "2026-07-08T00:00:00.000Z",
  refusalMessage: null,
};

const refusedResponse: ApiLaunchPassResponse = {
  schemaVersion: "itotori.projects.launch-pass.v1",
  outcome: "refused",
  journalRunId: null,
  startedAt: null,
  refusalMessage: "a pass is already running for this branch",
};

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

function renderWithToasts(ui: ReactNode): void {
  render(<ToastProvider>{ui}</ToastProvider>);
}

describe("ovw-launch-pass-action — LaunchPassAction", () => {
  it("disables + explains the action for a non-canSteer user (no POST)", () => {
    // fnd-caps-context — a denied action is disabled + explained, not hidden.
    render(
      <LaunchPassAction
        canSteer={false}
        steerDenial="user anon is missing permission draft.write"
        projectId="project-1"
        localeBranchId="locale-1"
      />,
    );
    const button = screen.getByRole("button", { name: /launch next pass/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "user anon is missing permission draft.write");
    expect(screen.getByRole("note")).toHaveAttribute("data-cap-denial", "steer");
    expect(document.querySelector('[data-launch-pass="denied"]')).not.toBeNull();
  });

  it("hides the action when no locale branch is selectable", () => {
    render(<LaunchPassAction canSteer projectId="project-1" localeBranchId={null} />);
    expect(screen.queryByRole("button", { name: /launch next pass/i })).not.toBeInTheDocument();
  });

  it("a canSteer click drives the next pass via the endpoint and renders the started outcome", async () => {
    const observed: { url: string | null; body: unknown } = { url: null, body: null };
    server.use(
      http.post(LAUNCH_PATH, async ({ request }) => {
        observed.url = request.url;
        observed.body = await request.json();
        return apiJson("projects.launchPass", startedResponse);
      }),
    );

    renderWithToasts(<LaunchPassAction canSteer projectId="project-1" localeBranchId="locale-1" />);
    const button = screen.getByRole("button", { name: "Launch next pass" });
    fireEvent.click(button);

    await waitFor(() => {
      expect(observed.body).not.toBeNull();
    });
    // The action POSTs to the project-scoped launch-pass endpoint (the driver
    // seam) carrying the locale branch it is scoped to — through the typed
    // client, not an ad-hoc fetch.
    expect(observed.url).toContain("/api/projects/project-1/launch-pass");
    expect(observed.body).toEqual({ localeBranchId: "locale-1" });
    // The started outcome is surfaced in-strip (and as a shell toast). Use
    // the launch-pass marker so the toast's journal-run copy does not
    // collide with a free-text getByText.
    await waitFor(() => {
      expect(document.querySelector('[data-launch-pass="started"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-launch-pass="started"]')).toHaveTextContent(
      /Journal localization-journal-run-7 started/i,
    );
  });

  it("surfaces a driver refusal as a visible alert (never a silent success)", async () => {
    server.use(http.post(LAUNCH_PATH, () => apiJson("projects.launchPass", refusedResponse)));

    renderWithToasts(<LaunchPassAction canSteer projectId="project-1" localeBranchId="locale-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Launch next pass" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/a pass is already running for this branch/i);
    expect(screen.queryByText(/started/i)).not.toBeInTheDocument();
  });

  it("PassLedgerPanel renders the launch action off the overview's canSteer signal", async () => {
    server.use(
      http.get(OVERVIEW_PATH, () =>
        apiJson("projects.overview", { ...projectOverviewFixture, canSteer: true }),
      ),
    );
    renderWithToasts(<PassLedgerPanel />);
    expect(await screen.findByRole("button", { name: "Launch next pass" })).toBeInTheDocument();
  });

  it("PassLedgerPanel disables + explains the launch action when the overview reports canSteer=false", async () => {
    // fnd-caps-context — denied steer is disabled + explained, not hidden.
    server.use(
      http.get(OVERVIEW_PATH, () =>
        apiJson("projects.overview", { ...projectOverviewFixture, canSteer: false }),
      ),
    );
    renderWithToasts(<PassLedgerPanel />);
    await waitFor(() => {
      expect(document.querySelector('[data-panel-state="ready"]')).not.toBeNull();
    });
    const button = screen.getByRole("button", { name: "Launch next pass" });
    expect(button).toBeDisabled();
    expect(document.querySelector('[data-launch-pass="denied"]')).not.toBeNull();
  });
});
