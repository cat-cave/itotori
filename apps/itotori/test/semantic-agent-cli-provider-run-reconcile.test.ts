// semantic-agent-cli-provider-run-not-reconciled — deterministic proof that a
// STANDALONE semantic-agent CLI run's provider-run is RECONCILED.
//
// Before the fix, the four standalone semantic-agent CLIs (scene-summary /
// character-relationship / route-choice-map / terminology-candidate) built
// their live OpenRouter provider with a recorder that DEFAULTED to the global
// scratch `.tmp/provider-runs` directory — a directory the telemetry
// reconciler never reads. So a standalone CLI run's served (model, provider)
// pair + billed `usage.cost` + ZDR posture were invisible to cost
// reconciliation.
//
// This test drives the REAL production path deterministically (mock fetch, no
// live key): it resolves the scene-summary provider through the SAME
// `resolveSceneSummaryProvider` seam the CLI uses, pointed at a RUN-SCOPED
// `LocalProviderRunArtifactRecorder(dir)` (exactly what the CLI now threads
// from `--provider-runs-dir`), runs the CLI runner, and asserts the run lands
// in that run-scoped directory — with the served pair, the REAL billed
// `usage.cost`, and ZDR enforced — read back through the SAME telemetry
// reconciliation reader (`readProviderRunArtifactsFromDir` +
// `aggregateProviderRunArtifacts`) that the reconciler consumes.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AuthorizationActor,
  BridgeUnitTextRecord,
  ItotoriSceneSummaryRepositoryPort,
  ItotoriTranslationBatchRepositoryPort,
  LoadBridgeUnitsForSummaryInput,
  LoadSceneSummaryByScene,
  LoadTranslationBatchesQuery,
  SceneSummaryRecord,
  TranslationBatchRecord,
} from "@itotori/db";
import {
  runGenerateSceneSummariesCli,
  resolveSceneSummaryProvider,
  type SceneSummaryCliDependencies,
} from "../src/agents/scene-summary/index.js";
import { DEV_PAIR, LocalProviderRunArtifactRecorder } from "../src/providers/index.js";
import {
  aggregateProviderRunArtifacts,
  readProviderRunArtifactsFromDir,
  SERVED_PROVIDER_UNKNOWN_SENTINEL,
} from "../src/telemetry/provider-run-artifact-source.js";
import { buildPairKey } from "../src/telemetry/queries.js";

const ACTOR: AuthorizationActor = { userId: "local-user" };

// Served upstream provider slug the mock OpenRouter response reports. Distinct
// from the requested provider so the assertions also prove the SERVED pair is
// carried through to the reconciled surface.
const SERVED_UPSTREAM = "fireworks";
// The REAL billed cost the (mock) OpenRouter endpoint reports as its own
// `usage.cost` wire field. This is the endpoint's value threaded verbatim
// through the provider — never a hard-coded ProviderCost literal in itotori.
const WIRE_USAGE_COST = 0.00004242;

