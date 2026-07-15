import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { DatabaseContext } from "../connection.js";
import type { LlmContentReadAuthorizer } from "../llm-content-access.js";
import {
  canonicalLlmJson,
  canonicalParentIds,
  conversationEventId,
  parseLlmJson,
} from "../llm-content-address.js";
import {
  ItotoriLlmHttpAttemptRepository,
  type LlmSpendExposureReport,
} from "./llm-http-attempt-repository.js";
import { conversationEventProjectionMetadata } from "./llm-conversation-repository.js";

export interface LlmMemoCipher {
  seal(plaintext: string): Promise<{ ciphertext: Uint8Array; keyRef: string }>;
  open(ciphertext: Uint8Array, keyRef: string): Promise<string>;
  /** Must be idempotent so interrupted retention passes can resume safely. */
  destroyKey(keyRef: string): Promise<void>;
}

export type LlmStepBilling =
  | { status: "confirmed"; costUsd: string }
  | { status: "billing_unknown" };

export type LlmServedPair =
  | { status: "confirmed"; model: string; provider: string }
  | { status: "unknown" };

export interface LlmStepUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
}

export interface LlmRouterAttemptEvidence {
  ordinal: number;
  model: string;
  provider: string;
  httpStatus: number;
}

export interface LlmStepAttemptContext {
  ordinal: number;
  startedAt: string;
}

export interface LlmAttemptFailure {
  classification: "transient" | "permanent" | "cancelled";
  kind: "transport" | "http" | "deadline" | "cancelled";
  httpStatus: number | null;
  retryAfterMs: number | null;
}

export interface LlmSpendAdmission {
  scope: string;
  confirmedCostCapUsd: string;
  maxAttemptExposureUsd: string;
  deadlineMs: number;
}

export interface CompletedLlmStep {
  kind: "completed";
  responseJson: string;
  outcomeJson: string;
  outcomeKind: "terminal" | "tool-calls" | "invalid" | "refusal" | "truncation";
  generationId: string | null;
  requestedModel: string;
  providerPolicy: unknown;
  served: LlmServedPair;
  routerAttempts: readonly LlmRouterAttemptEvidence[];
  usage: LlmStepUsage | null;
  billing: LlmStepBilling;
  reportedCostUsd: string | null;
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
  served: LlmServedPair;
  routerAttempts: readonly LlmRouterAttemptEvidence[];
  usage: LlmStepUsage | null;
  billing: LlmStepBilling;
  reportedCostUsd: string | null;
  failure: LlmAttemptFailure;
  completedAt: string;
}

export type LlmStepExecution = CompletedLlmStep | IncompleteLlmStep;

export interface LlmMemoSingleflightInput {
  memoKey: string;
  semanticHash: string;
  schemaVersion: string;
  requestJson: string;
  admission: LlmSpendAdmission;
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
      attemptOrdinal: number;
      failure: LlmAttemptFailure;
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
  readonly #attempts: ItotoriLlmHttpAttemptRepository;

  constructor(
    private readonly pool: DatabaseContext["pool"],
    private readonly cipher: LlmMemoCipher,
    private readonly contentAccess: LlmContentReadAuthorizer,
  ) {
    this.#attempts = new ItotoriLlmHttpAttemptRepository(pool, cipher);
  }

  readSpendExposure(admissionScope: string): Promise<LlmSpendExposureReport> {
    return this.#attempts.readSpendExposure(admissionScope);
  }

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

      const ordinal = await this.#attempts.nextOrdinal(input.memoKey, client);
      const startedAt = new Date().toISOString();
      await this.#attempts.admitAndStart(client, input, { ordinal, startedAt });
      let execution: LlmStepExecution;
      try {
        execution = await input.execute({ ordinal, startedAt });
      } catch {
        execution = {
          kind: "incomplete",
          responseJson: null,
          attemptStatus: "transport-error",
          httpStatus: null,
          generationId: null,
          served: { status: "unknown" },
          routerAttempts: [],
          usage: null,
          billing: { status: "billing_unknown" },
          reportedCostUsd: null,
          failure: {
            // Retry only failures positively classified at the transport boundary.
            classification: "permanent",
            kind: "transport",
            httpStatus: null,
            retryAfterMs: null,
          },
          completedAt: new Date().toISOString(),
        };
      }

