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

import { users } from "./schema-03.js";
import { projects } from "./schema-07.js";
import { localeBranches } from "./schema-08.js";
import { type DraftJobAttemptStatus, type DraftJobStatus } from "./schema-18.js";

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
// Asset localization decision workflow
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
