type RuntimeStatus = {
  finalStatus: string;
  runtimeReportId: string | null;
  runtimeStatus: string | null;
  fidelityTier: string | null;
  evidenceTier?: string | null;
  textEventCount: number;
  frameCaptureCount: number;
  screenshotArtifactCount?: number;
  recordingArtifactCount?: number;
  validationFindingCount?: number;
};

export async function fetchRuntimeStatus(endpoint = "/api/hello/status"): Promise<RuntimeStatus> {
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
  endpoint = "/api/hello/status",
): Promise<void> {
  root.innerHTML = `<main><h1>Utsushi Review</h1><p>Loading runtime evidence...</p></main>`;
  try {
    const status = await fetchRuntimeStatus(endpoint);
    root.innerHTML = `
      <main style="font-family: system-ui; margin: 2rem; max-width: 880px">
        <h1>Utsushi Review</h1>
        <p>Runtime validation hello world.</p>
        <section aria-label="Runtime evidence">
          <h2>${escapeHtml(status.runtimeStatus ?? "missing")}</h2>
          <dl>
            <dt>Report</dt><dd>${escapeHtml(status.runtimeReportId ?? "missing")}</dd>
            <dt>Evidence</dt><dd>${escapeHtml(status.evidenceTier ?? "legacy")}</dd>
            <dt>Adapter capability</dt><dd>${escapeHtml(status.fidelityTier ?? "unknown")}</dd>
            <dt>Trace</dt><dd>${status.textEventCount} text event(s)</dd>
            <dt>Capture</dt><dd>${status.frameCaptureCount} frame capture(s)</dd>
            <dt>Screenshots</dt><dd>${status.screenshotArtifactCount ?? status.frameCaptureCount} referenced artifact(s)</dd>
            <dt>Recordings</dt><dd>${status.recordingArtifactCount ?? 0} referenced artifact(s)</dd>
            <dt>Findings</dt><dd>${status.validationFindingCount ?? 0} validation finding(s)</dd>
            <dt>Suite</dt><dd>${escapeHtml(status.finalStatus)}</dd>
          </dl>
        </section>
      </main>
    `;
  } catch (error) {
    root.innerHTML = `
      <main style="font-family: system-ui; margin: 2rem; max-width: 880px">
        <h1>Utsushi Review</h1>
        <p role="alert">Runtime dashboard could not load DB-backed status.</p>
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
