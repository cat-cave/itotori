import { randomBytes } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import {
  eventOutbox,
  jobEvents,
  type JobEventType,
  type JobIdempotencyPolicy,
  jobIdempotencyPolicyValues,
  jobQueue,
  type JobStatus,
  jobStatusValues,
  type JobTaskType,
  type OutboxEventType,
  type OutboxStatus,
  outboxStatusValues,
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
 * ITOTORI-047 — the schema-version literal stamped on every
 * {@link QueueHealthReadModel} so dashboard/CLI consumers can pin the contract
 * (mirrors the `reviewer.queue_dashboard.v0.1` pattern).
 */
export const QUEUE_HEALTH_READ_MODEL_SCHEMA_VERSION = "itotori.queue_health.v0.1";

/**
 * ITOTORI-047 — a single row of the per-status breakdown for the queue-health
 * read-model. `status` is a member of {@link OutboxStatus} (outbox section) or
 * {@link JobStatus} (jobs section); kept as a plain string so the read-model
 * serializes without a tagged union.
 */
export type QueueStatusCount = {
  status: string;
  count: number;
};

/**
 * ITOTORI-047 — the dead-letter review slice of a queue-health section: the
 * TOTAL count of dead-lettered rows (unbounded) plus a bounded preview of the
 * most recent dead-lettered records so an operator can inspect what failed.
 */
export type QueueDeadLetterReview<TRecord> = {
  count: number;
  recent: TRecord[];
};

/**
 * ITOTORI-047 — one half of the {@link QueueHealthReadModel}: either the
 * transactional outbox section or the durable job-queue section. Each carries
 * the headline lag metric (oldest un-processed age), the per-status breakdown,
 * the retry-load count, and the dead-letter review.
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
 * ITOTORI-047 — the typed queue-health read-model an operator inspects to
 * answer "is the queue healthy?": outbox lag (oldest un-processed age), pending
 * job counts by status, retry counts, and dead-lettered work for both the
 * transactional outbox and the durable job queue. Surfaced verbatim by the CLI
 * `queue-health` command and the `queue.health` API route (typed responses, not
 * dumped strings).
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
 * actual owner plus the current status/expiry. See ITOTORI-046.
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
 * outbox analog of {@link JobLeaseRevalidationError}. See ITOTORI-046.
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

type InsertOutboxEventResult = {
  outboxEvent: OutboxEventRecord;
  inserted: boolean;
};

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
   * ITOTORI-047 — load the typed queue-health read-model (outbox lag, pending
   * job counts by status, retry counts, dead-lettered work) for operator
   * inspection. Read-only; gated on `queue.read`.
   */
  loadQueueHealth(
    actor: AuthorizationActor,
    options?: LoadQueueHealthOptions,
  ): Promise<QueueHealthReadModel>;
  pruneJobEvents(actor: AuthorizationActor, options?: PruneJobEventsOptions): Promise<number>;
}

