// Gate: markup balance + control-sequence integrity + punctuation
// (`markup-controls`; categories `markup`, `control-sequence`, `punctuation`).
//
//   * markup           — angle-bracket and square-bracket tags in the target
//                        must be balanced (no unclosed / stray bracket).
//   * control-sequence — an out-of-band control marker leak. The markers are
//                        SELECTED from the localization target policy (e.g. an
//                        engine's runtime Textout marker + interior-quote
//                        placeholder); a policy with no markers skips this check.
//   * punctuation      — a spoken/narrated target must terminate with sentence
//                        punctuation or a closing quote/bracket (a truncated
//                        line is a defect). Minor severity — never a hard fact.
// Bracket balance + punctuation are UNIVERSAL; only the control markers vary.

import type { Defect } from "../contracts/index.js";
import type { FactSnapshot } from "../prepass/index.js";

import { buildDefect } from "./defect.js";
import type { LocalizationTargetPolicy } from "./policy/types.js";
import { bindAccepted } from "./unit-index.js";
import type { AcceptedUnitOutput } from "./types.js";

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

/** A stable, human-readable label for a control marker (raw control chars are
 * shown as their code point so no raw control char is embedded in a message). */
function markerLabel(marker: string): string {
  if (marker.length === 1 && marker.codePointAt(0)! < 0x20) {
    return `U+${marker.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return JSON.stringify(marker);
}

export function markupControlsGate(
  snapshot: FactSnapshot,
  accepted: readonly AcceptedUnitOutput[],
  policy: LocalizationTargetPolicy,
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

    for (const marker of policy.controlMarkers) {
      if (marker.length > 0 && target.includes(marker)) {
        defects.push(
          buildDefect({
            unitId: fact.factId,
            category: "control-sequence",
            detail: `target leaks the out-of-band control marker ${markerLabel(marker)}`,
            basisFactIds: [fact.factId],
          }),
        );
      }
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
