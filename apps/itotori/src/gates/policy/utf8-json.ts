// A UTF-8 JSON localization target policy.
//
// The generic policy for an adapter whose patch target is UTF-8 text (e.g. a
// JSON bundle). UTF-8 represents every Unicode scalar value, so the encoding
// gate rejects only the unsupported C0/C1 control codes that would corrupt any
// text stream — an emoji, a full-width glyph, or an accented Latin letter that
// the RealLive Shift-JIS policy must reject passes HONESTLY here. Layout budgets
// are measured in UTF-8 bytes; the decoded runtime channel can carry an
// ASCII-leading target, so it is a trustworthy observation channel.

import type {
  EncodingViolation,
  LocalizationTargetPolicy,
  LocalizationTargetPolicyId,
  PolicyBoxLimits,
} from "./types.js";

export const UTF8_JSON_POLICY_ID =
  "itotori.localization-target-policy.utf8-json.v1" as LocalizationTargetPolicyId;

/** The generic UTF-8 JSON bundle adapter this policy governs. */
export const UTF8_JSON_ADAPTER_ID = "utf8-json-bundle";

const UTF8_ENCODER = new TextEncoder();

/** Tab / newline / carriage return are the only C0 controls a target may carry;
 * a raw C0/C1 control code corrupts a text stream in any encoding. */
function isUnsupportedControlCode(cp: number): boolean {
  return (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || (cp >= 0x7f && cp <= 0x9f);
}

function codePointLabel(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** The first codepoint UTF-8 cannot carry. UTF-8 represents every Unicode scalar
 * value, so this only rejects unsupported control codes. */
function firstDisallowedUtf8CodePoint(text: string): EncodingViolation | null {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isUnsupportedControlCode(cp)) {
      return { cp, label: codePointLabel(cp), reason: "unsupported control code" };
    }
  }
  return null;
}

/** Deterministic UTF-8 byte length — the length the JSON patch actually writes. */
function utf8ByteLength(text: string): number {
  return UTF8_ENCODER.encode(text).length;
}

/** Per-surface UTF-8 byte budgets. UTF-8 encodes CJK in 3 bytes vs Shift-JIS 2,
 * so the byte budgets are proportionally larger for the same visual box. */
const UTF8_BOX_LIMITS: PolicyBoxLimits = {
  dialogue: { maxBytes: 480, maxLineBytes: 162 },
  narration: { maxBytes: 480, maxLineBytes: 162 },
  speaker_name: { maxBytes: 96, maxLineBytes: 96 },
  choice_label: { maxBytes: 144, maxLineBytes: 144 },
  ui_label: { maxBytes: 144, maxLineBytes: 144 },
  tutorial_text: { maxBytes: 360, maxLineBytes: 162 },
  database_entry: { maxBytes: 480, maxLineBytes: 162 },
  song_title: { maxBytes: 192, maxLineBytes: 192 },
  image_text: { maxBytes: 192, maxLineBytes: 192 },
  metadata_text: { maxBytes: 480, maxLineBytes: 162 },
};

/** A UTF-8 JSON localization target policy. */
export const utf8JsonPolicy: LocalizationTargetPolicy = {
  policyId: UTF8_JSON_POLICY_ID,
  adapterId: UTF8_JSON_ADAPTER_ID,
  policyVersion: "1",
  codec: "utf-8",
  firstDisallowedCodePoint: firstDisallowedUtf8CodePoint,
  measureBytes: utf8ByteLength,
  boxLimits: UTF8_BOX_LIMITS,
  // No engine-specific out-of-band control markers for a plain UTF-8 target.
  controlMarkers: [],
  choiceMustBeSingleLine: true,
  // An ASCII-leading UTF-8 target is observable through the decoded channel.
  runtimeEvidenceChannels: ["decoded-textline", "render-ocr"],
};
