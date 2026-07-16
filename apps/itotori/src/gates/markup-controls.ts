// Gate: markup balance + control-sequence integrity + punctuation
// (`markup-controls`; categories `markup`, `control-sequence`, `punctuation`).
//
//   * markup           — angle-bracket and square-bracket tags in the target
//                        must be balanced (no unclosed / stray bracket).
//   * control-sequence — an out-of-band control marker (the kidoku Textout
//                        marker) or the interior-quote placeholder must never
//                        leak into the accepted target.
//   * punctuation      — a spoken/narrated target must terminate with sentence
//                        punctuation or a closing quote/bracket (a truncated
//                        line is a defect). Minor severity — never a hard fact.
// All three read only the snapshot surface kind and the accepted target.

import type { Defect } from "../contracts/index.js";
import type { FactSnapshot } from "../prepass/index.js";

import { buildDefect } from "./defect.js";
import { bindAccepted } from "./unit-index.js";
import type { AcceptedUnitOutput } from "./types.js";

const OUT_OF_BAND_MARKER = "<reallive.kidoku ";
// SOH (U+0001) — the patchback interior-quote placeholder; built from a code
// point so no raw control char is embedded in source.
const INTERIOR_QUOTE_PLACEHOLDER = String.fromCharCode(1);
const TERMINAL_PUNCTUATION = /[.!?…。！？」』）)\]】]\s*$/u;
const PUNCTUATED_SURFACES = new Set(["dialogue", "narration", "choice_label"]);

/** True iff every `<>`/`[]` pair is balanced with no stray closer. */
function bracketsBalanced(text: string): { ok: true } | { ok: false; detail: string } {
  const pairs: ReadonlyArray<readonly [string, string, string]> = [
    ["<", ">", "angle"],
    ["[", "]", "square"],
  ];
  for (const [open, close, label] of pairs) {
    let depth = 0;
    for (const ch of text) {
      if (ch === open) {
        depth += 1;
      } else if (ch === close) {
        depth -= 1;
        if (depth < 0) {
          return { ok: false, detail: `unbalanced ${label} bracket: stray '${close}'` };
        }
      }
    }
    if (depth !== 0) {
      return { ok: false, detail: `unbalanced ${label} bracket: ${depth} unclosed '${open}'` };
    }
  }
  return { ok: true };
}

export function markupControlsGate(
  snapshot: FactSnapshot,
  accepted: readonly AcceptedUnitOutput[],
): Defect[] {
  const bound = bindAccepted(snapshot, accepted);
  const defects: Defect[] = [];
  for (const { fact, accepted: output } of bound.values()) {
    const target = output.value.targetSkeleton;

    const balance = bracketsBalanced(target);
    if (!balance.ok) {
      defects.push(
        buildDefect({
          unitId: fact.factId,
          category: "markup",
          detail: `target markup is malformed: ${balance.detail}`,
          basisFactIds: [fact.factId],
        }),
      );
    }

    if (target.includes(OUT_OF_BAND_MARKER)) {
      defects.push(
        buildDefect({
          unitId: fact.factId,
          category: "control-sequence",
          detail: `target leaks the out-of-band control marker ${JSON.stringify(OUT_OF_BAND_MARKER)}`,
          basisFactIds: [fact.factId],
        }),
      );
    }
    if (target.includes(INTERIOR_QUOTE_PLACEHOLDER)) {
      defects.push(
        buildDefect({
          unitId: fact.factId,
          category: "control-sequence",
          detail: "target leaks an unresolved interior-quote placeholder (U+0001)",
          basisFactIds: [fact.factId],
        }),
      );
    }

    if (
      PUNCTUATED_SURFACES.has(fact.surfaceKind) &&
      target.trim().length > 0 &&
      !TERMINAL_PUNCTUATION.test(target)
    ) {
      defects.push(
        buildDefect({
          unitId: fact.factId,
          category: "punctuation",
          detail: `${fact.surfaceKind} target does not terminate with sentence punctuation or a closing quote/bracket`,
          basisFactIds: [fact.factId],
        }),
      );
    }
  }
  return defects;
}
