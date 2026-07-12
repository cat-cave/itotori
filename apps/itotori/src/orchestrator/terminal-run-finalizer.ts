// p0-core-terminal-run-finalizer — one all-path, coverage-only terminalizer.
//
// The executor owns durable unit work and deliberately stops at running/paused.
// This module owns the next boundary: it evaluates only durable coverage facts,
// makes exactly one terminal decision, and asks a persistence adapter to store
// the canonical summary plus its idempotent summary outbox projection.

export const TERMINAL_RUN_SUMMARY_SCHEMA_VERSION = "itotori.localization-run-summary.v0.1";

export const terminalRunStateValues = ["succeeded", "failed", "aborted", "paused"] as const;
export type TerminalRunState = (typeof terminalRunStateValues)[number];

/** Physical finalizer workers. Patch build/apply have distinct retry keys. */
export const terminalFinalizerStageValues = [
  "preflight",
  "provider",
  "unit",
  "persistence",
  "patch_build",
  "patch_apply",
  "validation",
  "summary",
  "cleanup",
] as const;
export type TerminalFinalizerStage = (typeof terminalFinalizerStageValues)[number];

/** Public summaries deliberately collapse both physical patch workers. */
export const terminalRunSummaryStageValues = [
  "preflight",
  "provider",
  "unit",
  "persistence",
  "patch",
  "validation",
  "summary",
  "cleanup",
] as const;
export type TerminalRunSummaryStage = (typeof terminalRunSummaryStageValues)[number];

export type TerminalStageStatus = "pending" | "succeeded" | "failed" | "skipped";

export type TerminalOperationalBlocker = {
  kind: "budget_cap" | "provider_outage" | "itotori_bug";
  detail: string;
  evidence: string;
  raisedAt: string;
  operatorAction: string;
};

export type TerminalRunRootCause = {
  kind:
    | "completed"
    | "operational_blocker"
    | "cancelled"
    | "patch_fault"
    | "itotori_defect"
    | "finalizer_fault";
  stage: TerminalRunSummaryStage | null;
  code: string;
  message: string;
};

export type TerminalRunUnit = { unitId: string; ordinal: number };

export type TerminalRunOutcome = {
  unitId: string;
  outcomeId: string;
  /** The selected candidate must be both durable and a non-blank target. */
  selectedCandidate: { id: string; body: string; valid: boolean } | null;
  /** A narrow run-origin reference; full HITL revisions remain node 10. */
  resultRevisionId: string | null;
};

export type TerminalRunAttempt = {
  attemptId: string;
  lifecycle: "dispatching" | "completed" | "retry_waiting";
};

export type TerminalRunReservation = {
  reservationId: string;
  state: "reserved" | "reconciled";
};

export type TerminalPatchVersion = {
  patchVersionId: string;
  unitIds: string[];
  artifactHashes: Record<string, string>;
  artifactRefs: Record<string, string>;
  buildSucceeded: boolean;
  applySucceeded: boolean;
  validationSucceeded: boolean;
  playable: boolean;
};

export type TerminalRunStageEvidence = {
  stage: TerminalRunSummaryStage;
  status: TerminalStageStatus;
  evidence: Record<string, unknown> | null;
  error: string | null;
};

/**
 * This is deliberately a durable projection shape. QA fields are carried as
 * metrics, but no property under `quality` is ever read by the success test.
 */
export type TerminalRunSnapshot = {
  runId: string;
  runStatus: "running" | "paused" | "finalizing" | TerminalRunState;
  blocker: TerminalOperationalBlocker | null;
  frozenUnits: TerminalRunUnit[];
  outcomes: TerminalRunOutcome[];
  attempts: TerminalRunAttempt[];
  reservations: TerminalRunReservation[];
  patch: TerminalPatchVersion | null;
  stages: TerminalRunStageEvidence[];
  quality: { findingCount: number; contestedFindingCount: number };
};

export type TerminalCoverageEvaluation = {
  complete: boolean;
  frozenUnitIds: string[];
  missingUnitIds: string[];
  duplicateOutcomeUnitIds: string[];
  runningAttemptIds: string[];
  unreconciledReservationIds: string[];
  patchExactFrozenScope: boolean;
  patchArtifactsPresent: boolean;
  patchStagesSucceeded: boolean;
};

