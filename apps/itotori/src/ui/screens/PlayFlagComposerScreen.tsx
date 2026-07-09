// play-flag-composer — Flag → review (AnnotationComposer).
//
// In-the-moment playtest note that creates a reviewer queue item. The form is
// the DS AnnotationComposer (severity-scaled via `--ito-severity-*` tokens).
// Submit is gated on canFlag (feedback.import) via CapsProvider / CapGated
// posture: denied actors see a disabled + explained composer.
//
// Backed by POST play.flagAnnotation → ManualFeedbackImport (same intake
// path workspace corrections use under the hood) which enqueues a
// reviewer-queue item when the flag is contextualized (bridge unit / scene).
//
// Rendered at `/play/flag`. Game-agnostic: project / branch / unit are query
// params or status fallbacks; no title is hardcoded.

import { useState, type ReactNode } from "react";
import { AnnotationComposer, Panel, type AnnotationComposerValue } from "@itotori/ds";
import type { ApiPlayFlagAnnotationResponse } from "../../api-schema.js";
import { apiClient } from "../client.js";
import { CapGatedButton, useCaps } from "../caps-context.js";
import { useApiQuery } from "../use-api-resource.js";
import { useWorkflowHandoffToasts } from "../workflow-handoff-toasts.js";
import { EmptyState, ErrorState, LoadingState, ShellHeader } from "../states.js";

export const playFlagComposerRoutePathRegex = /^\/play\/flag\/?$/u;

export type PlayFlagComposerRouteParams = {
  projectId: string | null;
  localeBranchId: string | null;
  bridgeUnitId: string | null;
  sceneId: string | null;
  targetLocale: string | null;
  sourceUnitKey: string | null;
};

export function parsePlayFlagComposerRoute(
  pathname: string,
  search: string,
): PlayFlagComposerRouteParams | null {
  if (!playFlagComposerRoutePathRegex.test(pathname)) {
    return null;
  }
  const params = new URLSearchParams(search);
  return {
    projectId: nonEmpty(params.get("projectId")),
    localeBranchId: nonEmpty(params.get("localeBranchId")),
    bridgeUnitId: nonEmpty(params.get("bridgeUnitId") ?? params.get("unitId")),
    sceneId: nonEmpty(params.get("sceneId")),
    targetLocale: nonEmpty(params.get("targetLocale")),
    sourceUnitKey: nonEmpty(params.get("sourceUnitKey")),
  };
}

function nonEmpty(value: string | null): string | null {
  if (value === null || value.trim().length === 0) {
    return null;
  }
  return value.trim();
}

export function PlayFlagComposerScreen({
  route,
}: {
  route: PlayFlagComposerRouteParams;
}): ReactNode {
  if (route.projectId !== null && route.localeBranchId !== null) {
    return (
      <PlayFlagComposerForBranch
        projectId={route.projectId}
        localeBranchId={route.localeBranchId}
        bridgeUnitId={route.bridgeUnitId}
        sceneId={route.sceneId}
        targetLocale={route.targetLocale}
        sourceUnitKey={route.sourceUnitKey}
      />
    );
  }
  return <PlayFlagComposerFromStatus route={route} />;
}

function PlayFlagComposerFromStatus({ route }: { route: PlayFlagComposerRouteParams }): ReactNode {
  const status = useApiQuery("projects.status", {}, "play-flag:status");
  if (status.state === "loading") {
    return (
      <main className="itotori-shell play-flag" data-screen="play-flag" data-state="loading">
        <ShellHeader eyebrow="Play" title="Flag to review" />
        <LoadingState label="Loading project context…" />
      </main>
    );
  }
  if (status.state === "error") {
    return (
      <main className="itotori-shell play-flag" data-screen="play-flag" data-state="error">
        <ShellHeader eyebrow="Play" title="Flag to review" />
        <ErrorState title="Flag composer" error={status.error} />
      </main>
    );
  }
  const projectId = status.state === "ready" ? status.data.projectId : null;
  const localeBranchId = status.state === "ready" ? status.data.selectedLocaleBranchId : null;
  if (projectId === null || localeBranchId === null) {
    return (
      <main className="itotori-shell play-flag" data-screen="play-flag" data-state="empty">
        <ShellHeader eyebrow="Play" title="Flag to review" />
        <EmptyState
          title="No project context"
          message="Select a project and locale branch to compose a playtest flag."
        />
      </main>
    );
  }
  return (
    <PlayFlagComposerForBranch
      projectId={projectId}
      localeBranchId={localeBranchId}
      bridgeUnitId={route.bridgeUnitId}
      sceneId={route.sceneId}
      targetLocale={route.targetLocale}
      sourceUnitKey={route.sourceUnitKey}
    />
  );
}

