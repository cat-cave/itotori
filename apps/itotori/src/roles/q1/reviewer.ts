// Drive the Meaning Reviewer end to end.
//
// One physical review: assemble the blinded meaning-only request, dispatch it
// through the single ZDR boundary (INJECTED, so a recorded result gives a
// deterministic offline proof), then interpret and route the verdict. The
// dispatch boundary is exactly the production `dispatch` signature — the live
// path passes the real one; a proof passes a recorded result. Nothing here
// derives a verdict from the back-translation signal: the verdict comes only
// from the model's ReviewVerdict, and the signal cannot flip the outcome.

import type { CallResult, CallSpec, Defect } from "../../contracts/index.js";
import {
  assembleQ1ReviewArtifact,
  type Q1ArtifactContext,
  type Q1ReviewArtifact,
} from "./artifact.js";
import { buildQ1CallSpec, type Q1DispatchRefs } from "./request.js";
import {
  interpretQ1Verdict,
  canFinalize,
  type EvidenceResolver,
  type Q1Interpretation,
} from "./verdict.js";
import type { Q1ReviewInput } from "./inputs.js";

/** The single ZDR dispatch boundary, as a seam. The live wiring passes the real
 * `dispatch`; a recorded/memo result satisfies the same contract offline. */
export type Q1Dispatch = (spec: CallSpec) => Promise<CallResult>;

export interface Q1RunDeps {
  readonly dispatch: Q1Dispatch;
  readonly resolveEvidence: EvidenceResolver;
  /** When the workflow is persisting reviewer evidence, it supplies the exact
   * reviewed batch + RB-031 dependency edges. The runner stamps the physical
   * call memo key and emits the provisional Translation WikiObject. */
  readonly artifactContext?: Omit<Q1ArtifactContext, "authorMemoKey">;
  /** Deterministic gates run before reviewers. A defect on this unit remains
   * authoritative even if the meaning model emits PASS. */
  readonly deterministicDefects?: readonly Defect[];
}

/** A dispatch that never produced a usable verdict (transport, refusal, …). */
export interface Q1DispatchFailure {
  readonly outcome: "no-verdict";
  readonly callResult: CallResult;
  readonly canFinalize: false;
}

/** A dispatch that produced a verdict, interpreted and routed. */
export interface Q1Reviewed {
  readonly outcome: "reviewed";
  readonly callResult: CallResult;
  readonly interpretation: Q1Interpretation;
  readonly canFinalize: boolean;
  readonly artifact: Q1ReviewArtifact | null;
  readonly dominatingFactIds: readonly string[];
}

export type Q1RunOutcome = Q1DispatchFailure | Q1Reviewed;

/** Facts are settled before the reviewer runs. A deterministic defect therefore
 * prevents Q1 from finalizing a unit even when the blinded model passed it. */
function applyDeterministicDominance(
  interpretation: Q1Interpretation,
  unitId: string,
  defects: readonly Defect[] | undefined,
): { readonly interpretation: Q1Interpretation; readonly dominatingFactIds: readonly string[] } {
  const dominatingFactIds = (defects ?? [])
    .filter((defect) => defect.origin === "deterministic" && defect.unitId === unitId)
    .map((defect) => defect.defectId);
  if (dominatingFactIds.length === 0 || interpretation.disposition !== "finalize") {
    return { interpretation, dominatingFactIds };
  }
  return {
    interpretation: { ...interpretation, disposition: "repair" },
    dominatingFactIds,
  };
}

/** Run one blinded meaning review. A dispatch failure can never finalize. */
export async function runQ1Review(
  input: Q1ReviewInput,
  refs: Q1DispatchRefs,
  deps: Q1RunDeps,
): Promise<Q1RunOutcome> {
  const spec = buildQ1CallSpec(input, refs);
  const callResult = await deps.dispatch(spec);
  if (callResult.status !== "success") {
    return { outcome: "no-verdict", callResult, canFinalize: false };
  }
  const interpreted = interpretQ1Verdict(callResult.value, deps.resolveEvidence);
  const { interpretation, dominatingFactIds } = applyDeterministicDominance(
    interpreted,
    input.unitId,
    deps.deterministicDefects,
  );
  const artifact =
    deps.artifactContext === undefined
      ? null
      : assembleQ1ReviewArtifact(input, interpretation, {
          ...deps.artifactContext,
          authorMemoKey: callResult.memoKey,
        });
  return {
    outcome: "reviewed",
    callResult,
    interpretation,
    canFinalize: canFinalize(interpretation),
    artifact,
    dominatingFactIds,
  };
}
