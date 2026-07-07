// ITOTORI-140 — branch policy/glossary references schema-drift guard.
//
// Migration 0022 enforces a set of constraints on
// `itotori_branch_policy_glossary_references` that the repository layer
// (branch-reference-repository) depends on: the event relationship
// (event_id -> itotori_events on delete set null) plus four CHECK
// constraints (positive version_sequence, jsonb array/object shape guards).
// Historically the Drizzle table representation omitted these, so a
// schema-drift introspection comparing Drizzle metadata to the live DB would
// under-report what the runtime enforces.
//
// This suite pins PARITY between the two sources of truth:
//   (1) the Drizzle table object declared in src/schema.ts, and
//   (2) the constraints actually registered on a freshly-migrated Postgres
//       schema (introspected via pg_constraint).
// If either side drifts (a constraint added/removed in only one), the
// matching assertion fails.

import { getTableName, isTable, sql, type Table } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { branchPolicyGlossaryReferences } from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const TABLE_NAME = "itotori_branch_policy_glossary_references";

// The constraints migration 0022 enforces and the Drizzle model must mirror.
const EXPECTED_CHECK_NAMES = [
  "itotori_branch_policy_glossary_refs_sequence_check",
  "itotori_branch_policy_glossary_refs_term_refs_check",
  "itotori_branch_policy_glossary_refs_review_refs_check",
  "itotori_branch_policy_glossary_refs_metadata_check",
] as const;

const EVENT_FK_COLUMN = "event_id";
const EVENT_FK_TARGET_TABLE = "itotori_events";

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

/**
 * Foreign keys declared on the Drizzle table, normalized to
 * `{ column, targetTable, onDelete }` triples. Covers both inline
 * `.references()` FKs and extra-config `foreignKey()` entries.
 */
function drizzleDeclaredForeignKeys(
  table: Table,
): Array<{ column: string; targetTable: string; onDelete: string }> {
  const out: Array<{ column: string; targetTable: string; onDelete: string }> = [];
  const inlineFks = (
    table as unknown as {
      [k: symbol]: unknown[];
    }
  )[INLINE_FK_SYMBOL];
  if (Array.isArray(inlineFks)) {
    for (const fk of inlineFks) {
      if (!isForeignKeyLike(fk)) continue;
      const ref = fk.reference();
      const targetName = getTableName(ref.foreignTable);
      for (const column of ref.columns) {
        out.push({ column: column.name, targetTable: targetName, onDelete: fk.onDelete });
      }
    }
  }
  for (const item of readDrizzleExtraConfigItems(table)) {
    if (!isForeignKeyLike(item)) continue;
    const ref = item.reference();
    const targetName = getTableName(ref.foreignTable);
    for (const column of ref.columns) {
      out.push({ column: column.name, targetTable: targetName, onDelete: item.onDelete });
    }
  }
  return out;
}

// --- pg_constraint introspection query --------------------------------------

const CONSTRAINT_QUERY = sql`
  select
    con.contype as constraint_type,
    con.conname as constraint_name,
    pg_get_constraintdef(con.oid) as constraint_definition
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = current_schema()
    and c.relname = ${TABLE_NAME}
  order by con.contype, con.conname
`;

// --- the parity suite -------------------------------------------------------

