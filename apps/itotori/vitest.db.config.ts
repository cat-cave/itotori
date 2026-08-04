import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// This config is intentionally separate from the portable configuration:
// ci-tier1-db passes the exact DB-owned suite manifest, while portable shards
// exclude those same files before Vitest discovers them.
const dbIntegrationTimeoutMs = 90_000;

export default defineConfig({
  plugins: [react()],
  test: {
    // Each proof creates and migrates an isolated schema under the shared
    // advisory lock; parallel files turn valid queueing into timeout flakes.
    fileParallelism: false,
    hookTimeout: dbIntegrationTimeoutMs,
    testTimeout: dbIntegrationTimeoutMs,
  },
});
