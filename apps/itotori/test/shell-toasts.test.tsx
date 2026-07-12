// @vitest-environment jsdom
// shell-toasts (HI-FI STUDIO EPIC · Shell) — behavior-first test for the
// SPA toast host + workflow-handoff notifications.
//
// Mounts the REAL `ToastProvider` (ds ToastViewport) and the real decide /
// launch-pass action strips over msw, and asserts the OBSERVABLE behavior:
//
//   1. an empty host renders no toast chrome (empty queue);
//   2. each workflow handoff (flag-sent / approved / pass-launched) enqueues
//      a legible toast rendered with the ds Toast component (tone + copy);
//   3. toasts auto-dismiss after the host duration;
//   4. a real approve / launch-pass success enqueues the matching handoff
//      toast through the shell host (not an ad-hoc banner).
//
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named; only
// the rendered toast copy + tone + auto-dismiss are asserted.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { http } from "msw";
import { setupServer } from "msw/node";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  branchReferenceFixture,
  draftFixture,
  glossaryFixture,
  readyContextFixture,
} from "../src/reviewer/index.js";
import type { ReviewerDetailContext } from "../src/reviewer/index.js";
import { workspaceComparisonFixture } from "../src/workspace/index.js";
import { ReviewerDetailScreen } from "../src/ui/screens/ReviewerDetailScreen.js";
import { LaunchPassAction } from "../src/ui/screens/PassLedgerPanel.js";
import { DEFAULT_TOAST_DURATION_MS, ToastProvider, useToast } from "../src/ui/toast-host.js";
import {
  describeWorkflowHandoff,
  useWorkflowHandoffToasts,
  type WorkflowHandoff,
} from "../src/ui/workflow-handoff-toasts.js";
import { apiJson } from "./msw-handlers.js";
import {
  reviewerQueueActionValues,
  reviewerQueueItemKindValues,
  reviewerQueueItemStateValues,
  type ReviewerQueueAction,
  type ReviewerQueueItemRecord,
} from "@itotori/db";
import type { ReviewerSingleActionResult } from "../src/reviewer/api-service.js";
import type { ApiLaunchPassResponse } from "../src/api-schema.js";

const REVIEW_ITEM_ID = "reviewer-queue-itotori-shelltoasts";
const DETAIL_PATH = "*/api/reviewer/queue/:reviewItemId/detail";
const ACTION_PATH = "*/api/reviewer/queue/:reviewItemId/action";
const COMPARISON_PATH = "*/api/workspace/comparison";
const LAUNCH_PATH = "*/api/projects/:projectId/launch-pass";
const fixtureSourceRevisionId = "source-revision-itotori-shelltoasts";

const server = setupServer();

// Bypass secondary panel reads (corrections / overview / runtime) — this
// suite only asserts the toast host + decide/launch handoffs.
beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

function toastViewport(): HTMLElement | null {
  return document.querySelector(".itotori-toast-viewport");
}

function toastNodes(): HTMLElement[] {
  return Array.from(document.querySelectorAll(".itotori-toast")) as HTMLElement[];
}

/** Harness: buttons that enqueue each workflow handoff through the real hook. */
function HandoffHarness(): ReactNode {
  const { notifyHandoff } = useWorkflowHandoffToasts();
  const { toasts } = useToast();
  const handoffs: WorkflowHandoff[] = [
    { kind: "flag-sent", severity: "warning", category: "tone" },
    { kind: "approved" },
    { kind: "pass-launched", journalRunId: "localization-journal-run-4", unitCount: 3 },
  ];
  return (
    <div data-handoff-harness="true" data-toast-count={toasts.length}>
      {handoffs.map((handoff) => (
        <button
          key={handoff.kind}
          type="button"
          data-enqueue-handoff={handoff.kind}
          onClick={() => {
            notifyHandoff(handoff);
          }}
        >
          enqueue {handoff.kind}
        </button>
      ))}
    </div>
  );
}

function mountHost(ui: ReactNode, defaultDurationMs?: number): void {
  render(<ToastProvider defaultDurationMs={defaultDurationMs}>{ui}</ToastProvider>);
}

describe("shell-toasts — pure handoff copy", () => {
  it("maps flag-sent / approved / pass-launched to the hi-fi studio wording", () => {
    expect(
      describeWorkflowHandoff({ kind: "flag-sent", severity: "warning", category: "tone" }),
    ).toEqual({
      kind: "flag-sent",
      tone: "neutral",
      message: "Flag sent to review · warning · tone",
    });
    expect(describeWorkflowHandoff({ kind: "approved" })).toEqual({
      kind: "approved",
      tone: "ok",
      message: "Approved as-is — unit marked proven.",
    });
    expect(
      describeWorkflowHandoff({
        kind: "pass-launched",
        journalRunId: "localization-journal-run-4",
        unitCount: 1,
      }),
    ).toEqual({
      kind: "pass-launched",
      tone: "neutral",
      message: "Journal localization-journal-run-4 started — drafting 1 corrected unit…",
    });
  });
});

