// Screen-surface visual contract — the level BELOW the shell chrome.
//
// The shell frame was styled first; the screens inside it still wrote class
// names that no stylesheet defined, so the cost drill-down, the execution
// journal, the catalog candidate browser and the addressable focus shell each
// rendered as raw browser-default HTML inside a styled frame. An unstyled class
// is silently inert — nothing throws, nothing fails, and every existing test
// stayed green.
//
// These assertions are what a reader SEES, measured off the live page: the cost
// panel group as a gapped stack, the served (model, provider) pair as a stacked
// mono block rather than one run-on line, the launch/produce action strips as
// one bordered row of controls, the catalog browser body as a gapped column,
// and the addressed player target as a bordered, accented region. Delete the
// matching stylesheet and every one of them goes red.
//
// DB-free: the closed fixture API surface is fulfilled in the browser, exactly
// as the sibling shell-chrome e2e does, so this stays deterministic.

import { expect, type Locator, type Page, type Route, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertItotoriApiResponse,
  type ApiAuthCapabilitiesResponse,
  type ItotoriApiResponseBody,
  type ItotoriApiRouteId,
} from "../src/api-schema.js";
import {
  authIdentityFixture,
  catalogOpportunitiesFixture,
  costDrilldownFixture,
  costReportFixture,
  dashboardDecisionsFixture,
  dashboardStatusFixture,
  portfolioProjectsFixture,
  projectOverviewFixture,
} from "../test/api-fixtures.js";

const artifactsDir = resolve(fileURLToPath(new URL("../../..", import.meta.url)), "artifacts");

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

/**
 * An element screenshot scrolls its target into view, and the STICKY shell
 * chrome then composites over the result — so a panel shot of a mid-page band
 * comes back with the nav row painted across it. Hide the chrome for the
 * capture; the sibling shell-chrome e2e is what proves the chrome itself.
 */
async function hideStickyChrome(page: Page): Promise<void> {
  await page.addStyleTag({ content: ".itotori-shell-frame__chrome { visibility: hidden; }" });
}

test.beforeEach(async ({ page }) => {
  await installFixtureApi(page);
});

// ---------------------------------------------------------------------------
// Cost drill-down — the panel group, the ledger rows, the served pair.
// ---------------------------------------------------------------------------

test("the cost drill-down is a gapped panel group with a legible served pair", async ({ page }) => {
  await page.goto("/");
  const group = page.getByLabel("Model cost");
  await expect(group).toBeVisible();
  await expect(page.locator(".itotori-panel--cost-drilldown")).toBeVisible();
  await hideStickyChrome(page);
  await group.screenshot({ path: shot("cost-drilldown") });
  await page.getByLabel("Indie localization cost target").screenshot({ path: shot("cost-target") });

  // The two panels stack with a real gap; unstyled they abutted with none.
  expect(await styleOf(group, "display")).toBe("grid");
  expect(parseFloat(await styleOf(group, "row-gap"))).toBeGreaterThan(0);

  const summary = (await page.locator(".itotori-panel--cost").boundingBox())!;
  const ledger = (await page.locator(".itotori-panel--cost-drilldown").boundingBox())!;
  expect(ledger.y).toBeGreaterThan(summary.y + summary.height - 1);

  // The target strip is a row of readouts, not a vertical stack.
  const target = page.getByLabel("Indie localization cost target");
  expect(await styleOf(target, "display")).toBe("grid");
  const targetColumns = (await styleOf(target, "grid-template-columns"))
    .split(/\s+/u)
    .filter(Boolean);
  expect(targetColumns.length).toBeGreaterThan(1);

  // The served pair: model over provider, as a block — never "model via x" on
  // one unreadable run-on line with the requested pair jammed after it.
  const pair = page.locator(".itotori-served-pair").first();
  await expect(pair).toBeVisible();
  const model = pair.locator(".itotori-served-model");
  const provider = pair.locator(".itotori-served-provider");
  const modelBox = (await model.boundingBox())!;
  const providerBox = (await provider.boundingBox())!;
  expect(providerBox.y).toBeGreaterThan(modelBox.y + modelBox.height - 2);
  expect(await styleOf(model, "font-family")).toContain("mono");
  // The requested pair is de-emphasised, not the same weight as what served.
  const requested = pair.locator(".itotori-served-requested");
  await expect(requested).toBeVisible();
  expect(await styleOf(requested, "color")).not.toBe(await styleOf(model, "color"));

  // Amount and timestamp are mono so the ledger columns line up.
  expect(await styleOf(page.locator(".itotori-cost-amount").first(), "font-family")).toContain(
    "mono",
  );
  expect(await styleOf(page.locator(".itotori-cost-started").first(), "font-family")).toContain(
    "mono",
  );
});

// ---------------------------------------------------------------------------
// Pass ledger — the launch / produce action strips.
// ---------------------------------------------------------------------------

