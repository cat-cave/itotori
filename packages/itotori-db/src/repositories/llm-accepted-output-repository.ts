import { createHash } from "node:crypto";
import type { DatabaseContext } from "../connection.js";
import type { LlmMemoCipher } from "./llm-call-memo-repository.js";

export type LlmAcceptedOutputSubjectType =
  | "unit"
  | "wiki-object"
  | "translation-object"
  | "localized-rendering";

export interface LlmAcceptedOutputHead {
  outputId: string;
  version: number;
  contentHash: string;
}

export interface AcceptLlmOutputInput {
  outputId: string;
  semanticKey: string;
  schemaVersion: string;
  outputVersion: number;
  supersedesOutputId: string | null;
  parentOutputIds: readonly string[];
  memoKeys: readonly string[];
  snapshotKind: "context" | "localization";
  snapshotId: string;
  subjectType: LlmAcceptedOutputSubjectType;
  subjectId: string;
  stage: string;
  sourceHash: string | null;
  outputJson: string;
  acceptedAt: string;
  expectedHead: LlmAcceptedOutputHead | null;
}

export class LlmQuarantinedResponseError extends Error {
  constructor(readonly memoKeys: readonly string[]) {
    super("accepted output requires a live memo with a generation ID and stream-attested route");
    this.name = "LlmQuarantinedResponseError";
  }
}

export class LlmAcceptedOutputCasError extends Error {
  constructor() {
    super("accepted output head compare-and-swap failed");
    this.name = "LlmAcceptedOutputCasError";
  }
}

export class ItotoriLlmAcceptedOutputRepository {
  constructor(
    private readonly pool: DatabaseContext["pool"],
    private readonly cipher: LlmMemoCipher,
  ) {}

  async acceptAndAdvance(input: AcceptLlmOutputInput): Promise<LlmAcceptedOutputHead> {
    assertInput(input);
    const client = await this.pool.connect();
    let sealed: Awaited<ReturnType<LlmMemoCipher["seal"]>> | null = null;
    try {
      await client.query("begin");
      const invalid = await client.query<{ memo_key: string }>(
        `
          select required.memo_key
          from unnest($1::text[]) required(memo_key)
          left join itotori_llm_call_memos memo on memo.memo_key = required.memo_key
          where memo.verification_status is distinct from 'verified'
            or memo.generation_id is null
            or memo.served_pair_status is distinct from 'confirmed'
            or memo.deletion_state is distinct from 'active'
        `,
        [input.memoKeys],
      );
      if (invalid.rows.length > 0) {
        throw new LlmQuarantinedResponseError(invalid.rows.map((row) => row.memo_key));
      }

      sealed = await this.cipher.seal(input.outputJson);
      const contentHash = hash(input.outputJson);
      await client.query(
        `
          insert into itotori_llm_accepted_outputs (
            output_id, semantic_key, schema_version, output_version, supersedes_output_id,
            parent_output_ids, memo_keys, snapshot_kind, snapshot_id, subject_type,
            subject_id, stage, source_hash, output_ciphertext, output_key_ref,
            output_content_hash, accepted_at, retention_deadline
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17::timestamptz,
            $17::timestamptz + interval '365 days'
          )
        `,
        [
          input.outputId,
          input.semanticKey,
          input.schemaVersion,
          input.outputVersion,
          input.supersedesOutputId,
          input.parentOutputIds,
          input.memoKeys,
          input.snapshotKind,
          input.snapshotId,
          input.subjectType,
          input.subjectId,
          input.stage,
          input.sourceHash,
          sealed.ciphertext,
          sealed.keyRef,
          contentHash,
          input.acceptedAt,
        ],
      );

      const advanced = input.expectedHead
        ? await client.query(
            `
              update itotori_llm_cas_heads
              set head_id = $1, head_version = $2, head_content_hash = $3,
                  updated_at = $4::timestamptz
              where head_namespace = 'accepted-output'
                and snapshot_id = $5 and subject_type = $6 and subject_id = $7
                and head_stage = $8 and head_id = $9 and head_version = $10
                and head_content_hash = $11
            `,
            [
              input.outputId,
              input.outputVersion,
              contentHash,
              input.acceptedAt,
              input.snapshotId,
              input.subjectType,
              input.subjectId,
              input.stage,
              input.expectedHead.outputId,
              input.expectedHead.version,
              input.expectedHead.contentHash,
            ],
          )
        : await client.query(
            `
              insert into itotori_llm_cas_heads (
                head_namespace, snapshot_id, subject_type, subject_id, head_stage,
                head_id, head_version, head_content_hash, updated_at
              ) values ('accepted-output', $1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
              on conflict (head_namespace, snapshot_id, subject_type, subject_id, head_stage)
              do nothing
            `,
            [
              input.snapshotId,
              input.subjectType,
              input.subjectId,
              input.stage,
              input.outputId,
              input.outputVersion,
              contentHash,
              input.acceptedAt,
            ],
          );
      if (advanced.rowCount !== 1) throw new LlmAcceptedOutputCasError();
      await client.query("commit");
      return { outputId: input.outputId, version: input.outputVersion, contentHash };
    } catch (error: unknown) {
      await client.query("rollback");
      if (sealed) await this.cipher.destroyKey(sealed.keyRef);
      throw error;
    } finally {
      client.release();
    }
  }

