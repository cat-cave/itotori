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
// Type-only import (erased at compile time — no runtime cycle with
// authorization.ts, which imports table VALUES from this module). Types the
// auth permission-set / grant / audit columns to the single Permission source
// of truth in authorization.ts.

import {
  catalogConfidenceValues,
  catalogRawContentRedactionClassValues,
  catalogReleasePackageKindValues,
  catalogTranslationPortabilityValues,
} from "./schema-02.js";
import { users } from "./schema-03.js";

export const userPermissionGrants = pgTable(
  "itotori_user_permission_grants",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.userId, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.permission] })],
);

export const catalogSourceProvenance = pgTable(
  "itotori_catalog_source_provenance",
  {
    sourceProvenanceId: text("source_provenance_id").primaryKey(),
    catalogSource: text("catalog_source").notNull(),
    sourceRecordKind: text("source_record_kind").notNull(),
    sourceId: text("source_id").notNull(),
    sourceVersion: text("source_version"),
    requestId: text("request_id"),
    httpStatus: integer("http_status"),
    ok: boolean("ok").notNull(),
    payloadHash: text("payload_hash"),
    rawContentRedactionClass: text("raw_content_redaction_class")
      .notNull()
      .default(catalogRawContentRedactionClassValues.publicMetadata),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_catalog_source_provenance_lookup_idx").on(
      table.catalogSource,
      table.sourceRecordKind,
      table.sourceId,
      table.fetchedAt,
    ),
    index("itotori_catalog_source_provenance_hash_idx").on(table.payloadHash),
  ],
);

export const catalogWorks = pgTable(
  "itotori_catalog_works",
  {
    workId: text("work_id").primaryKey(),
    canonicalTitle: text("canonical_title").notNull(),
    originalLanguage: text("original_language"),
    firstReleaseYear: integer("first_release_year"),
    workKind: text("work_kind").notNull().default("game"),
    engineName: text("engine_name"),
    engineSource: text("engine_source"),
    engineConfidence: text("engine_confidence"),
    engineProvenanceId: text("engine_provenance_id").references(
      () => catalogSourceProvenance.sourceProvenanceId,
      { onDelete: "set null" },
    ),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_catalog_works_title_idx").on(table.canonicalTitle),
    index("itotori_catalog_works_engine_idx").on(table.engineName, table.engineSource),
    index("itotori_catalog_works_engine_provenance_idx").on(table.engineProvenanceId),
  ],
);

export const catalogExternalIds = pgTable(
  "itotori_catalog_external_ids",
  {
    externalIdId: text("external_id_id").primaryKey(),
    workId: text("work_id")
      .notNull()
      .references(() => catalogWorks.workId, { onDelete: "cascade" }),
    catalogSource: text("catalog_source").notNull(),
    sourceId: text("source_id").notNull(),
    externalIdKind: text("external_id_kind").notNull(),
    sourceProvenanceId: text("source_provenance_id").references(
      () => catalogSourceProvenance.sourceProvenanceId,
      { onDelete: "set null" },
    ),
    confidence: text("confidence").notNull(),
    discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (table) => [
    uniqueIndex("itotori_catalog_external_ids_source_idx").on(
      table.catalogSource,
      table.sourceId,
      table.externalIdKind,
    ),
    index("itotori_catalog_external_ids_work_idx").on(table.workId),
    index("itotori_catalog_external_ids_provenance_idx").on(table.sourceProvenanceId),
  ],
);

export const catalogReleases = pgTable(
  "itotori_catalog_releases",
  {
    releaseId: text("release_id").primaryKey(),
    workId: text("work_id")
      .notNull()
      .references(() => catalogWorks.workId, { onDelete: "cascade" }),
    catalogSource: text("catalog_source").notNull(),
    sourceReleaseId: text("source_release_id"),
    releaseTitle: text("release_title").notNull(),
    releaseKind: text("release_kind").notNull(),
    editionName: text("edition_name"),
    milestone: text("milestone"),
    packageKind: text("package_kind").notNull().default(catalogReleasePackageKindValues.unknown),
    engineName: text("engine_name"),
    engineSource: text("engine_source"),
    engineConfidence: text("engine_confidence"),
    engineProvenanceId: text("engine_provenance_id").references(
      () => catalogSourceProvenance.sourceProvenanceId,
      { onDelete: "set null" },
    ),
    platform: text("platform"),
    language: text("language"),
    releaseDate: text("release_date"),
    releaseYear: integer("release_year"),
    isOfficial: boolean("is_official").notNull().default(false),
    sourceProvenanceId: text("source_provenance_id").references(
      () => catalogSourceProvenance.sourceProvenanceId,
      { onDelete: "set null" },
    ),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_catalog_releases_work_kind_idx").on(table.workId, table.releaseKind),
    index("itotori_catalog_releases_source_idx").on(table.catalogSource, table.sourceReleaseId),
    index("itotori_catalog_releases_milestone_idx").on(table.workId, table.milestone),
    index("itotori_catalog_releases_engine_idx").on(table.engineName, table.engineSource),
    index("itotori_catalog_releases_engine_provenance_idx").on(table.engineProvenanceId),
    index("itotori_catalog_releases_platform_language_idx").on(table.platform, table.language),
    index("itotori_catalog_releases_provenance_idx").on(table.sourceProvenanceId),
  ],
);

export const catalogReleaseMappings = pgTable(
  "itotori_catalog_release_mappings",
  {
    releaseMappingId: text("release_mapping_id").primaryKey(),
    workId: text("work_id")
      .notNull()
      .references(() => catalogWorks.workId, { onDelete: "cascade" }),
    sourceReleaseId: text("source_release_id")
      .notNull()
      .references(() => catalogReleases.releaseId, { onDelete: "cascade" }),
    targetReleaseId: text("target_release_id")
      .notNull()
      .references(() => catalogReleases.releaseId, { onDelete: "cascade" }),
    relationKind: text("relation_kind").notNull(),
    portability: text("portability").notNull().default(catalogTranslationPortabilityValues.unknown),
    sourceProvenanceId: text("source_provenance_id").references(
      () => catalogSourceProvenance.sourceProvenanceId,
      { onDelete: "set null" },
    ),
    confidence: text("confidence").notNull().default(catalogConfidenceValues.unknown),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_catalog_release_mappings_relation_idx").on(
      table.sourceReleaseId,
      table.targetReleaseId,
      table.relationKind,
    ),
    index("itotori_catalog_release_mappings_work_idx").on(table.workId, table.relationKind),
    index("itotori_catalog_release_mappings_target_idx").on(
      table.targetReleaseId,
      table.relationKind,
    ),
    index("itotori_catalog_release_mappings_source_idx").on(
      table.sourceReleaseId,
      table.relationKind,
    ),
    index("itotori_catalog_release_mappings_provenance_idx").on(table.sourceProvenanceId),
  ],
);
