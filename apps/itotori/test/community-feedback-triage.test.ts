// ITOTORI-120 — metadata-aware community/human feedback triage tests.
//
// Proves the two acceptance criteria:
//   1. A raw feedback item is enriched with ALL required catalog signals:
//      work identity, edition, language completeness, demand bucket, readiness
//      level, and existing translation status.
//   2. The triage queue uses those signals to route/prioritize — it does NOT
//      blindly accept every report. Two items with different metadata route
//      and prioritize differently, and a style-dispute routes to the style path.
//
// All catalog metadata is resolved deterministically from synthetic snapshots —
// no DB, no LLM, no network.

import { describe, expect, it } from "vitest";
import {
  catalogConfidenceValues,
  type CatalogBenchmarkSeedReadiness,
  type CatalogBenchmarkSeedTranslationStatus,
  type CatalogReleaseRecord,
  catalogLanguageStatusScopeValues,
  catalogLanguageStatusValues,
  catalogReleaseKindValues,
  catalogReleasePackageKindValues,
  catalogSourceValues,
  feedbackTypeValues,
} from "@itotori/db";
import {
  type CatalogWorkMetadataSnapshot,
  catalogWorkMetadataFromReadModel,
  enrichCommunityFeedback,
  feedbackEditionMatchValues,
  feedbackQueueLaneValues,
  feedbackTriageDispositionValues,
  InMemoryCatalogFeedbackMetadataProvider,
  type RawCommunityFeedbackItem,
  routeEnrichedFeedback,
} from "../src/triage/index.js";

// ---------------------------------------------------------------------------
// Synthetic catalog fixtures
// ---------------------------------------------------------------------------

const PC_RELEASE = "release-pc";
const SWITCH_RELEASE = "release-switch";

function readiness(
  overrides: Partial<CatalogBenchmarkSeedReadiness> = {},
): CatalogBenchmarkSeedReadiness {
  return {
    adapterId: "kaifuu-reallive",
    identify: "supported",
    inventory: "supported",
    extract: "supported",
    patch: "supported",
    helper: "supported",
    runtime: "supported",
    ...overrides,
  };
}

function translationStatus(
  language: string,
  status: CatalogBenchmarkSeedTranslationStatus["status"],
): CatalogBenchmarkSeedTranslationStatus {
  return {
    language,
    status,
    confidence: catalogConfidenceValues.high,
    statusScope: catalogLanguageStatusScopeValues.work,
    platform: null,
  };
}

