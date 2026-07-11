// itotori-execute-rerun-jobs — Repair-job EXECUTOR.
//
// `RepairJobService` (./repair-job-service.ts) is a PURE in-process queue: it
// accepts `RepairTrigger`s, mints typed `RepairJob`s, and exposes a
// `claimNext()` / `recordOutcome()` seam — but the service itself does NO IO,
// makes NO provider calls, and persists NOTHING. Its own header documents
// that "Production wiring layers an executor on top via `claimNext`." Before
// this module that executor did not exist: a scheduled rerun sat in the queue
// forever. Likewise `reviewer/repair-rerun-scheduler.ts` builds durable rerun
// job INPUTS, but nothing consumed them.
//
// This module IS that executor. It takes a CLAIMED `RepairJob` and actually
// RUNS the affected scope through the real draft + QA path
// (`runAgenticLoopForUnit` — the same per-unit executor the project-driven
// executor and localize-project-stage command drive), then PERSISTS the
// updated draft + the real billed provider-run cost. So a correction /
// feedback that schedules a rerun now produces a re-drafted, re-QA'd, persisted
// unit — not just a queued record.
//
// Generic to any project: the only project-specific knowledge (which bridge
// units map to which `LocalizationUnitV02`, the active glossary / style guide /
// scene context) lives behind the `RepairRerunUnitResolver` port the caller
// implements. The executor never references any title, engine, or game.
//
// Cost recording (PROJECT LAW / audit-no-hardcoded-cost): every recorded cent
// comes from the real per-invocation `usage.cost` the provider reported, summed
// verbatim from the bundle via `summariseProviderTelemetry` (the SAME helper
// the project-driven executor uses — no parallel representation). The executor
// NEVER fabricates or defaults a cost; a zero-cost (synthetic fake) provider is
// recorded as the real zero it produced.
//
// Determinism: for identical (job, deps) the executor drives units in the
// resolver's declared order, persists in that same order, and derives the
// terminal `RepairJobOutcome` from the loop's routing outcomes — so a replay
// produces byte-equal results.

import type { AuthorizationActor } from "@itotori/db";
import {
  runAgenticLoopForUnit,
  type AgenticLoopPolicy,
  type AgenticLoopProviderFactory,
  type AgenticLoopUnitInput,
  type PairPolicy,
} from "../agentic-loop.js";
import type { AgenticLoopReviewerQueueSink } from "../reviewer-queue-bridge.js";
import {
  summariseProviderTelemetry,
  type DrivenDraftRecord,
  type DrivenDraftSink,
  type DrivenProviderRunRecord,
  type DrivenProviderRunSink,
} from "../project-driven-executor.js";
import type { RepairJob, RepairJobOutcome } from "./types.js";
import { RepairJobService } from "./repair-job-service.js";

// ---------------------------------------------------------------------------
// Unit resolver — the project seam (generic, no game-specific code)
// ---------------------------------------------------------------------------

/**
 * Resolves a claimed `RepairJob`'s affected scope into the ready-to-run
 * `runAgenticLoopForUnit` inputs the executor drives. This is the ONLY
 * project-specific seam: the caller knows how a `bridgeUnitId` maps to a
 * `LocalizationUnitV02`, the active glossary / style guide, the surrounding
 * scene-context units, and the protected spans. The executor itself stays
 * project-agnostic.
 *
 * The resolver MUST honour the job's declared scope:
 *   - `bridge_units` / `scene` → resolve exactly the job's
 *     `affectedBridgeUnitIds` (one input per id).
 *   - `project` → resolve every in-scope unit for the project (the job
 *     carries no finite unit list by design — see `RepairAffectedWork`).
 * Returning an empty list is permitted (the job's scope was already empty /
 * every unit dropped out of scope); the executor records `outcome: "no_change"`
 * and persists nothing, mirroring the service's "nothing affected" semantics.
 */
export interface RepairRerunUnitResolver {
  resolveAffectedUnits(
    job: RepairJob,
    actor: AuthorizationActor,
  ): Promise<ReadonlyArray<AgenticLoopUnitInput>>;
}

// ---------------------------------------------------------------------------
// Executor dependencies + result
// ---------------------------------------------------------------------------

/**
 * Dependencies the executor needs to actually RUN a rerun. Mirrors the
 * project-driven executor's shape so the SAME persistence sinks + provider
 * factory + pair policy drive both first-pass translation and repair reruns.
 */
