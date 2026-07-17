// play-routemap-ui — read-only RouteMap from canonical route/choice context.
//
// The former per-scene verification controls were a reviewer-adjacent terminal
// state: they could report success without changing a result revision or
// canonical context. The RouteMap now stays a pure view of the real artifacts;
// corrections start at the canonical flag,
// wiki or result-revision surfaces instead.

import { useState, type ReactNode } from "react";
import { Badge, Panel, RouteMap, type RouteMapNode } from "@itotori/ds";
import type { ApiPlayRouteMapResponse } from "../../api-schema.js";
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
  const model = useApiQuery(
    "play.routeMap",
    { pathParams: { projectId, localeBranchId } },
    `play-routemap:tree:${projectId}:${localeBranchId}`,
  );

  const state =
    model.state === "error"
      ? "error"
      : model.state === "loading"
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
      {model.state === "ready" && state === "ready" && <PlayRouteMapReady model={model.data} />}
    </main>
  );
}

function PlayRouteMapReady({ model }: { model: ApiPlayRouteMapResponse }): ReactNode {
  const firstId = model.nodes[0]?.routeKey ?? null;
  const [selectedRouteKey, setSelectedRouteKey] = useState<string | null>(firstId);
  const selected =
    model.nodes.find((node) => node.routeKey === selectedRouteKey) ?? model.nodes[0] ?? null;
  const nodes: RouteMapNode[] = model.nodes.map((node) => ({
    id: node.routeKey,
    label: node.label,
    col: node.col,
    row: node.row,
    state: node.state,
    coverage: node.coverage,
    issues: node.issues,
  }));
  const edges = model.edges.map((edge, index) => ({
    key: `${edge.choiceKey}:${edge.fromRouteKey}:${edge.toRouteKey}:${index}`,
    fromId: edge.fromRouteKey,
    toId: edge.toRouteKey,
    label: edge.label,
  }));

  return (
    <section className="play-routemap__body" aria-label="Play route map">
      <Panel
        title="Context freshness"
        eyebrow={`${model.counts.fresh} fresh · ${model.counts.stale} stale`}
        className="play-routemap__counts"
        data-fresh-count={model.counts.fresh}
        data-stale-count={model.counts.stale}
        data-choice-count={model.counts.choiceCount}
        data-total-count={model.counts.total}
      >
        <p className="play-routemap__summary">
          <Badge status="fresh" tone="ok">
            fresh {model.counts.fresh}
          </Badge>{" "}
          <Badge status="stale" tone="neutral">
            stale {model.counts.stale}
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
        <Panel
          title={selected.label}
          eyebrow={`Route ${selected.routeKey} · ${selected.coverage}`}
          className="play-routemap__detail"
          data-selected-route-key={selected.routeKey}
          data-selected-coverage={selected.coverage}
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
      )}
    </section>
  );
}
