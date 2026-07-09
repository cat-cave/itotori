// @vitest-environment jsdom
// HI-FI STUDIO EPIC · Review — behavior-first test for the reviewer
// detail screen's DECIDE ACTION (spec/rev-decide).
//
// Mounts the REAL `ReviewerDetailScreen` over an msw-intercepted
//   - `/api/reviewer/queue/:id/detail` (the `reviewer.detail` read-model)
//   - `/api/reviewer/queue/:id/action` (the existing single-item action
//     seam `reviewer.itemAction` — approve / request_repair / …)
// and asserts the OBSERVABLE behavior a reviewer sees:
//
//   1. a `canDecide` reviewer can APPROVE the item — the "Approve" button
//      fires a `reviewer.itemAction` POST with `action: "approve"` and the
//      item transitions to `accepted` (the "proven" state);
//   2. a `canDecide` reviewer can QUEUE A CORRECTION — the
//      "Queue correction" button fires a POST with `action: "request_repair"`
//      and the item transitions to `repair_requested` (the "next pass"
//      state);
//   3. a non-`canDecide` actor sees the decide buttons HIDDEN;
//   4. a failure from the API surfaces an in-strip visible error instead
//      of a silent panel.
//
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named;
// only the rendered decide buttons + the API POSTs they emit + the
// loading/error states are asserted, over msw, through the typed client
// (no ad-hoc fetch, no api-contract edits).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  branchReferenceFixture,
  draftFixture,
  glossaryFixture,
  readyContextFixture,
  type ReviewerDetailContext as _ReviewerDetailContextAlias,
} from "../src/reviewer/index.js";
import type { ReviewerDetailContext } from "../src/reviewer/index.js";
import { workspaceComparisonFixture } from "../src/workspace/index.js";
import { ReviewerDetailScreen } from "../src/ui/screens/ReviewerDetailScreen.js";
import { ToastProvider } from "../src/ui/toast-host.js";
import { apiJson } from "./msw-handlers.js";
import {
  reviewerQueueActionValues,
  reviewerQueueItemKindValues,
  reviewerQueueItemStateValues,
  type ReviewerQueueAction,
  type ReviewerQueueItemRecord,
} from "@itotori/db";
import type { ReviewerSingleActionResult } from "../src/reviewer/api-service.js";

void (null as unknown as _ReviewerDetailContextAlias);

const REVIEW_ITEM_ID = "reviewer-queue-itotori-revdecide";
const DETAIL_PATH = "*/api/reviewer/queue/:reviewItemId/detail";
const ACTION_PATH = "*/api/reviewer/queue/:reviewItemId/action";
const COMPARISON_PATH = "*/api/workspace/comparison";

const fixtureSourceRevisionId = "source-revision-itotori-revdecide";

function makeItem(): ReviewerQueueItemRecord {
  return {
    reviewItemId: REVIEW_ITEM_ID,
    projectId: "project-itotori-revdecide",
    localeBranchId: "locale-branch-itotori-revdecide",
    sourceRevisionId: fixtureSourceRevisionId,
    itemKind: reviewerQueueItemKindValues.qa,
    sourceItemRef: "source-ref-revdecide",
    state: reviewerQueueItemStateValues.pending,
    priority: 20,
    summary: "QA blocker for the decide-action spec",
    affectedArtifactIds: [],
    evidenceTier: null,
    observationEventIds: null,
    artifactHashes: null,
    payload: {},
    metadata: {},
    createdByUserId: null,
    assignedToUserId: null,
    createdAt: new Date("2026-07-08T00:00:00Z"),
    updatedAt: new Date("2026-07-08T00:00:00Z"),
    resolvedAt: null,
  };
}

function decideContext(overrides: Partial<ReviewerDetailContext> = {}): ReviewerDetailContext {
  return readyContextFixture({
    item: makeItem(),
    reviewItemId: REVIEW_ITEM_ID,
    draft: draftFixture({ draftText: "Hello, reviewer.", attemptCount: 2 }),
    glossary: [glossaryFixture()],
    branchReference: branchReferenceFixture(),
    diagnostics: [],
    ...overrides,
  });
}

