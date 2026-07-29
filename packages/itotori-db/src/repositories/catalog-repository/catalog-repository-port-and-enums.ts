import {
  AuthorizationActor,
  CatalogCandidateMatchStatus,
  CatalogConfidence,
  CatalogConflictKind,
  CatalogConflictStatus,
  CatalogConflictSubjectKind,
  CatalogDemandFactKind,
  CatalogEngineSource,
  CatalogExternalIdKind,
  CatalogInstallState,
  CatalogOpportunityDecision,
  CatalogOpportunityFactor,
  CatalogOpportunityMarketPrevalenceSignal,
  CatalogPathRedactionClass,
  CatalogPlatformLanguageConflictOrigin,
  CatalogRawContentRedactionClass,
  CatalogReleaseKind,
  CatalogReleaseMappingKind,
  CatalogReleasePackageKind,
  CatalogSeedOrigin,
  CatalogSeedStatus,
  CatalogSource,
  CatalogSourceRecordKind,
  CatalogTranslationPortability,
  catalogCandidateMatchStatusValues,
  catalogConfidenceValues,
  catalogConflictKindValues,
  catalogConflictStatusValues,
  catalogConflictSubjectKindValues,
  catalogDemandFactKindValues,
  catalogEngineSourceValues,
  catalogInstallStateValues,
  catalogOpportunityWeightsVersion,
  catalogPathRedactionClassValues,
  catalogRawContentRedactionClassValues,
  catalogReleaseKindValues,
  catalogReleaseMappingKindValues,
  catalogReleasePackageKindValues,
  catalogSeedOriginValues,
  catalogSeedStatusValues,
  catalogSourceRecordKindValues,
  catalogTranslationPortabilityValues,
} from "./dependencies.js";
export {
  catalogExternalIdKinds,
  catalogLanguageStatusScopes,
  catalogLanguageStatuses as catalogLanguageStatusEnums,
  catalogSources,
} from "./catalog-enum-values.js";
import {
  CatalogSourceProvenanceInput,
  CatalogSourceProvenanceRecord,
} from "./catalog-record-types.js";
import {
  CatalogCandidateMatchInput,
  CatalogCandidateMatchRecord,
  CatalogCandidateTargetWorkRecord,
  CatalogConflictReviewSeverity,
  CatalogConflictReviewSourceId,
  CatalogLocalScanInput,
  CatalogLocalScanRecord,
  CatalogSeedTargetInput,
  CatalogSeedTargetRecord,
  CatalogWorkInput,
  CatalogWorkSnapshot,
} from "./catalog-work-scan-types.js";
import {
  CatalogAlphaBenchmarkOpportunityRanking,
  CatalogAlphaBenchmarkOpportunityRankingFilter,
  CatalogBenchmarkDemandBucket,
  CatalogBenchmarkLocalOwnership,
  CatalogBenchmarkSeedFinderFilter,
  CatalogBenchmarkSeedFinderReadModel,
  CatalogBenchmarkSeedProvenanceSummary,
  CatalogBenchmarkSeedReadiness,
  CatalogBenchmarkSeedSourceId,
  CatalogBenchmarkSeedTranslationStatus,
  CatalogCompletenessBenchmarkPools,
  CatalogCompletenessPool,
  CatalogCompletenessPoolFilter,
  CatalogConflictReviewFilter,
  CatalogConflictReviewReadModel,
  CatalogContextPanelCatalogReadModel,
  CatalogOpportunityDemandFacts,
  CatalogOpportunityRankingFilter,
  CatalogOpportunityRuntimeEvidenceReadiness,
  catalogCompletenessPoolValues,
} from "./catalog-read-model-types.js";

export type CatalogOpportunityDemotion = {
  reasonCode: string;
  conflictOrigin: CatalogPlatformLanguageConflictOrigin;
  conflictId: string | null;
  severity: CatalogConflictReviewSeverity;
  sourceIds: CatalogConflictReviewSourceId[];
};