export class ItotoriEventQueueRepository implements ItotoriEventQueueRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  static enqueueJobsInTransaction(
    executor: QueueSqlExecutor,
    inputs: readonly JobQueueInput[],
  ): Promise<JobQueueRecord[]> {
    return enqueueJobInputsInTransaction(executor, inputs);
  }

  async appendOutboxEvent(
    actor: AuthorizationActor,
    input: OutboxEventInput,
  ): Promise<OutboxEventRecord> {
    await requirePermission(this.db, actor, permissionValues.queueManage);
    const result = await insertOutboxEvent(this.db as unknown as QueueSqlExecutor, input);
    return result.outboxEvent;
  }

  async enqueueJob(actor: AuthorizationActor, input: JobQueueInput): Promise<JobQueueRecord> {
    await requirePermission(this.db, actor, permissionValues.queueManage);
    return insertJob(this.db as unknown as QueueSqlExecutor, input);
  }

  async enqueueJobs(
    actor: AuthorizationActor,
    input: readonly JobQueueInput[],
  ): Promise<JobQueueRecord[]> {
    await requirePermission(this.db, actor, permissionValues.queueManage);
    return this.db.transaction(async (tx) =>
      enqueueJobInputsInTransaction(tx as unknown as QueueSqlExecutor, input),
    );
  }

  async appendOutboxEventWithJobs(
    actor: AuthorizationActor,
    input: OutboxEventWithJobsInput,
  ): Promise<OutboxEventWithJobsResult> {
    await requirePermission(this.db, actor, permissionValues.queueManage);
    return this.db.transaction(async (tx) => {
      const executor = tx as unknown as QueueSqlExecutor;
      const outboxInsert = await insertOutboxEvent(executor, input.event);
      const outboxEvent = outboxInsert.outboxEvent;
      if (!outboxInsert.inserted) {
        return { outboxEvent, jobs: [] };
      }
      const linkedJobInputs = input.jobs.map((jobInput) => {
        const linkedJobInput: JobQueueInput = {
          ...jobInput,
          triggerOutboxEventId: jobInput.triggerOutboxEventId ?? outboxEvent.outboxEventId,
          correlationId: jobInput.correlationId ?? outboxEvent.correlationId,
          causationId: jobInput.causationId ?? outboxEvent.outboxEventId,
        };
        if (linkedJobInput.sourceEventId === undefined && input.event.sourceEventId !== undefined) {
          linkedJobInput.sourceEventId = input.event.sourceEventId;
        }
        return linkedJobInput;
      });
      const jobs = await enqueueJobInputsInTransaction(executor, linkedJobInputs);
      return { outboxEvent, jobs };
    });
  }

  async claimOutboxEvents(
    actor: AuthorizationActor,
    workerId: string,
    options: ClaimOutboxEventsOptions = {},
  ): Promise<OutboxEventRecord[]> {
    await requirePermission(this.db, actor, permissionValues.queueManage);
    const limit = normalizeLimit(options.limit);
    const leaseSeconds = normalizeLeaseSeconds(options.leaseSeconds);
    const rows = await executeRows(
      this.db as unknown as QueueSqlExecutor,
      sql`
        with candidate as (
          select outbox_event_id
          from ${eventOutbox}
          where status in (${outboxStatusValues.pending}, ${outboxStatusValues.retryWaiting})
            and available_at <= now()
            and (lease_expires_at is null or lease_expires_at <= now())
          order by available_at asc, created_at asc
          limit ${limit}
          for update skip locked
        )
        update ${eventOutbox} e
        set
          status = ${outboxStatusValues.publishing},
          locked_by = ${workerId},
          locked_at = now(),
          lease_expires_at = now() + (${leaseSeconds}::double precision * interval '1 second'),
          attempt_count = e.attempt_count + 1,
          updated_at = now()
        from candidate
        where e.outbox_event_id = candidate.outbox_event_id
        returning e.*
      `,
    );
    return rows.map(outboxEventFromRow);
  }

  async markOutboxEventPublished(
    actor: AuthorizationActor,
    outboxEventId: string,
    workerId: string,
  ): Promise<OutboxEventRecord> {
    await requirePermission(this.db, actor, permissionValues.queueManage);
    const executor = this.db as unknown as QueueSqlExecutor;
    const rows = await executeRows(
      executor,
      sql`
        update ${eventOutbox}
        set
          status = ${outboxStatusValues.published},
          published_at = now(),
          locked_by = null,
          locked_at = null,
          lease_expires_at = null,
          last_error = null,
          updated_at = now()
        where outbox_event_id = ${outboxEventId}
          and status = ${outboxStatusValues.publishing}
          and locked_by = ${workerId}
          and lease_expires_at is not null
          and lease_expires_at > now()
        returning *
      `,
    );
    if (rows[0] === undefined) {
      await throwOutboxLeaseRevalidationError(executor, outboxEventId, workerId, "publish");
    }
    return outboxEventFromRow(rows[0] as Record<string, unknown>);
  }

  async markOutboxEventFailed(
    actor: AuthorizationActor,
    outboxEventId: string,
    workerId: string,
    input: QueueFailureInput,
  ): Promise<OutboxEventRecord> {
    await requirePermission(this.db, actor, permissionValues.queueManage);
    const error = errorMessage(input.error);
    const retryAfterSeconds = normalizeRetryAfterSeconds(input.retryAfterSeconds);
    const executor = this.db as unknown as QueueSqlExecutor;
    const rows = await executeRows(
      executor,
      sql`
        update ${eventOutbox} e
        set
          status = case
            when e.attempt_count >= e.max_attempts then ${outboxStatusValues.deadLetter}
            else ${outboxStatusValues.retryWaiting}
          end,
          available_at = case
            when e.attempt_count >= e.max_attempts then now()
            else now() + (${retryAfterSeconds}::double precision * interval '1 second')
          end,
          locked_by = null,
          locked_at = null,
          lease_expires_at = null,
          last_error = ${error},
          error_history = e.error_history || jsonb_build_array(
            jsonb_build_object(
              'at', now(),
              'workerId', ${workerId}::text,
              'attempt', e.attempt_count,
              'error', ${error}::text,
              'terminal', e.attempt_count >= e.max_attempts
            )
          ),
          updated_at = now()
        where e.outbox_event_id = ${outboxEventId}
          and e.status = ${outboxStatusValues.publishing}
          and e.locked_by = ${workerId}
          and e.lease_expires_at is not null
          and e.lease_expires_at > now()
        returning e.*
      `,
    );
    if (rows[0] === undefined) {
      await throwOutboxLeaseRevalidationError(executor, outboxEventId, workerId, "fail");
    }
    return outboxEventFromRow(rows[0] as Record<string, unknown>);
  }

  async recoverExpiredOutboxLeases(actor: AuthorizationActor): Promise<OutboxEventRecord[]> {
    await requirePermission(this.db, actor, permissionValues.queueManage);
    const rows = await executeRows(
      this.db as unknown as QueueSqlExecutor,
      sql`
        update ${eventOutbox} e
        set
          status = case
            when e.attempt_count >= e.max_attempts then ${outboxStatusValues.deadLetter}
            else ${outboxStatusValues.retryWaiting}
          end,
          available_at = now(),
          locked_by = null,
          locked_at = null,
          lease_expires_at = null,
          last_error = 'lease expired',
          error_history = e.error_history || jsonb_build_array(
            jsonb_build_object(
              'at', now(),
              'workerId', coalesce(e.locked_by, 'unknown'),
              'attempt', e.attempt_count,
              'error', 'lease expired',
              'terminal', e.attempt_count >= e.max_attempts
            )
          ),
          updated_at = now()
        where e.status = ${outboxStatusValues.publishing}
          and e.lease_expires_at <= now()
        returning e.*
      `,
    );
    return rows.map(outboxEventFromRow);
  }

  async claimJobs(
    actor: AuthorizationActor,
    workerId: string,
    options: ClaimJobsOptions = {},
  ): Promise<JobQueueRecord[]> {
    await requirePermission(this.db, actor, permissionValues.queueManage);
    const limit = normalizeLimit(options.limit);
    const leaseSeconds = normalizeLeaseSeconds(options.leaseSeconds);
    const queueNameFilter =
      options.queueName === undefined ? sql`` : sql`and queue_name = ${options.queueName}`;
    const rows = await executeRows(
      this.db as unknown as QueueSqlExecutor,
      sql`
        with candidate as (
          select job_id
          from ${jobQueue}
          where status in (${jobStatusValues.queued}, ${jobStatusValues.retryWaiting})
            and available_at <= now()
            and (lease_expires_at is null or lease_expires_at <= now())
            and not exists (
              select 1
              from jsonb_array_elements_text(depends_on_job_ids) as dependency_ref(job_id)
              left join ${jobQueue} dependency on dependency.job_id = dependency_ref.job_id
              where dependency.job_id is null
                or dependency.status <> ${jobStatusValues.succeeded}
            )
            ${queueNameFilter}
          order by priority desc, available_at asc, created_at asc
          limit ${limit}
          for update skip locked
        )
        update ${jobQueue} j
        set
          status = ${jobStatusValues.running},
          locked_by = ${workerId},
          locked_at = now(),
          lease_expires_at = now() + (${leaseSeconds}::double precision * interval '1 second'),
          attempt_count = j.attempt_count + 1,
          updated_at = now()
        from candidate
        where j.job_id = candidate.job_id
        returning j.*
      `,
    );
    return rows.map(jobFromRow);
  }

  async completeJob(
    actor: AuthorizationActor,
    jobId: string,
    workerId: string,
    result: QueueJsonRecord = {},
  ): Promise<JobQueueRecord> {
    await requirePermission(this.db, actor, permissionValues.queueManage);
    const executor = this.db as unknown as QueueSqlExecutor;
    const rows = await executeRows(
      executor,
      sql`
        update ${jobQueue}
        set
          status = ${jobStatusValues.succeeded},
          completed_at = now(),
          locked_by = null,
          locked_at = null,
          lease_expires_at = null,
          last_error = null,
          result = ${JSON.stringify(result)}::jsonb,
          updated_at = now()
        where job_id = ${jobId}
          and status = ${jobStatusValues.running}
          and locked_by = ${workerId}
          and lease_expires_at is not null
          and lease_expires_at > now()
        returning *
      `,
    );
    if (rows[0] === undefined) {
      await throwJobLeaseRevalidationError(executor, jobId, workerId, "complete");
    }
    return jobFromRow(rows[0] as Record<string, unknown>);
  }

  async failJob(
    actor: AuthorizationActor,
    jobId: string,
    workerId: string,
    input: QueueFailureInput,
  ): Promise<JobQueueRecord> {
    await requirePermission(this.db, actor, permissionValues.queueManage);
    const error = errorMessage(input.error);
    const retryAfterSeconds = normalizeRetryAfterSeconds(input.retryAfterSeconds);
    const executor = this.db as unknown as QueueSqlExecutor;
    const rows = await executeRows(
      executor,
      sql`
        update ${jobQueue} j
        set
          status = case
            when j.attempt_count >= j.max_attempts then ${jobStatusValues.deadLetter}
            else ${jobStatusValues.retryWaiting}
          end,
          available_at = case
            when j.attempt_count >= j.max_attempts then now()
            else now() + (${retryAfterSeconds}::double precision * interval '1 second')
          end,
          locked_by = null,
          locked_at = null,
          lease_expires_at = null,
          last_error = ${error},
          error_history = j.error_history || jsonb_build_array(
            jsonb_build_object(
              'at', now(),
              'workerId', ${workerId}::text,
              'attempt', j.attempt_count,
              'error', ${error}::text,
              'terminal', j.attempt_count >= j.max_attempts
            )
          ),
          updated_at = now()
        where j.job_id = ${jobId}
          and j.status = ${jobStatusValues.running}
          and j.locked_by = ${workerId}
          and j.lease_expires_at is not null
          and j.lease_expires_at > now()
        returning j.*
      `,
    );
    if (rows[0] === undefined) {
      await throwJobLeaseRevalidationError(executor, jobId, workerId, "fail");
    }
    return jobFromRow(rows[0] as Record<string, unknown>);
  }

  async recoverExpiredJobLeases(actor: AuthorizationActor): Promise<JobQueueRecord[]> {
    await requirePermission(this.db, actor, permissionValues.queueManage);
    const rows = await executeRows(
      this.db as unknown as QueueSqlExecutor,
      sql`
        update ${jobQueue} j
        set
          status = case
            when j.attempt_count >= j.max_attempts then ${jobStatusValues.deadLetter}
            else ${jobStatusValues.retryWaiting}
          end,
          available_at = now(),
          locked_by = null,
          locked_at = null,
          lease_expires_at = null,
          last_error = 'lease expired',
          error_history = j.error_history || jsonb_build_array(
            jsonb_build_object(
              'at', now(),
              'workerId', coalesce(j.locked_by, 'unknown'),
              'attempt', j.attempt_count,
              'error', 'lease expired',
              'terminal', j.attempt_count >= j.max_attempts
            )
          ),
          updated_at = now()
        where j.status = ${jobStatusValues.running}
          and j.lease_expires_at <= now()
        returning j.*
      `,
    );
    return rows.map(jobFromRow);
  }

  async getOutboxEvent(
    actor: AuthorizationActor,
    outboxEventId: string,
  ): Promise<OutboxEventRecord | null> {
    await requirePermission(this.db, actor, permissionValues.queueRead);
    const rows = await executeRows(
      this.db as unknown as QueueSqlExecutor,
      sql`select * from ${eventOutbox} where outbox_event_id = ${outboxEventId} limit 1`,
    );
    return rows[0] === undefined ? null : outboxEventFromRow(rows[0]);
  }

  async getJob(actor: AuthorizationActor, jobId: string): Promise<JobQueueRecord | null> {
    await requirePermission(this.db, actor, permissionValues.queueRead);
    const rows = await executeRows(
      this.db as unknown as QueueSqlExecutor,
      sql`select * from ${jobQueue} where job_id = ${jobId} limit 1`,
    );
    return rows[0] === undefined ? null : jobFromRow(rows[0]);
  }

  async getJobEvents(actor: AuthorizationActor, jobId: string): Promise<JobEventRecord[]> {
    await requirePermission(this.db, actor, permissionValues.queueRead);
    const rows = await executeRows(
      this.db as unknown as QueueSqlExecutor,
      sql`
        select * from ${jobEvents}
        where job_id = ${jobId}
        order by recorded_at asc, job_event_id asc
      `,
    );
    return rows.map(jobEventFromRow);
  }

  /**
   * ITOTORI-047 — load the typed queue-health read-model. Computes, in three
   * cheap read-only queries per table (aggregate, per-status breakdown,
   * bounded dead-letter preview), the operator-facing metrics: outbox/job lag
   * (oldest un-processed age), pending counts by status, retry load, and the
   * dead-letter review. The lag is derived deterministically from
   * `generatedAt` minus the oldest un-processed timestamp (no moving DB
   * `now()`), so it is stable and testable. Gated on `queue.read`.
   */
  async loadQueueHealth(
    actor: AuthorizationActor,
    options: LoadQueueHealthOptions = {},
  ): Promise<QueueHealthReadModel> {
    await requirePermission(this.db, actor, permissionValues.queueRead);
    const deadLetterLimit = normalizeDeadLetterLimit(options.deadLetterLimit);
    const projectId = options.projectId;
    const projectFilter = projectId === undefined ? sql`` : sql`where project_id = ${projectId}`;
    const executor = this.db as unknown as QueueSqlExecutor;
    const generatedAt = new Date();

    const outboxAggregate = await singleRow(
      executeRows(
        executor,
        sql`
          select
            min(created_at) filter (
              where status in (
                ${outboxStatusValues.pending},
                ${outboxStatusValues.publishing},
                ${outboxStatusValues.retryWaiting}
              )
            ) as oldest_unprocessed_at,
            count(*) filter (
              where status in (
                ${outboxStatusValues.pending},
                ${outboxStatusValues.publishing},
                ${outboxStatusValues.retryWaiting}
              )
            ) as unprocessed_count,
            count(*) filter (
              where status = ${outboxStatusValues.retryWaiting} and attempt_count > 0
            ) as retrying_count,
            count(*) filter (where status = ${outboxStatusValues.deadLetter}) as dead_letter_count
          from ${eventOutbox}
          ${projectFilter}
        `,
      ),
      "itotori_event_outbox aggregate",
    );
    const outboxStatusRows = await executeRows(
      executor,
      sql`select status, count(*) as count from ${eventOutbox} ${projectFilter} group by status`,
    );
    const outboxDeadLetterRows = await executeRows(
      executor,
      sql`
        select * from ${eventOutbox}
        where status = ${outboxStatusValues.deadLetter}
        ${projectId === undefined ? sql`` : sql`and project_id = ${projectId}`}
        order by updated_at desc, created_at desc
        limit ${deadLetterLimit}
      `,
    );

    const jobsAggregate = await singleRow(
      executeRows(
        executor,
        sql`
          select
            min(created_at) filter (
              where status in (
                ${jobStatusValues.queued},
                ${jobStatusValues.running},
                ${jobStatusValues.retryWaiting}
              )
            ) as oldest_unprocessed_at,
            count(*) filter (
              where status in (
                ${jobStatusValues.queued},
                ${jobStatusValues.running},
                ${jobStatusValues.retryWaiting}
              )
            ) as unprocessed_count,
            count(*) filter (
              where status = ${jobStatusValues.retryWaiting} and attempt_count > 0
            ) as retrying_count,
            count(*) filter (where status = ${jobStatusValues.deadLetter}) as dead_letter_count
          from ${jobQueue}
          ${projectFilter}
        `,
      ),
      "itotori_jobs aggregate",
    );
    const jobsStatusRows = await executeRows(
      executor,
      sql`select status, count(*) as count from ${jobQueue} ${projectFilter} group by status`,
    );
    const jobsDeadLetterRows = await executeRows(
      executor,
      sql`
        select * from ${jobQueue}
        where status = ${jobStatusValues.deadLetter}
        ${projectId === undefined ? sql`` : sql`and project_id = ${projectId}`}
        order by updated_at desc, created_at desc
        limit ${deadLetterLimit}
      `,
    );

    return {
      schemaVersion: QUEUE_HEALTH_READ_MODEL_SCHEMA_VERSION,
      generatedAt,
      outbox: {
        unprocessedCount: rowNumber(outboxAggregate, "unprocessed_count"),
        oldestUnprocessedAt: nullableRowDate(outboxAggregate, "oldest_unprocessed_at"),
        unprocessedLagSeconds: lagSeconds(
          generatedAt,
          nullableRowDate(outboxAggregate, "oldest_unprocessed_at"),
        ),
        statusCounts: mergeStatusCounts(Object.values(outboxStatusValues), outboxStatusRows),
        retryingCount: rowNumber(outboxAggregate, "retrying_count"),
        deadLetter: {
          count: rowNumber(outboxAggregate, "dead_letter_count"),
          recent: outboxDeadLetterRows.map(outboxEventFromRow),
        },
      },
      jobs: {
        unprocessedCount: rowNumber(jobsAggregate, "unprocessed_count"),
        oldestUnprocessedAt: nullableRowDate(jobsAggregate, "oldest_unprocessed_at"),
        unprocessedLagSeconds: lagSeconds(
          generatedAt,
          nullableRowDate(jobsAggregate, "oldest_unprocessed_at"),
        ),
        statusCounts: mergeStatusCounts(Object.values(jobStatusValues), jobsStatusRows),
        retryingCount: rowNumber(jobsAggregate, "retrying_count"),
        deadLetter: {
          count: rowNumber(jobsAggregate, "dead_letter_count"),
          recent: jobsDeadLetterRows.map(jobFromRow),
        },
      },
    };
  }

  /**
   * Retention: prune job-lifecycle audit events for TERMINAL jobs
   * (succeeded/dead_letter/cancelled) older than the retention window. Events
   * for non-terminal jobs and events younger than the window are kept. Runs
   * through the sanctioned prune path — a transaction-local
   * `itotori.job_events_prune` flag the append-only trigger recognises — so no
   * other DELETE can silently erase an event. Returns the number of pruned
   * events.
   */
  async pruneJobEvents(
    actor: AuthorizationActor,
    options: PruneJobEventsOptions = {},
  ): Promise<number> {
    await requirePermission(this.db, actor, permissionValues.queueManage);
    const olderThanDays = normalizeRetentionDays(options.olderThanDays);
    return this.db.transaction(async (tx) => {
      const executor = tx as unknown as QueueSqlExecutor;
      await executor.execute(sql`set local itotori.job_events_prune = 'on'`);
      const rows = await executeRows(
        executor,
        sql`
          delete from ${jobEvents} e
          using ${jobQueue} j
          where e.job_id = j.job_id
            and j.status in (
              ${jobStatusValues.succeeded},
              ${jobStatusValues.deadLetter},
              ${jobStatusValues.cancelled}
            )
            and e.recorded_at < now() - (${olderThanDays}::double precision * interval '1 day')
          returning e.job_event_id
        `,
      );
      return rows.length;
    });
  }
}

