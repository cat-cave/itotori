import type { CatalogBenchmarkDemandBucket } from "@itotori/db";
import type {
  CatalogContextCompleteness,
  CatalogContextEdition,
  CatalogContextLocalCorpus,
  CatalogContextPanelView,
  CatalogContextProjectStateView,
} from "./catalog-context-panel.js";

// Render — pure, DOM-free. Returns an HTML string mirroring the dashboard panel
// pattern (`section.panel` + `dl.metric-list` + tables) so it can render in a
// catalog context route and be unit-tested by assigning to `element.innerHTML`.
export function renderCatalogContextPanel(view: CatalogContextPanelView): string {
  return `
    ${catalogContextPanelStyles()}
    <section
      class="panel catalog-context-panel"
      id="catalog-context"
      aria-label="Catalog context"
      data-state="catalog-context-ready"
      data-work-id="${escapeHtml(view.identity.workId)}"
    >
      <header class="panel-header">
        <p class="eyebrow">Catalog context</p>
        <h2>${escapeHtml(view.identity.canonicalTitle)}</h2>
      </header>
      ${renderIdentity(view)}
      ${renderAliases(view.identity.aliases)}
      ${renderEditions(view.editions)}
      ${renderCompleteness(view.completeness)}
      ${renderDemand(view.demandBucket)}
      ${renderLocalCorpus(view.localCorpus)}
      ${renderReadiness(view.readiness)}
      ${renderProjectState(view.projectState)}
    </section>
  `;
}

function renderIdentity(view: CatalogContextPanelView): string {
  const sourceRows = view.identity.sourceIds
    .map(
      (source) => `
        <tr>
          <td>${escapeHtml(source.catalogSource)}</td>
          <td><code>${escapeHtml(source.sourceId)}</code></td>
          <td>${escapeHtml(source.externalIdKind)}</td>
        </tr>
      `,
    )
    .join("");
  return card(
    "Identity",
    "Work identity",
    `
      <dl class="metric-list metric-list-compact">
        <div><dt>Work id</dt><dd><code>${escapeHtml(view.identity.workId)}</code></dd></div>
        <div><dt>Canonical title</dt><dd>${escapeHtml(view.identity.canonicalTitle)}</dd></div>
        <div><dt>Original language</dt><dd>${escapeHtml(view.identity.originalLanguage ?? "unknown")}</dd></div>
        <div><dt>Source IDs</dt><dd>${view.identity.sourceIds.length}</dd></div>
      </dl>
      ${
        view.identity.sourceIds.length === 0
          ? emptyText("No catalog source IDs recorded for this work.")
          : `
            <table>
              <thead><tr><th>Catalog source</th><th>Source id</th><th>Kind</th></tr></thead>
              <tbody>${sourceRows}</tbody>
            </table>
          `
      }
    `,
  );
}

function renderAliases(aliases: readonly string[]): string {
  return card(
    "Aliases",
    "Aliases",
    aliases.length === 0
      ? emptyText("No alternate release titles recorded.")
      : `
        <ul class="alias-list">
          ${aliases.map((alias) => `<li>${escapeHtml(alias)}</li>`).join("")}
        </ul>
      `,
  );
}

function renderEditions(editions: readonly CatalogContextEdition[]): string {
  const rows = editions
    .map(
      (edition) => `
        <tr>
          <td>${escapeHtml(edition.editionName ?? "—")}</td>
          <td>${escapeHtml(edition.releaseTitle)}</td>
          <td>${escapeHtml(edition.platform ?? "—")}</td>
          <td>${escapeHtml(edition.language ?? "—")}</td>
          <td>${escapeHtml(edition.releaseKind)}</td>
          <td>${badge(edition.isOfficial ? "official" : "unofficial")}</td>
        </tr>
      `,
    )
    .join("");
  return card(
    "Editions",
    "Editions",
    editions.length === 0
      ? emptyText("No catalog releases recorded for this work.")
      : `
        <table>
          <thead>
            <tr>
              <th>Edition</th>
              <th>Release title</th>
              <th>Platform</th>
              <th>Language</th>
              <th>Kind</th>
              <th>Official</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      `,
  );
}

function renderCompleteness(completeness: CatalogContextCompleteness): string {
  const rows = completeness.statuses
    .map(
      (status) => `
        <tr${status.language === completeness.targetLanguage ? ' class="target-language-row"' : ""}>
          <td>${escapeHtml(status.language)}</td>
          <td>${badge(status.status)}</td>
          <td>${escapeHtml(status.statusScope)}</td>
          <td>${escapeHtml(status.confidence)}</td>
          <td>${escapeHtml(status.platform ?? "—")}</td>
        </tr>
      `,
    )
    .join("");
  const targetStatus = completeness.targetLanguageStatus;
  return card(
    "Translation completeness",
    "Translation completeness",
    `
      <dl class="metric-list metric-list-compact">
        <div><dt>Completeness pool</dt><dd>${badge(completeness.completenessPool)}</dd></div>
        <div><dt>Your target language</dt><dd>${escapeHtml(completeness.targetLanguage)}</dd></div>
        <div>
          <dt>Status for your language</dt>
          <dd>${targetStatus === null ? badge("none") : badge(targetStatus.status)}</dd>
        </div>
      </dl>
      ${
        completeness.statuses.length === 0
          ? emptyText("No per-language translation statuses recorded.")
          : `
            <table>
              <thead>
                <tr>
                  <th>Language</th>
                  <th>Status</th>
                  <th>Scope</th>
                  <th>Confidence</th>
                  <th>Platform</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          `
      }
    `,
  );
}

