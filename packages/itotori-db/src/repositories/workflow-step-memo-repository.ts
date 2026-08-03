import { createHash } from "node:crypto";
import type { DatabaseContext } from "../connection.js";
import type { LlmContentReadAuthorizer } from "../llm-content-access.js";
import type { LlmMemoCipher } from "./llm-call-memo-repository.js";

/** Durable encrypted storage for completed logical workflow steps. */
export interface WorkflowStepMemoStore {
  get(memoKey: string): Promise<string | undefined>;
  set(memoKey: string, valueJson: string): Promise<void>;
}

/** The same logical step key may only ever name one completed value. */
export class WorkflowStepMemoConflictError extends Error {
  constructor(readonly memoKey: string) {
    super(`workflow step conflicts with immutable memo ${memoKey}`);
    this.name = "WorkflowStepMemoConflictError";
  }
}

/**
 * PostgreSQL-backed workflow checkpoint cache. Values are sealed before they
 * leave the process, read authorization is required immediately before opening
 * them, and a completed key is immutable even when two workers race to write.
 */
export class ItotoriWorkflowStepMemoRepository implements WorkflowStepMemoStore {
  constructor(
    private readonly pool: DatabaseContext["pool"],
    private readonly cipher: LlmMemoCipher,
    private readonly contentAccess: LlmContentReadAuthorizer,
  ) {}

  async get(memoKey: string): Promise<string | undefined> {
    assertMemoKey(memoKey);
    const row = await this.#find(memoKey);
    if (row === undefined || row.deletion_state !== "active") return undefined;
    if (row.value_ciphertext === null) {
      throw new Error(`active workflow step memo ${memoKey} has no ciphertext`);
    }
    await this.contentAccess.requireContentRead({ contentRef: memoKey, purpose: "memo-replay" });
    const valueJson = await this.cipher.open(row.value_ciphertext, row.value_key_ref);
    if (contentHash(valueJson) !== row.value_content_hash) {
      throw new Error("encrypted workflow step memo content hash mismatch");
    }
    return valueJson;
  }

  async set(memoKey: string, valueJson: string): Promise<void> {
    assertMemoKey(memoKey);
    assertJson(valueJson);
    const existing = await this.get(memoKey);
    if (existing !== undefined) {
      assertSameValue(memoKey, existing, valueJson);
      return;
    }

    const sealed = await this.cipher.seal(valueJson);
    let persisted = false;
    try {
      const inserted = await this.pool.query(
        `
          insert into itotori_llm_workflow_step_memos (
            memo_key, value_ciphertext, value_key_ref, value_content_hash
          ) values ($1, $2, $3, $4)
          on conflict (memo_key) do nothing
        `,
        [memoKey, sealed.ciphertext, sealed.keyRef, contentHash(valueJson)],
      );
      if (inserted.rowCount === 1) {
        persisted = true;
        return;
      }
    } finally {
      if (!persisted) await this.cipher.releaseKeyReference(sealed.keyRef);
    }

    const raced = await this.get(memoKey);
    if (raced !== undefined) {
      assertSameValue(memoKey, raced, valueJson);
      return;
    }
    throw new WorkflowStepMemoConflictError(memoKey);
  }

  async #find(memoKey: string): Promise<WorkflowStepMemoRow | undefined> {
    const result = await this.pool.query<WorkflowStepMemoRow>(
      `
        select value_ciphertext, value_key_ref, value_content_hash, deletion_state
        from itotori_llm_workflow_step_memos
        where memo_key = $1
      `,
      [memoKey],
    );
    return result.rows[0];
  }
}

type WorkflowStepMemoRow = {
  value_ciphertext: Uint8Array | null;
  value_key_ref: string;
  value_content_hash: string;
  deletion_state: string;
};

function assertMemoKey(value: string): void {
  if (!/^(?:pure-mtl:)?[0-9a-f]{64}$/u.test(value)) {
    throw new Error("workflow step memo key must be a stable SHA-256 digest");
  }
}

function assertJson(value: string): void {
  try {
    JSON.parse(value);
  } catch {
    throw new Error("workflow step memo value must be JSON");
  }
}

function assertSameValue(memoKey: string, expected: string, actual: string): void {
  if (expected !== actual) throw new WorkflowStepMemoConflictError(memoKey);
}

function contentHash(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
