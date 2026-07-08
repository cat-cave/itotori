import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// fnd-spa-shell — the single React SPA served by `src/server.ts`. Vite
// bundles `index.html` → `src/main.tsx` (the app shell) into `web-dist`,
// which the server serves as static assets + the dashboard-route index. The
// React plugin provides the automatic JSX runtime the `@itotori/ds`
// components + the shell screens compile against.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: "web-dist",
    emptyOutDir: true,
  },
});
