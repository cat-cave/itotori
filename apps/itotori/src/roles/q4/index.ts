// The Continuity Reviewer role module: a self-contained casting of the reviewer
// shape that judges CALLBACK / FORESHADOW / RELATIONSHIP / ROUTE-ARC consistency
// only, against the localized route + character bible and accepted origin
// translations. A contradiction cites both real endpoints; the decode play order
// proves the origin plays before the use, and no claim ever crosses the route the
// review is bound to. Self-contained on purpose — it consumes the roster and the
// decode fact snapshot read-only and shares no barrel a sibling reviewer edits.
export {
  buildContinuityLedger,
  continuityLedgerFrom,
  endpointVisibleOnReviewScope,
  originPrecedesUse,
  type ContinuityFact,
  type ContinuityLedger,
} from "./ledger.js";
export {
  Q4OriginTranslationSchema,
  Q4ReviewInputSchema,
  parseQ4ReviewInput,
  reviewScopeOf,
  type Q4OriginTranslation,
  type Q4ReviewInput,
} from "./inputs.js";
export {
  Q4_PROMPT_VERSION,
  assembleQ4Messages,
  q4SystemPrompt,
  q4UserPrompt,
  renderReviewScope,
  type Q4Messages,
} from "./prompt.js";
export {
  Q4RouteError,
  Q4RubricScopeError,
  assertCertifiedContinuityRoute,
  assertContinuityOnlyToolGrant,
  buildQ4CallSpec,
  q4ContinuityToolGrant,
  type Q4DispatchRefs,
} from "./request.js";
export {
  Q4_CONTINUITY_CATEGORIES,
  canFinalize,
  interpretQ4Verdict,
  type Q4ContinuityFacts,
  type Q4Disposition,
  type Q4Interpretation,
} from "./verdict.js";
export {
  runQ4Review,
  type Q4Dispatch,
  type Q4DispatchFailure,
  type Q4Reviewed,
  type Q4RunDeps,
  type Q4RunOutcome,
} from "./reviewer.js";
