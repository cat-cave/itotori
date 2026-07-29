import {
  bigint as pgBigint,
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
// Type-only import (erased at compile time — no runtime cycle with
// authorization.ts, which imports table VALUES from this module). Types the
// auth permission-set / grant / audit columns to the single Permission source
// of truth in authorization.ts.

import { users } from "./schema-03.js";
import { catalogSourceProvenance } from "./schema-04.js";
import { projects, sourceRevisions } from "./schema-07.js";
import { localeBranches, sourceUnits } from "./schema-08.js";
import { events } from "./schema-11.js";
import { providerRuns } from "./schema-13.js";

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
