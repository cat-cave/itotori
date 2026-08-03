// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import type { ProjectOverviewReadModel } from "../src/project-overview-read-model.js";
import { ToastProvider } from "../src/ui/toast-host.js";
import { PassLedgerPanel } from "../src/ui/screens/PassLedgerPanel.js";
import { projectOverviewFixture } from "./api-fixtures.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type PassPhase = "empty" | "running" | "paused";

function overviewFor(phase: PassPhase): ProjectOverviewReadModel {
  const fixtureRow = projectOverviewFixture.journal.rows[0];
  if (fixtureRow === undefined)
    throw new Error("project overview fixture must include a journal row");
  if (phase === "empty") {
    return {
      ...projectOverviewFixture,
      journal: {
        ...projectOverviewFixture.journal,
        pagination: { ...projectOverviewFixture.journal.pagination, total: 0, pageCount: 0 },
        rows: [],
        latestRow: null,
      },
    };
  }
  const activeRow = { ...fixtureRow, journalRunId: "run-1", status: phase };
  return {
    ...projectOverviewFixture,
    journal: {
      ...projectOverviewFixture.journal,
      rows: [activeRow],
      latestRow: activeRow,
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("PassLedgerPanel durable pass controls", () => {
  it("refreshes from launch into Pause, then presents Resume after a pause", async () => {
    const localeBranchId = projectOverviewFixture.journal.filter.localeBranchId;
    if (localeBranchId === null)
      throw new Error("project overview fixture must include a locale branch");
    let phase: PassPhase = "empty";
    const requests: Array<{ url: string; method: string; body: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const rawUrl =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const url = new URL(rawUrl, "http://itotori.test").pathname;
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? init.body : null;
        requests.push({ url, method, body });
        if (url === "/api/projects/overview" && method === "GET") {
          return jsonResponse(overviewFor(phase));
        }
        if (
          url === `/api/projects/${projectOverviewFixture.projectId}/launch-pass` &&
          method === "POST"
        ) {
          phase = "running";
          return jsonResponse({
            schemaVersion: "itotori.projects.launch-pass.v1",
            outcome: "started",
            journalRunId: "run-1",
            startedAt: "2026-08-03T12:00:00.000Z",
            refusalMessage: null,
          });
        }
        if (
          url === `/api/projects/${projectOverviewFixture.projectId}/runs/run-1/pause` &&
          method === "POST"
        ) {
          phase = "paused";
          return jsonResponse({
            schemaVersion: "itotori.projects.pass-control.v1",
            action: "pause",
            journalRunId: "run-1",
            status: "paused",
            transitionedAt: "2026-08-03T12:01:00.000Z",
          });
        }
        return jsonResponse({ code: "not_found", error: `unexpected ${method} ${url}` }, 404);
      }),
    );

    render(
      <ToastProvider defaultDurationMs={0}>
        <PassLedgerPanel />
      </ToastProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Launch next pass" }));
    const pause = await screen.findByRole("button", { name: "Pause pass" });
    expect(pause).toHaveAttribute("data-action", "pause-pass");

    fireEvent.click(pause);
    const resume = await screen.findByRole("button", { name: "Resume pass" });
    expect(resume).toHaveAttribute("data-action", "resume-pass");

    expect(requests).toContainEqual({
      url: `/api/projects/${projectOverviewFixture.projectId}/launch-pass`,
      method: "POST",
      body: JSON.stringify({ localeBranchId }),
    });
    expect(requests).toContainEqual({
      url: `/api/projects/${projectOverviewFixture.projectId}/runs/run-1/pause`,
      method: "POST",
      body: JSON.stringify({}),
    });
  });
});
