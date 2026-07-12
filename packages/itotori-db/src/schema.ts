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

export const wikiBrandContextRoleValues = {
  base: "base",
  sequel: "sequel",
  fandisk: "fandisk",
  shared: "shared",
} as const;

export type WikiBrandContextRole =
  (typeof wikiBrandContextRoleValues)[keyof typeof wikiBrandContextRoleValues];

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

// ITOTORI-225 — narrowed from the legacy 5-value enum to the only two cost
// states the cost-tracking audit (docs/audits/openrouter-cost-tracking-
// audit-2026-06-25.md) considers correct: a real upstream charge, or no
// charge at all. Migration 0039 backfills + tightens the CHECK constraint.
//
// ITOTORI-134 — re-introduces `provider_estimate` as a narrowly-scoped
// deterministic cost-estimate state (derived from cost_details or
// endpoint-pricing × tokens) for responses where the authoritative
// `usage.cost` is absent. The TS type accepts it; the DB CHECK constraint
// (migration 0039) is a separate follow-up — provider-level tests use an
// in-memory recorder, so this widening is type-safe without a migration.
export const providerCostKindValues = {
  billed: "billed",
  provider_estimate: "provider_estimate",
  zero: "zero",
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
  unknown: "unknown",
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
  // Inert evidence: a recorded-importer-authored seed hint that is NOT yet
  // benchmark-selectable. Importer hints land here (CATALOG-080) and stay inert
  // until CATALOG-004 readiness filtering consumes them, records a readiness
  // explanation, and promotes them to a selectable status.
  inert: "inert",
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

export const exactSearchSourceArtifactTypeValues = {
  sourceUnit: "source_unit",
} as const;

export type ExactSearchSourceArtifactType =
  (typeof exactSearchSourceArtifactTypeValues)[keyof typeof exactSearchSourceArtifactTypeValues];

export const contextArtifactCategoryValues = {
  sceneSummary: "scene_summary",
  characterNote: "character_note",
  routeMap: "route_map",
  speakerLabel: "speaker_label",
  terminologyCandidate: "terminology_candidate",
} as const;

export type ContextArtifactCategory =
  (typeof contextArtifactCategoryValues)[keyof typeof contextArtifactCategoryValues];

export const contextArtifactStatusValues = {
  active: "active",
  stale: "stale",
  superseded: "superseded",
  rejected: "rejected",
} as const;

export type ContextArtifactStatus =
  (typeof contextArtifactStatusValues)[keyof typeof contextArtifactStatusValues];

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
    // ITOTORI-060: tombstone timestamp. NULL = active/current member of the
    // latest reimported bundle; non-NULL = the asset was omitted by a later
    // bridge reimport and archived (its rows + dependents are retained, not
    // hard-deleted). Reviving on re-add clears this back to NULL.
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (table) => [
    index("itotori_assets_project_kind_idx").on(table.projectId, table.assetKind),
    index("itotori_assets_bundle_key_idx").on(table.sourceBundleId, table.assetKey),
    index("itotori_assets_revision_idx").on(table.sourceRevisionId),
    index("itotori_assets_active_idx")
      .on(table.sourceBundleId)
      .where(sql`${table.removedAt} is null`),
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
    // ITOTORI-060: tombstone timestamp. NULL = active/current member of the
    // latest reimported bundle; non-NULL = the unit was omitted by a later
    // bridge reimport and archived. Tombstoning replaces the former
    // hard-DELETE so dependent locale-branch unit rows, runtime evidence refs,
    // TM reuse events and historical facts are PRESERVED (they keep pointing at
    // the retained, now-tombstoned unit). Reviving on re-add clears this back
    // to NULL rather than duplicating the row.
    removedAt: timestamp("removed_at", { withTimezone: true }),
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
    index("itotori_source_units_active_idx")
      .on(table.sourceBundleId)
      .where(sql`${table.removedAt} is null`),
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
    uniqueIndex("itotori_locale_branches_project_branch_unique_idx").on(
      table.projectId,
      table.localeBranchId,
    ),
    index("itotori_locale_branches_project_locale_idx").on(table.projectId, table.targetLocale),
    index("itotori_locale_branches_bundle_idx").on(table.sourceBundleId),
  ],
);

