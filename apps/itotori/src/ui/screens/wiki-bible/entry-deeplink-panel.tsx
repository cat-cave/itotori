// Entry-level deep-link panel: jumps from a wiki object to the scene(s)/unit(s)
// its provenance actually addresses. Renders nothing when no target resolves.

import type { ReactNode } from "react";
import { Badge, Panel } from "@itotori/ds";
import type { WikiSourceObjectView } from "../../../wiki/dashboard/read-model.js";
import type { WikiBibleScope } from "./client.js";
import {
  entryDeepLinkSourceFromView,
  primaryEntryPlayerTarget,
  resolveEntryPlayerTargets,
  type EntryPlayerTarget,
  type StructureAddressIndex,
} from "./entry-deeplink.js";
import { citationScopeFor } from "./player-link.js";

export function WikiEntryDeepLinkPanel({
  object,
  scope,
  structure = null,
}: {
  object: WikiSourceObjectView;
  scope: WikiBibleScope;
  structure?: StructureAddressIndex | null;
}): ReactNode {
  const targets = resolveEntryPlayerTargets(
    entryDeepLinkSourceFromView(object),
    citationScopeFor(scope, object.objectId),
    structure,
  );
  if (targets.length === 0) {
    return null;
  }
  const primary = primaryEntryPlayerTarget(targets);
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
