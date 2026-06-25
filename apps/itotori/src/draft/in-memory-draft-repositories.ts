// ITOTORI-019 — In-memory port implementations for the draft fixture
// command.
//
// The fixture command is structurally bound to the same repository
// ports used by the live database-backed services, but its CI guarantee
// is that no DB connection is required. These in-memory implementations
// fulfil the ports for fixture mode and are also reused by the
// `draft-fixture-command.test.ts` suite.
//
// The implementations are intentionally minimal: they track the rows
// the command actually exercises (createDraftJob, recordAttempt,
// markAttemptSucceeded, markAttemptFailed, recordLedgerEntry,
// loadEntriesByAttempt, loadEntriesByProviderProof). Methods the fixture
// command does NOT use throw a typed error rather than silently no-op so
// drift between the live and fixture surfaces stays loud.

import { createHash } from "node:crypto";
import type {
  AuthorizationActor,
  DraftAttemptProviderLedgerEntry,
  DraftJobAttemptRecord,
  DraftJobAttemptStatus,
  DraftJobInput,
  DraftJobRecord,
  DraftJobStatus,
  ItotoriDraftAttemptProviderLedgerRepositoryPort,
  ItotoriDraftJobRepositoryPort,
  LedgerPairAggregateRow,
  LoadDraftJobsByProjectOptions,
  RecordDraftJobAttemptInput,
  RecordLedgerEntryInput,
  SumByPairAndDayOptions,
  SumCostByProjectOptions,
  SumCostByProjectResult,
  SumCostByProjectWindow,
} from "@itotori/db";

export class InMemoryDraftRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InMemoryDraftRepositoryError";
  }
}

const ATTEMPT_RUNNING: DraftJobAttemptStatus = "running";
const ATTEMPT_SUCCEEDED: DraftJobAttemptStatus = "succeeded";
const ATTEMPT_FAILED: DraftJobAttemptStatus = "failed";
const ATTEMPT_RETRYABLE: DraftJobAttemptStatus = "retryable";

const JOB_QUEUED: DraftJobStatus = "queued";
const JOB_RUNNING: DraftJobStatus = "running";
const JOB_SUCCEEDED: DraftJobStatus = "succeeded";
const JOB_FAILED: DraftJobStatus = "failed";
const JOB_RETRYABLE: DraftJobStatus = "retryable";

export class InMemoryDraftJobRepository implements ItotoriDraftJobRepositoryPort {
  public readonly jobs = new Map<string, DraftJobRecord>();
  public readonly attempts = new Map<string, DraftJobAttemptRecord>();
  private nextJob = 1;
  private nextAttempt = 1;

