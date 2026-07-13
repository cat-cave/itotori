// p0-core-attempt-and-outcome-journal — durable per-attempt + per-unit result
// repository.
//
// A localization journal run records every physical provider dispatch, then
// atomically records the canonical WrittenUnitOutcome and the normalized
// provenance that every patch/read/telemetry surface renders.

import { randomUUID } from "node:crypto";
import {
  assertWrittenUnitOutcome,
  type NonBlankTargetText,
  type SpeakerLabel,
  type TranslationCandidate,
  type WrittenQaFinding,
  type WrittenUnitOutcome,
} from "@itotori/localization-bridge-schema";
import { and, asc, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import {
  contextArtifacts,
  contextEntryVersions,
  localeBranches,
  localizationJournalCostReservations,
  localizationJournalLlmAttempts,
  localizationJournalRunCostAccounts,
  localizationJournalRuns,
  localizationJournalRunUnits,
  localizationPatchVersionUnits,
  localizationPatchVersions,
  localizationRefinementRunFeedbackBatches,
  localizationRefinementRunFeedbackEvents,
  localizationRefinementRunMembers,
  localizationRefinementRunWikiHeads,
  localizationResultRevisions,
  outcomeContextRefs,
  outcomeSpeakerLabels,
  playTestFeedbackBatches,
  playTestFeedbackEvents,
  playTestFeedbackEventUnits,
  sourceRevisions,
  translationCandidates,
  type LocalizationJournalQaSpan,
  writtenQaFindings,
  writtenUnitOutcomes,
} from "../schema.js";

export type LocalizationJournalTimestamp = Date | string;

export type LocalizationJournalAttemptValidationResult =
  | "accepted"
  | "schema_invalid"
  | "semantic_invalid"
  | "provider_failed"
  | "not_evaluated";

export type LocalizationJournalAttemptRetryDecision = "retry" | "advance" | "write" | "pause";

export type LocalizationJournalAttemptCostKind = "billed" | "provider_estimate" | "zero";

/** A response with unknown settlement keeps its conservative reservation. */
export type LocalizationJournalAttemptBillingState = "known" | "unknown";

export type LocalizationJournalAttemptLifecycleState = "dispatching" | "completed";

/**
 * The production lease is four times the supervisor's 30-second physical-call
 * deadline. With a healthy event loop, begin/complete renewal plus the abort
 * margin stops a bounded provider call before a second resumer can take over.
 */
export const LOCALIZATION_JOURNAL_RUN_LEASE_SECONDS = 120;

export type LocalizationJournalRunLeaseIdentity = {
  ownerId: string;
  fenceToken: number;
  leaseSeconds?: number;
};

/** DB-clock lease deadline plus its remaining duration at the observation query. */
export type LocalizationJournalRunLeaseDeadline = {
  leaseExpiresAt: Date;
  remainingMs: number;
};

export type SeedLocalizationJournalRunLeaseInput = {
  ownerId: string;
  leaseSeconds?: number;
};

export type LocalizationJournalRunStatus =
  | "running"
  | "paused"
  | "finalizing"
  | "succeeded"
  | "failed"
  | "aborted";

export type LocalizationJournalOperationalBlocker = {
  kind: "budget_cap" | "provider_outage" | "itotori_bug";
  detail: string;
  evidence: string;
  raisedAt: string;
  operatorAction: string;
};

export type LocalizationJournalUnitNextAction = {
  kind: string;
  [key: string]: unknown;
};

export type LocalizationJournalRunUnitState = "pending" | "claimed" | "written";

export type SeedLocalizationJournalRunUnitInput = {
  bridgeUnitId: string;
  sourceUnitKey?: string;
  nextAction: LocalizationJournalUnitNextAction;
};

/** A caller-supplied immutable wiki head; omit the array to freeze all current heads. */
export type SeedLocalizationJournalRefinementWikiHeadInput = {
  contextArtifactId: string;
  contextEntryVersionId: string;
};

/**
 * Frozen iteration inputs for a refinement run. The journal owns these fields
 * so run creation and its complete obligation set commit atomically.
 */
export type SeedLocalizationJournalRefinementInput = {
  basePatchVersionId: string;
  /** Whole durable batches selected by the play tester. */
  feedbackBatchIds: readonly string[];
  /** Individually selected immutable events, including events within a batch. */
  feedbackEventIds?: readonly string[];
  wikiHeads?: readonly SeedLocalizationJournalRefinementWikiHeadInput[];
  /** Explicit affected units in addition to feedback and wiki impact. */
  redraftUnitIds?: readonly string[];
};

/** Immutable run inputs plus the complete ordered unit obligation set. */
export type SeedLocalizationJournalRunInput = {
  runId?: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  targetLocale: string;
  frozenScope: Record<string, unknown> | unknown[];
  routingPolicy: Record<string, unknown>;
  costPolicy: Record<string, unknown>;
  units: readonly SeedLocalizationJournalRunUnitInput[];
  /** Present only for a vN refinement launched from a playable base patch. */
  refinement?: SeedLocalizationJournalRefinementInput;
  /** Present on a newly-driven run; resume verifies the plan before taking a new fence. */
  lease?: SeedLocalizationJournalRunLeaseInput;
  createdAt?: LocalizationJournalTimestamp;
};

/** Facts known and committed before a provider request is dispatched. */
export type BeginLocalizationJournalAttemptInput = {
  attemptId: string;
  runId: string;
  bridgeUnitId: string;
  stage: string;
  agentLabel: string;
  logicalCallId: string;
  attemptIndex: number;
  requestedModelId: string;
  requestedProviderId: string;
  /** Request routing posture, known before dispatch. */
  zdr: boolean;
  artifactRef?: string | null;
  startedAt: LocalizationJournalTimestamp;
  lease: LocalizationJournalRunLeaseIdentity;
};

/** Exact worst-case admission plus the dispatching attempt in one transaction. */
export type ReserveLocalizationJournalAttemptInput = BeginLocalizationJournalAttemptInput & {
  /** Canonical exact decimal USD; never micros or a JavaScript arithmetic result. */
  worstCaseCostUsd: string;
  /** Optional stable id for a retried transport write; defaults from attemptId. */
  reservationId?: string;
};

export type LocalizationJournalRunCostAccountRecord = {
  runId: string;
  capUsd: string | null;
  spentCostUsd: string;
  reservedCostUsd: string;
  createdAt: Date;
  updatedAt: Date;
};

export type LocalizationJournalCostReservationRecord = {
  reservationId: string;
  runId: string;
  attemptId: string;
  reservedUsd: string;
  reconciledUsd: string | null;
  state: "reserved" | "released" | "reconciled";
  createdAt: Date;
  reconciledAt: Date | null;
};

export type ReserveLocalizationJournalAttemptResult =
  | {
      admitted: true;
      attempt: LocalizationJournalDispatchingAttemptRecord;
      reservation: LocalizationJournalCostReservationRecord;
      account: LocalizationJournalRunCostAccountRecord;
    }
  | {
      admitted: false;
      account: LocalizationJournalRunCostAccountRecord;
    };

/** Real provider + validation facts that close one pre-dispatch attempt row. */
export type CompleteLocalizationJournalAttemptInput = {
  attemptId: string;
  runId: string;
  bridgeUnitId: string;
  /** Null only when the call ended without a ProviderRunRecord (for example a supervisor timeout). */
  modelId: string | null;
  providerId: string | null;
  costUsd: string | null;
  costKind?: LocalizationJournalAttemptCostKind | undefined;
  /** Known zero and unknown settlement are never conflated. */
  billingState?: LocalizationJournalAttemptBillingState | undefined;
  usageResponseJson?: unknown;
  tokensIn: number | null;
  tokensOut: number | null;
  tokenCountSource?: string | undefined;
  cacheReadTokens?: number | null | undefined;
  cacheWriteTokens?: number | null | undefined;
  cacheDiscountMicrosUsd?: number | null | undefined;
  fallbackUsed?: boolean | undefined;
  fallbackPlan?: readonly string[] | undefined;
  zdr: boolean;
  finishState: string | null;
  refusalState: string | null;
  validationResult: LocalizationJournalAttemptValidationResult;
  failureClass: string | null;
  retryDecision: LocalizationJournalAttemptRetryDecision | null;
  retryDelayMs: number | null;
  artifactRef?: string | null;
  errorClasses: readonly string[];
  completedAt: LocalizationJournalTimestamp;
  lease: LocalizationJournalRunLeaseIdentity;
};

/**
 * Settles an already-completed unknown-billing attempt when a later provider
 * reconciliation obtains its exact bill. This intentionally has no run lease:
 * reconciliation is a durable accounting repair, including after a crashed
 * driver's fence has been superseded.
 */
export type ReconcileLocalizationJournalAttemptBillingInput = {
  attemptId: string;
  runId: string;
  /** Exact settled decimal USD, never rounded micros. */
  costUsd: string;
  costKind?: LocalizationJournalAttemptCostKind | undefined;
  /** Required as a pair when the original unknown attempt had no served pair. */
  modelId?: string | undefined;
  providerId?: string | undefined;
  /** Optional recovered provider usage block; preserves prior metadata when absent. */
  usageResponseJson?: unknown;
};

/** One physical provider dispatch, keyed by its provider-run identity. */
export type PersistLocalizationJournalAttemptInput = {
  /** Must be the physical provider-run id when a candidate will point at it. */
  attemptId: string;
  /** Repeated deliberately so a caller cannot accidentally cross-bind a unit's attempt. */
  runId: string;
  bridgeUnitId: string;
  stage: string;
  agentLabel: string;
  logicalCallId: string;
  attemptIndex: number;
  /** Requested stage-policy pair; absent only on pre-0078 journal rows. */
  requestedModelId?: string | undefined;
  requestedProviderId?: string | undefined;
  modelId: string;
  providerId: string;
  providerRunId: string;
  /** Exact decimal text. Never pass this through Number or micros. */
  costUsd: string;
  costKind?: LocalizationJournalAttemptCostKind | undefined;
  usageResponseJson?: unknown;
  tokensIn: number | null;
  tokensOut: number | null;
  tokenCountSource?: string | undefined;
  /** Null/undefined means cache provenance was not captured, never zero. */
  cacheReadTokens?: number | null | undefined;
  cacheWriteTokens?: number | null | undefined;
  cacheDiscountMicrosUsd?: number | null | undefined;
  fallbackUsed?: boolean | undefined;
  fallbackPlan?: readonly string[] | undefined;
  zdr: boolean;
  finishState: string | null;
  refusalState: string | null;
  validationResult: LocalizationJournalAttemptValidationResult;
  failureClass: string | null;
  retryDecision: LocalizationJournalAttemptRetryDecision | null;
  retryDelayMs: number | null;
  artifactRef: string | null;
  errorClasses: readonly string[];
  startedAt: LocalizationJournalTimestamp;
  completedAt: LocalizationJournalTimestamp;
};

export type PersistLocalizationJournalAttemptsInput = {
  runId: string;
  bridgeUnitId: string;
  attempts: readonly PersistLocalizationJournalAttemptInput[];
};

export type LocalizationJournalOutcomeContextRefInput = {
  refKind: string;
  refId: string;
  versionRef?: string;
  details?: unknown;
};

export type LocalizationJournalOutcomeContextRef = {
  refKind: string;
  refId: string;
  versionRef: string | null;
  details: unknown | null;
};

export type LocalizationJournalQaDetail = {
  recommendation: string;
  agentRationale: string;
  evidenceRefs: readonly string[];
  sourceSpan?: LocalizationJournalQaSpan;
  draftSpan?: LocalizationJournalQaSpan;
};

export type LocalizationJournalQaDetailsByFindingId = Readonly<
  Record<string, LocalizationJournalQaDetail>
>;

export type PersistLocalizationJournalUnitInput = {
  runId: string;
  bridgeUnitId: string;
  /** Kept for patch/read ergonomics; bridge unit id remains the canonical key. */
  sourceUnitKey?: string;
  outcome: WrittenUnitOutcome;
  attempts: readonly PersistLocalizationJournalAttemptInput[];
  /** Exact resolved packet, retained even before the context-brain store exists. */
  contextPacket: unknown;
  contextRefs: readonly LocalizationJournalOutcomeContextRefInput[];
  speakerLabels: readonly SpeakerLabel[];
  /** Raw QA fields intentionally omitted by the concise WrittenQaFinding shape. */
  qaDetails: LocalizationJournalQaDetailsByFindingId;
  /** Required for every frozen/supervised run; legacy non-frozen rows omit it. */
  lease?: LocalizationJournalRunLeaseIdentity;
};

export type CreateLocalizationJournalRunInput = {
  runId?: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  targetLocale: string;
  createdAt?: LocalizationJournalTimestamp;
};

export type LocalizationJournalRunRecord = {
  runId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  targetLocale: string;
  frozenScope: Record<string, unknown> | unknown[] | null;
  routingPolicy: Record<string, unknown> | null;
  costPolicy: Record<string, unknown> | null;
  basePatchVersionId: string | null;
  status: LocalizationJournalRunStatus;
  pausedBlocker: LocalizationJournalOperationalBlocker | null;
  leaseOwnerId: string | null;
  leaseExpiresAt: Date | null;
  fenceToken: number;
  createdAt: Date;
  updatedAt: Date;
};

export type LocalizationJournalRunUnitRecord = {
  runId: string;
  bridgeUnitId: string;
  sourceUnitKey: string | null;
  unitOrdinal: number;
  state: LocalizationJournalRunUnitState;
  nextAction: LocalizationJournalUnitNextAction | null;
  claimOwnerId: string | null;
  claimFenceToken: number | null;
  createdAt: Date;
  updatedAt: Date;
};

export type LocalizationJournalAttemptRecord = {
  attemptId: string;
  runId: string;
  bridgeUnitId: string;
  stage: string;
  agentLabel: string;
  logicalCallId: string;
  attemptIndex: number;
  lifecycleState: LocalizationJournalAttemptLifecycleState;
  fenceToken: number;
  requestedModelId: string | null;
  requestedProviderId: string | null;
  modelId: string | null;
  providerId: string | null;
  providerRunId: string;
  /** Exact decimal text from unconstrained PostgreSQL numeric. */
  costUsd: string | null;
  costKind: LocalizationJournalAttemptCostKind | null;
  billingState: LocalizationJournalAttemptBillingState | null;
  usageResponseJson: unknown | null;
  tokensIn: number | null;
  tokensOut: number | null;
  tokenCountSource: string | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheDiscountMicrosUsd: number | null;
  fallbackUsed: boolean | null;
  fallbackPlan: string[] | null;
  zdr: boolean;
  finishState: string | null;
  refusalState: string | null;
  validationResult: LocalizationJournalAttemptValidationResult | null;
  failureClass: string | null;
  retryDecision: LocalizationJournalAttemptRetryDecision | null;
  retryDelayMs: number | null;
  artifactRef: string | null;
  errorClasses: string[];
  startedAt: Date;
  completedAt: Date | null;
  createdAt: Date;
};

/** Pre-dispatch row paired with the lease deadline renewed in the same transaction. */
export type LocalizationJournalDispatchingAttemptRecord = LocalizationJournalAttemptRecord & {
  leaseDeadline: LocalizationJournalRunLeaseDeadline;
};

/** Heartbeat result paired with a fresh DB-clock lease deadline observation. */
export type LocalizationJournalRenewedRunRecord = LocalizationJournalRunRecord & {
  leaseDeadline: LocalizationJournalRunLeaseDeadline;
};

export type LocalizationJournalOutcomeRecord = {
  /** Internal, run-scoped FK identity; canonical `outcome.id` remains below. */
  journalOutcomeId: string;
  runId: string;
  bridgeUnitId: string;
  sourceUnitKey: string | null;
  outcome: WrittenUnitOutcome;
  /** Convenience aliases for surfaces that do not need to unpack `outcome`. */
  candidates: TranslationCandidate[];
  findings: WrittenQaFinding[];
  contextPacket: unknown;
  contextRefs: LocalizationJournalOutcomeContextRef[];
  speakerLabels: SpeakerLabel[];
  qaDetails: Record<string, LocalizationJournalQaDetail>;
};

/** Aggregate over real physical journal attempts for one requested pair. */
export type LocalizationJournalAttemptAggregateRow = {
  /**
   * `requested*` is verbatim only when every row in this bucket captured the
   * requested pair. For pre-0078 rows the served pair is used strictly as a
   * grouping fallback, and this is `"partial"` so consumers cannot label it
   * as a captured request.
   */
  requestedPairAvailability: "complete" | "partial";
  requestedModelId: string;
  requestedProviderId: string;
  bucketDay: string | null;
  totalCostUsd: string;
  totalTokensIn: number;
  totalTokensOut: number;
  invocationCount: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  /**
   * Cache totals below are sums over captured facts. `partial` means at least
   * one physical attempt predates cache provenance capture; zero is therefore
   * not a claim that that unobserved attempt had no cache activity.
   */
  cacheFactsAvailability: "complete" | "partial";
  cacheFactsCapturedInvocationCount: number;
  cacheHitCount: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  cacheSavingsUsd: string;
};

export type LocalizationJournalAttemptAggregateOptions = {
  groupByDay?: boolean | undefined;
};

export type LocalizationJournalZdrAggregateRow = {
  requestedPairAvailability: "complete" | "partial";
  requestedModelId: string;
  requestedProviderId: string;
  invocationCount: number;
  zdrEnforcedCount: number;
};

export type LocalizationJournalCostKindAggregateRow = {
  requestedPairAvailability: "complete" | "partial";
  requestedModelId: string;
  requestedProviderId: string;
  costKind: LocalizationJournalAttemptCostKind;
  invocationCount: number;
  amountMicrosUsd: number;
};

export const JOBS_RUN_TABLE_SCHEMA_VERSION = "jobs.run_table.v0.2";
export const JOBS_RUN_TABLE_DEFAULT_LIMIT = 20;
export const JOBS_RUN_TABLE_MAX_LIMIT = 100;

export type JobsRunTablePagination = {
  total: number;
  limit: number;
  offset: number;
  page: number;
  pageCount: number;
  hasMore: boolean;
  nextOffset: number | null;
};

export type JobsRunTableFilter = { projectId: string | null };
export type JobsRunTableTokens = { in: number | null; out: number | null; total: number | null };
export type JobsRunTableCost = { unit: "usd"; amount: string };
/**
 * The provider exposes a plan, not an invented per-hop fallback chain. A
 * pre-0078 row has no fallback facts; `used` / `plan` intentionally remain
 * null rather than projecting a fabricated no-fallback result.
 */
export type JobsRunTableFallback = {
  availability: "captured" | "not_captured";
  used: boolean | null;
  plan: string[] | null;
  chain: string[];
};

/**
 * One physical journal attempt rendered in the jobs run table. Legacy draft
 * job/ledger identifiers are intentionally absent: `journalRunId` and
 * `attemptId` are the durable execution provenance.
 */
export type JobsRunTableRow = {
  /** Physical provider-run id, retained for existing route/detail links. */
  runId: string;
  journalRunId: string;
  attemptId: string;
  providerRunId: string;
  bridgeUnitId: string;
  projectId: string;
  localeBranchId: string;
  task: string;
  status: string;
  servedModel: string;
  servedProvider: string;
  zdr: boolean;
  cost: JobsRunTableCost;
  tokens: JobsRunTableTokens;
  fallback: JobsRunTableFallback;
  createdAt: string;
};

export type JobsRunTableReadModel = {
  schemaVersion: typeof JOBS_RUN_TABLE_SCHEMA_VERSION;
  generatedAt: string;
  filter: JobsRunTableFilter;
  pagination: JobsRunTablePagination;
  rows: JobsRunTableRow[];
};

export type LoadJobsRunTableOptions = {
  projectId?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  generatedAt?: Date | undefined;
};

export interface ItotoriLocalizationJournalRepositoryPort {
  seedRun(
    actor: AuthorizationActor,
    input: SeedLocalizationJournalRunInput,
  ): Promise<LocalizationJournalRunRecord>;
  createRun(
    actor: AuthorizationActor,
    input: CreateLocalizationJournalRunInput,
  ): Promise<LocalizationJournalRunRecord>;
  /**
   * Persists physical calls even when the unit raises before producing a
   * WrittenUnitOutcome (provider/parser/semantic failure paths).
   */
  persistAttempts(
    actor: AuthorizationActor,
    input: PersistLocalizationJournalAttemptsInput,
  ): Promise<LocalizationJournalAttemptRecord[]>;
  beginAttempt(
    actor: AuthorizationActor,
    input: BeginLocalizationJournalAttemptInput,
  ): Promise<LocalizationJournalDispatchingAttemptRecord>;
  reserveAttemptCost(
    actor: AuthorizationActor,
    input: ReserveLocalizationJournalAttemptInput,
  ): Promise<ReserveLocalizationJournalAttemptResult>;
  completeAttempt(
    actor: AuthorizationActor,
    input: CompleteLocalizationJournalAttemptInput,
  ): Promise<LocalizationJournalAttemptRecord>;
  /** Records an exact later bill for a completed attempt with unknown billing. */
  reconcileAttemptBilling(
    actor: AuthorizationActor,
    input: ReconcileLocalizationJournalAttemptBillingInput,
  ): Promise<LocalizationJournalAttemptRecord>;
  loadRunCostAccount(
    actor: AuthorizationActor,
    runId: string,
  ): Promise<LocalizationJournalRunCostAccountRecord | null>;
  loadCostReservations(
    actor: AuthorizationActor,
    runId: string,
  ): Promise<LocalizationJournalCostReservationRecord[]>;
  raiseRunCostCap(
    actor: AuthorizationActor,
    runId: string,
    capUsd: string,
  ): Promise<LocalizationJournalRunCostAccountRecord>;
  /** Atomically persists attempts, canonical outcome, and all provenance children. */
  persistUnit(
    actor: AuthorizationActor,
    input: PersistLocalizationJournalUnitInput,
  ): Promise<LocalizationJournalOutcomeRecord>;
  loadRun(actor: AuthorizationActor, runId: string): Promise<LocalizationJournalRunRecord | null>;
  loadRunUnits(
    actor: AuthorizationActor,
    runId: string,
  ): Promise<LocalizationJournalRunUnitRecord[]>;
  pauseRun(
    actor: AuthorizationActor,
    runId: string,
    blocker: LocalizationJournalOperationalBlocker,
    lease: LocalizationJournalRunLeaseIdentity,
  ): Promise<LocalizationJournalRunRecord>;
  resumeRun(
    actor: AuthorizationActor,
    runId: string,
    lease: Omit<LocalizationJournalRunLeaseIdentity, "fenceToken">,
  ): Promise<LocalizationJournalRunRecord>;
  /** Extend a live owner/fence lease while one or more provider calls are in flight. */
  renewRunLease(
    actor: AuthorizationActor,
    runId: string,
    lease: LocalizationJournalRunLeaseIdentity,
  ): Promise<LocalizationJournalRenewedRunRecord>;
  /** Release only a paused run after the owning executor has fully quiesced. */
  releaseRunLease(
    actor: AuthorizationActor,
    runId: string,
    lease: LocalizationJournalRunLeaseIdentity,
  ): Promise<LocalizationJournalRunRecord>;
  /** Chronological journal history for one locale branch, oldest run first. */
  loadRunsForBranch(
    actor: AuthorizationActor,
    localeBranchId: string,
  ): Promise<LocalizationJournalRunRecord[]>;
  /** Latest journal run for one locale branch, or null when the branch is new. */
  loadLatestRunForBranch(
    actor: AuthorizationActor,
    localeBranchId: string,
  ): Promise<LocalizationJournalRunRecord | null>;
  loadRunOutcomes(
    actor: AuthorizationActor,
    runId: string,
  ): Promise<LocalizationJournalOutcomeRecord[]>;
  loadAttemptsForRun(
    actor: AuthorizationActor,
    runId: string,
  ): Promise<LocalizationJournalAttemptRecord[]>;
  sumAttemptsByPairAndDay(
    actor: AuthorizationActor,
    projectId: string,
    window: { from: Date; to: Date },
    opts?: LocalizationJournalAttemptAggregateOptions,
  ): Promise<LocalizationJournalAttemptAggregateRow[]>;
  countZdrEnforcedAttemptsByPair(
    actor: AuthorizationActor,
    projectId: string,
    window: { from: Date; to: Date },
  ): Promise<LocalizationJournalZdrAggregateRow[]>;
  countCostKindsByPair(
    actor: AuthorizationActor,
    projectId: string,
    window: { from: Date; to: Date },
  ): Promise<LocalizationJournalCostKindAggregateRow[]>;
  loadJobsRunTable(
    actor: AuthorizationActor,
    options?: LoadJobsRunTableOptions,
  ): Promise<JobsRunTableReadModel>;
}

export class LocalizationJournalRepositoryError extends Error {
  constructor(
    readonly code:
      | "run_not_found"
      | "run_scope_mismatch"
      | "invalid_input"
      | "attempt_conflict"
      | "candidate_attempt_missing"
      | "outcome_already_persisted"
      | "run_seed_conflict"
      | "unit_not_seeded"
      | "unit_not_pending"
      | "run_lease_conflict"
      | "run_lease_lost"
      | "invalid_run_transition",
    message: string,
  ) {
    super(message);
    this.name = "LocalizationJournalRepositoryError";
  }
}

type JournalTransaction = Parameters<Parameters<ItotoriDatabase["transaction"]>[0]>[0];

type NormalizedAttempt = Omit<
  PersistLocalizationJournalAttemptInput,
  | "startedAt"
  | "completedAt"
  | "requestedModelId"
  | "requestedProviderId"
  | "costKind"
  | "usageResponseJson"
  | "tokenCountSource"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "cacheDiscountMicrosUsd"
  | "fallbackUsed"
  | "fallbackPlan"
> & {
  errorClasses: string[];
  startedAt: Date;
  completedAt: Date;
  requestedModelId: string | null;
  requestedProviderId: string | null;
  costKind: LocalizationJournalAttemptCostKind | null;
  usageResponseJson: unknown | null;
  tokenCountSource: string | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheDiscountMicrosUsd: number | null;
  fallbackUsed: boolean | null;
  fallbackPlan: string[] | null;
};

type NormalizedBeginAttempt = Omit<BeginLocalizationJournalAttemptInput, "startedAt" | "lease"> & {
  artifactRef: string | null;
  startedAt: Date;
  lease: Required<LocalizationJournalRunLeaseIdentity>;
};

type NormalizedCompleteAttempt = Omit<
  CompleteLocalizationJournalAttemptInput,
  | "completedAt"
  | "costKind"
  | "billingState"
  | "usageResponseJson"
  | "tokenCountSource"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "cacheDiscountMicrosUsd"
  | "fallbackUsed"
  | "fallbackPlan"
  | "artifactRef"
  | "lease"
> & {
  costKind: LocalizationJournalAttemptCostKind | null;
  billingState: LocalizationJournalAttemptBillingState;
  usageResponseJson: unknown | null;
  tokenCountSource: string | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheDiscountMicrosUsd: number | null;
  fallbackUsed: boolean | null;
  fallbackPlan: string[] | null;
  artifactRef: string | null | undefined;
  errorClasses: string[];
  completedAt: Date;
  lease: Required<LocalizationJournalRunLeaseIdentity>;
};

/**
 * DB repository for the lossless attempt/outcome journal.
 *
 * Write authority is `draft.write`; read authority is `catalog.read`. This is
 * deliberately a new seam and never calls a legacy draft/pass repository.
 */
export class ItotoriLocalizationJournalRepository implements ItotoriLocalizationJournalRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async seedRun(
    actor: AuthorizationActor,
    input: SeedLocalizationJournalRunInput,
  ): Promise<LocalizationJournalRunRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    validateSeedRunInput(input);

    const runId = input.runId ?? `localization-run-${randomUUID()}`;
    const createdAt = toValidDate(input.createdAt ?? new Date(), "createdAt");
    const initialLease =
      input.lease === undefined ? null : normalizeSeedRunLease(input.lease, "lease");
    return this.db.transaction(async (tx) => {
      await requireRunScopeInTx(tx, input);
      // Legacy unit synthesis takes this same transaction-scoped lock. It
      // makes the post-lock frozen-state recheck below a real serialization
      // boundary instead of a check-then-insert race.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${runId}))`);
      const insertedRuns = await tx
        .insert(localizationJournalRuns)
        .values({
          runId,
          projectId: input.projectId,
          localeBranchId: input.localeBranchId,
          sourceRevisionId: input.sourceRevisionId,
          targetLocale: input.targetLocale,
          frozenScope: input.frozenScope,
          routingPolicy: input.routingPolicy,
          costPolicy: input.costPolicy,
          basePatchVersionId: input.refinement?.basePatchVersionId ?? null,
          status: "running",
          pausedBlocker: null,
          leaseOwnerId: initialLease?.ownerId ?? null,
          leaseExpiresAt:
            initialLease === null ? null : leaseExpiryFromDbNow(initialLease.leaseSeconds),
          fenceToken: initialLease === null ? 0 : 1,
          createdAt,
          updatedAt: createdAt,
        })
        .onConflictDoNothing()
        .returning({ runId: localizationJournalRuns.runId });

      let run = await requireRunInTx(tx, runId);
      const preExistingFrozenRun = insertedRuns[0] === undefined && run.frozenScope !== null;
      assertSeedRunIdentity(run, input);
      assertSeedRefinementIdentity(run, input.refinement);
      if (run.frozenScope === null && run.routingPolicy === null && run.costPolicy === null) {
        const upgraded = await tx
          .update(localizationJournalRuns)
          .set({
            frozenScope: input.frozenScope,
            routingPolicy: input.routingPolicy,
            costPolicy: input.costPolicy,
            updatedAt: new Date(),
          })
          .where(eq(localizationJournalRuns.runId, runId))
          .returning();
        run = upgraded[0] ?? run;
      } else if (
        !jsonValuesEqual(run.frozenScope, input.frozenScope) ||
        !jsonValuesEqual(run.routingPolicy, input.routingPolicy)
      ) {
        throw new LocalizationJournalRepositoryError(
          "run_seed_conflict",
          `journal run ${runId} already exists with different frozen scope/routing/cost policy`,
        );
      } else if (!jsonValuesEqual(run.costPolicy, input.costPolicy)) {
        if (!costPolicyIsCapRaise(run.costPolicy, input.costPolicy)) {
          throw new LocalizationJournalRepositoryError(
            "run_seed_conflict",
            `journal run ${runId} already exists with a different immutable cost policy or a lower cost cap`,
          );
        }
        const raised = await tx
          .update(localizationJournalRuns)
          .set({ costPolicy: input.costPolicy, updatedAt: new Date() })
          .where(eq(localizationJournalRuns.runId, runId))
          .returning();
        run = raised[0] ?? run;
      }

      await ensureRunCostAccountInTx(tx, runId, costCapUsdFromPolicy(input.costPolicy));

      // An already-frozen run has an immutable obligation set. Validate the
      // caller's exact membership/order before attempting any unit insert so
      // a rejected re-seed cannot persist a newly supplied unit.
      if (preExistingFrozenRun) {
        const persistedUnits = await loadRunUnitsInTx(tx, runId);
        assertSeededUnitSet(runId, persistedUnits, input.units);
        if (input.refinement !== undefined) {
          await ensureRefinementRunMetadataInTx(tx, run, input);
        }
        return journalRunRowToRecord(run);
      }

      if (input.units.length > 0) {
        const unitCreatedAt = new Date();
        await tx
          .insert(localizationJournalRunUnits)
          .values(
            input.units.map((unit, unitOrdinal) => ({
              runId,
              bridgeUnitId: unit.bridgeUnitId,
              sourceUnitKey: unit.sourceUnitKey ?? null,
              unitOrdinal,
              state: "pending",
              nextAction: unit.nextAction,
              createdAt: unitCreatedAt,
              updatedAt: unitCreatedAt,
            })),
          )
          .onConflictDoNothing();
      }

      const persistedUnits = await loadRunUnitsInTx(tx, runId);
      assertSeededUnitSet(runId, persistedUnits, input.units);
      if (input.refinement !== undefined) {
        await ensureRefinementRunMetadataInTx(tx, run, input);
      }
      return journalRunRowToRecord(run);
    });
  }

  async createRun(
    actor: AuthorizationActor,
    input: CreateLocalizationJournalRunInput,
  ): Promise<LocalizationJournalRunRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    validateRunInput(input);

    const [branchRows, revisionRows] = await Promise.all([
      this.db
        .select({ projectId: localeBranches.projectId, targetLocale: localeBranches.targetLocale })
        .from(localeBranches)
        .where(eq(localeBranches.localeBranchId, input.localeBranchId))
        .limit(1),
      this.db
        .select({ projectId: sourceRevisions.projectId })
        .from(sourceRevisions)
        .where(eq(sourceRevisions.sourceRevisionId, input.sourceRevisionId))
        .limit(1),
    ]);
    const branch = branchRows[0];
    const revision = revisionRows[0];
    if (branch === undefined || revision === undefined) {
      throw new LocalizationJournalRepositoryError(
        "run_scope_mismatch",
        `cannot create localization journal run: branch=${input.localeBranchId} or sourceRevision=${input.sourceRevisionId} does not exist`,
      );
    }
    if (branch.projectId !== input.projectId || revision.projectId !== input.projectId) {
      throw new LocalizationJournalRepositoryError(
        "run_scope_mismatch",
        `journal run project ${input.projectId} does not own branch=${input.localeBranchId} and sourceRevision=${input.sourceRevisionId}`,
      );
    }
    if (branch.targetLocale !== input.targetLocale) {
      throw new LocalizationJournalRepositoryError(
        "run_scope_mismatch",
        `journal run targetLocale=${input.targetLocale} does not match locale branch ${input.localeBranchId} targetLocale=${branch.targetLocale}`,
      );
    }

    const runId = input.runId ?? `localization-run-${randomUUID()}`;
    const createdAt = toValidDate(input.createdAt ?? new Date(), "createdAt");
    const inserted = await this.db
      .insert(localizationJournalRuns)
      .values({
        runId,
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        sourceRevisionId: input.sourceRevisionId,
        targetLocale: input.targetLocale,
        frozenScope: null,
        routingPolicy: null,
        costPolicy: null,
        basePatchVersionId: null,
        status: "running",
        pausedBlocker: null,
        leaseOwnerId: null,
        leaseExpiresAt: null,
        fenceToken: 0,
        createdAt,
        updatedAt: createdAt,
      })
      .returning();
    const row = inserted[0];
    if (row === undefined) {
      throw new LocalizationJournalRepositoryError(
        "run_not_found",
        `journal run ${runId} disappeared immediately after insertion`,
      );
    }
    return journalRunRowToRecord(row);
  }

  async beginAttempt(
    actor: AuthorizationActor,
    input: BeginLocalizationJournalAttemptInput,
  ): Promise<LocalizationJournalDispatchingAttemptRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    const attempt = normalizeBeginAttempt(input);
    return this.db.transaction(async (tx) => await beginAttemptInTx(tx, attempt));
  }

  async reserveAttemptCost(
    actor: AuthorizationActor,
    input: ReserveLocalizationJournalAttemptInput,
  ): Promise<ReserveLocalizationJournalAttemptResult> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    const attempt = normalizeBeginAttempt(input);
    const worstCaseCostUsd = normalizeExactNonNegativeDecimal(
      input.worstCaseCostUsd,
      "worstCaseCostUsd",
    );
    const reservationId = input.reservationId ?? `cost-reservation:${attempt.attemptId}`;
    assertNonBlank(reservationId, "reservationId");

    return this.db.transaction(async (tx) => {
      const run = await renewRunLeaseInTx(tx, attempt.runId, attempt.lease, ["running", "paused"]);
      // Another concurrent worker may have just paused this same fenced run
      // after its own denial. Do not turn that expected convergence into an
      // invalid-transition bug or admit another physical dispatch while
      // siblings are draining.
      if (run.status === "paused") {
        return {
          admitted: false,
          account: journalCostAccountRowToRecord(
            await requireRunCostAccountInTx(tx, attempt.runId),
          ),
        };
      }
      const existing = await loadAttemptInTx(tx, attempt.attemptId);
      if (existing !== undefined) {
        if (!beginAttemptRowMatches(existing, attempt)) {
          throw new LocalizationJournalRepositoryError(
            "attempt_conflict",
            `attempt ${attempt.attemptId} already exists with different pre-dispatch facts`,
          );
        }
        if (existing.lifecycleState !== "dispatching") {
          throw new LocalizationJournalRepositoryError(
            "attempt_conflict",
            `attempt ${attempt.attemptId} is already ${existing.lifecycleState} and cannot be re-dispatched`,
          );
        }
        const reservation = await requireCostReservationInTx(tx, attempt.runId, attempt.attemptId);
        if (
          reservation.reservationId !== reservationId ||
          reservation.state !== "reserved" ||
          normalizeExactNonNegativeDecimal(reservation.reservedUsd, "reservedUsd") !==
            worstCaseCostUsd
        ) {
          throw new LocalizationJournalRepositoryError(
            "attempt_conflict",
            `attempt ${attempt.attemptId} already has a different cost reservation`,
          );
        }
        return {
          admitted: true,
          attempt: {
            ...journalAttemptRowToRecord(existing),
            leaseDeadline: await loadRunLeaseDeadlineInTx(tx, attempt.runId),
          },
          reservation: journalCostReservationRowToRecord(reservation),
          account: journalCostAccountRowToRecord(
            await requireRunCostAccountInTx(tx, attempt.runId),
          ),
        };
      }

      const account = await reserveRunCostAccountInTx(tx, attempt.runId, worstCaseCostUsd);
      if (account === undefined) {
        return {
          admitted: false,
          account: journalCostAccountRowToRecord(
            await requireRunCostAccountInTx(tx, attempt.runId),
          ),
        };
      }

      const dispatchingAttempt = await beginAttemptInTx(tx, attempt, { renewLease: false });
      const insertedReservations = await tx
        .insert(localizationJournalCostReservations)
        .values({
          reservationId,
          runId: attempt.runId,
          attemptId: attempt.attemptId,
          reservedUsd: worstCaseCostUsd,
          reconciledUsd: null,
          state: "reserved",
          createdAt: new Date(),
          reconciledAt: null,
        })
        .returning();
      const reservation = insertedReservations[0];
      if (reservation === undefined) {
        throw new LocalizationJournalRepositoryError(
          "attempt_conflict",
          `could not create cost reservation for attempt ${attempt.attemptId}`,
        );
      }
      return {
        admitted: true,
        attempt: dispatchingAttempt,
        reservation: journalCostReservationRowToRecord(reservation),
        account: journalCostAccountRowToRecord(account),
      };
    });
  }

  async completeAttempt(
    actor: AuthorizationActor,
    input: CompleteLocalizationJournalAttemptInput,
  ): Promise<LocalizationJournalAttemptRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    const completion = normalizeCompleteAttempt(input);

    return this.db.transaction(async (tx) => {
      await renewRunLeaseInTx(tx, completion.runId, completion.lease, ["running", "paused"]);
      const before = await loadAttemptInTx(tx, completion.attemptId);
      const persisted = await completeAttemptInTx(tx, completion);
      // Completion and reservation reconciliation share this transaction. A
      // malformed/refused response with a confirmed bill therefore charges the
      // account even though semantic validation later rejects the invocation.
      // Unknown settlement is intentionally a no-op here: its worst-case
      // reservation remains in `reservedCostUsd` until a later reconciliation.
      await reconcileAttemptReservationInTx(tx, completion);
      if (before?.lifecycleState === "dispatching") {
        const released = await tx
          .update(localizationJournalRunUnits)
          .set({
            state: "pending",
            claimOwnerId: null,
            claimFenceToken: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(localizationJournalRunUnits.runId, completion.runId),
              eq(localizationJournalRunUnits.bridgeUnitId, completion.bridgeUnitId),
              eq(localizationJournalRunUnits.state, "claimed"),
              eq(localizationJournalRunUnits.claimOwnerId, completion.lease.ownerId),
              eq(localizationJournalRunUnits.claimFenceToken, completion.lease.fenceToken),
            ),
          )
          .returning({ bridgeUnitId: localizationJournalRunUnits.bridgeUnitId });
        if (released[0] === undefined) {
          throw new LocalizationJournalRepositoryError(
            "unit_not_pending",
            `attempt ${completion.attemptId} no longer owns claimed unit ${completion.runId}/${completion.bridgeUnitId}`,
          );
        }
      }
      return journalAttemptRowToRecord(persisted);
    });
  }

  async reconcileAttemptBilling(
    actor: AuthorizationActor,
    input: ReconcileLocalizationJournalAttemptBillingInput,
  ): Promise<LocalizationJournalAttemptRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    assertNonBlank(input.attemptId, "attemptId");
    assertNonBlank(input.runId, "runId");
    const costUsd = normalizeExactNonNegativeDecimal(input.costUsd, "costUsd");
    const costKind = input.costKind ?? "billed";
    if (!journalCostKindValues.includes(costKind)) {
      throw new LocalizationJournalRepositoryError(
        "invalid_input",
        `costKind=${String(costKind)} is not supported`,
      );
    }
    if (input.usageResponseJson !== undefined) {
      assertJsonObject(input.usageResponseJson, "usageResponseJson");
    }
    if ((input.modelId === undefined) !== (input.providerId === undefined)) {
      throw new LocalizationJournalRepositoryError(
        "invalid_input",
        "modelId and providerId must be supplied together for billing reconciliation",
      );
    }
    if (input.modelId !== undefined) assertNonBlank(input.modelId, "modelId");
    if (input.providerId !== undefined) assertNonBlank(input.providerId, "providerId");

    return this.db.transaction(async (tx) => {
      const current = await loadAttemptInTx(tx, input.attemptId);
      if (current === undefined) {
        throw new LocalizationJournalRepositoryError(
          "candidate_attempt_missing",
          `cannot reconcile missing attempt ${input.attemptId}`,
        );
      }
      if (current.runId !== input.runId) {
        throw new LocalizationJournalRepositoryError(
          "attempt_conflict",
          `attempt ${input.attemptId} is not bound to run ${input.runId}`,
        );
      }
      if (current.lifecycleState !== "completed") {
        throw new LocalizationJournalRepositoryError(
          "invalid_input",
          `attempt ${input.attemptId} must complete before billing can reconcile`,
        );
      }
      const modelId = input.modelId ?? current.modelId;
      const providerId = input.providerId ?? current.providerId;
      if (modelId === null || providerId === null) {
        throw new LocalizationJournalRepositoryError(
          "invalid_input",
          `attempt ${input.attemptId} needs its served modelId/providerId before a known bill can reconcile`,
        );
      }

      if (current.billingState === "known") {
        if (
          current.costUsd !== costUsd ||
          current.costKind !== costKind ||
          current.modelId !== modelId ||
          current.providerId !== providerId
        ) {
          throw new LocalizationJournalRepositoryError(
            "attempt_conflict",
            `attempt ${input.attemptId} already has different settled billing facts`,
          );
        }
        await reconcileKnownAttemptReservationInTx(tx, {
          runId: input.runId,
          attemptId: input.attemptId,
          settledCostUsd: costUsd,
        });
        return journalAttemptRowToRecord(current);
      }

      // `null` is a pre-migration unknown state and receives the same
      // conservative treatment as the explicit `unknown` value.
      if (current.billingState !== "unknown" && current.billingState !== null) {
        throw new LocalizationJournalRepositoryError(
          "attempt_conflict",
          `attempt ${input.attemptId} has unsupported billing state ${String(current.billingState)}`,
        );
      }
      const updated = await tx
        .update(localizationJournalLlmAttempts)
        .set({
          modelId,
          providerId,
          costUsd,
          costKind,
          billingState: "known",
          ...(input.usageResponseJson === undefined
            ? {}
            : { usageResponseJson: input.usageResponseJson }),
        })
        .where(
          and(
            eq(localizationJournalLlmAttempts.attemptId, input.attemptId),
            eq(localizationJournalLlmAttempts.runId, input.runId),
            eq(localizationJournalLlmAttempts.lifecycleState, "completed"),
            sql`(${localizationJournalLlmAttempts.billingState} = 'unknown' or ${localizationJournalLlmAttempts.billingState} is null)`,
          ),
        )
        .returning();
      const settled = updated[0] ?? (await loadAttemptInTx(tx, input.attemptId));
      if (
        settled === undefined ||
        settled.billingState !== "known" ||
        settled.costUsd !== costUsd ||
        settled.costKind !== costKind
      ) {
        throw new LocalizationJournalRepositoryError(
          "attempt_conflict",
          `attempt ${input.attemptId} could not be reconciled with settled billing facts`,
        );
      }
      await reconcileKnownAttemptReservationInTx(tx, {
        runId: input.runId,
        attemptId: input.attemptId,
        settledCostUsd: costUsd,
      });
      return journalAttemptRowToRecord(settled);
    });
  }

  async loadRunCostAccount(
    actor: AuthorizationActor,
    runId: string,
  ): Promise<LocalizationJournalRunCostAccountRecord | null> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    assertNonBlank(runId, "runId");
    const rows = await this.db
      .select()
      .from(localizationJournalRunCostAccounts)
      .where(eq(localizationJournalRunCostAccounts.runId, runId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : journalCostAccountRowToRecord(row);
  }

  async loadCostReservations(
    actor: AuthorizationActor,
    runId: string,
  ): Promise<LocalizationJournalCostReservationRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    assertNonBlank(runId, "runId");
    const rows = await this.db
      .select()
      .from(localizationJournalCostReservations)
      .where(eq(localizationJournalCostReservations.runId, runId))
      .orderBy(asc(localizationJournalCostReservations.createdAt));
    return rows.map(journalCostReservationRowToRecord);
  }

  async raiseRunCostCap(
    actor: AuthorizationActor,
    runId: string,
    capUsdInput: string,
  ): Promise<LocalizationJournalRunCostAccountRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    assertNonBlank(runId, "runId");
    const capUsd = normalizeExactNonNegativeDecimal(capUsdInput, "capUsd");
    return this.db.transaction(async (tx) => {
      // Every production path which mutates this account locks the run first.
      // Keep cap raises in the same order as reserve, reconciliation, and
      // resume so a run takeover cannot deadlock against an operator raise.
      await lockRunForCostAccountingInTx(tx, runId);
      const run = await requireRunInTx(tx, runId);
      const account = await requireRunCostAccountInTx(tx, runId);
      if (account.capUsd !== null && compareExactNonNegativeDecimals(capUsd, account.capUsd) < 0) {
        throw new LocalizationJournalRepositoryError(
          "invalid_input",
          `cost cap ${capUsd} may not lower existing cap ${account.capUsd}`,
        );
      }
      if (run.costPolicy === null) {
        throw new LocalizationJournalRepositoryError(
          "invalid_input",
          `journal run ${runId} has no frozen cost policy to raise`,
        );
      }
      const raisedCostPolicy = { ...run.costPolicy, budgetCapUsd: capUsd };
      if (!costPolicyIsCapRaise(run.costPolicy, raisedCostPolicy)) {
        throw new LocalizationJournalRepositoryError(
          "run_seed_conflict",
          `journal run ${runId} cost policy does not permit cap ${capUsd}`,
        );
      }
      const updated = await tx
        .update(localizationJournalRunCostAccounts)
        .set({ capUsd, updatedAt: new Date() })
        .where(
          and(
            eq(localizationJournalRunCostAccounts.runId, runId),
            sql`(
              ${localizationJournalRunCostAccounts.capUsd} is null
              or ${localizationJournalRunCostAccounts.capUsd} <= ${capUsd}
            )`,
            sql`${localizationJournalRunCostAccounts.spentCostUsd}
              + ${localizationJournalRunCostAccounts.reservedCostUsd}
              <= ${capUsd}`,
          ),
        )
        .returning();
      const row = updated[0];
      if (row === undefined) {
        throw new LocalizationJournalRepositoryError(
          "invalid_input",
          `cost cap ${capUsd} must not lower the concurrent cap or fall below committed spend and reservations for journal run ${runId}`,
        );
      }
      await tx
        .update(localizationJournalRuns)
        .set({ costPolicy: raisedCostPolicy, updatedAt: new Date() })
        .where(eq(localizationJournalRuns.runId, runId));
      return journalCostAccountRowToRecord(row);
    });
  }

  async persistAttempts(
    actor: AuthorizationActor,
    input: PersistLocalizationJournalAttemptsInput,
  ): Promise<LocalizationJournalAttemptRecord[]> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    assertNonBlank(input.runId, "runId");
    assertNonBlank(input.bridgeUnitId, "bridgeUnitId");
    const attempts = normalizeAttempts(input.runId, input.bridgeUnitId, input.attempts);

    return this.db.transaction(async (tx) => {
      const run = await requireRunInTx(tx, input.runId);
      if (attempts.length === 0) return [];
      if (run.frozenScope !== null) {
        // Supervised runs may write attempts only through beginAttempt /
        // completeAttempt, where the current lease and fence are revalidated.
        // Keep this batch append solely for pre-supervisor, non-frozen rows.
        await requireSeededUnitInTx(tx, input.runId, input.bridgeUnitId);
        throw new LocalizationJournalRepositoryError(
          "invalid_input",
          `frozen journal run ${input.runId} rejects unfenced persistAttempts; use beginAttempt/completeAttempt`,
        );
      }
      await ensureLegacyUnitInTx(tx, input.runId, input.bridgeUnitId);
      const persisted = await insertAttemptsIdempotently(tx, attempts);
      return persisted.map(journalAttemptRowToRecord);
    });
  }

  async persistUnit(
    actor: AuthorizationActor,
    input: PersistLocalizationJournalUnitInput,
  ): Promise<LocalizationJournalOutcomeRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    assertNonBlank(input.runId, "runId");
    assertNonBlank(input.bridgeUnitId, "bridgeUnitId");
    if (input.sourceUnitKey !== undefined) assertNonBlank(input.sourceUnitKey, "sourceUnitKey");
    assertWrittenUnitOutcome(input.outcome, "persistUnit.outcome");
    if (input.outcome.unitId !== input.bridgeUnitId) {
      throw new LocalizationJournalRepositoryError(
        "invalid_input",
        `outcome.unitId=${input.outcome.unitId} must equal persistUnit.bridgeUnitId=${input.bridgeUnitId}`,
      );
    }
    assertJsonPersistable(input.outcome.provenance, "outcome.provenance");
    assertJsonPersistable(input.contextPacket, "contextPacket");

    const attempts = normalizeAttempts(input.runId, input.bridgeUnitId, input.attempts);
    const qaDetails = validateQaDetails(input.outcome.findings, input.qaDetails);
    const contextRefs = normalizeContextRefs(input.contextRefs);
    const speakerLabels = normalizeSpeakerLabels(input.bridgeUnitId, input.speakerLabels);
    const lease =
      input.lease === undefined
        ? null
        : normalizeRunLeaseIdentity(input.lease, "persistUnit.lease");

    const journalOutcomeId = journalOutcomeIdFor(input.runId, input.outcome.id);
    const journalCandidateIds = new Map<string, string>();
    for (const candidate of input.outcome.candidates) {
      journalCandidateIds.set(candidate.id, journalCandidateIdFor(journalOutcomeId, candidate.id));
    }

    await this.db.transaction(async (tx) => {
      const run = await requireRunInTx(tx, input.runId);
      if (run.frozenScope !== null) {
        if (lease === null) {
          throw new LocalizationJournalRepositoryError(
            "run_lease_lost",
            `frozen journal run ${input.runId} requires the active driver lease to persist a unit`,
          );
        }
        await renewRunLeaseInTx(tx, input.runId, lease, ["running", "paused"]);
      } else if (lease !== null) {
        await renewRunLeaseInTx(tx, input.runId, lease, ["running", "paused"]);
      }
      if (run.targetLocale !== input.outcome.targetLocale) {
        throw new LocalizationJournalRepositoryError(
          "run_scope_mismatch",
          `outcome targetLocale=${input.outcome.targetLocale} does not match run=${input.runId} targetLocale=${run.targetLocale}`,
        );
      }
      const plannedUnit =
        run.frozenScope === null
          ? await ensureLegacyUnitInTx(
              tx,
              input.runId,
              input.bridgeUnitId,
              input.sourceUnitKey ?? null,
            )
          : await requireSeededUnitInTx(tx, input.runId, input.bridgeUnitId);
      if (run.frozenScope !== null && attempts.length > 0) {
        throw new LocalizationJournalRepositoryError(
          "invalid_input",
          `frozen journal run ${input.runId} rejects unfenced attempts in persistUnit; use beginAttempt/completeAttempt`,
        );
      }
      if (
        input.sourceUnitKey !== undefined &&
        plannedUnit.sourceUnitKey !== null &&
        plannedUnit.sourceUnitKey !== input.sourceUnitKey
      ) {
        throw new LocalizationJournalRepositoryError(
          "run_scope_mismatch",
          `unit ${input.bridgeUnitId} sourceUnitKey=${input.sourceUnitKey} does not match frozen key ${plannedUnit.sourceUnitKey}`,
        );
      }
      if (input.sourceUnitKey !== undefined && plannedUnit.sourceUnitKey === null) {
        await tx
          .update(localizationJournalRunUnits)
          .set({ sourceUnitKey: input.sourceUnitKey, updatedAt: new Date() })
          .where(
            and(
              eq(localizationJournalRunUnits.runId, input.runId),
              eq(localizationJournalRunUnits.bridgeUnitId, input.bridgeUnitId),
            ),
          );
      }

      const existing = await tx
        .select({ journalOutcomeId: writtenUnitOutcomes.journalOutcomeId })
        .from(writtenUnitOutcomes)
        .where(
          and(
            eq(writtenUnitOutcomes.runId, input.runId),
            eq(writtenUnitOutcomes.bridgeUnitId, input.bridgeUnitId),
          ),
        )
        .limit(1);
      if (existing[0] !== undefined) {
        throw new LocalizationJournalRepositoryError(
          "outcome_already_persisted",
          `run ${input.runId} already has a written outcome for bridgeUnitId=${input.bridgeUnitId}`,
        );
      }

      await insertAttemptsIdempotently(tx, attempts);
      const candidateAttemptIds = input.outcome.candidates.map((candidate) => candidate.attemptId);
      const candidateAttemptRows = await tx
        .select()
        .from(localizationJournalLlmAttempts)
        .where(inArray(localizationJournalLlmAttempts.attemptId, candidateAttemptIds));
      const candidateAttemptsById = new Map(
        candidateAttemptRows.map((attempt) => [attempt.attemptId, attempt]),
      );
      for (const candidate of input.outcome.candidates) {
        const attempt = candidateAttemptsById.get(candidate.attemptId);
        if (
          attempt === undefined ||
          attempt.runId !== input.runId ||
          attempt.bridgeUnitId !== input.bridgeUnitId ||
          attempt.lifecycleState !== "completed" ||
          attempt.modelId === null ||
          attempt.providerId === null
        ) {
          throw new LocalizationJournalRepositoryError(
            "candidate_attempt_missing",
            `candidate ${candidate.id} requires a completed attempt ${candidate.attemptId} in run/unit ${input.runId}/${input.bridgeUnitId}`,
          );
        }
        if (run.frozenScope !== null && lease !== null && attempt.fenceToken !== lease.fenceToken) {
          throw new LocalizationJournalRepositoryError(
            "attempt_conflict",
            `candidate ${candidate.id} attempt ${candidate.attemptId} belongs to fence ${attempt.fenceToken}, not active fence ${lease.fenceToken}`,
          );
        }
        if (
          candidate.producedBy.modelId !== attempt.modelId ||
          candidate.producedBy.providerId !== attempt.providerId
        ) {
          throw new LocalizationJournalRepositoryError(
            "attempt_conflict",
            `candidate ${candidate.id} producedBy=${candidate.producedBy.modelId}/${candidate.producedBy.providerId} does not match attempt ${candidate.attemptId} served pair ${attempt.modelId}/${attempt.providerId}`,
          );
        }
      }
      const writtenAt = toValidDate(input.outcome.writtenAt, "outcome.writtenAt");
      const now = new Date();
      await tx.insert(writtenUnitOutcomes).values({
        journalOutcomeId,
        outcomeId: input.outcome.id,
        runId: input.runId,
        bridgeUnitId: input.bridgeUnitId,
        sourceUnitKey: input.sourceUnitKey ?? null,
        targetLocale: input.outcome.targetLocale,
        selectedCandidateId: input.outcome.selectedCandidateId,
        qualityFlags: [...input.outcome.qualityFlags],
        provenance: input.outcome.provenance,
        contextPacket: input.contextPacket,
        writtenAt,
        createdAt: now,
      });

      await tx.insert(translationCandidates).values(
        input.outcome.candidates.map((candidate, candidateOrdinal) => ({
          journalCandidateId: journalCandidateIds.get(candidate.id)!,
          candidateId: candidate.id,
          journalOutcomeId,
          runId: input.runId,
          bridgeUnitId: input.bridgeUnitId,
          candidateOrdinal,
          body: candidate.body,
          modelId: candidate.producedBy.modelId,
          providerId: candidate.producedBy.providerId,
          attemptId: candidate.attemptId,
          kind: candidate.kind,
          createdAt: now,
        })),
      );

      // Materialize the immutable selected result in the same transaction as
      // its outcome/candidates. Finalizer coverage reads only this persisted
      // row; it never turns a written outcome into a synthetic revision later.
      await tx.insert(localizationResultRevisions).values({
        resultRevisionId: localizationResultRevisionIdFor(input.runId, input.bridgeUnitId),
        journalOutcomeId,
        runId: input.runId,
        bridgeUnitId: input.bridgeUnitId,
        selectedCandidateId: input.outcome.selectedCandidateId,
        targetBody: input.outcome.candidates.find(
          (candidate) => candidate.id === input.outcome.selectedCandidateId,
        )!.body,
        origin: "run_written_outcome",
        createdAt: writtenAt,
      });

      if (input.outcome.findings.length > 0) {
        await tx.insert(writtenQaFindings).values(
          input.outcome.findings.map((finding, findingOrdinal) => {
            const detail = qaDetails[finding.id]!;
            return {
              journalFindingId: journalFindingIdFor(journalOutcomeId, finding.id),
              findingId: finding.id,
              journalOutcomeId,
              journalCandidateId: journalCandidateIds.get(finding.candidateId)!,
              findingOrdinal,
              severity: finding.severity,
              category: finding.category,
              note: finding.note,
              contested: finding.contested,
              confidence: String(finding.confidence),
              recommendation: detail.recommendation,
              agentRationale: detail.agentRationale,
              evidenceRefs: [...detail.evidenceRefs],
              sourceSpan: detail.sourceSpan ?? null,
              draftSpan: detail.draftSpan ?? null,
              createdAt: now,
            };
          }),
        );
      }

      if (contextRefs.length > 0) {
        await tx.insert(outcomeContextRefs).values(
          contextRefs.map((ref, refOrdinal) => ({
            journalOutcomeId,
            refOrdinal,
            refKind: ref.refKind,
            refId: ref.refId,
            versionRef: ref.versionRef,
            details: ref.details,
            createdAt: now,
          })),
        );
      }

      if (speakerLabels.length > 0) {
        await tx.insert(outcomeSpeakerLabels).values(
          speakerLabels.map((label, labelOrdinal) => ({
            journalOutcomeId,
            labelOrdinal,
            bridgeUnitId: label.bridgeUnitId,
            speakerId: label.speakerId,
            confidence: label.confidence,
            evidenceRefs: [...label.evidenceRefs],
            agentRationale: label.agentRationale,
            createdAt: now,
          })),
        );
      }

      const unitUpdate = await tx
        .update(localizationJournalRunUnits)
        .set({
          state: "written",
          nextAction: null,
          claimOwnerId: null,
          claimFenceToken: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(localizationJournalRunUnits.runId, input.runId),
            eq(localizationJournalRunUnits.bridgeUnitId, input.bridgeUnitId),
            eq(localizationJournalRunUnits.state, "pending"),
          ),
        )
        .returning({ bridgeUnitId: localizationJournalRunUnits.bridgeUnitId });
      if (unitUpdate[0] === undefined) {
        throw new LocalizationJournalRepositoryError(
          "outcome_already_persisted",
          `run ${input.runId} unit ${input.bridgeUnitId} is not pending`,
        );
      }
    });

    return outcomeRecordFromInput({
      journalOutcomeId,
      input,
      contextRefs,
      speakerLabels,
      qaDetails,
    });
  }

  async loadRun(
    actor: AuthorizationActor,
    runId: string,
  ): Promise<LocalizationJournalRunRecord | null> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const rows = await this.db
      .select()
      .from(localizationJournalRuns)
      .where(eq(localizationJournalRuns.runId, runId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : journalRunRowToRecord(row);
  }

  async loadRunUnits(
    actor: AuthorizationActor,
    runId: string,
  ): Promise<LocalizationJournalRunUnitRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    assertNonBlank(runId, "runId");
    const rows = await this.db
      .select()
      .from(localizationJournalRunUnits)
      .where(eq(localizationJournalRunUnits.runId, runId))
      .orderBy(asc(localizationJournalRunUnits.unitOrdinal));
    return rows.map(journalRunUnitRowToRecord);
  }

  async pauseRun(
    actor: AuthorizationActor,
    runId: string,
    blocker: LocalizationJournalOperationalBlocker,
    leaseInput: LocalizationJournalRunLeaseIdentity,
  ): Promise<LocalizationJournalRunRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    assertNonBlank(runId, "runId");
    const normalizedBlocker = normalizeOperationalBlocker(blocker);
    const lease = normalizeRunLeaseIdentity(leaseInput, "lease");
    const updated = await this.db
      .update(localizationJournalRuns)
      .set({
        status: "paused",
        pausedBlocker: normalizedBlocker,
        leaseExpiresAt: leaseExpiryFromDbNow(lease.leaseSeconds),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(localizationJournalRuns.runId, runId),
          eq(localizationJournalRuns.status, "running"),
          eq(localizationJournalRuns.leaseOwnerId, lease.ownerId),
          eq(localizationJournalRuns.fenceToken, lease.fenceToken),
          sql`${localizationJournalRuns.leaseExpiresAt} > now()`,
        ),
      )
      .returning();
    const row = updated[0];
    if (row !== undefined) return journalRunRowToRecord(row);

    const currentRows = await this.db
      .select()
      .from(localizationJournalRuns)
      .where(eq(localizationJournalRuns.runId, runId))
      .limit(1);
    const current = currentRows[0];
    if (current === undefined) {
      throw new LocalizationJournalRepositoryError(
        "run_not_found",
        `journal run ${runId} does not exist`,
      );
    }
    if (current.status === "paused") {
      // Concurrent supervisors can discover the same operational outage. The
      // first durable blocker wins; later pause writes converge on that record
      // without overwriting its evidence or operator action.
      const renewed = await this.db
        .update(localizationJournalRuns)
        .set({
          leaseExpiresAt: leaseExpiryFromDbNow(lease.leaseSeconds),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(localizationJournalRuns.runId, runId),
            eq(localizationJournalRuns.status, "paused"),
            eq(localizationJournalRuns.leaseOwnerId, lease.ownerId),
            eq(localizationJournalRuns.fenceToken, lease.fenceToken),
            sql`${localizationJournalRuns.leaseExpiresAt} > now()`,
          ),
        )
        .returning();
      if (renewed[0] !== undefined) return journalRunRowToRecord(renewed[0]);
    }
    if (current.status === "running" || current.status === "paused") {
      throw new LocalizationJournalRepositoryError(
        "run_lease_lost",
        `driver ${lease.ownerId} fence ${lease.fenceToken} no longer owns journal run ${runId}`,
      );
    }
    throw new LocalizationJournalRepositoryError(
      "invalid_run_transition",
      `cannot pause journal run ${runId} from status ${current.status}`,
    );
  }

  async resumeRun(
    actor: AuthorizationActor,
    runId: string,
    leaseInput: Omit<LocalizationJournalRunLeaseIdentity, "fenceToken">,
  ): Promise<LocalizationJournalRunRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    assertNonBlank(runId, "runId");
    const lease = normalizeSeedRunLease(leaseInput, "lease");
    return this.db.transaction(async (tx) => {
      const resumedAt = new Date();
      // This is the takeover boundary. Fencing guarantees that the old fence
      // cannot persist a duplicate or incorrect OUTCOME. A duplicate provider
      // CALL (and cost) remains possible only if its JavaScript event loop
      // freezes beyond this DB lease while a non-idempotent request is live;
      // preventing that residual requires provider idempotency keys, which are
      // unavailable. This is an accepted fundamental limitation. Healthy
      // drivers bind every request to this lease deadline.
      const rows = await tx
        .update(localizationJournalRuns)
        .set({
          status: "running",
          pausedBlocker: null,
          leaseOwnerId: lease.ownerId,
          leaseExpiresAt: leaseExpiryFromDbNow(lease.leaseSeconds),
          fenceToken: sql`${localizationJournalRuns.fenceToken} + 1`,
          updatedAt: resumedAt,
        })
        .where(
          and(
            eq(localizationJournalRuns.runId, runId),
            sql`(
              (
                ${localizationJournalRuns.status} = 'paused'
                and (
                  (
                    ${localizationJournalRuns.leaseOwnerId} is null
                    and ${localizationJournalRuns.leaseExpiresAt} is null
                  )
                  or ${localizationJournalRuns.leaseExpiresAt} <= now()
                )
              )
              or (
                ${localizationJournalRuns.status} = 'running'
                and ${localizationJournalRuns.fenceToken} > 0
                and ${localizationJournalRuns.leaseOwnerId} is not null
                and ${localizationJournalRuns.leaseExpiresAt} <= now()
              )
            )`,
          ),
        )
        .returning();
      const resumed = rows[0];
      if (resumed === undefined) {
        const current = await requireRunInTx(tx, runId);
        if (current.status !== "paused" && current.status !== "running") {
          throw new LocalizationJournalRepositoryError(
            "invalid_run_transition",
            `cannot resume journal run ${runId} from status ${current.status}`,
          );
        }
        throw new LocalizationJournalRepositoryError(
          "run_lease_conflict",
          `cannot resume journal run ${runId}: ${current.status} lease fence ${current.fenceToken} is still live or was never acquired`,
        );
      }

      // A process can die after the pre-dispatch row commits and before the
      // completion write. Explicit resume is the recovery boundary: close
      // every orphaned attempt truthfully as providerless/interrupted before
      // any pending unit is re-driven with a fresh physical attempt id.
      const interrupted = await tx
        .update(localizationJournalLlmAttempts)
        .set({
          lifecycleState: "completed",
          modelId: null,
          providerId: null,
          costUsd: null,
          costKind: null,
          billingState: "unknown",
          usageResponseJson: null,
          tokensIn: null,
          tokensOut: null,
          tokenCountSource: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          cacheDiscountMicrosUsd: null,
          fallbackUsed: null,
          fallbackPlan: null,
          finishState: "interrupted",
          refusalState: null,
          validationResult: "provider_failed",
          failureClass: "interrupted",
          retryDecision: "retry",
          retryDelayMs: 0,
          errorClasses: ["supervisor_process_interrupted"],
          completedAt: resumedAt,
        })
        .where(
          and(
            eq(localizationJournalLlmAttempts.runId, runId),
            eq(localizationJournalLlmAttempts.lifecycleState, "dispatching"),
            sql`${localizationJournalLlmAttempts.fenceToken} < ${resumed.fenceToken}`,
          ),
        )
        .returning({ attemptId: localizationJournalLlmAttempts.attemptId });

      // The pre-dispatch reservation is tied to the physical attempt, not to
      // the logical unit. Once this resume fences and closes that attempt, it
      // can no longer be in flight and must stop consuming capacity. `released`
      // is terminal: this interrupted attempt keeps unknown billing and records
      // no speculative late cost.
      await releaseInterruptedAttemptReservationsInTx(
        tx,
        runId,
        interrupted.map((attempt) => attempt.attemptId),
        resumedAt,
      );

      await tx
        .update(localizationJournalRunUnits)
        .set({
          state: "pending",
          claimOwnerId: null,
          claimFenceToken: null,
          updatedAt: resumedAt,
        })
        .where(
          and(
            eq(localizationJournalRunUnits.runId, runId),
            eq(localizationJournalRunUnits.state, "claimed"),
            sql`${localizationJournalRunUnits.claimFenceToken} < ${resumed.fenceToken}`,
          ),
        );

      return journalRunRowToRecord(resumed);
    });
  }

  async renewRunLease(
    actor: AuthorizationActor,
    runId: string,
    leaseInput: LocalizationJournalRunLeaseIdentity,
  ): Promise<LocalizationJournalRenewedRunRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    assertNonBlank(runId, "runId");
    const lease = normalizeRunLeaseIdentity(leaseInput, "lease");
    return this.db.transaction(async (tx) => {
      const renewed = await renewRunLeaseInTx(tx, runId, lease, ["running", "paused"]);
      return {
        ...journalRunRowToRecord(renewed),
        leaseDeadline: await loadRunLeaseDeadlineInTx(tx, runId),
      };
    });
  }

  async releaseRunLease(
    actor: AuthorizationActor,
    runId: string,
    leaseInput: LocalizationJournalRunLeaseIdentity,
  ): Promise<LocalizationJournalRunRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    assertNonBlank(runId, "runId");
    const lease = normalizeRunLeaseIdentity(leaseInput, "lease");
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .update(localizationJournalRuns)
        .set({ leaseOwnerId: null, leaseExpiresAt: null, updatedAt: new Date() })
        .where(
          and(
            eq(localizationJournalRuns.runId, runId),
            eq(localizationJournalRuns.status, "paused"),
            eq(localizationJournalRuns.leaseOwnerId, lease.ownerId),
            eq(localizationJournalRuns.fenceToken, lease.fenceToken),
            sql`${localizationJournalRuns.leaseExpiresAt} > now()`,
            sql`not exists (
              select 1
              from itotori_llm_attempts attempt
              where attempt.run_id = ${localizationJournalRuns.runId}
                and attempt.fence_token = ${localizationJournalRuns.fenceToken}
                and attempt.lifecycle_state = 'dispatching'
            )`,
            sql`not exists (
              select 1
              from itotori_localization_journal_run_units unit
              where unit.run_id = ${localizationJournalRuns.runId}
                and unit.claim_fence_token = ${localizationJournalRuns.fenceToken}
                and unit.state = 'claimed'
            )`,
          ),
        )
        .returning();
      if (rows[0] !== undefined) return journalRunRowToRecord(rows[0]);

      const current = await requireRunInTx(tx, runId);
      if (current.status !== "paused") {
        throw new LocalizationJournalRepositoryError(
          "invalid_run_transition",
          `cannot release journal run ${runId} while it is ${current.status}`,
        );
      }
      if (await runLeaseIsLiveInTx(tx, runId, lease)) {
        throw new LocalizationJournalRepositoryError(
          "run_lease_conflict",
          `cannot release journal run ${runId}: fence ${lease.fenceToken} still has a dispatching attempt or claimed unit`,
        );
      }
      throw new LocalizationJournalRepositoryError(
        "run_lease_lost",
        `driver ${lease.ownerId} fence ${lease.fenceToken} cannot release journal run ${runId}`,
      );
    });
  }

  async loadRunsForBranch(
    actor: AuthorizationActor,
    localeBranchId: string,
  ): Promise<LocalizationJournalRunRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const rows = await this.db
      .select()
      .from(localizationJournalRuns)
      .where(eq(localizationJournalRuns.localeBranchId, localeBranchId))
      .orderBy(asc(localizationJournalRuns.createdAt), asc(localizationJournalRuns.runId));
    return rows.map(journalRunRowToRecord);
  }

  async loadLatestRunForBranch(
    actor: AuthorizationActor,
    localeBranchId: string,
  ): Promise<LocalizationJournalRunRecord | null> {
    const runs = await this.loadRunsForBranch(actor, localeBranchId);
    return runs.at(-1) ?? null;
  }

  async loadRunOutcomes(
    actor: AuthorizationActor,
    runId: string,
  ): Promise<LocalizationJournalOutcomeRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const outcomeRows = await this.db
      .select()
      .from(writtenUnitOutcomes)
      .where(eq(writtenUnitOutcomes.runId, runId))
      .orderBy(asc(writtenUnitOutcomes.writtenAt), asc(writtenUnitOutcomes.bridgeUnitId));
    if (outcomeRows.length === 0) return [];

    const journalOutcomeIds = outcomeRows.map((row) => row.journalOutcomeId);
    const [candidateRows, findingRows, contextRefRows, speakerLabelRows] = await Promise.all([
      this.db
        .select()
        .from(translationCandidates)
        .where(inArray(translationCandidates.journalOutcomeId, journalOutcomeIds))
        .orderBy(
          asc(translationCandidates.journalOutcomeId),
          asc(translationCandidates.candidateOrdinal),
        ),
      this.db
        .select()
        .from(writtenQaFindings)
        .where(inArray(writtenQaFindings.journalOutcomeId, journalOutcomeIds))
        .orderBy(asc(writtenQaFindings.journalOutcomeId), asc(writtenQaFindings.findingOrdinal)),
      this.db
        .select()
        .from(outcomeContextRefs)
        .where(inArray(outcomeContextRefs.journalOutcomeId, journalOutcomeIds))
        .orderBy(asc(outcomeContextRefs.journalOutcomeId), asc(outcomeContextRefs.refOrdinal)),
      this.db
        .select()
        .from(outcomeSpeakerLabels)
        .where(inArray(outcomeSpeakerLabels.journalOutcomeId, journalOutcomeIds))
        .orderBy(
          asc(outcomeSpeakerLabels.journalOutcomeId),
          asc(outcomeSpeakerLabels.labelOrdinal),
        ),
    ]);

    const candidatesByOutcome = groupRows(candidateRows, (row) => row.journalOutcomeId);
    const findingsByOutcome = groupRows(findingRows, (row) => row.journalOutcomeId);
    const refsByOutcome = groupRows(contextRefRows, (row) => row.journalOutcomeId);
    const labelsByOutcome = groupRows(speakerLabelRows, (row) => row.journalOutcomeId);

    return outcomeRows.map((outcomeRow) => {
      const candidateRowsForOutcome = candidatesByOutcome.get(outcomeRow.journalOutcomeId) ?? [];
      const canonicalCandidateIdByJournalId = new Map(
        candidateRowsForOutcome.map((row) => [row.journalCandidateId, row.candidateId]),
      );
      const candidates = candidateRowsForOutcome.map((row) =>
        candidateRowToCanonical(row, outcomeRow.outcomeId),
      );
      const findingsAndDetails = (findingsByOutcome.get(outcomeRow.journalOutcomeId) ?? []).map(
        (row) =>
          findingRowToCanonical(
            row,
            outcomeRow.outcomeId,
            canonicalCandidateIdByJournalId.get(row.journalCandidateId),
          ),
      );
      const findings = findingsAndDetails.map((entry) => entry.finding);
      const qaDetails = Object.fromEntries(
        findingsAndDetails.map((entry) => [entry.finding.id, entry.detail]),
      );
      const outcome: WrittenUnitOutcome = {
        id: outcomeRow.outcomeId,
        status: "written",
        unitId: outcomeRow.bridgeUnitId,
        targetLocale: outcomeRow.targetLocale,
        selectedCandidateId: outcomeRow.selectedCandidateId,
        candidates,
        findings,
        qualityFlags: [...outcomeRow.qualityFlags],
        provenance: outcomeRow.provenance,
        writtenAt: outcomeRow.writtenAt.toISOString(),
      };
      // This is a corruption guard, not a reconstruction shortcut: all fields
      // were read from normalized tables and must still satisfy the canonical
      // invariant before consumers receive them.
      assertWrittenUnitOutcome(outcome, `loadRunOutcomes(${runId}).outcome`);

      return {
        journalOutcomeId: outcomeRow.journalOutcomeId,
        runId: outcomeRow.runId,
        bridgeUnitId: outcomeRow.bridgeUnitId,
        sourceUnitKey: outcomeRow.sourceUnitKey,
        outcome,
        candidates,
        findings,
        contextPacket: outcomeRow.contextPacket,
        contextRefs: (refsByOutcome.get(outcomeRow.journalOutcomeId) ?? []).map((row) => ({
          refKind: row.refKind,
          refId: row.refId,
          versionRef: row.versionRef,
          details: row.details ?? null,
        })),
        speakerLabels: (labelsByOutcome.get(outcomeRow.journalOutcomeId) ?? []).map(
          speakerLabelRowToCanonical,
        ),
        qaDetails,
      };
    });
  }

  async loadAttemptsForRun(
    actor: AuthorizationActor,
    runId: string,
  ): Promise<LocalizationJournalAttemptRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const rows = await this.db
      .select()
      .from(localizationJournalLlmAttempts)
      .where(eq(localizationJournalLlmAttempts.runId, runId))
      .orderBy(
        asc(localizationJournalLlmAttempts.bridgeUnitId),
        asc(localizationJournalLlmAttempts.logicalCallId),
        asc(localizationJournalLlmAttempts.attemptIndex),
      );
    return rows.map(journalAttemptRowToRecord);
  }

  async sumAttemptsByPairAndDay(
    actor: AuthorizationActor,
    projectId: string,
    window: { from: Date; to: Date },
    opts?: LocalizationJournalAttemptAggregateOptions,
  ): Promise<LocalizationJournalAttemptAggregateRow[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    assertJournalAggregateWindow(window);

    const groupByDay = opts?.groupByDay === true;
    const requestedModelId = sql<string>`coalesce(${localizationJournalLlmAttempts.requestedModelId}, ${localizationJournalLlmAttempts.modelId})`;
    const requestedProviderId = sql<string>`coalesce(${localizationJournalLlmAttempts.requestedProviderId}, ${localizationJournalLlmAttempts.providerId})`;
    const bucketDay = sql<
      string | null
    >`to_char(${localizationJournalLlmAttempts.completedAt} at time zone 'UTC', 'YYYY-MM-DD')`;
    const nullBucketDay = sql<string | null>`NULL::text`;
    const latencyMs = sql<
      string | null
    >`(avg(extract(epoch from (${localizationJournalLlmAttempts.completedAt} - ${localizationJournalLlmAttempts.startedAt})) * 1000))::text`;
    const p95LatencyMs = sql<
      string | null
    >`(percentile_cont(0.95) within group (order by extract(epoch from (${localizationJournalLlmAttempts.completedAt} - ${localizationJournalLlmAttempts.startedAt})) * 1000))::text`;

    const rows = await this.db
      .select({
        requestedModelId,
        requestedProviderId,
        requestedPairCapturedInvocationCount: sql<string>`count(*) filter (where ${localizationJournalLlmAttempts.requestedModelId} is not null and ${localizationJournalLlmAttempts.requestedProviderId} is not null)::text`,
        bucketDay: groupByDay ? bucketDay : nullBucketDay,
        totalCostUsd: sql<string>`coalesce(sum(${localizationJournalLlmAttempts.costUsd}), 0)::text`,
        totalTokensIn: sql<string>`coalesce(sum(coalesce(${localizationJournalLlmAttempts.tokensIn}, 0)), 0)::text`,
        totalTokensOut: sql<string>`coalesce(sum(coalesce(${localizationJournalLlmAttempts.tokensOut}, 0)), 0)::text`,
        invocationCount: sql<string>`count(*)::text`,
        avgLatencyMs: latencyMs,
        p95LatencyMs,
        cacheFactsCapturedInvocationCount: sql<string>`count(*) filter (where ${localizationJournalLlmAttempts.cacheReadTokens} is not null and ${localizationJournalLlmAttempts.cacheWriteTokens} is not null and ${localizationJournalLlmAttempts.cacheDiscountMicrosUsd} is not null)::text`,
        cacheHitCount: sql<string>`count(*) filter (where ${localizationJournalLlmAttempts.cacheReadTokens} > 0)::text`,
        totalCacheReadTokens: sql<string>`coalesce(sum(coalesce(${localizationJournalLlmAttempts.cacheReadTokens}, 0)), 0)::text`,
        totalCacheWriteTokens: sql<string>`coalesce(sum(coalesce(${localizationJournalLlmAttempts.cacheWriteTokens}, 0)), 0)::text`,
        cacheSavingsUsd: sql<string>`(coalesce(sum(coalesce(${localizationJournalLlmAttempts.cacheDiscountMicrosUsd}, 0)), 0)::numeric / 1000000)::text`,
      })
      .from(localizationJournalLlmAttempts)
      .innerJoin(
        localizationJournalRuns,
        eq(localizationJournalLlmAttempts.runId, localizationJournalRuns.runId),
      )
      .where(
        and(
          eq(localizationJournalRuns.projectId, projectId),
          eq(localizationJournalLlmAttempts.lifecycleState, "completed"),
          sql`${localizationJournalLlmAttempts.costUsd} is not null`,
          gte(localizationJournalLlmAttempts.completedAt, window.from),
          lte(localizationJournalLlmAttempts.completedAt, window.to),
        ),
      )
      .groupBy(requestedModelId, requestedProviderId, ...(groupByDay ? [bucketDay] : []))
      .orderBy(asc(requestedModelId), asc(requestedProviderId));

    return rows.map(parseJournalAttemptAggregateRow);
  }

  async countZdrEnforcedAttemptsByPair(
    actor: AuthorizationActor,
    projectId: string,
    window: { from: Date; to: Date },
  ): Promise<LocalizationJournalZdrAggregateRow[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    assertJournalAggregateWindow(window);

    const requestedModelId = sql<string>`coalesce(${localizationJournalLlmAttempts.requestedModelId}, ${localizationJournalLlmAttempts.modelId})`;
    const requestedProviderId = sql<string>`coalesce(${localizationJournalLlmAttempts.requestedProviderId}, ${localizationJournalLlmAttempts.providerId})`;
    const rows = await this.db
      .select({
        requestedModelId,
        requestedProviderId,
        requestedPairCapturedInvocationCount: sql<string>`count(*) filter (where ${localizationJournalLlmAttempts.requestedModelId} is not null and ${localizationJournalLlmAttempts.requestedProviderId} is not null)::text`,
        invocationCount: sql<string>`count(*)::text`,
        zdrEnforcedCount: sql<string>`count(*) filter (where ${localizationJournalLlmAttempts.zdr} = true)::text`,
      })
      .from(localizationJournalLlmAttempts)
      .innerJoin(
        localizationJournalRuns,
        eq(localizationJournalLlmAttempts.runId, localizationJournalRuns.runId),
      )
      .where(
        and(
          eq(localizationJournalRuns.projectId, projectId),
          eq(localizationJournalLlmAttempts.lifecycleState, "completed"),
          gte(localizationJournalLlmAttempts.completedAt, window.from),
          lte(localizationJournalLlmAttempts.completedAt, window.to),
        ),
      )
      .groupBy(requestedModelId, requestedProviderId)
      .orderBy(asc(requestedModelId), asc(requestedProviderId));

    return rows.map((row) => ({
      requestedPairAvailability:
        parseJournalCount(
          row.requestedPairCapturedInvocationCount,
          "requestedPairCapturedInvocationCount",
        ) === parseJournalCount(row.invocationCount, "invocationCount")
          ? "complete"
          : "partial",
      requestedModelId: row.requestedModelId,
      requestedProviderId: row.requestedProviderId,
      invocationCount: parseJournalCount(row.invocationCount, "invocationCount"),
      zdrEnforcedCount: parseJournalCount(row.zdrEnforcedCount, "zdrEnforcedCount"),
    }));
  }

  async countCostKindsByPair(
    actor: AuthorizationActor,
    projectId: string,
    window: { from: Date; to: Date },
  ): Promise<LocalizationJournalCostKindAggregateRow[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    assertJournalAggregateWindow(window);

    const requestedModelId = sql<string>`coalesce(${localizationJournalLlmAttempts.requestedModelId}, ${localizationJournalLlmAttempts.modelId})`;
    const requestedProviderId = sql<string>`coalesce(${localizationJournalLlmAttempts.requestedProviderId}, ${localizationJournalLlmAttempts.providerId})`;
    const rows = await this.db
      .select({
        requestedModelId,
        requestedProviderId,
        requestedPairCapturedInvocationCount: sql<string>`count(*) filter (where ${localizationJournalLlmAttempts.requestedModelId} is not null and ${localizationJournalLlmAttempts.requestedProviderId} is not null)::text`,
        costKind: localizationJournalLlmAttempts.costKind,
        invocationCount: sql<string>`count(*)::text`,
        amountMicrosUsd: sql<string>`coalesce(sum(round(${localizationJournalLlmAttempts.costUsd} * 1000000)), 0)::text`,
      })
      .from(localizationJournalLlmAttempts)
      .innerJoin(
        localizationJournalRuns,
        eq(localizationJournalLlmAttempts.runId, localizationJournalRuns.runId),
      )
      .where(
        and(
          eq(localizationJournalRuns.projectId, projectId),
          eq(localizationJournalLlmAttempts.lifecycleState, "completed"),
          gte(localizationJournalLlmAttempts.completedAt, window.from),
          lte(localizationJournalLlmAttempts.completedAt, window.to),
          sql`${localizationJournalLlmAttempts.costKind} is not null`,
        ),
      )
      .groupBy(requestedModelId, requestedProviderId, localizationJournalLlmAttempts.costKind)
      .orderBy(
        asc(requestedModelId),
        asc(requestedProviderId),
        asc(localizationJournalLlmAttempts.costKind),
      );

    return rows.map((row) => {
      if (!isJournalCostKind(row.costKind)) {
        throw new LocalizationJournalRepositoryError(
          "invalid_input",
          `journal cost kind ${String(row.costKind)} is not supported`,
        );
      }
      return {
        requestedPairAvailability:
          parseJournalCount(
            row.requestedPairCapturedInvocationCount,
            "requestedPairCapturedInvocationCount",
          ) === parseJournalCount(row.invocationCount, "invocationCount")
            ? "complete"
            : "partial",
        requestedModelId: row.requestedModelId,
        requestedProviderId: row.requestedProviderId,
        costKind: row.costKind,
        invocationCount: parseJournalCount(row.invocationCount, "invocationCount"),
        amountMicrosUsd: parseJournalCount(row.amountMicrosUsd, "amountMicrosUsd"),
      };
    });
  }

  async loadJobsRunTable(
    actor: AuthorizationActor,
    options: LoadJobsRunTableOptions = {},
  ): Promise<JobsRunTableReadModel> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const projectId = options.projectId;
    if (projectId === undefined || projectId.length === 0) {
      throw new LocalizationJournalRepositoryError(
        "invalid_input",
        "loadJobsRunTable requires a non-empty projectId scope (the journal run table is never read across projects)",
      );
    }
    const limit = normalizeJobsRunTableLimit(options.limit);
    const offset = normalizeJobsRunTableOffset(options.offset);
    const projectCondition = eq(localizationJournalRuns.projectId, projectId);

    const totalRows = await this.db
      .select({ total: sql<string>`count(*)::text` })
      .from(localizationJournalLlmAttempts)
      .innerJoin(
        localizationJournalRuns,
        eq(localizationJournalLlmAttempts.runId, localizationJournalRuns.runId),
      )
      .where(
        and(
          projectCondition,
          eq(localizationJournalLlmAttempts.lifecycleState, "completed"),
          sql`${localizationJournalLlmAttempts.modelId} is not null`,
          sql`${localizationJournalLlmAttempts.providerId} is not null`,
          sql`${localizationJournalLlmAttempts.costUsd} is not null`,
        ),
      );
    const total = parseJournalCount(totalRows[0]?.total ?? "0", "jobs run table total");

    const rows = await this.db
      .select({
        runId: localizationJournalRuns.runId,
        attemptId: localizationJournalLlmAttempts.attemptId,
        providerRunId: localizationJournalLlmAttempts.providerRunId,
        bridgeUnitId: localizationJournalLlmAttempts.bridgeUnitId,
        projectId: localizationJournalRuns.projectId,
        localeBranchId: localizationJournalRuns.localeBranchId,
        stage: localizationJournalLlmAttempts.stage,
        agentLabel: localizationJournalLlmAttempts.agentLabel,
        status: localizationJournalLlmAttempts.validationResult,
        servedModel: localizationJournalLlmAttempts.modelId,
        servedProvider: localizationJournalLlmAttempts.providerId,
        zdr: localizationJournalLlmAttempts.zdr,
        costUsd: sql<string | null>`${localizationJournalLlmAttempts.costUsd}::text`,
        tokensIn: localizationJournalLlmAttempts.tokensIn,
        tokensOut: localizationJournalLlmAttempts.tokensOut,
        fallbackUsed: localizationJournalLlmAttempts.fallbackUsed,
        fallbackPlan: localizationJournalLlmAttempts.fallbackPlan,
        completedAt: localizationJournalLlmAttempts.completedAt,
      })
      .from(localizationJournalLlmAttempts)
      .innerJoin(
        localizationJournalRuns,
        eq(localizationJournalLlmAttempts.runId, localizationJournalRuns.runId),
      )
      .where(
        and(
          projectCondition,
          eq(localizationJournalLlmAttempts.lifecycleState, "completed"),
          sql`${localizationJournalLlmAttempts.modelId} is not null`,
          sql`${localizationJournalLlmAttempts.providerId} is not null`,
          sql`${localizationJournalLlmAttempts.costUsd} is not null`,
        ),
      )
      .orderBy(
        desc(localizationJournalLlmAttempts.completedAt),
        desc(localizationJournalLlmAttempts.attemptId),
      )
      .limit(limit)
      .offset(offset);

    return {
      schemaVersion: JOBS_RUN_TABLE_SCHEMA_VERSION,
      generatedAt: (options.generatedAt ?? new Date()).toISOString(),
      filter: { projectId },
      pagination: jobsRunTablePagination(total, limit, offset),
      rows: rows.map(jobsRunTableRowFromCompletedAttempt),
    };
  }
}

