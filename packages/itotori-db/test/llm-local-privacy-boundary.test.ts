import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { localUserId, permissionValues, type AuthorizationActor } from "../src/authorization.js";
import type { DatabaseContext } from "../src/connection.js";
import { permissionBasedLlmContentRead as createContentAccess } from "../src/llm-content-access.js";
import {
  ItotoriLlmCallMemoRepository,
  type LlmMemoCipher,
} from "../src/repositories/llm-call-memo-repository.js";
import { ItotoriLlmRetentionRepository } from "../src/repositories/llm-retention-repository.js";
import { ItotoriPrincipalRepository } from "../src/repositories/principal-repository.js";
import { authAccountMemberships } from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const postgresDescribe = process.env.DATABASE_URL ? describe : describe.skip;
const localActor: AuthorizationActor = { userId: localUserId };

class ProofCipher implements LlmMemoCipher {
  readonly #keys = new Map<string, Buffer>();
  #ordinal = 0;
  openCalls = 0;

  async seal(plaintext: string): Promise<{ ciphertext: Uint8Array; keyRef: string }> {
    const key = randomBytes(32);
    const keyRef = `proof-key:${(this.#ordinal += 1)}`;
    this.#keys.set(keyRef, key);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { ciphertext: Buffer.concat([nonce, cipher.getAuthTag(), encrypted]), keyRef };
  }

  async open(ciphertext: Uint8Array, keyRef: string): Promise<string> {
    this.openCalls += 1;
    const key = this.#keys.get(keyRef);
    if (!key) throw new Error("envelope key is destroyed");
    const bytes = Buffer.from(ciphertext);
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  }

  async destroyKey(keyRef: string): Promise<void> {
    this.#keys.delete(keyRef);
  }
}

postgresDescribe("rebuilt LLM local privacy boundary", () => {
  it("stores content only as registered ciphertext and rejects a plaintext content column", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new ProofCipher();
    const sentinel = "PRIVATE_STORAGE_SENTINEL";
    try {
      const repository = new ItotoriLlmCallMemoRepository(
        context.pool,
        cipher,
        createContentAccess(context.db, localActor),
      );
      await repository.singleflight(memoInput("1", sentinel));

      await expect(
        assertNoPlaintextInRegisteredCiphertextColumns(context.pool, sentinel),
      ).resolves.toBeUndefined();
      await expect(assertNoPlaintextContentColumns(context.pool)).resolves.toBeUndefined();

      const client = await context.pool.connect();
      try {
        await client.query("begin");
        await client.query("alter table itotori_llm_human_inputs add column prompt_text text");
        await expect(assertNoPlaintextContentColumns(client)).rejects.toThrow(/prompt_text/u);
      } finally {
        await client.query("rollback");
        client.release();
      }
    } finally {
      await context.close();
    }
  });

  it("requires the exact content.read permission before memo decryption", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new ProofCipher();
    const input = memoInput("2", "PERMISSION_BOUND_CONTENT");
    try {
      const writer = new ItotoriLlmCallMemoRepository(
        context.pool,
        cipher,
        createContentAccess(context.db, localActor),
      );
      await writer.singleflight(input);

      const principals = new ItotoriPrincipalRepository(context.db);
      await principals.createAccount(localActor, {
        accountId: "privacy-account",
        slug: "privacy-account",
        name: "Privacy account",
      });
      await principals.createPrincipal(localActor, {
        kind: "human_user",
        principalId: "privacy-principal",
        userId: "privacy-user",
        displayName: "Privacy user",
      });
      await context.db.insert(authAccountMemberships).values({
        membershipId: "privacy-membership",
        accountId: "privacy-account",
        userId: "privacy-user",
      });
      await principals.createPermissionSet(localActor, {
        actorPrincipalId: "privacy-principal",
        permissionSetId: "misleading-label",
        accountId: "privacy-account",
        name: "Content access",
        permissions: [permissionValues.catalogRead],
      });
      await principals.grantPermissionSet(localActor, {
        actorPrincipalId: "privacy-principal",
        targetPrincipalId: "privacy-principal",
        permissionSetId: "misleading-label",
      });

      const actor = { userId: "privacy-user" };
      const reader = new ItotoriLlmCallMemoRepository(
        context.pool,
        cipher,
        createContentAccess(context.db, actor),
      );
      const openCallsBeforeDenial = cipher.openCalls;
      await expect(reader.singleflight(input)).rejects.toMatchObject({
        name: "AuthorizationError",
        permission: "content.read",
      });
      expect(cipher.openCalls).toBe(openCallsBeforeDenial);

      await principals.addPermissionToSet(localActor, {
        actorPrincipalId: "privacy-principal",
        permissionSetId: "misleading-label",
        permission: permissionValues.contentRead,
      });
      await expect(reader.singleflight(input)).resolves.toMatchObject({
        kind: "completed",
        memoHit: true,
      });
      expect(cipher.openCalls).toBe(openCallsBeforeDenial + 2);
    } finally {
      await context.close();
    }
  });

  it("deletes expired ciphertext, destroys its key, and retains an idempotent tombstone", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new ProofCipher();
    const sealed = await cipher.seal("RETENTION_PRIVATE_SENTINEL");
    const createdAt = "2020-01-01T00:00:00.000Z";
    try {
      await context.pool.query(
        `insert into itotori_llm_human_inputs (
           input_id, input_kind, subject_ref, human_input_ciphertext, human_input_key_ref,
           human_input_content_hash, created_at, retention_deadline
         ) values ($1, 'feedback', 'subject:1', $2, $3, $4, $5, $6)`,
        [
          "expired-input",
          sealed.ciphertext,
          sealed.keyRef,
          hash("RETENTION_PRIVATE_SENTINEL"),
          createdAt,
          "2020-01-02T00:00:00.000Z",
        ],
      );

      const retention = new ItotoriLlmRetentionRepository(context.pool, cipher);
      await expect(retention.deleteExpired(new Date("2020-01-03T00:00:00.000Z"))).resolves.toEqual({
        deletedRows: 1,
        destroyedKeyRefs: 1,
        tables: { itotori_llm_human_inputs: 1 },
      });
      const tombstone = await context.pool.query<{
        human_input_ciphertext: Buffer | null;
        deletion_state: string;
        deleted_at: Date | null;
      }>(
        `select human_input_ciphertext, deletion_state, deleted_at
         from itotori_llm_human_inputs where input_id = 'expired-input'`,
      );
      expect(tombstone.rows[0]).toMatchObject({
        human_input_ciphertext: null,
        deletion_state: "deleted",
      });
      expect(tombstone.rows[0]?.deleted_at).not.toBeNull();
      await expect(cipher.open(sealed.ciphertext, sealed.keyRef)).rejects.toThrow(/destroyed/u);
      await expect(retention.deleteExpired(new Date("2020-01-03T00:00:00.000Z"))).resolves.toEqual({
        deletedRows: 0,
        destroyedKeyRefs: 0,
        tables: {},
      });
    } finally {
      await context.close();
    }
  });
});

