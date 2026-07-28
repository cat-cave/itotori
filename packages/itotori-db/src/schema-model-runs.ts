import {
  bigint as pgBigint,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projects, localeBranches } from "./schema-project-core.js";
import { events, jobQueue } from "./schema-events.js";

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

export const costLedgerEntries = pgTable(
  "itotori_cost_ledger_entries",
  {
    costLedgerEntryId: text("cost_ledger_entry_id").primaryKey(),
    providerRunId: text("provider_run_id")
      .notNull()
      .references(() => providerRuns.providerRunId, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id").references(() => localeBranches.localeBranchId, {
      onDelete: "set null",
    }),
    costKind: text("cost_kind").notNull(),
    currency: text("currency").notNull(),
    amountMicrosUsd: pgBigint("amount_micros_usd", { mode: "number" }),
    pricingSnapshotId: text("pricing_snapshot_id"),
    tokenCountSource: text("token_count_source").notNull(),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    cachedInputTokens: integer("cached_input_tokens"),
    totalTokens: integer("total_tokens"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_cost_ledger_provider_run_idx").on(table.providerRunId),
    index("itotori_cost_ledger_project_kind_idx").on(table.projectId, table.costKind),
    index("itotori_cost_ledger_project_created_idx").on(table.projectId, table.createdAt),
  ],
);

export const findings = pgTable(
  "itotori_findings",
  {
    findingId: text("finding_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id").references(() => localeBranches.localeBranchId, {
      onDelete: "set null",
    }),
    findingKind: text("finding_kind").notNull(),
    severity: text("severity").notNull(),
    qualityCategory: text("quality_category"),
    title: text("title").notNull(),
    description: text("description").notNull(),
    impact: text("impact").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    reportedByTaskId: text("reported_by_task_id"),
    firstSeenEventId: text("first_seen_event_id").references(() => events.eventId, {
      onDelete: "set null",
    }),
    affectedRefs: jsonb("affected_refs").$type<unknown[]>().notNull(),
    evidence: jsonb("evidence").$type<unknown[]>().notNull(),
    provenance: jsonb("provenance").$type<unknown[]>().notNull(),
    causalLinks: jsonb("causal_links").$type<unknown[]>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_findings_project_branch_status_idx").on(
      table.projectId,
      table.localeBranchId,
      table.status,
    ),
    index("itotori_findings_project_severity_created_idx").on(
      table.projectId,
      table.severity,
      table.createdAt,
    ),
    index("itotori_findings_first_seen_event_idx").on(table.firstSeenEventId),
  ],
);
