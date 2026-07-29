import {
  CapabilityLevel,
  CapabilityLevelStatusKind,
  CatalogConfidence,
  CatalogConflictKind,
  CatalogConflictStatus,
  CatalogExternalIdKind,
  CatalogLanguageStatus,
  CatalogLanguageStatusScope,
  CatalogOpportunityRuntimeEvidenceSignal,
  CatalogPlatformLanguageConflictOrigin,
  CatalogRawContentRedactionClass,
  CatalogSource,
  CatalogSourceRecordKind,
} from "./dependencies.js";
import { CatalogReleaseRecord } from "./catalog-record-types.js";
import {
  CatalogConflictReviewExactLinkRef,
  CatalogConflictReviewFuzzyScore,
  CatalogConflictReviewProvenance,
  CatalogConflictReviewResolution,
  CatalogConflictReviewSeverity,
  CatalogConflictReviewSourceId,
  CatalogConflictReviewStatus,
} from "./catalog-work-scan-types.js";

export type CatalogConflictReviewRow = {
  reviewId: string;
  catalogRecordId: string;
  conflictId: string | null;
  candidateIds: string[];
  candidateCatalogIds: string[];
  exactLinkRefs: CatalogConflictReviewExactLinkRef[];
  fuzzyScores: CatalogConflictReviewFuzzyScore[];
  sourceIds: CatalogConflictReviewSourceId[];
  provenance: CatalogConflictReviewProvenance[];
  privateSourceCount: number;
  severity: CatalogConflictReviewSeverity;
  status: CatalogConflictReviewStatus;
  reasonCode: string;
  reasonDetail: string;
  /**
   * Whether this conflict's candidate payload was hand-authored by a fixture or derived
   * from live repository candidate rows. Meaningful for platform-language conflicts;
   * defaults to `fixture_authored` for other review rows.
   */
  conflictOrigin: CatalogPlatformLanguageConflictOrigin;
  conflictKind: CatalogConflictKind | null;
  detectedAt: Date;
  resolution: CatalogConflictReviewResolution | null;
};

export type CatalogConflictReviewReadModel = {
  rows: CatalogConflictReviewRow[];
};

export type CatalogConflictReviewFilter = {
  source?: CatalogSource;
  severity?: CatalogConflictReviewSeverity;
  status?: CatalogConflictReviewStatus;
  catalogRecordId?: string;
};

export const catalogCompletenessPoolValues = {
  mtlOnly: "mtl_only",
  fanPartial: "fan_partial",
  noEnglish: "no_english",
  unknown: "unknown",
  conflict: "conflict",
} as const;

export type CatalogCompletenessPool =
  (typeof catalogCompletenessPoolValues)[keyof typeof catalogCompletenessPoolValues];

export type CatalogCompletenessPoolFilter = {
  targetLanguage?: string;
  pool?: CatalogCompletenessPool;
};

export type CatalogCompletenessSourceSummary = {
  sourceProvenanceId: string;
  catalogSource: CatalogSource;
  sourceRecordKind: CatalogSourceRecordKind;
  sourceId: string;
  sourceVersion: string | null;
  fetchedAt: Date;
  rawContentRedactionClass: CatalogRawContentRedactionClass;
};

export type CatalogCompletenessStatusFact = {
  languageStatusId: string;
  language: string;
  status: CatalogLanguageStatus;
  statusScope: CatalogLanguageStatusScope;
  platform: string | null;
  releaseId: string | null;
  sourceProvenanceId: string | null;
  source: CatalogCompletenessSourceSummary | null;
  privateSourceCount: number;
  confidence: CatalogConfidence;
  observedAt: Date;
  importedAt: Date;
  parserVersion: string;
  rawContentRedactionClass: CatalogRawContentRedactionClass;
};

export type CatalogCompletenessConflictSummary = {
  conflictId: string;
  status: CatalogConflictStatus;
  reasonCode: string;
  sourceIds: CatalogConflictReviewSourceId[];
  privateSourceCount: number;
};

export type CatalogCompletenessPoolWork = {
  workId: string;
  canonicalTitle: string;
  originalLanguage: string | null;
  sourceIds: CatalogConflictReviewSourceId[];
  privateSourceCount: number;
  statuses: CatalogCompletenessStatusFact[];
  conflicts: CatalogCompletenessConflictSummary[];
};

export type CatalogCompletenessPublicPoolReport = {
  pool: CatalogCompletenessPool;
  workCount: number;
  sourceIds: CatalogConflictReviewSourceId[];
};

export type CatalogCompletenessPublicStatusReport = {
  status: CatalogLanguageStatus;
  factCount: number;
  sourceIds: CatalogConflictReviewSourceId[];
};

export type CatalogCompletenessPublicReport = {
  schemaVersion: "catalog.completeness_public_report.v0.1";
  targetLanguage: string;
  generatedAt: Date;
  totalWorkCount: number;
  conflictCount: number;
  pools: CatalogCompletenessPublicPoolReport[];
  statuses: CatalogCompletenessPublicStatusReport[];
};

export type CatalogCompletenessBenchmarkPools = {
  targetLanguage: string;
  pools: Record<CatalogCompletenessPool, CatalogCompletenessPoolWork[]>;
  publicReport: CatalogCompletenessPublicReport;
};

export type CatalogAlphaBenchmarkOpportunityDecision = "seed" | "demoted";

export type CatalogAlphaBenchmarkOpportunityDemotion = {
  reasonCode: string;
  reasonDetail: string;
  conflictOrigin: CatalogPlatformLanguageConflictOrigin;
  conflictId: string | null;
  severity: CatalogConflictReviewSeverity;
  sourceIds: CatalogConflictReviewSourceId[];
  provenance: CatalogConflictReviewProvenance[];
};

