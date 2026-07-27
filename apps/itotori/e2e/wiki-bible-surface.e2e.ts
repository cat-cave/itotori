// Wiki bible dashboard — the visual contract for the shared project brain.
//
// Every class this surface writes (`wiki-bible__grid`, `__claims`, `__facts`,
// `__citations`, `__route-toggles`, `__writes`, …) had no CSS rule anywhere, so
// the whole screen rendered as browser-default HTML: a single stacked column,
// bullet-point claim lists, an indented `<dl>`, and route/view toggles as a run
// of bare `<button>`s. Nothing failed — an unstyled class is silently inert.
//
// These assertions are measured off the live page and describe what a reader
// sees: the two-column grid on a wide display, the claim list as framed cards
// rather than bullets, the fact list as an aligned grid rather than an indented
// definition list, and the toggles as pressed-state chrome. Delete
// `wiki-bible.css` and every one of them goes red.

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
import { authIdentityFixture, portfolioProjectsFixture } from "../test/api-fixtures.js";

const artifactsDir = resolve(fileURLToPath(new URL("../../..", import.meta.url)), "artifacts");

const SNAPSHOT_ID = `sha256:${"a".repeat(64)}`;
const HASH = `sha256:${"b".repeat(64)}`;
const BIBLE_URL = `/bible?projectId=project-1&localeBranchId=locale-branch-1&snapshotId=${encodeURIComponent(SNAPSHOT_ID)}`;

async function styleOf(locator: Locator, property: string): Promise<string> {
  return locator.evaluate(
    (node, prop) => window.getComputedStyle(node).getPropertyValue(prop),
    property,
  );
}

test.beforeEach(async ({ page }) => {
  await installFixtureApi(page);
});

