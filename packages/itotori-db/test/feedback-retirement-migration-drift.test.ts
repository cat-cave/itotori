import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { isolatedMigratedContext } from "./db-test-context.js";

describe("feedback retirement migration drift", () => {
  it("makes feedback reports branch- and unit-bound with restrictive foreign keys", async () => {
    const context = await isolatedMigratedContext();
    try {
      const columns = await context.db.execute(sql`
        select column_name, is_nullable
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'itotori_feedback_reports'
          and column_name in ('locale_branch_id', 'bridge_unit_id')
        order by column_name
      `);
      expect(columns.rows).toEqual([
        { column_name: "bridge_unit_id", is_nullable: "NO" },
        { column_name: "locale_branch_id", is_nullable: "NO" },
      ]);

      const constraints = await context.db.execute(sql`
        select con.conname as constraint_name, pg_get_constraintdef(con.oid) as definition
        from pg_constraint con
        join pg_class rel on rel.oid = con.conrelid
        join pg_namespace ns on ns.oid = rel.relnamespace
        where ns.nspname = current_schema()
          and rel.relname = 'itotori_feedback_reports'
          and con.conname in (
            'itotori_feedback_reports_locale_branch_id_fkey',
            'itotori_feedback_reports_bridge_unit_id_fkey',
            'itotori_feedback_reports_direct_context_target_check'
          )
        order by con.conname
      `);
      const definitions = new Map(
        constraints.rows.map((row) => [String(row.constraint_name), String(row.definition)]),
      );
      expect(definitions.get("itotori_feedback_reports_locale_branch_id_fkey")).toContain(
        "ON DELETE RESTRICT",
      );
      expect(definitions.get("itotori_feedback_reports_bridge_unit_id_fkey")).toContain(
        "ON DELETE RESTRICT",
      );
      expect(definitions.get("itotori_feedback_reports_direct_context_target_check")).toContain(
        "context_status = 'contextualized'",
      );
    } finally {
      await context.close();
    }
  });

  it("requires every play-test feedback event to name a canonical outcome", async () => {
    const context = await isolatedMigratedContext();
    try {
      const constraints = await context.db.execute(sql`
        select con.conname as constraint_name, pg_get_constraintdef(con.oid) as definition
        from pg_constraint con
        join pg_class rel on rel.oid = con.conrelid
        join pg_namespace ns on ns.oid = rel.relnamespace
        where ns.nspname = current_schema()
          and rel.relname = 'itotori_play_test_feedback_events'
          and con.conname in (
            'itotori_play_test_feedback_events_context_version_pair',
            'itotori_play_test_feedback_events_canonical_outcome',
            'itotori_play_test_feedback_events_comment_body'
          )
        order by con.conname
      `);
      const definitions = new Map(
        constraints.rows.map((row) => [String(row.constraint_name), String(row.definition)]),
      );
      expect(definitions.get("itotori_play_test_feedback_events_context_version_pair")).toContain(
        "context_artifact_id IS NULL",
      );
      expect(definitions.get("itotori_play_test_feedback_events_canonical_outcome")).toContain(
        "result_revision_id IS NOT NULL",
      );
      expect(definitions.get("itotori_play_test_feedback_events_canonical_outcome")).toContain(
        "context_entry_version_id IS NOT NULL",
      );
      expect(definitions.get("itotori_play_test_feedback_events_comment_body")).toContain(
        "body IS NOT NULL",
      );
    } finally {
      await context.close();
    }
  });
});