export type CatalogAlphaBenchmarkOpportunity = {
  rank: number;
  seedRank: number | null;
  workId: string;
  canonicalTitle: string;
  originalLanguage: string | null;
  candidatePool: CatalogCompletenessPool;
  decision: CatalogAlphaBenchmarkOpportunityDecision;
  score: number;
  explanation: string;
  sourceIds: CatalogConflictReviewSourceId[];
  statuses: CatalogCompletenessStatusFact[];
  demotions: CatalogAlphaBenchmarkOpportunityDemotion[];
};

export type CatalogAlphaBenchmarkOpportunityRanking = {
  schemaVersion: "catalog.alpha_benchmark_opportunity_ranking.v0.1";
  targetLanguage: string;
  generatedAt: Date;
  rows: CatalogAlphaBenchmarkOpportunity[];
};

export type CatalogAlphaBenchmarkOpportunityRankingFilter = {
  targetLanguage?: string;
  includeDemoted?: boolean;
};

export type CatalogBenchmarkDemandBucket = "none" | "low" | "medium" | "high" | "very_high";

export type CatalogBenchmarkLocalOwnership = "owned" | "not_owned" | "unknown";

export type CatalogBenchmarkSeedReadinessLevel = CapabilityLevelStatusKind | "unknown";

export type CatalogBenchmarkSeedFinderDecision = "seed" | "candidate" | "demoted" | "excluded";

export type CatalogBenchmarkSeedFinderFilter = {
  targetLanguage?: string;
  pools?: CatalogCompletenessPool[];
  minCapabilityLevel?: CapabilityLevel;
  requiredCapabilities?: CapabilityLevel[];
  adapterIds?: string[];
  demandBucket?: CatalogBenchmarkDemandBucket;
  translationCompleteness?: CatalogLanguageStatus[];
  provenanceRequired?: boolean;
  localOwnership?: CatalogBenchmarkLocalOwnership;
  includeDemoted?: boolean;
  limit?: number;
};

export type CatalogBenchmarkSeedSourceId = {
  catalogSource: CatalogSource;
  sourceId: string;
  externalIdKind: CatalogExternalIdKind;
};

export type CatalogBenchmarkSeedTranslationStatus = {
  language: string;
  status: CatalogLanguageStatus;
  confidence: CatalogConfidence;
  statusScope: CatalogLanguageStatusScope;
  platform: string | null;
};

export type CatalogBenchmarkSeedReadiness = {
  adapterId: string | null;
  identify: CatalogBenchmarkSeedReadinessLevel;
  inventory: CatalogBenchmarkSeedReadinessLevel;
  extract: CatalogBenchmarkSeedReadinessLevel;
  patch: CatalogBenchmarkSeedReadinessLevel;
  helper: CatalogBenchmarkSeedReadinessLevel;
  runtime: CatalogBenchmarkSeedReadinessLevel;
};

export type CatalogBenchmarkSeedProvenanceSummary = {
  catalogSource: CatalogSource;
  sourceId: string;
  sourceRecordKind: CatalogSourceRecordKind;
  sourceVersion: string | null;
  fixtureId: string | null;
  redactionClass: CatalogRawContentRedactionClass;
};

export type CatalogBenchmarkSeedRow = {
  workId: string;
  canonicalTitle: string;
  originalLanguage: string | null;
  sourceIds: CatalogBenchmarkSeedSourceId[];
  completenessPool: CatalogCompletenessPool;
  translationStatuses: CatalogBenchmarkSeedTranslationStatus[];
  localOwnership: CatalogBenchmarkLocalOwnership;
  localEvidenceCount: number;
  demandBucket: CatalogBenchmarkDemandBucket;
  readiness: CatalogBenchmarkSeedReadiness;
  provenance: CatalogBenchmarkSeedProvenanceSummary[];
  decision: CatalogBenchmarkSeedFinderDecision;
  rank: number;
  seedRank: number | null;
  explanationCodes: string[];
};

export type CatalogBenchmarkSeedFinderReadModel = {
  schemaVersion: "catalog.benchmark_seed_finder.v0.1";
  targetLanguage: string;
  generatedAt: Date;
  rows: CatalogBenchmarkSeedRow[];
};

export type CatalogContextPanelCatalogReadModel = {
  schemaVersion: "catalog.context_panel_catalog.v0.1";
  targetLanguage: string;
  generatedAt: Date;
  row: CatalogBenchmarkSeedRow;
  releases: CatalogReleaseRecord[];
};

export type CatalogOpportunityRankingFilter = {
  targetLanguage?: string;
  includeDemoted?: boolean;
  limit?: number;
  engine?: string;
  pool?: CatalogCompletenessPool;
  minCapabilityLevel?: CapabilityLevel;
  localOwnership?: CatalogBenchmarkLocalOwnership;
  demandBucket?: CatalogBenchmarkDemandBucket;
};

export type CatalogOpportunityDemandFacts = {
  demandBucket: CatalogBenchmarkDemandBucket;
  dlCount: number | null;
  ratingAverage: number | null;
  ratingCount: number | null;
  wishlistCount: number | null;
  bestRank: number | null;
  workType: string | null;
};

export type CatalogOpportunityRuntimeEvidenceReadiness = {
  status: CatalogOpportunityRuntimeEvidenceSignal;
  publicFixtureEvidenceCount: number;
  privateLocalAggregateEvidenceCount: number;
};