export type CatalogOpportunityRow = {
  rank: number;
  workId: string;
  canonicalTitle: string;
  originalLanguage: string | null;
  sourceIds: CatalogBenchmarkSeedSourceId[];
  engineName: string | null;
  adapterId: string | null;
  readiness: CatalogBenchmarkSeedReadiness;
  runtimeEvidenceReadiness: CatalogOpportunityRuntimeEvidenceReadiness;
  completenessPool: CatalogCompletenessPool;
  translationStatuses: CatalogBenchmarkSeedTranslationStatus[];
  demandFacts: CatalogOpportunityDemandFacts;
  localOwnership: CatalogBenchmarkLocalOwnership;
  localEvidenceCount: number;
  marketPrevalence: CatalogOpportunityMarketPrevalenceSignal;
  decision: CatalogOpportunityDecision;
  score: number;
  factorBreakdown: CatalogOpportunityFactor[];
  explanationCodes: string[];
  provenance: CatalogBenchmarkSeedProvenanceSummary[];
  demotions: CatalogOpportunityDemotion[];
};

export type CatalogOpportunityRankingReadModel = {
  schemaVersion: "catalog.opportunity_ranking.v0.1";
  targetLanguage: string;
  generatedAt: Date;
  weightsVersion: typeof catalogOpportunityWeightsVersion;
  rows: CatalogOpportunityRow[];
};

export interface ItotoriCatalogRepositoryPort {
  recordSourceProvenance(
    actor: AuthorizationActor,
    input: CatalogSourceProvenanceInput,
  ): Promise<CatalogSourceProvenanceRecord>;
  upsertWork(actor: AuthorizationActor, input: CatalogWorkInput): Promise<CatalogWorkSnapshot>;
  recordLocalScan(
    actor: AuthorizationActor,
    input: CatalogLocalScanInput,
  ): Promise<CatalogLocalScanRecord>;
  recordSeedTarget(
    actor: AuthorizationActor,
    input: CatalogSeedTargetInput,
  ): Promise<CatalogSeedTargetRecord>;
  getWorkSnapshot(actor: AuthorizationActor, workId: string): Promise<CatalogWorkSnapshot | null>;
  getWorkByExternalId(
    actor: AuthorizationActor,
    catalogSource: CatalogSource,
    sourceId: string,
    externalIdKind?: CatalogExternalIdKind,
  ): Promise<CatalogWorkSnapshot | null>;
  listSeedTargets(
    actor: AuthorizationActor,
    status?: CatalogSeedStatus,
  ): Promise<CatalogSeedTargetRecord[]>;
  listBenchmarkSelectableSeedTargets(actor: AuthorizationActor): Promise<CatalogSeedTargetRecord[]>;
  listCatalogCandidateTargetWorks(
    actor: AuthorizationActor,
  ): Promise<CatalogCandidateTargetWorkRecord[]>;
  recordCatalogCandidateMatch(
    actor: AuthorizationActor,
    input: CatalogCandidateMatchInput,
  ): Promise<CatalogCandidateMatchRecord>;
  listCatalogCandidateMatches(
    actor: AuthorizationActor,
    status?: CatalogCandidateMatchStatus,
  ): Promise<CatalogCandidateMatchRecord[]>;
  catalogConflictReview(
    actor: AuthorizationActor,
    filter?: CatalogConflictReviewFilter,
  ): Promise<CatalogConflictReviewReadModel>;
  catalogCompletenessBenchmarkPools(
    actor: AuthorizationActor,
    filter?: CatalogCompletenessPoolFilter,
  ): Promise<CatalogCompletenessBenchmarkPools>;
  catalogAlphaBenchmarkOpportunityRanking(
    actor: AuthorizationActor,
    filter?: CatalogAlphaBenchmarkOpportunityRankingFilter,
  ): Promise<CatalogAlphaBenchmarkOpportunityRanking>;
  catalogBenchmarkSeedFinder(
    actor: AuthorizationActor,
    filter?: CatalogBenchmarkSeedFinderFilter,
  ): Promise<CatalogBenchmarkSeedFinderReadModel>;
  catalogContextPanelForWork(
    actor: AuthorizationActor,
    input: { workId: string; targetLanguage: string },
  ): Promise<CatalogContextPanelCatalogReadModel | null>;
  catalogOpportunityRanking(
    actor: AuthorizationActor,
    filter?: CatalogOpportunityRankingFilter,
  ): Promise<CatalogOpportunityRankingReadModel>;
}

