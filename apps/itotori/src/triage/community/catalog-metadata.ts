// ITOTORI-120 — Catalog metadata projection for community / human feedback
// triage.
//
// The feedback triage queue must NOT blindly accept every report. To route a
// report it first needs to know WHAT the report is against: which work, which
// edition, how complete the translation for the reporter's language is, how
// much demand the work has, how ready the engine adapter is, and whether a
// translation already exists. All of that is KNOWN catalog structure — the
// catalog read-model (`CatalogOpportunityRow`, `CatalogReleaseRecord`,
// `CatalogWorkRecord`) already carries it. This module projects those REAL
// read-model fields into a compact, language-scoped snapshot the enrichment
// service consumes. It invents no metadata: every field below is copied or
// deterministically derived from an existing catalog field (see
// `catalogWorkMetadataFromReadModel`).

import type {
  CatalogBenchmarkDemandBucket,
  CatalogBenchmarkSeedReadiness,
  CatalogBenchmarkSeedTranslationStatus,
  CatalogCompletenessPool,
  CatalogLanguageStatus,
  CatalogOpportunityDemandFacts,
  CatalogOpportunityExistingTranslationSignal,
  CatalogReleaseRecord,
  CatalogWorkRecord,
} from "@itotori/db";

/**
 * A single edition of a work, projected from a catalog release. The triage
 * router matches a report's `requestedEdition` against this list to decide
 * whether the report is even about the edition we translated.
 *
 * Every field is a verbatim copy of a `CatalogReleaseRecord` field.
 */
export type CatalogEditionMetadata = {
  releaseId: string;
  editionName: string | null;
  platform: string | null;
  language: string | null;
  releaseKind: string;
  isOfficial: boolean;
};

/**
 * Collapsed adapter-readiness level for one work. Derived from the per-capability
 * `CatalogBenchmarkSeedReadiness` (identify / inventory / extract / patch). The
 * router treats `patch_ready` / `extract_ready` as workable and everything below
 * as "low readiness" (a fix can't be produced yet).
 */
export const feedbackReadinessLevelValues = {
  patchReady: "patch_ready",
  extractReady: "extract_ready",
  inventoryReady: "inventory_ready",
  identifyReady: "identify_ready",
  unsupported: "unsupported",
  unknown: "unknown",
} as const;

export type FeedbackReadinessLevel =
  (typeof feedbackReadinessLevelValues)[keyof typeof feedbackReadinessLevelValues];

/**
 * Per-work catalog metadata snapshot, language-scoped where relevant. This is
 * the exact set of catalog signals the feedback enrichment consumes. It is a
 * PROJECTION of the catalog read-model — never a re-inference from prose.
 */
export type CatalogWorkMetadataSnapshot = {
  workId: string;
  canonicalTitle: string;
  editions: CatalogEditionMetadata[];
  /**
   * The edition we produced (or target) a translation for, if known. Reports
   * against a DIFFERENT edition route to the edition-mismatch hold path.
   */
  translatedEditionReleaseId: string | null;
  demandBucket: CatalogBenchmarkDemandBucket;
  readiness: CatalogBenchmarkSeedReadiness;
  /** target-language → catalog completeness pool (`no_english`, `mtl_only`, …). */
  completenessByLanguage: Record<string, CatalogCompletenessPool>;
  /** target-language → existing-translation signal (`none`, `mtl`, `official_or_complete`, …). */
  existingTranslationByLanguage: Record<string, CatalogOpportunityExistingTranslationSignal>;
};

/**
 * The metadata resolver the enrichment service depends on. The in-memory
 * implementation below is used by tests and any deterministic (DB-less) caller;
 * a repository-backed implementation projecting the live catalog read-model is a
 * drop-in (it builds each snapshot via `catalogWorkMetadataFromReadModel`).
 */
export interface CatalogFeedbackMetadataProvider {
  resolveWork(workId: string): CatalogWorkMetadataSnapshot | null;
}

/** Deterministic in-memory provider seeded from a fixed set of snapshots. */
export class InMemoryCatalogFeedbackMetadataProvider implements CatalogFeedbackMetadataProvider {
  private readonly byWorkId: ReadonlyMap<string, CatalogWorkMetadataSnapshot>;

  constructor(snapshots: ReadonlyArray<CatalogWorkMetadataSnapshot>) {
    const map = new Map<string, CatalogWorkMetadataSnapshot>();
    for (const snapshot of snapshots) {
      map.set(snapshot.workId, snapshot);
    }
    this.byWorkId = map;
  }

  resolveWork(workId: string): CatalogWorkMetadataSnapshot | null {
    return this.byWorkId.get(workId) ?? null;
  }
}

/**
 * Project the REAL catalog read-model into a feedback metadata snapshot. This is
 * the single place that names which catalog field backs which enrichment signal:
 *
 *   - workId / canonicalTitle      ← `CatalogWorkRecord`
 *   - editions                     ← `CatalogReleaseRecord[]` (edition/platform/language)
 *   - demandBucket                 ← `CatalogOpportunityDemandFacts.demandBucket`
 *   - readiness                    ← `CatalogBenchmarkSeedReadiness` (opportunity row)
 *   - completenessByLanguage       ← opportunity-row `completenessPool` per target language
 *   - existingTranslationByLanguage← `CatalogBenchmarkSeedTranslationStatus[]` (best status)
 *
 * No signal is synthesized; the only computation is deterministic bucketing of
 * the language-status list into an existing-translation signal.
 */
