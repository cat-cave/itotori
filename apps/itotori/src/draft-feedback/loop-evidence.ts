// ALPHA-002 — Before/after dashboard evidence for the feedback loop.
//
// Renders the playable-draft feedback loop as a before/after view derived
// from the batch result + the REAL scoped repair plan. The load-bearing
// field is `after.untouchedUnitIds`: the in-scope bridge units the repair
// left alone. Because `repairScheduledUnitIds` comes from the rerun
// scheduler's actual job output (see `buildDraftFeedbackRepairPlan`), a
// non-empty `untouchedUnitIds` is concrete proof that human feedback drove
// a scoped re-run, not a full rebuild.

import type {
  DraftFeedbackBatchResult,
  DraftFeedbackCorrection,
  DraftFeedbackLoopEvidence,
  DraftFeedbackRepairPlan,
} from "./types.js";

export type BuildDraftFeedbackLoopEvidenceArgs = {
  batchResult: DraftFeedbackBatchResult;
  repairPlan: DraftFeedbackRepairPlan;
  /**
   * Every bridge unit in the reviewed slice. The "before" baseline; the
   * repair's scope is measured against it to compute untouched work.
   */
  unitsInScope: ReadonlyArray<string>;
};

export function buildDraftFeedbackLoopEvidence(
  args: BuildDraftFeedbackLoopEvidenceArgs,
): DraftFeedbackLoopEvidence {
  const { batchResult, repairPlan } = args;
  const unitsInScope = sortedUnique(args.unitsInScope);
  const unitsWithFeedback = sortedUnique(batchResult.affectedBridgeUnitIds);
  const repairScheduledUnitIds = sortedUnique(repairPlan.repairScheduledUnitIds);
  const scheduled = new Set(repairScheduledUnitIds);
  const untouchedUnitIds = unitsInScope.filter((unit) => !scheduled.has(unit));

  const corrections: DraftFeedbackCorrection[] = [];
  for (const item of batchResult.items) {
    if (item.disposition !== "repair_candidate") {
      continue;
    }
    for (const bridgeUnitId of item.bridgeUnitIds) {
      corrections.push({
        bridgeUnitId,
        observed: item.observed,
        ...(item.suggestedEdit === undefined ? {} : { suggested: item.suggestedEdit }),
      });
    }
  }

  return {
    batchId: batchResult.batchId,
    ...(batchResult.batchLabel === undefined ? {} : { batchLabel: batchResult.batchLabel }),
    before: {
      unitsInScope,
      unitsWithFeedback,
      repairCandidateCount: batchResult.repairCandidateReportIds.length,
      decisionQueueCount: batchResult.decisionQueueReportIds.length,
    },
    after: {
      repairScheduledUnitIds,
      untouchedUnitIds,
      rerunJobCount: repairPlan.rerunJobs.length,
      decisionQueueReportIds: batchResult.decisionQueueReportIds,
    },
    corrections,
    // Scoped iff the repair re-ran a strict subset of the slice: at least
    // one in-scope unit was touched and at least one was left untouched.
    scoped: repairScheduledUnitIds.length > 0 && untouchedUnitIds.length > 0,
  };
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}