function localizationResultRevisionIdFor(runId: string, bridgeUnitId: string): string {
  return `run-result:${runId}:${bridgeUnitId}`;
}

type CompletedJobsAttemptRow = {
  runId: string;
  attemptId: string;
  providerRunId: string;
  bridgeUnitId: string;
  projectId: string;
  localeBranchId: string;
  stage: string;
  agentLabel: string;
  status: string | null;
  servedModel: string | null;
  servedProvider: string | null;
  zdr: boolean | null;
  costUsd: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  fallbackUsed: boolean | null;
  fallbackPlan: string[] | null;
  completedAt: Date | null;
};

function jobsRunTableRowFromCompletedAttempt(row: CompletedJobsAttemptRow): JobsRunTableRow {
  if (
    row.status === null ||
    row.servedModel === null ||
    row.servedProvider === null ||
    row.zdr === null ||
    row.costUsd === null ||
    row.completedAt === null
  ) {
    throw new LocalizationJournalRepositoryError(
      "invalid_input",
      `completed attempt ${row.attemptId} is missing terminal provider/cost facts`,
    );
  }
  return {
    runId: row.providerRunId,
    journalRunId: row.runId,
    attemptId: row.attemptId,
    providerRunId: row.providerRunId,
    bridgeUnitId: row.bridgeUnitId,
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    task: `${row.stage}:${row.agentLabel}`,
    status: row.status,
    servedModel: row.servedModel,
    servedProvider: row.servedProvider,
    zdr: row.zdr,
    cost: { unit: "usd", amount: row.costUsd },
    tokens: {
      in: row.tokensIn,
      out: row.tokensOut,
      total:
        row.tokensIn === null && row.tokensOut === null
          ? null
          : (row.tokensIn ?? 0) + (row.tokensOut ?? 0),
    },
    fallback: {
      availability:
        row.fallbackUsed === null || row.fallbackPlan === null ? "not_captured" : "captured",
      used: row.fallbackUsed,
      plan: row.fallbackPlan === null ? null : [...row.fallbackPlan],
      chain: [],
    },
    createdAt: row.completedAt.toISOString(),
  };
}

