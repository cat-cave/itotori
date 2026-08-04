import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

import { DB_OWNED_APP_TEST_FILES } from "../../scripts/ci/db-owned-app-proofs.mjs";
import { appLiveEvidenceVitestFiles } from "../../scripts/live-evidence-suite-manifest.mjs";

// App tests include several real-Postgres flows through
// `isolatedMigratedContext`. Each creates and migrates a schema, and migration
// setup is intentionally serialized by the DB advisory lock. Vitest's default
// five-second timeout is therefore flaky when the full app suite starts those
// flows together. Match the DB package's live-integration budget, but retain
// the quick default for DB-free runs.
const dbIntegrationTimeoutMs = 90_000;
const liveDatabaseTestTimeouts = process.env.DATABASE_URL
  ? {
      hookTimeout: dbIntegrationTimeoutMs,
      testTimeout: dbIntegrationTimeoutMs,
    }
  : {};

// The app test harness. The React plugin transforms the `.tsx` SPA + its
// behavior-first tests (jsdom + @testing-library/react); the per-file
// `// @vitest-environment jsdom` pragma keeps the pre-existing node tests on
// the default node environment, so this config ONLY adds the JSX transform.
export default defineConfig({
  plugins: [react()],
  test: {
    ...liveDatabaseTestTimeouts,
    exclude: [...configDefaults.exclude, ...DB_OWNED_APP_TEST_FILES, ...appLiveEvidenceVitestFiles],
  },
});
