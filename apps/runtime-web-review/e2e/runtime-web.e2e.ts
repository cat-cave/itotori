import { expect, test } from "@playwright/test";

// Real-browser (Chromium) e2e for the Utsushi runtime-web review UI
// (fe-runtime-web-playwright). Behavior-first + code-agnostic: every assertion
// is against observable rendered DOM / user interaction in a real browser, over
// the app's OWN fixtures + built-in seed data (no game bytes, no live game, no
// live server). Complements — does not duplicate — the jsdom unit tests: those
// assert render internals per module; this asserts the end-to-end rendered
// surfaces behave in a real engine.

test.beforeEach(async ({ page }) => {
  // Enforce "no external network": the harness is fully in-browser, so any
  // request off localhost is a bug. Localhost (the Vite dev server) passes.
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      return route.continue();
    }
    return route.abort();
  });
  await page.goto("/");
  await expect(page.locator("body")).toHaveAttribute("data-harness-ready", "true");
});

test("embed renders the scene from the committed EmbedState fixture", async ({ page }) => {
  const embed = page.locator('[data-testid="embed-region"]');
  await expect(embed.locator('[data-route="embed-state"]')).toBeVisible();

  // It is explicitly a deterministic fixture surface, not live runtime state.
  await expect(embed.locator("[data-embed-fixture-notice]")).toContainText(
    "NOT live runtime state",
  );

  // The scene: five trace lines render in declared order with their text.
  const lines = embed.locator('[data-section="trace"] > li');
  await expect(lines).toHaveCount(5);
  await expect(lines.first()).toContainText("fixture trace line 1");
  await expect(lines.nth(4)).toContainText("fixture trace line 5");

  // Capabilities render, incl. a disabled action for the unsupported one.
  await expect(embed.locator("[data-capability-id]")).toHaveCount(5);
  await expect(embed.locator('[data-capability-id="deterministic_fixture"]')).toContainText(
    "unsupported",
  );

  // The current snapshot is surfaced.
  await expect(embed.locator('[data-section="snapshot"]')).toContainText(
    "run-fixture-001-tick-0042",
  );
});

test("demo bundle renders observed dialogue + choice, data-only (no live game)", async ({
  page,
}) => {
  const demo = page.locator('[data-testid="demo-region"]');
  const main = demo.locator('[data-route="demo-bundle"]');
  await expect(main).toBeVisible();

  // Public fixture, NOT a live game.
  await expect(main).toHaveAttribute("data-live", "false");
  await expect(demo.locator('[data-live-badge="false"]')).toBeVisible();
  await expect(demo.locator("[data-demo-fixture-notice]")).toContainText("NOT a live game");

  // Observed dialogue lines render their translated text.
  const textEvents = demo.locator('[data-event-kind="text"]');
  await expect(textEvents).toHaveCount(2);
  await expect(demo).toContainText("The lighthouse keeps watch over the quiet cove.");

  // The observed choice renders its prompt + both options.
  const choice = demo.locator('[data-event-kind="choice"]');
  await expect(choice).toContainText("What will you do?");
  const options = choice.locator('[data-section="choice-options"] > li');
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toContainText("Raise the lantern high.");
  await expect(options.nth(1)).toContainText("Wait in the darkness.");

  // Never paints pixels: no <img>/<video> of a game asset anywhere.
  await expect(page.locator("img, video, audio")).toHaveCount(0);
});

test("branch explorer renders coverage and navigates via filter + pagination", async ({ page }) => {
  const branch = page.locator('[data-testid="branch-region"]');
  await expect(branch.locator('[data-route="branch-explorer"]')).toBeVisible();

  // The seed read model has four branches, one per coverage status.
  await expect(branch.locator('[data-summary="branch-count"]')).toHaveText("4");
  const rows = branch.locator("tbody tr[data-branch-id]");
  await expect(rows).toHaveCount(4);

  // Filter to visited -> one row, and the control reflects the active filter.
  await branch.locator('[data-control="status-filter"]').selectOption("visited");
  await expect(branch.locator("tbody tr[data-branch-id]")).toHaveCount(1);
  await expect(branch.locator("tbody tr[data-branch-id]")).toHaveAttribute(
    "data-coverage-status",
    "visited",
  );
  await expect(branch.locator('[data-role="active-filter"]')).toContainText("Visited");

  // Back to all statuses.
  await branch.locator('[data-control="status-filter"]').selectOption("");
  await expect(branch.locator("tbody tr[data-branch-id]")).toHaveCount(4);
});

test("branch explorer paginates forward and back over the seed model", async ({ page }) => {
  const branch = page.locator('[data-testid="branch-region"]');

  // Re-render at page size 2 so the 4-branch seed model spans two pages.
  await page.goto("/?branchPageSize=2");
  await expect(page.locator("body")).toHaveAttribute("data-harness-ready", "true");

  await expect(branch.locator('[data-role="page-indicator"]')).toHaveText("Page 1 of 2");
  await expect(branch.locator("tbody tr[data-branch-id]")).toHaveCount(2);
  await expect(branch.locator('[data-control="prev-page"]')).toBeDisabled();

  const firstPageIds = await branch
    .locator("tbody tr[data-branch-id]")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-branch-id")));

  // Forward: page 2 holds the remaining, different branches.
  await branch.locator('[data-control="next-page"]').click();
  await expect(branch.locator('[data-role="page-indicator"]')).toHaveText("Page 2 of 2");
  await expect(branch.locator('[data-control="next-page"]')).toBeDisabled();
  const secondPageIds = await branch
    .locator("tbody tr[data-branch-id]")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-branch-id")));
  expect(secondPageIds.some((id) => firstPageIds.includes(id))).toBe(false);

  // Back: returns to page 1 with the original branches.
  await branch.locator('[data-control="prev-page"]').click();
  await expect(branch.locator('[data-role="page-indicator"]')).toHaveText("Page 1 of 2");
  const backIds = await branch
    .locator("tbody tr[data-branch-id]")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-branch-id")));
  expect(backIds).toEqual(firstPageIds);
});

test("input bridge turns real gestures into engine-neutral advance/choice events", async ({
  page,
}) => {
  const input = page.locator('[data-testid="input-region"]');
  await expect(input.locator('[data-route="input-scene"]')).toBeVisible();

  const events = input.locator('[data-testid="input-events"] > li');
  await expect(events).toHaveCount(0);

  // A click on the scene background (not an option) is an ADVANCE gesture.
  await input.locator('[data-testid="scene-text"]').click();
  await expect(input.locator('[data-testid="advance-count"]')).toHaveText("1");
  await expect(events.last()).toHaveAttribute("data-event-kind", "advance");

  // Clicking a choice option commits a CHOICE at that option's index.
  await input.locator('[data-testid="choice-1"]').click();
  await expect(input.locator('[data-testid="last-choice-index"]')).toHaveText("1");
  const lastChoice = input.locator('[data-testid="input-events"] > li[data-choice-index]').last();
  await expect(lastChoice).toHaveAttribute("data-choice-index", "1");

  await input.locator('[data-testid="choice-0"]').click();
  await expect(input.locator('[data-testid="last-choice-index"]')).toHaveText("0");

  // The committed gesture stream reached the runtime input surface in order:
  // advance, then choice 1, then choice 0.
  await expect(events).toHaveCount(3);
  await expect(events.nth(0)).toHaveAttribute("data-event-kind", "advance");
  await expect(events.nth(1)).toHaveAttribute("data-choice-index", "1");
  await expect(events.nth(2)).toHaveAttribute("data-choice-index", "0");
});