function assertJournalAggregateWindow(window: { from: Date; to: Date }): void {
  if (window.from.getTime() > window.to.getTime()) {
    throw new LocalizationJournalRepositoryError(
      "invalid_input",
      "journal aggregate window.from must not be after window.to",
    );
  }
}

type RawJournalAttemptAggregateRow = {
  requestedModelId: string;
  requestedProviderId: string;
  requestedPairCapturedInvocationCount: string;
  bucketDay: string | null;
  totalCostUsd: string;
  totalTokensIn: string;
  totalTokensOut: string;
  invocationCount: string;
  avgLatencyMs: string | null;
  p95LatencyMs: string | null;
  cacheFactsCapturedInvocationCount: string;
  cacheHitCount: string;
  totalCacheReadTokens: string;
  totalCacheWriteTokens: string;
  cacheSavingsUsd: string;
};

function parseJournalAttemptAggregateRow(
  row: RawJournalAttemptAggregateRow,
): LocalizationJournalAttemptAggregateRow {
  const invocationCount = parseJournalCount(row.invocationCount, "invocationCount");
  const requestedPairCapturedInvocationCount = parseJournalCount(
    row.requestedPairCapturedInvocationCount,
    "requestedPairCapturedInvocationCount",
  );
  const cacheFactsCapturedInvocationCount = parseJournalCount(
    row.cacheFactsCapturedInvocationCount,
    "cacheFactsCapturedInvocationCount",
  );
  return {
    requestedPairAvailability:
      requestedPairCapturedInvocationCount === invocationCount ? "complete" : "partial",
    requestedModelId: row.requestedModelId,
    requestedProviderId: row.requestedProviderId,
    bucketDay: row.bucketDay,
    totalCostUsd: row.totalCostUsd,
    totalTokensIn: parseJournalCount(row.totalTokensIn, "totalTokensIn"),
    totalTokensOut: parseJournalCount(row.totalTokensOut, "totalTokensOut"),
    invocationCount,
    avgLatencyMs: parseOptionalJournalNumber(row.avgLatencyMs),
    p95LatencyMs: parseOptionalJournalNumber(row.p95LatencyMs),
    cacheFactsAvailability:
      cacheFactsCapturedInvocationCount === invocationCount ? "complete" : "partial",
    cacheFactsCapturedInvocationCount,
    cacheHitCount: parseJournalCount(row.cacheHitCount, "cacheHitCount"),
    totalCacheReadTokens: parseJournalCount(row.totalCacheReadTokens, "totalCacheReadTokens"),
    totalCacheWriteTokens: parseJournalCount(row.totalCacheWriteTokens, "totalCacheWriteTokens"),
    cacheSavingsUsd: row.cacheSavingsUsd,
  };
}

