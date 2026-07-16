// Drive the Adjudicator end to end.
//
// One bounded adjudication:
//   1. refuse the contest if the bounded trigger fails (non-subjective,
//      low-impact, or facts not yet settled) — no model call;
//   2. build exactly TWO CallSpecs (A-then-B and B-then-A);
//   3. re-prove the certified judge route at the public dispatch entry in EVERY
//      mode (including test-dev);
//   4. dispatch both orders through the single ZDR boundary (INJECTED, so a
//      recorded result gives a deterministic offline proof);
//   5. interpret each order, fold them, and emit one binding verdict OR a typed
//      human-escalation artifact, always recording the order-debias measurement.
//
// There is no further round-trip: the dual-order budget IS the adjudication.

import type { CallResult, CallSpec } from "../../contracts/index.js";
import { contestEligible, parseQ6ReviewInput, type Q6ReviewInput } from "./inputs.js";
import {
  assertCertifiedJudgeRoute,
  buildQ6OrderCallSpecs,
  type Q6DispatchRefs,
} from "./request.js";
import type { Q6PresentationOrder } from "./prompt.js";
import {
  canFinalize,
  contestEvidenceResolver,
  foldQ6OrderJudgements,
  interpretQ6OrderVerdict,
  type EvidenceResolver,
  type Q6HumanEscalation,
  type Q6Interpretation,
  type Q6OrderJudgement,
  Q6HumanEscalationSchema,
  Q6_HUMAN_ESCALATION_SCHEMA_VERSION,
} from "./verdict.js";

/** The single ZDR dispatch boundary, as a seam. The live wiring passes the real
 * `dispatch`; a recorded/memo result satisfies the same contract offline. */
export type Q6Dispatch = (spec: CallSpec) => Promise<CallResult>;

export interface Q6RunDeps {
  readonly dispatch: Q6Dispatch;
  /** Defaults to a resolver over the contest's supplied evidence texts. */
  readonly resolveEvidence?: EvidenceResolver;
}

/** Contest outside the bounded trigger: no model was called. */
export interface Q6Ineligible {
  readonly outcome: "ineligible";
  readonly reason: string;
  readonly canFinalize: false;
}

/** A dispatch that never produced a usable dual-order fold. */
export interface Q6DispatchFailure {
  readonly outcome: "no-verdict";
  readonly callResults: readonly CallResult[];
  readonly escalation: Q6HumanEscalation;
  readonly canFinalize: false;
}

/** Dual-order adjudication completed and folded. */
export interface Q6Adjudicated {
  readonly outcome: "adjudicated";
  readonly callResults: readonly CallResult[];
  readonly interpretation: Q6Interpretation;
  readonly canFinalize: boolean;
  /** Served (model, provider) pairs recorded from the dispatch results — never
   * a routing input. */
  readonly servedPairs: readonly unknown[];
}

export type Q6RunOutcome = Q6Ineligible | Q6DispatchFailure | Q6Adjudicated;

function ineligibleReason(input: Q6ReviewInput): string {
  if (!input.trigger.subjectiveConflict) return "not a subjective conflict";
  if (input.trigger.impact !== "high") return `impact is ${input.trigger.impact}, not high`;
  if (!input.trigger.factsSettled) return "facts are not yet settled";
  return "contest is not eligible";
}

/** Run one bounded, order-debiased adjudication. An ineligible contest never
 * becomes a verdict; a dispatch failure never finalizes. */
export async function runQ6Adjudication(
  input: Q6ReviewInput,
  refs: Q6DispatchRefs,
  deps: Q6RunDeps,
): Promise<Q6RunOutcome> {
  const parsed = parseQ6ReviewInput(input);

  // Bounded trigger: refuse non-subjective / low-impact / pre-fact contests
  // before any model call.
  if (!contestEligible(parsed)) {
    return {
      outcome: "ineligible",
      reason: ineligibleReason(parsed),
      canFinalize: false,
    };
  }

  const ordered = buildQ6OrderCallSpecs(parsed, refs);
  // Exactly two presentations — the entire adjudication budget.
  if (ordered.length !== 2) {
    throw new Error("adjudication order budget must be exactly two presentations");
  }

  const callResults: CallResult[] = [];
  const judgements: Q6OrderJudgement[] = [];
  const resolve = deps.resolveEvidence ?? contestEvidenceResolver(parsed);
  const servedPairs: unknown[] = [];

  for (const { order, spec } of ordered) {
    // Re-prove the certified deepseek-v4-flash judge route at the public
    // dispatch entry, in every mode (including test-dev), before a byte leaves.
    assertCertifiedJudgeRoute(spec);

    const callResult = await deps.dispatch(spec);
    callResults.push(callResult);
    servedPairs.push(callResult.served);

    if (callResult.status !== "success") {
      const escalation = Q6HumanEscalationSchema.parse({
        schemaVersion: Q6_HUMAN_ESCALATION_SCHEMA_VERSION,
        unitId: parsed.unitId,
        localizationSnapshotId: parsed.localizationSnapshotId,
        reason: "dispatch-failure",
        orderDebias: {
          abWinner: null,
          baWinner: null,
          ordersAgree: false,
          bindingSide: null,
          abVerdict: order === "A-then-B" ? "missing" : "missing",
          baVerdict: "missing",
        },
        evidenceIds: parsed.positions.flatMap((position) =>
          position.evidence.map((item) => item.evidenceId),
        ),
        note: `dispatch failed on presentation order ${order}`,
      });
      return {
        outcome: "no-verdict",
        callResults,
        escalation,
        canFinalize: false,
      };
    }

    judgements.push(interpretQ6OrderVerdict(callResult.value, order, parsed, resolve));
  }

  const interpretation = foldQ6OrderJudgements(parsed, judgements);
  return {
    outcome: "adjudicated",
    callResults,
    interpretation,
    canFinalize: canFinalize(interpretation),
    servedPairs,
  };
}

/** Orders that were dispatched in a completed run (test seam). */
export function dispatchedOrders(outcome: Q6RunOutcome): readonly Q6PresentationOrder[] {
  if (outcome.outcome === "ineligible") return [];
  // Each successful path runs both orders; a mid-budget dispatch failure may
  // have run only the first. Infer from call count.
  if (outcome.callResults.length >= 2) return ["A-then-B", "B-then-A"];
  if (outcome.callResults.length === 1) return ["A-then-B"];
  return [];
}
