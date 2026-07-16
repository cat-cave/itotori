// The selected-object detail of the Wiki bible dashboard.
//
// It renders the addressed object under the active route toggle: its badges
// (provisional / limited-context / test-mode), the source vs localized-bible
// claim views, the canonical vs route-specific claims (an out-of-route claim is
// NOT rendered — `visibleClaims` is the enforced filter), each claim's citations
// as Utsushi player deep-links, its media (default-redacted), and its immutable
// history + downstream dependents. The write forms close the loop back onto this
// object.

import { type ReactNode } from "react";
import { Badge, ComparisonPane, DataTable, Panel } from "@itotori/ds";
import {
  isCanonicalClaim,
  routeScopeRouteIds,
  visibleClaims,
  type WikiClaimView,
  type WikiDashboardObject,
  type WikiObjectView,
  type WikiRenderingView,
  type WikiSourceObjectView,
} from "../../../wiki/dashboard/read-model.js";
import { isLimitedContext, isTestMode } from "../../../wiki/dashboard/read-model.js";
import { RedactedFrame } from "../../redaction-governor.js";
import { citationDeepLink } from "./player-link.js";
import type { AsyncState } from "./hooks.js";
import type { WikiBibleScope } from "./client.js";

export type WikiBibleViewMode = "source" | "bible";

export function WikiBibleObjectPanel({
  object,
  rendering,
  detail,
  activeRouteId,
  viewMode,
  scope,
}: {
  object: WikiObjectView;
  rendering: WikiRenderingView | null;
  detail: AsyncState<WikiDashboardObject>;
  activeRouteId: string | null;
  viewMode: WikiBibleViewMode;
  scope: WikiBibleScope;
}): ReactNode {
  if (object.kind !== "source") {
    return (
      <Panel title="Rendering" eyebrow="Localized bible entry">
        <p>Select a source object to inspect its canonical claims and localized bible.</p>
      </Panel>
    );
  }
  return (
    <section
      className="wiki-bible__detail"
      aria-label="Selected wiki object"
      data-object-id={object.objectId}
      data-wiki-kind={object.wikiKind}
      data-view-mode={viewMode}
      data-active-route={activeRouteId ?? "canonical"}
    >
      <ObjectHeader object={object} />
      <ClaimsPanel
        object={object}
        rendering={rendering}
        activeRouteId={activeRouteId}
        viewMode={viewMode}
        scope={scope}
      />
      <MediaPanel object={object} />
      <HistoryPanel detail={detail} />
      <DependentsPanel detail={detail} />
    </section>
  );
}

function ObjectHeader({ object }: { object: WikiSourceObjectView }): ReactNode {
  return (
    <Panel
      title={`${object.subject.kind}: ${object.subject.id}`}
      eyebrow={object.category}
      lamps={
        <>
          <Badge status={object.badges.provisional ? "pending" : "active"}>
            {object.badges.provisional ? "provisional" : "confirmed"}
          </Badge>
          {isLimitedContext(object.badges) && (
            <Badge status="warning" data-badge="limited-context">
              limited context
            </Badge>
          )}
          {isTestMode(object.badges) && (
            <Badge status="info" data-badge="test-mode">
              {object.badges.runMode}
            </Badge>
          )}
        </>
      }
    >
      <dl className="wiki-bible__facts">
        <div>
          <dt>Object</dt>
          <dd>
            <code>{object.objectId}</code> · v{object.version}
          </dd>
        </div>
        <div>
          <dt>Object scope</dt>
          <dd>{scopeLabel(object.routeScope)}</dd>
        </div>
        <div>
          <dt>Context scope</dt>
          <dd>{object.badges.contextScope ?? "whole-game"}</dd>
        </div>
      </dl>
    </Panel>
  );
}

