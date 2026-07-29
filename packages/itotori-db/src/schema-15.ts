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

import { projects, sourceRevisions } from "./schema-07.js";
import { localeBranches, sourceBundles, sourceUnits } from "./schema-08.js";
import { findings, terminologySourceReferences, terminologyTerms } from "./schema-14.js";

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

export const runtimeEvidenceRuns = pgTable(
  "itotori_runtime_evidence_runs",
  {
    runtimeRunId: text("runtime_run_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    sourceBundleId: text("source_bundle_id")
      .notNull()
      .references(() => sourceBundles.sourceBundleId, { onDelete: "restrict" }),
    sourceBundleRevisionId: text("source_bundle_revision_id")
      .notNull()
      .references(() => sourceRevisions.sourceRevisionId, { onDelete: "restrict" }),
    runtimeReportArtifactId: text("runtime_report_artifact_id")
      .notNull()
      .references(() => artifacts.artifactId, { onDelete: "cascade" }),
    patchResultArtifactId: text("patch_result_artifact_id").references(() => artifacts.artifactId, {
      onDelete: "set null",
    }),
    adapterName: text("adapter_name").notNull(),
    adapterVersion: text("adapter_version"),
    status: text("status").notNull(),
    fidelityTier: text("fidelity_tier").notNull(),
    evidenceTier: text("evidence_tier"),
    textEventCount: integer("text_event_count").notNull().default(0),
    branchEventCount: integer("branch_event_count").notNull().default(0),
    captureCount: integer("capture_count").notNull().default(0),
    recordingCount: integer("recording_count").notNull().default(0),
    validationFindingCount: integer("validation_finding_count").notNull().default(0),
    referenceComparisonCount: integer("reference_comparison_count").notNull().default(0),
    reportCreatedAt: timestamp("report_created_at", { withTimezone: true }).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_runtime_runs_project_created_idx").on(table.projectId, table.reportCreatedAt),
    index("itotori_runtime_runs_branch_created_idx").on(
      table.localeBranchId,
      table.reportCreatedAt,
    ),
    index("itotori_runtime_runs_bundle_revision_idx").on(
      table.sourceBundleId,
      table.sourceBundleRevisionId,
    ),
    index("itotori_runtime_runs_status_idx").on(table.status),
  ],
);

export const runtimeEvidenceItems = pgTable(
  "itotori_runtime_evidence_items",
  {
    runtimeEvidenceId: text("runtime_evidence_id").primaryKey(),
    runtimeRunId: text("runtime_run_id")
      .notNull()
      .references(() => runtimeEvidenceRuns.runtimeRunId, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    sourceBundleId: text("source_bundle_id")
      .notNull()
      .references(() => sourceBundles.sourceBundleId, { onDelete: "restrict" }),
    sourceBundleRevisionId: text("source_bundle_revision_id")
      .notNull()
      .references(() => sourceRevisions.sourceRevisionId, { onDelete: "restrict" }),
    bridgeUnitId: text("bridge_unit_id").references(() => sourceUnits.bridgeUnitId, {
      onDelete: "set null",
    }),
    artifactId: text("artifact_id").references(() => artifacts.artifactId, {
      onDelete: "set null",
    }),
    evidenceKind: text("evidence_kind").notNull(),
    evidenceTier: text("evidence_tier"),
    artifactKind: text("artifact_kind"),
    portableArtifactUri: text("portable_artifact_uri"),
    frame: integer("frame"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_runtime_evidence_run_kind_idx").on(table.runtimeRunId, table.evidenceKind),
    index("itotori_runtime_evidence_bridge_unit_idx").on(table.bridgeUnitId),
    index("itotori_runtime_evidence_artifact_idx").on(table.artifactId),
  ],
);
