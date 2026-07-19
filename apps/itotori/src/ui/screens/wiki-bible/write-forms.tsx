// The Wiki bible dashboard write surface: a play tester's direct correction
// (edit) and free-text feedback, both NON-BLOCKING. Each write posts a strict
// HumanInput to the object API and returns an immediate receipt that addresses
// the SAME object; the surface then returns the tester to exactly what they
// corrected. There is no reviewer or approval control here — a correction is a
// durable human input the enhancement flywheel resolves later.

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Panel } from "@itotori/ds";
import { writeAssertionFor, writeWikiBibleInput, type WikiBibleScope } from "./client.js";
import type {
  WikiClaimView,
  WikiDashboardWriteReceipt,
  WikiSourceObjectView,
} from "../../../wiki/dashboard/read-model.js";
import { visibleClaims } from "../../../wiki/dashboard/read-model.js";

type WriteState =
  | { readonly state: "idle" }
  | { readonly state: "saving" }
  | { readonly state: "error"; readonly message: string };

export function WikiBibleWriteForms({
  object,
  scope,
  activeRouteId,
  onWritten,
}: {
  object: WikiSourceObjectView;
  scope: WikiBibleScope;
  /** The exact route scope already enforced by the read-side claims panel. */
  activeRouteId: string | null;
  onWritten: (receipt: WikiDashboardWriteReceipt) => void;
}): ReactNode {
  const ref = { objectId: object.objectId, wikiKind: object.wikiKind };
  // Never offer a write control for a claim the current route cannot read.
  // The forms consume this same projection as ClaimsPanel, not object.claims.
  const shownClaims = visibleClaims(object.claims, activeRouteId);
  return (
    <div className="wiki-bible__writes">
      <ClaimEditForm
        object={object}
        claims={shownClaims}
        scope={scope}
        objectRef={ref}
        onWritten={onWritten}
      />
      <FeedbackForm
        object={object}
        claims={shownClaims}
        scope={scope}
        objectRef={ref}
        onWritten={onWritten}
      />
    </div>
  );
}

function ClaimEditForm({
  object,
  claims,
  scope,
  objectRef,
  onWritten,
}: {
  object: WikiSourceObjectView;
  claims: readonly WikiClaimView[];
  scope: WikiBibleScope;
  objectRef: { objectId: string; wikiKind: string };
  onWritten: (receipt: WikiDashboardWriteReceipt) => void;
}): ReactNode {
  const firstClaim = claims[0] ?? null;
  const [claimId, setClaimId] = useState(firstClaim?.claimId ?? "");
  const claim = claims.find((entry) => entry.claimId === claimId) ?? null;
  const claimIndex = claim === null ? -1 : object.claims.findIndex((entry) => entry === claim);
  const [statement, setStatement] = useState(firstClaim?.statement ?? "");
  const [outcome, setOutcome] = useState<WriteState>({ state: "idle" });
  const canSave =
    claim !== null && statement.trim().length > 0 && statement.trim() !== claim.statement;

  // A route change can make a previously selected claim out of scope. Reset to
  // the first currently visible claim before the tester can submit it.
  useEffect(() => {
    if (claim !== null) {
      return;
    }
    setClaimId(firstClaim?.claimId ?? "");
    setStatement(firstClaim?.statement ?? "");
  }, [claim, firstClaim]);

  function selectClaim(nextClaimId: string): void {
    setClaimId(nextClaimId);
    const next = claims.find((entry) => entry.claimId === nextClaimId);
    setStatement(next?.statement ?? "");
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSave || claim === null) {
      return;
    }
    setOutcome({ state: "saving" });
    const result = await writeWikiBibleInput(scope, objectRef, {
      input: {
        kind: "edit",
        inputId: newInputId("edit"),
        operations: [
          {
            kind: "replace-text",
            fieldPath: ["claims", String(claimIndex), "statement"],
            before: claim.statement,
            after: statement.trim(),
          },
        ],
      },
      assertion: writeAssertionFor(object, scope),
    });
    if (result.ok) {
      onWritten(result.data);
      return;
    }
    setOutcome({ state: "error", message: result.error.message });
  }

  if (claims.length === 0) {
    return null;
  }
  return (
    <Panel title="Correct a claim" eyebrow="Direct canonical edit">
      <p>
        Rewrite a claim&rsquo;s statement. Saving appends a durable human version and returns you to
        this object; dependent renderings are invalidated for the enhancement flywheel to refresh.
      </p>
      <form aria-label="Correct a claim" onSubmit={(event) => void submit(event)}>
        <p>
          <label htmlFor="wiki-bible-edit-claim">Claim</label>
          <select
            id="wiki-bible-edit-claim"
            name="claimId"
            value={claimId}
            onChange={(event) => selectClaim(event.target.value)}
          >
            {claims.map((entry) => (
              <option key={entry.claimId} value={entry.claimId}>
                {entry.claimId}
              </option>
            ))}
          </select>
        </p>
        <p>
          <label htmlFor="wiki-bible-edit-statement">Statement</label>
          <textarea
            id="wiki-bible-edit-statement"
            name="statement"
            rows={4}
            value={statement}
            onChange={(event) => setStatement(event.target.value)}
            required
          />
        </p>
        <button type="submit" disabled={!canSave || outcome.state === "saving"}>
          {outcome.state === "saving" ? "Saving correction…" : "Save claim correction"}
        </button>
      </form>
      {outcome.state === "error" && <p role="alert">{outcome.message}</p>}
    </Panel>
  );
}