describe("shell-toasts — ToastProvider host", () => {
  it("renders an empty viewport when no handoff has fired (empty state)", () => {
    mountHost(<div data-screen-stub />);
    const viewport = toastViewport();
    expect(viewport).not.toBeNull();
    expect(toastNodes()).toHaveLength(0);
    expect(viewport).toBeEmptyDOMElement();
  });

  it("a handoff enqueues a toast that renders with the ds Toast component", () => {
    mountHost(<HandoffHarness />);
    fireEvent.click(screen.getByRole("button", { name: /enqueue flag-sent/i }));
    const nodes = toastNodes();
    expect(nodes).toHaveLength(1);
    const toast = nodes[0]!;
    expect(toast).toHaveClass("itotori-toast");
    expect(toast).toHaveAttribute("data-toast-tone", "neutral");
    expect(toast).toHaveAttribute("role", "status");
    expect(within(toast).getByText("Flag sent to review · warning · tone")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /enqueue approved/i }));
    fireEvent.click(screen.getByRole("button", { name: /enqueue pass-launched/i }));
    expect(toastNodes()).toHaveLength(3);
    expect(screen.getByText("Approved as-is — unit marked proven.")).toBeInTheDocument();
    expect(
      screen.getByText("Journal localization-journal-run-4 started — drafting 3 corrected units…"),
    ).toBeInTheDocument();
    const approved = toastNodes().find((node) => node.getAttribute("data-toast-tone") === "ok");
    expect(approved).toBeDefined();
  });

  it("auto-dismisses a toast after the host duration", () => {
    vi.useFakeTimers();
    mountHost(<HandoffHarness />, DEFAULT_TOAST_DURATION_MS);
    fireEvent.click(screen.getByRole("button", { name: /enqueue approved/i }));
    expect(screen.getByText("Approved as-is — unit marked proven.")).toBeInTheDocument();

    // Still visible just before the window.
    act(() => {
      vi.advanceTimersByTime(DEFAULT_TOAST_DURATION_MS - 1);
    });
    expect(screen.getByText("Approved as-is — unit marked proven.")).toBeInTheDocument();

    // At the window boundary the toast is gone (flush React state under fake timers).
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText("Approved as-is — unit marked proven.")).not.toBeInTheDocument();
    expect(toastNodes()).toHaveLength(0);
  });

  it("manual dismiss removes a toast immediately", () => {
    mountHost(<HandoffHarness />, 0);
    fireEvent.click(screen.getByRole("button", { name: /enqueue approved/i }));
    expect(toastNodes()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(toastNodes()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end handoffs through the real decide / launch-pass action strips.
// ---------------------------------------------------------------------------

function makeItem(): ReviewerQueueItemRecord {
  return {
    reviewItemId: REVIEW_ITEM_ID,
    projectId: "project-itotori-shelltoasts",
    localeBranchId: "locale-branch-itotori-shelltoasts",
    sourceRevisionId: fixtureSourceRevisionId,
    itemKind: reviewerQueueItemKindValues.qa,
    sourceItemRef: "source-ref-shelltoasts",
    state: reviewerQueueItemStateValues.pending,
    priority: 20,
    summary: "QA item for the shell-toasts handoff",
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

function decideContext(): ReviewerDetailContext {
  return readyContextFixture({
    item: makeItem(),
    reviewItemId: REVIEW_ITEM_ID,
    draft: draftFixture({ draftText: "Hello, handoff.", attemptCount: 1 }),
    glossary: [glossaryFixture()],
    branchReference: branchReferenceFixture(),
    diagnostics: [],
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

describe("shell-toasts — workflow handoffs from real actions", () => {
  beforeEach(() => {
    server.use(
      http.get(DETAIL_PATH, () => apiJson("reviewer.detail", decideContext())),
      http.get(COMPARISON_PATH, () =>
        apiJson(
          "workspace.comparison",
          workspaceComparisonFixture({ reviewItemId: REVIEW_ITEM_ID }),
        ),
      ),
    );
  });

  it("approving a review item surfaces the approved handoff toast", async () => {
    server.use(
      http.post(ACTION_PATH, () =>
        apiJson(
          "reviewer.itemAction",
          appliedSingleActionResult({
            reviewItemId: REVIEW_ITEM_ID,
            action: reviewerQueueActionValues.approve,
            expectedSourceRevisionId: fixtureSourceRevisionId,
            actorUserId: "local-user",
            nextState: reviewerQueueItemStateValues.accepted,
          }),
        ),
      ),
    );

    mountHost(<ReviewerDetailScreen reviewItemId={REVIEW_ITEM_ID} canDecide />);
    // Scope to the decide strip — the legacy kind-specific strip also has an
    // "Approve" control; the handoff toast is fired only by the decide body.
    let strip: HTMLElement | null = null;
    await waitFor(() => {
      strip = document.querySelector('[data-strip="decide-action"]');
      if (strip === null) {
        throw new Error("decide-action strip not yet present");
      }
    });
    fireEvent.click(within(strip as HTMLElement).getByRole("button", { name: "Approve" }));

    expect(await screen.findByText("Approved as-is — unit marked proven.")).toBeInTheDocument();
    const toast = toastNodes().find((node) => node.getAttribute("data-toast-tone") === "ok");
    expect(toast).toBeDefined();
    expect(toast).toHaveClass("itotori-toast", "itotori-toast--ok");
  });

  it("launching a pass surfaces the pass-launched handoff toast", async () => {
    const started: ApiLaunchPassResponse = {
      schemaVersion: "itotori.projects.launch-pass.v1",
      outcome: "started",
      journalRunId: "localization-journal-run-7",
      startedAt: "2026-07-08T00:00:00.000Z",
      refusalMessage: null,
    };
    server.use(http.post(LAUNCH_PATH, () => apiJson("projects.launchPass", started)));

    mountHost(<LaunchPassAction canSteer projectId="project-1" localeBranchId="locale-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Launch next pass" }));

    // Toast copy ends with a period; in-strip status does not. Assert the ds toast.
    await waitFor(() => {
      expect(screen.getByText("Journal localization-journal-run-7 started.")).toBeInTheDocument();
    });
    expect(toastNodes().length).toBeGreaterThanOrEqual(1);
    expect(document.querySelector('[data-launch-pass="started"]')).toHaveTextContent(
      /Journal localization-journal-run-7 started/i,
    );
  });
});