export const catalogSourceRecordKinds = Object.values(
  catalogSourceRecordKindValues,
) as CatalogSourceRecordKind[];
export const catalogConfidences = Object.values(catalogConfidenceValues) as CatalogConfidence[];
export const catalogEngineSources = Object.values(
  catalogEngineSourceValues,
) as CatalogEngineSource[];
export const catalogReleaseKinds = Object.values(catalogReleaseKindValues) as CatalogReleaseKind[];
export const catalogReleasePackageKinds = Object.values(
  catalogReleasePackageKindValues,
) as CatalogReleasePackageKind[];
export const catalogReleaseMappingKinds = Object.values(
  catalogReleaseMappingKindValues,
) as CatalogReleaseMappingKind[];
export const catalogTranslationPortabilities = Object.values(
  catalogTranslationPortabilityValues,
) as CatalogTranslationPortability[];
export const catalogInstallStates = Object.values(
  catalogInstallStateValues,
) as CatalogInstallState[];
export const catalogDemandFactKinds = Object.values(
  catalogDemandFactKindValues,
) as CatalogDemandFactKind[];
export const catalogConflictKinds = Object.values(
  catalogConflictKindValues,
) as CatalogConflictKind[];
export const catalogConflictStatuses = Object.values(
  catalogConflictStatusValues,
) as CatalogConflictStatus[];
export const catalogConflictSubjectKinds = Object.values(
  catalogConflictSubjectKindValues,
) as CatalogConflictSubjectKind[];
export const catalogPathRedactionClasses = Object.values(
  catalogPathRedactionClassValues,
) as CatalogPathRedactionClass[];
export const catalogRawContentRedactionClasses = Object.values(
  catalogRawContentRedactionClassValues,
) as CatalogRawContentRedactionClass[];
export const catalogSeedOrigins = Object.values(catalogSeedOriginValues) as CatalogSeedOrigin[];
export const catalogSeedStatuses = Object.values(catalogSeedStatusValues) as CatalogSeedStatus[];

// CATALOG-080: the seed statuses in which a seed target is actionable as a
// benchmark selection. Inert (importer hint), imported, ignored and failed seeds
// are never benchmark-selectable.
export const catalogBenchmarkSelectableSeedStatuses: CatalogSeedStatus[] = [
  catalogSeedStatusValues.pending,
  catalogSeedStatusValues.queued,
];

// CATALOG-080: metadata key that CATALOG-004 readiness filtering writes onto a
// seed target when it consumes an importer-authored hint and produces a readiness
// explanation. Importer-origin hints WITHOUT this record are inert evidence and
// are excluded from benchmark selection.
export const catalogSeedReadinessExplanationMetadataKey = "catalog004ReadinessExplanation";

// A seed target is benchmark-selectable only when it sits in an actionable
// status AND — for recorded-importer-authored hints — CATALOG-004 has already
// consumed it and recorded a readiness explanation. A raw, un-filtered importer
// hint is never directly benchmark-selectable (CATALOG-080).
export function seedTargetIsBenchmarkSelectable(seed: CatalogSeedTargetRecord): boolean {
  if (!catalogBenchmarkSelectableSeedStatuses.includes(seed.status)) {
    return false;
  }
  if (seed.seedOrigin === catalogSeedOriginValues.importer) {
    const explanation = seed.metadata[catalogSeedReadinessExplanationMetadataKey];
    return explanation !== undefined && explanation !== null;
  }
  return true;
}
export const catalogCandidateMatchStatuses = Object.values(
  catalogCandidateMatchStatusValues,
) as CatalogCandidateMatchStatus[];
export const catalogCompletenessPools = Object.values(
  catalogCompletenessPoolValues,
) as CatalogCompletenessPool[];
export const benchmarkDemandBuckets: CatalogBenchmarkDemandBucket[] = [
  "none",
  "low",
  "medium",
  "high",
  "very_high",
];
export const benchmarkLocalOwnershipValues: CatalogBenchmarkLocalOwnership[] = [
  "owned",
  "not_owned",
  "unknown",
];
