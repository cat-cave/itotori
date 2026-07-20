// Gate: byte / box length limits (`byte-box`, category `byte-limit`).
//
// A translated line that exceeds the engine text-box budget overflows or
// truncates at runtime. This gate measures the accepted target's byte length in
// the SELECTED policy's codec (the encoding the patchback writes) against a
// per-surface budget and, where a per-line budget is set, each wrapped line. The
// surface kind is a snapshot fact, so the applicable budget is chosen
// deterministically. Both the byte measurement and the budgets come from the
// policy; an optional caller override may tighten a specific surface's budget.

import type { Defect } from "../contracts/index.js";
import type { FactSnapshot } from "../prepass/index.js";

import { buildDefect } from "./defect.js";
import type { LocalizationTargetPolicy } from "./policy/types.js";
import { bindAccepted } from "./unit-index.js";
import type { BoxLimit, BoxLimitPolicy, AcceptedUnitOutput } from "./types.js";

export function byteBoxGate(
  snapshot: FactSnapshot,
  accepted: readonly AcceptedUnitOutput[],
  policy: LocalizationTargetPolicy,
  overrides: BoxLimitPolicy = {},
): Defect[] {
  const bound = bindAccepted(snapshot, accepted);
  const defects: Defect[] = [];
  for (const { fact, accepted: output } of bound.values()) {
    const limit: BoxLimit | undefined =
      overrides[fact.surfaceKind] ?? policy.boxLimits[fact.surfaceKind];
    if (limit === undefined) {
      continue;
    }
    const target = output.value.targetSkeleton;
    const totalBytes = policy.measureBytes(target);
    if (totalBytes > limit.maxBytes) {
      defects.push(
        buildDefect({
          unitId: fact.factId,
          category: "byte-limit",
          detail: `target is ${totalBytes} ${policy.codec} bytes, over the ${limit.maxBytes}-byte ${fact.surfaceKind} budget`,
          basisFactIds: [fact.factId],
        }),
      );
    }
    if (limit.maxLineBytes !== undefined) {
      const lines = target.split(/\r\n|\n|\r/u);
      for (const [index, line] of lines.entries()) {
        const lineBytes = policy.measureBytes(line);
        if (lineBytes > limit.maxLineBytes) {
          defects.push(
            buildDefect({
              unitId: fact.factId,
              category: "byte-limit",
              detail: `target line ${index + 1} is ${lineBytes} ${policy.codec} bytes, over the ${limit.maxLineBytes}-byte line budget`,
              basisFactIds: [fact.factId],
            }),
          );
        }
      }
    }
  }
  return defects;
}
