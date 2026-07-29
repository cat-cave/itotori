import type { AuthorizationActor } from "../authorization.js";
import type {
  TranslationMemoryMatchKind,
  TranslationMemoryReuseStatus,
  TranslationMemorySegmentStatus,
} from "../schema.js";

export const translationMemoryServiceVersion = "itotori.translation-memory.v1";
export const translationMemoryDefaultFuzzyThreshold = 720;
export const translationMemoryDefaultCandidateLimit = 20;
export const translationMemoryDefaultScoredCandidateLimit = 100;

export type TranslationMemoryDiagnostic = {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  reasonCode: string;
  field?: string;
  metadata?: Record<string, unknown>;
};

export type TranslationMemorySourceScopeErrorCode =
  | "locale_branch_missing"
  | "source_unit_missing"
  | "stale_source_revision"
  | "stale_source_hash"
  | "target_locale_mismatch"
  | "memory_segment_missing"
  | "memory_segment_scope_mismatch"
  | "existing_target_text";

export class TranslationMemorySourceScopeError extends Error {
  constructor(
    readonly code: TranslationMemorySourceScopeErrorCode,
    message: string,
    readonly metadata: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "TranslationMemorySourceScopeError";
  }
}

export type TranslationMemoryJsonRecord = Record<string, unknown>;

export type TranslationMemoryReuseCostImpact = {
  providerCallAvoided: boolean;
  estimatedPromptTokensSaved: number;
  estimatedCompletionTokensSaved: number;
  estimatedTotalTokensSaved: number;
  estimatedCostUsdSaved: string | null;
  calculation: "deterministic_character_estimate_v1";
};

export type TranslationMemoryUnitContext = {
  projectId: string;
  localeBranchId: string;
  targetLocale: string;
  bridgeUnitId: string;
  sourceRevisionId: string;
  sourceUnitKey: string;
  sourceOccurrenceId: string;
  sourceHash: string;
  sourceFingerprint: string;
  sourceText: string;
  currentTargetText: string | null;
};

