import type { BridgeBundle, BridgeBundleV02 } from "@itotori/localization-bridge-schema";
import { createUuid7 } from "@itotori/db";
import type {
  Batch,
  BatchCitationManifest,
  BatchCitationUnit,
  BatchContext,
  BatchModelProfile,
  Bcp47Locale,
  BridgeUnitRef,
  CharacterMapSnapshot,
  CharacterRef,
  ExampleRef,
  GlossaryRef,
  PlanBatchesOutput,
  PlanBatchesSummary,
  SceneSummaryRef,
  StyleGuideVersionSnapshot,
  StyleRuleRef,
  TerminologyTermSnapshot,
  TranslationMemoryQueryFn,
  Uuid7,
} from "./shapes.js";
import { tokenEstimatorIdV1 } from "./shapes.js";
import {
  alwaysOnStyleRules,
  buildCharacterRefs,
  categoriesFor,
  categoryMatchedStyleRules,
  characterEntryText,
  glossaryEntryText,
  glossaryHitsForUnit,
  sceneSummaryForGroup,
  styleRuleBody,
  termSnapshotToRef,
} from "./context-pack.js";
import {
  computeTokenBudgetCap,
  fallbackModelProfile,
  resolveModelProfile,
} from "./model-profiles.js";
import {
  groupBySceneBoundary,
  projectBridgeUnit,
  projectLocalizationUnitV02,
  type PlannerUnit,
  type SceneGroup,
} from "./scene-grouping.js";
import { estimateTokens, perUnitFrameOverheadTokens } from "./token-estimator.js";

export type PlanBatchesInput = {
  projectId: Uuid7;
  localeBranchId: Uuid7;
  sourceRevisionId: Uuid7;
  locale: Bcp47Locale;
  bridgeBundle: BridgeBundle | BridgeBundleV02;
  glossary: ReadonlyArray<TerminologyTermSnapshot>;
  styleGuide?: StyleGuideVersionSnapshot | undefined;
  characterMap?: CharacterMapSnapshot | undefined;
  sceneSummaries?: ReadonlyMap<string, SceneSummaryRef> | undefined;
  /**
   * Optional agent-produced scene summary refs keyed by sceneId. When set,
   * these take precedence over the curator-authored `sceneSummaries` for the
   * same scene id. Produced by the ITOTORI-013 scene-summary CLI.
   */
  agentSceneSummaries?: ReadonlyMap<string, SceneSummaryRef> | undefined;
  translationMemory?: TranslationMemoryQueryFn | undefined;
  modelProfile?: BatchModelProfile | undefined;
  maxTokensOverride?: number | undefined;
  targetFillRatio?: number | undefined;
  priorExampleLimit?: number | undefined;
  now?: (() => Date) | undefined;
};

export const defaultPriorExampleLimit = 5;
const nearCapWarningRatio = 0.95;

export async function planBatches(input: PlanBatchesInput): Promise<PlanBatchesOutput> {
  const profile =
    input.modelProfile ??
    resolveModelProfile({
      targetFillRatio: input.targetFillRatio,
      maxTokensOverride: input.maxTokensOverride,
    });
  // Ensure tokenEstimatorId always reflects the running estimator, even when
  // a caller provides a stale override.
  const modelProfile: BatchModelProfile = {
    ...profile,
    tokenEstimatorId: tokenEstimatorIdV1,
  };
  const tokenBudgetCap = computeTokenBudgetCap(modelProfile);
  const now = input.now ?? (() => new Date());
  const priorExampleLimit = input.priorExampleLimit ?? defaultPriorExampleLimit;

  const units = projectUnits(input.bridgeBundle);
  const groups = groupBySceneBoundary(units);

  const alwaysOnRules = alwaysOnStyleRules(input.styleGuide);
  const alwaysOnRuleTokens = alwaysOnRules.reduce(
    (acc, rule) => acc + estimateTokens(styleRuleBody(input.styleGuide, rule.ruleId)),
    0,
  );

  const batches: Batch[] = [];
  let batchOrdinal = 1;
  for (const group of groups) {
    const groupCategories = categoriesFor(group.units);
    const categoryRules = categoryMatchedStyleRules(input.styleGuide, groupCategories);
    const sceneSummary = sceneSummaryForGroup(
      input.sceneSummaries,
      group.sceneId,
      input.agentSceneSummaries,
    );
    const examples = await mineExamples(input.translationMemory, group, priorExampleLimit);

    const preludeTokens = computePreludeTokens({
      profile: modelProfile,
      sceneSummary,
      alwaysOnRuleTokens,
      categoryRules,
      examples,
      styleGuide: input.styleGuide,
    });

    const sceneBatches = packGroupIntoBatches({
      group,
      glossary: input.glossary,
      styleGuide: input.styleGuide,
      categoryRules,
      alwaysOnRules,
      characterMap: input.characterMap,
      sceneSummary,
      examples,
      preludeTokens,
      tokenBudgetCap,
      modelProfile,
      projectId: input.projectId,
      locale: input.locale,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId,
      now,
      startOrdinal: batchOrdinal,
    });
    for (const batch of sceneBatches) {
      batches.push(batch);
    }
    batchOrdinal += sceneBatches.length;
  }

  const summary = buildSummary(batches, modelProfile, units);
  return { batches, summary };
}

