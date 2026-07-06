// ITOTORI-119 — Project CONTEXT PANEL.
//
// A reviewer who does NOT read the source language still has to decide whether
// a draft/patch is worth reviewing. To do that they need the work's CATALOG
// CONTEXT: which work this is (identity + source IDs + aliases), which edition,
// how complete the translation for their target language is, how much demand
// the work has, whether we own a local corpus for it, and how ready the engine
// adapter is. Every one of those is a KNOWN, TYPED catalog fact — the catalog
// read-models (`CatalogBenchmarkSeedRow`, `CatalogReleaseRecord`) plus project
// state (`LocaleBranchStatus`) already carry it.
//
// This module PROJECTS those typed read-model fields into a compact,
// reviewer-facing view-model (`catalogContextPanelViewFromReadModel`) and
// renders it (`renderCatalogContextPanel`). It NEVER touches bridge-unit
// message streams / scene prose: the projection input is structurally limited
// to typed catalog facts + project state, so no raw source-language dialogue
// the reviewer cannot read can ever reach the panel. The only source-language
// strings it surfaces are catalog IDENTITY fields (canonical title, alternate
// release titles) — the very identity the reviewer asked to see.

import type {
  CatalogBenchmarkDemandBucket,
  CatalogBenchmarkLocalOwnership,
  CatalogBenchmarkSeedReadiness,
  CatalogBenchmarkSeedReadinessLevel,
  CatalogBenchmarkSeedRow,
  CatalogBenchmarkSeedSourceId,
  CatalogBenchmarkSeedTranslationStatus,
  CatalogCompletenessPool,
  CatalogReleaseRecord,
  LocaleBranchStatus,
} from "@itotori/db";

/**
 * Typed project state the panel consumes. This is the reviewer's localization
 * project context — the target language they are reviewing FOR, and (if the
 * work is being localized here) the tracking locale-branch status. Sourced
 * verbatim from `LocaleBranchStatus` (a `ProjectDashboardStatus` read-model
 * field); never re-inferred.
 */
export type CatalogContextProjectState = {
  /** The reviewer's working target language (BCP-47), e.g. `en-US`. */
  targetLanguage: string;
  /** The locale branch localizing this work here, if one exists. */
  localeBranch: LocaleBranchStatus | null;
};

/**
 * The panel's single input. Deliberately the union of TYPED catalog facts +
 * project state — there is no field through which raw source-language prose
 * could enter.
 */
export type CatalogContextPanelInput = {
  /**
   * Primary typed catalog facts for the work (identity, source IDs, translation
   * statuses, demand bucket, local corpus, adapter readiness). A
   * `CatalogOpportunityRow` is a drop-in alternative source — it carries the
   * same fields (its `demandFacts.demandBucket` maps onto `demandBucket`).
   */
  row: CatalogBenchmarkSeedRow;
  /** Edition facts: one catalog release per edition/platform/language. */
  releases: readonly CatalogReleaseRecord[];
  /** Reviewer project state (target language + optional tracking branch). */
  projectState: CatalogContextProjectState;
};

/** One edition of the work, projected verbatim from a catalog release. */
export type CatalogContextEdition = {
  releaseId: string;
  releaseTitle: string;
  editionName: string | null;
  platform: string | null;
  language: string | null;
  releaseKind: string;
  isOfficial: boolean;
};

/** Collapsed adapter-readiness level, derived from per-capability rungs. */
export const catalogContextReadinessLevelValues = {
  patchReady: "patch_ready",
  extractReady: "extract_ready",
  inventoryReady: "inventory_ready",
  identifyReady: "identify_ready",
  unsupported: "unsupported",
  unknown: "unknown",
} as const;

export type CatalogContextReadinessLevel =
  (typeof catalogContextReadinessLevelValues)[keyof typeof catalogContextReadinessLevelValues];

/** One adapter-readiness rung, for the per-capability readiness table. */
export type CatalogContextReadinessRung = {
  capability: "identify" | "inventory" | "extract" | "patch" | "helper" | "runtime";
  level: CatalogBenchmarkSeedReadinessLevel;
};

/**
 * Translation-completeness view for the reviewer's target language, plus the
 * full per-language status list. `targetLanguageStatus` is the status row whose
 * language matches the reviewer's target language, if any (so a reviewer can
 * see completeness for THEIR language at a glance without scanning the table).
 */
export type CatalogContextCompleteness = {
  completenessPool: CatalogCompletenessPool;
  targetLanguage: string;
  targetLanguageStatus: CatalogBenchmarkSeedTranslationStatus | null;
  statuses: readonly CatalogBenchmarkSeedTranslationStatus[];
};

/** Local-corpus evidence view. */
export type CatalogContextLocalCorpus = {
  ownership: CatalogBenchmarkLocalOwnership;
  evidenceCount: number;
};

/** Project-state view for the panel (progress derived from unit counts). */
export type CatalogContextProjectStateView = {
  targetLanguage: string;
  localizing: boolean;
  localeBranchStatus: string | null;
  translatedUnitCount: number;
  unitCount: number;
  progressPercentage: number;
};

/** The fully-projected, render-ready view-model. */
export type CatalogContextPanelView = {
  schemaVersion: "catalog.context_panel.v0.1";
  identity: {
    workId: string;
    canonicalTitle: string;
    originalLanguage: string | null;
    sourceIds: readonly CatalogBenchmarkSeedSourceId[];
    aliases: readonly string[];
  };
  editions: readonly CatalogContextEdition[];
  completeness: CatalogContextCompleteness;
  demandBucket: CatalogBenchmarkDemandBucket;
  localCorpus: CatalogContextLocalCorpus;
  readiness: {
    level: CatalogContextReadinessLevel;
    adapterId: string | null;
    rungs: readonly CatalogContextReadinessRung[];
  };
  projectState: CatalogContextProjectStateView;
};

