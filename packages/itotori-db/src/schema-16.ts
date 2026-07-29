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

// Type-only import (erased at compile time — no runtime cycle with
// authorization.ts, which imports table VALUES from this module). Types the
// auth permission-set / grant / audit columns to the single Permission source
// of truth in authorization.ts.

import { users } from "./schema-03.js";
import { projects, sourceRevisions } from "./schema-07.js";
import { localeBranches, sourceBundles, sourceUnits } from "./schema-08.js";
import { findings } from "./schema-14.js";
import { artifacts, runtimeEvidenceItems, runtimeEvidenceRuns } from "./schema-15.js";

export const runtimeEvidenceBridgeUnitRefs = pgTable(
  "itotori_runtime_evidence_bridge_unit_refs",
  {
    runtimeEvidenceId: text("runtime_evidence_id")
      .notNull()
      .references(() => runtimeEvidenceItems.runtimeEvidenceId, { onDelete: "cascade" }),
    bridgeUnitId: text("bridge_unit_id")
      .notNull()
      .references(() => sourceUnits.bridgeUnitId, { onDelete: "cascade" }),
    refRole: text("ref_role").notNull(),
    sourceUnitKey: text("source_unit_key").notNull().default(""),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.runtimeEvidenceId, table.bridgeUnitId, table.refRole, table.sourceUnitKey],
    }),
    index("itotori_runtime_evidence_refs_bridge_unit_idx").on(table.bridgeUnitId),
  ],
);

export const runtimeValidationFindings = pgTable(
  "itotori_runtime_validation_findings",
  {
    findingId: text("finding_id")
      .primaryKey()
      .references(() => findings.findingId, { onDelete: "cascade" }),
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
    findingKind: text("finding_kind").notNull(),
    severity: text("severity").notNull(),
    message: text("message").notNull(),
    evidenceTier: text("evidence_tier").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_runtime_validation_run_idx").on(table.runtimeRunId),
    index("itotori_runtime_validation_bridge_unit_idx").on(table.bridgeUnitId),
    index("itotori_runtime_validation_artifact_idx").on(table.artifactId),
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
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "restrict" }),
    sourceBundleId: text("source_bundle_id").references(() => sourceBundles.sourceBundleId, {
      onDelete: "set null",
    }),
    bridgeUnitId: text("bridge_unit_id")
      .notNull()
      .references(() => sourceUnits.bridgeUnitId, { onDelete: "restrict" }),
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

export const translationBatchContextRefKindValues = {
  glossaryTerm: "glossary_term",
  styleRule: "style_rule",
  character: "character",
  sceneSummary: "scene_summary",
  priorExample: "prior_example",
  sourceUnitKeyPrefix: "source_unit_key_prefix",
} as const;

export type TranslationBatchContextRefKind =
  (typeof translationBatchContextRefKindValues)[keyof typeof translationBatchContextRefKindValues];

export const translationBatchContextRefInclusionReasonValues = {
  hit: "hit",
  alwaysOn: "always_on",
  categoryMatch: "category_match",
  explicitPin: "explicit_pin",
  sameSpeaker: "same_speaker",
  sameScene: "same_scene",
  sameSurfaceKind: "same_surfaceKind",
  fallbackGrouping: "fallback_grouping",
} as const;
