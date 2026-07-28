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
import { catalogWorks } from "./schema-catalog-main.js";

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

export const catalogCrawlerJobs = pgTable(
  "itotori_catalog_crawler_jobs",
  {
    crawlerJobId: text("crawler_job_id").primaryKey(),
    catalogSource: text("catalog_source").notNull(),
    adapterName: text("adapter_name").notNull(),
    adapterVersion: text("adapter_version").notNull(),
    sourceVersion: text("source_version").notNull(),
    parserVersion: text("parser_version").notNull(),
    partitionKey: text("partition_key").notNull(),
    status: text("status").notNull(),
    checkpointCursor: jsonb("checkpoint_cursor").$type<unknown | null>(),
    lockedBy: text("locked_by").notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastError: text("last_error"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_catalog_crawler_jobs_active_partition_idx")
      .on(table.catalogSource, table.adapterName, table.partitionKey)
      .where(sql`${table.status} = 'running'`),
    index("itotori_catalog_crawler_jobs_source_status_idx").on(
      table.catalogSource,
      table.status,
      table.updatedAt,
    ),
    index("itotori_catalog_crawler_jobs_lease_idx").on(table.leaseExpiresAt),
  ],
);

export const catalogCrawlerCheckpoints = pgTable(
  "itotori_catalog_crawler_checkpoints",
  {
    catalogSource: text("catalog_source").notNull(),
    adapterName: text("adapter_name").notNull(),
    partitionKey: text("partition_key").notNull(),
    checkpointCursor: jsonb("checkpoint_cursor").$type<unknown | null>(),
    sourceVersion: text("source_version").notNull(),
    parserVersion: text("parser_version").notNull(),
    lastCrawlerJobId: text("last_crawler_job_id").references(
      () => catalogCrawlerJobs.crawlerJobId,
      { onDelete: "set null" },
    ),
    lastStepKey: text("last_step_key"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (table) => [
    primaryKey({ columns: [table.catalogSource, table.adapterName, table.partitionKey] }),
    index("itotori_catalog_crawler_checkpoints_job_idx").on(table.lastCrawlerJobId),
  ],
);

export const catalogCrawlerRateLimits = pgTable(
  "itotori_catalog_crawler_rate_limits",
  {
    catalogSource: text("catalog_source").notNull(),
    adapterName: text("adapter_name").notNull(),
    partitionKey: text("partition_key").notNull(),
    nextAvailableAt: timestamp("next_available_at", { withTimezone: true }),
    resetAt: timestamp("reset_at", { withTimezone: true }),
    remaining: integer("remaining"),
    limit: integer("limit"),
    retryAfterSeconds: integer("retry_after_seconds"),
    requestIdentity: text("request_identity"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.catalogSource, table.adapterName, table.partitionKey] }),
    index("itotori_catalog_crawler_rate_limits_next_idx").on(table.nextAvailableAt),
  ],
);

export const catalogCrawlerJobSteps = pgTable(
  "itotori_catalog_crawler_job_steps",
  {
    crawlerJobStepId: text("crawler_job_step_id").primaryKey(),
    crawlerJobId: text("crawler_job_id")
      .notNull()
      .references(() => catalogCrawlerJobs.crawlerJobId, { onDelete: "cascade" }),
    stepKey: text("step_key").notNull(),
    catalogSource: text("catalog_source").notNull(),
    adapterName: text("adapter_name").notNull(),
    partitionKey: text("partition_key").notNull(),
    sourceId: text("source_id").notNull(),
    requestIdentity: text("request_identity").notNull(),
    sourceVersion: text("source_version").notNull(),
    parserVersion: text("parser_version").notNull(),
    checkpointCursor: jsonb("checkpoint_cursor").$type<unknown | null>(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    httpStatus: integer("http_status"),
    ok: boolean("ok").notNull(),
    payloadHash: text("payload_hash").notNull(),
    sourceProvenanceId: text("source_provenance_id")
      .notNull()
      .references(() => catalogSourceProvenance.sourceProvenanceId, { onDelete: "restrict" }),
    status: text("status").notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true }),
    error: text("error"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_catalog_crawler_job_steps_job_step_idx").on(
      table.crawlerJobId,
      table.stepKey,
    ),
    index("itotori_catalog_crawler_job_steps_source_request_idx").on(
      table.catalogSource,
      table.adapterName,
      table.partitionKey,
      table.requestIdentity,
      table.fetchedAt,
    ),
    index("itotori_catalog_crawler_job_steps_provenance_idx").on(table.sourceProvenanceId),
    index("itotori_catalog_crawler_job_steps_status_idx").on(table.status, table.updatedAt),
  ],
);
