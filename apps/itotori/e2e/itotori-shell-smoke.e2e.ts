import { expect, type Page, type Route, test } from "@playwright/test";
import {
  assertItotoriApiResponse,
  type ApiAuthCapabilitiesResponse,
  type ApiPlayFlagAnnotationRequest,
  type ApiPlayFlagAnnotationResponse,
  type ItotoriApiResponseBody,
  type ItotoriApiRouteId,
} from "../src/api-schema.js";
import {
  authIdentityFixture,
  costReportFixture,
  dashboardStatusFixture,
  portfolioProjectsFixture,
} from "../test/api-fixtures.js";

const projectId = "project-1";
const localeBranchId = "locale-1";
const bridgeUnitId = "bridge-unit-1";
const sceneId = "scene-1";
const sourceUnitKey = "scene.001";

const observedFlags: Array<{
  projectId: string;
  localeBranchId: string;
  body: ApiPlayFlagAnnotationRequest;
}> = [];

test.beforeEach(async ({ page }) => {
  observedFlags.length = 0;
  await installFixtureApi(page);
});

test("Play flags create a context correction without exposing a human-review queue", async ({
  page,
}) => {
  await page.goto(
    `/play/flag?projectId=${projectId}&localeBranchId=${localeBranchId}` +
      `&bridgeUnitId=${bridgeUnitId}&sceneId=${sceneId}` +
      `&sourceUnitKey=${sourceUnitKey}`,
  );

  await expect(
    page.locator('main[data-screen="play-flag"][data-state="ready"][data-can-flag="true"]'),
  ).toBeVisible();

  const nav = page.getByRole("navigation", { name: "Surfaces" });
  await expect(nav.getByRole("tab", { name: "Review" })).toHaveCount(0);
  await expect(nav.getByRole("tab", { name: "Workspace" })).toHaveCount(0);

  await page.getByRole("radio", { name: "critical" }).click();
  await page.getByPlaceholder(/What's wrong with this line/i).fill("Textbox clips the final line.");
  await page.getByPlaceholder(/tone · layout · glossary/i).fill("layout");
  await page.getByRole("button", { name: "Send correction" }).click();

  const outcome = page.locator('[data-flag-outcome="ok"]');
  await expect(outcome).toBeVisible();
  await expect(outcome).toHaveAttribute("data-context-correction-id", "context-correction-e2e");
  await expect(outcome).toHaveAttribute("data-severity", "critical");
  await expect(outcome).toContainText("Flag sent to correction");

  expect(observedFlags).toEqual([
    {
      projectId,
      localeBranchId,
      body: {
        note: "Textbox clips the final line.",
        severity: "critical",
        category: "layout",
        bridgeUnitId,
        sourceUnitKey,
        sceneId,
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
  if (url.pathname === "/api/auth/capabilities") {
    await fulfillJson(route, "auth.capabilities", authCapabilitiesGrantedFixture);
    return;
  }
  if (url.pathname === "/api/auth/identity") {
    await fulfillJson(route, "auth.identity", authIdentityFixture);
    return;
  }
  if (url.pathname === "/api/projects") {
    await fulfillJson(route, "projects.list", portfolioProjectsFixture);
    return;
  }
  if (url.pathname === "/api/projects/status") {
    await fulfillJson(route, "projects.status", dashboardStatusFixture);
    return;
  }
  if (url.pathname === "/api/projects/cost") {
    await fulfillJson(route, "projects.cost", costReportFixture);
    return;
  }

  const flagRoute = /^\/api\/projects\/([^/]+)\/locale-branches\/([^/]+)\/flags$/u.exec(
    url.pathname,
  );
  if (flagRoute !== null) {
    const scopedProjectId = decodeURIComponent(flagRoute[1]!);
    const scopedLocaleBranchId = decodeURIComponent(flagRoute[2]!);
    const body = (await route.request().postDataJSON()) as ApiPlayFlagAnnotationRequest;
    observedFlags.push({ projectId: scopedProjectId, localeBranchId: scopedLocaleBranchId, body });
    await fulfillJson(
      route,
      "play.flagAnnotation",
      playFlagAnnotationResponse(scopedProjectId, scopedLocaleBranchId, body),
    );
    return;
  }

  throw new Error(`Unhandled fixture API request: ${route.request().method()} ${url.pathname}`);
}

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

function playFlagAnnotationResponse(
  responseProjectId: string,
  responseLocaleBranchId: string,
  request: ApiPlayFlagAnnotationRequest,
): ApiPlayFlagAnnotationResponse {
  return {
    schemaVersion: "itotori.play.flag-annotation.v0",
    projectId: responseProjectId,
    localeBranchId: responseLocaleBranchId,
    feedbackReportId: "feedback-report-e2e",
    feedbackEvidenceId: "feedback-evidence-e2e",
    severity: request.severity,
    category: request.category ?? "",
    note: request.note,
    triageLabel: "layout_runtime_candidate",
    contextStatus: "contextualized",
    contextCorrectionId: "context-correction-e2e",
    duplicate: false,
  };
}

const authCapabilitiesGrantedFixture: ApiAuthCapabilitiesResponse = {
  schemaVersion: "itotori.auth.capabilities.v0",
  actorUserId: "local-user",
  canFlag: true,
  canSteer: true,
  canReveal: true,
  denials: { flag: null, steer: null, reveal: null },
  denialReasons: [],
};
