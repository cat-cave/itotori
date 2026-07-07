// ITOTORI-145 — translation-memory CHECK-constraint schema-drift guard.
//
// Migration 0023 declared the translation-memory tables
// (itotori_translation_memory_segments + itotori_translation_memory_reuse_events)
// but left the enum-like status / match_kind / reuse_status columns, the
// 0..1000 match_score range, and the jsonb object shape of the provenance /
// cost_impact columns unenforced at the DB layer. Direct or HISTORICAL rows
// could otherwise persist an out-of-range score or an unknown enum value and
// silently poison reuse reads downstream (e.g. a "blocked" segment with an
// "applied" reuse event is structurally inconsistent).
//
// Migration 0063 adds seven DB CHECK constraints:
//   on itotori_translation_memory_segments:
//     status         in ('reusable', 'blocked')           (enum guard)
//     provenance    jsonb_typeof = 'object'              (shape guard)
//   on itotori_translation_memory_reuse_events:
//     match_kind    in ('exact', 'fuzzy')                (enum guard)
//     match_score   between 0 and 1000 inclusive         (range guard)
//     reuse_status  in ('suggested', 'applied')          (enum guard)
//     provenance    jsonb_typeof = 'object'              (shape guard)
//     cost_impact   jsonb_typeof = 'object'              (shape guard)
//
// This suite pins PARITY between the Drizzle table objects declared in
// src/schema.ts and the constraints registered on a freshly-migrated Postgres
// schema (introspected via pg_constraint). If either side drifts (a constraint
// added/removed in only one), the matching assertion fails. Behavioral probes
// additionally prove the DB rejects each invalid value at persist time with
// SQLSTATE 23514 (check_violation).

import { getTableName, isTable, sql, type Table } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { BridgeBundle } from "@itotori/localization-bridge-schema";

import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import {
  ItotoriProjectRepository,
  type ItotoriProjectRecord,
} from "../src/repositories/project-repository.js";
import { translationMemoryReuseEvents, translationMemorySegments } from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

const SEGMENTS_TABLE_NAME = "itotori_translation_memory_segments";
const REUSE_EVENTS_TABLE_NAME = "itotori_translation_memory_reuse_events";

const EXPECTED_SEGMENT_CHECK_NAMES = [
  "itotori_tm_segments_status_check",
  "itotori_tm_segments_provenance_check",
] as const;

const EXPECTED_REUSE_EVENT_CHECK_NAMES = [
  "itotori_tm_reuse_events_match_kind_check",
  "itotori_tm_reuse_events_match_score_check",
  "itotori_tm_reuse_events_reuse_status_check",
  "itotori_tm_reuse_events_provenance_check",
  "itotori_tm_reuse_events_cost_impact_check",
] as const;

// --- Drizzle metadata introspection -----------------------------------------

const INLINE_FK_SYMBOL = Symbol.for("drizzle:PgInlineForeignKeys");
const EXTRA_CONFIG_BUILDER_SYMBOL = Symbol.for("drizzle:ExtraConfigBuilder");
const EXTRA_CONFIG_COLUMNS_SYMBOL = Symbol.for("drizzle:ExtraConfigColumns");

interface DrizzleForeignKeyLike {
  reference: () => {
    name: string | undefined;
    columns: { name: string }[];
    foreignTable: Table;
    foreignColumns: { name: string }[];
  };
  onDelete: string;
  onUpdate: string;
}

interface DrizzleCheckBuilderLike {
  name: string;
  value: { toQuery: () => { sql: string } };
}

function isForeignKeyLike(value: unknown): value is DrizzleForeignKeyLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { reference?: unknown }).reference === "function"
  );
}

function isCheckBuilderLike(value: unknown): value is DrizzleCheckBuilderLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { value?: unknown }).value === "object"
  );
}

function drizzleTableName(table: Table): string {
  return getTableName(table);
}

function readDrizzleExtraConfigItems(table: Table): unknown[] {
  const builder = (
    table as unknown as {
      [k: symbol]: unknown;
    }
  )[EXTRA_CONFIG_BUILDER_SYMBOL];
  if (typeof builder !== "function") return [];
  const columns = (
    table as unknown as {
      [k: symbol]: unknown;
    }
  )[EXTRA_CONFIG_COLUMNS_SYMBOL];
  const result = (builder as (cols: unknown) => unknown)(columns);
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object") return Object.values(result);
  return [];
}

/** CHECK constraint names declared on the Drizzle table (extra-config array). */
function drizzleDeclaredCheckNames(table: Table): Set<string> {
  const names = new Set<string>();
  for (const item of readDrizzleExtraConfigItems(table)) {
    if (isCheckBuilderLike(item)) names.add(item.name);
  }
  return names;
}

// --- pg_constraint introspection query --------------------------------------

