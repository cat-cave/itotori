// Pure adapters from WikiObject wire responses to the product-surface
// dashboard read-models. The bible dashboard NEVER invents fields: readiness,
// route facets, and write-loop addressing are derived from the typed object API
// responses (list / show / edit / feedback) via the same pure builders the
// server-side dashboard HTTP adapter uses.

import type {
  ApiWikiEditResponse,
  ApiWikiListResponse,
  ApiWikiShowResponse,
} from "../../../api-schema.js";
import {
  WIKI_DASHBOARD_OBJECT_SCHEMA,
  WIKI_DASHBOARD_OVERVIEW_SCHEMA,
  WIKI_DASHBOARD_WRITE_SCHEMA,
  buildRouteFacets,
  computeReadiness,
  type WikiDashboardObject,
  type WikiDashboardOverview,
  type WikiDashboardWriteReceipt,
  type WikiRenderingView,
  type WikiSourceObjectView,
} from "../../../wiki/dashboard/read-model.js";

/** Project a wiki.list response into the product-surface overview: source vs
 * localized-bible partitions, route facets, and coverage/readiness. */
export function overviewFromWikiList(list: ApiWikiListResponse): WikiDashboardOverview {
  const sourceObjects = list.sourceObjects.filter(isSourceView);
  const renderings = list.renderings.filter(isRenderingView);
  return {
    schemaVersion: WIKI_DASHBOARD_OVERVIEW_SCHEMA,
    generatedAt: list.generatedAt,
    snapshotId: list.snapshotId,
    sourceObjects,
    renderings,
    routes: buildRouteFacets(sourceObjects),
    readiness: computeReadiness(sourceObjects, renderings),
  };
}

/** Project a wiki.show response into the product-surface object detail. */
export function objectFromWikiShow(
  shown: ApiWikiShowResponse,
  snapshotId: string,
): WikiDashboardObject {
  return {
    schemaVersion: WIKI_DASHBOARD_OBJECT_SCHEMA,
    generatedAt: shown.generatedAt,
    snapshotId,
    object: shown.view,
    history: shown.history,
    dependents: shown.dependencyImpact.dependents,
  };
}

/** Project a wiki.edit / wiki.feedback write receipt into the product-surface
 * loop-close receipt. `addressedObjectId` is the object the surface re-selects. */
export function writeReceiptFromWikiWrite(
  write: ApiWikiEditResponse,
  wikiKind: string,
): WikiDashboardWriteReceipt {
  const invalidatedObjectIds = [
    ...new Set(
      write.receipt.dependencyImpact.consumers.map((consumer) => consumer.downstreamObjectId),
    ),
  ];
  return {
    schemaVersion: WIKI_DASHBOARD_WRITE_SCHEMA,
    generatedAt: write.generatedAt,
    inputId: write.receipt.inputId,
    addressedObjectId: write.receipt.head.objectId,
    addressedWikiKind: wikiKind,
    head: write.receipt.head,
    object: write.receipt.view,
    badges: write.receipt.badges,
    invalidatedObjectIds,
  };
}

function isSourceView(
  view: ApiWikiListResponse["sourceObjects"][number],
): view is WikiSourceObjectView {
  return view.kind === "source";
}

function isRenderingView(
  view: ApiWikiListResponse["renderings"][number],
): view is WikiRenderingView {
  return view.kind === "rendering";
}
