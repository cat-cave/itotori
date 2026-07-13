// p0-core-iterative-patch-versioning-and-playtest-feedback — dashboard
// surface for the durable iteration loop. Reads only through the typed API
// client, starts an exact-version play session, and sends the frozen feedback
// selection to the real refinement endpoint. The reusable panel remains the
// presentation layer; this screen owns route identity and mutations.

import { useEffect, useState, type ReactNode } from "react";
import type {
  ApiPatchIterationFeedbackRequest,
  ApiPatchIterationFeedbackInbox,
  ApiPatchIterationPatch,
  ApiPatchIterationVersion,
} from "../../api-schema.js";
import { apiClient } from "../client.js";
import { EmptyState, ErrorState, LoadingState, ShellHeader } from "../states.js";
import { useApiQuery, useApiQueryWhen } from "../use-api-resource.js";
import {
  PatchIterationPanel,
  type PatchIterationFeedbackInboxView,
  type PatchIterationFeedbackRefinementStatus,
  type PatchIterationQaCalloutView,
  type PatchIterationRefinementRequest,
  type PatchIterationVersionStatus,
  type PatchIterationVersionView,
} from "./PatchIterationPanel.js";

/** The Play surface is the first-class patch iteration and feedback loop. */
export const patchIterationRoutePathRegex = /^\/play(?:\/patches)?\/?$/u;

export type PatchIterationRouteParams = {
  localeBranchId: string | null;
  patchVersionId: string | null;
};

export function parsePatchIterationRoute(
  pathname: string,
  search: string,
): PatchIterationRouteParams | null {
  if (!patchIterationRoutePathRegex.test(pathname)) {
    return null;
  }
  const params = new URLSearchParams(search);
  return {
    localeBranchId: nonEmpty(params.get("localeBranchId")),
    patchVersionId: nonEmpty(params.get("patchVersionId")),
  };
}

/** Stable internal link for one branch-scoped historical patch version. */
export function patchIterationHref(input: {
  localeBranchId: string;
  patchVersionId?: string;
}): string {
  const params = new URLSearchParams({ localeBranchId: input.localeBranchId });
  if (input.patchVersionId !== undefined) {
    params.set("patchVersionId", input.patchVersionId);
  }
  return `/play/patches?${params.toString()}`;
}

function nonEmpty(value: string | null): string | null {
  if (value === null || value.trim().length === 0) {
    return null;
  }
  return value.trim();
}

function browserNavigate(path: string): void {
  if (typeof window !== "undefined" && typeof window.location?.assign === "function") {
    window.location.assign(path);
  }
}

/**
 * Branch identity comes from the URL when supplied. Otherwise it falls back
 * to the selected project context, matching the other Play surfaces.
 */
export function PatchIterationScreen({
  route,
  navigate = browserNavigate,
}: {
  route: PatchIterationRouteParams;
  navigate?: (path: string) => void;
}): ReactNode {
  if (route.localeBranchId !== null) {
    return (
      <PatchIterationForBranch
        localeBranchId={route.localeBranchId}
        requestedPatchVersionId={route.patchVersionId}
        navigate={navigate}
      />
    );
  }
  return (
    <PatchIterationFromStatus requestedPatchVersionId={route.patchVersionId} navigate={navigate} />
  );
}

function PatchIterationFromStatus({
  requestedPatchVersionId,
  navigate,
}: {
  requestedPatchVersionId: string | null;
  navigate: (path: string) => void;
}): ReactNode {
  const status = useApiQuery("projects.status", {}, "patch-iteration:project-status");
  if (status.state === "loading") {
    return <PatchIterationLoading />;
  }
  if (status.state === "error") {
    return (
      <PatchIterationShell state="error">
        <ErrorState title="Patch iterations" error={status.error} />
      </PatchIterationShell>
    );
  }
  const localeBranchId = status.state === "ready" ? status.data.selectedLocaleBranchId : null;
  if (localeBranchId === null) {
    return (
      <PatchIterationShell state="empty">
        <EmptyState
          title="No locale branch selected"
          message="Select a locale branch to inspect its patch-version iteration history."
        />
      </PatchIterationShell>
    );
  }
  return (
    <PatchIterationForBranch
      localeBranchId={localeBranchId}
      requestedPatchVersionId={requestedPatchVersionId}
      navigate={navigate}
    />
  );
}

