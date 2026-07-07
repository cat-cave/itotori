import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Vite dev server for the runtime-web review Playwright e2e harness. It serves
// the harness page (which mounts the SHIPPING app modules) and, via
// `server.fs.allow`, lets the harness import the sibling `src/` modules and the
// committed JSON fixture goldens under `crates/`. Deterministic + offline: no
// HMR websocket churn, a fixed port, and no game bytes.
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const harnessRoot = fileURLToPath(new URL("./harness/", import.meta.url));

export default defineConfig({
  root: harnessRoot,
  server: {
    port: 4319,
    strictPort: true,
    fs: {
      // Allow the harness to import from the app `src/` and the repo's
      // committed fixture goldens (both live above the harness root).
      allow: [repoRoot],
    },
  },
  preview: {
    port: 4319,
    strictPort: true,
  },
});