export const wikiBrandContexts = pgTable(
  "itotori_wiki_brand_contexts",
  {
    brandContextId: text("brand_context_id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.workspaceId, { onDelete: "cascade" }),
    contextKey: text("context_key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_wiki_brand_contexts_workspace_key_idx").on(
      table.workspaceId,
      table.contextKey,
    ),
    index("itotori_wiki_brand_contexts_workspace_name_idx").on(table.workspaceId, table.name),
  ],
);

export const wikiBrandContextMemberships = pgTable(
  "itotori_wiki_brand_context_memberships",
  {
    brandContextMembershipId: text("brand_context_membership_id").primaryKey(),
    brandContextId: text("brand_context_id")
      .notNull()
      .references(() => wikiBrandContexts.brandContextId, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    contextRole: text("context_role").$type<WikiBrandContextRole>().notNull(),
    inheritanceOrder: integer("inheritance_order").notNull().default(0),
    providesCharacterArcs: boolean("provides_character_arcs").notNull().default(true),
    providesGlossary: boolean("provides_glossary").notNull().default(true),
    providesContext: boolean("provides_context").notNull().default(true),
    inheritsCharacterArcs: boolean("inherits_character_arcs").notNull().default(true),
    inheritsGlossary: boolean("inherits_glossary").notNull().default(true),
    inheritsContext: boolean("inherits_context").notNull().default(true),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_wiki_brand_context_memberships_scope_idx").on(
      table.brandContextId,
      table.projectId,
      table.localeBranchId,
    ),
    index("itotori_wiki_brand_context_memberships_branch_idx").on(
      table.projectId,
      table.localeBranchId,
    ),
    index("itotori_wiki_brand_context_memberships_context_order_idx").on(
      table.brandContextId,
      table.inheritanceOrder,
      table.contextRole,
    ),
    foreignKey({
      columns: [table.projectId, table.localeBranchId],
      foreignColumns: [localeBranches.projectId, localeBranches.localeBranchId],
      name: "itotori_wiki_brand_context_memberships_branch_fk",
    }).onDelete("cascade"),
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
    // ITOTORI-122: target key for the version -> guide scope composite FK.
    unique("itotori_style_guides_scope_key").on(
      table.styleGuideId,
      table.projectId,
      table.localeBranchId,
    ),
    // ITOTORI-122: latest_version_id and approved_version_id are guarded by
    // composite FKs onto itotori_style_guide_versions
    // (<pointer>, style_guide_id, project_id, locale_branch_id), so each pointer
    // must resolve to an EXISTING version in the SAME guide + project +
    // locale-branch (rejects dangling AND cross-project / cross-locale-branch).
    // Those FKs live in migration 0053 only: declaring them here would pair with
    // the version table's own style_guide_id FK back to this table to form a
    // mutually-recursive table type TypeScript cannot infer. The DB constraint
    // is the source of truth and is asserted by the migration-drift test.
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
    // ITOTORI-122: target key for the pointer composite FKs (latest/approved on
    // the guide + previous on this table). Trivially unique via the PK.
    unique("itotori_style_guide_versions_scope_key").on(
      table.styleGuideVersionId,
      table.styleGuideId,
      table.projectId,
      table.localeBranchId,
    ),
    // ITOTORI-122: a version's (project, locale-branch) MUST match its guide's.
    // This composite FK (style_guide_id, project_id, locale_branch_id) ->
    // itotori_style_guides is enforced in migration 0053; it is intentionally
    // NOT declared here because pairing it with the guide's latest/approved
    // composite FKs (which reference THIS table) forms a mutually-recursive
    // table type that TypeScript cannot infer. The DB constraint is the source
    // of truth; the acceptance-critical pointer FKs below stay in the model.
    // ITOTORI-122: previous_version_id must reference an existing (prior)
    // version in the SAME guide + project + locale-branch (self-referential).
    foreignKey({
      columns: [table.previousVersionId, table.styleGuideId, table.projectId, table.localeBranchId],
      foreignColumns: [
        table.styleGuideVersionId,
        table.styleGuideId,
        table.projectId,
        table.localeBranchId,
      ],
      name: "itotori_style_guide_versions_previous_version_scope_fkey",
    }),
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
    eventId: text("event_id").references(() => events.eventId, { onDelete: "set null" }),
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
    // ITOTORI-140: bring the Drizzle metadata into parity with migration 0022.
    // These check constraints are the source-of-truth runtime guards documented
    // in the SQL; modeling them here keeps schema-drift introspection honest. A
    // regression test (branch-policy-glossary-references-migration-drift) pins
    // the round-trip between this declaration and pg_constraint.
    check("itotori_branch_policy_glossary_refs_sequence_check", sql`${table.versionSequence} > 0`),
    check(
      "itotori_branch_policy_glossary_refs_term_refs_check",
      sql`jsonb_typeof(${table.glossaryTermRefs}) = 'array'`,
    ),
    check(
      "itotori_branch_policy_glossary_refs_review_refs_check",
      sql`jsonb_typeof(${table.glossaryReviewItemRefs}) = 'array'`,
    ),
    check(
      "itotori_branch_policy_glossary_refs_metadata_check",
      sql`jsonb_typeof(${table.metadata}) = 'object'`,
    ),
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
    // ITOTORI-145: keep Drizzle parity with migration 0063. The status enum
    // (reusable|blocked) and the jsonb object shape of provenance are
    // enforced at the DB; modeling the CHECK guards here keeps schema-drift
    // introspection honest.
    check("itotori_tm_segments_status_check", sql`${table.status} in ('reusable', 'blocked')`),
    check(
      "itotori_tm_segments_provenance_check",
      sql`jsonb_typeof(${table.provenance}) = 'object'`,
    ),
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

export const exactSearchDocuments = pgTable(
  "itotori_exact_search_documents",
  {
    searchDocumentId: text("search_document_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    sourceRevisionId: text("source_revision_id")
      .notNull()
      .references(() => sourceRevisions.sourceRevisionId, { onDelete: "restrict" }),
    sourceArtifactType: text("source_artifact_type").notNull(),
    sourceArtifactId: text("source_artifact_id")
      .notNull()
      .references(() => sourceUnits.bridgeUnitId, { onDelete: "cascade" }),
    exactTerm: text("exact_term").notNull(),
    normalizedExactTerm: text("normalized_exact_term").notNull(),
    sourceLocale: text("source_locale").notNull(),
    targetLocale: text("target_locale").notNull(),
    provenance: jsonb("provenance")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    refreshedAt: timestamp("refreshed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_exact_search_docs_source_term_idx").on(
      table.localeBranchId,
      table.sourceRevisionId,
      table.sourceArtifactType,
      table.sourceArtifactId,
      table.normalizedExactTerm,
    ),
    index("itotori_exact_search_docs_lookup_idx").on(
      table.localeBranchId,
      table.sourceRevisionId,
      table.normalizedExactTerm,
      table.sourceArtifactType,
    ),
    index("itotori_exact_search_docs_project_branch_idx").on(
      table.projectId,
      table.localeBranchId,
      table.sourceRevisionId,
    ),
  ],
);

export const contextArtifacts = pgTable(
  "itotori_context_artifacts",
  {
    contextArtifactId: text("context_artifact_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    sourceRevisionId: text("source_revision_id")
      .notNull()
      .references(() => sourceRevisions.sourceRevisionId, { onDelete: "restrict" }),
    category: text("category").notNull(),
    status: text("status").notNull().default(contextArtifactStatusValues.active),
    title: text("title").notNull(),
    normalizedTitle: text("normalized_title").notNull(),
    body: text("body").notNull(),
    data: jsonb("data")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    contentHash: text("content_hash").notNull(),
    producedByAgent: text("produced_by_agent"),
    producedByTool: text("produced_by_tool"),
    producerVersion: text("producer_version").notNull(),
    provenance: jsonb("provenance")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    invalidatedReason: text("invalidated_reason"),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id").references(() => users.userId, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_context_artifacts_branch_lookup_idx").on(
      table.projectId,
      table.localeBranchId,
      table.sourceRevisionId,
      table.category,
      table.status,
    ),
    index("itotori_context_artifacts_title_idx").on(table.localeBranchId, table.normalizedTitle),
    index("itotori_context_artifacts_content_hash_idx").on(
      table.localeBranchId,
      table.category,
      table.contentHash,
    ),
  ],
);

export const contextArtifactSourceUnits = pgTable(
  "itotori_context_artifact_source_units",
  {
    contextArtifactId: text("context_artifact_id")
      .notNull()
      .references(() => contextArtifacts.contextArtifactId, { onDelete: "cascade" }),
    bridgeUnitId: text("bridge_unit_id").notNull(),
    sourceRevisionId: text("source_revision_id")
      .notNull()
      .references(() => sourceRevisions.sourceRevisionId, { onDelete: "restrict" }),
    sourceHash: text("source_hash").notNull(),
    citation: text("citation").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.contextArtifactId, table.bridgeUnitId] }),
    index("itotori_context_artifact_source_units_unit_idx").on(
      table.bridgeUnitId,
      table.sourceRevisionId,
      table.sourceHash,
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
    // ITOTORI-145: mirror migration 0063's CHECK constraints on the reuse
    // events table so schema-drift introspection reflects runtime DB
    // enforcement: enum-like match_kind / reuse_status allowed values,
    // normalized 0..1000 match_score range, and the jsonb object shape of
    // provenance + cost_impact.
    check(
      "itotori_tm_reuse_events_match_kind_check",
      sql`${table.matchKind} in ('exact', 'fuzzy')`,
    ),
    check(
      "itotori_tm_reuse_events_match_score_check",
      sql`${table.matchScore} >= 0 and ${table.matchScore} <= 1000`,
    ),
    check(
      "itotori_tm_reuse_events_reuse_status_check",
      sql`${table.reuseStatus} in ('suggested', 'applied')`,
    ),
    check(
      "itotori_tm_reuse_events_provenance_check",
      sql`jsonb_typeof(${table.provenance}) = 'object'`,
    ),
    check(
      "itotori_tm_reuse_events_cost_impact_check",
      sql`jsonb_typeof(${table.costImpact}) = 'object'`,
    ),
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
    dependsOnJobIds: jsonb("depends_on_job_ids")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
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
      table.priority.desc(),
      table.createdAt,
    ),
    index("itotori_jobs_project_type_status_idx").on(table.projectId, table.jobType, table.status),
    index("itotori_jobs_trigger_outbox_event_idx").on(table.triggerOutboxEventId),
    index("itotori_jobs_source_event_idx").on(table.sourceEventId),
    index("itotori_jobs_correlation_idx").on(table.correlationId),
    index("itotori_jobs_depends_on_job_ids_gin_idx").using("gin", table.dependsOnJobIds),
  ],
);

// ITOTORI-045 — append-only audit trail for the job-queue lifecycle. One
// immutable row is written by the `itotori_job_events_capture` DB trigger for
// every genuine `itotori_jobs.status` transition (or insert), so the queue's
// history cannot be silently rewritten. See migration 0052 for the capture +
// append-only triggers and the retention policy enforced by pruneJobEvents().
export const jobEventTypeValues = {
  enqueued: "enqueued",
  claimed: "claimed",
  succeeded: "succeeded",
  retryScheduled: "retry_scheduled",
  deadLettered: "dead_lettered",
  cancelled: "cancelled",
  requeued: "requeued",
} as const;

export type JobEventType = (typeof jobEventTypeValues)[keyof typeof jobEventTypeValues];

export const jobEvents = pgTable(
  "itotori_job_events",
  {
    jobEventId: text("job_event_id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobQueue.jobId, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id").references(() => localeBranches.localeBranchId, {
      onDelete: "set null",
    }),
    queueName: text("queue_name").notNull(),
    eventType: text("event_type").$type<JobEventType>().notNull(),
    priorStatus: text("prior_status").$type<JobStatus>(),
    nextStatus: text("next_status").$type<JobStatus>().notNull(),
    attemptCount: integer("attempt_count").notNull(),
    workerId: text("worker_id"),
    correlationId: text("correlation_id").notNull(),
    detail: jsonb("detail")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_job_events_job_time_idx").on(table.jobId, table.recordedAt),
    index("itotori_job_events_project_time_idx").on(table.projectId, table.recordedAt),
    index("itotori_job_events_status_time_idx").on(table.nextStatus, table.recordedAt),
  ],
);

export const modelProviders = pgTable(
  "itotori_model_providers",
  {
    providerId: text("provider_id").primaryKey(),
    providerFamily: text("provider_family").notNull(),
    endpointFamily: text("endpoint_family").notNull(),
    providerName: text("provider_name").notNull(),
    // ITOTORI-230 — dropped `data_handling` and `account_privacy` jsonb
    // columns left over from the per-pair privacy registry that
    // ITOTORI-227 deleted. The canonical privacy posture is now
    // account-wide ZDR + per-request `provider.zdr=true`; the
    // routing-posture jsonb on `itotori_provider_runs` is the auditable
    // record of (b) per call.
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

export const modelRoutingSettings = pgTable(
  "itotori_model_routing_settings",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    taskKind: text("task_kind").notNull(),
    providerId: text("provider_id")
      .notNull()
      .references(() => modelProviders.providerId, { onDelete: "restrict" }),
    modelRegistryId: text("model_registry_id")
      .notNull()
      .references(() => modelRegistry.modelRegistryId, { onDelete: "restrict" }),
    modelId: text("model_id").notNull(),
    fallbackModelIds: jsonb("fallback_model_ids").$type<string[]>().notNull().default([]),
    promptPresetId: text("prompt_preset_id").notNull(),
    promptTemplateVersion: text("prompt_template_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.taskKind] }),
    index("itotori_model_routing_settings_project_idx").on(table.projectId),
    foreignKey({
      columns: [table.promptPresetId, table.promptTemplateVersion],
      foreignColumns: [promptPresets.promptPresetId, promptPresets.promptTemplateVersion],
      name: "itotori_model_routing_settings_prompt_preset_fk",
    }),
  ],
);

// itotori-translation-scope-settings — config-driven translation scope
// (dialogue-only -> dialogue-and-choices -> dialogue-choices-ui -> all), one
// row per locale branch. This is the DB-backed default the whole-project
// localize command (`runLocalizeFullProjectCommand`) consults when its run
// config JSON omits `translationScope` — see
// `apps/itotori/src/orchestrator/localize-fullproject-command.ts`.
export const translationScopeSettings = pgTable(
  "itotori_translation_scope_settings",
  {
    localeBranchId: text("locale_branch_id")
      .primaryKey()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("itotori_translation_scope_settings_project_idx").on(table.projectId)],
);

// p3-wire-localization-pass-run-config-registry — one operator-local whole-
// project run configuration per project/locale branch. The paths are local
// references only; game bytes never enter this table or a published artifact.
export const localizationPassRunConfigs = pgTable(
  "itotori_localization_pass_run_configs",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    configPath: text("config_path").notNull(),
    dataRoot: text("data_root").notNull(),
    pairPolicyPath: text("pair_policy_path").notNull(),
    modelId: text("model_id").notNull(),
    providerId: text("provider_id").notNull(),
    runDir: text("run_dir").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.localeBranchId] }),
    index("itotori_localization_pass_run_configs_branch_idx").on(table.localeBranchId),
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
    // ITOTORI-230 — captured OpenRouter routing posture for THIS run.
    // Required (non-null) post-migration; pre-migration rows carry the
    // sentinel `{"_pre_itotori_230": true}` jsonb so they cannot be
    // mistaken for a real captured posture by telemetry queries that
    // filter on `routing_posture->>'zdr' = 'true'`. The corresponding
    // application type is `OpenRouterRoutingPosture` (providers/types.ts).
    routingPosture: jsonb("routing_posture").$type<Record<string, unknown>>().notNull(),
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

export type TranslationBatchContextRefInclusionReason =
  (typeof translationBatchContextRefInclusionReasonValues)[keyof typeof translationBatchContextRefInclusionReasonValues];

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
     * ITOTORI-220 — required pinned providerId per the (modelId,
     * providerId) pair rule. The planner pins both halves of the pair on
     * `batch.modelProfile`; persisting only the model half dropped the
     * provider provenance the downstream draft agent reads back. NOT NULL
     * with NO sentinel default — a batch must carry its real provider, or
     * the insert fails loud (migration 0047 deletes pre-fix rows that
     * never captured it rather than backfilling a fake provider).
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

export const sceneSummaryStatusValues = {
  fresh: "Fresh",
  stale: "Stale",
} as const;

export type SceneSummaryStatus =
  (typeof sceneSummaryStatusValues)[keyof typeof sceneSummaryStatusValues];

export const sceneSummaryInvalidatedReasonValues = {
  sourceHashDrift: "source_hash_drift",
  templateVersionBump: "template_version_bump",
  manual: "manual",
} as const;

export type SceneSummaryInvalidatedReason =
  (typeof sceneSummaryInvalidatedReasonValues)[keyof typeof sceneSummaryInvalidatedReasonValues];

export const sceneSummaries = pgTable(
  "itotori_scene_summaries",
  {
    sceneSummaryId: text("scene_summary_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    sourceRevisionId: text("source_revision_id")
      .notNull()
      .references(() => sourceRevisions.sourceRevisionId, { onDelete: "restrict" }),
    sceneId: text("scene_id").notNull(),
    summaryLocale: text("summary_locale").notNull(),
    summaryText: text("summary_text").notNull(),
    modelProviderFamily: text("model_provider_family").notNull(),
    modelId: text("model_id").notNull(),
    modelContextWindowTokens: integer("model_context_window_tokens").notNull(),
    modelMaxOutputTokens: integer("model_max_output_tokens"),
    promptTemplateVersion: text("prompt_template_version").notNull(),
    promptHash: text("prompt_hash").notNull(),
    inputTokenEstimate: integer("input_token_estimate").notNull(),
    completionTokens: integer("completion_tokens").notNull(),
    status: text("status").notNull(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidatedReason: text("invalidated_reason"),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_scene_summaries_unique_idx").on(
      table.projectId,
      table.localeBranchId,
      table.sourceRevisionId,
      table.sceneId,
      table.promptTemplateVersion,
    ),
    index("itotori_scene_summaries_status_idx").on(
      table.projectId,
      table.localeBranchId,
      table.sourceRevisionId,
      table.status,
    ),
    index("itotori_scene_summaries_scene_idx").on(table.sceneId),
  ],
);

export const sceneSummaryCitedUnits = pgTable(
  "itotori_scene_summary_cited_units",
  {
    sceneSummaryId: text("scene_summary_id")
      .notNull()
      .references(() => sceneSummaries.sceneSummaryId, { onDelete: "cascade" }),
    bridgeUnitId: text("bridge_unit_id").notNull(),
    citedSourceHash: text("cited_source_hash").notNull(),
    citeOrdinal: integer("cite_ordinal").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.sceneSummaryId, table.bridgeUnitId] }),
    index("itotori_scene_summary_cited_units_bridge_unit_idx").on(
      table.bridgeUnitId,
      table.citedSourceHash,
    ),
    index("itotori_scene_summary_cited_units_ordinal_idx").on(
      table.sceneSummaryId,
      table.citeOrdinal,
    ),
  ],
);

