import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { type JobStatus } from "./schema-values-core.js";
import { projects, localeBranches } from "./schema-project-core.js";

export const events = pgTable(
  "itotori_events",
  {
    eventId: text("event_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id").references(() => localeBranches.localeBranchId, {
      onDelete: "set null",
    }),
    eventKind: text("event_kind").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    actor: jsonb("actor").$type<unknown>().notNull(),
    taskId: text("task_id"),
    findingId: text("finding_id"),
    subjectRefs: jsonb("subject_refs").$type<unknown[]>().notNull(),
    provenance: jsonb("provenance").$type<unknown[]>().notNull(),
    causalLinks: jsonb("causal_links").$type<unknown[]>().notNull(),
    payload: jsonb("payload").$type<unknown | null>(),
    appendedAt: timestamp("appended_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_events_project_branch_time_idx").on(
      table.projectId,
      table.localeBranchId,
      table.occurredAt,
    ),
    index("itotori_events_kind_time_idx").on(table.eventKind, table.occurredAt),
    index("itotori_events_task_idx").on(table.taskId),
    index("itotori_events_finding_idx").on(table.findingId),
  ],
);

export const eventOutbox = pgTable(
  "itotori_event_outbox",
  {
    outboxEventId: text("outbox_event_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id").references(() => localeBranches.localeBranchId, {
      onDelete: "set null",
    }),
    sourceEventId: text("source_event_id").references(() => events.eventId, {
      onDelete: "set null",
    }),
    eventType: text("event_type").notNull(),
    status: text("status").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    correlationId: text("correlation_id").notNull(),
    causationId: text("causation_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(25),
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    lastError: text("last_error"),
    errorHistory: jsonb("error_history")
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_event_outbox_idempotency_key_idx").on(table.idempotencyKey),
    index("itotori_event_outbox_ready_idx").on(table.status, table.availableAt, table.createdAt),
    index("itotori_event_outbox_project_type_idx").on(table.projectId, table.eventType),
    index("itotori_event_outbox_source_event_idx").on(table.sourceEventId),
    index("itotori_event_outbox_correlation_idx").on(table.correlationId),
  ],
);

export const jobQueue = pgTable(
  "itotori_jobs",
  {
    jobId: text("job_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id").references(() => localeBranches.localeBranchId, {
      onDelete: "set null",
    }),
    sourceEventId: text("source_event_id").references(() => events.eventId, {
      onDelete: "set null",
    }),
    triggerOutboxEventId: text("trigger_outbox_event_id").references(
      () => eventOutbox.outboxEventId,
      { onDelete: "set null" },
    ),
    jobType: text("job_type").notNull(),
    jobName: text("job_name").notNull(),
    queueName: text("queue_name").notNull().default("default"),
    status: text("status").notNull(),
    idempotencyPolicy: text("idempotency_policy").notNull(),
    idempotencyKey: text("idempotency_key"),
    correlationId: text("correlation_id").notNull(),
    causationId: text("causation_id"),
    subjectRefs: jsonb("subject_refs").$type<unknown[]>().notNull(),
    dependsOnJobIds: jsonb("depends_on_job_ids")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    priority: integer("priority").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastError: text("last_error"),
    errorHistory: jsonb("error_history")
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    result: jsonb("result").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_jobs_idempotency_key_idx").on(table.idempotencyKey),
    index("itotori_jobs_ready_idx").on(
      table.queueName,
      table.status,
      table.availableAt,
      table.priority.desc(),
      table.createdAt,
    ),
    index("itotori_jobs_project_type_status_idx").on(table.projectId, table.jobType, table.status),
    index("itotori_jobs_trigger_outbox_event_idx").on(table.triggerOutboxEventId),
    index("itotori_jobs_source_event_idx").on(table.sourceEventId),
    index("itotori_jobs_correlation_idx").on(table.correlationId),
    index("itotori_jobs_depends_on_job_ids_gin_idx").using("gin", table.dependsOnJobIds),
  ],
);

// Append-only audit trail for the job-queue lifecycle. One immutable row is
// written by the `itotori_job_events_capture` DB trigger for every genuine
// `itotori_jobs.status` transition (or insert), so the queue's history cannot
// be silently rewritten. See migration 0052 for the capture + append-only
// triggers and the retention policy enforced by pruneJobEvents().
export const jobEventTypeValues = {
  enqueued: "enqueued",
  claimed: "claimed",
  succeeded: "succeeded",
  retryScheduled: "retry_scheduled",
  deadLettered: "dead_lettered",
  cancelled: "cancelled",
  requeued: "requeued",
} as const;

export type JobEventType = (typeof jobEventTypeValues)[keyof typeof jobEventTypeValues];

export const jobEvents = pgTable(
  "itotori_job_events",
  {
    jobEventId: text("job_event_id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobQueue.jobId, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id").references(() => localeBranches.localeBranchId, {
      onDelete: "set null",
    }),
    queueName: text("queue_name").notNull(),
    eventType: text("event_type").$type<JobEventType>().notNull(),
    priorStatus: text("prior_status").$type<JobStatus>(),
    nextStatus: text("next_status").$type<JobStatus>().notNull(),
    attemptCount: integer("attempt_count").notNull(),
    workerId: text("worker_id"),
    correlationId: text("correlation_id").notNull(),
    detail: jsonb("detail")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_job_events_job_time_idx").on(table.jobId, table.recordedAt),
    index("itotori_job_events_project_time_idx").on(table.projectId, table.recordedAt),
    index("itotori_job_events_status_time_idx").on(table.nextStatus, table.recordedAt),
  ],
);
