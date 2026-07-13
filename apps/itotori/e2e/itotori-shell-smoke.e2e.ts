import { expect, type Page, type Route, test } from "@playwright/test";
import {
  reviewerQueueActionValues,
  reviewerQueueItemStateValues,
  type ReviewerQueueAction,
} from "@itotori/db";
import type { ReviewerSingleActionResult } from "../src/reviewer/api-service.js";
import type { ReviewerQueueDashboardReadModel } from "../src/reviewer/index.js";
import { readyContextFixture, reviewQueueDashboardFixtures } from "../src/reviewer/index.js";
import {
  workspaceAssetBrowseFixture,
  workspaceComparisonFixture,
  workspaceProjectBrowseFixture,
  workspaceSceneBrowseFixture,
  workspaceSearchFixture,
} from "../src/workspace/index.js";
import {
  assertItotoriApiResponse,
  type ApiAuthCapabilitiesResponse,
  type ApiPlayFlagAnnotationRequest,
  type ApiPlayFlagAnnotationResponse,
  type ItotoriApiResponseBody,
  type ItotoriApiRouteId,
} from "../src/api-schema.js";
import {
  bmkCockpitFixture,
  bmkCockpitHistoryFixture,
  benchmarkReportsFixture,
  catalogOpportunitiesFixture,
  costDrilldownFixture,
  costReportFixture,
  dashboardDecisionsFixture,
  dashboardStatusFixture,
  authIdentityFixture,
  jobsRunTableFixture,
  projectOverviewFixture,
  runtimeStatusFixture,
} from "../test/api-fixtures.js";

const reviewerDetailContext = readyContextFixture();
const workspaceProjects = workspaceProjectBrowseFixture();
const workspaceBranch = workspaceProjects.projects[0]!.localeBranches[0]!;
const reviewerDetailItem = reviewerDetailContext.item;
const playProjectId = dashboardStatusFixture.projectId;
const playLocaleBranchId = dashboardStatusFixture.selectedLocaleBranchId;
const playBridgeUnitId = "bridge-unit-1";
const playSourceUnitKey = "hello.scene.001.line.001";
const playReviewItemId = reviewerDetailContext.reviewItemId;
const playSceneId = "scene.001";

if (reviewerDetailItem === null) {
  throw new Error("Playwright reviewer detail fixture must include an item");
}

test.beforeEach(async ({ page }) => {
  await installFixtureApi(page);
});

