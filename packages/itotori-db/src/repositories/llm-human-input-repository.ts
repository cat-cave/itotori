import type { PoolClient } from "pg";
import type { DatabaseContext } from "../connection.js";
import { llmSha256 } from "../llm-content-address.js";
import type { LlmMemoCipher } from "./llm-call-memo-repository.js";

// A human edit or feedback item is an IMMUTABLE, encrypted, content-addressed
// record. The edit/feedback flow appends one on every direct edit and every
// general feedback BEFORE any inference runs, so the human intent is durable
// the instant the
// request returns. The row is never updated; the deletion trigger only allows a
// retention pass to null the ciphertext. Content lives encrypted at rest; only
// the kind, subject, and content hash are queryable in the clear.

export type LlmHumanInputKind = "edit" | "feedback";

export interface AppendLlmHumanInputInput {
  /** Stable, caller-derived identity. A retry with the same id is idempotent. */
  inputId: string;
  inputKind: LlmHumanInputKind;
  /** The wiki object (or rendering) this input targets: `<wikiKind>:<objectId>`. */
  subjectRef: string;
  /** Canonical JSON of the strict HumanInput. Its hash addresses the record. */
  inputJson: string;
  createdAt: string;
}

export interface LlmHumanInputRecord {
  inputId: string;
  inputKind: LlmHumanInputKind;
  subjectRef: string;
  contentHash: string;
  createdAt: string;
  /** Decrypted canonical HumanInput JSON, or null once retention-deleted. */
  inputJson: string | null;
}

export class LlmHumanInputConflictError extends Error {
  constructor(readonly inputId: string) {
    super(`human input ${inputId} conflicts with an immutable record`);
    this.name = "LlmHumanInputConflictError";
  }
}

/** Append-only store over the existing `itotori_llm_human_inputs` table. This
 * repository is the sole write path the edit/feedback flow uses so a human edit
 * is durable and immutable before any enhancement is launched. */
export class ItotoriLlmHumanInputRepository {
  constructor(
    private readonly pool: DatabaseContext["pool"],
    private readonly cipher: LlmMemoCipher,
  ) {}

  /** Append one immutable human input. Returns the durable record. A same-id
   * retry with identical content is a no-op; a same-id retry with different
   * content is a loud conflict — a HumanInput is never silently overwritten. */
  async append(input: AppendLlmHumanInputInput): Promise<LlmHumanInputRecord> {
    assertNonBlank(input.inputId, "human input id");
    assertNonBlank(input.subjectRef, "human input subject ref");
    if (input.inputKind !== "edit" && input.inputKind !== "feedback") {
      throw new LlmHumanInputConflictError(input.inputId);
    }
    const contentHash = llmSha256(input.inputJson);
    const client = await this.pool.connect();
    let sealed: Awaited<ReturnType<LlmMemoCipher["seal"]>> | null = null;
    try {
      await client.query("begin");
      sealed = await this.cipher.seal(input.inputJson);
      const inserted = await client.query(
        `
          insert into itotori_llm_human_inputs (
            input_id, input_kind, subject_ref,
            human_input_ciphertext, human_input_key_ref, human_input_content_hash,
            created_at, retention_deadline
          ) values (
            $1, $2, $3, $4, $5, $6, $7::timestamptz, $7::timestamptz + interval '365 days'
          )
          on conflict (input_id) do nothing
        `,
        [
          input.inputId,
          input.inputKind,
          input.subjectRef,
          sealed.ciphertext,
          sealed.keyRef,
          contentHash,
          input.createdAt,
        ],
      );
      if (inserted.rowCount === 0) {
        await this.assertIdempotent(client, input, contentHash);
        await client.query("commit");
        if (sealed) await this.cipher.destroyKey(sealed.keyRef);
        return {
          inputId: input.inputId,
          inputKind: input.inputKind,
          subjectRef: input.subjectRef,
          contentHash,
          createdAt: input.createdAt,
          inputJson: input.inputJson,
        };
      }
      await client.query("commit");
      return {
        inputId: input.inputId,
        inputKind: input.inputKind,
        subjectRef: input.subjectRef,
        contentHash,
        createdAt: input.createdAt,
        inputJson: input.inputJson,
      };
    } catch (error: unknown) {
      await client.query("rollback");
      if (sealed) await this.cipher.destroyKey(sealed.keyRef);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Read every active human input for a subject in append order. */
  async list(subjectRef: string): Promise<LlmHumanInputRecord[]> {
    const result = await this.pool.query<HumanInputRow>(
      `
        select input_id, input_kind, subject_ref, human_input_content_hash,
          created_at, deletion_state, human_input_ciphertext, human_input_key_ref
        from itotori_llm_human_inputs
        where subject_ref = $1
        order by created_at asc, input_id asc
      `,
      [subjectRef],
    );
    const records: LlmHumanInputRecord[] = [];
    for (const row of result.rows) {
      records.push(await this.toRecord(row));
    }
    return records;
  }

  private async toRecord(row: HumanInputRow): Promise<LlmHumanInputRecord> {
    const active = row.deletion_state === "active" && row.human_input_ciphertext !== null;
    const inputJson = active
      ? await this.openVerified(
          row.human_input_ciphertext as Uint8Array,
          row.human_input_key_ref,
          row.human_input_content_hash,
        )
      : null;
    return {
      inputId: row.input_id,
      inputKind: row.input_kind,
      subjectRef: row.subject_ref,
      contentHash: row.human_input_content_hash,
      createdAt: new Date(row.created_at).toISOString(),
      inputJson,
    };
  }

  private async assertIdempotent(
    client: PoolClient,
    input: AppendLlmHumanInputInput,
    contentHash: string,
  ): Promise<void> {
    const existing = await client.query<{
      human_input_content_hash: string;
      input_kind: string;
      subject_ref: string;
    }>(
      `
        select human_input_content_hash, input_kind, subject_ref
        from itotori_llm_human_inputs
        where input_id = $1
      `,
      [input.inputId],
    );
    const row = existing.rows[0];
    if (
      !row ||
      row.human_input_content_hash !== contentHash ||
      row.input_kind !== input.inputKind ||
      row.subject_ref !== input.subjectRef
    ) {
      throw new LlmHumanInputConflictError(input.inputId);
    }
  }

  private async openVerified(
    ciphertext: Uint8Array,
    keyRef: string,
    expectedHash: string,
  ): Promise<string> {
    const plaintext = await this.cipher.open(ciphertext, keyRef);
    if (llmSha256(plaintext) !== expectedHash) {
      throw new Error("human input content hash mismatch");
    }
    return plaintext;
  }
}

interface HumanInputRow {
  input_id: string;
  input_kind: LlmHumanInputKind;
  subject_ref: string;
  human_input_content_hash: string;
  created_at: string;
  deletion_state: string;
  human_input_ciphertext: Uint8Array | null;
  human_input_key_ref: string;
}

function assertNonBlank(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`${label} must be non-empty`);
}
