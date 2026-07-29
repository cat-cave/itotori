import { migrations } from "./migrations-registry.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapLocalUser } from "./authorization.js";
import { withDatabase } from "./connection.js";

/**
 * Drop the entire application schema and re-apply every migration, leaving a
 * pristine migrated database. This is the canonical dev/CI reset: it depends on
 * no per-table truncate list (which drifts as tables are added/removed) and no
 * application service graph — only the migration registry that owns the schema.
 */
export async function resetDatabase(databaseUrl?: string): Promise<void> {
  await withDatabase(async ({ pool }) => {
    const client = await pool.connect();
    try {
      await client.query("drop schema public cascade");
      await client.query("create schema public");
    } finally {
      client.release();
    }
  }, databaseUrl);
  await migrate(databaseUrl);
}

export async function migrate(databaseUrl?: string): Promise<void> {
  await withDatabase(async ({ db, pool }) => {
    const client = await pool.connect();
    let lockAcquired = false;
    try {
      await client.query("select pg_advisory_lock(8800030000000001)");
      lockAcquired = true;

      await client.query(`
        create table if not exists itotori_schema_migrations (
          migration_id text primary key,
          checksum text not null,
          applied_at timestamptz not null default now()
        )
      `);

      for (const migration of migrations) {
        const body = readFileSync(migrationPath(migration.file), "utf8");
        const checksum = createHash("sha256").update(body).digest("hex");
        const legacyIds = "legacyIds" in migration ? [...migration.legacyIds] : [];
        try {
          await client.query("begin");
          const applied = await client.query<{ checksum: string }>(
            "select checksum from itotori_schema_migrations where migration_id = $1 for update",
            [migration.id],
          );
          const existing = applied.rows[0];
          if (existing) {
            if (existing.checksum !== checksum) {
              throw new Error(`migration ${migration.id} checksum mismatch`);
            }
          } else if (legacyIds.length > 0) {
            const legacyApplied = await client.query<{
              migration_id: string;
              checksum: string;
            }>(
              `
                select migration_id, checksum
                from itotori_schema_migrations
                where migration_id = any($1::text[])
                for update
              `,
              [legacyIds],
            );
            const mismatchedLegacy = legacyApplied.rows.find(
              (legacy) => legacy.checksum !== checksum,
            );
            if (mismatchedLegacy !== undefined) {
              throw new Error(
                `migration ${migration.id} legacy migration ${mismatchedLegacy.migration_id} checksum mismatch`,
              );
            }
            if (legacyApplied.rows.length > 0) {
              await client.query(
                "insert into itotori_schema_migrations (migration_id, checksum) values ($1, $2)",
                [migration.id, checksum],
              );
            } else {
              await client.query(body);
              await client.query(
                "insert into itotori_schema_migrations (migration_id, checksum) values ($1, $2)",
                [migration.id, checksum],
              );
            }
          } else {
            await client.query(body);
            await client.query(
              "insert into itotori_schema_migrations (migration_id, checksum) values ($1, $2)",
              [migration.id, checksum],
            );
          }
          await client.query("commit");
        } catch (error) {
          await client.query("rollback");
          throw error;
        }
      }
    } finally {
      if (lockAcquired) {
        await client.query("select pg_advisory_unlock(8800030000000001)");
      }
      client.release();
    }

    await bootstrapLocalUser(db);
  }, databaseUrl);
}

function migrationPath(file: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "migrations", file);
}
