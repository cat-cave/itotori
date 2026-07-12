import { describe, expect, it } from "vitest";
import {
  contextArtifactCategoryValues,
  type AuthorizationActor,
  type ItotoriSourceUnitRepositoryPort,
  type ItotoriTranslationBatchRepositoryPort,
  type LoadCurrentSourceHashesInput,
  type LoadSourceUnitsForScopeInput,
  type LoadSourceUnitsInput,
  type LoadTranslationBatchesQuery,
  type SaveTranslationBatchesInput,
  type SourceUnitTextRecord,
  type TranslationBatchRecord,
} from "@itotori/db";
import { FakeModelProvider } from "../src/providers/fake.js";
import {
  InMemoryContextArtifactRepository,
  sceneSummaryArtifactId,
} from "../src/orchestrator/context-brain.js";
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
    return this.batches.find((batch) => batch.batchId === batchId) ?? null;
  }
}

class InMemorySourceUnitRepository implements ItotoriSourceUnitRepositoryPort {
  constructor(private readonly units: SourceUnitTextRecord[]) {}

  async loadSourceUnits(
    _actor: AuthorizationActor,
    input: LoadSourceUnitsInput,
  ): Promise<Map<string, SourceUnitTextRecord>> {
    return new Map(
      this.units
        .filter((unit) => input.bridgeUnitIds.includes(unit.bridgeUnitId))
        .map((unit) => [unit.bridgeUnitId, unit]),
    );
  }

  async currentSourceHashes(
    _actor: AuthorizationActor,
    input: LoadCurrentSourceHashesInput,
  ): Promise<Map<string, string>> {
    return new Map(
      this.units
        .filter((unit) => input.bridgeUnitIds.includes(unit.bridgeUnitId))
        .map((unit) => [unit.bridgeUnitId, unit.sourceHash]),
    );
  }

  async loadSourceUnitsForScope(
    _actor: AuthorizationActor,
    _input: LoadSourceUnitsForScopeInput,
  ): Promise<SourceUnitTextRecord[]> {
    return this.units;
  }
}

function sourceUnit(
  ordinal: number,
  sourceText: string,
  speaker: string | null,
): SourceUnitTextRecord {
  return {
    bridgeUnitId: `unit-${ordinal}`,
    sourceUnitKey: `scene.001.line.${String(ordinal).padStart(3, "0")}`,
    sourceText,
    sourceHash: `hash-${ordinal}`,
    speaker,
    occurrenceId: `occurrence-${ordinal}`,
  };
}

function batchRecord(
  batchId: string,
  ordinal: number,
  sceneId: string,
  units: SourceUnitTextRecord[],
): TranslationBatchRecord {
  return {
    batchId,
    projectId: "project-1",
    localeBranchId: "locale-1",
    sourceRevisionId: "revision-1",
    batchOrdinal: ordinal,
    tokenEstimate: 100,
    tokenBudgetCap: 1000,
    sceneId,
    sceneSplitIndex: ordinal,
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
    units: units.map((unit, index) => ({
      bridgeUnitId: unit.bridgeUnitId,
      sourceUnitKey: unit.sourceUnitKey,
      sourceHash: unit.sourceHash,
      unitOrdinal: index + 1,
    })),
    contextRefs: [],
  };
}

function dependencies(args: {
  batches: TranslationBatchRecord[];
  units: SourceUnitTextRecord[];
  contextArtifacts: InMemoryContextArtifactRepository;
  generate?: () => string;
}): SceneSummaryCliDependencies {
  return {
    actor,
    batchRepository: new InMemoryBatchRepository(args.batches),
    sourceUnitRepository: new InMemorySourceUnitRepository(args.units),
    contextArtifactRepository: args.contextArtifacts,
    provider: new FakeModelProvider({ generate: args.generate ?? (() => "generated summary") }),
    now: () => new Date("2026-06-23T12:00:00Z"),
  };
}

