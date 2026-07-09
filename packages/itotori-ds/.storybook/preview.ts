import type { Preview } from "@storybook/react-vite";

// The single shipped CSS entry — same import hosts use at the SPA shell.
import "../tokens/styles.css";
import "./storybook.css";

/**
 * Global preview for the DS design-review catalog.
 *
 * Determinism notes (pair with fe-ds-visual-regression later):
 * - Token CSS only; no network font fetch required (system fallbacks).
 * - Page background matches `--ito-color-page` so stories read on-night.
 * - Layout padding is fixed; no animation-forcing chrome.
 */
const preview: Preview = {
  parameters: {
    layout: "padded",
    backgrounds: {
      default: "page",
      values: [
        { name: "page", value: "var(--ito-color-page, #0b0d12)" },
        { name: "night", value: "var(--ito-color-night, #12151c)" },
      ],
    },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    // Interaction tests run via play functions; the panel surfaces them in
    // the Storybook UI. Automated CI runs the same play bodies through
    // composeStories in Vitest/jsdom (see test/stories.test.tsx).
    options: {
      storySort: {
        order: ["core", "layout", "data", "localization", "navigation", "feedback"],
      },
    },
  },
};

export default preview;