function projectUnits(bundle: BridgeBundle | BridgeBundleV02): PlannerUnit[] {
  if (isBridgeBundleV02(bundle)) {
    return bundle.units.map(projectLocalizationUnitV02);
  }
  return bundle.units.map(projectBridgeUnit);
}

function isBridgeBundleV02(bundle: BridgeBundle | BridgeBundleV02): bundle is BridgeBundleV02 {
  return bundle.schemaVersion === "0.2.0";
}

type ComputePreludeTokensInput = {
  profile: BatchModelProfile;
  sceneSummary: SceneSummaryRef | undefined;
  alwaysOnRuleTokens: number;
  categoryRules: StyleRuleRef[];
  examples: ExampleRef[];
  styleGuide: StyleGuideVersionSnapshot | undefined;
};

function computePreludeTokens(input: ComputePreludeTokensInput): number {
  let tokens = input.profile.promptOverheadTokens;
  tokens += input.alwaysOnRuleTokens;
  for (const rule of input.categoryRules) {
    tokens += estimateTokens(styleRuleBody(input.styleGuide, rule.ruleId));
  }
  if (input.sceneSummary) {
    tokens += estimateTokens(input.sceneSummary.body);
  }
  for (const example of input.examples) {
    tokens += estimateTokens(example.body);
  }
  return tokens;
}

type PackGroupInput = {
  group: SceneGroup;
  glossary: ReadonlyArray<TerminologyTermSnapshot>;
  styleGuide: StyleGuideVersionSnapshot | undefined;
  categoryRules: StyleRuleRef[];
  alwaysOnRules: StyleRuleRef[];
  characterMap: CharacterMapSnapshot | undefined;
  sceneSummary: SceneSummaryRef | undefined;
  examples: ExampleRef[];
  preludeTokens: number;
  tokenBudgetCap: number;
  modelProfile: BatchModelProfile;
  projectId: Uuid7;
  locale: Bcp47Locale;
  localeBranchId: Uuid7;
  sourceRevisionId: Uuid7;
  now: () => Date;
  startOrdinal: number;
};

type PackAccumulator = {
  units: PlannerUnit[];
  glossaryById: Map<string, { term: TerminologyTermSnapshot; hits: string[] }>;
  speakerToUnits: Map<string, string[]>;
  unitCitations: BatchCitationUnit[];
  totalTokens: number;
};

function emptyAccumulator(preludeTokens: number): PackAccumulator {
  return {
    units: [],
    glossaryById: new Map(),
    speakerToUnits: new Map(),
    unitCitations: [],
    totalTokens: preludeTokens,
  };
}

function packGroupIntoBatches(input: PackGroupInput): Batch[] {
  const batches: Batch[] = [];
  let acc = emptyAccumulator(input.preludeTokens);
  let sceneSplitIndex = 1;
  const groupHasScene = input.group.sceneId !== undefined;

  for (const unit of input.group.units) {
    const hits = glossaryHitsForUnit(input.glossary, unit);
    const newGlossaryTokens = hits.reduce((acc2, term) => {
      if (acc.glossaryById.has(term.termId)) {
        return acc2;
      }
      return acc2 + estimateTokens(glossaryEntryText(termSnapshotToRef(term, [unit.bridgeUnitId])));
    }, 0);
    const speakerTokens =
      unit.speaker && !acc.speakerToUnits.has(unit.speaker) ? estimateTokens(unit.speaker) : 0;
    const unitTokens = estimateTokens(unit.sourceText) + perUnitFrameOverheadTokens;
    const incremental = unitTokens + newGlossaryTokens + speakerTokens;

    if (acc.units.length > 0 && acc.totalTokens + incremental > input.tokenBudgetCap) {
      batches.push(
        finalizeBatch({
          acc,
          input,
          batchOrdinal: input.startOrdinal + batches.length,
          sceneSplitIndex: groupHasScene && batches.length > 0 ? sceneSplitIndex : undefined,
        }),
      );
      if (groupHasScene) {
        sceneSplitIndex += 1;
      }
      acc = emptyAccumulator(input.preludeTokens);
    }

    addUnitToAccumulator(acc, unit, hits, incremental);
  }

  if (acc.units.length > 0) {
    batches.push(
      finalizeBatch({
        acc,
        input,
        batchOrdinal: input.startOrdinal + batches.length,
        sceneSplitIndex: groupHasScene && batches.length > 0 ? sceneSplitIndex : undefined,
      }),
    );
  }

  // When the group was split across multiple batches, retro-set sceneSplitIndex
  // on the first one so the sequence reads 1..N (the first batch was emitted
  // before we knew the group would split).
  if (groupHasScene && batches.length > 1) {
    for (let i = 0; i < batches.length; i += 1) {
      batches[i] = { ...batches[i]!, sceneSplitIndex: i + 1 };
    }
  }

  return batches;
}