function constraintQueryFor(tableName: string) {
  return sql`
    select
      con.contype as constraint_type,
      con.conname as constraint_name,
      pg_get_constraintdef(con.oid) as constraint_definition
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = current_schema()
      and c.relname = ${tableName}
    order by con.contype, con.conname
  `;
}

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

// --- helper: load the project's bridge so FK columns are valid ---------------

async function seedTranslationMemoryProject(
  db: ConstructorParameters<typeof ItotoriProjectRepository>[0],
) {
  const repository = new ItotoriProjectRepository(db);
  await repository.importSourceBundle(localActor, translationMemoryProjectFixture());
}

function translationMemoryProjectFixture(): ItotoriProjectRecord {
  return {
    projectId: "project-tm-drift-145",
    localeBranchId: "locale-en-us-drift-145",
    targetLocale: "en-US",
    drafts: {},
    bridge: translationMemoryBridgeFixture(),
  };
}

function translationMemoryBridgeFixture(): BridgeBundle {
  const bridgeId = "bridge-tm-drift-145";
  const sourceBundleHash = "hash:bundle-drift-145";
  const assetId = `${bridgeId}:scenario.ks`;
  return {
    schemaVersion: "0.1.0",
    bridgeId,
    sourceBundleHash,
    sourceLocale: "ja-JP",
    extractorName: "kaifuu-fixture",
    extractorVersion: "0.0.0",
    units: [
      {
        bridgeUnitId: "unit-tm-drift-145",
        sourceUnitKey: "scene.drift-145",
        occurrenceId: "occurrence-drift-145",
        sourceHash: "hash:drift-145",
        sourceLocale: "ja-JP",
        sourceText: "おはようございます。",
        textSurface: "dialogue",
        protectedSpans: [],
        patchRef: {
          assetId,
          writeMode: "replace",
          sourceUnitKey: "scene.drift-145",
        },
      },
    ],
  };
}

// --- helpers: raw INSERTs that intentionally target a single CHECK -----------

type SegmentInsertColumns = {
  status?: string;
  provenance?: string;
  memorySegmentId?: string;
};

type ReuseEventInsertColumns = {
  match_kind?: string;
  match_score?: number;
  reuse_status?: string;
  provenance?: string;
  cost_impact?: string;
  reuseEventId?: string;
};

async function captureCheckViolation(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
  rawSql: string,
  params: unknown[],
): Promise<string | undefined> {
  let captured: unknown;
  try {
    await context.pool.query(rawSql, params);
  } catch (error) {
    captured = error;
  }
  return pgErrorCodeOf(captured);
}

function segmentInsert(columns: SegmentInsertColumns) {
  // Always pin the not-null-required columns (status is NOT NULL without a DB
  // default); only the CHECK-relevant columns are varied per probe so each
  // failure isolates a single guard.
  const memorySegmentId = columns.memorySegmentId ?? "tm-drift-base";
  const parts: string[] = [
    "memory_segment_id",
    "project_id",
    "locale_branch_id",
    "source_revision_id",
    "source_unit_key",
    "source_occurrence_id",
    "source_hash",
    "source_fingerprint",
    "source_text",
    "target_locale",
    "target_text",
    "status",
  ];
  const values: string[] = [
    `'${memorySegmentId}'`,
    "'project-tm-drift-145'",
    "'locale-en-us-drift-145'",
    "'bridge-tm-drift-145:bundle-revision'",
    "'scene.drift-145'",
    "'occurrence-drift-145'",
    "'hash:drift-145'",
    "'fingerprint:drift-145'",
    "'おはようございます。'",
    "'en-US'",
    "'Good morning.'",
    "'reusable'",
  ];
  if (columns.status !== undefined) {
    values[values.length - 1] = `'${columns.status}'`;
  }
  if (columns.provenance !== undefined) {
    parts.push("provenance");
    values.push(`'${columns.provenance}'::jsonb`);
  }
  return {
    sql: `insert into itotori_translation_memory_segments (${parts.join(", ")}) values (${values.join(", ")})`,
    params: [] as unknown[],
  };
}

