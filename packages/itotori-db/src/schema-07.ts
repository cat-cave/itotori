import {
  boolean,
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
// Type-only import (erased at compile time — no runtime cycle with
// authorization.ts, which imports table VALUES from this module). Types the
// auth permission-set / grant / audit columns to the single Permission source
// of truth in authorization.ts.

import { users } from "./schema-03.js";
import { catalogSourceProvenance } from "./schema-04.js";

export const catalogCrawlerJobs = pgTable(
  "itotori_catalog_crawler_jobs",
  {
    crawlerJobId: text("crawler_job_id").primaryKey(),
    catalogSource: text("catalog_source").notNull(),
    adapterName: text("adapter_name").notNull(),
    adapterVersion: text("adapter_version").notNull(),
    sourceVersion: text("source_version").notNull(),
    parserVersion: text("parser_version").notNull(),
    partitionKey: text("partition_key").notNull(),
    status: text("status").notNull(),
    checkpointCursor: jsonb("checkpoint_cursor").$type<unknown | null>(),
    lockedBy: text("locked_by").notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastError: text("last_error"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_catalog_crawler_jobs_active_partition_idx")
      .on(table.catalogSource, table.adapterName, table.partitionKey)
      .where(sql`${table.status} = 'running'`),
    index("itotori_catalog_crawler_jobs_source_status_idx").on(
      table.catalogSource,
      table.status,
      table.updatedAt,
    ),
    index("itotori_catalog_crawler_jobs_lease_idx").on(table.leaseExpiresAt),
  ],
);

export const catalogCrawlerCheckpoints = pgTable(
  "itotori_catalog_crawler_checkpoints",
  {
    catalogSource: text("catalog_source").notNull(),
    adapterName: text("adapter_name").notNull(),
    partitionKey: text("partition_key").notNull(),
    checkpointCursor: jsonb("checkpoint_cursor").$type<unknown | null>(),
    sourceVersion: text("source_version").notNull(),
    parserVersion: text("parser_version").notNull(),
    lastCrawlerJobId: text("last_crawler_job_id").references(
      () => catalogCrawlerJobs.crawlerJobId,
      { onDelete: "set null" },
    ),
    lastStepKey: text("last_step_key"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (table) => [
    primaryKey({ columns: [table.catalogSource, table.adapterName, table.partitionKey] }),
    index("itotori_catalog_crawler_checkpoints_job_idx").on(table.lastCrawlerJobId),
  ],
);

export const catalogCrawlerRateLimits = pgTable(
  "itotori_catalog_crawler_rate_limits",
  {
    catalogSource: text("catalog_source").notNull(),
    adapterName: text("adapter_name").notNull(),
    partitionKey: text("partition_key").notNull(),
    nextAvailableAt: timestamp("next_available_at", { withTimezone: true }),
    resetAt: timestamp("reset_at", { withTimezone: true }),
    remaining: integer("remaining"),
    limit: integer("limit"),
    retryAfterSeconds: integer("retry_after_seconds"),
    requestIdentity: text("request_identity"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.catalogSource, table.adapterName, table.partitionKey] }),
    index("itotori_catalog_crawler_rate_limits_next_idx").on(table.nextAvailableAt),
  ],
);

export const catalogCrawlerJobSteps = pgTable(
  "itotori_catalog_crawler_job_steps",
  {
    crawlerJobStepId: text("crawler_job_step_id").primaryKey(),
    crawlerJobId: text("crawler_job_id")
      .notNull()
      .references(() => catalogCrawlerJobs.crawlerJobId, { onDelete: "cascade" }),
    stepKey: text("step_key").notNull(),
    catalogSource: text("catalog_source").notNull(),
    adapterName: text("adapter_name").notNull(),
    partitionKey: text("partition_key").notNull(),
    sourceId: text("source_id").notNull(),
    requestIdentity: text("request_identity").notNull(),
    sourceVersion: text("source_version").notNull(),
    parserVersion: text("parser_version").notNull(),
    checkpointCursor: jsonb("checkpoint_cursor").$type<unknown | null>(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    httpStatus: integer("http_status"),
    ok: boolean("ok").notNull(),
    payloadHash: text("payload_hash").notNull(),
    sourceProvenanceId: text("source_provenance_id")
      .notNull()
      .references(() => catalogSourceProvenance.sourceProvenanceId, { onDelete: "restrict" }),
    status: text("status").notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true }),
    error: text("error"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_catalog_crawler_job_steps_job_step_idx").on(
      table.crawlerJobId,
      table.stepKey,
    ),
    index("itotori_catalog_crawler_job_steps_source_request_idx").on(
      table.catalogSource,
      table.adapterName,
      table.partitionKey,
      table.requestIdentity,
      table.fetchedAt,
    ),
    index("itotori_catalog_crawler_job_steps_provenance_idx").on(table.sourceProvenanceId),
    index("itotori_catalog_crawler_job_steps_status_idx").on(table.status, table.updatedAt),
  ],
);

export const workspaces = pgTable("itotori_workspaces", {
  workspaceId: text("workspace_id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projects = pgTable(
  "itotori_projects",
  {
    projectId: text("project_id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.workspaceId, { onDelete: "cascade" }),
    projectKey: text("project_key").notNull(),
    name: text("name").notNull(),
    sourceLocale: text("source_locale").notNull(),
    status: text("status").notNull(),
    gameId: text("game_id"),
    gameVersion: text("game_version"),
    sourceProfileId: text("source_profile_id"),
    engineFamily: text("engine_family"),
    sourceRoot: text("source_root"),
    buildRoot: text("build_root"),
    extractProfile: jsonb("extract_profile").$type<Record<string, unknown>>(),
    createdByUserId: text("created_by_user_id").references(() => users.userId, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_projects_workspace_key_idx").on(table.workspaceId, table.projectKey),
    index("itotori_projects_workspace_status_idx").on(table.workspaceId, table.status),
  ],
);

export const sourceRevisions = pgTable(
  "itotori_source_revisions",
  {
    sourceRevisionId: text("source_revision_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    revisionKind: text("revision_kind").notNull(),
    value: text("value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_source_revisions_project_idx").on(table.projectId),
    index("itotori_source_revisions_kind_value_idx").on(table.revisionKind, table.value),
  ],
);