function addUnitToAccumulator(
  acc: PackAccumulator,
  unit: PlannerUnit,
  hits: TerminologyTermSnapshot[],
  incremental: number,
): void {
  acc.units.push(unit);
  acc.totalTokens += incremental;

  const glossaryIds: string[] = [];
  for (const term of hits) {
    const existing = acc.glossaryById.get(term.termId);
    if (existing) {
      if (!existing.hits.includes(unit.bridgeUnitId)) {
        existing.hits.push(unit.bridgeUnitId);
      }
    } else {
      acc.glossaryById.set(term.termId, { term, hits: [unit.bridgeUnitId] });
    }
    if (!glossaryIds.includes(term.termId)) {
      glossaryIds.push(term.termId);
    }
  }

  if (unit.speaker) {
    const speakerBucket = acc.speakerToUnits.get(unit.speaker) ?? [];
    if (!speakerBucket.includes(unit.bridgeUnitId)) {
      speakerBucket.push(unit.bridgeUnitId);
    }
    acc.speakerToUnits.set(unit.speaker, speakerBucket);
  }

  acc.unitCitations.push({
    bridgeUnitId: unit.bridgeUnitId,
    glossaryTermIds: glossaryIds,
    styleRuleIds: [],
    characterTermIds: [],
  });
}

type FinalizeBatchInput = {
  acc: PackAccumulator;
  input: PackGroupInput;
  batchOrdinal: number;
  sceneSplitIndex?: number | undefined;
};

function finalizeBatch({ acc, input, batchOrdinal, sceneSplitIndex }: FinalizeBatchInput): Batch {
  const glossaryRefs: GlossaryRef[] = [];
  for (const { term, hits } of acc.glossaryById.values()) {
    glossaryRefs.push(termSnapshotToRef(term, hits));
  }
  glossaryRefs.sort((a, b) => a.termKey.localeCompare(b.termKey));

  const characterRefs: CharacterRef[] = buildCharacterRefs(input.characterMap, acc.speakerToUnits);
  const characterTokens = characterRefs.reduce(
    (sum, ref) => sum + estimateTokens(characterEntryText(ref)),
    0,
  );

  const styleGuideRules: StyleRuleRef[] = [...input.alwaysOnRules, ...input.categoryRules];

  // Citation manifest: walk per-unit citations and fill in style/character ids.
  const unitCitations: BatchCitationUnit[] = acc.unitCitations.map((citation) => ({
    ...citation,
    styleRuleIds: styleGuideRules.map((rule) => rule.ruleId),
    characterTermIds: characterRefs
      .filter((ref) => ref.appearsInBridgeUnitIds.includes(citation.bridgeUnitId))
      .map((ref) => ref.termId),
  }));

  const citationManifest: BatchCitationManifest = {
    glossaryTermCount: glossaryRefs.length,
    styleRuleCount: styleGuideRules.length,
    characterCount: characterRefs.length,
    exampleCount: input.examples.length,
    unitCitations,
    sourceUnitKeyPrefix: input.group.sourceUnitKeyPrefix,
  };

  const totalTokens = acc.totalTokens + characterTokens;
  const tokenEstimate = totalTokens;
  const nearCapWarning = tokenEstimate / Math.max(1, input.tokenBudgetCap) > nearCapWarningRatio;

  const context: BatchContext = {
    glossaryTerms: glossaryRefs,
    styleGuideRules,
    characterRelationships: characterRefs,
    sceneSummary: input.sceneSummary,
    priorTranslationExamples: input.examples,
    citationManifest,
  };

  const unitRefs: BridgeUnitRef[] = acc.units.map((unit) => ({
    bridgeUnitId: unit.bridgeUnitId,
    sourceUnitKey: unit.sourceUnitKey,
    sourceHash: unit.sourceHash,
  }));

  return {
    id: createUuid7(input.now()),
    projectId: input.projectId,
    locale: input.locale,
    localeBranchId: input.localeBranchId,
    sourceRevisionId: input.sourceRevisionId,
    batchOrdinal,
    units: unitRefs,
    context,
    tokenEstimate,
    tokenBudgetCap: input.tokenBudgetCap,
    sceneId: input.group.sceneId,
    sceneSplitIndex,
    routeId: input.group.routeId,
    modelProfile: input.modelProfile,
    nearCapWarning,
    generatedAt: input.now().toISOString(),
  };
}