async function insertOutboxEvent(
  executor: QueueSqlExecutor,
  input: OutboxEventInput,
): Promise<InsertOutboxEventResult> {
  const outboxEventId = input.outboxEventId ?? createUuid7();
  const correlationId = input.correlationId ?? outboxEventId;
  const availableAt = input.availableAt ?? new Date();
  const maxAttempts = input.maxAttempts ?? 25;
  const rows = await executeRows(
    executor,
    sql`
      insert into ${eventOutbox} (
        outbox_event_id,
        project_id,
        locale_branch_id,
        source_event_id,
        event_type,
        status,
        idempotency_key,
        correlation_id,
        causation_id,
        payload,
        available_at,
        max_attempts
      )
      values (
        ${outboxEventId},
        ${input.projectId},
        ${input.localeBranchId ?? null},
        ${input.sourceEventId ?? null},
        ${input.eventType},
        ${outboxStatusValues.pending},
        ${input.idempotencyKey},
        ${correlationId},
        ${input.causationId ?? null},
        ${JSON.stringify(input.payload)}::jsonb,
        ${availableAt},
        ${maxAttempts}
      )
      on conflict (idempotency_key) do nothing
      returning *
    `,
  );
  if (rows[0] !== undefined) {
    return { outboxEvent: outboxEventFromRow(rows[0]), inserted: true };
  }

  const existingRows = await executeRows(
    executor,
    sql`
      select *
      from ${eventOutbox}
      where idempotency_key = ${input.idempotencyKey}
      limit 1
    `,
  );
  return { outboxEvent: singleOutboxRow(existingRows, outboxEventId), inserted: false };
}

