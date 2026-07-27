// Shell-chrome visual contract.
//
// The app chrome (nav row, workspace/branch controls, ⌘K affordance, status
// bar, project summary strip, section grid) referenced class names that had no
// CSS rule in any stylesheet, so the whole frame rendered as raw browser
// default HTML around a fully styled interior. Nothing failed: an unstyled
// class is silently inert.
//
// These assertions are what a reader SEES, measured off the live rendered page
// — the night canvas, the status bar laid out as one row of labelled cells
// (not a vertical run of "Projectproject-alpha"), the summary strip as an
// aligned grid rather than a browser `<dl>`, the section grid as two columns,
// and the toolbar controls as bordered chrome rather than default `<button>`s.
// Delete either app stylesheet and every one of them goes red.
//
// DB-free: the closed fixture API surface is fulfilled in the browser, exactly
// as the sibling shell smoke does, so this stays deterministic.

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
  costReportFixture,
  dashboardStatusFixture,
  portfolioProjectsFixture,
} from "../test/api-fixtures.js";

const artifactsDir = resolve(fileURLToPath(new URL("../../..", import.meta.url)), "artifacts");

// Dusk Observatory tokens, as the browser resolves them. These are the DS
// values (`packages/itotori-ds/tokens/colors.css` / `interface.css`); asserting
// the computed colour proves the app sheet consumed the DS token rather than
// leaving the surface unpainted or inventing its own palette.
const PAGE_BG = "rgb(21, 16, 31)"; // --ito-color-page
const STATUSBAR_BG = "rgb(23, 18, 42)"; // --ito-statusbar-bg
const SURFACE_BG = "rgb(32, 26, 52)"; // --ito-color-surface

async function styleOf(locator: Locator, property: string): Promise<string> {
  return locator.evaluate(
    (node, prop) => window.getComputedStyle(node).getPropertyValue(prop),
    property,
  );
}

test.beforeEach(async ({ page }) => {
  await installFixtureApi(page);
});

test("the frame renders on the night canvas, not the default white page", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-shell-frame="true"]')).toBeVisible();

  expect(await styleOf(page.locator("body"), "background-color")).toBe(PAGE_BG);
  expect(await styleOf(page.locator(".itotori-shell-frame"), "background-color")).toBe(PAGE_BG);
});

test("the status bar is one row of labelled cells, aligned and separated", async ({ page }) => {
  await page.goto("/");

  const bar = page.locator("[data-shell-status]");
  await expect(bar).toBeVisible();
  expect(await styleOf(bar, "background-color")).toBe(STATUSBAR_BG);

  const project = page.locator('[data-shell-stat="project"]');
  const branch = page.locator('[data-shell-stat="branch"]');
  const cost = page.locator('[data-shell-stat="cost"]');
  await expect(project).toBeVisible();

  const projectBox = (await project.boundingBox())!;
  const branchBox = (await branch.boundingBox())!;
  const costBox = (await cost.boundingBox())!;

  // Laid out as a ROW: each later cell starts to the right of the previous one
  // and shares its vertical band. Unstyled, these were stacked <div>s.
  expect(branchBox.x).toBeGreaterThan(projectBox.x + projectBox.width - 1);
  expect(costBox.x).toBeGreaterThan(branchBox.x);
  expect(Math.abs(branchBox.y - projectBox.y)).toBeLessThan(2);

  // Within a cell the label sits ABOVE its value, so "Project" and
  // "project-alpha" can never run together as one unreadable string.
  const label = project.locator(".itotori-shell-frame__stat-label");
  const value = project.locator(".itotori-shell-frame__stat-value");
  const labelBox = (await label.boundingBox())!;
  const valueBox = (await value.boundingBox())!;
  expect(labelBox.y + labelBox.height).toBeLessThanOrEqual(valueBox.y + 1);
  expect(await styleOf(label, "text-transform")).toBe("uppercase");

  // The whole bar stays a single band, not a tall stack of rows.
  const barBox = (await bar.boundingBox())!;
  expect(barBox.height).toBeLessThan(80);
});

test("the chrome and the screen content share one measure on a wide display", async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto("/");
  await expect(page.locator('[data-shell-frame="true"]')).toBeVisible();

  // The status bar's first cell must start on the same vertical line as the
  // screen's own content, or the chrome reads as a different, wider page.
  const statCell = (await page.locator('[data-shell-stat="project"]').boundingBox())!;
  const summaryCell = (await page
    .getByLabel("Project summary")
    .locator("> div")
    .first()
    .boundingBox())!;
  expect(Math.abs(statCell.x - summaryCell.x)).toBeLessThan(4);
  // …and that shared line is the CENTRED measure, not the raw viewport edge:
  // 1800px viewport around a 1440px measure leaves a ~180px gutter each side.
  expect(statCell.x).toBeGreaterThan(120);

  const toolbar = (await page.locator('[data-shell-toolbar="true"]').boundingBox())!;
  const summary = (await page.getByLabel("Project summary").boundingBox())!;
  expect(Math.abs(toolbar.x + toolbar.width - (summary.x + summary.width))).toBeLessThan(4);
});