  async readHead(input: {
    snapshotId: string;
    subjectType: LlmAcceptedOutputSubjectType;
    subjectId: string;
    stage: string;
  }): Promise<LlmAcceptedOutputHead | null> {
    const result = await this.pool.query<{
      output_id: string;
      output_version: number;
      output_content_hash: string;
    }>(
      `
        select output.output_id, output.output_version, output.output_content_hash
        from itotori_llm_cas_heads head
        join itotori_llm_accepted_outputs output on output.output_id = head.head_id
        where head.head_namespace = 'accepted-output'
          and head.snapshot_id = $1 and head.subject_type = $2
          and head.subject_id = $3 and head.head_stage = $4
          and output.deletion_state = 'active'
          and not exists (
            select 1
            from unnest(output.memo_keys) required(memo_key)
            left join itotori_llm_call_memos memo on memo.memo_key = required.memo_key
            where memo.verification_status is distinct from 'verified'
              or memo.generation_id is null
              or memo.served_pair_status is distinct from 'confirmed'
              or memo.deletion_state is distinct from 'active'
          )
      `,
      [input.snapshotId, input.subjectType, input.subjectId, input.stage],
    );
    const row = result.rows[0];
    return row
      ? {
          outputId: row.output_id,
          version: row.output_version,
          contentHash: row.output_content_hash,
        }
      : null;
  }
}

function assertInput(input: AcceptLlmOutputInput): void {
  assertHash(input.semanticKey, "accepted output semantic key");
  assertHash(input.snapshotId, "accepted output snapshot ID");
  if (input.memoKeys.length === 0 || new Set(input.memoKeys).size !== input.memoKeys.length) {
    throw new Error("accepted output requires unique source memo keys");
  }
  for (const memoKey of input.memoKeys) assertHash(memoKey, "accepted output memo key");
  if (input.sourceHash !== null) assertHash(input.sourceHash, "accepted output source hash");
  if (!Number.isSafeInteger(input.outputVersion) || input.outputVersion <= 0) {
    throw new Error("accepted output version must be a positive safe integer");
  }
  if (input.expectedHead === null && input.outputVersion !== 1) {
    throw new Error("the first accepted output version must be one");
  }
  if (
    input.expectedHead !== null &&
    (input.outputVersion !== input.expectedHead.version + 1 ||
      input.supersedesOutputId !== input.expectedHead.outputId)
  ) {
    throw new Error("accepted output version does not advance its expected head");
  }
  if (!Number.isFinite(Date.parse(input.acceptedAt))) {
    throw new Error("accepted output timestamp is invalid");
  }
}

function assertHash(value: string, label: string): void {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error(`${label} must be a SHA-256 hash`);
}

function hash(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
