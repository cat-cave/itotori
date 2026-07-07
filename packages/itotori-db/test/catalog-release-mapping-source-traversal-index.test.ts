import { describe, expect, it } from "vitest";
import type { DatabaseContext } from "../src/connection.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const SOURCE_INDEX_NAME = "itotori_catalog_release_mappings_source_idx";
const TARGET_INDEX_NAME = "itotori_catalog_release_mappings_target_idx";
const RELATION_INDEX_NAME = "itotori_catalog_release_mappings_relation_idx";

// CATALOG-092: portability queries ("what can this source release map to") drive
// translation porting (relation_kind = 'translation_of') and patch-target
// discovery (relation_kind = 'patch_targets') by filtering
// itotori_catalog_release_mappings on (source_release_id, relation_kind).
//
// Prior coverage only had a TARGET-side traversal index
// (itotori_catalog_release_mappings_target_idx on (target_release_id,
// relation_kind)) and the unique natural-key index
// (itotori_catalog_release_mappings_relation_idx on (source_release_id,
// target_release_id, relation_kind)). The unique index shares source_release_id
// as its leading column, but relation_kind is its THIRD column, so a
// (source_release_id, relation_kind) predicate can only use the source_release_id
// prefix and must then SCAN every target_release_id for that source — unbounded
// traversal for any source with many mapped targets.
//
// These assertions pin the new source-side index's EXACT Postgres definition
// (via pg_get_indexdef) AND prove with EXPLAIN that a source-side portability
// query is served by it (not the unique relation index), so the "efficient +
// provable" acceptance crux and the "no duplicate index" audit focus both hold.
// Raw pg_catalog queries + EXPLAIN are used (rather than the drizzle `sql` tag)
// because we interrogate Postgres planner/catalog output, not drizzle-modeled
// queries.

describe("catalog release mapping source-side traversal index (CATALOG-092)", () => {
  it("pins the source-side traversal index definition exactly via pg_get_indexdef", async () => {
    const context = await isolatedMigratedContext();
    try {
      const result = await context.pool.query<{
        schema_name: string;
        index_name: string;
        index_definition: string;
      }>(
        `
          select current_schema() as schema_name,
                 c.relname as index_name,
                 pg_get_indexdef(c.oid) as index_definition
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = current_schema()
            and c.relkind = 'i'
            and c.relname = any($1::text[])
        `,
        [[SOURCE_INDEX_NAME, TARGET_INDEX_NAME, RELATION_INDEX_NAME]],
      );

      const byName = new Map(result.rows.map((row) => [row.index_name, row]));

      const sourceRow = byName.get(SOURCE_INDEX_NAME);
      expect(sourceRow, `expected index ${SOURCE_INDEX_NAME} to exist`).toBeDefined();
      const sourceSchema = String(sourceRow?.schema_name);
      // Pins the absence of UNIQUE (non-uniqueness — the natural key is enforced
      // by the separate relation_idx) and the two-column (source_release_id,
      // relation_kind) ordering. Adding uniqueness, dropping a column, or
      // reordering columns fails this assertion.
      expect(String(sourceRow?.index_definition)).toBe(sourceIndexDefinition(sourceSchema));

      // Symmetry sanity: the target-side traversal index still exists with the
      // mirror shape, so source/target traversal are covered symmetrically.
      const targetRow = byName.get(TARGET_INDEX_NAME);
      expect(targetRow, `expected index ${TARGET_INDEX_NAME} to exist`).toBeDefined();
      expect(String(targetRow?.index_definition)).toBe(targetIndexDefinition(sourceSchema));

      // Non-redundancy: the unique relation index still enforces the
      // (source_release_id, target_release_id, relation_kind) natural key and is
      // NOT collapsed into the source-side traversal index.
      const relationRow = byName.get(RELATION_INDEX_NAME);
      expect(relationRow, `expected index ${RELATION_INDEX_NAME} to exist`).toBeDefined();
      expect(String(relationRow?.index_definition)).toBe(relationIndexDefinition(sourceSchema));
    } finally {
      await context.close();
    }
  });

  it("proves via EXPLAIN that source-side portability queries use the source traversal index, not the unique relation index", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedReleaseMappingTraversalRows(context);

      // ANALYZE so the planner has accurate per-column statistics; without it a
      // tiny fixture table can default to a sequential scan and mask the index
      // choice. enable_seqscan = off (session-local) then forces an index path
      // so the proof is deterministic rather than planner-heuristic-dependent.
      await context.pool.query("analyze itotori_catalog_release_mappings");
      await context.pool.query("set enable_seqscan = off");

      // The two portability query shapes this index exists to serve:
      // translation porting + patch-target discovery. Each must seek the
      // (source_release_id, relation_kind) bucket via source_idx instead of
      // scanning the unique relation index's source_release_id prefix.
      for (const relationKind of ["translation_of", "patch_targets"] as const) {
        const plan = await explainPlan(context, {
          sourceReleaseId: "release-src-A",
          relationKind,
        });

        // The source-side traversal index is the one chosen by the planner for
        // the (source_release_id, relation_kind) predicate.
        expect(
          plan.includes(SOURCE_INDEX_NAME),
          `expected EXPLAIN for relation_kind=${relationKind} to use ${SOURCE_INDEX_NAME}\n${plan}`,
        ).toBe(true);
        // And the unique natural-key index is NOT chosen for this lookup —
        // proving the new index is non-redundant (relation_kind is the unique
        // index's THIRD column, behind the unbounded target_release_id).
        expect(
          plan.includes(RELATION_INDEX_NAME),
          `expected EXPLAIN for relation_kind=${relationKind} NOT to use ${RELATION_INDEX_NAME}\n${plan}`,
        ).toBe(false);
      }
    } finally {
      await context.close();
    }
  });
});

