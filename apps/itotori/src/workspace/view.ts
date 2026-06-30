// ITOTORI-040 — localization workspace views (pure render).
//
// Stateless, dependency-free renderers. Each accepts a fully-typed
// workspace read-model (resolved by the API + route loader) and returns
// HTML. No fetch, no DOM, no globals — every test exercises a renderer
// directly with a fixture. The renderers deliberately lead with the
// translated, source-language-free affordances (branch names, translated
// scene summaries, target-locale draft / final text, runtime-evidence
// links) so a reviewer who does not read the source can navigate.

import {
  type WorkspaceAssetBrowseReadModel,
  type WorkspaceComparisonReadModel,
  type WorkspaceDiagnostic,
  type WorkspaceProjectBrowseReadModel,
  type WorkspaceSceneBrowseReadModel,
  type WorkspaceSearchReadModel,
} from "./read-model.js";

export function renderWorkspaceProjectBrowseView(model: WorkspaceProjectBrowseReadModel): string {
  if (!model.permission.canReadQueue) {
    return renderDeniedShell("project-browse", "Localization workspace", model.diagnostics);
  }
  const projects = model.projects
    .map(
      (project) => `
      <section class="workspace-project" data-project-id="${escapeHtml(project.projectId)}">
        <h2>${escapeHtml(project.name)}</h2>
        <p class="subhead">
          <code>${escapeHtml(project.projectKey)}</code> — source locale
          <code>${escapeHtml(project.sourceLocale)}</code> —
          ${project.unitCount} units across ${project.branchCount} locale branch(es)
        </p>
        <ul class="workspace-branch-list">
          ${project.localeBranches
            .map(
              (branch) => `
            <li class="workspace-branch" data-locale-branch-id="${escapeHtml(branch.localeBranchId)}"
              data-target-locale="${escapeHtml(branch.targetLocale)}">
              <span class="branch-name">${escapeHtml(branch.branchName)}</span>
              <code class="branch-locale">${escapeHtml(branch.sourceLocale)} → ${escapeHtml(branch.targetLocale)}</code>
              <span class="branch-progress">${branch.translatedUnitCount}/${branch.unitCount} units</span>
              <span class="branch-findings">${branch.openFindingCount} open finding(s)</span>
              <a class="branch-scenes" href="${escapeHtml(branch.sceneBrowsePath)}">scenes</a>
              <a class="branch-assets" href="${escapeHtml(branch.assetBrowsePath)}">assets</a>
            </li>`,
            )
            .join("")}
        </ul>
      </section>`,
    )
    .join("");
  return `
    ${workspaceStyles()}
    <main class="itotori-shell workspace-browse" data-state="ready" data-view="project-browse">
      <header class="shell-header">
        <p class="eyebrow">Localization workspace</p>
        <h1>Browse projects and locale branches</h1>
      </header>
      ${renderDiagnosticBanner(model.diagnostics)}
      ${projects === "" ? `<p class="empty">No projects are imported yet.</p>` : projects}
    </main>
  `;
}

export function renderWorkspaceSceneBrowseView(model: WorkspaceSceneBrowseReadModel): string {
  if (!model.permission.canReadQueue) {
    return renderDeniedShell("scene-browse", "Scene browser", model.diagnostics);
  }
  const scenes = model.scenes
    .map(
      (scene) => `
      <section class="workspace-scene${scene.stale ? " is-stale" : ""}"
        data-scene-id="${escapeHtml(scene.sceneId)}"
        data-summary-locale="${escapeHtml(scene.summaryLocale)}"
        data-stale="${scene.stale ? "true" : "false"}">
        <h2>${escapeHtml(scene.sceneId)}</h2>
        <p class="scene-summary" lang="${escapeHtml(scene.summaryLocale)}">${escapeHtml(scene.summaryText)}</p>
        <p class="subhead">${scene.citedUnitCount} cited unit(s) — summary in
          <code>${escapeHtml(scene.summaryLocale)}</code></p>
        <ul class="workspace-unit-list">
          ${scene.units
            .map(
              (unit) => `
            <li class="workspace-unit" data-bridge-unit-id="${escapeHtml(unit.bridgeUnitId)}">
              <code class="unit-key">${escapeHtml(unit.sourceUnitKey)}</code>
              ${unit.speaker === null ? "" : `<span class="unit-speaker">${escapeHtml(unit.speaker)}</span>`}
            </li>`,
            )
            .join("")}
        </ul>
      </section>`,
    )
    .join("");
  return `
    ${workspaceStyles()}
    <main class="itotori-shell workspace-browse" data-state="ready" data-view="scene-browse"
      data-locale-branch-id="${escapeHtml(model.localeBranchId)}">
      <header class="shell-header">
        <p class="eyebrow">Localization workspace</p>
        <h1>Scenes — navigate by translated summary</h1>
        <p class="subhead">Locale branch <code>${escapeHtml(model.localeBranchId)}</code></p>
      </header>
      ${renderDiagnosticBanner(model.diagnostics)}
      ${scenes === "" ? `<p class="empty">No scene summaries available.</p>` : scenes}
    </main>
  `;
}