async function insertJob(
  executor: QueueSqlExecutor,
  input: JobQueueInput,
): Promise<JobQueueRecord> {
  const jobId = input.jobId ?? createUuid7();
  const idempotencyPolicy = input.idempotency.policy;
  const idempotencyKey =
    input.idempotency.policy === jobIdempotencyPolicyValues.idempotent
      ? input.idempotency.key
      : null;
  const correlationId = input.correlationId ?? jobId;
  const availableAt = input.availableAt ?? new Date();
  const rows = await executeRows(
    executor,
    sql`
      insert into ${jobQueue} (
        job_id,
        project_id,
        locale_branch_id,
        source_event_id,
        trigger_outbox_event_id,
        job_type,
        job_name,
        queue_name,
        status,
        idempotency_policy,
        idempotency_key,
        correlation_id,
        causation_id,
        subject_refs,
        depends_on_job_ids,
        payload,
        priority,
        available_at,
        max_attempts
      )
      values (
        ${jobId},
        ${input.projectId},
        ${input.localeBranchId ?? null},
        ${input.sourceEventId ?? null},
        ${input.triggerOutboxEventId ?? null},
        ${input.jobType},
        ${input.jobName},
        ${input.queueName ?? "default"},
        ${jobStatusValues.queued},
        ${idempotencyPolicy},
        ${idempotencyKey},
        ${correlationId},
        ${input.causationId ?? null},
        ${JSON.stringify(input.subjectRefs ?? [])}::jsonb,
        ${JSON.stringify(input.dependsOnJobIds ?? [])}::jsonb,
        ${JSON.stringify(input.payload ?? {})}::jsonb,
        ${input.priority ?? 0},
        ${availableAt},
        ${input.maxAttempts ?? 3}
      )
      on conflict (idempotency_key) do update
      set updated_at = itotori_jobs.updated_at
      returning *
    `,
  );
  return singleJobRow(rows, jobId);
}

