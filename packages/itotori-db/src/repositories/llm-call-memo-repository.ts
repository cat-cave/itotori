import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { DatabaseContext } from "../connection.js";

export interface LlmMemoCipher {
  seal(plaintext: string): Promise<{ ciphertext: Uint8Array; keyRef: string }>;
  open(ciphertext: Uint8Array, keyRef: string): Promise<string>;
}

export type LlmStepBilling =
  | { status: "confirmed"; costUsd: string }
  | { status: "billing_unknown" };

export interface LlmStepAttemptContext {
  ordinal: number;
  startedAt: string;
}

export interface CompletedLlmStep {
  kind: "completed";
  responseJson: string;
  outcomeJson: string;
  outcomeKind: "terminal" | "tool-calls" | "invalid" | "refusal" | "truncation";
  verificationStatus: "verified" | "quarantined";
  generationId: string | null;
  requestedModel: string;
  providerPolicy: unknown;
  servedModel: string | null;
  servedProvider: string | null;
  usage: {
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
    cachedTokens: number;
  };
  billing: LlmStepBilling;
  completedAt: string;
  responseEvent: {
    eventId: string;
    schemaVersion: string;
    parentEventIds: readonly string[];
    snapshotKind: "context" | "localization";
    snapshotId: string;
    actorRole: string;
    bodyJson: string;
  };
}

export interface IncompleteLlmStep {
  kind: "incomplete";
  responseJson: string | null;
  attemptStatus: "transport-error" | "http-error" | "cancelled";
  httpStatus: number | null;
  generationId: string | null;
  billing: LlmStepBilling;
  completedAt: string;
}

export type LlmStepExecution = CompletedLlmStep | IncompleteLlmStep;

export interface LlmMemoSingleflightInput {
  memoKey: string;
  semanticHash: string;
  schemaVersion: string;
  requestJson: string;
  execute: (attempt: LlmStepAttemptContext) => Promise<LlmStepExecution>;
}

export type LlmMemoSingleflightResult =
  | {
      kind: "completed";
      memoHit: boolean;
      memoKey: string;
      semanticHash: string;
      responseJson: string;
      outcomeJson: string;
      responseEventId: string;
    }
  | {
      kind: "incomplete";
      memoHit: false;
      memoKey: string;
      semanticHash: string;
      responseJson: string | null;
    };

export interface LlmCallMemoStore {
  singleflight(input: LlmMemoSingleflightInput): Promise<LlmMemoSingleflightResult>;
}

export class LlmMemoConflictError extends Error {
  constructor(readonly memoKey: string) {
    super(`physical model step conflicts with immutable memo ${memoKey}`);
    this.name = "LlmMemoConflictError";
  }
}

export class ItotoriLlmCallMemoRepository implements LlmCallMemoStore {
  constructor(
    private readonly pool: DatabaseContext["pool"],
    private readonly cipher: LlmMemoCipher,
  ) {}

  async singleflight(input: LlmMemoSingleflightInput): Promise<LlmMemoSingleflightResult> {
    assertHash(input.memoKey, "memo key");
    assertHash(input.semanticHash, "semantic hash");
    const early = await this.findMemo(input.memoKey, input.semanticHash);
    if (early) return { ...early, memoHit: true };

    const client = await this.pool.connect();
    const lockKey = advisoryLockKey(input.memoKey);
    let locked = false;
    try {
      await client.query("select pg_advisory_lock($1::bigint)", [lockKey]);
      locked = true;
      const existing = await this.findMemo(input.memoKey, input.semanticHash, client);
      if (existing) return { ...existing, memoHit: true };
      await this.rejectSemanticAlias(input.memoKey, input.semanticHash, client);

      const ordinal = await nextAttemptOrdinal(input.memoKey, client);
      const startedAt = new Date().toISOString();
      let execution: LlmStepExecution;
      try {
        execution = await input.execute({ ordinal, startedAt });
      } catch (error: unknown) {
        await this.insertAttempt(client, input, {
          ordinal,
          startedAt,
          execution: {
            kind: "incomplete",
            responseJson: null,
            attemptStatus: "transport-error",
            httpStatus: null,
            generationId: null,
            billing: { status: "billing_unknown" },
            completedAt: new Date().toISOString(),
          },
        });
        throw error;
      }

      if (execution.kind === "incomplete") {
        await this.insertAttempt(client, input, { ordinal, startedAt, execution });
        return {
          kind: "incomplete",
          memoHit: false,
          memoKey: input.memoKey,
          semanticHash: input.semanticHash,
          responseJson: execution.responseJson,
        };
      }

      await this.insertCompleted(client, input, { ordinal, startedAt, execution });
      return {
        kind: "completed",
        memoHit: false,
        memoKey: input.memoKey,
        semanticHash: input.semanticHash,
        responseJson: execution.responseJson,
        outcomeJson: execution.outcomeJson,
        responseEventId: execution.responseEvent.eventId,
      };
    } finally {
      if (locked) {
        try {
          await client.query("select pg_advisory_unlock($1::bigint)", [lockKey]);
        } catch {
          // Releasing the session also releases its advisory lock.
        }
      }
      client.release();
    }
  }