export function renderWorkspaceAssetBrowseView(model: WorkspaceAssetBrowseReadModel): string {
  if (!model.permission.canReadQueue) {
    return renderDeniedShell("asset-browse", "Asset browser", model.diagnostics);
  }
  const rows = model.assets
    .map(
      (asset) => `
      <tr class="workspace-asset" data-asset-ref="${escapeHtml(asset.assetRef.ref)}"
        data-decided="${asset.decided ? "true" : "false"}">
        <td>${escapeHtml(asset.displayLabel ?? asset.assetRef.ref)}</td>
        <td><code>${escapeHtml(asset.assetKind)}</code></td>
        <td>${asset.decided ? escapeHtml(asset.decisionPolicy ?? "decided") : "undecided"}</td>
      </tr>`,
    )
    .join("");
  return `
    ${workspaceStyles()}
    <main class="itotori-shell workspace-browse" data-state="ready" data-view="asset-browse"
      data-locale-branch-id="${escapeHtml(model.localeBranchId)}">
      <header class="shell-header">
        <p class="eyebrow">Localization workspace</p>
        <h1>Assets</h1>
        <p class="subhead">Locale branch <code>${escapeHtml(model.localeBranchId)}</code></p>
      </header>
      ${renderDiagnosticBanner(model.diagnostics)}
      ${
        rows === ""
          ? `<p class="empty">No assets in this locale branch.</p>`
          : `<table class="workspace-asset-table"><thead><tr><th>Asset</th><th>Kind</th><th>Decision</th></tr></thead><tbody>${rows}</tbody></table>`
      }
    </main>
  `;
}

export function renderWorkspaceComparisonView(model: WorkspaceComparisonReadModel): string {
  if (!model.permission.canReadQueue) {
    return renderDeniedShell("comparison", "Source / draft / final comparison", model.diagnostics);
  }
  const cells = model.cells
    .map(
      (cell) => `
      <article class="comparison-cell" data-side="${escapeHtml(cell.side)}"
        data-locale="${escapeHtml(cell.locale)}">
        <h3>${escapeHtml(cell.label)}</h3>
        <p class="comparison-text" lang="${escapeHtml(cell.locale)}">${escapeHtml(cell.text)}</p>
      </article>`,
    )
    .join("");
  const runtime = model.runtimeEvidenceLinks
    .map(
      (link) => `
      <li class="runtime-evidence-link" data-evidence-kind="${escapeHtml(link.evidenceKind)}"
        data-evidence-tier="${escapeHtml(link.evidenceTier)}"
        data-runtime-target-id="${escapeHtml(link.runtimeTargetId)}">
        <span class="evidence-summary">${escapeHtml(link.summary)}</span>
        <code class="evidence-tier">${escapeHtml(link.evidenceTier)}</code>
        ${link.observationEventIds.map((id) => `<code class="observation-event">${escapeHtml(id)}</code>`).join("")}
        ${link.providerProofRefs.map((ref) => `<code class="provider-proof">${escapeHtml(ref)}</code>`).join("")}
      </li>`,
    )
    .join("");
  return `
    ${workspaceStyles()}
    <main class="itotori-shell workspace-comparison" data-state="ready" data-view="comparison"
      data-review-item-id="${escapeHtml(model.reviewItemId)}"
      data-has-final="${model.hasFinal ? "true" : "false"}">
      <header class="shell-header">
        <p class="eyebrow">Localization workspace</p>
        <h1>Source / draft / final comparison</h1>
        <p class="subhead">
          ${model.sourceUnitKey === null ? "" : `Unit <code>${escapeHtml(model.sourceUnitKey)}</code> — `}
          review item <code>${escapeHtml(model.reviewItemId)}</code>
        </p>
        ${model.contextNote === null ? "" : `<p class="context-note">${escapeHtml(model.contextNote)}</p>`}
      </header>
      ${renderDiagnosticBanner(model.diagnostics)}
      <section class="comparison-grid" aria-label="Source, draft, and final text">
        ${cells === "" ? `<p class="empty">Nothing to compare.</p>` : cells}
      </section>
      <section class="runtime-evidence" aria-label="Runtime evidence links">
        <h2>Runtime evidence</h2>
        ${runtime === "" ? `<p class="empty">No runtime evidence linked.</p>` : `<ul>${runtime}</ul>`}
      </section>
    </main>
  `;
}

