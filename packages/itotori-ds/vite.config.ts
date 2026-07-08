import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The component gallery: a real browser bundle of every component rendered
// against fixture data. `pnpm --filter @itotori/ds gallery:build` proves the
// gallery + tokens compile for the browser; `gallery:dev` serves it live.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: "web-dist",
    emptyOutDir: true,
  },
});
