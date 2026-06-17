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
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const projectStatusValues = {
  imported: "imported",
  drafted: "drafted",
  patchExported: "patch_exported",
  runtimeIngested: "runtime_ingested",
  archived: "archived",
} as const;

export type ProjectStatus = (typeof projectStatusValues)[keyof typeof projectStatusValues];

export const localeBranchStatusValues = {
  active: "active",
  archived: "archived",
} as const;

export type LocaleBranchStatus =
  (typeof localeBranchStatusValues)[keyof typeof localeBranchStatusValues];

export const outboxEventTypeValues = {
  agentTaskRequested: "agent_task_requested",
  deterministicToolTaskRequested: "deterministic_tool_task_requested",
  rerunRequested: "rerun_requested",
  triageLoopRequested: "triage_loop_requested",
  jobScheduled: "job_scheduled",
  jobCompleted: "job_completed",
  jobFailed: "job_failed",
  jobDeadLettered: "job_dead_lettered",
} as const;

export type OutboxEventType = (typeof outboxEventTypeValues)[keyof typeof outboxEventTypeValues];

export const outboxStatusValues = {
  pending: "pending",
  publishing: "publishing",
  published: "published",
  retryWaiting: "retry_waiting",
  deadLetter: "dead_letter",
} as const;

export type OutboxStatus = (typeof outboxStatusValues)[keyof typeof outboxStatusValues];

export const jobTaskTypeValues = {
  agentTask: "agent_task",
  deterministicToolTask: "deterministic_tool_task",
  rerun: "rerun",
  triageLoop: "triage_loop",
} as const;

export type JobTaskType = (typeof jobTaskTypeValues)[keyof typeof jobTaskTypeValues];

export const jobStatusValues = {
  queued: "queued",
  running: "running",
  retryWaiting: "retry_waiting",
  succeeded: "succeeded",
  deadLetter: "dead_letter",
  cancelled: "cancelled",
} as const;

export type JobStatus = (typeof jobStatusValues)[keyof typeof jobStatusValues];

export const jobIdempotencyPolicyValues = {
  idempotent: "idempotent",
  nonIdempotent: "non_idempotent",
} as const;

export type JobIdempotencyPolicy =
  (typeof jobIdempotencyPolicyValues)[keyof typeof jobIdempotencyPolicyValues];

export const providerRunStatusValues = {
  succeeded: "succeeded",
  failed: "failed",
  partial: "partial",
  skipped: "skipped",
} as const;

export type ProviderRunStatus =
  (typeof providerRunStatusValues)[keyof typeof providerRunStatusValues];

export const providerCostKindValues = {
  billed: "billed",
  providerEstimate: "provider_estimate",
  localEstimate: "local_estimate",
  zero: "zero",
  unknown: "unknown",
} as const;

export type ProviderCostKind = (typeof providerCostKindValues)[keyof typeof providerCostKindValues];

export const users = pgTable("itotori_users", {
  userId: text("user_id").primaryKey(),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userPermissionGrants = pgTable(
  "itotori_user_permission_grants",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.userId, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.permission] })],
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

