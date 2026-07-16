// Gate: Shift-JIS / target-encoding validity (`shift-jis`, category `encoding`).
//
// A RealLive target must encode to Shift-JIS byte-for-byte or the patchback
// raises `patchback_target_encode_failure` and the scene fails to patch. This
// gate proves every accepted target codepoint is Shift-JIS-representable using
// the AUTHORITATIVE encodable set derived from a real Shift-JIS codec (reused,
// not re-derived, from the patchback-safety module), plus a rejection of the
// unsupported C0/C1 control codes that would corrupt the Textout stream. It
// never mutates the target — normalization is a drafting concern; this is a
// pass/defect fact.

import { listSjisEncodableCodepointsForAudit } from "../localization/patchback-safety.js";
import type { Defect } from "../contracts/index.js";
import type { FactSnapshot } from "../prepass/index.js";

import { buildDefect } from "./defect.js";
import { bindAccepted } from "./unit-index.js";
import type { AcceptedUnitOutput } from "./types.js";

const SJIS_ENCODABLE: ReadonlySet<number> = new Set(listSjisEncodableCodepointsForAudit());

/** Tab / newline / carriage return are the only C0 controls a target may carry. */
function isUnsupportedControlCode(cp: number): boolean {
  return (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || (cp >= 0x7f && cp <= 0x9f);
}

function codePointLabel(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** The first codepoint in `text` that cannot survive the Shift-JIS patchback,
 * or null. Exposed for the byte-box gate (which assumes SJIS-valid input). */
export function firstNonSjisCodePoint(
  text: string,
): { cp: number; label: string; reason: string } | null {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isUnsupportedControlCode(cp)) {
      return { cp, label: codePointLabel(cp), reason: "unsupported control code" };
    }
    if (!SJIS_ENCODABLE.has(cp)) {
      return { cp, label: codePointLabel(cp), reason: "not Shift-JIS-representable" };
    }
  }
  return null;
}

export function shiftJisGate(
  snapshot: FactSnapshot,
  accepted: readonly AcceptedUnitOutput[],
): Defect[] {
  const bound = bindAccepted(snapshot, accepted);
  const defects: Defect[] = [];
  for (const { fact, accepted: output } of bound.values()) {
    const offending = firstNonSjisCodePoint(output.value.targetSkeleton);
    if (offending !== null) {
      defects.push(
        buildDefect({
          unitId: fact.factId,
          category: "encoding",
          detail: `target contains ${offending.label} (${offending.reason})`,
          basisFactIds: [fact.factId],
          span: { surface: "target", text: offending.label },
        }),
      );
    }
  }
  return defects;
}