export async function enqueueJobInputsInTransaction(
  executor: QueueSqlExecutor,
  inputs: readonly JobQueueInput[],
): Promise<JobQueueRecord[]> {
  const jobs: JobQueueRecord[] = [];
  for (const input of inputs) {
    jobs.push(await insertJob(executor, input));
  }
  return jobs;
}

async function executeRows(
  executor: QueueSqlExecutor,
  query: SQL,
): Promise<Array<Record<string, unknown>>> {
  const result = await executor.execute(query);
  return result.rows as Array<Record<string, unknown>>;
}

function singleOutboxRow(
  rows: Array<Record<string, unknown>>,
  outboxEventId: string,
): OutboxEventRecord {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`outbox event ${outboxEventId} is not leased by this worker`);
  }
  return outboxEventFromRow(row);
}

function singleJobRow(rows: Array<Record<string, unknown>>, jobId: string): JobQueueRecord {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`job ${jobId} is not leased by this worker`);
  }
  return jobFromRow(row);
}

/**
 * A guarded job write (completeJob/failJob) matched 0 rows: the worker's lease
 * is no longer valid. Read the current row (read-only — no mutation occurs) to
 * classify why and raise a {@link JobLeaseRevalidationError} naming expected vs
 * actual owner, status, and expiry. Because the guarded UPDATE already required
 * `status = running AND locked_by = worker AND lease not expired`, a match of
 * running + matching owner leaves lease expiry as the only remaining cause, so
 * no wall-clock re-comparison is needed here.
 */