type FlagOutcome =
  | { kind: "ok"; response: ApiPlayFlagAnnotationResponse }
  | { kind: "error"; message: string };

function PlayFlagComposerForBranch({
  projectId,
  localeBranchId,
  bridgeUnitId,
  sceneId,
  targetLocale,
  sourceUnitKey,
}: {
  projectId: string;
  localeBranchId: string;
  bridgeUnitId: string | null;
  sceneId: string | null;
  targetLocale: string | null;
  sourceUnitKey: string | null;
}): ReactNode {
  const caps = useCaps();
  const flagGate = caps.cap("flag");
  const { notifyHandoff } = useWorkflowHandoffToasts();
  const [outcome, setOutcome] = useState<FlagOutcome | null>(null);
  const [pending, setPending] = useState(false);

  const resolvedLocale = targetLocale ?? "en-US";
  const contextParts = [
    sceneId !== null ? `scene ${sceneId}` : null,
    bridgeUnitId !== null ? `unit ${bridgeUnitId}` : null,
  ].filter((part): part is string => part !== null);
  const contextLabel = contextParts.length > 0 ? contextParts.join(" · ") : null;

  async function submitFlag(value: AnnotationComposerValue): Promise<void> {
    if (!flagGate.allowed || pending) {
      return;
    }
    setOutcome(null);
    setPending(true);
    const result = await apiClient.request("play.flagAnnotation", {
      pathParams: { projectId, localeBranchId },
      body: {
        note: value.note,
        severity: value.severity,
        targetLocale: resolvedLocale,
        ...(value.category.length > 0 ? { category: value.category } : {}),
        ...(bridgeUnitId !== null ? { bridgeUnitId } : {}),
        ...(sourceUnitKey !== null ? { sourceUnitKey } : {}),
        ...(sceneId !== null ? { sceneId } : {}),
        actorUserId: caps.actorUserId,
      },
    });
    if (result.state === "ready") {
      setOutcome({ kind: "ok", response: result.data });
      notifyHandoff({
        kind: "flag-sent",
        severity: result.data.severity,
        category: result.data.category.length > 0 ? result.data.category : "playtest",
      });
    } else if (result.state === "error") {
      const code = result.error.code ?? "unavailable";
      const detail = result.error.message ?? `status ${result.error.status}`;
      setOutcome({ kind: "error", message: `${code}: ${detail}` });
    } else {
      setOutcome({ kind: "error", message: "Unexpected empty response" });
    }
    setPending(false);
  }

  return (
    <main
      className="itotori-shell play-flag"
      data-screen="play-flag"
      data-state="ready"
      data-project-id={projectId}
      data-locale-branch-id={localeBranchId}
      data-can-flag={flagGate.allowed ? "true" : "false"}
    >
      <ShellHeader eyebrow="Play" title="Flag to review">
        <p
          className="itotori-eyebrow"
          data-project-id={projectId}
          data-locale-branch-id={localeBranchId}
        >
          {projectId} · {localeBranchId}
        </p>
      </ShellHeader>
      <section className="play-flag__body" aria-label="Playtest flag composer">
        <Panel
          title="Annotation"
          eyebrow="In-the-moment note → reviewer queue"
          className="play-flag__panel"
          data-pane-id="flag-composer"
        >
          {!flagGate.allowed && (
            <p role="status" data-cap-denial="flag" className="play-flag__denial">
              {flagGate.reason ?? "Flagging requires feedback.import"}
            </p>
          )}
          <AnnotationComposer
            onSubmit={submitFlag}
            disabled={!flagGate.allowed || pending}
            disabledReason={flagGate.reason}
            contextLabel={contextLabel}
            submitLabel="Send to review"
          />
          {/* CapGatedButton mirrors the composer submit gate for a11y audit. */}
          <div className="play-flag__cap-mirror" hidden>
            <CapGatedButton capability="flag">Send to review</CapGatedButton>
          </div>
          {outcome?.kind === "ok" && (
            <p
              role="status"
              data-flag-outcome="ok"
              data-queue-enqueued={outcome.response.queueEnqueued ? "true" : "false"}
              data-severity={outcome.response.severity}
              className="play-flag__status"
            >
              Flag sent to review · {outcome.response.severity}
              {outcome.response.category.length > 0 ? ` · ${outcome.response.category}` : ""}
              {outcome.response.queueEnqueued ? " · queued" : " · needs context"}
            </p>
          )}
          {outcome?.kind === "error" && (
            <p role="alert" data-flag-outcome="error" className="play-flag__status">
              {outcome.message}
            </p>
          )}
        </Panel>
      </section>
    </main>
  );
}