  async createDraftJob(_actor: AuthorizationActor, input: DraftJobInput): Promise<DraftJobRecord> {
    const draftJobId = `fixture-draft-job-${this.nextJob.toString().padStart(4, "0")}`;
    this.nextJob += 1;
    const now = new Date(Date.UTC(2026, 5, 24, 12, 0, 0));
    const record: DraftJobRecord = {
      draftJobId,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      bridgeUnitIds: [...input.sourceUnitIds],
      styleGuideVersion: input.styleGuideVersion,
      glossaryVersion: input.glossaryVersion,
      protectedSpanRefs: [...(input.protectedSpanRefs ?? [])],
      policyVersions: { ...input.policyVersions },
      contextRefs: [...(input.contextRefs ?? [])],
      status: JOB_QUEUED,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(draftJobId, record);
    return record;
  }

  async recordAttempt(
    _actor: AuthorizationActor,
    draftJobId: string,
    attemptInput: RecordDraftJobAttemptInput,
  ): Promise<DraftJobAttemptRecord> {
    const job = this.jobs.get(draftJobId);
    if (!job) {
      throw new InMemoryDraftRepositoryError(`unknown draft job ${draftJobId}`);
    }
    const draftJobAttemptId = `fixture-draft-attempt-${this.nextAttempt.toString().padStart(4, "0")}`;
    this.nextAttempt += 1;
    const attempt: DraftJobAttemptRecord = {
      draftJobAttemptId,
      draftJobId,
      attemptIndex: attemptInput.attemptIndex,
      providerRunId: attemptInput.providerRunId ?? null,
      startedAt: attemptInput.startedAt,
      endedAt: null,
      status: ATTEMPT_RUNNING,
      failureReason: null,
      recordedProviderArtifactId: null,
      createdAt: attemptInput.startedAt,
    };
    this.attempts.set(draftJobAttemptId, attempt);
    this.jobs.set(draftJobId, { ...job, status: JOB_RUNNING, updatedAt: attemptInput.startedAt });
    return attempt;
  }

  async markAttemptSucceeded(
    _actor: AuthorizationActor,
    draftJobAttemptId: string,
    endedAt: Date,
    providerRunId?: string,
    recordedProviderArtifactId?: string,
  ): Promise<void> {
    const attempt = this.attempts.get(draftJobAttemptId);
    if (!attempt) {
      throw new InMemoryDraftRepositoryError(`unknown attempt ${draftJobAttemptId}`);
    }
    this.attempts.set(draftJobAttemptId, {
      ...attempt,
      status: ATTEMPT_SUCCEEDED,
      endedAt,
      providerRunId: providerRunId ?? attempt.providerRunId,
      recordedProviderArtifactId: recordedProviderArtifactId ?? attempt.recordedProviderArtifactId,
    });
    const job = this.jobs.get(attempt.draftJobId);
    if (job) {
      this.jobs.set(attempt.draftJobId, {
        ...job,
        status: JOB_SUCCEEDED,
        failureReason: null,
        updatedAt: endedAt,
      });
    }
  }

  async markAttemptFailed(
    _actor: AuthorizationActor,
    draftJobAttemptId: string,
    failureReason: string,
    retryable: boolean,
    endedAt: Date,
  ): Promise<void> {
    const attempt = this.attempts.get(draftJobAttemptId);
    if (!attempt) {
      throw new InMemoryDraftRepositoryError(`unknown attempt ${draftJobAttemptId}`);
    }
    this.attempts.set(draftJobAttemptId, {
      ...attempt,
      status: retryable ? ATTEMPT_RETRYABLE : ATTEMPT_FAILED,
      failureReason,
      endedAt,
    });
    const job = this.jobs.get(attempt.draftJobId);
    if (job) {
      this.jobs.set(attempt.draftJobId, {
        ...job,
        status: retryable ? JOB_RETRYABLE : JOB_FAILED,
        failureReason,
        updatedAt: endedAt,
      });
    }
  }

  async cancelDraftJob(_actor: AuthorizationActor, _draftJobId: string): Promise<void> {
    throw new InMemoryDraftRepositoryError(
      "cancelDraftJob is not implemented in the in-memory fixture repository",
    );
  }

  async loadDraftJob(
    _actor: AuthorizationActor,
    draftJobId: string,
  ): Promise<DraftJobRecord | null> {
    return this.jobs.get(draftJobId) ?? null;
  }

  async loadDraftJobsByProject(
    _actor: AuthorizationActor,
    projectId: string,
    opts?: LoadDraftJobsByProjectOptions,
  ): Promise<DraftJobRecord[]> {
    const out: DraftJobRecord[] = [];
    for (const job of this.jobs.values()) {
      if (job.projectId !== projectId) continue;
      if (opts?.statusFilter !== undefined && job.status !== opts.statusFilter) continue;
      out.push(job);
    }
    if (opts?.limit !== undefined) {
      return out.slice(0, opts.limit);
    }
    return out;
  }

  async loadDraftJobAttempts(
    _actor: AuthorizationActor,
    draftJobId: string,
  ): Promise<DraftJobAttemptRecord[]> {
    const rows: DraftJobAttemptRecord[] = [];
    for (const attempt of this.attempts.values()) {
      if (attempt.draftJobId === draftJobId) {
        rows.push(attempt);
      }
    }
    rows.sort((a, b) => a.attemptIndex - b.attemptIndex);
    return rows;
  }
}

export class InMemoryDraftAttemptProviderLedgerRepository implements ItotoriDraftAttemptProviderLedgerRepositoryPort {
  public readonly entries: DraftAttemptProviderLedgerEntry[] = [];
  private nextEntry = 1;