function appliedSingleActionResult(input: {
  reviewItemId: string;
  action: ReviewerQueueAction;
  expectedSourceRevisionId: string;
  actorUserId: string;
  nextState:
    | typeof reviewerQueueItemStateValues.accepted
    | typeof reviewerQueueItemStateValues.repairRequested;
}): ReviewerSingleActionResult {
  const item = makeItem();
  return {
    request: {
      reviewItemId: input.reviewItemId,
      action: input.action,
      actorUserId: input.actorUserId,
      expectedSourceRevisionId: input.expectedSourceRevisionId,
    },
    preview: {
      reviewItemId: input.reviewItemId,
      expectedSourceRevisionId: input.expectedSourceRevisionId,
      status: "allowed",
      action: input.action,
      requiredPermission: "queue.manage",
      item,
      priorState: reviewerQueueItemStateValues.pending,
      nextState: input.nextState,
      consequences: [],
      diagnostics: [],
      message: null,
    },
    outcome: {
      kind: "applied",
      reviewItemId: input.reviewItemId,
      result: {
        item: { ...item, state: input.nextState, resolvedAt: new Date("2026-07-08T00:00:01Z") },
        transition: {
          transitionId: `transition-${input.reviewItemId}-${input.action}`,
          reviewItemId: input.reviewItemId,
          localeBranchId: item.localeBranchId,
          sourceRevisionId: input.expectedSourceRevisionId,
          itemKind: item.itemKind,
          action: input.action,
          priorState: reviewerQueueItemStateValues.pending,
          nextState: input.nextState,
          actorUserId: input.actorUserId,
          affectedArtifactIds: [],
          diagnostics: [],
          metadata: {},
          createdAt: new Date("2026-07-08T00:00:01Z"),
        },
      },
    },
    applied: true,
    refused: false,
  };
}

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

function handleComparison(): void {
  server.use(
    http.get(COMPARISON_PATH, () =>
      apiJson("workspace.comparison", workspaceComparisonFixture({ reviewItemId: REVIEW_ITEM_ID })),
    ),
  );
}

function handleDetail(context: ReviewerDetailContext = decideContext()): void {
  server.use(http.get(DETAIL_PATH, () => apiJson("reviewer.detail", context)));
  handleComparison();
}

function renderWithToasts(ui: ReactNode): void {
  // shell-toasts — DecideActionStrip enqueues handoff toasts; the host must
  // wrap any mount that reaches a successful decide.
  render(<ToastProvider>{ui}</ToastProvider>);
}

