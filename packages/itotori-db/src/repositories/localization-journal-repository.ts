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
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import {
  localeBranches,
  localizationJournalLlmAttempts,
  localizationJournalRuns,
  outcomeContextRefs,
  outcomeSpeakerLabels,
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
  createdAt: Date;
};

export type LocalizationJournalAttemptRecord = {
  attemptId: string;
  runId: string;
  bridgeUnitId: string;
  stage: string;
  agentLabel: string;
  logicalCallId: string;
  attemptIndex: number;
  requestedModelId: string | null;
  requestedProviderId: string | null;
  modelId: string;
  providerId: string;
  providerRunId: string;
  /** Exact decimal text from unconstrained PostgreSQL numeric. */
  costUsd: string;
  costKind: LocalizationJournalAttemptCostKind | null;
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
  validationResult: LocalizationJournalAttemptValidationResult;
  failureClass: string | null;
  retryDecision: LocalizationJournalAttemptRetryDecision | null;
  retryDelayMs: number | null;
  artifactRef: string | null;
  errorClasses: string[];
  startedAt: Date;
  completedAt: Date;
  createdAt: Date;
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
  /** Atomically persists attempts, canonical outcome, and all provenance children. */
  persistUnit(
    actor: AuthorizationActor,
    input: PersistLocalizationJournalUnitInput,
  ): Promise<LocalizationJournalOutcomeRecord>;
  loadRun(actor: AuthorizationActor, runId: string): Promise<LocalizationJournalRunRecord | null>;
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
      | "outcome_already_persisted",
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

/**
 * DB repository for the lossless attempt/outcome journal.
 *
 * Write authority is `draft.write`; read authority is `catalog.read`. This is
 * deliberately a new seam and never calls a legacy draft/pass repository.
 */
export class ItotoriLocalizationJournalRepository implements ItotoriLocalizationJournalRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

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
        createdAt,
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

  async persistAttempts(
    actor: AuthorizationActor,
    input: PersistLocalizationJournalAttemptsInput,
  ): Promise<LocalizationJournalAttemptRecord[]> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    assertNonBlank(input.runId, "runId");
    assertNonBlank(input.bridgeUnitId, "bridgeUnitId");
    const attempts = normalizeAttempts(input.runId, input.bridgeUnitId, input.attempts);

    return this.db.transaction(async (tx) => {
      await requireRunInTx(tx, input.runId);
      if (attempts.length === 0) return [];
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
    const attemptIds = new Set(attempts.map((attempt) => attempt.attemptId));
    for (const candidate of input.outcome.candidates) {
      if (!attemptIds.has(candidate.attemptId)) {
        throw new LocalizationJournalRepositoryError(
          "candidate_attempt_missing",
          `candidate ${candidate.id} points to attemptId=${candidate.attemptId}, which was not supplied in this unit's physical attempts`,
        );
      }
    }

    const journalOutcomeId = journalOutcomeIdFor(input.runId, input.outcome.id);
    const journalCandidateIds = new Map<string, string>();
    for (const candidate of input.outcome.candidates) {
      journalCandidateIds.set(candidate.id, journalCandidateIdFor(journalOutcomeId, candidate.id));
    }

    await this.db.transaction(async (tx) => {
      const run = await requireRunInTx(tx, input.runId);
      if (run.targetLocale !== input.outcome.targetLocale) {
        throw new LocalizationJournalRepositoryError(
          "run_scope_mismatch",
          `outcome targetLocale=${input.outcome.targetLocale} does not match run=${input.runId} targetLocale=${run.targetLocale}`,
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
      .where(projectCondition);
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
        costUsd: sql<string>`${localizationJournalLlmAttempts.costUsd}::text`,
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
      .where(projectCondition)
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
      rows: rows.map((row) => ({
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
          // No false/[] default: null means this historical physical call
          // predates the journal fallback capture columns.
          used: row.fallbackUsed,
          plan: row.fallbackPlan === null ? null : [...row.fallbackPlan],
          chain: [],
        },
        createdAt: row.completedAt.toISOString(),
      })),
    };
  }
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
    const persisted = byAttemptId.get(attempt.attemptId);
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
    row.runId === attempt.runId &&
    row.bridgeUnitId === attempt.bridgeUnitId &&
    row.stage === attempt.stage &&
    row.agentLabel === attempt.agentLabel &&
    row.logicalCallId === attempt.logicalCallId &&
    row.attemptIndex === attempt.attemptIndex &&
    row.requestedModelId === attempt.requestedModelId &&
    row.requestedProviderId === attempt.requestedProviderId &&
    row.modelId === attempt.modelId &&
    row.providerId === attempt.providerId &&
    row.providerRunId === attempt.providerRunId &&
    row.costUsd === attempt.costUsd &&
    row.costKind === attempt.costKind &&
    JSON.stringify(row.usageResponseJson) === JSON.stringify(attempt.usageResponseJson) &&
    row.tokensIn === attempt.tokensIn &&
    row.tokensOut === attempt.tokensOut &&
    row.tokenCountSource === attempt.tokenCountSource &&
    row.cacheReadTokens === attempt.cacheReadTokens &&
    row.cacheWriteTokens === attempt.cacheWriteTokens &&
    row.cacheDiscountMicrosUsd === attempt.cacheDiscountMicrosUsd &&
    row.fallbackUsed === attempt.fallbackUsed &&
    JSON.stringify(row.fallbackPlan) === JSON.stringify(attempt.fallbackPlan) &&
    row.zdr === attempt.zdr &&
    row.finishState === attempt.finishState &&
    row.refusalState === attempt.refusalState &&
    row.validationResult === attempt.validationResult &&
    row.failureClass === attempt.failureClass &&
    row.retryDecision === attempt.retryDecision &&
    row.retryDelayMs === attempt.retryDelayMs &&
    row.artifactRef === attempt.artifactRef &&
    row.startedAt.getTime() === attempt.startedAt.getTime() &&
    row.completedAt.getTime() === attempt.completedAt.getTime() &&
    JSON.stringify(row.errorClasses) === JSON.stringify(attempt.errorClasses)
  );
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
    createdAt: row.createdAt,
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
    requestedModelId: row.requestedModelId,
    requestedProviderId: row.requestedProviderId,
    modelId: row.modelId,
    providerId: row.providerId,
    providerRunId: row.providerRunId,
    costUsd: row.costUsd,
    costKind: row.costKind as LocalizationJournalAttemptCostKind | null,
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
    validationResult: row.validationResult as LocalizationJournalAttemptValidationResult,
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