  async recordLedgerEntry(
    _actor: AuthorizationActor,
    input: RecordLedgerEntryInput,
  ): Promise<DraftAttemptProviderLedgerEntry> {
    if (this.entries.some((e) => e.providerProofId === input.providerProofId)) {
      throw new InMemoryDraftRepositoryError(
        `duplicate provider_proof_id ${input.providerProofId} (in-memory ledger enforces uniqueness)`,
      );
    }
    const ledgerEntryId = `fixture-ledger-${this.nextEntry.toString().padStart(4, "0")}`;
    this.nextEntry += 1;
    const createdAt = new Date(Date.UTC(2026, 5, 24, 12, 0, 0));
    if (typeof input.providerId !== "string" || input.providerId.length === 0) {
      throw new InMemoryDraftRepositoryError(
        `providerId must be a non-empty string (ITOTORI-220 model+provider pair rule)`,
      );
    }
    const entry: DraftAttemptProviderLedgerEntry = {
      ledgerEntryId,
      draftJobAttemptId: input.draftJobAttemptId,
      providerProofId: input.providerProofId,
      modelProviderFamily: input.modelProviderFamily ?? null,
      modelId: input.modelId ?? null,
      providerId: input.providerId,
      modelContextWindowTokens: input.modelContextWindowTokens ?? null,
      modelMaxOutputTokens: input.modelMaxOutputTokens ?? null,
      promptTemplateVersion: input.promptTemplateVersion ?? null,
      promptHash: input.promptHash ?? null,
      policyVersions: input.policyVersions ?? {},
      contextArtifactRefs: [...(input.contextArtifactRefs ?? [])],
      tokensIn: input.tokensIn ?? null,
      tokensOut: input.tokensOut ?? null,
      costUnit: input.costUnit,
      costAmount: input.costAmount,
      latencyMs: input.latencyMs ?? null,
      fallbackChain: [...(input.fallbackChain ?? [])],
      isRecordedProvider: input.isRecordedProvider ?? false,
      recordedProviderBundleId: input.recordedProviderBundleId ?? null,
      createdAt,
    };
    this.entries.push(entry);
    return entry;
  }

  async loadEntriesByAttempt(
    _actor: AuthorizationActor,
    draftJobAttemptId: string,
  ): Promise<DraftAttemptProviderLedgerEntry[]> {
    return this.entries.filter((e) => e.draftJobAttemptId === draftJobAttemptId);
  }

  async loadEntriesByProviderProof(
    _actor: AuthorizationActor,
    providerProofId: string,
  ): Promise<DraftAttemptProviderLedgerEntry | null> {
    return this.entries.find((e) => e.providerProofId === providerProofId) ?? null;
  }

  async sumCostByProject(
    _actor: AuthorizationActor,
    _projectId: string,
    _window: SumCostByProjectWindow,
    opts?: SumCostByProjectOptions,
  ): Promise<SumCostByProjectResult> {
    const total = this.entries.reduce((acc, entry) => acc + Number(entry.costAmount), 0);
    const result: SumCostByProjectResult = { totalCost: total.toFixed(8) };
    if (opts?.byModel === true) {
      const byModel: Record<string, number> = {};
      for (const entry of this.entries) {
        const key = entry.modelId ?? "unknown";
        byModel[key] = (byModel[key] ?? 0) + Number(entry.costAmount);
      }
      result.byModel = Object.fromEntries(
        Object.entries(byModel).map(([k, v]) => [k, v.toFixed(8)]),
      );
    }
    // ITOTORI-220 — provider-level aggregation. Mirrors the DB-backed
    // repository so the in-memory fixture preserves typed parity.
    if (opts?.byProvider === true) {
      const byProvider: Record<string, number> = {};
      for (const entry of this.entries) {
        const key = entry.providerId;
        byProvider[key] = (byProvider[key] ?? 0) + Number(entry.costAmount);
      }
      result.byProvider = Object.fromEntries(
        Object.entries(byProvider).map(([k, v]) => [k, v.toFixed(8)]),
      );
    }
    return result;
  }

