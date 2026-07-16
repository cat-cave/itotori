// The Adjudicator role module: a self-contained casting of the reviewer shape
// that resolves ONE genuine subjective / high-impact conflict after facts have
// settled. Blinded to which reviewer produced each contested position, it runs
// the judgement in both A/B and B/A order, records the order-debias (self-bias)
// measurement, and emits exactly one binding verdict OR a typed human-escalation
// artifact. Bounded to one dual-order adjudication — no unbounded back-and-
// forth. Self-contained on purpose — it consumes the roster read-only and shares
// no barrel a sibling reviewer would also edit.
export {
  FORBIDDEN_BLINDING_KEYS,
  Q6_IMPACT_LEVELS,
  Q6_POSITION_LABELS,
  Q6BlindingError,
  Q6ContestTriggerSchema,
  Q6ContestedPositionSchema,
  Q6EvidenceItemSchema,
  Q6ImpactSchema,
  Q6IneligibleContestError,
  Q6PositionLabelSchema,
  Q6ReviewInputSchema,
  allContestEvidenceIds,
  assertBlinded,
  assertContestEligible,
  contestEligible,
  parseQ6ReviewInput,
  positionByLabel,
  sideOwningEvidence,
  type Q6ContestTrigger,
  type Q6ContestedPosition,
  type Q6EvidenceItem,
  type Q6Impact,
  type Q6PositionLabel,
  type Q6ReviewInput,
} from "./inputs.js";
export {
  Q6_PROMPT_VERSION,
  assembleQ6Messages,
  labelsForOrder,
  q6SystemPrompt,
  q6UserPrompt,
  type Q6Messages,
  type Q6PresentationOrder,
} from "./prompt.js";
export {
  Q6_ORDER_BUDGET,
  Q6RouteError,
  Q6RubricScopeError,
  assertAdjudicationOnlyToolGrant,
  assertCertifiedJudgeRoute,
  buildQ6CallSpec,
  buildQ6OrderCallSpecs,
  q6AdjudicationToolGrant,
  type Q6DispatchRefs,
} from "./request.js";
export {
  Q6_ADJUDICATION_CATEGORIES,
  Q6_HUMAN_ESCALATION_SCHEMA_VERSION,
  Q6HumanEscalationSchema,
  Q6OrderDebiasSchema,
  canFinalize,
  contestEvidenceResolver,
  foldQ6OrderJudgements,
  interpretQ6OrderVerdict,
  interpretQ6Verdict,
  winningSideFromCitations,
  type EvidenceResolution,
  type EvidenceResolver,
  type Q6Disposition,
  type Q6HumanEscalation,
  type Q6Interpretation,
  type Q6OrderDebias,
  type Q6OrderJudgement,
} from "./verdict.js";
export {
  dispatchedOrders,
  runQ6Adjudication,
  type Q6Adjudicated,
  type Q6Dispatch,
  type Q6DispatchFailure,
  type Q6Ineligible,
  type Q6RunDeps,
  type Q6RunOutcome,
} from "./reviewer.js";
