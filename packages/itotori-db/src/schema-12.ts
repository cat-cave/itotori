import {
  foreignKey,
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

import { type JobStatus } from "./schema-01.js";
import { projects } from "./schema-07.js";
import { localeBranches } from "./schema-08.js";
import { jobQueue } from "./schema-11.js";

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

export const modelProviders = pgTable(
  "itotori_model_providers",
  {
    providerId: text("provider_id").primaryKey(),
    providerFamily: text("provider_family").notNull(),
    endpointFamily: text("endpoint_family").notNull(),
    providerName: text("provider_name").notNull(),
    // Dropped `data_handling` and `account_privacy` jsonb columns left over
    // from the retired per-pair privacy registry. The canonical privacy
    // posture is now account-wide ZDR + per-request `provider.zdr=true`; the
    // routing-posture jsonb on `itotori_provider_runs` is the auditable
    // record of that posture per call.
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_model_providers_identity_idx").on(
      table.providerFamily,
      table.endpointFamily,
      table.providerName,
    ),
  ],
);

export const modelRegistry = pgTable(
  "itotori_model_registry",
  {
    modelRegistryId: text("model_registry_id").primaryKey(),
    providerId: text("provider_id")
      .notNull()
      .references(() => modelProviders.providerId, { onDelete: "restrict" }),
    modelId: text("model_id").notNull(),
    capabilities: jsonb("capabilities").$type<Record<string, unknown>>().notNull(),
    pricing: jsonb("pricing").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_model_registry_provider_model_idx").on(table.providerId, table.modelId),
    index("itotori_model_registry_model_idx").on(table.modelId),
  ],
);

export const promptPresets = pgTable(
  "itotori_prompt_presets",
  {
    promptPresetId: text("prompt_preset_id").notNull(),
    promptTemplateVersion: text("prompt_template_version").notNull(),
    presetSchemaVersion: text("preset_schema_version").notNull(),
    promptHash: text("prompt_hash").notNull(),
    configSnapshot: jsonb("config_snapshot").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.promptPresetId, table.promptTemplateVersion] }),
    index("itotori_prompt_presets_hash_idx").on(table.promptHash),
  ],
);

export const modelRoutingSettings = pgTable(
  "itotori_model_routing_settings",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    taskKind: text("task_kind").notNull(),
    providerId: text("provider_id")
      .notNull()
      .references(() => modelProviders.providerId, { onDelete: "restrict" }),
    modelRegistryId: text("model_registry_id")
      .notNull()
      .references(() => modelRegistry.modelRegistryId, { onDelete: "restrict" }),
    modelId: text("model_id").notNull(),
    fallbackModelIds: jsonb("fallback_model_ids").$type<string[]>().notNull().default([]),
    promptPresetId: text("prompt_preset_id").notNull(),
    promptTemplateVersion: text("prompt_template_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.taskKind] }),
    index("itotori_model_routing_settings_project_idx").on(table.projectId),
    foreignKey({
      columns: [table.promptPresetId, table.promptTemplateVersion],
      foreignColumns: [promptPresets.promptPresetId, promptPresets.promptTemplateVersion],
      name: "itotori_model_routing_settings_prompt_preset_fk",
    }),
  ],
);

// itotori-translation-scope-settings — config-driven translation scope
// (dialogue-only -> dialogue-and-choices -> dialogue-choices-ui -> all), one
// row per locale branch. This is the DB-backed default the whole-project
// localize command consults when its run request omits `--output-scope` — see
// `apps/itotori/src/cli/localize-command.ts`.
export const translationScopeSettings = pgTable(
  "itotori_translation_scope_settings",
  {
    localeBranchId: text("locale_branch_id")
      .primaryKey()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("itotori_translation_scope_settings_project_idx").on(table.projectId)],
);

// p3-wire-localization-pass-run-config-registry — one operator-local whole-
// project run configuration per project/locale branch. The paths are local
// references only; game bytes never enter this table or a published artifact.
export const localizationPassRunConfigs = pgTable(
  "itotori_localization_pass_run_configs",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    configPath: text("config_path").notNull(),
    dataRoot: text("data_root").notNull(),
    pairPolicyPath: text("pair_policy_path").notNull(),
    modelId: text("model_id").notNull(),
    providerId: text("provider_id").notNull(),
    runDir: text("run_dir").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.localeBranchId] }),
    index("itotori_localization_pass_run_configs_branch_idx").on(table.localeBranchId),
  ],
);

/** Immutable CAS snapshots bound to every durable project run. */