test("dashboard shell navigates to reviewer and workspace surfaces", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator('main[data-screen="dashboard"][data-state="ready"]')).toBeVisible();
  await expect(page.getByRole("heading", { name: "Itotori dashboard" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Reviewer queue" })).toBeVisible();

  await page.getByRole("tab", { name: "Review" }).click();
  await expect(page).toHaveURL(/\/reviewer-queue$/u);
  await expect(
    page.locator('main[data-screen="reviewer-queue"][data-state="ready"]'),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Reviewer queue" })).toBeVisible();

  const detailLink = page
    .locator('main[data-screen="reviewer-queue"] a[href^="/reviewer-queue/"]')
    .first();
  await expect(detailLink).toBeVisible();
  await detailLink.click();
  await expect(
    page.locator('main[data-screen="reviewer-detail"][data-state="ready"]'),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Source unit" })).toBeVisible();

  await page.getByRole("tab", { name: "Workspace" }).click();
  await expect(page).toHaveURL(/\/workspace$/u);
  await expect(page.locator('main[data-screen="workspace"][data-view="projects"]')).toBeVisible();
  await expect(page.getByRole("heading", { name: "Oshioki Sweetie HD" })).toBeVisible();

  await page.locator('main[data-screen="workspace"] a[href^="/workspace/scenes"]').first().click();
  await expect(page).toHaveURL(/\/workspace\/scenes\?/u);
  await expect(page.locator('main[data-screen="workspace"][data-view="scenes"]')).toBeVisible();
  await expect(page.getByRole("heading", { name: /Scene 1:/u })).toBeVisible();
});

test("reviewer and workspace deep links cold-load through the server fallback", async ({
  page,
}) => {
  await page.goto(`/reviewer-queue/${reviewerDetailContext.reviewItemId}`);
  await expect(
    page.locator('main[data-screen="reviewer-detail"][data-state="ready"]'),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Comparison" })).toBeVisible();

  await page.goto(
    `/workspace/scenes?projectId=${encodeURIComponent(
      workspaceBranch.projectId,
    )}&localeBranchId=${encodeURIComponent(workspaceBranch.localeBranchId)}`,
  );
  await expect(page.locator('main[data-screen="workspace"][data-view="scenes"]')).toBeVisible();
  await expect(page.getByRole("heading", { name: /Scene 1:/u })).toBeVisible();

  await page.goto(
    `/workspace/comparison?reviewItemId=${encodeURIComponent(reviewerDetailContext.reviewItemId)}`,
  );
  await expect(page.locator('main[data-screen="workspace"][data-view="comparison"]')).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Source / draft / final comparison" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Comparison", exact: true })).toBeVisible();
});

test("Studio shell + Review core loop queues through detail and decide", async ({ page }) => {
  await page.goto("/reviewer-queue");

  await expect(page.locator('[data-switcher="identity-org"]')).toHaveAttribute(
    "data-switcher-phase",
    "ready",
  );
  await expect(page.getByRole("button", { name: "Local workspace" })).toBeVisible();

  const nav = page.getByRole("navigation", { name: "Surfaces" });
  await expect(nav.getByRole("tab", { name: "Review" })).toHaveAttribute("aria-selected", "true");

  const statusBar = page.getByRole("status", { name: "Shell status bar" });
  await expect(statusBar).toHaveAttribute("data-shell-status", "ready");
  await expect(statusBar.locator('[data-shell-stat="project"]')).toContainText("project-1");
  await expect(statusBar.locator('[data-shell-stat="branch"]')).toContainText("fr-FR");
  await expect(statusBar.locator('[data-shell-stat="source-to-branch"]')).toContainText(
    "ja-JP → fr-FR",
  );
  await expect(statusBar.locator('[data-shell-stat="zdr"]')).toContainText("zdr=true");
  await expect(statusBar.locator('[data-shell-stat="zdr"]')).toContainText("data_collection=none");
  await expect(statusBar.locator('[data-shell-stat="cost"]')).toContainText("$0.002180");

  await expect(
    page.locator('main[data-screen="reviewer-queue"][data-state="ready"]'),
  ).toBeVisible();
  // Queue list is a VirtualList (not a table) — assert the virtualized list
  // region and that at least one detail link is present.
  await expect(page.locator('[aria-label="Reviewer queue virtualized rows"]')).toBeVisible();

  const detailLink = page
    .locator('main[data-screen="reviewer-queue"] a[href^="/reviewer-queue/"]')
    .first();
  await expect(detailLink).toBeVisible();
  await detailLink.click();
  await expect(
    page.locator('main[data-screen="reviewer-detail"][data-state="ready"]'),
  ).toBeVisible();
  await expect(page.locator('main[data-screen="reviewer-detail"]')).toHaveAttribute(
    "data-can-decide",
    "true",
  );
  await expect(page.locator('[data-strip="decide-action"]')).toBeVisible();

  await page.locator('button[data-action="decide-approve"]').click();
  await expect(page.locator('[data-strip="decide-action"]')).toHaveAttribute("data-busy", "false");
  await expect(page.getByText("Approved as-is — unit marked proven.")).toBeVisible();
  expect(e2eObservedReviewerActions).toEqual([
    {
      reviewItemId: reviewerDetailContext.reviewItemId,
      body: {
        reviewItemId: reviewerDetailContext.reviewItemId,
        action: "approve",
        actorUserId: "local-user",
        expectedSourceRevisionId: reviewerDetailItem.sourceRevisionId,
      },
    },
  ]);
});

test("Play surface drives filmstrip runtime evidence and flag-to-review loop", async ({ page }) => {
  await page.goto(
    `/play?projectId=${encodeURIComponent(playProjectId)}&localeBranchId=${encodeURIComponent(
      playLocaleBranchId,
    )}`,
  );

  const playMain = page.locator('main[data-screen="play-scene-picker"]');
  await expect(playMain).toHaveAttribute("data-state", "ready");
  await expect(page.getByRole("heading", { name: "Scene picker" })).toBeVisible();

  const sceneNav = page.getByRole("navigation", { name: "Scenes by translated summary" });
  await expect(
    sceneNav.getByRole("tab", {
      name: /Scene 1: the heroine greets the protagonist outside the school gate/i,
    }),
  ).toBeVisible();
  await expect(page.getByRole("table")).toContainText(playSourceUnitKey);

  const comparison = page.locator(`[data-comparison-for="${playBridgeUnitId}"]`);
  await expect(comparison).toBeVisible();
  await expect(comparison).toContainText("こんにちは、{player}。");
  await expect(comparison).toContainText("Hello, {player}.");

  const filmstrip = page.locator('[data-pane-id="play-sceneplayer-embed"]');
  await expect(filmstrip).toHaveAttribute("data-pane-state", "ready");
  await expect(filmstrip).toHaveAttribute("data-filmstrip-unit-id", playBridgeUnitId);
  await expect(
    filmstrip.locator('[data-component="scene-player"][data-mode="play"]'),
  ).toBeVisible();
  await expect(filmstrip).toContainText("Hello there, world!");

  const frame = filmstrip.locator('[data-filmstrip-artifact-id="runtime-1:screenshot-1"]');
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute("data-filmstrip-artifact-kind", "screenshot");
  await expect(frame).toHaveAttribute(
    "data-filmstrip-artifact-uri",
    "artifacts/utsushi/runtime/runtime-1/screenshots/screenshot-1.png",
  );
  await expect(filmstrip.locator('.itotori-redaction-frame[data-redacted="true"]')).toBeVisible();

  await page.goto(
    `/play/flag?projectId=${encodeURIComponent(playProjectId)}` +
      `&localeBranchId=${encodeURIComponent(playLocaleBranchId)}` +
      `&bridgeUnitId=${encodeURIComponent(playBridgeUnitId)}` +
      `&sceneId=${encodeURIComponent(playSceneId)}` +
      `&sourceUnitKey=${encodeURIComponent(playSourceUnitKey)}` +
      "&targetLocale=en-US",
  );

  const flagMain = page.locator('main[data-screen="play-flag"][data-can-flag="true"]');
  await expect(flagMain).toBeVisible();
  await expect(page.locator('[data-component="annotation-composer"]')).toHaveAttribute(
    "data-severity",
    "warning",
  );

  await page.getByRole("radio", { name: "critical" }).click();
  await page.getByPlaceholder(/What's wrong with this line/i).fill("Textbox clips the final line.");
  await page.getByPlaceholder(/tone · layout · glossary/i).fill("layout");
  await page.getByRole("button", { name: "Send correction" }).click();

  const outcome = page.locator('[data-flag-outcome="ok"]');
  await expect(outcome).toBeVisible();
  await expect(outcome).toHaveAttribute("data-context-correction-enqueued", "true");
  await expect(outcome).toHaveAttribute("data-severity", "critical");
  await expect(outcome).toContainText("Flag sent to correction");

  expect(e2eObservedFlagAnnotations).toEqual([
    {
      projectId: playProjectId,
      localeBranchId: playLocaleBranchId,
      body: {
        note: "Textbox clips the final line.",
        severity: "critical",
        category: "layout",
        targetLocale: "en-US",
        bridgeUnitId: playBridgeUnitId,
        sourceUnitKey: playSourceUnitKey,
        sceneId: playSceneId,
        actorUserId: "local-user",
      },
    },
  ]);
});

async function installFixtureApi(page: Page): Promise<void> {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/")) {
      await fulfillApi(route, url);
      return;
    }
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      await route.continue();
      return;
    }
    await route.abort();
  });
}

