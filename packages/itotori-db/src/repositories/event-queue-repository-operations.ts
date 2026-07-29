import { sql } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import {
  eventOutbox,
  jobEvents,
  jobQueue,
  jobStatusValues,
  outboxStatusValues,
} from "../schema.js";
import {
  enqueueJobInputsInTransaction,
  executeRows,
  insertJob,
  insertOutboxEvent,
  throwJobLeaseRevalidationError,
  throwOutboxLeaseRevalidationError,
} from "./event-queue-repository-core.js";
import { loadQueueHealth, pruneJobEvents } from "./event-queue-repository-health.js";
import {
  errorMessage,
  jobEventFromRow,
  jobFromRow,
  normalizeLeaseSeconds,
  normalizeLimit,
  normalizeRetryAfterSeconds,
  outboxEventFromRow,
} from "./event-queue-repository-mappers.js";
import type {
  ClaimJobsOptions,
  ClaimOutboxEventsOptions,
  ItotoriEventQueueRepositoryPort,
  JobEventRecord,
  JobQueueInput,
  JobQueueRecord,
  LoadQueueHealthOptions,
  OutboxEventInput,
  OutboxEventRecord,
  OutboxEventWithJobsInput,
  OutboxEventWithJobsResult,
  PruneJobEventsOptions,
  QueueFailureInput,
  QueueHealthReadModel,
  QueueJsonRecord,
  QueueSqlExecutor,
} from "./event-queue-repository-types.js";

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

  async loadQueueHealth(
    actor: AuthorizationActor,
    options: LoadQueueHealthOptions = {},
  ): Promise<QueueHealthReadModel> {
    return loadQueueHealth(this.db, actor, options);
  }

  async pruneJobEvents(
    actor: AuthorizationActor,
    options: PruneJobEventsOptions = {},
  ): Promise<number> {
    return pruneJobEvents(this.db, actor, options);
  }
}
