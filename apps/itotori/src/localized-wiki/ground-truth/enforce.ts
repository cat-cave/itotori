// Enforce the bible as ground truth — a contradictory line is a DEFECT.
//
// The bible's installed canonical forms are the authoritative target for every
// term they rule. A drafted / reviewed line that renders a different form for a
// ruled term is not an alternate stylistic choice the pipeline may accept: it is
// a deterministic defect. This binds the bible's OWN installed forms into the
// deterministic glossary-exact gate, so the contradiction is caught as the same
// `glossary-exact` defect the downstream gate emits — grounded on a snapshot
// fact, routed to correction, never suppressible by a reviewer. Feeding the
// bible forms is the binding; removing it removes the guarantee (and a
// contradiction would pass unflagged), which is exactly what the proof falsifies.

import type { Defect } from "../../contracts/index.js";
import { glossaryExactGate, type AcceptedUnitOutput } from "../../gates/index.js";
import type { FactSnapshot } from "../../prepass/index.js";
import type { InstalledBible } from "./types.js";

/** The outcome of enforcing the bible over a set of accepted lines. */
export interface BibleEnforcementResult {
  /** Every deterministic defect the bible's authority produced. */
  readonly defects: readonly Defect[];
  /** The subset that are canonical-form contradictions — a line rendering a form
   * the bible forbids/omits for a ruled term. These are ground-truth violations,
   * never accepted stylistic variants. */
  readonly contradictions: readonly Defect[];
}

/** Enforce the installed bible against the accepted lines. A line contradicting
 * a ruled term's canonical form surfaces as a `glossary-exact` defect. */
export function enforceBibleGroundTruth(
  snapshot: FactSnapshot,
  accepted: readonly AcceptedUnitOutput[],
  bible: InstalledBible,
): BibleEnforcementResult {
  const defects = glossaryExactGate(snapshot, accepted, bible.canonicalForms);
  const contradictions = defects.filter((defect) => defect.category === "glossary-exact");
  return { defects, contradictions };
}