export function catalogWorkMetadataFromReadModel(input: {
  work: Pick<CatalogWorkRecord, "workId" | "canonicalTitle">;
  releases: ReadonlyArray<CatalogReleaseRecord>;
  demandFacts: Pick<CatalogOpportunityDemandFacts, "demandBucket">;
  readiness: CatalogBenchmarkSeedReadiness;
  translationStatuses: ReadonlyArray<CatalogBenchmarkSeedTranslationStatus>;
  completenessByLanguage: Record<string, CatalogCompletenessPool>;
  translatedEditionReleaseId?: string | null;
}): CatalogWorkMetadataSnapshot {
  const existingTranslationByLanguage: Record<string, CatalogOpportunityExistingTranslationSignal> =
    {};
  for (const status of input.translationStatuses) {
    const candidate = existingTranslationFromLanguageStatus(status.status);
    const current = existingTranslationByLanguage[status.language];
    existingTranslationByLanguage[status.language] =
      current === undefined ? candidate : moreCompleteTranslation(current, candidate);
  }

  return {
    workId: input.work.workId,
    canonicalTitle: input.work.canonicalTitle,
    editions: input.releases.map(editionFromRelease),
    translatedEditionReleaseId: input.translatedEditionReleaseId ?? null,
    demandBucket: input.demandFacts.demandBucket,
    readiness: input.readiness,
    completenessByLanguage: { ...input.completenessByLanguage },
    existingTranslationByLanguage,
  };
}

function editionFromRelease(release: CatalogReleaseRecord): CatalogEditionMetadata {
  return {
    releaseId: release.releaseId,
    editionName: release.editionName,
    platform: release.platform,
    language: release.language,
    releaseKind: release.releaseKind,
    isOfficial: release.isOfficial,
  };
}

/**
 * Collapse the per-capability catalog readiness record into a single ordered
 * level. Ordering mirrors the adapter-readiness ladder used by the catalog
 * opportunity ranking (patch > extract > inventory > identify).
 */
export function deriveFeedbackReadinessLevel(
  readiness: CatalogBenchmarkSeedReadiness,
): FeedbackReadinessLevel {
  if (readiness.patch === "supported") {
    return feedbackReadinessLevelValues.patchReady;
  }
  if (readiness.extract === "supported" || readiness.patch === "partial") {
    return feedbackReadinessLevelValues.extractReady;
  }
  if (readiness.inventory === "supported") {
    return feedbackReadinessLevelValues.inventoryReady;
  }
  if (readiness.identify === "supported") {
    return feedbackReadinessLevelValues.identifyReady;
  }
  if (
    readiness.identify === "unsupported" &&
    readiness.inventory === "unsupported" &&
    readiness.extract === "unsupported" &&
    readiness.patch === "unsupported"
  ) {
    return feedbackReadinessLevelValues.unsupported;
  }
  return feedbackReadinessLevelValues.unknown;
}

/**
 * `patch_ready` / `extract_ready` mean a fix can actually be produced. Anything
 * below cannot yet be shipped, so a report against such a work routes to a
 * defer/backlog path rather than the review queue.
 */
export function isLowFeedbackReadiness(level: FeedbackReadinessLevel): boolean {
  return (
    level !== feedbackReadinessLevelValues.patchReady &&
    level !== feedbackReadinessLevelValues.extractReady
  );
}

const existingTranslationRank: Record<CatalogOpportunityExistingTranslationSignal, number> = {
  official_or_complete: 4,
  fan_partial: 3,
  mtl: 2,
  none: 1,
  unknown: 0,
};

function moreCompleteTranslation(
  left: CatalogOpportunityExistingTranslationSignal,
  right: CatalogOpportunityExistingTranslationSignal,
): CatalogOpportunityExistingTranslationSignal {
  return existingTranslationRank[right] > existingTranslationRank[left] ? right : left;
}

/**
 * Map a raw catalog language status onto the coarser existing-translation
 * signal the opportunity ranking already uses. Deterministic and total over the
 * closed `CatalogLanguageStatus` enum.
 */
export function existingTranslationFromLanguageStatus(
  status: CatalogLanguageStatus,
): CatalogOpportunityExistingTranslationSignal {
  switch (status) {
    case "official_full":
    case "fan_full":
      return "official_or_complete";
    case "fan_partial":
    case "interface_only":
      return "fan_partial";
    case "mtl":
      return "mtl";
    case "none":
      return "none";
    case "unverified_console":
    case "unknown":
      return "unknown";
    default:
      return assertNeverLanguageStatus(status);
  }
}

function assertNeverLanguageStatus(value: never): never {
  throw new Error(`unexpected catalog language status ${String(value)}`);
}
