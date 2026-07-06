// ITOTORI-081 — reviewer queue migration drift guard.
//
// The SQL discriminant on `itotori_reviewer_queue_items` is the
// load-bearing invariant the repository relies on to prevent runtime
// evidence rows from silently losing their evidence tier / observation
// refs / artifact hashes. This file pins the SQL behavior directly so a
// future migration that loosens the discriminant fails this test.

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { isolatedMigratedContext } from "./db-test-context.js";

function pgErrorCodeOf(error: unknown): string | undefined {
  let current: unknown = error;
  while (current !== undefined && current !== null) {
    if (typeof current === "object" && "code" in current) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string") {
        return code;
      }
    }
    if (typeof current === "object" && "cause" in current) {
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return undefined;
}

const projectId = "project-drift-081";
const localeBranchId = "locale-branch-drift-081";
const sourceRevisionId = "source-revision-drift-081";

async function seedProjectScope(context: Awaited<ReturnType<typeof isolatedMigratedContext>>) {
  await context.db.execute(sql`
    insert into itotori_workspaces (workspace_id, name)
    values ('workspace-drift-081', 'Drift workspace')
    on conflict (workspace_id) do nothing
  `);
  await context.db.execute(sql`
    insert into itotori_projects (
      project_id, workspace_id, project_key, name, source_locale, status
    )
    values (
      ${projectId}, 'workspace-drift-081', 'drift-081', 'Drift project', 'ja-JP', 'imported'
    )
    on conflict (project_id) do nothing
  `);
  await context.db.execute(sql`
    insert into itotori_source_revisions (source_revision_id, project_id, revision_kind, value)
    values (${sourceRevisionId}, ${projectId}, 'bridge_revision', 'drift-v1')
    on conflict (source_revision_id) do nothing
  `);
  await context.db.execute(sql`
    insert into itotori_source_bundles (
      source_bundle_id, project_id, source_bundle_revision_id, bridge_id,
      schema_version, source_bundle_hash, source_locale,
      extractor_name, extractor_version, unit_count, asset_count
    )
    values (
      'source-bundle-drift-081', ${projectId}, ${sourceRevisionId}, 'bridge-drift-081',
      '0.2.0', 'hash:drift', 'ja-JP', 'fixture-extractor', '1.0.0', 0, 0
    )
    on conflict (source_bundle_id) do nothing
  `);
  await context.db.execute(sql`
    insert into itotori_locale_branches (
      locale_branch_id, project_id, source_bundle_id, target_locale, branch_name, status
    )
    values (
      ${localeBranchId}, ${projectId}, 'source-bundle-drift-081', 'en-US', 'English', 'active'
    )
    on conflict (locale_branch_id) do nothing
  `);
}

