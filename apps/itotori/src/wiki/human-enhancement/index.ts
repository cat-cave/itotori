// Self-contained RB-033 module barrel. This is NOT a shared app barrel: it is
// local to the human edit / feedback / enhancement path so a sibling role node
// never contends on it.

export {
  createDispatchEnhancementRunner,
  type DispatchEnhancementPlan,
  type DispatchEnhancementRunnerDeps,
  type EnhancementCallPlanner,
} from "./dispatch-runner.js";
export {
  detectDecodedFactConflicts,
  reconcileEnhancement,
  type DecodedFact,
  type EnhancementProposal,
  type EnhancementRequest,
  type EnhancementRunner,
  type ReconcileInput,
} from "./enhancement.js";
export {
  changedLeafPaths,
  getAtPath,
  leafPaths,
  pathKey,
  type FieldPath,
  type JsonValue,
} from "./field-path.js";
export {
  applyDeltaEdits,
  applyEdit,
  coalesceHumanDelta,
  HumanDeltaError,
  type CoalescedHumanDelta,
} from "./human-delta.js";
export {
  HumanEnhancementError,
  HumanEnhancementService,
  type AppendReceipt,
  type ApplyReceipt,
  type EnhancementSession,
  type HumanEnhancementDeps,
} from "./service.js";
