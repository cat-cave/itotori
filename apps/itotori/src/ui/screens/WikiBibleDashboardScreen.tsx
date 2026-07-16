// The Wiki bible dashboard — the product surface for the shared project brain.
//
// It is Wiki-FIRST: the source bible and its localized renderings ARE the
// artifact, browsable by object, filterable by route, and correctable in place.
// Everything is read from the wiki object read/write API (never the old
// context-artifact worker): source vs localized-bible claims, canonical vs
// route-specific claims under an enforced route toggle, default-redacted media,
// immutable history, downstream impact, coverage/readiness, and the
// limited-context / test badges. Every real citation is a deep-link into the
// Utsushi player at the exact scene/unit; a correction returns the tester to the
// object they addressed.

import { useMemo, useState, type ReactNode } from "react";
import { Badge, NavPills, Panel, StatReadout, type NavPillItem } from "@itotori/ds";
import { ShellHeader } from "../states.js";
import { useWikiBibleObject, useWikiBibleOverview } from "./wiki-bible/hooks.js";
import { WikiBibleObjectPanel, type WikiBibleViewMode } from "./wiki-bible/object-panel.js";
import { WikiBibleWriteForms } from "./wiki-bible/write-forms.js";
import type { WikiBibleObjectRef, WikiBibleScope } from "./wiki-bible/client.js";
import type {
  WikiDashboardOverview,
  WikiDashboardWriteReceipt,
  WikiRenderingView,
  WikiSourceObjectView,
} from "../../wiki/dashboard/read-model.js";

export const wikiBibleRoutePathRegex = /^\/bible\/?$/u;

export interface WikiBibleRouteParams {
  readonly projectId: string | null;
  readonly localeBranchId: string | null;
  readonly snapshotId: string | null;
  readonly objectId: string | null;
  readonly wikiKind: string | null;
}

export function parseWikiBibleRoute(pathname: string, search: string): WikiBibleRouteParams | null {
  if (!wikiBibleRoutePathRegex.test(pathname)) {
    return null;
  }
  const params = new URLSearchParams(search);
  return {
    projectId: nonEmpty(params.get("projectId")),
    localeBranchId: nonEmpty(params.get("localeBranchId")),
    snapshotId: nonEmpty(params.get("snapshotId")),
    objectId: nonEmpty(params.get("objectId")),
    wikiKind: nonEmpty(params.get("wikiKind")),
  };
}

export function WikiBibleDashboardScreen({ route }: { route: WikiBibleRouteParams }): ReactNode {
  if (route.projectId === null || route.localeBranchId === null || route.snapshotId === null) {
    return (
      <main className="itotori-shell wiki-bible" data-screen="wiki-bible" data-state="empty">
        <ShellHeader eyebrow="Wiki bible" title="Wiki bible" />
        <Panel title="Select a snapshot" eyebrow="Project brain">
          <p>
            Choose a project, locale branch, and context snapshot to browse the shared wiki bible.
          </p>
        </Panel>
      </main>
    );
  }
  const scope: WikiBibleScope = {
    projectId: route.projectId,
    localeBranchId: route.localeBranchId,
    snapshotId: route.snapshotId,
  };
  return <WikiBibleReady scope={scope} route={route} />;
}

function WikiBibleReady({
  scope,
  route,
}: {
  scope: WikiBibleScope;
  route: WikiBibleRouteParams;
}): ReactNode {
  const overview = useWikiBibleOverview(scope, 0);
  return (
    <main
      className="itotori-shell wiki-bible"
      data-screen="wiki-bible"
      data-state={overview.state}
      data-snapshot-id={scope.snapshotId}
    >
      <ShellHeader eyebrow="Wiki bible" title="Shared project brain" />
      {overview.state === "loading" && <p>Loading the wiki bible…</p>}
      {overview.state === "error" && (
        <Panel title="Wiki bible" eyebrow="Error">
          <p role="alert">{overview.message}</p>
        </Panel>
      )}
      {overview.state === "ready" && (
        <WikiBibleBody scope={scope} route={route} overview={overview.data} />
      )}
    </main>
  );
}

