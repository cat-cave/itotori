import { describe, expect, it } from "vitest";
import type {
  AuthorizationActor,
  BridgeUnitTextRecord,
  ItotoriSceneSummaryRepositoryPort,
  ItotoriTranslationBatchRepositoryPort,
  LoadTranslationBatchesQuery,
  SaveSceneSummaryInput,
  SaveTranslationBatchesInput,
  SceneSummaryCitationRecord,
  SceneSummaryInvalidatedReason,
  SceneSummaryRecord,
  SceneSummaryStatus,
  TranslationBatchRecord,
} from "@itotori/db";
import { FakeModelProvider } from "../src/providers/fake.js";
import {
  PROMPT_TEMPLATE_VERSION_V1,
  runGenerateSceneSummariesCli,
  type SceneSummaryCliDependencies,
} from "../src/agents/scene-summary/index.js";

const actor: AuthorizationActor = { userId: "local-user" };

class InMemoryBatchRepository implements ItotoriTranslationBatchRepositoryPort {
  constructor(private readonly batches: TranslationBatchRecord[]) {}
  async saveBatches(
    _actor: AuthorizationActor,
    _input: SaveTranslationBatchesInput,
  ): Promise<TranslationBatchRecord[]> {
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

class InMemorySceneSummaryRepository implements ItotoriSceneSummaryRepositoryPort {
  public records = new Map<string, SceneSummaryRecord>();
  public sourceHashes = new Map<string, string>();
  public bridgeUnitTextById = new Map<string, BridgeUnitTextRecord>();
  public lastSaveCount = 0;

  async saveSummary(
    _actor: AuthorizationActor,
    input: SaveSceneSummaryInput,
  ): Promise<SceneSummaryRecord> {
    this.lastSaveCount += 1;
    const record: SceneSummaryRecord = {
      sceneSummaryId: input.sceneSummaryId,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId,
      sceneId: input.sceneId,
      summaryLocale: input.summaryLocale,
      summaryText: input.summaryText,
      modelProviderFamily: input.modelProviderFamily,
      modelId: input.modelId,
      modelContextWindowTokens: input.modelContextWindowTokens,
      modelMaxOutputTokens: input.modelMaxOutputTokens,
      promptTemplateVersion: input.promptTemplateVersion,
      promptHash: input.promptHash,
      inputTokenEstimate: input.inputTokenEstimate,
      completionTokens: input.completionTokens,
      status: "Fresh" as SceneSummaryStatus,
      invalidatedAt: null,
      invalidatedReason: null,
      generatedAt: input.generatedAt,
      createdAt: input.generatedAt,
      citations: input.citations.map(
        (c): SceneSummaryCitationRecord => ({
          bridgeUnitId: c.bridgeUnitId,
          citedSourceHash: c.citedSourceHash,
          citeOrdinal: c.citeOrdinal,
        }),
      ),
    };
    this.records.set(record.sceneSummaryId, record);
    return record;
  }
  async loadSummaryByScene(
    _actor: AuthorizationActor,
    query: {
      projectId: string;
      localeBranchId: string;
      sourceRevisionId: string;
      sceneId: string;
      promptTemplateVersion?: string;
    },
  ): Promise<SceneSummaryRecord | null> {
    return (
      [...this.records.values()].find(
        (r) =>
          r.projectId === query.projectId &&
          r.localeBranchId === query.localeBranchId &&
          r.sourceRevisionId === query.sourceRevisionId &&
          r.sceneId === query.sceneId &&
          (query.promptTemplateVersion === undefined ||
            r.promptTemplateVersion === query.promptTemplateVersion),
      ) ?? null
    );
  }
  async loadSummaries(_actor: AuthorizationActor): Promise<SceneSummaryRecord[]> {
    return [...this.records.values()];
  }
  async markStale(
    _actor: AuthorizationActor,
    input: { sceneSummaryId: string; reason: SceneSummaryInvalidatedReason; invalidatedAt?: Date },
  ): Promise<void> {
    const record = this.records.get(input.sceneSummaryId);
    if (!record || record.status !== "Fresh") {
      return;
    }
    this.records.set(input.sceneSummaryId, {
      ...record,
      status: "Stale" as SceneSummaryStatus,
      invalidatedReason: input.reason,
      invalidatedAt: input.invalidatedAt ?? new Date(),
    });
  }
  async currentSourceHashesForBridgeUnits(
    _actor: AuthorizationActor,
    input: { bridgeUnitIds: string[] },
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const id of input.bridgeUnitIds) {
      const v = this.sourceHashes.get(id);
      if (v !== undefined) {
        result.set(id, v);
      }
    }
    return result;
  }
  async loadBridgeUnitsForSummary(
    _actor: AuthorizationActor,
    input: { bridgeUnitIds: string[] },
  ): Promise<Map<string, BridgeUnitTextRecord>> {
    const result = new Map<string, BridgeUnitTextRecord>();
    for (const id of input.bridgeUnitIds) {
      const v = this.bridgeUnitTextById.get(id);
      if (v) {
        result.set(id, v);
      }
    }
    return result;
  }
}

function recordFor(
  bridgeUnitId: string,
  ordinal: number,
  sourceText: string,
  speaker: string | null,
): BridgeUnitTextRecord {
  return {
    bridgeUnitId,
    sourceUnitKey: `scene.001.line.${String(ordinal).padStart(3, "0")}`,
    sourceText,
    sourceHash: `${bridgeUnitId}-hash`,
    speaker,
    occurrenceId: `occ-${ordinal}`,
  };
}

function batchRecord(
  batchId: string,
  ordinal: number,
  sceneId: string,
  sceneSplitIndex: number | null,
  units: BridgeUnitTextRecord[],
): TranslationBatchRecord {
  return {
    batchId,
    projectId: "p",
    localeBranchId: "lb",
    sourceRevisionId: "rev-1",
    batchOrdinal: ordinal,
    tokenEstimate: 100,
    tokenBudgetCap: 1000,
    sceneId,
    sceneSplitIndex,
    routeId: null,
    modelProviderFamily: "fake",
    modelId: "fake-m",
    modelContextWindowTokens: 8000,
    modelMaxOutputTokens: 256,
    modelTargetFillRatio: 0.7,
    modelPromptOverheadTokens: 200,
    tokenEstimatorId: "itotori-batch-estimator-v1",
    nearCapWarning: false,
    generatedAt: new Date("2026-06-23T12:00:00Z"),
    createdAt: new Date("2026-06-23T12:00:00Z"),
    units: units.map((u, idx) => ({
      bridgeUnitId: u.bridgeUnitId,
      sourceUnitKey: u.sourceUnitKey,
      sourceHash: u.sourceHash,
      unitOrdinal: idx + 1,
    })),
    contextRefs: [
      {
        refKind: "glossary_term",
        refId: "term-hero",
        refSecondaryId: "",
        inclusionReason: "hit",
        hitBridgeUnitIds: [units[0]!.bridgeUnitId],
        details: {
          termKey: "yusha",
          preferredSourceForm: "勇者",
          preferredTargetForm: "hero",
        },
      },
    ],
  };
}

describe("runGenerateSceneSummariesCli", () => {
  it("threads priorSummary across batches when a scene spans multiple batches", async () => {
    const unit1 = recordFor("u-1", 1, "勇者は王様に挨拶した。", "勇者");
    const unit2 = recordFor("u-2", 2, "王様はうなずいた。", "王様");
    const unit3 = recordFor("u-3", 3, "そして物語は続く。", null);
    const summaryRepo = new InMemorySceneSummaryRepository();
    summaryRepo.bridgeUnitTextById.set(unit1.bridgeUnitId, unit1);
    summaryRepo.bridgeUnitTextById.set(unit2.bridgeUnitId, unit2);
    summaryRepo.bridgeUnitTextById.set(unit3.bridgeUnitId, unit3);

    const batches = [
      batchRecord("batch-1", 1, "scene-1", 1, [unit1, unit2]),
      batchRecord("batch-2", 2, "scene-1", 2, [unit3]),
    ];
    const batchRepo = new InMemoryBatchRepository(batches);

    let invocationCount = 0;
    const provider = new FakeModelProvider({
      providerName: "scene-summary-fake",
      modelId: "fake-m",
      generate: () => {
        invocationCount += 1;
        return `summary-${invocationCount}`;
      },
    });

    const deps: SceneSummaryCliDependencies = {
      actor,
      batchRepository: batchRepo,
      summaryRepository: summaryRepo,
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
          providerFamily: "fake",
          modelId: "fake-m",
          contextWindowTokens: 8000,
          maxOutputTokens: 256,
        },
      },
      deps,
    );

    expect(result.generatedCount).toBe(2);
    expect(result.scenes).toHaveLength(2);
    expect(summaryRepo.lastSaveCount).toBe(2);
    // Last persisted summary should cite the cumulative union of units across batches.
    const persistedFinal = [...summaryRepo.records.values()].find(
      (r) => r.summaryText === "summary-2",
    );
    expect(persistedFinal?.citations.map((c) => c.bridgeUnitId)).toEqual(["u-1", "u-2", "u-3"]);
    expect(persistedFinal?.promptTemplateVersion).toBe(PROMPT_TEMPLATE_VERSION_V1);
  });

