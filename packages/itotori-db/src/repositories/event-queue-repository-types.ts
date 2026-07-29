import type { SQL } from "drizzle-orm";
import type { AuthorizationActor } from "../authorization.js";
import {
  type JobEventType,
  type JobIdempotencyPolicy,
  jobIdempotencyPolicyValues,
  type JobStatus,
  type JobTaskType,
  type OutboxEventType,
  type OutboxStatus,
} from "../schema.js";

export type QueueJsonRecord = Record<string, unknown>;

export type QueueErrorRecord = {
  at: string;
  workerId: string;
  attempt: number;
  error: string;
  terminal: boolean;
};

export type OutboxEventRecord = {
  outboxEventId: string;
  projectId: string;
  localeBranchId: string | null;
  sourceEventId: string | null;
  eventType: OutboxEventType;
  status: OutboxStatus;
  idempotencyKey: string;
  correlationId: string;
  causationId: string | null;
  payload: QueueJsonRecord;
  availableAt: Date;
  attemptCount: number;
  maxAttempts: number;
  lockedBy: string | null;
  lockedAt: Date | null;
  leaseExpiresAt: Date | null;
  publishedAt: Date | null;
  lastError: string | null;
  errorHistory: QueueErrorRecord[];
  createdAt: Date;
  updatedAt: Date;
};

