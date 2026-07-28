import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { catalogRawContentRedactionClassValues } from "./schema-values-core.js";

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
