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
    latencyMs: row.latencyMs,
    fallbackChain: row.fallbackChain,
    isRecordedProvider: row.isRecordedProvider,
    recordedProviderBundleId: row.recordedProviderBundleId,
    createdAt: row.createdAt,
  };
}
