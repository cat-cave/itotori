import type { StorybookConfig } from "@storybook/react-vite";

/**
 * Storybook harness for @itotori/ds (fe-ds-storybook-harness).
 *
 * The design-review catalog + component behavior surface: one CSF story file
 * per public DS component, with play-function interaction tests where the
 * surface has observable interaction. Dev-only tooling — not the shipped ZDR
 * pipeline. Deterministic CI: telemetry off, no network fonts required (the
 * token stacks fall back to system fonts).
 */
const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  // Docs addon ships with Storybook 10 core; keep the surface minimal.
  addons: [],
  core: {
    disableTelemetry: true,
    disableWhatsNewNotifications: true,
  },
  // Static build output is gitignored; used as the offline design-review
  // catalog artifact and as a compile gate (`storybook:build`).
  // viteFinal intentionally leaves the default Vite config alone so the DS
  // package's gallery vite.config.ts is not pulled in as the Storybook root.
  async viteFinal(config) {
    // Ensure the package root resolves `@itotori/ds` source via relative
    // imports inside stories (stories import co-located components, not the
    // package name). No alias needed.
    return config;
  },
};

export default config;
