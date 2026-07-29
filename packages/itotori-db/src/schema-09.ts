import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
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

import { type WikiBrandContextRole } from "./schema-01.js";
import { users } from "./schema-03.js";
import { projects, sourceRevisions, workspaces } from "./schema-07.js";
import { localeBranches } from "./schema-08.js";

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

export const styleGuides = pgTable(
  "itotori_style_guides",
  {
    styleGuideId: text("style_guide_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    latestVersionId: text("latest_version_id"),
    approvedVersionId: text("approved_version_id"),
    createdByUserId: text("created_by_user_id").references(() => users.userId, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_style_guides_locale_branch_idx").on(table.localeBranchId),
    index("itotori_style_guides_project_idx").on(table.projectId),
    // Target key for the version -> guide scope composite FK.
    unique("itotori_style_guides_scope_key").on(
      table.styleGuideId,
      table.projectId,
      table.localeBranchId,
    ),
    // latest_version_id and approved_version_id are guarded by composite FKs
    // onto itotori_style_guide_versions
    // (<pointer>, style_guide_id, project_id, locale_branch_id), so each pointer
    // must resolve to an EXISTING version in the SAME guide + project +
    // locale-branch (rejects dangling AND cross-project / cross-locale-branch).
    // Those FKs live in migration 0053 only: declaring them here would pair with
    // the version table's own style_guide_id FK back to this table to form a
    // mutually-recursive table type TypeScript cannot infer. The DB constraint
    // is the source of truth and is asserted by the migration-drift test.
  ],
);

export const styleGuideVersions = pgTable(
  "itotori_style_guide_versions",
  {
    styleGuideVersionId: text("style_guide_version_id").primaryKey(),
    styleGuideId: text("style_guide_id")
      .notNull()
      .references(() => styleGuides.styleGuideId, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    previousVersionId: text("previous_version_id"),
    sourceRevisionId: text("source_revision_id")
      .notNull()
      .references(() => sourceRevisions.sourceRevisionId, { onDelete: "restrict" }),
    versionSequence: integer("version_sequence").notNull(),
    authorUserId: text("author_user_id")
      .notNull()
      .references(() => users.userId, { onDelete: "restrict" }),
    approverUserId: text("approver_user_id").references(() => users.userId, {
      onDelete: "set null",
    }),
    status: text("status").notNull(),
    contentHash: text("content_hash").notNull(),
    policy: jsonb("policy").$type<Record<string, unknown>>().notNull(),
    semanticDiagnostics: jsonb("semantic_diagnostics")
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_style_guide_versions_branch_sequence_idx").on(
      table.localeBranchId,
      table.versionSequence,
    ),
    index("itotori_style_guide_versions_guide_created_idx").on(table.styleGuideId, table.createdAt),
    index("itotori_style_guide_versions_source_revision_idx").on(table.sourceRevisionId),
    index("itotori_style_guide_versions_status_idx").on(table.status),
    // Target key for the pointer composite FKs (latest/approved on the guide
    // + previous on this table). Trivially unique via the PK.
    unique("itotori_style_guide_versions_scope_key").on(
      table.styleGuideVersionId,
      table.styleGuideId,
      table.projectId,
      table.localeBranchId,
    ),
    // A version's (project, locale-branch) MUST match its guide's.
    // This composite FK (style_guide_id, project_id, locale_branch_id) ->
    // itotori_style_guides is enforced in migration 0053; it is intentionally
    // NOT declared here because pairing it with the guide's latest/approved
    // composite FKs (which reference THIS table) forms a mutually-recursive
    // table type that TypeScript cannot infer. The DB constraint is the source
    // of truth; the acceptance-critical pointer FKs below stay in the model.
    // previous_version_id must reference an existing (prior) version in the
    // SAME guide + project + locale-branch (self-referential).
    foreignKey({
      columns: [table.previousVersionId, table.styleGuideId, table.projectId, table.localeBranchId],
      foreignColumns: [
        table.styleGuideVersionId,
        table.styleGuideId,
        table.projectId,
        table.localeBranchId,
      ],
      name: "itotori_style_guide_versions_previous_version_scope_fkey",
    }),
  ],
);