const readinessCapabilities: ReadonlyArray<CatalogContextReadinessRung["capability"]> = [
  "identify",
  "inventory",
  "extract",
  "patch",
  "helper",
  "runtime",
];

/**
 * Project the REAL catalog read-model + project state into the panel view. This
 * is the single place naming which typed field backs which panel signal:
 *
 *   - identity.workId / canonicalTitle / originalLanguage ← `CatalogBenchmarkSeedRow`
 *   - identity.sourceIds        ← `CatalogBenchmarkSeedRow.sourceIds`
 *   - identity.aliases          ← distinct `CatalogReleaseRecord.releaseTitle` != canonical
 *   - editions                  ← `CatalogReleaseRecord[]`
 *   - completeness              ← row `completenessPool` + `translationStatuses`
 *   - demandBucket              ← `CatalogBenchmarkSeedRow.demandBucket`
 *   - localCorpus               ← row `localOwnership` + `localEvidenceCount`
 *   - readiness                 ← `CatalogBenchmarkSeedReadiness` (per-capability rungs)
 *   - projectState              ← `LocaleBranchStatus` (target language + progress)
 *
 * No signal is synthesized. The only computation is deterministic: collapsing
 * the readiness rungs into a level, deduping release titles into aliases, and
 * dividing translated/total units into a progress percentage.
 */
export function catalogContextPanelViewFromReadModel(
  input: CatalogContextPanelInput,
): CatalogContextPanelView {
  const { row, releases, projectState } = input;
  const editions = releases.map(editionFromRelease);
  const branch = projectState.localeBranch;

  return {
    schemaVersion: "catalog.context_panel.v0.1",
    identity: {
      workId: row.workId,
      canonicalTitle: row.canonicalTitle,
      originalLanguage: row.originalLanguage,
      sourceIds: row.sourceIds,
      aliases: aliasesFromReleases(row.canonicalTitle, releases),
    },
    editions,
    completeness: {
      completenessPool: row.completenessPool,
      targetLanguage: projectState.targetLanguage,
      targetLanguageStatus:
        row.translationStatuses.find((status) => status.language === projectState.targetLanguage) ??
        null,
      statuses: row.translationStatuses,
    },
    demandBucket: row.demandBucket,
    localCorpus: {
      ownership: row.localOwnership,
      evidenceCount: row.localEvidenceCount,
    },
    readiness: {
      level: collapseCatalogReadiness(row.readiness),
      adapterId: row.readiness.adapterId,
      rungs: readinessCapabilities.map((capability) => ({
        capability,
        level: row.readiness[capability],
      })),
    },
    projectState: {
      targetLanguage: projectState.targetLanguage,
      localizing: branch !== null,
      localeBranchStatus: branch?.status ?? null,
      translatedUnitCount: branch?.translatedUnitCount ?? 0,
      unitCount: branch?.unitCount ?? 0,
      progressPercentage: percentage(branch?.translatedUnitCount ?? 0, branch?.unitCount ?? 0),
    },
  };
}

function editionFromRelease(release: CatalogReleaseRecord): CatalogContextEdition {
  return {
    releaseId: release.releaseId,
    releaseTitle: release.releaseTitle,
    editionName: release.editionName,
    platform: release.platform,
    language: release.language,
    releaseKind: release.releaseKind,
    isOfficial: release.isOfficial,
  };
}

/**
 * Alternate titles are the distinct `releaseTitle`s that differ from the
 * canonical title — a TYPED catalog identity field, not free prose. Order is
 * deterministic (first appearance) so the render is stable.
 */
function aliasesFromReleases(
  canonicalTitle: string,
  releases: readonly CatalogReleaseRecord[],
): string[] {
  const aliases: string[] = [];
  for (const release of releases) {
    if (release.releaseTitle === canonicalTitle) {
      continue;
    }
    if (!aliases.includes(release.releaseTitle)) {
      aliases.push(release.releaseTitle);
    }
  }
  return aliases;
}

/**
 * Collapse the per-capability readiness record into a single ordered level.
 * Ordering mirrors the adapter-readiness ladder used across the catalog
 * (patch > extract > inventory > identify). A `partial` patch counts as
 * extract-ready (a patch cannot yet be produced end-to-end).
 */
export function collapseCatalogReadiness(
  readiness: CatalogBenchmarkSeedReadiness,
): CatalogContextReadinessLevel {
  if (readiness.patch === "supported") {
    return catalogContextReadinessLevelValues.patchReady;
  }
  if (readiness.extract === "supported" || readiness.patch === "partial") {
    return catalogContextReadinessLevelValues.extractReady;
  }
  if (readiness.inventory === "supported") {
    return catalogContextReadinessLevelValues.inventoryReady;
  }
  if (readiness.identify === "supported") {
    return catalogContextReadinessLevelValues.identifyReady;
  }
  if (
    readiness.identify === "unsupported" &&
    readiness.inventory === "unsupported" &&
    readiness.extract === "unsupported" &&
    readiness.patch === "unsupported"
  ) {
    return catalogContextReadinessLevelValues.unsupported;
  }
  return catalogContextReadinessLevelValues.unknown;
}

function percentage(value: number, max: number): number {
  if (max <= 0) {
    return 0;
  }
  return Math.round((value / max) * 100);
}

// ---------------------------------------------------------------------------
// Render — pure, DOM-free. Returns an HTML string mirroring the dashboard panel
// pattern (`section.panel` + `dl.metric-list` + tables) so it can drop into the
// reviewer workbench and be unit-tested by assigning to `element.innerHTML`.
// ---------------------------------------------------------------------------

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
