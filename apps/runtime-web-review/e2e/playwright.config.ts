import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// Playwright config for the runtime-web review real-browser e2e lane
// (fe-runtime-web-playwright). This is a BROWSER lane, deliberately kept OUT of
// the fast per-gate `vp run ts:test` (jsdom) lane — it is invoked only via the
// package `e2e` script.
//
// BROWSER BINARY: Playwright's own downloaded Chromium is dynamically linked
// against libraries absent on NixOS, so it cannot run here. Instead the nix
// devShell (flake.nix) provides a real, runnable Chromium and exports its path
// as `PLAYWRIGHT_CHROMIUM_BIN` (and `UTSUSHI_BROWSER_BIN`, shared with the Rust
// MV/MZ browser gates). The config launches THAT binary via `executablePath`.
const appRoot = fileURLToPath(new URL("..", import.meta.url));
const e2eDir = fileURLToPath(new URL(".", import.meta.url));

const chromiumBin =
  process.env.PLAYWRIGHT_CHROMIUM_BIN ?? process.env.UTSUSHI_BROWSER_BIN ?? undefined;

if (chromiumBin === undefined) {
  throw new Error(
    "runtime-web e2e: no Chromium binary provided. Enter the nix devShell " +
      "(direnv/`nix develop`) so PLAYWRIGHT_CHROMIUM_BIN / UTSUSHI_BROWSER_BIN " +
      "point at the nix-provided Chromium, or set PLAYWRIGHT_CHROMIUM_BIN.",
  );
}

const PORT = 4319;

export default defineConfig({
  testDir: e2eDir,
  // `.e2e.ts` (not `.spec.ts`) so the fast jsdom vitest lane's default
  // `**/*.spec.ts` glob never picks up this browser lane.
  testMatch: /.*\.e2e\.ts$/,
  // Deterministic: single worker, no retries, no parallelism.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [["list"]],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Deterministic rendering: fixed viewport + reduced motion.
    viewport: { width: 1280, height: 800 },
    ...devices["Desktop Chrome"],
    // Re-apply the fixed viewport AFTER spreading the device preset so the
    // preset's own viewport cannot override determinism.
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
    command: "pnpm exec vite --config e2e/vite.e2e.config.ts",
    cwd: appRoot,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
