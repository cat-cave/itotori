// @vitest-environment jsdom
// fnd-spa-shell — behavior-first test for the served React SPA.
//
// Mounts the real `App` shell (the one `src/main.tsx` mounts + `server.ts`
// serves) against msw-intercepted `/api/*` responses and asserts the
// OBSERVABLE rendered behavior — that the shell CONSUMES the typed API and
// renders the ported parity views:
//   - the Workbench dashboard's Projects / Status / Model-cost /
//     Reviewer-queue / Pending-decisions panels,
//   - the settings privacy + model-routing screens,
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
  bridgeFixture,
  bridgeImportResponseFixture,
  branchPolicySettingsFixture,
  bmkCockpitFixture,
  catalogOpportunitiesFixture,
  costDrilldownFixture,
  costReportFixture,
  dashboardDecisionsFixture,
  dashboardStatusFixture,
  draftBranchResponseFixture,
  jobsRunTableFixture,
  modelRoutingSettingsFixture,
  projectOverviewFixture,
  runtimeStatusFixture,
  translationScopeSettingsFixture,
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
  http.get("*/api/jobs/run-table", () => apiJson("jobs.runTable", jobsRunTableFixture)),
  http.get("*/api/projects/overview", () => apiJson("projects.overview", projectOverviewFixture)),
  http.get("*/api/projects/:projectId/bmk-cockpit", () =>
    apiJson("projects.bmkCockpit", bmkCockpitFixture),
  ),
  http.get("*/api/catalog/opportunities", () =>
    apiJson("catalog.opportunities", catalogOpportunitiesFixture),
  ),
  http.get("*/api/reviewer/queue", () =>
    apiJson("reviewer.queue", reviewerQueueDashboardApiFixture()),
  ),
  http.get("*/api/reviewer/queue/:reviewItemId/detail", () =>
    apiJson("reviewer.detail", reviewerDetailContext),
  ),
  http.get("*/api/workspace/projects", () =>
    apiJson("workspace.projects", workspaceProjectBrowseFixture()),
  ),
  http.get("*/api/settings/model-routing", () =>
    apiJson("settings.modelRouting.get", modelRoutingSettingsFixture),
  ),
  http.get("*/api/projects/:projectId/locale-branches/:localeBranchId/settings/branch-policy", () =>
    apiJson("settings.branchPolicy.get", branchPolicySettingsFixture),
  ),
  http.get(
    "*/api/projects/:projectId/locale-branches/:localeBranchId/settings/translation-scope",
    () => apiJson("settings.translationScope.get", translationScopeSettingsFixture),
  ),
  http.get("*/api/runtime/v0.2/status", () => apiJson("runtime.status", runtimeStatusFixture)),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