function FeedbackForm({
  object,
  claims,
  scope,
  objectRef,
  onWritten,
}: {
  object: WikiSourceObjectView;
  claims: readonly WikiClaimView[];
  scope: WikiBibleScope;
  objectRef: { objectId: string; wikiKind: string };
  onWritten: (receipt: WikiDashboardWriteReceipt) => void;
}): ReactNode {
  const [text, setText] = useState("");
  const [targetClaimId, setTargetClaimId] = useState("");
  const [outcome, setOutcome] = useState<WriteState>({ state: "idle" });
  const canSend = text.trim().length > 0 && outcome.state !== "saving";

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSend) {
      return;
    }
    setOutcome({ state: "saving" });
    const result = await writeWikiBibleInput(scope, objectRef, {
      input: {
        kind: "feedback",
        inputId: newInputId("feedback"),
        text: text.trim(),
        ...(targetClaimId === "" ? {} : { targetClaimId }),
      },
      assertion: writeAssertionFor(object, scope),
    });
    if (result.ok) {
      onWritten(result.data);
      return;
    }
    setOutcome({ state: "error", message: result.error.message });
  }

  return (
    <Panel title="Flag or leave feedback" eyebrow="Non-blocking human input">
      <p>
        Flag something you observed while playing or leave feedback on a claim. It is recorded
        against this object immediately and returns you here — no approval step.
      </p>
      <form aria-label="Flag or leave feedback" onSubmit={(event) => void submit(event)}>
        <p>
          <label htmlFor="wiki-bible-feedback-claim">Target claim (optional)</label>
          <select
            id="wiki-bible-feedback-claim"
            name="targetClaimId"
            value={targetClaimId}
            onChange={(event) => setTargetClaimId(event.target.value)}
          >
            <option value="">Whole object</option>
            {claims.map((entry) => (
              <option key={entry.claimId} value={entry.claimId}>
                {entry.claimId}
              </option>
            ))}
          </select>
        </p>
        <p>
          <label htmlFor="wiki-bible-feedback-text">Feedback</label>
          <textarea
            id="wiki-bible-feedback-text"
            name="text"
            rows={4}
            value={text}
            onChange={(event) => setText(event.target.value)}
            required
          />
        </p>
        <button type="submit" disabled={!canSend}>
          {outcome.state === "saving" ? "Recording feedback…" : "Record feedback"}
        </button>
      </form>
      {outcome.state === "error" && <p role="alert">{outcome.message}</p>}
    </Panel>
  );
}

/** A collision-resistant, contract-valid HumanInput identifier. */
function newInputId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}
