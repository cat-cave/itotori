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
    costUnit: "usd",
    costAmount: "0.01250000",
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
      expect(entry.costUnit).toBe("usd");
      expect(entry.costAmount).toBe("0.01250000");
      expect(entry.latencyMs).toBe(1200);
      expect(entry.fallbackChain).toEqual([]);
      expect(entry.isRecordedProvider).toBe(false);
      expect(entry.recordedProviderBundleId).toBeNull();
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
      });
      await repo.recordLedgerEntry(localActor, {
        ...baseLedgerInput(attemptId),
        providerProofId: "proof-b",
        modelId: "anthropic/claude-3.5-sonnet",
        costAmount: "0.02000000",
      });
      await repo.recordLedgerEntry(localActor, {
        ...baseLedgerInput(attemptId),
        providerProofId: "proof-c",
        modelId: "openai/gpt-4o-mini",
        costAmount: "0.00500000",
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
      expect(grouped.byModel).toEqual({
        "anthropic/claude-3.5-sonnet": "0.03000000",
        "openai/gpt-4o-mini": "0.00500000",
      });
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
      });
      await repo.recordLedgerEntry(localActor, {
        ...baseLedgerInput(attemptId),
        providerProofId: "proof-prov-b",
        providerId: "anthropic",
        costAmount: "0.02500000",
      });
      await repo.recordLedgerEntry(localActor, {
        ...baseLedgerInput(attemptId),
        providerProofId: "proof-prov-c",
        providerId: "openai",
        costAmount: "0.00750000",
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
      });
      await repo.recordLedgerEntry(localActor, {
        ...baseLedgerInput(attemptId),
        providerProofId: "proof-day-2",
        modelId: "anthropic/claude-3.5-sonnet",
        providerId: "anthropic",
        costAmount: "0.02000000",
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
});