function PatchIterationForBranch({
  localeBranchId,
  requestedPatchVersionId,
  navigate,
}: {
  localeBranchId: string;
  requestedPatchVersionId: string | null;
  navigate: (path: string) => void;
}): ReactNode {
  const [revision, setRevision] = useState(0);
  const versions = useApiQuery(
    "patchIteration.versions",
    { pathParams: { localeBranchId } },
    `patch-iteration:versions:${localeBranchId}:${revision}`,
  );
  const activePatchVersionId =
    versions.state === "ready"
      ? activePlayablePatchVersionId(versions.data.versions, requestedPatchVersionId)
      : null;
  const surface = useApiQueryWhen(
    "patchIteration.surface",
    { pathParams: { patchVersionId: activePatchVersionId ?? "" } },
    `patch-iteration:surface:${activePatchVersionId ?? "none"}:${revision}`,
    activePatchVersionId !== null,
  );

  if (versions.state === "loading") {
    return <PatchIterationLoading localeBranchId={localeBranchId} />;
  }
  if (versions.state === "error") {
    return (
      <PatchIterationShell state="error" localeBranchId={localeBranchId}>
        <ErrorState title="Patch version lineage" error={versions.error} />
      </PatchIterationShell>
    );
  }
  if (versions.state === "empty") {
    return (
      <PatchIterationShell state="empty" localeBranchId={localeBranchId}>
        <EmptyState
          title="No patch versions yet"
          message="Finish a localization run to produce the first playable patch version."
        />
      </PatchIterationShell>
    );
  }

  if (activePatchVersionId === null) {
    return (
      <PatchIterationShell state="ready" localeBranchId={localeBranchId}>
        <PatchIterationPanel
          versions={versions.data.versions.map((version) =>
            patchIterationVersionView(version, localeBranchId),
          )}
          activePatchVersionId={null}
          baseScopeUnitIds={[]}
          feedback={EMPTY_FEEDBACK_INBOX}
          qaCallouts={[]}
          onPlay={() => {}}
          onRefine={() => {}}
        />
      </PatchIterationShell>
    );
  }
  if (surface.state === "loading") {
    return <PatchIterationLoading localeBranchId={localeBranchId} />;
  }
  if (surface.state === "error") {
    return (
      <PatchIterationShell state="error" localeBranchId={localeBranchId}>
        <ErrorState title="Patch play surface" error={surface.error} />
      </PatchIterationShell>
    );
  }
  if (surface.state === "empty") {
    return (
      <PatchIterationShell state="empty" localeBranchId={localeBranchId}>
        <EmptyState
          title="Patch play surface unavailable"
          message="The requested patch version is no longer available to this workspace."
        />
      </PatchIterationShell>
    );
  }

  return (
    <PatchIterationReady
      localeBranchId={localeBranchId}
      surface={surface.data}
      navigate={navigate}
      onRefresh={() => setRevision((value) => value + 1)}
    />
  );
}

type MutationOutcome =
  | { kind: "play"; playSessionId: string }
  | { kind: "refine"; patchVersionId: string }
  | { kind: "error"; message: string };