const input = {
  projectId: "project-1",
  localeBranchId: "locale-1",
  sourceLocale: "ja-JP",
  sourceRevisionId: "revision-1",
  modelProfile: {
    providerFamily: "fake" as const,
    modelId: "fake-m",
    contextWindowTokens: 8000,
    maxOutputTokens: 256,
  },
};

describe("runGenerateSceneSummariesCli", () => {
  it("persists standalone CLI output in the central context artifact store", async () => {
    const first = sourceUnit(1, "勇者は王様に挨拶した。", "勇者");
    const second = sourceUnit(2, "王様はうなずいた。", "王様");
    const store = new InMemoryContextArtifactRepository();

    const result = await runGenerateSceneSummariesCli(
      input,
      dependencies({
        batches: [batchRecord("batch-1", 1, "scene-1", [first, second])],
        units: [first, second],
        contextArtifacts: store,
      }),
    );

    const stored = await store.retrieveArtifacts(actor, {
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId,
      categories: [contextArtifactCategoryValues.sceneSummary],
    });
    expect(result.generatedCount).toBe(1);
    expect(stored.status).toBe("completed");
    expect(stored.matches).toHaveLength(1);
    expect(stored.matches[0]).toMatchObject({
      contextArtifactId: sceneSummaryArtifactId(input.projectId, "scene-1"),
      category: contextArtifactCategoryValues.sceneSummary,
      body: "generated summary",
      data: {
        semanticKind: "scene_summary",
        sceneId: "scene-1",
        promptTemplateVersion: PROMPT_TEMPLATE_VERSION_V1,
      },
    });
    expect(stored.matches[0]?.sourceUnits.map((unit) => unit.bridgeUnitId)).toEqual([
      first.bridgeUnitId,
      second.bridgeUnitId,
    ]);
  });

  it("reuses an active central artifact instead of generating a parallel summary", async () => {
    const unit = sourceUnit(1, "テキスト", null);
    const store = new InMemoryContextArtifactRepository();
    const artifactId = sceneSummaryArtifactId(input.projectId, "scene-1");
    await store.upsertArtifact(actor, {
      contextArtifactId: artifactId,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId,
      category: contextArtifactCategoryValues.sceneSummary,
      title: "Scene summary scene-1",
      body: "already persisted centrally",
      data: {
        semanticKind: "scene_summary",
        sceneId: "scene-1",
        citedUnitIds: [unit.bridgeUnitId],
        inputTokenEstimate: 11,
      },
      producedByAgent: "scene-summary",
      producedByTool: "tool.context-brain",
      producerVersion: PROMPT_TEMPLATE_VERSION_V1,
      provenance: {},
      sourceUnits: [{ bridgeUnitId: unit.bridgeUnitId, citation: "scene:scene-1" }],
    });

    const result = await runGenerateSceneSummariesCli(
      input,
      dependencies({
        batches: [batchRecord("batch-1", 1, "scene-1", [unit])],
        units: [unit],
        contextArtifacts: store,
        generate: () => {
          throw new Error("provider must not run when central context is reusable");
        },
      }),
    );

    expect(result).toMatchObject({ generatedCount: 0, skippedFreshCount: 1 });
    expect(result.scenes[0]).toMatchObject({
      status: "skipped",
      summaryId: artifactId,
      summaryText: "already persisted centrally",
    });
  });

  it("does not write a context artifact during --dry-run", async () => {
    const unit = sourceUnit(1, "テキスト", null);
    const store = new InMemoryContextArtifactRepository();

    const result = await runGenerateSceneSummariesCli(
      { ...input, dryRun: true },
      dependencies({
        batches: [batchRecord("batch-1", 1, "scene-1", [unit])],
        units: [unit],
        contextArtifacts: store,
      }),
    );
    const stored = await store.retrieveArtifacts(actor, {
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId,
      categories: [contextArtifactCategoryValues.sceneSummary],
    });

    expect(result.generatedCount).toBe(1);
    expect(stored.matches).toEqual([]);
  });
});
