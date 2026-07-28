import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  catalogRawContentRedactionClassValues,
  catalogConfidenceValues,
  catalogReleasePackageKindValues,
  catalogTranslationPortabilityValues,
} from "./schema-values-core.js";
import { catalogSourceProvenance } from "./schema-catalog-values.js";
import { catalogLocalScanEntries } from "./schema-catalog-local.js";

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

export const catalogReleaseInstallStates = pgTable(
  "itotori_catalog_release_install_states",
  {
    installStateId: text("install_state_id").primaryKey(),
    workId: text("work_id")
      .notNull()
      .references(() => catalogWorks.workId, { onDelete: "cascade" }),
    releaseId: text("release_id")
      .notNull()
      .references(() => catalogReleases.releaseId, { onDelete: "cascade" }),
    localScanEntryId: text("local_scan_entry_id").references(
      () => catalogLocalScanEntries.localScanEntryId,
      { onDelete: "set null" },
    ),
    installState: text("install_state").notNull(),
    targetArtifactLabel: text("target_artifact_label"),
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
    uniqueIndex("itotori_catalog_release_install_states_target_idx").on(
      table.releaseId,
      sql`coalesce(${table.localScanEntryId}, '')`,
      table.installState,
    ),
    index("itotori_catalog_release_install_states_work_idx").on(table.workId, table.installState),
    index("itotori_catalog_release_install_states_release_idx").on(
      table.releaseId,
      table.installState,
    ),
    index("itotori_catalog_release_install_states_local_scan_idx").on(table.localScanEntryId),
    index("itotori_catalog_release_install_states_provenance_idx").on(table.sourceProvenanceId),
  ],
);

export const catalogLanguageStatuses = pgTable(
  "itotori_catalog_language_statuses",
  {
    languageStatusId: text("language_status_id").primaryKey(),
    workId: text("work_id")
      .notNull()
      .references(() => catalogWorks.workId, { onDelete: "cascade" }),
    language: text("language").notNull(),
    status: text("status").notNull(),
    statusScope: text("status_scope").notNull(),
    platform: text("platform"),
    releaseId: text("release_id").references(() => catalogReleases.releaseId, {
      onDelete: "set null",
    }),
    sourceProvenanceId: text("source_provenance_id").references(
      () => catalogSourceProvenance.sourceProvenanceId,
      { onDelete: "set null" },
    ),
    confidence: text("confidence").notNull(),
    isCurrent: boolean("is_current").notNull().default(true),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
    parserVersion: text("parser_version").notNull().default("unknown"),
    rawContentRedactionClass: text("raw_content_redaction_class")
      .notNull()
      .default(catalogRawContentRedactionClassValues.publicMetadata),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_catalog_language_statuses_work_lang_idx").on(
      table.workId,
      table.language,
      table.status,
    ),
    index("itotori_catalog_language_statuses_release_idx").on(table.releaseId),
    index("itotori_catalog_language_statuses_provenance_idx").on(table.sourceProvenanceId),
  ],
);

export const catalogDemandFacts = pgTable(
  "itotori_catalog_demand_facts",
  {
    demandFactId: text("demand_fact_id").primaryKey(),
    workId: text("work_id")
      .notNull()
      .references(() => catalogWorks.workId, { onDelete: "cascade" }),
    catalogSource: text("catalog_source").notNull(),
    sourceId: text("source_id").notNull(),
    factKind: text("fact_kind").notNull(),
    factValue: jsonb("fact_value")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    sourceProvenanceId: text("source_provenance_id").references(
      () => catalogSourceProvenance.sourceProvenanceId,
      { onDelete: "set null" },
    ),
    parserVersion: text("parser_version").notNull().default("unknown"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_catalog_demand_facts_source_kind_idx").on(
      table.catalogSource,
      table.sourceId,
      table.factKind,
      sql`coalesce(${table.metadata}->>'sourceField', '')`,
    ),
    index("itotori_catalog_demand_facts_work_idx").on(table.workId),
    index("itotori_catalog_demand_facts_provenance_idx").on(table.sourceProvenanceId),
  ],
);

export const catalogConflicts = pgTable(
  "itotori_catalog_conflicts",
  {
    conflictId: text("conflict_id").primaryKey(),
    workId: text("work_id")
      .notNull()
      .references(() => catalogWorks.workId, { onDelete: "cascade" }),
    conflictKind: text("conflict_kind").notNull(),
    status: text("status").notNull(),
    summary: text("summary").notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_catalog_conflicts_work_status_idx").on(
      table.workId,
      table.conflictKind,
      table.status,
    ),
  ],
);

export const catalogConflictEvidence = pgTable(
  "itotori_catalog_conflict_evidence",
  {
    conflictEvidenceId: text("conflict_evidence_id").primaryKey(),
    conflictId: text("conflict_id")
      .notNull()
      .references(() => catalogConflicts.conflictId, { onDelete: "cascade" }),
    subjectKind: text("subject_kind").notNull(),
    subjectId: text("subject_id").notNull(),
    sourceProvenanceId: text("source_provenance_id").references(
      () => catalogSourceProvenance.sourceProvenanceId,
      { onDelete: "set null" },
    ),
    evidencePosition: integer("evidence_position").notNull().default(0),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_catalog_conflict_evidence_conflict_idx").on(table.conflictId),
    index("itotori_catalog_conflict_evidence_subject_idx").on(table.subjectKind, table.subjectId),
    index("itotori_catalog_conflict_evidence_provenance_idx").on(table.sourceProvenanceId),
  ],
);
