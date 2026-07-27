// Play surfaces — hub, route map, and flag composer.
//
// "Play" is a top-level nav pill, so these are the first screens a reviewer
// reaches after the workbench. Every class they wrote had no CSS rule anywhere:
// the hub's two context actions rendered as bare `<p>` links, the route-map
// panels abutted with no seam and clipped the diagram, and the composer's
// denial and outcome lines were plain body prose. Nothing failed — an unstyled
// class is silently inert.
//
// Measured off the live page; delete `play.css` and every assertion goes red.

import { expect, type Locator, type Page, type Route, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertItotoriApiResponse,
  type ApiAuthCapabilitiesResponse,
  type ApiPatchIterationVersionsResponse,
  type ApiPlayRouteMapResponse,
  type ItotoriApiResponseBody,
  type ItotoriApiRouteId,
} from "../src/api-schema.js";
import {
  authIdentityFixture,
  costReportFixture,
  dashboardStatusFixture,
  portfolioProjectsFixture,
} from "../test/api-fixtures.js";

const artifactsDir = resolve(fileURLToPath(new URL("../../..", import.meta.url)), "artifacts");
const PROJECT_ID = dashboardStatusFixture.projectId;
const LOCALE_BRANCH_ID = dashboardStatusFixture.selectedLocaleBranchId;
if (LOCALE_BRANCH_ID === null) {
  throw new Error("The dashboard status fixture requires a selected locale branch.");
}

async function styleOf(locator: Locator, property: string): Promise<string> {
  return locator.evaluate(
    (node, prop) => window.getComputedStyle(node).getPropertyValue(prop),
    property,
  );
}

function shot(name: string): string {
  mkdirSync(artifactsDir, { recursive: true });
  return resolve(artifactsDir, `surface-${name}.png`);
}

async function hideStickyChrome(page: Page): Promise<void> {
  await page.addStyleTag({ content: ".itotori-shell-frame__chrome { visibility: hidden; }" });
}

test.beforeEach(async ({ page }) => {
  await installFixtureApi(page);
});

