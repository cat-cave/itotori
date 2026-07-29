import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
// Type-only import (erased at compile time — no runtime cycle with
// authorization.ts, which imports table VALUES from this module). Types the
// auth permission-set / grant / audit columns to the single Permission source
// of truth in authorization.ts.

import {
  localizationPatchVersionUnits,
  patchOutputRevisions,
  playTestFeedbackBatches,
  type PlayTestFeedbackEventKind,
} from "./schema-23.js";

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
