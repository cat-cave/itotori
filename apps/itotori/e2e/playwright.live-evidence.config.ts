import { defineConfig } from "@playwright/test";

import publicConfig from "./playwright.config.js";

// The named runner passes the exact manifest-owned suite paths. Reuse the
// production browser/server contract, then collect only the private evidence
// directory after removing the public lane's exclusions.
export default defineConfig({
  ...publicConfig,
  testMatch: /live-evidence\/.*\.e2e\.ts$/u,
  testIgnore: [],
});
