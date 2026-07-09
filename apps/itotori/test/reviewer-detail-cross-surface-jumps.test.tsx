// @vitest-environment jsdom
// xs-deep-jumps — behavior-first test for the reviewer detail screen's
// CROSS-SURFACE addressable jumps (finding -> line).
//
// Mounts the REAL `ReviewerDetailScreen` over an msw-intercepted
// `/api/reviewer/queue/:id/detail` (+ the sibling comparison / runtime reads
// the screen mounts) and asserts the OBSERVABLE behavior:
//
//   - the SOURCE UNIT panel renders the unit's bridgeUnitId as a deep-link to
//     /play/units/:bridgeUnitId (the player LINE) — the finding -> line leg,
//     scoped to the item's project / locale branch;
//   - every QA FINDING id is itself addressable: a deep-link to
//     /findings/:findingId so a finding opened on the review surface can be
//     followed onward via the routing scheme.
//
// The links carry the bridgeUnitId / findingId verbatim from the read-model
// — no invented destinations, no game named.
// [[feedback_behavior_first_code_agnostic_testing]].

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  qaFindingFixture,
  readyContextFixture,
  sourceUnitFixture,
  type ReviewerDetailContext,
} from "../src/reviewer/index.js";
import { workspaceComparisonFixture } from "../src/workspace/index.js";
import type { ReviewerQueueItemRecord } from "@itotori/db";
import { reviewerQueueItemKindValues, reviewerQueueItemStateValues } from "@itotori/db";
import { ReviewerDetailScreen } from "../src/ui/screens/ReviewerDetailScreen.js";
import { ToastProvider } from "../src/ui/toast-host.js";
import { apiJson } from "./msw-handlers.js";
import { runtimeStatusFixture } from "./api-fixtures.js";

const REVIEW_ITEM_ID = "reviewer-queue-xs-deep-jumps";
const DETAIL_PATH = "*/api/reviewer/queue/:reviewItemId/detail";
const COMPARISON_PATH = "*/api/workspace/comparison";
const STATUS_PATH = "*/api/runtime/v0.2/status";

const PROJECT_ID = "project-xs-deep-jumps";
const LOCALE_BRANCH_ID = "locale-branch-xs-deep-jumps";
const SOURCE_REVISION_ID = "source-revision-xs-deep-jumps";

function makeItem(): ReviewerQueueItemRecord {
  return {
    reviewItemId: REVIEW_ITEM_ID,
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
    sourceRevisionId: SOURCE_REVISION_ID,
    itemKind: reviewerQueueItemKindValues.qa,
    sourceItemRef: "source-ref-xs-deep-jumps",
    state: reviewerQueueItemStateValues.pending,
    priority: 20,
    summary: "QA finding for the cross-surface jump spec",
    affectedArtifactIds: [],
    evidenceTier: null,
    observationEventIds: null,
    artifactHashes: null,
    payload: {},
    metadata: {},
    createdByUserId: null,
    assignedToUserId: null,
    createdAt: new Date("2026-07-09T00:00:00Z"),
    updatedAt: new Date("2026-07-09T00:00:00Z"),
    resolvedAt: null,
  };
}

function jumpContext(overrides: Partial<ReviewerDetailContext> = {}): ReviewerDetailContext {
  return readyContextFixture({
    item: makeItem(),
    reviewItemId: REVIEW_ITEM_ID,
    source: sourceUnitFixture({
      bridgeUnitId: "bridge-unit-xs-deep-jumps",
      sourceUnitKey: "scene.042.line.007",
    }),
    qaFindings: [
      qaFindingFixture({ findingId: "qa-finding-xs-deep-jumps-1" }),
      qaFindingFixture({
        findingId: "qa-finding-xs-deep-jumps-2",
        category: "style_adherence",
        severity: "minor",
        summary: "Honorific register slipped.",
      }),
    ],
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

function handleAll(context: ReviewerDetailContext = jumpContext()): void {
  server.use(http.get(DETAIL_PATH, () => apiJson("reviewer.detail", context)));
  server.use(
    http.get(COMPARISON_PATH, () =>
      apiJson("workspace.comparison", workspaceComparisonFixture({ reviewItemId: REVIEW_ITEM_ID })),
    ),
  );
  server.use(http.get(STATUS_PATH, () => apiJson("runtime.status", runtimeStatusFixture)));
}

function renderWithToasts(ui: ReactNode): void {
  render(<ToastProvider>{ui}</ToastProvider>);
}

describe("ReviewerDetailScreen — cross-surface addressable jumps (xs-deep-jumps)", () => {
  it("renders the source unit's bridgeUnitId as a deep-link to the player LINE (/play/units/:id)", async () => {
    handleAll();
    renderWithToasts(<ReviewerDetailScreen reviewItemId={REVIEW_ITEM_ID} />);

    await screen.findByRole("heading", { name: "Source unit" });
    const sourceJump = document.querySelector(".itotori-source-jump");
    expect(sourceJump).not.toBeNull();
    expect(sourceJump).toHaveAttribute("data-jump-kind", "unit");
    expect(sourceJump).toHaveAttribute("data-jump-id", "bridge-unit-xs-deep-jumps");
    // The source-unit key stays the visible label.
    expect(sourceJump).toHaveTextContent("scene.042.line.007");
    // The item's project / locale-branch scope forwards as query so the play
    // surface opens on the same branch.
    expect(sourceJump).toHaveAttribute(
      "href",
      `/play/units/bridge-unit-xs-deep-jumps?projectId=${PROJECT_ID}&localeBranchId=${LOCALE_BRANCH_ID}`,
    );
  });

  it("renders every QA finding id as a deep-link to /findings/:findingId", async () => {
    handleAll();
    renderWithToasts(<ReviewerDetailScreen reviewItemId={REVIEW_ITEM_ID} />);

    await screen.findByRole("heading", { name: "QA findings" });
    const findingJumps = document.querySelectorAll(".itotori-qa-finding-jump");
    expect(findingJumps).toHaveLength(2);
    expect(findingJumps[0]).toHaveAttribute("data-jump-kind", "finding");
    expect(findingJumps[0]).toHaveAttribute("data-jump-id", "qa-finding-xs-deep-jumps-1");
    // The item's project / locale-branch scope forwards as query (consistent
    // with the source-unit line jump).
    const scopedHref = `?projectId=${PROJECT_ID}&localeBranchId=${LOCALE_BRANCH_ID}`;
    expect(findingJumps[0]).toHaveAttribute(
      "href",
      `/findings/qa-finding-xs-deep-jumps-1${scopedHref}`,
    );
    expect(findingJumps[1]).toHaveAttribute(
      "href",
      `/findings/qa-finding-xs-deep-jumps-2${scopedHref}`,
    );
  });

  it("renders no source jump when the source unit is absent (no invented destination)", async () => {
    handleAll(jumpContext({ source: null }));
    renderWithToasts(<ReviewerDetailScreen reviewItemId={REVIEW_ITEM_ID} />);

    await screen.findByRole("heading", { name: "Source unit" });
    expect(document.querySelector(".itotori-source-jump")).toBeNull();
    // The missing-context copy renders instead.
    const sourcePanel = document.querySelector('[data-screen="reviewer-detail"]');
    expect(sourcePanel).not.toBeNull();
    expect(within(sourcePanel as HTMLElement).getByText(/No source unit/i)).toBeInTheDocument();
  });
});