function PatchIterationReady({
  localeBranchId,
  surface,
  navigate,
  onRefresh,
}: {
  localeBranchId: string;
  surface: {
    patch: ApiPatchIterationPatch;
    versions: ApiPatchIterationVersion[];
    feedback: ApiPatchIterationFeedbackInbox;
  };
  navigate: (path: string) => void;
  onRefresh: () => void;
}): ReactNode {
  const [pending, setPending] = useState<"play" | "refine" | null>(null);
  const [outcome, setOutcome] = useState<MutationOutcome | null>(null);
  const [playSessionId, setPlaySessionId] = useState<string | null>(null);

  // Patch versions are immutable and a session must never leak from the
  // previously viewed version into feedback for the next one.
  useEffect(() => {
    setPlaySessionId(null);
  }, [surface.patch.patchVersionId]);

  const startPlay = async (patchVersionId: string): Promise<void> => {
    if (pending !== null) return;
    setPending("play");
    setOutcome(null);
    setPlaySessionId(null);
    try {
      const result = await apiClient.request("patchIteration.play", {
        pathParams: { patchVersionId },
        body: {},
      });
      if (result.state === "ready") {
        const startedPlaySessionId = result.data.session.playSessionId;
        setPlaySessionId(startedPlaySessionId);
        setOutcome({ kind: "play", playSessionId: startedPlaySessionId });
      } else if (result.state === "error") {
        setOutcome({ kind: "error", message: apiErrorMessage(result.error) });
      } else {
        setOutcome({ kind: "error", message: "The play session returned no durable receipt." });
      }
    } catch (error) {
      setOutcome({
        kind: "error",
        message: errorMessage(error, "Could not start the play session."),
      });
    } finally {
      setPending(null);
    }
  };

  const startRefinement = async (request: PatchIterationRefinementRequest): Promise<void> => {
    if (pending !== null) return;
    setPending("refine");
    setOutcome(null);
    try {
      const result = await apiClient.request("patchIteration.refine", {
        pathParams: { patchVersionId: request.basePatchVersionId },
        body: {
          feedbackBatchIds: [...request.feedbackBatchIds],
          feedbackEventIds: [...request.feedbackEventIds],
          ...(request.scopeUnitIds === undefined
            ? {}
            : { scopeUnitIds: [...request.scopeUnitIds] }),
          ...(request.targetBodiesByUnit === undefined
            ? {}
            : { targetBodiesByUnit: { ...request.targetBodiesByUnit } }),
          ...(request.wikiHeads === undefined ? {} : { wikiHeads: [...request.wikiHeads] }),
        },
      });
      if (result.state === "ready") {
        const patchVersionId = result.data.patch.patchVersionId;
        setOutcome({ kind: "refine", patchVersionId });
        // A real refinement has a fresh immutable identity. Move the
        // dashboard to that exact v2 rather than mutating v1 in place.
        navigate(patchIterationHref({ localeBranchId, patchVersionId }));
      } else if (result.state === "error") {
        setOutcome({ kind: "error", message: apiErrorMessage(result.error) });
      } else {
        setOutcome({ kind: "error", message: "The refinement returned no durable patch receipt." });
      }
    } catch (error) {
      setOutcome({ kind: "error", message: errorMessage(error, "Could not start refinement.") });
    } finally {
      setPending(null);
    }
  };

  const versions = surface.versions.map((version) =>
    patchIterationVersionView(version, localeBranchId, surface.patch),
  );
  const feedback = patchIterationFeedbackInboxView(
    surface.feedback,
    surface.patch.patchVersionId,
    surface.versions,
  );
  const qaCallouts = surface.patch.qaCallouts.map(patchIterationQaCalloutView);
  return (
    <PatchIterationShell state="ready" localeBranchId={localeBranchId}>
      <section
        aria-label="Patch iteration dashboard"
        data-patch-iteration-pending={pending ?? "none"}
        // This duplicate surface marker makes the operational invariant
        // visible at the dashboard boundary too: QA annotates, never gates.
        data-qa-gates-actions="false"
      >
        <PatchIterationPanel
          versions={versions}
          activePatchVersionId={surface.patch.patchVersionId}
          baseScopeUnitIds={surface.patch.units.map((unit) => unit.bridgeUnitId)}
          feedback={feedback}
          qaCallouts={qaCallouts}
          onPlay={(patchVersionId) => {
            void startPlay(patchVersionId);
          }}
          onRefine={(request) => {
            void startRefinement(request);
          }}
        />
        <PatchFeedbackComposer
          patchVersionId={surface.patch.patchVersionId}
          playSessionId={playSessionId}
          onRecorded={onRefresh}
        />
        {pending !== null && (
          <p role="status" data-patch-iteration-status="pending">
            {pending === "play" ? "Starting play session…" : "Building refinement patch…"}
          </p>
        )}
        {outcome?.kind === "play" && (
          <p role="status" data-patch-iteration-status="play-started">
            Patched runtime opened; play session <code>{outcome.playSessionId}</code> is linked to
            this exact patch version.
          </p>
        )}
        {outcome?.kind === "refine" && (
          <p role="status" data-patch-iteration-status="refinement-built">
            Refinement produced <code>{outcome.patchVersionId}</code>; opening that new patch
            version.
          </p>
        )}
        {outcome?.kind === "error" && <p role="alert">{outcome.message}</p>}
      </section>
    </PatchIterationShell>
  );
}

