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
    } finally {
      await context.close();
    }
  });
});
