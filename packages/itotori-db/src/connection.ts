import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

export type ItotoriDatabase = NodePgDatabase<typeof schema>;

export type DatabaseContext = {
  pool: pg.Pool;
  db: ItotoriDatabase;
  close: () => Promise<void>;
};

export function databaseUrlFromEnv(): string {
  const value = process.env.DATABASE_URL;
  if (!value) {
    throw new Error("DATABASE_URL is required for Itotori database operations");
  }
  return value;
}

export function createDatabaseContext(databaseUrl = databaseUrlFromEnv()): DatabaseContext {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  return {
    pool,
    db: drizzle(pool, { schema }),
    close: () => pool.end(),
  };
}

export async function withDatabase<T>(
  fn: (context: DatabaseContext) => Promise<T>,
  databaseUrl = databaseUrlFromEnv(),
): Promise<T> {
  const context = createDatabaseContext(databaseUrl);
  try {
    return await fn(context);
  } finally {
    await context.close();
  }
}
