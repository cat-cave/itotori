import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// Playwright smoke for the current Itotori shell served by src/server.ts.
// The server renders the real built HTML for dashboard/play/patch-iteration
// deep links; the browser test fulfills only the closed fixture API surface it
// needs so this dev-only lane stays deterministic and DB-free.
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

const chromiumBin =
  process.env.PLAYWRIGHT_CHROMIUM_BIN ?? process.env.UTSUSHI_BROWSER_BIN ?? undefined;

if (chromiumBin === undefined) {
  throw new Error(
    "itotori shell e2e: no Chromium binary provided. Enter the nix devShell " +
      "(direnv/`nix develop`) so PLAYWRIGHT_CHROMIUM_BIN / UTSUSHI_BROWSER_BIN " +
      "point at the nix-provided Chromium, or set PLAYWRIGHT_CHROMIUM_BIN.",
  );
}

const PORT = 4322;

export default defineConfig({
  testDir: fileURLToPath(new URL(".", import.meta.url)),
  testMatch: /.*\.e2e\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [["list"]],
  // Full current-surface smoke can rebuild all workspace packages before the
  // browser starts; give that deterministic heavy lane the requested ceiling.
  timeout: 180_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1280, height: 800 },
    ...devices["Desktop Chrome"],
    launchOptions: { executablePath: chromiumBin },
    contextOptions: { reducedMotion: "reduce" },
  },
  projects: [
    {
      name: "chromium",
      use: { viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    command: `pnpm --filter @itotori/localization-bridge-schema build && pnpm --filter @itotori/db build && pnpm --filter @itotori/ds build && pnpm --filter @itotori/app build && PORT=${PORT} node apps/itotori/dist/server.js`,
    cwd: repoRoot,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    // The server command builds every workspace package before launch, so it
    // needs the same heavy-e2e ceiling as the test itself.
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
