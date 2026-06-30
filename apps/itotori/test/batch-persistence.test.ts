import { describe, expect, it } from "vitest";
import type {
  AuthorizationActor,
  ItotoriTranslationBatchRepositoryPort,
  LoadTranslationBatchesQuery,
  SaveTranslationBatchesInput,
  TranslationBatchRecord,
} from "@itotori/db";
import { persistBatches } from "../src/batch-planner/persistence.js";
import type { Batch, BatchModelProfile } from "../src/batch-planner/shapes.js";

const actor: AuthorizationActor = { userId: "local" };

// ITOTORI-220 — a real (modelId, providerId) pair pinned on the batch.
const modelProfile: BatchModelProfile = {
  providerFamily: "openrouter",
  modelId: "deepseek/deepseek-v4-flash",
  providerId: "fireworks",
  contextWindowTokens: 128_000,
  maxOutputTokens: 8_192,
  targetFillRatio: 0.7,
  promptOverheadTokens: 200,
  tokenEstimatorId: "itotori-batch-estimator-v1",
};

/** Captures the input handed to the repository so we can assert on it. */
class CapturingBatchRepository implements ItotoriTranslationBatchRepositoryPort {
  public lastSaveInput: SaveTranslationBatchesInput | undefined;

  async saveBatches(
    _actor: AuthorizationActor,
    input: SaveTranslationBatchesInput,
  ): Promise<TranslationBatchRecord[]> {
    this.lastSaveInput = input;
    return [];
  }

  async loadBatches(
    _actor: AuthorizationActor,
    _query: LoadTranslationBatchesQuery,
  ): Promise<TranslationBatchRecord[]> {
    return [];
  }

  async loadBatchById(
    _actor: AuthorizationActor,
    _batchId: string,
  ): Promise<TranslationBatchRecord | null> {
    return null;
  }
}

function fixtureBatch(): Batch {
  return {
    id: "019ed018-0000-7000-8000-000000000301",
    projectId: "019ed018-0000-7000-8000-0000000000a1",
    locale: "en-US",
    localeBranchId: "019ed018-0000-7000-8000-0000000000b1",
    sourceRevisionId: "019ed018-0000-7000-8000-0000000000c1",
    batchOrdinal: 1,
    units: [
      {
        bridgeUnitId: "019ed018-0000-7000-8000-0000000000d1",
        sourceUnitKey: "scene.001.line.001",
        sourceHash: "hash-1",
      },
    ],
    context: {
      glossaryTerms: [],
      styleGuideRules: [],
      characterRelationships: [],
      priorTranslationExamples: [],
      citationManifest: {
        glossaryTermCount: 0,
        styleRuleCount: 0,
        characterCount: 0,
        exampleCount: 0,
        unitCitations: [],
      },
    },
    tokenEstimate: 100,
    tokenBudgetCap: 1000,
    modelProfile,
    nearCapWarning: false,
    generatedAt: "2026-06-23T00:00:00.000Z",
  };
}

describe("persistBatches (ITOTORI-220 provider pinning)", () => {
  it("threads the pinned providerId into the save input (not dropped, not 'unknown')", async () => {
    const repository = new CapturingBatchRepository();

    await persistBatches(repository, actor, [fixtureBatch()], {
      projectId: "019ed018-0000-7000-8000-0000000000a1",
      localeBranchId: "019ed018-0000-7000-8000-0000000000b1",
      sourceRevisionId: "019ed018-0000-7000-8000-0000000000c1",
    });

    const saved = repository.lastSaveInput?.batches[0];
    expect(saved).toBeDefined();
    expect(saved!.providerId).toBe("fireworks");
    expect(saved!.providerId).not.toBe("unknown");
    // The model half is still threaded alongside the provider half.
    expect(saved!.modelId).toBe("deepseek/deepseek-v4-flash");
    expect(saved!.modelProviderFamily).toBe("openrouter");
  });
});
