// p0-core-terminal-run-finalizer — DB adapter for the transport-free core.
//
// The core consumes a small structural port so its all-path behavior is easy
// to test. This adapter is the production binding: every predicate input is
// loaded from the normalized journal/patch/outbox rows, never from an executor
// report or a summary file.

import {
  ItotoriLocalizationRunFinalizerRepository,
  patchVersionIdFor,
  type AuthorizationActor,
  type DatabaseContext,
  type LocalizationRunFinalizerRootCause,
  type LocalizationRunFinalizerSnapshot,
  type LocalizationRunFinalizerOutboxStatus,
  type LocalizationRunTerminalSummary,
  type LocalizationJournalRunLeaseIdentity,
} from "@itotori/db";
import type {
  TerminalFinalizerStage,
  TerminalOperationalBlocker,
  TerminalPatchVersion,
  TerminalRunFinalizerPersistencePort,
  TerminalRunRootCause,
  TerminalRunSnapshot,
  TerminalRunStageEvidence,
  TerminalRunState,
  TerminalRunSummary,
  TerminalRunSummaryStage,
  TerminalStageStatus,
} from "./terminal-run-finalizer.js";

export type TerminalRunLeaseResolver = (
  runId: string,
) => LocalizationJournalRunLeaseIdentity | undefined;

export type TerminalRunFinalizingHooks = {
  /** Stop executor heartbeat work before the DB consumes its fence. */
  beforeEnterFinalizing?: (runId: string) => Promise<void>;
  /** Drop in-process executor ownership after the DB has the finalizing lock. */
  afterEnterFinalizing?: (runId: string) => Promise<void>;
};

export type TerminalRunFinalizerAdapterOptions = {
  /** Authorizes the repository's explicit operator-cancellation transition. */
  operatorCancellation?: boolean;
  /**
   * Production pool used to hold one session-scoped advisory lock for the
   * complete finalizer invocation. This prevents concurrent build/apply
   * workers while still releasing automatically on process/connection death.
   */
  runLockPool?: Pick<DatabaseContext["pool"], "connect">;
};

/** Binds the generic finalizer to the live, lease-aware DB repository. */
export class DbTerminalRunFinalizerAdapter implements TerminalRunFinalizerPersistencePort {
  constructor(
    private readonly repository: ItotoriLocalizationRunFinalizerRepository,
    private readonly actor: AuthorizationActor,
    private readonly leaseFor?: TerminalRunLeaseResolver,
    private readonly hooks: TerminalRunFinalizingHooks = {},
    private readonly options: TerminalRunFinalizerAdapterOptions = {},
  ) {}