function renderDemand(demandBucket: CatalogBenchmarkDemandBucket): string {
  return card(
    "Demand",
    "Demand",
    `
      <dl class="metric-list metric-list-compact">
        <div><dt>Demand bucket</dt><dd>${badge(demandBucket)}</dd></div>
      </dl>
    `,
  );
}

function renderLocalCorpus(localCorpus: CatalogContextLocalCorpus): string {
  return card(
    "Local corpus",
    "Local corpus",
    `
      <dl class="metric-list metric-list-compact">
        <div><dt>Ownership</dt><dd>${badge(localCorpus.ownership)}</dd></div>
        <div><dt>Local evidence</dt><dd>${localCorpus.evidenceCount}</dd></div>
      </dl>
    `,
  );
}

function renderReadiness(readiness: CatalogContextPanelView["readiness"]): string {
  const rows = readiness.rungs
    .map(
      (rung) => `
        <tr>
          <td>${escapeHtml(rung.capability)}</td>
          <td>${badge(rung.level)}</td>
        </tr>
      `,
    )
    .join("");
  return card(
    "Readiness",
    "Readiness",
    `
      <dl class="metric-list metric-list-compact">
        <div><dt>Overall</dt><dd>${badge(readiness.level)}</dd></div>
        <div><dt>Adapter</dt><dd>${escapeHtml(readiness.adapterId ?? "none")}</dd></div>
      </dl>
      <table>
        <thead><tr><th>Capability</th><th>Level</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `,
  );
}

function renderProjectState(projectState: CatalogContextProjectStateView): string {
  return card(
    "Project state",
    "Project state",
    `
      <dl class="metric-list metric-list-compact">
        <div><dt>Target language</dt><dd>${escapeHtml(projectState.targetLanguage)}</dd></div>
        <div>
          <dt>Localizing here</dt>
          <dd>${projectState.localizing ? badge("yes") : badge("not_started")}</dd>
        </div>
        <div>
          <dt>Branch status</dt>
          <dd>${projectState.localeBranchStatus === null ? "none" : badge(projectState.localeBranchStatus)}</dd>
        </div>
        <div>
          <dt>Translated</dt>
          <dd>${projectState.translatedUnitCount}/${projectState.unitCount} (${projectState.progressPercentage}%)</dd>
        </div>
      </dl>
      <div class="progress" aria-label="${projectState.progressPercentage}% translated">
        <span style="width: ${Math.max(0, Math.min(100, projectState.progressPercentage))}%"></span>
      </div>
    `,
  );
}

function card(dataLabel: string, ariaLabel: string, body: string): string {
  return `
    <section
      class="context-card"
      aria-label="${escapeHtml(ariaLabel)}"
      data-context-section="${escapeHtml(dataLabel)}"
    >
      <header><h3>${escapeHtml(ariaLabel)}</h3></header>
      ${body}
    </section>
  `;
}

function emptyText(message: string): string {
  return `<p class="empty-copy">${escapeHtml(message)}</p>`;
}

function badge(value: string): string {
  const tone =
    value === "none" ||
    value === "unsupported" ||
    value === "not_owned" ||
    value === "not_started" ||
    value === "conflict"
      ? "critical"
      : "neutral";
  return `<span class="badge badge-${tone}">${escapeHtml(value)}</span>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function catalogContextPanelStyles(): string {
  return `
    <style>
      .catalog-context-panel {
        min-width: 0;
        border: 1px solid #d8dee2;
        border-radius: 8px;
        padding: 16px;
        background: #ffffff;
      }

      .catalog-context-panel .panel-header {
        margin-bottom: 12px;
      }

      .catalog-context-panel .context-card {
        min-width: 0;
        margin-bottom: 14px;
        border: 1px solid #e7ebee;
        border-radius: 8px;
        padding: 12px;
        background: #fbfcfd;
      }

      .catalog-context-panel .context-card:last-child {
        margin-bottom: 0;
      }

      .catalog-context-panel .context-card h3 {
        margin: 0 0 10px;
        font-size: 0.92rem;
      }

      .catalog-context-panel .alias-list {
        margin: 0;
        padding-left: 18px;
      }

      .catalog-context-panel .target-language-row {
        background: #eef7f3;
      }
    </style>
  `;
}
