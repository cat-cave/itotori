// Drive the Build-LQA Reviewer end to end.
//
// One physical review: parse the input against the strict schema, assemble the
// on-screen build-LQA request, dispatch it through the single ZDR boundary
// (INJECTED, so a recorded result gives a deterministic offline proof), then
// interpret and route the verdict against the frame it was formed over. The
// dispatch boundary is exactly the production `dispatch` signature — the live
// path passes the real one; a proof passes a recorded result. A blocking render/
// OCR fault routes the unit to the deterministic gates deterministically,
// whatever the model returned.
//
// The frame and expected target are TRUSTED workflow substrate: the patched-byte
// frame comes from the deterministic render step, and the expected target comes
// from the accepted-output store. This is a cooperative pipeline, not a hostile
// caller — the strict schema is the input check. The one channel invariant that
// still matters is enforced there: the frame carries no decoded-text field, so
// the English target is only ever observed through the render/OCR channel.

import type { CallResult, CallSpec } from "../../contracts/index.js";
import { buildQ5CallSpec, type Q5DispatchRefs } from "./request.js";
import {
  interpretQ5Verdict,
  canFinalize,
  type EvidenceResolver,
  type Q5Interpretation,
} from "./verdict.js";
import { parseQ5ReviewInput, type Q5ReviewInput } from "./inputs.js";

/** The single ZDR dispatch boundary, as a seam. The live wiring passes the real
 * `dispatch`; a recorded/memo result satisfies the same contract offline. */
export type Q5Dispatch = (spec: CallSpec) => Promise<CallResult>;

export interface Q5RunDeps {
  readonly dispatch: Q5Dispatch;
  readonly resolveEvidence: EvidenceResolver;
}

/** A dispatch that never produced a usable verdict (transport, refusal, …). */
export interface Q5DispatchFailure {
  readonly outcome: "no-verdict";
  readonly callResult: CallResult;
  readonly canFinalize: false;
}

/** A dispatch that produced a verdict, interpreted and routed. */
export interface Q5Reviewed {
  readonly outcome: "reviewed";
  readonly callResult: CallResult;
  readonly interpretation: Q5Interpretation;
  readonly canFinalize: boolean;
}

export type Q5RunOutcome = Q5DispatchFailure | Q5Reviewed;

/** Run one on-screen build-LQA review. The input is parsed against the strict
 * schema (which keeps the observation channel pure — no decoded-text field) then
 * reviewed. A dispatch failure can never finalize. */
export async function runQ5Review(
  input: Q5ReviewInput,
  refs: Q5DispatchRefs,
  deps: Q5RunDeps,
): Promise<Q5RunOutcome> {
  const parsed = parseQ5ReviewInput(input);
  const spec = buildQ5CallSpec(parsed, refs);
  const callResult = await deps.dispatch(spec);
  if (callResult.status !== "success") {
    return { outcome: "no-verdict", callResult, canFinalize: false };
  }
  const interpretation = interpretQ5Verdict(callResult.value, parsed.frame, deps.resolveEvidence);
  return {
    outcome: "reviewed",
    callResult,
    interpretation,
    canFinalize: canFinalize(interpretation),
  };
}
