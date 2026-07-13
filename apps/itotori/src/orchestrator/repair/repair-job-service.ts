// ITOTORI-038 — Repair-job service.
//
// In-process, event-driven repair queue. Accepts `RepairTrigger`s,
// emits typed `RepairJob` records, and records an append-only
// `RepairEvent` history. The service is a SKELETON — it does NOT
// execute reruns. Execution is the orchestrator's responsibility
// (ITOTORI-222 already owns the bounded-repair loop inside the
// agentic-loop); this module is the seam that turns findings +
// machine-verifiable findings into the typed jobs the loop consumes.
//
// Hard rules (ITOTORI-038 audit-focus):
//   - Pipeline-only reruns. Every `RepairJob` declares one
//     `pipelineStage` + the exact set of `affectedBridgeUnitIds`. The
//     service only enqueues the bridge units named by the trigger.
//   - Lost repair provenance. Every state change appends a
//     `RepairEvent` to the history; the events are immutable and
//     surfaced through `repairHistory()`. The (modelId, providerId)
//     pair is recorded verbatim on each job.
//   - Over-broad invalidation. `minimumSeverity` defaults to `p1`, so a
//     `p2` finding is rejected unless a caller explicitly widens the
//     threshold to `p2`; that keeps noisy sub-blocking findings from
//     consuming repair budget. (`REPAIR_JOB_SEVERITIES` is `p0|p1|p2`;
//     there is no `p3`.) The selector (./affected-work-selector.ts) does
//     the narrowing; this service enforces the rules around it.
//
// The service is pure: there is no IO, no DB, no provider invocation.
// Production wiring layers an executor on top via `claimNext`.

import { createHash, randomUUID } from "node:crypto";
import { selectAffectedWork, type AffectedWorkSelection } from "./affected-work-selector.js";
import {
  type RepairAffectedWork,
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
   * Minimum severity the service accepts. Defaults to `p1` — the
   * spec's acceptance criterion ("P0/P1 findings can trigger targeted
   * repair jobs") makes p1 the strictest threshold the orchestrator
   * is required to honor. Production callers can widen to `p2` when
   * they want noisier triggers to count.
   */
  minimumSeverity?: RepairJobSeverity;
  /**
   * Per-instance entropy folded into every minted jobId. Defaults to a
   * fresh `randomUUID()` so two RepairJobService instances that ingest
   * overlapping triggers at the same counter slot never mint colliding
   * jobIds — a caller merging histories from two services stays
   * collision-free. Pass a FIXED value to make jobIds byte-reproducible
   * across a replay of the same service.
   */
  instanceId?: string;
};

