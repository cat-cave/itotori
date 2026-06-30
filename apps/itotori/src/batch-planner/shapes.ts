import type { ProviderFamily } from "../providers/types.js";

export type Uuid7 = string;
export type Bcp47Locale = string;

/**
 * Stable id for the deterministic token estimator. Bump when the function
 * changes so token estimates stored on persisted batches remain auditable.
 */
export const tokenEstimatorIdV1 = "itotori-batch-estimator-v1" as const;

export type BridgeUnitRef = {
  bridgeUnitId: Uuid7;
  sourceUnitKey: string;
  sourceHash: string;
};

export type GlossaryRef = {
  termId: Uuid7;
  termKey: string;
  preferredSourceForm: string;
  preferredTargetForm?: string | undefined;
  /** Bridge units whose sourceText triggered this term's inclusion. */
  hitBridgeUnitIds: Uuid7[];
};

export type StyleRuleInclusionReason = "always_on" | "category_match" | "explicit_pin";

export type StyleRuleRef = {
  ruleId: string;
  styleGuideVersionId: Uuid7;
  rulePath?: string | undefined;
  inclusionReason: StyleRuleInclusionReason;
};

export type CharacterRef = {
  /** Terminology row id (kind = "character_name") when known; otherwise speaker key. */
  termId: Uuid7;
  canonicalName: string;
  relationshipNotes?: string | undefined;
  appearsInBridgeUnitIds: Uuid7[];
};

export type SceneSummaryRef = {
  contextArtifactId: Uuid7;
  sceneId: string;
  contentHash: string;
  /** Summary body included in the pack. Counted in token estimate. */
  body: string;
};

export type ExampleSimilarityReason = "same_speaker" | "same_scene" | "same_surfaceKind";

export type ExampleRef = {
  bridgeUnitId: Uuid7;
  translationMemorySegmentId?: Uuid7 | undefined;
  similarityReason: ExampleSimilarityReason;
  /** Inline body for token accounting; the segment body that would be shown. */
  body: string;
};

export type BatchCitationUnit = {
  bridgeUnitId: Uuid7;
  glossaryTermIds: Uuid7[];
  styleRuleIds: string[];
  characterTermIds: Uuid7[];
};

export type BatchCitationManifest = {
  glossaryTermCount: number;
  styleRuleCount: number;
  characterCount: number;
  exampleCount: number;
  /** Per-unit citation index for audit. */
  unitCitations: BatchCitationUnit[];
  /** When the planner fell back to sourceUnitKey-prefix grouping. */
  sourceUnitKeyPrefix?: string | undefined;
};

export type BatchModelProfile = {
  providerFamily: ProviderFamily;
  modelId: string;
  /**
   * ITOTORI-220 — required (modelId, providerId) pair pinned for every
   * batch invocation. The batch planner does not invoke a model, but the
   * downstream draft agent reads `providerId` off the profile when
   * issuing the call, so it must travel with the batch shape AND be
   * persisted: `batchToSaveInput` threads it into the
   * `translation_batches.provider_id` column so the pinned provider half
   * survives a save/load round-trip.
   */
  providerId: string;
  contextWindowTokens: number;
  maxOutputTokens?: number | undefined;
  targetFillRatio: number;
  promptOverheadTokens: number;
  tokenEstimatorId: string;
};

export type BatchContext = {
  glossaryTerms: GlossaryRef[];
  styleGuideRules: StyleRuleRef[];
  characterRelationships: CharacterRef[];
  sceneSummary?: SceneSummaryRef | undefined;
  priorTranslationExamples: ExampleRef[];
  citationManifest: BatchCitationManifest;
};

export type Batch = {
  id: Uuid7;
  projectId: Uuid7;
  locale: Bcp47Locale;
  localeBranchId: Uuid7;
  sourceRevisionId: Uuid7;
  batchOrdinal: number;
  units: BridgeUnitRef[];
  context: BatchContext;
  tokenEstimate: number;
  tokenBudgetCap: number;
  sceneId?: string | undefined;
  sceneSplitIndex?: number | undefined;
  routeId?: string | undefined;
  modelProfile: BatchModelProfile;
  /** When estimate > 0.95 * budget. */
  nearCapWarning: boolean;
  generatedAt: string;
};

export type PlanBatchesSummary = {
  batchCount: number;
  totalTokenEstimate: number;
  averageTokenEstimatePerBatch: number;
  minTokenEstimate: number;
  maxTokenEstimate: number;
  scenesSplitCount: number;
  unitsWithoutSceneCount: number;
  glossaryHitCount: number;
  modelProfile: BatchModelProfile;
};

export type PlanBatchesOutput = {
  batches: Batch[];
  summary: PlanBatchesSummary;
};

/**
 * Aliases for the source-side glossary, style guide, character map, and
 * translation memory snapshots that the planner consumes. They are loosely
 * shaped so existing repositories can feed them without coupling on field
 * names beyond what the planner reads.
 */
export type TerminologyAliasSnapshot = {
  aliasText: string;
  aliasKind?: string | undefined;
};

export type TerminologyTermSnapshot = {
  termId: Uuid7;
  termKey: string;
  termKind?: string | undefined;
  preferredSourceForm: string;
  preferredTargetForm?: string | undefined;
  aliases?: TerminologyAliasSnapshot[] | undefined;
  caseSensitive?: boolean | undefined;
};

export type StyleGuideRuleSnapshot = {
  ruleId: string;
  rulePath?: string | undefined;
  /** "always_on" or a category like "dialogue" / "system" / surfaceKind. */
  applicability: string;
  /** Optional rule body included in the prompt; used for token accounting. */
  body?: string | undefined;
};

export type StyleGuideVersionSnapshot = {
  styleGuideVersionId: Uuid7;
  rules: StyleGuideRuleSnapshot[];
};

export type CharacterMapEntrySnapshot = {
  termId: Uuid7;
  canonicalName: string;
  /** Normalized speaker keys/display names the parser is known to emit. */
  speakerKeys: string[];
  relationshipNotes?: string | undefined;
};

export type CharacterMapSnapshot = {
  entries: CharacterMapEntrySnapshot[];
};

export type TranslationMemoryQueryInput = {
  speaker?: string | undefined;
  sceneId?: string | undefined;
  surfaceKind?: string | undefined;
  limit: number;
};

export type TranslationMemoryQueryFn = (
  input: TranslationMemoryQueryInput,
) => ExampleRef[] | Promise<ExampleRef[]>;
