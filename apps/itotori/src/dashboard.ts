import type { HelloDashboardStatus } from "@itotori/db";

export async function fetchHelloStatus(
  endpoint = "/api/hello/status",
): Promise<HelloDashboardStatus> {
  const url = endpoint.startsWith("http")
    ? endpoint
    : new URL(endpoint, window.location.href).toString();
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to load hello status: ${response.status}`);
  }
  return (await response.json()) as HelloDashboardStatus;
}

export async function renderDashboard(
  root: HTMLElement,
  endpoint = "/api/hello/status",
): Promise<void> {
  root.innerHTML = `<main><h1>Itotori</h1><p>Loading DB-backed hello-world status...</p></main>`;
  try {
    const status = await fetchHelloStatus(endpoint);
    root.innerHTML = `
      <main style="font-family: system-ui; margin: 2rem; max-width: 880px">
        <h1>Itotori</h1>
        <p>Agentic localization workbench hello world.</p>
        <section aria-label="Hello status">
          <h2>${escapeHtml(status.finalStatus)}</h2>
          <dl>
            <dt>Project</dt><dd>${escapeHtml(status.projectId)}</dd>
            <dt>Locale</dt><dd>${escapeHtml(status.sourceLocale)} -> ${escapeHtml(status.targetLocale)}</dd>
            <dt>Units</dt><dd>${status.translatedUnitCount}/${status.unitCount} translated</dd>
            <dt>Patch export</dt><dd>${escapeHtml(status.patchExportId ?? "missing")}</dd>
            <dt>Runtime report</dt><dd>${escapeHtml(status.runtimeReportId ?? "missing")}</dd>
            <dt>Runtime</dt><dd>${escapeHtml(status.runtimeStatus ?? "missing")} (${escapeHtml(status.fidelityTier ?? "unknown")})</dd>
            <dt>Evidence</dt><dd>${status.textEventCount} text event(s), ${status.frameCaptureCount} frame capture(s)</dd>
          </dl>
        </section>
      </main>
    `;
  } catch (error) {
    root.innerHTML = `
      <main style="font-family: system-ui; margin: 2rem; max-width: 880px">
        <h1>Itotori</h1>
        <p role="alert">Dashboard could not load DB-backed hello-world status.</p>
        <pre>${escapeHtml(error instanceof Error ? error.message : String(error))}</pre>
      </main>
    `;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
