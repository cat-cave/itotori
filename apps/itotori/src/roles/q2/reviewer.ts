// Drive the Voice Reviewer end to end.
//
// One physical review: assemble the voice-continuity request against the DECODE-
// DERIVED position, re-prove the certified route at this PUBLIC dispatch entry in
// EVERY mode, dispatch through the single ZDR boundary (INJECTED, so a recorded
// result gives a deterministic offline proof), then interpret and route the
// verdict. The citation resolver defaults to the position-grounded one built from
// the input, so a FAIL is judged against the applicable bible rule and the
// accepted history at the exact position — never against model-chosen grounds.

import type { CallResult, CallSpec } from "../../contracts/index.js";
import { assertCertifiedReviewerRoute, buildQ2CallSpec, type Q2DispatchRefs } from "./request.js";
import {
  canFinalize,
  interpretQ2Verdict,
  positionGroundedCitationResolver,
  type EvidenceResolver,
  type Q2Interpretation,
  type VoiceCitationResolver,
} from "./verdict.js";
import type { Q2ReviewInput } from "./inputs.js";

/** The single ZDR dispatch boundary, as a seam. The live wiring passes the real
 * `dispatch`; a recorded/memo result satisfies the same contract offline. */
export type Q2Dispatch = (spec: CallSpec) => Promise<CallResult>;

export interface Q2RunDeps {
  readonly dispatch: Q2Dispatch;
  readonly resolveEvidence: EvidenceResolver;
  /** Defaults to the position-grounded citation resolver built from the input. */
  readonly resolveCitation?: VoiceCitationResolver;
}

/** A dispatch that never produced a usable verdict (transport, refusal, …). */
export interface Q2DispatchFailure {
  readonly outcome: "no-verdict";
  readonly callResult: CallResult;
  readonly canFinalize: false;
}

/** A dispatch that produced a verdict, interpreted and routed. */
export interface Q2Reviewed {
  readonly outcome: "reviewed";
  readonly callResult: CallResult;
  readonly interpretation: Q2Interpretation;
  readonly canFinalize: boolean;
}

export type Q2RunOutcome = Q2DispatchFailure | Q2Reviewed;

/** Run one voice-continuity review. A dispatch failure never finalizes; a FAIL is
 * grounded against the applicable bible rule and violated history at the position. */
export async function runQ2Review(
  input: Q2ReviewInput,
  refs: Q2DispatchRefs,
  deps: Q2RunDeps,
): Promise<Q2RunOutcome> {
  const spec = buildQ2CallSpec(input, refs);
  // Re-prove the certified deepseek-v4-flash reviewer route at the public dispatch
  // entry, in every mode (including test-dev), before a byte leaves.
  assertCertifiedReviewerRoute(spec);

  const callResult = await deps.dispatch(spec);
  if (callResult.status !== "success") {
    return { outcome: "no-verdict", callResult, canFinalize: false };
  }
  const resolveCitation = deps.resolveCitation ?? positionGroundedCitationResolver(input);
  const interpretation = interpretQ2Verdict(
    callResult.value,
    deps.resolveEvidence,
    resolveCitation,
  );
  return {
    outcome: "reviewed",
    callResult,
    interpretation,
    canFinalize: canFinalize(interpretation),
  };
}
