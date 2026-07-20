import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedMigratedContext } from "./db-test-context.js";

const here = dirname(fileURLToPath(import.meta.url));
const ledgerPath = join(here, "..", "..", "..", "scripts", "lint", "deletion-ledger.json");
const { retiredDbTables } = JSON.parse(readFileSync(ledgerPath, "utf8"));

describe("retired localization persistence", () => {
  it("does not create retired benchmark, journal, reservation, finalizer, or context-artifact tables", async () => {
    const context = await isolatedMigratedContext();
    try {
      expect(retiredDbTables).toContain("itotori_benchmark_runs");
      const tables = await context.pool.query<{ table_name: string }>(
        `
        select table_name
        from information_schema.tables
        where table_schema = current_schema()
          and table_name = any($1::text[])
      `,
        [retiredDbTables],
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
