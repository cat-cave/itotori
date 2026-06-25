import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import {
  draftAttemptProviderLedger,
  draftJobAttempts,
  draftJobs,
  type DraftAttemptFallbackChainEntry,
  type DraftAttemptProviderLedgerContextRef,
  type DraftAttemptProviderLedgerPolicyVersions,
} from "../schema.js";

export type DraftAttemptProviderLedgerEntry = {
  ledgerEntryId: string;
  draftJobAttemptId: string;
  providerProofId: string;
  modelProviderFamily: string | null;
  modelId: string | null;
  /**
   * ITOTORI-220 — pinned upstream provider id. Always present (NOT NULL
   * at the schema level); legacy rows are backfilled to `unknown` by
   * migration 0038.
   */
  providerId: string;
  modelContextWindowTokens: number | null;
  modelMaxOutputTokens: number | null;
  promptTemplateVersion: string | null;
  promptHash: string | null;
  policyVersions: DraftAttemptProviderLedgerPolicyVersions;
  contextArtifactRefs: DraftAttemptProviderLedgerContextRef[];
  tokensIn: number | null;
  tokensOut: number | null;
  costUnit: string;
  costAmount: string;
  /**
   * ITOTORI-232 — full `usage` block from the originating OpenRouter
   * response, mirrored verbatim. The DB CHECK enforces that
   * `cost_amount` equals `usage_response_json->>'cost'` within 1e-9 USD
   * whenever the object carries a `cost` field; rows with no `cost` key
   * (offline / local / fake providers; pre-ITOTORI-232 backfill
   * sentinel) are exempt.
   */
  usageResponseJson: Record<string, unknown>;
  latencyMs: number | null;
  fallbackChain: DraftAttemptFallbackChainEntry[];
  isRecordedProvider: boolean;
  recordedProviderBundleId: string | null;
  createdAt: Date;
};

export type RecordLedgerEntryInput = {
  draftJobAttemptId: string;
  providerProofId: string;
  modelProviderFamily?: string | undefined;
  modelId?: string | undefined;
  /**
   * ITOTORI-220 — REQUIRED. The repository rejects null/empty
   * providerId; per the standing pair rule, the writer must declare it.
   */
  providerId: string;
  modelContextWindowTokens?: number | undefined;
  modelMaxOutputTokens?: number | undefined;
  promptTemplateVersion?: string | undefined;
  promptHash?: string | undefined;
  policyVersions?: DraftAttemptProviderLedgerPolicyVersions | undefined;
  contextArtifactRefs?: DraftAttemptProviderLedgerContextRef[] | undefined;
  tokensIn?: number | undefined;
  tokensOut?: number | undefined;
  costUnit: string;
  costAmount: string;
  /**
   * ITOTORI-232 — REQUIRED. The originating OpenRouter response's full
   * `usage` block (prompt_tokens, completion_tokens, cost, cost_details,
   * prompt_tokens_details). For LIVE OR rows this MUST carry a real
   * `cost` field whose value equals `costAmount` within 1e-9 USD — the
   * DB CHECK refuses any row that violates the equality. For offline /
   * local / fake provider rows that genuinely never billed, pass an
   * object with no `cost` key (e.g. `{}` or a sentinel like
   * `{"_local": true}`); the partial-NULL CHECK exempts these.
   */
  usageResponseJson: Record<string, unknown>;
  latencyMs?: number | undefined;
  fallbackChain?: DraftAttemptFallbackChainEntry[] | undefined;
  isRecordedProvider?: boolean | undefined;
  recordedProviderBundleId?: string | undefined;
};

export type SumCostByProjectWindow = {
  from: Date;
  to: Date;
};

export type SumCostByProjectOptions = {
  byModel?: boolean | undefined;
  /**
   * ITOTORI-220 — when true, return a `byProvider` aggregate keyed by
   * `provider_id`. Independent of `byModel`; setting both returns both.
   */
  byProvider?: boolean | undefined;
};

