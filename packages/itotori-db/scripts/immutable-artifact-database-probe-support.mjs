import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import pg from "pg";

import { createDatabaseContext, migrate } from "../dist/index.js";

export class ArtifactBehaviorCipher {
  #keys = new Map();
  #ordinal = 0;

  async seal(plaintext) {
    const key = randomBytes(32);
    const keyRef = `artifact-behavior-key:${(this.#ordinal += 1)}`;
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    this.#keys.set(keyRef, key);
    return { ciphertext: Buffer.concat([nonce, cipher.getAuthTag(), encrypted]), keyRef };
  }

  async open(ciphertext, keyRef) {
    const key = this.#keys.get(keyRef);
    if (key === undefined) throw new Error("artifact behavior key was released");
    const bytes = Buffer.from(ciphertext);
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  }

  async releaseKeyReference(keyRef) {
    this.#keys.delete(keyRef);
  }
}

export async function withIsolatedArtifactDatabase(operation) {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) throw new Error("artifact-driver-database-unavailable");
  const schemaName = `itotori_artifact_behavior_${process.pid}_${randomBytes(6).toString("hex")}`;
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

export async function retentionTempShadowRejected(pool, sessionId) {
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query("begin");
    inTransaction = true;
    await client.query(`
      create temporary table itotori_auth_sessions (
        session_id text, principal_id text, revoked_at timestamptz, expires_at timestamptz
      );
      create temporary table itotori_auth_principals (principal_id text, disabled_at timestamptz);
      create temporary table itotori_auth_users (user_id text, principal_id text);
      create temporary table itotori_auth_principal_permission_grants (
        principal_id text, permission text
      );
      create temporary table itotori_auth_principal_permission_set_grants (
        principal_id text, permission_set_id text
      );
      create temporary table itotori_auth_permission_sets (permission_set_id text, account_id text);
      create temporary table itotori_auth_permission_set_permissions (
        permission_set_id text, permission text
      );
      create temporary table itotori_auth_accounts (account_id text, disabled_at timestamptz);
      create temporary table itotori_auth_account_memberships (account_id text, user_id text);
    `);
    await client.query(
      `insert into itotori_auth_sessions (session_id, principal_id, expires_at)
       values ($1, 'shadow-principal', now() + interval '1 hour')`,
      [sessionId],
    );
    await client.query(
      "insert into itotori_auth_principals (principal_id) values ('shadow-principal')",
    );
    await client.query(
      "insert into itotori_auth_users (user_id, principal_id) values ('shadow-retention-manager', 'shadow-principal')",
    );
    await client.query(
      "insert into itotori_auth_principal_permission_grants (principal_id, permission) values ('shadow-principal', 'retention.manage')",
    );
    const result = await client.query(
      "select actor_id from itotori_immutable_artifact_retention_actor_for_session($1)",
      [sessionId],
    );
    await client.query("rollback");
    inTransaction = false;
    return result.rowCount === 0;
  } catch {
    return false;
  } finally {
    if (inTransaction) await client.query("rollback").catch(() => undefined);
    client.release();
  }
}
