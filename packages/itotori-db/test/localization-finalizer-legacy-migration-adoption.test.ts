import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { describe, expect, it } from "vitest";

import { migrate, migrations } from "../src/migrations.js";

const here = dirname(fileURLToPath(import.meta.url));

const rebasedMigrationIds = [
  "0083_context_entry_versions",
  "0084_retire_legacy_semantic_agent_tables",
  "0085_localization_run_finalizer",
  "0086_terminal_finalizer_integrity",
  "0087_playable_patch_immutability",
  "0088_playable_patch_idempotent_membership",
] as const;

const legacyFinalizerMigrations = [
  {
    canonicalId: "0085_localization_run_finalizer",
    legacyId: "0083_localization_run_finalizer",
  },
  {
    canonicalId: "0086_terminal_finalizer_integrity",
    legacyId: "0084_terminal_finalizer_integrity",
  },
  {
    canonicalId: "0087_playable_patch_immutability",
    legacyId: "0085_playable_patch_immutability",
  },
  {
    canonicalId: "0088_playable_patch_idempotent_membership",
    legacyId: "0086_playable_patch_idempotent_membership",
  },
] as const;

describe("legacy finalizer migration ID adoption", () => {
  it("adopts pre-rebase finalizer rows while applying the rebased context migrations", async () => {
    await withLegacyFinalizerDeployment(async ({ pool, schemaUrl }) => {
      await migrate(schemaUrl);

      const applied = await migrationChecksums(pool, [
        ...rebasedMigrationIds,
        ...legacyFinalizerMigrations.map(({ legacyId }) => legacyId),
      ]);

      expect([...applied.keys()].sort()).toEqual(
        [
          ...rebasedMigrationIds,
          ...legacyFinalizerMigrations.map(({ legacyId }) => legacyId),
        ].sort(),
      );
      for (const { canonicalId, legacyId } of legacyFinalizerMigrations) {
        const checksum = checksumForMigration(canonicalId);
        expect(applied.get(canonicalId)).toBe(checksum);
        expect(applied.get(legacyId)).toBe(checksum);
      }

      await expect(migrate(schemaUrl)).resolves.toBeUndefined();
    });
  });

  it("rejects a mismatched legacy finalizer checksum instead of replaying its SQL", async () => {
    await withLegacyFinalizerDeployment(async ({ pool, schemaUrl }) => {
      await expect(migrate(schemaUrl)).rejects.toThrow(
        "migration 0085_localization_run_finalizer legacy migration 0083_localization_run_finalizer checksum mismatch",
      );

      const applied = await migrationChecksums(pool, ["0085_localization_run_finalizer"]);
      expect(applied.has("0085_localization_run_finalizer")).toBe(false);
    }, "0083_localization_run_finalizer");
  });
});

async function withLegacyFinalizerDeployment(
  test: (context: { pool: pg.Pool; schemaUrl: string }) => Promise<void>,
  corruptLegacyMigrationId?: string,
): Promise<void> {
  const databaseUrl = requiredDatabaseUrl();
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const schemaName = `itotori_finalizer_legacy_${process.pid}_${Date.now()}_${randomBytes(6).toString("hex")}`;
  const schemaUrl = databaseUrlWithSearchPath(databaseUrl, schemaName);

  await admin.query(`create schema ${quoteIdentifier(schemaName)}`);
  const pool = new pg.Pool({ connectionString: schemaUrl });
  try {
    await migrateThroughCostAccountBackfill(pool);
    await installLegacyFinalizerMigrations(pool, corruptLegacyMigrationId);
    await test({ pool, schemaUrl });
  } finally {
    await pool.end();
    await admin.query(`drop schema if exists ${quoteIdentifier(schemaName)} cascade`);
    await admin.end();
  }
}

async function migrateThroughCostAccountBackfill(pool: pg.Pool): Promise<void> {
  await pool.query(`
    create table itotori_schema_migrations (
      migration_id text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);

  const backfillIndex = migrations.findIndex(
    (migration) => migration.id === "0082_backfill_localization_run_cost_accounts",
  );
  expect(backfillIndex).toBeGreaterThanOrEqual(0);

  for (const migration of migrations.slice(0, backfillIndex + 1)) {
    const body = migrationSql(migration.file);
    await pool.query(body);
    await recordMigration(pool, migration.id, body);
  }
}

async function installLegacyFinalizerMigrations(
  pool: pg.Pool,
  corruptLegacyMigrationId?: string,
): Promise<void> {
  for (const { canonicalId, legacyId } of legacyFinalizerMigrations) {
    const body = migrationSqlForId(canonicalId);
    await pool.query(body);
    await recordMigration(
      pool,
      legacyId,
      body,
      legacyId === corruptLegacyMigrationId ? "incorrect-checksum" : undefined,
    );
  }
}

async function recordMigration(
  pool: pg.Pool,
  migrationId: string,
  body: string,
  checksum = createHash("sha256").update(body).digest("hex"),
): Promise<void> {
  await pool.query(
    "insert into itotori_schema_migrations (migration_id, checksum) values ($1, $2)",
    [migrationId, checksum],
  );
}

async function migrationChecksums(
  pool: pg.Pool,
  migrationIds: readonly string[],
): Promise<Map<string, string>> {
  const result = await pool.query<{ migration_id: string; checksum: string }>(
    `
      select migration_id, checksum
      from itotori_schema_migrations
      where migration_id = any($1::text[])
    `,
    [migrationIds],
  );
  return new Map(result.rows.map((row) => [row.migration_id, row.checksum]));
}

function checksumForMigration(migrationId: string): string {
  return createHash("sha256").update(migrationSqlForId(migrationId)).digest("hex");
}

function migrationSqlForId(migrationId: string): string {
  const migration = migrations.find((entry) => entry.id === migrationId);
  if (!migration) {
    throw new Error(`migration ${migrationId} is not registered`);
  }
  return migrationSql(migration.file);
}

function migrationSql(file: string): string {
  return readFileSync(join(here, "..", "migrations", file), "utf8");
}

function requiredDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for DB-backed migration tests");
  }
  return databaseUrl;
}

function databaseUrlWithSearchPath(databaseUrl: string, schemaName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`invalid SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}
