import { expect, type Page, type Route, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertItotoriApiResponse,
  type ApiAuthCapabilitiesResponse,
  type ApiProjectsResponse,
  type ItotoriApiResponseBody,
  type ItotoriApiRouteId,
  type ProjectPortfolioEntry,
} from "../src/api-schema.js";
import {
  authIdentityFixture,
  costReportFixture,
  dashboardStatusFixture,
  portfolioProjectsFixture,
} from "../test/api-fixtures.js";

const artifactsDir = resolve(fileURLToPath(new URL("../../..", import.meta.url)), "artifacts");
const screenshotPath = resolve(artifactsDir, "portfolio-progress-dashboard.png");
const denseScreenshotPath = resolve(artifactsDir, "portfolio-progress-dashboard-dense.png");
const dense40ScreenshotPath = resolve(artifactsDir, "portfolio-progress-dashboard-dense-40.png");

/** N projects in varied states so density is exercised, not asserted. */
function densePortfolioFixture(count = 12): ApiProjectsResponse {
  const engines = [
    "reallive",
    "siglus",
    "kiri_kiri_xp3",
    "rpgmaker_mv",
    "softpal",
    "tyrano",
    null,
  ] as const;
  const templates = portfolioProjectsFixture.projects;
  const projects: ProjectPortfolioEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = templates[i % templates.length]!;
    const engine = engines[i % engines.length] ?? null;
    const key = `project-dense-${String(i + 1).padStart(2, "0")}`;
    const provenShare = i % 5;
    const totalUnits = 4 + (i % 3);
    const patched = provenShare === 0 ? 0 : Math.min(totalUnits, provenShare);
    const drafted = Math.max(0, totalUnits - patched - (i % 2));
    const decoded = Math.max(0, totalUnits - patched - drafted);
    projects.push({
      ...base,
      projectId: `dense-${i + 1}`,
      projectKey: key,
      name: key,
      engineFamily: engine,
      findingCount: i % 4 === 0 ? i % 3 : 0,
      status: i % 3 === 0 ? "drafting" : base.status,
      progress: {
        ...base.progress,
        projectId: `dense-${i + 1}`,
        runCount: i % 5 === 4 ? 0 : 1 + (i % 3),
        runStatusCounts: {
          queued: i % 7 === 1 ? 1 : 0,
          running: i % 5 === 0 ? 1 : 0,
          paused: i % 6 === 2 ? 1 : 0,
          completed: i % 4 === 3 ? 1 : 0,
          failed: 0,
          cancelled: 0,
        },
        unitCounts:
          i % 5 === 4
            ? { decoded: 0, drafted: 0, QA: 0, accepted: 0, patched: 0 }
            : {
                decoded,
                drafted,
                QA: i % 3,
                accepted: Math.max(0, (i % 2) - (i % 3 === 0 ? 0 : 0)),
                patched,
              },
        totalCostMicrosUsd: i % 5 === 4 ? 0 : 1000 * (i + 1) + i * 17,
        averageCoveragePercent: i % 5 === 4 ? 0 : Math.min(100, 20 + i * 7),
        blockers:
          i % 4 === 1
            ? [
                {
                  runId: `dense-run-${i + 1}`,
                  bridgeUnitId: `dense-unit-${i + 1}`,
                  role: "writer",
                  blockers: ["review-needed"],
                },
              ]
            : [],
      },
    });
  }
  return { projects };
}

test("live portfolio dashboard renders multi-project progress (screenshot)", async ({ page }) => {
  await installFixtureApi(page, portfolioProjectsFixture);
  await page.goto("/");

  const panel = page.locator('[data-panel="portfolio-progress"]');
  await expect(panel).toHaveAttribute("data-panel-state", "ready", { timeout: 30_000 });
  await expect(page.locator("[data-portfolio-count]")).toHaveAttribute("data-portfolio-count", "4");
  await expect(page.getByRole("heading", { name: "project-alpha" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "project-beta" })).toBeVisible();
  await expect(page.getByText("reallive")).toBeVisible();
  await expect(page.getByText("siglus")).toBeVisible();
  await expect(page.locator("[data-portfolio-rollup]")).toBeVisible();
  // Proven fill is separate from stage mix — zero proven must not look "full".
  await expect(page.locator("[data-portfolio-stage-mix]").first()).toBeVisible();
  await expect(page.getByText("Stage mix").first()).toBeVisible();

  mkdirSync(artifactsDir, { recursive: true });
  await panel.screenshot({ path: screenshotPath });
  // Also capture the full viewport for the report.
  await page.screenshot({
    path: resolve(artifactsDir, "portfolio-progress-dashboard-full.png"),
    fullPage: true,
  });
});

