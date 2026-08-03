// Mandatory Q5 finalization guard.
//
// A Build-LQA port may not turn a render/OCR failure into a partial success:
// every requested unit needs one clean Q5 build-lqa verdict before the workflow
// creates its build-lqa CAS head.

import type { LaneVerdict } from "./types.js";
import { WorkflowSequenceError } from "./types.js";

export function assertCleanBuildLqa(
  requestedUnitIds: readonly string[],
  verdicts: readonly LaneVerdict[],
): void {
  const requested = new Set(requestedUnitIds);
  if (requested.size !== requestedUnitIds.length) {
    throw new WorkflowSequenceError("Build-LQA was requested with duplicate unit ids");
  }
  const seen = new Set<string>();
  for (const verdict of verdicts) {
    const unitId = verdict.verdict.unitId;
    if (
      verdict.lane !== "Q5" ||
      verdict.verdict.roleId !== "Q5" ||
      verdict.verdict.rubric !== "build-lqa" ||
      verdict.verdict.verdict !== "PASS"
    ) {
      throw new WorkflowSequenceError("Build-LQA returned a non-finalizable Q5 verdict");
    }
    if (!requested.has(unitId) || seen.has(unitId)) {
      throw new WorkflowSequenceError("Build-LQA returned an unexpected Q5 verdict coverage");
    }
    seen.add(unitId);
  }
  if (seen.size !== requested.size) {
    throw new WorkflowSequenceError("Build-LQA did not return a PASS for every requested unit");
  }
}