// KAIFUU-053: capability-leveled engine detector registry persistence.
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

// ITOTORI-014: character relationship agent persistence.
//
// Three tables back the character bio + relationship pack a project owns at
// a given (project, locale branch, source revision, prompt template) tuple.
// The bio and relationship tables share lifecycle semantics with
// itotori_scene_summaries: a Fresh row is the latest valid artifact; a Stale
// row records the prior state for audit after a source-hash drift or
// template-version bump invalidates it.

export const characterBioStatusValues = {
  fresh: "Fresh",
  stale: "Stale",
} as const;

export type CharacterBioStatus =
  (typeof characterBioStatusValues)[keyof typeof characterBioStatusValues];

export const characterRelationshipStatusValues = {
  fresh: "Fresh",
  stale: "Stale",
} as const;

export type CharacterRelationshipStatus =
  (typeof characterRelationshipStatusValues)[keyof typeof characterRelationshipStatusValues];

export const characterRelationshipInvalidatedReasonValues = {
  sourceHashDrift: "source_hash_drift",
  templateVersionBump: "template_version_bump",
  manual: "manual",
} as const;

export type CharacterRelationshipInvalidatedReason =
  (typeof characterRelationshipInvalidatedReasonValues)[keyof typeof characterRelationshipInvalidatedReasonValues];

export const characterRelationshipKindValues = {
  familyRelation: "FamilyRelation",
  romantic: "Romantic",
  friendship: "Friendship",
  mentor: "Mentor",
  rivalry: "Rivalry",
  allegiance: "Allegiance",
  antagonism: "Antagonism",
  other: "Other",
} as const;

export type CharacterRelationshipKind =
  (typeof characterRelationshipKindValues)[keyof typeof characterRelationshipKindValues];

export const characterRelationshipDirectionValues = {
  symmetric: "Symmetric",
  fromAToB: "FromAToB",
} as const;

export type CharacterRelationshipDirection =
  (typeof characterRelationshipDirectionValues)[keyof typeof characterRelationshipDirectionValues];

export const characterBios = pgTable(
  "itotori_character_bios",
  {
    characterBioId: text("character_bio_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    sourceRevisionId: text("source_revision_id")
      .notNull()
      .references(() => sourceRevisions.sourceRevisionId, { onDelete: "restrict" }),
    characterId: text("character_id").notNull(),
    bioLocale: text("bio_locale").notNull(),
    bioText: text("bio_text").notNull(),
    modelProviderFamily: text("model_provider_family").notNull(),
    modelId: text("model_id").notNull(),
    modelContextWindowTokens: integer("model_context_window_tokens").notNull(),
    modelMaxOutputTokens: integer("model_max_output_tokens"),
    promptTemplateVersion: text("prompt_template_version").notNull(),
    promptHash: text("prompt_hash").notNull(),
    inputTokenEstimate: integer("input_token_estimate").notNull(),
    completionTokens: integer("completion_tokens").notNull(),
    status: text("status").notNull(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidatedReason: text("invalidated_reason"),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_character_bios_unique_idx").on(
      table.projectId,
      table.localeBranchId,
      table.sourceRevisionId,
      table.characterId,
      table.promptTemplateVersion,
    ),
    index("itotori_character_bios_status_idx").on(
      table.projectId,
      table.localeBranchId,
      table.sourceRevisionId,
      table.status,
    ),
    index("itotori_character_bios_character_idx").on(table.characterId),
  ],
);

export const characterBioEvidence = pgTable(
  "itotori_character_bio_evidence",
  {
    characterBioId: text("character_bio_id")
      .notNull()
      .references(() => characterBios.characterBioId, { onDelete: "cascade" }),
    bridgeUnitId: text("bridge_unit_id").notNull(),
    citedSourceHash: text("cited_source_hash").notNull(),
    citeOrdinal: integer("cite_ordinal").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.characterBioId, table.bridgeUnitId] }),
    index("itotori_character_bio_evidence_bridge_unit_idx").on(
      table.bridgeUnitId,
      table.citedSourceHash,
    ),
    index("itotori_character_bio_evidence_ordinal_idx").on(table.characterBioId, table.citeOrdinal),
  ],
);

export const characterRelationships = pgTable(
  "itotori_character_relationships",
  {
    characterRelationshipId: text("character_relationship_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    sourceRevisionId: text("source_revision_id")
      .notNull()
      .references(() => sourceRevisions.sourceRevisionId, { onDelete: "restrict" }),
    fromCharacterId: text("from_character_id").notNull(),
    toCharacterId: text("to_character_id").notNull(),
    kind: text("kind").$type<CharacterRelationshipKind>().notNull(),
    direction: text("direction").$type<CharacterRelationshipDirection>().notNull(),
    descriptor: text("descriptor").notNull(),
    descriptorLocale: text("descriptor_locale").notNull(),
    modelProviderFamily: text("model_provider_family").notNull(),
    modelId: text("model_id").notNull(),
    modelContextWindowTokens: integer("model_context_window_tokens").notNull(),
    modelMaxOutputTokens: integer("model_max_output_tokens"),
    promptTemplateVersion: text("prompt_template_version").notNull(),
    promptHash: text("prompt_hash").notNull(),
    status: text("status").notNull(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidatedReason: text("invalidated_reason"),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_character_relationships_unique_idx").on(
      table.projectId,
      table.localeBranchId,
      table.sourceRevisionId,
      table.fromCharacterId,
      table.toCharacterId,
      table.kind,
      table.promptTemplateVersion,
    ),
    index("itotori_character_relationships_status_idx").on(
      table.projectId,
      table.localeBranchId,
      table.sourceRevisionId,
      table.status,
    ),
    index("itotori_character_relationships_from_idx").on(table.fromCharacterId),
    index("itotori_character_relationships_to_idx").on(table.toCharacterId),
  ],
);

export const characterRelationshipEvidence = pgTable(
  "itotori_character_relationship_evidence",
  {
    characterRelationshipId: text("character_relationship_id")
      .notNull()
      .references(() => characterRelationships.characterRelationshipId, {
        onDelete: "cascade",
      }),
    bridgeUnitId: text("bridge_unit_id").notNull(),
    citedSourceHash: text("cited_source_hash").notNull(),
    citeOrdinal: integer("cite_ordinal").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.characterRelationshipId, table.bridgeUnitId] }),
    index("itotori_character_relationship_evidence_bridge_unit_idx").on(
      table.bridgeUnitId,
      table.citedSourceHash,
    ),
    index("itotori_character_relationship_evidence_ordinal_idx").on(
      table.characterRelationshipId,
      table.citeOrdinal,
    ),
  ],
);

// ---------------------------------------------------------------------
// ITOTORI-015 — route + choice map agent
// ---------------------------------------------------------------------

export const routeMapStatusValues = {
  fresh: "Fresh",
  stale: "Stale",
} as const;

export type RouteMapStatus = (typeof routeMapStatusValues)[keyof typeof routeMapStatusValues];

export const routeChoiceStatusValues = {
  fresh: "Fresh",
  stale: "Stale",
} as const;

export type RouteChoiceStatus =
  (typeof routeChoiceStatusValues)[keyof typeof routeChoiceStatusValues];

export const routeInvalidatedReasonValues = {
  sourceHashDrift: "source_hash_drift",
  templateVersionBump: "template_version_bump",
  unknownRouteTarget: "unknown_route_target",
  manual: "manual",
} as const;

export type RouteInvalidatedReason =
  (typeof routeInvalidatedReasonValues)[keyof typeof routeInvalidatedReasonValues];

