// itotori-project-level-driven-executor — concrete journal + patch adapters.
//
// The durable path has exactly two boundaries:
//
//   - unit journal -> itotori_localization_journal_* tables. Every physical
//                     provider call lands as a row; then the canonical outcome
//                     and its normalized provenance land atomically.
//   - patch export -> translated-bridge.json + patch-report.json.
//
// Draft-job and aggregate provider-ledger rows are deliberately absent from
// this adapter. They cannot represent a lossless execution journal.

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  LOCALIZATION_JOURNAL_RUN_LEASE_SECONDS,
  type AuthorizationActor,
  type ItotoriLocalizationJournalRepositoryPort,
  type LocalizationJournalRunLeaseDeadline,
} from "@itotori/db";
import type {
  DrivenJournalResumeState,
  DrivenJournalCostPolicy,
  DrivenJournalRunPlan,
  DrivenUnitJournalRecord,
  DrivenUnitJournalSink,
  DrivenPatchExportRecord,
  DrivenPatchExportSink,
} from "./project-driven-executor.js";
import type { DrivenLlmAttemptRecord } from "./attempt-outcome-journal.js";
import {
  INVOCATION_DEFAULT_DEADLINE_MS,
  InvocationOperationalPauseError,
  type InvocationAttemptCompleted,
  type InvocationAttemptStarted,
  type InvocationCostAdmission,
  type OperationalBlocker,
} from "./invocation-supervisor.js";

export type DrivenJournalPersistenceOptions = {
  actor: AuthorizationActor;
  /** Stable only for this live executor instance; a resumer must use a new owner. */
  driverId?: string;
  /** Defaults to the repository's 120-second lease (4x the provider deadline). */
  leaseSeconds?: number;
  /** Test/operations override; defaults to one third of the configured lease. */
  leaseHeartbeatIntervalMs?: number;
  /** Maximum duration of one renewal query; defaults to the heartbeat interval. */
  leaseHeartbeatTimeoutMs?: number;
};

type ActiveRunLease = {
  ownerId: string;
  fenceToken: number;
  leaseSeconds?: number;
};

type RunLeaseHeartbeat = {
  attemptAbortControllers: Map<string, AbortController>;
  timer: ReturnType<typeof setInterval>;
  leaseDeadlineTimer: ReturnType<typeof setTimeout> | null;
  renewalInFlight: Promise<void> | null;
  renewalFailure: unknown | null;
};

class JournalRunLeaseDeadlineError extends Error {
  constructor(runId: string, deadline: LocalizationJournalRunLeaseDeadline) {
    super(
      `journal run ${runId} reached DB lease deadline ${deadline.leaseExpiresAt.toISOString()} before renewal`,
    );
    this.name = "JournalRunLeaseDeadlineError";
  }
}

/**
 * Binds the executor's journal sink to its real repository. The executor gives
 * us a stable run identity but deliberately knows nothing about database setup;
 * establish the run before dispatch, and defensively ensure it again for every
 * unit/failure write. The promise map keeps this safe if a future executor
 * chooses concurrent persistence.
 */
export class DrivenJournalPersistenceAdapter implements DrivenUnitJournalSink {
  private readonly seededRuns = new Map<string, Promise<void>>();
  private readonly activeLeases = new Map<string, ActiveRunLease>();
  private readonly leaseHeartbeats = new Map<string, RunLeaseHeartbeat>();
  private readonly driverId: string;
  private readonly leaseHeartbeatIntervalMs: number;
  private readonly leaseHeartbeatTimeoutMs: number;

