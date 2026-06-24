// ITOTORI-077 - Draft attempt recorder unit tests.
//
// The recorder is a pure function over the in-memory ledger
// repository; we use an in-memory stub so the test suite never has to
// reach the database. The redaction regression guards the contract
// that the raw prompt body and raw response payload never appear in
// the ledger row.

import { describe, expect, it } from "vitest";
import type {
  AuthorizationActor,
  DraftAttemptProviderLedgerEntry,
  ItotoriDraftAttemptProviderLedgerRepository,
  RecordLedgerEntryInput,
  SumCostByProjectOptions,
  SumCostByProjectResult,
  SumCostByProjectWindow,
} from "@itotori/db";
import { DraftAttemptRecorder } from "../src/draft/draft-attempt-recorder.js";
import {
  DRAFT_ATTEMPT_FIXTURE_DRAFT_JOB_ATTEMPT_ID,
  DRAFT_ATTEMPT_FIXTURE_PROMPT_HASH,
  fallbackChainFixture,
  recordedProviderFixture,
  successfulAttemptFixture,
} from "../src/draft/draft-attempt-fixtures.js";

const FIXED_ACTOR: AuthorizationActor = { userId: "local-user" };

class InMemoryLedgerRepository implements ItotoriDraftAttemptProviderLedgerRepository {
  public readonly entries: DraftAttemptProviderLedgerEntry[] = [];
  // Allow access to the constructor parameter for type compatibility.
  // The recorder only invokes `recordLedgerEntry`.
  constructor() {}

  async recordLedgerEntry(
    _actor: AuthorizationActor,
    input: RecordLedgerEntryInput,
  ): Promise<DraftAttemptProviderLedgerEntry> {
    if (this.entries.some((entry) => entry.providerProofId === input.providerProofId)) {
      throw new Error(
        `duplicate provider_proof_id: ${input.providerProofId} (in-memory stub enforces unique constraint)`,
      );
    }
    const entry: DraftAttemptProviderLedgerEntry = {
      ledgerEntryId: `ledger-${this.entries.length + 1}`,
      draftJobAttemptId: input.draftJobAttemptId,
      providerProofId: input.providerProofId,
      modelProviderFamily: input.modelProviderFamily ?? null,
      modelId: input.modelId ?? null,
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
      createdAt: new Date(),
    };
    this.entries.push(entry);
    return entry;
  }

  async loadEntriesByAttempt(
    _actor: AuthorizationActor,
    draftJobAttemptId: string,
  ): Promise<DraftAttemptProviderLedgerEntry[]> {
    return this.entries.filter((entry) => entry.draftJobAttemptId === draftJobAttemptId);
  }

  async loadEntriesByProviderProof(
    _actor: AuthorizationActor,
    providerProofId: string,
  ): Promise<DraftAttemptProviderLedgerEntry | null> {
    return this.entries.find((entry) => entry.providerProofId === providerProofId) ?? null;
  }

  async sumCostByProject(
    _actor: AuthorizationActor,
    _projectId: string,
    _window: SumCostByProjectWindow,
    opts?: SumCostByProjectOptions,
  ): Promise<SumCostByProjectResult> {
    const total = this.entries.reduce((acc, entry) => acc + Number(entry.costAmount), 0);
    const result: SumCostByProjectResult = { totalCost: total.toFixed(8) };
    if (opts?.byModel === true) {
      const byModel: Record<string, number> = {};
      for (const entry of this.entries) {
        const key = entry.modelId ?? "unknown";
        byModel[key] = (byModel[key] ?? 0) + Number(entry.costAmount);
      }
      result.byModel = Object.fromEntries(
        Object.entries(byModel).map(([key, value]) => [key, value.toFixed(8)]),
      );
    }
    return result;
  }
}