export const routeChoiceKindValues = {
  routeBranch: "RouteBranch",
  flagToggle: "FlagToggle",
  sceneSelector: "SceneSelector",
  cosmetic: "Cosmetic",
  other: "Other",
} as const;

export type RouteChoiceKind = (typeof routeChoiceKindValues)[keyof typeof routeChoiceKindValues];

export const routeEvidenceSubjectKindValues = {
  route: "route",
  choice: "choice",
  choiceOption: "choice_option",
} as const;

export type RouteEvidenceSubjectKind =
  (typeof routeEvidenceSubjectKindValues)[keyof typeof routeEvidenceSubjectKindValues];

export const routeMaps = pgTable(
  "itotori_route_maps",
  {
    routeMapId: text("route_map_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    sourceRevisionId: text("source_revision_id")
      .notNull()
      .references(() => sourceRevisions.sourceRevisionId, { onDelete: "restrict" }),
    routeKey: text("route_key").notNull(),
    routeTitle: text("route_title").notNull(),
    mapLocale: text("map_locale").notNull(),
    routeSummary: text("route_summary").notNull(),
    modelProviderFamily: text("model_provider_family").notNull(),
    modelId: text("model_id").notNull(),
    modelContextWindowTokens: integer("model_context_window_tokens").notNull(),
    modelMaxOutputTokens: integer("model_max_output_tokens"),
    promptTemplateVersion: text("prompt_template_version").notNull(),
    promptHash: text("prompt_hash").notNull(),
    inputTokenEstimate: integer("input_token_estimate").notNull(),
    completionTokens: integer("completion_tokens").notNull(),
    status: text("status").notNull(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidatedReason: text("invalidated_reason"),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_route_maps_unique_idx").on(
      table.projectId,
      table.localeBranchId,
      table.sourceRevisionId,
      table.routeKey,
      table.promptTemplateVersion,
    ),
    index("itotori_route_maps_status_idx").on(
      table.projectId,
      table.localeBranchId,
      table.sourceRevisionId,
      table.status,
    ),
    index("itotori_route_maps_route_key_idx").on(table.routeKey),
  ],
);

export const routeChoices = pgTable(
  "itotori_route_choices",
  {
    routeChoiceId: text("route_choice_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    sourceRevisionId: text("source_revision_id")
      .notNull()
      .references(() => sourceRevisions.sourceRevisionId, { onDelete: "restrict" }),
    choiceKey: text("choice_key").notNull(),
    kind: text("kind").$type<RouteChoiceKind>().notNull(),
    fromRouteKey: text("from_route_key"),
    promptSummary: text("prompt_summary").notNull(),
    mapLocale: text("map_locale").notNull(),
    options: jsonb("options").notNull(),
    modelProviderFamily: text("model_provider_family").notNull(),
    modelId: text("model_id").notNull(),
    modelContextWindowTokens: integer("model_context_window_tokens").notNull(),
    modelMaxOutputTokens: integer("model_max_output_tokens"),
    promptTemplateVersion: text("prompt_template_version").notNull(),
    promptHash: text("prompt_hash").notNull(),
    status: text("status").notNull(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidatedReason: text("invalidated_reason"),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_route_choices_unique_idx").on(
      table.projectId,
      table.localeBranchId,
      table.sourceRevisionId,
      table.choiceKey,
      table.promptTemplateVersion,
    ),
    index("itotori_route_choices_status_idx").on(
      table.projectId,
      table.localeBranchId,
      table.sourceRevisionId,
      table.status,
    ),
    index("itotori_route_choices_choice_key_idx").on(table.choiceKey),
    index("itotori_route_choices_from_route_key_idx").on(table.fromRouteKey),
  ],
);

export const routeEvidence = pgTable(
  "itotori_route_evidence",
  {
    routeEvidenceId: text("route_evidence_id").primaryKey(),
    subjectKind: text("subject_kind").$type<RouteEvidenceSubjectKind>().notNull(),
    routeMapId: text("route_map_id").references(() => routeMaps.routeMapId, {
      onDelete: "cascade",
    }),
    routeChoiceId: text("route_choice_id").references(() => routeChoices.routeChoiceId, {
      onDelete: "cascade",
    }),
    choiceOptionId: text("choice_option_id"),
    bridgeUnitId: text("bridge_unit_id").notNull(),
    citedSourceHash: text("cited_source_hash").notNull(),
    citeOrdinal: integer("cite_ordinal").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_route_evidence_by_route_idx").on(table.routeMapId, table.bridgeUnitId),
    index("itotori_route_evidence_by_choice_idx").on(table.routeChoiceId, table.bridgeUnitId),
    index("itotori_route_evidence_bridge_unit_idx").on(table.bridgeUnitId, table.citedSourceHash),
  ],
);

// ---------------------------------------------------------------------
// ITOTORI-016 — terminology candidate agent
// ---------------------------------------------------------------------

export const terminologyCandidateStatusValues = {
  fresh: "Fresh",
  stale: "Stale",
  promoted: "Promoted",
  rejectedByReviewer: "RejectedByReviewer",
} as const;

export type TerminologyCandidateStatus =
  (typeof terminologyCandidateStatusValues)[keyof typeof terminologyCandidateStatusValues];

export const terminologyCandidateInvalidatedReasonValues = {
  sourceHashDrift: "source_hash_drift",
  templateVersionBump: "template_version_bump",
  glossaryConflictPostPersist: "glossary_conflict_post_persist",
  manual: "manual",
} as const;

export type TerminologyCandidateInvalidatedReason =
  (typeof terminologyCandidateInvalidatedReasonValues)[keyof typeof terminologyCandidateInvalidatedReasonValues];

export const terminologyCandidateKindValues = {
  properNoun: "ProperNoun",
  titleOrHonorific: "TitleOrHonorific",
  technicalTerm: "TechnicalTerm",
  catchphrase: "Catchphrase",
  soundEffect: "SoundEffect",
  writtenSign: "WrittenSign",
  other: "Other",
} as const;

export type TerminologyCandidateKind =
  (typeof terminologyCandidateKindValues)[keyof typeof terminologyCandidateKindValues];

export const terminologyCandidates = pgTable(
  "itotori_terminology_candidates",
  {
    terminologyCandidateId: text("terminology_candidate_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    sourceRevisionId: text("source_revision_id")
      .notNull()
      .references(() => sourceRevisions.sourceRevisionId, { onDelete: "restrict" }),
    kind: text("kind").$type<TerminologyCandidateKind>().notNull(),
    surfaceForm: text("surface_form").notNull(),
    surfaceLocale: text("surface_locale").notNull(),
    rationale: text("rationale").notNull(),
    readingHint: text("reading_hint"),
    conflictingTerminologyTermId: text("conflicting_terminology_term_id").references(
      () => terminologyTerms.termId,
      { onDelete: "set null" },
    ),
    modelProviderFamily: text("model_provider_family").notNull(),
    modelId: text("model_id").notNull(),
    modelContextWindowTokens: integer("model_context_window_tokens").notNull(),
    modelMaxOutputTokens: integer("model_max_output_tokens"),
    promptTemplateVersion: text("prompt_template_version").notNull(),
    promptHash: text("prompt_hash").notNull(),
    inputTokenEstimate: integer("input_token_estimate").notNull(),
    completionTokens: integer("completion_tokens").notNull(),
    status: text("status").notNull(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidatedReason: text("invalidated_reason"),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_terminology_candidates_unique_idx").on(
      table.projectId,
      table.localeBranchId,
      table.sourceRevisionId,
      table.surfaceForm,
      table.kind,
      table.promptTemplateVersion,
    ),
    index("itotori_terminology_candidates_status_idx").on(
      table.projectId,
      table.localeBranchId,
      table.sourceRevisionId,
      table.status,
    ),
    index("itotori_terminology_candidates_surface_idx").on(table.surfaceForm),
  ],
);

export const terminologyCandidateEvidence = pgTable(
  "itotori_terminology_candidate_evidence",
  {
    terminologyCandidateId: text("terminology_candidate_id")
      .notNull()
      .references(() => terminologyCandidates.terminologyCandidateId, { onDelete: "cascade" }),
    bridgeUnitId: text("bridge_unit_id").notNull(),
    citedSourceHash: text("cited_source_hash").notNull(),
    citeOrdinal: integer("cite_ordinal").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.terminologyCandidateId, table.bridgeUnitId] }),
    index("itotori_terminology_candidate_evidence_bridge_unit_idx").on(
      table.bridgeUnitId,
      table.citedSourceHash,
    ),
    index("itotori_terminology_candidate_evidence_ordinal_idx").on(
      table.terminologyCandidateId,
      table.citeOrdinal,
    ),
  ],
);

// ---------------------------------------------------------------------
// ITOTORI-074 — draft job schema (jobs + attempts)
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
// ITOTORI-035 — asset localization decision workflow
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

export const auditFindings = pgTable(
  "itotori_audit_findings",
  {
    auditFindingId: text("audit_finding_id").primaryKey(),
    auditReportId: text("audit_report_id").notNull(),
    nodeId: text("node_id").notNull(),
    severity: text("severity").$type<AuditFindingSeverity>().notNull(),
    category: text("category").notNull(),
    summary: text("summary").notNull(),
    detail: text("detail"),
    fileRef: text("file_ref"),
    proposedDagNode: text("proposed_dag_node"),
    status: text("status").$type<AuditFindingStatus>().notNull().default("open"),
    supersededByFindingId: text("superseded_by_finding_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.supersededByFindingId],
      foreignColumns: [table.auditFindingId],
      name: "itotori_audit_findings_superseded_by_fkey",
    }),
    index("itotori_audit_findings_node_status_severity_idx").on(
      table.nodeId,
      table.status,
      table.severity,
    ),
    index("itotori_audit_findings_report_idx").on(table.auditReportId),
    index("itotori_audit_findings_severity_status_idx").on(table.severity, table.status),
  ],
);

// ---------------------------------------------------------------------
// ITOTORI-081 — reviewer queue action API + state machine
// ---------------------------------------------------------------------

/**
 * Closed enum of reviewer-queue item kinds. Mirrors the SQL check
 * constraint on `itotori_reviewer_queue_items.item_kind`. Adding a kind
 * requires (1) a SQL migration that replaces the check constraint and
 * (2) a routing rule in the reviewer-queue action service so the new
 * kind dispatches to a typed action.
 */
