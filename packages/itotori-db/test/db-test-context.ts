import { randomBytes } from "node:crypto";
import pg from "pg";
import { createDatabaseContext, type DatabaseContext } from "../src/connection.js";
import { migrate } from "../src/migrations.js";

export async function isolatedMigratedContext(): Promise<DatabaseContext & { databaseUrl: string }> {
  const databaseUrl = requiredDatabaseUrl();
  const schemaName = isolatedSchemaName();
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let context: DatabaseContext | undefined;

  try {
    await admin.query(`create schema ${quoteIdentifier(schemaName)}`);
    const isolatedUrl = databaseUrlWithSearchPath(databaseUrl, schemaName);
    await migrate(isolatedUrl);
    context = createDatabaseContext(isolatedUrl);
    return {
      ...context,
      databaseUrl: isolatedUrl,
      close: async () => {
        try {
          await context?.close();
        } finally {
          try {
            await admin.query(`drop schema if exists ${quoteIdentifier(schemaName)} cascade`);
          } finally {
            await admin.end();
          }
        }
      },
    };
  } catch (error) {
    try {
      await context?.close();
    } finally {
      try {
        await admin.query(`drop schema if exists ${quoteIdentifier(schemaName)} cascade`);
      } catch {
        // Preserve the original setup failure; failed setup may not have created the schema.
      } finally {
        await admin.end();
      }
    }
    throw error;
  }
}

function requiredDatabaseUrl(): string {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for DB-backed repository tests");
  }
  return process.env.DATABASE_URL;
}

function isolatedSchemaName(): string {
  return `itotori_test_${process.pid}_${Date.now()}_${randomBytes(6).toString("hex")}`;
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
