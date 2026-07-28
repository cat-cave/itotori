import {
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
import { users } from "./schema-catalog-values.js";
import { projects, localeBranches } from "./schema-project-core.js";
import { findings } from "./schema-model-runs.js";
import {
  type CapabilityLevel,
  type CapabilityLevelStatusKind,
  type EngineCapabilityEvidenceSource,
  type EngineCapabilityEvidenceKind,
  type EngineCapabilityEvidenceStatus,
} from "./schema-batches-conformance.js";

export const engineCapabilityReports = pgTable(
  "itotori_engine_capability_reports",
  {
    engineCapabilityReportId: text("engine_capability_report_id").primaryKey(),
    adapterId: text("adapter_id").notNull(),
    level: text("level").$type<CapabilityLevel>().notNull(),
    statusKind: text("status_kind").$type<CapabilityLevelStatusKind>().notNull(),
    limitations: jsonb("limitations")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    reason: text("reason"),
    reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_engine_capability_reports_adapter_idx").on(table.adapterId),
    index("itotori_engine_capability_reports_level_idx").on(table.level, table.statusKind),
  ],
);

export const engineCapabilityEvidence = pgTable(
  "itotori_engine_capability_evidence",
  {
    engineCapabilityEvidenceId: text("engine_capability_evidence_id").primaryKey(),
    adapterId: text("adapter_id").notNull(),
    level: text("level").$type<CapabilityLevel>().notNull(),
    evidenceSource: text("evidence_source").$type<EngineCapabilityEvidenceSource>().notNull(),
    evidenceKind: text("evidence_kind").$type<EngineCapabilityEvidenceKind>().notNull(),
    schemaVersion: text("schema_version").notNull(),
    status: text("status").$type<EngineCapabilityEvidenceStatus>().notNull(),
    aggregateCounts: jsonb("aggregate_counts")
      .$type<Record<string, number>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    evidenceLabels: jsonb("evidence_labels")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    limitations: jsonb("limitations")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    publicFixtureId: text("public_fixture_id"),
    reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_engine_capability_evidence_adapter_idx").on(table.adapterId),
    index("itotori_engine_capability_evidence_level_idx").on(table.adapterId, table.level),
    index("itotori_engine_capability_evidence_source_idx").on(
      table.evidenceSource,
      table.evidenceKind,
    ),
  ],
);

// ---------------------------------------------------------------------
// Draft job schema (jobs + attempts)
// ---------------------------------------------------------------------

export const draftJobStatusValues = {
  queued: "queued",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  retryable: "retryable",
  cancelled: "cancelled",
} as const;

export type DraftJobStatus = (typeof draftJobStatusValues)[keyof typeof draftJobStatusValues];

export const draftJobAttemptStatusValues = {
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  retryable: "retryable",
  cancelled: "cancelled",
} as const;

export type DraftJobAttemptStatus =
  (typeof draftJobAttemptStatusValues)[keyof typeof draftJobAttemptStatusValues];

/**
 * Reference to a protected-span carried by a source unit that the draft job
 * must preserve in any candidate translation output.
 */
export type DraftJobProtectedSpanRef = {
  bridgeUnitId: string;
  spanIndex: number;
  spanKind: string;
};

/**
 * Reference to a context artifact (scene summary, glossary excerpt, prior
 * draft, etc.) made available to the drafting agent.
 */
export type DraftJobContextRef = {
  contextArtifactId: string;
  category: string;
  contentHash: string;
};

/**
 * Versions of agent-side policies (prompt templates, model providers, etc.)
 * that the recorded draft was generated under. Recorded so a draft can be
 * reproduced bit-for-bit by replaying the same versioned policies.
 */
export type DraftJobPolicyVersions = {
  promptTemplateVersion: string;
  modelProviderFamily: string;
  modelId: string;
} & Record<string, string>;

export const draftJobs = pgTable(
  "itotori_draft_jobs",
  {
    draftJobId: text("draft_job_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    bridgeUnitIds: text("bridge_unit_ids").array().notNull(),
    styleGuideVersion: text("style_guide_version").notNull(),
    glossaryVersion: text("glossary_version").notNull(),
    protectedSpanRefs: jsonb("protected_span_refs")
      .$type<DraftJobProtectedSpanRef[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    policyVersions: jsonb("policy_versions")
      .$type<DraftJobPolicyVersions>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    contextRefs: jsonb("context_refs")
      .$type<DraftJobContextRef[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: text("status").$type<DraftJobStatus>().notNull(),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_draft_jobs_project_status_idx").on(table.projectId, table.status),
    index("itotori_draft_jobs_locale_branch_status_idx").on(table.localeBranchId, table.status),
    index("itotori_draft_jobs_created_at_idx").on(table.projectId, table.createdAt),
  ],
);

export const draftJobAttempts = pgTable(
  "itotori_draft_job_attempts",
  {
    draftJobAttemptId: text("draft_job_attempt_id").primaryKey(),
    draftJobId: text("draft_job_id")
      .notNull()
      .references(() => draftJobs.draftJobId, { onDelete: "cascade" }),
    attemptIndex: integer("attempt_index").notNull(),
    providerRunId: text("provider_run_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    status: text("status").$type<DraftJobAttemptStatus>().notNull(),
    failureReason: text("failure_reason"),
    recordedProviderArtifactId: text("recorded_provider_artifact_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_draft_job_attempts_attempt_idx").on(table.draftJobId, table.attemptIndex),
    index("itotori_draft_job_attempts_status_idx").on(table.draftJobId, table.status),
  ],
);

// ---------------------------------------------------------------------
// Asset localization decision workflow
// ---------------------------------------------------------------------

export const assetLocalizationDecisionAssetKindValues = {
  imageWithText: "image_with_text",
  songTitle: "song_title",
  uiArt: "ui_art",
  font: "font",
  video: "video",
  romanization: "romanization",
  fullLocalization: "full_localization",
  doNotTranslate: "do_not_translate",
} as const;

export type AssetLocalizationDecisionAssetKind =
  (typeof assetLocalizationDecisionAssetKindValues)[keyof typeof assetLocalizationDecisionAssetKindValues];

export const assetLocalizationDecisionPolicyValues = {
  keepOriginal: "keep_original",
  translateText: "translate_text",
  swapWithReplacement: "swap_with_replacement",
  romanize: "romanize",
  fullLocalize: "full_localize",
  skip: "skip",
} as const;

export type AssetLocalizationDecisionPolicy =
  (typeof assetLocalizationDecisionPolicyValues)[keyof typeof assetLocalizationDecisionPolicyValues];

/**
 * The asset identifier carried by an asset-localization decision. The
 * `kind` tag discriminates the reference source (bridge bundle asset
 * ref, engine-specific sprite id, etc.) and `ref` is the canonical
 * string identifier used for the active-decision uniqueness index.
 */
export type AssetLocalizationDecisionAssetRef = {
  kind: string;
  ref: string;
  // Additional discriminator-specific fields are tolerated.
  [extraField: string]: unknown;
};

export const assetLocalizationDecisions = pgTable(
  "itotori_asset_localization_decisions",
  {
    decisionId: text("decision_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    assetRef: jsonb("asset_ref").$type<AssetLocalizationDecisionAssetRef>().notNull(),
    assetKind: text("asset_kind").$type<AssetLocalizationDecisionAssetKind>().notNull(),
    decisionPolicy: text("decision_policy").$type<AssetLocalizationDecisionPolicy>().notNull(),
    decisionRationale: text("decision_rationale"),
    decidedByUserId: text("decided_by_user_id").references(() => users.userId, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededByDecisionId: text("superseded_by_decision_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.supersededByDecisionId],
      foreignColumns: [table.decisionId],
      name: "itotori_asset_localization_decisions_superseded_by_fkey",
    }),
    index("itotori_asset_localization_decisions_project_branch_kind_idx").on(
      table.projectId,
      table.localeBranchId,
      table.assetKind,
    ),
    index("itotori_asset_localization_decisions_decided_by_idx").on(
      table.decidedByUserId,
      table.decidedAt,
    ),
  ],
);

// ---------------------------------------------------------------------
// alpha gate 5 — audit findings persistence
// ---------------------------------------------------------------------

export const auditFindingSeverityValues = {
  p0: "P0",
  p1: "P1",
  p2: "P2",
  p3: "P3",
} as const;

export type AuditFindingSeverity =
  (typeof auditFindingSeverityValues)[keyof typeof auditFindingSeverityValues];

export const auditFindingStatusValues = {
  open: "open",
  superseded: "superseded",
  fixed: "fixed",
  wontfix: "wontfix",
  duplicate: "duplicate",
} as const;

export type AuditFindingStatus =
  (typeof auditFindingStatusValues)[keyof typeof auditFindingStatusValues];

/**
 * Shape of an audit-finding row as it appears in the DB. The dashboard
 * read model and the bootstrap script both consume this shape directly;
 * the repository class wraps it with auth + invariants.
 */
export type AuditFindingRecord = {
  auditFindingId: string;
  auditReportId: string;
  nodeId: string;
  severity: AuditFindingSeverity;
  category: string;
  summary: string;
  detail: string | null;
  fileRef: string | null;
  proposedDagNode: string | null;
  status: AuditFindingStatus;
  supersededByFindingId: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
};