function parseJournalCount(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new LocalizationJournalRepositoryError(
      "invalid_input",
      `unexpected journal aggregate ${label}=${value}`,
    );
  }
  return parsed;
}

function parseOptionalJournalNumber(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeJobsRunTableLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit < 1) {
    return JOBS_RUN_TABLE_DEFAULT_LIMIT;
  }
  return Math.min(limit, JOBS_RUN_TABLE_MAX_LIMIT);
}

function normalizeJobsRunTableOffset(offset: number | undefined): number {
  return offset === undefined || !Number.isInteger(offset) || offset < 0 ? 0 : offset;
}

function jobsRunTablePagination(
  total: number,
  limit: number,
  offset: number,
): JobsRunTablePagination {
  const pageCount = total === 0 ? 0 : Math.ceil(total / limit);
  const hasMore = offset + limit < total;
  return {
    total,
    limit,
    offset,
    page: Math.floor(offset / limit) + 1,
    pageCount,
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
  };
}

function validateRunInput(input: CreateLocalizationJournalRunInput): void {
  if (input.runId !== undefined) assertNonBlank(input.runId, "runId");
  assertNonBlank(input.projectId, "projectId");
  assertNonBlank(input.localeBranchId, "localeBranchId");
  assertNonBlank(input.sourceRevisionId, "sourceRevisionId");
  assertNonBlank(input.targetLocale, "targetLocale");
  if (input.createdAt !== undefined) toValidDate(input.createdAt, "createdAt");
}