describe("SPA shell — Workbench dashboard", () => {
  it("consumes /api/* and renders the projects / status / cost / catalog-opportunities / reviewer-queue / decisions panels", async () => {
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

    // Jobs panel (jobs.runTable) — server-paged + virtualized.
    expect(await screen.findByRole("heading", { name: "Jobs" })).toBeInTheDocument();
    expect(await screen.findByLabelText("Jobs run table virtualized rows")).toHaveAttribute(
      "data-virtualized",
      "true",
    );

    // Model cost panel (projects.cost) — the empirical $25 target.
    expect(await screen.findByRole("heading", { name: "Model cost" })).toBeInTheDocument();
    const billed = costReportFixture.billedMicrosUsd / 1_000_000;
    expect((await screen.findAllByText(`$${billed.toFixed(6)}`)).length).toBeGreaterThan(0);

    // Catalog opportunities panel (catalog.opportunities) — compact API-backed
    // ranking surface on the main dashboard.
    expect(
      await screen.findByRole("heading", { name: "Catalog opportunities" }),
    ).toBeInTheDocument();
    const opportunityTable = screen.getByRole("table", { name: "Catalog opportunity rows" });
    expect(within(opportunityTable).getByText(/Opportunity API Fixture/u)).toBeInTheDocument();
    expect(within(opportunityTable).getByText("Score 100")).toBeInTheDocument();
    expect(
      within(opportunityTable).getByText(/patch supported \/ runtime partial/u),
    ).toBeInTheDocument();
    expect(within(opportunityTable).getByText("Very high")).toBeInTheDocument();
    expect(within(opportunityTable).getByText("Owned")).toBeInTheDocument();
    expect(
      within(opportunityTable).getByText(/translation completeness \+30/u),
    ).toBeInTheDocument();
    expect(within(opportunityTable).getByText(/demotion: none/u)).toBeInTheDocument();

    // Pending decisions band (projects.decisions).
    expect(await screen.findByRole("heading", { name: /pending decision/i })).toBeInTheDocument();
  });

  it("renders demoted catalog opportunities and keeps the dashboard alive on catalog schema failure", async () => {
    const baseRow = catalogOpportunitiesFixture.rows[0];
    server.use(
      http.get("*/api/catalog/opportunities", () =>
        apiJson("catalog.opportunities", {
          ...catalogOpportunitiesFixture,
          rows: [
            baseRow,
            {
              ...baseRow,
              rank: 2,
              workId: "work-opportunity-demoted",
              canonicalTitle: "Demoted Conflict Fixture",
              completenessPool: "conflict",
              decision: "demoted",
              score: -10,
              demotions: [
                {
                  reasonCode: "official_english_conflict",
                  conflictOrigin: "repository_derived",
                  conflictId: "conflict-opportunity-demoted",
                  severity: "warning",
                  sourceIds: [
                    {
                      catalogSource: "dlsite",
                      sourceId: "RJOPPAPI002",
                    },
                  ],
                },
              ],
              factorBreakdown: baseRow.factorBreakdown.map((factor) =>
                factor.factor === "platform_language_conflict"
                  ? {
                      ...factor,
                      rawValue: 1,
                      weightedScore: -60,
                      evidenceRefs: ["catalog-conflict:conflict-opportunity-demoted"],
                      explanationCode: "platform_language_conflict:official_english_conflict",
                    }
                  : factor,
              ),
              explanationCodes: [
                ...baseRow.explanationCodes.filter(
                  (code) => code !== "platform_language_conflict:none",
                ),
                "platform_language_conflict:official_english_conflict",
              ],
            },
          ],
        }),
      ),
    );

    render(<App location={{ pathname: "/", search: "" }} />);
    const opportunityTable = await screen.findByRole("table", { name: "Catalog opportunity rows" });
    expect(within(opportunityTable).getByText(/Demoted Conflict Fixture/u)).toBeInTheDocument();
    expect(within(opportunityTable).getByText("Demoted")).toBeInTheDocument();
    expect(
      within(opportunityTable).getByText(/demotion: official_english_conflict/u),
    ).toBeInTheDocument();

    cleanup();
    server.resetHandlers();
    server.use(http.get("*/api/catalog/opportunities", () => HttpResponse.json({})));

    render(<App location={{ pathname: "/", search: "" }} />);
    expect(
      await screen.findByText(
        "Route catalog.opportunities failed with status 200 (no typed error body).",
      ),
    ).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Projects" })).toBeInTheDocument();
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

describe("SPA shell — guided first run", () => {
  it("walks setup, candidate bootstrap, bridge import, locale branch creation, and workspace handoff through typed APIs", async () => {
    const ssoPosts: unknown[] = [];
    const projectPosts: unknown[] = [];
    const branchPosts: unknown[] = [];
    server.use(
      http.get("*/api/projects", () => apiJson("projects.list", { projects: [] })),
      http.post("*/api/settings/security/sso", async ({ request }) => {
        const body = await request.json();
        ssoPosts.push(body);
        return apiJson("auth.ssoSettings.configure", {
          ...(body as object),
          schemaVersion: "itotori.auth.sso-settings.v0",
          updatedAt: "2026-07-09T00:00:00.000Z",
        });
      }),
      http.post("*/api/imports/bridge", async ({ request }) => {
        const body = await request.json();
        projectPosts.push(body);
        return apiJson("imports.bridge", bridgeImportResponseFixture);
      }),
      http.post("*/api/projects/:projectId/branches", async ({ request }) => {
        const body = await request.json();
        branchPosts.push(body);
        return apiJson("branches.draft", draftBranchResponseFixture);
      }),
    );

    render(<App location={{ pathname: "/onboarding", search: "" }} />);

    expect(await screen.findByRole("heading", { name: "Guided setup" })).toBeInTheDocument();
    expect(await screen.findByText("No projects are visible yet.")).toBeInTheDocument();
    const candidateStep = screen.getByRole("region", { name: "Candidate step" });
    expect(within(candidateStep).getByText("ready")).toBeInTheDocument();
    const bootstrapButton = screen.getByRole("button", { name: "Bootstrap project" });
    expect(bootstrapButton).toBeDisabled();
    expect(
      screen.getAllByText("Choose a bridge JSON export for the selected candidate.").length,
    ).toBeGreaterThan(0);
    expect(screen.getByLabelText("Candidate")).toHaveValue("work-opportunity");
    expect(screen.getByText(/Selected Opportunity API Fixture/u)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Issuer URL"), {
      target: { value: "https://idp.example.test/oauth2/default" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save account setup" }));
    await waitFor(() => expect(ssoPosts).toHaveLength(1));
    expect(await screen.findByText("Security setup saved.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Target locale"), { target: { value: "fr-FR" } });
    fireEvent.change(screen.getByLabelText("Bridge export"), {
      target: {
        files: [
          new File([JSON.stringify(bridgeFixture)], "opportunity-api-fixture-bridge.json", {
            type: "application/json",
          }),
        ],
      },
    });
    expect(bootstrapButton).toBeEnabled();
    fireEvent.click(bootstrapButton);

    await waitFor(() => expect(projectPosts).toHaveLength(1));
    expect(projectPosts[0]).toMatchObject({
      bridge: bridgeFixture,
      bootstrapSelection: {
        selectedWorkId: "work-opportunity",
        candidates: [
          expect.objectContaining({
            workId: "work-opportunity",
            canonicalTitle: "Opportunity API Fixture",
            sourceIds: catalogOpportunitiesFixture.rows[0]?.sourceIds,
          }),
        ],
      },
    });
    await waitFor(() => expect(branchPosts).toHaveLength(1));
    expect(branchPosts[0]).toMatchObject({
      project: { projectId: bridgeImportResponseFixture.project.projectId },
      targetLocale: "fr-FR",
    });
    expect(
      (branchPosts[0] as { project: { bridge: { units: unknown[] } } }).project.bridge.units.length,
    ).toBeGreaterThan(0);
    expect(
      await screen.findByText("Project bootstrapped from Opportunity API Fixture."),
    ).toBeInTheDocument();
    expect(await screen.findByText("Open workspace scenes")).toHaveAttribute(
      "href",
      `/workspace/scenes?projectId=${encodeURIComponent(
        draftBranchResponseFixture.status.projectId,
      )}&localeBranchId=${encodeURIComponent(
        draftBranchResponseFixture.status.selectedLocaleBranchId,
      )}`,
    );
  });

  it("does not fabricate a bridge when candidate bootstrap has no bridge export", async () => {
    const projectPosts: unknown[] = [];
    const branchPosts: unknown[] = [];
    server.use(
      http.post("*/api/imports/bridge", async ({ request }) => {
        projectPosts.push(await request.json());
        return apiJson("imports.bridge", bridgeImportResponseFixture);
      }),
      http.post("*/api/projects/:projectId/branches", async ({ request }) => {
        const body = await request.json();
        branchPosts.push(body);
        return apiJson("branches.draft", draftBranchResponseFixture);
      }),
    );

    render(<App location={{ pathname: "/onboarding", search: "" }} />);

    expect(await screen.findByText("1 project(s) already visible.")).toBeInTheDocument();
    const bootstrapButton = screen.getByRole("button", { name: "Bootstrap project" });
    expect(bootstrapButton).toBeDisabled();
    expect(
      screen.getAllByText("Choose a bridge JSON export for the selected candidate.").length,
    ).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("Target locale"), { target: { value: "fr-FR" } });
    fireEvent.click(bootstrapButton);
    expect(projectPosts).toHaveLength(0);
    expect(branchPosts).toHaveLength(0);
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

describe("SPA shell — settings", () => {
  it("routes privacy, model routing, branch policy, and translation scope settings screens", async () => {
    render(<App location={{ pathname: "/settings/privacy", search: "" }} />);

    expect(await screen.findByRole("heading", { name: "Privacy posture" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Privacy" })).toHaveAttribute("aria-selected", "true");
    const panel = screen.getByRole("region", { name: /privacy \/ zdr/i });
    expect(panel).toHaveAttribute("data-panel-id", "privacy-zdr");
    expect(await within(panel).findByText("zdr=true")).toBeInTheDocument();
    expect(within(panel).getByText(/data_collection=none/)).toBeInTheDocument();

    cleanup();

    render(<App location={{ pathname: "/settings/model-routing", search: "" }} />);

    expect(await screen.findByRole("heading", { name: "Model routing" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Model routing" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("data-screen", "settings-model-routing");
    expect(main).toHaveAttribute("data-state", "ready");
    expect(await screen.findByRole("heading", { name: "Task route" })).toBeInTheDocument();
    const pairsTable = screen.getByRole("table", { name: "Available model provider pairs" });
    expect(within(pairsTable).getByText("anthropic/claude-3-5-sonnet")).toBeInTheDocument();
    const routesTable = screen.getByRole("table", { name: "Saved model routing routes" });
    expect(within(routesTable).getByText("draft_translation")).toBeInTheDocument();

    cleanup();

    render(<App location={{ pathname: "/settings/branch-policy", search: "" }} />);

    expect(await screen.findByRole("heading", { name: "Branch policy" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Branch policy" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      await screen.findByRole("heading", { name: "Locale branch policy" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Ruby")).toHaveValue("Preserve ruby annotations on proper nouns.");
    const referenceTable = screen.getByRole("table", { name: "Branch policy reference state" });
    expect(within(referenceTable).getByText("branch-policy-reference-1")).toBeInTheDocument();

    cleanup();

    render(<App location={{ pathname: "/settings/translation-scope", search: "" }} />);

    expect(await screen.findByRole("heading", { name: "Translation scope" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Translation scope" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const scopeMain = screen.getByRole("main");
    expect(scopeMain).toHaveAttribute("data-screen", "settings-translation-scope");
    expect(scopeMain).toHaveAttribute("data-state", "ready");
    expect(
      await screen.findByRole("heading", { name: "Config-driven translation scope" }),
    ).toBeInTheDocument();
    // All four cumulative tiers render as toggles.
    expect(screen.getByLabelText("Dialogue")).toBeInTheDocument();
    expect(screen.getByLabelText("+ Choices")).toBeInTheDocument();
    expect(screen.getByLabelText("+ UI text")).toBeInTheDocument();
    expect(screen.getByLabelText("+ Images (beta)")).toBeInTheDocument();
    // The persisted fixture scope is "dialogue-only": the baseline is
    // checked+disabled (always on), every higher tier unchecked.
    expect(screen.getByLabelText("Dialogue")).toBeChecked();
    expect(screen.getByLabelText("Dialogue")).toBeDisabled();
    expect(screen.getByLabelText("+ Choices")).not.toBeChecked();
    expect(screen.getByLabelText("+ UI text")).not.toBeChecked();
    expect(screen.getByLabelText("+ Images (beta)")).not.toBeChecked();
  });

  it("saves a model-routing task route through the typed settings API", async () => {
    const posts: unknown[] = [];
    server.use(
      http.post("*/api/settings/model-routing", async ({ request }) => {
        const body = await request.json();
        posts.push(body);
        return apiJson("settings.modelRouting.save", {
          ...modelRoutingSettingsFixture,
          routes: [
            {
              ...modelRoutingSettingsFixture.routes[0]!,
              fallbackModelIds: (body as { fallbackModelIds: string[] }).fallbackModelIds,
            },
          ],
        });
      }),
    );

    render(<App location={{ pathname: "/settings/model-routing", search: "" }} />);

    expect(await screen.findByRole("heading", { name: "Model routing" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Task route" })).toBeInTheDocument();
    expect((await screen.findAllByText("OpenRouter")).length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("Fallback models"), {
      target: { value: "anthropic/claude-3-haiku" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save route" }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({
      projectId: "project-1",
      taskKind: "draft_translation",
      providerId: "openrouter",
      modelId: "anthropic/claude-3-5-sonnet",
      fallbackModelIds: ["anthropic/claude-3-haiku"],
      promptPresetId: "itotori-draft-default-v1",
      promptTemplateVersion: "1.0.0",
    });
    expect(await screen.findByText("Saved draft_translation")).toBeInTheDocument();
  });

  it("saves branch policy through the typed project/branch settings API", async () => {
    const posts: unknown[] = [];
    server.use(
      http.post(
        "*/api/projects/:projectId/locale-branches/:localeBranchId/settings/branch-policy",
        async ({ request }) => {
          const body = await request.json();
          posts.push(body);
          return apiJson("settings.branchPolicy.save", {
            ...branchPolicySettingsFixture,
            latestVersion: {
              ...branchPolicySettingsFixture.latestVersion!,
              styleGuideVersionId: "style-guide-version-saved",
              policy: (body as { policy: typeof branchPolicySettingsFixture.policy }).policy,
            },
            branchReference: {
              ...branchPolicySettingsFixture.branchReference!,
              styleGuideVersionId: "style-guide-version-saved",
              updateReason: (body as { updateReason: string }).updateReason,
            },
            policy: (body as { policy: typeof branchPolicySettingsFixture.policy }).policy,
          });
        },
      ),
    );

    render(<App location={{ pathname: "/settings/branch-policy", search: "" }} />);

    expect(await screen.findByRole("heading", { name: "Branch policy" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Tone"), {
      target: { value: "Keep narration grounded.\nKeep jokes dry." },
    });
    fireEvent.change(screen.getByLabelText("Ruby"), {
      target: { value: "Preserve ruby annotations." },
    });
    fireEvent.change(screen.getByLabelText("Profanity"), {
      target: { value: "Preserve plot-critical profanity." },
    });
    fireEvent.change(screen.getByLabelText("Update reason"), {
      target: { value: "Tune branch voice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save branch policy" }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({
      projectId: "project-1",
      localeBranchId: "locale-1",
      expectedPreviousVersionId: "style-guide-version-1",
      updateReason: "Tune branch voice",
      policy: {
        schemaVersion: "style-guide-policy.v0",
        sections: {
          tone: [
            { ruleId: "tone.1", guidance: "Keep narration grounded." },
            { ruleId: "tone.2", guidance: "Keep jokes dry." },
          ],
          formatting: [{ ruleId: "ruby.1", guidance: "Preserve ruby annotations." }],
          terminology: [{ ruleId: "profanity.1", guidance: "Preserve plot-critical profanity." }],
        },
      },
    });
    expect(await screen.findByText("Saved style-guide-version-saved")).toBeInTheDocument();
  });

  it("persists a translation-scope tier selection through the typed project/branch settings API", async () => {
    const posts: unknown[] = [];
    server.use(
      http.post(
        "*/api/projects/:projectId/locale-branches/:localeBranchId/settings/translation-scope",
        async ({ request }) => {
          const body = (await request.json()) as {
            projectId: string;
            localeBranchId: string;
            scope: string;
          };
          posts.push(body);
          return apiJson("settings.translationScope.save", {
            ...translationScopeSettingsFixture,
            scope: body.scope,
            updatedAt: "2026-07-09T00:00:00.000Z",
          });
        },
      ),
    );

    render(<App location={{ pathname: "/settings/translation-scope", search: "" }} />);

    expect(await screen.findByRole("heading", { name: "Translation scope" })).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "Config-driven translation scope" }),
    ).toBeInTheDocument();

    // The fixture persists "dialogue-only"; enabling "+ UI text" must also
    // imply "+ Choices" (the cumulative-tier affordance) — this is a REAL
    // user interaction (a checkbox click), not a pre-seeded form value.
    fireEvent.click(screen.getByLabelText("+ UI text"));
    expect(screen.getByLabelText("+ Choices")).toBeChecked();
    expect(screen.getByLabelText("+ UI text")).toBeChecked();
    expect(screen.getByLabelText("+ Images (beta)")).not.toBeChecked();

    // Unchecking "+ Choices" cascades "+ UI text" back off too (a lower tier
    // can never stay enabled once a surface below it is disabled).
    fireEvent.click(screen.getByLabelText("+ Choices"));
    expect(screen.getByLabelText("+ Choices")).not.toBeChecked();
    expect(screen.getByLabelText("+ UI text")).not.toBeChecked();

    // Re-enable "+ Choices" only (one tier above the always-on baseline) and save.
    fireEvent.click(screen.getByLabelText("+ Choices"));
    expect(screen.getByLabelText("+ Choices")).toBeChecked();
    expect(screen.getByLabelText("+ UI text")).not.toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Save translation scope" }));

    await waitFor(() => expect(posts).toHaveLength(1));
    // Wire-verbatim proof: the EXACT scope token the backend
    // (`TranslationScope`/`crates/kaifuu-reallive/src/scope.rs`) expects went
    // over the typed client, through the REAL route path — not a mock state.
    expect(posts[0]).toMatchObject({
      projectId: "project-1",
      localeBranchId: "locale-1",
      scope: "dialogue-and-choices",
    });
    expect(await screen.findByText("Saved dialogue-and-choices")).toBeInTheDocument();
  });

  it("reloads branch policy editor state before saving after locale branch selection changes", async () => {
    const branchBLocaleBranchId = "019ed065-0000-7000-8000-000000000110";
    const branchBSettings = {
      ...branchPolicySettingsFixture,
      localeBranchId: branchBLocaleBranchId,
      targetLocale: "fr-FR",
      latestVersion: {
        ...branchPolicySettingsFixture.latestVersion!,
        styleGuideVersionId: "style-guide-version-branch-b",
        policy: {
          ...branchPolicySettingsFixture.policy,
          sections: {
            ...branchPolicySettingsFixture.policy.sections,
            tone: [{ ruleId: "tone.1", guidance: "Use formal branch B voice." }],
            formatting: [{ ruleId: "ruby.1", guidance: "Drop ruby annotations for branch B." }],
          },
        },
      },
      branchReference: {
        ...branchPolicySettingsFixture.branchReference!,
        referenceId: "branch-policy-reference-2",
        styleGuideVersionId: "style-guide-version-branch-b",
      },
      policy: {
        ...branchPolicySettingsFixture.policy,
        sections: {
          ...branchPolicySettingsFixture.policy.sections,
          tone: [{ ruleId: "tone.1", guidance: "Use formal branch B voice." }],
          formatting: [{ ruleId: "ruby.1", guidance: "Drop ruby annotations for branch B." }],
        },
      },
    };
    const statusWithTwoBranches = {
      ...dashboardStatusFixture,
      localeBranches: dashboardStatusFixture.localeBranches.map((branch) =>
        branch.localeBranchId === branchBLocaleBranchId
          ? { ...branch, currentStyleGuidePolicyVersionId: "style-guide-version-branch-b" }
          : branch,
      ),
      selectedLocaleBranchId: "locale-1",
    };
    const posts: unknown[] = [];
    server.use(
      http.get("*/api/projects", () =>
        apiJson("projects.list", { projects: [statusWithTwoBranches] }),
      ),
      http.get("*/api/projects/status", () => apiJson("projects.status", statusWithTwoBranches)),
      http.get(
        "*/api/projects/:projectId/locale-branches/:localeBranchId/settings/branch-policy",
        ({ params }) =>
          apiJson(
            "settings.branchPolicy.get",
            params.localeBranchId === branchBLocaleBranchId
              ? branchBSettings
              : branchPolicySettingsFixture,
          ),
      ),
      http.post(
        "*/api/projects/:projectId/locale-branches/:localeBranchId/settings/branch-policy",
        async ({ request }) => {
          const body = await request.json();
          posts.push(body);
          return apiJson("settings.branchPolicy.save", {
            ...branchBSettings,
            latestVersion: {
              ...branchBSettings.latestVersion,
              styleGuideVersionId: "style-guide-version-branch-b-saved",
              policy: (body as { policy: typeof branchPolicySettingsFixture.policy }).policy,
            },
            branchReference: {
              ...branchBSettings.branchReference,
              styleGuideVersionId: "style-guide-version-branch-b-saved",
              updateReason: (body as { updateReason: string }).updateReason,
            },
            policy: (body as { policy: typeof branchPolicySettingsFixture.policy }).policy,
          });
        },
      ),
    );

    render(<App location={{ pathname: "/settings/branch-policy", search: "" }} />);

    expect(await screen.findByRole("heading", { name: "Branch policy" })).toBeInTheDocument();
    expect(await screen.findByLabelText("Tone")).toHaveValue(
      "Keep narration concise and emotionally direct.",
    );
    fireEvent.change(screen.getByLabelText("Tone"), {
      target: { value: "Branch A unsaved draft must not cross branches." },
    });

    fireEvent.click(screen.getByRole("button", { name: "Project & branch" }));
    const switcher = screen.getByRole("menu", { name: "Switch project and locale branch" });
    const branchGroup = await within(switcher).findByRole("group", { name: "Branch" });
    fireEvent.click(within(branchGroup).getByText("fr-FR"));

    await waitFor(() =>
      expect(screen.getByLabelText("Tone")).toHaveValue("Use formal branch B voice."),
    );
    expect(screen.getByLabelText("Ruby")).toHaveValue("Drop ruby annotations for branch B.");
    fireEvent.click(screen.getByRole("button", { name: "Save branch policy" }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({
      projectId: "project-1",
      localeBranchId: branchBLocaleBranchId,
      expectedPreviousVersionId: "style-guide-version-branch-b",
      policy: {
        sections: {
          tone: [{ ruleId: "tone.1", guidance: "Use formal branch B voice." }],
          formatting: [{ ruleId: "ruby.1", guidance: "Drop ruby annotations for branch B." }],
        },
      },
    });
    expect(JSON.stringify(posts[0])).not.toContain("Branch A unsaved draft");
  });

  it("shows the latest editable draft when an older approved branch policy exists", async () => {
    const settingsWithApproved = {
      ...branchPolicySettingsFixture,
      latestVersion: {
        ...branchPolicySettingsFixture.latestVersion!,
        styleGuideVersionId: "style-guide-version-latest-draft",
        policy: {
          ...branchPolicySettingsFixture.policy,
          sections: {
            ...branchPolicySettingsFixture.policy.sections,
            tone: [{ ruleId: "tone.1", guidance: "Latest draft tone." }],
          },
        },
      },
      approvedVersion: {
        ...branchPolicySettingsFixture.latestVersion!,
        styleGuideVersionId: "style-guide-version-approved",
        status: "approved",
        approvedAt: "2026-07-08T01:00:00.000Z",
        policy: {
          ...branchPolicySettingsFixture.policy,
          sections: {
            ...branchPolicySettingsFixture.policy.sections,
            tone: [{ ruleId: "tone.1", guidance: "Approved older tone." }],
          },
        },
      },
      policy: {
        ...branchPolicySettingsFixture.policy,
        sections: {
          ...branchPolicySettingsFixture.policy.sections,
          tone: [{ ruleId: "tone.1", guidance: "Latest draft tone." }],
        },
      },
    };
    server.use(
      http.get(
        "*/api/projects/:projectId/locale-branches/:localeBranchId/settings/branch-policy",
        () => apiJson("settings.branchPolicy.get", settingsWithApproved),
      ),
    );

    render(<App location={{ pathname: "/settings/branch-policy", search: "" }} />);

    expect(await screen.findByLabelText("Tone")).toHaveValue("Latest draft tone.");
    expect(screen.queryByDisplayValue("Approved older tone.")).not.toBeInTheDocument();
    const referenceTable = screen.getByRole("table", { name: "Branch policy reference state" });
    expect(
      within(referenceTable).getByText("style-guide-version-latest-draft"),
    ).toBeInTheDocument();
    expect(within(referenceTable).getByText("style-guide-version-approved")).toBeInTheDocument();
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
  it("shows seat usage, invites members, and grants a permission set through typed auth APIs", async () => {
    let directorGranted = false;
    const grantRequests: unknown[] = [];
    const inviteRequests: unknown[] = [];
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
      http.get("*/api/auth/billing/seat-usage", () =>
        apiJson("auth.billing.seatUsage", {
          schemaVersion: "itotori.auth.billing-seat-usage.v0",
          accountId: "account-local",
          planId: "studio-team",
          planName: "Studio Team",
          billingPeriod: "monthly",
          seatLimit: 5,
          includedSeats: 5,
          usedSeats: 1,
          pendingInvitations: inviteRequests.length,
          availableSeats: 4,
          overSeatLimit: false,
          updatedAt: "2026-07-08T00:00:00.000Z",
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
      http.post("*/api/auth/members/invitations", async ({ request }) => {
        const body = await request.json();
        inviteRequests.push(body);
        return apiJson("auth.members.invite", {
          schemaVersion: "itotori.auth.member-invitation.v0",
          invitationId: "invitation-ui",
          accountId: "account-local",
          email: (body as { email: string }).email,
          initialPermissionSetIds: (body as { initialPermissionSetIds: string[] })
            .initialPermissionSetIds,
          expiresAt: (body as { expiresAt: string }).expiresAt,
          acceptedAt: null,
          revokedAt: null,
          createdAt: "2026-07-08T00:00:00.000Z",
        });
      }),
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

    expect(await screen.findByRole("heading", { name: "Plan and seats" })).toBeInTheDocument();
    expect(await screen.findByText("studio-team")).toBeInTheDocument();
    expect(await screen.findByText("Monthly")).toBeInTheDocument();
    expect(await screen.findByText("API Member")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "new.member@example.test" },
    });
    fireEvent.click(screen.getByLabelText("Include Reviewer"));
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    await waitFor(() => expect(inviteRequests).toHaveLength(1));
    expect(inviteRequests[0]).toMatchObject({
      accountId: "account-local",
      email: "new.member@example.test",
      initialPermissionSetIds: ["permission-set-account-local-reviewer"],
      reason: null,
      requestId: null,
    });
    expect(await screen.findByText("Invite sent to new.member@example.test")).toBeInTheDocument();
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