export const reviewerQueueItemKindValues = {
  qa: "qa",
  style: "style",
  glossary: "glossary",
  feedback: "feedback",
  runtimeEvidence: "runtime_evidence",
} as const;

export type ReviewerQueueItemKind =
  (typeof reviewerQueueItemKindValues)[keyof typeof reviewerQueueItemKindValues];

/**
 * Closed enum of reviewer-queue item states. Mirrors the SQL check
 * constraint on `itotori_reviewer_queue_items.state` and the prior /
 * next state constraints on `itotori_reviewer_queue_transitions`.
 *
 * Terminal states (`accepted`, `rejected`) require `resolvedAt`; the
 * `itotori_reviewer_queue_items_resolved_state_consistent` check guards
 * that invariant at the database level.
 */
export const reviewerQueueItemStateValues = {
  pending: "pending",
  inReview: "in_review",
  accepted: "accepted",
  rejected: "rejected",
  repairRequested: "repair_requested",
  deferred: "deferred",
  escalated: "escalated",
} as const;

export type ReviewerQueueItemState =
  (typeof reviewerQueueItemStateValues)[keyof typeof reviewerQueueItemStateValues];

/**
 * Closed enum of reviewer-queue actions. Each maps 1:1 to a typed entry
 * on the action API (`approve`, `reject`, `requestRepair`,
 * `updateGlossary`, `updateStyle`, `importRuntimeFeedback`).
 */
export const reviewerQueueActionValues = {
  approve: "approve",
  reject: "reject",
  defer: "defer",
  escalate: "escalate",
  requestRepair: "request_repair",
  updateGlossary: "update_glossary",
  updateStyle: "update_style",
  importRuntimeFeedback: "import_runtime_feedback",
} as const;

export type ReviewerQueueAction =
  (typeof reviewerQueueActionValues)[keyof typeof reviewerQueueActionValues];

/**
 * Persisted shape of a reviewer-queue item row. Runtime-evidence rows
 * carry `evidenceTier`, `observationEventIds`, and `artifactHashes` per
 * the SQL discriminant; every other kind has those three fields = null.
 */
export type ReviewerQueueItemRecord = {
  reviewItemId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  itemKind: ReviewerQueueItemKind;
  sourceItemRef: string;
  state: ReviewerQueueItemState;
  priority: number;
  summary: string;
  affectedArtifactIds: string[];
  evidenceTier: string | null;
  observationEventIds: string[] | null;
  artifactHashes: string[] | null;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdByUserId: string | null;
  assignedToUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
};

/**
 * Persisted shape of one append-only transition log row.
 */
export type ReviewerQueueTransitionRecord = {
  transitionId: string;
  reviewItemId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  itemKind: ReviewerQueueItemKind;
  action: ReviewerQueueAction;
  priorState: ReviewerQueueItemState;
  nextState: ReviewerQueueItemState;
  actorUserId: string;
  affectedArtifactIds: string[];
  diagnostics: ReviewerQueueDiagnostic[];
  metadata: Record<string, unknown>;
  createdAt: Date;
};

/**
 * Semantic diagnostic emitted alongside a transition (e.g. invalid
 * transition reason, stale-source explanation). Stored verbatim on the
 * transition row so the dashboard can render the reviewer's diagnostic
 * trail without re-querying the orchestrator.
 */
export type ReviewerQueueDiagnostic = {
  code: string;
  message: string;
};