/**
 * The iteration surface owns feedback attachment/batching, while result text
 * and canonical context remain owned by their existing Node 10 / Node 9
 * identities. Context feedback can deliberately either invoke that canonical
 * WikiBrain path or attach a correction that was already made in the wiki;
 * this form never creates a parallel editor or mutable feedback-only context.
 */
function PatchFeedbackComposer({
  patchVersionId,
  playSessionId,
  onRecorded,
}: {
  patchVersionId: string;
  playSessionId: string | null;
  onRecorded: () => void;
}): ReactNode {
  const [eventKind, setEventKind] =
    useState<ApiPatchIterationFeedbackRequest["eventKind"]>("comment");
  const [body, setBody] = useState("");
  const [feedbackBatchId, setFeedbackBatchId] = useState("");
  const [batchLabel, setBatchLabel] = useState("");
  const [bridgeUnitIds, setBridgeUnitIds] = useState("");
  const [targetBody, setTargetBody] = useState("");
  const [contextMode, setContextMode] = useState<"mutation" | "reference">("mutation");
  const [contextKind, setContextKind] = useState<"note" | "glossary" | "style">("note");
  const [contextTitle, setContextTitle] = useState("");
  const [contextBody, setContextBody] = useState("");
  const [contextReason, setContextReason] = useState("");
  const [contextArtifactId, setContextArtifactId] = useState("");
  const [contextEntryVersionId, setContextEntryVersionId] = useState("");
  const [pending, setPending] = useState<"batch" | "feedback" | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createBatch = async (): Promise<void> => {
    if (pending !== null) return;
    setPending("batch");
    setReceipt(null);
    setError(null);
    try {
      const result = await apiClient.request("patchIteration.feedbackBatch", {
        pathParams: { patchVersionId },
        body: batchLabel.trim().length === 0 ? {} : { label: batchLabel.trim() },
      });
      if (result.state !== "ready") {
        setError(
          result.state === "error"
            ? apiErrorMessage(result.error)
            : "The feedback batch returned no durable receipt.",
        );
        return;
      }
      setFeedbackBatchId(result.data.batch.feedbackBatchId);
      setReceipt(`Feedback batch ${result.data.batch.feedbackBatchId} is ready.`);
    } catch (caught) {
      setError(errorMessage(caught, "Could not create the feedback batch."));
    } finally {
      setPending(null);
    }
  };

  const recordFeedback = async (): Promise<void> => {
    if (pending !== null) return;
    const affectedBridgeUnitIds = commaSeparatedNonBlank(bridgeUnitIds);
    const isContextEvent = eventKind === "added_context" || eventKind === "wiki_edit";
    if (eventKind === "result_edit") {
      if (affectedBridgeUnitIds.length !== 1 || targetBody.trim().length === 0) {
        setError("A result edit needs one bridge-unit ID and non-blank replacement target text.");
        return;
      }
    }
    if (eventKind === "comment") {
      if (affectedBridgeUnitIds.length === 0 || body.trim().length === 0) {
        setError(
          "A comment needs a non-blank note and at least one bridge-unit ID so it can become a canonical correction.",
        );
        return;
      }
    }
    if (isContextEvent) {
      if (contextMode === "reference") {
        if (contextArtifactId.trim().length === 0 || contextEntryVersionId.trim().length === 0) {
          setError("Existing-context feedback needs a canonical artifact ID and version ID.");
          return;
        }
      } else if (eventKind === "added_context") {
        if (
          contextTitle.trim().length === 0 ||
          contextBody.trim().length === 0 ||
          contextReason.trim().length === 0 ||
          affectedBridgeUnitIds.length === 0
        ) {
          setError(
            "Added context needs a kind, title, body, reason, and at least one affected bridge unit.",
          );
          return;
        }
      } else if (
        contextArtifactId.trim().length === 0 ||
        contextBody.trim().length === 0 ||
        contextReason.trim().length === 0
      ) {
        setError("A wiki edit needs an artifact ID, replacement body, and reason.");
        return;
      }
    }
    const contextFeedback =
      !isContextEvent || contextMode === "reference"
        ? undefined
        : eventKind === "added_context"
          ? {
              operation: "add" as const,
              kind: contextKind,
              title: contextTitle.trim(),
              body: contextBody.trim(),
              reason: contextReason.trim(),
              affectedBridgeUnitIds,
            }
          : {
              operation: "edit" as const,
              contextArtifactId: contextArtifactId.trim(),
              body: contextBody.trim(),
              reason: contextReason.trim(),
              ...(contextTitle.trim().length === 0 ? {} : { title: contextTitle.trim() }),
              ...(affectedBridgeUnitIds.length === 0 ? {} : { affectedBridgeUnitIds }),
            };
    setPending("feedback");
    setReceipt(null);
    setError(null);
    const request: ApiPatchIterationFeedbackRequest = {
      eventKind,
      ...(feedbackBatchId.trim().length === 0 ? {} : { feedbackBatchId: feedbackBatchId.trim() }),
      ...(playSessionId === null ? {} : { playSessionId }),
      ...(body.trim().length === 0 ? {} : { body: body.trim() }),
      ...(contextFeedback === undefined && affectedBridgeUnitIds.length > 0
        ? { affectedBridgeUnitIds }
        : {}),
      ...(targetBody.trim().length === 0 ? {} : { targetBody: targetBody.trim() }),
      ...(contextFeedback === undefined && contextArtifactId.trim().length > 0
        ? { contextArtifactId: contextArtifactId.trim() }
        : {}),
      ...(contextFeedback === undefined && contextEntryVersionId.trim().length > 0
        ? { contextEntryVersionId: contextEntryVersionId.trim() }
        : {}),
      ...(contextFeedback === undefined ? {} : { contextFeedback }),
    };
    try {
      const result = await apiClient.request("patchIteration.feedback", {
        pathParams: { patchVersionId },
        body: request,
      });
      if (result.state !== "ready") {
        setError(
          result.state === "error"
            ? apiErrorMessage(result.error)
            : "The feedback event returned no durable receipt.",
        );
        return;
      }
      setReceipt(
        `Feedback event ${result.data.feedback.feedbackEventId} was attached to this patch.`,
      );
      setBody("");
      setTargetBody("");
      setBridgeUnitIds("");
      setContextBody("");
      setContextReason("");
      onRecorded();
    } catch (caught) {
      setError(errorMessage(caught, "Could not attach play-test feedback."));
    } finally {
      setPending(null);
    }
  };

  return (
    <section
      className="patch-iteration-feedback-composer"
      aria-labelledby="patch-feedback-compose-heading"
    >
      <h2 id="patch-feedback-compose-heading">Record play-test feedback</h2>
      <p>
        Feedback is attached to <code>{patchVersionId}</code>. A scoped comment becomes a canonical
        note for the registered redraft; result edits create the existing immutable result revision;
        context feedback writes through the existing canonical wiki and correction flywheel, or can
        cite a correction already recorded there.
      </p>
      <div className="patch-iteration-feedback-composer__batch">
        <label>
          Batch label (optional)
          <input
            value={batchLabel}
            onChange={(event) => setBatchLabel(event.currentTarget.value)}
            placeholder="Route observations"
          />
        </label>
        <button type="button" onClick={() => void createBatch()} disabled={pending !== null}>
          Create feedback batch
        </button>
      </div>
      <label>
        Feedback batch ID (optional; omit for an individual event)
        <input
          value={feedbackBatchId}
          onChange={(event) => setFeedbackBatchId(event.currentTarget.value)}
          placeholder="feedback-batch:…"
        />
      </label>
      <label>
        Kind
        <select
          value={eventKind}
          onChange={(event) =>
            setEventKind(event.currentTarget.value as ApiPatchIterationFeedbackRequest["eventKind"])
          }
        >
          <option value="comment">Scoped comment</option>
          <option value="result_edit">Result edit</option>
          <option value="added_context">Added context</option>
          <option value="wiki_edit">Wiki edit</option>
        </select>
      </label>
      <label>
        {eventKind === "comment"
          ? "Comment (required)"
          : "Note (optional for a target-only result edit)"}
        <textarea
          value={body}
          onChange={(event) => setBody(event.currentTarget.value)}
          rows={3}
          placeholder="What changed during play?"
        />
      </label>
      <label>
        Affected bridge-unit IDs (comma-separated)
        <input
          value={bridgeUnitIds}
          onChange={(event) => setBridgeUnitIds(event.currentTarget.value)}
          placeholder="bridge-unit-1"
        />
      </label>
      {eventKind === "result_edit" && (
        <label>
          Replacement target text
          <textarea
            value={targetBody}
            onChange={(event) => setTargetBody(event.currentTarget.value)}
            rows={3}
            placeholder="The text the play tester wants in the next patch"
          />
        </label>
      )}
      {(eventKind === "added_context" || eventKind === "wiki_edit") && (
        <div className="patch-iteration-feedback-composer__context">
          <fieldset className="patch-iteration-feedback-composer__context-mode">
            <legend>Context feedback mode</legend>
            <label>
              <input
                type="radio"
                name="patch-context-feedback-mode"
                checked={contextMode === "mutation"}
                onChange={() => setContextMode("mutation")}
              />
              Write through canonical WikiBrain
            </label>
            <label>
              <input
                type="radio"
                name="patch-context-feedback-mode"
                checked={contextMode === "reference"}
                onChange={() => setContextMode("reference")}
              />
              Attach an existing canonical wiki version
            </label>
          </fieldset>
          {contextMode === "reference" ? (
            <>
              <label>
                Existing wiki/context artifact ID
                <input
                  value={contextArtifactId}
                  onChange={(event) => setContextArtifactId(event.currentTarget.value)}
                />
              </label>
              <label>
                Existing wiki/context version ID
                <input
                  value={contextEntryVersionId}
                  onChange={(event) => setContextEntryVersionId(event.currentTarget.value)}
                />
              </label>
            </>
          ) : (
            <>
              {eventKind === "added_context" && (
                <label>
                  Context entry kind
                  <select
                    value={contextKind}
                    onChange={(event) =>
                      setContextKind(event.currentTarget.value as "note" | "glossary" | "style")
                    }
                  >
                    <option value="note">Note</option>
                    <option value="glossary">Glossary</option>
                    <option value="style">Style</option>
                  </select>
                </label>
              )}
              {eventKind === "wiki_edit" && (
                <label>
                  Existing wiki/context artifact ID
                  <input
                    value={contextArtifactId}
                    onChange={(event) => setContextArtifactId(event.currentTarget.value)}
                  />
                </label>
              )}
              <label>
                Context entry title {eventKind === "wiki_edit" ? "(optional)" : ""}
                <input
                  value={contextTitle}
                  onChange={(event) => setContextTitle(event.currentTarget.value)}
                  placeholder={
                    eventKind === "wiki_edit"
                      ? "Leave blank to preserve the canonical title"
                      : "Shared terminology or route fact"
                  }
                />
              </label>
              <label>
                {eventKind === "wiki_edit" ? "Replacement context body" : "Context entry body"}
                <textarea
                  value={contextBody}
                  onChange={(event) => setContextBody(event.currentTarget.value)}
                  rows={3}
                />
              </label>
              <label>
                Why this context matters
                <textarea
                  value={contextReason}
                  onChange={(event) => setContextReason(event.currentTarget.value)}
                  rows={2}
                />
              </label>
            </>
          )}
        </div>
      )}
      <button type="button" onClick={() => void recordFeedback()} disabled={pending !== null}>
        {pending === "feedback" ? "Recording feedback…" : "Attach feedback"}
      </button>
      {receipt !== null && <p role="status">{receipt}</p>}
      {error !== null && <p role="alert">{error}</p>}
    </section>
  );
}

