import { sql, type SQL } from "drizzle-orm";
import {
  eventOutbox,
  type JobStatus,
  jobIdempotencyPolicyValues,
  jobQueue,
  jobStatusValues,
  type OutboxStatus,
  outboxStatusValues,
} from "../schema.js";
import {
  JobLeaseRevalidationError,
  type JobLeaseOperation,
  type JobLeaseRevalidationReason,
  type JobQueueInput,
  type JobQueueRecord,
  OutboxLeaseRevalidationError,
  type OutboxEventInput,
  type OutboxEventRecord,
  type OutboxLeaseOperation,
  type OutboxLeaseRevalidationReason,
  type QueueSqlExecutor,
  jobLeaseRevalidationReasons,
  outboxLeaseRevalidationReasons,
} from "./event-queue-repository-types.js";
import {
  createUuid7,
  jobFromRow,
  nullableRowDate,
  nullableRowString,
  outboxEventFromRow,
  rowString,
} from "./event-queue-repository-mappers.js";

type InsertOutboxEventResult = {
  outboxEvent: OutboxEventRecord;
  inserted: boolean;
};

export async function insertOutboxEvent(
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

export async function insertJob(
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

export async function executeRows(
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
export async function throwJobLeaseRevalidationError(
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
export async function throwOutboxLeaseRevalidationError(
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