export type TerminalRunSummary = {
  schemaVersion: typeof TERMINAL_RUN_SUMMARY_SCHEMA_VERSION;
  runId: string;
  terminalStatus: TerminalRunState;
  summaryEpoch: number;
  rootCause: TerminalRunRootCause;
  blocker: TerminalOperationalBlocker | null;
  coverage: {
    plannedUnitCount: number;
    writtenOutcomeCount: number;
    validSelectedCandidateCount: number;
    resultRevisionCount: number;
    missingUnitIds: string[];
    duplicateOutcomeUnitIds: string[];
  };
  attempts: { totalCount: number; runningCount: number; retryWaitingCount: number };
  reservations: { totalCount: number; reconciledCount: number; unresolvedCount: number };
  patch: {
    patchVersionId: string | null;
    exactFrozenScope: boolean;
    artifactHashes: Record<string, string>;
    artifactRefs: Record<string, string>;
    playable: boolean;
  };
  stages: TerminalRunStageEvidence[];
  quality: { findingCount: number; contestedFindingCount: number };
  cleanup: { error: string | null };
  generatedAt: string;
};

export type TerminalPatchWorkerResult = {
  artifactHashes?: Record<string, string>;
  artifactRefs?: Record<string, string>;
  evidence?: Record<string, unknown>;
};

export type TerminalFinalizerWorkerPorts = Partial<{
  [Stage in TerminalFinalizerStage]: (args: {
    runId: string;
    snapshot: TerminalRunSnapshot;
    summary?: TerminalRunSummary;
  }) => Promise<TerminalPatchWorkerResult | void> | TerminalPatchWorkerResult | void;
}>;

/** Structural port so the core remains testable without a database import. */
export type TerminalRunFinalizerPersistencePort = {
  /**
   * Acquire exclusive ownership of this run's finalizer. Production uses a
   * session-scoped PostgreSQL advisory lock, so process/connection death
   * releases ownership without relying on a filesystem lock or a heartbeat.
   * `null` means another finalizer currently owns the run.
   */
  acquireRunLock?(runId: string): Promise<(() => Promise<void>) | null>;
  loadSnapshot(runId: string): Promise<TerminalRunSnapshot | null>;
  /** Reads an already-committed canonical projection for summary-only retries. */
  loadTerminalSummary(runId: string): Promise<TerminalRunSummary | null>;
  enterFinalizing?(runId: string): Promise<void>;
  ensurePatchVersion?(input: {
    runId: string;
    frozenUnitIds: string[];
    memberships: Array<{ unitId: string; outcomeId: string; resultRevisionId: string }>;
    artifactHashes: Record<string, string>;
    artifactRefs: Record<string, string>;
  }): Promise<TerminalPatchVersion>;
  recordStage?(input: {
    runId: string;
    stage: TerminalFinalizerStage;
    status: TerminalStageStatus;
    evidence?: Record<string, unknown> | null;
    error?: string | null;
  }): Promise<void>;
  /** Stores the one canonical summary and changes the durable run state. */
  commitTerminal(input: {
    runId: string;
    terminalStatus: TerminalRunState;
    rootCause: TerminalRunRootCause;
    blocker: TerminalOperationalBlocker | null;
    patchVersionId?: string;
    /** A resumed executor reached a new paused boundary; replace the prior pause epoch. */
    supersedePausedSummary?: boolean;
    summary: TerminalRunSummary;
  }): Promise<TerminalRunSummary>;
};

export type TerminalFinalizerFaultFactory = () => unknown;

export type TerminalRunFinalizerInput = {
  runId: string;
  persistence: TerminalRunFinalizerPersistencePort;
  workers?: TerminalFinalizerWorkerPorts;
  /** Explicit operator cancellation maps only to `aborted`. */
  cancelled?: boolean;
  /** This invocation resumed executor work, so a new pause is not a summary retry. */
  supersedePausedSummary?: boolean;
  stageFaults?: Partial<Record<TerminalFinalizerStage, TerminalFinalizerFaultFactory>>;
  now?: () => Date;
};

export type TerminalRunFinalizerResult = {
  terminalStatus: TerminalRunState;
  summary: TerminalRunSummary;
  committed: true;
};

/** A typed error lets a worker declare a resumable operational pause. */
export class TerminalRunOperationalBlockerError extends Error {
  constructor(readonly blocker: TerminalOperationalBlocker) {
    super(blocker.detail);
    this.name = "TerminalRunOperationalBlockerError";
  }
}