function commaSeparatedNonBlank(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((unitId) => unitId.trim())
        .filter(Boolean),
    ),
  ];
}

function PatchIterationShell({
  state,
  localeBranchId,
  children,
}: {
  state: "loading" | "ready" | "empty" | "error";
  localeBranchId?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <main
      className="itotori-shell patch-iteration"
      data-screen="patch-iteration"
      data-state={state}
      data-locale-branch-id={localeBranchId}
    >
      <ShellHeader eyebrow="Play" title="Patch iterations">
        <a href="/play/routemap">Play route map</a>
      </ShellHeader>
      {children}
    </main>
  );
}

function PatchIterationLoading({ localeBranchId }: { localeBranchId?: string }): ReactNode {
  return (
    <PatchIterationShell
      state="loading"
      {...(localeBranchId === undefined ? {} : { localeBranchId })}
    >
      <LoadingState label="Loading patch-version lineage…" />
    </PatchIterationShell>
  );
}

function activePlayablePatchVersionId(
  versions: readonly ApiPatchIterationVersion[],
  requestedPatchVersionId: string | null,
): string | null {
  const requested =
    requestedPatchVersionId === null
      ? undefined
      : versions.find((version) => version.patchVersionId === requestedPatchVersionId);
  if (requested?.status === "playable") {
    return requested.patchVersionId;
  }
  for (let index = versions.length - 1; index >= 0; index -= 1) {
    const version = versions[index];
    if (version?.status === "playable") {
      return version.patchVersionId;
    }
  }
  return null;
}

