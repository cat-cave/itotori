import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapLocalUser } from "./authorization.js";
import { withDatabase } from "./connection.js";

export async function migrate(databaseUrl?: string): Promise<void> {
  await withDatabase(async ({ db, pool }) => {
    await pool.query(`
      create table if not exists itotori_schema_migrations (
        migration_id text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);

    for (const migration of migrations) {
      const body = readFileSync(migrationPath(migration.file), "utf8");
      const checksum = createHash("sha256").update(body).digest("hex");
      const client = await pool.connect();
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
      } finally {
        client.release();
      }
    }

    await bootstrapLocalUser(db);
  }, databaseUrl);
}

const migrations = [
  {
    id: "0001_hello_world",
    file: "0001_hello_world.sql",
  },
  {
    id: "0002_permissions",
    file: "0002_permissions.sql",
  },
  {
    id: "0003_persistence_v02",
    file: "0003_persistence_v02.sql",
  },
  {
    id: "0004_feedback_sources",
    file: "0004_feedback_sources.sql",
  },
] as const;

function migrationPath(file: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "migrations", file);
}