/**
 * The terminal transaction could not be confirmed after a bounded retry. No
 * summary exists to project; the durable run status identifies the resume
 * boundary a later finalizer invocation must continue from.
 */
export class TerminalRunCommitResumableError extends Error {
  constructor(
    readonly runId: string,
    readonly durableRunStatus: TerminalRunSnapshot["runStatus"] | "unavailable",
    readonly commitError: unknown,
  ) {
    super(
      `terminal commit for ${runId} could not be confirmed; durable run remains ${durableRunStatus}`,
    );
    this.name = "TerminalRunCommitResumableError";
  }
}

/** Another live finalizer owns this run; no worker or terminal write occurred. */
export class TerminalRunFinalizerBusyError extends Error {
  constructor(readonly runId: string) {
    super(`terminal finalizer for ${runId} is already running`);
    this.name = "TerminalRunFinalizerBusyError";
  }
}

/**
 * Evaluate the coverage-only success predicate. QA annotations are purposely
 * absent from every condition below; they remain in `snapshot.quality` only.
 */
export function evaluateTerminalRunCoverage(
  snapshot: TerminalRunSnapshot,
  options: { requirePatch?: boolean; requirePlayable?: boolean } = {},
): TerminalCoverageEvaluation {
  const frozenUnitIds = snapshot.frozenUnits
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((unit) => unit.unitId);
  const outcomesByUnit = new Map<string, TerminalRunOutcome[]>();
  for (const outcome of snapshot.outcomes) {
    const outcomes = outcomesByUnit.get(outcome.unitId) ?? [];
    outcomes.push(outcome);
    outcomesByUnit.set(outcome.unitId, outcomes);
  }
  const duplicateOutcomeUnitIds = [...outcomesByUnit.entries()]
    .filter(([, outcomes]) => outcomes.length !== 1)
    .map(([unitId]) => unitId)
    .sort();
  const missingUnitIds = frozenUnitIds.filter((unitId) => {
    const outcome = outcomesByUnit.get(unitId)?.[0];
    const candidate = outcome?.selectedCandidate;
    return (
      outcome === undefined ||
      candidate == null ||
      !candidate.valid ||
      candidate.body.trim().length === 0 ||
      outcome.resultRevisionId === null
    );
  });
  const runningAttemptIds = snapshot.attempts
    .filter(
      (attempt) => attempt.lifecycle === "dispatching" || attempt.lifecycle === "retry_waiting",
    )
    .map((attempt) => attempt.attemptId)
    .sort();
  const unreconciledReservationIds = snapshot.reservations
    .filter((reservation) => reservation.state !== "reconciled")
    .map((reservation) => reservation.reservationId)
    .sort();
  const patch = snapshot.patch;
  const patchExactFrozenScope =
    patch !== null &&
    patch.unitIds.length === frozenUnitIds.length &&
    patch.unitIds.every((unitId, index) => unitId === frozenUnitIds[index]);
  const patchArtifactsPresent =
    patch !== null &&
    Object.keys(patch.artifactHashes).length > 0 &&
    Object.keys(patch.artifactRefs).length > 0;
  const patchStagesSucceeded =
    patch !== null && patch.buildSucceeded && patch.applySucceeded && patch.validationSucceeded;
  const patchComplete =
    !options.requirePatch ||
    (patchExactFrozenScope &&
      patchArtifactsPresent &&
      patchStagesSucceeded &&
      (options.requirePlayable === false || patch?.playable === true));
  return {
    complete:
      missingUnitIds.length === 0 &&
      duplicateOutcomeUnitIds.length === 0 &&
      runningAttemptIds.length === 0 &&
      unreconciledReservationIds.length === 0 &&
      patchComplete,
    frozenUnitIds,
    missingUnitIds,
    duplicateOutcomeUnitIds,
    runningAttemptIds,
    unreconciledReservationIds,
    patchExactFrozenScope,
    patchArtifactsPresent,
    patchStagesSucceeded,
  };
}

/**
 * All-path terminalizer. Worker faults become canonical terminal summaries;
 * the one exception is an unconfirmed DB commit, which throws a typed
 * resumable error and never invokes the summary projection worker. A failed
 * projection leaves the canonical row intact for idempotent retry.
 */