type RegisteredCiphertextColumn = {
  table_name: string;
  ciphertext_column: string;
};

function memoInput(digit: string, content: string) {
  const memoKey = hash(`memo:${digit}`);
  return {
    memoKey,
    semanticHash: hash(`semantic:${digit}`),
    schemaVersion: "proof:v1",
    requestJson: JSON.stringify({ content }),
    admission: {
      scope: `privacy:${digit}`,
      confirmedCostCapUsd: "1",
      maxAttemptExposureUsd: "1",
      deadlineMs: 60_000,
    },
    execute: async () => ({
      kind: "completed" as const,
      responseJson: JSON.stringify({ content }),
      outcomeJson: JSON.stringify({ content }),
      outcomeKind: "terminal" as const,
      generationId: null,
      requestedModel: "provider:model-v4",
      providerPolicy: {},
      served: { status: "unknown" as const },
      routerAttempts: [],
      usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, cachedTokens: 0 },
      billing: { status: "billing_unknown" as const },
      reportedCostUsd: null,
      completedAt: new Date().toISOString(),
      responseEvent: {
        eventId: hash(`event:${digit}`),
        schemaVersion: "event:v1",
        parentEventIds: [] as const,
        snapshotKind: "context" as const,
        snapshotId: `snapshot:${digit}`,
        actorRole: "Q1",
        bodyJson: JSON.stringify({ content }),
      },
    }),
  };
}

async function assertNoPlaintextInRegisteredCiphertextColumns(
  queryable: Pick<DatabaseContext["pool"], "query">,
  plaintext: string,
): Promise<void> {
  const registry = await queryable.query<RegisteredCiphertextColumn>(`
    select table_name, ciphertext_column
    from itotori_llm_encrypted_column_registry
    order by table_name, ciphertext_column
  `);
  const plaintextBytes = Buffer.from(plaintext);
  for (const { table_name: tableName, ciphertext_column: ciphertextColumn } of registry.rows) {
    const rows = await queryable.query<{ ciphertext: Uint8Array }>(
      `select ${quoteIdentifier(ciphertextColumn)} as ciphertext
       from ${quoteIdentifier(tableName)}
       where ${quoteIdentifier(ciphertextColumn)} is not null`,
    );
    for (const { ciphertext } of rows.rows) {
      if (Buffer.from(ciphertext).includes(plaintextBytes)) {
        throw new Error(`plaintext sentinel found in ${tableName}.${ciphertextColumn}`);
      }
    }
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function assertNoPlaintextContentColumns(
  queryable: Pick<DatabaseContext["pool"], "query">,
): Promise<void> {
  const columns = await queryable.query<{ table_name: string; column_name: string }>(`
    select table_name, column_name from information_schema.columns
    where table_schema = current_schema()
      and table_name in (
        select distinct table_name from itotori_llm_encrypted_column_registry
      )
  `);
  const contentName =
    /(?:source|target|prompt|response|message|content|output|argument|result|excerpt|ocr|body|payload)/iu;
  const metadataName = /(?:hash|_id|key|ref|_at|state|deadline|length|count|version)/iu;
  const violations = columns.rows.filter(
    ({ column_name: name }) =>
      contentName.test(name) &&
      !metadataName.test(name) &&
      !/(?:encrypted|ciphertext|cipher)/iu.test(name) &&
      name !== "validation_result",
  );
  if (violations.length > 0) {
    throw new Error(
      `plaintext rebuilt-LLM content columns: ${violations
        .map((column) => `${column.table_name}.${column.column_name}`)
        .join(", ")}`,
    );
  }
}

function hash(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
