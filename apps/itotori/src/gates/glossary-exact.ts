// Gate: exact names / glossary conformance (`glossary-exact`).
//
// For every approved glossary term, the units where the source term occurs are
// a snapshot fact (`terminology.occurrenceUnitKeys`). This gate proves each such
// unit's accepted target renders the term's `requiredTargetForm` verbatim and
// contains none of its `forbiddenTargetForms`. The occurrence set and the term
// fact id are cited from the snapshot; an approved form for a term absent from
// the snapshot terminology cannot be evaluated and fails loud.

import type { Defect } from "../contracts/index.js";
import type { FactSnapshot, TerminologyOccurrenceFact } from "../prepass/index.js";

import { buildDefect, GateEvaluationError } from "./defect.js";
import { bindAccepted } from "./unit-index.js";
import type { AcceptedUnitOutput, GlossaryApprovedForm } from "./types.js";

export function glossaryExactGate(
  snapshot: FactSnapshot,
  accepted: readonly AcceptedUnitOutput[],
  glossary: readonly GlossaryApprovedForm[],
): Defect[] {
  const bound = bindAccepted(snapshot, accepted);
  const bySourceKey = new Map(
    [...bound.values()].map((binding) => [binding.fact.sourceUnitKey, binding] as const),
  );
  const termByKey = new Map<string, TerminologyOccurrenceFact>(
    snapshot.terminology.map((term) => [term.termKey, term]),
  );

  const defects: Defect[] = [];
  for (const form of glossary) {
    const term = termByKey.get(form.termId);
    if (term === undefined) {
      throw new GateEvaluationError(
        `approved glossary form ${form.termId} has no matching terminology fact in snapshot ${snapshot.snapshotId}`,
      );
    }
    for (const unitKey of term.occurrenceUnitKeys) {
      const binding = bySourceKey.get(unitKey);
      if (binding === undefined) {
        continue; // that occurrence has no accepted output yet (coverage gate owns it)
      }
      const target = binding.accepted.value.targetSkeleton;
      if (!target.includes(form.requiredTargetForm)) {
        defects.push(
          buildDefect({
            unitId: binding.fact.factId,
            category: "glossary-exact",
            detail: `target is missing the approved form ${JSON.stringify(form.requiredTargetForm)} for source term ${JSON.stringify(form.sourceForm)}`,
            basisFactIds: [term.factId],
            span: { surface: "source", text: form.sourceForm },
          }),
        );
      }
      for (const forbidden of form.forbiddenTargetForms) {
        if (forbidden.length > 0 && target.includes(forbidden)) {
          defects.push(
            buildDefect({
              unitId: binding.fact.factId,
              category: "glossary-exact",
              detail: `target uses the forbidden form ${JSON.stringify(forbidden)} for term ${JSON.stringify(form.sourceForm)}`,
              basisFactIds: [term.factId],
              span: { surface: "target", text: forbidden },
            }),
          );
        }
      }
    }
  }
  return defects;
}
