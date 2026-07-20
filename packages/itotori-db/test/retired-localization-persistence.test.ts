import { describe, expect, it } from "vitest";
import { isolatedMigratedContext } from "./db-test-context.js";

const retiredTables = [
  "itotori_localization_journal_runs",
  "itotori_localization_journal_run_units",
  "itotori_llm_attempts",
  "itotori_localization_cost_reservations",
  "itotori_localization_run_cost_accounts",
  "itotori_written_unit_outcomes",
  "itotori_translation_candidates",
  "itotori_localization_result_revisions",
  "itotori_written_qa_findings",
  "itotori_outcome_context_refs",
  "itotori_outcome_speaker_labels",
  "itotori_localization_run_terminal_summaries",
  "itotori_localization_run_finalizer_outbox",
  "itotori_play_sessions",
  "itotori_play_session_qa_callouts",
  "itotori_localization_refinement_run_feedback_batches",
  "itotori_localization_refinement_run_feedback_events",
  "itotori_localization_refinement_run_wiki_heads",
  "itotori_localization_refinement_run_members",
  "itotori_context_artifacts",
  "itotori_context_entry_versions",
  "itotori_context_artifact_source_units",
] as const;

describe("retired localization persistence", () => {
  it("does not create journal ownership, reservation, finalizer, or context-artifact tables", async () => {
    const context = await isolatedMigratedContext();
    try {
      const tables = await context.pool.query<{ table_name: string }>(
        `
        select table_name
        from information_schema.tables
        where table_schema = current_schema()
          and table_name = any($1::text[])
      `,
        [retiredTables],
      );
      expect(tables.rows).toEqual([]);

      const retiredColumns = await context.pool.query<{ table_name: string; column_name: string }>(`
        select table_name, column_name
        from information_schema.columns
        where table_schema = current_schema()
          and (
            (table_name = 'itotori_localization_patch_versions' and column_name in ('run_id', 'lease_owner_id', 'lease_expires_at', 'fence_token'))
            or (table_name = 'itotori_localization_patch_version_units' and column_name in ('run_id', 'source_run_id', 'journal_outcome_id', 'result_revision_id'))
            or (table_name = 'itotori_play_test_feedback_events' and column_name in ('play_session_id', 'result_revision_id', 'context_artifact_id', 'context_entry_version_id'))
          )
      `);
      expect(retiredColumns.rows).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
