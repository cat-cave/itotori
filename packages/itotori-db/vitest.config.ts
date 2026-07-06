import { defineConfig } from "vitest/config";

// DB integration tests build a 55-migration schema (some run multiple isolated
// schemas per test) and are legitimately slow on a loaded/disposable CI Postgres.
// 30s is too tight and flakes CI under machine load; 90s gives a generous budget.
const dbIntegrationTimeoutMs = 90_000;

export default defineConfig({
  test: {
    // Full DB runs start many isolated schemas in parallel; migrations are serialized by advisory lock.
    hookTimeout: dbIntegrationTimeoutMs,
    testTimeout: dbIntegrationTimeoutMs,
  },
});