export async function finalizeTerminalRun(
  input: TerminalRunFinalizerInput,
): Promise<TerminalRunFinalizerResult> {
  let releaseRunLock: (() => Promise<void>) | null | undefined;
  try {
    releaseRunLock = await input.persistence.acquireRunLock?.(input.runId);
  } catch (error) {
    throw new TerminalRunCommitResumableError(input.runId, "unavailable", error);
  }
  if (releaseRunLock === null) throw new TerminalRunFinalizerBusyError(input.runId);

  try {
    return await finalizeTerminalRunWithLock(input);
  } finally {
    // Releasing ownership is housekeeping, not a second terminal decision.
    // A canonical result must never be hidden by an unlock/connection error.
    try {
      await releaseRunLock?.();
    } catch {
      // Session teardown still releases PostgreSQL advisory locks.
    }
  }
}

async function finalizeTerminalRunWithLock(
  input: TerminalRunFinalizerInput,
): Promise<TerminalRunFinalizerResult> {
  const now = input.now ?? (() => new Date());
  const workers = input.workers ?? {};
  const stageEvidence = new Map<TerminalRunSummaryStage, TerminalRunStageEvidence>();
  let snapshot: TerminalRunSnapshot | null = null;
  let state: TerminalRunState = "failed";
  let blocker: TerminalOperationalBlocker | null = null;
  let rootCause: TerminalRunRootCause | null = null;
  let cleanupError: string | null = null;
  let canonicalSummary: TerminalRunSummary | null = null;
  let terminalAlreadyCommitted = false;
  let activeStage: TerminalFinalizerStage = "preflight";

  const setStage = async (
    stage: TerminalFinalizerStage,
    status: TerminalStageStatus,
    evidence: Record<string, unknown> | null = null,
    error: string | null = null,
  ): Promise<void> => {
    const summaryStage = summaryStageFor(stage);
    const record = { stage: summaryStage, status, evidence, error };
    stageEvidence.set(summaryStage, record);
    await input.persistence.recordStage?.({
      runId: input.runId,
      stage,
      status,
      ...(evidence === null ? {} : { evidence }),
      ...(error === null ? {} : { error }),
    });
  };

  const failFrom = (stage: TerminalFinalizerStage, error: unknown): void => {
    if (rootCause !== null) return;
    if (error instanceof TerminalRunOperationalBlockerError) {
      blocker = error.blocker;
      state = "paused";
      rootCause = {
        kind: "operational_blocker",
        stage: summaryStageFor(stage),
        code: error.blocker.kind,
        message: error.blocker.detail,
      };
      return;
    }
    const message = errorMessage(error);
    state = "failed";
    rootCause = {
      kind:
        stage === "patch_build" || stage === "patch_apply" || stage === "validation"
          ? "patch_fault"
          : "itotori_defect",
      stage: summaryStageFor(stage),
      code: errorCode(error),
      message,
    };
  };

  const runStage = async (
    stage: TerminalFinalizerStage,
    beforeSuccess?: (result: TerminalPatchWorkerResult | void) => Promise<void>,
  ): Promise<TerminalPatchWorkerResult | void> => {
    activeStage = stage;
    if (durableStageSucceeded(requireSnapshot(snapshot, input.runId), stage)) return undefined;
    let result: TerminalPatchWorkerResult | void;
    try {
      const injected = input.stageFaults?.[stage];
      if (injected !== undefined) throw injected();
      result = await workers[stage]?.({
        runId: input.runId,
        snapshot: requireSnapshot(snapshot, input.runId),
        ...(canonicalSummary === null ? {} : { summary: canonicalSummary }),
      });
      await beforeSuccess?.(result);
    } catch (workerError) {
      // The worker fault is the root cause. Failure-evidence persistence is a
      // secondary fault and must never replace what actually broke the stage.
      failFrom(stage, workerError);
      try {
        // An operational blocker is deliberately resumable. Persist it as
        // pending-with-evidence rather than a terminal failed worker row, so
        // the same idempotency key can later become succeeded after resume.
        await setStage(
          stage,
          workerError instanceof TerminalRunOperationalBlockerError ? "pending" : "failed",
          null,
          errorMessage(workerError),
        );
      } catch {
        // The original stage error is already retained in the in-memory
        // evidence and root cause. The commit path may still persist it.
      }
      return undefined;
    }

    try {
      await setStage(stage, "succeeded", result?.evidence ?? null);
    } catch (persistenceError) {
      failFrom("persistence", persistenceError);
      return undefined;
    }
    return result;
  };

  try {
    // Preflight begins with a fresh durable projection, not an in-memory
    // executor report. This is why a stale report cannot manufacture success.
    snapshot = await input.persistence.loadSnapshot(input.runId);
    if (snapshot === null) {
      throw new Error(`terminal finalizer could not load durable run ${input.runId}`);
    }
    const supersedingPausedSummary =
      input.supersedePausedSummary === true && snapshot.runStatus === "paused";
    const existing =
      isTerminalRunState(snapshot.runStatus) &&
      !(input.cancelled && snapshot.runStatus === "paused") &&
      !supersedingPausedSummary
        ? await input.persistence.loadTerminalSummary(input.runId)
        : undefined;
    if (existing !== null && existing !== undefined) {
      // A paused executor run has no summary yet; a paused finalizer run does.
      // All other terminal states require this canonical record to exist.
      // A terminal retry only retries its summary outbox projection. It must
      // never rebuild/reapply a patch or mutate the terminal root cause.
      canonicalSummary = existing;
      state = existing.terminalStatus;
      rootCause = existing.rootCause;
      blocker = existing.blocker;
      terminalAlreadyCommitted = true;
    } else if (isTerminalRunState(snapshot.runStatus) && snapshot.runStatus !== "paused") {
      throw new Error(`terminal run ${input.runId} is missing its canonical summary`);
    } else {
      if (!durableStageSucceeded(snapshot, "preflight")) {
        const preflightFault = input.stageFaults?.preflight;
        if (preflightFault !== undefined) throw preflightFault();
        await setStage("preflight", "succeeded", {
          frozenUnitCount: snapshot.frozenUnits.length,
        });
      }

      if (input.cancelled) {
        state = "aborted";
        rootCause = {
          kind: "cancelled",
          stage: null,
          code: "explicit_cancellation",
          message: "run was explicitly cancelled by the operator",
        };
      } else if (snapshot.runStatus === "paused" || snapshot.blocker !== null) {
        state = "paused";
        blocker =
          snapshot.blocker ??
          coverageBlocker(snapshot, "run is paused pending operator action", now);
        rootCause = {
          kind: "operational_blocker",
          stage: "preflight",
          code: blocker.kind,
          message: blocker.detail,
        };
      } else {
        for (const stage of ["provider", "unit", "persistence"] as const) {
          await runStage(stage);
          if (rootCause !== null) break;
        }
        if (rootCause === null) {
          snapshot = await input.persistence.loadSnapshot(input.runId);
          if (snapshot === null)
            throw new Error(`terminal finalizer lost durable run ${input.runId}`);
          const coverage = evaluateTerminalRunCoverage(snapshot);
          if (!coverage.complete) {
            state = "paused";
            blocker = coverageBlocker(snapshot, coverageMessage(coverage), now);
            rootCause = {
              kind: "operational_blocker",
              stage: "persistence",
              code: "coverage_incomplete",
              message: blocker.detail,
            };
          }
        }
        if (rootCause === null) {
          activeStage = "patch_build";
          await input.persistence.enterFinalizing?.(input.runId);
          const coverage = evaluateTerminalRunCoverage(requireSnapshot(snapshot, input.runId));
          const memberships = coverage.frozenUnitIds.map((unitId) => {
            const outcome = requireSnapshot(snapshot, input.runId).outcomes.find(
              (candidate) => candidate.unitId === unitId,
            );
            if (outcome?.resultRevisionId === null || outcome?.resultRevisionId === undefined) {
              throw new Error(`coverage outcome ${unitId} lacks its result revision`);
            }
            return {
              unitId,
              outcomeId: outcome.outcomeId,
              resultRevisionId: outcome.resultRevisionId,
            };
          });
          const patch = await input.persistence.ensurePatchVersion?.({
            runId: input.runId,
            frozenUnitIds: coverage.frozenUnitIds,
            memberships,
            artifactHashes: {},
            artifactRefs: {},
          });
          if (patch !== undefined) snapshot = { ...requireSnapshot(snapshot, input.runId), patch };
          const persistPatchArtifacts = async (
            result: TerminalPatchWorkerResult | void,
          ): Promise<void> => {
            if (
              result === undefined ||
              (result.artifactHashes === undefined && result.artifactRefs === undefined) ||
              input.persistence.ensurePatchVersion === undefined
            )
              return;
            const ensured = await input.persistence.ensurePatchVersion({
              runId: input.runId,
              frozenUnitIds: coverage.frozenUnitIds,
              memberships,
              artifactHashes: result.artifactHashes ?? {},
              artifactRefs: result.artifactRefs ?? {},
            });
            snapshot = { ...requireSnapshot(snapshot, input.runId), patch: ensured };
          };
          await runStage("patch_build", persistPatchArtifacts);
          if (rootCause === null) await runStage("patch_apply", persistPatchArtifacts);
          if (rootCause === null) await runStage("validation", persistPatchArtifacts);
          if (rootCause === null) {
            activeStage = "validation";
            snapshot = await input.persistence.loadSnapshot(input.runId);
            if (snapshot === null)
              throw new Error(`terminal finalizer lost durable run ${input.runId}`);
            const finalCoverage = evaluateTerminalRunCoverage(snapshot, {
              requirePatch: true,
              // `completeSucceededRun` atomically flips building -> playable
              // after this durable coverage check. Requiring playable here would
              // be circular and would make success unreachable.
              requirePlayable: false,
            });
            if (!finalCoverage.complete) {
              throw new Error(
                `coverage-only success barrier failed: ${coverageMessage(finalCoverage)}`,
              );
            }
            state = "succeeded";
            rootCause = {
              kind: "completed",
              stage: null,
              code: "coverage_complete",
              message: "frozen run scope is complete and the patch is playable",
            };
          }
        }
      }
    }
  } catch (error) {
    failFrom(activeStage, error);
    try {
      if (!stageEvidence.has(summaryStageFor(activeStage))) {
        await setStage(activeStage, "failed", null, errorMessage(error));
      }
    } catch {
      // The root cause above remains authoritative when evidence persistence
      // independently fails.
    }
  } finally {
    try {
      if (snapshot !== null && !terminalAlreadyCommitted) {
        await runStage("cleanup");
        cleanupError = stageEvidence.get("cleanup")?.error ?? null;
      }
    } catch (error) {
      cleanupError = errorMessage(error);
      if (rootCause === null) failFrom("cleanup", error);
    }

    const finalSnapshot =
      (await safeLoadSnapshot(input.persistence, input.runId)) ??
      snapshot ??
      emptySnapshot(input.runId);
    if (!terminalAlreadyCommitted) {
      const effectiveCause = rootCause ?? {
        kind: "finalizer_fault" as const,
        stage: "cleanup" as const,
        code: "unknown_terminal_failure",
        message: "terminal finalizer exited without a terminal cause",
      };
      const effectiveBlocker = state === "paused" ? (blocker ?? finalSnapshot.blocker) : null;
      const provisional = buildTerminalRunSummary({
        snapshot: finalSnapshot,
        terminalStatus: state,
        rootCause: effectiveCause,
        blocker: effectiveBlocker,
        stages: mergeStages(finalSnapshot.stages, stageEvidence),
        cleanupError,
        now,
      });
      canonicalSummary = await commitTerminalWithReconciliation(input.persistence, {
        runId: input.runId,
        terminalStatus: state,
        rootCause: effectiveCause,
        blocker: effectiveBlocker,
        ...(finalSnapshot.patch === null
          ? {}
          : { patchVersionId: finalSnapshot.patch.patchVersionId }),
        ...(state === "paused" && input.supersedePausedSummary === true
          ? { supersedePausedSummary: true }
          : {}),
        summary: provisional,
      });
      // The terminal transaction can replace a previously-succeeded summary
      // outbox payload (for example paused epoch 1 -> succeeded epoch 2) and
      // reset it to pending. Refresh before deciding whether delivery may skip.
      snapshot = (await safeLoadSnapshot(input.persistence, input.runId)) ?? snapshot;
    }

    // The file is an outbox projection, never a second source of truth. A
    // projection failure is recorded but does not erase/downgrade the durable
    // terminal decision; the summary worker can retry idempotently.
    if (canonicalSummary !== null) {
      const summaryResult = await runStage("summary");
      void summaryResult;
    }
  }

  return {
    terminalStatus: requireCanonicalSummary(canonicalSummary, input.runId).terminalStatus,
    summary: requireCanonicalSummary(canonicalSummary, input.runId),
    committed: true,
  };
}