  async acquireRunLock(runId: string): Promise<(() => Promise<void>) | null> {
    const pool = this.options.runLockPool;
    if (pool === undefined) {
      throw new Error("production terminal finalizer requires a PostgreSQL run-lock pool");
    }
    const client = await pool.connect();
    const lockKey = `itotori:terminal-finalizer:${runId}`;
    let acquired = false;
    try {
      const result = await client.query<{ acquired: boolean }>(
        "select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired",
        [lockKey],
      );
      acquired = result.rows[0]?.acquired === true;
    } catch (error) {
      client.release(error instanceof Error ? error : true);
      throw error;
    }
    if (!acquired) {
      client.release();
      return null;
    }

    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
        client.release();
      } catch (error) {
        // Destroy a broken session so it cannot return to the pool while still
        // owning the advisory lock. Disconnecting releases the lock server-side.
        client.release(error instanceof Error ? error : true);
      }
    };
  }

  async loadSnapshot(runId: string): Promise<TerminalRunSnapshot | null> {
    const snapshot = await this.repository.loadSnapshot(this.actor, runId);
    return snapshot === null ? null : snapshotFromDb(snapshot);
  }

  async enterFinalizing(runId: string): Promise<void> {
    await this.hooks.beforeEnterFinalizing?.(runId);
    const lease = this.leaseFor?.(runId);
    await this.repository.enterFinalizing(this.actor, {
      runId,
      ...(lease === undefined ? {} : { lease }),
    });
    await this.hooks.afterEnterFinalizing?.(runId);
  }

  async loadTerminalSummary(runId: string): Promise<TerminalRunSummary | null> {
    const summary = await this.repository.loadTerminalSummary(this.actor, runId);
    return summary === null ? null : summaryFromDb(summary.summary);
  }

  async ensurePatchVersion(input: {
    runId: string;
    frozenUnitIds: string[];
    memberships: Array<{ unitId: string; outcomeId: string; resultRevisionId: string }>;
    artifactHashes: Record<string, string>;
    artifactRefs: Record<string, string>;
  }): Promise<TerminalPatchVersion> {
    // The repository independently derives exact membership from durable
    // planned-unit/outcome rows. Verify the caller did not accidentally hand
    // it a stale report before allowing the DB transaction to establish it.
    const expectedIds = input.frozenUnitIds;
    if (
      input.memberships.length !== expectedIds.length ||
      input.memberships.some(
        (member, index) =>
          member.unitId !== expectedIds[index] || member.resultRevisionId.trim().length === 0,
      )
    ) {
      throw new Error(
        `terminal finalizer membership does not match frozen run scope ${input.runId}`,
      );
    }
    await this.repository.ensurePatchVersion(this.actor, {
      runId: input.runId,
      artifactHashes: input.artifactHashes,
      artifactRefs: input.artifactRefs,
    });
    const snapshot = await this.repository.loadSnapshot(this.actor, input.runId);
    if (snapshot?.patch === null || snapshot === null) {
      throw new Error(`terminal finalizer did not persist patch version for ${input.runId}`);
    }
    return patchFromDb(snapshot.patch, snapshot.outbox);
  }

  async recordStage(input: {
    runId: string;
    stage: TerminalFinalizerStage;
    status: TerminalStageStatus;
    evidence?: Record<string, unknown> | null;
    error?: string | null;
  }): Promise<void> {
    if (input.status === "skipped") return;
    await this.repository.upsertPatchStageEvidence(this.actor, {
      runId: input.runId,
      stage: input.stage,
      // A file-projection failure is explicitly retryable: the canonical
      // summary is already durable, so summary delivery must not become an
      // immutable failed row that blocks a later idempotent retry.
      status:
        input.stage === "summary" && input.status === "failed"
          ? "retry_waiting"
          : dbStageStatus(input.status),
      ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
      ...(input.error === undefined ? {} : { lastError: input.error }),
    });
  }

  async commitTerminal(input: {
    runId: string;
    terminalStatus: TerminalRunState;
    rootCause: TerminalRunRootCause;
    blocker: TerminalOperationalBlocker | null;
    patchVersionId?: string;
    supersedePausedSummary?: boolean;
    summary: TerminalRunSummary;
  }): Promise<TerminalRunSummary> {
    const lease = this.leaseFor?.(input.runId);
    const terminalInput = {
      runId: input.runId,
      ...(input.patchVersionId === undefined ? {} : { patchVersionId: input.patchVersionId }),
      ...(lease === undefined ? {} : { lease }),
      ...(input.blocker === null ? {} : { blocker: input.blocker }),
      ...(input.supersedePausedSummary === true ? { supersedePausedSummary: true } : {}),
      ...(this.options.operatorCancellation === true &&
      input.terminalStatus === "aborted" &&
      input.rootCause.kind === "cancelled"
        ? { operatorCancellation: true }
        : {}),
      rootCause: rootCauseToDb(input.rootCause),
    };
    const record =
      input.terminalStatus === "succeeded"
        ? await this.repository.completeSucceededRun(this.actor, terminalInput)
        : await this.repository.terminalize(this.actor, {
            ...terminalInput,
            terminalStatus: input.terminalStatus,
          });
    return summaryFromDb(record.summary);
  }
}

function snapshotFromDb(snapshot: LocalizationRunFinalizerSnapshot): TerminalRunSnapshot {
  return {
    runId: snapshot.run.runId,
    runStatus: snapshot.run.status,
    blocker: snapshot.run.pausedBlocker,
    frozenUnits: snapshot.units.map((unit) => ({
      unitId: unit.bridgeUnitId,
      ordinal: unit.unitOrdinal,
    })),
    outcomes: snapshot.outcomes.map((outcome) => ({
      unitId: outcome.bridgeUnitId,
      outcomeId: outcome.outcomeId,
      selectedCandidate:
        outcome.selectedCandidateId === "" || outcome.selectedCandidateBody === null
          ? null
          : {
              id: outcome.selectedCandidateId,
              body: outcome.selectedCandidateBody,
              valid: outcome.selectedCandidateValid,
            },
      resultRevisionId: outcome.resultRevisionId,
    })),
    attempts: snapshot.attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      lifecycle:
        attempt.lifecycleState === "dispatching"
          ? "dispatching"
          : attempt.retryWaiting
            ? "retry_waiting"
            : "completed",
    })),
    reservations: snapshot.reservations.map((reservation) => ({
      reservationId: reservation.reservationId,
      state: reservation.state,
    })),
    patch: snapshot.patch === null ? null : patchFromDb(snapshot.patch, snapshot.outbox),
    stages: stagesFromDb(snapshot),
    quality: { ...snapshot.quality },
  };
}

function patchFromDb(
  patch: NonNullable<LocalizationRunFinalizerSnapshot["patch"]>,
  outbox: LocalizationRunFinalizerSnapshot["outbox"],
): TerminalPatchVersion {
  const stageStatus = new Map(outbox.map((entry) => [entry.stage, entry.status] as const));
  return {
    patchVersionId: patch.patchVersionId,
    unitIds: patch.units
      .slice()
      .sort((a, b) => a.unitOrdinal - b.unitOrdinal)
      .map((unit) => unit.bridgeUnitId),
    artifactHashes: { ...patch.artifactHashes },
    artifactRefs: { ...patch.artifactRefs },
    buildSucceeded: stageStatus.get("patch_build") === "succeeded",
    applySucceeded: stageStatus.get("patch_apply") === "succeeded",
    validationSucceeded: stageStatus.get("validation") === "succeeded",
    playable: patch.status === "playable",
  };
}

