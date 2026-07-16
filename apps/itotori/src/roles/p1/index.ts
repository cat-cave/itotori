// The P1 Whole-Scene Localizer role — a self-contained module. It consumes the
// roster manifest read-only (the P1 localizer specialist) and dispatches through
// the single ZDR boundary; it owns no shared roster registry.
export {
  normalizeScene,
  planSceneLocalization,
  PlanError,
  type ChunkSegment,
  type LocalizationPlan,
  type LocalizationSegment,
  type NormalizedScene,
  type PlanOptions,
  type SkeletonUnit,
  type WholeSceneSegment,
} from "./plan.js";
export {
  buildLocalizerCall,
  dispatchLocalizerCall,
  type AcceptedTargetLine,
  type BuildLocalizerCallInput,
  type LocalizerCall,
  type LocalizerRuntimeBase,
} from "./call.js";
export {
  assembleFinalizedDrafts,
  assertBatchMatchesSegment,
  assertExactAgainstSource,
  assertPlaceholdersPreserved,
  surfaceUncertainties,
  validateSegmentBatch,
  FinalizeError,
  type UncertainUnit,
} from "./finalize.js";
export {
  localizeScene,
  LocalizeError,
  type LocalizeSceneInput,
  type PriorAcceptedTarget,
  type SceneLocalization,
} from "./localizer.js";
