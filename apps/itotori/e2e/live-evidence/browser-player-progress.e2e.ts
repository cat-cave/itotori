// Real-bytes proof that the in-browser player PROGRESSES.
//
// This asserts on VM ADDRESSES, never on "a frame rendered". A player wedged
// on one instruction still returns a picture for every input, which is exactly
// how a stuck player stayed unnoticed: every rendering assertion kept passing.
// The only claim worth making about a player is that the machine MOVED, and
// that the move was the one the reader asked for.
//
// Nothing here is stubbed: real dashboard server, real engine child process,
// real archive bytes, real Chromium. The dedicated evidence runner fails if
// the private inventory lacks the runtime descriptor, because those bytes are
// not redistributable and cannot live in the repo.

import { expect, test, type Page } from "@playwright/test";
import { realliveBrowserPlayerLaunchFromInventory } from "../../src/play/reallive-browser-player-launch.js";

const launch = realliveBrowserPlayerLaunchFromInventory();
const session = "e2e";

// One engine frame is multiple megabytes of base64 over the wire, and the
// engine rasterises a fresh one per input, so each step is seconds not
// milliseconds.
const STEP_TIMEOUT_MS = 120_000;

test.describe("browser player progress", () => {
  test.slow();

  test("successive inputs through the browser move the VM to distinct addresses", async ({
    page,
  }) => {
    await openPlayer(page);

    const seen: string[] = [await address(page)];
    for (let step = 0; step < 6; step++) {
      const before = seen[seen.length - 1]!;
      await sendInput(page);
      await waitForMove(page, before);
      seen.push(await address(page));
    }

    // Every input landed the VM somewhere it had not been. A relay that
    // replayed the opening state, or a UI that never delivered the input,
    // collapses this set.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(7);
  });

  test("the option a reader clicks is the branch the VM commits to", async ({ page, context }) => {
    // Two sessions from the same entry point, driven to the same gate, given
    // DIFFERENT option indices. If the browser dropped the index — or sent a
    // bare advance — both land on the same address and this fails. Asserting
    // "the frame changed after clicking" cannot tell those apart.
    const first = await addressAfterChoice(page, 0);
    const second = await addressAfterChoice(await context.newPage(), 1);

    expect(first.optionLabels.length).toBeGreaterThan(1);
    expect(second.optionLabels).toEqual(first.optionLabels);
    expect(second.address).not.toBe(first.address);
  });
});

async function addressAfterChoice(
  page: Page,
  index: number,
): Promise<{ address: string; optionLabels: string[] }> {
  await openPlayer(page);
  const gate = page.locator("[data-live-player-panel]");
  await expect(gate).toHaveAttribute("data-waiting-for", "choice", { timeout: STEP_TIMEOUT_MS });
  const optionLabels = await page.locator("[data-player-choice]").allInnerTexts();
  const before = await address(page);
  await page.locator(`[data-player-choice="${index}"]`).click();
  await waitForMove(page, before);
  return { address: await address(page), optionLabels };
}

async function openPlayer(page: Page): Promise<void> {
  if (!launch) {
    throw new Error(
      "browser-player progress real-byte proof requires the selected RealLive corpus in the private inventory",
    );
  }
  const query = new URLSearchParams({ session });
  await page.goto(`/play/player?${query.toString()}`);
  await expect(page.locator("[data-live-player-panel]")).toBeVisible({ timeout: STEP_TIMEOUT_MS });
  await settle(page);
}

/** The SETTLED VM position the surface is showing, once no input is in flight. */
async function address(page: Page): Promise<string> {
  await settle(page);
  const panel = page.locator("[data-live-player-panel]");
  const scene = await panel.getAttribute("data-scene");
  const pointer = await panel.getAttribute("data-instruction-pointer");
  return `${scene}:${pointer}`;
}

/**
 * Wait until the surface SETTLES on an address other than `before`. An
 * in-flight request reports `before`, so a request that is merely pending
 * never counts as movement — the wedged-player failure mode this file exists
 * to catch would otherwise pass on the loading state alone.
 */
async function waitForMove(page: Page, before: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const panel = page.locator("[data-live-player-panel]");
        if ((await panel.getAttribute("data-busy")) === "true") return before;
        const scene = await panel.getAttribute("data-scene");
        return `${scene}:${await panel.getAttribute("data-instruction-pointer")}`;
      },
      { timeout: STEP_TIMEOUT_MS },
    )
    .not.toBe(before);
}

/** Answer whatever gate the engine has parked on, through the real controls. */
async function sendInput(page: Page): Promise<void> {
  const panel = page.locator("[data-live-player-panel]");
  const waitingFor = await panel.getAttribute("data-waiting-for");
  if (waitingFor === "choice") await page.locator('[data-player-choice="0"]').click();
  else await page.locator("[data-player-advance]").click();
}

async function settle(page: Page): Promise<void> {
  await expect(page.locator("[data-live-player-panel]")).toHaveAttribute("data-busy", "false", {
    timeout: STEP_TIMEOUT_MS,
  });
}