async function throwJobLeaseRevalidationError(
  executor: QueueSqlExecutor,
  jobId: string,
  workerId: string,
  operation: JobLeaseOperation,
): Promise<never> {
  const rows = await executeRows(
    executor,
    sql`
      select status, locked_by, lease_expires_at
      from ${jobQueue}
      where job_id = ${jobId}
      limit 1
    `,
  );
  const row = rows[0];
  if (row === undefined) {
    throw new JobLeaseRevalidationError({
      jobId,
      operation,
      reason: jobLeaseRevalidationReasons.notFound,
      expectedOwner: workerId,
      actualOwner: null,
      jobStatus: null,
      leaseExpiresAt: null,
    });
  }
  const jobStatus = rowString(row, "status") as JobStatus;
  const actualOwner = nullableRowString(row, "locked_by");
  const leaseExpiresAt = nullableRowDate(row, "lease_expires_at");
  const reason = classifyLeaseRevalidationReason(jobStatus, actualOwner, workerId);
  throw new JobLeaseRevalidationError({
    jobId,
    operation,
    reason,
    expectedOwner: workerId,
    actualOwner,
    jobStatus,
    leaseExpiresAt,
  });
}

function classifyLeaseRevalidationReason(
  jobStatus: JobStatus,
  actualOwner: string | null,
  workerId: string,
): JobLeaseRevalidationReason {
  if (jobStatus !== jobStatusValues.running) {
    // Already terminal or recovered back to a claimable state (covers a
    // duplicate completion of an already-succeeded job).
    return jobLeaseRevalidationReasons.notRunning;
  }
  if (actualOwner !== workerId) {
    // Still running, but another worker holds the lease now.
    return jobLeaseRevalidationReasons.ownerMismatch;
  }
  // Running and owned by this worker, yet the guarded write matched no row: the
  // lease elapsed before revalidation.
  return jobLeaseRevalidationReasons.leaseExpired;
}

/**
 * The outbox analog of {@link throwJobLeaseRevalidationError}: a guarded outbox
 * write (markOutboxEventPublished/markOutboxEventFailed) matched 0 rows, so the
 * publisher's lease is no longer valid. Read the current row (read-only — no
 * mutation) to classify why and raise an {@link OutboxLeaseRevalidationError}
 * naming expected vs actual owner, status, and expiry. The guarded UPDATE already
 * required `status = publishing AND locked_by = worker AND lease not expired`, so
 * a match of publishing + matching owner leaves lease expiry as the only
 * remaining cause and no wall-clock re-comparison is needed here.
 */
