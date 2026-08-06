import { randomBytes } from "node:crypto";

import pg from "pg";

import { createDatabaseContext, migrate } from "../dist/index.js";

/**
 * Run `operation` against a freshly migrated, isolated schema, then drop it.
 * Product identity proofs never share schema state across cases or processes.
 */
export async function withIsolatedIdentityDatabase(operation) {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) {
    throw new Error("identity-behavior-database-unavailable");
  }
  const schemaName = `itotori_identity_behavior_${process.pid}_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let context;
  try {
    await admin.query(`create schema "${schemaName}"`);
    const isolated = new URL(databaseUrl);
    isolated.searchParams.set("options", `-csearch_path=${schemaName}`);
    await migrate(isolated.toString());
    context = createDatabaseContext(isolated.toString());
    return await operation(context);
  } finally {
    try {
      await context?.close();
    } finally {
      try {
        await admin.query(`drop schema if exists "${schemaName}" cascade`);
      } finally {
        await admin.end();
      }
    }
  }
}

export function isJwtShaped(token) {
  if (typeof token !== "string" || token.length === 0) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  return parts.every((part) => part.length > 0 && /^[A-Za-z0-9_-]+$/u.test(part));
}

export async function captureError(operation) {
  try {
    await operation();
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}
