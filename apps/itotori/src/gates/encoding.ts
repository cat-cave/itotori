// Gate: target-encoding validity (`encoding-policy`, category `encoding`).
//
// The accepted target must be representable in the SELECTED localization target
// policy's codec, or the patchback fails to write it. This gate is codec-agnostic:
// it asks the policy for the first codepoint its codec / control-grammar cannot
// carry. For the RealLive Shift-JIS policy that is any non-SJIS codepoint or an
// unsupported control code; for a UTF-8 policy it is only an unsupported control
// code. It never mutates the target — normalization is a drafting concern; this
// is a pass/defect fact.

import type { Defect } from "../contracts/index.js";
import type { FactSnapshot } from "../prepass/index.js";

import { buildDefect } from "./defect.js";
import type { LocalizationTargetPolicy } from "./policy/types.js";
import { bindAccepted } from "./unit-index.js";
import type { AcceptedUnitOutput } from "./types.js";

export function encodingGate(
  snapshot: FactSnapshot,
  accepted: readonly AcceptedUnitOutput[],
  policy: LocalizationTargetPolicy,
): Defect[] {
  const bound = bindAccepted(snapshot, accepted);
  const defects: Defect[] = [];
  for (const { fact, accepted: output } of bound.values()) {
    const offending = policy.firstDisallowedCodePoint(output.value.targetSkeleton);
    if (offending !== null) {
      defects.push(
        buildDefect({
          unitId: fact.factId,
          category: "encoding",
          detail: `target contains ${offending.label} (${offending.reason}) — not ${policy.codec}-representable`,
          basisFactIds: [fact.factId],
          span: { surface: "target", text: offending.label },
        }),
      );
    }
  }
  return defects;
}
