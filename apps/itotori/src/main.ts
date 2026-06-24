import { renderDashboard } from "./dashboard.js";
import { renderStyleGuideBuilderRoute } from "./style-guide-builder.js";
import { parseAssetDecisionsRoute, renderAssetDecisionsRoute } from "./asset-decisions/route.js";

const root = document.querySelector<HTMLDivElement>("#app")!;

const assetDecisionsParams = parseAssetDecisionsRoute(window.location.pathname);
if (assetDecisionsParams !== null) {
  await renderAssetDecisionsRoute(root, assetDecisionsParams);
} else if (window.location.pathname === "/style-guide-builder") {
  await renderStyleGuideBuilderRoute(root);
} else {
  await renderDashboard(root);
}
