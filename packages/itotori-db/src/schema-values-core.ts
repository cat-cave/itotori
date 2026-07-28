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

export const projectRunStatusValues = {
  queued: "queued",
  running: "running",
  paused: "paused",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
} as const;

export type ProjectRunStatus = (typeof projectRunStatusValues)[keyof typeof projectRunStatusValues];

export const projectRunProgressStatusValues = {
  decoded: "decoded",
  drafted: "drafted",
  QA: "QA",
  accepted: "accepted",
  patched: "patched",
} as const;

export type ProjectRunProgressStatus =
  (typeof projectRunProgressStatusValues)[keyof typeof projectRunProgressStatusValues];

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

// Narrowed from the legacy 5-value enum to the only two cost states the
// cost-tracking audit (docs/audits/openrouter-cost-tracking-
// audit-2026-06-25.md) considers correct: a real upstream charge, or no
// charge at all. Migration 0039 backfills + tightens the CHECK constraint.
//
// Also re-introduces `provider_estimate` as a narrowly-scoped deterministic
// cost-estimate state (derived from cost_details or endpoint-pricing ×
// tokens) for responses where the authoritative `usage.cost` is absent.
// The TS type accepts it; the DB CHECK constraint (migration 0039) is a
// separate follow-up — provider-level tests use an in-memory recorder, so
// this widening is type-safe without a migration.
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
