import { DEFAULT_RUNTIME_STATUS_ENDPOINT, type RuntimeStatus } from "./dashboard-types.js";
import { escapeHtml, pageStyle, renderRuntimeEvidence } from "./dashboard-renderers.js";

export async function fetchRuntimeStatus(
  endpoint = DEFAULT_RUNTIME_STATUS_ENDPOINT,
): Promise<RuntimeStatus> {
  const url = endpoint.startsWith("http")
    ? endpoint
    : new URL(endpoint, window.location.href).toString();
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to load runtime status: ${response.status}`);
  }
  return (await response.json()) as RuntimeStatus;
}

export async function renderRuntimeDashboard(
  root: HTMLElement,
  endpoint = DEFAULT_RUNTIME_STATUS_ENDPOINT,
): Promise<void> {
  const routeRuntimeRunId = runtimeRunIdFromPath(window.location.pathname);
  root.innerHTML = `<main><h1>Utsushi Review</h1><p>Loading runtime evidence...</p></main>`;
  try {
    const status = await fetchRuntimeStatus(endpoint);
    root.innerHTML = renderRuntimeEvidence(status, routeRuntimeRunId);
  } catch (error) {
    root.innerHTML = `
      <main style="${pageStyle()}">
        <h1>Utsushi Review</h1>
        <p role="alert">Runtime dashboard could not load DB-backed status.</p>
        <pre>${escapeHtml(error instanceof Error ? error.message : String(error))}</pre>
      </main>
    `;
  }
}

export async function renderRuntimeEvidenceRoute(
  root: HTMLElement,
  runtimeRunId: string,
  endpoint = DEFAULT_RUNTIME_STATUS_ENDPOINT,
): Promise<void> {
  await renderRuntimeDashboard(root, runtimeStatusEndpointForRun(endpoint, runtimeRunId));
}

export function runtimeRunIdFromPath(pathname: string): string | null {
  const match = /^\/runtime\/evidence\/([^/]+)\/?$/u.exec(pathname);
  return match === null ? null : decodeURIComponent(match[1] ?? "");
}

function runtimeStatusEndpointForRun(endpoint: string, runtimeRunId: string): string {
  const url = new URL(endpoint, window.location.href);
  url.searchParams.set("runtimeRunId", runtimeRunId);
  return endpoint.startsWith("http") ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
}
