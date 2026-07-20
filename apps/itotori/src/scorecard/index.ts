// Strict scorecard + zero-call deterministic replay — offline-provable core.
//
// Builds on the content-free qualifying artifact lineage and the accepted-
// output CAS / physical-step memo substrate. Pure projection and replay
// logic only: no model dispatch, no retired execution path, no CLI/API/composition wiring.
// The scorecard over a REAL terminal run is a live-lane follow-up.

export {
  LIVE_TERMINAL_RUN_SCORECARD_FOLLOW_UP,
  STRICT_SCORECARD_SCHEMA_VERSION,
  buildStrictScorecardFromLineage,
  buildStrictScorecardFromPersistedLineage,
  type StrictScorecard,
  type StrictScorecardCostTotal,
  type StrictScorecardStageBucket,
  type StrictScorecardStageRoleBucket,
  type StrictScorecardTokenTotal,
  type StrictScorecardTotals,
} from "./strict-from-lineage.js";

export {
  InMemoryZeroCallReplayStore,
  ZERO_CALL_REPLAY_SCHEMA_VERSION,
  hashOutputJson,
  replayZeroCallFromPersisted,
  type AcceptedOutputCasHead,
  type MemoizedPhysicalStep,
  type ZeroCallReplayResult,
  type ZeroCallReplayStore,
  type ZeroCallReplayedOutput,
} from "./zero-call-replay.js";