describe("DraftAttemptRecorder", () => {
  it("successfulAttemptFixture persists and round-trips byte-equal via the in-memory repository", async () => {
    const repo = new InMemoryLedgerRepository();
    const recorder = new DraftAttemptRecorder(
      repo as unknown as ItotoriDraftAttemptProviderLedgerRepository,
    );
    const args = successfulAttemptFixture();

    const entry = await recorder.record(FIXED_ACTOR, args);

    expect(entry.draftJobAttemptId).toBe(DRAFT_ATTEMPT_FIXTURE_DRAFT_JOB_ATTEMPT_ID);
    expect(entry.providerProofId).toBe("live:provider-run-success-01");
    expect(entry.modelProviderFamily).toBe("openrouter");
    expect(entry.modelId).toBe("anthropic/claude-3.5-sonnet");
    expect(entry.modelContextWindowTokens).toBe(200_000);
    expect(entry.modelMaxOutputTokens).toBe(8_192);
    expect(entry.promptHash).toBe(`sha256:${DRAFT_ATTEMPT_FIXTURE_PROMPT_HASH}`);
    expect(entry.tokensIn).toBe(480);
    expect(entry.tokensOut).toBe(220);
    expect(entry.costUnit).toBe("usd");
    expect(entry.costAmount).toBe("0.01250000");
    expect(entry.latencyMs).toBe(1200);
    expect(entry.fallbackChain).toEqual([]);
    expect(entry.isRecordedProvider).toBe(false);
    expect(entry.recordedProviderBundleId).toBeNull();

    const reloaded = await repo.loadEntriesByProviderProof(FIXED_ACTOR, entry.providerProofId);
    expect(reloaded).toEqual(entry);
  });

  it("fallbackChainFixture persists the fallback chain and the actual-model id", async () => {
    const repo = new InMemoryLedgerRepository();
    const recorder = new DraftAttemptRecorder(
      repo as unknown as ItotoriDraftAttemptProviderLedgerRepository,
    );
    const args = fallbackChainFixture();
    const entry = await recorder.record(FIXED_ACTOR, args);

    expect(entry.fallbackChain).toHaveLength(1);
    expect(entry.fallbackChain[0]!.modelId).toBe("anthropic/claude-3.5-sonnet");
    expect(entry.fallbackChain[0]!.failureReason).toContain("provider_http_error");
    expect(entry.modelId).toBe("anthropic/claude-3.5-sonnet"); // modelProfile.modelId stays the requested model
    expect(entry.providerProofId).toBe("live:provider-run-fallback-01");
    expect(entry.costAmount).toBe("0.00850000");
  });

  it("recordedProviderFixture marks the entry as recorded and stamps a zero cost", async () => {
    const repo = new InMemoryLedgerRepository();
    const recorder = new DraftAttemptRecorder(
      repo as unknown as ItotoriDraftAttemptProviderLedgerRepository,
    );
    const args = recordedProviderFixture();
    const entry = await recorder.record(FIXED_ACTOR, args);

    expect(entry.isRecordedProvider).toBe(true);
    expect(entry.recordedProviderBundleId).toBe("recorded-bundle-01");
    expect(entry.providerProofId).toBe("recorded:recorded-bundle-01");
    expect(entry.costAmount).toBe("0.00000000");
    expect(entry.modelProviderFamily).toBe("recorded");
  });

  it("never writes the raw prompt body or raw response payload (redaction regression)", async () => {
    const repo = new InMemoryLedgerRepository();
    const recorder = new DraftAttemptRecorder(
      repo as unknown as ItotoriDraftAttemptProviderLedgerRepository,
    );

    // Inject the must-never-appear sentinel into a fresh translation
    // result by piggybacking on the fixture's draftText and the
    // (intentionally) extra rationale field. The recorder MUST NOT
    // forward these strings into the ledger row.
    const SENTINEL = "REDACTED-MUST-NEVER-APPEAR";
    const base = successfulAttemptFixture();
    const args = {
      ...base,
      translationResult: {
        ...base.translationResult,
        drafts: base.translationResult.drafts.map((draft) => ({
          ...draft,
          draftText: `${SENTINEL}-DRAFT`,
          agentRationale: `${SENTINEL}-RATIONALE`,
        })),
      },
    };

    const entry = await recorder.record(FIXED_ACTOR, args);
    const serialised = JSON.stringify(entry);
    expect(serialised).not.toContain(SENTINEL);

    // Belt-and-braces: confirm the input we constructed actually did
    // contain the sentinel; if not, the assertion above is vacuous.
    expect(JSON.stringify(args.translationResult.drafts)).toContain(SENTINEL);
  });

  it("aggregates cost across all three fixtures via sumCostByProject", async () => {
    const repo = new InMemoryLedgerRepository();
    const recorder = new DraftAttemptRecorder(
      repo as unknown as ItotoriDraftAttemptProviderLedgerRepository,
    );

    await recorder.record(FIXED_ACTOR, successfulAttemptFixture());
    await recorder.record(FIXED_ACTOR, fallbackChainFixture());
    await recorder.record(FIXED_ACTOR, recordedProviderFixture());

    const window: SumCostByProjectWindow = {
      from: new Date("2020-01-01T00:00:00Z"),
      to: new Date("2099-01-01T00:00:00Z"),
    };
    const total = await repo.sumCostByProject(FIXED_ACTOR, "project-draft-job", window, {
      byModel: true,
    });

    // 0.01250000 + 0.00850000 + 0.00000000 = 0.02100000
    expect(total.totalCost).toBe("0.02100000");
    expect(total.byModel).toBeDefined();
    expect(total.byModel!["anthropic/claude-3.5-sonnet"]).toBe("0.02100000");
  });
});
