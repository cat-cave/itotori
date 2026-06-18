import {
  renderRuntimeDashboard,
  renderRuntimeEvidenceRoute,
  runtimeRunIdFromPath,
} from "./dashboard.js";

const root = document.querySelector<HTMLDivElement>("#app")!;
const runtimeRunId = runtimeRunIdFromPath(window.location.pathname);

if (runtimeRunId === null) {
  await renderRuntimeDashboard(root);
} else {
  await renderRuntimeEvidenceRoute(root, runtimeRunId);
}
