import type { ProjectDashboardStatus } from "@itotori/db";

export async function fetchProjectStatus(
  endpoint = "/api/projects/status",
): Promise<ProjectDashboardStatus> {
  const url = endpoint.startsWith("http")
    ? endpoint
    : new URL(endpoint, window.location.href).toString();
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to load project status: ${response.status}`);
  }
  return (await response.json()) as ProjectDashboardStatus;
}

export async function renderDashboard(
  root: HTMLElement,
  endpoint = "/api/projects/status",
): Promise<void> {
  root.innerHTML = `<main><h1>Itotori</h1><p>Loading project status...</p></main>`;
  try {
    const status = await fetchProjectStatus(endpoint);
    const branches = status.localeBranches
      .map(
        (branch) => `
          <tr>
            <td>${escapeHtml(branch.targetLocale)}</td>
            <td>${escapeHtml(branch.status)}</td>
            <td>${branch.translatedUnitCount}/${branch.unitCount}</td>
            <td>${branch.openFindingCount}</td>
            <td>${branch.artifactCount}</td>
          </tr>
        `,
      )
      .join("");
    root.innerHTML = `
      <main style="font-family: system-ui; margin: 2rem; max-width: 960px">
        <h1>Itotori</h1>
        <section aria-label="Project status">
          <h2>${escapeHtml(status.name)}</h2>
          <dl>
            <dt>Project</dt><dd>${escapeHtml(status.projectId)}</dd>
            <dt>Status</dt><dd>${escapeHtml(status.status)}</dd>
            <dt>Source</dt><dd>${escapeHtml(status.sourceLocale)} ${escapeHtml(status.sourceBundleHash)}</dd>
            <dt>Revision</dt><dd>${escapeHtml(status.sourceBundleRevisionId)}</dd>
            <dt>Units</dt><dd>${status.unitCount}</dd>
            <dt>Findings</dt><dd>${status.findingCount}</dd>
            <dt>Artifacts</dt><dd>${status.artifactCount}</dd>
            <dt>Latest event</dt><dd>${escapeHtml(status.latestEventKind ?? "none")}</dd>
          </dl>
          <table>
            <thead>
              <tr>
                <th>Locale</th>
                <th>Status</th>
                <th>Translated</th>
                <th>Open findings</th>
                <th>Artifacts</th>
              </tr>
            </thead>
            <tbody>${branches}</tbody>
          </table>
        </section>
      </main>
    `;
  } catch (error) {
    root.innerHTML = `
      <main style="font-family: system-ui; margin: 2rem; max-width: 880px">
        <h1>Itotori</h1>
        <p role="alert">Dashboard could not load DB-backed project status.</p>
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
