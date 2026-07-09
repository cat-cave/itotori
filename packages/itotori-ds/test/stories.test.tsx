/**
 * Storybook harness CI gate (fe-ds-storybook-harness).
 *
 * 1. Catalog completeness — every public component export has a CSF story.
 * 2. Play-function interaction tests — run each story's `play` body via
 *    `composeStories` in jsdom (deterministic, offline, no Storybook UI).
 *
 * This is the component behavior surface the design-review catalog pairs with
 * Vitest pure-model tests and Playwright e2e. The Storybook UI itself is the
 * interactive design-review catalog (`pnpm --filter @itotori/ds storybook`).
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReactElement } from "react";
import { composeStories, setProjectAnnotations } from "@storybook/react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import previewAnnotations from "../.storybook/preview.js";
import * as annotationComposerStories from "../src/stories/AnnotationComposer.stories.js";
import * as badgeStories from "../src/stories/Badge.stories.js";
import * as biTextStories from "../src/stories/BiText.stories.js";
import * as commandPaletteStories from "../src/stories/CommandPalette.stories.js";
import * as comparisonPaneStories from "../src/stories/ComparisonPane.stories.js";
import * as contestantSwatchStories from "../src/stories/ContestantSwatch.stories.js";
import * as dataTableStories from "../src/stories/DataTable.stories.js";
import * as localizationProgressStories from "../src/stories/LocalizationProgress.stories.js";
import * as navPillsStories from "../src/stories/NavPills.stories.js";
import * as paginationStories from "../src/stories/Pagination.stories.js";
import * as panelStories from "../src/stories/Panel.stories.js";
import * as progressBarStories from "../src/stories/ProgressBar.stories.js";
import * as redactionFrameStories from "../src/stories/RedactionFrame.stories.js";
import * as statReadoutStories from "../src/stories/StatReadout.stories.js";
import * as toastStories from "../src/stories/Toast.stories.js";

// Apply preview decorators/parameters so composeStories matches the UI.
setProjectAnnotations([previewAnnotations]);

afterEach(() => {
  cleanup();
});

/** Public component symbols that must have a design-review story. */
const PUBLIC_COMPONENTS = [
  "AnnotationComposer",
  "Badge",
  "Panel",
  "DataTable",
  "ProgressBar",
  "ComparisonPane",
  "LocalizationProgress",
  "StatReadout",
  "ContestantSwatch",
  "RedactionFrame",
  "BiText",
  "NavPills",
  "CommandPalette",
  "Pagination",
  "Toast",
] as const;

const storyModules = {
  AnnotationComposer: annotationComposerStories,
  Badge: badgeStories,
  Panel: panelStories,
  DataTable: dataTableStories,
  ProgressBar: progressBarStories,
  ComparisonPane: comparisonPaneStories,
  LocalizationProgress: localizationProgressStories,
  StatReadout: statReadoutStories,
  ContestantSwatch: contestantSwatchStories,
  RedactionFrame: redactionFrameStories,
  BiText: biTextStories,
  NavPills: navPillsStories,
  CommandPalette: commandPaletteStories,
  Pagination: paginationStories,
  Toast: toastStories,
} as const;

describe("Storybook catalog completeness", () => {
  it("ships a CSF story file per public DS component", () => {
    const storiesDir = join(dirname(fileURLToPath(import.meta.url)), "../src/stories");
    const storyFiles = readdirSync(storiesDir).filter((name) => name.endsWith(".stories.tsx"));
    for (const component of PUBLIC_COMPONENTS) {
      expect(storyFiles, `missing story file for public component ${component}`).toContain(
        `${component}.stories.tsx`,
      );
    }
  });

  it("registers every public component in the story module map (play runners)", () => {
    for (const component of PUBLIC_COMPONENTS) {
      expect(storyModules).toHaveProperty(component);
    }
  });
});

type ComposedStory = {
  (props?: Record<string, unknown>): ReactElement | null;
  play?: (context: {
    canvasElement: HTMLElement;
    args: Record<string, unknown>;
    step: (label: string, body: () => Promise<void> | void) => Promise<void>;
    context: Record<string, unknown>;
    id: string;
    canvas: HTMLElement;
  }) => Promise<void> | void;
  args?: Record<string, unknown>;
};

describe("Storybook play-function interaction tests", () => {
  for (const [component, module] of Object.entries(storyModules)) {
    const composed = composeStories(module as Parameters<typeof composeStories>[0]) as Record<
      string,
      ComposedStory
    >;
    for (const [storyName, Story] of Object.entries(composed)) {
      if (typeof Story !== "function") continue;
      const play = Story.play;
      if (!play) continue;

      it(`${component} / ${storyName} play function passes`, async () => {
        const { container, unmount } = render(<Story />);
        try {
          await play({
            canvasElement: container,
            // composeStories merges args (including storybook/test `fn()` mocks).
            args: Story.args ?? {},
            step: async (_label, body) => {
              await body();
            },
            context: {},
            id: `${component}--${storyName}`,
            canvas: container,
          });
        } finally {
          unmount();
        }
      });
    }
  }
});
