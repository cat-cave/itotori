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
    const rows = await executeRows(
      this.db as unknown as QueueSqlExecutor,
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
        returning *
      `,
    );
    return singleOutboxRow(rows, outboxEventId);
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
    const rows = await executeRows(
      this.db as unknown as QueueSqlExecutor,
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
        returning e.*
      `,
    );
    return singleOutboxRow(rows, outboxEventId);
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
    const rows = await executeRows(
      this.db as unknown as QueueSqlExecutor,
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
        returning *
      `,
    );
    return singleJobRow(rows, jobId);
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
    const rows = await executeRows(
      this.db as unknown as QueueSqlExecutor,
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
        returning j.*
      `,
    );
    return singleJobRow(rows, jobId);
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