export const reviewerQueueItems = pgTable(
  "itotori_reviewer_queue_items",
  {
    reviewItemId: text("review_item_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    sourceRevisionId: text("source_revision_id")
      .notNull()
      .references(() => sourceRevisions.sourceRevisionId, { onDelete: "restrict" }),
    itemKind: text("item_kind").$type<ReviewerQueueItemKind>().notNull(),
    sourceItemRef: text("source_item_ref").notNull(),
    state: text("state").$type<ReviewerQueueItemState>().notNull().default("pending"),
    priority: integer("priority").notNull().default(0),
    summary: text("summary").notNull(),
    affectedArtifactIds: jsonb("affected_artifact_ids")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    evidenceTier: text("evidence_tier"),
    observationEventIds: jsonb("observation_event_ids").$type<string[]>(),
    artifactHashes: jsonb("artifact_hashes").$type<string[]>(),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdByUserId: text("created_by_user_id").references(() => users.userId, {
      onDelete: "set null",
    }),
    assignedToUserId: text("assigned_to_user_id").references(() => users.userId, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("itotori_reviewer_queue_items_source_item_unique").on(
      table.localeBranchId,
      table.sourceRevisionId,
      table.itemKind,
      table.sourceItemRef,
    ),
    index("itotori_reviewer_queue_items_branch_state_idx").on(
      table.localeBranchId,
      table.state,
      table.updatedAt,
    ),
    index("itotori_reviewer_queue_items_project_kind_state_idx").on(
      table.projectId,
      table.itemKind,
      table.state,
    ),
    index("itotori_reviewer_queue_items_assigned_idx").on(table.assignedToUserId, table.state),
  ],
);

export const reviewerQueueTransitions = pgTable(
  "itotori_reviewer_queue_transitions",
  {
    transitionId: text("transition_id").primaryKey(),
    reviewItemId: text("review_item_id")
      .notNull()
      .references(() => reviewerQueueItems.reviewItemId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    sourceRevisionId: text("source_revision_id")
      .notNull()
      .references(() => sourceRevisions.sourceRevisionId, { onDelete: "restrict" }),
    itemKind: text("item_kind").$type<ReviewerQueueItemKind>().notNull(),
    action: text("action").$type<ReviewerQueueAction>().notNull(),
    priorState: text("prior_state").$type<ReviewerQueueItemState>().notNull(),
    nextState: text("next_state").$type<ReviewerQueueItemState>().notNull(),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.userId, { onDelete: "restrict" }),
    affectedArtifactIds: jsonb("affected_artifact_ids")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    diagnostics: jsonb("diagnostics")
      .$type<ReviewerQueueDiagnostic[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_reviewer_queue_transitions_item_idx").on(table.reviewItemId, table.createdAt),
    index("itotori_reviewer_queue_transitions_actor_idx").on(table.actorUserId, table.createdAt),
  ],
);

// ITOTORI-118 — durable edit history for reviewer manual corrections.
//
// One append-only row per correction. Tied to (project, locale branch, source
// revision, bridge unit, actor, reason) and linked back to the feedback report
// / evidence / reviewer-queue item the correction produced — the correction
// enters the same feedback + decision + targeted-rerun loop, this table only
// records the durable audit trail. `localeBranchId` keeps corrections
// branch-scoped (ITOTORI-059); a correction is never conflated across branches.
export const workspaceCorrectionEdits = pgTable(
  "itotori_workspace_correction_edits",
  {
    correctionEditId: text("correction_edit_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    sourceRevisionId: text("source_revision_id")
      .notNull()
      .references(() => sourceRevisions.sourceRevisionId, { onDelete: "restrict" }),
    bridgeUnitId: text("bridge_unit_id").notNull(),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.userId, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    beforeText: text("before_text"),
    afterText: text("after_text").notNull(),
    disposition: text("disposition").notNull(),
    triageLabel: text("triage_label").notNull(),
    feedbackReportId: text("feedback_report_id")
      .notNull()
      .references(() => feedbackReports.feedbackReportId, { onDelete: "cascade" }),
    feedbackEvidenceId: text("feedback_evidence_id").notNull(),
    reviewItemId: text("review_item_id").references(() => reviewerQueueItems.reviewItemId, {
      onDelete: "set null",
    }),
    batchId: text("batch_id").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_workspace_correction_edits_branch_time_idx").on(
      table.localeBranchId,
      table.createdAt,
    ),
    index("itotori_workspace_correction_edits_unit_idx").on(
      table.localeBranchId,
      table.sourceRevisionId,
      table.bridgeUnitId,
    ),
    index("itotori_workspace_correction_edits_feedback_idx").on(table.feedbackReportId),
    index("itotori_workspace_correction_edits_batch_idx").on(table.batchId),
  ],
);

/**
 * itotori-bmk-cockpit-read-model — durable store for benchmark cockpit runs.
 * One row per benchmark run; the benchmark facility's body
 * (game-agnostic contestants + ranked ladder + the §8 panel↔human anchor +
 * the §10 actionable backlog) carried verbatim in `report_body` so a reviewer
 * can page a run history + render the latest run's composed cockpit shape.
 * Append-only; no UPDATE / DELETE.
 */
export const benchmarkRuns = pgTable(
  "itotori_benchmark_runs",
  {
    runId: text("run_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id").references(() => localeBranches.localeBranchId, {
      onDelete: "set null",
    }),
    targetLocale: text("target_locale").notNull(),
    schemaVersion: text("schema_version").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    unitsScored: integer("units_scored").notNull(),
    reportBody: jsonb("report_body")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_benchmark_runs_project_recorded_idx").on(table.projectId, table.recordedAt),
    index("itotori_benchmark_runs_branch_recorded_idx").on(
      table.projectId,
      table.localeBranchId,
      table.recordedAt,
    ),
  ],
);

// ---------------------------------------------------------------------------
// play-mark-validated — per-scene localization coverage (needs_check / flagged /
// validated). The Play RouteMap paints each node with this state; "Mark
// validated" writes through this table. Game-agnostic: scene_id is an opaque
// key (matches scene-summary sceneId / route-map routeKey when shared).
// ---------------------------------------------------------------------------

export const sceneLocalizationCoverageStateValues = {
  needsCheck: "needs_check",
  flagged: "flagged",
  validated: "validated",
} as const;

export type SceneLocalizationCoverageState =
  (typeof sceneLocalizationCoverageStateValues)[keyof typeof sceneLocalizationCoverageStateValues];

export const sceneLocalizationCoverage = pgTable(
  "itotori_scene_localization_coverage",
  {
    coverageId: text("coverage_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    sceneId: text("scene_id").notNull(),
    coverageState: text("coverage_state").$type<SceneLocalizationCoverageState>().notNull(),
    updatedByUserId: text("updated_by_user_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_scene_localization_coverage_unique_idx").on(
      table.projectId,
      table.localeBranchId,
      table.sceneId,
    ),
    index("itotori_scene_localization_coverage_branch_idx").on(
      table.projectId,
      table.localeBranchId,
      table.coverageState,
    ),
  ],
);

// ---------------------------------------------------------------------------
// auth-001-principal-schema — multi-user principal / account / permission-set
// identity layer.
//
// This EXTENDS the existing single-user substrate (`itotori_users` +
// `itotori_user_permission_grants` above, which `requirePermission` reads) with
// the organization / membership / identity / session / permission-set / audit
// layer a real multi-user auth service needs. The single-user substrate stays
// intact and working; nothing here replaces it.
//
// GOVERNING INVARIANT (docs/permissions.md): access control is PERMISSION-based,
// NEVER role-based. There is NO role column anywhere that authorization branches
// on. A "role" is ONLY a `permission_set` — a named, editable DATA bundle of
// permission rows granted to a principal. Effective permissions for a principal
// are the UNION of its direct permission grants and the permissions of every
// permission-set granted to it; authorization still resolves to an exact-match
// permission check, never to a role string.
//
// `principal_kind` below is an identity-TYPE discriminator (human user vs
// non-human service principal), NOT an authorization role: no authorization code
// branches on it. It exists only so a grant / session / audit row can reference
// either kind of principal through one supertype id.

/** Principal identity TYPE. NOT an authorization role — see the note above. */
export const authPrincipalKindValues = {
  humanUser: "human_user",
  servicePrincipal: "service_principal",
} as const;

export type AuthPrincipalKind =
  (typeof authPrincipalKindValues)[keyof typeof authPrincipalKindValues];

/** External IdP claim KIND. Claims are quarantined input, not grants. */
export const authProviderClaimKindValues = {
  role: "role",
  group: "group",
  scope: "scope",
} as const;

export type AuthProviderClaimKind =
  (typeof authProviderClaimKindValues)[keyof typeof authProviderClaimKindValues];

/** Direction of a permission / permission-set delta recorded in the audit log. */
export const authAuditEventActionValues = {
  granted: "granted",
  revoked: "revoked",
  invited: "invited",
  accepted: "accepted",
  removed: "removed",
  sessionRevoked: "session_revoked",
} as const;

export type AuthAuditEventAction =
  (typeof authAuditEventActionValues)[keyof typeof authAuditEventActionValues];

/**
 * The kind of permission-set MODEL mutation recorded in the permission-set audit
 * trail. This is orthogonal to `authAuditEventActionValues` (which records a
 * grant/revoke against a principal): a set mutation edits the DATA of a
 * permission bundle itself, and its subject is a permission SET, not a target
 * principal. Editing a set changes the effective permissions of every principal
 * the set is granted to, so the change is auditable in its own right.
 */
export const authPermissionSetAuditActionValues = {
  created: "set_created",
  renamed: "set_renamed",
  permissionAdded: "permission_added",
  permissionRemoved: "permission_removed",
  deleted: "set_deleted",
} as const;

export type AuthPermissionSetAuditAction =
  (typeof authPermissionSetAuditActionValues)[keyof typeof authPermissionSetAuditActionValues];

/** External SSO provider protocol configured by an account admin. */
export const authSsoProviderProtocolValues = {
  oidc: "oidc",
  saml: "saml",
} as const;

export type AuthSsoProviderProtocol =
  (typeof authSsoProviderProtocolValues)[keyof typeof authSsoProviderProtocolValues];

/** The org / workspace tenant that owns memberships, permission sets, etc. */
export const authAccounts = pgTable("itotori_auth_accounts", {
  accountId: text("account_id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
});

export const authBillingPeriodValues = {
  monthly: "monthly",
  annual: "annual",
  manual: "manual",
} as const;

export type AuthBillingPeriod =
  (typeof authBillingPeriodValues)[keyof typeof authBillingPeriodValues];

/** Internal account billing plan and seat entitlement. */
export const authAccountBillingSeats = pgTable(
  "itotori_auth_account_billing_seats",
  {
    accountId: text("account_id")
      .primaryKey()
      .references(() => authAccounts.accountId, { onDelete: "cascade" }),
    planId: text("plan_id").notNull(),
    planName: text("plan_name").notNull(),
    seatLimit: integer("seat_limit").notNull(),
    includedSeats: integer("included_seats").notNull(),
    billingPeriod: text("billing_period").notNull().$type<AuthBillingPeriod>().default("monthly"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("itotori_auth_account_billing_seats_plan_id_check", sql`length(${table.planId}) > 0`),
    check("itotori_auth_account_billing_seats_plan_name_check", sql`length(${table.planName}) > 0`),
    check("itotori_auth_account_billing_seats_seat_limit_check", sql`${table.seatLimit} >= 1`),
    check(
      "itotori_auth_account_billing_seats_included_seats_check",
      sql`${table.includedSeats} >= 0`,
    ),
    check(
      "itotori_auth_account_billing_seats_period_check",
      sql`${table.billingPeriod} in ('monthly', 'annual', 'manual')`,
    ),
  ],
);

/**
 * The unifying principal supertype: a principal is a human user OR a service
 * principal. Grants, sessions, and audit rows reference a principal by this id
 * regardless of kind. `principalKind` is an identity-type discriminator, not a
 * role (see the module note).
 */
export const authPrincipals = pgTable(
  "itotori_auth_principals",
  {
    principalId: text("principal_id").primaryKey(),
    principalKind: text("principal_kind").notNull().$type<AuthPrincipalKind>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
  },
  (table) => [index("itotori_auth_principals_kind_idx").on(table.principalKind)],
);

/** Human user identity subtype (1:1 with a `human_user` principal). */
export const authUsers = pgTable(
  "itotori_auth_users",
  {
    userId: text("user_id").primaryKey(),
    principalId: text("principal_id")
      .notNull()
      .unique()
      .references(() => authPrincipals.principalId, { onDelete: "cascade" }),
    email: text("email"),
    displayName: text("display_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("itotori_auth_users_email_idx").on(table.email)],
);

/** Non-human principal subtype (1:1 with a `service_principal` principal). */
export const authServicePrincipals = pgTable("itotori_auth_service_principals", {
  servicePrincipalId: text("service_principal_id").primaryKey(),
  principalId: text("principal_id")
    .notNull()
    .unique()
    .references(() => authPrincipals.principalId, { onDelete: "cascade" }),
  accountId: text("account_id")
    .notNull()
    .references(() => authAccounts.accountId, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
});

/** User ↔ account tenancy link. Unique on (account, user). */
export const authAccountMemberships = pgTable(
  "itotori_auth_account_memberships",
  {
    membershipId: text("membership_id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => authAccounts.accountId, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.userId, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("itotori_auth_account_memberships_account_user_key").on(table.accountId, table.userId),
    index("itotori_auth_account_memberships_user_idx").on(table.userId),
  ],
);

/** OIDC / SAML identity link. Unique on (provider, subject). */
export const authExternalIdentities = pgTable(
  "itotori_auth_external_identities",
  {
    externalIdentityId: text("external_identity_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.userId, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    subject: text("subject").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("itotori_auth_external_identities_provider_subject_key").on(
      table.provider,
      table.subject,
    ),
    index("itotori_auth_external_identities_user_idx").on(table.userId),
  ],
);

/** Admin-managed OIDC / SAML provider configuration for an account. */
export const authSsoProviderConfigs = pgTable(
  "itotori_auth_sso_provider_configs",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => authAccounts.accountId, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    protocol: text("protocol").notNull().$type<AuthSsoProviderProtocol>(),
    displayName: text("display_name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    oidcIssuer: text("oidc_issuer"),
    oidcClientId: text("oidc_client_id"),
    oidcScopes: jsonb("oidc_scopes")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    samlSsoUrl: text("saml_sso_url"),
    samlEntityId: text("saml_entity_id"),
    samlCertificateFingerprint: text("saml_certificate_fingerprint"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.providerId] }),
    check(
      "itotori_auth_sso_provider_configs_protocol_check",
      sql`${table.protocol} in ('oidc', 'saml')`,
    ),
    check(
      "itotori_auth_sso_provider_configs_provider_id_check",
      sql`length(${table.providerId}) > 0`,
    ),
    check(
      "itotori_auth_sso_provider_configs_display_name_check",
      sql`length(${table.displayName}) > 0`,
    ),
    check(
      "itotori_auth_sso_provider_configs_oidc_check",
      sql`${table.protocol} <> 'oidc' or (${table.oidcIssuer} is not null and ${table.oidcClientId} is not null)`,
    ),
    check(
      "itotori_auth_sso_provider_configs_saml_check",
      sql`${table.protocol} <> 'saml' or (${table.samlSsoUrl} is not null and ${table.samlEntityId} is not null)`,
    ),
    index("itotori_auth_sso_provider_configs_account_idx").on(table.accountId),
  ],
);

/** Account-wide security and session policy backing Settings > Account security. */
export const authAccountSecuritySettings = pgTable(
  "itotori_auth_account_security_settings",
  {
    accountId: text("account_id")
      .primaryKey()
      .references(() => authAccounts.accountId, { onDelete: "cascade" }),
    requireSso: boolean("require_sso").notNull().default(false),
    requireMfa: boolean("require_mfa").notNull().default(false),
    allowPasswordLogin: boolean("allow_password_login").notNull().default(true),
    sessionIdleTimeoutMinutes: integer("session_idle_timeout_minutes").notNull(),
    sessionAbsoluteTimeoutMinutes: integer("session_absolute_timeout_minutes").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "itotori_auth_account_security_settings_idle_timeout_check",
      sql`${table.sessionIdleTimeoutMinutes} > 0`,
    ),
    check(
      "itotori_auth_account_security_settings_absolute_timeout_check",
      sql`${table.sessionAbsoluteTimeoutMinutes} >= ${table.sessionIdleTimeoutMinutes}`,
    ),
  ],
);

/**
 * Quarantined provider claims observed during external-login processing.
 *
 * These rows are untrusted facts from the IdP. Authorization never reads them
 * directly; only explicit admin-created mappings may materialize ordinary grant
 * rows.
 */
export const authExternalIdentityProviderClaims = pgTable(
  "itotori_auth_external_identity_provider_claims",
  {
    externalIdentityId: text("external_identity_id")
      .notNull()
      .references(() => authExternalIdentities.externalIdentityId, { onDelete: "cascade" }),
    claimKind: text("claim_kind").notNull().$type<AuthProviderClaimKind>(),
    claimValue: text("claim_value").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.externalIdentityId, table.claimKind, table.claimValue] }),
    check(
      "itotori_auth_external_identity_provider_claims_kind_check",
      sql`${table.claimKind} in ('role', 'group', 'scope')`,
    ),
    check(
      "itotori_auth_external_identity_provider_claims_value_check",
      sql`length(${table.claimValue}) > 0`,
    ),
    index("itotori_auth_external_identity_provider_claims_identity_idx").on(
      table.externalIdentityId,
    ),
  ],
);

/**
 * Admin-created mapping from a quarantined provider claim to an exact
 * permission. Login reconciliation uses these rows to materialize ordinary
 * `auth_principal_permission_grants`; authorization still reads only grants.
 */
export const authProviderClaimPermissionMappings = pgTable(
  "itotori_auth_provider_claim_permission_mappings",
  {
    provider: text("provider").notNull(),
    claimKind: text("claim_kind").notNull().$type<AuthProviderClaimKind>(),
    claimValue: text("claim_value").notNull(),
    permission: text("permission").notNull().$type<Permission>(),
    createdByPrincipalId: text("created_by_principal_id")
      .notNull()
      .references(() => authPrincipals.principalId, { onDelete: "restrict" }),
    reason: text("reason"),
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.claimKind, table.claimValue, table.permission] }),
    check(
      "itotori_auth_provider_claim_permission_mappings_kind_check",
      sql`${table.claimKind} in ('role', 'group', 'scope')`,
    ),
    check(
      "itotori_auth_provider_claim_permission_mappings_claim_value_check",
      sql`length(${table.claimValue}) > 0`,
    ),
    index("itotori_auth_provider_claim_permission_mappings_claim_idx").on(
      table.provider,
      table.claimKind,
      table.claimValue,
    ),
  ],
);

/**
 * An account invitation. `initialPermissionSetIds` is the OPTIONAL list of
 * permission-set ids to grant the accepting principal on join — a permission
 * bundle, never a role string.
 */
export const authInvitations = pgTable(
  "itotori_auth_invitations",
  {
    invitationId: text("invitation_id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => authAccounts.accountId, { onDelete: "cascade" }),
    email: text("email").notNull(),
    initialPermissionSetIds: jsonb("initial_permission_set_ids")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("itotori_auth_invitations_account_email_idx").on(table.accountId, table.email)],
);

/** Opaque server-side session for a principal (human or service). */
export const authSessions = pgTable(
  "itotori_auth_sessions",
  {
    sessionId: text("session_id").primaryKey(),
    principalId: text("principal_id")
      .notNull()
      .references(() => authPrincipals.principalId, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    userAgent: text("user_agent"),
    ipAddress: text("ip_address"),
    deviceLabel: text("device_label"),
  },
  (table) => [index("itotori_auth_sessions_principal_idx").on(table.principalId)],
);

/**
 * A named, editable permission bundle. This is the ONLY thing a "role" may ever
 * be: a data row of permissions, account-scoped and editable. Unique per
 * (account, name).
 */
export const authPermissionSets = pgTable(
  "itotori_auth_permission_sets",
  {
    permissionSetId: text("permission_set_id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => authAccounts.accountId, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("itotori_auth_permission_sets_account_name_key").on(table.accountId, table.name),
  ],
);

/**
 * The permissions in a permission set. `permission` is a `Permission` value
 * (the same exact-match permission strings `requirePermission` checks); it is
 * validated by the typed repository layer, keeping a single source of truth in
 * `permissionValues` rather than a second SQL enum copy.
 */
export const authPermissionSetPermissions = pgTable(
  "itotori_auth_permission_set_permissions",
  {
    permissionSetId: text("permission_set_id")
      .notNull()
      .references(() => authPermissionSets.permissionSetId, { onDelete: "cascade" }),
    permission: text("permission").notNull().$type<Permission>(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.permissionSetId, table.permission] })],
);

/** Direct exact-permission overrides granted to a principal. */
export const authPrincipalPermissionGrants = pgTable(
  "itotori_auth_principal_permission_grants",
  {
    principalId: text("principal_id")
      .notNull()
      .references(() => authPrincipals.principalId, { onDelete: "cascade" }),
    permission: text("permission").notNull().$type<Permission>(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.principalId, table.permission] })],
);