/** Chat-completions success body mirroring the OpenRouter wire shape. */
function successResponse(): Response {
  const body = {
    id: "gen-recon-" + Math.random().toString(36).slice(2, 10),
    model: DEV_PAIR.modelId,
    provider: SERVED_UPSTREAM,
    choices: [
      { finish_reason: "stop", message: { role: "assistant", content: "A short summary." } },
    ],
    usage: {
      prompt_tokens: 42,
      completion_tokens: 8,
      total_tokens: 50,
      cost: WIRE_USAGE_COST,
    },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function unitRecord(bridgeUnitId: string): BridgeUnitTextRecord {
  return {
    bridgeUnitId,
    sourceUnitKey: "scene.001.line.001",
    sourceText: "勇者は王様に挨拶した。",
    sourceHash: `${bridgeUnitId}-hash`,
    speaker: "勇者",
    occurrenceId: "occ-1",
  };
}

function batchRecord(unit: BridgeUnitTextRecord): TranslationBatchRecord {
  return {
    batchId: "batch-1",
    projectId: "p",
    localeBranchId: "lb",
    sourceRevisionId: "rev-1",
    batchOrdinal: 1,
    tokenEstimate: 100,
    tokenBudgetCap: 1000,
    sceneId: "scene-1",
    sceneSplitIndex: null,
    routeId: null,
    modelProviderFamily: "openrouter",
    modelId: DEV_PAIR.modelId,
    modelContextWindowTokens: 8000,
    modelMaxOutputTokens: 256,
    modelTargetFillRatio: 0.7,
    modelPromptOverheadTokens: 200,
    tokenEstimatorId: "itotori-batch-estimator-v1",
    nearCapWarning: false,
    generatedAt: new Date("2026-06-23T12:00:00Z"),
    createdAt: new Date("2026-06-23T12:00:00Z"),
    units: [
      {
        bridgeUnitId: unit.bridgeUnitId,
        sourceUnitKey: unit.sourceUnitKey,
        sourceHash: unit.sourceHash,
        unitOrdinal: 1,
      },
    ],
    contextRefs: [],
  };
}

class OneBatchRepository implements ItotoriTranslationBatchRepositoryPort {
  constructor(private readonly batches: TranslationBatchRecord[]) {}
  async saveBatches(): Promise<TranslationBatchRecord[]> {
    return this.batches;
  }
  async loadBatches(
    _actor: AuthorizationActor,
    _query: LoadTranslationBatchesQuery,
  ): Promise<TranslationBatchRecord[]> {
    return this.batches;
  }
  async loadBatchById(
    _actor: AuthorizationActor,
    batchId: string,
  ): Promise<TranslationBatchRecord | null> {
    return this.batches.find((b) => b.batchId === batchId) ?? null;
  }
}

// Minimal read-only summary repository: the run is `--dry-run` so no summary is
// persisted; only the three read paths the runner exercises are implemented.
class ReadOnlySummaryRepository implements ItotoriSceneSummaryRepositoryPort {
  constructor(private readonly units: Map<string, BridgeUnitTextRecord>) {}
  async saveSummary(): Promise<SceneSummaryRecord> {
    throw new Error("dry-run: saveSummary must not be called");
  }
  async loadSummaryByScene(
    _actor: AuthorizationActor,
    _query: LoadSceneSummaryByScene,
  ): Promise<SceneSummaryRecord | null> {
    return null;
  }
  async loadSummaries(): Promise<SceneSummaryRecord[]> {
    return [];
  }
  async markStale(): Promise<void> {}
  async currentSourceHashesForBridgeUnits(): Promise<Map<string, string>> {
    return new Map();
  }
  async loadBridgeUnitsForSummary(
    _actor: AuthorizationActor,
    input: LoadBridgeUnitsForSummaryInput,
  ): Promise<Map<string, BridgeUnitTextRecord>> {
    const out = new Map<string, BridgeUnitTextRecord>();
    for (const id of input.bridgeUnitIds) {
      const rec = this.units.get(id);
      if (rec) out.set(id, rec);
    }
    return out;
  }
}

describe("semantic-agent-cli-provider-run-not-reconciled — standalone CLI run is reconciled", () => {
  let runsDir: string;
  let priorZdr: string | undefined;
  let priorKey: string | undefined;

  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), "itotori-sacli-reconcile-"));
    priorZdr = process.env.OPENROUTER_ZDR_ACCOUNT_ASSERTED;
    priorKey = process.env.OPENROUTER_API_KEY;
  });

  afterEach(() => {
    rmSync(runsDir, { recursive: true, force: true });
    if (priorZdr === undefined) delete process.env.OPENROUTER_ZDR_ACCOUNT_ASSERTED;
    else process.env.OPENROUTER_ZDR_ACCOUNT_ASSERTED = priorZdr;
    if (priorKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = priorKey;
  });

  it("records the served (model,provider) pair + billed usage.cost + ZDR into the run-scoped dir the reconciler reads", async () => {
    const unit = unitRecord("u-1");
    const runScopedRecorder = new LocalProviderRunArtifactRecorder(runsDir);

    // Resolve the REAL live provider through the SAME seam the CLI uses,
    // pointed at the run-scoped recorder (mirrors what the CLI threads from
    // `--provider-runs-dir`). Transport is a mock fetch so the run is
    // deterministic and free; the account-ZDR + API-key gates are satisfied
    // via the injected env.
    const provider = resolveSceneSummaryProvider("openrouter", {
      artifactRecorder: runScopedRecorder,
      env: { OPENROUTER_API_KEY: "test-key", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: (async () => successResponse()) as unknown as typeof fetch,
    });

    const deps: SceneSummaryCliDependencies = {
      actor: ACTOR,
      batchRepository: new OneBatchRepository([batchRecord(unit)]),
      summaryRepository: new ReadOnlySummaryRepository(new Map([[unit.bridgeUnitId, unit]])),
      provider,
      now: () => new Date("2026-06-23T12:00:00Z"),
    };

    const result = await runGenerateSceneSummariesCli(
      {
        projectId: "p",
        localeBranchId: "lb",
        sourceLocale: "ja-JP",
        sourceRevisionId: "rev-1",
        modelProfile: {
          providerFamily: "openrouter",
          modelId: DEV_PAIR.modelId,
          providerId: DEV_PAIR.providerId,
          contextWindowTokens: 8000,
          maxOutputTokens: 256,
        },
        dryRun: true,
      },
      deps,
    );
    expect(result.generatedCount).toBe(1);

    // Read the run-scoped directory back through the EXACT reader the telemetry
    // reconciler consumes.
    const artifacts = readProviderRunArtifactsFromDir(runsDir);
    expect(artifacts).toHaveLength(1);

    const aggregate = aggregateProviderRunArtifacts(artifacts);

    // Served (model, provider) pair reconciled under the requested pinned pair.
    const pairKey = buildPairKey(DEV_PAIR.modelId, DEV_PAIR.providerId);
    expect(aggregate.summary.byPair[pairKey]).toBeDefined();
    expect(aggregate.summary.byPair[pairKey]?.invocationCount).toBe(1);

    // Billed cost is the REAL wire `usage.cost`, carried verbatim (not zero,
    // not fabricated).
    expect(Number(aggregate.summary.totalCostUsd)).toBeCloseTo(WIRE_USAGE_COST, 9);
    expect(aggregate.summary.byPair[pairKey]?.totalCostUsd).toBe(WIRE_USAGE_COST.toFixed(8));

    // The REAL served upstream provider is bucketed (not the unknown sentinel).
    expect(aggregate.servedProviderBreakdown.byServedProvider[SERVED_UPSTREAM]).toBeDefined();
    expect(
      aggregate.servedProviderBreakdown.byServedProvider[SERVED_PROVIDER_UNKNOWN_SENTINEL],
    ).toBeUndefined();
    expect(Number(aggregate.servedProviderBreakdown.totalCostUsd)).toBeCloseTo(WIRE_USAGE_COST, 9);

    // ZDR enforced on the wire for the private_corpus semantic-agent request.
    const zdrRow = aggregate.zdrRows.find((r) => r.pair === pairKey);
    expect(zdrRow?.invocationCount).toBe(1);
    expect(zdrRow?.zdrEnforcedCount).toBe(1);

    // Cost kind is 'billed' (a real upstream charge).
    const billedRow = aggregate.costKindRows.find(
      (r) => r.pair === pairKey && r.costKind === "billed",
    );
    expect(billedRow?.invocationCount).toBe(1);
  });
});