async function mineExamples(
  translationMemory: TranslationMemoryQueryFn | undefined,
  group: SceneGroup,
  limit: number,
): Promise<ExampleRef[]> {
  if (!translationMemory || limit <= 0 || group.units.length === 0) {
    return [];
  }
  const speakers = new Set<string>();
  const surfaceKinds = new Set<string>();
  for (const unit of group.units) {
    if (unit.speaker) {
      speakers.add(unit.speaker);
    }
    if (unit.surfaceKind) {
      surfaceKinds.add(unit.surfaceKind);
    }
  }
  const collected: ExampleRef[] = [];
  const sceneSpeakers = [...speakers];
  const sceneId = group.sceneId;
  // Priority: same speaker + same scene, same speaker, same surfaceKind.
  for (const speaker of sceneSpeakers) {
    if (collected.length >= limit) {
      break;
    }
    if (sceneId !== undefined) {
      const matches = await Promise.resolve(
        translationMemory({ speaker, sceneId, limit: limit - collected.length }),
      );
      for (const match of matches) {
        collected.push({ ...match, similarityReason: "same_scene" });
        if (collected.length >= limit) break;
      }
    }
  }
  for (const speaker of sceneSpeakers) {
    if (collected.length >= limit) {
      break;
    }
    const matches = await Promise.resolve(
      translationMemory({ speaker, limit: limit - collected.length }),
    );
    for (const match of matches) {
      collected.push({ ...match, similarityReason: "same_speaker" });
      if (collected.length >= limit) break;
    }
  }
  for (const surfaceKind of surfaceKinds) {
    if (collected.length >= limit) {
      break;
    }
    const matches = await Promise.resolve(
      translationMemory({ surfaceKind, limit: limit - collected.length }),
    );
    for (const match of matches) {
      collected.push({ ...match, similarityReason: "same_surfaceKind" });
      if (collected.length >= limit) break;
    }
  }
  return collected.slice(0, limit);
}

function buildSummary(
  batches: Batch[],
  modelProfile: BatchModelProfile,
  units: PlannerUnit[],
): PlanBatchesSummary {
  const tokenEstimates = batches.map((batch) => batch.tokenEstimate);
  const totalTokenEstimate = tokenEstimates.reduce((sum, n) => sum + n, 0);
  const batchCount = batches.length;
  const averageTokenEstimatePerBatch =
    batchCount === 0 ? 0 : Math.floor(totalTokenEstimate / batchCount);
  const minTokenEstimate = batchCount === 0 ? 0 : Math.min(...tokenEstimates);
  const maxTokenEstimate = batchCount === 0 ? 0 : Math.max(...tokenEstimates);
  const scenesSplitCount = countSplitScenes(batches);
  const unitsWithoutSceneCount = units.filter((unit) => unit.sceneId === undefined).length;
  const glossaryHitCount = batches.reduce(
    (sum, batch) => sum + batch.context.glossaryTerms.length,
    0,
  );

  return {
    batchCount,
    totalTokenEstimate,
    averageTokenEstimatePerBatch,
    minTokenEstimate,
    maxTokenEstimate,
    scenesSplitCount,
    unitsWithoutSceneCount,
    glossaryHitCount,
    modelProfile,
  };
}

function countSplitScenes(batches: Batch[]): number {
  const scenesWithSplits = new Set<string>();
  for (const batch of batches) {
    if (batch.sceneId !== undefined && batch.sceneSplitIndex !== undefined) {
      scenesWithSplits.add(batch.sceneId);
    }
  }
  return scenesWithSplits.size;
}

export const _internalFallbackProfile = fallbackModelProfile;
