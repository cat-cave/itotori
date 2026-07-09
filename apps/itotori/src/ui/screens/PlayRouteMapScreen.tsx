// play-mark-validated + play-routemap-ui — the Play RouteMap route/choice
// tree with per-scene localization coverage (needs_check / flagged /
// validated).
//
// Loads `play.routeMap` for the route/choice tree and `play.sceneCoverage` for
// durable validation state. The tree stays route-choice-map shaped
// (col/row/state/coverage/issues), while the selected route can still be marked
// validated / flagged / needs_check through `play.setSceneCoverage`.

import { useState, type ReactNode } from "react";
import { Badge, Panel, RouteMap, type RouteMapNode } from "@itotori/ds";
import type {
  ApiPlayRouteMapResponse,
  ApiPlaySceneCoverageResponse,
  ApiSceneCoverageState,
} from "../../api-schema.js";
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
        <LoadingState label="Loading project context..." />
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
          message="Select a locale branch to view the route/choice tree."
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
  const model = useApiQuery(
    "play.routeMap",
    { pathParams: { projectId, localeBranchId } },
    `play-routemap:tree:${projectId}:${localeBranchId}`,
  );
  const coverage = useApiQuery(
    "play.sceneCoverage",
    { pathParams: { projectId, localeBranchId } },
    `play-routemap:coverage:${projectId}:${localeBranchId}:${reloadKey}`,
  );

  const state =
    model.state === "error" || coverage.state === "error"
      ? "error"
      : model.state === "loading" || coverage.state === "loading"
        ? "loading"
        : model.state === "empty"
          ? "empty"
          : "ready";

  return (
    <main
      className="itotori-shell play-routemap"
      data-screen="play-routemap"
      data-state={state}
      data-locale-branch-id={localeBranchId}
    >
      <ShellHeader eyebrow="Play" title="Route map" />
      {state === "loading" && <LoadingState label="Loading route map..." />}
      {state === "empty" && (
        <EmptyState
          title="No routes on the map"
          message="No route-map nodes were returned for this locale branch."
        />
      )}
      {model.state === "error" && <ErrorState title="Route map" error={model.error} />}
      {model.state !== "error" && coverage.state === "error" && (
        <ErrorState title="Route map coverage" error={coverage.error} />
      )}
      {model.state === "ready" && state === "ready" && (
        <PlayRouteMapReady
          model={model.data}
          coverage={coverage.state === "ready" ? coverage.data : null}
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
  coverage,
  projectId,
  localeBranchId,
  onCoverageChanged,
}: {
  model: ApiPlayRouteMapResponse;
  coverage: ApiPlaySceneCoverageResponse | null;
  projectId: string;
  localeBranchId: string;
  onCoverageChanged: () => void;
}): ReactNode {
  const firstId = model.nodes[0]?.routeKey ?? null;
  const [selectedRouteKey, setSelectedRouteKey] = useState<string | null>(firstId);
  const selected =
    model.nodes.find((node) => node.routeKey === selectedRouteKey) ?? model.nodes[0] ?? null;
  const coverageByScene = new Map(coverage?.nodes.map((node) => [node.sceneId, node]) ?? []);
  const validationCounts = coverage?.counts ?? {
    validated: 0,
    flagged: 0,
    needsCheck: model.nodes.length,
    total: model.nodes.length,
  };

  const nodes: RouteMapNode[] = model.nodes.map((node) => {
    const sceneCoverage = coverageByScene.get(node.routeKey)?.coverageState ?? "needs_check";
    return {
      id: node.routeKey,
      label: node.label,
      col: node.col,
      row: node.row,
      state: node.state,
      coverage: node.coverage,
      sceneCoverageState: sceneCoverage,
      issues: node.issues,
    };
  });
  const edges = model.edges.map((edge, index) => ({
    key: `${edge.choiceKey}:${edge.fromRouteKey}:${edge.toRouteKey}:${index}`,
    fromId: edge.fromRouteKey,
    toId: edge.toRouteKey,
    label: edge.label,
  }));
  const selectedCoverage =
    selected !== null
      ? (coverageByScene.get(selected.routeKey)?.coverageState ?? "needs_check")
      : "needs_check";

  return (
    <section className="play-routemap__body" aria-label="Play route map">
      <Panel
        title="Coverage"
        eyebrow={`${model.counts.fresh} fresh · ${model.counts.stale} stale · ${validationCounts.validated} validated`}
        className="play-routemap__counts"
        data-fresh-count={model.counts.fresh}
        data-stale-count={model.counts.stale}
        data-choice-count={model.counts.choiceCount}
        data-total-count={model.counts.total}
        data-validated-count={validationCounts.validated}
        data-flagged-count={validationCounts.flagged}
        data-needs-check-count={validationCounts.needsCheck}
      >
        <p className="play-routemap__summary">
          <Badge status="fresh" tone="ok">
            fresh {model.counts.fresh}
          </Badge>{" "}
          <Badge status="stale" tone="neutral">
            stale {model.counts.stale}
          </Badge>{" "}
          <Badge status="validated" tone="ok">
            validated {validationCounts.validated}
          </Badge>{" "}
          <Badge status="flagged" tone="critical">
            flagged {validationCounts.flagged}
          </Badge>{" "}
          <Badge status="needs_check" tone="neutral">
            needs_check {validationCounts.needsCheck}
          </Badge>
        </p>
      </Panel>

      <Panel
        title="Route map"
        eyebrow={`${model.nodes.length} route(s)`}
        className="play-routemap__map"
      >
        <RouteMap
          nodes={nodes}
          edges={edges}
          activeId={selected?.routeKey ?? null}
          onSelect={setSelectedRouteKey}
          label="Localization route map"
        />
      </Panel>

      {selected !== null && (
        <>
          <Panel
            title={selected.label}
            eyebrow={`Route ${selected.routeKey} · ${selected.coverage}`}
            className="play-routemap__detail"
            data-selected-route-key={selected.routeKey}
            data-selected-coverage={selected.coverage}
            data-selected-scene-coverage={selectedCoverage}
            data-selected-col={selected.col}
            data-selected-row={selected.row}
            data-selected-issues={selected.issues}
          >
            <p className="play-routemap__detail-summary">{selected.summary}</p>
            <p className="play-routemap__detail-meta">
              <code>{selected.routeMapId}</code>
              {" · "}
              col {selected.col} / row {selected.row}
              {selected.issues > 0 ? ` · ${selected.issues} issue(s)` : ""}
            </p>
          </Panel>
          <MarkCoverageStrip
            sceneId={selected.routeKey}
            label={selected.label}
            coverageState={selectedCoverage}
            projectId={projectId}
            localeBranchId={localeBranchId}
            onCoverageChanged={onCoverageChanged}
          />
        </>
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
          {pending ? "Saving..." : "Mark validated"}
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
