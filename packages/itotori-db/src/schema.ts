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
