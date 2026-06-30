import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import {
  ItotoriDraftAttemptProviderLedgerRepository,
  type RecordLedgerEntryInput,
} from "../src/repositories/draft-attempt-provider-ledger-repository.js";
import { ItotoriDraftJobRepository } from "../src/repositories/draft-job-repository.js";
import {
  draftJobFixtureInput,
  draftJobFixtureProjectId,
  provisionDraftJobFixtureProject,
} from "./draft-job-fixtures.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };
const deniedActor: AuthorizationActor = { userId: "user-without-required-permission" };

function pgErrorCodeOf(error: unknown): string | undefined {
  let current: unknown = error;
  while (current !== undefined && current !== null) {
    if (typeof current === "object" && "code" in current) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string") {
        return code;
      }
    }
    if (typeof current === "object" && "cause" in current) {
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return undefined;
}

async function provisionDraftAttempt(
  db: import("../src/connection.js").ItotoriDatabase,
): Promise<string> {
  const repo = new ItotoriDraftJobRepository(db);
  const job = await repo.createDraftJob(localActor, draftJobFixtureInput());
  const attempt = await repo.recordAttempt(localActor, job.draftJobId, {
    attemptIndex: 1,
    providerRunId: "provider-run-ledger-fixture",
    startedAt: new Date("2026-06-23T12:00:00Z"),
  });
  return attempt.draftJobAttemptId;
}

function baseLedgerInput(draftJobAttemptId: string): RecordLedgerEntryInput {
  return {
    draftJobAttemptId,
    providerProofId: "provider-proof-fixture-01",
    modelProviderFamily: "openrouter",
    modelId: "anthropic/claude-3.5-sonnet",
    // ITOTORI-220 — required pinned providerId per the (modelId, providerId)
    // pair rule.
    providerId: "anthropic",
    modelContextWindowTokens: 200_000,
    modelMaxOutputTokens: 8_192,
    promptTemplateVersion: "itotori-translation-agent-v1",
    promptHash: "sha256:abcdef",
    policyVersions: { styleGuide: "style-guide-v1", glossary: "glossary-v1" },
    contextArtifactRefs: [
      {
        contextArtifactId: "context-scene-001",
        category: "scene-summary",
        contentHash: "hash-context-001",
      },
    ],
    tokensIn: 500,
    tokensOut: 200,
    // general-audit-1 (genaudit1-00) — a recorded token count must name a
    // real provenance. Live OR usage parses to `provider_reported`.
    tokenCountSource: "provider_reported",
    costUnit: "usd",
    costAmount: "0.01250000",
    // ITOTORI-232 — required `usage` block mirrored from the originating
    // OR response. `cost: 0.0125` matches `costAmount: "0.01250000"`
    // exactly; the DB CHECK enforces equality within 1e-9 USD.
    usageResponseJson: {
      prompt_tokens: 500,
      completion_tokens: 200,
      total_tokens: 700,
      cost: 0.0125,
    },
    latencyMs: 1200,
    fallbackChain: [],
    isRecordedProvider: false,
  };
}