async function throwOutboxLeaseRevalidationError(
  executor: QueueSqlExecutor,
  outboxEventId: string,
  workerId: string,
  operation: OutboxLeaseOperation,
): Promise<never> {
  const rows = await executeRows(
    executor,
    sql`
      select status, locked_by, lease_expires_at
      from ${eventOutbox}
      where outbox_event_id = ${outboxEventId}
      limit 1
    `,
  );
  const row = rows[0];
  if (row === undefined) {
    throw new OutboxLeaseRevalidationError({
      outboxEventId,
      operation,
      reason: outboxLeaseRevalidationReasons.notFound,
      expectedOwner: workerId,
      actualOwner: null,
      outboxStatus: null,
      leaseExpiresAt: null,
    });
  }
  const outboxStatus = rowString(row, "status") as OutboxStatus;
  const actualOwner = nullableRowString(row, "locked_by");
  const leaseExpiresAt = nullableRowDate(row, "lease_expires_at");
  const reason = classifyOutboxLeaseRevalidationReason(outboxStatus, actualOwner, workerId);
  throw new OutboxLeaseRevalidationError({
    outboxEventId,
    operation,
    reason,
    expectedOwner: workerId,
    actualOwner,
    outboxStatus,
    leaseExpiresAt,
  });
}

function classifyOutboxLeaseRevalidationReason(
  outboxStatus: OutboxStatus,
  actualOwner: string | null,
  workerId: string,
): OutboxLeaseRevalidationReason {
  if (outboxStatus !== outboxStatusValues.publishing) {
    // Already terminal (published/dead_letter) or recovered back to a claimable
    // state (covers a duplicate mark of an already-published event).
    return outboxLeaseRevalidationReasons.notPublishing;
  }
  if (actualOwner !== workerId) {
    // Still publishing, but another publisher holds the lease now.
    return outboxLeaseRevalidationReasons.ownerMismatch;
  }
  // Publishing and owned by this publisher, yet the guarded write matched no row:
  // the lease elapsed before revalidation.
  return outboxLeaseRevalidationReasons.leaseExpired;
}

function outboxEventFromRow(row: Record<string, unknown>): OutboxEventRecord {
  return {
    outboxEventId: rowString(row, "outbox_event_id"),
    projectId: rowString(row, "project_id"),
    localeBranchId: nullableRowString(row, "locale_branch_id"),
    sourceEventId: nullableRowString(row, "source_event_id"),
    eventType: rowString(row, "event_type") as OutboxEventType,
    status: rowString(row, "status") as OutboxStatus,
    idempotencyKey: rowString(row, "idempotency_key"),
    correlationId: rowString(row, "correlation_id"),
    causationId: nullableRowString(row, "causation_id"),
    payload: rowJsonRecord(row, "payload"),
    availableAt: rowDate(row, "available_at"),
    attemptCount: rowNumber(row, "attempt_count"),
    maxAttempts: rowNumber(row, "max_attempts"),
    lockedBy: nullableRowString(row, "locked_by"),
    lockedAt: nullableRowDate(row, "locked_at"),
    leaseExpiresAt: nullableRowDate(row, "lease_expires_at"),
    publishedAt: nullableRowDate(row, "published_at"),
    lastError: nullableRowString(row, "last_error"),
    errorHistory: rowArray(row, "error_history") as QueueErrorRecord[],
    createdAt: rowDate(row, "created_at"),
    updatedAt: rowDate(row, "updated_at"),
  };
}

function jobFromRow(row: Record<string, unknown>): JobQueueRecord {
  return {
    jobId: rowString(row, "job_id"),
    projectId: rowString(row, "project_id"),
    localeBranchId: nullableRowString(row, "locale_branch_id"),
    sourceEventId: nullableRowString(row, "source_event_id"),
    triggerOutboxEventId: nullableRowString(row, "trigger_outbox_event_id"),
    jobType: rowString(row, "job_type") as JobTaskType,
    jobName: rowString(row, "job_name"),
    queueName: rowString(row, "queue_name"),
    status: rowString(row, "status") as JobStatus,
    idempotencyPolicy: rowString(row, "idempotency_policy") as JobIdempotencyPolicy,
    idempotencyKey: nullableRowString(row, "idempotency_key"),
    correlationId: rowString(row, "correlation_id"),
    causationId: nullableRowString(row, "causation_id"),
    subjectRefs: rowArray(row, "subject_refs"),
    dependsOnJobIds: rowArray(row, "depends_on_job_ids") as string[],
    payload: rowJsonRecord(row, "payload"),
    priority: rowNumber(row, "priority"),
    availableAt: rowDate(row, "available_at"),
    attemptCount: rowNumber(row, "attempt_count"),
    maxAttempts: rowNumber(row, "max_attempts"),
    lockedBy: nullableRowString(row, "locked_by"),
    lockedAt: nullableRowDate(row, "locked_at"),
    leaseExpiresAt: nullableRowDate(row, "lease_expires_at"),
    completedAt: nullableRowDate(row, "completed_at"),
    lastError: nullableRowString(row, "last_error"),
    errorHistory: rowArray(row, "error_history") as QueueErrorRecord[],
    result: nullableRowJsonRecord(row, "result"),
    createdAt: rowDate(row, "created_at"),
    updatedAt: rowDate(row, "updated_at"),
  };
}

function jobEventFromRow(row: Record<string, unknown>): JobEventRecord {
  return {
    jobEventId: rowString(row, "job_event_id"),
    jobId: rowString(row, "job_id"),
    projectId: rowString(row, "project_id"),
    localeBranchId: nullableRowString(row, "locale_branch_id"),
    queueName: rowString(row, "queue_name"),
    eventType: rowString(row, "event_type") as JobEventType,
    priorStatus: nullableRowString(row, "prior_status") as JobStatus | null,
    nextStatus: rowString(row, "next_status") as JobStatus,
    attemptCount: rowNumber(row, "attempt_count"),
    workerId: nullableRowString(row, "worker_id"),
    correlationId: rowString(row, "correlation_id"),
    detail: rowJsonRecord(row, "detail"),
    recordedAt: rowDate(row, "recorded_at"),
  };
}

