// Real-browser proof for the Softpal live-player relay.
//
// This deliberately starts the normal Itotori HTTP server with a trusted,
// server-held descriptor.  The browser receives only the opaque session id;
// it cannot choose a point-table entry, filesystem path, or redaction mode.
// The retail corpora are never committed, so this skips when the established
// Softpal research root is absent.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { expect, test, type Page } from "@playwright/test";
import { BrowserPlayerSessionManager } from "../src/play/browser-player-session.js";
import { createItotoriServer } from "../src/server.js";
import type { ItotoriReadOnlyServiceFactory } from "../src/services/database-services.js";

const softpalRoot = process.env.ITOTORI_SOFTPAL_RESEARCH_ROOT;
const corpora = [
  { id: "corpus-1", pointId: 6543, staticOracle: 30_165 },
  { id: "corpus-2", pointId: 10_581, staticOracle: 39_832 },
] as const;

const corpusReady =
  softpalRoot !== undefined &&
  corpora.every(({ id }) => existsSync(join(softpalRoot, `softpal-${id.at(-1)}`, "data.pac")));

test.describe("Softpal browser player", () => {
  test.skip(
    !corpusReady,
    "set the established ITOTORI_SOFTPAL_RESEARCH_ROOT to a staged two-title Softpal corpus",
  );
  test.slow();

  for (const corpus of corpora) {
    test(`steps two distinct decoded ${corpus.id} frames through the browser`, async ({ page }) => {
      const artifactRoot = await mkdtemp(join(tmpdir(), `itotori-${corpus.id}-browser-`));
      const session = `softpal-${corpus.id}`;
      const sessions = new BrowserPlayerSessionManager();
      const server = createItotoriServer({
        webRoot: new URL("../web-dist/", import.meta.url),
        browserPlayerSessions: sessions,
        browserPlayerLaunches: {
          [session]: {
            engine: "softpal",
            gameRoot: join(softpalRoot!, `softpal-${corpus.id.at(-1)}`),
            artifactRoot,
            pointId: corpus.pointId,
          },
        },
        // This fixture models a permitted private viewer. The engine itself
        // still insists on --reveal and writes the readable frames only under
        // its sibling private artifact root.
        readOnlyServiceFactory: allowReveal,
      });
      try {
        const origin = await listen(server);
        await page.goto(`${origin}/play/player?session=${encodeURIComponent(session)}`);
        const panel = page.locator("[data-live-player-panel]");
        await expect(panel).toHaveAttribute("data-scene", String(corpus.pointId));
        await expect(panel).toHaveAttribute("data-oracle-overlap", `2/2/${corpus.staticOracle}`);
        await expect(panel).toHaveAttribute("data-waiting-for", "advance");

        await expect(page.locator("img[alt='Current real engine frame']")).toHaveAttribute(
          "data-frame-artifact-id",
          /^private:/u,
        );
        const first = await currentFrameHash(page);
        const firstAddress = await panel.getAttribute("data-instruction-pointer");
        await page.locator("[data-player-advance]").click();
        await expect(panel).toHaveAttribute("data-waiting-for", "ended");
        await expect
          .poll(async () => await panel.getAttribute("data-instruction-pointer"))
          .not.toBe(firstAddress);
        const second = await currentFrameHash(page);

        // A changed instruction pointer alone is not a rendering proof. These
        // are the exact PNG bytes the browser loaded from the session route.
        expect(second).not.toBe(first);
        await expect(page.locator("img[alt='Current real engine frame']")).toHaveJSProperty(
          "naturalWidth",
          800,
        );
      } finally {
        // The page can retain an idle keep-alive connection. Stop the VM
        // first, rather than relying on the server's close event (which only
        // fires after that connection drains), so this proof never leaves a
        // real child process behind.
        await sessions.closeAll();
        await close(server);
        await rm(artifactRoot, { recursive: true, force: true });
      }
    });
  }
});

async function currentFrameHash(page: Page): Promise<string> {
  const image = page.locator("img[alt='Current real engine frame']");
  await expect(image).toHaveJSProperty("complete", true);
  const source = await image.getAttribute("src");
  expect(source).not.toBeNull();
  const response = await page.request.get(new URL(source!, page.url()).toString());
  expect(response.ok()).toBe(true);
  return createHash("sha256")
    .update(await response.body())
    .digest("hex");
}

function listen(server: ReturnType<typeof createItotoriServer>): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: ReturnType<typeof createItotoriServer>): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

const allowReveal = (async (callback) =>
  await callback({
    authorization: { requirePermission: async () => undefined },
  } as never)) as ItotoriReadOnlyServiceFactory;
