import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projects, sourceRevisions, localeBranches } from "./schema-project-core.js";
import { artifacts } from "./schema-runtime-feedback.js";

export const translationBatches = pgTable(
  "itotori_translation_batches",
  {
    batchId: text("batch_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    sourceRevisionId: text("source_revision_id")
      .notNull()
      .references(() => sourceRevisions.sourceRevisionId, { onDelete: "restrict" }),
    batchOrdinal: integer("batch_ordinal").notNull(),
    tokenEstimate: integer("token_estimate").notNull(),
    tokenBudgetCap: integer("token_budget_cap").notNull(),
    sceneId: text("scene_id"),
    sceneSplitIndex: integer("scene_split_index"),
    routeId: text("route_id"),
    modelProviderFamily: text("model_provider_family").notNull(),
    modelId: text("model_id").notNull(),
    /**
     * Required pinned providerId per the (modelId, providerId) pair rule.
     * The planner pins both halves of the pair on `batch.modelProfile`;
     * persisting only the model half dropped the provider provenance the
     * downstream draft agent reads back. NOT NULL with NO sentinel default
     * — a batch must carry its real provider, or the insert fails loud
     * (migration 0047 deletes pre-fix rows that never captured it rather
     * than backfilling a fake provider).
     */
    providerId: text("provider_id").notNull(),
    modelContextWindowTokens: integer("model_context_window_tokens").notNull(),
    modelMaxOutputTokens: integer("model_max_output_tokens"),
    modelTargetFillRatio: numeric("model_target_fill_ratio", { precision: 4, scale: 3 }).notNull(),
    modelPromptOverheadTokens: integer("model_prompt_overhead_tokens").notNull(),
    tokenEstimatorId: text("token_estimator_id").notNull(),
    nearCapWarning: boolean("near_cap_warning").notNull().default(false),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_translation_batches_triple_ordinal_idx").on(
      table.projectId,
      table.localeBranchId,
      table.sourceRevisionId,
      table.batchOrdinal,
    ),
    index("itotori_translation_batches_triple_idx").on(
      table.projectId,
      table.localeBranchId,
      table.sourceRevisionId,
    ),
    index("itotori_translation_batches_scene_idx").on(table.sceneId),
  ],
);

export const translationBatchUnits = pgTable(
  "itotori_translation_batch_units",
  {
    batchId: text("batch_id")
      .notNull()
      .references(() => translationBatches.batchId, { onDelete: "cascade" }),
    bridgeUnitId: text("bridge_unit_id").notNull(),
    sourceUnitKey: text("source_unit_key").notNull(),
    sourceHash: text("source_hash").notNull(),
    unitOrdinal: integer("unit_ordinal").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.batchId, table.bridgeUnitId] }),
    index("itotori_translation_batch_units_bridge_unit_idx").on(table.bridgeUnitId),
    index("itotori_translation_batch_units_batch_ordinal_idx").on(table.batchId, table.unitOrdinal),
  ],
);

export const translationBatchContextRefs = pgTable(
  "itotori_translation_batch_context_refs",
  {
    batchId: text("batch_id")
      .notNull()
      .references(() => translationBatches.batchId, { onDelete: "cascade" }),
    refKind: text("ref_kind").notNull(),
    refId: text("ref_id").notNull(),
    refSecondaryId: text("ref_secondary_id").notNull().default(""),
    inclusionReason: text("inclusion_reason").notNull(),
    hitBridgeUnitIds: jsonb("hit_bridge_unit_ids").$type<string[] | null>(),
    details: jsonb("details")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.batchId, table.refKind, table.refId, table.refSecondaryId],
    }),
    index("itotori_translation_batch_context_refs_ref_idx").on(table.refKind, table.refId),
  ],
);

export const conformanceOutcomeKindValues = {
  pass: "pass",
  fail: "fail",
  skip: "skip",
  unsupported: "unsupported",
} as const;
export type ConformanceOutcomeKind =
  (typeof conformanceOutcomeKindValues)[keyof typeof conformanceOutcomeKindValues];

export const conformanceProfileIdValues = {
  textTrace: "text-trace",
  branchCapture: "branch-capture",
  snapshotRestore: "snapshot-restore",
  frameCapture: "frame-capture",
  recordingCapture: "recording-capture",
  deterministicReplay: "deterministic-replay",
} as const;
export type ConformanceProfileIdValue =
  (typeof conformanceProfileIdValues)[keyof typeof conformanceProfileIdValues];

export const conformanceEvidenceRefKindValues = {
  runtimeArtifact: "runtimeArtifact",
  textLine: "textLine",
  frameArtifactRef: "frameArtifactRef",
  replayLogRef: "replayLogRef",
  implMapFixture: "implMapFixture",
  bridgeUnit: "bridgeUnit",
  statePath: "statePath",
} as const;
export type ConformanceEvidenceRefKindValue =
  (typeof conformanceEvidenceRefKindValues)[keyof typeof conformanceEvidenceRefKindValues];

export const conformanceFindingSeverityValues = {
  info: "info",
  warning: "warning",
  error: "error",
} as const;
export type ConformanceFindingSeverityValue =
  (typeof conformanceFindingSeverityValues)[keyof typeof conformanceFindingSeverityValues];

