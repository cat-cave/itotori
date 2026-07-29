// Entry-level deep-link panel: jumps from a wiki object to the scene(s)/unit(s)
// its provenance actually addresses. Renders nothing when no target resolves.

import { useEffect, useState, type ReactNode } from "react";
import { Badge, Panel } from "@itotori/ds";
import type { WikiSourceObjectView } from "../../../wiki/dashboard/read-model.js";
import type { WikiBibleScope } from "./client.js";
import {
  citedBridgeUnitIds,
  entryDeepLinkSourceFromView,
  resolveEntryPlayerTargets,
  type EntryPlayerTarget,
  type StructureAddressIndex,
} from "./entry-deeplink.js";
import { appendReturnToHref, bibleObjectHref } from "./player-link.js";
import { apiClient } from "../../client.js";
import { addressableFocusToken, hrefForAddressable } from "../../addressable-routing.js";

export function WikiEntryDeepLinkPanel({
  object,
  scope,
  structure = null,
}: {
  object: WikiSourceObjectView;
  scope: WikiBibleScope;
  structure?: StructureAddressIndex | null;
}): ReactNode {
  const source = entryDeepLinkSourceFromView(object);
  const unitIds = citedBridgeUnitIds(source);
  const structureTargets = resolveEntryPlayerTargets(
    source,
    { ...scope, objectId: object.objectId },
    structure,
  );
  const [verifiedTargets, setVerifiedTargets] = useState<readonly EntryPlayerTarget[]>([]);
  useEffect(() => {
    let active = true;
    void Promise.all(
      unitIds.map(async (bridgeUnitId) =>
        apiClient.request("play.addressableUnit", {
          pathParams: {
            projectId: scope.projectId,
            localeBranchId: scope.localeBranchId,
            bridgeUnitId,
          },
        }),
      ),
    ).then((results) => {
      if (!active) return;
      const returnHref = bibleObjectHref({ ...scope, objectId: object.objectId });
      const next: EntryPlayerTarget[] = [];
      for (const result of results) {
        if (result.state !== "ready" || result.data.unit.state !== "resolved") continue;
        const unit = result.data.unit;
        const href = hrefForAddressable({
          kind: "scene",
          id: unit.sceneId,
          unitId: unit.bridgeUnitId,
          projectId: scope.projectId,
          localeBranchId: scope.localeBranchId,
        });
        next.push({
          kind: "scene",
          id: unit.sceneId,
          unitId: unit.bridgeUnitId,
          source: "citation",
          href: appendReturnToHref(href, returnHref),
          focus: addressableFocusToken({ kind: "unit", id: unit.bridgeUnitId }),
        });
      }
      setVerifiedTargets(
        next.sort((a, b) => a.id.localeCompare(b.id) || a.unitId!.localeCompare(b.unitId!)),
      );
    });
    return () => {
      active = false;
    };
  }, [
    object.objectId,
    scope.projectId,
    scope.localeBranchId,
    scope.snapshotId,
    unitIds.join("\0"),
  ]);
  const targets = mergeEntryPlayerTargets(
    verifiedTargets,
    structureTargets.filter((target) => target.kind !== "unit"),
  );
  if (targets.length === 0) {
    return null;
  }
  const primary = targets[0] ?? null;
  if (primary === null) {
    return null;
  }
  return (
    <Panel
      title="Jump to scene"
      eyebrow={`${targets.length} addressable target${targets.length === 1 ? "" : "s"}`}
      lamps={
        <Badge status="active" data-testid="wiki-entry-deeplink-count">
          {targets.length}
        </Badge>
      }
      data-testid="wiki-entry-deeplink-panel"
      data-entry-deeplink-count={String(targets.length)}
      data-entry-primary-kind={primary.kind}
      data-entry-primary-id={primary.id}
    >
      <p className="wiki-bible__deeplink-lead">
        Derived from this entry&rsquo;s subject, citations, and media — not a text search.
      </p>
      <ul className="wiki-bible__entry-deeplinks" aria-label="Entry scene deep-links">
        {targets.map((target) => (
          <EntryDeepLinkItem key={`${target.kind}:${target.id}`} target={target} />
        ))}
      </ul>
    </Panel>
  );
}

function mergeEntryPlayerTargets(
  verifiedTargets: readonly EntryPlayerTarget[],
  structureTargets: readonly EntryPlayerTarget[],
): readonly EntryPlayerTarget[] {
  const byAddress = new Map<string, EntryPlayerTarget>();
  for (const target of [...verifiedTargets, ...structureTargets]) {
    const key = `${target.kind}:${target.id}`;
    if (!byAddress.has(key)) {
      byAddress.set(key, target);
    }
  }
  return [...byAddress.values()].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "scene" ? -1 : 1;
    }
    return left.id.localeCompare(right.id);
  });
}

function EntryDeepLinkItem({ target }: { target: EntryPlayerTarget }): ReactNode {
  return (
    <li
      data-entry-deeplink-kind={target.kind}
      data-entry-deeplink-id={target.id}
      data-entry-deeplink-source={target.source}
    >
      <a
        href={target.href}
        data-entry-player-jump={target.href}
        data-entry-player-focus={target.focus}
        data-jump-kind={target.kind}
        data-jump-id={target.id}
      >
        Jump to {target.kind} {target.id}
      </a>{" "}
      <span className="wiki-bible__deeplink-source">({target.source})</span>
    </li>
  );
}