test("the execution-journal actions read as one row of chrome, not bare buttons", async ({
  page,
}) => {
  await page.goto("/");
  const panel = page.locator(".itotori-panel--pass-ledger");
  await expect(panel).toBeVisible();
  await hideStickyChrome(page);
  await panel.screenshot({ path: shot("pass-ledger") });

  const launch = page.locator(".itotori-launch-pass-action");
  const produce = page.locator(".itotori-produce-build-action");
  for (const strip of [launch, produce]) {
    await expect(strip).toBeVisible();
    expect(await styleOf(strip, "display")).toBe("flex");
    const button = strip.locator("button");
    // A default <button> is grey with a ~0 radius; ours carries the DS radius,
    // a token border, and a real target height.
    expect(await styleOf(button, "border-top-left-radius")).not.toBe("0px");
    expect(await styleOf(button, "border-top-style")).toBe("solid");
    const box = (await button.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(28);
  }

  // The two strips stack as separate bands, each starting at the panel gutter.
  const launchBox = (await launch.boundingBox())!;
  const produceBox = (await produce.boundingBox())!;
  expect(produceBox.y).toBeGreaterThan(launchBox.y + launchBox.height - 1);
  expect(Math.abs(produceBox.x - launchBox.x)).toBeLessThan(2);
});

// ---------------------------------------------------------------------------
// Catalog candidate browser.
// ---------------------------------------------------------------------------

test("the catalog candidate browser is a gapped column of framed panels", async ({ page }) => {
  await page.goto("/catalog");
  const body = page.locator(".catalog-candidate-browser__body");
  await expect(body).toBeVisible();
  await hideStickyChrome(page);
  await body.screenshot({ path: shot("catalog-browser") });

  expect(await styleOf(body, "display")).toBe("grid");
  expect(parseFloat(await styleOf(body, "row-gap"))).toBeGreaterThan(0);

  const panels = page.locator(".catalog-candidate-browser__panel");
  await expect(panels).toHaveCount(2);
  const first = (await panels.nth(0).boundingBox())!;
  const second = (await panels.nth(1).boundingBox())!;
  expect(second.y).toBeGreaterThan(first.y + first.height - 1);

  // The seven-column readiness matrix scrolls INSIDE its panel; the page body
  // must never gain a horizontal scrollbar because one table is wide.
  expect(await styleOf(panels.last().locator(".itotori-panel__body"), "overflow-x")).toBe("auto");
  const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const viewport = page.viewportSize()!;
  expect(documentWidth).toBeLessThanOrEqual(viewport.width);
});

// ---------------------------------------------------------------------------
// Addressable focus / player.
// ---------------------------------------------------------------------------

test("the addressed player target is a framed, accented region", async ({ page }) => {
  await page.goto("/play/units/unit-42?projectId=project-1&localeBranchId=locale-branch-1");
  const target = page.locator(".addressable-player__target");
  await expect(target).toBeVisible();
  await page.screenshot({ path: shot("addressable-player"), fullPage: true });

  expect(await styleOf(target, "border-left-style")).toBe("solid");
  expect(parseFloat(await styleOf(target, "padding-left"))).toBeGreaterThan(0);
  // The arrival line is a status band above the player, not body prose.
  const arrival = page.locator(".addressable-player__arrival");
  await expect(arrival).toBeVisible();
  const arrivalBox = (await arrival.boundingBox())!;
  const targetBox = (await target.boundingBox())!;
  expect(arrivalBox.y).toBeGreaterThanOrEqual(targetBox.y - 1);
  expect(await styleOf(arrival, "background-color")).not.toBe("rgba(0, 0, 0, 0)");

  // The return actions are one row of links, not a stack of <p> paragraphs.
  const actions = page.getByLabel("Addressed player actions");
  await expect(actions).toBeVisible();
  expect(await styleOf(actions, "display")).toBe("flex");
});

test("the addressable focus shell frames its focused entity", async ({ page }) => {
  await page.goto("/runs/run-77");
  const shell = page.locator(".addressable-focus");
  await expect(shell).toBeVisible();
  await page.screenshot({ path: shot("addressable-focus"), fullPage: true });

  const panel = page.locator(".addressable-focus__panel");
  await expect(panel).toBeVisible();
  // Capped measure: a one-line focus statement must not span a 1280px row.
  const box = (await panel.boundingBox())!;
  expect(box.width).toBeLessThan(900);
  // The id is called out against the surrounding prose, not the same ink.
  const code = panel.locator("code[data-addressable-id-value]");
  expect(await styleOf(code, "color")).not.toBe(await styleOf(panel.locator("p").first(), "color"));
});

// ---------------------------------------------------------------------------
// Fixture API — the closed surface these screens read on mount.
// ---------------------------------------------------------------------------

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

const FIXTURE_BY_PATH: ReadonlyArray<readonly [string, ItotoriApiRouteId, ItotoriApiResponseBody]> =
  [
    ["/api/auth/identity", "auth.identity", authIdentityFixture],
    ["/api/projects", "projects.list", portfolioProjectsFixture],
    ["/api/projects/status", "projects.status", dashboardStatusFixture],
    ["/api/projects/cost", "projects.cost", costReportFixture],
    ["/api/projects/cost/drilldown", "projects.costDrilldown", costDrilldownFixture],
    ["/api/projects/overview", "projects.overview", projectOverviewFixture],
    ["/api/projects/decisions", "projects.decisions", dashboardDecisionsFixture],
    ["/api/catalog/opportunities", "catalog.opportunities", catalogOpportunitiesFixture],
  ];

async function fulfillApi(route: Route, url: URL): Promise<void> {
  if (url.pathname === "/api/auth/capabilities") {
    await fulfillJson(route, "auth.capabilities", authCapabilitiesFixture);
    return;
  }
  for (const [path, routeId, body] of FIXTURE_BY_PATH) {
    if (url.pathname === path) {
      await fulfillJson(route, routeId, body);
      return;
    }
  }
  // Sibling panels may fire; settle them without crashing the SPA.
  await route.fulfill({
    status: 404,
    contentType: "application/json",
    body: JSON.stringify({ error: "not fixtured for screen-surfaces e2e", code: "not_found" }),
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

const authCapabilitiesFixture: ApiAuthCapabilitiesResponse = {
  schemaVersion: "itotori.auth.capabilities.v0",
  actorUserId: "local-user",
  canFlag: true,
  canSteer: true,
  canReveal: true,
  denials: { flag: null, steer: null, reveal: null },
  denialReasons: [],
};
