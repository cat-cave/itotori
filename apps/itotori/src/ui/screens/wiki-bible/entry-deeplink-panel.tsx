// Entry-level deep-link panel: jumps from a wiki object to the scene(s)/unit(s)
// its provenance actually addresses. Renders nothing when no target resolves.

import type { ReactNode } from "react";
import { Badge, Panel } from "@itotori/ds";
import type { WikiSourceObjectView } from "../../../wiki/dashboard/read-model.js";
import { useApiQueryWhen } from "../../use-api-resource.js";
import type { WikiBibleScope } from "./client.js";
import {
  citedBridgeUnitIds,
  primaryEntryPlayerTarget,
  resolveVerifiedEntrySceneTargets,
  type EntryPlayerTarget,
  type EntryDeepLinkSource,
  type VerifiedSceneTarget,
} from "./entry-deeplink.js";
import { citationScopeFor } from "./player-link.js";

/** Fetch project-scoped proof before exposing a navigation link. An empty
 * response means the cited coordinates do not address this imported project,
 * so the entry intentionally renders no dead deep-link. */
export function VerifiedWikiEntryDeepLinkPanel({
  object,
  scope,
}: {
  object: WikiSourceObjectView;
  scope: WikiBibleScope;
}): ReactNode {
  const entry: EntryDeepLinkSource = {
    subject: object.subject,
    citations: object.citations,
    claims: object.claims,
    media: entryMedia(object),
  };
  const bridgeUnitIds = citedBridgeUnitIds(entry);
  const resolved = useApiQueryWhen(
    "play.sceneTargets",
    {
      pathParams: { projectId: scope.projectId, localeBranchId: scope.localeBranchId },
      query: { bridgeUnitId: bridgeUnitIds },
    },
    `wiki-entry-scene-targets:${scope.projectId}:${scope.localeBranchId}:${bridgeUnitIds.join(",")}`,
    bridgeUnitIds.length > 0,
  );
  if (resolved.state !== "ready") return null;
  return (
    <WikiEntryDeepLinkPanel object={object} scope={scope} verifiedTargets={resolved.data.targets} />
  );
}

export function WikiEntryDeepLinkPanel({
  object,
  scope,
  verifiedTargets,
}: {
  object: WikiSourceObjectView;
  scope: WikiBibleScope;
  /** Supplied by the project-scoped resolver; no unchecked URL is rendered. */
  verifiedTargets: readonly VerifiedSceneTarget[];
}): ReactNode {
  const entry: EntryDeepLinkSource = {
    subject: object.subject,
    citations: object.citations,
    claims: object.claims,
    media: entryMedia(object),
  };
  const targets = resolveVerifiedEntrySceneTargets(
    entry,
    citationScopeFor(scope, object.objectId),
    verifiedTargets,
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
        Verified against this project&rsquo;s imported bridge from this entry&rsquo;s citation
        coordinates.
      </p>
      <ul className="wiki-bible__entry-deeplinks" aria-label="Entry scene deep-links">
        {targets.map((target) => (
          <EntryDeepLinkItem key={`${target.kind}:${target.id}`} target={target} />
        ))}
      </ul>
    </Panel>
  );
}

function entryMedia(object: WikiSourceObjectView): NonNullable<EntryDeepLinkSource["media"]> {
  return object.media.map((media) => ({
    kind: media.kind,
    ...("sceneId" in media ? { sceneId: media.sceneId } : {}),
    ...("unitId" in media && media.unitId !== undefined ? { unitId: media.unitId } : {}),
  }));
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
