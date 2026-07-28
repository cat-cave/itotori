import {
  check,
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
import { sql } from "drizzle-orm";
import { projects, sourceRevisions, localeBranches } from "./schema-project-core.js";
import {
  type LocalizationRunPatchVersionStatus,
  type LocalizationPatchVersionMemberOrigin,
  type PlayTestFeedbackEventKind,
  type PlayTestFeedbackBatchSelectionKind,
  type LocalizationPatchVersionOrigin,
} from "./schema-auth-permissions.js";

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
export const playTestFeedbackEvents = pgTable(
  "itotori_play_test_feedback_events",
  {
    feedbackEventId: text("feedback_event_id").primaryKey(),
    feedbackBatchId: text("feedback_batch_id").notNull(),
    observedPatchVersionId: text("observed_patch_version_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    eventKind: text("event_kind").$type<PlayTestFeedbackEventKind>().notNull(),
    body: text("body"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    outputRevisionId: text("output_revision_id").references(
      () => patchOutputRevisions.outputRevisionId,
      { onDelete: "restrict" },
    ),
    /** Immutable pointer to the new wiki/accepted-output substrate. */
    subjectRef: text("subject_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.feedbackBatchId, table.observedPatchVersionId],
      foreignColumns: [
        playTestFeedbackBatches.feedbackBatchId,
        playTestFeedbackBatches.observedPatchVersionId,
      ],
      name: "itotori_play_test_feedback_events_batch_patch_fkey",
    }).onDelete("restrict"),
    check(
      "itotori_play_test_feedback_events_result_edit_output_revision",
      sql`${table.eventKind} <> 'result_edit' or ${table.outputRevisionId} is not null`,
    ),
    check(
      "itotori_play_test_feedback_events_subject_binding",
      sql`(
        (${table.eventKind} = 'result_edit' and ${table.outputRevisionId} is not null and ${table.subjectRef} is null)
        or (
          ${table.eventKind} in ('comment', 'added_context', 'wiki_edit')
          and ${table.outputRevisionId} is null
          and ${table.subjectRef} is not null
        )
      )`,
    ),
    check(
      "itotori_play_test_feedback_events_comment_body",
      sql`${table.eventKind} <> 'comment' or ${table.body} is not null`,
    ),
    index("itotori_play_test_feedback_events_patch_created_idx").on(
      table.observedPatchVersionId,
      table.createdAt,
    ),
    index("itotori_play_test_feedback_events_batch_created_idx").on(
      table.feedbackBatchId,
      table.createdAt,
    ),
  ],
);

/** A feedback event can target any number of members from the patch observed. */
export const playTestFeedbackEventUnits = pgTable(
  "itotori_play_test_feedback_event_units",
  {
    feedbackEventId: text("feedback_event_id")
      .notNull()
      .references(() => playTestFeedbackEvents.feedbackEventId, { onDelete: "cascade" }),
    observedPatchVersionId: text("observed_patch_version_id").notNull(),
    bridgeUnitId: text("bridge_unit_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.feedbackEventId, table.bridgeUnitId] }),
    foreignKey({
      columns: [table.observedPatchVersionId, table.bridgeUnitId],
      foreignColumns: [
        localizationPatchVersionUnits.patchVersionId,
        localizationPatchVersionUnits.bridgeUnitId,
      ],
      name: "itotori_play_test_feedback_event_units_observed_member_fkey",
    }).onDelete("restrict"),
    index("itotori_play_test_feedback_event_units_patch_unit_idx").on(
      table.observedPatchVersionId,
      table.bridgeUnitId,
    ),
  ],
);
