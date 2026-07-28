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
import { users, catalogSourceProvenance } from "./schema-catalog-values.js";
import { projects, sourceRevisions, sourceUnits, localeBranches } from "./schema-project-core.js";
import { findings } from "./schema-model-runs.js";

export const terminologyTerms = pgTable(
  "itotori_terminology_terms",
  {
    termId: text("term_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    sourceTerm: text("source_term").notNull(),
    normalizedSourceTerm: text("normalized_source_term").notNull(),
    sourceLocale: text("source_locale").notNull(),
    targetLocale: text("target_locale").notNull(),
    preferredTranslation: text("preferred_translation").notNull(),
    normalizedPreferredTranslation: text("normalized_preferred_translation").notNull(),
    termKind: text("term_kind").notNull(),
    partOfSpeech: text("part_of_speech"),
    status: text("status").notNull(),
    caseSensitive: boolean("case_sensitive").notNull().default(false),
    notes: text("notes"),
    metadata: jsonb("metadata")
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
    uniqueIndex("itotori_terminology_terms_branch_preferred_idx").on(
      table.localeBranchId,
      table.normalizedSourceTerm,
      table.normalizedPreferredTranslation,
    ),
    index("itotori_terminology_terms_project_idx").on(
      table.projectId,
      table.localeBranchId,
      table.status,
    ),
    index("itotori_terminology_terms_exact_idx").on(
      table.localeBranchId,
      table.normalizedSourceTerm,
    ),
    index("itotori_terminology_terms_translation_idx").on(
      table.localeBranchId,
      table.normalizedPreferredTranslation,
    ),
  ],
);

export const terminologyAliases = pgTable(
  "itotori_terminology_aliases",
  {
    aliasId: text("alias_id").primaryKey(),
    termId: text("term_id")
      .notNull()
      .references(() => terminologyTerms.termId, { onDelete: "cascade" }),
    aliasText: text("alias_text").notNull(),
    normalizedAliasText: text("normalized_alias_text").notNull(),
    aliasKind: text("alias_kind").notNull(),
    locale: text("locale"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_terminology_aliases_term_kind_idx").on(
      table.termId,
      table.aliasKind,
      table.normalizedAliasText,
    ),
    index("itotori_terminology_aliases_lookup_idx").on(table.aliasKind, table.normalizedAliasText),
  ],
);

export const terminologySourceReferences = pgTable(
  "itotori_terminology_source_refs",
  {
    sourceRefId: text("source_ref_id").primaryKey(),
    termId: text("term_id")
      .notNull()
      .references(() => terminologyTerms.termId, { onDelete: "cascade" }),
    sourceRevisionId: text("source_revision_id").references(
      () => sourceRevisions.sourceRevisionId,
      {
        onDelete: "set null",
      },
    ),
    bridgeUnitId: text("bridge_unit_id").references(() => sourceUnits.bridgeUnitId, {
      onDelete: "set null",
    }),
    sourceProvenanceId: text("source_provenance_id").references(
      () => catalogSourceProvenance.sourceProvenanceId,
      { onDelete: "set null" },
    ),
    referenceKind: text("reference_kind").notNull(),
    citation: text("citation").notNull(),
    context: text("context"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_terminology_source_refs_term_idx").on(table.termId, table.referenceKind),
    index("itotori_terminology_source_refs_revision_idx").on(table.sourceRevisionId),
    index("itotori_terminology_source_refs_bridge_unit_idx").on(table.bridgeUnitId),
    index("itotori_terminology_source_refs_provenance_idx").on(table.sourceProvenanceId),
  ],
);

export const terminologySemanticIndex = pgTable(
  "itotori_terminology_semantic_index",
  {
    semanticIndexId: text("semantic_index_id").primaryKey(),
    termId: text("term_id")
      .notNull()
      .references(() => terminologyTerms.termId, { onDelete: "cascade" }),
    searchDocument: text("search_document").notNull(),
    searchTokens: jsonb("search_tokens").$type<string[]>().notNull(),
    embeddingProvider: text("embedding_provider").notNull(),
    embeddingModel: text("embedding_model").notNull(),
    embeddingDimension: integer("embedding_dimension").notNull(),
    embeddingVector: jsonb("embedding_vector").$type<number[] | null>(),
    contentHash: text("content_hash").notNull(),
    status: text("status").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    refreshedAt: timestamp("refreshed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_terminology_semantic_index_term_idx").on(table.termId),
    index("itotori_terminology_semantic_index_status_idx").on(table.status, table.updatedAt),
    index("itotori_terminology_semantic_index_hash_idx").on(table.contentHash),
  ],
);

export const terminologyConflicts = pgTable(
  "itotori_terminology_conflicts",
  {
    conflictId: text("conflict_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    normalizedSourceTerm: text("normalized_source_term").notNull(),
    conflictKind: text("conflict_kind").notNull(),
    status: text("status").notNull(),
    summary: text("summary").notNull(),
    findingId: text("finding_id").references(() => findings.findingId, { onDelete: "set null" }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_terminology_conflicts_branch_status_idx").on(
      table.localeBranchId,
      table.status,
      table.conflictKind,
    ),
    index("itotori_terminology_conflicts_finding_idx").on(table.findingId),
  ],
);

export const terminologyConflictEvidence = pgTable(
  "itotori_terminology_conflict_evidence",
  {
    conflictEvidenceId: text("conflict_evidence_id").primaryKey(),
    conflictId: text("conflict_id")
      .notNull()
      .references(() => terminologyConflicts.conflictId, { onDelete: "cascade" }),
    termId: text("term_id").references(() => terminologyTerms.termId, { onDelete: "set null" }),
    sourceRefId: text("source_ref_id").references(() => terminologySourceReferences.sourceRefId, {
      onDelete: "set null",
    }),
    evidencePosition: integer("evidence_position").notNull().default(0),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_terminology_conflict_evidence_conflict_idx").on(
      table.conflictId,
      table.evidencePosition,
    ),
    index("itotori_terminology_conflict_evidence_term_idx").on(table.termId),
  ],
);
