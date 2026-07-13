// fnd-spa-shell — bridge for the routes NOT ported to React by this node.
//
// fnd-spa-shell replaces the dashboard HTML-string renderer with React. The
// asset-decisions routes are SEPARATE downstream screen nodes that still use
// their own HTML-string renderers (out of this node's delete scope). This
// module keeps them working by returning the async renderer to mount into a
// container — an honest, temporary bridge (each is a tracked follow-on
// screen), NOT a dual path for a replaced view.

import type { AssetDecisionsRouteParams } from "../asset-decisions/route.js";
import type { CatalogContextPanelRouteParams } from "../catalog-context-panel-route.js";

export type LegacyRouteRenderer = (root: HTMLElement) => void | Promise<void>;

const assetDecisionsRoutePathRegex =
  /^\/projects\/([^/]+)\/locale-branches\/([^/]+)\/asset-decisions(\/batch)?$/u;
const catalogContextPanelRoutePathRegex =
  /^\/projects\/([^/]+)\/locale-branches\/([^/]+)\/catalog-context\/([^/]+)$/u;
/**
 * Return the async HTML-string renderer for a route this node does not port,
 * or `null` when the path is owned by a React screen (so `App` renders React).
 */
export function matchLegacyRoute(pathname: string, _search: string): LegacyRouteRenderer | null {
  const assetDecisions = parseAssetDecisionsRoute(pathname);
  if (assetDecisions !== null) {
    return async (root) => {
      const { renderAssetDecisionsRoute } = await import("../asset-decisions/route.js");
      await renderAssetDecisionsRoute(root, assetDecisions);
    };
  }
  const catalogContextPanel = parseCatalogContextPanelRoute(pathname);
  if (catalogContextPanel !== null) {
    return async (root) => {
      const { renderCatalogContextPanelRoute } = await import("../catalog-context-panel-route.js");
      await renderCatalogContextPanelRoute(root, catalogContextPanel);
    };
  }
  return null;
}

function parseAssetDecisionsRoute(pathname: string): AssetDecisionsRouteParams | null {
  const match = assetDecisionsRoutePathRegex.exec(pathname);
  const projectId = match?.[1];
  const localeBranchId = match?.[2];
  if (projectId === undefined || localeBranchId === undefined) {
    return null;
  }
  return {
    projectId: decodeURIComponent(projectId),
    localeBranchId: decodeURIComponent(localeBranchId),
    view: match?.[3] === "/batch" ? "batch" : "policy",
  };
}

function parseCatalogContextPanelRoute(pathname: string): CatalogContextPanelRouteParams | null {
  const match = catalogContextPanelRoutePathRegex.exec(pathname);
  const projectId = match?.[1];
  const localeBranchId = match?.[2];
  const workId = match?.[3];
  if (projectId === undefined || localeBranchId === undefined || workId === undefined) {
    return null;
  }
  return {
    projectId: decodeURIComponent(projectId),
    localeBranchId: decodeURIComponent(localeBranchId),
    workId: decodeURIComponent(workId),
  };
}
