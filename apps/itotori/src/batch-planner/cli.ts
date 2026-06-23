import type { BridgeBundle, BridgeBundleV02 } from "@itotori/localization-bridge-schema";
import { resolveModelProfile } from "./model-profiles.js";
import { planBatches, type PlanBatchesInput } from "./planner.js";
import type {
  Batch,
  BatchModelProfile,
  CharacterMapSnapshot,
  PlanBatchesOutput,
  SceneSummaryRef,
  StyleGuideVersionSnapshot,
  TerminologyTermSnapshot,
  TranslationMemoryQueryFn,
} from "./shapes.js";
import type { ProviderFamily } from "../providers/types.js";

export type PlanBatchesCliInput = {
  /** Path the CLI uses to read the project JSON. */
  projectPath: string;
  /** Optional output path for the plan result. */
  outputPath?: string | undefined;
  /** Target locale (BCP-47). */
  locale: string;
  /** Caller-supplied modelId (resolves a built-in profile when known). */
  modelId?: string | undefined;
  /** Caller-supplied provider family hint when modelId alone is ambiguous. */
  providerFamily?: ProviderFamily | undefined;
  /** Hard cap on contextWindowTokens; clamps the resolved profile. */
  maxTokens?: number | undefined;
  /** Optional override of targetFillRatio. */
  targetFillRatio?: number | undefined;
  /** Optional cap on prior translation examples per batch. */
  priorExampleLimit?: number | undefined;
  /** When true the CLI prints summary but does not persist. */
  dryRun?: boolean | undefined;
};

export type PlannedProjectFile = {
  projectId: string;
  localeBranchId: string;
  targetLocale: string;
  bridge: BridgeBundle | BridgeBundleV02;
};

export type PlanBatchesContextLoader = (
  project: PlannedProjectFile,
  locale: string,
) => Promise<{
  sourceRevisionId: string;
  glossary: ReadonlyArray<TerminologyTermSnapshot>;
  styleGuide?: StyleGuideVersionSnapshot | undefined;
  characterMap?: CharacterMapSnapshot | undefined;
  sceneSummaries?: ReadonlyMap<string, SceneSummaryRef> | undefined;
  translationMemory?: TranslationMemoryQueryFn | undefined;
}>;

export type PlanBatchesPersister = (
  batches: Batch[],
  identity: { projectId: string; localeBranchId: string; sourceRevisionId: string },
) => Promise<void>;

export type RunPlanBatchesDependencies = {
  loadProject(path: string): PlannedProjectFile;
  writeJson(path: string, value: unknown): void;
  loadContext: PlanBatchesContextLoader;
  persist?: PlanBatchesPersister;
  log?: (message: string) => void;
};

export async function runPlanBatches(
  input: PlanBatchesCliInput,
  dependencies: RunPlanBatchesDependencies,
): Promise<PlanBatchesOutput> {
  const project = dependencies.loadProject(input.projectPath);
  const context = await dependencies.loadContext(project, input.locale);
  const modelProfile: BatchModelProfile = resolveModelProfile({
    modelId: input.modelId,
    providerDescriptor:
      input.providerFamily === undefined
        ? undefined
        : {
            family: input.providerFamily,
            endpointFamily: "chat-completions",
            providerName: input.providerFamily,
            defaultModelId: input.modelId ?? "unknown",
            capabilities: {
              structuredOutputs: {
                jsonSchema: "untested",
                jsonObject: "untested",
                toolCallArguments: "untested",
                plainJsonExtraction: "untested",
                preferredModes: [],
              },
              toolCalls: {
                support: "untested",
                parallelToolCalls: "untested",
                requiresSchemaPerRequest: false,
              },
              imageInput: { support: "untested" },
              routing: {
                providerRouting: "untested",
                modelFallbacks: "untested",
                presets: "untested",
                requireParameters: "untested",
                dataCollectionControl: "untested",
                zeroDataRetentionRouting: "untested",
              },
              dataHandling: {
                costTier: "unknown",
                promptLogging: "unknown",
                completionLogging: "unknown",
                retention: "unknown",
                trainingUse: "unknown",
                dataCollection: "unknown",
                rawCaptureDefault: "unknown",
              },
            },
          },
    targetFillRatio: input.targetFillRatio,
    maxTokensOverride: input.maxTokens,
  });

  const planInput: PlanBatchesInput = {
    projectId: project.projectId,
    localeBranchId: project.localeBranchId,
    sourceRevisionId: context.sourceRevisionId,
    locale: input.locale,
    bridgeBundle: project.bridge,
    glossary: context.glossary,
    styleGuide: context.styleGuide,
    characterMap: context.characterMap,
    sceneSummaries: context.sceneSummaries,
    translationMemory: context.translationMemory,
    modelProfile,
    priorExampleLimit: input.priorExampleLimit,
  };

  const result = await planBatches(planInput);
  enforceBudgetInvariant(result);

  if (!input.dryRun && dependencies.persist) {
    await dependencies.persist(result.batches, {
      projectId: project.projectId,
      localeBranchId: project.localeBranchId,
      sourceRevisionId: context.sourceRevisionId,
    });
  }

  if (input.outputPath) {
    dependencies.writeJson(input.outputPath, result);
  }

  if (dependencies.log) {
    dependencies.log(formatSummary(result));
  }

  return result;
}

function enforceBudgetInvariant(result: PlanBatchesOutput): void {
  for (const batch of result.batches) {
    if (batch.tokenEstimate > batch.tokenBudgetCap) {
      throw new Error(
        `batch ${batch.id} exceeds tokenBudgetCap: ${batch.tokenEstimate} > ${batch.tokenBudgetCap}`,
      );
    }
  }
}

export function formatSummary(result: PlanBatchesOutput): string {
  const { summary } = result;
  const lines = [
    `Batches planned: ${summary.batchCount}`,
    `Total tokens (estimated input): ${summary.totalTokenEstimate}`,
    `Average tokens/batch: ${summary.averageTokenEstimatePerBatch}`,
    `Min / max tokens: ${summary.minTokenEstimate} / ${summary.maxTokenEstimate}`,
    `Scenes split across batches: ${summary.scenesSplitCount}`,
    `Units without scene metadata: ${summary.unitsWithoutSceneCount}`,
    `Glossary citations: ${summary.glossaryHitCount}`,
    `Model: ${summary.modelProfile.providerFamily} / ${summary.modelProfile.modelId}  (ctx ${summary.modelProfile.contextWindowTokens}, cap ${result.batches[0]?.tokenBudgetCap ?? 0})`,
  ];
  return lines.join("\n");
}
