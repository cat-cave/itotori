// The Terminology Auditor role module: a self-contained casting of the reviewer
// shape that runs ONLY AFTER the exact glossary and name gate and judges the
// contextual SENSE and REGISTER of already-approved forms — or a genuinely new
// ambiguous coinage. An exact mismatch is the deterministic gate's defect, never
// this lane's verdict; a verdict contradicting an approved form is rejected and
// routed back, never overwritten. Self-contained on purpose — it consumes the
// roster read-only and shares no barrel a sibling reviewer would also edit.
export {
  EXACT_GATE,
  Q3AmbiguousCoinageSchema,
  Q3ApprovedTermSchema,
  Q3ExactGateSchema,
  Q3NeighborWindowSchema,
  Q3PrematureAuditError,
  Q3ReviewInputSchema,
  assertExactGateCleared,
  exactGateCleared,
  parseQ3ReviewInput,
  type Q3ApprovedTerm,
  type Q3AmbiguousCoinage,
  type Q3ExactGate,
  type Q3NeighborWindow,
  type Q3ReviewInput,
} from "./inputs.js";
export {
  Q3_PROMPT_VERSION,
  assembleQ3Messages,
  q3SystemPrompt,
  q3UserPrompt,
  type Q3Messages,
} from "./prompt.js";
export {
  Q3RouteError,
  Q3RubricScopeError,
  assertCertifiedReviewerRoute,
  assertTerminologyOnlyToolGrant,
  buildQ3CallSpec,
  q3TerminologyToolGrant,
  type Q3DispatchRefs,
} from "./request.js";
export {
  Q3_TERMINOLOGY_CATEGORIES,
  approvedFormContradictionResolver,
  canFinalize,
  interpretQ3Verdict,
  type ContradictionResolution,
  type ContradictionResolver,
  type EvidenceResolution,
  type EvidenceResolver,
  type Q3Disposition,
  type Q3Interpretation,
  type Q3Referral,
} from "./verdict.js";
export {
  runQ3Audit,
  type Q3Dispatch,
  type Q3DispatchFailure,
  type Q3GateDefect,
  type Q3Reviewed,
  type Q3RunDeps,
  type Q3RunOutcome,
} from "./reviewer.js";