export type RepairJobExecutorDeps = {
  actor: AuthorizationActor;
  resolveUnits: RepairRerunUnitResolver;
  /** Run/bundle-level source revision registered for this repair rerun. */
  sourceRevisionId: string;
  /** Parsed pair-policy — every stage's (modelId, providerId) + posture. */
  pairPolicy: PairPolicy;
  /** The loop's tunables (project / locale / repair cap). */
  policy: AgenticLoopPolicy;
  /** Provider factory (live OpenRouter in production, fake in tests). */
  providerFactory: AgenticLoopProviderFactory;
  /**
   * The pinned repair pair recorded on every persisted provider-run row.
   * Mirrors `RepairJob.pair` (the repair leaf of the pair-policy); passed
   * explicitly so the executor records the SAME pair the driven executor does.
   */
  pair: { modelId: string; providerId: string };
  /**
   * Persistence sinks — the SAME `DrivenDraftSink` / `DrivenProviderRunSink`
   * the project-driven executor persists through (real DB adapter in
   * production, in-memory in tests). Reusing them means a repair rerun
   * persists a draft the SAME way a first-pass driven run does.
   */
  sinks: {
    draft: DrivenDraftSink;
    providerRun: DrivenProviderRunSink;
  };
  /**
   * Optional reviewer-queue sink. When present, a unit that the loop defers
   * during the rerun bridges a context-rich reviewer_queue_items row (the
   * repair could not auto-resolve it), exactly as a driven run does.
   */
  reviewerQueue?: AgenticLoopReviewerQueueSink;
  log?: (message: string) => void;
};

/**
 * Details of ONE unit whose loop threw during a rerun (per-unit isolation).
 * Captured so a `partial_failure` outcome never hides which unit failed or why
 * — the executor surfaces this list on {@link RepairJobExecutionResult.failures}
 * rather than swallowing the error after counting it.
 */
export type RepairUnitFailure = {
  bridgeUnitId: string;
  sourceUnitKey: string;
  /** Isolated error message (the thrown error's `.message`, or stringified). */
  message: string;
};

/**
 * Result of executing ONE claimed `RepairJob`. The terminal `outcome` is what
 * the caller passes back to `RepairJobService.recordOutcome` so the append-only
 * history reflects the real run, not just the enqueue.
 */
export type RepairJobExecutionResult = {
  outcome: RepairJobOutcome;
  /** Units the resolver produced for the job's scope. */
  unitsResolved: number;
  /** Units whose loop actually ran + persisted a draft. */
  unitsRun: number;
  acceptedDraftCount: number;
  deferredCount: number;
  /** Units whose loop threw (isolated); their draft stays untouched. */
  failureCount: number;
  /**
   * Details of each unit whose loop threw (isolated), in the resolver's
   * declared run order. Non-empty iff `failureCount > 0` (i.e. the outcome is
   * `partial_failure`); carries the sourceUnitKey + error message so the
   * failure that downgraded the outcome from `succeeded` is never hidden.
   */
  failures: RepairUnitFailure[];
  /**
   * Real billed cost summed verbatim from every invocation the rerun fired
   * (PROJECT LAW). Zero for a synthetic fake provider; never fabricated.
   */
  totalCostUsd: number;
  /** True iff EVERY invocation carried `zdr:true` on the wire. */
  zdrConfirmed: boolean;
};

// ---------------------------------------------------------------------------
// Execute a single claimed job
// ---------------------------------------------------------------------------

/**
 * EXECUTE a claimed `RepairJob`: resolve its affected scope, run each unit
 * through the real draft + QA agentic loop, persist the updated draft + the
 * real billed provider-run cost, and return the terminal outcome.
 *
 * Per-unit isolation: a single unit's failure (e.g. a malformed provider pack)
 * is caught and counted; the remaining units still run and persist. This
 * mirrors the project-driven executor's robustness contract — one bad unit
 * never aborts the rerun.
 *
 * The caller is expected to have `claimNext()`-ed the job from a
 * `RepairJobService` and to `recordOutcome(jobId, result.outcome)` afterwards
 * (see {@link runRepairQueue} for the loop that ties them together). This
 * function does NOT touch the service: it only runs + persists, keeping the
 * pure service free of IO.
 */
