// ITOTORI-120 — Feedback triage metadata ENRICHMENT service.
//
// Given a raw human / community feedback item (which work + edition it is
// against, the reporter's target language, and the feedback type), resolve the
// catalog metadata that lets the triage queue make a routing decision instead of
// blindly accepting the report:
//
//   - work identity            (workId + canonicalTitle)
//   - edition                  (the resolved edition + whether it matches the
//                               edition we translated)
//   - language completeness    (catalog completeness pool for the target language)
//   - demand bucket            (catalog DLsite demand bucket)
//   - readiness level          (collapsed adapter-readiness ladder)
//   - existing translation     (none / mtl / fan_partial / official_or_complete)
//
// The enrichment is DETERMINISTIC: it resolves catalog metadata through a
// provider (in-memory for tests, repository-backed in production). It makes no
// model or network call.

import { feedbackTypeValues, type FeedbackType } from "@itotori/db";
import type {
  CatalogBenchmarkDemandBucket,
  CatalogCompletenessPool,
  CatalogOpportunityExistingTranslationSignal,
} from "@itotori/db";
import {
  type CatalogEditionMetadata,
  type CatalogFeedbackMetadataProvider,
  deriveFeedbackReadinessLevel,
  type FeedbackReadinessLevel,
} from "./catalog-metadata.js";

/**
 * Which specific edition a report is filed against. All fields optional: a
 * reporter may only know the platform ("the Switch version") or the edition name
 * ("Perfect Edition"). When empty, the report is treated as targeting whatever
 * edition we translated.
 */
export type RequestedEditionRef = {
  releaseId?: string;
  editionName?: string;
  platform?: string;
};

/**
 * Raw feedback item entering the community/human triage path. Intentionally
 * narrow — it carries only what is needed to resolve catalog metadata and route.
 * The rich evidence (attachments, line refs) lives on the persisted
 * `feedback_reports` row; this is the routing-facing projection.
 */
export type RawCommunityFeedbackItem = {
  feedbackId: string;
  workId: string;
  targetLanguage: string;
  feedbackType: FeedbackType;
  /** e.g. "community", "playtester", "reviewer". Community reports may need corroboration. */
  reporterRole: string;
  requestedEdition?: RequestedEditionRef;
  /** How many distinct reporters raised this (aggregated). Defaults to 1. */
  reportCount?: number;
};

export const feedbackEditionMatchValues = {
  /** Reporter named no specific edition; treated as the translated edition. */
  unspecified: "unspecified",
  /** Reporter's edition matches the edition we translated. */
  matchesTranslated: "matches_translated",
  /** Reporter's edition resolves to a KNOWN but DIFFERENT edition of the work. */
  differentEdition: "different_edition",
  /** Reporter named an edition that is not in the catalog for this work. */
  unknownEdition: "unknown_edition",
} as const;

export type FeedbackEditionMatch =
  (typeof feedbackEditionMatchValues)[keyof typeof feedbackEditionMatchValues];

export type EnrichedFeedbackEdition = {
  requested: RequestedEditionRef | null;
  resolved: CatalogEditionMetadata | null;
  translated: CatalogEditionMetadata | null;
  match: FeedbackEditionMatch;
};

/**
 * A raw feedback item enriched with the catalog metadata signals. When the work
 * cannot be resolved, `resolution` is `unresolved_work` and every catalog signal
 * is `null` — the router holds such items rather than accepting them.
 */
export type EnrichedFeedbackItem = {
  feedbackId: string;
  raw: RawCommunityFeedbackItem;
  resolution: "resolved" | "unresolved_work";
  workIdentity: { workId: string; canonicalTitle: string } | null;
  edition: EnrichedFeedbackEdition;
  languageCompleteness: CatalogCompletenessPool | null;
  demandBucket: CatalogBenchmarkDemandBucket | null;
  readinessLevel: FeedbackReadinessLevel | null;
  existingTranslationStatus: CatalogOpportunityExistingTranslationSignal | null;
  /** True when the feedback type is a style preference (routes to the style path). */
  styleDispute: boolean;
};

