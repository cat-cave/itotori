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

import { users } from "./schema-03.js";
import { projects, sourceRevisions } from "./schema-07.js";
import { localeBranches, sourceUnits } from "./schema-08.js";
import { styleGuideVersions } from "./schema-09.js";
import { events } from "./schema-11.js";

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