  constructor(
    private readonly journal: ItotoriLocalizationJournalRepositoryPort,
    private readonly opts: DrivenJournalPersistenceOptions,
  ) {
    this.driverId = opts.driverId ?? `localization-driver-${randomUUID()}`;
    const leaseMilliseconds = (opts.leaseSeconds ?? LOCALIZATION_JOURNAL_RUN_LEASE_SECONDS) * 1_000;
    this.leaseHeartbeatIntervalMs =
      opts.leaseHeartbeatIntervalMs ?? Math.max(1_000, Math.floor(leaseMilliseconds / 3));
    this.leaseHeartbeatTimeoutMs = opts.leaseHeartbeatTimeoutMs ?? this.leaseHeartbeatIntervalMs;
    if (
      !Number.isFinite(this.leaseHeartbeatIntervalMs) ||
      !Number.isInteger(this.leaseHeartbeatIntervalMs) ||
      this.leaseHeartbeatIntervalMs <= 0 ||
      !Number.isFinite(this.leaseHeartbeatTimeoutMs) ||
      !Number.isInteger(this.leaseHeartbeatTimeoutMs) ||
      this.leaseHeartbeatTimeoutMs <= 0 ||
      this.leaseHeartbeatIntervalMs + this.leaseHeartbeatTimeoutMs >= leaseMilliseconds ||
      INVOCATION_DEFAULT_DEADLINE_MS + this.leaseHeartbeatTimeoutMs > leaseMilliseconds
    ) {
      throw new Error(
        "journal lease heartbeat interval and timeout must be positive integers whose sum is below the lease, and the lease must cover the provider deadline plus the abort margin",
      );
    }
  }

  async beginJournalRun(plan: DrivenJournalRunPlan, mode: "new" | "resume"): Promise<void> {
    let seed = this.seededRuns.get(plan.run.runId);
    if (seed === undefined) {
      seed = this.journal
        .seedRun(this.opts.actor, {
          runId: plan.run.runId,
          projectId: plan.run.projectId,
          localeBranchId: plan.run.localeBranchId,
          sourceRevisionId: plan.run.sourceRevisionId,
          targetLocale: plan.run.targetLocale,
          frozenScope: plan.frozenScope,
          routingPolicy: plan.routingPolicy,
          costPolicy: plan.costPolicy,
          units: plan.units,
          ...(mode === "new"
            ? {
                lease: {
                  ownerId: this.driverId,
                  ...(this.opts.leaseSeconds === undefined
                    ? {}
                    : { leaseSeconds: this.opts.leaseSeconds }),
                },
              }
            : {}),
        })
        .then((run) => {
          if (mode === "new") {
            if (
              run.leaseOwnerId !== this.driverId ||
              run.leaseExpiresAt === null ||
              run.fenceToken <= 0
            ) {
              throw new Error(`journal run ${run.runId} is already owned by another live driver`);
            }
            this.activeLeases.set(run.runId, {
              ownerId: this.driverId,
              fenceToken: run.fenceToken,
              ...(this.opts.leaseSeconds === undefined
                ? {}
                : { leaseSeconds: this.opts.leaseSeconds }),
            });
          }
        });
      this.seededRuns.set(plan.run.runId, seed);
    }
    await seed;
  }

  async loadResumeState(runId: string): Promise<DrivenJournalResumeState> {
    const [run, outcomes, attempts] = await Promise.all([
      this.journal.loadRun(this.opts.actor, runId),
      this.journal.loadRunOutcomes(this.opts.actor, runId),
      this.journal.loadAttemptsForRun(this.opts.actor, runId),
    ]);
    if (run === null) throw new Error(`cannot resume missing journal run ${runId}`);
    return {
      costPolicy: drivenJournalCostPolicyFromRecord(run.costPolicy, runId),
      status: run.status,
      pausedBlocker: run.pausedBlocker,
      leaseOwnerId: run.leaseOwnerId,
      leaseExpiresAt: run.leaseExpiresAt?.toISOString() ?? null,
      fenceToken: run.fenceToken,
      attempts: attempts.map((attempt): DrivenLlmAttemptRecord => {
        if (attempt.requestedModelId === null || attempt.requestedProviderId === null) {
          throw new Error(
            `supervised attempt ${attempt.attemptId} is missing its requested model/provider pair`,
          );
        }
        return {
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
          usageResponseJson: attempt.usageResponseJson as Record<string, unknown> | null,
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
          validationResult: attempt.validationResult ?? "not_evaluated",
          failureClass: attempt.failureClass,
          retryDecision: attempt.retryDecision,
          retryDelayMs: attempt.retryDelayMs,
          artifactRef: attempt.artifactRef,
          errorClasses: attempt.errorClasses,
          startedAt: attempt.startedAt.toISOString(),
          completedAt: attempt.completedAt?.toISOString() ?? null,
        };
      }),
      writtenOutcomes: outcomes.map((record) => {
        const selected = record.outcome.candidates.find(
          (candidate) => candidate.id === record.outcome.selectedCandidateId,
        );
        if (selected === undefined) {
          throw new Error(`journal outcome ${record.outcome.id} has no selected candidate`);
        }
        return {
          bridgeUnitId: record.bridgeUnitId,
          sourceUnitKey: record.sourceUnitKey ?? record.bridgeUnitId,
          sceneId: undefined,
          outcome: record.outcome,
          selectedBody: selected.body,
        };
      }),
    };
  }