export type JobQueueRecord = {
  jobId: string;
  projectId: string;
  localeBranchId: string | null;
  sourceEventId: string | null;
  triggerOutboxEventId: string | null;
  jobType: JobTaskType;
  jobName: string;
  queueName: string;
  status: JobStatus;
  idempotencyPolicy: JobIdempotencyPolicy;
  idempotencyKey: string | null;
  correlationId: string;
  causationId: string | null;
  subjectRefs: unknown[];
  dependsOnJobIds: string[];
  payload: QueueJsonRecord;
  priority: number;
  availableAt: Date;
  attemptCount: number;
  maxAttempts: number;
  lockedBy: string | null;
  lockedAt: Date | null;
  leaseExpiresAt: Date | null;
  completedAt: Date | null;
  lastError: string | null;
  errorHistory: QueueErrorRecord[];
  result: QueueJsonRecord | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * One append-only row of the job-queue lifecycle audit trail. Written by the
 * `itotori_job_events_capture` DB trigger for every genuine `itotori_jobs`
 * status transition; immutable (rewrite/ad-hoc-delete rejected by the
 * `itotori_job_events_append_only` trigger). See migration 0052.
 */
export type JobEventRecord = {
  jobEventId: string;
  jobId: string;
  projectId: string;
  localeBranchId: string | null;
  queueName: string;
  eventType: JobEventType;
  priorStatus: JobStatus | null;
  nextStatus: JobStatus;
  attemptCount: number;
  workerId: string | null;
  correlationId: string;
  detail: QueueJsonRecord;
  recordedAt: Date;
};

/**
 * Retention window for the job-queue lifecycle audit trail. Events for a job
 * still in a non-terminal state are kept regardless of age; events for a
 * terminal job (succeeded/dead_letter/cancelled) are kept until this many days
 * old, after which pruneJobEvents() may remove them via the sanctioned prune
 * path. See migration 0052.
 */
export const DEFAULT_JOB_EVENT_RETENTION_DAYS = 90;

export type PruneJobEventsOptions = {
  olderThanDays?: number;
};

export type OutboxEventInput = {
  outboxEventId?: string;
  projectId: string;
  localeBranchId?: string;
  sourceEventId?: string;
  eventType: OutboxEventType;
  idempotencyKey: string;
  correlationId?: string;
  causationId?: string;
  payload: QueueJsonRecord;
  availableAt?: Date;
  maxAttempts?: number;
};

export type JobIdempotencyInput =
  | {
      policy: typeof jobIdempotencyPolicyValues.idempotent;
      key: string;
    }
  | {
      policy: typeof jobIdempotencyPolicyValues.nonIdempotent;
    };

export type JobQueueInput = {
  jobId?: string;
  projectId: string;
  localeBranchId?: string;
  sourceEventId?: string;
  triggerOutboxEventId?: string;
  jobType: JobTaskType;
  jobName: string;
  queueName?: string;
  idempotency: JobIdempotencyInput;
  correlationId?: string;
  causationId?: string;
  subjectRefs?: unknown[];
  dependsOnJobIds?: string[];
  payload?: QueueJsonRecord;
  priority?: number;
  availableAt?: Date;
  maxAttempts?: number;
};

export type OutboxEventWithJobsInput = {
  event: OutboxEventInput;
  jobs: JobQueueInput[];
};

export type OutboxEventWithJobsResult = {
  outboxEvent: OutboxEventRecord;
  jobs: JobQueueRecord[];
};

/**
 * Schema-version literal stamped on every {@link QueueHealthReadModel} so
 * dashboard/CLI consumers can pin the contract (mirrors the durable
 * operational queue-dashboard pattern).
 */
export const QUEUE_HEALTH_READ_MODEL_SCHEMA_VERSION = "itotori.queue_health.v0.1";

/**
 * A single row of the per-status breakdown for the queue-health read-model.
 * `status` is a member of {@link OutboxStatus} (outbox section) or
 * {@link JobStatus} (jobs section); kept as a plain string so the read-model
 * serializes without a tagged union.
 */
export type QueueStatusCount = {
  status: string;
  count: number;
};

/**
 * Dead-letter review slice of a queue-health section: the TOTAL count of
 * dead-lettered rows (unbounded) plus a bounded preview of the most recent
 * dead-lettered records so an operator can inspect what failed.
 */
export type QueueDeadLetterReview<TRecord> = {
  count: number;
  recent: TRecord[];
};

/**
 * One half of the {@link QueueHealthReadModel}: either the transactional
 * outbox section or the durable job-queue section. Each carries the headline
 * lag metric (oldest un-processed age), the per-status breakdown, the
 * retry-load count, and the dead-letter review.
 */
export type QueueHealthSection<TRecord> = {
  unprocessedCount: number;
  oldestUnprocessedAt: Date | null;
  unprocessedLagSeconds: number | null;
  statusCounts: QueueStatusCount[];
  retryingCount: number;
  deadLetter: QueueDeadLetterReview<TRecord>;
};

/**
 * Typed queue-health read-model an operator inspects to answer "is the
 * queue healthy?": outbox lag (oldest un-processed age), pending job counts
 * by status, retry counts, and dead-lettered work for both the transactional
 * outbox and the durable job queue. Surfaced verbatim by the CLI
 * `queue-health` command and the `queue.health` API route (typed responses,
 * not dumped strings).
 */
export type QueueHealthReadModel = {
  schemaVersion: typeof QUEUE_HEALTH_READ_MODEL_SCHEMA_VERSION;
  generatedAt: Date;
  outbox: QueueHealthSection<OutboxEventRecord>;
  jobs: QueueHealthSection<JobQueueRecord>;
};

export type LoadQueueHealthOptions = {
  /** Bound the dead-letter `recent` preview (default 50, range 1-200). */
  deadLetterLimit?: number;
  /** Optional project scope; omit for a global operator view. */
  projectId?: string;
};

export type ClaimOutboxEventsOptions = {
  limit?: number;
  leaseSeconds?: number;
};

export type ClaimJobsOptions = {
  queueName?: string;
  limit?: number;
  leaseSeconds?: number;
};

export type QueueFailureInput = {
  error: unknown;
  retryAfterSeconds?: number;
};

export type QueueSqlExecutor = {
  execute: (query: SQL) => Promise<{ rows: unknown[] }>;
};

/**
 * Why a job-lease revalidation rejected a completion / failure attempt. See
 * {@link JobLeaseRevalidationError}. Ordering of detection is deliberate:
 * `not_found` (row gone) → `not_running` (already terminal / recovered, e.g. a
 * duplicate completion) → `owner_mismatch` (a different worker took the lease
 * over) → `lease_expired` (this worker still names itself owner but its lease
 * elapsed before it revalidated).
 */
export const jobLeaseRevalidationReasons = {
  notFound: "not_found",
  notRunning: "not_running",
  ownerMismatch: "owner_mismatch",
  leaseExpired: "lease_expired",
} as const;

export type JobLeaseRevalidationReason =
  (typeof jobLeaseRevalidationReasons)[keyof typeof jobLeaseRevalidationReasons];

export type JobLeaseOperation = "complete" | "fail";

export type JobLeaseRevalidationDetails = {
  jobId: string;
  operation: JobLeaseOperation;
  reason: JobLeaseRevalidationReason;
  /** The worker that attempted the write (the lease owner it believed it held). */
  expectedOwner: string;
  /** The lease owner recorded in the row right now (null once released/recovered). */
  actualOwner: string | null;
  /** The job's current status (null when the row no longer exists). */
  jobStatus: JobStatus | null;
  /** The lease expiry recorded in the row right now (null when released/recovered). */
  leaseExpiresAt: Date | null;
};

/**
 * Raised when a worker tries to complete (or fail) a job whose lease no longer
 * belongs to it — the lease expired, was recovered, or was taken over by another
 * worker. The offending write is a no-op (0 rows matched) so job state is NOT
 * mutated; this error is the clear, structured diagnostic naming expected vs
 * actual owner plus the current status/expiry.
 */
export class JobLeaseRevalidationError extends Error {
  readonly jobId: string;
  readonly operation: JobLeaseOperation;
  readonly reason: JobLeaseRevalidationReason;
  readonly expectedOwner: string;
  readonly actualOwner: string | null;
  readonly jobStatus: JobStatus | null;
  readonly leaseExpiresAt: Date | null;

  constructor(details: JobLeaseRevalidationDetails) {
    super(formatLeaseRevalidationMessage(details));
    this.name = "JobLeaseRevalidationError";
    this.jobId = details.jobId;
    this.operation = details.operation;
    this.reason = details.reason;
    this.expectedOwner = details.expectedOwner;
    this.actualOwner = details.actualOwner;
    this.jobStatus = details.jobStatus;
    this.leaseExpiresAt = details.leaseExpiresAt;
  }
}

function formatLeaseRevalidationMessage(details: JobLeaseRevalidationDetails): string {
  const actualOwner = details.actualOwner === null ? "<none>" : details.actualOwner;
  const status = details.jobStatus === null ? "<absent>" : details.jobStatus;
  const expiry = details.leaseExpiresAt === null ? "<none>" : details.leaseExpiresAt.toISOString();
  return (
    `worker "${details.expectedOwner}" cannot ${details.operation} job ${details.jobId}: ` +
    `lease ownership revalidation failed (reason=${details.reason}, ` +
    `expectedOwner="${details.expectedOwner}", actualOwner="${actualOwner}", ` +
    `status=${status}, leaseExpiresAt=${expiry})`
  );
}

/**
 * Why an outbox-lease revalidation rejected a publish / fail mark. The outbox
 * analog of {@link jobLeaseRevalidationReasons}: the running state is
 * `publishing`, so `not_publishing` (rather than `not_running`) names an event
 * that is no longer in the leased publishing state (already published, recovered
 * back to retry, or dead-lettered). Detection order matches the job path:
 * `not_found` (row gone) → `not_publishing` (already terminal / recovered, e.g.
 * a duplicate mark) → `owner_mismatch` (another publisher took the lease over) →
 * `lease_expired` (this publisher still names itself owner but its lease elapsed
 * before it revalidated).
 */
export const outboxLeaseRevalidationReasons = {
  notFound: "not_found",
  notPublishing: "not_publishing",
  ownerMismatch: "owner_mismatch",
  leaseExpired: "lease_expired",
} as const;

export type OutboxLeaseRevalidationReason =
  (typeof outboxLeaseRevalidationReasons)[keyof typeof outboxLeaseRevalidationReasons];

export type OutboxLeaseOperation = "publish" | "fail";

export type OutboxLeaseRevalidationDetails = {
  outboxEventId: string;
  operation: OutboxLeaseOperation;
  reason: OutboxLeaseRevalidationReason;
  /** The publisher that attempted the mark (the lease owner it believed it held). */
  expectedOwner: string;
  /** The lease owner recorded in the row right now (null once released/recovered). */
  actualOwner: string | null;
  /** The event's current status (null when the row no longer exists). */
  outboxStatus: OutboxStatus | null;
  /** The lease expiry recorded in the row right now (null when released/recovered). */
  leaseExpiresAt: Date | null;
};

/**
 * Raised when a publisher tries to mark an outbox event published (or failed)
 * whose lease no longer belongs to it — the lease expired, was recovered, or was
 * taken over by another publisher. The offending write is a no-op (0 rows
 * matched) so outbox state is NOT mutated; this error is the clear, structured
 * diagnostic naming expected vs actual owner plus the current status/expiry. The
 * outbox analog of {@link JobLeaseRevalidationError}.
 */
export class OutboxLeaseRevalidationError extends Error {
  readonly outboxEventId: string;
  readonly operation: OutboxLeaseOperation;
  readonly reason: OutboxLeaseRevalidationReason;
  readonly expectedOwner: string;
  readonly actualOwner: string | null;
  readonly outboxStatus: OutboxStatus | null;
  readonly leaseExpiresAt: Date | null;

  constructor(details: OutboxLeaseRevalidationDetails) {
    super(formatOutboxLeaseRevalidationMessage(details));
    this.name = "OutboxLeaseRevalidationError";
    this.outboxEventId = details.outboxEventId;
    this.operation = details.operation;
    this.reason = details.reason;
    this.expectedOwner = details.expectedOwner;
    this.actualOwner = details.actualOwner;
    this.outboxStatus = details.outboxStatus;
    this.leaseExpiresAt = details.leaseExpiresAt;
  }
}

function formatOutboxLeaseRevalidationMessage(details: OutboxLeaseRevalidationDetails): string {
  const actualOwner = details.actualOwner === null ? "<none>" : details.actualOwner;
  const status = details.outboxStatus === null ? "<absent>" : details.outboxStatus;
  const expiry = details.leaseExpiresAt === null ? "<none>" : details.leaseExpiresAt.toISOString();
  return (
    `publisher "${details.expectedOwner}" cannot ${details.operation} outbox event ` +
    `${details.outboxEventId}: lease ownership revalidation failed (reason=${details.reason}, ` +
    `expectedOwner="${details.expectedOwner}", actualOwner="${actualOwner}", ` +
    `status=${status}, leaseExpiresAt=${expiry})`
  );
}

export interface ItotoriEventQueueRepositoryPort {
  appendOutboxEvent(actor: AuthorizationActor, input: OutboxEventInput): Promise<OutboxEventRecord>;
  enqueueJob(actor: AuthorizationActor, input: JobQueueInput): Promise<JobQueueRecord>;
  enqueueJobs(
    actor: AuthorizationActor,
    input: readonly JobQueueInput[],
  ): Promise<JobQueueRecord[]>;
  appendOutboxEventWithJobs(
    actor: AuthorizationActor,
    input: OutboxEventWithJobsInput,
  ): Promise<OutboxEventWithJobsResult>;
  claimOutboxEvents(
    actor: AuthorizationActor,
    workerId: string,
    options?: ClaimOutboxEventsOptions,
  ): Promise<OutboxEventRecord[]>;
  markOutboxEventPublished(
    actor: AuthorizationActor,
    outboxEventId: string,
    workerId: string,
  ): Promise<OutboxEventRecord>;
  markOutboxEventFailed(
    actor: AuthorizationActor,
    outboxEventId: string,
    workerId: string,
    input: QueueFailureInput,
  ): Promise<OutboxEventRecord>;
  recoverExpiredOutboxLeases(actor: AuthorizationActor): Promise<OutboxEventRecord[]>;
  claimJobs(
    actor: AuthorizationActor,
    workerId: string,
    options?: ClaimJobsOptions,
  ): Promise<JobQueueRecord[]>;
  completeJob(
    actor: AuthorizationActor,
    jobId: string,
    workerId: string,
    result?: QueueJsonRecord,
  ): Promise<JobQueueRecord>;
  failJob(
    actor: AuthorizationActor,
    jobId: string,
    workerId: string,
    input: QueueFailureInput,
  ): Promise<JobQueueRecord>;
  recoverExpiredJobLeases(actor: AuthorizationActor): Promise<JobQueueRecord[]>;
  getOutboxEvent(
    actor: AuthorizationActor,
    outboxEventId: string,
  ): Promise<OutboxEventRecord | null>;
  getJob(actor: AuthorizationActor, jobId: string): Promise<JobQueueRecord | null>;
  getJobEvents(actor: AuthorizationActor, jobId: string): Promise<JobEventRecord[]>;
  /**
   * Load the typed queue-health read-model (outbox lag, pending job counts
   * by status, retry counts, dead-lettered work) for operator inspection.
   * Read-only; gated on `queue.read`.
   */
  loadQueueHealth(
    actor: AuthorizationActor,
    options?: LoadQueueHealthOptions,
  ): Promise<QueueHealthReadModel>;
  pruneJobEvents(actor: AuthorizationActor, options?: PruneJobEventsOptions): Promise<number>;
}