test("the wiki bible reads as one product, not a stack of default HTML", async ({ page }) => {
  await page.goto(BIBLE_URL);
  const grid = page.locator(".wiki-bible__grid");
  await expect(grid).toBeVisible();
  await expect(page.locator(".wiki-bible__detail")).toBeVisible();

  mkdirSync(artifactsDir, { recursive: true });
  await page.screenshot({ path: resolve(artifactsDir, "surface-wiki-bible.png"), fullPage: true });
  await page.addStyleTag({ content: ".itotori-shell-frame__chrome { visibility: hidden; }" });
  await page
    .locator(".wiki-bible__writes")
    .screenshot({ path: resolve(artifactsDir, "surface-wiki-bible-writes.png") });
  await page
    .locator(".wiki-bible__claims")
    .screenshot({ path: resolve(artifactsDir, "surface-wiki-bible-claims.png") });
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.screenshot({
    path: resolve(artifactsDir, "surface-wiki-bible-wide.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 800 });

  // The screen is a real grid with separation between its bands.
  expect(await styleOf(grid, "display")).toBe("grid");
  expect(parseFloat(await styleOf(grid, "row-gap"))).toBeGreaterThan(0);

  // Given room, the detail column and the write column sit side by side.
  await page.setViewportSize({ width: 1800, height: 1000 });
  const detailBox = (await page.locator(".wiki-bible__detail").boundingBox())!;
  const writesBox = (await page.locator(".wiki-bible__writes").boundingBox())!;
  expect(writesBox.x).toBeGreaterThan(detailBox.x + detailBox.width - 1);
});

test("claims render as framed cards, not browser bullet points", async ({ page }) => {
  await page.goto(BIBLE_URL);
  const claims = page.locator(".wiki-bible__claims");
  await expect(claims).toBeVisible();

  // A default <ul> carries a disc marker and a ~40px inline start padding.
  expect(await styleOf(claims, "list-style-type")).toBe("none");
  expect(await styleOf(claims, "padding-inline-start")).toBe("0px");

  const claim = page.locator(".wiki-bible__claim").first();
  await expect(claim).toBeVisible();
  expect(await styleOf(claim, "border-left-style")).toBe("solid");
  expect(parseFloat(await styleOf(claim, "padding-left"))).toBeGreaterThan(0);

  // Scope badge and confidence badge share one row above the statement.
  const head = claim.locator(".wiki-bible__claim-head");
  expect(await styleOf(head, "display")).toBe("flex");
  const headBox = (await head.boundingBox())!;
  const statementBox = (await claim.locator(".wiki-bible__claim-statement").boundingBox())!;
  expect(statementBox.y).toBeGreaterThan(headBox.y + headBox.height - 2);

  // Citations are a de-emphasised sub-list, still unbulleted.
  const citations = claim.locator(".wiki-bible__citations");
  await expect(citations).toBeVisible();
  expect(await styleOf(citations, "list-style-type")).toBe("none");
  expect(await styleOf(citations, "color")).not.toBe(
    await styleOf(claim.locator(".wiki-bible__claim-statement"), "color"),
  );
});

test("object facts are an aligned grid, not an indented definition list", async ({ page }) => {
  await page.goto(BIBLE_URL);
  const facts = page.locator(".wiki-bible__facts");
  await expect(facts).toBeVisible();
  expect(await styleOf(facts, "display")).toBe("grid");

  // A <dd> must not keep the browser's default 40px indent.
  expect(await styleOf(facts.locator("dd").first(), "margin-inline-start")).toBe("0px");

  const cells = facts.locator("> div");
  await expect(cells).toHaveCount(3);
  const first = (await cells.nth(0).boundingBox())!;
  const second = (await cells.nth(1).boundingBox())!;
  expect(second.x).toBeGreaterThan(first.x);
  expect(Math.abs(second.y - first.y)).toBeLessThan(2);
});

test("route and view toggles are chrome with a visible pressed state", async ({ page }) => {
  await page.goto(BIBLE_URL);
  const toggles = page.locator(".wiki-bible__route-toggles");
  await expect(toggles).toBeVisible();
  expect(await styleOf(toggles, "display")).toBe("flex");

  const canonical = toggles.locator('[data-route-toggle="canonical"]');
  const routed = toggles.locator('[data-route-toggle="route-akari"]');
  await expect(canonical).toBeVisible();
  await expect(routed).toBeVisible();

  // Bordered pills, not default buttons.
  expect(await styleOf(canonical, "border-top-left-radius")).not.toBe("0px");
  expect(await styleOf(canonical, "border-top-style")).toBe("solid");

  // The pressed toggle is visually distinct from the unpressed one — unstyled,
  // aria-pressed changed nothing a reader could see.
  const pressedBg = await styleOf(canonical, "background-color");
  const restingBg = await styleOf(routed, "background-color");
  expect(pressedBg).not.toBe(restingBg);

  // They share one row rather than stacking one control per line.
  const canonicalBox = (await canonical.boundingBox())!;
  const routedBox = (await routed.boundingBox())!;
  expect(Math.abs(routedBox.y - canonicalBox.y)).toBeLessThan(2);

  const view = page.locator(".wiki-bible__view-toggle");
  expect(await styleOf(view, "display")).toBe("flex");
  const source = view.locator('[data-view-toggle="source"]');
  const bible = view.locator('[data-view-toggle="bible"]');
  expect(await styleOf(source, "background-color")).not.toBe(
    await styleOf(bible, "background-color"),
  );
});

test("the correction forms are laid-out fields, not raw browser controls", async ({ page }) => {
  await page.goto(BIBLE_URL);
  const writes = page.locator(".wiki-bible__writes");
  await expect(writes).toBeVisible();
  expect(await styleOf(writes, "display")).toBe("grid");

  const textarea = page.locator("#wiki-bible-edit-statement");
  await expect(textarea).toBeVisible();
  // A default textarea is a white box with a beveled border; ours is a token
  // field on the night canvas.
  expect(await styleOf(textarea, "background-color")).not.toBe("rgb(255, 255, 255)");
  expect(await styleOf(textarea, "border-top-style")).toBe("solid");

  const label = page.getByText("Statement", { exact: true });
  const labelBox = (await label.boundingBox())!;
  const areaBox = (await textarea.boundingBox())!;
  // Label above its control, never running into it.
  expect(areaBox.y).toBeGreaterThan(labelBox.y + labelBox.height - 2);
  expect(areaBox.width).toBeGreaterThan(200);
});

// ---------------------------------------------------------------------------
// Fixture API — the wiki object surface, plus the shell's own reads.
// ---------------------------------------------------------------------------

const CANONICAL_CITATION = {
  claimId: "claim-canonical",
  evidenceId: "ev-unit-42",
  evidenceHash: HASH,
  snapshotId: SNAPSHOT_ID,
  subject: { kind: "unit", id: "unit-42" },
  role: "establishes",
  playOrderIndex: 3,
  quotedSpan: "the bell",
};

const BADGES = {
  provisional: false,
  contextScope: "route-slice",
  runMode: "pilot",
  editedBy: null,
};

function sourceObject(): Record<string, unknown> {
  return {
    kind: "source",
    objectId: "obj-scene-1",
    wikiKind: "source-object",
    category: "scene-summary",
    version: 1,
    lang: "ja",
    subject: { kind: "scene", id: "scene-2031" },
    routeScope: { kind: "global" },
    badges: BADGES,
    claims: [
      {
        claimId: "claim-canonical",
        statement: "The shrine bell tolls at dawn and the courtyard empties.",
        scope: { kind: "global" },
        kind: "beat",
        confidence: "high",
        supersedesClaimId: null,
        citations: [CANONICAL_CITATION],
      },
      {
        claimId: "claim-routed",
        statement: "The confession happens at the shrine, after the festival.",
        scope: { kind: "route", routeId: "route-akari" },
        kind: "arc",
        confidence: "medium",
        supersedesClaimId: null,
        citations: [],
      },
    ],
    citations: [CANONICAL_CITATION],
    media: [
      {
        kind: "screenshot",
        mediaId: "media-shot-1",
        sceneId: "scene-2031",
        availability: {
          status: "available",
          artifactUri: "artifacts/runtime/screenshots/shot-1.png",
          contentHash: HASH,
          mediaType: "image/png",
          dimensions: { width: 1280, height: 720 },
          access: { redaction: "default-redacted", permission: "project-member" },
        },
      },
    ],
  };
}

function wikiListBody(): Record<string, unknown> {
  return {
    schemaVersion: "itotori.wiki.objects.v1",
    generatedAt: "2026-07-16T00:00:00.000Z",
    snapshotId: SNAPSHOT_ID,
    sourceObjects: [sourceObject()],
    renderings: [
      {
        kind: "rendering",
        renderingId: "rendering-obj-scene-1-en",
        sourceObjectId: "obj-scene-1",
        category: "scene-summary",
        version: 1,
        targetLanguage: "en",
        routeScope: { kind: "global" },
        badges: BADGES,
        claimRenderings: [
          { claimId: "claim-canonical", text: "The temple bell rings at first light." },
        ],
      },
    ],
  };
}

function wikiShowBody(): Record<string, unknown> {
  return {
    schemaVersion: "itotori.wiki.object.v1",
    generatedAt: "2026-07-16T00:00:00.000Z",
    view: sourceObject(),
    history: [
      {
        version: 1,
        supersedesVersion: null,
        contentHash: HASH,
        editedBy: null,
        provisional: false,
        createdAt: "2026-07-15T00:00:00.000Z",
      },
    ],
    dependencyImpact: {
      dependents: [
        {
          downstreamObjectId: "rendering-obj-scene-1-en",
          downstreamWikiKind: "localized-rendering",
          downstreamVersion: 1,
          claimId: "claim-canonical",
          fieldPath: [],
          renderingId: "rendering-obj-scene-1-en",
          protectedHuman: false,
        },
      ],
    },
  };
}

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
  if (url.pathname === "/api/wiki") {
    await fulfillJson(route, "wiki.list", wikiListBody() as ItotoriApiResponseBody);
    return;
  }
  if (url.pathname.startsWith("/api/wiki/")) {
    await fulfillJson(route, "wiki.show", wikiShowBody() as ItotoriApiResponseBody);
    return;
  }
  await route.fulfill({
    status: 404,
    contentType: "application/json",
    body: JSON.stringify({ error: "not fixtured for wiki-bible e2e", code: "not_found" }),
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
