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

import { catalogSourceValues } from "./schema-01.js";

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