async function fulfillApi(route: Route, url: URL): Promise<void> {
  const path = url.pathname;
  if (path === "/api/auth/capabilities") {
    await fulfillJson(route, "auth.capabilities", authCapabilitiesGrantedFixture);
    return;
  }
  if (path === "/api/auth/identity") {
    await fulfillJson(route, "auth.identity", authIdentityFixture);
    return;
  }
  if (path === "/api/projects") {
    await fulfillJson(route, "projects.list", { projects: [dashboardStatusFixture] });
    return;
  }
  if (path === "/api/projects/status") {
    await fulfillJson(route, "projects.status", dashboardStatusFixture);
    return;
  }
  if (path === "/api/projects/decisions") {
    await fulfillJson(route, "projects.decisions", dashboardDecisionsFixture);
    return;
  }
  if (path === "/api/projects/cost") {
    await fulfillJson(route, "projects.cost", costReportFixture);
    return;
  }
  if (path === "/api/projects/cost/drilldown") {
    await fulfillJson(route, "projects.costDrilldown", costDrilldownFixture);
    return;
  }
  if (path === "/api/projects/overview") {
    await fulfillJson(route, "projects.overview", projectOverviewFixture);
    return;
  }
  if (path === "/api/projects/benchmarks") {
    await fulfillJson(route, "projects.benchmarks", { reports: benchmarkReportsFixture });
    return;
  }
  if (path === "/api/projects/project-1/bmk-cockpit") {
    await fulfillJson(route, "projects.bmkCockpit", bmkCockpitFixture);
    return;
  }
  if (path === "/api/projects/project-1/bmk-cockpit/history") {
    await fulfillJson(route, "projects.bmkCockpitHistory", bmkCockpitHistoryFixture);
    return;
  }
  if (path === "/api/jobs/run-table") {
    await fulfillJson(route, "jobs.runTable", jobsRunTableFixture);
    return;
  }
  if (path === "/api/catalog/opportunities") {
    await fulfillJson(route, "catalog.opportunities", catalogOpportunitiesFixture);
    return;
  }
  if (path === "/api/runtime/v0.2/status") {
    await fulfillJson(route, "runtime.status", runtimeStatusFixture);
    return;
  }
  const playFlagMatch = /^\/api\/projects\/([^/]+)\/locale-branches\/([^/]+)\/flags$/u.exec(path);
  if (playFlagMatch !== null) {
    const projectId = decodeURIComponent(playFlagMatch[1]!);
    const localeBranchId = decodeURIComponent(playFlagMatch[2]!);
    const body = (await route.request().postDataJSON()) as ApiPlayFlagAnnotationRequest;
    e2eObservedFlagAnnotations.push({ projectId, localeBranchId, body });
    await fulfillJson(
      route,
      "play.flagAnnotation",
      playFlagAnnotationResponse(projectId, localeBranchId, body),
    );
    return;
  }
  if (path === "/api/reviewer/queue") {
    await fulfillJson(route, "reviewer.queue", reviewerQueueDashboardApiFixture());
    return;
  }
  if (/^\/api\/reviewer\/queue\/[^/]+\/detail$/u.test(path)) {
    await fulfillJson(route, "reviewer.detail", reviewerDetailContext);
    return;
  }
  const reviewerActionMatch = /^\/api\/reviewer\/queue\/([^/]+)\/action$/u.exec(path);
  if (reviewerActionMatch !== null) {
    const reviewItemId = decodeURIComponent(reviewerActionMatch[1]!);
    const body = (await route.request().postDataJSON()) as unknown;
    e2eObservedReviewerActions.push({ reviewItemId, body });
    await fulfillJson(
      route,
      "reviewer.itemAction",
      appliedSingleActionResult({
        reviewItemId,
        action: reviewerQueueActionValues.approve,
        nextState: reviewerQueueItemStateValues.accepted,
      }),
    );
    return;
  }
  if (path === "/api/workspace/projects") {
    await fulfillJson(route, "workspace.projects", workspaceProjects);
    return;
  }
  if (path === "/api/workspace/scenes") {
    await fulfillJson(route, "workspace.scenes", {
      ...workspaceSceneBrowseFixture(),
      projectId: url.searchParams.get("projectId") ?? workspaceBranch.projectId,
      localeBranchId: url.searchParams.get("localeBranchId") ?? workspaceBranch.localeBranchId,
      scenes: [
        {
          ...workspaceSceneBrowseFixture().scenes[0]!,
          sceneId: playSceneId,
          localeBranchId: url.searchParams.get("localeBranchId") ?? workspaceBranch.localeBranchId,
          units: [
            {
              ...workspaceSceneBrowseFixture().scenes[0]!.units[0]!,
              bridgeUnitId: playBridgeUnitId,
              reviewItemId: playReviewItemId,
              sourceUnitKey: playSourceUnitKey,
              sourceText: "こんにちは、{player}。",
            },
          ],
        },
      ],
    });
    return;
  }
  if (path === "/api/workspace/assets") {
    await fulfillJson(route, "workspace.assets", {
      ...workspaceAssetBrowseFixture(),
      projectId: url.searchParams.get("projectId") ?? workspaceBranch.projectId,
      localeBranchId: url.searchParams.get("localeBranchId") ?? workspaceBranch.localeBranchId,
    });
    return;
  }
  if (path === "/api/workspace/comparison") {
    await fulfillJson(route, "workspace.comparison", {
      ...workspaceComparisonFixture(),
      reviewItemId: url.searchParams.get("reviewItemId") ?? reviewerDetailContext.reviewItemId,
      bridgeUnitId: playBridgeUnitId,
      sourceUnitKey: playSourceUnitKey,
      cells: [
        {
          side: "source",
          locale: "ja-JP",
          text: "こんにちは、{player}。",
          label: "Source (ja-JP)",
        },
        {
          side: "draft",
          locale: "en-US",
          text: "Hello, {player}.",
          label: "Draft (en-US)",
        },
        {
          side: "final",
          locale: "en-US",
          text: "Hello there, world!",
          label: "Final / approved (en-US)",
        },
      ],
    });
    return;
  }
  if (path === "/api/workspace/corrections") {
    await fulfillJson(route, "workspace.correctionPreview", workspaceCorrectionPreviewFixture(url));
    return;
  }
  if (path === "/api/workspace/search") {
    await fulfillJson(route, "workspace.search", {
      ...workspaceSearchFixture(),
      projectId: url.searchParams.get("projectId") ?? workspaceBranch.projectId,
      localeBranchId: url.searchParams.get("localeBranchId") ?? workspaceBranch.localeBranchId,
      query: url.searchParams.get("query") ?? "",
    });
    return;
  }
  throw new Error(
    `Unhandled Itotori fixture API request: ${route.request().method()} ${url.pathname}${url.search}`,
  );
}

