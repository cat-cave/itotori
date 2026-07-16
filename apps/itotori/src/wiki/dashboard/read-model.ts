// The Wiki bible dashboard read-models — the product-surface projection of the
// wiki object read/write API. Every type here is a pure VIEW of what the object
// API already resolved from the trusted substrate (source objects, per-target
// localized renderings, per-claim route scope, media, history, badges). This
// module has NO runtime dependency on the database, zod contracts, or any agent
// surface: it is `import type` for the view shapes plus pure derivation, so the
// SAME read-models compile into the browser client bundle and the server handler.
//
// Route scope is the enforcement key of the whole surface: a claim scoped to a
// route is HIDDEN when that route is not the active toggle. `isClaimVisibleUnderRoute`
// is that rule, and the dashboard renders `visibleClaims(...)` only — an
// out-of-route claim is never in the DOM under the wrong toggle.

import type {
  WikiBadges,
  WikiClaimView,
  WikiHeadReceipt,
  WikiHistoryEntry,
  WikiObjectView,
  WikiRenderingView,
  WikiRouteScope,
  WikiSourceObjectView,
} from "../object-api/index.js";
import type { WikiDependentView } from "../object-api/service.js";

export type {
  WikiBadges,
  WikiCitationView,
  WikiClaimView,
  WikiHeadReceipt,
  WikiHistoryEntry,
  WikiObjectView,
  WikiRenderingView,
  WikiRouteScope,
  WikiSourceObjectView,
} from "../object-api/index.js";
export type { WikiDependentView } from "../object-api/service.js";

export const WIKI_DASHBOARD_OVERVIEW_SCHEMA = "itotori.wiki-dashboard.overview.v1" as const;
export const WIKI_DASHBOARD_OBJECT_SCHEMA = "itotori.wiki-dashboard.object.v1" as const;
export const WIKI_DASHBOARD_WRITE_SCHEMA = "itotori.wiki-dashboard.write.v1" as const;

/** The coverage / readiness summary a viewer reads at a glance: how much of the
 * source truth is drafted vs still provisional, how much has a localized bible,
 * and how many objects were written under a limited context or a non-production
 * (test / pilot) run mode. */
export interface WikiDashboardReadiness {
  readonly sourceObjectCount: number;
  readonly renderingCount: number;
  readonly provisionalSourceCount: number;
  readonly provisionalRenderingCount: number;
  /** Source objects that already have at least one localized rendering. */
  readonly localizedSourceCount: number;
  /** localizedSourceCount / sourceObjectCount as an integer percent (0 when no source). */
  readonly localizationCoveragePercent: number;
  /** Objects written under a narrowed / externally-augmented context scope. */
  readonly limitedContextCount: number;
  /** Objects written under a non-production (pilot / test-dev) run mode. */
  readonly testModeCount: number;
}

/** One route facet the toggle bar offers: the route id and how many claims are
 * scoped to it (directly or via a route-set). */
export interface WikiDashboardRouteFacet {
  readonly routeId: string;
  readonly claimCount: number;
}

/** The dashboard overview: the source bible, its localized renderings, the route
 * facets the toggle bar renders, and the readiness summary. */
export interface WikiDashboardOverview {
  readonly schemaVersion: typeof WIKI_DASHBOARD_OVERVIEW_SCHEMA;
  readonly generatedAt: string;
  readonly snapshotId: string;
  readonly sourceObjects: readonly WikiSourceObjectView[];
  readonly renderings: readonly WikiRenderingView[];
  readonly routes: readonly WikiDashboardRouteFacet[];
  readonly readiness: WikiDashboardReadiness;
}

/** One addressed object: the resolved view (with per-claim scope, citations, and
 * media), its immutable history, and its downstream dependents. The localized
 * bible rendering that localizes a source object is correlated by the surface
 * from the overview's renderings, so the detail stays a single object read. */
export interface WikiDashboardObject {
  readonly schemaVersion: typeof WIKI_DASHBOARD_OBJECT_SCHEMA;
  readonly generatedAt: string;
  readonly snapshotId: string;
  readonly object: WikiObjectView;
  readonly history: readonly WikiHistoryEntry[];
  readonly dependents: readonly WikiDependentView[];
}

/** The immediate receipt an edit / feedback returns. `addressedObjectId` is the
 * object the loop closes on: the surface re-selects it so a play tester's
 * correction returns them to exactly what they addressed. */