export type SumCostByProjectResult = {
  totalCost: string;
  byModel?: Record<string, string>;
  byProvider?: Record<string, string>;
};

/**
 * ITOTORI-223 — per-(modelId, providerId) aggregate row produced by
 * {@link ItotoriDraftAttemptProviderLedgerRepositoryPort.sumByPairAndDay}.
 *
 * The aggregate is keyed exactly on the (modelId, providerId) pair per
 * the standing model+provider pair rule. `modelId` is the underlying
 * column value (nullable in the schema for pre-ITOTORI-077 rows); the
 * repository returns the raw nullable value and the telemetry query
 * layer is responsible for surfacing a typed "unknown" sentinel when
 * rendering pair keys.
 *
 * Latency aggregates are NULL when no row in the bucket carries a
 * latency_ms value. The telemetry query layer treats NULL latency as
 * "no measurement" — it never coerces NULL to 0.
 *
 * `bucketDay`: ISO YYYY-MM-DD string when {@link SumByPairAndDayOptions.groupByDay}
 * is true, otherwise NULL. The day boundary is computed from
 * `created_at` in UTC.
 */
export type LedgerPairAggregateRow = {
  modelId: string | null;
  providerId: string;
  bucketDay: string | null;
  totalCostUsd: string;
  totalTokensIn: number;
  totalTokensOut: number;
  invocationCount: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
};

export type SumByPairAndDayOptions = {
  groupByDay?: boolean | undefined;
};

export class DraftAttemptProviderLedgerRepositoryError extends Error {
  constructor(
    readonly code:
      | "ledger_entry_not_found"
      | "ledger_entry_persistence_failed"
      | "ledger_entry_invalid_input",
    message: string,
  ) {
    super(message);
    this.name = "DraftAttemptProviderLedgerRepositoryError";
  }
}

export interface ItotoriDraftAttemptProviderLedgerRepositoryPort {
  recordLedgerEntry(
    actor: AuthorizationActor,
    input: RecordLedgerEntryInput,
  ): Promise<DraftAttemptProviderLedgerEntry>;
  loadEntriesByAttempt(
    actor: AuthorizationActor,
    draftJobAttemptId: string,
  ): Promise<DraftAttemptProviderLedgerEntry[]>;
  loadEntriesByProviderProof(
    actor: AuthorizationActor,
    providerProofId: string,
  ): Promise<DraftAttemptProviderLedgerEntry | null>;
  sumCostByProject(
    actor: AuthorizationActor,
    projectId: string,
    window: SumCostByProjectWindow,
    opts?: SumCostByProjectOptions,
  ): Promise<SumCostByProjectResult>;
  /**
   * ITOTORI-223 — per-(modelId, providerId) aggregate over a project /
   * window, with optional per-day grouping. Returns raw aggregate rows
   * (cost / token / latency totals + count + p95) — the telemetry
   * query layer (apps/itotori/src/telemetry) builds the typed
   * TelemetrySummaryByPair on top.
   *
   * The aggregation key is exactly (modelId, providerId) per the
   * standing model+provider pair rule.
   */
  sumByPairAndDay(
    actor: AuthorizationActor,
    projectId: string,
    window: SumCostByProjectWindow,
    opts?: SumByPairAndDayOptions,
  ): Promise<LedgerPairAggregateRow[]>;
}

