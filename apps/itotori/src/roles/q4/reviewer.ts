// Drive the Continuity Reviewer end to end.
//
// One physical review: parse the input against the strict schema, assemble the
// route-bound continuity request, dispatch it through the single ZDR boundary
// (INJECTED, so a recorded result gives a deterministic offline proof), then
// interpret and route the verdict against the deterministic continuity ledger.
// The dispatch boundary is exactly the production `dispatch` signature — the live
// path passes the real one; a proof passes a recorded result.
//
// The ledger, review scope, and unit under review are TRUSTED workflow
// substrate: the ledger is materialized from the decode fact snapshot and the
// review scope + accepted origins come from the localization store. This is a
// cooperative pipeline, not a hostile caller — the strict schema is the input
// check. What still matters, and is enforced deterministically at interpret
// time, is that every cited endpoint is real, on-route, and origin-before-use.

import type { CallResult, CallSpec } from "../../contracts/index.js";
import { buildQ4CallSpec, type Q4DispatchRefs } from "./request.js";
import { parseQ4ReviewInput, type Q4ReviewInput } from "./inputs.js";
import type { ContinuityLedger } from "./ledger.js";
import { canFinalize, interpretQ4Verdict, type Q4Interpretation } from "./verdict.js";

/** The single ZDR dispatch boundary, as a seam. The live wiring passes the real
 * `dispatch`; a recorded/memo result satisfies the same contract offline. */
export type Q4Dispatch = (spec: CallSpec) => Promise<CallResult>;

export interface Q4RunDeps {
  readonly dispatch: Q4Dispatch;
  /** The deterministic ledger, materialized from the decode fact snapshot. */
  readonly ledger: ContinuityLedger;
}

/** A dispatch that never produced a usable verdict (transport, refusal, …). */
export interface Q4DispatchFailure {
  readonly outcome: "no-verdict";
  readonly callResult: CallResult;
  readonly canFinalize: false;
}

/** A dispatch that produced a verdict, interpreted and routed. */
export interface Q4Reviewed {
  readonly outcome: "reviewed";
  readonly callResult: CallResult;
  readonly interpretation: Q4Interpretation;
  readonly canFinalize: boolean;
}

export type Q4RunOutcome = Q4DispatchFailure | Q4Reviewed;

/** Run one route-bound continuity review. The input is parsed against the strict
 * schema, dispatched through the ZDR boundary, then judged against the ledger. A
 * dispatch failure can never finalize. */
export async function runQ4Review(
  input: Q4ReviewInput,
  refs: Q4DispatchRefs,
  deps: Q4RunDeps,
): Promise<Q4RunOutcome> {
  const parsed = parseQ4ReviewInput(input);
  const spec = buildQ4CallSpec(parsed, refs);
  const callResult = await deps.dispatch(spec);
  if (callResult.status !== "success") {
    return { outcome: "no-verdict", callResult, canFinalize: false };
  }
  const interpretation = interpretQ4Verdict(callResult.value, {
    useUnitId: parsed.unitId,
    reviewScope: parsed.reviewScope,
    ledger: deps.ledger,
  });
  return {
    outcome: "reviewed",
    callResult,
    interpretation,
    canFinalize: canFinalize(interpretation),
  };
}