  async resumeJournalRun(runId: string): Promise<void> {
    const run = await this.journal.resumeRun(this.opts.actor, runId, {
      ownerId: this.driverId,
      ...(this.opts.leaseSeconds === undefined ? {} : { leaseSeconds: this.opts.leaseSeconds }),
    });
    this.activeLeases.set(runId, {
      ownerId: this.driverId,
      fenceToken: run.fenceToken,
      ...(this.opts.leaseSeconds === undefined ? {} : { leaseSeconds: this.opts.leaseSeconds }),
    });
  }

  createCostAdmission(runId: string): InvocationCostAdmission {
    return {
      admit: async (input) => {
        if (input.runId !== runId) {
          throw new Error(
            `cost admission for ${runId} cannot reserve attempt for different run ${input.runId}`,
          );
        }
        await this.requireSeed(runId);
        const lease = this.requireLease(runId);
        const roundTripStartedAt = performance.now();
        const result = await this.journal.reserveAttemptCost(this.opts.actor, {
          attemptId: input.attempt.attemptId,
          runId: input.attempt.runId,
          bridgeUnitId: input.attempt.bridgeUnitId,
          stage: input.attempt.stage,
          agentLabel: input.attempt.agentLabel,
          logicalCallId: input.attempt.logicalCallId,
          attemptIndex: input.attempt.attemptIndex,
          requestedModelId: input.attempt.requestedModelId,
          requestedProviderId: input.attempt.requestedProviderId,
          zdr: input.attempt.zdr,
          artifactRef: `provider-run:${input.attempt.providerRunId}`,
          startedAt: input.attempt.startedAt,
          worstCaseCostUsd: input.worstCaseCostUsd,
          lease,
        });
        if (!result.admitted) {
          const cap = result.account.capUsd ?? "unbounded";
          return {
            admitted: false,
            detail:
              `run cost cap $${cap} cannot reserve worst-case $${input.worstCaseCostUsd} ` +
              `after $${result.account.spentCostUsd} spent and $${result.account.reservedCostUsd} reserved`,
            evidence:
              `cost-account:${runId};spent-usd:${result.account.spentCostUsd};` +
              `reserved-usd:${result.account.reservedCostUsd};cap-usd:${cap}`,
            operatorAction: "raise the run cost cap, then resume",
          };
        }
        return {
          admitted: true,
          attemptStarted: true,
          dispatchLeaseSignal: this.startAttemptHeartbeat(
            runId,
            input.attempt.attemptId,
            result.attempt.leaseDeadline,
            performance.now() - roundTripStartedAt,
          ),
        };
      },
    };
  }

