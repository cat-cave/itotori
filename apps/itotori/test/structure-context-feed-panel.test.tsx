// @vitest-environment jsdom
// wiki-structure-context-feed (HI-FI STUDIO EPIC · Wiki) — behavior-first
// test for the structure-informed context feed on the reviewer detail screen.
//
// Acceptance: the reviewer sees WHY a draft chose its wording (the cited
// structure context that fed it).
//
// Mounts the REAL `ReviewerDetailScreen` over msw-intercepted
// `reviewer.detail` (+ sibling workspace.comparison) and asserts the
// OBSERVABLE structure-context panel:
//   1. the panel title / why-heading is visible;
//   2. the scene summary / character arcs / route texts that FED the draft
//      are rendered (not just opaque ref ids);
//   3. the `fed the draft` badge and cited artifact refs surface;
//   4. missing feed → visible "missing context" cell (never a blank panel).
//
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  draftFixture,
  readyContextFixture,
  structureContextFeedFixture,
} from "../src/reviewer/index.js";
import type { ReviewerDetailContext } from "../src/reviewer/index.js";
import { workspaceComparisonFixture } from "../src/workspace/index.js";
import { ReviewerDetailScreen } from "../src/ui/screens/ReviewerDetailScreen.js";
import { ToastProvider } from "../src/ui/toast-host.js";
import { apiJson } from "./msw-handlers.js";

const REVIEW_ITEM_ID = "reviewer-queue-itotori-082";
const DETAIL_PATH = "*/api/reviewer/queue/:reviewItemId/detail";
const COMPARISON_PATH = "*/api/workspace/comparison";

const SCENE_SUMMARY_BODY =
  "Scene 6010: 3 messages; speakers 勇者, 王女; opens with 勇者; no choices; dispatches to scene 6020.";
const CHARACTER_ARCS_BODY =
  "Speaker arcs in this scene:\n- 勇者: appears in scenes 6010, 6020 (4 lines total).\n- 王女: appears in scenes 6010 (2 lines total).";

function feedContext(overrides: Partial<ReviewerDetailContext> = {}): ReviewerDetailContext {
  return readyContextFixture({
    draft: draftFixture({
      draftText: "I'll protect this village.",
      draftStatus: "pending_review",
      attemptCount: 1,
    }),
    structureContextFeed: structureContextFeedFixture({
      sceneId: 6010,
      fedTheDraft: true,
      whyHeading: "Structure-informed context that fed this draft's wording",
      items: [
        {
          kind: "scene_summary",
          artifactRef: "scene-summary:6010",
          title: "Scene summary",
          body: SCENE_SUMMARY_BODY,
          feedRole: "Fed the draft's scene-aware wording (structure-informed injection).",
        },
        {
          kind: "route_map",
          artifactRef: "route-branch-map",
          title: "Route / branch position",
          body: "Scene 6010 route position: position 1 of 2 in the dispatch order [6010 -> 6020].",
          feedRole: "Fed the draft's branch-aware wording (structure-informed injection).",
        },
        {
          kind: "character_arc",
          artifactRef: "character-arc:勇者",
          title: "Character arcs",
          body: CHARACTER_ARCS_BODY,
          feedRole: "Fed the draft's speaker voice consistency (structure-informed injection).",
        },
      ],
      contextArtifactRefs: ["character-arc:勇者", "route-branch-map", "scene-summary:6010"],
    }),
    diagnostics: [],
    ...overrides,
  });
}

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

function handleComparison(): void {
  server.use(
    http.get(COMPARISON_PATH, () =>
      apiJson("workspace.comparison", workspaceComparisonFixture({ reviewItemId: REVIEW_ITEM_ID })),
    ),
  );
}

function handleDetail(context: ReviewerDetailContext = feedContext()): void {
  server.use(http.get(DETAIL_PATH, () => apiJson("reviewer.detail", context)));
  handleComparison();
}

function renderWithToasts(ui: ReactNode): void {
  render(<ToastProvider>{ui}</ToastProvider>);
}

describe("ReviewerDetailScreen — structure context that fed the draft", () => {
  it("shows WHY the draft chose its wording (scene summary + character arcs that fed it)", async () => {
    handleDetail();
    renderWithToasts(<ReviewerDetailScreen reviewItemId={REVIEW_ITEM_ID} />);

    expect(
      await screen.findByRole("heading", { name: "Structure context that fed this draft" }),
    ).toBeInTheDocument();

    const panel = document.querySelector('[data-panel-id="structure-context-feed"]');
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute("data-fed-the-draft", "true");
    expect(panel).toHaveAttribute("data-scene-id", "6010");

    const scoped = within(panel as HTMLElement);
    expect(scoped.getByText(/Structure-informed context that fed this draft/i)).toBeInTheDocument();
    expect(scoped.getByText(SCENE_SUMMARY_BODY)).toBeInTheDocument();
    expect(scoped.getByText(/Speaker arcs in this scene/)).toBeInTheDocument();
    expect(scoped.getByText(/勇者: appears in scenes 6010/)).toBeInTheDocument();
    expect(scoped.getByText(/Scene 6010 route position/)).toBeInTheDocument();
    expect(scoped.getByText("fed the draft")).toBeInTheDocument();
    // Artifact refs appear both on the item row and in the cited-refs footer.
    expect(scoped.getAllByText("scene-summary:6010").length).toBeGreaterThanOrEqual(1);
    expect(scoped.getAllByText("character-arc:勇者").length).toBeGreaterThanOrEqual(1);
  });

  it("surfaces a visible missing-context cell when no feed is bound (never a blank panel)", async () => {
    handleDetail(
      feedContext({
        structureContextFeed: null,
      }),
    );
    renderWithToasts(<ReviewerDetailScreen reviewItemId={REVIEW_ITEM_ID} />);

    expect(
      await screen.findByRole("heading", { name: "Structure context that fed this draft" }),
    ).toBeInTheDocument();
    const panel = document.querySelector('[data-panel-id="structure-context-feed"]');
    expect(panel).not.toBeNull();
    expect(
      within(panel as HTMLElement).getByText(
        /No structure-informed context feed bound to this draft/i,
      ),
    ).toBeInTheDocument();
  });
});