function validateSeedRunInput(input: SeedLocalizationJournalRunInput): void {
  validateRunInput(input);
  assertJsonPersistable(input.frozenScope, "frozenScope");
  if (
    input.frozenScope === null ||
    (typeof input.frozenScope !== "object" && !Array.isArray(input.frozenScope))
  ) {
    throw new LocalizationJournalRepositoryError(
      "invalid_input",
      "frozenScope must be a JSON object or array",
    );
  }
  assertJsonObject(input.routingPolicy, "routingPolicy");
  assertJsonObject(input.costPolicy, "costPolicy");
  if (!Array.isArray(input.units)) {
    throw new LocalizationJournalRepositoryError("invalid_input", "units must be an array");
  }
  const unitIds = new Set<string>();
  for (const [index, unit] of input.units.entries()) {
    assertNonBlank(unit.bridgeUnitId, `units[${index}].bridgeUnitId`);
    if (unitIds.has(unit.bridgeUnitId)) {
      throw new LocalizationJournalRepositoryError(
        "invalid_input",
        `units[${index}].bridgeUnitId=${unit.bridgeUnitId} is duplicated`,
      );
    }
    unitIds.add(unit.bridgeUnitId);
    if (unit.sourceUnitKey !== undefined) {
      assertNonBlank(unit.sourceUnitKey, `units[${index}].sourceUnitKey`);
    }
    normalizeNextAction(unit.nextAction, `units[${index}].nextAction`);
  }
  if (input.refinement !== undefined) validateSeedRefinementInput(input.refinement);
  if (input.lease !== undefined) normalizeSeedRunLease(input.lease, "lease");
}

function validateSeedRefinementInput(input: SeedLocalizationJournalRefinementInput): void {
  assertNonBlank(input.basePatchVersionId, "refinement.basePatchVersionId");
  if (!Array.isArray(input.feedbackBatchIds)) {
    throw new LocalizationJournalRepositoryError(
      "invalid_input",
      "refinement.feedbackBatchIds must be an array",
    );
  }
  assertUniqueNonBlankStrings(input.feedbackBatchIds, "refinement.feedbackBatchIds");
  if (input.feedbackEventIds !== undefined) {
    if (!Array.isArray(input.feedbackEventIds)) {
      throw new LocalizationJournalRepositoryError(
        "invalid_input",
        "refinement.feedbackEventIds must be an array when supplied",
      );
    }
    assertUniqueNonBlankStrings(input.feedbackEventIds, "refinement.feedbackEventIds");
  }
  if (input.wikiHeads !== undefined) {
    if (!Array.isArray(input.wikiHeads)) {
      throw new LocalizationJournalRepositoryError(
        "invalid_input",
        "refinement.wikiHeads must be an array when supplied",
      );
    }
    const artifactIds = new Set<string>();
    for (const [index, head] of input.wikiHeads.entries()) {
      assertNonBlank(head.contextArtifactId, `refinement.wikiHeads[${index}].contextArtifactId`);
      assertNonBlank(
        head.contextEntryVersionId,
        `refinement.wikiHeads[${index}].contextEntryVersionId`,
      );
      if (artifactIds.has(head.contextArtifactId)) {
        throw new LocalizationJournalRepositoryError(
          "invalid_input",
          `refinement.wikiHeads contains duplicate artifact ${head.contextArtifactId}`,
        );
      }
      artifactIds.add(head.contextArtifactId);
    }
  }
  if (input.redraftUnitIds !== undefined) {
    if (!Array.isArray(input.redraftUnitIds)) {
      throw new LocalizationJournalRepositoryError(
        "invalid_input",
        "refinement.redraftUnitIds must be an array when supplied",
      );
    }
    assertUniqueNonBlankStrings(input.redraftUnitIds, "refinement.redraftUnitIds");
  }
}

function normalizeLeaseSeconds(value: number | undefined, label: string): number {
  const leaseSeconds = value ?? LOCALIZATION_JOURNAL_RUN_LEASE_SECONDS;
  if (
    !Number.isFinite(leaseSeconds) ||
    !Number.isInteger(leaseSeconds) ||
    leaseSeconds < LOCALIZATION_JOURNAL_RUN_LEASE_SECONDS
  ) {
    throw new LocalizationJournalRepositoryError(
      "invalid_input",
      `${label} must be an integer of at least ${LOCALIZATION_JOURNAL_RUN_LEASE_SECONDS} seconds`,
    );
  }
  return leaseSeconds;
}

function normalizeSeedRunLease(
  input: SeedLocalizationJournalRunLeaseInput,
  label: string,
): Required<SeedLocalizationJournalRunLeaseInput> {
  assertNonBlank(input.ownerId, `${label}.ownerId`);
  return {
    ownerId: input.ownerId,
    leaseSeconds: normalizeLeaseSeconds(input.leaseSeconds, `${label}.leaseSeconds`),
  };
}

function normalizeRunLeaseIdentity(
  input: LocalizationJournalRunLeaseIdentity,
  label: string,
): Required<LocalizationJournalRunLeaseIdentity> {
  const lease = normalizeSeedRunLease(input, label);
  if (!Number.isInteger(input.fenceToken) || input.fenceToken <= 0) {
    throw new LocalizationJournalRepositoryError(
      "invalid_input",
      `${label}.fenceToken must be a positive integer`,
    );
  }
  return { ...lease, fenceToken: input.fenceToken };
}

function leaseExpiryFromDbNow(leaseSeconds: number) {
  // Lease admission and expiry validation share PostgreSQL's transaction
  // clock. Never derive this timestamp from the executor host's wall clock.
  return sql`now() + (${leaseSeconds} * interval '1 second')`;
}

function normalizeBeginAttempt(
  input: BeginLocalizationJournalAttemptInput,
): NormalizedBeginAttempt {
  assertNonBlank(input.attemptId, "attemptId");
  assertNonBlank(input.runId, "runId");
  assertNonBlank(input.bridgeUnitId, "bridgeUnitId");
  assertNonBlank(input.stage, "stage");
  assertNonBlank(input.agentLabel, "agentLabel");
  assertNonBlank(input.logicalCallId, "logicalCallId");
  assertNonNegativeInteger(input.attemptIndex, "attemptIndex");
  assertNonBlank(input.requestedModelId, "requestedModelId");
  assertNonBlank(input.requestedProviderId, "requestedProviderId");
  if (typeof input.zdr !== "boolean") {
    throw new LocalizationJournalRepositoryError("invalid_input", "zdr must be boolean");
  }
  if (input.artifactRef !== undefined && input.artifactRef !== null) {
    assertNonBlank(input.artifactRef, "artifactRef");
  }
  return {
    ...input,
    artifactRef: input.artifactRef ?? null,
    startedAt: toValidDate(input.startedAt, "startedAt"),
    lease: normalizeRunLeaseIdentity(input.lease, "lease"),
  };
}

function normalizeCompleteAttempt(
  input: CompleteLocalizationJournalAttemptInput,
): NormalizedCompleteAttempt {
  assertNonBlank(input.attemptId, "attemptId");
  assertNonBlank(input.runId, "runId");
  assertNonBlank(input.bridgeUnitId, "bridgeUnitId");
  if ((input.modelId === null) !== (input.providerId === null)) {
    throw new LocalizationJournalRepositoryError(
      "invalid_input",
      "modelId and providerId must either both be present or both be null",
    );
  }
  if (input.modelId !== null) assertNonBlank(input.modelId, "modelId");
  if (input.providerId !== null) assertNonBlank(input.providerId, "providerId");
  const costUsd =
    input.costUsd === null ? null : normalizeExactNonNegativeDecimal(input.costUsd, "costUsd");
  if (costUsd !== null) {
    if (input.modelId === null) {
      throw new LocalizationJournalRepositoryError(
        "invalid_input",
        "costUsd requires a real served model/provider pair",
      );
    }
    assertExactNonNegativeDecimal(costUsd, "costUsd");
  } else if (input.costKind !== undefined) {
    throw new LocalizationJournalRepositoryError(
      "invalid_input",
      "costKind cannot be supplied when costUsd is null",
    );
  }
  if (input.costKind !== undefined && !journalCostKindValues.includes(input.costKind)) {
    throw new LocalizationJournalRepositoryError(
      "invalid_input",
      `costKind=${input.costKind} is not supported`,
    );
  }
  if (
    input.billingState !== undefined &&
    input.billingState !== "known" &&
    input.billingState !== "unknown"
  ) {
    throw new LocalizationJournalRepositoryError(
      "invalid_input",
      `billingState=${String(input.billingState)} is not supported`,
    );
  }
  const billingState = input.billingState ?? (costUsd === null ? "unknown" : "known");
  if (billingState === "known" && costUsd === null) {
    throw new LocalizationJournalRepositoryError(
      "invalid_input",
      "known billingState requires an exact settled costUsd",
    );
  }
  if (input.usageResponseJson !== undefined) {
    assertJsonObject(input.usageResponseJson, "usageResponseJson");
  }
  assertNullableNonNegativeInteger(input.tokensIn, "tokensIn");
  assertNullableNonNegativeInteger(input.tokensOut, "tokensOut");
  if (input.tokenCountSource !== undefined)
    assertNonBlank(input.tokenCountSource, "tokenCountSource");
  if (input.cacheReadTokens !== undefined)
    assertNullableNonNegativeInteger(input.cacheReadTokens, "cacheReadTokens");
  if (input.cacheWriteTokens !== undefined)
    assertNullableNonNegativeInteger(input.cacheWriteTokens, "cacheWriteTokens");
  if (input.cacheDiscountMicrosUsd !== undefined)
    assertNullableNonNegativeInteger(input.cacheDiscountMicrosUsd, "cacheDiscountMicrosUsd");
  if (input.fallbackUsed !== undefined && typeof input.fallbackUsed !== "boolean") {
    throw new LocalizationJournalRepositoryError(
      "invalid_input",
      "fallbackUsed must be boolean when supplied",
    );
  }
  if (
    input.fallbackPlan !== undefined &&
    (!Array.isArray(input.fallbackPlan) || !input.fallbackPlan.every(isNonBlankString))
  ) {
    throw new LocalizationJournalRepositoryError(
      "invalid_input",
      "fallbackPlan must contain only non-blank strings when supplied",
    );
  }
  if (typeof input.zdr !== "boolean") {
    throw new LocalizationJournalRepositoryError("invalid_input", "zdr must be boolean");
  }
  if (!journalValidationResultValues.includes(input.validationResult)) {
    throw new LocalizationJournalRepositoryError(
      "invalid_input",
      `validationResult=${input.validationResult} is not supported`,
    );
  }
  if (input.retryDecision !== null && !journalRetryDecisionValues.includes(input.retryDecision)) {
    throw new LocalizationJournalRepositoryError(
      "invalid_input",
      `retryDecision=${input.retryDecision} is not supported`,
    );
  }
  assertNullableNonNegativeInteger(input.retryDelayMs, "retryDelayMs");
  if (!Array.isArray(input.errorClasses) || !input.errorClasses.every(isNonBlankString)) {
    throw new LocalizationJournalRepositoryError(
      "invalid_input",
      "errorClasses must contain only non-blank strings",
    );
  }
  if (input.artifactRef !== undefined && input.artifactRef !== null) {
    assertNonBlank(input.artifactRef, "artifactRef");
  }
  return {
    ...input,
    costUsd,
    costKind: input.costKind ?? null,
    billingState,
    usageResponseJson: input.usageResponseJson ?? null,
    tokenCountSource: input.tokenCountSource ?? null,
    cacheReadTokens: input.cacheReadTokens ?? null,
    cacheWriteTokens: input.cacheWriteTokens ?? null,
    cacheDiscountMicrosUsd: input.cacheDiscountMicrosUsd ?? null,
    fallbackUsed: input.fallbackUsed ?? null,
    fallbackPlan: input.fallbackPlan === undefined ? null : [...input.fallbackPlan],
    artifactRef: input.artifactRef,
    errorClasses: [...input.errorClasses],
    completedAt: toValidDate(input.completedAt, "completedAt"),
    lease: normalizeRunLeaseIdentity(input.lease, "lease"),
  };
}

function normalizeAttempts(
  runId: string,
  bridgeUnitId: string,
  attempts: readonly PersistLocalizationJournalAttemptInput[],
): NormalizedAttempt[] {
  const seenAttemptIds = new Set<string>();
  const seenLogicalAttempts = new Set<string>();
  return attempts.map((attempt, index) => {
    const label = `attempts[${index}]`;
    if (attempt.runId !== runId || attempt.bridgeUnitId !== bridgeUnitId) {
      throw new LocalizationJournalRepositoryError(
        "invalid_input",
        `${label} binds runId=${attempt.runId}/bridgeUnitId=${attempt.bridgeUnitId}; expected ${runId}/${bridgeUnitId}`,
      );
    }
    assertNonBlank(attempt.attemptId, `${label}.attemptId`);
    assertNonBlank(attempt.stage, `${label}.stage`);
    assertNonBlank(attempt.agentLabel, `${label}.agentLabel`);
    assertNonBlank(attempt.logicalCallId, `${label}.logicalCallId`);
    assertNonNegativeInteger(attempt.attemptIndex, `${label}.attemptIndex`);
    if (attempt.requestedModelId !== undefined) {
      assertNonBlank(attempt.requestedModelId, `${label}.requestedModelId`);
    }
    if (attempt.requestedProviderId !== undefined) {
      assertNonBlank(attempt.requestedProviderId, `${label}.requestedProviderId`);
    }
    assertNonBlank(attempt.modelId, `${label}.modelId`);
    assertNonBlank(attempt.providerId, `${label}.providerId`);
    assertNonBlank(attempt.providerRunId, `${label}.providerRunId`);
    if (attempt.attemptId !== attempt.providerRunId) {
      throw new LocalizationJournalRepositoryError(
        "invalid_input",
        `${label}.attemptId must equal providerRunId so candidate attempt FKs retain the physical provider-run identity`,
      );
    }
    assertExactNonNegativeDecimal(attempt.costUsd, `${label}.costUsd`);
    if (attempt.costKind !== undefined && !journalCostKindValues.includes(attempt.costKind)) {
      throw new LocalizationJournalRepositoryError(
        "invalid_input",
        `${label}.costKind=${attempt.costKind} is not supported`,
      );
    }
    if (attempt.usageResponseJson !== undefined) {
      assertJsonPersistable(attempt.usageResponseJson, `${label}.usageResponseJson`);
      if (
        attempt.usageResponseJson === null ||
        typeof attempt.usageResponseJson !== "object" ||
        Array.isArray(attempt.usageResponseJson)
      ) {
        throw new LocalizationJournalRepositoryError(
          "invalid_input",
          `${label}.usageResponseJson must be a JSON object when supplied`,
        );
      }
    }
    assertNullableNonNegativeInteger(attempt.tokensIn, `${label}.tokensIn`);
    assertNullableNonNegativeInteger(attempt.tokensOut, `${label}.tokensOut`);
    if (attempt.cacheReadTokens !== undefined) {
      assertNullableNonNegativeInteger(attempt.cacheReadTokens, `${label}.cacheReadTokens`);
    }
    if (attempt.cacheWriteTokens !== undefined) {
      assertNullableNonNegativeInteger(attempt.cacheWriteTokens, `${label}.cacheWriteTokens`);
    }
    if (attempt.cacheDiscountMicrosUsd !== undefined) {
      assertNullableNonNegativeInteger(
        attempt.cacheDiscountMicrosUsd,
        `${label}.cacheDiscountMicrosUsd`,
      );
    }
    if (attempt.fallbackUsed !== undefined && typeof attempt.fallbackUsed !== "boolean") {
      throw new LocalizationJournalRepositoryError(
        "invalid_input",
        `${label}.fallbackUsed must be boolean when supplied`,
      );
    }
    if (
      attempt.fallbackPlan !== undefined &&
      (!Array.isArray(attempt.fallbackPlan) || !attempt.fallbackPlan.every(isNonBlankString))
    ) {
      throw new LocalizationJournalRepositoryError(
        "invalid_input",
        `${label}.fallbackPlan must contain only non-blank strings when supplied`,
      );
    }
    assertNullableNonNegativeInteger(attempt.retryDelayMs, `${label}.retryDelayMs`);
    if (!journalValidationResultValues.includes(attempt.validationResult)) {
      throw new LocalizationJournalRepositoryError(
        "invalid_input",
        `${label}.validationResult=${attempt.validationResult} is not supported`,
      );
    }
    if (
      attempt.retryDecision !== null &&
      !journalRetryDecisionValues.includes(attempt.retryDecision)
    ) {
      throw new LocalizationJournalRepositoryError(
        "invalid_input",
        `${label}.retryDecision=${attempt.retryDecision} is not supported`,
      );
    }
    if (typeof attempt.zdr !== "boolean") {
      throw new LocalizationJournalRepositoryError("invalid_input", `${label}.zdr must be boolean`);
    }
    if (!Array.isArray(attempt.errorClasses) || !attempt.errorClasses.every(isNonBlankString)) {
      throw new LocalizationJournalRepositoryError(
        "invalid_input",
        `${label}.errorClasses must contain only non-blank strings`,
      );
    }
    if (seenAttemptIds.has(attempt.attemptId)) {
      throw new LocalizationJournalRepositoryError(
        "invalid_input",
        `${label}.attemptId=${attempt.attemptId} is duplicated in one write`,
      );
    }
    const logicalAttemptKey = `${attempt.logicalCallId}\u0000${attempt.attemptIndex}`;
    if (seenLogicalAttempts.has(logicalAttemptKey)) {
      throw new LocalizationJournalRepositoryError(
        "invalid_input",
        `${label} duplicates logicalCallId/attemptIndex=${attempt.logicalCallId}/${attempt.attemptIndex}`,
      );
    }
    const startedAt = toValidDate(attempt.startedAt, `${label}.startedAt`);
    const completedAt = toValidDate(attempt.completedAt, `${label}.completedAt`);
    if (completedAt.getTime() < startedAt.getTime()) {
      throw new LocalizationJournalRepositoryError(
        "invalid_input",
        `${label}.completedAt must not precede startedAt`,
      );
    }
    seenAttemptIds.add(attempt.attemptId);
    seenLogicalAttempts.add(logicalAttemptKey);
    return {
      ...attempt,
      requestedModelId: attempt.requestedModelId ?? null,
      requestedProviderId: attempt.requestedProviderId ?? null,
      costKind: attempt.costKind ?? null,
      usageResponseJson: attempt.usageResponseJson ?? null,
      tokenCountSource: attempt.tokenCountSource ?? null,
      cacheReadTokens: attempt.cacheReadTokens ?? null,
      cacheWriteTokens: attempt.cacheWriteTokens ?? null,
      cacheDiscountMicrosUsd: attempt.cacheDiscountMicrosUsd ?? null,
      fallbackUsed: attempt.fallbackUsed ?? null,
      fallbackPlan: attempt.fallbackPlan === undefined ? null : [...attempt.fallbackPlan],
      errorClasses: [...attempt.errorClasses],
      startedAt,
      completedAt,
    };
  });
}

const journalValidationResultValues = [
  "accepted",
  "schema_invalid",
  "semantic_invalid",
  "provider_failed",
  "not_evaluated",
] as const satisfies readonly LocalizationJournalAttemptValidationResult[];

const journalRetryDecisionValues = [
  "retry",
  "advance",
  "write",
  "pause",
] as const satisfies readonly LocalizationJournalAttemptRetryDecision[];

const journalCostKindValues = [
  "billed",
  "provider_estimate",
  "zero",
] as const satisfies readonly LocalizationJournalAttemptCostKind[];

function isJournalCostKind(value: unknown): value is LocalizationJournalAttemptCostKind {
  return typeof value === "string" && journalCostKindValues.includes(value as never);
}

function validateQaDetails(
  findings: readonly WrittenQaFinding[],
  qaDetails: LocalizationJournalQaDetailsByFindingId,
): Record<string, LocalizationJournalQaDetail> {
  const expected = new Set(findings.map((finding) => finding.id));
  const actual = Object.keys(qaDetails);
  for (const findingId of expected) {
    const detail = qaDetails[findingId];
    if (detail === undefined) {
      throw new LocalizationJournalRepositoryError(
        "invalid_input",
        `qaDetails is missing rationale/evidence for written finding ${findingId}`,
      );
    }
    assertNonBlank(detail.recommendation, `qaDetails.${findingId}.recommendation`);
    assertNonBlank(detail.agentRationale, `qaDetails.${findingId}.agentRationale`);
    if (!Array.isArray(detail.evidenceRefs) || !detail.evidenceRefs.every(isNonBlankString)) {
      throw new LocalizationJournalRepositoryError(
        "invalid_input",
        `qaDetails.${findingId}.evidenceRefs must contain only non-blank strings`,
      );
    }
    if (detail.sourceSpan !== undefined)
      validateQaSpan(detail.sourceSpan, `qaDetails.${findingId}.sourceSpan`);
    if (detail.draftSpan !== undefined)
      validateQaSpan(detail.draftSpan, `qaDetails.${findingId}.draftSpan`);
  }
  for (const findingId of actual) {
    if (!expected.has(findingId)) {
      throw new LocalizationJournalRepositoryError(
        "invalid_input",
        `qaDetails contains unknown finding ${findingId}`,
      );
    }
  }
  return Object.fromEntries(
    findings.map((finding) => {
      const detail = qaDetails[finding.id]!;
      return [
        finding.id,
        {
          recommendation: detail.recommendation,
          agentRationale: detail.agentRationale,
          evidenceRefs: [...detail.evidenceRefs],
          ...(detail.sourceSpan !== undefined ? { sourceSpan: { ...detail.sourceSpan } } : {}),
          ...(detail.draftSpan !== undefined ? { draftSpan: { ...detail.draftSpan } } : {}),
        },
      ];
    }),
  );
}

function normalizeContextRefs(
  refs: readonly LocalizationJournalOutcomeContextRefInput[],
): LocalizationJournalOutcomeContextRef[] {
  return refs.map((ref, index) => {
    const label = `contextRefs[${index}]`;
    assertNonBlank(ref.refKind, `${label}.refKind`);
    assertNonBlank(ref.refId, `${label}.refId`);
    if (ref.versionRef !== undefined) assertNonBlank(ref.versionRef, `${label}.versionRef`);
    if (ref.details !== undefined) assertJsonPersistable(ref.details, `${label}.details`);
    return {
      refKind: ref.refKind,
      refId: ref.refId,
      versionRef: ref.versionRef ?? null,
      details: ref.details ?? null,
    };
  });
}

function normalizeSpeakerLabels(
  bridgeUnitId: string,
  labels: readonly SpeakerLabel[],
): SpeakerLabel[] {
  return labels.map((label, index) => {
    const labelPath = `speakerLabels[${index}]`;
    if (label.bridgeUnitId !== bridgeUnitId) {
      throw new LocalizationJournalRepositoryError(
        "invalid_input",
        `${labelPath}.bridgeUnitId=${label.bridgeUnitId} must equal ${bridgeUnitId}`,
      );
    }
    if (!speakerConfidenceValues.includes(label.confidence)) {
      throw new LocalizationJournalRepositoryError(
        "invalid_input",
        `${labelPath}.confidence=${label.confidence} is not supported`,
      );
    }
    if (!Array.isArray(label.evidenceRefs) || !label.evidenceRefs.every(isNonBlankString)) {
      throw new LocalizationJournalRepositoryError(
        "invalid_input",
        `${labelPath}.evidenceRefs must contain only non-blank strings`,
      );
    }
    assertNonBlank(label.agentRationale, `${labelPath}.agentRationale`);
    assertJsonPersistable(label.speakerId, `${labelPath}.speakerId`);
    return {
      ...label,
      evidenceRefs: [...label.evidenceRefs],
    };
  });
}

