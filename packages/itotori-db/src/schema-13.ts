import {
  bigint as pgBigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
// Type-only import (erased at compile time — no runtime cycle with
// authorization.ts, which imports table VALUES from this module). Types the
// auth permission-set / grant / audit columns to the single Permission source
// of truth in authorization.ts.
import type { Permission } from "./authorization.js";

import { projects } from "./schema-07.js";
import { localeBranches } from "./schema-08.js";
import { jobQueue } from "./schema-11.js";
import { modelProviders, modelRegistry, promptPresets } from "./schema-12.js";

export const llmContextSnapshots = pgTable("itotori_llm_context_snapshots", {
  snapshotId: text("snapshot_id").primaryKey(),
  schemaVersion: text("schema_version").notNull(),
  snapshotContentHash: text("snapshot_content_hash").notNull(),
  snapshotIdentity: jsonb("snapshot_identity").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

/** Immutable localization CAS snapshots bound to every durable project run. */
export const llmLocalizationSnapshots = pgTable("itotori_llm_localization_snapshots", {
  snapshotId: text("snapshot_id").primaryKey(),
  schemaVersion: text("schema_version").notNull(),
  snapshotContentHash: text("snapshot_content_hash").notNull(),
  contextSnapshotId: text("context_snapshot_id")
    .notNull()
    .references(() => llmContextSnapshots.snapshotId, { onDelete: "restrict" }),
  snapshotIdentity: jsonb("snapshot_identity").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const projectRuns = pgTable(
  "itotori_project_runs",
  {
    runId: text("run_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    contextSnapshotId: text("context_snapshot_id")
      .notNull()
      .references(() => llmContextSnapshots.snapshotId, { onDelete: "restrict" }),
    localizationSnapshotId: text("localization_snapshot_id")
      .notNull()
      .references(() => llmLocalizationSnapshots.snapshotId, { onDelete: "restrict" }),
    status: text("status").notNull(),
    leaseOwnerId: text("lease_owner_id"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    fenceToken: pgBigint("fence_token", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("itotori_project_runs_scope_key").on(table.runId, table.projectId),
    index("itotori_project_runs_project_status_idx").on(
      table.projectId,
      table.status,
      table.updatedAt,
    ),
    index("itotori_project_runs_lease_idx").on(table.status, table.leaseExpiresAt),
    uniqueIndex("itotori_project_runs_one_active_branch_idx")
      .on(table.projectId, table.localeBranchId)
      .where(sql`${table.status} in ('queued', 'running', 'paused')`),
    foreignKey({
      columns: [table.projectId, table.localeBranchId],
      foreignColumns: [localeBranches.projectId, localeBranches.localeBranchId],
      name: "itotori_project_runs_branch_scope_fkey",
    }).onDelete("cascade"),
  ],
);

export const projectRunCostAccounts = pgTable(
  "itotori_project_run_cost_accounts",
  {
    runId: text("run_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    capMicrosUsd: pgBigint("cap_micros_usd", { mode: "number" }),
    spentMicrosUsd: pgBigint("spent_micros_usd", { mode: "number" }).notNull().default(0),
    reservedMicrosUsd: pgBigint("reserved_micros_usd", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("itotori_project_run_cost_accounts_scope_key").on(table.runId, table.projectId),
    foreignKey({
      columns: [table.runId, table.projectId],
      foreignColumns: [projectRuns.runId, projectRuns.projectId],
      name: "itotori_project_run_cost_accounts_run_scope_fkey",
    }).onDelete("cascade"),
  ],
);

export const projectRunCostReservations = pgTable(
  "itotori_project_run_cost_reservations",
  {
    reservationId: text("reservation_id").notNull(),
    runId: text("run_id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    reservedMicrosUsd: pgBigint("reserved_micros_usd", { mode: "number" }).notNull(),
    settledMicrosUsd: pgBigint("settled_micros_usd", { mode: "number" }),
    state: text("state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.reservationId] }),
    index("itotori_project_run_cost_reservations_scope_state_idx").on(
      table.runId,
      table.projectId,
      table.state,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.runId, table.projectId],
      foreignColumns: [projectRunCostAccounts.runId, projectRunCostAccounts.projectId],
      name: "itotori_project_run_cost_reservations_account_fkey",
    }).onDelete("cascade"),
  ],
);

export const projectRunProgress = pgTable(
  "itotori_project_run_progress",
  {
    runId: text("run_id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    bridgeUnitId: text("bridge_unit_id").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull(),
    costMicrosUsd: pgBigint("cost_micros_usd", { mode: "number" }).notNull().default(0),
    coveragePercent: integer("coverage_percent").notNull().default(0),
    blockers: jsonb("blockers")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.bridgeUnitId, table.role] }),
    index("itotori_project_run_progress_scope_status_idx").on(
      table.runId,
      table.projectId,
      table.status,
    ),
    foreignKey({
      columns: [table.runId, table.projectId],
      foreignColumns: [projectRuns.runId, projectRuns.projectId],
      name: "itotori_project_run_progress_run_scope_fkey",
    }).onDelete("cascade"),
  ],
);

export const providerRuns = pgTable(
  "itotori_provider_runs",
  {
    providerRunId: text("provider_run_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id").references(() => localeBranches.localeBranchId, {
      onDelete: "set null",
    }),
    jobId: text("job_id").references(() => jobQueue.jobId, { onDelete: "set null" }),
    systemId: text("system_id"),
    taskKind: text("task_kind").notNull(),
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    latencyMs: integer("latency_ms"),
    providerId: text("provider_id")
      .notNull()
      .references(() => modelProviders.providerId, { onDelete: "restrict" }),
    requestedModelRegistryId: text("requested_model_registry_id")
      .notNull()
      .references(() => modelRegistry.modelRegistryId, { onDelete: "restrict" }),
    actualModelRegistryId: text("actual_model_registry_id")
      .notNull()
      .references(() => modelRegistry.modelRegistryId, { onDelete: "restrict" }),
    requestedModelId: text("requested_model_id").notNull(),
    actualModelId: text("actual_model_id").notNull(),
    upstreamProvider: text("upstream_provider"),
    routeSettingsHash: text("route_settings_hash"),
    promptPresetId: text("prompt_preset_id").notNull(),
    promptTemplateVersion: text("prompt_template_version").notNull(),
    promptHash: text("prompt_hash").notNull(),
    providerPreset: jsonb("provider_preset").$type<Record<string, unknown> | null>(),
    structuredOutputMode: text("structured_output_mode").notNull(),
    retryCount: integer("retry_count").notNull(),
    errorClasses: jsonb("error_classes").$type<string[]>().notNull(),
    fallbackUsed: boolean("fallback_used").notNull(),
    fallbackPlan: jsonb("fallback_plan").$type<string[]>().notNull(),
    tokenCountSource: text("token_count_source").notNull(),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    cachedInputTokens: integer("cached_input_tokens"),
    totalTokens: integer("total_tokens"),
    // Captured OpenRouter routing posture for THIS run. Required (non-null)
    // post-migration; pre-migration rows carry the sentinel
    // `{"_pre_itotori_230": true}` jsonb so they cannot be mistaken for a
    // real captured posture by telemetry queries that filter on
    // `routing_posture->>'zdr' = 'true'`. The corresponding current LLM
    // boundary supplies this captured posture as validated JSON.
    routingPosture: jsonb("routing_posture").$type<Record<string, unknown>>().notNull(),
    adapterMetadata: jsonb("adapter_metadata").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_provider_runs_project_started_idx").on(table.projectId, table.startedAt),
    index("itotori_provider_runs_project_task_idx").on(table.projectId, table.taskKind),
    index("itotori_provider_runs_prompt_idx").on(table.promptPresetId, table.promptTemplateVersion),
    index("itotori_provider_runs_fallback_idx").on(table.projectId, table.fallbackUsed),
    foreignKey({
      columns: [table.promptPresetId, table.promptTemplateVersion],
      foreignColumns: [promptPresets.promptPresetId, promptPresets.promptTemplateVersion],
      name: "itotori_provider_runs_prompt_preset_fk",
    }).onDelete("restrict"),
  ],
);