describe("reviewer queue migration drift", () => {
  it("item_kind check constraint rejects unknown kinds", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProjectScope(context);
      let captured: unknown;
      try {
        await context.pool.query(
          `insert into itotori_reviewer_queue_items
             (review_item_id, project_id, locale_branch_id, source_revision_id,
              item_kind, source_item_ref, summary)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            "reviewer-queue-drift-1",
            projectId,
            localeBranchId,
            sourceRevisionId,
            "bogus_kind",
            "ref-1",
            "summary",
          ],
        );
      } catch (error) {
        captured = error;
      }
      expect(pgErrorCodeOf(captured)).toBe("23514");
    } finally {
      await context.close();
    }
  });

  it("runtime evidence discriminant rejects null evidence_tier on runtime_evidence rows", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProjectScope(context);
      let captured: unknown;
      try {
        await context.pool.query(
          `insert into itotori_reviewer_queue_items
             (review_item_id, project_id, locale_branch_id, source_revision_id,
              item_kind, source_item_ref, summary)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            "reviewer-queue-drift-2",
            projectId,
            localeBranchId,
            sourceRevisionId,
            "runtime_evidence",
            "ref-2",
            "summary",
          ],
        );
      } catch (error) {
        captured = error;
      }
      expect(pgErrorCodeOf(captured)).toBe("23514");
    } finally {
      await context.close();
    }
  });

  it("runtime evidence discriminant rejects evidence_tier on non-runtime kinds", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProjectScope(context);
      let captured: unknown;
      try {
        await context.pool.query(
          `insert into itotori_reviewer_queue_items
             (review_item_id, project_id, locale_branch_id, source_revision_id,
              item_kind, source_item_ref, summary, evidence_tier,
              observation_event_ids, artifact_hashes)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            "reviewer-queue-drift-3",
            projectId,
            localeBranchId,
            sourceRevisionId,
            "qa",
            "ref-3",
            "summary",
            "tier-2",
            JSON.stringify(["event-1"]),
            JSON.stringify(["sha:1"]),
          ],
        );
      } catch (error) {
        captured = error;
      }
      expect(pgErrorCodeOf(captured)).toBe("23514");
    } finally {
      await context.close();
    }
  });

  it("resolved-state consistency check rejects accepted rows with null resolved_at", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProjectScope(context);
      // First insert a valid pending row, then attempt to set state =
      // 'accepted' without resolved_at — the check must reject.
      await context.pool.query(
        `insert into itotori_reviewer_queue_items
           (review_item_id, project_id, locale_branch_id, source_revision_id,
            item_kind, source_item_ref, summary)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          "reviewer-queue-drift-4",
          projectId,
          localeBranchId,
          sourceRevisionId,
          "qa",
          "ref-4",
          "summary",
        ],
      );

      let captured: unknown;
      try {
        await context.pool.query(
          `update itotori_reviewer_queue_items
             set state = 'accepted'
             where review_item_id = $1`,
          ["reviewer-queue-drift-4"],
        );
      } catch (error) {
        captured = error;
      }
      expect(pgErrorCodeOf(captured)).toBe("23514");
    } finally {
      await context.close();
    }
  });

  it("source-item uniqueness rejects duplicates at the database layer", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProjectScope(context);
      await context.pool.query(
        `insert into itotori_reviewer_queue_items
           (review_item_id, project_id, locale_branch_id, source_revision_id,
            item_kind, source_item_ref, summary)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          "reviewer-queue-drift-5",
          projectId,
          localeBranchId,
          sourceRevisionId,
          "qa",
          "shared-ref",
          "summary",
        ],
      );

      let captured: unknown;
      try {
        await context.pool.query(
          `insert into itotori_reviewer_queue_items
             (review_item_id, project_id, locale_branch_id, source_revision_id,
              item_kind, source_item_ref, summary)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            "reviewer-queue-drift-6",
            projectId,
            localeBranchId,
            sourceRevisionId,
            "qa",
            "shared-ref",
            "summary",
          ],
        );
      } catch (error) {
        captured = error;
      }
      expect(pgErrorCodeOf(captured)).toBe("23505");
    } finally {
      await context.close();
    }
  });

  it("deferred rows are non-terminal and keep resolved_at null", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProjectScope(context);
      await context.pool.query(
        `insert into itotori_reviewer_queue_items
           (review_item_id, project_id, locale_branch_id, source_revision_id,
            item_kind, source_item_ref, summary, state)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          "reviewer-queue-drift-deferred",
          projectId,
          localeBranchId,
          sourceRevisionId,
          "qa",
          "deferred-ref",
          "summary",
          "deferred",
        ],
      );

      const rows = await context.pool.query(
        `select state, resolved_at
           from itotori_reviewer_queue_items
          where review_item_id = $1`,
        ["reviewer-queue-drift-deferred"],
      );
      expect(rows.rows[0]).toMatchObject({ state: "deferred", resolved_at: null });
    } finally {
      await context.close();
    }
  });

  it("registers the foreign key from transitions back to items", async () => {
    const context = await isolatedMigratedContext();
    try {
      const rows = await context.db.execute(sql`
        select
          c.relname as table_name,
          pg_get_constraintdef(con.oid) as constraint_definition
        from pg_constraint con
        join pg_class c on c.oid = con.conrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = current_schema()
          and c.relname = 'itotori_reviewer_queue_transitions'
          and con.contype = 'f'
        order by con.conname
      `);
      const definitions = rows.rows.map(
        (row) => `${String(row.table_name)}: ${String(row.constraint_definition)}`,
      );
      expect(
        definitions.some(
          (def) =>
            def.startsWith("itotori_reviewer_queue_transitions:") &&
            def.includes("REFERENCES itotori_reviewer_queue_items"),
        ),
      ).toBe(true);
    } finally {
      await context.close();
    }
  });
});
