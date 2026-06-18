import { renderDashboard } from "./dashboard.js";
import { renderStyleGuideBuilderRoute } from "./style-guide-builder.js";

const root = document.querySelector<HTMLDivElement>("#app")!;

if (window.location.pathname === "/style-guide-builder") {
  await renderStyleGuideBuilderRoute(root);
} else {
  await renderDashboard(root);
}