export class RepairJobServiceError extends Error {
  constructor(
    public readonly code:
      | "missing_pair"
      | "below_minimum_severity"
      | "not_in_flight"
      | "unknown_job_id"
      | "unknown_parent_job_id",
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
  private readonly minimumSeverity: RepairJobSeverity;
  private readonly instanceId: string;
  private readonly queue: RepairJob[] = [];
  private readonly history: RepairEvent[] = [];
  private readonly inflight = new Set<string>();
  private readonly completed = new Map<string, RepairJobOutcome>();
  /**
   * Every jobId this service has ever minted, retained across the job's
   * whole lifecycle (queued → in-flight → completed → dropped). A
   * `parentJobId` is validated against this set so the repair chain can
   * never dangle past a job the service actually saw.
   */
  private readonly knownJobIds = new Set<string>();
  private jobCounter = 0;

  constructor(options: RepairJobServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.minimumSeverity = options.minimumSeverity ?? "p1";
    this.instanceId = options.instanceId ?? randomUUID();
  }

  /**
   * Convert a trigger into a queued `RepairJob`. Returns the job so
   * callers can join the record to the originating finding without
   * scanning the queue. Throws on missing pair / below-severity /
   * empty-scope / dangling-parent inputs — every refusal carries a
   * typed code.
   */
  enqueue(input: EnqueueRepairJobInput): RepairJob {
    assertPair(input.pair);
    assertSeverity(input.trigger.severity, this.minimumSeverity);
    this.assertKnownParent(input.parentJobId);

    const selection = selectAffectedWork(input.trigger);

    const enqueuedAt = this.now();
    this.jobCounter += 1;
    const jobId = this.mintJobId(input.trigger, this.jobCounter);
    const job: RepairJob = {
      jobId,
      trigger: input.trigger,
      pipelineStage: selection.pipelineStage,
      ...affectedWorkOf(selection),
      pair: { modelId: input.pair.modelId, providerId: input.pair.providerId },
      enqueuedAt,
      severity: input.trigger.severity,
      ...(input.parentJobId !== undefined ? { parentJobId: input.parentJobId } : {}),
      priority: priorityFromSeverity(input.trigger.severity),
      rationale: rationaleFor(input.trigger),
    };
    this.knownJobIds.add(jobId);
    this.queue.push(job);
    // Stable priority sort: lower numeric priority first; ties broken by
    // enqueue time so older jobs drain first.
    this.queue.sort(compareJobs);
    // Embed an independent deep copy of the job in the append-only history
    // so that mutating the queued job OR the value returned to the caller
    // can never retroactively edit history. The readonly types discourage
    // mutation; the structural guarantee must not depend on them.
    this.history.push({
      kind: "job_enqueued",
      jobId,
      at: enqueuedAt,
      job: structuredClone(job),
    });
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
   * decides — out-of-band — that the trigger no longer applies. The drop is recorded with a
   * reason so the audit trail can show why the job never ran.
   *
   * A jobId that is neither queued nor in-flight throws a typed
   * `unknown_job_id` error — matching `recordOutcome`'s convention for
   * unknown ids. Silently returning would let a typo'd/stale jobId
   * swallow the operation with no record in the audit history.
   */
  drop(jobId: string, reason: string): void {
    const queueIdx = this.queue.findIndex((j) => j.jobId === jobId);
    if (queueIdx >= 0) {
      this.queue.splice(queueIdx, 1);
    } else if (this.inflight.has(jobId)) {
      this.inflight.delete(jobId);
    } else {
      throw new RepairJobServiceError(
        "unknown_job_id",
        `drop called for jobId='${jobId}' which is neither queued nor in-flight`,
      );
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
   *
   * Each event is deep-copied on emit so a caller that mutates the
   * returned snapshot — including the `RepairJob` embedded in a
   * `job_enqueued` event — cannot retroactively edit the internal,
   * append-only history.
   */
  repairHistory(): ReadonlyArray<RepairEvent> {
    return this.history.map((event) => structuredClone(event));
  }

  /**
   * Look up a job's terminal outcome. Returns `undefined` while the
   * job is still queued or in-flight.
   */
  outcomeOf(jobId: string): RepairJobOutcome | undefined {
    return this.completed.get(jobId);
  }

  /**
   * Reject a `parentJobId` that points at a job this service never
   * minted. Accepting it verbatim would dangle the repair chain the
   * dashboard reconstructs from `parentJobId` (types.ts), so a typo'd
   * or stale id surfaces a typed `unknown_parent_job_id` error rather
   * than silently breaking provenance — matching `drop()` /
   * `recordOutcome`'s convention for unknown ids.
   */
  private assertKnownParent(parentJobId: string | undefined): void {
    if (parentJobId === undefined) {
      return;
    }
    if (!this.knownJobIds.has(parentJobId)) {
      throw new RepairJobServiceError(
        "unknown_parent_job_id",
        `enqueue refused: parentJobId='${parentJobId}' does not reference a job this service ever minted`,
      );
    }
  }

  private mintJobId(trigger: RepairTrigger, counter: number): string {
    // Id derived from the per-instance entropy seed + trigger + counter.
    // The counter prevents collisions across two QA findings that share the
    // same bridge unit; `instanceId` prevents collisions across two distinct
    // service instances that ingest overlapping triggers at the same counter
    // slot. Seeding a service with a FIXED `instanceId` makes a replay
    // produce byte-equal job ids.
    const seed = `${this.instanceId}|${trigger.trigger}|${triggerStableKey(trigger)}|${counter}`;
    const digest = createHash("sha256").update(seed).digest("hex");
    return `repair-job-${digest.slice(0, 16)}`;
  }
}

/**
 * Project the discriminated affected-work descriptor out of a selection
 * so it can be spread onto a `RepairJob`. The exhaustive switch keeps the
 * unit-scoped selection onto a `RepairJob`.
 */
function affectedWorkOf(selection: AffectedWorkSelection): RepairAffectedWork {
  return {
    affectedScope: selection.affectedScope,
    affectedBridgeUnitIds: selection.affectedBridgeUnitIds,
  };
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
  // `order` is keyed by `Record<RepairJobSeverity, number>`, so adding a
  // severity to `REPAIR_JOB_SEVERITIES` without a rank here is a
  // compile-time error. No runtime completeness guard is needed.
  const order: Record<RepairJobSeverity, number> = { p0: 0, p1: 1, p2: 2 };
  if (order[severity] > order[minimum]) {
    throw new RepairJobServiceError(
      "below_minimum_severity",
      `repair job refused: severity='${severity}' is below minimum='${minimum}'`,
    );
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
