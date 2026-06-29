// ITOTORI-038 — Repair-job service.
//
// In-process, event-driven repair queue. Accepts `RepairTrigger`s,
// emits typed `RepairJob` records, and records an append-only
// `RepairEvent` history. The service is a SKELETON — it does NOT
// execute reruns. Execution is the orchestrator's responsibility
// (ITOTORI-222 already owns the bounded-repair loop inside the
// agentic-loop); this module is the seam that turns findings +
// human decisions into the typed jobs the loop consumes.
//
// Hard rules (ITOTORI-038 audit-focus):
//   - Pipeline-only reruns. Every `RepairJob` declares one
//     `pipelineStage` + the exact set of `affectedBridgeUnitIds`. The
//     service refuses to enqueue a job whose scope is `project`
//     unless the trigger is a `human_decision` that explicitly opted
//     in.
//   - Lost repair provenance. Every state change appends a
//     `RepairEvent` to the history; the events are immutable and
//     surfaced through `repairHistory()`. The (modelId, providerId)
//     pair is recorded verbatim on each job.
//   - Over-broad invalidation. Severity below `p2` is rejected so a
//     noisy P3 finding cannot consume repair budget. The selector
//     (./affected-work-selector.ts) does the narrowing; this service
//     enforces the rules around it.
//
// The service is pure: there is no IO, no DB, no provider invocation.
// Production wiring layers an executor on top via `claimNext`.

import { createHash } from "node:crypto";
import { selectAffectedWork, type RepairSceneIndex } from "./affected-work-selector.js";
import {
  REPAIR_JOB_SEVERITIES,
  type RepairEvent,
  type RepairJob,
  type RepairJobOutcome,
  type RepairJobSeverity,
  type RepairProviderPair,
  type RepairTrigger,
} from "./types.js";

export type RepairJobServiceClock = () => Date;

export type RepairJobServiceOptions = {
  /**
   * Deterministic clock. Tests pass a tick counter; production wires
   * `() => new Date()`. Defaults to the system clock.
   */
  now?: RepairJobServiceClock;
  /**
   * Optional scene index for `human_decision` triggers whose scope is
   * `scene`. Omitting it is fine when no human decision ever asks for
   * a scene-wide rerun; the service throws a typed error if a `scene`
   * trigger arrives without one.
   */
  sceneIndex?: RepairSceneIndex;
  /**
   * Minimum severity the service accepts. Defaults to `p1` — the
   * spec's acceptance criterion ("P0/P1 findings can trigger targeted
   * repair jobs") makes p1 the strictest threshold the orchestrator
   * is required to honor. Production callers can widen to `p2` when
   * they want noisier triggers to count.
   */
  minimumSeverity?: RepairJobSeverity;
};

export class RepairJobServiceError extends Error {
  constructor(
    public readonly code:
      | "missing_pair"
      | "below_minimum_severity"
      | "scene_scope_requires_scene_index"
      | "not_in_flight",
    message: string,
  ) {
    super(message);
    this.name = "RepairJobServiceError";
  }
}

export type EnqueueRepairJobInput = {
  trigger: RepairTrigger;
  /**
   * Pinned (modelId, providerId) pair the rerun MUST use. Production
   * callers pass `pairPolicy.repair.primary.pair` here. The service
   * NEVER defaults — empty strings throw `missing_pair`.
   */
  pair: RepairProviderPair;
  /**
   * Optional id of the predecessor job. Set when a previous rerun's
   * output spawned a new finding so the dashboard can render the
   * repair chain without re-walking history.
   */
  parentJobId?: string;
};

export class RepairJobService {
  private readonly now: RepairJobServiceClock;
  private readonly sceneIndex: RepairSceneIndex | undefined;
  private readonly minimumSeverity: RepairJobSeverity;
  private readonly queue: RepairJob[] = [];
  private readonly history: RepairEvent[] = [];
  private readonly inflight = new Set<string>();
  private readonly completed = new Map<string, RepairJobOutcome>();
  private jobCounter = 0;

  constructor(options: RepairJobServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.sceneIndex = options.sceneIndex;
    this.minimumSeverity = options.minimumSeverity ?? "p1";
  }

