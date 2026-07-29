import { defineConfig } from "vitest/config";

// DB integration tests build a 55-migration schema (some run multiple isolated
// schemas per test) and are legitimately slow on a loaded/disposable CI Postgres.
// 30s is too tight and flakes CI under machine load; 90s gives a generous budget.
const dbIntegrationTimeoutMs = 90_000;

export default defineConfig({
  test: {
    // The DB runner owns `test/`; make that ownership explicit instead of
    // relying on Vitest's evolving default file glob.
    include: ["test/**/*.test.ts"],
    // Every suite migrates an isolated schema under one advisory lock. Running
    // those files in parallel turns a valid queue into 90-second hook timeouts.
    fileParallelism: false,
    hookTimeout: dbIntegrationTimeoutMs,
    testTimeout: dbIntegrationTimeoutMs,
  },
});