export function buildTerminalRunSummary(input: {
  snapshot: TerminalRunSnapshot;
  terminalStatus: TerminalRunState;
  rootCause: TerminalRunRootCause;
  blocker: TerminalOperationalBlocker | null;
  stages: TerminalRunStageEvidence[];
  cleanupError: string | null;
  now: () => Date;
}): TerminalRunSummary {
  const coverage = evaluateTerminalRunCoverage(input.snapshot);
  const validOutcomes = input.snapshot.outcomes.filter((outcome) => {
    const candidate = outcome.selectedCandidate;
    return candidate !== null && candidate.valid && candidate.body.trim().length > 0;
  });
  const patch = input.snapshot.patch;
  return {
    schemaVersion: TERMINAL_RUN_SUMMARY_SCHEMA_VERSION,
    runId: input.snapshot.runId,
    terminalStatus: input.terminalStatus,
    summaryEpoch: 1,
    rootCause: input.rootCause,
    blocker: input.blocker,
    coverage: {
      plannedUnitCount: coverage.frozenUnitIds.length,
      writtenOutcomeCount: input.snapshot.outcomes.length,
      validSelectedCandidateCount: validOutcomes.length,
      resultRevisionCount: input.snapshot.outcomes.filter(
        (outcome) => outcome.resultRevisionId !== null,
      ).length,
      missingUnitIds: coverage.missingUnitIds,
      duplicateOutcomeUnitIds: coverage.duplicateOutcomeUnitIds,
    },
    attempts: {
      totalCount: input.snapshot.attempts.length,
      runningCount: input.snapshot.attempts.filter((attempt) => attempt.lifecycle === "dispatching")
        .length,
      retryWaitingCount: input.snapshot.attempts.filter(
        (attempt) => attempt.lifecycle === "retry_waiting",
      ).length,
    },
    reservations: {
      totalCount: input.snapshot.reservations.length,
      reconciledCount: input.snapshot.reservations.filter(
        (reservation) => reservation.state === "reconciled",
      ).length,
      unresolvedCount: input.snapshot.reservations.filter(
        (reservation) => reservation.state !== "reconciled",
      ).length,
    },
    patch: {
      patchVersionId: patch?.patchVersionId ?? null,
      exactFrozenScope: coverage.patchExactFrozenScope,
      artifactHashes: { ...patch?.artifactHashes },
      artifactRefs: { ...patch?.artifactRefs },
      playable: patch?.playable === true,
    },
    stages: input.stages,
    quality: { ...input.snapshot.quality },
    cleanup: { error: input.cleanupError },
    generatedAt: input.now().toISOString(),
  };
}

