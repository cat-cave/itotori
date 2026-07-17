// The review-lane verdict interpreter — the deterministic projection of a role's
// raw model verdict into the driver's `LaneVerdict`.
//
// The model call happens inside the role; this maps its output to the finding the
// deterministic finding-join folds. It validates the raw output is a schema-valid
// review verdict for THIS lane + unit (a mis-routed or malformed verdict is a loud
// refusal, never a silent pass), then tags it with the lane. The lane-specific
// disposition guarantees (evidence resolution, meaning-only category, …) are the
// role's own `interpretQxVerdict` with its live resolvers; this is the structural
// tag the join consumes.

import { ReviewVerdictSchema, type ReviewVerdict } from "../../../contracts/index.js";
import type { LaneVerdict, ReviewLane } from "../../../workflow/index.js";
import { AssemblerError } from "./substrate.js";

/** The rubric each review lane's verdict must carry — the single source shared
 * with the contract rubric enum. */
const RUBRIC_BY_LANE: Partial<Record<ReviewLane, ReviewVerdict["rubric"]>> = {
  Q1: "meaning",
  Q2: "voice",
  Q3: "terminology",
  Q4: "continuity",
  Q5: "build-lqa",
};

/** Interpret a role's raw model output into a `LaneVerdict`. Fails loud when the
 * output is not a schema-valid review verdict, or is routed to the wrong lane or
 * unit — the driver's finding-join must never fold a mis-attributed verdict. */
export function interpretLaneVerdict(
  lane: ReviewLane,
  unitId: string,
  rawVerdict: unknown,
): LaneVerdict {
  const parsed = ReviewVerdictSchema.safeParse(rawVerdict);
  if (!parsed.success) {
    throw new AssemblerError(
      "invalid-verdict",
      `${lane} output is not a schema-valid review verdict`,
    );
  }
  const verdict = parsed.data;
  const rubric = RUBRIC_BY_LANE[lane];
  if (rubric === undefined) {
    throw new AssemblerError("not-a-review-lane", `${lane} is not a review lane`);
  }
  if (verdict.roleId !== lane) {
    throw new AssemblerError("wrong-lane", `verdict roleId ${verdict.roleId} is not ${lane}`);
  }
  if (verdict.rubric !== rubric) {
    throw new AssemblerError("wrong-rubric", `${lane} verdict rubric is ${verdict.rubric}`);
  }
  if (verdict.unitId !== unitId) {
    throw new AssemblerError(
      "wrong-unit",
      `${lane} verdict names unit ${verdict.unitId}, expected ${unitId}`,
    );
  }
  return { lane, verdict };
}