      if (execution.kind === "incomplete") {
        await this.#attempts.finish(client, input, { ordinal, execution });
        return {
          kind: "incomplete",
          memoHit: false,
          memoKey: input.memoKey,
          semanticHash: input.semanticHash,
          responseJson: execution.responseJson,
          attemptOrdinal: ordinal,
          failure: execution.failure,
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
    await this.contentAccess.requireContentRead({ contentRef: memoKey, purpose: "memo-replay" });
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
    const eventBody = parseLlmJson(execution.responseEvent.bodyJson);
    const canonicalEventBody = canonicalLlmJson(eventBody);
    if (canonicalEventBody !== execution.responseEvent.bodyJson) {
      throw new Error("conversation event body must use canonical JSON");
    }
    const parentEventIds = canonicalParentIds(execution.responseEvent.parentEventIds);
    const projection = conversationEventProjectionMetadata(eventBody);
    const expectedEventId = conversationEventId({
      parentIds: parentEventIds,
      kind: "assistant",
      snapshotId: execution.responseEvent.snapshotId,
      role: execution.responseEvent.actorRole,
      body: eventBody,
      memoKey: input.memoKey,
    });
    if (execution.responseEvent.eventId !== expectedEventId) {
      throw new Error("conversation event ID does not match its canonical content");
    }
    const confirmedServedPair =
      execution.generationId !== null && execution.served.status === "confirmed"
        ? execution.served
        : null;
    const request = await this.cipher.seal(input.requestJson);
    const response = await this.cipher.seal(execution.responseJson);
    const outcome = await this.cipher.seal(execution.outcomeJson);
    const sealedEventBody = await this.cipher.seal(execution.responseEvent.bodyJson);
    await client.query("begin");
    try {
      await this.#attempts.finish(client, input, attempt, false);
      await client.query(
        `
          insert into itotori_llm_call_memos (
            memo_key, semantic_hash, schema_version,
            request_ciphertext, request_key_ref, request_content_hash,
            response_ciphertext, response_key_ref, response_content_hash,
            outcome_ciphertext, outcome_key_ref, outcome_content_hash,
            outcome_kind, verification_status, generation_id, requested_model,
            provider_policy, served_model, served_provider, served_pair_status,
            prompt_token_count, completion_token_count, reasoning_token_count,
            cached_token_count, billing_state, cost_usd, completed_at, retention_deadline
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
            $13, $14, $15, $16, $17::jsonb, $18, $19, $20, $21, $22, $23,
            $24, $25, $26, $27::timestamptz, $27::timestamptz + interval '30 days'
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
          confirmedServedPair ? "verified" : "quarantined",
          execution.generationId,
          execution.requestedModel,
          JSON.stringify(execution.providerPolicy),
          confirmedServedPair?.model ?? null,
          confirmedServedPair?.provider ?? null,
          confirmedServedPair ? "confirmed" : "unknown",
          execution.usage?.promptTokens ?? null,
          execution.usage?.completionTokens ?? null,
          execution.usage?.reasoningTokens ?? null,
          execution.usage?.cachedTokens ?? null,
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
            event_body_content_hash, memo_key, projection_kind, projection_ref,
            projection_auxiliary_ref, accepted, created_at, retention_deadline
          ) values (
            $1, $2, $3, 'assistant', $4, $5, $6, $7, $8, $9, $10, $11, $12,
            $13, false, $14::timestamptz, $14::timestamptz + interval '30 days'
          )
        `,
        [
          execution.responseEvent.eventId,
          execution.responseEvent.schemaVersion,
          parentEventIds,
          execution.responseEvent.snapshotKind,
          execution.responseEvent.snapshotId,
          execution.responseEvent.actorRole,
          sealedEventBody.ciphertext,
          sealedEventBody.keyRef,
          hash(execution.responseEvent.bodyJson),
          input.memoKey,
          projection?.kind ?? null,
          projection?.ref ?? null,
          projection?.auxiliaryRef ?? null,
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