function mergeStages(
  durable: TerminalRunStageEvidence[],
  current: ReadonlyMap<TerminalRunSummaryStage, TerminalRunStageEvidence>,
): TerminalRunStageEvidence[] {
  const byStage = new Map(durable.map((stage) => [stage.stage, stage] as const));
  for (const [stage, evidence] of current) byStage.set(stage, evidence);
  return terminalRunSummaryStageValues.map(
    (stage) => byStage.get(stage) ?? { stage, status: "skipped", evidence: null, error: null },
  );
}

function summaryStageFor(stage: TerminalFinalizerStage): TerminalRunSummaryStage {
  return stage === "patch_build" || stage === "patch_apply" ? "patch" : stage;
}

function durableStageSucceeded(
  snapshot: TerminalRunSnapshot,
  stage: TerminalFinalizerStage,
): boolean {
  if (stage === "patch_build") return snapshot.patch?.buildSucceeded === true;
  if (stage === "patch_apply") return snapshot.patch?.applySucceeded === true;
  if (stage === "validation" && snapshot.patch?.validationSucceeded === true) return true;
  const summaryStage = summaryStageFor(stage);
  return snapshot.stages.some(
    (evidence) => evidence.stage === summaryStage && evidence.status === "succeeded",
  );
}

const TERMINAL_COMMIT_ATTEMPT_LIMIT = 2;