function ClaimsPanel({
  object,
  rendering,
  activeRouteId,
  viewMode,
  scope,
}: {
  object: WikiSourceObjectView;
  rendering: WikiRenderingView | null;
  activeRouteId: string | null;
  viewMode: WikiBibleViewMode;
  scope: WikiBibleScope;
}): ReactNode {
  const shown = visibleClaims(object.claims, activeRouteId);
  const renderingText = new Map(
    (rendering?.claimRenderings ?? []).map((claim) => [claim.claimId, claim.text]),
  );
  return (
    <Panel
      title={viewMode === "bible" ? "Localized bible" : "Source claims"}
      eyebrow={`${shown.length} claim${shown.length === 1 ? "" : "s"} under ${activeRouteId ?? "canonical"}`}
      lamps={
        <Badge status="info" data-testid="wiki-bible-visible-claim-count">
          {shown.length} shown
        </Badge>
      }
    >
      {viewMode === "bible" && rendering === null && (
        <p data-testid="wiki-bible-no-rendering">
          No localized bible rendering exists for this object yet.
        </p>
      )}
      <ul
        className="wiki-bible__claims"
        aria-label="Claims"
        data-visible-claim-ids={shown.map((claim) => claim.claimId).join(",")}
      >
        {shown.map((claim) => (
          <li
            key={claim.claimId}
            className="wiki-bible__claim"
            data-claim-id={claim.claimId}
            data-claim-scope={claim.scope.kind}
            data-claim-canonical={isCanonicalClaim(claim) ? "true" : "false"}
          >
            <div className="wiki-bible__claim-head">
              <ClaimScopeBadge claim={claim} />
              <Badge status="neutral">{claim.confidence}</Badge>
            </div>
            {viewMode === "bible" ? (
              <ComparisonPane
                source={claim.statement}
                draft={renderingText.get(claim.claimId) ?? "— not yet localized —"}
                sourceLabel="Source"
                draftLabel={`Bible · ${rendering?.targetLanguage ?? "target"}`}
                unit={claim.claimId}
              />
            ) : (
              <p className="wiki-bible__claim-statement">{claim.statement}</p>
            )}
            <CitationList claim={claim} scope={scope} />
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function ClaimScopeBadge({ claim }: { claim: WikiClaimView }): ReactNode {
  if (isCanonicalClaim(claim)) {
    return <Badge status="active">canonical</Badge>;
  }
  return (
    <Badge status="info" data-badge="route-specific">
      route: {routeScopeRouteIds(claim.scope).join(", ")}
    </Badge>
  );
}

function CitationList({
  claim,
  scope,
}: {
  claim: WikiClaimView;
  scope: WikiBibleScope;
}): ReactNode {
  if (claim.citations.length === 0) {
    return null;
  }
  return (
    <ul className="wiki-bible__citations" aria-label={`Citations for ${claim.claimId}`}>
      {claim.citations.map((citation) => {
        const link = citationDeepLink(citation, scope);
        const key = `${citation.evidenceId}:${citation.subject.kind}:${citation.subject.id}`;
        if (link === null) {
          return (
            <li key={key}>
              <code>
                {citation.subject.kind}:{citation.subject.id}
              </code>{" "}
              ({citation.role})
            </li>
          );
        }
        return (
          <li key={key}>
            <a
              href={link.href}
              data-citation-jump={link.href}
              data-citation-focus={link.focus}
              {...(link.isPlayer ? { "data-citation-player-jump": link.href } : {})}
            >
              open {citation.subject.kind} {citation.subject.id} in {link.surface}
            </a>{" "}
            ({citation.role})
          </li>
        );
      })}
    </ul>
  );
}

function MediaPanel({ object }: { object: WikiSourceObjectView }): ReactNode {
  if (object.media.length === 0) {
    return null;
  }
  return (
    <Panel title="Media" eyebrow="Portraits, screenshots, and CGs (default-redacted)">
      <ul className="wiki-bible__media" aria-label="Media">
        {object.media.map((ref) => {
          const sensitive =
            ref.availability.status === "available" &&
            ref.availability.access.redaction === "default-redacted";
          return (
            <li key={ref.mediaId} data-media-id={ref.mediaId} data-media-kind={ref.kind}>
              <RedactedFrame
                sensitive={sensitive}
                label={`${ref.kind} — ${ref.availability.status}`}
              >
                <figure className="wiki-bible__frame" data-media-status={ref.availability.status}>
                  <figcaption>
                    <code>{ref.mediaId}</code> · {ref.kind}
                  </figcaption>
                </figure>
              </RedactedFrame>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function HistoryPanel({ detail }: { detail: AsyncState<WikiDashboardObject> }): ReactNode {
  return (
    <Panel title="History" eyebrow="Immutable version lineage">
      {detail.state === "loading" && <p>Loading history…</p>}
      {detail.state === "error" && <p role="alert">{detail.message}</p>}
      {detail.state === "ready" && (
        <DataTable
          caption="Version history"
          columns={[
            { key: "version", header: "Version", render: (entry) => <code>v{entry.version}</code> },
            {
              key: "supersedes",
              header: "Supersedes",
              render: (entry) =>
                entry.supersedesVersion === null ? "—" : `v${entry.supersedesVersion}`,
            },
            { key: "editedBy", header: "Edited by", render: (entry) => entry.editedBy ?? "run" },
            {
              key: "provisional",
              header: "State",
              render: (entry) => (entry.provisional ? "provisional" : "confirmed"),
            },
            { key: "hash", header: "Content", render: (entry) => <code>{entry.contentHash}</code> },
          ]}
          rows={[...detail.data.history]}
          getRowKey={(entry) => `${entry.version}:${entry.contentHash}`}
          emptyLabel="No versions were returned for this object."
        />
      )}
    </Panel>
  );
}

function DependentsPanel({ detail }: { detail: AsyncState<WikiDashboardObject> }): ReactNode {
  if (detail.state !== "ready") {
    return null;
  }
  return (
    <Panel
      title="Downstream"
      eyebrow={`${detail.data.dependents.length} consumer${detail.data.dependents.length === 1 ? "" : "s"}`}
    >
      <DataTable
        caption="Downstream consumers"
        columns={[
          {
            key: "object",
            header: "Object",
            render: (dep) => <code>{dep.downstreamObjectId}</code>,
          },
          { key: "kind", header: "Kind", render: (dep) => dep.downstreamWikiKind },
          {
            key: "protected",
            header: "Human",
            render: (dep) => (dep.protectedHuman ? "protected" : "machine"),
          },
        ]}
        rows={[...detail.data.dependents]}
        getRowKey={(dep) => `${dep.downstreamObjectId}:${dep.downstreamVersion}`}
        emptyLabel="No downstream consumers depend on this object yet."
      />
    </Panel>
  );
}

function scopeLabel(scope: WikiSourceObjectView["routeScope"]): string {
  if (scope.kind === "global") {
    return "canonical (global)";
  }
  return `route: ${routeScopeRouteIds(scope).join(", ")}`;
}