function reuseEventInsert(columns: ReuseEventInsertColumns) {
  // The not-null columns are pinned; the probe varies one CHECK column at a
  // time so each assertion isolates a single guard.
  const reuseEventId = columns.reuseEventId ?? "tm-drift-event";
  const parts: string[] = [
    "reuse_event_id",
    "project_id",
    "locale_branch_id",
    "target_bridge_unit_id",
    "source_revision_id",
    "memory_segment_id",
    "source_hash",
    "candidate_source_hash",
    "target_text",
    "match_kind",
    "match_score",
    "reuse_status",
    "provenance",
    "cost_impact",
  ];
  const values: string[] = [
    `'${reuseEventId}'`,
    "'project-tm-drift-145'",
    "'locale-en-us-drift-145'",
    "'unit-tm-drift-145'",
    "'bridge-tm-drift-145:bundle-revision'",
    "'tm-drift-base'",
    "'hash:drift-145'",
    "'hash:drift-145'",
    "'Good morning.'",
    "'exact'",
    "1000",
    "'applied'",
    "'{}'::jsonb",
    "'{}'::jsonb",
  ];
  if (columns.match_kind !== undefined) {
    values[parts.indexOf("match_kind")] = `'${columns.match_kind}'`;
  }
  if (columns.match_score !== undefined) {
    values[parts.indexOf("match_score")] = String(columns.match_score);
  }
  if (columns.reuse_status !== undefined) {
    values[parts.indexOf("reuse_status")] = `'${columns.reuse_status}'`;
  }
  if (columns.provenance !== undefined) {
    values[parts.indexOf("provenance")] = `'${columns.provenance}'::jsonb`;
  }
  if (columns.cost_impact !== undefined) {
    values[parts.indexOf("cost_impact")] = `'${columns.cost_impact}'::jsonb`;
  }
  return {
    sql: `insert into itotori_translation_memory_reuse_events (${parts.join(", ")}) values (${values.join(", ")})`,
    params: [] as unknown[],
  };
}

// --- the parity suites ------------------------------------------------------

