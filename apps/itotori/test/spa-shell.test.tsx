// @vitest-environment jsdom
// fnd-spa-shell — behavior-first test for the served React SPA.
//
// Mounts the real `App` shell (the one `src/main.tsx` mounts + `server.ts`
// serves) against msw-intercepted `/api/*` responses and asserts the
// OBSERVABLE rendered behavior — that the shell CONSUMES the typed API and
// renders the ported parity views:
//   - the Workbench dashboard's Projects / Status / Model-cost /
//     Reviewer-queue / Pending-decisions panels,
//   - the reviewer-detail screen,
//   - the localization workspace project-browse screen.
//
// Playwright-against-a-live-server would prove the same served behavior, but
// the repo's browser-driven e2e harness (runtime-web-review) is a separate
// track; this jsdom + msw mount is the established app-test seam (the api-
// client + ds tests use it) and asserts the same real behavior: a route ->
// a screen that reads `/api/*` through the typed client and paints the DOM.
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named; only
// the states + panels the shell consumers see are asserted.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { App } from "../src/ui/App.js";
import { readyContextFixture } from "../src/reviewer/index.js";
import { workspaceProjectBrowseFixture } from "../src/workspace/index.js";
import {
  costDrilldownFixture,
  costReportFixture,
  dashboardDecisionsFixture,
  dashboardStatusFixture,
  projectOverviewFixture,
} from "./api-fixtures.js";
import {
  apiJson,
  authCapabilitiesMswHandler,
  authIdentityMswHandler,
  reviewerQueueDashboardApiFixture,
} from "./msw-handlers.js";

const reviewerDetailContext = readyContextFixture();