const speakerConfidenceValues = ["high", "medium", "low", "unknown"] as const;

async function requireRunScopeInTx(
  tx: JournalTransaction,
  input: Pick<
    SeedLocalizationJournalRunInput,
    "projectId" | "localeBranchId" | "sourceRevisionId" | "targetLocale"
  >,
): Promise<void> {
  const [branchRows, revisionRows] = await Promise.all([
    tx
      .select({ projectId: localeBranches.projectId, targetLocale: localeBranches.targetLocale })
      .from(localeBranches)
      .where(eq(localeBranches.localeBranchId, input.localeBranchId))
      .limit(1),
    tx
      .select({ projectId: sourceRevisions.projectId })
      .from(sourceRevisions)
      .where(eq(sourceRevisions.sourceRevisionId, input.sourceRevisionId))
      .limit(1),
  ]);
  const branch = branchRows[0];
  const revision = revisionRows[0];
  if (branch === undefined || revision === undefined) {
    throw new LocalizationJournalRepositoryError(
      "run_scope_mismatch",
      `cannot seed localization journal run: branch=${input.localeBranchId} or sourceRevision=${input.sourceRevisionId} does not exist`,
    );
  }
  if (branch.projectId !== input.projectId || revision.projectId !== input.projectId) {
    throw new LocalizationJournalRepositoryError(
      "run_scope_mismatch",
      `journal run project ${input.projectId} does not own branch=${input.localeBranchId} and sourceRevision=${input.sourceRevisionId}`,
    );
  }
  if (branch.targetLocale !== input.targetLocale) {
    throw new LocalizationJournalRepositoryError(
      "run_scope_mismatch",
      `journal run targetLocale=${input.targetLocale} does not match locale branch ${input.localeBranchId} targetLocale=${branch.targetLocale}`,
    );
  }
}

function assertSeedRunIdentity(
  row: typeof localizationJournalRuns.$inferSelect,
  input: SeedLocalizationJournalRunInput,
): void {
  if (
    row.projectId !== input.projectId ||
    row.localeBranchId !== input.localeBranchId ||
    row.sourceRevisionId !== input.sourceRevisionId ||
    row.targetLocale !== input.targetLocale
  ) {
    throw new LocalizationJournalRepositoryError(
      "run_seed_conflict",
      `journal run ${row.runId} already exists with a different project/branch/revision/locale identity`,
    );
  }
}

function assertSeedRefinementIdentity(
  row: typeof localizationJournalRuns.$inferSelect,
  refinement: SeedLocalizationJournalRefinementInput | undefined,
): void {
  const expected = refinement?.basePatchVersionId ?? null;
  if ((row.basePatchVersionId ?? null) !== expected) {
    throw new LocalizationJournalRepositoryError(
      "run_seed_conflict",
      `journal run ${row.runId} already exists with a different refinement base patch`,
    );
  }
}

function assertSeededUnitSet(
  runId: string,
  rows: Array<typeof localizationJournalRunUnits.$inferSelect>,
  units: readonly SeedLocalizationJournalRunUnitInput[],
): void {
  if (rows.length !== units.length) {
    throw new LocalizationJournalRepositoryError(
      "run_seed_conflict",
      `journal run ${runId} has ${rows.length} planned units; seed requested ${units.length}`,
    );
  }
  for (const [unitOrdinal, unit] of units.entries()) {
    const row = rows[unitOrdinal];
    if (
      row === undefined ||
      row.unitOrdinal !== unitOrdinal ||
      row.bridgeUnitId !== unit.bridgeUnitId ||
      row.sourceUnitKey !== (unit.sourceUnitKey ?? null)
    ) {
      throw new LocalizationJournalRepositoryError(
        "run_seed_conflict",
        `journal run ${runId} planned-unit identity/order differs at ordinal ${unitOrdinal}`,
      );
    }
  }
}

/**
 * Persist the immutable iteration inputs in the same transaction that seeded
 * the run and its units. A retry sees the existing snapshot rather than
 * recomputing it against newer feedback or wiki heads.
 */
async function ensureRefinementRunMetadataInTx(
  tx: JournalTransaction,
  run: typeof localizationJournalRuns.$inferSelect,
  input: SeedLocalizationJournalRunInput,
): Promise<void> {
  const refinement = input.refinement;
  if (refinement === undefined) return;

  const existingMembers = await tx
    .select()
    .from(localizationRefinementRunMembers)
    .where(eq(localizationRefinementRunMembers.runId, run.runId));
  if (existingMembers.length > 0) {
    const [existingBatches, existingEvents] = await Promise.all([
      tx
        .select()
        .from(localizationRefinementRunFeedbackBatches)
        .where(eq(localizationRefinementRunFeedbackBatches.runId, run.runId))
        .orderBy(asc(localizationRefinementRunFeedbackBatches.batchOrdinal)),
      tx
        .select()
        .from(localizationRefinementRunFeedbackEvents)
        .where(eq(localizationRefinementRunFeedbackEvents.runId, run.runId)),
    ]);
    const existingBatchIds = new Set(existingBatches.map((row) => row.feedbackBatchId));
    const existingEventIds = new Set(existingEvents.map((row) => row.feedbackEventId));
    const missingRequestedBatch = refinement.feedbackBatchIds.find(
      (feedbackBatchId) => !existingBatchIds.has(feedbackBatchId),
    );
    const missingRequestedEvent = (refinement.feedbackEventIds ?? []).find(
      (feedbackEventId) => !existingEventIds.has(feedbackEventId),
    );
    if (
      existingMembers.length !== input.units.length ||
      missingRequestedBatch !== undefined ||
      missingRequestedEvent !== undefined
    ) {
      throw new LocalizationJournalRepositoryError(
        "run_seed_conflict",
        `refinement snapshot for run ${run.runId} differs from the requested frozen inputs`,
      );
    }
    return;
  }

  await tx.execute(sql`
    select patch_version_id
    from itotori_localization_patch_versions
    where patch_version_id = ${refinement.basePatchVersionId}
    for update
  `);
  const baseRows = await tx
    .select({
      patchVersionId: localizationPatchVersions.patchVersionId,
      status: localizationPatchVersions.status,
      projectId: localizationJournalRuns.projectId,
      localeBranchId: localizationJournalRuns.localeBranchId,
      sourceRevisionId: localizationJournalRuns.sourceRevisionId,
      targetLocale: localizationJournalRuns.targetLocale,
    })
    .from(localizationPatchVersions)
    .innerJoin(
      localizationJournalRuns,
      eq(localizationPatchVersions.runId, localizationJournalRuns.runId),
    )
    .where(eq(localizationPatchVersions.patchVersionId, refinement.basePatchVersionId))
    .limit(1);
  const base = baseRows[0];
  if (base === undefined || base.status !== "playable") {
    throw new LocalizationJournalRepositoryError(
      "invalid_input",
      `refinement base patch ${refinement.basePatchVersionId} must exist and be playable`,
    );
  }
  if (
    base.projectId !== run.projectId ||
    base.localeBranchId !== run.localeBranchId ||
    base.sourceRevisionId !== run.sourceRevisionId ||
    base.targetLocale !== run.targetLocale
  ) {
    throw new LocalizationJournalRepositoryError(
      "run_scope_mismatch",
      `refinement base patch ${refinement.basePatchVersionId} does not share run ${run.runId}'s project/branch/source/locale identity`,
    );
  }

  const unitIds = input.units.map((unit) => unit.bridgeUnitId);
  const baseMembers =
    unitIds.length === 0
      ? []
      : await tx
          .select()
          .from(localizationPatchVersionUnits)
          .where(
            and(
              eq(localizationPatchVersionUnits.patchVersionId, refinement.basePatchVersionId),
              inArray(localizationPatchVersionUnits.bridgeUnitId, unitIds),
            ),
          );
  const baseMemberByUnit = new Map(baseMembers.map((member) => [member.bridgeUnitId, member]));

  const explicitlySelectedBatchIds = [...refinement.feedbackBatchIds];
  const explicitlySelectedEventIds = [...(refinement.feedbackEventIds ?? [])];
  const individuallySelectedEvents =
    explicitlySelectedEventIds.length === 0
      ? []
      : await tx
          .select()
          .from(playTestFeedbackEvents)
          .where(inArray(playTestFeedbackEvents.feedbackEventId, explicitlySelectedEventIds));
  if (individuallySelectedEvents.length !== explicitlySelectedEventIds.length) {
    throw new LocalizationJournalRepositoryError(
      "invalid_input",
      `one or more individually selected feedback events do not exist for refinement run ${run.runId}`,
    );
  }
  const individualEventById = new Map(
    individuallySelectedEvents.map((event) => [event.feedbackEventId, event]),
  );
  const batchIds = [
    ...explicitlySelectedBatchIds,
    ...explicitlySelectedEventIds.map(
      (feedbackEventId) => individualEventById.get(feedbackEventId)!.feedbackBatchId,
    ),
  ].filter((feedbackBatchId, index, values) => values.indexOf(feedbackBatchId) === index);
  const batches =
    batchIds.length === 0
      ? []
      : await tx
          .select()
          .from(playTestFeedbackBatches)
          .where(inArray(playTestFeedbackBatches.feedbackBatchId, batchIds));
  if (batches.length !== batchIds.length) {
    throw new LocalizationJournalRepositoryError(
      "invalid_input",
      `one or more frozen feedback batches do not exist for refinement run ${run.runId}`,
    );
  }
  const batchById = new Map(batches.map((batch) => [batch.feedbackBatchId, batch]));
  for (const batchId of batchIds) {
    const batch = batchById.get(batchId)!;
    if (!(await isPatchAncestorOrSameInTx(tx, batch.observedPatchVersionId, base.patchVersionId))) {
      throw new LocalizationJournalRepositoryError(
        "invalid_input",
        `feedback batch ${batchId} observed patch ${batch.observedPatchVersionId}, which is not in base patch ${base.patchVersionId}'s lineage`,
      );
    }
  }
  const feedbackEvents =
    explicitlySelectedBatchIds.length === 0 && explicitlySelectedEventIds.length === 0
      ? []
      : await tx
          .select()
          .from(playTestFeedbackEvents)
          .where(
            or(
              ...(explicitlySelectedBatchIds.length === 0
                ? []
                : [inArray(playTestFeedbackEvents.feedbackBatchId, explicitlySelectedBatchIds)]),
              ...(explicitlySelectedEventIds.length === 0
                ? []
                : [inArray(playTestFeedbackEvents.feedbackEventId, explicitlySelectedEventIds)]),
            ),
          )
          .orderBy(
            asc(playTestFeedbackEvents.createdAt),
            asc(playTestFeedbackEvents.feedbackEventId),
          );
  // A result edit atomically creates a selected child patch. If that child is
  // already in the base patch's ancestry, the selected event remains in the
  // immutable run snapshot but is provenance, not fresh redraft input. This
  // prevents a later refinement from replaying an old target (or demanding a
  // redraft source) merely because the feedback is inherited in the inbox.
  const activeFeedbackEventIds: string[] = [];
  for (const event of feedbackEvents) {
    if (!(await isResultEditAlreadyAppliedInBaseInTx(tx, event, base.patchVersionId))) {
      activeFeedbackEventIds.push(event.feedbackEventId);
    }
  }
  const feedbackEventUnits =
    activeFeedbackEventIds.length === 0
      ? []
      : await tx
          .select()
          .from(playTestFeedbackEventUnits)
          .where(inArray(playTestFeedbackEventUnits.feedbackEventId, activeFeedbackEventIds));
  const feedbackAffectedUnitIds = new Set(
    feedbackEventUnits.map((eventUnit) => eventUnit.bridgeUnitId),
  );
  const requestedUnitIds = new Set(unitIds);
  const outsideScopeFeedback = [...feedbackAffectedUnitIds].find(
    (unitId) => !requestedUnitIds.has(unitId),
  );
  if (outsideScopeFeedback !== undefined) {
    throw new LocalizationJournalRepositoryError(
      "run_scope_mismatch",
      `feedback affects ${outsideScopeFeedback}, which is outside refinement run ${run.runId}'s frozen scope`,
    );
  }

  const requestedHeads = refinement.wikiHeads;
  const wikiHeads =
    requestedHeads === undefined
      ? await tx
          .select({
            contextArtifactId: contextArtifacts.contextArtifactId,
            contextEntryVersionId: contextArtifacts.headVersionId,
            affectedUnitIds: contextEntryVersions.affectedUnitIds,
          })
          .from(contextArtifacts)
          .innerJoin(
            contextEntryVersions,
            and(
              eq(contextArtifacts.headVersionId, contextEntryVersions.contextEntryVersionId),
              eq(contextArtifacts.contextArtifactId, contextEntryVersions.contextArtifactId),
            ),
          )
          .where(
            and(
              eq(contextArtifacts.projectId, run.projectId),
              eq(contextArtifacts.localeBranchId, run.localeBranchId),
            ),
          )
      : await loadRequestedRefinementWikiHeadsInTx(tx, run, requestedHeads);
  const wikiAffectedUnitIds = new Set(
    wikiHeads.flatMap((head) => (head.affectedUnitIds ?? []).filter(isNonBlankString)),
  );

  const explicitRedraftIds = new Set(refinement.redraftUnitIds ?? []);
  const outsideExplicit = [...explicitRedraftIds].find((unitId) => !requestedUnitIds.has(unitId));
  if (outsideExplicit !== undefined) {
    throw new LocalizationJournalRepositoryError(
      "run_scope_mismatch",
      `explicit redraft unit ${outsideExplicit} is outside refinement run ${run.runId}'s frozen scope`,
    );
  }
  const redraftUnitIds = new Set([
    ...explicitRedraftIds,
    ...feedbackAffectedUnitIds,
    ...[...wikiAffectedUnitIds].filter((unitId) => requestedUnitIds.has(unitId)),
  ]);

  const now = new Date();
  if (batchIds.length > 0) {
    await tx.insert(localizationRefinementRunFeedbackBatches).values(
      batchIds.map((feedbackBatchId, batchOrdinal) => ({
        runId: run.runId,
        feedbackBatchId,
        observedPatchVersionId: batchById.get(feedbackBatchId)!.observedPatchVersionId,
        batchOrdinal,
        createdAt: now,
      })),
    );
  }
  if (feedbackEvents.length > 0) {
    await tx.insert(localizationRefinementRunFeedbackEvents).values(
      feedbackEvents.map((event, eventOrdinal) => ({
        runId: run.runId,
        feedbackEventId: event.feedbackEventId,
        feedbackBatchId: event.feedbackBatchId,
        eventOrdinal,
        createdAt: now,
      })),
    );
  }
  if (wikiHeads.length > 0) {
    await tx.insert(localizationRefinementRunWikiHeads).values(
      wikiHeads.map((head) => ({
        runId: run.runId,
        contextArtifactId: head.contextArtifactId,
        contextEntryVersionId: head.contextEntryVersionId!,
        createdAt: now,
      })),
    );
  }
  if (input.units.length > 0) {
    await tx.insert(localizationRefinementRunMembers).values(
      input.units.map((unit) => {
        const baseMember = baseMemberByUnit.get(unit.bridgeUnitId);
        if (baseMember === undefined) {
          return {
            runId: run.runId,
            bridgeUnitId: unit.bridgeUnitId,
            strategy: "new_scope" as const,
            basePatchVersionId: null,
            baseSourceRunId: null,
            baseJournalOutcomeId: null,
            baseResultRevisionId: null,
            createdAt: now,
          };
        }
        return {
          runId: run.runId,
          bridgeUnitId: unit.bridgeUnitId,
          strategy: redraftUnitIds.has(unit.bridgeUnitId)
            ? ("redraft" as const)
            : ("reuse" as const),
          basePatchVersionId: refinement.basePatchVersionId,
          baseSourceRunId: baseMember.sourceRunId,
          baseJournalOutcomeId: baseMember.journalOutcomeId,
          baseResultRevisionId: baseMember.resultRevisionId,
          createdAt: now,
        };
      }),
    );
  }
}

async function loadRequestedRefinementWikiHeadsInTx(
  tx: JournalTransaction,
  run: typeof localizationJournalRuns.$inferSelect,
  requestedHeads: readonly SeedLocalizationJournalRefinementWikiHeadInput[],
): Promise<
  Array<{
    contextArtifactId: string;
    contextEntryVersionId: string;
    affectedUnitIds: string[];
  }>
> {
  if (requestedHeads.length === 0) return [];
  const artifactIds = requestedHeads.map((head) => head.contextArtifactId);
  const rows = await tx
    .select({
      contextArtifactId: contextArtifacts.contextArtifactId,
      contextEntryVersionId: contextEntryVersions.contextEntryVersionId,
      affectedUnitIds: contextEntryVersions.affectedUnitIds,
    })
    .from(contextArtifacts)
    .innerJoin(
      contextEntryVersions,
      and(
        eq(contextArtifacts.headVersionId, contextEntryVersions.contextEntryVersionId),
        eq(contextArtifacts.contextArtifactId, contextEntryVersions.contextArtifactId),
      ),
    )
    .where(
      and(
        eq(contextArtifacts.projectId, run.projectId),
        eq(contextArtifacts.localeBranchId, run.localeBranchId),
        inArray(contextArtifacts.contextArtifactId, artifactIds),
      ),
    );
  const rowByArtifactId = new Map(rows.map((row) => [row.contextArtifactId, row]));
  return requestedHeads.map((head) => {
    const row = rowByArtifactId.get(head.contextArtifactId);
    if (row === undefined || row.contextEntryVersionId !== head.contextEntryVersionId) {
      throw new LocalizationJournalRepositoryError(
        "invalid_input",
        `wiki head ${head.contextArtifactId}/${head.contextEntryVersionId} is not the current scoped head at refinement launch`,
      );
    }
    return row;
  });
}

async function isPatchAncestorOrSameInTx(
  tx: JournalTransaction,
  ancestorPatchVersionId: string,
  descendantPatchVersionId: string,
): Promise<boolean> {
  const result = await tx.execute(sql<{ reachable: boolean }>`
    with recursive lineage as (
      select patch_version_id, parent_patch_version_id
      from itotori_localization_patch_versions
      where patch_version_id = ${descendantPatchVersionId}
      union all
      select parent.patch_version_id, parent.parent_patch_version_id
      from itotori_localization_patch_versions parent
      join lineage child on child.parent_patch_version_id = parent.patch_version_id
    )
    select exists (
      select 1 from lineage where patch_version_id = ${ancestorPatchVersionId}
    ) as reachable
  `);
  return result.rows[0]?.reachable === true;
}

async function isResultEditAlreadyAppliedInBaseInTx(
  tx: JournalTransaction,
  event: typeof playTestFeedbackEvents.$inferSelect,
  basePatchVersionId: string,
): Promise<boolean> {
  if (event.eventKind !== "result_edit") return false;
  const childPatchVersionId = event.metadata.resultRevisionPatchVersionId;
  if (typeof childPatchVersionId !== "string" || childPatchVersionId.trim().length === 0) {
    // Older events without the atomic child binding remain actionable. The
    // service will still require a real target body before materializing.
    return false;
  }
  return isPatchAncestorOrSameInTx(tx, childPatchVersionId, basePatchVersionId);
}

