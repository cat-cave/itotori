import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { DatabaseContext } from "../connection.js";
import type {
  CompletedLlmStep,
  LlmRouterAttemptEvidence,
  LlmServedPair,
  LlmStepAttemptContext,
} from "./llm-call-memo-repository.js";

export type LlmAttributionStatus = "pending" | "verified" | "unavailable";

export type LlmAttributionRecord = {
  memoKey: string;
  attemptOrdinal: number;
  responseEventId: string;
  generationId: string | null;
  status: LlmAttributionStatus;
  served: LlmServedPair;
  lookupAttempts: number;
  nextLookupAt: Date | null;
};

export type LlmAttributionLookup = (generationId: string) => Promise<{
  served: LlmServedPair;
  routerAttempts: readonly LlmRouterAttemptEvidence[];
  reportedCostUsd: string | null;
}>;

/**
 * The mutable provider-attribution ledger is deliberately separate from the
 * immutable request/response receipt. A generation may only become visible to
 * OpenRouter after the response has been durably accepted, so a missing route
 * is a queued reconciliation fact, never a fabricated "unknown" route.
 */
export class ItotoriLlmAttributionRepository {
  constructor(private readonly pool: DatabaseContext["pool"]) {}

  async recordPhysicalAttempt(
    client: PoolClient,
    input: { memoKey: string; attempt: LlmStepAttemptContext; execution: CompletedLlmStep },
  ): Promise<void> {
    const { execution } = input;
    const status: LlmAttributionStatus =
      execution.served.status === "confirmed"
        ? "verified"
        : execution.generationId === null
          ? "unavailable"
          : "pending";
    await client.query(
      `
        insert into itotori_llm_provider_attributions (
          attribution_id, memo_key, attempt_ordinal, response_event_id,
          generation_id, requested_model, provider_policy, served_pair_status,
          served_model, served_provider, router_attempts, reported_cost_usd,
          attribution_status, lookup_attempts, next_lookup_at, created_at, updated_at
        ) values (
          $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11::jsonb, $12,
          $13, $14, case when $13 = 'pending' then now() else null end, now(), now()
        ) on conflict (memo_key, attempt_ordinal) do nothing
      `,
      [
        attributionId(input.memoKey, input.attempt.ordinal),
        input.memoKey,
        input.attempt.ordinal,
        execution.responseEvent.eventId,
        execution.generationId,
        execution.requestedModel,
        JSON.stringify(execution.providerPolicy),
        execution.served.status,
        execution.served.status === "confirmed" ? execution.served.model : null,
        execution.served.status === "confirmed" ? execution.served.provider : null,
        JSON.stringify(execution.routerAttempts),
        execution.reportedCostUsd,
        status,
        execution.generationId === null ? 0 : 1,
      ],
    );
  }

  async pending(limit: number): Promise<LlmAttributionRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("attribution reconciliation limit must be between 1 and 100");
    }
    const result = await this.pool.query<AttributionRow>(
      `
        select memo_key, attempt_ordinal, response_event_id, generation_id,
          attribution_status, served_pair_status, served_model, served_provider,
          lookup_attempts, next_lookup_at
        from itotori_llm_provider_attributions
        where attribution_status = 'pending' and next_lookup_at <= now()
        order by next_lookup_at, attribution_id
        limit $1
        for update skip locked
      `,
      [limit],
    );
    return result.rows.map(recordFromRow);
  }

  async reconcilePending(
    limit: number,
    lookup: LlmAttributionLookup,
  ): Promise<LlmAttributionRecord[]> {
    const pending = await this.pending(limit);
    const reconciled: LlmAttributionRecord[] = [];
    for (const item of pending) {
      if (item.generationId === null) continue;
      const metadata = await lookup(item.generationId);
      const served = metadata.served;
      const result = await this.pool.query<AttributionRow>(
        `
          update itotori_llm_provider_attributions
          set served_pair_status = $1, served_model = $2, served_provider = $3,
              router_attempts = $4::jsonb, reported_cost_usd = coalesce($5, reported_cost_usd),
              attribution_status = case when $1 = 'confirmed' then 'verified' else 'pending' end,
              lookup_attempts = lookup_attempts + 1,
              next_lookup_at = case when $1 = 'confirmed' then null else now() + interval '5 seconds' end,
              updated_at = now()
          where memo_key = $6 and attempt_ordinal = $7 and attribution_status = 'pending'
          returning memo_key, attempt_ordinal, response_event_id, generation_id,
            attribution_status, served_pair_status, served_model, served_provider,
            lookup_attempts, next_lookup_at
        `,
        [
          served.status,
          served.status === "confirmed" ? served.model : null,
          served.status === "confirmed" ? served.provider : null,
          JSON.stringify(metadata.routerAttempts),
          metadata.reportedCostUsd,
          item.memoKey,
          item.attemptOrdinal,
        ],
      );
      const row = result.rows[0];
      if (row) reconciled.push(recordFromRow(row));
    }
    return reconciled;
  }
}

type AttributionRow = {
  memo_key: string;
  attempt_ordinal: number;
  response_event_id: string;
  generation_id: string | null;
  attribution_status: LlmAttributionStatus;
  served_pair_status: "confirmed" | "unknown";
  served_model: string | null;
  served_provider: string | null;
  lookup_attempts: number;
  next_lookup_at: Date | null;
};

function recordFromRow(row: AttributionRow): LlmAttributionRecord {
  const served: LlmServedPair =
    row.served_pair_status === "confirmed" && row.served_model && row.served_provider
      ? { status: "confirmed", model: row.served_model, provider: row.served_provider }
      : { status: "unknown" };
  return {
    memoKey: row.memo_key,
    attemptOrdinal: row.attempt_ordinal,
    responseEventId: row.response_event_id,
    generationId: row.generation_id,
    status: row.attribution_status,
    served,
    lookupAttempts: row.lookup_attempts,
    nextLookupAt: row.next_lookup_at,
  };
}

function attributionId(memoKey: string, attemptOrdinal: number): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(`${memoKey}:${attemptOrdinal}`).digest("hex")}`;
}
