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

import { conformanceResults, conformanceRuns } from "./schema-17.js";

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