async function requireSeededUnitInTx(
  tx: JournalTransaction,
  runId: string,
  bridgeUnitId: string,
): Promise<typeof localizationJournalRunUnits.$inferSelect> {
  const rows = await tx
    .select()
    .from(localizationJournalRunUnits)
    .where(
      and(
        eq(localizationJournalRunUnits.runId, runId),
        eq(localizationJournalRunUnits.bridgeUnitId, bridgeUnitId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new LocalizationJournalRepositoryError(
      "unit_not_seeded",
      `journal run ${runId} has no planned unit ${bridgeUnitId}`,
    );
  }
  return row;
}

async function loadRunUnitsInTx(
  tx: JournalTransaction,
  runId: string,
): Promise<Array<typeof localizationJournalRunUnits.$inferSelect>> {
  return tx
    .select()
    .from(localizationJournalRunUnits)
    .where(eq(localizationJournalRunUnits.runId, runId))
    .orderBy(asc(localizationJournalRunUnits.unitOrdinal));
}

/** Compatibility for node-2 callers; node-3 dispatch uses seedRun instead. */
async function ensureLegacyUnitInTx(
  tx: JournalTransaction,
  runId: string,
  bridgeUnitId: string,
  sourceUnitKey: string | null = null,
): Promise<typeof localizationJournalRunUnits.$inferSelect> {
  const run = await requireRunInTx(tx, runId);
  const existing = await tx
    .select()
    .from(localizationJournalRunUnits)
    .where(
      and(
        eq(localizationJournalRunUnits.runId, runId),
        eq(localizationJournalRunUnits.bridgeUnitId, bridgeUnitId),
      ),
    )
    .limit(1);
  if (existing[0] !== undefined) return existing[0];

  // Frozen runs are immutable obligation sets. Compatibility may synthesize a
  // unit only for a pre-supervisor createRun row whose frozen scope is null.
  if (run.frozenScope !== null) {
    throw new LocalizationJournalRepositoryError(
      "unit_not_seeded",
      `frozen journal run ${runId} has no planned unit ${bridgeUnitId}`,
    );
  }

  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${runId}))`);
  // seedRun takes the same lock before freezing a legacy run. Re-read after
  // waiting so a concurrent freeze cannot be bypassed with the stale pre-lock
  // row above.
  const afterLockRun = await requireRunInTx(tx, runId);
  const afterLock = await tx
    .select()
    .from(localizationJournalRunUnits)
    .where(
      and(
        eq(localizationJournalRunUnits.runId, runId),
        eq(localizationJournalRunUnits.bridgeUnitId, bridgeUnitId),
      ),
    )
    .limit(1);
  if (afterLock[0] !== undefined) return afterLock[0];
  if (afterLockRun.frozenScope !== null) {
    throw new LocalizationJournalRepositoryError(
      "unit_not_seeded",
      `frozen journal run ${runId} has no planned unit ${bridgeUnitId}`,
    );
  }

  const ordinalRows = await tx
    .select({
      nextOrdinal: sql<number>`coalesce(max(${localizationJournalRunUnits.unitOrdinal}), -1) + 1`,
    })
    .from(localizationJournalRunUnits)
    .where(eq(localizationJournalRunUnits.runId, runId));
  const now = new Date();
  const inserted = await tx
    .insert(localizationJournalRunUnits)
    .values({
      runId,
      bridgeUnitId,
      sourceUnitKey,
      unitOrdinal: ordinalRows[0]?.nextOrdinal ?? 0,
      state: "pending",
      nextAction: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return inserted[0]!;
}

async function requireRunInTx(
  tx: JournalTransaction,
  runId: string,
): Promise<typeof localizationJournalRuns.$inferSelect> {
  const rows = await tx
    .select()
    .from(localizationJournalRuns)
    .where(eq(localizationJournalRuns.runId, runId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new LocalizationJournalRepositoryError(
      "run_not_found",
      `journal run ${runId} does not exist`,
    );
  }
  return row;
}

async function renewRunLeaseInTx(
  tx: JournalTransaction,
  runId: string,
  lease: Required<LocalizationJournalRunLeaseIdentity>,
  allowedStatuses: readonly LocalizationJournalRunStatus[],
): Promise<typeof localizationJournalRuns.$inferSelect> {
  const rows = await tx
    .update(localizationJournalRuns)
    .set({
      leaseExpiresAt: leaseExpiryFromDbNow(lease.leaseSeconds),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(localizationJournalRuns.runId, runId),
        inArray(localizationJournalRuns.status, [...allowedStatuses]),
        eq(localizationJournalRuns.leaseOwnerId, lease.ownerId),
        eq(localizationJournalRuns.fenceToken, lease.fenceToken),
        sql`${localizationJournalRuns.leaseExpiresAt} > now()`,
      ),
    )
    .returning();
  if (rows[0] !== undefined) return rows[0];

  const current = await requireRunInTx(tx, runId);
  if (!allowedStatuses.includes(current.status as LocalizationJournalRunStatus)) {
    throw new LocalizationJournalRepositoryError(
      "invalid_run_transition",
      `journal run ${runId} is ${current.status}; expected ${allowedStatuses.join(" or ")}`,
    );
  }
  throw new LocalizationJournalRepositoryError(
    "run_lease_lost",
    `driver ${lease.ownerId} fence ${lease.fenceToken} has no live lease for journal run ${runId}`,
  );
}

async function loadRunLeaseDeadlineInTx(
  tx: JournalTransaction,
  runId: string,
): Promise<LocalizationJournalRunLeaseDeadline> {
  const rows = await tx
    .select({
      leaseExpiresAt: localizationJournalRuns.leaseExpiresAt,
      remainingMs: sql<number>`greatest(
        0,
        extract(epoch from (${localizationJournalRuns.leaseExpiresAt} - clock_timestamp())) * 1000
      )::double precision`,
    })
    .from(localizationJournalRuns)
    .where(eq(localizationJournalRuns.runId, runId))
    .limit(1);
  const deadline = rows[0];
  if (
    deadline?.leaseExpiresAt === null ||
    deadline?.leaseExpiresAt === undefined ||
    !Number.isFinite(deadline.remainingMs) ||
    deadline.remainingMs < 0
  ) {
    throw new LocalizationJournalRepositoryError(
      "run_lease_lost",
      `journal run ${runId} has no valid DB lease deadline`,
    );
  }
  return {
    leaseExpiresAt: deadline.leaseExpiresAt,
    remainingMs: deadline.remainingMs,
  };
}

async function runLeaseIsLiveInTx(
  tx: JournalTransaction,
  runId: string,
  lease: Required<LocalizationJournalRunLeaseIdentity>,
): Promise<boolean> {
  const rows = await tx
    .select({
      isLive: sql<boolean>`${localizationJournalRuns.leaseExpiresAt} > now()`,
    })
    .from(localizationJournalRuns)
    .where(
      and(
        eq(localizationJournalRuns.runId, runId),
        eq(localizationJournalRuns.leaseOwnerId, lease.ownerId),
        eq(localizationJournalRuns.fenceToken, lease.fenceToken),
      ),
    )
    .limit(1);
  return rows[0]?.isLive === true;
}

async function loadAttemptInTx(
  tx: JournalTransaction,
  attemptId: string,
): Promise<typeof localizationJournalLlmAttempts.$inferSelect | undefined> {
  const rows = await tx
    .select()
    .from(localizationJournalLlmAttempts)
    .where(eq(localizationJournalLlmAttempts.attemptId, attemptId))
    .limit(1);
  return rows[0];
}

function beginAttemptRowMatches(
  row: typeof localizationJournalLlmAttempts.$inferSelect,
  attempt: NormalizedBeginAttempt,
): boolean {
  return (
    row.runId === attempt.runId &&
    row.bridgeUnitId === attempt.bridgeUnitId &&
    row.stage === attempt.stage &&
    row.agentLabel === attempt.agentLabel &&
    row.logicalCallId === attempt.logicalCallId &&
    row.attemptIndex === attempt.attemptIndex &&
    row.fenceToken === attempt.lease.fenceToken &&
    row.requestedModelId === attempt.requestedModelId &&
    row.requestedProviderId === attempt.requestedProviderId &&
    row.providerRunId === attempt.attemptId &&
    row.zdr === attempt.zdr &&
    row.startedAt.getTime() === attempt.startedAt.getTime() &&
    (row.lifecycleState === "completed" || row.artifactRef === attempt.artifactRef)
  );
}

async function beginAttemptInTx(
  tx: JournalTransaction,
  attempt: NormalizedBeginAttempt,
  options: { renewLease?: boolean } = {},
): Promise<LocalizationJournalDispatchingAttemptRecord> {
  if (options.renewLease !== false) {
    await renewRunLeaseInTx(tx, attempt.runId, attempt.lease, ["running"]);
  }
  const existing = await loadAttemptInTx(tx, attempt.attemptId);
  if (existing !== undefined) {
    if (!beginAttemptRowMatches(existing, attempt)) {
      throw new LocalizationJournalRepositoryError(
        "attempt_conflict",
        `attempt ${attempt.attemptId} already exists with different pre-dispatch facts`,
      );
    }
    return {
      ...journalAttemptRowToRecord(existing),
      leaseDeadline: await loadRunLeaseDeadlineInTx(tx, attempt.runId),
    };
  }
  const claimed = await tx
    .update(localizationJournalRunUnits)
    .set({
      state: "claimed",
      claimOwnerId: attempt.lease.ownerId,
      claimFenceToken: attempt.lease.fenceToken,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(localizationJournalRunUnits.runId, attempt.runId),
        eq(localizationJournalRunUnits.bridgeUnitId, attempt.bridgeUnitId),
        eq(localizationJournalRunUnits.state, "pending"),
      ),
    )
    .returning({ bridgeUnitId: localizationJournalRunUnits.bridgeUnitId });
  if (claimed[0] === undefined) {
    const current = await requireSeededUnitInTx(tx, attempt.runId, attempt.bridgeUnitId);
    throw new LocalizationJournalRepositoryError(
      "unit_not_pending",
      `cannot dispatch attempt ${attempt.attemptId}: planned unit ${attempt.runId}/${attempt.bridgeUnitId} is ${current.state}`,
    );
  }
  await tx
    .insert(localizationJournalLlmAttempts)
    .values({
      attemptId: attempt.attemptId,
      runId: attempt.runId,
      bridgeUnitId: attempt.bridgeUnitId,
      stage: attempt.stage,
      agentLabel: attempt.agentLabel,
      logicalCallId: attempt.logicalCallId,
      attemptIndex: attempt.attemptIndex,
      lifecycleState: "dispatching",
      fenceToken: attempt.lease.fenceToken,
      requestedModelId: attempt.requestedModelId,
      requestedProviderId: attempt.requestedProviderId,
      modelId: null,
      providerId: null,
      providerRunId: attempt.attemptId,
      costUsd: null,
      costKind: null,
      billingState: null,
      usageResponseJson: null,
      tokensIn: null,
      tokensOut: null,
      tokenCountSource: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      cacheDiscountMicrosUsd: null,
      fallbackUsed: null,
      fallbackPlan: null,
      zdr: attempt.zdr,
      finishState: null,
      refusalState: null,
      validationResult: null,
      failureClass: null,
      retryDecision: null,
      retryDelayMs: null,
      artifactRef: attempt.artifactRef,
      errorClasses: [],
      startedAt: attempt.startedAt,
      completedAt: null,
      createdAt: new Date(),
    })
    .onConflictDoNothing();

  const persisted = await loadAttemptInTx(tx, attempt.attemptId);
  if (persisted === undefined || !beginAttemptRowMatches(persisted, attempt)) {
    throw new LocalizationJournalRepositoryError(
      "attempt_conflict",
      `attempt ${attempt.attemptId} already exists with different pre-dispatch facts or collides with another logical attempt`,
    );
  }
  return {
    ...journalAttemptRowToRecord(persisted),
    leaseDeadline: await loadRunLeaseDeadlineInTx(tx, attempt.runId),
  };
}

/**
 * The account-only admission primitive. Its single conditional UPDATE is the
 * concurrency boundary for cost reservations: PostgreSQL locks the account
 * row, reevaluates the cap predicate after that lock, and either returns the
 * newly reserved balance or no row. Keep lease/unit/attempt work out of this
 * helper so its atomicity can be exercised independently of run-row locks.
 */
export async function reserveRunCostAccountInTx(
  tx: JournalTransaction,
  runId: string,
  worstCaseCostUsd: string,
): Promise<typeof localizationJournalRunCostAccounts.$inferSelect | undefined> {
  const updated = await tx
    .update(localizationJournalRunCostAccounts)
    .set({
      reservedCostUsd: sql`${localizationJournalRunCostAccounts.reservedCostUsd} + ${worstCaseCostUsd}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(localizationJournalRunCostAccounts.runId, runId),
        sql`(
          ${localizationJournalRunCostAccounts.capUsd} is null
          or ${localizationJournalRunCostAccounts.spentCostUsd}
            + ${localizationJournalRunCostAccounts.reservedCostUsd}
            + ${worstCaseCostUsd}
            <= ${localizationJournalRunCostAccounts.capUsd}
        )`,
      ),
    )
    .returning();
  return updated[0];
}

async function requireRunCostAccountInTx(
  tx: JournalTransaction,
  runId: string,
): Promise<typeof localizationJournalRunCostAccounts.$inferSelect> {
  const rows = await tx
    .select()
    .from(localizationJournalRunCostAccounts)
    .where(eq(localizationJournalRunCostAccounts.runId, runId))
    .limit(1);
  const account = rows[0];
  if (account === undefined) {
    throw new LocalizationJournalRepositoryError(
      "invalid_input",
      `journal run ${runId} has no cost account; seed it before cost admission`,
    );
  }
  return account;
}

