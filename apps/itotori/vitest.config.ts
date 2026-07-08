import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The app test harness. The React plugin transforms the `.tsx` SPA + its
// behavior-first tests (jsdom + @testing-library/react); the per-file
// `// @vitest-environment jsdom` pragma keeps the pre-existing node tests on
// the default node environment, so this config ONLY adds the JSX transform.
export default defineConfig({
  plugins: [react()],
});
