import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Behaviour-first component tests run in jsdom (already a workspace dep) with
// @testing-library/react. This is the harness the ~50 downstream UI nodes
// inherit: assert rendered DOM + real interactions, never component internals.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.tsx", "test/**/*.test.ts"],
  },
});