  /**
   * Convert a trigger into a queued `RepairJob`. Returns the job so
   * callers can join the record to the originating finding without
   * scanning the queue. Throws on missing pair / below-severity /
   * empty-scope inputs — every refusal carries a typed code.
   */
  enqueue(input: EnqueueRepairJobInput): RepairJob {
    assertPair(input.pair);
    assertSeverity(input.trigger.severity, this.minimumSeverity);

    const selection =
      input.trigger.trigger === "human_decision" && input.trigger.scope.kind === "scene"
        ? this.requireSceneIndexAndSelect(input.trigger)
        : selectAffectedWork(input.trigger, this.sceneIndex);

    const enqueuedAt = this.now();
    this.jobCounter += 1;
    const jobId = this.mintJobId(input.trigger, this.jobCounter);
    const job: RepairJob = {
      jobId,
      trigger: input.trigger,
      pipelineStage: selection.pipelineStage,
      affectedScope: selection.affectedScope,
      affectedBridgeUnitIds: selection.affectedBridgeUnitIds,
      pair: { modelId: input.pair.modelId, providerId: input.pair.providerId },
      enqueuedAt,
      severity: input.trigger.severity,
      ...(input.parentJobId !== undefined ? { parentJobId: input.parentJobId } : {}),
      priority: priorityFromSeverity(input.trigger.severity),
      rationale: rationaleFor(input.trigger),
    };
    this.queue.push(job);
    // Stable priority sort: lower numeric priority first; ties broken by
    // enqueue time so older jobs drain first.
    this.queue.sort(compareJobs);
    this.history.push({ kind: "job_enqueued", jobId, at: enqueuedAt, job });
    return job;
  }

  /**
   * Pop the next job in priority order. Returns `undefined` when the
   * queue is empty. The popped job is marked in-flight so subsequent
   * `claimNext` calls don't return the same id.
   */
  claimNext(): RepairJob | undefined {
    const job = this.queue.shift();
    if (job === undefined) {
      return undefined;
    }
    this.inflight.add(job.jobId);
    this.history.push({ kind: "job_started", jobId: job.jobId, at: this.now() });
    return job;
  }

  /**
   * Mark an in-flight job complete. The caller passes the rerun's
   * terminal outcome (mirrored from the agentic-loop's routing
   * summary); the service records it on the history but does NOT
   * re-enqueue anything. Subsequent reruns require a fresh trigger.
   */
  recordOutcome(jobId: string, outcome: RepairJobOutcome): void {
    if (!this.inflight.has(jobId)) {
      throw new RepairJobServiceError(
        "not_in_flight",
        `recordOutcome called for jobId='${jobId}' which is not in-flight`,
      );
    }
    this.inflight.delete(jobId);
    this.completed.set(jobId, outcome);
    this.history.push({ kind: "job_completed", jobId, at: this.now(), outcome });
  }

  /**
   * Drop a queued or in-flight job. Used when the orchestrator
   * decides — out-of-band — that the trigger no longer applies (e.g.
   * the human decision was rescinded). The drop is recorded with a
   * reason so the audit trail can show why the job never ran.
   */
  drop(jobId: string, reason: string): void {
    const queueIdx = this.queue.findIndex((j) => j.jobId === jobId);
    if (queueIdx >= 0) {
      this.queue.splice(queueIdx, 1);
    } else if (!this.inflight.has(jobId)) {
      return;
    } else {
      this.inflight.delete(jobId);
    }
    this.history.push({ kind: "job_dropped", jobId, at: this.now(), reason });
  }

  /**
   * Snapshot of the pending queue, ordered by claim priority. Pure
   * accessor — does NOT mutate state.
   */
  pending(): ReadonlyArray<RepairJob> {
    return this.queue.slice();
  }

  /**
   * Append-only event history. Surfaces every state transition the
   * service has observed since construction so the dashboard can
   * reconstruct the repair lineage without rejoining inputs.
   */
  repairHistory(): ReadonlyArray<RepairEvent> {
    return this.history.slice();
  }

