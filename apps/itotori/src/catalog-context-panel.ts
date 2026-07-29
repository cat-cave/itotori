// policy — Project CONTEXT PANEL.
//
// A play tester who does NOT read the source language still needs the work's CATALOG
// CONTEXT: which work this is (identity + source IDs + aliases), which edition,
// how complete the translation for their target language is, how much demand
// the work has, whether we own a local corpus for it, and how ready the engine
// adapter is. Every one of those is a KNOWN, TYPED catalog fact — the catalog
// read-models (`CatalogBenchmarkSeedRow`, `CatalogReleaseRecord`) plus project
// state (`LocaleBranchStatus`) already carry it.
//
// This module PROJECTS those typed read-model fields into a compact,
// play-tester-facing view-model (`catalogContextPanelViewFromReadModel`) and
// renders it (`renderCatalogContextPanel`). It NEVER touches bridge-unit
// message streams / scene prose: the projection input is structurally limited
// to typed catalog facts + project state, so no raw source-language dialogue
// the play tester cannot read can ever reach the panel. The only source-language
// strings it surfaces are catalog IDENTITY fields (canonical title, alternate
// release titles) — the identity the operator needs to see.

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
 * Typed project state the panel consumes. This is the play tester's localization
 * project context — the target language they are playing in, and (if the
 * work is being localized here) the tracking locale-branch status. Sourced
 * verbatim from `LocaleBranchStatus` (a `ProjectDashboardStatus` read-model
 * field); never re-inferred.
 */
export type CatalogContextProjectState = {
  /** The play tester's working target language (BCP-47), e.g. `en-US`. */
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
  /** Play-tester project state (target language + optional tracking branch). */
  projectState: CatalogContextProjectState;
};

/** DB/API read-model consumed by the live catalog-context dashboard route. */
export type CatalogContextPanelReadModel = CatalogContextPanelInput & {
  schemaVersion: "catalog.context_panel_route.v0.1";
  generatedAt: Date;
  params: {
    projectId: string;
    localeBranchId: string;
    workId: string;
  };
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
 * Translation-completeness view for the play tester's target language, plus the
 * full per-language status list. `targetLanguageStatus` is the status row whose
 * language matches the play tester's target language, if any (so a play tester can
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

export {
  catalogContextPanelStyles,
  renderCatalogContextPanel,
} from "./catalog-context-panel-render.js";