function WikiBibleBody({
  scope,
  route,
  overview,
}: {
  scope: WikiBibleScope;
  route: WikiBibleRouteParams;
  overview: WikiDashboardOverview;
}): ReactNode {
  // A write refreshes ONLY the addressed object's detail (its new head, history,
  // and impact); the overview stays mounted so the receipt notice and the
  // tester's place in the surface are preserved.
  const [detailRefreshKey, setDetailRefreshKey] = useState(0);
  const initialObjectId = route.objectId ?? overview.sourceObjects[0]?.objectId ?? "";
  const [selectedObjectId, setSelectedObjectId] = useState(initialObjectId);
  const [activeRouteId, setActiveRouteId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<WikiBibleViewMode>("source");
  const [receipt, setReceipt] = useState<WikiDashboardWriteReceipt | null>(null);

  const selected = useMemo(
    () =>
      overview.sourceObjects.find((object) => object.objectId === selectedObjectId) ??
      overview.sourceObjects[0] ??
      null,
    [overview.sourceObjects, selectedObjectId],
  );
  const rendering = useMemo(
    () => findRendering(overview.renderings, selected),
    [overview.renderings, selected],
  );
  const objectRef: WikiBibleObjectRef | null = selected
    ? { objectId: selected.objectId, wikiKind: selected.wikiKind }
    : null;
  const detail = useWikiBibleObject(scope, objectRef, detailRefreshKey);

  // A write returns the tester to the object they addressed: re-select it and
  // re-read its detail so the new head, history, and downstream impact refresh.
  function onWritten(written: WikiDashboardWriteReceipt): void {
    setReceipt(written);
    setSelectedObjectId(written.addressedObjectId);
    setDetailRefreshKey((current) => current + 1);
  }

  return (
    <div className="wiki-bible__grid" data-selected-object-id={selected?.objectId ?? ""}>
      <ReadinessBand overview={overview} />
      <RouteToggleBar
        overview={overview}
        activeRouteId={activeRouteId}
        onSelect={setActiveRouteId}
      />
      <ViewModeToggle
        viewMode={viewMode}
        onSelect={setViewMode}
        hasRendering={rendering !== null}
      />
      <ObjectIndex
        objects={overview.sourceObjects}
        selectedObjectId={selected?.objectId ?? ""}
        onSelect={setSelectedObjectId}
      />
      {receipt !== null && <WriteReceiptBanner receipt={receipt} />}
      {selected === null ? (
        <Panel title="No source objects" eyebrow="Wiki bible">
          <p>This snapshot has no source wiki objects yet.</p>
        </Panel>
      ) : (
        <>
          <WikiBibleObjectPanel
            object={selected}
            rendering={rendering}
            detail={detail}
            activeRouteId={activeRouteId}
            viewMode={viewMode}
            scope={scope}
          />
          <WikiBibleWriteForms object={selected} scope={scope} onWritten={onWritten} />
        </>
      )}
    </div>
  );
}

function ReadinessBand({ overview }: { overview: WikiDashboardOverview }): ReactNode {
  const { readiness } = overview;
  return (
    <Panel
      title="Readiness"
      eyebrow="Coverage of the shared brain"
      className="wiki-bible__readiness"
    >
      <div className="wiki-bible__stats" role="group" aria-label="Readiness">
        <StatReadout label="Source objects" value={readiness.sourceObjectCount} />
        <StatReadout
          label="Localized"
          value={`${readiness.localizationCoveragePercent}%`}
          delta={`${readiness.localizedSourceCount}/${readiness.sourceObjectCount}`}
          deltaTone="neutral"
        />
        <StatReadout label="Provisional" value={readiness.provisionalSourceCount} />
        <StatReadout label="Limited context" value={readiness.limitedContextCount} />
        <StatReadout label="Test / pilot" value={readiness.testModeCount} />
      </div>
    </Panel>
  );
}

function RouteToggleBar({
  overview,
  activeRouteId,
  onSelect,
}: {
  overview: WikiDashboardOverview;
  activeRouteId: string | null;
  onSelect: (routeId: string | null) => void;
}): ReactNode {
  return (
    <Panel
      title="Route"
      eyebrow="Canonical vs route-specific claims"
      className="wiki-bible__routes"
    >
      <div role="group" aria-label="Route toggles" className="wiki-bible__route-toggles">
        <button
          type="button"
          data-route-toggle="canonical"
          aria-pressed={activeRouteId === null}
          onClick={() => onSelect(null)}
        >
          Canonical only
        </button>
        {overview.routes.map((facet) => (
          <button
            key={facet.routeId}
            type="button"
            data-route-toggle={facet.routeId}
            aria-pressed={activeRouteId === facet.routeId}
            onClick={() => onSelect(facet.routeId)}
          >
            {facet.routeId} ({facet.claimCount})
          </button>
        ))}
      </div>
    </Panel>
  );
}

function ViewModeToggle({
  viewMode,
  onSelect,
  hasRendering,
}: {
  viewMode: WikiBibleViewMode;
  onSelect: (mode: WikiBibleViewMode) => void;
  hasRendering: boolean;
}): ReactNode {
  return (
    <div role="group" aria-label="View mode" className="wiki-bible__view-toggle">
      <button
        type="button"
        data-view-toggle="source"
        aria-pressed={viewMode === "source"}
        onClick={() => onSelect("source")}
      >
        Source
      </button>
      <button
        type="button"
        data-view-toggle="bible"
        aria-pressed={viewMode === "bible"}
        onClick={() => onSelect("bible")}
      >
        Localized bible{hasRendering ? "" : " (none yet)"}
      </button>
    </div>
  );
}

function ObjectIndex({
  objects,
  selectedObjectId,
  onSelect,
}: {
  objects: readonly WikiSourceObjectView[];
  selectedObjectId: string;
  onSelect: (objectId: string) => void;
}): ReactNode {
  const items: NavPillItem[] = objects.map((object) => ({
    id: object.objectId,
    label: `${object.subject.id}`,
    badge: object.category,
  }));
  return (
    <Panel
      title="Bible index"
      eyebrow={`${objects.length} source object${objects.length === 1 ? "" : "s"}`}
    >
      <NavPills
        items={items}
        activeId={selectedObjectId}
        onSelect={onSelect}
        label="Source objects"
        className="wiki-bible__index"
      />
    </Panel>
  );
}

function WriteReceiptBanner({ receipt }: { receipt: WikiDashboardWriteReceipt }): ReactNode {
  return (
    <Panel
      title="Correction recorded"
      eyebrow="Returned to your object"
      data-testid="wiki-bible-receipt"
      data-addressed-object-id={receipt.addressedObjectId}
    >
      <p>
        Human input <code>{receipt.inputId}</code> landed on{" "}
        <code>{receipt.addressedObjectId}</code> (now v{receipt.head.version}).
      </p>
      <p>
        {receipt.invalidatedObjectIds.length === 0
          ? "No downstream renderings were invalidated."
          : `${receipt.invalidatedObjectIds.length} downstream rendering(s) invalidated for refresh.`}
      </p>
      <Badge status={receipt.badges.provisional ? "pending" : "active"}>
        {receipt.badges.provisional ? "provisional head" : "confirmed head"}
      </Badge>
    </Panel>
  );
}

function findRendering(
  renderings: readonly WikiRenderingView[],
  selected: WikiSourceObjectView | null,
): WikiRenderingView | null {
  if (selected === null) {
    return null;
  }
  return renderings.find((rendering) => rendering.sourceObjectId === selected.objectId) ?? null;
}

function nonEmpty(value: string | null): string | null {
  return value === null || value.trim().length === 0 ? null : value;
}