function patchIterationVersionView(
  version: ApiPatchIterationVersion,
  localeBranchId: string,
  activePatch?: ApiPatchIterationPatch,
): PatchIterationVersionView {
  const unitCount =
    activePatch?.patchVersionId === version.patchVersionId ? activePatch.units.length : null;
  return {
    patchVersionId: version.patchVersionId,
    parentPatchVersionId: version.parentPatchVersionId,
    status: patchIterationVersionStatus(version.status),
    scopeSummary:
      unitCount === null
        ? `Run ${version.runId} · ${version.origin}`
        : `${unitCount} ${unitCount === 1 ? "unit" : "units"} · ${version.origin}`,
    openHref: patchIterationHref({
      localeBranchId,
      patchVersionId: version.patchVersionId,
    }),
    // The public iteration API intentionally exposes integrity hashes, not a
    // guessed archive URL. A play session is the exact historical delivery
    // entry point, so do not accidentally link an unrelated selected export.
    artifactHref: null,
  };
}

function patchIterationVersionStatus(status: string): PatchIterationVersionStatus {
  if (status === "playable") return "playable";
  if (status === "failed") return "failed";
  return "building";
}

const EMPTY_FEEDBACK_INBOX: PatchIterationFeedbackInboxView = {
  eventCount: 0,
  individualEventCount: 0,
  batches: [],
  individualEvents: [],
  selectedFeedbackEventIds: [],
  selectedFeedbackBatchIds: [],
};

