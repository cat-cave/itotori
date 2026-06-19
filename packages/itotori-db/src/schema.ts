import {
  bigint as pgBigint,
  boolean,
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

export const projectStatusValues = {
  imported: "imported",
  drafted: "drafted",
  patchExported: "patch_exported",
  runtimeIngested: "runtime_ingested",
  archived: "archived",
} as const;

export type ProjectStatus = (typeof projectStatusValues)[keyof typeof projectStatusValues];

export const localeBranchStatusValues = {
  active: "active",
  archived: "archived",
} as const;

export type LocaleBranchStatus =
  (typeof localeBranchStatusValues)[keyof typeof localeBranchStatusValues];

export const styleGuideVersionStatusValues = {
  draft: "draft",
  approved: "approved",
  superseded: "superseded",
} as const;

export type StyleGuideVersionStatus =
  (typeof styleGuideVersionStatusValues)[keyof typeof styleGuideVersionStatusValues];

export const outboxEventTypeValues = {
  agentTaskRequested: "agent_task_requested",
  deterministicToolTaskRequested: "deterministic_tool_task_requested",
  rerunRequested: "rerun_requested",
  triageLoopRequested: "triage_loop_requested",
  styleGuideVersionChanged: "style_guide_version_changed",
  affectedWorkInvalidated: "affected_work_invalidated",
  jobScheduled: "job_scheduled",
  jobCompleted: "job_completed",
  jobFailed: "job_failed",
  jobDeadLettered: "job_dead_lettered",
} as const;

export type OutboxEventType = (typeof outboxEventTypeValues)[keyof typeof outboxEventTypeValues];

export const outboxStatusValues = {
  pending: "pending",
  publishing: "publishing",
  published: "published",
  retryWaiting: "retry_waiting",
  deadLetter: "dead_letter",
} as const;

export type OutboxStatus = (typeof outboxStatusValues)[keyof typeof outboxStatusValues];

export const jobTaskTypeValues = {
  agentTask: "agent_task",
  deterministicToolTask: "deterministic_tool_task",
  rerun: "rerun",
  triageLoop: "triage_loop",
} as const;

export type JobTaskType = (typeof jobTaskTypeValues)[keyof typeof jobTaskTypeValues];

export const jobStatusValues = {
  queued: "queued",
  running: "running",
  retryWaiting: "retry_waiting",
  succeeded: "succeeded",
  deadLetter: "dead_letter",
  cancelled: "cancelled",
} as const;

export type JobStatus = (typeof jobStatusValues)[keyof typeof jobStatusValues];

export const jobIdempotencyPolicyValues = {
  idempotent: "idempotent",
  nonIdempotent: "non_idempotent",
} as const;

export type JobIdempotencyPolicy =
  (typeof jobIdempotencyPolicyValues)[keyof typeof jobIdempotencyPolicyValues];

export const providerRunStatusValues = {
  succeeded: "succeeded",
  failed: "failed",
  partial: "partial",
  skipped: "skipped",
} as const;

export type ProviderRunStatus =
  (typeof providerRunStatusValues)[keyof typeof providerRunStatusValues];

export const providerCostKindValues = {
  billed: "billed",
  providerEstimate: "provider_estimate",
  localEstimate: "local_estimate",
  zero: "zero",
  unknown: "unknown",
} as const;

export type ProviderCostKind = (typeof providerCostKindValues)[keyof typeof providerCostKindValues];

export const runtimeRunStatusValues = {
  passed: "passed",
  failed: "failed",
} as const;

export type RuntimeRunStatus = (typeof runtimeRunStatusValues)[keyof typeof runtimeRunStatusValues];

export const runtimeEvidenceKindValues = {
  traceEvent: "trace_event",
  branchEvent: "branch_event",
  capture: "capture",
  recording: "recording",
  approximation: "approximation",
  referenceComparison: "reference_comparison",
} as const;

export type RuntimeEvidenceKind =
  (typeof runtimeEvidenceKindValues)[keyof typeof runtimeEvidenceKindValues];

export const runtimeBridgeUnitRefRoleValues = {
  primary: "primary",
  branchLabel: "branch_label",
  branchTarget: "branch_target",
  affected: "affected",
  covered: "covered",
} as const;

export type RuntimeBridgeUnitRefRole =
  (typeof runtimeBridgeUnitRefRoleValues)[keyof typeof runtimeBridgeUnitRefRoleValues];

export const catalogSourceValues = {
  vndb: "vndb",
  egs: "egs",
  dlsite: "dlsite",
  steam: "steam",
  igdb: "igdb",
  wikidata: "wikidata",
  localCorpus: "local_corpus",
  kaifuu: "kaifuu",
  manual: "manual",
} as const;

export type CatalogSource = (typeof catalogSourceValues)[keyof typeof catalogSourceValues];

export const catalogSourceRecordKindValues = {
  rawCache: "raw_cache",
  normalizedRecord: "normalized_record",
  recordedFixture: "recorded_fixture",
  localScan: "local_scan",
  manualAssertion: "manual_assertion",
  importerRequest: "importer_request",
} as const;

export type CatalogSourceRecordKind =
  (typeof catalogSourceRecordKindValues)[keyof typeof catalogSourceRecordKindValues];

export const catalogRawContentRedactionClassValues = {
  publicRaw: "public_raw",
  publicMetadata: "public_metadata",
  privateCorpus: "private_corpus",
  redacted: "redacted",
} as const;

export type CatalogRawContentRedactionClass =
  (typeof catalogRawContentRedactionClassValues)[keyof typeof catalogRawContentRedactionClassValues];

export const catalogExternalIdKindValues = {
  sourceRecord: "source_record",
  releaseRecord: "release_record",
  storeProduct: "store_product",
  knowledgeBaseEntity: "knowledge_base_entity",
  localDetection: "local_detection",
  manualAlias: "manual_alias",
} as const;

export type CatalogExternalIdKind =
  (typeof catalogExternalIdKindValues)[keyof typeof catalogExternalIdKindValues];

export const catalogConfidenceValues = {
  high: "high",
  medium: "medium",
  low: "low",
  unknown: "unknown",
} as const;

export type CatalogConfidence =
  (typeof catalogConfidenceValues)[keyof typeof catalogConfidenceValues];

export const catalogEngineSourceValues = {
  localScan: "local_scan",
  vndb: "vndb",
  dlsiteWorktypeInferred: "dlsite_worktype_inferred",
  sourceProvenance: "source_provenance",
  manual: "manual",
  unknown: "unknown",
} as const;

export type CatalogEngineSource =
  (typeof catalogEngineSourceValues)[keyof typeof catalogEngineSourceValues];

export const catalogReleaseKindValues = {
  original: "original",
  edition: "edition",
  officialTranslation: "official_translation",
  fanPatch: "fan_patch",
  patch: "patch",
  remaster: "remaster",
  fandisc: "fandisc",
  bundle: "bundle",
  collectionMember: "collection_member",
  unknown: "unknown",
} as const;

export type CatalogReleaseKind =
  (typeof catalogReleaseKindValues)[keyof typeof catalogReleaseKindValues];

export const catalogReleasePackageKindValues = {
  looseFiles: "loose_files",
  archive: "archive",
  installer: "installer",
  steamApp: "steam_app",
  dlsiteProduct: "dlsite_product",
  physicalMedia: "physical_media",
  bundle: "bundle",
  unknown: "unknown",
} as const;

export type CatalogReleasePackageKind =
  (typeof catalogReleasePackageKindValues)[keyof typeof catalogReleasePackageKindValues];

export const catalogReleaseMappingKindValues = {
  editionOf: "edition_of",
  remasterOf: "remaster_of",
  fandiscOf: "fandisc_of",
  bundleContains: "bundle_contains",
  collectionContains: "collection_contains",
  translationOf: "translation_of",
  patchTargets: "patch_targets",
  sameMilestoneAs: "same_milestone_as",
} as const;

export type CatalogReleaseMappingKind =
  (typeof catalogReleaseMappingKindValues)[keyof typeof catalogReleaseMappingKindValues];

export const catalogTranslationPortabilityValues = {
  exact: "exact",
  likelyPortable: "likely_portable",
  needsReview: "needs_review",
  incompatible: "incompatible",
  unknown: "unknown",
} as const;

export type CatalogTranslationPortability =
  (typeof catalogTranslationPortabilityValues)[keyof typeof catalogTranslationPortabilityValues];

export const catalogInstallStateValues = {
  sourceArchive: "source_archive",
  installed: "installed",
  patchTarget: "patch_target",
  notInstalled: "not_installed",
  archived: "archived",
  unknown: "unknown",
} as const;

export type CatalogInstallState =
  (typeof catalogInstallStateValues)[keyof typeof catalogInstallStateValues];

export const catalogLanguageStatusValues = {
  officialFull: "official_full",
  fanFull: "fan_full",
  fanPartial: "fan_partial",
  mtl: "mtl",
  interfaceOnly: "interface_only",
  none: "none",
  unverifiedConsole: "unverified_console",
  unknown: "unknown",
} as const;

export type CatalogLanguageStatus =
  (typeof catalogLanguageStatusValues)[keyof typeof catalogLanguageStatusValues];

export const catalogLanguageStatusScopeValues = {
  work: "work",
  release: "release",
  platform: "platform",
} as const;

export type CatalogLanguageStatusScope =
  (typeof catalogLanguageStatusScopeValues)[keyof typeof catalogLanguageStatusScopeValues];

export const catalogDemandFactKindValues = {
  dlCount: "dl_count",
  ratingSummary: "rating_summary",
  ratingHistogram: "rating_histogram",
  wishlistCount: "wishlist_count",
  rank: "rank",
  workType: "work_type",
  translationTree: "translation_tree",
} as const;

export type CatalogDemandFactKind =
  (typeof catalogDemandFactKindValues)[keyof typeof catalogDemandFactKindValues];

export const catalogConflictKindValues = {
  externalId: "external_id",
  languageStatus: "language_status",
  release: "release",
  title: "title",
  engine: "engine",
} as const;

export type CatalogConflictKind =
  (typeof catalogConflictKindValues)[keyof typeof catalogConflictKindValues];

export const catalogConflictStatusValues = {
  open: "open",
  resolved: "resolved",
  ignored: "ignored",
} as const;

export type CatalogConflictStatus =
  (typeof catalogConflictStatusValues)[keyof typeof catalogConflictStatusValues];

export const catalogConflictSubjectKindValues = {
  externalId: "external_id",
  languageStatus: "language_status",
  release: "release",
  work: "work",
  sourceProvenance: "source_provenance",
} as const;

export type CatalogConflictSubjectKind =
  (typeof catalogConflictSubjectKindValues)[keyof typeof catalogConflictSubjectKindValues];

export const catalogPathRedactionClassValues = {
  privatePathHash: "private_path_hash",
  publicFixturePath: "public_fixture_path",
  redacted: "redacted",
} as const;

export type CatalogPathRedactionClass =
  (typeof catalogPathRedactionClassValues)[keyof typeof catalogPathRedactionClassValues];

export const catalogSeedOriginValues = {
  localScan: "local_scan",
  recordedFixture: "recorded_fixture",
  researchFixture: "research_fixture",
  manual: "manual",
  importer: "importer",
  catalogCrawl: "catalog_crawl",
} as const;

export type CatalogSeedOrigin =
  (typeof catalogSeedOriginValues)[keyof typeof catalogSeedOriginValues];

export const catalogSeedStatusValues = {
  pending: "pending",
  queued: "queued",
  imported: "imported",
  ignored: "ignored",
  failed: "failed",
} as const;

export type CatalogSeedStatus =
  (typeof catalogSeedStatusValues)[keyof typeof catalogSeedStatusValues];

export const catalogCandidateMatchStatusValues = {
  reviewPending: "review_pending",
  duplicateSource: "duplicate_source",
} as const;

export type CatalogCandidateMatchStatus =
  (typeof catalogCandidateMatchStatusValues)[keyof typeof catalogCandidateMatchStatusValues];

export const catalogCrawlerJobStatusValues = {
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
} as const;

export type CatalogCrawlerJobStatus =
  (typeof catalogCrawlerJobStatusValues)[keyof typeof catalogCrawlerJobStatusValues];

export const catalogCrawlerStepStatusValues = {
  fetched: "fetched",
  imported: "imported",
  failed: "failed",
} as const;

export type CatalogCrawlerStepStatus =
  (typeof catalogCrawlerStepStatusValues)[keyof typeof catalogCrawlerStepStatusValues];

export const terminologyTermStatusValues = {
  active: "active",
  deprecated: "deprecated",
  conflicted: "conflicted",
} as const;

export type TerminologyTermStatus =
  (typeof terminologyTermStatusValues)[keyof typeof terminologyTermStatusValues];

export const terminologyTermKindValues = {
  characterName: "character_name",
  placeName: "place_name",
  itemName: "item_name",
  systemTerm: "system_term",
  loreTerm: "lore_term",
  uiTerm: "ui_term",
  general: "general",
} as const;

export type TerminologyTermKind =
  (typeof terminologyTermKindValues)[keyof typeof terminologyTermKindValues];

export const terminologyAliasKindValues = {
  sourceAlias: "source_alias",
  targetAlias: "target_alias",
  disallowedTranslation: "disallowed_translation",
} as const;

export type TerminologyAliasKind =
  (typeof terminologyAliasKindValues)[keyof typeof terminologyAliasKindValues];

export const terminologySourceReferenceKindValues = {
  sourceUnit: "source_unit",
  styleGuide: "style_guide",
  catalog: "catalog",
  manual: "manual",
  qaFinding: "qa_finding",
} as const;

export type TerminologySourceReferenceKind =
  (typeof terminologySourceReferenceKindValues)[keyof typeof terminologySourceReferenceKindValues];

export const terminologySemanticIndexStatusValues = {
  pending: "pending",
  indexedLexical: "indexed_lexical",
  ready: "ready",
  stale: "stale",
  failed: "failed",
} as const;

export type TerminologySemanticIndexStatus =
  (typeof terminologySemanticIndexStatusValues)[keyof typeof terminologySemanticIndexStatusValues];

export const terminologyConflictKindValues = {
  preferredTranslation: "preferred_translation",
  alias: "alias",
  sourceReference: "source_reference",
  localeScope: "locale_scope",
} as const;

export type TerminologyConflictKind =
  (typeof terminologyConflictKindValues)[keyof typeof terminologyConflictKindValues];

export const terminologyConflictStatusValues = {
  open: "open",
  resolved: "resolved",
  ignored: "ignored",
} as const;

export type TerminologyConflictStatus =
  (typeof terminologyConflictStatusValues)[keyof typeof terminologyConflictStatusValues];

export const glossaryReviewItemStateValues = {
  proposed: "proposed",
  approved: "approved",
  rejected: "rejected",
  conflict: "conflict",
  staleSource: "stale_source",
} as const;

export type GlossaryReviewItemState =
  (typeof glossaryReviewItemStateValues)[keyof typeof glossaryReviewItemStateValues];

export const translationMemorySegmentStatusValues = {
  reusable: "reusable",
  blocked: "blocked",
} as const;

export type TranslationMemorySegmentStatus =
  (typeof translationMemorySegmentStatusValues)[keyof typeof translationMemorySegmentStatusValues];

export const translationMemoryMatchKindValues = {
  exact: "exact",
  fuzzy: "fuzzy",
} as const;

export type TranslationMemoryMatchKind =
  (typeof translationMemoryMatchKindValues)[keyof typeof translationMemoryMatchKindValues];

export const translationMemoryReuseStatusValues = {
  suggested: "suggested",
  applied: "applied",
} as const;

export type TranslationMemoryReuseStatus =
  (typeof translationMemoryReuseStatusValues)[keyof typeof translationMemoryReuseStatusValues];

export const users = pgTable("itotori_users", {
  userId: text("user_id").primaryKey(),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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

export const workspaces = pgTable("itotori_workspaces", {
  workspaceId: text("workspace_id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projects = pgTable(
  "itotori_projects",
  {
    projectId: text("project_id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.workspaceId, { onDelete: "cascade" }),
    projectKey: text("project_key").notNull(),
    name: text("name").notNull(),
    sourceLocale: text("source_locale").notNull(),
    status: text("status").notNull(),
    gameId: text("game_id"),
    gameVersion: text("game_version"),
    sourceProfileId: text("source_profile_id"),
    createdByUserId: text("created_by_user_id").references(() => users.userId, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_projects_workspace_key_idx").on(table.workspaceId, table.projectKey),
    index("itotori_projects_workspace_status_idx").on(table.workspaceId, table.status),
  ],
);

export const sourceRevisions = pgTable(
  "itotori_source_revisions",
  {
    sourceRevisionId: text("source_revision_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    revisionKind: text("revision_kind").notNull(),
    value: text("value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_source_revisions_project_idx").on(table.projectId),
    index("itotori_source_revisions_kind_value_idx").on(table.revisionKind, table.value),
  ],
);

export const sourceBundles = pgTable(
  "itotori_source_bundles",
  {
    sourceBundleId: text("source_bundle_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    sourceBundleRevisionId: text("source_bundle_revision_id")
      .notNull()
      .references(() => sourceRevisions.sourceRevisionId, { onDelete: "restrict" }),
    bridgeId: text("bridge_id").notNull(),
    schemaVersion: text("schema_version").notNull(),
    sourceBundleHash: text("source_bundle_hash").notNull(),
    sourceLocale: text("source_locale").notNull(),
    extractorName: text("extractor_name").notNull(),
    extractorVersion: text("extractor_version").notNull(),
    unitCount: integer("unit_count").notNull(),
    assetCount: integer("asset_count").notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_source_bundles_bridge_idx").on(table.bridgeId),
    index("itotori_source_bundles_project_imported_idx").on(table.projectId, table.importedAt),
    index("itotori_source_bundles_revision_idx").on(table.sourceBundleRevisionId),
    index("itotori_source_bundles_hash_idx").on(table.sourceBundleHash),
  ],
);

export const bridgeImports = pgTable(
  "itotori_bridge_imports",
  {
    bridgeImportId: text("bridge_import_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    sourceBundleId: text("source_bundle_id")
      .notNull()
      .references(() => sourceBundles.sourceBundleId, { onDelete: "cascade" }),
    sourceBundleRevisionId: text("source_bundle_revision_id")
      .notNull()
      .references(() => sourceRevisions.sourceRevisionId, { onDelete: "restrict" }),
    bridgeId: text("bridge_id").notNull(),
    schemaVersion: text("schema_version").notNull(),
    sourceBundleHash: text("source_bundle_hash").notNull(),
    sourceLocale: text("source_locale").notNull(),
    unitCount: integer("unit_count").notNull(),
    assetCount: integer("asset_count").notNull(),
    sourceRevisionCount: integer("source_revision_count").notNull(),
    validationFailureCount: integer("validation_failure_count").notNull().default(0),
    addedUnitCount: integer("added_unit_count").notNull(),
    updatedUnitCount: integer("updated_unit_count").notNull(),
    removedUnitCount: integer("removed_unit_count").notNull(),
    unchangedUnitCount: integer("unchanged_unit_count").notNull(),
    addedAssetCount: integer("added_asset_count").notNull(),
    updatedAssetCount: integer("updated_asset_count").notNull(),
    removedAssetCount: integer("removed_asset_count").notNull(),
    unchangedAssetCount: integer("unchanged_asset_count").notNull(),
    addedSourceRevisionCount: integer("added_source_revision_count").notNull(),
    existingSourceRevisionCount: integer("existing_source_revision_count").notNull(),
    catalogWorkId: text("catalog_work_id"),
    localCorpusEntryId: text("local_corpus_entry_id"),
    readinessProfileId: text("readiness_profile_id"),
    completenessStatusId: text("completeness_status_id"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_bridge_imports_bundle_revision_idx").on(
      table.sourceBundleId,
      table.sourceBundleRevisionId,
    ),
    index("itotori_bridge_imports_project_imported_idx").on(table.projectId, table.importedAt),
    index("itotori_bridge_imports_future_refs_idx").on(
      table.catalogWorkId,
      table.localCorpusEntryId,
      table.readinessProfileId,
      table.completenessStatusId,
    ),
  ],
);

export const assets = pgTable(
  "itotori_assets",
  {
    assetId: text("asset_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    sourceBundleId: text("source_bundle_id")
      .notNull()
      .references(() => sourceBundles.sourceBundleId, { onDelete: "cascade" }),
    sourceRevisionId: text("source_revision_id")
      .notNull()
      .references(() => sourceRevisions.sourceRevisionId, { onDelete: "restrict" }),
    assetKey: text("asset_key").notNull(),
    assetKind: text("asset_kind").notNull(),
    sourceHash: text("source_hash").notNull(),
    path: text("path"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_assets_project_kind_idx").on(table.projectId, table.assetKind),
    index("itotori_assets_bundle_key_idx").on(table.sourceBundleId, table.assetKey),
    index("itotori_assets_revision_idx").on(table.sourceRevisionId),
  ],
);

export const sourceUnits = pgTable(
  "itotori_source_units",
  {
    bridgeUnitId: text("bridge_unit_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    sourceBundleId: text("source_bundle_id")
      .notNull()
      .references(() => sourceBundles.sourceBundleId, { onDelete: "cascade" }),
    sourceAssetId: text("source_asset_id")
      .notNull()
      .references(() => assets.assetId, { onDelete: "restrict" }),
    sourceRevisionId: text("source_revision_id")
      .notNull()
      .references(() => sourceRevisions.sourceRevisionId, { onDelete: "restrict" }),
    surfaceId: text("surface_id").notNull(),
    surfaceKind: text("surface_kind").notNull(),
    sourceUnitKey: text("source_unit_key").notNull(),
    occurrenceId: text("occurrence_id").notNull(),
    sourceLocale: text("source_locale").notNull(),
    sourceText: text("source_text").notNull(),
    sourceHash: text("source_hash").notNull(),
    sourceLocation: jsonb("source_location").$type<unknown>().notNull(),
    speaker: jsonb("speaker").$type<unknown | null>(),
    context: jsonb("context").$type<unknown>().notNull(),
    policy: jsonb("policy").$type<unknown | null>(),
    spans: jsonb("spans").$type<unknown[]>().notNull(),
    patchRef: jsonb("patch_ref").$type<unknown>().notNull(),
    runtimeExpectation: jsonb("runtime_expectation").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_source_units_bundle_key_idx").on(
      table.sourceBundleId,
      table.sourceUnitKey,
    ),
    index("itotori_source_units_project_locale_key_idx").on(
      table.projectId,
      table.sourceLocale,
      table.sourceUnitKey,
    ),
    index("itotori_source_units_asset_idx").on(table.sourceAssetId),
    index("itotori_source_units_revision_idx").on(table.sourceRevisionId),
  ],
);

export const localeBranches = pgTable(
  "itotori_locale_branches",
  {
    localeBranchId: text("locale_branch_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    sourceBundleId: text("source_bundle_id")
      .notNull()
      .references(() => sourceBundles.sourceBundleId, { onDelete: "restrict" }),
    targetLocale: text("target_locale").notNull(),
    branchName: text("branch_name").notNull(),
    status: text("status").notNull(),
    createdByUserId: text("created_by_user_id").references(() => users.userId, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_locale_branches_project_locale_idx").on(table.projectId, table.targetLocale),
    index("itotori_locale_branches_bundle_idx").on(table.sourceBundleId),
  ],
);

export const styleGuides = pgTable(
  "itotori_style_guides",
  {
    styleGuideId: text("style_guide_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    latestVersionId: text("latest_version_id"),
    approvedVersionId: text("approved_version_id"),
    createdByUserId: text("created_by_user_id").references(() => users.userId, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_style_guides_locale_branch_idx").on(table.localeBranchId),
    index("itotori_style_guides_project_idx").on(table.projectId),
  ],
);

export const styleGuideVersions = pgTable(
  "itotori_style_guide_versions",
  {
    styleGuideVersionId: text("style_guide_version_id").primaryKey(),
    styleGuideId: text("style_guide_id")
      .notNull()
      .references(() => styleGuides.styleGuideId, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    previousVersionId: text("previous_version_id"),
    sourceRevisionId: text("source_revision_id")
      .notNull()
      .references(() => sourceRevisions.sourceRevisionId, { onDelete: "restrict" }),
    versionSequence: integer("version_sequence").notNull(),
    authorUserId: text("author_user_id")
      .notNull()
      .references(() => users.userId, { onDelete: "restrict" }),
    approverUserId: text("approver_user_id").references(() => users.userId, {
      onDelete: "set null",
    }),
    status: text("status").notNull(),
    contentHash: text("content_hash").notNull(),
    policy: jsonb("policy").$type<Record<string, unknown>>().notNull(),
    semanticDiagnostics: jsonb("semantic_diagnostics")
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_style_guide_versions_branch_sequence_idx").on(
      table.localeBranchId,
      table.versionSequence,
    ),
    index("itotori_style_guide_versions_guide_created_idx").on(table.styleGuideId, table.createdAt),
    index("itotori_style_guide_versions_source_revision_idx").on(table.sourceRevisionId),
    index("itotori_style_guide_versions_status_idx").on(table.status),
  ],
);

export const branchPolicyGlossaryReferences = pgTable(
  "itotori_branch_policy_glossary_references",
  {
    referenceId: text("reference_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    versionSequence: integer("version_sequence").notNull(),
    styleGuideVersionId: text("style_guide_version_id").references(
      () => styleGuideVersions.styleGuideVersionId,
      { onDelete: "set null" },
    ),
    glossaryContentHash: text("glossary_content_hash").notNull(),
    glossaryTermRefs: jsonb("glossary_term_refs")
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    glossaryReviewItemRefs: jsonb("glossary_review_item_refs")
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    updateReason: text("update_reason").notNull(),
    eventId: text("event_id"),
    supersedesReferenceId: text("supersedes_reference_id"),
    actorUserId: text("actor_user_id").references(() => users.userId, {
      onDelete: "set null",
    }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_branch_policy_glossary_refs_branch_sequence_idx").on(
      table.localeBranchId,
      table.versionSequence,
    ),
    index("itotori_branch_policy_glossary_refs_project_branch_idx").on(
      table.projectId,
      table.localeBranchId,
      table.createdAt,
    ),
    index("itotori_branch_policy_glossary_refs_style_guide_idx").on(table.styleGuideVersionId),
    index("itotori_branch_policy_glossary_refs_hash_idx").on(
      table.localeBranchId,
      table.glossaryContentHash,
    ),
    index("itotori_branch_policy_glossary_refs_event_idx").on(table.eventId),
  ],
);

export const localeBranchUnits = pgTable(
  "itotori_locale_branch_units",
  {
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    bridgeUnitId: text("bridge_unit_id")
      .notNull()
      .references(() => sourceUnits.bridgeUnitId, { onDelete: "cascade" }),
    targetText: text("target_text"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    styleGuideVersionId: text("style_guide_version_id").references(
      () => styleGuideVersions.styleGuideVersionId,
      { onDelete: "set null" },
    ),
    glossaryReferenceId: text("glossary_reference_id").references(
      () => branchPolicyGlossaryReferences.referenceId,
      { onDelete: "set null" },
    ),
  },
  (table) => [
    primaryKey({ columns: [table.localeBranchId, table.bridgeUnitId] }),
    index("itotori_locale_branch_units_bridge_unit_idx").on(table.bridgeUnitId),
    index("itotori_locale_branch_units_style_guide_version_idx").on(table.styleGuideVersionId),
    index("itotori_locale_branch_units_glossary_reference_idx").on(table.glossaryReferenceId),
  ],
);

export const translationMemorySegments = pgTable(
  "itotori_translation_memory_segments",
  {
    memorySegmentId: text("memory_segment_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    sourceRevisionId: text("source_revision_id")
      .notNull()
      .references(() => sourceRevisions.sourceRevisionId, { onDelete: "restrict" }),
    sourceBridgeUnitId: text("source_bridge_unit_id").references(() => sourceUnits.bridgeUnitId, {
      onDelete: "set null",
    }),
    sourceUnitKey: text("source_unit_key").notNull(),
    sourceOccurrenceId: text("source_occurrence_id").notNull(),
    sourceHash: text("source_hash").notNull(),
    sourceFingerprint: text("source_fingerprint").notNull(),
    sourceText: text("source_text").notNull(),
    targetLocale: text("target_locale").notNull(),
    targetText: text("target_text").notNull(),
    status: text("status").notNull(),
    provenance: jsonb("provenance")
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
    index("itotori_tm_segments_exact_lookup_idx").on(
      table.localeBranchId,
      table.sourceRevisionId,
      table.sourceHash,
      table.status,
      table.sourceUnitKey,
      table.sourceOccurrenceId,
    ),
    index("itotori_tm_segments_fingerprint_idx").on(
      table.localeBranchId,
      table.sourceRevisionId,
      table.sourceFingerprint,
      table.status,
    ),
    index("itotori_tm_segments_project_branch_idx").on(
      table.projectId,
      table.localeBranchId,
      table.createdAt,
    ),
  ],
);

export const translationMemoryReuseEvents = pgTable(
  "itotori_translation_memory_reuse_events",
  {
    reuseEventId: text("reuse_event_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    targetBridgeUnitId: text("target_bridge_unit_id")
      .notNull()
      .references(() => sourceUnits.bridgeUnitId, { onDelete: "cascade" }),
    sourceRevisionId: text("source_revision_id")
      .notNull()
      .references(() => sourceRevisions.sourceRevisionId, { onDelete: "restrict" }),
    memorySegmentId: text("memory_segment_id")
      .notNull()
      .references(() => translationMemorySegments.memorySegmentId, { onDelete: "restrict" }),
    matchKind: text("match_kind").notNull(),
    matchScore: integer("match_score").notNull(),
    reuseStatus: text("reuse_status").notNull(),
    sourceHash: text("source_hash").notNull(),
    candidateSourceHash: text("candidate_source_hash").notNull(),
    targetText: text("target_text").notNull(),
    provenance: jsonb("provenance")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    costImpact: jsonb("cost_impact")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdByUserId: text("created_by_user_id").references(() => users.userId, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_tm_reuse_events_target_idx").on(
      table.localeBranchId,
      table.targetBridgeUnitId,
      table.createdAt,
    ),
    index("itotori_tm_reuse_events_segment_idx").on(table.memorySegmentId, table.createdAt),
  ],
);

export const events = pgTable(
  "itotori_events",
  {
    eventId: text("event_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id").references(() => localeBranches.localeBranchId, {
      onDelete: "set null",
    }),
    eventKind: text("event_kind").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    actor: jsonb("actor").$type<unknown>().notNull(),
    taskId: text("task_id"),
    findingId: text("finding_id"),
    subjectRefs: jsonb("subject_refs").$type<unknown[]>().notNull(),
    provenance: jsonb("provenance").$type<unknown[]>().notNull(),
    causalLinks: jsonb("causal_links").$type<unknown[]>().notNull(),
    payload: jsonb("payload").$type<unknown | null>(),
    appendedAt: timestamp("appended_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_events_project_branch_time_idx").on(
      table.projectId,
      table.localeBranchId,
      table.occurredAt,
    ),
    index("itotori_events_kind_time_idx").on(table.eventKind, table.occurredAt),
    index("itotori_events_task_idx").on(table.taskId),
    index("itotori_events_finding_idx").on(table.findingId),
  ],
);

export const eventOutbox = pgTable(
  "itotori_event_outbox",
  {
    outboxEventId: text("outbox_event_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id").references(() => localeBranches.localeBranchId, {
      onDelete: "set null",
    }),
    sourceEventId: text("source_event_id").references(() => events.eventId, {
      onDelete: "set null",
    }),
    eventType: text("event_type").notNull(),
    status: text("status").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    correlationId: text("correlation_id").notNull(),
    causationId: text("causation_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(25),
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    lastError: text("last_error"),
    errorHistory: jsonb("error_history")
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_event_outbox_idempotency_key_idx").on(table.idempotencyKey),
    index("itotori_event_outbox_ready_idx").on(table.status, table.availableAt, table.createdAt),
    index("itotori_event_outbox_project_type_idx").on(table.projectId, table.eventType),
    index("itotori_event_outbox_source_event_idx").on(table.sourceEventId),
    index("itotori_event_outbox_correlation_idx").on(table.correlationId),
  ],
);

export const jobQueue = pgTable(
  "itotori_jobs",
  {
    jobId: text("job_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id").references(() => localeBranches.localeBranchId, {
      onDelete: "set null",
    }),
    sourceEventId: text("source_event_id").references(() => events.eventId, {
      onDelete: "set null",
    }),
    triggerOutboxEventId: text("trigger_outbox_event_id").references(
      () => eventOutbox.outboxEventId,
      { onDelete: "set null" },
    ),
    jobType: text("job_type").notNull(),
    jobName: text("job_name").notNull(),
    queueName: text("queue_name").notNull().default("default"),
    status: text("status").notNull(),
    idempotencyPolicy: text("idempotency_policy").notNull(),
    idempotencyKey: text("idempotency_key"),
    correlationId: text("correlation_id").notNull(),
    causationId: text("causation_id"),
    subjectRefs: jsonb("subject_refs").$type<unknown[]>().notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    priority: integer("priority").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastError: text("last_error"),
    errorHistory: jsonb("error_history")
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    result: jsonb("result").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_jobs_idempotency_key_idx").on(table.idempotencyKey),
    index("itotori_jobs_ready_idx").on(
      table.queueName,
      table.status,
      table.availableAt,
      table.priority,
    ),
    index("itotori_jobs_project_type_status_idx").on(table.projectId, table.jobType, table.status),
    index("itotori_jobs_trigger_outbox_event_idx").on(table.triggerOutboxEventId),
    index("itotori_jobs_source_event_idx").on(table.sourceEventId),
    index("itotori_jobs_correlation_idx").on(table.correlationId),
  ],
);

export const modelProviders = pgTable(
  "itotori_model_providers",
  {
    providerId: text("provider_id").primaryKey(),
    providerFamily: text("provider_family").notNull(),
    endpointFamily: text("endpoint_family").notNull(),
    providerName: text("provider_name").notNull(),
    dataHandling: jsonb("data_handling").$type<Record<string, unknown>>().notNull(),
    accountPrivacy: jsonb("account_privacy").$type<Record<string, unknown> | null>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_model_providers_identity_idx").on(
      table.providerFamily,
      table.endpointFamily,
      table.providerName,
    ),
  ],
);

export const modelRegistry = pgTable(
  "itotori_model_registry",
  {
    modelRegistryId: text("model_registry_id").primaryKey(),
    providerId: text("provider_id")
      .notNull()
      .references(() => modelProviders.providerId, { onDelete: "restrict" }),
    modelId: text("model_id").notNull(),
    capabilities: jsonb("capabilities").$type<Record<string, unknown>>().notNull(),
    pricing: jsonb("pricing").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_model_registry_provider_model_idx").on(table.providerId, table.modelId),
    index("itotori_model_registry_model_idx").on(table.modelId),
  ],
);

export const promptPresets = pgTable(
  "itotori_prompt_presets",
  {
    promptPresetId: text("prompt_preset_id").notNull(),
    promptTemplateVersion: text("prompt_template_version").notNull(),
    presetSchemaVersion: text("preset_schema_version").notNull(),
    promptHash: text("prompt_hash").notNull(),
    configSnapshot: jsonb("config_snapshot").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.promptPresetId, table.promptTemplateVersion] }),
    index("itotori_prompt_presets_hash_idx").on(table.promptHash),
  ],
);

export const providerRuns = pgTable(
  "itotori_provider_runs",
  {
    providerRunId: text("provider_run_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id").references(() => localeBranches.localeBranchId, {
      onDelete: "set null",
    }),
    jobId: text("job_id").references(() => jobQueue.jobId, { onDelete: "set null" }),
    systemId: text("system_id"),
    taskKind: text("task_kind").notNull(),
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    latencyMs: integer("latency_ms"),
    providerId: text("provider_id")
      .notNull()
      .references(() => modelProviders.providerId, { onDelete: "restrict" }),
    requestedModelRegistryId: text("requested_model_registry_id")
      .notNull()
      .references(() => modelRegistry.modelRegistryId, { onDelete: "restrict" }),
    actualModelRegistryId: text("actual_model_registry_id")
      .notNull()
      .references(() => modelRegistry.modelRegistryId, { onDelete: "restrict" }),
    requestedModelId: text("requested_model_id").notNull(),
    actualModelId: text("actual_model_id").notNull(),
    upstreamProvider: text("upstream_provider"),
    routeSettingsHash: text("route_settings_hash"),
    promptPresetId: text("prompt_preset_id").notNull(),
    promptTemplateVersion: text("prompt_template_version").notNull(),
    promptHash: text("prompt_hash").notNull(),
    providerPreset: jsonb("provider_preset").$type<Record<string, unknown> | null>(),
    structuredOutputMode: text("structured_output_mode").notNull(),
    retryCount: integer("retry_count").notNull(),
    errorClasses: jsonb("error_classes").$type<string[]>().notNull(),
    fallbackUsed: boolean("fallback_used").notNull(),
    fallbackPlan: jsonb("fallback_plan").$type<string[]>().notNull(),
    tokenCountSource: text("token_count_source").notNull(),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    cachedInputTokens: integer("cached_input_tokens"),
    totalTokens: integer("total_tokens"),
    dataHandling: jsonb("data_handling").$type<Record<string, unknown>>().notNull(),
    accountPrivacy: jsonb("account_privacy").$type<Record<string, unknown> | null>(),
    adapterMetadata: jsonb("adapter_metadata").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_provider_runs_project_started_idx").on(table.projectId, table.startedAt),
    index("itotori_provider_runs_project_task_idx").on(table.projectId, table.taskKind),
    index("itotori_provider_runs_prompt_idx").on(table.promptPresetId, table.promptTemplateVersion),
    index("itotori_provider_runs_fallback_idx").on(table.projectId, table.fallbackUsed),
    foreignKey({
      columns: [table.promptPresetId, table.promptTemplateVersion],
      foreignColumns: [promptPresets.promptPresetId, promptPresets.promptTemplateVersion],
      name: "itotori_provider_runs_prompt_preset_fk",
    }).onDelete("restrict"),
  ],
);

export const costLedgerEntries = pgTable(
  "itotori_cost_ledger_entries",
  {
    costLedgerEntryId: text("cost_ledger_entry_id").primaryKey(),
    providerRunId: text("provider_run_id")
      .notNull()
      .references(() => providerRuns.providerRunId, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id").references(() => localeBranches.localeBranchId, {
      onDelete: "set null",
    }),
    costKind: text("cost_kind").notNull(),
    currency: text("currency").notNull(),
    amountMicrosUsd: pgBigint("amount_micros_usd", { mode: "number" }),
    pricingSnapshotId: text("pricing_snapshot_id"),
    tokenCountSource: text("token_count_source").notNull(),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    cachedInputTokens: integer("cached_input_tokens"),
    totalTokens: integer("total_tokens"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_cost_ledger_provider_run_idx").on(table.providerRunId),
    index("itotori_cost_ledger_project_kind_idx").on(table.projectId, table.costKind),
    index("itotori_cost_ledger_project_created_idx").on(table.projectId, table.createdAt),
  ],
);

export const findings = pgTable(
  "itotori_findings",
  {
    findingId: text("finding_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id").references(() => localeBranches.localeBranchId, {
      onDelete: "set null",
    }),
    findingKind: text("finding_kind").notNull(),
    severity: text("severity").notNull(),
    qualityCategory: text("quality_category"),
    title: text("title").notNull(),
    description: text("description").notNull(),
    impact: text("impact").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    reportedByTaskId: text("reported_by_task_id"),
    firstSeenEventId: text("first_seen_event_id").references(() => events.eventId, {
      onDelete: "set null",
    }),
    affectedRefs: jsonb("affected_refs").$type<unknown[]>().notNull(),
    evidence: jsonb("evidence").$type<unknown[]>().notNull(),
    provenance: jsonb("provenance").$type<unknown[]>().notNull(),
    causalLinks: jsonb("causal_links").$type<unknown[]>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_findings_project_branch_status_idx").on(
      table.projectId,
      table.localeBranchId,
      table.status,
    ),
    index("itotori_findings_project_severity_created_idx").on(
      table.projectId,
      table.severity,
      table.createdAt,
    ),
    index("itotori_findings_first_seen_event_idx").on(table.firstSeenEventId),
  ],
);

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

export const glossaryReviewItems = pgTable(
  "itotori_glossary_review_items",
  {
    reviewItemId: text("review_item_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    termId: text("term_id").references(() => terminologyTerms.termId, { onDelete: "set null" }),
    sourceRevisionId: text("source_revision_id")
      .notNull()
      .references(() => sourceRevisions.sourceRevisionId, { onDelete: "restrict" }),
    styleGuideVersionId: text("style_guide_version_id").references(
      () => styleGuideVersions.styleGuideVersionId,
      { onDelete: "set null" },
    ),
    glossaryReferenceId: text("glossary_reference_id").references(
      () => branchPolicyGlossaryReferences.referenceId,
      { onDelete: "set null" },
    ),
    state: text("state").notNull(),
    sourceTerm: text("source_term").notNull(),
    normalizedSourceTerm: text("normalized_source_term").notNull(),
    proposedTranslation: text("proposed_translation").notNull(),
    normalizedProposedTranslation: text("normalized_proposed_translation").notNull(),
    protectedSpanRefs: jsonb("protected_span_refs")
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    provenance: jsonb("provenance")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    semanticDiagnostics: jsonb("semantic_diagnostics")
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
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
    uniqueIndex("itotori_glossary_review_items_proposal_idx").on(
      table.localeBranchId,
      table.sourceRevisionId,
      table.normalizedSourceTerm,
      table.normalizedProposedTranslation,
    ),
    index("itotori_glossary_review_items_term_idx").on(table.termId, table.sourceRevisionId),
    index("itotori_glossary_review_items_queue_idx").on(
      table.localeBranchId,
      table.state,
      table.updatedAt,
    ),
    index("itotori_glossary_review_items_style_guide_idx").on(table.styleGuideVersionId),
    index("itotori_glossary_review_items_glossary_reference_idx").on(table.glossaryReferenceId),
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
    localeBranchId: text("locale_branch_id").references(() => localeBranches.localeBranchId, {
      onDelete: "set null",
    }),
    sourceBundleId: text("source_bundle_id").references(() => sourceBundles.sourceBundleId, {
      onDelete: "set null",
    }),
    bridgeUnitId: text("bridge_unit_id").references(() => sourceUnits.bridgeUnitId, {
      onDelete: "set null",
    }),
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