test("dense portfolio (≥10 projects) stays scannable (screenshot)", async ({ page }) => {
  const dense = densePortfolioFixture(12);
  expect(dense.projects.length).toBeGreaterThanOrEqual(10);
  await installFixtureApi(page, dense);
  await page.goto("/");

  const panel = page.locator('[data-panel="portfolio-progress"]');
  await expect(panel).toHaveAttribute("data-panel-state", "ready", { timeout: 30_000 });
  await expect(page.locator("[data-portfolio-count]")).toHaveAttribute(
    "data-portfolio-count",
    String(dense.projects.length),
  );
  await expect(page.locator("[data-portfolio-density]")).toHaveAttribute(
    "data-portfolio-density",
    "dense",
  );
  await expect(page.locator('[data-portfolio-layout="dense"]')).toBeVisible();
  await expect(page.locator("[data-portfolio-rollup]")).toBeVisible();
  // Compact table still exposes the concurrent-progress label (virtualized).
  await expect(page.getByLabel("Concurrent project progress")).toBeVisible();
  // Stage-mix legend stays off dense rows — essentials only.
  await expect(page.locator("[data-portfolio-stage-mix]")).toHaveCount(0);

  mkdirSync(artifactsDir, { recursive: true });
  await panel.screenshot({ path: denseScreenshotPath });
  await page.screenshot({
    path: resolve(artifactsDir, "portfolio-progress-dashboard-dense-full.png"),
    fullPage: true,
  });
});

test("dense portfolio (40 projects) stress-tests table density (screenshot)", async ({ page }) => {
  const dense = densePortfolioFixture(40);
  expect(dense.projects.length).toBe(40);
  await installFixtureApi(page, dense);
  await page.goto("/");

  const panel = page.locator('[data-panel="portfolio-progress"]');
  await expect(panel).toHaveAttribute("data-panel-state", "ready", { timeout: 30_000 });
  await expect(page.locator("[data-portfolio-count]")).toHaveAttribute(
    "data-portfolio-count",
    "40",
  );
  await expect(page.locator('[data-portfolio-layout="dense"]')).toBeVisible();
  await expect(page.getByLabel("Concurrent project progress")).toHaveAttribute(
    "data-virtualized",
    "true",
  );

  mkdirSync(artifactsDir, { recursive: true });
  await panel.screenshot({ path: dense40ScreenshotPath });
  await page.screenshot({
    path: resolve(artifactsDir, "portfolio-progress-dashboard-dense-40-full.png"),
    fullPage: true,
  });
});

async function installFixtureApi(page: Page, projects: ApiProjectsResponse): Promise<void> {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/")) {
      await fulfillApi(route, url, projects);
      return;
    }
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      await route.continue();
      return;
    }
    await route.abort();
  });
}

async function fulfillApi(route: Route, url: URL, projects: ApiProjectsResponse): Promise<void> {
  if (url.pathname === "/api/auth/capabilities") {
    await fulfillJson(route, "auth.capabilities", authCapabilitiesGrantedFixture);
    return;
  }
  if (url.pathname === "/api/auth/identity") {
    await fulfillJson(route, "auth.identity", authIdentityFixture);
    return;
  }
  if (url.pathname === "/api/projects") {
    await fulfillJson(route, "projects.list", projects);
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

  // Sibling dashboard panels may fire; settle them without crashing the SPA.
  await route.fulfill({
    status: 404,
    contentType: "application/json",
    body: JSON.stringify({ error: "not fixtureed for portfolio e2e", code: "not_found" }),
  });
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

const authCapabilitiesGrantedFixture: ApiAuthCapabilitiesResponse = {
  schemaVersion: "itotori.auth.capabilities.v0",
  actorUserId: "local-user",
  canFlag: true,
  canSteer: true,
  canReveal: true,
  denials: { flag: null, steer: null, reveal: null },
  denialReasons: [],
};