const e2eObservedReviewerActions: Array<{ reviewItemId: string; body: unknown }> = [];
const e2eObservedFlagAnnotations: Array<{
  projectId: string;
  localeBranchId: string;
  body: ApiPlayFlagAnnotationRequest;
}> = [];

test.beforeEach(() => {
  e2eObservedReviewerActions.length = 0;
  e2eObservedFlagAnnotations.length = 0;
});

test.afterEach(() => {
  e2eObservedReviewerActions.length = 0;
  e2eObservedFlagAnnotations.length = 0;
});

async function fulfillJson(
  route: Route,
  routeId: ItotoriApiRouteId,
  body: ItotoriApiResponseBody,
): Promise<void> {
  assertItotoriApiResponse(routeId, body);
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function workspaceCorrectionPreviewFixture(url: URL): ItotoriApiResponseBody {
  const comparison = workspaceComparisonFixture();
  const source = comparison.cells.find((cell) => cell.side === "source") ?? null;
  const draft = comparison.cells.find((cell) => cell.side === "draft") ?? null;
  const final = comparison.cells.find((cell) => cell.side === "final") ?? null;
  const localeBranchId =
    url.searchParams.get("localeBranchId") ??
    comparison.localeBranchId ??
    reviewerDetailContext.item?.localeBranchId ??
    workspaceBranch.localeBranchId;
  return {
    schemaVersion: "workspace.correction_preview.v0.1",
    generatedAt: new Date("2026-07-09T00:00:00.000Z"),
    permission: {
      actorUserId: "local-user",
      canReadQueue: true,
      canManageQueue: true,
      denialReasons: [],
    },
    projectId: reviewerDetailContext.item?.projectId ?? workspaceBranch.projectId,
    localeBranchId,
    sourceBundleId: null,
    targetLocale: draft?.locale ?? final?.locale ?? null,
    units:
      comparison.bridgeUnitId === null || comparison.sourceRevisionId === null
        ? []
        : [
            {
              reviewItemId: reviewerDetailContext.reviewItemId,
              localeBranchId,
              sourceRevisionId: comparison.sourceRevisionId,
              bridgeUnitId: comparison.bridgeUnitId,
              sourceUnitKey: comparison.sourceUnitKey,
              sourceLocale: source?.locale ?? null,
              sourceText: source?.text ?? null,
              targetLocale: draft?.locale ?? final?.locale ?? null,
              draftText: draft?.text ?? null,
              finalText: final?.text ?? null,
              styleGuidePolicyVersionId: null,
              styleGuidePolicyStatus: null,
              glossary: [],
              runtimeEvidenceLinks: comparison.runtimeEvidenceLinks,
              screenshotArtifactHashes: [],
              diagnostics: [],
            },
          ],
    diagnostics: [],
  };
}

function playFlagAnnotationResponse(
  projectId: string,
  localeBranchId: string,
  request: ApiPlayFlagAnnotationRequest,
): ApiPlayFlagAnnotationResponse {
  return {
    schemaVersion: "itotori.play.flag-annotation.v0",
    projectId,
    localeBranchId,
    feedbackReportId: `feedback-report-${request.bridgeUnitId ?? "unscoped"}`,
    feedbackEvidenceId: `feedback-evidence-${request.bridgeUnitId ?? "unscoped"}`,
    severity: request.severity,
    category: request.category ?? "",
    note: request.note,
    triageLabel: request.category === "layout" ? "layout_runtime_candidate" : "playtest_flag",
    contextStatus: request.bridgeUnitId === undefined ? "needs_context" : "contextualized",
    contextCorrectionEnqueued: request.bridgeUnitId !== undefined,
    duplicate: false,
  };
}

function reviewerQueueDashboardApiFixture(): ReviewerQueueDashboardReadModel {
  const fixtures = reviewQueueDashboardFixtures();
  const rows = fixtures.decisions.map((decision) => ({
    reviewItemId: decision.item.reviewItemId,
    projectId: decision.item.projectId,
    localeBranchId: decision.item.localeBranchId,
    sourceRevisionId: decision.item.sourceRevisionId,
    itemKind: decision.item.itemKind,
    sourceItemRef: decision.item.sourceItemRef,
    summary: decision.item.summary,
    priority: decision.item.priority,
    state: decision.item.state,
    dashboardState: decision.dashboardState,
    lastAction: decision.lastAction,
    batchActionId: decision.batchActionId,
    findingId: decision.findingId,
    decisionId: decision.decisionId,
    detailPath: `/reviewer-queue/${encodeURIComponent(decision.item.reviewItemId)}`,
    selectedForBatch: decision.dashboardState === "pending",
    createdAt: decision.item.createdAt,
    updatedAt: decision.item.updatedAt,
    resolvedAt: decision.item.resolvedAt,
  }));
  const limit = Math.max(rows.length, 1);
  return {
    schemaVersion: "reviewer.queue_dashboard.v0.1",
    localeBranchId: dashboardStatusFixture.selectedLocaleBranchId,
    generatedAt: new Date("2026-06-26T00:00:00Z"),
    permission: {
      actorUserId: "local-user",
      canReadQueue: true,
      canManageQueue: true,
      denialReasons: [],
    },
    pagination: {
      total: rows.length,
      limit,
      offset: 0,
      page: 1,
      pageCount: rows.length === 0 ? 0 : 1,
      hasMore: false,
      nextOffset: null,
    },
    rows,
    aggregate: {
      pending: rows.filter((row) => row.dashboardState === "pending").length,
      resolved: rows.filter((row) => row.dashboardState === "resolved").length,
      deferred: rows.filter((row) => row.dashboardState === "deferred").length,
      escalated: rows.filter((row) => row.dashboardState === "escalated").length,
      batch_applied: rows.filter((row) => row.dashboardState === "batch_applied").length,
    },
    defaultBatchRequest: {
      ...fixtures.batchAppliedPreview.request,
      action: "approve",
      selections: rows
        .filter((row) => row.selectedForBatch)
        .map((row) => ({
          reviewItemId: row.reviewItemId,
          expectedSourceRevisionId: row.sourceRevisionId,
        })),
    },
  };
}

function appliedSingleActionResult(input: {
  reviewItemId: string;
  action: ReviewerQueueAction;
  nextState:
    | typeof reviewerQueueItemStateValues.accepted
    | typeof reviewerQueueItemStateValues.repairRequested;
}): ReviewerSingleActionResult {
  return {
    request: {
      reviewItemId: input.reviewItemId,
      action: input.action,
      actorUserId: "local-user",
      expectedSourceRevisionId: reviewerDetailItem.sourceRevisionId,
    },
    preview: {
      reviewItemId: input.reviewItemId,
      expectedSourceRevisionId: reviewerDetailItem.sourceRevisionId,
      status: "allowed",
      action: input.action,
      requiredPermission: "queue.manage",
      item: reviewerDetailItem,
      priorState: reviewerQueueItemStateValues.pending,
      nextState: input.nextState,
      consequences: [],
      diagnostics: [],
      message: null,
    },
    outcome: {
      kind: "applied",
      reviewItemId: input.reviewItemId,
      result: {
        item: {
          ...reviewerDetailItem,
          state: input.nextState,
          resolvedAt: new Date("2026-07-09T00:00:01.000Z"),
        },
        transition: {
          transitionId: `transition-${input.reviewItemId}-${input.action}`,
          reviewItemId: input.reviewItemId,
          localeBranchId: reviewerDetailItem.localeBranchId,
          sourceRevisionId: reviewerDetailItem.sourceRevisionId,
          itemKind: reviewerDetailItem.itemKind,
          action: input.action,
          priorState: reviewerQueueItemStateValues.pending,
          nextState: input.nextState,
          actorUserId: "local-user",
          affectedArtifactIds: [],
          diagnostics: [],
          metadata: {},
          createdAt: new Date("2026-07-09T00:00:01.000Z"),
        },
      },
    },
    applied: true,
    refused: false,
  };
}

const authCapabilitiesGrantedFixture: ApiAuthCapabilitiesResponse = {
  schemaVersion: "itotori.auth.capabilities.v0",
  actorUserId: "local-user",
  canReadQueue: true,
  canManageQueue: true,
  canFlag: true,
  canDecide: true,
  canSteer: true,
  canReveal: true,
  denials: {
    flag: null,
    decide: null,
    steer: null,
    reveal: null,
    queueRead: null,
    queueManage: null,
  },
  denialReasons: [],
};
