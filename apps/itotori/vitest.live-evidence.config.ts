import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

// Named private-evidence runs collect only the suites owned by
// scripts/live-evidence-suite-manifest.mjs. The public config excludes this
// directory, so an unavailable private input cannot turn into a green skip.
const integrationTimeoutMs = 90_000;

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["test/live-evidence/**/*.test.ts"],
    exclude: [...configDefaults.exclude],
    fileParallelism: false,
    hookTimeout: integrationTimeoutMs,
    testTimeout: integrationTimeoutMs,
  },
});