  async attemptStarted(attempt: InvocationAttemptStarted): Promise<AbortSignal> {
    await this.requireSeed(attempt.runId);
    const lease = this.requireLease(attempt.runId);
    const leaseRoundTripStartedAt = performance.now();
    const dispatchingAttempt = await this.journal.beginAttempt(this.opts.actor, {
      attemptId: attempt.attemptId,
      runId: attempt.runId,
      bridgeUnitId: attempt.bridgeUnitId,
      stage: attempt.stage,
      agentLabel: attempt.agentLabel,
      logicalCallId: attempt.logicalCallId,
      attemptIndex: attempt.attemptIndex,
      requestedModelId: attempt.requestedModelId,
      requestedProviderId: attempt.requestedProviderId,
      zdr: attempt.zdr,
      artifactRef: `provider-run:${attempt.providerRunId}`,
      startedAt: attempt.startedAt,
      lease,
    });
    return this.startAttemptHeartbeat(
      attempt.runId,
      attempt.attemptId,
      dispatchingAttempt.leaseDeadline,
      performance.now() - leaseRoundTripStartedAt,
    );
  }

  async attemptCompleted(attempt: InvocationAttemptCompleted): Promise<void> {
    const run = attempt.providerRun;
    await this.requireSeed(attempt.runId);
    const lease = this.requireLease(attempt.runId);
    const usage = run?.tokenUsage;
    const billingState = run?.billingState ?? "unknown";
    const reportableCost =
      run !== undefined && !(billingState === "unknown" && run.cost.costKind === "zero");
    try {
      await this.journal.completeAttempt(this.opts.actor, {
        attemptId: attempt.attemptId,
        runId: attempt.runId,
        bridgeUnitId: attempt.bridgeUnitId,
        modelId: run?.provider.actualModelId ?? null,
        providerId:
          run === undefined
            ? null
            : (run.provider.upstreamProvider ?? run.provider.requestedProviderId),
        costUsd: reportableCost ? run.cost.amountUsd : null,
        ...(reportableCost ? { costKind: run.cost.costKind } : {}),
        billingState,
        ...(run !== undefined ? { usageResponseJson: run.usageResponseJson } : {}),
        tokensIn: usage?.promptTokens ?? null,
        tokensOut: usage?.completionTokens ?? null,
        ...(usage !== undefined ? { tokenCountSource: usage.tokenCountSource } : {}),
        ...(usage !== undefined ? { cacheReadTokens: usage.cacheReadTokens ?? null } : {}),
        ...(usage !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens ?? null } : {}),
        ...(run !== undefined
          ? { cacheDiscountMicrosUsd: run.cost.cacheDiscountMicrosUsd ?? null }
          : {}),
        ...(run !== undefined ? { fallbackUsed: run.fallbackUsed } : {}),
        ...(run !== undefined ? { fallbackPlan: run.fallbackPlan } : {}),
        zdr: run?.routingPosture.zdr ?? attempt.zdr,
        finishState: attempt.finishState,
        refusalState: attempt.refusalState,
        validationResult: attempt.validationResult,
        failureClass: attempt.failureClass,
        retryDecision: attempt.retryDecision,
        retryDelayMs: attempt.retryDelayMs,
        artifactRef: attempt.artifactRef,
        errorClasses: run?.errorClasses ?? [],
        completedAt: attempt.completedAt,
        lease,
      });
      // A provider can report a settled bill above its pre-dispatch estimate.
      // The repository commits that real cost and atomically pauses a capped
      // run. Surface the durable blocker back through the supervisor so this
      // worker stops before it can materialize an outcome or patch after the
      // over-cap settlement.
      const runState = await this.journal.loadRun(this.opts.actor, attempt.runId);
      if (runState?.status === "paused" && runState.pausedBlocker?.kind === "budget_cap") {
        throw new InvocationOperationalPauseError(runState.pausedBlocker);
      }
    } finally {
      await this.stopAttemptHeartbeat(attempt.runId, attempt.attemptId);
    }
  }

  async pauseRun(runId: string, blocker: OperationalBlocker): Promise<void> {
    await this.requireSeed(runId);
    await this.journal.pauseRun(this.opts.actor, runId, blocker, this.requireLease(runId));
  }

  async releasePausedRunLease(runId: string): Promise<void> {
    await this.requireSeed(runId);
    const lease = this.requireLease(runId);
    await this.journal.releaseRunLease(this.opts.actor, runId, lease);
    this.activeLeases.delete(runId);
    await this.stopRunHeartbeat(runId);
  }

  /**
   * The terminal finalizer needs the same fenced lease that admitted the
   * executor's provider calls. Expose a copy rather than the private mutable
   * record so it can make the finalizing -> terminal transition atomically
   * without teaching the executor about terminal states.
   */
  getActiveRunLease(runId: string): {
    ownerId: string;
    fenceToken: number;
    leaseSeconds?: number;
  } {
    return { ...this.requireLease(runId) };
  }

  /**
   * Stop provider-era heartbeat work while retaining the fenced identity for
   * the one atomic `running|paused -> finalizing` transition. The terminal
   * repository clears that durable lease as it acquires the run-level lock.
   */
  async quiesceTerminalRunLeaseHeartbeat(runId: string): Promise<void> {
    await this.stopRunHeartbeat(runId);
  }

  /**
   * `running|paused -> finalizing` atomically consumes the durable executor
   * lease. Drop this adapter's in-memory ownership immediately afterward;
   * unlike `releasePausedRunLease`, this never performs another DB write.
   */
  async forgetTerminalRunLease(runId: string): Promise<void> {
    this.activeLeases.delete(runId);
    await this.stopRunHeartbeat(runId);
  }

  async persistUnitJournal(record: DrivenUnitJournalRecord): Promise<void> {
    await this.requireSeed(record.run.runId);
    const lease = this.requireLease(record.run.runId);
    await this.journal.persistUnit(this.opts.actor, {
      runId: record.run.runId,
      bridgeUnitId: record.writtenOutcome.bridgeUnitId,
      sourceUnitKey: record.writtenOutcome.sourceUnitKey,
      outcome: record.writtenOutcome.outcome,
      // Attempts were begun/completed around each physical dispatch. Supplying
      // an empty batch makes the outcome transaction verify those existing
      // rows instead of creating a second append path.
      attempts: [],
      contextPacket: record.contextPacket,
      contextRefs: record.contextRefs,
      speakerLabels: record.speakerLabels,
      qaDetails: record.qaDetails,
      lease,
    });
  }

  async persistFailedUnitAttempts(
    record: Parameters<DrivenUnitJournalSink["persistFailedUnitAttempts"]>[0],
  ): Promise<void> {
    await this.requireSeed(record.run.runId);
    // Supervisor lifecycle already persisted every observable attempt. An
    // interrupted attempt deliberately remains dispatching for resume.
  }

  private async requireSeed(runId: string): Promise<void> {
    const seed = this.seededRuns.get(runId);
    if (seed === undefined) throw new Error(`journal run ${runId} was not seeded before dispatch`);
    await seed;
  }

  private requireLease(runId: string): {
    ownerId: string;
    fenceToken: number;
    leaseSeconds?: number;
  } {
    const lease = this.activeLeases.get(runId);
    if (lease === undefined) {
      throw new Error(`journal run ${runId} has no active driver lease`);
    }
    return lease;
  }

  private startAttemptHeartbeat(
    runId: string,
    attemptId: string,
    deadline: LocalizationJournalRunLeaseDeadline,
    leaseRoundTripMs: number,
  ): AbortSignal {
    const controller = new AbortController();
    const existing = this.leaseHeartbeats.get(runId);
    if (existing !== undefined) {
      existing.attemptAbortControllers.set(attemptId, controller);
      if (existing.renewalFailure !== null) {
        controller.abort(existing.renewalFailure);
      } else {
        this.armRunLeaseDeadline(runId, existing, deadline, leaseRoundTripMs);
      }
      return controller.signal;
    }

    const attemptAbortControllers = new Map([[attemptId, controller]]);
    const timer = setInterval(() => {
      this.renewLeaseHeartbeat(runId);
    }, this.leaseHeartbeatIntervalMs);
    timer.unref?.();
    const heartbeat: RunLeaseHeartbeat = {
      attemptAbortControllers,
      timer,
      leaseDeadlineTimer: null,
      renewalInFlight: null,
      renewalFailure: null,
    };
    this.leaseHeartbeats.set(runId, heartbeat);
    this.armRunLeaseDeadline(runId, heartbeat, deadline, leaseRoundTripMs);
    return controller.signal;
  }

  private renewLeaseHeartbeat(runId: string): void {
    const heartbeat = this.leaseHeartbeats.get(runId);
    const lease = this.activeLeases.get(runId);
    if (heartbeat === undefined || lease === undefined || heartbeat.renewalInFlight !== null)
      return;

    const renewalStartedAt = performance.now();
    const underlyingRenewal = Promise.resolve()
      .then(async () => {
        return await this.journal.renewRunLease(this.opts.actor, runId, lease);
      })
      .then((renewed) => {
        const current = this.leaseHeartbeats.get(runId);
        if (current === heartbeat && current.renewalFailure === null) {
          this.armRunLeaseDeadline(
            runId,
            current,
            renewed.leaseDeadline,
            performance.now() - renewalStartedAt,
          );
        }
      });
    let renewal!: Promise<void>;
    renewal = new Promise<void>((resolve) => {
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(renewalTimeout);
        resolve();
      };
      const renewalTimeout = setTimeout(() => {
        this.recordHeartbeatFailure(
          runId,
          new Error(`journal lease heartbeat exceeded ${String(this.leaseHeartbeatTimeoutMs)}ms`),
        );
        settle();
      }, this.leaseHeartbeatTimeoutMs);
      renewalTimeout.unref?.();
      // Both handlers stay attached after a timeout, so a late database
      // settlement is observed and can never become an unhandled rejection.
      void underlyingRenewal.then(settle, (error: unknown) => {
        this.recordHeartbeatFailure(runId, error);
        settle();
      });
    }).finally(() => {
      const current = this.leaseHeartbeats.get(runId);
      if (current?.renewalInFlight === renewal) current.renewalInFlight = null;
    });
    heartbeat.renewalInFlight = renewal;
  }

  private recordHeartbeatFailure(runId: string, error: unknown): void {
    const heartbeat = this.leaseHeartbeats.get(runId);
    if (heartbeat === undefined) return;
    heartbeat.renewalFailure ??=
      error instanceof Error
        ? error
        : new Error(`journal lease heartbeat failed: ${String(error)}`);
    if (heartbeat.leaseDeadlineTimer !== null) {
      clearTimeout(heartbeat.leaseDeadlineTimer);
      heartbeat.leaseDeadlineTimer = null;
    }
    // The provider transport contract requires honoring AbortSignal. Poison
    // every active dispatch immediately on lease uncertainty, while later
    // ticks keep trying to renew until all attempts have settled.
    for (const controller of heartbeat.attemptAbortControllers.values()) {
      controller.abort(heartbeat.renewalFailure);
    }
  }

  private armRunLeaseDeadline(
    runId: string,
    heartbeat: RunLeaseHeartbeat,
    deadline: LocalizationJournalRunLeaseDeadline,
    leaseRoundTripMs: number,
  ): void {
    if (heartbeat.renewalFailure !== null) return;
    if (heartbeat.leaseDeadlineTimer !== null) clearTimeout(heartbeat.leaseDeadlineTimer);
    // PostgreSQL supplies the remaining duration, so executor wall-clock skew
    // cannot move this boundary. Subtract the full observed round trip plus the
    // renewal timeout as a conservative abort margin; a healthy event loop then
    // delivers AbortSignal before the DB can admit a new fence.
    const delayMs = Math.max(
      0,
      Math.floor(
        deadline.remainingMs - Math.max(0, leaseRoundTripMs) - this.leaseHeartbeatTimeoutMs,
      ),
    );
    if (delayMs === 0) {
      // Fail closed in this turn. A zero-delay timer would run only after the
      // supervisor's continuation had a chance to enter the physical provider.
      this.recordHeartbeatFailure(runId, new JournalRunLeaseDeadlineError(runId, deadline));
      return;
    }
    heartbeat.leaseDeadlineTimer = setTimeout(() => {
      this.recordHeartbeatFailure(runId, new JournalRunLeaseDeadlineError(runId, deadline));
    }, delayMs);
    heartbeat.leaseDeadlineTimer.unref?.();
  }

  private async stopAttemptHeartbeat(runId: string, attemptId: string): Promise<void> {
    const heartbeat = this.leaseHeartbeats.get(runId);
    if (heartbeat === undefined) return;
    heartbeat.attemptAbortControllers.delete(attemptId);
    if (heartbeat.attemptAbortControllers.size === 0) await this.stopRunHeartbeat(runId);
  }

  private async stopRunHeartbeat(runId: string): Promise<void> {
    const heartbeat = this.leaseHeartbeats.get(runId);
    if (heartbeat === undefined) return;
    clearInterval(heartbeat.timer);
    if (heartbeat.leaseDeadlineTimer !== null) clearTimeout(heartbeat.leaseDeadlineTimer);
    this.leaseHeartbeats.delete(runId);
    // The interval callback records every renewal promise before returning.
    // Drain the final one so executor completion/context teardown cannot race
    // an unobserved database operation.
    await heartbeat.renewalInFlight;
  }
}

