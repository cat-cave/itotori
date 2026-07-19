// The compact `/wiki` browse surface.  It addresses the new WikiObject API by
// snapshot; source truth has no locale-branch prerequisite.

import { Panel } from "@itotori/ds";
import type { ReactNode } from "react";
import { useApiQuery } from "../use-api-resource.js";
import { EmptyState, ErrorState, LoadingState, ShellHeader } from "../states.js";

export const wikiRoutePathRegex = /^\/wiki\/?$/u;

export type WikiEntryRouteParams = {
  snapshotId: string | null;
  focusKind: "character" | "term" | null;
  focusEntryId: string | null;
};

export function parseWikiRoute(pathname: string, search: string): WikiEntryRouteParams | null {
  if (!wikiRoutePathRegex.test(pathname)) return null;
  const params = new URLSearchParams(search);
  return {
    snapshotId: nonEmpty(params.get("snapshotId")),
    focusKind: null,
    focusEntryId: nonEmpty(params.get("objectId")),
  };
}

export function wikiRouteFromAddressable(location: {
  kind: "character" | "term";
  id: string;
}): WikiEntryRouteParams {
  return {
    snapshotId: null,
    focusKind: location.kind,
    focusEntryId: entryIdFor(location.kind, location.id),
  };
}

export function entryIdFor(kind: "character" | "term", id: string): string {
  return `${kind}:${id}`;
}

export function WikiEntryScreen({ route }: { route: WikiEntryRouteParams }): ReactNode {
  if (route.snapshotId === null) {
    return (
      <main className="itotori-shell wiki-entry" data-screen="wiki-entry" data-state="empty">
        <ShellHeader eyebrow="Wiki" title="Source wiki" />
        <Panel title="Select a source snapshot" eyebrow="WikiObject">
          <p>The source Wiki is snapshot-addressed and does not require a locale branch.</p>
        </Panel>
      </main>
    );
  }
  return <WikiObjectList snapshotId={route.snapshotId} focusEntryId={route.focusEntryId} />;
}

function WikiObjectList({
  snapshotId,
  focusEntryId,
}: {
  snapshotId: string;
  focusEntryId: string | null;
}): ReactNode {
  const result = useApiQuery("wiki.list", { query: { snapshotId } }, `wiki:${snapshotId}`);
  if (result.state === "loading") return <LoadingState label="Loading source wiki" />;
  if (result.state === "error")
    return <ErrorState title="Source wiki unavailable" error={result.error} />;
  if (result.state === "empty")
    return <EmptyState title="No WikiObjects" message="This snapshot has no source WikiObjects." />;
  const objects = result.data.sourceObjects;
  return (
    <main className="itotori-shell wiki-entry" data-screen="wiki-entry" data-state="ready">
      <ShellHeader eyebrow="Wiki" title="Source wiki" />
      <Panel title="Source WikiObjects" eyebrow={`${objects.length} objects`}>
        <ul>
          {objects.map((object) => (
            <li
              key={object.kind === "source" ? object.objectId : object.renderingId}
              data-focused={object.kind === "source" && object.objectId === focusEntryId}
            >
              {object.kind === "source" ? (
                <a
                  href={`/wiki?snapshotId=${encodeURIComponent(snapshotId)}&objectId=${encodeURIComponent(object.objectId)}`}
                >
                  {object.category}: {object.objectId}
                </a>
              ) : (
                `${object.category}: ${object.renderingId}`
              )}
            </li>
          ))}
        </ul>
      </Panel>
    </main>
  );
}

function nonEmpty(value: string | null): string | null {
  return value === null || value.trim().length === 0 ? null : value;
}