export class ItotoriDraftAttemptProviderLedgerRepository implements ItotoriDraftAttemptProviderLedgerRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async recordLedgerEntry(
    actor: AuthorizationActor,
    input: RecordLedgerEntryInput,
  ): Promise<DraftAttemptProviderLedgerEntry> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);

    assertRecordLedgerEntryInput(input);

    const ledgerEntryId = `draft-attempt-provider-ledger-${randomUUID()}`;
    await this.db.insert(draftAttemptProviderLedger).values({
      ledgerEntryId,
      draftJobAttemptId: input.draftJobAttemptId,
      providerProofId: input.providerProofId,
      modelProviderFamily: input.modelProviderFamily ?? null,
      modelId: input.modelId ?? null,
      providerId: input.providerId,
      modelContextWindowTokens: input.modelContextWindowTokens ?? null,
      modelMaxOutputTokens: input.modelMaxOutputTokens ?? null,
      promptTemplateVersion: input.promptTemplateVersion ?? null,
      promptHash: input.promptHash ?? null,
      policyVersions: input.policyVersions ?? {},
      contextArtifactRefs: input.contextArtifactRefs ?? [],
      tokensIn: input.tokensIn ?? null,
      tokensOut: input.tokensOut ?? null,
      costUnit: input.costUnit,
      costAmount: input.costAmount,
      usageResponseJson: input.usageResponseJson,
      latencyMs: input.latencyMs ?? null,
      fallbackChain: input.fallbackChain ?? [],
      isRecordedProvider: input.isRecordedProvider ?? false,
      recordedProviderBundleId: input.recordedProviderBundleId ?? null,
    });

    const persisted = await this.fetchByLedgerEntryId(ledgerEntryId);
    if (persisted === null) {
      throw new DraftAttemptProviderLedgerRepositoryError(
        "ledger_entry_persistence_failed",
        `failed to load ledger entry ${ledgerEntryId} after insert`,
      );
    }
    return persisted;
  }

  async loadEntriesByAttempt(
    actor: AuthorizationActor,
    draftJobAttemptId: string,
  ): Promise<DraftAttemptProviderLedgerEntry[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);

    const rows = await this.db
      .select()
      .from(draftAttemptProviderLedger)
      .where(eq(draftAttemptProviderLedger.draftJobAttemptId, draftJobAttemptId))
      .orderBy(asc(draftAttemptProviderLedger.createdAt));
    return rows.map(ledgerRowToEntry);
  }

  async loadEntriesByProviderProof(
    actor: AuthorizationActor,
    providerProofId: string,
  ): Promise<DraftAttemptProviderLedgerEntry | null> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);

    const rows = await this.db
      .select()
      .from(draftAttemptProviderLedger)
      .where(eq(draftAttemptProviderLedger.providerProofId, providerProofId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return ledgerRowToEntry(row);
  }

  async sumCostByProject(
    actor: AuthorizationActor,
    projectId: string,
    window: SumCostByProjectWindow,
    opts?: SumCostByProjectOptions,
  ): Promise<SumCostByProjectResult> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);

    if (window.from.getTime() > window.to.getTime()) {
      throw new DraftAttemptProviderLedgerRepositoryError(
        "ledger_entry_invalid_input",
        "sumCostByProject window.from must not be after window.to",
      );
    }

    const totalRows = await this.db
      .select({
        total: sql<string>`coalesce(sum(${draftAttemptProviderLedger.costAmount}), 0)::text`,
      })
      .from(draftAttemptProviderLedger)
      .innerJoin(
        draftJobAttempts,
        eq(draftAttemptProviderLedger.draftJobAttemptId, draftJobAttempts.draftJobAttemptId),
      )
      .innerJoin(draftJobs, eq(draftJobAttempts.draftJobId, draftJobs.draftJobId))
      .where(
        and(
          eq(draftJobs.projectId, projectId),
          gte(draftAttemptProviderLedger.createdAt, window.from),
          lte(draftAttemptProviderLedger.createdAt, window.to),
        ),
      );
    const totalCost = totalRows[0]?.total ?? "0";

    const result: SumCostByProjectResult = { totalCost };

    if (opts?.byModel === true) {
      const byModelRows = await this.db
        .select({
          modelId: draftAttemptProviderLedger.modelId,
          amount: sql<string>`coalesce(sum(${draftAttemptProviderLedger.costAmount}), 0)::text`,
        })
        .from(draftAttemptProviderLedger)
        .innerJoin(
          draftJobAttempts,
          eq(draftAttemptProviderLedger.draftJobAttemptId, draftJobAttempts.draftJobAttemptId),
        )
        .innerJoin(draftJobs, eq(draftJobAttempts.draftJobId, draftJobs.draftJobId))
        .where(
          and(
            eq(draftJobs.projectId, projectId),
            gte(draftAttemptProviderLedger.createdAt, window.from),
            lte(draftAttemptProviderLedger.createdAt, window.to),
          ),
        )
        .groupBy(draftAttemptProviderLedger.modelId)
        .orderBy(desc(sql`coalesce(sum(${draftAttemptProviderLedger.costAmount}), 0)`));

      const byModel: Record<string, string> = {};
      for (const row of byModelRows) {
        const key = row.modelId ?? "unknown";
        byModel[key] = row.amount;
      }
      result.byModel = byModel;
    }

    // ITOTORI-220 — provider-level cost aggregation. Mirrors `byModel`
    // but keys on `provider_id`. Useful for spotting providers that are
    // unexpectedly expensive even if the model is the same.
    if (opts?.byProvider === true) {
      const byProviderRows = await this.db
        .select({
          providerId: draftAttemptProviderLedger.providerId,
          amount: sql<string>`coalesce(sum(${draftAttemptProviderLedger.costAmount}), 0)::text`,
        })
        .from(draftAttemptProviderLedger)
        .innerJoin(
          draftJobAttempts,
          eq(draftAttemptProviderLedger.draftJobAttemptId, draftJobAttempts.draftJobAttemptId),
        )
        .innerJoin(draftJobs, eq(draftJobAttempts.draftJobId, draftJobs.draftJobId))
        .where(
          and(
            eq(draftJobs.projectId, projectId),
            gte(draftAttemptProviderLedger.createdAt, window.from),
            lte(draftAttemptProviderLedger.createdAt, window.to),
          ),
        )
        .groupBy(draftAttemptProviderLedger.providerId)
        .orderBy(desc(sql`coalesce(sum(${draftAttemptProviderLedger.costAmount}), 0)`));

      const byProvider: Record<string, string> = {};
      for (const row of byProviderRows) {
        byProvider[row.providerId] = row.amount;
      }
      result.byProvider = byProvider;
    }

    return result;
  }

  async sumByPairAndDay(
    actor: AuthorizationActor,
    projectId: string,
    window: SumCostByProjectWindow,
    opts?: SumByPairAndDayOptions,
  ): Promise<LedgerPairAggregateRow[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);

    if (window.from.getTime() > window.to.getTime()) {
      throw new DraftAttemptProviderLedgerRepositoryError(
        "ledger_entry_invalid_input",
        "sumByPairAndDay window.from must not be after window.to",
      );
    }

    const groupByDay = opts?.groupByDay === true;

    // We compute every aggregate in SQL:
    //   - totalCostUsd: sum of cost_amount (numeric)
    //   - totalTokensIn/Out: sum of (nullable) token columns coerced to
    //     0 when NULL (a NULL token reading is an absence of data; the
    //     aggregate sum semantics here are "what we know about", so 0
    //     is the correct identity element). The query layer DOES NOT
    //     coerce: it forwards the value the repo returned.
    //   - invocationCount: COUNT(*) of rows in the bucket.
    //   - avgLatencyMs / p95LatencyMs: aggregates over the non-NULL
    //     latency rows only. When every row in a bucket has NULL
    //     latency, these are NULL (NOT zero), surfaced as null by the
    //     mapper below.
    const bucketDayExpr = sql<
      string | null
    >`to_char(${draftAttemptProviderLedger.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
    const nullBucketExpr = sql<string | null>`NULL::text`;

    const rows = await this.db
      .select({
        modelId: draftAttemptProviderLedger.modelId,
        providerId: draftAttemptProviderLedger.providerId,
        bucketDay: groupByDay ? bucketDayExpr : nullBucketExpr,
        totalCostUsd: sql<string>`coalesce(sum(${draftAttemptProviderLedger.costAmount}), 0)::text`,
        totalTokensIn: sql<string>`coalesce(sum(coalesce(${draftAttemptProviderLedger.tokensIn}, 0)), 0)::text`,
        totalTokensOut: sql<string>`coalesce(sum(coalesce(${draftAttemptProviderLedger.tokensOut}, 0)), 0)::text`,
        invocationCount: sql<string>`count(*)::text`,
        avgLatencyMs: sql<string | null>`(avg(${draftAttemptProviderLedger.latencyMs}))::text`,
        p95LatencyMs: sql<
          string | null
        >`(percentile_cont(0.95) within group (order by ${draftAttemptProviderLedger.latencyMs}))::text`,
      })
      .from(draftAttemptProviderLedger)
      .innerJoin(
        draftJobAttempts,
        eq(draftAttemptProviderLedger.draftJobAttemptId, draftJobAttempts.draftJobAttemptId),
      )
      .innerJoin(draftJobs, eq(draftJobAttempts.draftJobId, draftJobs.draftJobId))
      .where(
        and(
          eq(draftJobs.projectId, projectId),
          gte(draftAttemptProviderLedger.createdAt, window.from),
          lte(draftAttemptProviderLedger.createdAt, window.to),
        ),
      )
      .groupBy(
        draftAttemptProviderLedger.modelId,
        draftAttemptProviderLedger.providerId,
        ...(groupByDay ? [bucketDayExpr] : []),
      )
      .orderBy(asc(draftAttemptProviderLedger.modelId), asc(draftAttemptProviderLedger.providerId));

    return rows.map((row) => parseAggregateRow(row));
  }

  private async fetchByLedgerEntryId(
    ledgerEntryId: string,
  ): Promise<DraftAttemptProviderLedgerEntry | null> {
    const rows = await this.db
      .select()
      .from(draftAttemptProviderLedger)
      .where(eq(draftAttemptProviderLedger.ledgerEntryId, ledgerEntryId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return ledgerRowToEntry(row);
  }
}

function assertRecordLedgerEntryInput(input: RecordLedgerEntryInput): void {
  if (input.draftJobAttemptId.length === 0) {
    throw new DraftAttemptProviderLedgerRepositoryError(
      "ledger_entry_invalid_input",
      "draftJobAttemptId must be non-empty",
    );
  }
  if (input.providerProofId.length === 0) {
    throw new DraftAttemptProviderLedgerRepositoryError(
      "ledger_entry_invalid_input",
      "providerProofId must be non-empty",
    );
  }
  if (typeof input.providerId !== "string" || input.providerId.length === 0) {
    throw new DraftAttemptProviderLedgerRepositoryError(
      "ledger_entry_invalid_input",
      "providerId must be a non-empty string (ITOTORI-220 model+provider pair rule)",
    );
  }
  if (input.costUnit.length === 0) {
    throw new DraftAttemptProviderLedgerRepositoryError(
      "ledger_entry_invalid_input",
      "costUnit must be non-empty",
    );
  }
  if (!/^-?\d+(?:\.\d+)?$/u.test(input.costAmount)) {
    throw new DraftAttemptProviderLedgerRepositoryError(
      "ledger_entry_invalid_input",
      `costAmount must be a decimal string (got ${input.costAmount})`,
    );
  }
  if (input.costAmount.startsWith("-")) {
    throw new DraftAttemptProviderLedgerRepositoryError(
      "ledger_entry_invalid_input",
      "costAmount must be non-negative",
    );
  }
  // ITOTORI-232 — usage_response_json is required and must be a JSON
  // object (not an array, not a primitive, not null). The DB CHECK
  // enforces the same shape (`jsonb_typeof = 'object'`) plus the cost
  // equality; this typed gate gives callers a clear error before the
  // round-trip.
  if (
    input.usageResponseJson === null ||
    typeof input.usageResponseJson !== "object" ||
    Array.isArray(input.usageResponseJson)
  ) {
    throw new DraftAttemptProviderLedgerRepositoryError(
      "ledger_entry_invalid_input",
      "usageResponseJson must be a JSON object (ITOTORI-232 real-cost enforcement)",
    );
  }
  if (input.tokensIn !== undefined && (!Number.isInteger(input.tokensIn) || input.tokensIn < 0)) {
    throw new DraftAttemptProviderLedgerRepositoryError(
      "ledger_entry_invalid_input",
      "tokensIn must be a non-negative integer",
    );
  }
  if (
    input.tokensOut !== undefined &&
    (!Number.isInteger(input.tokensOut) || input.tokensOut < 0)
  ) {
    throw new DraftAttemptProviderLedgerRepositoryError(
      "ledger_entry_invalid_input",
      "tokensOut must be a non-negative integer",
    );
  }
  if (
    input.latencyMs !== undefined &&
    (!Number.isInteger(input.latencyMs) || input.latencyMs < 0)
  ) {
    throw new DraftAttemptProviderLedgerRepositoryError(
      "ledger_entry_invalid_input",
      "latencyMs must be a non-negative integer",
    );
  }
}

type RawAggregateRow = {
  modelId: string | null;
  providerId: string;
  bucketDay: string | null;
  totalCostUsd: string;
  totalTokensIn: string;
  totalTokensOut: string;
  invocationCount: string;
  avgLatencyMs: string | null;
  p95LatencyMs: string | null;
};

function parseAggregateRow(row: RawAggregateRow): LedgerPairAggregateRow {
  const totalTokensIn = Number.parseInt(row.totalTokensIn, 10);
  const totalTokensOut = Number.parseInt(row.totalTokensOut, 10);
  const invocationCount = Number.parseInt(row.invocationCount, 10);
  if (!Number.isFinite(totalTokensIn) || totalTokensIn < 0) {
    throw new DraftAttemptProviderLedgerRepositoryError(
      "ledger_entry_persistence_failed",
      `unexpected totalTokensIn aggregate ${row.totalTokensIn}`,
    );
  }
  if (!Number.isFinite(totalTokensOut) || totalTokensOut < 0) {
    throw new DraftAttemptProviderLedgerRepositoryError(
      "ledger_entry_persistence_failed",
      `unexpected totalTokensOut aggregate ${row.totalTokensOut}`,
    );
  }
  if (!Number.isFinite(invocationCount) || invocationCount < 0) {
    throw new DraftAttemptProviderLedgerRepositoryError(
      "ledger_entry_persistence_failed",
      `unexpected invocationCount aggregate ${row.invocationCount}`,
    );
  }
  return {
    modelId: row.modelId,
    providerId: row.providerId,
    bucketDay: row.bucketDay,
    totalCostUsd: row.totalCostUsd,
    totalTokensIn,
    totalTokensOut,
    invocationCount,
    avgLatencyMs: parseOptionalLatency(row.avgLatencyMs),
    p95LatencyMs: parseOptionalLatency(row.p95LatencyMs),
  };
}

function parseOptionalLatency(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) {
    return null;
  }
  return value;
}

function ledgerRowToEntry(
  row: typeof draftAttemptProviderLedger.$inferSelect,
): DraftAttemptProviderLedgerEntry {
  return {
    ledgerEntryId: row.ledgerEntryId,
    draftJobAttemptId: row.draftJobAttemptId,
    providerProofId: row.providerProofId,
    modelProviderFamily: row.modelProviderFamily,
    modelId: row.modelId,
    providerId: row.providerId,
    modelContextWindowTokens: row.modelContextWindowTokens,
    modelMaxOutputTokens: row.modelMaxOutputTokens,
    promptTemplateVersion: row.promptTemplateVersion,
    promptHash: row.promptHash,
    policyVersions: row.policyVersions,
    contextArtifactRefs: row.contextArtifactRefs,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    costUnit: row.costUnit,
    costAmount: row.costAmount,
    usageResponseJson: row.usageResponseJson,
    latencyMs: row.latencyMs,
    fallbackChain: row.fallbackChain,
    isRecordedProvider: row.isRecordedProvider,
    recordedProviderBundleId: row.recordedProviderBundleId,
    createdAt: row.createdAt,
  };
}