/**
 * A resumed executor must replay the policy the repository persisted, not a
 * config/CLI reconstruction. Validate the narrow driven-run contract here,
 * but keep every persisted field so a future policy addition remains stable
 * across an idempotent resume seed.
 */
function drivenJournalCostPolicyFromRecord(
  costPolicy: Record<string, unknown> | null,
  runId: string,
): DrivenJournalCostPolicy {
  if (costPolicy === null) {
    throw new Error(`cannot resume journal run ${runId}: persisted cost policy is missing`);
  }
  if (costPolicy.reservation !== "node_4_seam") {
    throw new Error(
      `cannot resume journal run ${runId}: unsupported persisted cost reservation policy`,
    );
  }
  const budgetCapUsd = costPolicy.budgetCapUsd;
  if (
    budgetCapUsd !== null &&
    typeof budgetCapUsd !== "string" &&
    (typeof budgetCapUsd !== "number" || !Number.isFinite(budgetCapUsd) || budgetCapUsd < 0)
  ) {
    throw new Error(`cannot resume journal run ${runId}: persisted budget cap is invalid`);
  }
  if (typeof budgetCapUsd === "string" && budgetCapUsd.trim().length === 0) {
    throw new Error(`cannot resume journal run ${runId}: persisted budget cap is invalid`);
  }
  return {
    ...costPolicy,
    reservation: "node_4_seam",
    budgetCapUsd,
  };
}

/**
 * Writes the ONE patch export to disk under a run directory as
 * `translated-bridge.json` + `patch-report.json`. Real filesystem storage —
 * the translated bridge carries every in-scope unit's selected body once
 * coverage is complete, and the patch report is the deterministic summary.
 */
export class FsDrivenPatchExportSink implements DrivenPatchExportSink {
  private count = 0;
  constructor(private readonly runDir: string) {}

  async exportPatch(record: DrivenPatchExportRecord): Promise<void> {
    mkdirSync(this.runDir, { recursive: true });
    writeFileSync(
      join(this.runDir, "translated-bridge.json"),
      `${JSON.stringify(record.translatedBridge, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(
      join(this.runDir, "patch-report.json"),
      `${JSON.stringify(record.patchReport, null, 2)}\n`,
      "utf8",
    );
    this.count += 1;
  }

  get exportCount(): number {
    return this.count;
  }
}
