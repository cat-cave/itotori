// Review-surface list of unit-bound feedback notes (play.unitFeedback).

import { useEffect, useState, type ReactNode } from "react";
import { Panel } from "@itotori/ds";
import type { ApiPlayUnitFeedbackNote } from "../../api-schema.js";
import { apiClient } from "../client.js";

type LoadState =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly notes: readonly ApiPlayUnitFeedbackNote[] }
  | { readonly state: "error"; readonly message: string };

export function UnitBoundFeedbackList({
  projectId,
  localeBranchId,
  bridgeUnitId,
}: {
  projectId: string;
  localeBranchId: string;
  bridgeUnitId: string;
}): ReactNode {
  const [load, setLoad] = useState<LoadState>({ state: "loading" });

  useEffect(() => {
    let cancelled = false;
    setLoad({ state: "loading" });
    void (async () => {
      const result = await apiClient.request("play.unitFeedback", {
        pathParams: { projectId, localeBranchId },
        query: { bridgeUnitId },
      });
      if (cancelled) {
        return;
      }
      if (result.state === "ready") {
        setLoad({ state: "ready", notes: result.data.notes });
        return;
      }
      if (result.state === "empty") {
        setLoad({ state: "ready", notes: [] });
        return;
      }
      setLoad({
        state: "error",
        message: result.error.message ?? result.error.code ?? "unit feedback unavailable",
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, localeBranchId, bridgeUnitId]);

  return (
    <Panel
      title="Unit feedback"
      eyebrow={`Bound to unit ${bridgeUnitId}`}
      data-testid="unit-bound-feedback-list"
      data-unit-feedback-unit={bridgeUnitId}
      data-unit-feedback-count={load.state === "ready" ? String(load.notes.length) : "pending"}
    >
      {load.state === "loading" && <p>Loading feedback for this unit…</p>}
      {load.state === "error" && <p role="alert">{load.message}</p>}
      {load.state === "ready" && load.notes.length === 0 && (
        <p data-unit-feedback-empty="true">No notes are bound to this unit yet.</p>
      )}
      {load.state === "ready" && load.notes.length > 0 && (
        <ul aria-label="Unit-bound feedback notes" data-unit-feedback-list="true">
          {load.notes.map((note) => (
            <li
              key={note.feedbackEvidenceId}
              data-unit-feedback-id={note.feedbackReportId}
              data-unit-feedback-unit={note.bridgeUnitId}
              data-unit-feedback-note={note.note}
            >
              <strong>{note.severity}</strong>: {note.note}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