  it("skips scenes with a Fresh summary unless --include-stale is set", async () => {
    const unit1 = recordFor("u-1", 1, "テキスト1", null);
    const unit2 = recordFor("u-2", 2, "テキスト2", null);
    const summaryRepo = new InMemorySceneSummaryRepository();
    summaryRepo.bridgeUnitTextById.set(unit1.bridgeUnitId, unit1);
    summaryRepo.bridgeUnitTextById.set(unit2.bridgeUnitId, unit2);

    // Pre-existing Fresh summary at the same key.
    await summaryRepo.saveSummary(actor, {
      sceneSummaryId: "preexisting",
      projectId: "p",
      localeBranchId: "lb",
      sourceRevisionId: "rev-1",
      sceneId: "scene-1",
      summaryLocale: "ja-JP",
      summaryText: "previously",
      modelProviderFamily: "fake",
      modelId: "fake-m",
      modelContextWindowTokens: 8000,
      modelMaxOutputTokens: 256,
      promptTemplateVersion: PROMPT_TEMPLATE_VERSION_V1,
      promptHash: "h",
      inputTokenEstimate: 10,
      completionTokens: 5,
      generatedAt: new Date("2026-06-23T12:00:00Z"),
      citations: [{ bridgeUnitId: "u-1", citedSourceHash: "u-1-hash", citeOrdinal: 1 }],
    });

    const batches = [batchRecord("batch-1", 1, "scene-1", null, [unit1, unit2])];
    const provider = new FakeModelProvider({ generate: () => "regenerated" });
    const deps: SceneSummaryCliDependencies = {
      actor,
      batchRepository: new InMemoryBatchRepository(batches),
      summaryRepository: summaryRepo,
      provider,
    };

    const skipped = await runGenerateSceneSummariesCli(
      {
        projectId: "p",
        localeBranchId: "lb",
        sourceLocale: "ja-JP",
        sourceRevisionId: "rev-1",
        modelProfile: {
          providerFamily: "fake",
          modelId: "fake-m",
          contextWindowTokens: 8000,
        },
      },
      deps,
    );
    expect(skipped.generatedCount).toBe(0);
    expect(skipped.skippedFreshCount).toBe(1);

    const regenerated = await runGenerateSceneSummariesCli(
      {
        projectId: "p",
        localeBranchId: "lb",
        sourceLocale: "ja-JP",
        sourceRevisionId: "rev-1",
        modelProfile: {
          providerFamily: "fake",
          modelId: "fake-m",
          contextWindowTokens: 8000,
        },
        includeStale: true,
      },
      deps,
    );
    expect(regenerated.generatedCount).toBe(1);
  });

  it("honours --dry-run by skipping persistence", async () => {
    const unit = recordFor("u-1", 1, "テキスト", null);
    const summaryRepo = new InMemorySceneSummaryRepository();
    summaryRepo.bridgeUnitTextById.set(unit.bridgeUnitId, unit);
    const provider = new FakeModelProvider({ generate: () => "dry-run" });

    const deps: SceneSummaryCliDependencies = {
      actor,
      batchRepository: new InMemoryBatchRepository([
        batchRecord("batch-1", 1, "scene-x", null, [unit]),
      ]),
      summaryRepository: summaryRepo,
      provider,
    };

    const result = await runGenerateSceneSummariesCli(
      {
        projectId: "p",
        localeBranchId: "lb",
        sourceLocale: "ja-JP",
        sourceRevisionId: "rev-1",
        modelProfile: {
          providerFamily: "fake",
          modelId: "fake-m",
          contextWindowTokens: 8000,
        },
        dryRun: true,
      },
      deps,
    );
    expect(result.generatedCount).toBe(1);
    expect(summaryRepo.lastSaveCount).toBe(0);
  });
});