export const sourceBundles = pgTable(
  "itotori_source_bundles",
  {
    sourceBundleId: text("source_bundle_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    sourceBundleRevisionId: text("source_bundle_revision_id")
      .notNull()
      .references(() => sourceRevisions.sourceRevisionId, { onDelete: "restrict" }),
    bridgeId: text("bridge_id").notNull(),
    schemaVersion: text("schema_version").notNull(),
    sourceBundleHash: text("source_bundle_hash").notNull(),
    sourceLocale: text("source_locale").notNull(),
    extractorName: text("extractor_name").notNull(),
    extractorVersion: text("extractor_version").notNull(),
    unitCount: integer("unit_count").notNull(),
    assetCount: integer("asset_count").notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_source_bundles_bridge_idx").on(table.bridgeId),
    index("itotori_source_bundles_project_imported_idx").on(table.projectId, table.importedAt),
    index("itotori_source_bundles_revision_idx").on(table.sourceBundleRevisionId),
    index("itotori_source_bundles_hash_idx").on(table.sourceBundleHash),
  ],
);

export const assets = pgTable(
  "itotori_assets",
  {
    assetId: text("asset_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    sourceBundleId: text("source_bundle_id")
      .notNull()
      .references(() => sourceBundles.sourceBundleId, { onDelete: "cascade" }),
    sourceRevisionId: text("source_revision_id")
      .notNull()
      .references(() => sourceRevisions.sourceRevisionId, { onDelete: "restrict" }),
    assetKey: text("asset_key").notNull(),
    assetKind: text("asset_kind").notNull(),
    sourceHash: text("source_hash").notNull(),
    path: text("path"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_assets_project_kind_idx").on(table.projectId, table.assetKind),
    index("itotori_assets_bundle_key_idx").on(table.sourceBundleId, table.assetKey),
    index("itotori_assets_revision_idx").on(table.sourceRevisionId),
  ],
);

export const sourceUnits = pgTable(
  "itotori_source_units",
  {
    bridgeUnitId: text("bridge_unit_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    sourceBundleId: text("source_bundle_id")
      .notNull()
      .references(() => sourceBundles.sourceBundleId, { onDelete: "cascade" }),
    sourceAssetId: text("source_asset_id")
      .notNull()
      .references(() => assets.assetId, { onDelete: "restrict" }),
    sourceRevisionId: text("source_revision_id")
      .notNull()
      .references(() => sourceRevisions.sourceRevisionId, { onDelete: "restrict" }),
    surfaceId: text("surface_id").notNull(),
    surfaceKind: text("surface_kind").notNull(),
    sourceUnitKey: text("source_unit_key").notNull(),
    occurrenceId: text("occurrence_id").notNull(),
    sourceLocale: text("source_locale").notNull(),
    sourceText: text("source_text").notNull(),
    sourceHash: text("source_hash").notNull(),
    sourceLocation: jsonb("source_location").$type<unknown>().notNull(),
    speaker: jsonb("speaker").$type<unknown | null>(),
    context: jsonb("context").$type<unknown>().notNull(),
    policy: jsonb("policy").$type<unknown | null>(),
    spans: jsonb("spans").$type<unknown[]>().notNull(),
    patchRef: jsonb("patch_ref").$type<unknown>().notNull(),
    runtimeExpectation: jsonb("runtime_expectation").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_source_units_bundle_key_idx").on(
      table.sourceBundleId,
      table.sourceUnitKey,
    ),
    index("itotori_source_units_project_locale_key_idx").on(
      table.projectId,
      table.sourceLocale,
      table.sourceUnitKey,
    ),
    index("itotori_source_units_asset_idx").on(table.sourceAssetId),
    index("itotori_source_units_revision_idx").on(table.sourceRevisionId),
  ],
);

export const localeBranches = pgTable(
  "itotori_locale_branches",
  {
    localeBranchId: text("locale_branch_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    sourceBundleId: text("source_bundle_id")
      .notNull()
      .references(() => sourceBundles.sourceBundleId, { onDelete: "restrict" }),
    targetLocale: text("target_locale").notNull(),
    branchName: text("branch_name").notNull(),
    status: text("status").notNull(),
    createdByUserId: text("created_by_user_id").references(() => users.userId, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_locale_branches_project_locale_idx").on(table.projectId, table.targetLocale),
    index("itotori_locale_branches_bundle_idx").on(table.sourceBundleId),
  ],
);

export const localeBranchUnits = pgTable(
  "itotori_locale_branch_units",
  {
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    bridgeUnitId: text("bridge_unit_id")
      .notNull()
      .references(() => sourceUnits.bridgeUnitId, { onDelete: "cascade" }),
    targetText: text("target_text"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.localeBranchId, table.bridgeUnitId] }),
    index("itotori_locale_branch_units_bridge_unit_idx").on(table.bridgeUnitId),
  ],
);

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
      table.priority,
    ),
    index("itotori_jobs_project_type_status_idx").on(table.projectId, table.jobType, table.status),
    index("itotori_jobs_trigger_outbox_event_idx").on(table.triggerOutboxEventId),
    index("itotori_jobs_source_event_idx").on(table.sourceEventId),
    index("itotori_jobs_correlation_idx").on(table.correlationId),
  ],
);