async function commitTerminalWithReconciliation(
  persistence: TerminalRunFinalizerPersistencePort,
  input: Parameters<TerminalRunFinalizerPersistencePort["commitTerminal"]>[0],
): Promise<TerminalRunSummary> {
  let commitError: unknown = new Error("terminal commit was not attempted");
  for (let attempt = 0; attempt < TERMINAL_COMMIT_ATTEMPT_LIMIT; attempt += 1) {
    try {
      return await persistence.commitTerminal(input);
    } catch (error) {
      commitError = error;
      // A driver can lose its connection after PostgreSQL committed. Always
      // reconcile the canonical row before retrying or declaring the run
      // resumable; the database decision wins over the transport outcome.
      const committed = await loadConfirmedTerminalSummary(
        persistence,
        input.runId,
        input.terminalStatus,
      );
      if (committed !== null) return committed;
    }
  }

  const durable = await safeLoadSnapshot(persistence, input.runId);
  throw new TerminalRunCommitResumableError(
    input.runId,
    durable?.runStatus ?? "unavailable",
    commitError,
  );
}

async function loadConfirmedTerminalSummary(
  persistence: TerminalRunFinalizerPersistencePort,
  runId: string,
  expectedStatus: TerminalRunState,
): Promise<TerminalRunSummary | null> {
  try {
    const summary = await persistence.loadTerminalSummary(runId);
    if (summary === null || summary.terminalStatus !== expectedStatus) return null;
    const snapshot = await persistence.loadSnapshot(runId);
    return snapshot?.runStatus === summary.terminalStatus ? summary : null;
  } catch {
    return null;
  }
}