export function renderWorkspaceSearchView(model: WorkspaceSearchReadModel): string {
  if (!model.permission.canReadQueue) {
    return renderDeniedShell("search", "Searchable context", model.diagnostics);
  }
  const rows = model.results
    .map(
      (result) => `
      <li class="search-result" data-match-kind="${escapeHtml(result.matchKind)}"
        data-locale-branch-id="${escapeHtml(result.localeBranchId)}"
        data-source-artifact-id="${escapeHtml(result.sourceArtifactId)}"
        data-bridge-unit-ref="${escapeHtml(result.bridgeUnitRef)}">
        <span class="result-snippet">${escapeHtml(result.snippet)}</span>
        <code class="result-artifact">artifact:${escapeHtml(result.sourceArtifactId)}</code>
        <code class="result-branch">branch:${escapeHtml(result.localeBranchId)}</code>
        <code class="result-bridge-unit">unit:${escapeHtml(result.bridgeUnitRef)}</code>
      </li>`,
    )
    .join("");
  return `
    ${workspaceStyles()}
    <main class="itotori-shell workspace-search" data-state="ready" data-view="search"
      data-locale-branch-id="${escapeHtml(model.localeBranchId)}"
      data-dropped-opaque-count="${model.droppedOpaqueCount}">
      <header class="shell-header">
        <p class="eyebrow">Localization workspace</p>
        <h1>Searchable context</h1>
        <p class="subhead">Query <code>${escapeHtml(model.query)}</code> in
          <code>${escapeHtml(model.mode)}</code> mode — locale branch
          <code>${escapeHtml(model.localeBranchId)}</code></p>
      </header>
      ${renderDiagnosticBanner(model.diagnostics)}
      ${
        rows === ""
          ? `<p class="empty">No results cite a source artifact, locale branch, and bridge unit.</p>`
          : `<ul class="search-results">${rows}</ul>`
      }
    </main>
  `;
}

function renderDeniedShell(
  view: string,
  title: string,
  diagnostics: WorkspaceDiagnostic[],
): string {
  const reason = diagnostics[0]?.message ?? "Permission denied.";
  return `
    ${workspaceStyles()}
    <main class="itotori-shell workspace-browse" data-state="denied" data-view="${escapeHtml(view)}">
      <header class="shell-header">
        <p class="eyebrow">Localization workspace</p>
        <h1>${escapeHtml(title)} — access denied</h1>
      </header>
      <section class="denial-panel" role="alert">
        <p>${escapeHtml(reason)}</p>
        <p class="subhead">The workspace withholds all project, scene, asset, comparison, and
          search context until the <code>queue.read</code> permission is granted.</p>
      </section>
    </main>
  `;
}

function renderDiagnosticBanner(diagnostics: WorkspaceDiagnostic[]): string {
  if (diagnostics.length === 0) {
    return "";
  }
  const items = diagnostics
    .map(
      (diagnostic) =>
        `<li data-diagnostic-code="${escapeHtml(diagnostic.code)}">${escapeHtml(diagnostic.message)}</li>`,
    )
    .join("");
  return `
    <section class="diagnostic-banner" role="status" aria-label="Workspace diagnostics">
      <ul>${items}</ul>
    </section>
  `;
}

function workspaceStyles(): string {
  return `<style data-itotori-workspace-styles>
    .workspace-branch-list,.workspace-unit-list,.search-results{list-style:none;margin:0;padding:0}
    .comparison-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));gap:1rem}
    .diagnostic-banner{border-left:3px solid #b8860b;padding:.5rem 1rem;margin:1rem 0}
  </style>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