test("the play hub's context actions read as chrome, not body links", async ({ page }) => {
  await page.goto("/play");
  const tools = page.locator(".play-hub__tools");
  await expect(tools).toBeVisible();
  await hideStickyChrome(page);
  await page.getByLabel("Play hub sections").screenshot({ path: shot("play-hub") });

  const routeMapLink = tools.getByRole("link", { name: "Open route map" });
  const flagLink = tools.getByRole("link", { name: "Flag a correction" });
  for (const link of [routeMapLink, flagLink]) {
    await expect(link).toBeVisible();
    expect(await styleOf(link, "border-top-style")).toBe("solid");
    expect(await styleOf(link, "border-top-left-radius")).not.toBe("0px");
    expect(await styleOf(link, "text-decoration-line")).toBe("none");
    const box = (await link.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(28);
  }

  // The panel body is a gapped column, so the lede and the two actions do not
  // run together as one block of default paragraph margins.
  const body = tools.locator(".itotori-panel__body");
  expect(await styleOf(body, "display")).toBe("flex");
  expect(parseFloat(await styleOf(body, "row-gap"))).toBeGreaterThan(0);
});

test("the route map is a gapped column with a scrollable diagram", async ({ page }) => {
  await page.goto(`/play/routemap?projectId=${PROJECT_ID}&localeBranchId=${LOCALE_BRANCH_ID}`);
  const body = page.locator(".play-routemap__body");
  await expect(body).toBeVisible();
  await hideStickyChrome(page);
  await body.screenshot({ path: shot("play-routemap") });

  expect(await styleOf(body, "display")).toBe("grid");
  expect(parseFloat(await styleOf(body, "row-gap"))).toBeGreaterThan(0);

  const counts = page.locator(".play-routemap__counts");
  const map = page.locator(".play-routemap__map");
  const countsBox = (await counts.boundingBox())!;
  const mapBox = (await map.boundingBox())!;
  expect(mapBox.y).toBeGreaterThan(countsBox.y + countsBox.height - 1);

  // The freshness badges share a row instead of stacking.
  const summary = page.locator(".play-routemap__summary");
  expect(await styleOf(summary, "display")).toBe("flex");

  // The diagram scrolls inside its panel; the document never gains a
  // horizontal scrollbar because a route tree is wide.
  expect(await styleOf(map.locator(".itotori-panel__body"), "overflow-x")).toBe("auto");
  const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(documentWidth).toBeLessThanOrEqual(page.viewportSize()!.width);

  // Selecting a route opens a capped-measure detail panel with mono metadata.
  await page.locator('[data-route-id="route-1"]').click();
  const detail = page.locator(".play-routemap__detail");
  await expect(detail).toBeVisible();
  // The summary keeps a reading measure even though the panel spans the column.
  const summaryText = page.locator(".play-routemap__detail-summary");
  expect((await summaryText.boundingBox())!.width).toBeLessThan(900);
  expect((await detail.boundingBox())!.width).toBeGreaterThan(900);
  expect(await styleOf(page.locator(".play-routemap__detail-meta"), "font-family")).toContain(
    "mono",
  );
  await detail.screenshot({ path: shot("play-routemap-detail") });
});

test("the flag composer's refusal reads as a refusal", async ({ page }) => {
  await page.goto(
    `/play/flag?projectId=${PROJECT_ID}&localeBranchId=${LOCALE_BRANCH_ID}&unitId=unit-42`,
  );
  const panel = page.locator(".play-flag__panel");
  await expect(panel).toBeVisible();
  await hideStickyChrome(page);
  await page.locator(".play-flag__body").screenshot({ path: shot("play-flag") });

  expect(await styleOf(page.locator(".play-flag__body"), "display")).toBe("grid");
  // A capped measure: the composer is a form, not a 1280px-wide band.
  expect((await panel.boundingBox())!.width).toBeLessThan(1000);

  const denial = page.locator(".play-flag__denial");
  await expect(denial).toBeVisible();
  // A tinted, bordered band — not a paragraph indistinguishable from the copy.
  expect(await styleOf(denial, "background-color")).not.toBe("rgba(0, 0, 0, 0)");
  expect(await styleOf(denial, "border-top-style")).toBe("solid");
  const composerCopy = panel.locator(".itotori-panel__body p").last();
  expect(await styleOf(denial, "color")).not.toBe(await styleOf(composerCopy, "color"));
});

// ---------------------------------------------------------------------------
// Fixture API.
// ---------------------------------------------------------------------------

const versionsFixture: ApiPatchIterationVersionsResponse = {
  schemaVersion: "itotori.patch-iteration.versions.v0",
  versions: [
    {
      patchVersionId: "patch-version-2",
      runId: "run-2",
      parentPatchVersionId: "patch-version-1",
      origin: "refinement_run",
      status: "ready",
      playableAt: "2026-07-17T00:00:00.000Z",
      selectedAt: "2026-07-17T00:01:00.000Z",
      artifactHashes: { patch: "sha256:patch-2" },
      basePatchVersionId: "patch-version-1",
    },
  ],
};

const routeMapFixture: ApiPlayRouteMapResponse = {
  schemaVersion: "itotori.play.route-map.v0",
  generatedAt: "2026-07-17T00:00:00.000Z",
  projectId: PROJECT_ID,
  localeBranchId: LOCALE_BRANCH_ID,
  nodes: [
    {
      routeKey: "route-1",
      routeMapId: "route-map-1",
      label: "Opening route",
      summary: "The opening route has current context for every choice it reaches.",
      col: 0,
      row: 0,
      state: "fresh",
      coverage: "fresh",
      issues: 0,
    },
    {
      routeKey: "route-2",
      routeMapId: "route-map-2",
      label: "Festival branch",
      summary: "Context on this branch is stale after the last source revision.",
      col: 1,
      row: 0,
      state: "stale",
      coverage: "stale",
      issues: 2,
    },
  ],
  edges: [
    {
      choiceKey: "choice-1",
      choiceKind: "branch",
      fromRouteKey: "route-1",
      toRouteKey: "route-2",
      label: "Go to the festival",
    },
  ],
  counts: { fresh: 1, stale: 1, total: 2, choiceCount: 1 },
};

/** Flagging is DENIED here: the refusal band is the thing being proven. */
const authCapabilitiesFixture: ApiAuthCapabilitiesResponse = {
  schemaVersion: "itotori.auth.capabilities.v0",
  actorUserId: "local-user",
  canFlag: false,
  canSteer: true,
  canReveal: true,
  denials: {
    flag: "feedback.import permission required to flag a line",
    steer: null,
    reveal: null,
  },
  denialReasons: ["feedback.import"],
};

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
  const table: ReadonlyArray<readonly [string, ItotoriApiRouteId, ItotoriApiResponseBody]> = [
    ["/api/auth/capabilities", "auth.capabilities", authCapabilitiesFixture],
    ["/api/auth/identity", "auth.identity", authIdentityFixture],
    ["/api/projects", "projects.list", portfolioProjectsFixture],
    ["/api/projects/status", "projects.status", dashboardStatusFixture],
    ["/api/projects/cost", "projects.cost", costReportFixture],
    [
      `/api/play/locale-branches/${LOCALE_BRANCH_ID}/patch-versions`,
      "patchIteration.versions",
      versionsFixture,
    ],
    [
      `/api/projects/${PROJECT_ID}/locale-branches/${LOCALE_BRANCH_ID}/route-map`,
      "play.routeMap",
      routeMapFixture,
    ],
  ];
  for (const [path, routeId, body] of table) {
    if (url.pathname === path) {
      assertItotoriApiResponse(routeId, body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
      return;
    }
  }
  await route.fulfill({
    status: 404,
    contentType: "application/json",
    body: JSON.stringify({ error: "not fixtured for play-surfaces e2e", code: "not_found" }),
  });
}
