import { defineConfig } from "vitest/config";

const dbIntegrationTimeoutMs = 30_000;

export default defineConfig({
  test: {
    // Full DB runs start many isolated schemas in parallel; migrations are serialized by advisory lock.
    hookTimeout: dbIntegrationTimeoutMs,
    testTimeout: dbIntegrationTimeoutMs,
  },
});