function stagesFromDb(snapshot: LocalizationRunFinalizerSnapshot): TerminalRunStageEvidence[] {
  const records = new Map<TerminalRunSummaryStage, TerminalRunStageEvidence>();
  let patchBuild: LocalizationRunFinalizerSnapshot["outbox"][number] | undefined;
  let patchApply: LocalizationRunFinalizerSnapshot["outbox"][number] | undefined;
  for (const entry of snapshot.outbox) {
    if (entry.stage === "patch_build") {
      patchBuild = entry;
      continue;
    }
    if (entry.stage === "patch_apply") {
      patchApply = entry;
      continue;
    }
    const stage = entry.stage;
    const incoming: TerminalRunStageEvidence = {
      stage,
      status: coreStageStatus(entry.status),
      evidence: entry.evidence,
      error: entry.lastError,
    };
    const prior = records.get(stage);
    if (prior === undefined || stageRank(incoming.status) >= stageRank(prior.status)) {
      records.set(stage, incoming);
    }
  }
  const patch = collapsedPatchStage(patchBuild, patchApply);
  if (patch !== null) records.set("patch", patch);
  return [...records.values()];
}

function collapsedPatchStage(
  build: LocalizationRunFinalizerSnapshot["outbox"][number] | undefined,
  apply: LocalizationRunFinalizerSnapshot["outbox"][number] | undefined,
): TerminalRunStageEvidence | null {
  if (build === undefined && apply === undefined) return null;
  const failed = [build, apply].find((entry) => entry?.status === "failed");
  if (failed !== undefined) return stageEvidenceFromPatchEntry(failed, "failed");
  if (build?.status === "succeeded" && apply?.status === "succeeded") {
    return stageEvidenceFromPatchEntry(apply, "succeeded");
  }
  const pending = [build, apply].find((entry) => entry?.status !== "succeeded");
  return stageEvidenceFromPatchEntry(pending ?? apply ?? build!, "pending");
}

function stageEvidenceFromPatchEntry(
  entry: LocalizationRunFinalizerSnapshot["outbox"][number],
  status: TerminalStageStatus,
): TerminalRunStageEvidence {
  return {
    stage: "patch",
    status,
    evidence: entry.evidence,
    error: entry.lastError,
  };
}

function stageRank(status: TerminalStageStatus): number {
  return status === "failed" ? 4 : status === "succeeded" ? 3 : status === "pending" ? 2 : 1;
}

function dbStageStatus(status: TerminalStageStatus): LocalizationRunFinalizerOutboxStatus {
  return status === "succeeded" ? "succeeded" : status === "failed" ? "failed" : "pending";
}

function coreStageStatus(status: LocalizationRunFinalizerOutboxStatus): TerminalStageStatus {
  if (status === "succeeded") return "succeeded";
  if (status === "failed") return "failed";
  return "pending";
}

function rootCauseToDb(rootCause: TerminalRunRootCause): LocalizationRunFinalizerRootCause {
  return {
    kind: rootCause.kind,
    stage: rootCause.stage === "patch" ? "patch_apply" : rootCause.stage,
    code: rootCause.code,
    message: rootCause.message,
  };
}

function summaryFromDb(summary: LocalizationRunTerminalSummary): TerminalRunSummary {
  return {
    schemaVersion: summary.schemaVersion,
    runId: summary.runId,
    terminalStatus: summary.terminalStatus,
    summaryEpoch: summary.summaryEpoch,
    rootCause: {
      kind: summary.rootCause.kind,
      stage: summary.rootCause.stage,
      code: summary.rootCause.code,
      message: summary.rootCause.message,
    },
    blocker: summary.blocker,
    coverage: {
      plannedUnitCount: summary.coverage.plannedUnitCount,
      writtenOutcomeCount: summary.coverage.writtenOutcomeCount,
      validSelectedCandidateCount: summary.coverage.validSelectedCandidateCount,
      resultRevisionCount: summary.coverage.resultRevisionCount,
      missingUnitIds: summary.coverage.missingUnitIds,
      duplicateOutcomeUnitIds: summary.coverage.duplicateOutcomeUnitIds,
    },
    attempts: {
      totalCount: summary.attempts.totalCount,
      runningCount: summary.attempts.runningCount,
      retryWaitingCount: summary.attempts.retryWaitingCount,
    },
    reservations: {
      totalCount: summary.reservations.totalCount,
      reconciledCount: summary.reservations.reconciledCount,
      unresolvedCount: summary.reservations.unresolvedCount,
    },
    patch: {
      patchVersionId: summary.patch.patchVersionId,
      exactFrozenScope: summary.patch.exactFrozenScope,
      artifactHashes: { ...summary.patch.artifactHashes },
      artifactRefs: { ...summary.patch.artifactRefs },
      playable: summary.patch.playable,
    },
    stages: summary.stages.map((entry) => ({
      stage: entry.stage,
      status: entry.status,
      evidence: entry.evidence,
      error: entry.error,
    })),
    quality: { ...summary.quality },
    cleanup: { ...summary.cleanup },
    generatedAt: summary.generatedAt,
  };
}

export function defaultPatchVersionId(runId: string): string {
  return patchVersionIdFor(runId);
}
