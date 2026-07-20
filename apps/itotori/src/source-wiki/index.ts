// The whole-game source-Wiki orchestration — public surface.
//
// The deterministic control flow that drives the analyst roles (A1-A10) to build
// the whole-game, source-language Wiki: default-full roster selection, DAG
// dependency ordering, bounded-concurrency fan-out with the A3 serial fold, an
// accept gate proving every object is source-language / cited / route-scoped /
// stamped, and crash recovery by missing-artifact query. It imports nothing from
// the legacy agents tree; it composes the roster, prepass, read-tool substrate,
// and wiki persistence READ-ONLY.

export {
  ANALYST_ROLE_IDS,
  FULL_CONTEXT_ROSTER,
  SourceWikiSelectionError,
  assertContextRosterForRunMode,
  contextRosterIsFull,
  selectSourceWikiRoles,
} from "./roster-selection.js";
export { SourceWikiOrderingError, orderAnalystLevels } from "./ordering.js";
export {
  WHOLE_GAME_ROUTE_ID,
  deriveWorkSource,
  type RouteWork,
  type WorkSource,
} from "./work-source.js";
export { buildSourceWikiPlan } from "./plan.js";
export { ConcurrencyLimitError, mapWithConcurrency } from "./concurrency.js";
export {
  ObjectRejectedError,
  acceptObject,
  artifactKey,
  artifactKeyOf,
  isRecoverablyUncitable,
  scopeKey,
  type AcceptStamp,
} from "./accept.js";
export { InMemoryArtifactLedger, createRepositoryArtifactLedger } from "./ledger.js";
export {
  orchestrateSourceWiki,
  planSourceWiki,
  type OrchestrateSourceWikiDeps,
  type PhaseReport,
  type SourceWikiObserver,
  type SourceWikiRunReport,
  type UncitableObjectReport,
} from "./orchestrate.js";
export {
  WHOLE_GAME_CONTEXT_SCOPE,
  type AnalystRunner,
  type ArtifactKey,
  type ArtifactLedger,
  type ArtifactTarget,
  type Phase,
  type RunStepInput,
  type SourceWikiPlan,
  type WholeGameContextScope,
  type WorkItem,
  type WorkStep,
} from "./types.js";