function patchIterationFeedbackInboxView(
  inbox: ApiPatchIterationFeedbackInbox,
  activePatchVersionId: string,
  versions: readonly ApiPatchIterationVersion[],
): PatchIterationFeedbackInboxView {
  const activeLineagePatchVersionIds = patchVersionLineageIds(activePatchVersionId, versions);
  const batches = inbox.batches
    .filter((batch) => batch.selectionKind === "batch")
    .map((batch) => {
      const events = batch.events.map((event) => ({
        feedbackEventId: event.feedbackEventId,
        eventKind: event.eventKind,
        summary: patchIterationFeedbackSummary(event),
        refinementStatus: patchIterationFeedbackRefinementStatus(
          event,
          activeLineagePatchVersionIds,
        ),
      }));
      const refinementStatus = aggregateFeedbackRefinementStatus(
        events.map((event) => event.refinementStatus),
      );
      return {
        feedbackBatchId: batch.feedbackBatchId,
        status: batch.selectionKind,
        eventCount: batch.events.length,
        selected: refinementStatus === "refinable",
        label: batch.label,
        refinementStatus,
        events,
      };
    });
  const individualEvents = inbox.batches
    .filter((batch) => batch.selectionKind === "individual")
    .flatMap((batch) =>
      batch.events.map((event) => {
        const refinementStatus = patchIterationFeedbackRefinementStatus(
          event,
          activeLineagePatchVersionIds,
        );
        return {
          feedbackEventId: event.feedbackEventId,
          feedbackBatchId: batch.feedbackBatchId,
          eventKind: event.eventKind,
          summary: patchIterationFeedbackSummary(event),
          selected: refinementStatus === "refinable",
          refinementStatus,
        };
      }),
    );
  return {
    eventCount: inbox.batches.reduce((count, batch) => count + batch.events.length, 0),
    individualEventCount: individualEvents.length,
    batches,
    individualEvents,
    selectedFeedbackEventIds: individualEvents
      .filter((event) => event.selected)
      .map((event) => event.feedbackEventId),
    selectedFeedbackBatchIds: batches
      .filter((batch) => batch.selected)
      .map((batch) => batch.feedbackBatchId),
  };
}