async function seedReleaseMappingTraversalRows(context: DatabaseContext): Promise<void> {
  const pool = context.pool;
  await pool.query(`
    insert into itotori_catalog_works (work_id, canonical_title)
    values ('work-A', 'Traversal Proof Work A')
  `);

  // One source release (release-src-A) is the portability-lookup subject; it
  // maps to many targets across many relation kinds so the unique relation
  // index would scan a wide source_release_id prefix if chosen. The other
  // source releases bulk out the table so a sequential scan is not attractive.
  const releases = [
    "release-src-A",
    "release-src-B",
    "release-src-C",
    "release-tgt-1",
    "release-tgt-2",
    "release-tgt-3",
    "release-tgt-4",
    "release-tgt-5",
    "release-tgt-6",
  ];
  for (const releaseId of releases) {
    await pool.query(
      `
        insert into itotori_catalog_releases (release_id, work_id, catalog_source, release_title, release_kind)
        values ($1, 'work-A', 'dlsite', $2, 'original')
      `,
      [releaseId, `Title ${releaseId}`],
    );
  }

  const relationKinds = ["translation_of", "patch_targets", "edition_of", "remaster_of"];
  const targetsForA = ["release-tgt-1", "release-tgt-2", "release-tgt-3", "release-tgt-4"];
  let mappingSeq = 0;
  // source release A maps to 4 targets x 4 relation kinds = 16 rows. A
  // (source_release_id, relation_kind) predicate matches 4 of these, while the
  // unique relation index would have to scan all 16 for source_release_id = A.
  for (const target of targetsForA) {
    for (const kind of relationKinds) {
      mappingSeq += 1;
      await pool.query(
        `
          insert into itotori_catalog_release_mappings (release_mapping_id, work_id, source_release_id, target_release_id, relation_kind)
          values ($1, 'work-A', 'release-src-A', $2, $3)
        `,
        [`mapping-A-${mappingSeq}`, target, kind],
      );
    }
  }
  // Other sources add traversal-unrelated bulk so the table is large enough
  // that an index path is the clearly cheaper plan.
  for (const source of ["release-src-B", "release-src-C"]) {
    for (const target of ["release-tgt-5", "release-tgt-6"]) {
      for (const kind of relationKinds) {
        mappingSeq += 1;
        await pool.query(
          `
            insert into itotori_catalog_release_mappings (release_mapping_id, work_id, source_release_id, target_release_id, relation_kind)
            values ($1, 'work-A', $2, $3, $4)
          `,
          [`mapping-other-${mappingSeq}`, source, target, kind],
        );
      }
    }
  }
}

async function explainPlan(
  context: DatabaseContext,
  input: { sourceReleaseId: string; relationKind: string },
): Promise<string> {
  const result = await context.pool.query<{ "QUERY PLAN": string }>(
    `
      explain (format text)
      select target_release_id, portability
      from itotori_catalog_release_mappings
      where source_release_id = $1 and relation_kind = $2
    `,
    [input.sourceReleaseId, input.relationKind],
  );
  return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
}

function sourceIndexDefinition(schemaName: string): string {
  return (
    `CREATE INDEX ${SOURCE_INDEX_NAME} ` +
    `ON ${schemaName}.itotori_catalog_release_mappings USING btree ` +
    `(source_release_id, relation_kind)`
  );
}

function targetIndexDefinition(schemaName: string): string {
  return (
    `CREATE INDEX ${TARGET_INDEX_NAME} ` +
    `ON ${schemaName}.itotori_catalog_release_mappings USING btree ` +
    `(target_release_id, relation_kind)`
  );
}

function relationIndexDefinition(schemaName: string): string {
  return (
    `CREATE UNIQUE INDEX ${RELATION_INDEX_NAME} ` +
    `ON ${schemaName}.itotori_catalog_release_mappings USING btree ` +
    `(source_release_id, target_release_id, relation_kind)`
  );
}