export type TranslationMemorySegmentRecord = {
  memorySegmentId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  sourceBridgeUnitId: string | null;
  sourceUnitKey: string;
  sourceOccurrenceId: string;
  sourceHash: string;
  sourceFingerprint: string;
  sourceText: string;
  targetLocale: string;
  targetText: string;
  status: TranslationMemorySegmentStatus;
  provenance: TranslationMemoryJsonRecord;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type TranslationMemoryMatchRecord = TranslationMemorySegmentRecord & {
  matchKind: TranslationMemoryMatchKind;
  matchScore: number;
};

export type TranslationMemoryMatchSet = {
  target: TranslationMemoryUnitContext;
  matches: TranslationMemoryMatchRecord[];
};

export type TranslationMemoryReuseEventRecord = {
  reuseEventId: string;
  projectId: string;
  localeBranchId: string;
  targetBridgeUnitId: string;
  sourceRevisionId: string;
  memorySegmentId: string;
  matchKind: TranslationMemoryMatchKind;
  matchScore: number;
  reuseStatus: TranslationMemoryReuseStatus;
  sourceHash: string;
  candidateSourceHash: string;
  targetText: string;
  provenance: TranslationMemoryJsonRecord;
  costImpact: TranslationMemoryReuseCostImpact;
  createdByUserId: string | null;
  createdAt: Date;
};

export type UpsertTranslationMemorySegmentInput = {
  projectId: string;
  localeBranchId: string;
  sourceBridgeUnitId: string;
  targetText: string;
  memorySegmentId?: string;
  status?: TranslationMemorySegmentStatus;
  provenance?: TranslationMemoryJsonRecord;
  expectedSourceRevisionId?: string;
  expectedSourceHash?: string;
  expectedTargetLocale?: string;
};

export type FindTranslationMemoryMatchesInput = {
  projectId: string;
  localeBranchId: string;
  requestedTargetLocale: string;
  targetBridgeUnitId: string;
  includeFuzzy?: boolean;
  minFuzzyScore?: number;
  candidateLimit?: number;
  scoredCandidateLimit?: number;
};

export type ListTranslationMemoryPrefillTargetsInput = {
  projectId: string;
  localeBranchId: string;
  bridgeUnitIds?: readonly string[];
  includeExistingTargets?: boolean;
};

export type RecordTranslationMemoryReuseInput = {
  projectId: string;
  localeBranchId: string;
  requestedTargetLocale: string;
  targetBridgeUnitId: string;
  memorySegmentId: string;
  matchKind: TranslationMemoryMatchKind;
  matchScore: number;
  reuseEventId?: string;
  reuseStatus?: TranslationMemoryReuseStatus;
  applyDraft: boolean;
  overwriteExistingTarget?: boolean;
  provenance?: TranslationMemoryJsonRecord;
  costImpact?: TranslationMemoryReuseCostImpact;
};

export type ListTranslationMemoryReuseEventsInput = {
  projectId: string;
  localeBranchId: string;
  targetBridgeUnitId?: string;
};

export type ListUnitsSharingSourceInput = {
  projectId: string;
  localeBranchId: string;
  bridgeUnitId: string;
};

/**
 * The set of locale-branch units that share a source segment with a given
 * bridge unit — i.e. every unit whose next draft a canonical correction on
 * that unit should propagate to via translation-memory reuse. `bridgeUnitIds`
 * always includes the anchor unit itself.
 */
export type UnitsSharingSourceResult = {
  sourceRevisionId: string;
  sourceHash: string;
  bridgeUnitIds: string[];
};

export interface ItotoriTranslationMemoryRepositoryPort {
  upsertSegment(
    actor: AuthorizationActor,
    input: UpsertTranslationMemorySegmentInput,
  ): Promise<TranslationMemorySegmentRecord>;
  findReusableSegments(
    input: FindTranslationMemoryMatchesInput,
  ): Promise<TranslationMemoryMatchSet | null>;
  listPrefillTargets(
    input: ListTranslationMemoryPrefillTargetsInput,
  ): Promise<TranslationMemoryUnitContext[]>;
  recordReuse(
    actor: AuthorizationActor,
    input: RecordTranslationMemoryReuseInput,
  ): Promise<TranslationMemoryReuseEventRecord>;
  listReuseEvents(
    input: ListTranslationMemoryReuseEventsInput,
  ): Promise<TranslationMemoryReuseEventRecord[]>;
  listUnitsSharingSource(
    input: ListUnitsSharingSourceInput,
  ): Promise<UnitsSharingSourceResult | null>;
}

export type PrefillTranslationMemoryDraftsInput = {
  projectId: string;
  localeBranchId: string;
  requestedTargetLocale: string;
  bridgeUnitIds?: readonly string[];
  applyDrafts?: boolean;
  includeExistingTargets?: boolean;
  includeFuzzy?: boolean;
  minFuzzyScore?: number;
  candidateLimit?: number;
  scoredCandidateLimit?: number;
  requestId?: string;
};

export type TranslationMemoryPrefillReuse = {
  target: TranslationMemoryUnitContext;
  match: TranslationMemoryMatchRecord;
  event: TranslationMemoryReuseEventRecord;
};

export type TranslationMemoryPrefillSkip = {
  target: TranslationMemoryUnitContext;
  reasonCode: "no_reusable_segment" | "existing_target_text" | "target_locale_mismatch";
};

export type TranslationMemoryPrefillResult = {
  status: "completed" | "invalid";
  diagnostics: TranslationMemoryDiagnostic[];
  appliedCount: number;
  suggestedCount: number;
  skippedCount: number;
  reuses: TranslationMemoryPrefillReuse[];
  skipped: TranslationMemoryPrefillSkip[];
};
