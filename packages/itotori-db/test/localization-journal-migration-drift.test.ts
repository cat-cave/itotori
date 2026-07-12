import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { isolatedMigratedContext } from "./db-test-context.js";

describe("localization attempt/outcome journal migration", () => {
  it("creates the normalized journal tables, an unconstrained exact-cost numeric, and candidate-to-attempt FK", async () => {
    const context = await isolatedMigratedContext();
    try {
      const tableRows = await context.db.execute(sql`
        select table_name
        from information_schema.tables
        where table_schema = current_schema()
          and table_name in (
            'itotori_localization_journal_runs',
            'itotori_localization_journal_run_units',
            'itotori_llm_attempts',
            'itotori_written_unit_outcomes',
            'itotori_translation_candidates',
            'itotori_written_qa_findings',
            'itotori_outcome_context_refs',
            'itotori_outcome_speaker_labels'
          )
        order by table_name
      `);
      expect(tableRows.rows.map((row) => (row as { table_name: string }).table_name)).toEqual([
        "itotori_llm_attempts",
        "itotori_localization_journal_run_units",
        "itotori_localization_journal_runs",
        "itotori_outcome_context_refs",
        "itotori_outcome_speaker_labels",
        "itotori_translation_candidates",
        "itotori_written_qa_findings",
        "itotori_written_unit_outcomes",
      ]);

      const [costColumn] = (
        await context.db.execute(sql`
          select data_type, numeric_precision, numeric_scale
          from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'itotori_llm_attempts'
            and column_name = 'cost_usd'
        `)
      ).rows as Array<{
        data_type: string;
        numeric_precision: number | null;
        numeric_scale: number | null;
      }>;
      expect(costColumn).toEqual({
        data_type: "numeric",
        numeric_precision: null,
        numeric_scale: null,
      });

      const foreignKeys = await context.db.execute(sql`
        select referenced.relname as referenced_table
        from pg_constraint constraint_row
        inner join pg_class source on source.oid = constraint_row.conrelid
        inner join pg_namespace source_namespace on source_namespace.oid = source.relnamespace
        inner join pg_class referenced on referenced.oid = constraint_row.confrelid
        where constraint_row.contype = 'f'
          and source.relname = 'itotori_translation_candidates'
          and source_namespace.nspname = current_schema()
        order by referenced.relname
      `);
      expect(
        foreignKeys.rows.map((row) => (row as { referenced_table: string }).referenced_table),
      ).toEqual(["itotori_llm_attempts", "itotori_written_unit_outcomes"]);

      const unitColumns = await context.db.execute(sql`
        select column_name
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'itotori_localization_journal_run_units'
        order by ordinal_position
      `);
      const unitColumnNames = unitColumns.rows.map(
        (row) => (row as { column_name: string }).column_name,
      );
      expect(unitColumnNames).toEqual([
        "run_id",
        "bridge_unit_id",
        "source_unit_key",
        "unit_ordinal",
        "state",
        "next_action",
        "created_at",
        "updated_at",
      ]);
      expect(unitColumnNames).not.toEqual(
        expect.arrayContaining(["source_text", "target_text", "candidate", "body"]),
      );

      const attemptLifecycleColumns = await context.db.execute(sql`
        select column_name, is_nullable, column_default
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'itotori_llm_attempts'
          and column_name in (
            'lifecycle_state', 'model_id', 'provider_id', 'cost_usd',
            'zdr', 'validation_result', 'completed_at'
          )
        order by column_name
      `);
      expect(attemptLifecycleColumns.rows).toEqual([
        expect.objectContaining({ column_name: "completed_at", is_nullable: "YES" }),
        expect.objectContaining({ column_name: "cost_usd", is_nullable: "YES" }),
        expect.objectContaining({
          column_name: "lifecycle_state",
          is_nullable: "NO",
          column_default: "'completed'::text",
        }),
        expect.objectContaining({ column_name: "model_id", is_nullable: "YES" }),
        expect.objectContaining({ column_name: "provider_id", is_nullable: "YES" }),
        expect.objectContaining({ column_name: "validation_result", is_nullable: "YES" }),
        expect.objectContaining({ column_name: "zdr", is_nullable: "NO" }),
      ]);

      const plannedUnitForeignKeys = await context.db.execute(sql`
        select source.relname as source_table
        from pg_constraint constraint_row
        inner join pg_class source on source.oid = constraint_row.conrelid
        inner join pg_namespace source_namespace on source_namespace.oid = source.relnamespace
        inner join pg_class referenced on referenced.oid = constraint_row.confrelid
        where constraint_row.contype = 'f'
          and referenced.relname = 'itotori_localization_journal_run_units'
          and source_namespace.nspname = current_schema()
        order by source.relname
      `);
      expect(
        plannedUnitForeignKeys.rows.map((row) => (row as { source_table: string }).source_table),
      ).toEqual(["itotori_llm_attempts", "itotori_written_unit_outcomes"]);
    } finally {
      await context.close();
    }
  });
});
