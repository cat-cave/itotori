// play-mark-validated + play-routemap-ui — the Play RouteMap with per-scene
// localization coverage (needs_check / flagged / validated).
//
// Loads `play.sceneCoverage` through the typed client, paints nodes via the
// `@itotori/ds` RouteMap, and lets the user set a scene's coverage state via
// `play.setSceneCoverage` (Mark validated / Flag / Needs check). Coverage
// PERSISTS server-side; after a successful write the screen reloads the map so
// the RouteMap reflects the new state.
//
// Rendered INSIDE the shell frame at `/play/routemap`. Game-agnostic: no
// title is hardcoded; project/branch come from query or projects.status.

import { useState, type ReactNode } from "react";
import { Badge, Panel, RouteMap, type RouteMapNode } from "@itotori/ds";
import type { ApiPlaySceneCoverageResponse, ApiSceneCoverageState } from "../../api-schema.js";
import { apiClient } from "../client.js";
import { useApiQuery } from "../use-api-resource.js";
import { EmptyState, ErrorState, LoadingState, ShellHeader } from "../states.js";

export const playRouteMapRoutePathRegex = /^\/play\/routemap\/?$/u;

export type PlayRouteMapRouteParams = {
  projectId: string | null;
  localeBranchId: string | null;
};

export function parsePlayRouteMapRoute(
  pathname: string,
  search: string,
): PlayRouteMapRouteParams | null {
  if (!playRouteMapRoutePathRegex.test(pathname)) {
    return null;
  }
  const params = new URLSearchParams(search);
  return {
    projectId: nonEmpty(params.get("projectId")),
    localeBranchId: nonEmpty(params.get("localeBranchId")),
  };
}

function nonEmpty(value: string | null): string | null {
  if (value === null || value.trim().length === 0) {
    return null;
  }
  return value;
}

export function PlayRouteMapScreen({ route }: { route: PlayRouteMapRouteParams }): ReactNode {
  if (route.projectId !== null && route.localeBranchId !== null) {
    return (
      <PlayRouteMapForBranch projectId={route.projectId} localeBranchId={route.localeBranchId} />
    );
  }
  return <PlayRouteMapFromStatus />;
}

function PlayRouteMapFromStatus(): ReactNode {
  const status = useApiQuery("projects.status", {}, "play-routemap:status");
  if (status.state === "loading") {
    return (
      <main
        className="itotori-shell play-routemap"
        data-screen="play-routemap"
        data-state="loading"
      >
        <ShellHeader eyebrow="Play" title="Route map" />
        <LoadingState label="Loading project context…" />
      </main>
    );
  }
  if (status.state === "error") {
    return (
      <main className="itotori-shell play-routemap" data-screen="play-routemap" data-state="error">
        <ShellHeader eyebrow="Play" title="Route map" />
        <ErrorState title="Route map" error={status.error} />
      </main>
    );
  }
  const projectId = status.state === "ready" ? status.data.projectId : null;
  const localeBranchId = status.state === "ready" ? status.data.selectedLocaleBranchId : null;
  if (projectId === null || localeBranchId === null) {
    return (
      <main className="itotori-shell play-routemap" data-screen="play-routemap" data-state="empty">
        <ShellHeader eyebrow="Play" title="Route map" />
        <EmptyState
          title="No locale branch selected"
          message="Select a locale branch to view scene coverage on the route map."
        />
      </main>
    );
  }
  return <PlayRouteMapForBranch projectId={projectId} localeBranchId={localeBranchId} />;
}

function PlayRouteMapForBranch({
  projectId,
  localeBranchId,
}: {
  projectId: string;
  localeBranchId: string;
}): ReactNode {
  const [reloadKey, setReloadKey] = useState(0);
  const coverage = useApiQuery(
    "play.sceneCoverage",
    { pathParams: { projectId, localeBranchId } },
    `play-routemap:coverage:${projectId}:${localeBranchId}:${reloadKey}`,
  );

  return (
    <main
      className="itotori-shell play-routemap"
      data-screen="play-routemap"
      data-state={coverage.state}
      data-locale-branch-id={localeBranchId}
    >
      <ShellHeader eyebrow="Play" title="Route map" />
      {coverage.state === "loading" && <LoadingState label="Loading route map coverage…" />}
      {coverage.state === "empty" && (
        <EmptyState
          title="No scenes on the route map"
          message="No route-map nodes or coverage rows were returned for this locale branch."
        />
      )}
      {coverage.state === "error" && <ErrorState title="Route map" error={coverage.error} />}
      {coverage.state === "ready" && (
        <PlayRouteMapReady
          model={coverage.data}
          projectId={projectId}
          localeBranchId={localeBranchId}
          onCoverageChanged={() => setReloadKey((k) => k + 1)}
        />
      )}
    </main>
  );
}

