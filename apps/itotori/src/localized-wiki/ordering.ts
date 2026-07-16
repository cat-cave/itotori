// Deterministic tier ordering + decision-class derivation.
//
// The bible has exactly two tiers and they run in a FIXED order: the canonical-
// form DECISIONS (L-Term / L-Name) FIRST, then every DESCRIPTIVE rendering. The
// order is not incidental — `assertDecisionTierFirst` proves the decision phase
// strictly precedes the descriptive phase, and the orchestrator refuses to enter
// the descriptive phase until the decisions are installed.
//
// A source object's tier and decision class are derived MECHANICALLY from its
// kind and subject, never inferred by a model: a `term-ruling` is a decision (a
// character subject makes it an L-Name, any other subject an L-Term); every other
// source kind is descriptive.

import type { WikiObject } from "../contracts/index.js";
import type { BiblePhase, BibleTier, DecisionClass } from "./types.js";

/** The tier order the bible MUST execute in. */
export const BIBLE_TIER_ORDER: readonly BibleTier[] = Object.freeze(["decision", "descriptive"]);

/** The one source kind that carries a canonical target form and is therefore a
 * decision. Everything else is a descriptive rendering. */
export const DECISION_SOURCE_KIND = "term-ruling" as const;

/** A plan whose tiers are out of order — a control-flow defect. */
export class BibleOrderingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BibleOrderingError";
  }
}

/** The tier a source object belongs to. */
export function tierOf(object: WikiObject): BibleTier {
  return object.kind === DECISION_SOURCE_KIND ? "decision" : "descriptive";
}

/** The decision class of a source object, or `null` if it is descriptive. A
 * term-ruling over a character subject is a NAME ruling (L-Name); any other
 * term-ruling is a glossary-TERM ruling (L-Term). */
export function decisionClassOf(object: WikiObject): DecisionClass | null {
  if (object.kind !== DECISION_SOURCE_KIND) return null;
  return object.subject.kind === "character" ? "L-Name" : "L-Term";
}

/**
 * Prove the plan runs the decisions FIRST: every decision-tier phase is at a
 * strictly earlier level than every descriptive-tier phase. A reordered plan
 * throws — the ordering is enforced, not incidental.
 */
export function assertDecisionTierFirst(phases: readonly BiblePhase[]): void {
  let maxDecisionLevel = -1;
  let minDescriptiveLevel = Number.POSITIVE_INFINITY;
  for (const phase of phases) {
    if (phase.tier === "decision") maxDecisionLevel = Math.max(maxDecisionLevel, phase.level);
    else minDescriptiveLevel = Math.min(minDescriptiveLevel, phase.level);
  }
  if (maxDecisionLevel >= 0 && minDescriptiveLevel <= maxDecisionLevel) {
    throw new BibleOrderingError(
      `decision tier must precede the descriptive tier: decision level ${maxDecisionLevel} is not before descriptive level ${minDescriptiveLevel}`,
    );
  }
}
