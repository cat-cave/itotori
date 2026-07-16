// Gate: protected-span preservation (`protected-spans`).
//
// Every protected span the decode committed with preserve mode `exact` (control
// markup, verbatim variable placeholders, ruby annotations that must survive
// byte-equal) MUST appear in the accepted target the required number of times.
// The required spans and their raw bytes are CITED from the snapshot unit's
// protected skeleton — never re-parsed from the target prose — so a fabricated
// or dropped control token is caught deterministically. Spans whose preserve
// mode allows transformation (`map` / `transform` / `locale_policy`) are not
// required verbatim and are skipped by this gate.

import type { Defect } from "../contracts/index.js";
import type { OrderedUnitFact } from "../prepass/index.js";

import { buildDefect } from "./defect.js";
import { missingRequiredOccurrences } from "./occurrences.js";
import { bindAccepted } from "./unit-index.js";
import type { AcceptedUnitOutput } from "./types.js";
import type { FactSnapshot } from "../prepass/index.js";

/** The verbatim-required raws for a unit (preserve mode `exact`, in span order). */
export function requiredExactSpanRaws(unit: OrderedUnitFact): string[] {
  return unit.protectedSkeleton.spans
    .filter((span) => span.preserveMode === "exact")
    .map((span) => span.raw);
}

export function protectedSpansGate(
  snapshot: FactSnapshot,
  accepted: readonly AcceptedUnitOutput[],
): Defect[] {
  const bound = bindAccepted(snapshot, accepted);
  const defects: Defect[] = [];
  for (const { fact, accepted: output } of bound.values()) {
    const required = requiredExactSpanRaws(fact);
    if (required.length === 0) {
      continue;
    }
    const target = output.value.targetSkeleton;
    const missing = missingRequiredOccurrences(required, target);
    for (const raw of new Set(missing)) {
      const requiredCount = required.filter((candidate) => candidate === raw).length;
      defects.push(
        buildDefect({
          unitId: fact.factId,
          category: "protected-span",
          detail: `target is missing required protected span ${JSON.stringify(raw)} (${requiredCount} required)`,
          basisFactIds: [fact.factId],
          span: { surface: "source", text: raw },
        }),
      );
    }
  }
  return defects;
}