test("the project summary is an aligned grid, not a browser definition list", async ({ page }) => {
  await page.goto("/");

  const strip = page.getByLabel("Project summary");
  await expect(strip).toBeVisible();
  expect(await styleOf(strip, "display")).toBe("grid");

  // More than one column: the second cell shares the first cell's row.
  const columns = (await styleOf(strip, "grid-template-columns")).split(/\s+/u).filter(Boolean);
  expect(columns.length).toBeGreaterThan(1);

  const cells = strip.locator("> div");
  await expect(cells).toHaveCount(6);
  const first = (await cells.nth(0).boundingBox())!;
  const second = (await cells.nth(1).boundingBox())!;
  expect(second.x).toBeGreaterThan(first.x);
  expect(Math.abs(second.y - first.y)).toBeLessThan(2);
  expect(await styleOf(cells.first(), "background-color")).toBe(SURFACE_BG);

  // A <dd> must not keep the browser's default 40px indent.
  const dd = strip.locator("dd").first();
  expect(await styleOf(dd, "margin-inline-start")).toBe("0px");
});

test("the dashboard section grid is a gapped grid that widens to two columns", async ({ page }) => {
  await page.goto("/");

  const grid = page.getByLabel("Dashboard sections");
  await expect(grid).toBeVisible();
  expect(await styleOf(grid, "display")).toBe("grid");
  // A real gap between panels — unstyled they abutted with no separation.
  expect(await styleOf(grid, "row-gap")).not.toBe("normal");
  expect(parseFloat(await styleOf(grid, "row-gap"))).toBeGreaterThan(0);

  // At 1280 the data tables need the full width, so one column.
  const narrow = (await styleOf(grid, "grid-template-columns")).split(/\s+/u).filter(Boolean);
  expect(narrow.length).toBe(1);

  // Given room, panels sit side by side rather than running one long column.
  await page.setViewportSize({ width: 1800, height: 900 });
  const wide = (await styleOf(grid, "grid-template-columns")).split(/\s+/u).filter(Boolean);
  expect(wide.length).toBe(2);
});

test("toolbar controls read as chrome, not as default browser buttons", async ({ page }) => {
  await page.goto("/");

  const toolbar = page.locator('[data-shell-toolbar="true"]');
  await expect(toolbar).toBeVisible();
  expect(await styleOf(toolbar, "display")).toBe("flex");

  const commandTrigger = page.locator('[data-command-trigger="true"]');
  const switcherTrigger = page.locator('[data-switcher-trigger="true"]');

  for (const control of [commandTrigger, switcherTrigger]) {
    await expect(control).toBeVisible();
    // A default <button> is border-box grey with a 0-ish radius; ours carry the
    // DS pill radius and a token border.
    expect(await styleOf(control, "border-top-left-radius")).not.toBe("0px");
    expect(await styleOf(control, "border-top-style")).toBe("solid");
  }

  // The controls share ONE row with each other and hang off the right edge of
  // the chrome. Unstyled they were a left-aligned vertical stack of four
  // default controls, one per line.
  const commandBox = (await commandTrigger.boundingBox())!;
  const switcherBox = (await switcherTrigger.boundingBox())!;
  expect(Math.abs(commandBox.y - switcherBox.y)).toBeLessThan(4);
  expect(commandBox.x).toBeGreaterThan(switcherBox.x + switcherBox.width - 1);

  const chromeBox = (await page.locator(".itotori-shell-frame__chrome").boundingBox())!;
  const toolbarBox = (await toolbar.boundingBox())!;
  const chromeRight = chromeBox.x + chromeBox.width;
  expect(chromeRight - (toolbarBox.x + toolbarBox.width)).toBeLessThan(32);
  // The nav pills lead the chrome; the toolbar never precedes them.
  const navBox = (await page.getByRole("navigation", { name: "Surfaces" }).boundingBox())!;
  expect(toolbarBox.y).toBeGreaterThanOrEqual(navBox.y);
  // Two compact rows at most — the chrome must not become a tall stack.
  expect(chromeBox.height).toBeLessThan(120);
});

test("the shell chrome renders as one product (screenshot)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-panel="portfolio-progress"]')).toHaveAttribute(
    "data-panel-state",
    "ready",
    { timeout: 30_000 },
  );

  mkdirSync(artifactsDir, { recursive: true });
  await page.screenshot({ path: resolve(artifactsDir, "shell-chrome-full.png"), fullPage: true });
  // The chrome band on its own — nav, toolbar, status bar, summary strip.
  await page.screenshot({
    path: resolve(artifactsDir, "shell-chrome-frame.png"),
    clip: { x: 0, y: 0, width: 1280, height: 300 },
  });

  // The wide layout, where the section grid opens to two columns.
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.screenshot({ path: resolve(artifactsDir, "shell-chrome-wide.png"), fullPage: true });
});

// ---------------------------------------------------------------------------
// Fixture API — the closed surface the dashboard reads on mount.
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

async function fulfillApi(route: Route, url: URL): Promise<void> {
  if (url.pathname === "/api/auth/capabilities") {
    await fulfillJson(route, "auth.capabilities", authCapabilitiesFixture);
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
  // Sibling panels may fire; settle them without crashing the SPA.
  await route.fulfill({
    status: 404,
    contentType: "application/json",
    body: JSON.stringify({ error: "not fixtured for shell-chrome e2e", code: "not_found" }),
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
