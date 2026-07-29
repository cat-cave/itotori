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
import { executeRows } from "./event-queue-repository-core.js";
import {
  jobFromRow,
  lagSeconds,
  mergeStatusCounts,
  normalizeDeadLetterLimit,
  normalizeRetentionDays,
  nullableRowDate,
  outboxEventFromRow,
  rowNumber,
  singleRow,
} from "./event-queue-repository-mappers.js";
import {
  QUEUE_HEALTH_READ_MODEL_SCHEMA_VERSION,
  type LoadQueueHealthOptions,
  type PruneJobEventsOptions,
  type QueueHealthReadModel,
  type QueueSqlExecutor,
} from "./event-queue-repository-types.js";

/**
 * Load the typed queue-health read-model. Computes, in three cheap
 * read-only queries per table (aggregate, per-status breakdown, bounded
 * dead-letter preview), the operator-facing metrics: outbox/job lag
 * (oldest un-processed age), pending counts by status, retry load, and the
 * dead-letter review. The lag is derived deterministically from
 * `generatedAt` minus the oldest un-processed timestamp (no moving DB
 * `now()`), so it is stable and testable. Gated on `queue.read`.
 */
export async function loadQueueHealth(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
  options: LoadQueueHealthOptions = {},
): Promise<QueueHealthReadModel> {
  await requirePermission(db, actor, permissionValues.queueRead);
  const deadLetterLimit = normalizeDeadLetterLimit(options.deadLetterLimit);
  const projectId = options.projectId;
  const projectFilter = projectId === undefined ? sql`` : sql`where project_id = ${projectId}`;
  const executor = db as unknown as QueueSqlExecutor;
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
export async function pruneJobEvents(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
  options: PruneJobEventsOptions = {},
): Promise<number> {
  await requirePermission(db, actor, permissionValues.queueManage);
  const olderThanDays = normalizeRetentionDays(options.olderThanDays);
  return db.transaction(async (tx) => {
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