describe("ReviewerDetailScreen — decide action (canDecide)", () => {
  async function decideStrip(): Promise<HTMLElement> {
    // The detail query settles asynchronously; the strip mounts after
    // the ready view renders. Wait for the marker.
    let el: HTMLElement | null = null;
    await vi.waitFor(() => {
      el = document.querySelector('[data-strip="decide-action"]');
      if (el === null) {
        throw new Error("decide-action strip not yet present");
      }
    });
    return el as HTMLElement;
  }

  it("renders the Approve + Queue correction buttons for a canDecide reviewer", async () => {
    handleDetail();
    renderWithToasts(<ReviewerDetailScreen reviewItemId={REVIEW_ITEM_ID} canDecide />);
    expect(
      await screen.findByRole("heading", { name: /QA blocker for the decide-action spec/i }),
    ).toBeInTheDocument();
    const strip = await decideStrip();
    expect(within(strip).getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(within(strip).getByRole("button", { name: "Queue correction" })).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAttribute("data-can-decide", "true");
  });

  it("a canDecide user approving fires the typed approve action through the existing client", async () => {
    const observed: { body: unknown } = { body: null };
    handleDetail();
    server.use(
      http.post(ACTION_PATH, async ({ request }) => {
        observed.body = await request.json();
        return apiJson(
          "reviewer.itemAction",
          appliedSingleActionResult({
            reviewItemId: REVIEW_ITEM_ID,
            action: reviewerQueueActionValues.approve,
            expectedSourceRevisionId: fixtureSourceRevisionId,
            actorUserId: "local-user",
            nextState: reviewerQueueItemStateValues.accepted,
          }),
        );
      }),
    );

    renderWithToasts(<ReviewerDetailScreen reviewItemId={REVIEW_ITEM_ID} canDecide />);
    const strip = await decideStrip();
    const approve = await within(strip).findByRole("button", { name: "Approve" });
    fireEvent.click(approve);

    // The button POSTs through the typed client (`reviewer.itemAction`),
    // NOT an ad-hoc fetch. Body MUST carry `action: "approve"`, the
    // reviewer's actor id from the read-model, and the item's source
    // revision id (stale-decision guard).
    await vi.waitFor(() => {
      expect(observed.body).not.toBeNull();
    });
    const body = observed.body as Record<string, unknown>;
    expect(body.action).toBe(reviewerQueueActionValues.approve);
    expect(body.actorUserId).toBe("local-user");
    expect(body.expectedSourceRevisionId).toBe(fixtureSourceRevisionId);
    expect(body.repairHint).toBeUndefined();
  });

  it("a canDecide user queuing a correction fires the typed request_repair action (-> next pass)", async () => {
    const observed: { body: unknown } = { body: null };
    handleDetail();
    server.use(
      http.post(ACTION_PATH, async ({ request }) => {
        observed.body = await request.json();
        return apiJson(
          "reviewer.itemAction",
          appliedSingleActionResult({
            reviewItemId: REVIEW_ITEM_ID,
            action: reviewerQueueActionValues.requestRepair,
            expectedSourceRevisionId: fixtureSourceRevisionId,
            actorUserId: "local-user",
            nextState: reviewerQueueItemStateValues.repairRequested,
          }),
        );
      }),
    );

    renderWithToasts(<ReviewerDetailScreen reviewItemId={REVIEW_ITEM_ID} canDecide />);
    const strip = await decideStrip();
    const queue = await within(strip).findByRole("button", { name: "Queue correction" });
    fireEvent.click(queue);

    await vi.waitFor(() => {
      expect(observed.body).not.toBeNull();
    });
    const body = observed.body as Record<string, unknown>;
    // request_repair IS the existing typed single-item verb that pushes
    // the item into the `repair_requested` state (= the "next pass"
    // state the brief requires).
    expect(body.action).toBe(reviewerQueueActionValues.requestRepair);
    expect(body.actorUserId).toBe("local-user");
    expect(body.expectedSourceRevisionId).toBe(fixtureSourceRevisionId);
    expect(typeof body.repairHint).toBe("string");
    expect((body.repairHint as string).length).toBeGreaterThan(0);
  });

  it("a non-canDecide user sees decide buttons DISABLED + EXPLAINED", async () => {
    // fnd-caps-context — a denied action is disabled + explained (not a
    // silent hide). The CapGatedButton strip carries the denial reason.
    handleDetail();
    render(<ReviewerDetailScreen reviewItemId={REVIEW_ITEM_ID} canDecide={false} />);
    expect(
      await screen.findByRole("heading", { name: /QA blocker for the decide-action spec/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAttribute("data-can-decide", "false");
    // Target the decide-capability strip (data-cap="decide"), not the
    // legacy kind-specific Approve which also renders in the action strip.
    const approve = document.querySelector('button[data-cap="decide"][data-action="approve"]');
    const queue = document.querySelector(
      'button[data-cap="decide"][data-action="queue_correction"]',
    );
    expect(approve).not.toBeNull();
    expect(queue).not.toBeNull();
    expect(approve).toBeDisabled();
    expect(queue).toBeDisabled();
    expect(approve).toHaveAttribute("data-cap-allowed", "false");
    expect(screen.getByRole("note")).toHaveAttribute("data-cap-denial", "decide");
  });

  it("surfaces an in-strip error when the typed action API returns a 403 forbidden", async () => {
    handleDetail();
    server.resetHandlers(
      http.get(DETAIL_PATH, () => apiJson("reviewer.detail", decideContext())),
      http.get(COMPARISON_PATH, () =>
        apiJson(
          "workspace.comparison",
          workspaceComparisonFixture({ reviewItemId: REVIEW_ITEM_ID }),
        ),
      ),
      http.post(ACTION_PATH, () =>
        HttpResponse.json(
          {
            code: "forbidden",
            error: "user local-user is missing permission queue.manage",
          },
          { status: 403 },
        ),
      ),
    );

    renderWithToasts(<ReviewerDetailScreen reviewItemId={REVIEW_ITEM_ID} canDecide />);
    const strip = await decideStrip();
    const approve = await within(strip).findByRole("button", { name: "Approve" });
    fireEvent.click(approve);

    const error = await within(strip).findByRole("alert");
    expect(error).toHaveAttribute("data-decide-error", "approve");
    expect(within(error).getByText(/forbidden/i)).toBeInTheDocument();
    // The button recovers so the reviewer can retry once their
    // permission is fixed.
    await waitFor(() => {
      expect(within(strip).getByRole("button", { name: "Approve" })).not.toBeDisabled();
    });
  });
});

beforeEach(() => {
  // Each test mounts the real screen fresh.
});