export const conformanceRuns = pgTable(
  "itotori_conformance_runs",
  {
    conformanceRunId: text("conformance_run_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id").references(() => localeBranches.localeBranchId, {
      onDelete: "cascade",
    }),
    manifestArtifactId: text("manifest_artifact_id").references(() => artifacts.artifactId, {
      onDelete: "set null",
    }),
    reportArtifactId: text("report_artifact_id")
      .notNull()
      .references(() => artifacts.artifactId, { onDelete: "cascade" }),
    adapterId: text("adapter_id").notNull(),
    abiVersion: integer("abi_version").notNull(),
    schemaVersion: text("schema_version").notNull(),
    manifestFidelityTier: text("manifest_fidelity_tier"),
    resultCount: integer("result_count").notNull().default(0),
    passCount: integer("pass_count").notNull().default(0),
    failCount: integer("fail_count").notNull().default(0),
    skipCount: integer("skip_count").notNull().default(0),
    unsupportedCount: integer("unsupported_count").notNull().default(0),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_conformance_runs_project_recorded_idx").on(table.projectId, table.recordedAt),
    index("itotori_conformance_runs_adapter_idx").on(table.adapterId),
  ],
);

export const conformanceResults = pgTable(
  "itotori_conformance_results",
  {
    conformanceResultId: text("conformance_result_id").primaryKey(),
    conformanceRunId: text("conformance_run_id")
      .notNull()
      .references(() => conformanceRuns.conformanceRunId, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    adapterId: text("adapter_id").notNull(),
    profileId: text("profile_id").notNull(),
    outcomeKind: text("outcome_kind").notNull(),
    passEvidenceTier: text("pass_evidence_tier"),
    semanticCode: text("semantic_code"),
    outcomeMessage: text("outcome_message"),
    declaredInManifest: boolean("declared_in_manifest"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_conformance_results_run_idx").on(table.conformanceRunId),
    index("itotori_conformance_results_profile_outcome_idx").on(table.profileId, table.outcomeKind),
  ],
);

export const conformanceEvidenceRefs = pgTable(
  "itotori_conformance_evidence_refs",
  {
    conformanceEvidenceRefId: text("conformance_evidence_ref_id").primaryKey(),
    conformanceResultId: text("conformance_result_id")
      .notNull()
      .references(() => conformanceResults.conformanceResultId, { onDelete: "cascade" }),
    evidenceKind: text("evidence_kind").notNull(),
    artifactKind: text("artifact_kind"),
    uri: text("uri"),
    artifactId: text("artifact_id"),
    lineId: text("line_id"),
    frameId: text("frame_id"),
    runId: text("run_id"),
    fixtureId: text("fixture_id"),
    bridgeUnitId: text("bridge_unit_id"),
    statePath: text("state_path"),
    ordinal: integer("ordinal").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_conformance_evidence_refs_result_idx").on(
      table.conformanceResultId,
      table.ordinal,
    ),
  ],
);

export const conformanceFindings = pgTable(
  "itotori_conformance_findings",
  {
    conformanceFindingId: text("conformance_finding_id").primaryKey(),
    conformanceRunId: text("conformance_run_id")
      .notNull()
      .references(() => conformanceRuns.conformanceRunId, { onDelete: "cascade" }),
    findingCode: text("finding_code").notNull(),
    severity: text("severity").notNull(),
    message: text("message").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("itotori_conformance_findings_run_idx").on(table.conformanceRunId)],
);

// Capability-leveled engine detector registry persistence.
// The Postgres enums (`capability_level_enum`,
// `capability_level_status_kind`) are created in migration
// 0030_engine_capability_reports.sql. The CHECK constraint in that
// migration mirrors the Rust `CapabilityLevelStatus` discriminator and
// the TS `assertCapabilityLevelStatusV02` guard, so the application can
// safely write any value the typed surface accepts.
export const capabilityLevelValues = {
  identify: "identify",
  inventory: "inventory",
  extract: "extract",
  patch: "patch",
} as const;

export type CapabilityLevel = (typeof capabilityLevelValues)[keyof typeof capabilityLevelValues];

export const capabilityLevelStatusKindValues = {
  supported: "supported",
  partial: "partial",
  unsupported: "unsupported",
} as const;

export type CapabilityLevelStatusKind =
  (typeof capabilityLevelStatusKindValues)[keyof typeof capabilityLevelStatusKindValues];

export const engineCapabilityEvidenceSourceValues = {
  publicFixture: "public_fixture",
  privateLocalAggregate: "private_local_aggregate",
} as const;

export type EngineCapabilityEvidenceSource =
  (typeof engineCapabilityEvidenceSourceValues)[keyof typeof engineCapabilityEvidenceSourceValues];

export const engineCapabilityEvidenceKindValues = {
  adapterMatrix: "adapter_matrix",
  localCorpusSidecar: "local_corpus_sidecar",
  keyValidation: "key_validation",
  engineMarkerCount: "engine_marker_count",
} as const;

export type EngineCapabilityEvidenceKind =
  (typeof engineCapabilityEvidenceKindValues)[keyof typeof engineCapabilityEvidenceKindValues];

export const engineCapabilityEvidenceStatusValues = {
  present: "present",
  partial: "partial",
  missing: "missing",
  unknown: "unknown",
} as const;

export type EngineCapabilityEvidenceStatus =
  (typeof engineCapabilityEvidenceStatusValues)[keyof typeof engineCapabilityEvidenceStatusValues];
