// Unit-bound feedback panel for the wiki bible: lists durable notes submitted
// against the entry's cited units (same play.flagAnnotation ledger).

import { useEffect, useState, type ReactNode } from "react";
import { Panel } from "@itotori/ds";
import type { ApiPlayUnitFeedbackNote } from "../../../api-schema.js";
import { apiClient } from "../../client.js";
import type { WikiSourceObjectView } from "../../../wiki/dashboard/read-model.js";
import type { WikiBibleScope } from "./client.js";
import { citedBridgeUnitIds } from "./entry-deeplink.js";

type LoadState =
  | { readonly state: "idle" }
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly notes: readonly ApiPlayUnitFeedbackNote[] }
  | { readonly state: "error"; readonly message: string };

export function WikiUnitFeedbackPanel({
  object,
  scope,
}: {
  object: WikiSourceObjectView;
  scope: WikiBibleScope;
}): ReactNode {
  const unitIds = unitIdsForObject(object);
  const [load, setLoad] = useState<LoadState>({ state: "idle" });

  useEffect(() => {
    if (unitIds.length === 0) {
      setLoad({ state: "ready", notes: [] });
      return;
    }
    let cancelled = false;
    setLoad({ state: "loading" });
    void (async () => {
      try {
        const batches = await Promise.all(
          unitIds.map(async (bridgeUnitId) => {
            const result = await apiClient.request("play.unitFeedback", {
              pathParams: {
                projectId: scope.projectId,
                localeBranchId: scope.localeBranchId,
              },
              query: { bridgeUnitId },
            });
            if (result.state === "ready") {
              return result.data.notes;
            }
            if (result.state === "empty") {
              // A successful unit-feedback response always carries its notes
              // array. Do not turn an absent response into an invented empty
              // state for this wiki entry.
              throw new Error("unit feedback response did not include the persisted notes list");
            }
            throw new Error(
              result.error.message ?? result.error.code ?? "unit feedback unavailable",
            );
          }),
        );
        if (cancelled) {
          return;
        }
        const notes = batches.flat();
        setLoad({ state: "ready", notes });
      } catch (error: unknown) {
        if (cancelled) {
          return;
        }
        setLoad({
          state: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [object.objectId, scope.projectId, scope.localeBranchId, unitIds.join("\0")]);

  if (unitIds.length === 0) {
    return null;
  }
  if (load.state === "ready" && load.notes.length === 0) {
    return (
      <Panel
        title="Unit feedback"
        eyebrow="Notes bound to cited units"
        data-testid="wiki-unit-feedback-panel"
        data-unit-feedback-count="0"
      >
        <p data-unit-feedback-empty="true">No unit-bound notes yet for this entry&rsquo;s units.</p>
      </Panel>
    );
  }
  return (
    <Panel
      title="Unit feedback"
      eyebrow="Notes bound to cited units"
      data-testid="wiki-unit-feedback-panel"
      data-unit-feedback-count={load.state === "ready" ? String(load.notes.length) : "pending"}
    >
      {load.state === "loading" && <p>Loading unit-bound feedback…</p>}
      {load.state === "error" && <p role="alert">{load.message}</p>}
      {load.state === "ready" && (
        <ul aria-label="Unit-bound feedback notes" data-unit-feedback-list="true">
          {load.notes.map((note) => (
            <li
              key={note.feedbackEvidenceId}
              data-unit-feedback-id={note.feedbackReportId}
              data-unit-feedback-unit={note.bridgeUnitId}
              data-unit-feedback-note={note.note}
            >
              <strong>{note.severity}</strong> on unit <code>{note.bridgeUnitId}</code>
              {note.sceneId !== null ? (
                <>
                  {" "}
                  (scene <code>{note.sceneId}</code>)
                </>
              ) : null}
              : {note.note}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function unitIdsForObject(object: WikiSourceObjectView): readonly string[] {
  return citedBridgeUnitIds({
    subject: object.subject,
    citations: object.citations,
    claims: object.claims,
  });
}