export const modelProviders = pgTable(
  "itotori_model_providers",
  {
    providerId: text("provider_id").primaryKey(),
    providerFamily: text("provider_family").notNull(),
    endpointFamily: text("endpoint_family").notNull(),
    providerName: text("provider_name").notNull(),
    dataHandling: jsonb("data_handling").$type<Record<string, unknown>>().notNull(),
    accountPrivacy: jsonb("account_privacy").$type<Record<string, unknown> | null>(),
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
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    latencyMs: integer("latency_ms").notNull(),
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
    dataHandling: jsonb("data_handling").$type<Record<string, unknown>>().notNull(),
    accountPrivacy: jsonb("account_privacy").$type<Record<string, unknown> | null>(),
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

export const artifacts = pgTable(
  "itotori_artifacts",
  {
    artifactId: text("artifact_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id").references(() => localeBranches.localeBranchId, {
      onDelete: "set null",
    }),
    sourceBundleId: text("source_bundle_id").references(() => sourceBundles.sourceBundleId, {
      onDelete: "set null",
    }),
    bridgeUnitId: text("bridge_unit_id").references(() => sourceUnits.bridgeUnitId, {
      onDelete: "set null",
    }),
    findingId: text("finding_id").references(() => findings.findingId, { onDelete: "set null" }),
    artifactKind: text("artifact_kind").notNull(),
    uri: text("uri"),
    hash: text("hash"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_artifacts_project_branch_kind_idx").on(
      table.projectId,
      table.localeBranchId,
      table.artifactKind,
    ),
    index("itotori_artifacts_finding_idx").on(table.findingId),
    index("itotori_artifacts_bridge_unit_idx").on(table.bridgeUnitId),
    index("itotori_artifacts_source_bundle_idx").on(table.sourceBundleId),
  ],
);

export const feedbackSources = pgTable(
  "itotori_feedback_sources",
  {
    feedbackSourceId: text("feedback_source_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    sourceKind: text("source_kind").notNull(),
    label: text("label").notNull(),
    sourceChannel: text("source_channel"),
    privacyReviewState: text("privacy_review_state").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    createdByUserId: text("created_by_user_id").references(() => users.userId, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_feedback_sources_project_kind_idx").on(table.projectId, table.sourceKind),
  ],
);

export const feedbackReports = pgTable(
  "itotori_feedback_reports",
  {
    feedbackReportId: text("feedback_report_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id").references(() => localeBranches.localeBranchId, {
      onDelete: "set null",
    }),
    sourceBundleId: text("source_bundle_id").references(() => sourceBundles.sourceBundleId, {
      onDelete: "set null",
    }),
    bridgeUnitId: text("bridge_unit_id").references(() => sourceUnits.bridgeUnitId, {
      onDelete: "set null",
    }),
    targetLocale: text("target_locale").notNull(),
    feedbackSourceId: text("feedback_source_id")
      .notNull()
      .references(() => feedbackSources.feedbackSourceId, { onDelete: "restrict" }),
    feedbackType: text("feedback_type").notNull(),
    triageLabel: text("triage_label").notNull(),
    reportStatus: text("report_status").notNull(),
    contextStatus: text("context_status").notNull(),
    privacyClassification: text("privacy_classification").notNull(),
    redactionState: text("redaction_state").notNull(),
    reporterRole: text("reporter_role").notNull(),
    reporterNote: text("reporter_note").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    lineReference: jsonb("line_reference").$type<Record<string, unknown> | null>(),
    attachmentSummary: jsonb("attachment_summary").$type<Record<string, unknown>>().notNull(),
    reportCount: integer("report_count").notNull().default(1),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    firstReportedAt: timestamp("first_reported_at", { withTimezone: true }).notNull(),
    lastReportedAt: timestamp("last_reported_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_feedback_reports_dedupe_key_idx").on(table.dedupeKey),
    index("itotori_feedback_reports_project_branch_status_idx").on(
      table.projectId,
      table.localeBranchId,
      table.reportStatus,
    ),
    index("itotori_feedback_reports_project_label_idx").on(table.projectId, table.triageLabel),
    index("itotori_feedback_reports_bridge_unit_idx").on(table.bridgeUnitId),
  ],
);

export const feedbackReportEvidence = pgTable(
  "itotori_feedback_report_evidence",
  {
    feedbackEvidenceId: text("feedback_evidence_id").primaryKey(),
    feedbackReportId: text("feedback_report_id")
      .notNull()
      .references(() => feedbackReports.feedbackReportId, { onDelete: "cascade" }),
    feedbackSourceId: text("feedback_source_id")
      .notNull()
      .references(() => feedbackSources.feedbackSourceId, { onDelete: "restrict" }),
    reporter: jsonb("reporter").$type<Record<string, unknown>>().notNull(),
    reporterNote: text("reporter_note").notNull(),
    lineReference: jsonb("line_reference").$type<Record<string, unknown> | null>(),
    attachments: jsonb("attachments").$type<unknown[]>().notNull(),
    contextSignals: jsonb("context_signals").$type<Record<string, unknown>>().notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    reportedAt: timestamp("reported_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_feedback_evidence_report_idx").on(table.feedbackReportId),
    index("itotori_feedback_evidence_source_idx").on(table.feedbackSourceId),
  ],
);
