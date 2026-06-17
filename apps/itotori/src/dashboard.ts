import type { ProjectDashboardStatus } from "@itotori/db";
import { assertProjectDashboardStatus } from "./api-schema.js";

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
  const status = await response.json();
  assertProjectDashboardStatus(status);
  return status;
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
    const costRows = status.cost.totalsByCostKind
      .map(
        (cost) => `
          <tr>
            <td>${escapeHtml(cost.costKind)}</td>
            <td>${cost.runCount}</td>
            <td>${formatMicrosUsd(cost.amountMicrosUsd)}</td>
            <td>${cost.totalTokens}</td>
          </tr>
        `,
      )
      .join("");
    const recentRunRows = status.cost.recentRuns
      .map(
        (run) => `
          <tr>
            <td>${escapeHtml(run.taskKind)}</td>
            <td>${escapeHtml(run.providerFamily)} / ${escapeHtml(run.providerName)}</td>
            <td>${escapeHtml(run.requestedModelId)} -> ${escapeHtml(run.actualModelId)}</td>
            <td>${escapeHtml(run.promptPresetId)}@${escapeHtml(run.promptTemplateVersion)}</td>
            <td>${escapeHtml(run.costKind)}</td>
            <td>${formatMicrosUsd(run.amountMicrosUsd)}</td>
            <td>${run.fallbackUsed ? "yes" : "no"}</td>
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
            <dt>Billed cost</dt><dd>${formatMicrosUsd(status.cost.billedMicrosUsd)}</dd>
            <dt>Estimated cost</dt><dd>${formatMicrosUsd(status.cost.estimatedMicrosUsd)}</dd>
            <dt>Unknown cost runs</dt><dd>${status.cost.unknownRunCount}</dd>
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
          <h2>Cost</h2>
          <table>
            <thead>
              <tr>
                <th>Kind</th>
                <th>Runs</th>
                <th>Amount</th>
                <th>Tokens</th>
              </tr>
            </thead>
            <tbody>${costRows}</tbody>
          </table>
          <h2>Provider runs</h2>
          <table>
            <thead>
              <tr>
                <th>Task</th>
                <th>Provider</th>
                <th>Model</th>
                <th>Preset</th>
                <th>Cost kind</th>
                <th>Amount</th>
                <th>Fallback</th>
              </tr>
            </thead>
            <tbody>${recentRunRows}</tbody>
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

function formatMicrosUsd(value: number | null): string {
  if (value === null) {
    return "unknown";
  }
  return `$${(value / 1_000_000).toFixed(6)}`;
}
