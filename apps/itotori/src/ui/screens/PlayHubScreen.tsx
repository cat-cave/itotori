// play-hub-ui — the Play landing surface.
//
// Bare `/play` is the durable handoff from the shell nav and onboarding. It
// keeps the two existing Play reads independently inspectable: exact patch
// version history and canonical route/choice context. Detailed interaction
// remains in the existing Route map and Flag a correction screens.

import type { ReactNode } from "react";
import { Badge, DataTable, Panel, StatReadout } from "@itotori/ds";
import type { ApiCallState } from "../../api-client.js";
import type {
  ApiPatchIterationVersionsResponse,
  ApiPlayRouteMapResponse,
} from "../../api-schema.js";
import { useApiQuery } from "../use-api-resource.js";
import { EmptyState, ErrorState, LoadingState, ShellHeader } from "../states.js";

export const playHubRoutePathRegex = /^\/play\/?$/u;

export type PlayHubRouteParams = {
  projectId: string | null;
  localeBranchId: string | null;
};

export function parsePlayHubRoute(pathname: string, search: string): PlayHubRouteParams | null {
  if (!playHubRoutePathRegex.test(pathname)) {
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
  return value.trim();
}

export function PlayHubScreen({ route }: { route: PlayHubRouteParams }): ReactNode {
  if (route.projectId !== null && route.localeBranchId !== null) {
    return <PlayHubForBranch projectId={route.projectId} localeBranchId={route.localeBranchId} />;
  }
  return <PlayHubFromStatus route={route} />;
}

function PlayHubFromStatus({ route }: { route: PlayHubRouteParams }): ReactNode {
  const status = useApiQuery("projects.status", {}, "play-hub:status");
  if (status.state === "loading") {
    return (
      <main className="itotori-shell play-hub" data-screen="play-hub" data-state="loading">
        <ShellHeader eyebrow="Play" title="Play hub" />
        <LoadingState label="Loading project context..." />
      </main>
    );
  }
  if (status.state === "error") {
    return (
      <main className="itotori-shell play-hub" data-screen="play-hub" data-state="error">
        <ShellHeader eyebrow="Play" title="Play hub" />
        <ErrorState title="Play hub" error={status.error} />
      </main>
    );
  }
  const projectId = route.projectId ?? (status.state === "ready" ? status.data.projectId : null);
  const localeBranchId =
    route.localeBranchId ?? (status.state === "ready" ? status.data.selectedLocaleBranchId : null);
  if (projectId === null || localeBranchId === null) {
    return (
      <main className="itotori-shell play-hub" data-screen="play-hub" data-state="empty">
        <ShellHeader eyebrow="Play" title="Play hub" />
        <EmptyState
          title="No locale branch selected"
          message="Select a project and locale branch to inspect playable patches and route context."
        />
      </main>
    );
  }
  return <PlayHubForBranch projectId={projectId} localeBranchId={localeBranchId} />;
}

function PlayHubForBranch({
  projectId,
  localeBranchId,
}: {
  projectId: string;
  localeBranchId: string;
}): ReactNode {
  const versions = useApiQuery(
    "patchIteration.versions",
    { pathParams: { localeBranchId } },
    `play-hub:versions:${localeBranchId}`,
  );
  const routeMap = useApiQuery(
    "play.routeMap",
    { pathParams: { projectId, localeBranchId } },
    `play-hub:route-map:${projectId}:${localeBranchId}`,
  );
  const routeMapHref = playHref("/play/routemap", projectId, localeBranchId);
  const flagHref = playHref("/play/flag", projectId, localeBranchId);

  return (
    <main
      className="itotori-shell play-hub"
      data-screen="play-hub"
      data-state={hubState(versions, routeMap)}
      data-project-id={projectId}
      data-locale-branch-id={localeBranchId}
    >
      <ShellHeader eyebrow="Play" title="Play hub">
        <p className="itotori-shell__lede">
          Inspect exact patch versions and route context before recording a correction.
        </p>
      </ShellHeader>
      <section className="itotori-section-grid" aria-label="Play hub sections">
        <PatchVersionsPanel versions={versions} />
        <RouteCoveragePanel routeMap={routeMap} routeMapHref={routeMapHref} />
        <Panel title="Play tools" eyebrow="Context actions" className="play-hub__tools">
          <p>
            Follow the route tree for context or open the correction composer for a persisted line.
          </p>
          <p>
            <a href={routeMapHref}>Open route map</a>
          </p>
          <p>
            <a href={flagHref}>Flag a correction</a>
          </p>
        </Panel>
      </section>
    </main>
  );
}

function hubState(
  versions: ApiCallState<ApiPatchIterationVersionsResponse>,
  routeMap: ApiCallState<ApiPlayRouteMapResponse>,
): "loading" | "ready" | "empty" | "error" {
  if (versions.state === "loading" || routeMap.state === "loading") {
    return "loading";
  }
  if (versions.state === "error" && routeMap.state === "error") {
    return "error";
  }
  if (versions.state === "empty" && routeMap.state === "empty") {
    return "empty";
  }
  return "ready";
}

function PatchVersionsPanel({
  versions,
}: {
  versions: ApiCallState<ApiPatchIterationVersionsResponse>;
}): ReactNode {
  return (
    <Panel title="Patch versions" eyebrow="Exact play history" className="play-hub__versions">
      {versions.state === "loading" && <LoadingState label="Loading patch versions..." />}
      {versions.state === "empty" && (
        <EmptyState
          title="No patch versions"
          message="No durable patch versions were returned for this locale branch."
        />
      )}
      {versions.state === "error" && <ErrorState title="Patch versions" error={versions.error} />}
      {versions.state === "ready" && <PatchVersionsContent versions={versions.data} />}
    </Panel>
  );
}

function PatchVersionsContent({
  versions,
}: {
  versions: ApiPatchIterationVersionsResponse;
}): ReactNode {
  const playable = versions.versions.filter((version) => version.playableAt !== null).length;
  const selected = versions.versions.filter((version) => version.selectedAt !== null).length;
  return (
    <>
      <div className="itotori-metric-row" aria-label="Patch version aggregate">
        <StatReadout label="Versions" value={versions.versions.length} />
        <StatReadout label="Playable" value={playable} />
        <StatReadout label="Selected" value={selected} />
      </div>
      <DataTable
        caption="Patch versions"
        columns={[
          {
            key: "version",
            header: "Patch version",
            render: (version) => <code>{version.patchVersionId}</code>,
          },
          {
            key: "status",
            header: "Status / origin",
            render: (version) => (
              <span>
                <Badge status={version.status}>{version.status.replaceAll("_", " ")}</Badge>{" "}
                <Badge status={version.origin}>{version.origin.replaceAll("_", " ")}</Badge>
              </span>
            ),
          },
          {
            key: "lineage",
            header: "Run / base",
            render: (version) => (
              <span>
                <code>{version.runId}</code>
                <br />
                {version.basePatchVersionId ?? version.parentPatchVersionId ?? "root version"}
              </span>
            ),
          },
          {
            key: "playable",
            header: "Play surface",
            render: (version) => (
              <Badge
                status={version.playableAt === null ? "pending" : "playable"}
                tone={version.playableAt === null ? "neutral" : "ok"}
              >
                {version.playableAt === null ? "not playable" : "playable"}
              </Badge>
            ),
          },
        ]}
        rows={versions.versions}
        getRowKey={(version) => version.patchVersionId}
      />
    </>
  );
}

function RouteCoveragePanel({
  routeMap,
  routeMapHref,
}: {
  routeMap: ApiCallState<ApiPlayRouteMapResponse>;
  routeMapHref: string;
}): ReactNode {
  return (
    <Panel title="Route coverage" eyebrow="Choice context" className="play-hub__route-map">
      {routeMap.state === "loading" && <LoadingState label="Loading route coverage..." />}
      {routeMap.state === "empty" && (
        <EmptyState
          title="No routes on the map"
          message="No route-map nodes were returned for this locale branch."
        />
      )}
      {routeMap.state === "error" && <ErrorState title="Route coverage" error={routeMap.error} />}
      {routeMap.state === "ready" && (
        <RouteCoverageContent routeMap={routeMap.data} routeMapHref={routeMapHref} />
      )}
    </Panel>
  );
}

function RouteCoverageContent({
  routeMap,
  routeMapHref,
}: {
  routeMap: ApiPlayRouteMapResponse;
  routeMapHref: string;
}): ReactNode {
  return (
    <>
      <div className="itotori-metric-row" aria-label="Route coverage aggregate">
        <StatReadout label="Routes" value={routeMap.counts.total} />
        <StatReadout label="Choices" value={routeMap.counts.choiceCount} />
        <StatReadout label="Fresh" value={routeMap.counts.fresh} />
        <StatReadout label="Stale" value={routeMap.counts.stale} />
      </div>
      <DataTable
        caption="Route coverage"
        columns={[
          {
            key: "route",
            header: "Route",
            render: (node) => (
              <span>
                {node.label}
                <br />
                <code>{node.routeKey}</code>
              </span>
            ),
          },
          {
            key: "coverage",
            header: "Coverage",
            render: (node) => (
              <Badge status={node.coverage} tone={node.coverage === "fresh" ? "ok" : "neutral"}>
                {node.coverage}
              </Badge>
            ),
          },
          {
            key: "issues",
            header: "Issues",
            align: "end",
            render: (node) => (
              <Badge status={node.issues > 0 ? "warning" : "fresh"}>{node.issues}</Badge>
            ),
          },
          { key: "summary", header: "Context", render: (node) => node.summary },
        ]}
        rows={routeMap.nodes}
        getRowKey={(node) => node.routeKey}
      />
      <p>
        <a href={routeMapHref}>Inspect the full route map</a>
      </p>
    </>
  );
}

function playHref(pathname: string, projectId: string, localeBranchId: string): string {
  const params = new URLSearchParams({ projectId, localeBranchId });
  return `${pathname}?${params.toString()}`;
}
