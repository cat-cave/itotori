// The deterministic live workflow-port assemblers — the concrete `WorkflowPortDeps`
// seam projections that turn run-scoped decode facts + the threaded drafted scene
// / contested verdicts into each role's EXACT input. No assembler dispatches a
// model: the model call happens inside each role. The FACTORY that sources the
// substrate (fact snapshot, bridge units, installed bible, ZDR runtimes) from a
// live Postgres + ZDR run, and the Q5 build-LQA input (which needs live patched-
// bytes render/OCR), are the live lane — see the module comments for the flags.

export {
  AssemblerError,
  decodeFactSourceFrom,
  projectSceneUnitFact,
  projectSceneUnitFacts,
  type DecodeFactSource,
  type InstalledBible,
  type RequirementOptions,
  type RunScopeConfig,
  type Sha256Hash,
} from "./substrate.js";
export { createReadinessDeps } from "./readiness.js";
export { buildLocalizeSceneInput, createDraftDeps, type DraftRealizationConfig } from "./draft.js";
export {
  buildDeterministicGateInput,
  createGateDeps,
  type GateEvidenceCorpus,
  type GateSideInputs,
} from "./gate.js";
export {
  buildEditLineInput,
  buildRepairOptions,
  buildRepairRequest,
  createRepairDeps,
} from "./repair.js";
export {
  buildQ6ReviewInput,
  createAdjudicateDeps,
  type BibleRenderingIdResolver,
  type EvidenceTextResolver,
} from "./adjudicate.js";
export {
  buildQ1ReviewInput,
  buildQ2ReviewInput,
  buildQ3ReviewInput,
  buildQ4ReviewInput,
  knownSpeakerId,
  primaryRouteId,
  toRouteScope,
} from "./review-inputs.js";
export { interpretLaneVerdict } from "./review-verdict.js";