/** A permission set granted to a principal (the "role assignment"). */
export const authPrincipalPermissionSetGrants = pgTable(
  "itotori_auth_principal_permission_set_grants",
  {
    principalId: text("principal_id")
      .notNull()
      .references(() => authPrincipals.principalId, { onDelete: "cascade" }),
    permissionSetId: text("permission_set_id")
      .notNull()
      .references(() => authPermissionSets.permissionSetId, { onDelete: "cascade" }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.principalId, table.permissionSetId] })],
);

/**
 * Append-only audit trail of authorization changes and member lifecycle events:
 * which actor granted/revoked which permission or permission-set to/from which
 * target principal, invited which email, accepted which invitation, or removed
 * which member, why, and under which request id.
 */
export const authAuditEvents = pgTable(
  "itotori_auth_audit_events",
  {
    authAuditEventId: text("auth_audit_event_id").primaryKey(),
    actorPrincipalId: text("actor_principal_id")
      .notNull()
      .references(() => authPrincipals.principalId, { onDelete: "restrict" }),
    targetPrincipalId: text("target_principal_id").references(() => authPrincipals.principalId, {
      onDelete: "restrict",
    }),
    accountId: text("account_id").references(() => authAccounts.accountId, {
      onDelete: "set null",
    }),
    invitationId: text("invitation_id").references(() => authInvitations.invitationId, {
      onDelete: "set null",
    }),
    targetEmail: text("target_email"),
    action: text("action").notNull().$type<AuthAuditEventAction>(),
    permission: text("permission").$type<Permission>(),
    permissionSetId: text("permission_set_id").references(
      () => authPermissionSets.permissionSetId,
      { onDelete: "set null" },
    ),
    reason: text("reason"),
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_auth_audit_events_target_idx").on(table.targetPrincipalId, table.createdAt),
    index("itotori_auth_audit_events_actor_idx").on(table.actorPrincipalId, table.createdAt),
  ],
);

/**
 * Append-only audit trail of permission-set MODEL edits: which actor created,
 * renamed, added/removed a permission to/from, or deleted which permission set,
 * why, and under which request id. Editing a granted set changes the effective
 * permissions of the principals it is granted to, so every set mutation is
 * recorded here.
 *
 * `permissionSetId` is a plain retained id (NOT a foreign key): the row must
 * survive the set's deletion so a `set_deleted` event is not itself cascaded
 * away. `setName` snapshots the set's name at mutation time so a deleted set is
 * still legible in the trail. `permission` is populated only for
 * `permission_added` / `permission_removed`.
 */
export const authPermissionSetAuditEvents = pgTable(
  "itotori_auth_permission_set_audit_events",
  {
    authPermissionSetAuditEventId: text("auth_permission_set_audit_event_id").primaryKey(),
    actorPrincipalId: text("actor_principal_id")
      .notNull()
      .references(() => authPrincipals.principalId, { onDelete: "restrict" }),
    permissionSetId: text("permission_set_id").notNull(),
    setName: text("set_name").notNull(),
    action: text("action").notNull().$type<AuthPermissionSetAuditAction>(),
    permission: text("permission").$type<Permission>(),
    reason: text("reason"),
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_auth_permission_set_audit_events_set_idx").on(
      table.permissionSetId,
      table.createdAt,
    ),
    index("itotori_auth_permission_set_audit_events_actor_idx").on(
      table.actorPrincipalId,
      table.createdAt,
    ),
  ],
);

// ---------------------------------------------------------------------
// p0-core-attempt-and-outcome-journal — durable per-run execution journal
// ---------------------------------------------------------------------

/**
 * Context/version reference resolved into one written unit's immutable input
 * packet. The context store itself is a later node; the journal preserves the
 * references and opaque packet so a read-model never has to fabricate them.
 */
export type LocalizationJournalOutcomeContextRefDetails = unknown;

/** A source/draft character span supplied by a raw QA finding. */
export type LocalizationJournalQaSpan = {
  start: number;
  end: number;
};

/** Opaque, versioned supervisor inputs frozen at run launch. */
export type LocalizationJournalFrozenScopeJson = Record<string, unknown> | unknown[];
export type LocalizationJournalRoutingPolicyJson = Record<string, unknown>;
export type LocalizationJournalCostPolicyJson = Record<string, unknown>;

/** Run-level operational blocker persisted while execution is resumably paused. */
export type LocalizationJournalPausedBlockerJson = {
  kind: "budget_cap" | "provider_outage" | "itotori_bug";
  detail: string;
  evidence: string;
  raisedAt: string;
  operatorAction: string;
};

/** Durable, provider-independent description of the unit work to resume. */
export type LocalizationJournalNextActionJson = {
  kind: string;
  [key: string]: unknown;
};

/**
 * One localization execution run. It owns the physical provider-call and
 * written-outcome facts needed to rebuild a patch/read model losslessly.
 */
export const localizationJournalRuns = pgTable(
  "itotori_localization_journal_runs",
  {
    runId: text("run_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "cascade" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "cascade" }),
    sourceRevisionId: text("source_revision_id")
      .notNull()
      .references(() => sourceRevisions.sourceRevisionId, { onDelete: "restrict" }),
    targetLocale: text("target_locale").notNull(),
    frozenScope: jsonb("frozen_scope").$type<LocalizationJournalFrozenScopeJson>(),
    routingPolicy: jsonb("routing_policy").$type<LocalizationJournalRoutingPolicyJson>(),
    costPolicy: jsonb("cost_policy").$type<LocalizationJournalCostPolicyJson>(),
    status: text("status").notNull().default("running"),
    pausedBlocker: jsonb("paused_blocker").$type<LocalizationJournalPausedBlockerJson>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_localization_journal_runs_branch_created_idx").on(
      table.localeBranchId,
      table.createdAt,
    ),
    index("itotori_localization_journal_runs_project_created_idx").on(
      table.projectId,
      table.createdAt,
    ),
  ],
);

/**
 * One planned unit execution slot, seeded before dispatch. This table never
 * stores source text, target text, or candidates; those belong only to the
 * canonical terminal WrittenUnitOutcome tables below.
 */