  private async findMemo(
    memoKey: string,
    semanticHash: string,
    queryable: Pick<DatabaseContext["pool"], "query"> = this.pool,
  ): Promise<Omit<Extract<LlmMemoSingleflightResult, { kind: "completed" }>, "memoHit"> | null> {
    const result = await queryable.query<MemoRow>(
      `
        select m.memo_key, m.semantic_hash, m.response_ciphertext, m.response_key_ref,
          m.response_content_hash, m.outcome_ciphertext, m.outcome_key_ref,
          m.outcome_content_hash, m.deletion_state, e.event_id as response_event_id
        from itotori_llm_call_memos m
        left join lateral (
          select event_id from itotori_llm_conversation_events
          where memo_key = m.memo_key and event_kind = 'assistant'
          order by created_at asc limit 1
        ) e on true
        where m.memo_key = $1
      `,
      [memoKey],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.semantic_hash !== semanticHash || row.deletion_state !== "active") {
      throw new LlmMemoConflictError(memoKey);
    }
    if (!row.response_ciphertext || !row.outcome_ciphertext || !row.response_event_id) {
      throw new Error(`immutable memo ${memoKey} is incomplete`);
    }
    const responseJson = await this.openVerified(
      row.response_ciphertext,
      row.response_key_ref,
      row.response_content_hash,
    );
    const outcomeJson = await this.openVerified(
      row.outcome_ciphertext,
      row.outcome_key_ref,
      row.outcome_content_hash,
    );
    return {
      kind: "completed",
      memoKey,
      semanticHash,
      responseJson,
      outcomeJson,
      responseEventId: row.response_event_id,
    };
  }

  private async rejectSemanticAlias(
    memoKey: string,
    semanticHash: string,
    queryable: Pick<DatabaseContext["pool"], "query">,
  ): Promise<void> {
    const result = await queryable.query<{ memo_key: string }>(
      "select memo_key from itotori_llm_call_memos where semantic_hash = $1",
      [semanticHash],
    );
    const existingKey = result.rows[0]?.memo_key;
    if (existingKey && existingKey !== memoKey) throw new LlmMemoConflictError(existingKey);
  }

  private async insertCompleted(
    client: PoolClient,
    input: LlmMemoSingleflightInput,
    attempt: { ordinal: number; startedAt: string; execution: CompletedLlmStep },
  ): Promise<void> {
    const { execution } = attempt;
    const request = await this.cipher.seal(input.requestJson);
    const response = await this.cipher.seal(execution.responseJson);
    const outcome = await this.cipher.seal(execution.outcomeJson);
    const eventBody = await this.cipher.seal(execution.responseEvent.bodyJson);
    await client.query("begin");
    try {
      await this.insertAttempt(client, input, attempt, false);
      await client.query(
        `
          insert into itotori_llm_call_memos (
            memo_key, semantic_hash, schema_version,
            request_ciphertext, request_key_ref, request_content_hash,
            response_ciphertext, response_key_ref, response_content_hash,
            outcome_ciphertext, outcome_key_ref, outcome_content_hash,
            outcome_kind, verification_status, generation_id, requested_model,
            provider_policy, served_model, served_provider,
            prompt_token_count, completion_token_count, reasoning_token_count,
            cached_token_count, billing_state, cost_usd, completed_at, retention_deadline
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
            $13, $14, $15, $16, $17::jsonb, $18, $19, $20, $21, $22, $23,
            $24, $25, $26::timestamptz, $26::timestamptz + interval '30 days'
          )
        `,
        [
          input.memoKey,
          input.semanticHash,
          input.schemaVersion,
          request.ciphertext,
          request.keyRef,
          hash(input.requestJson),
          response.ciphertext,
          response.keyRef,
          hash(execution.responseJson),
          outcome.ciphertext,
          outcome.keyRef,
          hash(execution.outcomeJson),
          execution.outcomeKind,
          execution.verificationStatus,
          execution.generationId,
          execution.requestedModel,
          JSON.stringify(execution.providerPolicy),
          execution.servedModel,
          execution.servedProvider,
          execution.usage.promptTokens,
          execution.usage.completionTokens,
          execution.usage.reasoningTokens,
          execution.usage.cachedTokens,
          execution.billing.status,
          execution.billing.status === "confirmed" ? execution.billing.costUsd : null,
          execution.completedAt,
        ],
      );
      await client.query(
        `
          insert into itotori_llm_conversation_events (
            event_id, schema_version, parent_event_ids, event_kind, snapshot_kind,
            snapshot_id, actor_role, event_body_ciphertext, event_body_key_ref,
            event_body_content_hash, memo_key, accepted, created_at, retention_deadline
          ) values (
            $1, $2, $3, 'assistant', $4, $5, $6, $7, $8, $9, $10, false,
            $11::timestamptz, $11::timestamptz + interval '30 days'
          )
        `,
        [
          execution.responseEvent.eventId,
          execution.responseEvent.schemaVersion,
          execution.responseEvent.parentEventIds,
          execution.responseEvent.snapshotKind,
          execution.responseEvent.snapshotId,
          execution.responseEvent.actorRole,
          eventBody.ciphertext,
          eventBody.keyRef,
          hash(execution.responseEvent.bodyJson),
          input.memoKey,
          execution.completedAt,
        ],
      );
      await client.query("commit");
    } catch (error: unknown) {
      await client.query("rollback");
      if (isUniqueViolation(error)) throw new LlmMemoConflictError(input.memoKey);
      throw error;
    }
  }