export async function executeRepairJob(
  job: RepairJob,
  deps: RepairJobExecutorDeps,
): Promise<RepairJobExecutionResult> {
  const log = deps.log ?? (() => {});
  const unitInputs = await deps.resolveUnits.resolveAffectedUnits(job, deps.actor);
  if (unitInputs.length === 0) {
    log(
      `repair-job-executor: job ${job.jobId} (${job.affectedScope}) resolved zero units -> no_change`,
    );
    return {
      outcome: "no_change",
      unitsResolved: 0,
      unitsRun: 0,
      acceptedDraftCount: 0,
      deferredCount: 0,
      failureCount: 0,
      failures: [],
      totalCostUsd: 0,
      zdrConfirmed: true,
    };
  }

  let unitsRun = 0;
  let acceptedDraftCount = 0;
  let deferredCount = 0;
  let failureCount = 0;
  let totalCostUsd = 0;
  let zdrConfirmed = true;
  let sawInvocation = false;
  const failures: RepairUnitFailure[] = [];

  // itotori-repair-outcome — thread the rerun's reviewer-queue sink into EACH
  // unit input the resolver produced (when the resolver didn't already wire
  // one), mirroring the project-driven executor. Without this, a unit the loop
  // DEFERS during a rerun would never bridge a reviewer_queue_items row — the
  // reviewerQueue dep was documented but never reached `runAgenticLoopForUnit`.
  const reviewerQueue = deps.reviewerQueue;

  for (const resolvedInput of unitInputs) {
    const unitInput: AgenticLoopUnitInput = {
      ...resolvedInput,
      sourceRevisionId: deps.sourceRevisionId,
      ...(reviewerQueue !== undefined && resolvedInput.reviewerQueue === undefined
        ? { reviewerQueue }
        : {}),
    };
    const result = await runRepairUnit(unitInput, job, deps, log);
    if (result.status === "failed") {
      // Per-unit isolation: the loop threw; the unit's draft stays untouched.
      failureCount += 1;
      failures.push(result.failure);
      continue;
    }
    unitsRun += 1;
    totalCostUsd += result.telemetry.totalCostUsd;
    if (result.telemetry.invocationCount > 0) {
      sawInvocation = true;
    }
    zdrConfirmed = zdrConfirmed && result.telemetry.zdr;
    if (result.accepted) {
      acceptedDraftCount += 1;
    } else {
      deferredCount += 1;
    }
  }

  // Derive the terminal RepairJobOutcome from the loop's per-unit outcomes.
  // A rerun where ANY unit's loop THREW (isolated) is terminally NON-successful
  // — recorded as `partial_failure` with the failed-unit details on
  // `result.failures` — so a mixed accept+fail rerun never reads as a clean
  // success and the failures are never hidden. The deferred + no_change +
  // fully-succeeded paths are unchanged when no unit failed: a job whose every
  // resolved unit produced an accepted (or repaired-then-accepted) draft
  // SUCCEEDED; a job where any unit deferred (the loop could not auto-resolve
  // it) hands the affected scope back to human triage. The `cap_exhausted`
  // outcome is owned by the loop's own bounded-repair cap (recorded as a
  // per-unit defer); it surfaces here as deferred_to_human.
  const outcome: RepairJobOutcome =
    failureCount > 0
      ? "partial_failure"
      : deferredCount > 0
        ? "deferred_to_human"
        : acceptedDraftCount > 0
          ? "succeeded"
          : "no_change";

  log(
    `repair-job-executor: job ${job.jobId} (${job.affectedScope}) ran ${unitsRun} unit(s); ` +
      `${acceptedDraftCount} accepted, ${deferredCount} deferred, ${failureCount} failed -> ${outcome}`,
  );

  return {
    outcome,
    unitsResolved: unitInputs.length,
    unitsRun,
    acceptedDraftCount,
    deferredCount,
    failureCount,
    failures,
    totalCostUsd,
    // A job that fired zero invocations cannot assert a ZDR posture.
    zdrConfirmed: sawInvocation ? zdrConfirmed : true,
  };
}

// ---------------------------------------------------------------------------
// Per-unit run — invoke the real draft + QA executor + persist
// ---------------------------------------------------------------------------

type RepairUnitRunResult = {
  accepted: boolean;
  telemetry: ReturnType<typeof summariseProviderTelemetry>;
};

/**
 * Per-unit run outcome. PER-UNIT ISOLATION surfaces a thrown error (incl. a
 * malformed provider pack) as `failed` — carrying the failed unit's identity +
 * error message — so the caller can record a `partial_failure` outcome WITH the
 * failed-unit details rather than swallowing the error after counting it. The
 * failing unit's draft stays byte-untouched either way; the other units still
 * run.
 */
type RepairUnitRunOutcome =
  | ({ status: "ran" } & RepairUnitRunResult)
  | { status: "failed"; failure: RepairUnitFailure };

/**
 * Drive ONE affected unit through the real agentic loop (`runAgenticLoopForUnit`)
 * and persist its updated draft + real billed provider-run cost. PER-UNIT
 * ISOLATION: a thrown error (incl. a malformed provider pack) is caught and
 * surfaced as a `failed` outcome (carrying the failed unit's identity + error
 * message) so the job's other units still run — the failing unit's draft stays
 * byte-untouched — AND the caller can record a `partial_failure` outcome with
 * the failed-unit details rather than swallowing the error after counting it.
 * Returns whether the unit's draft was accepted (re-drafted /
 * repaired-then-accepted) or deferred.
 */