function release(
  overrides: Partial<CatalogReleaseRecord> & { releaseId: string },
): CatalogReleaseRecord {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    workId: "work-alpha",
    catalogSource: catalogSourceValues.vndb,
    sourceReleaseId: null,
    releaseTitle: "Release",
    releaseKind: catalogReleaseKindValues.original,
    editionName: null,
    milestone: null,
    packageKind: catalogReleasePackageKindValues.looseFiles,
    engineName: null,
    engineSource: null,
    engineConfidence: null,
    engineProvenanceId: null,
    platform: null,
    language: null,
    releaseDate: null,
    releaseYear: null,
    isOfficial: false,
    sourceProvenanceId: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// A completed, high-demand, patch-ready work with two editions (PC translated,
// Switch not). Built via the REAL read-model projection so the test also proves
// the signals come from real catalog fields.
const completedHighDemand: CatalogWorkMetadataSnapshot = catalogWorkMetadataFromReadModel({
  work: { workId: "work-alpha", canonicalTitle: "Alpha Story" },
  releases: [
    release({
      releaseId: PC_RELEASE,
      workId: "work-alpha",
      editionName: "Standard",
      platform: "windows",
      language: "ja",
      releaseKind: catalogReleaseKindValues.original,
    }),
    release({
      releaseId: SWITCH_RELEASE,
      workId: "work-alpha",
      editionName: "Perfect Edition",
      platform: "switch",
      language: "ja",
      releaseKind: catalogReleaseKindValues.edition,
    }),
  ],
  demandFacts: { demandBucket: "very_high" },
  readiness: readiness(),
  translationStatuses: [translationStatus("en", catalogLanguageStatusValues.officialFull)],
  completenessByLanguage: { en: "fan_partial" },
  translatedEditionReleaseId: PC_RELEASE,
});

// A low-demand work with NO English translation and only identify-level adapter
// support (cannot produce a fix).
const untranslatedLowReadiness: CatalogWorkMetadataSnapshot = {
  workId: "work-beta",
  canonicalTitle: "Beta Tale",
  editions: [
    {
      releaseId: "release-beta-pc",
      editionName: "Standard",
      platform: "windows",
      language: "ja",
      releaseKind: catalogReleaseKindValues.original,
      isOfficial: true,
    },
  ],
  translatedEditionReleaseId: null,
  demandBucket: "low",
  readiness: {
    adapterId: null,
    identify: "supported",
    inventory: "unsupported",
    extract: "unsupported",
    patch: "unsupported",
    helper: "unsupported",
    runtime: "unsupported",
  },
  completenessByLanguage: { en: "no_english" },
  existingTranslationByLanguage: { en: "none" },
};

const provider = new InMemoryCatalogFeedbackMetadataProvider([
  completedHighDemand,
  untranslatedLowReadiness,
]);

function rawItem(overrides: Partial<RawCommunityFeedbackItem> = {}): RawCommunityFeedbackItem {
  return {
    feedbackId: "fb-1",
    workId: "work-alpha",
    targetLanguage: "en",
    feedbackType: feedbackTypeValues.objectiveDefect,
    reporterRole: "community",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Enrichment: all required signals resolved
// ---------------------------------------------------------------------------

describe("enrichCommunityFeedback", () => {
  it("enriches a raw item with work identity, edition, completeness, demand, readiness, existing-translation", () => {
    const enriched = enrichCommunityFeedback(
      rawItem({ requestedEdition: { platform: "windows" } }),
      provider,
    );

    expect(enriched.resolution).toBe("resolved");
    expect(enriched.workIdentity).toEqual({ workId: "work-alpha", canonicalTitle: "Alpha Story" });
    expect(enriched.edition.resolved?.releaseId).toBe(PC_RELEASE);
    expect(enriched.edition.match).toBe(feedbackEditionMatchValues.matchesTranslated);
    expect(enriched.languageCompleteness).toBe("fan_partial");
    expect(enriched.demandBucket).toBe("very_high");
    expect(enriched.readinessLevel).toBe("patch_ready");
    expect(enriched.existingTranslationStatus).toBe("official_or_complete");
    expect(enriched.styleDispute).toBe(false);
  });

  it("marks an unresolved work and leaves catalog signals null", () => {
    const enriched = enrichCommunityFeedback(rawItem({ workId: "work-missing" }), provider);
    expect(enriched.resolution).toBe("unresolved_work");
    expect(enriched.workIdentity).toBeNull();
    expect(enriched.demandBucket).toBeNull();
    expect(enriched.readinessLevel).toBeNull();
  });

  it("resolves existing-translation from the real language-status list", () => {
    const enriched = enrichCommunityFeedback(rawItem({ workId: "work-beta" }), provider);
    expect(enriched.existingTranslationStatus).toBe("none");
    expect(enriched.languageCompleteness).toBe("no_english");
    expect(enriched.readinessLevel).toBe("identify_ready");
  });
});

// ---------------------------------------------------------------------------
// 2. Routing: uses the signals, does NOT blindly accept
// ---------------------------------------------------------------------------

describe("routeEnrichedFeedback", () => {
  it("routes two different-metadata items differently (not blind-accept)", () => {
    const completed = routeEnrichedFeedback(
      enrichCommunityFeedback(rawItem({ workId: "work-alpha", feedbackId: "fb-a" }), provider),
    );
    const untranslated = routeEnrichedFeedback(
      enrichCommunityFeedback(rawItem({ workId: "work-beta", feedbackId: "fb-b" }), provider),
    );

    // Completed high-demand → accepted into review, fast-tracked, high priority.
    expect(completed.disposition).toBe(feedbackTriageDispositionValues.fastTrackHighDemand);
    expect(completed.lane).toBe(feedbackQueueLaneValues.reviewerQueue);
    expect(completed.accepted).toBe(true);

    // Untranslated → held in the backlog, NOT accepted.
    expect(untranslated.disposition).toBe(feedbackTriageDispositionValues.holdPendingTranslation);
    expect(untranslated.lane).toBe(feedbackQueueLaneValues.backlog);
    expect(untranslated.accepted).toBe(false);

    // Different route AND different priority — the queue is not blindly accepting.
    expect(completed.disposition).not.toBe(untranslated.disposition);
    expect(completed.accepted).not.toBe(untranslated.accepted);
    expect(completed.priority).toBeGreaterThan(untranslated.priority);
  });

  it("routes a style dispute to the style path", () => {
    const decision = routeEnrichedFeedback(
      enrichCommunityFeedback(
        rawItem({ workId: "work-alpha", feedbackType: feedbackTypeValues.stylePreference }),
        provider,
      ),
    );
    expect(decision.disposition).toBe(feedbackTriageDispositionValues.routeToStylePath);
    expect(decision.lane).toBe(feedbackQueueLaneValues.styleGuide);
    expect(decision.signals.styleDispute).toBe(true);
  });

  it("holds a report against a different (non-translated) edition", () => {
    const decision = routeEnrichedFeedback(
      enrichCommunityFeedback(
        rawItem({ workId: "work-alpha", requestedEdition: { platform: "switch" } }),
        provider,
      ),
    );
    expect(decision.signals.editionMatch).toBe(feedbackEditionMatchValues.differentEdition);
    expect(decision.disposition).toBe(feedbackTriageDispositionValues.holdEditionMismatch);
    expect(decision.accepted).toBe(false);
  });

  it("defers a report when adapter readiness is too low to produce a fix", () => {
    // work-gamma: translation exists (so it is not the no-translation path) but
    // the adapter is only inventory-ready.
    const gammaProvider = new InMemoryCatalogFeedbackMetadataProvider([
      {
        workId: "work-gamma",
        canonicalTitle: "Gamma",
        editions: [],
        translatedEditionReleaseId: null,
        demandBucket: "medium",
        readiness: {
          adapterId: null,
          identify: "supported",
          inventory: "supported",
          extract: "unsupported",
          patch: "unsupported",
          helper: "unsupported",
          runtime: "unsupported",
        },
        completenessByLanguage: { en: "mtl_only" },
        existingTranslationByLanguage: { en: "mtl" },
      },
    ]);
    const decision = routeEnrichedFeedback(
      enrichCommunityFeedback(rawItem({ workId: "work-gamma" }), gammaProvider),
    );
    expect(decision.disposition).toBe(feedbackTriageDispositionValues.deferLowReadiness);
    expect(decision.accepted).toBe(false);
  });

  it("holds an unresolved work for needs-context", () => {
    const decision = routeEnrichedFeedback(
      enrichCommunityFeedback(rawItem({ workId: "work-missing" }), provider),
    );
    expect(decision.disposition).toBe(feedbackTriageDispositionValues.holdUnresolvedWork);
    expect(decision.lane).toBe(feedbackQueueLaneValues.needsContext);
    expect(decision.accepted).toBe(false);
  });

  it("gives more corroborated reports a higher priority within the same route", () => {
    const single = routeEnrichedFeedback(
      enrichCommunityFeedback(rawItem({ workId: "work-alpha", reportCount: 1 }), provider),
    );
    const many = routeEnrichedFeedback(
      enrichCommunityFeedback(rawItem({ workId: "work-alpha", reportCount: 5 }), provider),
    );
    expect(many.disposition).toBe(single.disposition);
    expect(many.priority).toBeGreaterThan(single.priority);
  });
});
