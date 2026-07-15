// Standalone semantic-agent CLI paths may resolve an OpenRouter provider, but
// they do not own a durable run-cost admission sink. The root supervisor must
// therefore refuse them before the recorder or transport can observe a paid
// call.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AuthorizationActor,
  ItotoriSourceUnitRepositoryPort,
  ItotoriTranslationBatchRepositoryPort,
  LoadCurrentSourceHashesInput,
  LoadSourceUnitsForScopeInput,
  LoadSourceUnitsInput,
  LoadTranslationBatchesQuery,
  SourceUnitTextRecord,
  TranslationBatchRecord,
} from "@itotori/db";
import {
  runGenerateSceneSummariesCli,
  resolveSceneSummaryProvider,
  type SceneSummaryCliDependencies,
} from "../src/agents/scene-summary/index.js";
import { InMemoryContextArtifactRepository } from "../src/orchestrator/context-brain.js";
import {
  REQUESTED_PROVIDER_UNKNOWN,
  DEV_PAIR,
  LocalProviderRunArtifactRecorder,
} from "../src/providers/index.js";
import { readProviderRunArtifactsFromDir } from "../src/telemetry/provider-run-artifact-source.js";

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

function unitRecord(bridgeUnitId: string): SourceUnitTextRecord {
  return {
    bridgeUnitId,
    sourceUnitKey: "scene.001.line.001",
    sourceText: "勇者は王様に挨拶した。",
    sourceHash: `${bridgeUnitId}-hash`,
    speaker: "勇者",
    occurrenceId: "occ-1",
  };
}

function batchRecord(unit: SourceUnitTextRecord): TranslationBatchRecord {
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

class OneSourceUnitRepository implements ItotoriSourceUnitRepositoryPort {
  constructor(private readonly units: Map<string, SourceUnitTextRecord>) {}

  async loadSourceUnits(
    _actor: AuthorizationActor,
    input: LoadSourceUnitsInput,
  ): Promise<Map<string, SourceUnitTextRecord>> {
    return new Map(
      input.bridgeUnitIds.flatMap((id) => {
        const unit = this.units.get(id);
        return unit === undefined ? [] : [[id, unit] as const];
      }),
    );
  }

  async currentSourceHashes(
    _actor: AuthorizationActor,
    input: LoadCurrentSourceHashesInput,
  ): Promise<Map<string, string>> {
    return new Map(
      input.bridgeUnitIds.flatMap((id) => {
        const unit = this.units.get(id);
        return unit === undefined ? [] : [[id, unit.sourceHash] as const];
      }),
    );
  }

  async loadSourceUnitsForScope(
    _actor: AuthorizationActor,
    _input: LoadSourceUnitsForScopeInput,
  ): Promise<SourceUnitTextRecord[]> {
    return [...this.units.values()];
  }
}

describe("semantic-agent CLI paid-provider boundary", () => {
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

  it("refuses an unbound standalone OpenRouter CLI run before artifact or transport dispatch", async () => {
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
      sourceUnitRepository: new OneSourceUnitRepository(new Map([[unit.bridgeUnitId, unit]])),
      contextArtifactRepository: new InMemoryContextArtifactRepository(),
      provider,
      now: () => new Date("2026-06-23T12:00:00Z"),
    };

    await expect(
      runGenerateSceneSummariesCli(
        {
          projectId: "p",
          localeBranchId: "lb",
          sourceLocale: "ja-JP",
          sourceRevisionId: "rev-1",
          modelProfile: {
            providerFamily: "openrouter",
            modelId: DEV_PAIR.modelId,
            providerId: REQUESTED_PROVIDER_UNKNOWN,
            contextWindowTokens: 8000,
            maxOutputTokens: 256,
          },
          dryRun: true,
        },
        deps,
      ),
    ).rejects.toMatchObject({
      name: "InvocationOperationalPauseError",
      blocker: { kind: "budget_cap" },
    });
    expect(readProviderRunArtifactsFromDir(runsDir)).toEqual([]);
  });
});