export function createUuid7(date = new Date()): string {
  const timestamp = BigInt(date.getTime());
  const bytes = randomBytes(16);
  bytes[0] = Number((timestamp >> 40n) & 0xffn);
  bytes[1] = Number((timestamp >> 32n) & 0xffn);
  bytes[2] = Number((timestamp >> 24n) & 0xffn);
  bytes[3] = Number((timestamp >> 16n) & 0xffn);
  bytes[4] = Number((timestamp >> 8n) & 0xffn);
  bytes[5] = Number(timestamp & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function rowString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`expected ${key} to be a string`);
  }
  return value;
}

function nullableRowString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`expected ${key} to be a string or null`);
  }
  return value;
}

function rowDate(row: Record<string, unknown>, key: string): Date {
  const value = row[key];
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "string") {
    return new Date(value);
  }
  throw new Error(`expected ${key} to be a date`);
}

function nullableRowDate(row: Record<string, unknown>, key: string): Date | null {
  const value = row[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "string") {
    return new Date(value);
  }
  throw new Error(`expected ${key} to be a date or null`);
}

function rowNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return Number(value);
  }
  throw new Error(`expected ${key} to be a number`);
}

function rowJsonRecord(row: Record<string, unknown>, key: string): QueueJsonRecord {
  const value = parseJsonValue(row[key]);
  if (!isJsonRecord(value)) {
    throw new Error(`expected ${key} to be a JSON object`);
  }
  return value;
}

function nullableRowJsonRecord(row: Record<string, unknown>, key: string): QueueJsonRecord | null {
  const value = row[key];
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = parseJsonValue(value);
  if (!isJsonRecord(parsed)) {
    throw new Error(`expected ${key} to be a JSON object or null`);
  }
  return parsed;
}

function rowArray(row: Record<string, unknown>, key: string): unknown[] {
  const value = parseJsonValue(row[key]);
  if (!Array.isArray(value)) {
    throw new Error(`expected ${key} to be a JSON array`);
  }
  return value;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    return JSON.parse(value);
  }
  return value;
}

function isJsonRecord(value: unknown): value is QueueJsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) {
    return 10;
  }
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("queue claim limit must be an integer from 1 through 100");
  }
  return value;
}

function normalizeLeaseSeconds(value: number | undefined): number {
  if (value === undefined) {
    return 60;
  }
  if (!Number.isFinite(value) || value < 0 || value > 3600) {
    throw new Error("queue lease seconds must be from 0 through 3600");
  }
  return value;
}

function normalizeRetryAfterSeconds(value: number | undefined): number {
  if (value === undefined) {
    return 60;
  }
  if (!Number.isFinite(value) || value < 0 || value > 86400) {
    throw new Error("queue retry seconds must be from 0 through 86400");
  }
  return value;
}

function normalizeRetentionDays(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_JOB_EVENT_RETENTION_DAYS;
  }
  if (!Number.isFinite(value) || value < 0 || value > 36500) {
    throw new Error("job event retention days must be from 0 through 36500");
  }
  return value;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 4096 ? message.slice(0, 4096) : message;
}

async function singleRow(
  rowsPromise: Promise<Array<Record<string, unknown>>>,
  label: string,
): Promise<Record<string, unknown>> {
  const rows = await rowsPromise;
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`expected ${label} to return exactly one row`);
  }
  return row;
}

/**
 * ITOTORI-047 — deterministic lag in seconds between the read-model's
 * `generatedAt` and the oldest un-processed timestamp. Returns null when there
 * is nothing pending (no oldest timestamp). Computed from a fixed
 * `generatedAt` rather than a moving DB `now()` so the metric is stable and
 * testable; clamped at 0 so a tiny app/DB clock skew can never report negative
 * lag.
 */
function lagSeconds(generatedAt: Date, oldestUnprocessedAt: Date | null): number | null {
  if (oldestUnprocessedAt === null) {
    return null;
  }
  const seconds = (generatedAt.getTime() - oldestUnprocessedAt.getTime()) / 1000;
  return Math.round(Math.max(0, seconds) * 1000) / 1000;
}

/**
 * ITOTORI-047 — fold the per-status group-by rows into a STABLE breakdown that
 * always lists every known status (missing statuses default to 0), so a
 * consumer never has to defensively branch on an absent status. Statuses appear
 * in the enum's declaration order for deterministic serialization.
 */
function mergeStatusCounts(
  knownStatuses: readonly string[],
  statusRows: Array<Record<string, unknown>>,
): QueueStatusCount[] {
  const countsByStatus = new Map<string, number>();
  for (const row of statusRows) {
    countsByStatus.set(rowString(row, "status"), rowNumber(row, "count"));
  }
  return knownStatuses.map((status) => ({
    status,
    count: countsByStatus.get(status) ?? 0,
  }));
}

function normalizeDeadLetterLimit(value: number | undefined): number {
  if (value === undefined) {
    return 50;
  }
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new Error("queue health dead-letter limit must be an integer from 1 through 200");
  }
  return value;
}