async function runRepairUnit(
  unitInput: AgenticLoopUnitInput,
  job: RepairJob,
  deps: RepairJobExecutorDeps,
  log: (message: string) => void,
): Promise<RepairUnitRunOutcome> {
  const unit = unitInput.unit;
  try {
    const bundle = await runAgenticLoopForUnit(
      unitInput,
      deps.pairPolicy,
      deps.policy,
      deps.providerFactory,
    );

    const accepted = bundle.finalDraft.draftText !== undefined;

    // PERSIST the updated draft FIRST. The provider-run ledger's FK references
    // the draft attempt the sink creates, so the draft must land before the
    // provider-run row (mirrors the project-driven executor's ordering).
    const draftRecord: DrivenDraftRecord = {
      bridgeUnitId: unit.bridgeUnitId,
      sourceUnitKey: unit.sourceUnitKey,
      sceneId: unitInput.sceneId,
      outcome: bundle.routingSummary.outcome,
      accepted,
      targetLocale: deps.policy.targetLocale,
      draftText: bundle.finalDraft.draftText,
      deferredReason: bundle.finalDraft.deferredReason,
    };
    await deps.sinks.draft.persistDraft(draftRecord);

    // PERSIST the provider-run summary — real usage.cost + ZDR, summed verbatim
    // from the bundle the loop produced (PROJECT LAW: cost only from real
    // provider output, never fabricated).
    const telemetry = summariseProviderTelemetry(bundle, job.pair);
    const providerRunRecord: DrivenProviderRunRecord = {
      bridgeUnitId: unit.bridgeUnitId,
      ...telemetry,
    };
    await deps.sinks.providerRun.persistProviderRun(providerRunRecord);

    return { status: "ran", accepted, telemetry };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(
      `repair-job-executor: unit ${unit.sourceUnitKey} in job ${job.jobId} FAILED (isolated, rerun continues): ${message}`,
    );
    return {
      status: "failed",
      failure: {
        bridgeUnitId: unit.bridgeUnitId,
        sourceUnitKey: unit.sourceUnitKey,
        message,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Drain the whole repair queue — claimNext -> execute -> recordOutcome
// ---------------------------------------------------------------------------

export type RepairQueueRunResult = {
  jobsRun: number;
  succeeded: number;
  /** Jobs that ended `partial_failure` (at least one unit's loop threw). */
  partialFailure: number;
  deferredToHuman: number;
  noChange: number;
  /** Real billed cost summed across every job the run drained. */
  totalCostUsd: number;
};

/**
 * Drain a `RepairJobService`'s queue, EXECUTING each claimed job through
 * {@link executeRepairJob} and recording its terminal outcome on the service's
 * append-only history via `recordOutcome`. This is the seam the service's
 * header documents ("Production wiring layers an executor on top via
 * `claimNext`"): it turns a pure queue of scheduled reruns into ACTUAL
 * orchestrator work that re-drafts / re-QAs the affected scope and persists
 * the updated draft.
 *
 * The loop is the only place the executor touches the (pure) service: it
 * claims, executes, and records — so the service stays free of IO while every
 * job's history reflects the real run, not just the enqueue.
 */
export async function runRepairQueue(
  service: RepairJobService,
  deps: RepairJobExecutorDeps,
): Promise<RepairQueueRunResult> {
  let jobsRun = 0;
  let succeeded = 0;
  let partialFailure = 0;
  let deferredToHuman = 0;
  let noChange = 0;
  let totalCostUsd = 0;

  for (;;) {
    const job = service.claimNext();
    if (job === undefined) {
      break;
    }
    const result = await executeRepairJob(job, deps);
    service.recordOutcome(job.jobId, result.outcome);
    jobsRun += 1;
    totalCostUsd += result.totalCostUsd;
    switch (result.outcome) {
      case "succeeded":
        succeeded += 1;
        break;
      case "partial_failure":
        partialFailure += 1;
        break;
      case "deferred_to_human":
        deferredToHuman += 1;
        break;
      case "no_change":
        noChange += 1;
        break;
      // `cap_exhausted` is owned by the loop's bounded-repair cap (it surfaces
      // as a per-unit defer -> deferred_to_human above); keeping this exhaustive
      // so adding a new outcome without handling it here is a compile error.
      case "cap_exhausted":
        deferredToHuman += 1;
        break;
      default: {
        const _exhaustive: never = result.outcome;
        throw new Error(`repair-job-executor: unexpected outcome ${String(_exhaustive)}`);
      }
    }
  }

  return { jobsRun, succeeded, partialFailure, deferredToHuman, noChange, totalCostUsd };
}