function patchVersionLineageIds(
  activePatchVersionId: string,
  versions: readonly ApiPatchIterationVersion[],
): ReadonlySet<string> {
  const parentByPatchVersionId = new Map(
    versions.map((version) => [version.patchVersionId, version.parentPatchVersionId]),
  );
  const lineage = new Set<string>();
  let patchVersionId: string | null = activePatchVersionId;
  while (patchVersionId !== null && !lineage.has(patchVersionId)) {
    lineage.add(patchVersionId);
    patchVersionId = parentByPatchVersionId.get(patchVersionId) ?? null;
  }
  return lineage;
}

function patchIterationFeedbackRefinementStatus(
  event: ApiPatchIterationFeedbackInbox["batches"][number]["events"][number],
  activeLineagePatchVersionIds: ReadonlySet<string>,
): PatchIterationFeedbackRefinementStatus {
  if (event.eventKind === "result_edit") {
    const childPatchVersionId = event.metadata.resultRevisionPatchVersionId;
    if (
      typeof childPatchVersionId === "string" &&
      activeLineagePatchVersionIds.has(childPatchVersionId)
    ) {
      return "already_applied";
    }
    return "refinable";
  }
  // Current scoped comments and context feedback are backed by the canonical
  // WikiBrain head they caused. Older generic notes remain visible for audit,
  // but are not preselected because they have no safe durable redraft source.
  if (event.contextArtifactId === null || event.contextEntryVersionId === null) {
    return "needs_canonical_context";
  }
  // A legacy/reference-only context head has no request-time correction
  // receipt, so it remains a valid refinable input. A receipt that explicitly
  // reports any state other than success must match the server-side gate and
  // stay visible but disabled.
  const rerunState = patchIterationContextRerunState(event);
  if (rerunState !== null && rerunState !== "succeeded") {
    return "canonical_redraft_not_succeeded";
  }
  return "refinable";
}

function aggregateFeedbackRefinementStatus(
  statuses: readonly PatchIterationFeedbackRefinementStatus[],
): PatchIterationFeedbackRefinementStatus {
  // Batch selection is atomic: submitting a batch includes every event in it.
  // A failed/pending context receipt therefore blocks its otherwise
  // refinable siblings too, matching the server's all-selected-events gate.
  if (statuses.some((status) => status === "canonical_redraft_not_succeeded")) {
    return "canonical_redraft_not_succeeded";
  }
  if (statuses.some((status) => status === "refinable")) return "refinable";
  if (statuses.some((status) => status === "needs_canonical_context")) {
    return "needs_canonical_context";
  }
  return "already_applied";
}

/** Match the refinement service's distinction between legacy and failed receipts. */
function patchIterationContextRerunState(
  event: ApiPatchIterationFeedbackInbox["batches"][number]["events"][number],
): string | null {
  const correction = event.metadata.contextCorrection;
  if (!isRecord(correction)) return null;
  const rerun = correction.rerun;
  if (!isRecord(rerun)) return "unverified";
  return typeof rerun.state === "string" ? rerun.state : "unverified";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function patchIterationFeedbackSummary(
  event: ApiPatchIterationFeedbackInbox["batches"][number]["events"][number],
): string {
  if (event.body !== null && event.body.trim().length > 0) {
    return event.body;
  }
  const targetBody = event.metadata.targetBody;
  if (typeof targetBody === "string" && targetBody.trim().length > 0) {
    return targetBody;
  }
  return event.feedbackEventId;
}

function patchIterationQaCalloutView(
  callout: ApiPatchIterationPatch["qaCallouts"][number],
): PatchIterationQaCalloutView {
  const numericConfidence = Number(callout.confidence);
  return {
    id: callout.journalFindingId,
    contested: callout.contested,
    confidence:
      Number.isFinite(numericConfidence) && numericConfidence >= 0 && numericConfidence <= 1
        ? numericConfidence
        : null,
    note: `${callout.category}: ${callout.note}`,
  };
}

function apiErrorMessage(error: {
  code: string | null;
  message: string | null;
  status: number;
}): string {
  return `${error.code ?? "unavailable"}: ${error.message ?? `status ${error.status}`}`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