/**
 * Enrich a raw feedback item with catalog metadata. Pure given the provider;
 * the provider is the only source of catalog facts.
 */
export function enrichCommunityFeedback(
  raw: RawCommunityFeedbackItem,
  provider: CatalogFeedbackMetadataProvider,
): EnrichedFeedbackItem {
  const styleDispute = raw.feedbackType === feedbackTypeValues.stylePreference;
  const snapshot = provider.resolveWork(raw.workId);

  if (snapshot === null) {
    return {
      feedbackId: raw.feedbackId,
      raw,
      resolution: "unresolved_work",
      workIdentity: null,
      edition: {
        requested: raw.requestedEdition ?? null,
        resolved: null,
        translated: null,
        match: raw.requestedEdition
          ? feedbackEditionMatchValues.unknownEdition
          : feedbackEditionMatchValues.unspecified,
      },
      languageCompleteness: null,
      demandBucket: null,
      readinessLevel: null,
      existingTranslationStatus: null,
      styleDispute,
    };
  }

  const translated =
    snapshot.editions.find(
      (edition) => edition.releaseId === snapshot.translatedEditionReleaseId,
    ) ?? null;
  const { resolved, match } = resolveEdition(raw.requestedEdition, snapshot.editions, translated);

  return {
    feedbackId: raw.feedbackId,
    raw,
    resolution: "resolved",
    workIdentity: { workId: snapshot.workId, canonicalTitle: snapshot.canonicalTitle },
    edition: {
      requested: raw.requestedEdition ?? null,
      resolved,
      translated,
      match,
    },
    languageCompleteness: snapshot.completenessByLanguage[raw.targetLanguage] ?? null,
    demandBucket: snapshot.demandBucket,
    readinessLevel: deriveFeedbackReadinessLevel(snapshot.readiness),
    existingTranslationStatus:
      snapshot.existingTranslationByLanguage[raw.targetLanguage] ?? "unknown",
    styleDispute,
  };
}

function resolveEdition(
  requested: RequestedEditionRef | undefined,
  editions: ReadonlyArray<CatalogEditionMetadata>,
  translated: CatalogEditionMetadata | null,
): { resolved: CatalogEditionMetadata | null; match: FeedbackEditionMatch } {
  if (requested === undefined || !hasEditionSignal(requested)) {
    // No edition named → the report is about the edition we translated.
    return { resolved: translated, match: feedbackEditionMatchValues.unspecified };
  }

  const resolved = editions.find((edition) => editionMatchesRequest(edition, requested)) ?? null;
  if (resolved === null) {
    return { resolved: null, match: feedbackEditionMatchValues.unknownEdition };
  }
  if (translated !== null && resolved.releaseId === translated.releaseId) {
    return { resolved, match: feedbackEditionMatchValues.matchesTranslated };
  }
  return { resolved, match: feedbackEditionMatchValues.differentEdition };
}

function hasEditionSignal(requested: RequestedEditionRef): boolean {
  return (
    isNonEmpty(requested.releaseId) ||
    isNonEmpty(requested.editionName) ||
    isNonEmpty(requested.platform)
  );
}

function editionMatchesRequest(
  edition: CatalogEditionMetadata,
  requested: RequestedEditionRef,
): boolean {
  if (isNonEmpty(requested.releaseId)) {
    return edition.releaseId === requested.releaseId;
  }
  const nameMatches =
    !isNonEmpty(requested.editionName) ||
    equalsIgnoreCase(edition.editionName, requested.editionName);
  const platformMatches =
    !isNonEmpty(requested.platform) || equalsIgnoreCase(edition.platform, requested.platform);
  // At least one positive signal must be present (guaranteed by hasEditionSignal).
  return nameMatches && platformMatches;
}

function equalsIgnoreCase(value: string | null, other: string | undefined): boolean {
  if (value === null || other === undefined) {
    return false;
  }
  return value.trim().toLowerCase() === other.trim().toLowerCase();
}

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Convenience: the closed set of feedback types treated as style disputes. */
export const STYLE_DISPUTE_FEEDBACK_TYPES: ReadonlySet<FeedbackType> = new Set<FeedbackType>([
  feedbackTypeValues.stylePreference,
]);