  private async insertAttempt(
    client: PoolClient,
    input: LlmMemoSingleflightInput,
    attempt: {
      ordinal: number;
      startedAt: string;
      execution: LlmStepExecution;
    },
    transactional = true,
  ): Promise<void> {
    const request = await this.cipher.seal(input.requestJson);
    const response = attempt.execution.responseJson
      ? await this.cipher.seal(attempt.execution.responseJson)
      : null;
    const status =
      attempt.execution.kind === "completed" ? "completed" : attempt.execution.attemptStatus;
    const httpStatus = attempt.execution.kind === "completed" ? 200 : attempt.execution.httpStatus;
    const generationId = attempt.execution.generationId;
    const billing = attempt.execution.billing;
    const completedAt = attempt.execution.completedAt;
    const write = async (): Promise<void> => {
      await client.query(
        `
          insert into itotori_llm_http_attempts (
            attempt_id, memo_key, attempt_ordinal, request_ciphertext, request_key_ref,
            request_content_hash, response_ciphertext, response_key_ref,
            response_content_hash, request_hash, attempt_status, http_status,
            generation_id, billing_state, cost_usd, started_at, completed_at,
            retention_deadline
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
            $14, $15, $16::timestamptz, $17::timestamptz,
            $17::timestamptz + interval '7 days'
          )
        `,
        [
          hash({ memoKey: input.memoKey, ordinal: attempt.ordinal }),
          input.memoKey,
          attempt.ordinal,
          request.ciphertext,
          request.keyRef,
          hash(input.requestJson),
          response?.ciphertext ?? null,
          response?.keyRef ?? null,
          attempt.execution.responseJson ? hash(attempt.execution.responseJson) : null,
          input.semanticHash,
          status,
          httpStatus,
          generationId,
          billing.status,
          billing.status === "confirmed" ? billing.costUsd : null,
          attempt.startedAt,
          completedAt,
        ],
      );
    };
    if (!transactional) return write();
    await client.query("begin");
    try {
      await write();
      await client.query("commit");
    } catch (error: unknown) {
      await client.query("rollback");
      throw error;
    }
  }

  private async openVerified(
    ciphertext: Uint8Array,
    keyRef: string,
    expectedHash: string,
  ): Promise<string> {
    const plaintext = await this.cipher.open(ciphertext, keyRef);
    if (hash(plaintext) !== expectedHash) throw new Error("encrypted memo content hash mismatch");
    return plaintext;
  }
}

type MemoRow = {
  memo_key: string;
  semantic_hash: string;
  response_ciphertext: Uint8Array | null;
  response_key_ref: string;
  response_content_hash: string;
  outcome_ciphertext: Uint8Array | null;
  outcome_key_ref: string;
  outcome_content_hash: string;
  deletion_state: string;
  response_event_id: string | null;
};

async function nextAttemptOrdinal(
  memoKey: string,
  queryable: Pick<DatabaseContext["pool"], "query">,
): Promise<number> {
  const result = await queryable.query<{ next_ordinal: number }>(
    `
      select coalesce(max(attempt_ordinal), 0)::integer + 1 as next_ordinal
      from itotori_llm_http_attempts where memo_key = $1
    `,
    [memoKey],
  );
  const ordinal = result.rows[0]?.next_ordinal ?? 1;
  if (ordinal > 3) throw new Error(`physical model step exhausted attempt limit for ${memoKey}`);
  return ordinal;
}

function advisoryLockKey(memoKey: string): string {
  const unsigned = BigInt(`0x${memoKey.slice("sha256:".length, "sha256:".length + 16)}`);
  const signBit = 1n << 63n;
  return (unsigned >= signBit ? unsigned - (1n << 64n) : unsigned).toString();
}

function assertHash(value: string, label: string): void {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error(`${label} must be a SHA-256 hash`);
}

function hash(value: unknown): `sha256:${string}` {
  const bytes = typeof value === "string" ? value : JSON.stringify(value);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
