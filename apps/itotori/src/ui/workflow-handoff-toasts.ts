// shell-toasts — legible copy for the three workflow handoffs the hi-fi
// studio store surfaces as toasts:
//
//   flag-sent     — playtester flags a unit into the review queue
//   approved      — reviewer approves as-is (unit marked proven)
//   pass-launched — director launches the next localization pass
//
// Pure message + tone derivation lives here so a behavior-first test can
// assert the handoff copy without mounting the whole studio store. Screens
// call {@link useWorkflowHandoffToasts} to enqueue through the shell host.

import { useCallback } from "react";
import type { ToastTone } from "@itotori/ds";
import { useToast } from "./toast-host.js";

/**
 * The workflow handoffs that must surface a toast. Game-agnostic: severity /
 * category / pass numbers are data, never a title.
 */
export type WorkflowHandoff =
  | { kind: "flag-sent"; severity: string; category: string }
  | { kind: "approved" }
  | { kind: "correction-queued"; nextPass?: number }
  | { kind: "pass-launched"; passNumber: number; unitCount?: number };

export type WorkflowHandoffToast = {
  message: string;
  tone: ToastTone;
  /** Stable handoff kind for test / audit selectors. */
  kind: WorkflowHandoff["kind"];
};

/**
 * Pure map from a workflow handoff to toast copy + tone. Mirrors the hi-fi
 * studio store wording so design ↔ repo stay aligned.
 */
export function describeWorkflowHandoff(handoff: WorkflowHandoff): WorkflowHandoffToast {
  switch (handoff.kind) {
    case "flag-sent":
      return {
        kind: "flag-sent",
        tone: "neutral",
        message: `Flag sent to review · ${handoff.severity} · ${handoff.category}`,
      };
    case "approved":
      return {
        kind: "approved",
        tone: "ok",
        message: "Approved as-is — unit marked proven.",
      };
    case "correction-queued":
      return {
        kind: "correction-queued",
        tone: "neutral",
        message:
          handoff.nextPass === undefined
            ? "Correction queued for the next pass."
            : `Correction queued for pass ${handoff.nextPass}.`,
      };
    case "pass-launched": {
      const n = handoff.unitCount;
      const body =
        n === undefined
          ? `Pass ${handoff.passNumber} started.`
          : `Pass ${handoff.passNumber} started — re-drafting ${n} corrected ${n === 1 ? "unit" : "units"}…`;
      return {
        kind: "pass-launched",
        tone: "neutral",
        message: body,
      };
    }
  }
}

/**
 * Hook: enqueue a workflow-handoff toast through the shell toast host.
 * Screens call `notifyHandoff(...)` after a successful handoff action.
 */
export function useWorkflowHandoffToasts(): {
  notifyHandoff: (handoff: WorkflowHandoff) => string;
} {
  const { pushToast } = useToast();
  const notifyHandoff = useCallback(
    (handoff: WorkflowHandoff): string => {
      const described = describeWorkflowHandoff(handoff);
      return pushToast({
        message: described.message,
        tone: described.tone,
      });
    },
    [pushToast],
  );
  return { notifyHandoff };
}
