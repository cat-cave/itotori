import {
  check,
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
import { users } from "./schema-catalog-values.js";
import { projects, sourceRevisions, sourceUnits, localeBranches } from "./schema-project-core.js";
import { events } from "./schema-events.js";

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

export const branchPolicyGlossaryReferences = pgTable(
  "itotori_branch_policy_glossary_references",
  {
    referenceId: text("reference_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    versionSequence: integer("version_sequence").notNull(),
    styleGuideVersionId: text("style_guide_version_id").references(
      () => styleGuideVersions.styleGuideVersionId,
      { onDelete: "set null" },
    ),
    glossaryContentHash: text("glossary_content_hash").notNull(),
    glossaryTermRefs: jsonb("glossary_term_refs")
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    updateReason: text("update_reason").notNull(),
    eventId: text("event_id").references(() => events.eventId, { onDelete: "set null" }),
    supersedesReferenceId: text("supersedes_reference_id"),
    actorUserId: text("actor_user_id").references(() => users.userId, {
      onDelete: "set null",
    }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_branch_policy_glossary_refs_branch_sequence_idx").on(
      table.localeBranchId,
      table.versionSequence,
    ),
    index("itotori_branch_policy_glossary_refs_project_branch_idx").on(
      table.projectId,
      table.localeBranchId,
      table.createdAt,
    ),
    index("itotori_branch_policy_glossary_refs_style_guide_idx").on(table.styleGuideVersionId),
    index("itotori_branch_policy_glossary_refs_hash_idx").on(
      table.localeBranchId,
      table.glossaryContentHash,
    ),
    index("itotori_branch_policy_glossary_refs_event_idx").on(table.eventId),
    // Bring the Drizzle metadata into parity with migration 0022. These check
    // constraints are the source-of-truth runtime guards documented in the SQL;
    // modeling them here keeps schema-drift introspection honest. A regression
    // test (branch-policy-glossary-references-migration-drift) pins the
    // round-trip between this declaration and pg_constraint.
    check("itotori_branch_policy_glossary_refs_sequence_check", sql`${table.versionSequence} > 0`),
    check(
      "itotori_branch_policy_glossary_refs_term_refs_check",
      sql`jsonb_typeof(${table.glossaryTermRefs}) = 'array'`,
    ),
    check(
      "itotori_branch_policy_glossary_refs_metadata_check",
      sql`jsonb_typeof(${table.metadata}) = 'object'`,
    ),
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
    styleGuideVersionId: text("style_guide_version_id").references(
      () => styleGuideVersions.styleGuideVersionId,
      { onDelete: "set null" },
    ),
    glossaryReferenceId: text("glossary_reference_id").references(
      () => branchPolicyGlossaryReferences.referenceId,
      { onDelete: "set null" },
    ),
  },
  (table) => [
    primaryKey({ columns: [table.localeBranchId, table.bridgeUnitId] }),
    index("itotori_locale_branch_units_bridge_unit_idx").on(table.bridgeUnitId),
    index("itotori_locale_branch_units_style_guide_version_idx").on(table.styleGuideVersionId),
    index("itotori_locale_branch_units_glossary_reference_idx").on(table.glossaryReferenceId),
  ],
);

export const translationMemorySegments = pgTable(
  "itotori_translation_memory_segments",
  {
    memorySegmentId: text("memory_segment_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    sourceRevisionId: text("source_revision_id")
      .notNull()
      .references(() => sourceRevisions.sourceRevisionId, { onDelete: "restrict" }),
    sourceBridgeUnitId: text("source_bridge_unit_id").references(() => sourceUnits.bridgeUnitId, {
      onDelete: "set null",
    }),
    sourceUnitKey: text("source_unit_key").notNull(),
    sourceOccurrenceId: text("source_occurrence_id").notNull(),
    sourceHash: text("source_hash").notNull(),
    sourceFingerprint: text("source_fingerprint").notNull(),
    sourceText: text("source_text").notNull(),
    targetLocale: text("target_locale").notNull(),
    targetText: text("target_text").notNull(),
    status: text("status").notNull(),
    provenance: jsonb("provenance")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdByUserId: text("created_by_user_id").references(() => users.userId, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Keep Drizzle parity with migration 0063. The status enum
    // (reusable|blocked) and the jsonb object shape of provenance are
    // enforced at the DB; modeling the CHECK guards here keeps schema-drift
    // introspection honest.
    check("itotori_tm_segments_status_check", sql`${table.status} in ('reusable', 'blocked')`),
    check(
      "itotori_tm_segments_provenance_check",
      sql`jsonb_typeof(${table.provenance}) = 'object'`,
    ),
    index("itotori_tm_segments_exact_lookup_idx").on(
      table.localeBranchId,
      table.sourceRevisionId,
      table.sourceHash,
      table.status,
      table.sourceUnitKey,
      table.sourceOccurrenceId,
    ),
    index("itotori_tm_segments_fingerprint_idx").on(
      table.localeBranchId,
      table.sourceRevisionId,
      table.sourceFingerprint,
      table.status,
    ),
    index("itotori_tm_segments_project_branch_idx").on(
      table.projectId,
      table.localeBranchId,
      table.createdAt,
    ),
  ],
);

export const exactSearchDocuments = pgTable(
  "itotori_exact_search_documents",
  {
    searchDocumentId: text("search_document_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    sourceRevisionId: text("source_revision_id")
      .notNull()
      .references(() => sourceRevisions.sourceRevisionId, { onDelete: "restrict" }),
    sourceArtifactType: text("source_artifact_type").notNull(),
    sourceArtifactId: text("source_artifact_id")
      .notNull()
      .references(() => sourceUnits.bridgeUnitId, { onDelete: "cascade" }),
    exactTerm: text("exact_term").notNull(),
    normalizedExactTerm: text("normalized_exact_term").notNull(),
    sourceLocale: text("source_locale").notNull(),
    targetLocale: text("target_locale").notNull(),
    provenance: jsonb("provenance")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    refreshedAt: timestamp("refreshed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_exact_search_docs_source_term_idx").on(
      table.localeBranchId,
      table.sourceRevisionId,
      table.sourceArtifactType,
      table.sourceArtifactId,
      table.normalizedExactTerm,
    ),
    index("itotori_exact_search_docs_lookup_idx").on(
      table.localeBranchId,
      table.sourceRevisionId,
      table.normalizedExactTerm,
      table.sourceArtifactType,
    ),
    index("itotori_exact_search_docs_project_branch_idx").on(
      table.projectId,
      table.localeBranchId,
      table.sourceRevisionId,
    ),
  ],
);

export const translationMemoryReuseEvents = pgTable(
  "itotori_translation_memory_reuse_events",
  {
    reuseEventId: text("reuse_event_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    targetBridgeUnitId: text("target_bridge_unit_id")
      .notNull()
      .references(() => sourceUnits.bridgeUnitId, { onDelete: "cascade" }),
    sourceRevisionId: text("source_revision_id")
      .notNull()
      .references(() => sourceRevisions.sourceRevisionId, { onDelete: "restrict" }),
    memorySegmentId: text("memory_segment_id")
      .notNull()
      .references(() => translationMemorySegments.memorySegmentId, { onDelete: "restrict" }),
    matchKind: text("match_kind").notNull(),
    matchScore: integer("match_score").notNull(),
    reuseStatus: text("reuse_status").notNull(),
    sourceHash: text("source_hash").notNull(),
    candidateSourceHash: text("candidate_source_hash").notNull(),
    targetText: text("target_text").notNull(),
    provenance: jsonb("provenance")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    costImpact: jsonb("cost_impact")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdByUserId: text("created_by_user_id").references(() => users.userId, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Mirror migration 0063's CHECK constraints on the reuse events table so
    // schema-drift introspection reflects runtime DB enforcement: enum-like
    // match_kind / reuse_status allowed values, normalized 0..1000
    // match_score range, and the jsonb object shape of provenance +
    // cost_impact.
    check(
      "itotori_tm_reuse_events_match_kind_check",
      sql`${table.matchKind} in ('exact', 'fuzzy')`,
    ),
    check(
      "itotori_tm_reuse_events_match_score_check",
      sql`${table.matchScore} >= 0 and ${table.matchScore} <= 1000`,
    ),
    check(
      "itotori_tm_reuse_events_reuse_status_check",
      sql`${table.reuseStatus} in ('suggested', 'applied')`,
    ),
    check(
      "itotori_tm_reuse_events_provenance_check",
      sql`jsonb_typeof(${table.provenance}) = 'object'`,
    ),
    check(
      "itotori_tm_reuse_events_cost_impact_check",
      sql`jsonb_typeof(${table.costImpact}) = 'object'`,
    ),
    index("itotori_tm_reuse_events_target_idx").on(
      table.localeBranchId,
      table.targetBridgeUnitId,
      table.createdAt,
    ),
    index("itotori_tm_reuse_events_segment_idx").on(table.memorySegmentId, table.createdAt),
  ],
);