  /**
   * Look up a job's terminal outcome. Returns `undefined` while the
   * job is still queued or in-flight.
   */
  outcomeOf(jobId: string): RepairJobOutcome | undefined {
    return this.completed.get(jobId);
  }

  private requireSceneIndexAndSelect(
    trigger: RepairTrigger,
  ): ReturnType<typeof selectAffectedWork> {
    if (this.sceneIndex === undefined) {
      throw new RepairJobServiceError(
        "scene_scope_requires_scene_index",
        "human decision scope='scene' requires a sceneIndex on RepairJobService construction",
      );
    }
    return selectAffectedWork(trigger, this.sceneIndex);
  }

  private mintJobId(trigger: RepairTrigger, counter: number): string {
    // Deterministic id derived from trigger + counter so a replay
    // produces byte-equal job ids. The counter prevents collisions
    // across two QA findings that share the same bridge unit.
    const seed = `${trigger.trigger}|${triggerStableKey(trigger)}|${counter}`;
    const digest = createHash("sha256").update(seed).digest("hex");
    return `repair-job-${digest.slice(0, 16)}`;
  }
}

function assertPair(pair: RepairProviderPair): void {
  if (typeof pair.modelId !== "string" || pair.modelId.length === 0) {
    throw new RepairJobServiceError(
      "missing_pair",
      "repair job refused: pair.modelId is required and must be non-empty",
    );
  }
  if (typeof pair.providerId !== "string" || pair.providerId.length === 0) {
    throw new RepairJobServiceError(
      "missing_pair",
      "repair job refused: pair.providerId is required and must be non-empty",
    );
  }
}

function assertSeverity(severity: RepairJobSeverity, minimum: RepairJobSeverity): void {
  const order: Record<RepairJobSeverity, number> = { p0: 0, p1: 1, p2: 2 };
  if (order[severity] > order[minimum]) {
    throw new RepairJobServiceError(
      "below_minimum_severity",
      `repair job refused: severity='${severity}' is below minimum='${minimum}'`,
    );
  }
  // Belt-and-suspenders: every enum value must appear in the order
  // table. Adding a new severity without extending the table is a
  // runtime error here AND a compile-time error at the type level.
  for (const known of REPAIR_JOB_SEVERITIES) {
    if (!(known in order)) {
      throw new RepairJobServiceError(
        "below_minimum_severity",
        `repair job refused: severity table is missing '${known}'`,
      );
    }
  }
}

function priorityFromSeverity(severity: RepairJobSeverity): number {
  switch (severity) {
    case "p0":
      return 0;
    case "p1":
      return 1;
    case "p2":
      return 2;
    default:
      return assertNever(severity);
  }
}

function rationaleFor(trigger: RepairTrigger): string {
  switch (trigger.trigger) {
    case "qa_finding":
      return `QA finding ${trigger.findingId} on bridge unit ${trigger.bridgeUnitId} (severity=${trigger.severity}): ${trigger.rationale}`;
    case "protected_span_violation":
      return `protected-span violation ${trigger.violationId} on bridge unit ${trigger.bridgeUnitId} (severity=${trigger.severity}): ${trigger.rationale}`;
    case "human_decision":
      return `human decision ${trigger.decisionId} (severity=${trigger.severity}, scope=${trigger.scope.kind}): ${trigger.rationale}`;
    default:
      return assertNever(trigger);
  }
}

function triggerStableKey(trigger: RepairTrigger): string {
  switch (trigger.trigger) {
    case "qa_finding":
      return `${trigger.findingId}|${trigger.bridgeUnitId}|${trigger.targetStage}`;
    case "protected_span_violation":
      return `${trigger.violationId}|${trigger.bridgeUnitId}`;
    case "human_decision":
      return `${trigger.decisionId}|${trigger.scope.kind}|${trigger.targetStage}`;
    default:
      return assertNever(trigger);
  }
}

function compareJobs(a: RepairJob, b: RepairJob): number {
  if (a.priority !== b.priority) {
    return a.priority - b.priority;
  }
  return a.enqueuedAt.getTime() - b.enqueuedAt.getTime();
}

function assertNever(value: never): never {
  throw new Error(`repair-job service: unexpected union value ${String(value)}`);
}
