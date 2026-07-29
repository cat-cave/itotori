import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Type-only import (erased at compile time — no runtime cycle with
// authorization.ts, which imports table VALUES from this module). Types the
// auth permission-set / grant / audit columns to the single Permission source
// of truth in authorization.ts.

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

export const users = pgTable("itotori_users", {
  userId: text("user_id").primaryKey(),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