async function ensureRunCostAccountInTx(
  tx: JournalTransaction,
  runId: string,
  capUsd: string | null,
): Promise<typeof localizationJournalRunCostAccounts.$inferSelect> {
  await tx
    .insert(localizationJournalRunCostAccounts)
    .values({
      runId,
      capUsd,
      spentCostUsd: "0",
      reservedCostUsd: "0",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
  const existing = await requireRunCostAccountInTx(tx, runId);
  if (existing.capUsd === capUsd) return existing;
  if (
    existing.capUsd !== null &&
    capUsd !== null &&
    compareExactNonNegativeDecimals(capUsd, existing.capUsd) < 0
  ) {
    throw new LocalizationJournalRepositoryError(
      "run_seed_conflict",
      `journal run ${runId} cost cap cannot decrease from ${existing.capUsd} to ${capUsd}`,
    );
  }
  if (existing.capUsd !== null && capUsd === null) {
    throw new LocalizationJournalRepositoryError(
      "run_seed_conflict",
      `journal run ${runId} already has finite cost cap ${existing.capUsd} and cannot become unlimited`,
    );
  }
  const updated = await tx
    .update(localizationJournalRunCostAccounts)
    .set({ capUsd, updatedAt: new Date() })
    .where(
      and(
        eq(localizationJournalRunCostAccounts.runId, runId),
        sql`(
          ${localizationJournalRunCostAccounts.capUsd} is null
          or ${localizationJournalRunCostAccounts.capUsd} <= ${capUsd}
        )`,
        sql`${localizationJournalRunCostAccounts.spentCostUsd}
          + ${localizationJournalRunCostAccounts.reservedCostUsd}
          <= ${capUsd}`,
      ),
    )
    .returning();
  const account = updated[0];
  if (account === undefined) {
    throw new LocalizationJournalRepositoryError(
      "run_seed_conflict",
      `journal run ${runId} cost cap ${capUsd} cannot fall below committed spend and reservations`,
    );
  }
  return account;
}

async function requireCostReservationInTx(
  tx: JournalTransaction,
  runId: string,
  attemptId: string,
): Promise<typeof localizationJournalCostReservations.$inferSelect> {
  const rows = await tx
    .select()
    .from(localizationJournalCostReservations)
    .where(
      and(
        eq(localizationJournalCostReservations.runId, runId),
        eq(localizationJournalCostReservations.attemptId, attemptId),
      ),
    )
    .limit(1);
  const reservation = rows[0];
  if (reservation === undefined) {
    throw new LocalizationJournalRepositoryError(
      "attempt_conflict",
      `attempt ${attemptId} has no durable cost reservation`,
    );
  }
  return reservation;
}

async function reconcileAttemptReservationInTx(
  tx: JournalTransaction,
  completion: NormalizedCompleteAttempt,
): Promise<void> {
  if (completion.billingState !== "known") return;
  const settledCostUsd = completion.costUsd;
  if (settledCostUsd === null) {
    throw new LocalizationJournalRepositoryError(
      "invalid_input",
      `known billing for attempt ${completion.attemptId} lacks settled cost`,
    );
  }
  await reconcileKnownAttemptReservationInTx(tx, {
    runId: completion.runId,
    attemptId: completion.attemptId,
    settledCostUsd,
  });
}

/** Move one settled reservation into exact spent balance, idempotently. */
async function reconcileKnownAttemptReservationInTx(
  tx: JournalTransaction,
  input: { runId: string; attemptId: string; settledCostUsd: string },
): Promise<void> {
  // Cost admission locks the run before its account. Take the same lock order
  // on both immediate completion and late reconciliation, so an over-cap
  // settlement can pause the run without racing a concurrent reservation.
  await lockRunForCostAccountingInTx(tx, input.runId);
  const reservationRows = await tx
    .select()
    .from(localizationJournalCostReservations)
    .where(
      and(
        eq(localizationJournalCostReservations.runId, input.runId),
        eq(localizationJournalCostReservations.attemptId, input.attemptId),
      ),
    )
    .limit(1);
  const prior = reservationRows[0];
  // Legacy / deliberately unbudgeted attempts have no reservation.
  if (prior === undefined) return;
  if (prior.state === "released") {
    throw new LocalizationJournalRepositoryError(
      "attempt_conflict",
      `attempt ${input.attemptId} cost reservation was terminally released with unknown billing`,
    );
  }
  if (prior.state === "reconciled") {
    if (prior.reconciledUsd !== input.settledCostUsd) {
      throw new LocalizationJournalRepositoryError(
        "attempt_conflict",
        `attempt ${input.attemptId} cost reservation was reconciled with different facts`,
      );
    }
    await pauseRunForOverCapSettlementInTx(tx, input);
    return;
  }

  const transitioned = await tx
    .update(localizationJournalCostReservations)
    .set({
      state: "reconciled",
      reconciledUsd: input.settledCostUsd,
      reconciledAt: new Date(),
    })
    .where(
      and(
        eq(localizationJournalCostReservations.runId, input.runId),
        eq(localizationJournalCostReservations.attemptId, input.attemptId),
        eq(localizationJournalCostReservations.state, "reserved"),
      ),
    )
    .returning();
  const reservation = transitioned[0];
  if (reservation === undefined) {
    throw new LocalizationJournalRepositoryError(
      "attempt_conflict",
      `attempt ${input.attemptId} cost reservation changed while its bill reconciled`,
    );
  }
  const account = await tx
    .update(localizationJournalRunCostAccounts)
    .set({
      spentCostUsd: sql`${localizationJournalRunCostAccounts.spentCostUsd} + ${input.settledCostUsd}`,
      reservedCostUsd: sql`${localizationJournalRunCostAccounts.reservedCostUsd} - ${reservation.reservedUsd}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(localizationJournalRunCostAccounts.runId, input.runId),
        sql`${localizationJournalRunCostAccounts.reservedCostUsd} >= ${reservation.reservedUsd}`,
      ),
    )
    .returning();
  const updatedAccount = account[0];
  if (updatedAccount === undefined) {
    throw new LocalizationJournalRepositoryError(
      "attempt_conflict",
      `cost account for attempt ${input.attemptId} has no matching reserved balance`,
    );
  }
  await pauseRunForOverCapSettlementInTx(tx, input, updatedAccount);
}

/**
 * Release capacity held by attempts that this resume transaction just closed.
 * `released` is terminal and deliberately records no later provider bill.
 */
async function releaseInterruptedAttemptReservationsInTx(
  tx: JournalTransaction,
  runId: string,
  attemptIds: readonly string[],
  resumedAt: Date,
): Promise<void> {
  if (attemptIds.length === 0) return;
  const released = await tx
    .update(localizationJournalCostReservations)
    .set({ state: "released" })
    .where(
      and(
        eq(localizationJournalCostReservations.runId, runId),
        inArray(localizationJournalCostReservations.attemptId, attemptIds),
        eq(localizationJournalCostReservations.state, "reserved"),
      ),
    )
    .returning({ reservedUsd: localizationJournalCostReservations.reservedUsd });
  const releasedUsd = released.reduce(
    (total, reservation) =>
      addExactNonNegativeDecimals(
        total,
        normalizeExactNonNegativeDecimal(reservation.reservedUsd, "reservedUsd"),
      ),
    "0",
  );
  if (releasedUsd === "0") return;

  const account = await tx
    .update(localizationJournalRunCostAccounts)
    .set({
      reservedCostUsd: sql`${localizationJournalRunCostAccounts.reservedCostUsd} - ${releasedUsd}`,
      updatedAt: resumedAt,
    })
    .where(
      and(
        eq(localizationJournalRunCostAccounts.runId, runId),
        sql`${localizationJournalRunCostAccounts.reservedCostUsd} >= ${releasedUsd}`,
      ),
    )
    .returning();
  if (account[0] === undefined) {
    throw new LocalizationJournalRepositoryError(
      "attempt_conflict",
      `cost account for interrupted attempts in run ${runId} has insufficient reserved balance`,
    );
  }
}

/**
 * Reconciliation is allowed to record a provider bill above the pre-dispatch
 * reservation, because refusing the write would erase a real charge. The
 * account is still never allowed to continue silently over its run cap:
 * persist node 3's normal budget-cap operational state in the same
 * transaction as the settlement.
 */
async function pauseRunForOverCapSettlementInTx(
  tx: JournalTransaction,
  input: { runId: string; attemptId: string; settledCostUsd: string },
  updatedAccount?: typeof localizationJournalRunCostAccounts.$inferSelect,
): Promise<void> {
  const account = updatedAccount ?? (await requireRunCostAccountInTx(tx, input.runId));
  if (
    account.capUsd === null ||
    compareExactNonNegativeDecimals(
      addExactNonNegativeDecimals(account.spentCostUsd, account.reservedCostUsd),
      account.capUsd,
    ) <= 0
  ) {
    return;
  }

  const blocker: LocalizationJournalOperationalBlocker = {
    kind: "budget_cap",
    detail:
      `reconciled provider bill $${input.settledCostUsd} raised run spend ` +
      `plus reservations to $${addExactNonNegativeDecimals(
        account.spentCostUsd,
        account.reservedCostUsd,
      )}, above configured cap $${account.capUsd}`,
    evidence:
      `cost-account:${input.runId};attempt:${input.attemptId};` +
      `spent-usd:${account.spentCostUsd};reserved-usd:${account.reservedCostUsd};` +
      `cap-usd:${account.capUsd}`,
    raisedAt: new Date().toISOString(),
    operatorAction: "raise the run cost cap, then resume",
  };

  // Preserve an earlier operational blocker rather than overwriting its
  // evidence. A running run is the only state that could otherwise continue
  // dispatching after this paid overrun.
  await tx
    .update(localizationJournalRuns)
    .set({ status: "paused", pausedBlocker: blocker, updatedAt: new Date() })
    .where(
      and(
        eq(localizationJournalRuns.runId, input.runId),
        eq(localizationJournalRuns.status, "running"),
      ),
    );
}

async function lockRunForCostAccountingInTx(tx: JournalTransaction, runId: string): Promise<void> {
  await tx.execute(sql`
    select 1
    from ${localizationJournalRuns}
    where ${localizationJournalRuns.runId} = ${runId}
    for update
  `);
  await requireRunInTx(tx, runId);
}

async function completeAttemptInTx(
  tx: JournalTransaction,
  completion: NormalizedCompleteAttempt,
): Promise<typeof localizationJournalLlmAttempts.$inferSelect> {
  const current = await loadAttemptInTx(tx, completion.attemptId);
  if (current === undefined) {
    throw new LocalizationJournalRepositoryError(
      "candidate_attempt_missing",
      `cannot complete missing attempt ${completion.attemptId}`,
    );
  }
  if (current.runId !== completion.runId || current.bridgeUnitId !== completion.bridgeUnitId) {
    throw new LocalizationJournalRepositoryError(
      "attempt_conflict",
      `attempt ${completion.attemptId} is not bound to ${completion.runId}/${completion.bridgeUnitId}`,
    );
  }
  if (current.fenceToken !== completion.lease.fenceToken) {
    throw new LocalizationJournalRepositoryError(
      "run_lease_lost",
      `attempt ${completion.attemptId} belongs to fence ${current.fenceToken}, not ${completion.lease.fenceToken}`,
    );
  }
  if (current.zdr !== completion.zdr) {
    throw new LocalizationJournalRepositoryError(
      "attempt_conflict",
      `attempt ${completion.attemptId} completion changed the pre-dispatch ZDR posture`,
    );
  }
  if (completion.completedAt.getTime() < current.startedAt.getTime()) {
    throw new LocalizationJournalRepositoryError(
      "invalid_input",
      `attempt ${completion.attemptId}.completedAt must not precede startedAt`,
    );
  }
  if (current.lifecycleState === "completed") {
    if (!completeAttemptRowMatches(current, completion)) {
      throw new LocalizationJournalRepositoryError(
        "attempt_conflict",
        `attempt ${completion.attemptId} is already completed with different facts`,
      );
    }
    return current;
  }

  const updated = await tx
    .update(localizationJournalLlmAttempts)
    .set({
      lifecycleState: "completed",
      modelId: completion.modelId,
      providerId: completion.providerId,
      costUsd: completion.costUsd,
      costKind: completion.costKind,
      billingState: completion.billingState,
      usageResponseJson: completion.usageResponseJson,
      tokensIn: completion.tokensIn,
      tokensOut: completion.tokensOut,
      tokenCountSource: completion.tokenCountSource,
      cacheReadTokens: completion.cacheReadTokens,
      cacheWriteTokens: completion.cacheWriteTokens,
      cacheDiscountMicrosUsd: completion.cacheDiscountMicrosUsd,
      fallbackUsed: completion.fallbackUsed,
      fallbackPlan: completion.fallbackPlan,
      zdr: completion.zdr,
      finishState: completion.finishState,
      refusalState: completion.refusalState,
      validationResult: completion.validationResult,
      failureClass: completion.failureClass,
      retryDecision: completion.retryDecision,
      retryDelayMs: completion.retryDelayMs,
      artifactRef:
        completion.artifactRef === undefined ? current.artifactRef : completion.artifactRef,
      errorClasses: completion.errorClasses,
      completedAt: completion.completedAt,
    })
    .where(
      and(
        eq(localizationJournalLlmAttempts.attemptId, completion.attemptId),
        eq(localizationJournalLlmAttempts.lifecycleState, "dispatching"),
        eq(localizationJournalLlmAttempts.fenceToken, completion.lease.fenceToken),
      ),
    )
    .returning();
  const row = updated[0] ?? (await loadAttemptInTx(tx, completion.attemptId));
  if (row === undefined || !completeAttemptRowMatches(row, completion)) {
    throw new LocalizationJournalRepositoryError(
      "attempt_conflict",
      `attempt ${completion.attemptId} was completed concurrently with different facts`,
    );
  }
  return row;
}

function completeAttemptRowMatches(
  row: typeof localizationJournalLlmAttempts.$inferSelect,
  completion: NormalizedCompleteAttempt,
): boolean {
  return (
    row.lifecycleState === "completed" &&
    row.runId === completion.runId &&
    row.bridgeUnitId === completion.bridgeUnitId &&
    row.fenceToken === completion.lease.fenceToken &&
    row.modelId === completion.modelId &&
    row.providerId === completion.providerId &&
    row.costUsd === completion.costUsd &&
    row.costKind === completion.costKind &&
    row.billingState === completion.billingState &&
    jsonValuesEqual(row.usageResponseJson, completion.usageResponseJson) &&
    row.tokensIn === completion.tokensIn &&
    row.tokensOut === completion.tokensOut &&
    row.tokenCountSource === completion.tokenCountSource &&
    row.cacheReadTokens === completion.cacheReadTokens &&
    row.cacheWriteTokens === completion.cacheWriteTokens &&
    row.cacheDiscountMicrosUsd === completion.cacheDiscountMicrosUsd &&
    row.fallbackUsed === completion.fallbackUsed &&
    jsonValuesEqual(row.fallbackPlan, completion.fallbackPlan) &&
    row.zdr === completion.zdr &&
    row.finishState === completion.finishState &&
    row.refusalState === completion.refusalState &&
    row.validationResult === completion.validationResult &&
    row.failureClass === completion.failureClass &&
    row.retryDecision === completion.retryDecision &&
    row.retryDelayMs === completion.retryDelayMs &&
    (completion.artifactRef === undefined || row.artifactRef === completion.artifactRef) &&
    jsonValuesEqual(row.errorClasses, completion.errorClasses) &&
    row.completedAt?.getTime() === completion.completedAt.getTime()
  );
}

/**
 * Insert physical attempts exactly once. A retried transport write can replay
 * the same attempt batch safely; a same-id row with divergent facts is refused
 * rather than silently treated as idempotent.
 */
async function insertAttemptsIdempotently(
  tx: JournalTransaction,
  attempts: readonly NormalizedAttempt[],
): Promise<Array<typeof localizationJournalLlmAttempts.$inferSelect>> {
  if (attempts.length === 0) return [];
  const createdAt = new Date();
  await tx
    .insert(localizationJournalLlmAttempts)
    .values(
      attempts.map((attempt) => ({
        attemptId: attempt.attemptId,
        runId: attempt.runId,
        bridgeUnitId: attempt.bridgeUnitId,
        stage: attempt.stage,
        agentLabel: attempt.agentLabel,
        logicalCallId: attempt.logicalCallId,
        attemptIndex: attempt.attemptIndex,
        lifecycleState: "completed",
        fenceToken: 0,
        requestedModelId: attempt.requestedModelId,
        requestedProviderId: attempt.requestedProviderId,
        modelId: attempt.modelId,
        providerId: attempt.providerId,
        providerRunId: attempt.providerRunId,
        costUsd: attempt.costUsd,
        costKind: attempt.costKind,
        usageResponseJson: attempt.usageResponseJson,
        tokensIn: attempt.tokensIn,
        tokensOut: attempt.tokensOut,
        tokenCountSource: attempt.tokenCountSource,
        cacheReadTokens: attempt.cacheReadTokens,
        cacheWriteTokens: attempt.cacheWriteTokens,
        cacheDiscountMicrosUsd: attempt.cacheDiscountMicrosUsd,
        fallbackUsed: attempt.fallbackUsed,
        fallbackPlan: attempt.fallbackPlan,
        zdr: attempt.zdr,
        finishState: attempt.finishState,
        refusalState: attempt.refusalState,
        validationResult: attempt.validationResult,
        failureClass: attempt.failureClass,
        retryDecision: attempt.retryDecision,
        retryDelayMs: attempt.retryDelayMs,
        artifactRef: attempt.artifactRef,
        errorClasses: attempt.errorClasses,
        startedAt: attempt.startedAt,
        completedAt: attempt.completedAt,
        createdAt,
      })),
    )
    .onConflictDoNothing();

  const rows = await tx
    .select()
    .from(localizationJournalLlmAttempts)
    .where(
      inArray(
        localizationJournalLlmAttempts.attemptId,
        attempts.map((attempt) => attempt.attemptId),
      ),
    );
  const byAttemptId = new Map(rows.map((row) => [row.attemptId, row]));
  for (const attempt of attempts) {
    let persisted = byAttemptId.get(attempt.attemptId);
    if (persisted?.lifecycleState === "dispatching") {
      if (persisted.fenceToken > 0) {
        throw new LocalizationJournalRepositoryError(
          "run_lease_lost",
          `supervised attempt ${attempt.attemptId} must be completed through its fenced lifecycle`,
        );
      }
      if (!completedAttemptIdentityMatches(persisted, attempt)) {
        throw new LocalizationJournalRepositoryError(
          "attempt_conflict",
          `attempt ${attempt.attemptId} pre-dispatch identity differs from the completed attempt`,
        );
      }
      persisted = await completeAttemptInTx(tx, normalizedAttemptToCompletion(attempt));
      byAttemptId.set(attempt.attemptId, persisted);
    }
    if (persisted === undefined || !attemptRowsMatch(persisted, attempt)) {
      throw new LocalizationJournalRepositoryError(
        "attempt_conflict",
        `attempt ${attempt.attemptId} already exists with different facts or collides with another run/logical attempt`,
      );
    }
  }
  return attempts.map((attempt) => byAttemptId.get(attempt.attemptId)!);
}

function attemptRowsMatch(
  row: typeof localizationJournalLlmAttempts.$inferSelect,
  attempt: NormalizedAttempt,
): boolean {
  return (
    row.lifecycleState === "completed" &&
    row.runId === attempt.runId &&
    row.bridgeUnitId === attempt.bridgeUnitId &&
    row.stage === attempt.stage &&
    row.agentLabel === attempt.agentLabel &&
    row.logicalCallId === attempt.logicalCallId &&
    row.attemptIndex === attempt.attemptIndex &&
    row.fenceToken === 0 &&
    row.requestedModelId === attempt.requestedModelId &&
    row.requestedProviderId === attempt.requestedProviderId &&
    row.modelId === attempt.modelId &&
    row.providerId === attempt.providerId &&
    row.providerRunId === attempt.providerRunId &&
    row.costUsd === attempt.costUsd &&
    row.costKind === attempt.costKind &&
    jsonValuesEqual(row.usageResponseJson, attempt.usageResponseJson) &&
    row.tokensIn === attempt.tokensIn &&
    row.tokensOut === attempt.tokensOut &&
    row.tokenCountSource === attempt.tokenCountSource &&
    row.cacheReadTokens === attempt.cacheReadTokens &&
    row.cacheWriteTokens === attempt.cacheWriteTokens &&
    row.cacheDiscountMicrosUsd === attempt.cacheDiscountMicrosUsd &&
    row.fallbackUsed === attempt.fallbackUsed &&
    jsonValuesEqual(row.fallbackPlan, attempt.fallbackPlan) &&
    row.zdr === attempt.zdr &&
    row.finishState === attempt.finishState &&
    row.refusalState === attempt.refusalState &&
    row.validationResult === attempt.validationResult &&
    row.failureClass === attempt.failureClass &&
    row.retryDecision === attempt.retryDecision &&
    row.retryDelayMs === attempt.retryDelayMs &&
    row.artifactRef === attempt.artifactRef &&
    row.startedAt.getTime() === attempt.startedAt.getTime() &&
    row.completedAt?.getTime() === attempt.completedAt.getTime() &&
    jsonValuesEqual(row.errorClasses, attempt.errorClasses)
  );
}

function completedAttemptIdentityMatches(
  row: typeof localizationJournalLlmAttempts.$inferSelect,
  attempt: NormalizedAttempt,
): boolean {
  return (
    row.runId === attempt.runId &&
    row.bridgeUnitId === attempt.bridgeUnitId &&
    row.stage === attempt.stage &&
    row.agentLabel === attempt.agentLabel &&
    row.logicalCallId === attempt.logicalCallId &&
    row.attemptIndex === attempt.attemptIndex &&
    row.fenceToken === 0 &&
    row.requestedModelId === attempt.requestedModelId &&
    row.requestedProviderId === attempt.requestedProviderId &&
    row.providerRunId === attempt.providerRunId &&
    row.startedAt.getTime() === attempt.startedAt.getTime()
  );
}

function normalizedAttemptToCompletion(attempt: NormalizedAttempt): NormalizedCompleteAttempt {
  return {
    attemptId: attempt.attemptId,
    runId: attempt.runId,
    bridgeUnitId: attempt.bridgeUnitId,
    modelId: attempt.modelId,
    providerId: attempt.providerId,
    costUsd: attempt.costUsd,
    costKind: attempt.costKind,
    billingState: "known",
    usageResponseJson: attempt.usageResponseJson,
    tokensIn: attempt.tokensIn,
    tokensOut: attempt.tokensOut,
    tokenCountSource: attempt.tokenCountSource,
    cacheReadTokens: attempt.cacheReadTokens,
    cacheWriteTokens: attempt.cacheWriteTokens,
    cacheDiscountMicrosUsd: attempt.cacheDiscountMicrosUsd,
    fallbackUsed: attempt.fallbackUsed,
    fallbackPlan: attempt.fallbackPlan,
    zdr: attempt.zdr,
    finishState: attempt.finishState,
    refusalState: attempt.refusalState,
    validationResult: attempt.validationResult,
    failureClass: attempt.failureClass,
    retryDecision: attempt.retryDecision,
    retryDelayMs: attempt.retryDelayMs,
    artifactRef: attempt.artifactRef,
    errorClasses: attempt.errorClasses,
    completedAt: attempt.completedAt,
    lease: {
      ownerId: "legacy-unfenced-attempt",
      fenceToken: 0,
      leaseSeconds: LOCALIZATION_JOURNAL_RUN_LEASE_SECONDS,
    },
  };
}

function journalRunRowToRecord(
  row: typeof localizationJournalRuns.$inferSelect,
): LocalizationJournalRunRecord {
  return {
    runId: row.runId,
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    sourceRevisionId: row.sourceRevisionId,
    targetLocale: row.targetLocale,
    frozenScope: row.frozenScope,
    routingPolicy: row.routingPolicy,
    costPolicy: row.costPolicy,
    basePatchVersionId: row.basePatchVersionId ?? null,
    status: row.status as LocalizationJournalRunStatus,
    pausedBlocker: row.pausedBlocker,
    leaseOwnerId: row.leaseOwnerId,
    leaseExpiresAt: row.leaseExpiresAt,
    fenceToken: row.fenceToken,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function journalRunUnitRowToRecord(
  row: typeof localizationJournalRunUnits.$inferSelect,
): LocalizationJournalRunUnitRecord {
  return {
    runId: row.runId,
    bridgeUnitId: row.bridgeUnitId,
    sourceUnitKey: row.sourceUnitKey,
    unitOrdinal: row.unitOrdinal,
    state: row.state as LocalizationJournalRunUnitState,
    nextAction: row.nextAction,
    claimOwnerId: row.claimOwnerId,
    claimFenceToken: row.claimFenceToken,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function journalAttemptRowToRecord(
  row: typeof localizationJournalLlmAttempts.$inferSelect,
): LocalizationJournalAttemptRecord {
  return {
    attemptId: row.attemptId,
    runId: row.runId,
    bridgeUnitId: row.bridgeUnitId,
    stage: row.stage,
    agentLabel: row.agentLabel,
    logicalCallId: row.logicalCallId,
    attemptIndex: row.attemptIndex,
    lifecycleState: row.lifecycleState as LocalizationJournalAttemptLifecycleState,
    fenceToken: row.fenceToken,
    requestedModelId: row.requestedModelId,
    requestedProviderId: row.requestedProviderId,
    modelId: row.modelId,
    providerId: row.providerId,
    providerRunId: row.providerRunId,
    costUsd: row.costUsd === null ? null : normalizeExactNonNegativeDecimal(row.costUsd, "costUsd"),
    costKind: row.costKind as LocalizationJournalAttemptCostKind | null,
    billingState: row.billingState as LocalizationJournalAttemptBillingState | null,
    usageResponseJson: row.usageResponseJson,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    tokenCountSource: row.tokenCountSource,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    cacheDiscountMicrosUsd: row.cacheDiscountMicrosUsd,
    fallbackUsed: row.fallbackUsed,
    fallbackPlan: row.fallbackPlan === null ? null : [...row.fallbackPlan],
    zdr: row.zdr,
    finishState: row.finishState,
    refusalState: row.refusalState,
    validationResult: row.validationResult as LocalizationJournalAttemptValidationResult | null,
    retryDecision: row.retryDecision as LocalizationJournalAttemptRetryDecision | null,
    failureClass: row.failureClass,
    retryDelayMs: row.retryDelayMs,
    artifactRef: row.artifactRef,
    errorClasses: [...row.errorClasses],
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
  };
}

function journalCostAccountRowToRecord(
  row: typeof localizationJournalRunCostAccounts.$inferSelect,
): LocalizationJournalRunCostAccountRecord {
  return {
    runId: row.runId,
    capUsd: row.capUsd === null ? null : normalizeExactNonNegativeDecimal(row.capUsd, "capUsd"),
    spentCostUsd: normalizeExactNonNegativeDecimal(row.spentCostUsd, "spentCostUsd"),
    reservedCostUsd: normalizeExactNonNegativeDecimal(row.reservedCostUsd, "reservedCostUsd"),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function journalCostReservationRowToRecord(
  row: typeof localizationJournalCostReservations.$inferSelect,
): LocalizationJournalCostReservationRecord {
  return {
    reservationId: row.reservationId,
    runId: row.runId,
    attemptId: row.attemptId,
    reservedUsd: normalizeExactNonNegativeDecimal(row.reservedUsd, "reservedUsd"),
    reconciledUsd:
      row.reconciledUsd === null
        ? null
        : normalizeExactNonNegativeDecimal(row.reconciledUsd, "reconciledUsd"),
    state: row.state,
    createdAt: row.createdAt,
    reconciledAt: row.reconciledAt,
  };
}

function candidateRowToCanonical(
  row: typeof translationCandidates.$inferSelect,
  outcomeId: string,
): TranslationCandidate {
  return {
    id: row.candidateId,
    outcomeId,
    body: row.body as NonBlankTargetText,
    producedBy: { modelId: row.modelId, providerId: row.providerId },
    attemptId: row.attemptId,
    kind: row.kind as TranslationCandidate["kind"],
  };
}

function findingRowToCanonical(
  row: typeof writtenQaFindings.$inferSelect,
  outcomeId: string,
  candidateId: string | undefined,
): {
  finding: WrittenQaFinding;
  detail: LocalizationJournalQaDetail;
} {
  if (candidateId === undefined) {
    throw new LocalizationJournalRepositoryError(
      "invalid_input",
      `persisted finding ${row.findingId} refers to missing journal candidate ${row.journalCandidateId}`,
    );
  }
  return {
    finding: {
      id: row.findingId,
      outcomeId,
      candidateId,
      severity: row.severity as WrittenQaFinding["severity"],
      category: row.category,
      note: row.note,
      contested: row.contested,
      confidence: Number(row.confidence),
    },
    detail: {
      recommendation: row.recommendation,
      agentRationale: row.agentRationale,
      evidenceRefs: [...row.evidenceRefs],
      ...(row.sourceSpan !== null && row.sourceSpan !== undefined
        ? { sourceSpan: row.sourceSpan }
        : {}),
      ...(row.draftSpan !== null && row.draftSpan !== undefined
        ? { draftSpan: row.draftSpan }
        : {}),
    },
  };
}

function speakerLabelRowToCanonical(row: typeof outcomeSpeakerLabels.$inferSelect): SpeakerLabel {
  return {
    bridgeUnitId: row.bridgeUnitId,
    speakerId: row.speakerId as SpeakerLabel["speakerId"],
    confidence: row.confidence as SpeakerLabel["confidence"],
    evidenceRefs: [...row.evidenceRefs],
    agentRationale: row.agentRationale,
  };
}

function outcomeRecordFromInput(args: {
  journalOutcomeId: string;
  input: PersistLocalizationJournalUnitInput;
  contextRefs: LocalizationJournalOutcomeContextRef[];
  speakerLabels: SpeakerLabel[];
  qaDetails: Record<string, LocalizationJournalQaDetail>;
}): LocalizationJournalOutcomeRecord {
  return {
    journalOutcomeId: args.journalOutcomeId,
    runId: args.input.runId,
    bridgeUnitId: args.input.bridgeUnitId,
    sourceUnitKey: args.input.sourceUnitKey ?? null,
    outcome: args.input.outcome,
    candidates: [...args.input.outcome.candidates],
    findings: [...args.input.outcome.findings],
    contextPacket: args.input.contextPacket,
    contextRefs: args.contextRefs,
    speakerLabels: args.speakerLabels,
    qaDetails: args.qaDetails,
  };
}

function groupRows<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const groupKey = key(row);
    const bucket = grouped.get(groupKey) ?? [];
    bucket.push(row);
    grouped.set(groupKey, bucket);
  }
  return grouped;
}

function journalOutcomeIdFor(runId: string, outcomeId: string): string {
  return `localization-journal-outcome:${runId}:${outcomeId}`;
}

function journalCandidateIdFor(journalOutcomeId: string, candidateId: string): string {
  return `${journalOutcomeId}:candidate:${candidateId}`;
}

function journalFindingIdFor(journalOutcomeId: string, findingId: string): string {
  return `${journalOutcomeId}:finding:${findingId}`;
}

function validateQaSpan(span: LocalizationJournalQaSpan, label: string): void {
  assertNonNegativeInteger(span.start, `${label}.start`);
  assertNonNegativeInteger(span.end, `${label}.end`);
  if (span.end < span.start) {
    throw new LocalizationJournalRepositoryError(
      "invalid_input",
      `${label}.end must be greater than or equal to start`,
    );
  }
}

function assertExactNonNegativeDecimal(value: string, label: string): void {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value)) {
    throw new LocalizationJournalRepositoryError(
      "invalid_input",
      `${label} must be an exact non-negative decimal string without exponent notation`,
    );
  }
}

function normalizeExactNonNegativeDecimal(value: string, label: string): string {
  assertExactNonNegativeDecimal(value, label);
  const [whole, fraction = ""] = value.split(".");
  const trimmedFraction = fraction.replace(/0+$/u, "");
  return trimmedFraction.length === 0 ? whole! : `${whole}.${trimmedFraction}`;
}

function compareExactNonNegativeDecimals(left: string, right: string): -1 | 0 | 1 {
  const leftCanonical = normalizeExactNonNegativeDecimal(left, "left decimal");
  const rightCanonical = normalizeExactNonNegativeDecimal(right, "right decimal");
  const [leftWhole, leftFraction = ""] = leftCanonical.split(".");
  const [rightWhole, rightFraction = ""] = rightCanonical.split(".");
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const leftScaled = BigInt(leftWhole! + leftFraction.padEnd(scale, "0"));
  const rightScaled = BigInt(rightWhole! + rightFraction.padEnd(scale, "0"));
  if (leftScaled === rightScaled) return 0;
  return leftScaled < rightScaled ? -1 : 1;
}

function addExactNonNegativeDecimals(left: string, right: string): string {
  const leftCanonical = normalizeExactNonNegativeDecimal(left, "left decimal");
  const rightCanonical = normalizeExactNonNegativeDecimal(right, "right decimal");
  const [leftWhole, leftFraction = ""] = leftCanonical.split(".");
  const [rightWhole, rightFraction = ""] = rightCanonical.split(".");
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const sum =
    BigInt(leftWhole! + leftFraction.padEnd(scale, "0")) +
    BigInt(rightWhole! + rightFraction.padEnd(scale, "0"));
  if (scale === 0) return sum.toString();
  const digits = sum.toString().padStart(scale + 1, "0");
  return normalizeExactNonNegativeDecimal(
    `${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`,
    "decimal sum",
  );
}

function costCapUsdFromPolicy(policy: Record<string, unknown>): string | null {
  const raw = policy.budgetCapUsd;
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string")
    return normalizeExactNonNegativeDecimal(raw, "costPolicy.budgetCapUsd");
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return normalizeExactNonNegativeDecimal(
      decimalStringFromFiniteNumber(raw),
      "costPolicy.budgetCapUsd",
    );
  }
  throw new LocalizationJournalRepositoryError(
    "invalid_input",
    "costPolicy.budgetCapUsd must be a non-negative decimal string, number, null, or omitted",
  );
}

function costPolicyIsCapRaise(
  current: Record<string, unknown> | null,
  next: Record<string, unknown>,
): boolean {
  if (current === null) return false;
  const currentWithoutCap = { ...current };
  const nextWithoutCap = { ...next };
  delete currentWithoutCap.budgetCapUsd;
  delete nextWithoutCap.budgetCapUsd;
  if (!jsonValuesEqual(currentWithoutCap, nextWithoutCap)) return false;
  const before = costCapUsdFromPolicy(current);
  const after = costCapUsdFromPolicy(next);
  if (before === after) return true;
  if (after === null) return before === null;
  // An unlimited account still tracks durable spent/reserved history. An
  // operator may add a finite cap later, provided the account update proves
  // it covers all already-committed cost.
  if (before === null) return true;
  return compareExactNonNegativeDecimals(after, before) >= 0;
}

function decimalStringFromFiniteNumber(value: number): string {
  const raw = String(value);
  if (!/[eE]/u.test(raw)) return raw;
  const [coefficient, exponentRaw] = raw.toLowerCase().split("e");
  const exponent = Number(exponentRaw);
  const [whole = "0", fraction = ""] = coefficient!.split(".");
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/u, "") || "0";
  const decimalPoint = whole.length + exponent;
  if (decimalPoint <= 0) return `0.${"0".repeat(-decimalPoint)}${digits}`;
  if (decimalPoint >= digits.length) return `${digits}${"0".repeat(decimalPoint - digits.length)}`;
  return `${digits.slice(0, decimalPoint)}.${digits.slice(decimalPoint)}`;
}

function toValidDate(value: LocalizationJournalTimestamp, label: string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new LocalizationJournalRepositoryError(
      "invalid_input",
      `${label} must be a valid instant`,
    );
  }
  return date;
}

function assertNonBlank(value: string, label: string): void {
  if (!isNonBlankString(value)) {
    throw new LocalizationJournalRepositoryError(
      "invalid_input",
      `${label} must be a non-blank string`,
    );
  }
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertUniqueNonBlankStrings(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    assertNonBlank(value, `${label}[${index}]`);
    if (seen.has(value)) {
      throw new LocalizationJournalRepositoryError(
        "invalid_input",
        `${label} contains duplicate value ${value}`,
      );
    }
    seen.add(value);
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new LocalizationJournalRepositoryError(
      "invalid_input",
      `${label} must be a non-negative integer`,
    );
  }
}

function assertNullableNonNegativeInteger(value: number | null, label: string): void {
  if (value !== null) assertNonNegativeInteger(value, label);
}

function assertJsonObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  assertJsonPersistable(value, label);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LocalizationJournalRepositoryError("invalid_input", `${label} must be a JSON object`);
  }
}

function normalizeNextAction(
  value: LocalizationJournalUnitNextAction,
  label: string,
): LocalizationJournalUnitNextAction {
  assertJsonObject(value, label);
  assertNonBlank(value.kind, `${label}.kind`);
  return { ...value } as LocalizationJournalUnitNextAction;
}

function normalizeOperationalBlocker(
  blocker: LocalizationJournalOperationalBlocker,
): LocalizationJournalOperationalBlocker {
  const kinds = ["budget_cap", "provider_outage", "itotori_bug"] as const;
  if (!kinds.includes(blocker.kind)) {
    throw new LocalizationJournalRepositoryError(
      "invalid_input",
      `paused blocker kind=${String(blocker.kind)} is not supported`,
    );
  }
  assertNonBlank(blocker.detail, "blocker.detail");
  assertNonBlank(blocker.evidence, "blocker.evidence");
  assertNonBlank(blocker.operatorAction, "blocker.operatorAction");
  const raisedAt = toValidDate(blocker.raisedAt, "blocker.raisedAt").toISOString();
  return { ...blocker, raisedAt };
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalizeJson(left)) === JSON.stringify(canonicalizeJson(right));
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalizeJson(entry)]),
  );
}

function assertJsonPersistable(value: unknown, label: string): void {
  if (value === undefined) {
    throw new LocalizationJournalRepositoryError("invalid_input", `${label} cannot be undefined`);
  }
  try {
    if (JSON.stringify(value) === undefined) {
      throw new LocalizationJournalRepositoryError(
        "invalid_input",
        `${label} is not JSON-persistable`,
      );
    }
  } catch (error) {
    if (error instanceof LocalizationJournalRepositoryError) throw error;
    throw new LocalizationJournalRepositoryError(
      "invalid_input",
      `${label} is not JSON-persistable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
