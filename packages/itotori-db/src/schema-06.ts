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
import { catalogSourceProvenance, catalogWorks } from "./schema-04.js";

export const catalogLocalScans = pgTable(
  "itotori_catalog_local_scans",
  {
    localScanId: text("local_scan_id").primaryKey(),
    scanRootLabel: text("scan_root_label").notNull(),
    scanRootPathHash: text("scan_root_path_hash").notNull(),
    scannerName: text("scanner_name").notNull(),
    scannerVersion: text("scanner_version").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    createdByUserId: text("created_by_user_id").references(() => users.userId, {
      onDelete: "set null",
    }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_catalog_local_scans_root_completed_idx").on(
      table.scanRootPathHash,
      table.completedAt,
    ),
    index("itotori_catalog_local_scans_user_idx").on(table.createdByUserId),
  ],
);

export const catalogLocalScanEntries = pgTable(
  "itotori_catalog_local_scan_entries",
  {
    localScanEntryId: text("local_scan_entry_id").primaryKey(),
    localScanId: text("local_scan_id")
      .notNull()
      .references(() => catalogLocalScans.localScanId, { onDelete: "cascade" }),
    workId: text("work_id").references(() => catalogWorks.workId, { onDelete: "set null" }),
    pathHash: text("path_hash").notNull(),
    pathRedactionClass: text("path_redaction_class").notNull(),
    owned: boolean("owned").notNull().default(true),
    engineName: text("engine_name"),
    engineSource: text("engine_source"),
    engineConfidence: text("engine_confidence"),
    signals: jsonb("signals")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    sourceProvenanceId: text("source_provenance_id").references(
      () => catalogSourceProvenance.sourceProvenanceId,
      { onDelete: "set null" },
    ),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_catalog_local_scan_entries_path_idx").on(
      table.localScanId,
      table.pathHash,
    ),
    index("itotori_catalog_local_scan_entries_work_idx").on(table.workId),
    index("itotori_catalog_local_scan_entries_engine_idx").on(table.engineName, table.engineSource),
    index("itotori_catalog_local_scan_entries_provenance_idx").on(table.sourceProvenanceId),
  ],
);

export const catalogLocalScanExternalIds = pgTable(
  "itotori_catalog_local_scan_external_ids",
  {
    localScanEntryId: text("local_scan_entry_id")
      .notNull()
      .references(() => catalogLocalScanEntries.localScanEntryId, { onDelete: "cascade" }),
    catalogSource: text("catalog_source").notNull(),
    sourceId: text("source_id").notNull(),
    externalIdKind: text("external_id_kind").notNull(),
    sourceProvenanceId: text("source_provenance_id").references(
      () => catalogSourceProvenance.sourceProvenanceId,
      { onDelete: "set null" },
    ),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.localScanEntryId, table.catalogSource, table.sourceId, table.externalIdKind],
    }),
    index("itotori_catalog_local_scan_external_ids_source_idx").on(
      table.catalogSource,
      table.sourceId,
    ),
    index("itotori_catalog_local_scan_external_ids_provenance_idx").on(table.sourceProvenanceId),
  ],
);

export const catalogSeedTargets = pgTable(
  "itotori_catalog_seed_targets",
  {
    seedTargetId: text("seed_target_id").primaryKey(),
    catalogSource: text("catalog_source").notNull(),
    sourceId: text("source_id").notNull(),
    seedOrigin: text("seed_origin").notNull(),
    originRef: text("origin_ref"),
    localScanEntryId: text("local_scan_entry_id").references(
      () => catalogLocalScanEntries.localScanEntryId,
      { onDelete: "set null" },
    ),
    sourceProvenanceId: text("source_provenance_id").references(
      () => catalogSourceProvenance.sourceProvenanceId,
      { onDelete: "set null" },
    ),
    status: text("status").notNull(),
    priority: integer("priority").notNull().default(0),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_catalog_seed_targets_source_origin_idx").on(
      table.catalogSource,
      table.sourceId,
      table.seedOrigin,
      sql`coalesce(${table.originRef}, '')`,
    ),
    index("itotori_catalog_seed_targets_status_idx").on(
      table.status,
      table.priority.desc(),
      table.addedAt,
    ),
    index("itotori_catalog_seed_targets_local_scan_entry_idx").on(table.localScanEntryId),
    index("itotori_catalog_seed_targets_provenance_idx").on(table.sourceProvenanceId),
  ],
);

export const catalogCandidateMatches = pgTable(
  "itotori_catalog_candidate_matches",
  {
    candidateId: text("candidate_id").primaryKey(),
    sourceCatalogSource: text("source_catalog_source").notNull(),
    sourceId: text("source_id").notNull(),
    sourceTitle: text("source_title").notNull(),
    sourceProvenanceId: text("source_provenance_id").references(
      () => catalogSourceProvenance.sourceProvenanceId,
      { onDelete: "set null" },
    ),
    targetWorkId: text("target_work_id")
      .notNull()
      .references(() => catalogWorks.workId, { onDelete: "cascade" }),
    score: integer("score").notNull(),
    matchedFields: jsonb("matched_fields")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text("status").notNull(),
    diagnosticCode: text("diagnostic_code").notNull(),
    generatorVersion: text("generator_version").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_catalog_candidate_matches_source_target_idx").on(
      table.sourceCatalogSource,
      table.sourceId,
      table.targetWorkId,
      table.generatorVersion,
    ),
    index("itotori_catalog_candidate_matches_status_idx").on(
      table.status,
      table.score.desc(),
      table.createdAt,
    ),
    index("itotori_catalog_candidate_matches_target_idx").on(table.targetWorkId),
    index("itotori_catalog_candidate_matches_provenance_idx").on(table.sourceProvenanceId),
  ],
);