describe.skipIf(!process.env.DATABASE_URL)("ItotoriDraftAttemptProviderLedgerRepository", () => {
  it("recordLedgerEntry persists every column and round-trips JSON shapes", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const attemptId = await provisionDraftAttempt(context.db);
      const repo = new ItotoriDraftAttemptProviderLedgerRepository(context.db);

      const input = baseLedgerInput(attemptId);
      const entry = await repo.recordLedgerEntry(localActor, input);

      expect(entry.draftJobAttemptId).toBe(attemptId);
      expect(entry.providerProofId).toBe("provider-proof-fixture-01");
      expect(entry.modelProviderFamily).toBe("openrouter");
      expect(entry.modelId).toBe("anthropic/claude-3.5-sonnet");
      expect(entry.policyVersions).toEqual({
        styleGuide: "style-guide-v1",
        glossary: "glossary-v1",
      });
      expect(entry.contextArtifactRefs).toEqual([
        {
          contextArtifactId: "context-scene-001",
          category: "scene-summary",
          contentHash: "hash-context-001",
        },
      ]);
      expect(entry.tokensIn).toBe(500);
      expect(entry.tokensOut).toBe(200);
      expect(entry.tokenCountSource).toBe("provider_reported");
      expect(entry.costUnit).toBe("usd");
      expect(entry.costAmount).toBe("0.01250000");
      expect(entry.usageResponseJson).toEqual({
        prompt_tokens: 500,
        completion_tokens: 200,
        total_tokens: 700,
        cost: 0.0125,
      });
      expect(entry.latencyMs).toBe(1200);
      expect(entry.fallbackChain).toEqual([]);
      expect(entry.isRecordedProvider).toBe(false);
      expect(entry.recordedProviderBundleId).toBeNull();
      // ITOTORI-233 — cache columns default to 0 when the input omits
      // them. Pre-cache-aware callers continue to write valid rows.
      expect(entry.cacheReadTokens).toBe(0);
      expect(entry.cacheWriteTokens).toBe(0);
      expect(entry.cacheDiscountMicrosUsd).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("ITOTORI-232 — persists a sub-micro cost (0.00000602) at full precision; the cost-matches-usage CHECK passes", async () => {
    // The DEV_PAIR (deepseek-v4-flash) real-evidence cost. `amountMicrosUsd`
    // would round this to 6 micros = 0.000006 (a 2e-8 error) and the
    // migration-0041 CHECK `abs(cost_amount - usage->>'cost') < 1e-9` would
    // REJECT the row. Carrying the verbatim `usage.cost` decimal through
    // `cost_amount` is what makes this insert legal.
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const attemptId = await provisionDraftAttempt(context.db);
      const repo = new ItotoriDraftAttemptProviderLedgerRepository(context.db);

      const entry = await repo.recordLedgerEntry(localActor, {
        ...baseLedgerInput(attemptId),
        providerProofId: "provider-proof-submicro-01",
        costAmount: "0.00000602",
        usageResponseJson: {
          prompt_tokens: 500,
          completion_tokens: 200,
          total_tokens: 700,
          cost: 0.00000602,
        },
      });

      // The row inserted (no RecordedCostMismatch / DB check_violation) and
      // round-trips the full-precision decimal verbatim.
      expect(entry.costAmount).toBe("0.00000602");
      expect((entry.usageResponseJson as { cost: number }).cost).toBe(0.00000602);
    } finally {
      await context.close();
    }
  });

  it("ITOTORI-232 — a micros-ROUNDED cost (0.000006) for a sub-micro usage.cost is rejected by the DB CHECK", async () => {
    // Negative control: the pre-fix behaviour persisted
    // `amountMicrosUsd / 1e6` = 0.000006 against a real usage.cost of
    // 0.00000602. The migration-0041 CHECK must refuse that row — this is
    // the defect the full-precision `amountUsd` fix prevents.
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const attemptId = await provisionDraftAttempt(context.db);
      const repo = new ItotoriDraftAttemptProviderLedgerRepository(context.db);

      let pgCode: string | undefined;
      try {
        await repo.recordLedgerEntry(localActor, {
          ...baseLedgerInput(attemptId),
          providerProofId: "provider-proof-rounded-01",
          costAmount: "0.000006",
          usageResponseJson: {
            prompt_tokens: 500,
            completion_tokens: 200,
            total_tokens: 700,
            cost: 0.00000602,
          },
        });
      } catch (error) {
        pgCode = pgErrorCodeOf(error);
      }

      // Postgres check_violation = 23514 (the cost-matches-usage CHECK).
      expect(pgCode).toBe("23514");
    } finally {
      await context.close();
    }
  });

  it("ITOTORI-233 — round-trips cache_read_tokens / cache_write_tokens / cache_discount_micros_usd", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const attemptId = await provisionDraftAttempt(context.db);
      const repo = new ItotoriDraftAttemptProviderLedgerRepository(context.db);

      const input: RecordLedgerEntryInput = {
        ...baseLedgerInput(attemptId),
        cacheReadTokens: 250,
        cacheWriteTokens: 100,
        cacheDiscountMicrosUsd: 3, // 3 micros = $0.000003 USD (sub-micro round-up)
      };
      const entry = await repo.recordLedgerEntry(localActor, input);
      expect(entry.cacheReadTokens).toBe(250);
      expect(entry.cacheWriteTokens).toBe(100);
      expect(entry.cacheDiscountMicrosUsd).toBe(3);
    } finally {
      await context.close();
    }
  });

  it("ITOTORI-233 — rejects negative cache values at the application layer", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const attemptId = await provisionDraftAttempt(context.db);
      const repo = new ItotoriDraftAttemptProviderLedgerRepository(context.db);

      await expect(
        repo.recordLedgerEntry(localActor, {
          ...baseLedgerInput(attemptId),
          cacheReadTokens: -1,
        }),
      ).rejects.toThrow(/cacheReadTokens/);
      await expect(
        repo.recordLedgerEntry(localActor, {
          ...baseLedgerInput(attemptId),
          providerProofId: "provider-proof-fixture-neg-write",
          cacheWriteTokens: -1,
        }),
      ).rejects.toThrow(/cacheWriteTokens/);
      await expect(
        repo.recordLedgerEntry(localActor, {
          ...baseLedgerInput(attemptId),
          providerProofId: "provider-proof-fixture-neg-discount",
          cacheDiscountMicrosUsd: -1,
        }),
      ).rejects.toThrow(/cacheDiscountMicrosUsd/);
    } finally {
      await context.close();
    }
  });

  it("ITOTORI-233 — sumByPairAndDay surfaces cache hit count + cache savings aggregates", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const attemptId = await provisionDraftAttempt(context.db);
      const repo = new ItotoriDraftAttemptProviderLedgerRepository(context.db);

      // Two rows for the same pair: one cache hit ($0.000003 discount),
      // one miss ($0 discount). Hit rate = 1/2; savings = $0.000003.
      await repo.recordLedgerEntry(localActor, {
        ...baseLedgerInput(attemptId),
        providerProofId: "provider-proof-cache-hit",
        cacheReadTokens: 50,
        cacheWriteTokens: 0,
        cacheDiscountMicrosUsd: 3,
      });
      await repo.recordLedgerEntry(localActor, {
        ...baseLedgerInput(attemptId),
        providerProofId: "provider-proof-cache-miss",
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheDiscountMicrosUsd: 0,
      });

      const rows = await repo.sumByPairAndDay(localActor, draftJobFixtureProjectId, {
        from: new Date("2020-01-01T00:00:00Z"),
        to: new Date("2099-01-01T00:00:00Z"),
      });
      const pairRow = rows.find(
        (row) => row.modelId === "anthropic/claude-3.5-sonnet" && row.providerId === "anthropic",
      );
      expect(pairRow).toBeDefined();
      expect(pairRow!.invocationCount).toBe(2);
      expect(pairRow!.cacheHitCount).toBe(1);
      expect(pairRow!.totalCacheReadTokens).toBe(50);
      expect(pairRow!.totalCacheWriteTokens).toBe(0);
      // 3 micros / 1_000_000 = 0.000003 USD; SQL returns a numeric ::text
      // string. Compare as a number to tolerate any (formatting-only)
      // representation difference (e.g. 0.000003 vs 0.0000030).
      expect(Number(pairRow!.cacheSavingsUsd)).toBeCloseTo(0.000003, 9);
    } finally {
      await context.close();
    }
  });

  it("loadEntriesByAttempt returns entries for the attempt ordered by creation", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const attemptId = await provisionDraftAttempt(context.db);
      const repo = new ItotoriDraftAttemptProviderLedgerRepository(context.db);

      await repo.recordLedgerEntry(localActor, baseLedgerInput(attemptId));
      await repo.recordLedgerEntry(localActor, {
        ...baseLedgerInput(attemptId),
        providerProofId: "provider-proof-fixture-02",
        costAmount: "0.00500000",
        // ITOTORI-232 — `cost` in usage_response_json must match the
        // overridden `costAmount` (DB CHECK enforces within 1e-9 USD).
        usageResponseJson: {
          prompt_tokens: 500,
          completion_tokens: 200,
          total_tokens: 700,
          cost: 0.005,
        },
      });

      const entries = await repo.loadEntriesByAttempt(localActor, attemptId);
      expect(entries).toHaveLength(2);
      const ids = entries.map((entry) => entry.providerProofId);
      expect(ids).toContain("provider-proof-fixture-01");
      expect(ids).toContain("provider-proof-fixture-02");
    } finally {
      await context.close();
    }
  });

  it("loadEntriesByProviderProof returns a single entry or null", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const attemptId = await provisionDraftAttempt(context.db);
      const repo = new ItotoriDraftAttemptProviderLedgerRepository(context.db);

      await repo.recordLedgerEntry(localActor, baseLedgerInput(attemptId));

      const found = await repo.loadEntriesByProviderProof(localActor, "provider-proof-fixture-01");
      expect(found).not.toBeNull();
      expect(found?.providerProofId).toBe("provider-proof-fixture-01");

      const missing = await repo.loadEntriesByProviderProof(localActor, "no-such-proof");
      expect(missing).toBeNull();
    } finally {
      await context.close();
    }
  });

  it("recording the same provider_proof_id twice throws a unique-constraint error", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const attemptId = await provisionDraftAttempt(context.db);
      const repo = new ItotoriDraftAttemptProviderLedgerRepository(context.db);

      await repo.recordLedgerEntry(localActor, baseLedgerInput(attemptId));

      let captured: unknown;
      try {
        await repo.recordLedgerEntry(localActor, baseLedgerInput(attemptId));
      } catch (error) {
        captured = error;
      }
      expect(pgErrorCodeOf(captured)).toBe("23505");
    } finally {
      await context.close();
    }
  });

  it("fallback_chain JSON round-trips through the DB", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const attemptId = await provisionDraftAttempt(context.db);
      const repo = new ItotoriDraftAttemptProviderLedgerRepository(context.db);

      const fallbackChain = [
        {
          modelProviderFamily: "openrouter",
          modelId: "anthropic/claude-3.5-sonnet",
          failureReason: "provider_http_error: upstream 503",
          attemptedAt: "2026-06-23T12:00:00.000Z",
        },
        {
          modelProviderFamily: "openrouter",
          modelId: "openai/gpt-4o-mini",
          failureReason: "provider_response_invalid: malformed JSON",
          attemptedAt: "2026-06-23T12:00:01.500Z",
        },
      ];
      await repo.recordLedgerEntry(localActor, {
        ...baseLedgerInput(attemptId),
        fallbackChain,
      });

      const entries = await repo.loadEntriesByAttempt(localActor, attemptId);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.fallbackChain).toEqual(fallbackChain);
    } finally {
      await context.close();
    }
  });

  it("sumCostByProject aggregates cost across attempts within a window", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const attemptId = await provisionDraftAttempt(context.db);
      const repo = new ItotoriDraftAttemptProviderLedgerRepository(context.db);

      await repo.recordLedgerEntry(localActor, {
        ...baseLedgerInput(attemptId),
        providerProofId: "proof-a",
        modelId: "anthropic/claude-3.5-sonnet",
        costAmount: "0.01000000",
        usageResponseJson: { prompt_tokens: 500, completion_tokens: 200, cost: 0.01 },
      });
      await repo.recordLedgerEntry(localActor, {
        ...baseLedgerInput(attemptId),
        providerProofId: "proof-b",
        modelId: "anthropic/claude-3.5-sonnet",
        costAmount: "0.02000000",
        usageResponseJson: { prompt_tokens: 500, completion_tokens: 200, cost: 0.02 },
      });
      await repo.recordLedgerEntry(localActor, {
        ...baseLedgerInput(attemptId),
        providerProofId: "proof-c",
        modelId: "openai/gpt-4o-mini",
        costAmount: "0.00500000",
        usageResponseJson: { prompt_tokens: 500, completion_tokens: 200, cost: 0.005 },
      });

      const window = {
        from: new Date("2020-01-01T00:00:00Z"),
        to: new Date("2099-01-01T00:00:00Z"),
      };
      const total = await repo.sumCostByProject(localActor, draftJobFixtureProjectId, window);
      expect(total.totalCost).toBe("0.03500000");
      expect(total.byModel).toBeUndefined();

      const grouped = await repo.sumCostByProject(localActor, draftJobFixtureProjectId, window, {
        byModel: true,
      });
      expect(grouped.totalCost).toBe("0.03500000");
      // byModel is a RAW-nullable array (ByModelCostBucket), ordered by
      // descending cost — never a Record keyed on a collapsed sentinel.
      expect(grouped.byModel).toEqual([
        { modelId: "anthropic/claude-3.5-sonnet", totalCost: "0.03000000" },
        { modelId: "openai/gpt-4o-mini", totalCost: "0.00500000" },
      ]);
    } finally {
      await context.close();
    }
  });

  it("sumCostByProject byModel keeps a NULL modelId distinct from a literal 'unknown' model", async () => {
    // Regression guard for the audit finding
    // `sumcost-bymodel-collapses-null-modelid-into-unknown`: the byModel
    // path used to collapse NULL → "unknown" inside the repository, silently
    // merging NULL-attributed cost with any row whose model was literally
    // named "unknown". The corrected behaviour returns the RAW nullable
    // modelId so the two are DISTINCT buckets (sentinel applied downstream).
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const attemptId = await provisionDraftAttempt(context.db);
      const repo = new ItotoriDraftAttemptProviderLedgerRepository(context.db);

      // A NULL-modelId row (no model attributed). modelId is omitted so
      // the column is written NULL.
      const nullModelInput = { ...baseLedgerInput(attemptId) } as RecordLedgerEntryInput & {
        modelId?: string;
      };
      delete nullModelInput.modelId;
      await repo.recordLedgerEntry(localActor, {
        ...nullModelInput,
        providerProofId: "proof-null-model",
        costAmount: "0.01000000",
        usageResponseJson: { prompt_tokens: 500, completion_tokens: 200, cost: 0.01 },
      } as RecordLedgerEntryInput);
      // A row whose model is LITERALLY the string "unknown".
      await repo.recordLedgerEntry(localActor, {
        ...baseLedgerInput(attemptId),
        providerProofId: "proof-literal-unknown",
        modelId: "unknown",
        costAmount: "0.02000000",
        usageResponseJson: { prompt_tokens: 500, completion_tokens: 200, cost: 0.02 },
      });

      const window = {
        from: new Date("2020-01-01T00:00:00Z"),
        to: new Date("2099-01-01T00:00:00Z"),
      };
      const grouped = await repo.sumCostByProject(localActor, draftJobFixtureProjectId, window, {
        byModel: true,
      });

      // Two distinct buckets — the buggy path would have merged them into a
      // single "unknown" bucket of 0.03000000.
      expect(grouped.byModel).toHaveLength(2);
      expect(grouped.byModel).toContainEqual({ modelId: null, totalCost: "0.01000000" });
      expect(grouped.byModel).toContainEqual({ modelId: "unknown", totalCost: "0.02000000" });
    } finally {
      await context.close();
    }
  });

  it("ITOTORI-220: recordLedgerEntry rejects null/empty providerId", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const attemptId = await provisionDraftAttempt(context.db);
      const repo = new ItotoriDraftAttemptProviderLedgerRepository(context.db);

      // Empty string rejected at the typed input boundary.
      const emptyInput = { ...baseLedgerInput(attemptId), providerId: "" };
      await expect(repo.recordLedgerEntry(localActor, emptyInput)).rejects.toMatchObject({
        name: "DraftAttemptProviderLedgerRepositoryError",
        code: "ledger_entry_invalid_input",
      });

      // The DB column itself is NOT NULL — drop the providerId via a cast and
      // attempt the insert to confirm the schema layer enforces it.
      const nullInput = { ...baseLedgerInput(attemptId) } as RecordLedgerEntryInput & {
        providerId?: string;
      };
      delete nullInput.providerId;
      await expect(
        repo.recordLedgerEntry(localActor, nullInput as RecordLedgerEntryInput),
      ).rejects.toMatchObject({
        name: "DraftAttemptProviderLedgerRepositoryError",
        code: "ledger_entry_invalid_input",
      });
    } finally {
      await context.close();
    }
  });

  it("ITOTORI-220: recordLedgerEntry persists providerId and surfaces it on read", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const attemptId = await provisionDraftAttempt(context.db);
      const repo = new ItotoriDraftAttemptProviderLedgerRepository(context.db);

      const entry = await repo.recordLedgerEntry(localActor, {
        ...baseLedgerInput(attemptId),
        providerId: "anthropic",
      });
      expect(entry.providerId).toBe("anthropic");

      const reread = await repo.loadEntriesByProviderProof(localActor, entry.providerProofId);
      expect(reread?.providerId).toBe("anthropic");
    } finally {
      await context.close();
    }
  });

  it("ITOTORI-220: sumCostByProject aggregates by provider via byProvider option", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const attemptId = await provisionDraftAttempt(context.db);
      const repo = new ItotoriDraftAttemptProviderLedgerRepository(context.db);

      await repo.recordLedgerEntry(localActor, {
        ...baseLedgerInput(attemptId),
        providerProofId: "proof-prov-a",
        providerId: "anthropic",
        costAmount: "0.01500000",
        usageResponseJson: { prompt_tokens: 500, completion_tokens: 200, cost: 0.015 },
      });
      await repo.recordLedgerEntry(localActor, {
        ...baseLedgerInput(attemptId),
        providerProofId: "proof-prov-b",
        providerId: "anthropic",
        costAmount: "0.02500000",
        usageResponseJson: { prompt_tokens: 500, completion_tokens: 200, cost: 0.025 },
      });
      await repo.recordLedgerEntry(localActor, {
        ...baseLedgerInput(attemptId),
        providerProofId: "proof-prov-c",
        providerId: "openai",
        costAmount: "0.00750000",
        usageResponseJson: { prompt_tokens: 500, completion_tokens: 200, cost: 0.0075 },
      });

      const window = {
        from: new Date("2020-01-01T00:00:00Z"),
        to: new Date("2099-01-01T00:00:00Z"),
      };
      const grouped = await repo.sumCostByProject(localActor, draftJobFixtureProjectId, window, {
        byProvider: true,
      });
      expect(grouped.totalCost).toBe("0.04750000");
      expect(grouped.byProvider).toEqual({
        anthropic: "0.04000000",
        openai: "0.00750000",
      });
    } finally {
      await context.close();
    }
  });

  it("ITOTORI-223: sumByPairAndDay aggregates cost/tokens/latency per (model, provider) pair", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const attemptId = await provisionDraftAttempt(context.db);
      const repo = new ItotoriDraftAttemptProviderLedgerRepository(context.db);

      await repo.recordLedgerEntry(localActor, {
        ...baseLedgerInput(attemptId),
        providerProofId: "proof-pair-a-1",
        modelId: "anthropic/claude-3.5-sonnet",
        providerId: "anthropic",
        costAmount: "0.01000000",
        tokensIn: 100,
        tokensOut: 50,
        latencyMs: 1000,
        usageResponseJson: { prompt_tokens: 100, completion_tokens: 50, cost: 0.01 },
      });
      await repo.recordLedgerEntry(localActor, {
        ...baseLedgerInput(attemptId),
        providerProofId: "proof-pair-a-2",
        modelId: "anthropic/claude-3.5-sonnet",
        providerId: "anthropic",
        costAmount: "0.02000000",
        tokensIn: 200,
        tokensOut: 100,
        latencyMs: 3000,
        usageResponseJson: { prompt_tokens: 200, completion_tokens: 100, cost: 0.02 },
      });
      await repo.recordLedgerEntry(localActor, {
        ...baseLedgerInput(attemptId),
        providerProofId: "proof-pair-b-1",
        modelId: "openai/gpt-4o-mini",
        providerId: "openai",
        costAmount: "0.00500000",
        tokensIn: 50,
        tokensOut: 25,
        latencyMs: 500,
        usageResponseJson: { prompt_tokens: 50, completion_tokens: 25, cost: 0.005 },
      });

      const window = {
        from: new Date("2020-01-01T00:00:00Z"),
        to: new Date("2099-01-01T00:00:00Z"),
      };
      const rows = await repo.sumByPairAndDay(localActor, draftJobFixtureProjectId, window);
      expect(rows).toHaveLength(2);

      const anthropicRow = rows.find(
        (row) => row.modelId === "anthropic/claude-3.5-sonnet" && row.providerId === "anthropic",
      );
      expect(anthropicRow).toBeDefined();
      expect(anthropicRow!.totalCostUsd).toBe("0.03000000");
      expect(anthropicRow!.totalTokensIn).toBe(300);
      expect(anthropicRow!.totalTokensOut).toBe(150);
      expect(anthropicRow!.invocationCount).toBe(2);
      expect(anthropicRow!.avgLatencyMs).toBe(2000);
      // p95 of [1000, 3000] = 2900
      expect(anthropicRow!.p95LatencyMs).toBe(2900);
      expect(anthropicRow!.bucketDay).toBeNull();

      const openaiRow = rows.find(
        (row) => row.modelId === "openai/gpt-4o-mini" && row.providerId === "openai",
      );
      expect(openaiRow).toBeDefined();
      expect(openaiRow!.totalCostUsd).toBe("0.00500000");
      expect(openaiRow!.invocationCount).toBe(1);
      expect(openaiRow!.avgLatencyMs).toBe(500);
      expect(openaiRow!.p95LatencyMs).toBe(500);
    } finally {
      await context.close();
    }
  });

  it("ITOTORI-223: sumByPairAndDay with groupByDay returns one row per (pair, day)", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const attemptId = await provisionDraftAttempt(context.db);
      const repo = new ItotoriDraftAttemptProviderLedgerRepository(context.db);

      await repo.recordLedgerEntry(localActor, {
        ...baseLedgerInput(attemptId),
        providerProofId: "proof-day-1",
        modelId: "anthropic/claude-3.5-sonnet",
        providerId: "anthropic",
        costAmount: "0.01000000",
        usageResponseJson: { prompt_tokens: 500, completion_tokens: 200, cost: 0.01 },
      });
      await repo.recordLedgerEntry(localActor, {
        ...baseLedgerInput(attemptId),
        providerProofId: "proof-day-2",
        modelId: "anthropic/claude-3.5-sonnet",
        providerId: "anthropic",
        costAmount: "0.02000000",
        usageResponseJson: { prompt_tokens: 500, completion_tokens: 200, cost: 0.02 },
      });

      const window = {
        from: new Date("2020-01-01T00:00:00Z"),
        to: new Date("2099-01-01T00:00:00Z"),
      };
      const rows = await repo.sumByPairAndDay(localActor, draftJobFixtureProjectId, window, {
        groupByDay: true,
      });
      expect(rows.length).toBeGreaterThanOrEqual(1);
      for (const row of rows) {
        expect(row.bucketDay).not.toBeNull();
        expect(row.bucketDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    } finally {
      await context.close();
    }
  });

  it("sumCostByProject returns zero when the window excludes every entry", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const attemptId = await provisionDraftAttempt(context.db);
      const repo = new ItotoriDraftAttemptProviderLedgerRepository(context.db);

      await repo.recordLedgerEntry(localActor, baseLedgerInput(attemptId));

      const window = {
        from: new Date("1990-01-01T00:00:00Z"),
        to: new Date("1990-01-02T00:00:00Z"),
      };
      const total = await repo.sumCostByProject(localActor, draftJobFixtureProjectId, window);
      expect(total.totalCost).toBe("0");
    } finally {
      await context.close();
    }
  });

  it("denies draftWrite paths when the actor lacks draft.write", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const repo = new ItotoriDraftAttemptProviderLedgerRepository(context.db);
      await expect(
        repo.recordLedgerEntry(deniedActor, baseLedgerInput("draft-job-attempt-x")),
      ).rejects.toMatchObject({ name: "AuthorizationError", permission: "draft.write" });
    } finally {
      await context.close();
    }
  });

  it("denies catalogRead paths when the actor lacks catalog.read", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const repo = new ItotoriDraftAttemptProviderLedgerRepository(context.db);
      await expect(
        repo.loadEntriesByAttempt(deniedActor, "draft-job-attempt-x"),
      ).rejects.toMatchObject({ name: "AuthorizationError", permission: "catalog.read" });
      await expect(
        repo.loadEntriesByProviderProof(deniedActor, "provider-proof-x"),
      ).rejects.toMatchObject({ name: "AuthorizationError", permission: "catalog.read" });
      await expect(
        repo.sumCostByProject(deniedActor, draftJobFixtureProjectId, {
          from: new Date(0),
          to: new Date(),
        }),
      ).rejects.toMatchObject({ name: "AuthorizationError", permission: "catalog.read" });
    } finally {
      await context.close();
    }
  });

  // ---------------------------------------------------------------------
  // ITOTORI-232 — schema-level enforcement of real cost.
  //
  // Migration 0041 adds three guards on itotori_draft_attempt_provider_ledger:
  //   (a) cost_unit = 'usd';
  //   (b) usage_response_json jsonb NOT NULL + jsonb_typeof = 'object';
  //   (c) cost_amount equals (usage_response_json->>'cost')::numeric within
  //       1e-9 USD whenever usage_response_json carries a real `cost` field.
  //
  // The tests below assert each guard fires with the expected Postgres
  // error code (23514 check_violation, 23502 not_null_violation) so a
  // future regression cannot silently weaken them.
  // ---------------------------------------------------------------------

  it("ITOTORI-232: rejects row whose cost_amount mismatches usage_response_json.cost", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const attemptId = await provisionDraftAttempt(context.db);
      const repo = new ItotoriDraftAttemptProviderLedgerRepository(context.db);

      // The audit-mandated regression: cost_amount = 99 (fake) but the
      // mirrored usage block reports a real cost of 0.000005 USD. The
      // partial-NULL CHECK fires because usage_response_json carries a
      // real `cost` field.
      let captured: unknown;
      try {
        await repo.recordLedgerEntry(localActor, {
          ...baseLedgerInput(attemptId),
          providerProofId: "provider-proof-fake-cost-01",
          costAmount: "99.00000000",
          usageResponseJson: {
            prompt_tokens: 500,
            completion_tokens: 200,
            cost: 0.000005,
          },
        });
      } catch (error) {
        captured = error;
      }
      expect(pgErrorCodeOf(captured)).toBe("23514");
      const message = (captured as { message?: string } | undefined)?.message ?? "";
      expect(message).toMatch(/cost.*usage|usage.*cost|check/iu);
    } finally {
      await context.close();
    }
  });

  it("ITOTORI-232: allows rows whose usage_response_json has no `cost` field (sentinel exempt)", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const attemptId = await provisionDraftAttempt(context.db);
      const repo = new ItotoriDraftAttemptProviderLedgerRepository(context.db);

      // Offline / local / fake provider rows that genuinely never billed
      // carry an object with no `cost` key. The partial-NULL CHECK
      // exempts these — cost_amount = 0 by application contract; the
      // sentinel key is greppable.
      const entry = await repo.recordLedgerEntry(localActor, {
        ...baseLedgerInput(attemptId),
        providerProofId: "provider-proof-zero-cost-01",
        costAmount: "0.00000000",
        usageResponseJson: { _local_no_billing: true },
      });
      expect(entry.costAmount).toBe("0.00000000");
      expect(entry.usageResponseJson).toEqual({ _local_no_billing: true });
    } finally {
      await context.close();
    }
  });

  it("ITOTORI-232: rejects row whose cost_unit is not 'usd'", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const attemptId = await provisionDraftAttempt(context.db);
      const repo = new ItotoriDraftAttemptProviderLedgerRepository(context.db);

      let captured: unknown;
      try {
        await repo.recordLedgerEntry(localActor, {
          ...baseLedgerInput(attemptId),
          providerProofId: "provider-proof-bad-unit-01",
          costUnit: "eur",
        });
      } catch (error) {
        captured = error;
      }
      expect(pgErrorCodeOf(captured)).toBe("23514");
    } finally {
      await context.close();
    }
  });

  it("ITOTORI-232: rejects row whose usage_response_json is not a JSON object", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const attemptId = await provisionDraftAttempt(context.db);
      // Bypass the typed repository to attempt a raw INSERT with a
      // JSON array for usage_response_json. The DB CHECK
      // `jsonb_typeof(usage_response_json) = 'object'` must reject it.
      let captured: unknown;
      try {
        await context.pool.query(
          `insert into itotori_draft_attempt_provider_ledger (
              ledger_entry_id,
              draft_job_attempt_id,
              provider_proof_id,
              provider_id,
              cost_unit,
              cost_amount,
              usage_response_json
            ) values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [
            "draft-attempt-provider-ledger-bad-shape",
            attemptId,
            "provider-proof-bad-shape-01",
            "anthropic",
            "usd",
            "0.00000000",
            '["not", "an", "object"]',
          ],
        );
      } catch (error) {
        captured = error;
      }
      expect(pgErrorCodeOf(captured)).toBe("23514");
    } finally {
      await context.close();
    }
  });

  it("ITOTORI-232: allows rows whose cost_amount matches usage_response_json.cost within 1e-9", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const attemptId = await provisionDraftAttempt(context.db);
      const repo = new ItotoriDraftAttemptProviderLedgerRepository(context.db);

      // costAmount stores 8-decimal-place truncation of cost; the 9th
      // and below are within tolerance. 0.00001234 ~= 0.0000123399 to
      // within 1e-9. The CHECK MUST accept it.
      const entry = await repo.recordLedgerEntry(localActor, {
        ...baseLedgerInput(attemptId),
        providerProofId: "provider-proof-tight-match-01",
        costAmount: "0.00001234",
        usageResponseJson: { cost: 0.00001234 },
      });
      expect(entry.costAmount).toBe("0.00001234");
    } finally {
      await context.close();
    }
  });

  it("ITOTORI-220: a raw insert omitting provider_id fails loud (no 'unknown' sentinel default)", async () => {
    // The schema's `.default("unknown")` was removed (migration 0047) so a
    // row that never declared the served provider can no longer be silently
    // recorded as the fake (model, "unknown") pair. A direct insert that
    // omits provider_id — bypassing the repository's typed gate — must now
    // hit the NOT NULL constraint (Postgres 23502) instead of defaulting.
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const attemptId = await provisionDraftAttempt(context.db);

      let captured: unknown;
      try {
        // usage_response_json `{}` carries no `cost` key, so the real-cost
        // CHECK is exempt — the ONLY thing that can fail here is the missing
        // provider_id, proving the dropped default is what fails loud.
        await context.pool.query(
          `insert into itotori_draft_attempt_provider_ledger
             (ledger_entry_id, draft_job_attempt_id, provider_proof_id,
              cost_unit, cost_amount, usage_response_json)
           values ($1, $2, $3, 'usd', '0', '{}'::jsonb)`,
          ["ledger-no-provider-01", attemptId, "provider-proof-no-provider-01"],
        );
      } catch (error) {
        captured = error;
      }
      // Postgres not_null_violation = 23502.
      expect(pgErrorCodeOf(captured)).toBe("23502");
      const message = (captured as { message?: string } | undefined)?.message ?? "";
      expect(message).toMatch(/provider_id/u);

      // No fake "unknown" row leaked through.
      const rows = await context.pool.query(
        "select provider_id from itotori_draft_attempt_provider_ledger",
      );
      expect(rows.rows).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
});