describe("translation memory migration drift", () => {
  describe("itotori_translation_memory_segments", () => {
    it("the Drizzle table targets the migration's table name", () => {
      expect(isTable(translationMemorySegments)).toBe(true);
      expect(drizzleTableName(translationMemorySegments)).toBe(SEGMENTS_TABLE_NAME);
    });

    it("the Drizzle model declares every check constraint the migration enforces", () => {
      const declared = drizzleDeclaredCheckNames(translationMemorySegments);
      for (const name of EXPECTED_SEGMENT_CHECK_NAMES) {
        expect(declared.has(name), `Drizzle must declare check ${name}`).toBe(true);
      }
    });

    it("the migrated schema registers every segment check the Drizzle model declares", async () => {
      const context = await isolatedMigratedContext();
      try {
        const rows = await context.db.execute(constraintQueryFor(SEGMENTS_TABLE_NAME));
        const dbChecks = new Set(
          rows.rows
            .filter((row) => String(row.constraint_type) === "c")
            .map((row) => String(row.constraint_name)),
        );
        const declared = drizzleDeclaredCheckNames(translationMemorySegments);
        for (const name of declared) {
          expect(dbChecks.has(name), `migration must register check ${name}`).toBe(true);
        }
        for (const name of EXPECTED_SEGMENT_CHECK_NAMES) {
          expect(dbChecks.has(name), `migration must register check ${name}`).toBe(true);
        }
      } finally {
        await context.close();
      }
    });

    it("rejects an invalid segment status at the database layer (status check)", async () => {
      const context = await isolatedMigratedContext();
      try {
        await seedTranslationMemoryProject(context.db);
        const insert = segmentInsert({ status: "archived" });
        expect(await captureCheckViolation(context, insert.sql, insert.params)).toBe("23514");
        // Boundary values (reusable, blocked) are accepted by the same CHECK.
        for (const [i, valid] of ["reusable", "blocked"].entries()) {
          const probe = segmentInsert({
            status: valid,
            memorySegmentId: `tm-drift-status-${valid}-${i}`,
          });
          expect(await captureCheckViolation(context, probe.sql, probe.params)).toBe(undefined);
        }
      } finally {
        await context.close();
      }
    });

    it("rejects a non-object segment provenance at the database layer (provenance check)", async () => {
      const context = await isolatedMigratedContext();
      try {
        await seedTranslationMemoryProject(context.db);
        const insert = segmentInsert({ provenance: JSON.stringify(["not", "an", "object"]) });
        expect(await captureCheckViolation(context, insert.sql, insert.params)).toBe("23514");
        // An empty object is the default and must continue to pass.
        const probe = segmentInsert({
          provenance: "{}",
          memorySegmentId: "tm-drift-prov-empty",
        });
        expect(await captureCheckViolation(context, probe.sql, probe.params)).toBe(undefined);
      } finally {
        await context.close();
      }
    });
  });

  describe("itotori_translation_memory_reuse_events", () => {
    it("the Drizzle table targets the migration's table name", () => {
      expect(isTable(translationMemoryReuseEvents)).toBe(true);
      expect(drizzleTableName(translationMemoryReuseEvents)).toBe(REUSE_EVENTS_TABLE_NAME);
    });

    it("the Drizzle model declares every check constraint the migration enforces", () => {
      const declared = drizzleDeclaredCheckNames(translationMemoryReuseEvents);
      for (const name of EXPECTED_REUSE_EVENT_CHECK_NAMES) {
        expect(declared.has(name), `Drizzle must declare check ${name}`).toBe(true);
      }
    });

    it("the migrated schema registers every reuse-event check the Drizzle model declares", async () => {
      const context = await isolatedMigratedContext();
      try {
        const rows = await context.db.execute(constraintQueryFor(REUSE_EVENTS_TABLE_NAME));
        const dbChecks = new Set(
          rows.rows
            .filter((row) => String(row.constraint_type) === "c")
            .map((row) => String(row.constraint_name)),
        );
        const declared = drizzleDeclaredCheckNames(translationMemoryReuseEvents);
        for (const name of declared) {
          expect(dbChecks.has(name), `migration must register check ${name}`).toBe(true);
        }
        for (const name of EXPECTED_REUSE_EVENT_CHECK_NAMES) {
          expect(dbChecks.has(name), `migration must register check ${name}`).toBe(true);
        }
      } finally {
        await context.close();
      }
    });

    async function seedReuseEventFixture(
      context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
    ) {
      await seedTranslationMemoryProject(context.db);
      await context.pool.query(
        `insert into itotori_translation_memory_segments
           (memory_segment_id, project_id, locale_branch_id, source_revision_id,
            source_unit_key, source_occurrence_id, source_hash, source_fingerprint,
            source_text, target_locale, target_text, status)
         values
           ('tm-drift-base', 'project-tm-drift-145', 'locale-en-us-drift-145',
            'bridge-tm-drift-145:bundle-revision', 'scene.drift-145', 'occurrence-drift-145',
            'hash:drift-145', 'fingerprint:drift-145', 'おはようございます。',
            'en-US', 'Good morning.', 'reusable')`,
      );
    }

    it("rejects an invalid match_kind at the database layer (match_kind check)", async () => {
      const context = await isolatedMigratedContext();
      try {
        await seedReuseEventFixture(context);
        const insert = reuseEventInsert({ match_kind: "partial" });
        expect(await captureCheckViolation(context, insert.sql, insert.params)).toBe("23514");
        for (const [i, valid] of ["exact", "fuzzy"].entries()) {
          const probe = reuseEventInsert({
            match_kind: valid,
            reuseEventId: `tm-drift-event-kind-${valid}-${i}`,
          });
          expect(await captureCheckViolation(context, probe.sql, probe.params)).toBe(undefined);
        }
      } finally {
        await context.close();
      }
    });

    it("rejects an out-of-range match_score at the database layer (match_score check)", async () => {
      const context = await isolatedMigratedContext();
      try {
        await seedReuseEventFixture(context);
        for (const [i, outOfRange] of [-1, 1001, 5000].entries()) {
          const insert = reuseEventInsert({
            match_score: outOfRange,
            reuseEventId: `tm-drift-event-range-${outOfRange}-${i}`,
          });
          expect(
            await captureCheckViolation(context, insert.sql, insert.params),
            `expected match_score=${outOfRange} to be rejected`,
          ).toBe("23514");
        }
        // Boundaries (0 and 1000) are accepted.
        for (const [i, boundary] of [0, 1000].entries()) {
          const probe = reuseEventInsert({
            match_score: boundary,
            reuseEventId: `tm-drift-event-boundary-${boundary}-${i}`,
          });
          expect(await captureCheckViolation(context, probe.sql, probe.params)).toBe(undefined);
        }
      } finally {
        await context.close();
      }
    });

    it("rejects an invalid reuse_status at the database layer (reuse_status check)", async () => {
      const context = await isolatedMigratedContext();
      try {
        await seedReuseEventFixture(context);
        const insert = reuseEventInsert({ reuse_status: "discarded" });
        expect(await captureCheckViolation(context, insert.sql, insert.params)).toBe("23514");
        for (const [i, valid] of ["suggested", "applied"].entries()) {
          const probe = reuseEventInsert({
            reuse_status: valid,
            reuseEventId: `tm-drift-event-status-${valid}-${i}`,
          });
          expect(await captureCheckViolation(context, probe.sql, probe.params)).toBe(undefined);
        }
      } finally {
        await context.close();
      }
    });

    it("rejects a non-object reuse-event provenance at the database layer (provenance check)", async () => {
      const context = await isolatedMigratedContext();
      try {
        await seedReuseEventFixture(context);
        const insert = reuseEventInsert({
          provenance: JSON.stringify(["not", "an", "object"]),
        });
        expect(await captureCheckViolation(context, insert.sql, insert.params)).toBe("23514");
      } finally {
        await context.close();
      }
    });

    it("rejects a non-object cost_impact at the database layer (cost_impact check)", async () => {
      const context = await isolatedMigratedContext();
      try {
        await seedReuseEventFixture(context);
        const insert = reuseEventInsert({
          cost_impact: JSON.stringify(["not", "an", "object"]),
        });
        expect(await captureCheckViolation(context, insert.sql, insert.params)).toBe("23514");
      } finally {
        await context.close();
      }
    });
  });
});
