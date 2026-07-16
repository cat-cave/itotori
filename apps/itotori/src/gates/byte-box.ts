// Gate: byte / box length limits (`byte-box`, category `byte-limit`).
//
// A translated line that exceeds the engine text-box budget overflows or
// truncates at runtime. This gate measures the accepted target's Shift-JIS byte
// length (the encoding the patchback writes) against a per-surface budget and,
// where a per-line budget is set, each wrapped line. The surface kind is a
// snapshot fact, so the applicable budget is chosen deterministically. Targets
// that are not Shift-JIS-valid are the encoding gate's concern; here a
// non-encodable codepoint is conservatively counted as two bytes.

import type { SurfaceKindV02 } from "@itotori/localization-bridge-schema";
import type { Defect } from "../contracts/index.js";
import type { FactSnapshot } from "../prepass/index.js";

import { buildDefect } from "./defect.js";
import { bindAccepted } from "./unit-index.js";
import type { BoxLimit, BoxLimitPolicy, AcceptedUnitOutput } from "./types.js";

/** Conservative default per-surface byte budgets (Shift-JIS bytes). */
export const DEFAULT_BOX_LIMITS: Readonly<Record<SurfaceKindV02, BoxLimit>> = {
  dialogue: { maxBytes: 320, maxLineBytes: 108 },
  narration: { maxBytes: 320, maxLineBytes: 108 },
  speaker_name: { maxBytes: 64, maxLineBytes: 64 },
  choice_label: { maxBytes: 96, maxLineBytes: 96 },
  ui_label: { maxBytes: 96, maxLineBytes: 96 },
  tutorial_text: { maxBytes: 240, maxLineBytes: 108 },
  database_entry: { maxBytes: 320, maxLineBytes: 108 },
  song_title: { maxBytes: 128, maxLineBytes: 128 },
  image_text: { maxBytes: 128, maxLineBytes: 128 },
  metadata_text: { maxBytes: 320, maxLineBytes: 108 },
};

function isSingleByte(cp: number): boolean {
  return cp <= 0x7f || (cp >= 0xff61 && cp <= 0xff9f) || cp === 0xa5 || cp === 0x203e;
}

/** Deterministic Shift-JIS byte length; a non-encodable codepoint counts as 2. */
export function sjisByteLength(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    bytes += isSingleByte(ch.codePointAt(0) ?? 0) ? 1 : 2;
  }
  return bytes;
}

export function byteBoxGate(
  snapshot: FactSnapshot,
  accepted: readonly AcceptedUnitOutput[],
  policy: BoxLimitPolicy = DEFAULT_BOX_LIMITS,
): Defect[] {
  const bound = bindAccepted(snapshot, accepted);
  const defects: Defect[] = [];
  for (const { fact, accepted: output } of bound.values()) {
    const limit = policy[fact.surfaceKind] ?? DEFAULT_BOX_LIMITS[fact.surfaceKind];
    if (limit === undefined) {
      continue;
    }
    const target = output.value.targetSkeleton;
    const totalBytes = sjisByteLength(target);
    if (totalBytes > limit.maxBytes) {
      defects.push(
        buildDefect({
          unitId: fact.factId,
          category: "byte-limit",
          detail: `target is ${totalBytes} Shift-JIS bytes, over the ${limit.maxBytes}-byte ${fact.surfaceKind} budget`,
          basisFactIds: [fact.factId],
        }),
      );
    }
    if (limit.maxLineBytes !== undefined) {
      const lines = target.split(/\r\n|\n|\r/u);
      for (const [index, line] of lines.entries()) {
        const lineBytes = sjisByteLength(line);
        if (lineBytes > limit.maxLineBytes) {
          defects.push(
            buildDefect({
              unitId: fact.factId,
              category: "byte-limit",
              detail: `target line ${index + 1} is ${lineBytes} Shift-JIS bytes, over the ${limit.maxLineBytes}-byte line budget`,
              basisFactIds: [fact.factId],
            }),
          );
        }
      }
    }
  }
  return defects;
}
