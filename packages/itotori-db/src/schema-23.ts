import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

// Type-only import (erased at compile time — no runtime cycle with
// authorization.ts, which imports table VALUES from this module). Types the
// auth permission-set / grant / audit columns to the single Permission source
// of truth in authorization.ts.
import type { Permission } from "./authorization.js";

import { projects, sourceRevisions } from "./schema-07.js";
import { localeBranches } from "./schema-08.js";
import { type AuthPermissionSetAuditAction } from "./schema-20.js";
import { authPrincipals } from "./schema-21.js";

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

/** Delivery lifecycle for retained patch versions. */
export const localizationRunPatchVersionStatusValues = {
  building: "building",
  playable: "playable",
  failed: "failed",
} as const;

export type LocalizationRunPatchVersionStatus =
  (typeof localizationRunPatchVersionStatusValues)[keyof typeof localizationRunPatchVersionStatusValues];

/** How a patch member arrived in this exact delivery. */
export const localizationPatchVersionMemberOriginValues = {
  runWrittenOutcome: "run_written_outcome",
  reusedFromBase: "reused_from_base",
  playTesterEdit: "play_tester_edit",
} as const;

export type LocalizationPatchVersionMemberOrigin =
  (typeof localizationPatchVersionMemberOriginValues)[keyof typeof localizationPatchVersionMemberOriginValues];

/** Durable play-feedback event kinds. */
export const playTestFeedbackEventKindValues = {
  resultEdit: "result_edit",
  comment: "comment",
  addedContext: "added_context",
  wikiEdit: "wiki_edit",
} as const;

export type PlayTestFeedbackEventKind =
  (typeof playTestFeedbackEventKindValues)[keyof typeof playTestFeedbackEventKindValues];

export const playTestFeedbackBatchSelectionKindValues = {
  individual: "individual",
  batch: "batch",
} as const;

export type PlayTestFeedbackBatchSelectionKind =
  (typeof playTestFeedbackBatchSelectionKindValues)[keyof typeof playTestFeedbackBatchSelectionKindValues];

export const localizationPatchVersionOriginValues = {
  runFinalizer: "run_finalizer",
  playTesterEdit: "play_tester_edit",
  refinementRun: "refinement_run",
} as const;
export type LocalizationPatchVersionOrigin =
  (typeof localizationPatchVersionOriginValues)[keyof typeof localizationPatchVersionOriginValues];

/** Immutable target text retained independently of the retired journal. */
export const patchOutputRevisions = pgTable(
  "itotori_patch_output_revisions",
  {
    outputRevisionId: text("output_revision_id").primaryKey(),
    bridgeUnitId: text("bridge_unit_id").notNull(),
    targetBody: text("target_body").notNull(),
    origin: text("origin").notNull(),
    parentOutputRevisionId: text("parent_output_revision_id"),
    actorUserId: text("actor_user_id"),
    createdForPatchVersionId: text("created_for_patch_version_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_patch_output_revisions_bridge_unit_idx").on(table.bridgeUnitId),
    index("itotori_patch_output_revisions_parent_idx").on(table.parentOutputRevisionId),
  ],
);

export const localizationPatchVersions = pgTable(
  "itotori_localization_patch_versions",
  {
    patchVersionId: text("patch_version_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "restrict" }),
    localeBranchId: text("locale_branch_id")
      .notNull()
      .references(() => localeBranches.localeBranchId, { onDelete: "restrict" }),
    sourceRevisionId: text("source_revision_id")
      .notNull()
      .references(() => sourceRevisions.sourceRevisionId, { onDelete: "restrict" }),
    deliveryScopeId: text("delivery_scope_id").notNull(),
    status: text("status").$type<LocalizationRunPatchVersionStatus>().notNull(),
    artifactHashes: jsonb("artifact_hashes").$type<Record<string, string>>().notNull(),
    artifactRefs: jsonb("artifact_refs").$type<Record<string, string>>().notNull(),
    playableAt: timestamp("playable_at", { withTimezone: true }),
    parentPatchVersionId: text("parent_patch_version_id"),
    origin: text("origin")
      .$type<LocalizationPatchVersionOrigin>()
      .notNull()
      .default("run_finalizer"),
    actorUserId: text("actor_user_id"),
    selectedAt: timestamp("selected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("itotori_localization_patch_versions_id_scope_unique").on(
      table.patchVersionId,
      table.deliveryScopeId,
    ),
    index("itotori_localization_patch_versions_scope_status_idx").on(
      table.deliveryScopeId,
      table.status,
    ),
    index("itotori_localization_patch_versions_branch_created_idx").on(
      table.localeBranchId,
      table.createdAt,
    ),
    index("itotori_localization_patch_versions_parent_idx").on(table.parentPatchVersionId),
  ],
);

/** Exact, ordered frozen-scope membership for one minimal PatchVersion. */
export const localizationPatchVersionUnits = pgTable(
  "itotori_localization_patch_version_units",
  {
    patchVersionId: text("patch_version_id").notNull(),
    bridgeUnitId: text("bridge_unit_id").notNull(),
    outputRevisionId: text("output_revision_id")
      .notNull()
      .references(() => patchOutputRevisions.outputRevisionId, { onDelete: "restrict" }),
    memberOrigin: text("member_origin").$type<LocalizationPatchVersionMemberOrigin>().notNull(),
    reusedFromPatchVersionId: text("reused_from_patch_version_id"),
    unitOrdinal: integer("unit_ordinal").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.patchVersionId, table.bridgeUnitId] }),
    unique("itotori_localization_patch_version_units_ordinal_unique").on(
      table.patchVersionId,
      table.unitOrdinal,
    ),
    index("itotori_localization_patch_version_units_output_idx").on(table.outputRevisionId),
    foreignKey({
      columns: [table.patchVersionId],
      foreignColumns: [localizationPatchVersions.patchVersionId],
      name: "itotori_localization_patch_version_units_patch_fkey",
    }).onDelete("cascade"),
  ],
);

/** A first-class feedback inbox grouping; individual feedback has a singleton batch. */
export const playTestFeedbackBatches = pgTable(
  "itotori_play_test_feedback_batches",
  {
    feedbackBatchId: text("feedback_batch_id").primaryKey(),
    observedPatchVersionId: text("observed_patch_version_id")
      .notNull()
      .references(() => localizationPatchVersions.patchVersionId, { onDelete: "restrict" }),
    actorUserId: text("actor_user_id").notNull(),
    selectionKind: text("selection_kind").$type<PlayTestFeedbackBatchSelectionKind>().notNull(),
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("itotori_play_test_feedback_batches_id_patch_unique").on(
      table.feedbackBatchId,
      table.observedPatchVersionId,
    ),
    index("itotori_play_test_feedback_batches_patch_created_idx").on(
      table.observedPatchVersionId,
      table.createdAt,
    ),
  ],
);

/** One exact-version observation/edit/comment/context feedback event. */
