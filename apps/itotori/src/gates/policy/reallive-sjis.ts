// The RealLive Shift-JIS localization target policy.
//
// This is the ONE home of the RealLive encoding/layout/control rules that the
// shared release gates used to run unconditionally. A RealLive target must
// encode to Shift-JIS byte-for-byte or the patchback raises
// `patchback_target_encode_failure` and the scene fails to patch; a translated
// line that exceeds the engine text box overflows at runtime; the runtime
// Textout kidoku marker and the interior-quote placeholder must never leak; and
// the decoded-TextLine observation channel is Shift-JIS lead-byte gated, so it
// cannot observe an ASCII-leading English line — the target is observed through
// render/OCR only. All of that behavior is preserved here, re-homed behind the
// policy seam rather than hard-coded into the shared gate path.

import {
  listSjisEncodableCodepointsForAudit,
  stripOutOfBandControlMarkup,
} from "../../localization/patchback-safety.js";
import type { BoxLimit } from "../types.js";

import type {
  EncodingViolation,
  LocalizationTargetPolicy,
  LocalizationTargetPolicyId,
  PolicyBoxLimits,
} from "./types.js";

export const REALLIVE_SJIS_POLICY_ID =
  "itotori.localization-target-policy.reallive-sjis.v1" as LocalizationTargetPolicyId;

/** The RealLive extractor adapter whose bridges this policy governs. */
export const REALLIVE_SJIS_ADAPTER_ID = "kaifuu-reallive-bridge";

const SJIS_ENCODABLE: ReadonlySet<number> = new Set(listSjisEncodableCodepointsForAudit());

/** Tab / newline / carriage return are the only C0 controls a target may carry. */
function isUnsupportedControlCode(cp: number): boolean {
  return (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || (cp >= 0x7f && cp <= 0x9f);
}

function codePointLabel(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** The first codepoint in `text` that cannot survive the Shift-JIS patchback,
 * or null. Uses the AUTHORITATIVE encodable set derived from a real Shift-JIS
 * codec (reused, not re-derived, from the patchback-safety module). */
export function firstNonSjisCodePoint(text: string): EncodingViolation | null {
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

/** Conservative default per-surface byte budgets (Shift-JIS bytes). */
const REALLIVE_BOX_LIMITS: PolicyBoxLimits = {
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

/** The runtime Textout kidoku marker (space-terminated). */
const OUT_OF_BAND_MARKER = "<reallive.kidoku ";
/** SOH (U+0001) — the patchback interior-quote placeholder; built from a code
 * point so no raw control char is embedded in source. */
const INTERIOR_QUOTE_PLACEHOLDER = String.fromCharCode(1);

/** The RealLive Shift-JIS localization target policy. */
export const realliveSjisPolicy: LocalizationTargetPolicy = {
  policyId: REALLIVE_SJIS_POLICY_ID,
  adapterId: REALLIVE_SJIS_ADAPTER_ID,
  policyVersion: "1",
  codec: "shift-jis",
  firstDisallowedCodePoint: firstNonSjisCodePoint,
  measureBytes: sjisByteLength,
  boxLimits: REALLIVE_BOX_LIMITS,
  controlMarkers: [OUT_OF_BAND_MARKER, INTERIOR_QUOTE_PLACEHOLDER],
  normalizeVisibleText: stripOutOfBandControlMarkup,
  choiceMustBeSingleLine: true,
  // Shift-JIS lead-byte gated: an ASCII-leading English target is observable
  // ONLY through the render/OCR frame, never the decoded-TextLine channel.
  runtimeEvidenceChannels: ["render-ocr"],
};

export { REALLIVE_BOX_LIMITS };
export type { BoxLimit };
