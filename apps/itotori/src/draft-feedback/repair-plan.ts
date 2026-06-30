// ALPHA-002 — Scoped repair plan from reviewer decisions.
//
// Takes the REAL `ReviewerQueueActionResult`s produced when a reviewer
// acts on draft-feedback queue items (e.g. `requestRepair` on a typo
// report) and runs them through the existing reviewer-triggered rerun
// scheduler (`buildReviewerTriggeredRerunJobInputs`). The scheduler is
// the single source of truth for "which work re-runs": it scopes the
// rerun jobs to the affected bridge units carried on the item / transition
// metadata. This module only AGGREGATES that real output — it never
// decides scope itself, so it cannot widen a repair past what the
// scheduler emitted.

import type { ReviewerQueueActionResult } from "@itotori/db";
import { buildReviewerTriggeredRerunJobInputs } from "../reviewer/repair-rerun-scheduler.js";
import type { DraftFeedbackRepairPlan, DraftFeedbackRepairPlanItem } from "./types.js";

/**
 * Aggregate the scoped rerun jobs the scheduler emits for a set of
 * reviewer decisions. `repairScheduledUnitIds` is read back from the
 * jobs' `bridge_unit` subject refs — the real, narrowed scope — not from
 * the request. Decisions that produce no rerun jobs (approve / reject /
 * defer / escalate) contribute nothing, exactly as the scheduler intends.
 */
export function buildDraftFeedbackRepairPlan(
  actionResults: ReadonlyArray<ReviewerQueueActionResult>,
): DraftFeedbackRepairPlan {
  const rerunJobs = [] as ReturnType<typeof buildReviewerTriggeredRerunJobInputs>;
  const perItem: DraftFeedbackRepairPlanItem[] = [];
  const scheduled = new Set<string>();

  for (const result of actionResults) {
    const jobs = buildReviewerTriggeredRerunJobInputs(result);
    if (jobs.length === 0) {
      continue;
    }
    const units = new Set<string>();
    const jobIds: string[] = [];
    for (const job of jobs) {
      rerunJobs.push(job);
      if (typeof job.jobId === "string") {
        jobIds.push(job.jobId);
      }
      for (const unit of bridgeUnitsFromSubjectRefs(job.subjectRefs)) {
        units.add(unit);
        scheduled.add(unit);
      }
    }
    perItem.push({
      reviewItemId: result.item.reviewItemId,
      affectedUnitIds: sortedUnique([...units]),
      rerunJobIds: sortedUnique(jobIds),
    });
  }

  return {
    rerunJobs,
    repairScheduledUnitIds: sortedUnique([...scheduled]),
    perItem,
  };
}

function bridgeUnitsFromSubjectRefs(subjectRefs: unknown[] | undefined): string[] {
  if (!Array.isArray(subjectRefs)) {
    return [];
  }
  const out: string[] = [];
  for (const ref of subjectRefs) {
    if (
      ref !== null &&
      typeof ref === "object" &&
      "subjectKind" in ref &&
      (ref as { subjectKind: unknown }).subjectKind === "bridge_unit" &&
      "subjectId" in ref &&
      typeof (ref as { subjectId: unknown }).subjectId === "string"
    ) {
      out.push((ref as { subjectId: string }).subjectId);
    }
  }
  return out;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}
