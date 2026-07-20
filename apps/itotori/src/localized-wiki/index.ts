// The per-target localized-Wiki (bible) orchestration — public surface.
//
// The deterministic control flow that turns the source-language Wiki into the
// mandatory per-target bible BEFORE any production line: a localizer-profile
// posture, the L-Term / L-Name decisions FIRST, a Q3/Q2-style reviewer gate over
// those decisions, the install of the agreed canonical target forms into the
// deterministic gates, then the descriptive renderings (style, voice, arcs,
// cultural notes) — with recovery by missing-rendering query and NO bypass under
// production or pilot. It imports nothing from the legacy agents tree; it
// composes the source Wiki, roster, reviewer castings, gates, and wiki
// persistence READ-ONLY.

export {
  LOCALIZER_PROFILE_SHAPE,
  FULL_BIBLE_POSTURES,
  BibleBypassError,
  CollapsedBibleError,
  assertBibleIsNotCollapsed,
  bypassBibleForAblation,
  localizerProfileRoles,
  mustBuildFullBible,
  type AblationBypass,
} from "./posture.js";
export {
  BIBLE_TIER_ORDER,
  DECISION_SOURCE_KIND,
  BibleOrderingError,
  assertDecisionTierFirst,
  decisionClassOf,
  tierOf,
} from "./ordering.js";
export {
  RenderingRejectedError,
  acceptRendering,
  renderingKey,
  renderingKeyOf,
  scopeKey,
} from "./rendering.js";
export { BiblePlanError, buildLocalizedWikiPlan } from "./plan.js";
export {
  DECISION_RUBRICS,
  reviewDecision,
  type DecisionReview,
  type RubricOutcome,
} from "./review-gate.js";
export {
  CanonicalFormInstallError,
  installCanonicalForms,
  toGlossaryApprovedForm,
  type ValidatedDecision,
} from "./install.js";
export { InMemoryBibleRenderingLedger, createRepositoryBibleRenderingLedger } from "./ledger.js";
export {
  LocalizedWikiRouteError,
  buildLocalizedDecisionReviewCall,
  buildLocalizedRenderingCall,
  createCertifiedLocalizedWikiActors,
  createDispatchDecisionReviewer,
  createDispatchLocalizerRunner,
  type CertifiedLocalizedWikiActors,
  type LocalizedWikiDispatch,
  type LocalizedWikiDispatchRefs,
} from "./dispatch.js";
export {
  orchestrateLocalizedWiki,
  planLocalizedWiki,
  BibleDecisionValidationError,
  type DecisionOutcome,
  type LocalizedWikiObserver,
  type LocalizedWikiRunReport,
  type OrchestrateLocalizedWikiDeps,
} from "./orchestrate.js";
export {
  type BiblePhase,
  type BibleRenderingLedger,
  type BibleStep,
  type BibleTier,
  type DecisionClass,
  type DecisionReviewer,
  type DecisionReviewerOutput,
  type LocalizationPosture,
  type LocalizedTarget,
  type LocalizedWikiPlan,
  type LocalizerRunner,
  type RenderStepInput,
  type RenderingKey,
  type RenderingStamp,
  type ReviewDecisionInput,
} from "./types.js";