export interface WikiDashboardWriteReceipt {
  readonly schemaVersion: typeof WIKI_DASHBOARD_WRITE_SCHEMA;
  readonly generatedAt: string;
  readonly inputId: string;
  readonly addressedObjectId: string;
  readonly addressedWikiKind: string;
  readonly head: WikiHeadReceipt;
  readonly object: WikiObjectView;
  readonly badges: WikiBadges;
  readonly invalidatedObjectIds: readonly string[];
}

/** The route ids a scope holds under: none for a canonical (global) scope. */
export function routeScopeRouteIds(scope: WikiRouteScope): readonly string[] {
  switch (scope.kind) {
    case "global":
      return [];
    case "route":
      return [scope.routeId];
    case "route-set":
      return scope.routeIds;
  }
}

/** Whether a claim (or object) at `scope` is visible under the active route
 * toggle. `activeRouteId === null` is the canonical-only view: ONLY global
 * scope is visible. A route toggle reveals global claims plus the claims scoped
 * to that route; a claim scoped to a DIFFERENT route stays hidden. This is the
 * enforced rule the surface renders against — never a cosmetic dimming. */
export function isClaimVisibleUnderRoute(
  scope: WikiRouteScope,
  activeRouteId: string | null,
): boolean {
  if (scope.kind === "global") {
    return true;
  }
  if (activeRouteId === null) {
    return false;
  }
  return routeScopeRouteIds(scope).includes(activeRouteId);
}

/** The claims visible under the active route toggle, in input order. */
export function visibleClaims(
  claims: readonly WikiClaimView[],
  activeRouteId: string | null,
): readonly WikiClaimView[] {
  return claims.filter((claim) => isClaimVisibleUnderRoute(claim.scope, activeRouteId));
}

/** Whether a claim is canonical (holds across every route). */
export function isCanonicalClaim(claim: WikiClaimView): boolean {
  return claim.scope.kind === "global";
}

/** The distinct route facets referenced by any source object's claims, sorted by
 * route id, each carrying the number of claims scoped to it. */
export function buildRouteFacets(
  sourceObjects: readonly WikiSourceObjectView[],
): WikiDashboardRouteFacet[] {
  const counts = new Map<string, number>();
  for (const object of sourceObjects) {
    for (const claim of object.claims) {
      for (const routeId of routeScopeRouteIds(claim.scope)) {
        counts.set(routeId, (counts.get(routeId) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .map(([routeId, claimCount]) => ({ routeId, claimCount }))
    .sort((left, right) => left.routeId.localeCompare(right.routeId));
}

/** Whether an object's badges mark it as written under a limited context (a
 * narrowed slice or an externally-augmented scope rather than whole-game). */
export function isLimitedContext(badges: WikiBadges): boolean {
  const scope = badges.contextScope;
  return scope !== null && scope !== "whole-game";
}

/** Whether an object's badges mark it as written under a non-production run
 * mode (a pilot or a test-dev run). */
export function isTestMode(badges: WikiBadges): boolean {
  return badges.runMode !== "production";
}

/** Compute the coverage / readiness summary from the resolved views. */
export function computeReadiness(
  sourceObjects: readonly WikiSourceObjectView[],
  renderings: readonly WikiRenderingView[],
): WikiDashboardReadiness {
  const localizedSourceIds = new Set(renderings.map((rendering) => rendering.sourceObjectId));
  const localizedSourceCount = sourceObjects.filter((object) =>
    localizedSourceIds.has(object.objectId),
  ).length;
  const limitedContextCount = sourceObjects.filter((object) =>
    isLimitedContext(object.badges),
  ).length;
  const testModeCount = [...sourceObjects, ...renderings].filter((view) =>
    isTestMode(view.badges),
  ).length;
  return {
    sourceObjectCount: sourceObjects.length,
    renderingCount: renderings.length,
    provisionalSourceCount: sourceObjects.filter((object) => object.badges.provisional).length,
    provisionalRenderingCount: renderings.filter((rendering) => rendering.badges.provisional)
      .length,
    localizedSourceCount,
    localizationCoveragePercent:
      sourceObjects.length === 0
        ? 0
        : Math.round((localizedSourceCount / sourceObjects.length) * 100),
    limitedContextCount,
    testModeCount,
  };
}

/** Split a resolved list into its source and rendering views (the object API
 * returns each `WikiObjectView` tagged by `kind`). */
export function partitionViews(views: readonly WikiObjectView[]): {
  sourceObjects: WikiSourceObjectView[];
  renderings: WikiRenderingView[];
} {
  const sourceObjects: WikiSourceObjectView[] = [];
  const renderings: WikiRenderingView[] = [];
  for (const view of views) {
    if (view.kind === "rendering") {
      renderings.push(view);
    } else {
      sourceObjects.push(view);
    }
  }
  return { sourceObjects, renderings };
}