function requireCanonicalSummary(
  summary: TerminalRunSummary | null,
  runId: string,
): TerminalRunSummary {
  if (summary === null) {
    throw new TerminalRunCommitResumableError(
      runId,
      "unavailable",
      new Error("terminal commit returned without a canonical summary"),
    );
  }
  return summary;
}

function coverageMessage(coverage: TerminalCoverageEvaluation): string {
  const clauses: string[] = [];
  if (coverage.missingUnitIds.length > 0)
    clauses.push(`missing units=${coverage.missingUnitIds.join(",")}`);
  if (coverage.duplicateOutcomeUnitIds.length > 0)
    clauses.push(`duplicate outcomes=${coverage.duplicateOutcomeUnitIds.join(",")}`);
  if (coverage.runningAttemptIds.length > 0)
    clauses.push(`live attempts=${coverage.runningAttemptIds.join(",")}`);
  if (coverage.unreconciledReservationIds.length > 0)
    clauses.push(`unreconciled reservations=${coverage.unreconciledReservationIds.join(",")}`);
  if (!coverage.patchExactFrozenScope) clauses.push("patch does not exactly match frozen scope");
  if (!coverage.patchArtifactsPresent) clauses.push("patch artifacts/hashes are absent");
  if (!coverage.patchStagesSucceeded) clauses.push("patch build/apply/validation is incomplete");
  return clauses.length === 0 ? "coverage barrier is incomplete" : clauses.join("; ");
}

function coverageBlocker(
  snapshot: TerminalRunSnapshot,
  detail: string,
  now: () => Date,
): TerminalOperationalBlocker {
  return {
    kind: "itotori_bug",
    detail,
    evidence: `terminal-run:${snapshot.runId};frozen-units:${snapshot.frozenUnits.length}`,
    raisedAt: now().toISOString(),
    operatorAction: "resolve the durable blocker, then resume this run",
  };
}

function requireSnapshot(snapshot: TerminalRunSnapshot | null, runId: string): TerminalRunSnapshot {
  if (snapshot === null) throw new Error(`terminal finalizer has no durable snapshot for ${runId}`);
  return snapshot;
}

function isTerminalRunState(state: TerminalRunSnapshot["runStatus"]): state is TerminalRunState {
  return terminalRunStateValues.some((terminal) => terminal === state);
}

async function safeLoadSnapshot(
  persistence: TerminalRunFinalizerPersistencePort,
  runId: string,
): Promise<TerminalRunSnapshot | null> {
  try {
    return await persistence.loadSnapshot(runId);
  } catch {
    return null;
  }
}

function emptySnapshot(runId: string): TerminalRunSnapshot {
  return {
    runId,
    runStatus: "failed",
    blocker: null,
    frozenUnits: [],
    outcomes: [],
    attempts: [],
    reservations: [],
    patch: null,
    stages: [],
    quality: { findingCount: 0, contestedFindingCount: 0 },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.trim().length > 0) return code;
  }
  return error instanceof Error ? error.name : "terminal_finalizer_error";
}
