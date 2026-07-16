// The Wiki bible dashboard barrel — local to the product surface. It re-exports
// the pure read-model + browser guards (shared by the surface's data client) and
// the server-side HTTP adapter (composed over the wiki object API). Self-
// contained: nothing here reaches the old context-artifact worker or an agent.

export {
  WIKI_DASHBOARD_OBJECT_SCHEMA,
  WIKI_DASHBOARD_OVERVIEW_SCHEMA,
  WIKI_DASHBOARD_WRITE_SCHEMA,
  buildRouteFacets,
  computeReadiness,
  isCanonicalClaim,
  isClaimVisibleUnderRoute,
  isLimitedContext,
  isTestMode,
  partitionViews,
  routeScopeRouteIds,
  visibleClaims,
  type WikiBadges,
  type WikiCitationView,
  type WikiClaimView,
  type WikiDashboardObject,
  type WikiDashboardOverview,
  type WikiDashboardReadiness,
  type WikiDashboardRouteFacet,
  type WikiDashboardWriteReceipt,
  type WikiDependentView,
  type WikiHeadReceipt,
  type WikiHistoryEntry,
  type WikiObjectView,
  type WikiRenderingView,
  type WikiRouteScope,
  type WikiSourceObjectView,
} from "./read-model.js";

export {
  assertWikiDashboardObject,
  assertWikiDashboardOverview,
  assertWikiDashboardWriteReceipt,
} from "./guards.js";

export {
  handleWikiDashboardRequest,
  type WikiDashboardHttpBody,
  type WikiDashboardHttpRequest,
  type WikiDashboardHttpResponse,
} from "./http.js";