describe("branch policy/glossary references migration drift", () => {
  it("the Drizzle table targets the migration's table name", () => {
    expect(isTable(branchPolicyGlossaryReferences)).toBe(true);
    expect(drizzleTableName(branchPolicyGlossaryReferences)).toBe(TABLE_NAME);
  });

  it("the Drizzle model declares every check constraint the migration enforces", () => {
    const declared = drizzleDeclaredCheckNames(branchPolicyGlossaryReferences);
    for (const name of EXPECTED_CHECK_NAMES) {
      expect(declared.has(name), `Drizzle must declare check ${name}`).toBe(true);
    }
  });

  it("the Drizzle model declares the event_id -> itotori_events relationship", () => {
    const fks = drizzleDeclaredForeignKeys(branchPolicyGlossaryReferences);
    const eventFk = fks.find(
      (fk) => fk.column === EVENT_FK_COLUMN && fk.targetTable === EVENT_FK_TARGET_TABLE,
    );
    expect(eventFk, "Drizzle must model event_id -> itotori_events").toBeDefined();
    // SQL migration: `on delete set null`.
    expect(eventFk?.onDelete).toBe("set null");
  });

  it("the migrated schema registers every check constraint the Drizzle model declares", async () => {
    const context = await isolatedMigratedContext();
    try {
      const rows = await context.db.execute(CONSTRAINT_QUERY);
      const dbChecks = new Set(
        rows.rows
          .filter((row) => String(row.constraint_type) === "c")
          .map((row) => String(row.constraint_name)),
      );
      const declared = drizzleDeclaredCheckNames(branchPolicyGlossaryReferences);
      // Every check the Drizzle model declares must exist on the migrated DB.
      for (const name of declared) {
        expect(dbChecks.has(name), `migration must register check ${name}`).toBe(true);
      }
      // And the specific acceptance-critical checks named in migration 0022.
      for (const name of EXPECTED_CHECK_NAMES) {
        expect(dbChecks.has(name), `migration must register check ${name}`).toBe(true);
      }
    } finally {
      await context.close();
    }
  });

  it("the migrated schema registers the event_id -> itotori_events foreign key", async () => {
    const context = await isolatedMigratedContext();
    try {
      const rows = await context.db.execute(CONSTRAINT_QUERY);
      const fkDefs = rows.rows
        .filter((row) => String(row.constraint_type) === "f")
        .map((row) => String(row.constraint_definition));
      expect(
        fkDefs.some(
          (def) =>
            /FOREIGN KEY\s*\(\s*event_id\s*\)/i.test(def) &&
            new RegExp(`REFERENCES\\s+${EVENT_FK_TARGET_TABLE}\\s*\\(`, "i").test(def) &&
            /ON DELETE\s+SET\s+NULL/i.test(def),
        ),
        `expected event_id -> ${EVENT_FK_TARGET_TABLE} on delete set null; saw:\n${fkDefs.join("\n")}`,
      ).toBe(true);
    } finally {
      await context.close();
    }
  });

  it("rejects a non-positive version_sequence at the database layer (sequence check)", async () => {
    const context = await isolatedMigratedContext();
    try {
      let captured: unknown;
      try {
        await context.pool.query(
          `insert into itotori_branch_policy_glossary_references
             (reference_id, project_id, locale_branch_id, version_sequence,
              glossary_content_hash, update_reason)
           values ($1, $2, $3, $4, $5, $6)`,
          [
            "ref-drift-seq",
            "project-drift-140",
            "locale-branch-drift-140",
            0,
            "hash:drift",
            "drift probe",
          ],
        );
      } catch (error) {
        captured = error;
      }
      // 23514 = check_violation.
      expect(pgErrorCodeOf(captured)).toBe("23514");
    } finally {
      await context.close();
    }
  });

  it("rejects a non-array glossary_term_refs at the database layer (term-refs check)", async () => {
    const context = await isolatedMigratedContext();
    try {
      let captured: unknown;
      try {
        await context.pool.query(
          `insert into itotori_branch_policy_glossary_references
             (reference_id, project_id, locale_branch_id, version_sequence,
              glossary_content_hash, glossary_term_refs, update_reason)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            "ref-drift-terms",
            "project-drift-140",
            "locale-branch-drift-140",
            1,
            "hash:drift",
            JSON.stringify({ not: "an array" }),
            "drift probe",
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

  it("rejects a non-object metadata blob at the database layer (metadata check)", async () => {
    const context = await isolatedMigratedContext();
    try {
      let captured: unknown;
      try {
        await context.pool.query(
          `insert into itotori_branch_policy_glossary_references
             (reference_id, project_id, locale_branch_id, version_sequence,
              glossary_content_hash, metadata, update_reason)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            "ref-drift-meta",
            "project-drift-140",
            "locale-branch-drift-140",
            1,
            "hash:drift",
            JSON.stringify(["not", "an", "object"]),
            "drift probe",
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
});

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
