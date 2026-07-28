import {
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
import { type WikiBrandContextRole } from "./schema-values-core.js";
import { users } from "./schema-catalog-values.js";
import { events } from "./schema-events.js";

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

export const bridgeImports = pgTable(
  "itotori_bridge_imports",
  {
    bridgeImportId: text("bridge_import_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    sourceBundleId: text("source_bundle_id")
      .notNull()
      .references(() => sourceBundles.sourceBundleId, { onDelete: "cascade" }),
    sourceBundleRevisionId: text("source_bundle_revision_id")
      .notNull()
      .references(() => sourceRevisions.sourceRevisionId, { onDelete: "restrict" }),
    bridgeId: text("bridge_id").notNull(),
    schemaVersion: text("schema_version").notNull(),
    sourceBundleHash: text("source_bundle_hash").notNull(),
    sourceLocale: text("source_locale").notNull(),
    unitCount: integer("unit_count").notNull(),
    assetCount: integer("asset_count").notNull(),
    sourceRevisionCount: integer("source_revision_count").notNull(),
    validationFailureCount: integer("validation_failure_count").notNull().default(0),
    addedUnitCount: integer("added_unit_count").notNull(),
    updatedUnitCount: integer("updated_unit_count").notNull(),
    removedUnitCount: integer("removed_unit_count").notNull(),
    unchangedUnitCount: integer("unchanged_unit_count").notNull(),
    addedAssetCount: integer("added_asset_count").notNull(),
    updatedAssetCount: integer("updated_asset_count").notNull(),
    removedAssetCount: integer("removed_asset_count").notNull(),
    unchangedAssetCount: integer("unchanged_asset_count").notNull(),
    addedSourceRevisionCount: integer("added_source_revision_count").notNull(),
    existingSourceRevisionCount: integer("existing_source_revision_count").notNull(),
    catalogWorkId: text("catalog_work_id"),
    localCorpusEntryId: text("local_corpus_entry_id"),
    readinessProfileId: text("readiness_profile_id"),
    completenessStatusId: text("completeness_status_id"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_bridge_imports_bundle_revision_idx").on(
      table.sourceBundleId,
      table.sourceBundleRevisionId,
    ),
    index("itotori_bridge_imports_project_imported_idx").on(table.projectId, table.importedAt),
    index("itotori_bridge_imports_future_refs_idx").on(
      table.catalogWorkId,
      table.localCorpusEntryId,
      table.readinessProfileId,
      table.completenessStatusId,
    ),
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
    // Tombstone timestamp. NULL = active/current member of the latest
    // reimported bundle; non-NULL = the asset was omitted by a later bridge
    // reimport and archived (its rows + dependents are retained, not
    // hard-deleted). Reviving on re-add clears this back to NULL.
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (table) => [
    index("itotori_assets_project_kind_idx").on(table.projectId, table.assetKind),
    index("itotori_assets_bundle_key_idx").on(table.sourceBundleId, table.assetKey),
    index("itotori_assets_revision_idx").on(table.sourceRevisionId),
    index("itotori_assets_active_idx")
      .on(table.sourceBundleId)
      .where(sql`${table.removedAt} is null`),
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
    // Tombstone timestamp. NULL = active/current member of the latest
    // reimported bundle; non-NULL = the unit was omitted by a later bridge
    // reimport and archived. Tombstoning replaces the former hard-DELETE so
    // dependent locale-branch unit rows, runtime evidence refs, TM reuse
    // events and historical facts are PRESERVED (they keep pointing at the
    // retained, now-tombstoned unit). Reviving on re-add clears this back to
    // NULL rather than duplicating the row.
    removedAt: timestamp("removed_at", { withTimezone: true }),
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
    index("itotori_source_units_active_idx")
      .on(table.sourceBundleId)
      .where(sql`${table.removedAt} is null`),
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
    uniqueIndex("itotori_locale_branches_project_branch_unique_idx").on(
      table.projectId,
      table.localeBranchId,
    ),
    index("itotori_locale_branches_project_locale_idx").on(table.projectId, table.targetLocale),
    index("itotori_locale_branches_bundle_idx").on(table.sourceBundleId),
  ],
);

export const wikiBrandContexts = pgTable(
  "itotori_wiki_brand_contexts",
  {
    brandContextId: text("brand_context_id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.workspaceId, { onDelete: "cascade" }),
    contextKey: text("context_key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_wiki_brand_contexts_workspace_key_idx").on(
      table.workspaceId,
      table.contextKey,
    ),
    index("itotori_wiki_brand_contexts_workspace_name_idx").on(table.workspaceId, table.name),
  ],
);

export const wikiBrandContextMemberships = pgTable(
  "itotori_wiki_brand_context_memberships",
  {
    brandContextMembershipId: text("brand_context_membership_id").primaryKey(),
    brandContextId: text("brand_context_id")
      .notNull()
      .references(() => wikiBrandContexts.brandContextId, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    contextRole: text("context_role").$type<WikiBrandContextRole>().notNull(),
    inheritanceOrder: integer("inheritance_order").notNull().default(0),
    providesCharacterArcs: boolean("provides_character_arcs").notNull().default(true),
    providesGlossary: boolean("provides_glossary").notNull().default(true),
    providesContext: boolean("provides_context").notNull().default(true),
    inheritsCharacterArcs: boolean("inherits_character_arcs").notNull().default(true),
    inheritsGlossary: boolean("inherits_glossary").notNull().default(true),
    inheritsContext: boolean("inherits_context").notNull().default(true),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_wiki_brand_context_memberships_scope_idx").on(
      table.brandContextId,
      table.projectId,
      table.localeBranchId,
    ),
    index("itotori_wiki_brand_context_memberships_branch_idx").on(
      table.projectId,
      table.localeBranchId,
    ),
    index("itotori_wiki_brand_context_memberships_context_order_idx").on(
      table.brandContextId,
      table.inheritanceOrder,
      table.contextRole,
    ),
    foreignKey({
      columns: [table.projectId, table.localeBranchId],
      foreignColumns: [localeBranches.projectId, localeBranches.localeBranchId],
      name: "itotori_wiki_brand_context_memberships_branch_fk",
    }).onDelete("cascade"),
  ],
);