function PlayRouteMapReady({
  model,
  projectId,
  localeBranchId,
  onCoverageChanged,
}: {
  model: ApiPlaySceneCoverageResponse;
  projectId: string;
  localeBranchId: string;
  onCoverageChanged: () => void;
}): ReactNode {
  const firstId = model.nodes[0]?.sceneId ?? null;
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(firstId);
  const selected =
    model.nodes.find((node) => node.sceneId === selectedSceneId) ?? model.nodes[0] ?? null;

  const nodes: RouteMapNode[] = model.nodes.map((node) => ({
    id: node.sceneId,
    label: node.label,
    coverageState: node.coverageState,
  }));
  const edges = model.edges.map((edge, index) => ({
    key: `${edge.choiceKey}:${edge.fromSceneId}:${edge.toSceneId}:${index}`,
    fromId: edge.fromSceneId,
    toId: edge.toSceneId,
    label: edge.label,
  }));

  return (
    <section className="play-routemap__body" aria-label="Play route map coverage">
      <Panel
        title="Coverage"
        eyebrow={`${model.counts.validated} validated · ${model.counts.flagged} flagged · ${model.counts.needsCheck} needs check`}
        className="play-routemap__counts"
        data-validated-count={model.counts.validated}
        data-flagged-count={model.counts.flagged}
        data-needs-check-count={model.counts.needsCheck}
      >
        <p className="play-routemap__summary">
          <Badge status="validated" tone="ok">
            validated {model.counts.validated}
          </Badge>{" "}
          <Badge status="flagged" tone="critical">
            flagged {model.counts.flagged}
          </Badge>{" "}
          <Badge status="needs_check" tone="neutral">
            needs_check {model.counts.needsCheck}
          </Badge>
        </p>
      </Panel>

      <Panel
        title="Route map"
        eyebrow={`${model.nodes.length} scene(s)`}
        className="play-routemap__map"
      >
        <RouteMap
          nodes={nodes}
          edges={edges}
          activeId={selected?.sceneId ?? null}
          onSelect={setSelectedSceneId}
          label="Localization route map"
        />
      </Panel>

      {selected !== null && (
        <MarkCoverageStrip
          sceneId={selected.sceneId}
          label={selected.label}
          coverageState={selected.coverageState}
          projectId={projectId}
          localeBranchId={localeBranchId}
          onCoverageChanged={onCoverageChanged}
        />
      )}
    </section>
  );
}

type MarkOutcome =
  | { kind: "ok"; coverageState: ApiSceneCoverageState }
  | { kind: "error"; message: string };

function MarkCoverageStrip({
  sceneId,
  label,
  coverageState,
  projectId,
  localeBranchId,
  onCoverageChanged,
}: {
  sceneId: string;
  label: string;
  coverageState: ApiSceneCoverageState;
  projectId: string;
  localeBranchId: string;
  onCoverageChanged: () => void;
}): ReactNode {
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<MarkOutcome | null>(null);

  async function setCoverage(next: ApiSceneCoverageState): Promise<void> {
    if (pending) {
      return;
    }
    setOutcome(null);
    setPending(true);
    const result = await apiClient.request("play.setSceneCoverage", {
      pathParams: { projectId, localeBranchId },
      body: { sceneId, coverageState: next },
    });
    if (result.state === "ready") {
      setOutcome({ kind: "ok", coverageState: result.data.coverageState });
      onCoverageChanged();
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
    <Panel
      title={label}
      eyebrow={`Scene ${sceneId} · ${coverageState}`}
      className="play-routemap__mark"
      data-selected-scene-id={sceneId}
      data-selected-coverage={coverageState}
    >
      <div
        className="play-routemap__actions"
        data-strip="mark-coverage"
        data-busy={pending ? "true" : "false"}
      >
        <button
          type="button"
          data-action="mark-validated"
          disabled={pending || coverageState === "validated"}
          aria-disabled={pending || coverageState === "validated"}
          onClick={() => {
            void setCoverage("validated");
          }}
        >
          {pending ? "Saving…" : "Mark validated"}
        </button>
        <button
          type="button"
          data-action="mark-flagged"
          disabled={pending || coverageState === "flagged"}
          onClick={() => {
            void setCoverage("flagged");
          }}
        >
          Flag
        </button>
        <button
          type="button"
          data-action="mark-needs-check"
          disabled={pending || coverageState === "needs_check"}
          onClick={() => {
            void setCoverage("needs_check");
          }}
        >
          Needs check
        </button>
      </div>
      {outcome?.kind === "ok" && (
        <p role="status" data-mark-coverage="ok" className="play-routemap__status">
          Scene marked {outcome.coverageState}.
        </p>
      )}
      {outcome?.kind === "error" && (
        <p role="alert" data-mark-coverage="error" className="play-routemap__status">
          {outcome.message}
        </p>
      )}
    </Panel>
  );
}
