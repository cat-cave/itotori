// The Semantic Repair role — a self-contained module. It consumes the roster
// manifest read-only (the Semantic Repair specialist) and dispatches through the
// single ZDR boundary; it owns no shared roster registry and imports no agents.
export {
  normalizeRepairRequest,
  RepairError,
  type NormalizedRepair,
  type RepairCandidateUnit,
  type RepairDefect,
  type RepairPlaceholder,
  type RepairRequest,
} from "./normalize.js";
export {
  buildRepairCall,
  dispatchRepairCall,
  REPAIR_MODE,
  type BuildRepairCallInput,
  type RepairCall,
  type RepairRuntimeBase,
} from "./call.js";
export {
  assertBlindedGroundedFork,
  assertRepairPatchBatch,
  RepairFinalizeError,
} from "./finalize.js";
export {
  repairSemanticDefects,
  RepairDispatchError,
  type RepairOptions,
  type RepairOutcome,
  type RepairedOutcome,
  type RoutedOutcome,
} from "./repair.js";
