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
  type P1UnitBible,
  type PriorAcceptedTarget,
  type SceneLocalization,
} from "./localizer.js";
export {
  P1_ROLE_ID,
  P1_TRANSLATION_KIND,
  P1RoleError,
  type P1Context,
  type P1FailureCode,
  type P1ModelCaller,
  type P1ReadScene,
  type P1SceneInput,
  type P1SegmentRequest,
} from "./agent-types.js";
export { p1Caller, readP1Scene } from "./read.js";
export { assembleP1TranslationObject } from "./assemble.js";
export {
  assertP1AgentCertifiedRoute,
  buildP1AgentCall,
  dispatchP1Agent,
  dispatchingP1ModelCaller,
  type P1AgentCall,
} from "./agent-call.js";
export { runP1Scene, type P1SceneResult } from "./run.js";