  // ITOTORI-223 — per-(modelId, providerId) aggregate. Mirrors the
  // DB-backed repository so in-memory fixtures preserve typed parity.
  // Latency p95 uses linear interpolation to match Postgres's
  // `percentile_cont(0.95)` semantics.
  async sumByPairAndDay(
    _actor: AuthorizationActor,
    _projectId: string,
    window: SumCostByProjectWindow,
    opts?: SumByPairAndDayOptions,
  ): Promise<LedgerPairAggregateRow[]> {
    const groupByDay = opts?.groupByDay === true;
    const filtered = this.entries.filter(
      (entry) =>
        entry.createdAt.getTime() >= window.from.getTime() &&
        entry.createdAt.getTime() <= window.to.getTime(),
    );

    type Bucket = {
      modelId: string | null;
      providerId: string;
      day: string | null;
      costSum: number;
      tokensInSum: number;
      tokensOutSum: number;
      count: number;
      latencies: number[];
    };
    const buckets = new Map<string, Bucket>();
    for (const entry of filtered) {
      const day = groupByDay ? entry.createdAt.toISOString().slice(0, 10) : null;
      const key = `${entry.modelId ?? "__null__"}|${entry.providerId}|${day ?? "__all__"}`;
      const existing = buckets.get(key);
      if (existing === undefined) {
        buckets.set(key, {
          modelId: entry.modelId,
          providerId: entry.providerId,
          day,
          costSum: Number(entry.costAmount),
          tokensInSum: entry.tokensIn ?? 0,
          tokensOutSum: entry.tokensOut ?? 0,
          count: 1,
          latencies: entry.latencyMs === null ? [] : [entry.latencyMs],
        });
      } else {
        existing.costSum += Number(entry.costAmount);
        existing.tokensInSum += entry.tokensIn ?? 0;
        existing.tokensOutSum += entry.tokensOut ?? 0;
        existing.count += 1;
        if (entry.latencyMs !== null) {
          existing.latencies.push(entry.latencyMs);
        }
      }
    }

    const rows: LedgerPairAggregateRow[] = [];
    for (const bucket of buckets.values()) {
      const sortedLatencies = [...bucket.latencies].sort((a, b) => a - b);
      const avgLatencyMs =
        sortedLatencies.length === 0
          ? null
          : sortedLatencies.reduce((acc, v) => acc + v, 0) / sortedLatencies.length;
      const p95LatencyMs =
        sortedLatencies.length === 0 ? null : computeP95LinearInterp(sortedLatencies);
      rows.push({
        modelId: bucket.modelId,
        providerId: bucket.providerId,
        bucketDay: bucket.day,
        totalCostUsd: bucket.costSum.toFixed(8),
        totalTokensIn: bucket.tokensInSum,
        totalTokensOut: bucket.tokensOutSum,
        invocationCount: bucket.count,
        avgLatencyMs,
        p95LatencyMs,
      });
    }
    rows.sort((a, b) => {
      const am = a.modelId ?? "";
      const bm = b.modelId ?? "";
      if (am !== bm) return am.localeCompare(bm);
      if (a.providerId !== b.providerId) return a.providerId.localeCompare(b.providerId);
      const ad = a.bucketDay ?? "";
      const bd = b.bucketDay ?? "";
      return ad.localeCompare(bd);
    });
    return rows;
  }
}

function computeP95LinearInterp(sorted: ReadonlyArray<number>): number {
  if (sorted.length === 1) {
    return sorted[0]!;
  }
  const rank = 0.95 * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) {
    return sorted[lower]!;
  }
  const frac = rank - lower;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * frac;
}

export type DraftFixtureRepositories = {
  draftJobRepository: InMemoryDraftJobRepository;
  ledgerRepository: InMemoryDraftAttemptProviderLedgerRepository;
};

export function createInMemoryDraftFixtureRepositories(): DraftFixtureRepositories {
  return {
    draftJobRepository: new InMemoryDraftJobRepository(),
    ledgerRepository: new InMemoryDraftAttemptProviderLedgerRepository(),
  };
}

/**
 * Deterministic content-hash helper for fixture construction. Useful
 * for tests asserting deterministic-context-artifact shape.
 */
export function fixtureContentHash(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}
