import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyEventQueueIndexAlignment } from "./verify-event-queue-index-alignment.mjs";

test("accepts the repository event outbox and job queue index definitions", () => {
  assert.doesNotThrow(() => verifyEventQueueIndexAlignment());
});

test("rejects an index declared only in the Drizzle schema", async () => {
  const fixture = await createFixture({
    schema: baseSchema().replace(
      `index("itotori_event_outbox_correlation_idx").on(table.correlationId),`,
      `index("itotori_event_outbox_correlation_idx").on(table.correlationId),
    index("itotori_event_outbox_schema_only_idx").on(table.status),`,
    ),
    migration: baseMigration(),
  });

  try {
    assert.throws(
      () =>
        verifyEventQueueIndexAlignment({
          schemaPath: fixture.schemaPath,
          migrationsDir: fixture.migrationsDir,
        }),
      /schema-only index itotori_event_outbox_schema_only_idx/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects an index declared only in SQL migrations", async () => {
  const fixture = await createFixture({
    schema: baseSchema(),
    migration:
      baseMigration() +
      "\ncreate index if not exists itotori_jobs_migration_only_idx on itotori_jobs(status);\n",
  });

  try {
    assert.throws(
      () =>
        verifyEventQueueIndexAlignment({
          schemaPath: fixture.schemaPath,
          migrationsDir: fixture.migrationsDir,
        }),
      /migration-only index itotori_jobs_migration_only_idx/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a shared index name with different columns or ordering", async () => {
  const fixture = await createFixture({
    schema: baseSchema(),
    migration: baseMigration().replace(
      "on itotori_jobs(queue_name, status, available_at, priority desc, created_at);",
      "on itotori_jobs(queue_name, status, available_at, priority, created_at);",
    ),
  });

  try {
    assert.throws(
      () =>
        verifyEventQueueIndexAlignment({
          schemaPath: fixture.schemaPath,
          migrationsDir: fixture.migrationsDir,
        }),
      /index itotori_jobs_ready_idx differs/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture({ schema, migration }) {
  const root = await mkdtemp(path.join(tmpdir(), "itotori-event-queue-index-"));
  const srcDir = path.join(root, "src");
  const migrationsDir = path.join(root, "migrations");
  await mkdir(srcDir);
  await mkdir(migrationsDir);

  const schemaPath = path.join(srcDir, "schema.ts");
  await writeFile(schemaPath, schema);
  await writeFile(path.join(migrationsDir, "0001_event_queue.sql"), migration);

  return { root, schemaPath, migrationsDir };
}

function baseSchema() {
  return `
    import { index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

    export const eventOutbox = pgTable(
      "itotori_event_outbox",
      {
        outboxEventId: text("outbox_event_id").primaryKey(),
        projectId: text("project_id").notNull(),
        sourceEventId: text("source_event_id"),
        eventType: text("event_type").notNull(),
        status: text("status").notNull(),
        idempotencyKey: text("idempotency_key").notNull(),
        correlationId: text("correlation_id").notNull(),
        availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
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
        projectId: text("project_id").notNull(),
        sourceEventId: text("source_event_id"),
        triggerOutboxEventId: text("trigger_outbox_event_id"),
        jobType: text("job_type").notNull(),
        queueName: text("queue_name").notNull(),
        status: text("status").notNull(),
        idempotencyKey: text("idempotency_key"),
        correlationId: text("correlation_id").notNull(),
        priority: integer("priority").notNull(),
        availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
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
      ],
    );
  `;
}

function baseMigration() {
  return `
    create unique index if not exists itotori_event_outbox_idempotency_key_idx
      on itotori_event_outbox(idempotency_key);
    create index if not exists itotori_event_outbox_ready_idx
      on itotori_event_outbox(status, available_at, created_at);
    create index if not exists itotori_event_outbox_project_type_idx
      on itotori_event_outbox(project_id, event_type);
    create index if not exists itotori_event_outbox_source_event_idx
      on itotori_event_outbox(source_event_id);
    create index if not exists itotori_event_outbox_correlation_idx
      on itotori_event_outbox(correlation_id);

    create unique index if not exists itotori_jobs_idempotency_key_idx
      on itotori_jobs(idempotency_key);
    create index if not exists itotori_jobs_ready_idx
      on itotori_jobs(queue_name, status, available_at, priority desc, created_at);
    create index if not exists itotori_jobs_project_type_status_idx
      on itotori_jobs(project_id, job_type, status);
    create index if not exists itotori_jobs_trigger_outbox_event_idx
      on itotori_jobs(trigger_outbox_event_id);
    create index if not exists itotori_jobs_source_event_idx
      on itotori_jobs(source_event_id);
    create index if not exists itotori_jobs_correlation_idx
      on itotori_jobs(correlation_id);
  `;
}
