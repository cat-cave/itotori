import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { isolatedMigratedContext } from "./db-test-context.js";

// ITOTORI-122: assert the style-guide version reference-integrity constraints
// (migration 0053) are actually registered on a freshly-migrated schema. The
// DB constraint — not schema.ts — is the source of truth for the composite FKs
// that cannot be expressed in the mutually-recursive drizzle table types, so we
// introspect pg_constraint directly (mirrors audit-finding-migration-drift).

describe.skipIf(!process.env.DATABASE_URL)(
  "style guide version reference integrity migration drift",
  () => {
    it("registers the scoped latest / approved / previous / guide composite FKs", async () => {
      const context = await isolatedMigratedContext();
      try {
        const rows = await context.db.execute(sql`
          select
            c.relname as table_name,
            con.conname as constraint_name,
            pg_get_constraintdef(con.oid) as constraint_definition
          from pg_constraint con
          join pg_class c on c.oid = con.conrelid
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = current_schema()
            and c.relname in ('itotori_style_guides', 'itotori_style_guide_versions')
            and con.contype = 'f'
          order by con.conname
        `);

        const byName = new Map(
          rows.rows.map((row) => [String(row.constraint_name), String(row.constraint_definition)]),
        );

        // latest_version_id -> versions (id + full scope).
        expect(byName.get("itotori_style_guides_latest_version_scope_fkey")).toMatch(
          /FOREIGN KEY \(latest_version_id, style_guide_id, project_id, locale_branch_id\) REFERENCES itotori_style_guide_versions\(style_guide_version_id, style_guide_id, project_id, locale_branch_id\)/i,
        );
        // approved_version_id -> versions (id + full scope).
        expect(byName.get("itotori_style_guides_approved_version_scope_fkey")).toMatch(
          /FOREIGN KEY \(approved_version_id, style_guide_id, project_id, locale_branch_id\) REFERENCES itotori_style_guide_versions\(style_guide_version_id, style_guide_id, project_id, locale_branch_id\)/i,
        );
        // previous_version_id -> versions (self, id + full scope).
        expect(byName.get("itotori_style_guide_versions_previous_version_scope_fkey")).toMatch(
          /FOREIGN KEY \(previous_version_id, style_guide_id, project_id, locale_branch_id\) REFERENCES itotori_style_guide_versions\(style_guide_version_id, style_guide_id, project_id, locale_branch_id\)/i,
        );
        // version scope -> its guide's scope.
        expect(byName.get("itotori_style_guide_versions_guide_scope_fkey")).toMatch(
          /FOREIGN KEY \(style_guide_id, project_id, locale_branch_id\) REFERENCES itotori_style_guides\(style_guide_id, project_id, locale_branch_id\)/i,
        );
      } finally {
        await context.close();
      }
    });

    it("registers the composite unique keys targeted by the pointer FKs", async () => {
      const context = await isolatedMigratedContext();
      try {
        const rows = await context.db.execute(sql`
          select con.conname as constraint_name
          from pg_constraint con
          join pg_class c on c.oid = con.conrelid
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = current_schema()
            and con.contype = 'u'
            and con.conname in (
              'itotori_style_guides_scope_key',
              'itotori_style_guide_versions_scope_key'
            )
        `);
        const names = new Set(rows.rows.map((row) => String(row.constraint_name)));
        expect(names.has("itotori_style_guides_scope_key")).toBe(true);
        expect(names.has("itotori_style_guide_versions_scope_key")).toBe(true);
      } finally {
        await context.close();
      }
    });
  },
);
