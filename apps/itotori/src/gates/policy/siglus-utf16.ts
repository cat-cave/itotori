// Siglus UTF-16LE target policy. The profile is engine-wide: it has no
// title-specific vocabulary or cipher material.

import type {
  EncodingViolation,
  LocalizationTargetPolicy,
  LocalizationTargetPolicyId,
  PolicyBoxLimits,
} from "./types.js";

export const SIGLUS_UTF16_POLICY_ID =
  "itotori.localization-target-policy.siglus-utf16le.v1" as LocalizationTargetPolicyId;
/** The bridge extractor identity governed by this profile. */
export const SIGLUS_UTF16_ADAPTER_ID = "kaifuu-siglus";

function firstDisallowedUtf16CodePoint(text: string): EncodingViolation | null {
  for (const character of text) {
    const cp = character.codePointAt(0) ?? 0;
    if ((cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || (cp >= 0x7f && cp <= 0x9f)) {
      return {
        cp,
        label: `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`,
        reason: "unsupported control code",
      };
    }
  }
  return null;
}

/** UTF-16LE byte length for scalar text, including both units of a surrogate pair. */
function utf16LeByteLength(text: string): number {
  // UTF-16LE stores each JavaScript code unit in two bytes, so this includes a
  // surrogate pair as four bytes.
  return text.length * 2;
}

const SIGLUS_BOX_LIMITS: PolicyBoxLimits = {
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

export const siglusUtf16Policy: LocalizationTargetPolicy = {
  policyId: SIGLUS_UTF16_POLICY_ID,
  adapterId: SIGLUS_UTF16_ADAPTER_ID,
  policyVersion: "1",
  codec: "utf-16le",
  firstDisallowedCodePoint: firstDisallowedUtf16CodePoint,
  measureBytes: utf16LeByteLength,
  boxLimits: SIGLUS_BOX_LIMITS,
  controlMarkers: [],
  normalizeVisibleText: (text) => text,
  choiceMustBeSingleLine: true,
  runtimeEvidenceChannels: ["decoded-textline", "render-ocr"],
};