// Host-agnostic handlers: the shell's client issues RELATIVE `/api/*` calls,
// which jsdom resolves against the test origin; `*/…` matches that origin.
const server = setupServer(
  authCapabilitiesMswHandler,
  authIdentityMswHandler,
  http.get("*/api/projects", () =>
    apiJson("projects.list", { projects: [dashboardStatusFixture] }),
  ),
  http.get("*/api/projects/status", () => apiJson("projects.status", dashboardStatusFixture)),
  http.get("*/api/projects/decisions", () =>
    apiJson("projects.decisions", dashboardDecisionsFixture),
  ),
  http.get("*/api/projects/cost", () => apiJson("projects.cost", costReportFixture)),
  http.get("*/api/projects/cost/drilldown", () =>
    apiJson("projects.costDrilldown", costDrilldownFixture),
  ),
  http.get("*/api/projects/overview", () => apiJson("projects.overview", projectOverviewFixture)),
  http.get("*/api/reviewer/queue", () =>
    apiJson("reviewer.queue", reviewerQueueDashboardApiFixture()),
  ),
  http.get("*/api/reviewer/queue/:reviewItemId/detail", () =>
    apiJson("reviewer.detail", reviewerDetailContext),
  ),
  http.get("*/api/workspace/projects", () =>
    apiJson("workspace.projects", workspaceProjectBrowseFixture()),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

describe("SPA shell — Workbench dashboard", () => {
  it("consumes /api/* and renders the projects / status / cost / reviewer-queue / decisions panels", async () => {
    render(<App location={{ pathname: "/", search: "" }} />);

    // Status strip (projects.status) — the project shell context.
    const strip = await screen.findByLabelText("Project summary");
    expect(within(strip).getByText("project-1")).toBeInTheDocument();

    // Projects panel (projects.list) rendered as a ds DataTable.
    expect(await screen.findByRole("heading", { name: "Projects" })).toBeInTheDocument();
    expect(await screen.findByRole("columnheader", { name: "Findings" })).toBeInTheDocument();

    // Reviewer queue panel (reviewer.queue) — aggregate + a detail link.
    expect(await screen.findByRole("heading", { name: "Reviewer queue" })).toBeInTheDocument();
    expect(await screen.findByText("Preview batch actions")).toBeInTheDocument();

    // Model cost panel (projects.cost) — the empirical $25 target.
    expect(await screen.findByRole("heading", { name: "Model cost" })).toBeInTheDocument();
    const billed = costReportFixture.billedMicrosUsd / 1_000_000;
    expect((await screen.findAllByText(`$${billed.toFixed(6)}`)).length).toBeGreaterThan(0);

    // Pending decisions band (projects.decisions).
    expect(await screen.findByRole("heading", { name: /pending decision/i })).toBeInTheDocument();
  });

  it("surfaces a typed API error state instead of a blank panel", async () => {
    server.use(
      http.get("*/api/projects/cost", () =>
        HttpResponse.json(
          { code: "forbidden", error: "not permitted to read cost" },
          { status: 403 },
        ),
      ),
    );
    render(<App location={{ pathname: "/", search: "" }} />);
    // The cost panel error surfaces the typed code (not a fabricated empty).
    expect(await screen.findByText("not permitted to read cost")).toBeInTheDocument();
  });
});

describe("SPA shell — reviewer detail", () => {
  it("renders the reviewer-detail screen from /api/reviewer/queue/:id/detail", async () => {
    render(
      <App
        location={{ pathname: `/reviewer-queue/${reviewerDetailContext.reviewItemId}`, search: "" }}
      />,
    );
    // Wait for a ready-only panel first (the <main> also exists while loading).
    expect(await screen.findByRole("heading", { name: "Source unit" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Comparison" })).toBeInTheDocument();
    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("data-screen", "reviewer-detail");
    expect(main).toHaveAttribute("data-state", "ready");
  });
});

describe("SPA shell — localization workspace", () => {
  it("renders the workspace project-browse screen from /api/workspace/projects", async () => {
    render(<App location={{ pathname: "/workspace", search: "" }} />);
    // A project name + branch link only render after workspace.projects loads.
    expect(await screen.findByRole("heading", { name: "Oshioki Sweetie HD" })).toBeInTheDocument();
    expect(await screen.findByText("English (informal)")).toBeInTheDocument();
    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("data-screen", "workspace");
    expect(main).toHaveAttribute("data-view", "projects");
  });

  it("submits line/scene correction annotations through the typed workspace correction route", async () => {
    const posts: unknown[] = [];
    server.use(
      http.get("*/api/workspace/corrections", () =>
        apiJson("workspace.correctionPreview", {
          schemaVersion: "workspace.correction_preview.v0.1",
          generatedAt: "2026-07-09T00:00:00.000Z",
          permission: {
            actorUserId: "reviewer-1",
            canReadQueue: true,
            canManageQueue: true,
            denialReasons: [],
          },
          projectId: "project-1",
          localeBranchId: "locale-1",
          sourceBundleId: null,
          targetLocale: "en-US",
          units: [
            {
              reviewItemId: "review-item-1",
              localeBranchId: "locale-1",
              sourceRevisionId: "source-revision-1",
              bridgeUnitId: "bridge-unit-1",
              sourceUnitKey: "unit.key.1",
              sourceLocale: "ja-JP",
              sourceText: "源文",
              targetLocale: "en-US",
              draftText: "Draft text.",
              finalText: null,
              styleGuidePolicyVersionId: null,
              styleGuidePolicyStatus: null,
              glossary: [],
              runtimeEvidenceLinks: [],
              screenshotArtifactHashes: [],
              diagnostics: [],
            },
          ],
          diagnostics: [],
        }),
      ),
      http.post("*/api/workspace/corrections", async ({ request }) => {
        const body = await request.json();
        posts.push(body);
        return apiJson("workspace.correctionSubmit", {
          schemaVersion: "workspace.correction_submit.v0.1",
          generatedAt: "2026-07-09T00:00:01.000Z",
          permission: {
            actorUserId: "reviewer-1",
            canReadQueue: true,
            canManageQueue: true,
            denialReasons: [],
          },
          localeBranchId: "locale-1",
          batchId: "workspace-correction-batch-test",
          batchLabel: null,
          submittedCount: 1,
          edits: [],
          repairCandidateReportIds: [],
          decisionQueueReportIds: [],
          needsContextReportIds: [],
          affectedBridgeUnitIds: ["bridge-unit-1"],
          writebacks: [],
          scheduledRerunJobIds: [],
          diagnostics: [],
        });
      }),
    );

    render(
      <App
        location={{
          pathname: "/workspace/corrections",
          search: "?localeBranchId=locale-1&reviewItemIds=review-item-1",
        }}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Manual corrections" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Correction text"), {
      target: { value: "Corrected text." },
    });
    fireEvent.change(screen.getByLabelText("Note"), {
      target: { value: "Scene-level consistency issue." },
    });
    fireEvent.change(screen.getByLabelText("Severity"), { target: { value: "critical" } });
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "scene" } });
    fireEvent.change(screen.getByLabelText("Scene id"), { target: { value: "scene-alpha" } });
    fireEvent.click(screen.getByRole("button", { name: /Submit corrections/i }));

    await waitFor(() => {
      expect(posts).toHaveLength(1);
    });
    expect(posts[0]).toMatchObject({
      projectId: "project-1",
      localeBranchId: "locale-1",
      targetLocale: "en-US",
      actorUserId: "reviewer-1",
      corrections: [
        {
          bridgeUnitId: "bridge-unit-1",
          sourceRevisionId: "source-revision-1",
          sourceUnitKey: "unit.key.1",
          severity: "critical",
          scope: { kind: "scene", sceneId: "scene-alpha" },
          reason: "Scene-level consistency issue.",
          correctedText: "Corrected text.",
        },
      ],
    });
    expect(await screen.findByText("Submitted 1 correction(s).")).toBeInTheDocument();
  });
});

describe("SPA shell — members", () => {
  it("lists members and grants a permission set through the typed permission editor API", async () => {
    let directorGranted = false;
    const grantRequests: unknown[] = [];
    server.use(
      http.get("*/api/auth/members", () =>
        apiJson("auth.members.list", {
          schemaVersion: "itotori.auth.members.v0",
          accountId: "account-local",
          members: [
            {
              membershipId: "membership-api",
              accountId: "account-local",
              userId: "user-api-member",
              principalId: "principal-api-member",
              email: "member@example.test",
              displayName: "API Member",
              permissionSetIds: directorGranted
                ? ["permission-set-account-local-director", "permission-set-account-local-reviewer"]
                : ["permission-set-account-local-reviewer"],
              createdAt: "2026-07-08T00:00:00.000Z",
            },
          ],
        }),
      ),
      http.get("*/api/auth/permission-sets", () =>
        apiJson("auth.permissionSets.list", {
          schemaVersion: "itotori.auth.permission-sets.v0",
          accountId: "account-local",
          permissionSets: [
            {
              permissionSetId: "permission-set-account-local-reviewer",
              accountId: "account-local",
              name: "Reviewer",
              permissions: ["queue.read", "queue.manage"],
            },
            {
              permissionSetId: "permission-set-account-local-director",
              accountId: "account-local",
              name: "Director",
              permissions: ["project.import", "patch.export"],
            },
          ],
        }),
      ),
      http.post(
        "*/api/auth/principals/:principalId/permission-sets/:permissionSetId/grant",
        async ({ params, request }) => {
          grantRequests.push(await request.json());
          directorGranted = true;
          return apiJson("auth.permissionSets.grant", {
            schemaVersion: "itotori.auth.permission-set-grant.v0",
            principalId: String(params.principalId),
            permissionSetId: String(params.permissionSetId),
            action: "granted",
            updatedMember: {
              membershipId: "membership-api",
              accountId: "account-local",
              userId: "user-api-member",
              principalId: String(params.principalId),
              email: "member@example.test",
              displayName: "API Member",
              permissionSetIds: [
                "permission-set-account-local-director",
                "permission-set-account-local-reviewer",
              ],
              createdAt: "2026-07-08T00:00:00.000Z",
            },
          });
        },
      ),
    );

    render(<App location={{ pathname: "/members", search: "" }} />);

    expect(await screen.findByText("API Member")).toBeInTheDocument();
    const reviewer = await screen.findByLabelText("Revoke Reviewer for API Member");
    expect(reviewer).toBeChecked();

    const director = await screen.findByLabelText("Grant Director for API Member");
    expect(director).not.toBeChecked();
    fireEvent.click(director);

    await waitFor(() => {
      expect(grantRequests).toEqual([{ reason: null, requestId: null }]);
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Revoke Director for API Member")).toBeChecked();
    });
  });
});