export const localizationJournalRunUnits = pgTable(
  "itotori_localization_journal_run_units",
  {
    runId: text("run_id")
      .notNull()
      .references(() => localizationJournalRuns.runId, { onDelete: "cascade" }),
    bridgeUnitId: text("bridge_unit_id").notNull(),
    sourceUnitKey: text("source_unit_key"),
    unitOrdinal: integer("unit_ordinal").notNull(),
    state: text("state").notNull().default("pending"),
    nextAction: jsonb("next_action").$type<LocalizationJournalNextActionJson>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.bridgeUnitId] }),
    unique("itotori_localization_journal_run_units_run_ordinal_unique").on(
      table.runId,
      table.unitOrdinal,
    ),
    index("itotori_localization_journal_run_units_run_state_idx").on(
      table.runId,
      table.state,
      table.unitOrdinal,
    ),
  ],
);

/**
 * One physical provider dispatch. `costUsd` intentionally uses an
 * unconstrained PostgreSQL `numeric`: it round-trips through Drizzle as a
 * decimal string and must never be converted to integer micros or a JS number.
 */
export const localizationJournalLlmAttempts = pgTable(
  "itotori_llm_attempts",
  {
    attemptId: text("attempt_id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => localizationJournalRuns.runId, { onDelete: "cascade" }),
    // The whole-project driver journals raw bridge units before (and even
    // without) source-unit SQL provisioning, so this frozen-scope identity is
    // intentionally a durable text key rather than a source_units FK.
    bridgeUnitId: text("bridge_unit_id").notNull(),
    stage: text("stage").notNull(),
    agentLabel: text("agent_label").notNull(),
    logicalCallId: text("logical_call_id").notNull(),
    attemptIndex: integer("attempt_index").notNull(),
    lifecycleState: text("lifecycle_state").notNull().default("completed"),
    // The requested policy pair and the actual served pair are distinct facts:
    // OpenRouter may route within the ZDR allow-list after a preference miss.
    requestedModelId: text("requested_model_id"),
    requestedProviderId: text("requested_provider_id"),
    modelId: text("model_id"),
    providerId: text("provider_id"),
    providerRunId: text("provider_run_id").notNull(),
    costUsd: numeric("cost_usd"),
    costKind: text("cost_kind"),
    usageResponseJson: jsonb("usage_response_json"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    tokenCountSource: text("token_count_source"),
    // Cache fields remain nullable for pre-0078 journal rows: NULL means the
    // provenance was not captured, never a fabricated non-cache-hit zero.
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    cacheDiscountMicrosUsd: pgBigint("cache_discount_micros_usd", { mode: "number" }),
    fallbackUsed: boolean("fallback_used"),
    fallbackPlan: jsonb("fallback_plan").$type<string[]>(),
    zdr: boolean("zdr").notNull(),
    finishState: text("finish_state"),
    refusalState: text("refusal_state"),
    validationResult: text("validation_result"),
    failureClass: text("failure_class"),
    retryDecision: text("retry_decision"),
    retryDelayMs: integer("retry_delay_ms"),
    artifactRef: text("artifact_ref"),
    errorClasses: jsonb("error_classes")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_llm_attempts_run_logical_attempt_idx").on(
      table.runId,
      table.logicalCallId,
      table.attemptIndex,
    ),
    uniqueIndex("itotori_llm_attempts_provider_run_idx").on(table.providerRunId),
    index("itotori_llm_attempts_run_unit_idx").on(table.runId, table.bridgeUnitId),
    index("itotori_llm_attempts_run_stage_idx").on(table.runId, table.stage),
    index("itotori_llm_attempts_dispatching_idx").on(
      table.runId,
      table.lifecycleState,
      table.startedAt,
    ),
    foreignKey({
      columns: [table.runId, table.bridgeUnitId],
      foreignColumns: [localizationJournalRunUnits.runId, localizationJournalRunUnits.bridgeUnitId],
      name: "itotori_llm_attempts_planned_unit_fkey",
    }).onDelete("cascade"),
  ],
);

/**
 * Canonical terminal result for one unit in a run. Migration 0077 declares
 * the selected-candidate composite FK separately because the candidate table
 * is defined below and the relationship is cyclic; PostgreSQL enforces it as
 * `DEFERRABLE INITIALLY DEFERRED` at the atomic unit-write boundary.
 */
export const writtenUnitOutcomes = pgTable(
  "itotori_written_unit_outcomes",
  {
    // Canonical outcome ids are deterministic per project/branch/unit and can
    // recur in a later run. Keep a journal-local identity for child FKs.
    journalOutcomeId: text("journal_outcome_id").primaryKey(),
    outcomeId: text("outcome_id").notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => localizationJournalRuns.runId, { onDelete: "cascade" }),
    bridgeUnitId: text("bridge_unit_id").notNull(),
    sourceUnitKey: text("source_unit_key"),
    targetLocale: text("target_locale").notNull(),
    selectedCandidateId: text("selected_candidate_id").notNull(),
    qualityFlags: text("quality_flags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // `unknown` legitimately includes null: a node that has no resolved
    // context packet yet records that fact rather than inventing `{}`.
    provenance: jsonb("provenance").$type<unknown>(),
    contextPacket: jsonb("context_packet").$type<unknown>(),
    writtenAt: timestamp("written_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_written_unit_outcomes_run_outcome_idx").on(table.runId, table.outcomeId),
    uniqueIndex("itotori_written_unit_outcomes_run_unit_idx").on(table.runId, table.bridgeUnitId),
    index("itotori_written_unit_outcomes_run_written_idx").on(table.runId, table.writtenAt),
    foreignKey({
      columns: [table.runId, table.bridgeUnitId],
      foreignColumns: [localizationJournalRunUnits.runId, localizationJournalRunUnits.bridgeUnitId],
      name: "itotori_written_unit_outcomes_planned_unit_fkey",
    }).onDelete("cascade"),
  ],
);

/** Every primary/repair candidate, linked to its physical provider attempt. */
export const translationCandidates = pgTable(
  "itotori_translation_candidates",
  {
    // Candidate ids are canonical output ids, not globally unique run ids.
    journalCandidateId: text("journal_candidate_id").primaryKey(),
    candidateId: text("candidate_id").notNull(),
    journalOutcomeId: text("journal_outcome_id")
      .notNull()
      .references(() => writtenUnitOutcomes.journalOutcomeId, { onDelete: "cascade" }),
    // These columns are required by the migration's composite provenance FKs:
    // a candidate must belong to the same immutable run/unit as both its
    // written outcome and physical provider attempt.
    runId: text("run_id").notNull(),
    bridgeUnitId: text("bridge_unit_id").notNull(),
    candidateOrdinal: integer("candidate_ordinal").notNull(),
    body: text("body").notNull(),
    modelId: text("model_id").notNull(),
    providerId: text("provider_id").notNull(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => localizationJournalLlmAttempts.attemptId, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_translation_candidates_outcome_candidate_idx").on(
      table.journalOutcomeId,
      table.candidateId,
    ),
    uniqueIndex("itotori_translation_candidates_outcome_ordinal_idx").on(
      table.journalOutcomeId,
      table.candidateOrdinal,
    ),
    index("itotori_translation_candidates_attempt_idx").on(table.attemptId),
  ],
);

/**
 * Candidate-scoped permanent QA annotations. The raw QA detail fields are
 * deliberately normalized alongside the concise written finding so the read
 * surface can render rationale/evidence without parsing a note or an opaque
 * provenance payload.
 */
export const writtenQaFindings = pgTable(
  "itotori_written_qa_findings",
  {
    journalFindingId: text("journal_finding_id").primaryKey(),
    findingId: text("finding_id").notNull(),
    journalOutcomeId: text("journal_outcome_id")
      .notNull()
      .references(() => writtenUnitOutcomes.journalOutcomeId, { onDelete: "cascade" }),
    journalCandidateId: text("journal_candidate_id")
      .notNull()
      .references(() => translationCandidates.journalCandidateId, { onDelete: "cascade" }),
    findingOrdinal: integer("finding_ordinal").notNull(),
    severity: text("severity").notNull(),
    category: text("category").notNull(),
    note: text("note").notNull(),
    contested: boolean("contested").notNull(),
    confidence: numeric("confidence").notNull(),
    recommendation: text("recommendation").notNull(),
    agentRationale: text("agent_rationale").notNull(),
    evidenceRefs: jsonb("evidence_refs")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    sourceSpan: jsonb("source_span").$type<LocalizationJournalQaSpan | null>(),
    draftSpan: jsonb("draft_span").$type<LocalizationJournalQaSpan | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("itotori_written_qa_findings_outcome_finding_idx").on(
      table.journalOutcomeId,
      table.findingId,
    ),
    uniqueIndex("itotori_written_qa_findings_outcome_ordinal_idx").on(
      table.journalOutcomeId,
      table.findingOrdinal,
    ),
    index("itotori_written_qa_findings_candidate_idx").on(table.journalCandidateId),
  ],
);

/** Resolved context packet/version references used by a written outcome. */
export const outcomeContextRefs = pgTable(
  "itotori_outcome_context_refs",
  {
    journalOutcomeId: text("journal_outcome_id")
      .notNull()
      .references(() => writtenUnitOutcomes.journalOutcomeId, { onDelete: "cascade" }),
    refOrdinal: integer("ref_ordinal").notNull(),
    refKind: text("ref_kind").notNull(),
    refId: text("ref_id").notNull(),
    versionRef: text("version_ref"),
    details: jsonb("details").$type<LocalizationJournalOutcomeContextRefDetails>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.journalOutcomeId, table.refOrdinal] }),
    index("itotori_outcome_context_refs_kind_ref_idx").on(table.refKind, table.refId),
  ],
);

/** Speaker labels resolved for the unit and retained with their evidence. */
export const outcomeSpeakerLabels = pgTable(
  "itotori_outcome_speaker_labels",
  {
    journalOutcomeId: text("journal_outcome_id")
      .notNull()
      .references(() => writtenUnitOutcomes.journalOutcomeId, { onDelete: "cascade" }),
    labelOrdinal: integer("label_ordinal").notNull(),
    bridgeUnitId: text("bridge_unit_id").notNull(),
    speakerId: jsonb("speaker_id").$type<unknown>().notNull(),
    confidence: text("confidence").notNull(),
    evidenceRefs: jsonb("evidence_refs")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    agentRationale: text("agent_rationale").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.journalOutcomeId, table.labelOrdinal] }),
    index("itotori_outcome_speaker_labels_bridge_unit_idx").on(table.bridgeUnitId),
  ],
);
