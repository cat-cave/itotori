// Drive the Terminology Auditor end to end.
//
// One physical audit: refuse the unit outright if the exact gate has not cleared
// (an exact mismatch is the gate's deterministic defect, NEVER a verdict — no
// model is called), otherwise assemble the terminology request, re-prove the
// certified route at this PUBLIC dispatch entry in EVERY mode, dispatch through
// the single ZDR boundary (INJECTED, so a recorded result gives a deterministic
// offline proof), then interpret and route the verdict.

import type { CallResult, CallSpec } from "../../contracts/index.js";
import { EXACT_GATE, exactGateCleared, type Q3ReviewInput } from "./inputs.js";
import { assertCertifiedReviewerRoute, buildQ3CallSpec, type Q3DispatchRefs } from "./request.js";
import {
  approvedFormContradictionResolver,
  canFinalize,
  interpretQ3Verdict,
  type ContradictionResolver,
  type EvidenceResolver,
  type Q3Interpretation,
} from "./verdict.js";

/** The single ZDR dispatch boundary, as a seam. The live wiring passes the real
 * `dispatch`; a recorded/memo result satisfies the same contract offline. */
export type Q3Dispatch = (spec: CallSpec) => Promise<CallResult>;

export interface Q3RunDeps {
  readonly dispatch: Q3Dispatch;
  readonly resolveEvidence: EvidenceResolver;
  /** Defaults to the approved-form contradiction resolver built from the input. */
  readonly resolveContradiction?: ContradictionResolver;
}

/** The exact gate reported a defect (or an approved form is absent): a
 * deterministic mismatch the gate owns. No model was called and no verdict was
 * produced. */
export interface Q3GateDefect {
  readonly outcome: "gate-defect";
  readonly owningGate: typeof EXACT_GATE;
  readonly canFinalize: false;
}

/** A dispatch that never produced a usable verdict (transport, refusal, …). */
export interface Q3DispatchFailure {
  readonly outcome: "no-verdict";
  readonly callResult: CallResult;
  readonly canFinalize: false;
}

/** A dispatch that produced a verdict, interpreted and routed. */
export interface Q3Reviewed {
  readonly outcome: "reviewed";
  readonly callResult: CallResult;
  readonly interpretation: Q3Interpretation;
  readonly canFinalize: boolean;
}

export type Q3RunOutcome = Q3GateDefect | Q3DispatchFailure | Q3Reviewed;

/** Run one terminology audit. An uncleared exact gate never becomes a verdict; a
 * dispatch failure never finalizes. */
export async function runQ3Audit(
  input: Q3ReviewInput,
  refs: Q3DispatchRefs,
  deps: Q3RunDeps,
): Promise<Q3RunOutcome> {
  // An exact mismatch is a deterministic defect owned by the gate. The auditor
  // refuses it before any model call — it never issues a terminology verdict.
  if (!exactGateCleared(input)) {
    return { outcome: "gate-defect", owningGate: EXACT_GATE, canFinalize: false };
  }

  const spec = buildQ3CallSpec(input, refs);
  // Re-prove the certified deepseek-v4-flash reviewer route at the public dispatch
  // entry, in every mode (including test-dev), before a byte leaves.
  assertCertifiedReviewerRoute(spec);

  const callResult = await deps.dispatch(spec);
  if (callResult.status !== "success") {
    return { outcome: "no-verdict", callResult, canFinalize: false };
  }
  const resolveContradiction =
    deps.resolveContradiction ?? approvedFormContradictionResolver(input);
  const interpretation = interpretQ3Verdict(
    callResult.value,
    input,
    deps.resolveEvidence,
    resolveContradiction,
  );
  return {
    outcome: "reviewed",
    callResult,
    interpretation,
    canFinalize: canFinalize(interpretation),
  };
}
