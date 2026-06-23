import { tokenEstimatorIdV1 } from "./shapes.js";

/**
 * Per-unit JSON-frame overhead. Covers the wrapper the drafting agent's
 * prompt template uses (id, sourceText, protectedSpans, etc.).
 */
export const perUnitFrameOverheadTokens = 8;

/**
 * Default fallback per-batch system-prompt overhead. Profiles can override.
 */
export const defaultPromptOverheadTokens = 2000;

const cjkBlockRanges: Array<[number, number]> = [
  [0x3040, 0x309f], // Hiragana
  [0x30a0, 0x30ff], // Katakana
  [0x31f0, 0x31ff], // Katakana Phonetic Extensions
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0x3400, 0x4dbf], // CJK Extension A
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xff00, 0xffef], // Halfwidth/Fullwidth Forms
];

/** True if the code point is in any of the CJK Unicode ranges we account for. */
function isCjkCodePoint(codePoint: number): boolean {
  for (const [start, end] of cjkBlockRanges) {
    if (codePoint >= start && codePoint <= end) {
      return true;
    }
  }
  return false;
}

/** Fraction of characters in the string that fall in a CJK block. */
export function cjkFraction(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  let cjk = 0;
  let total = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    total += 1;
    if (isCjkCodePoint(codePoint)) {
      cjk += 1;
    }
  }
  if (total === 0) {
    return 0;
  }
  return cjk / total;
}

/**
 * Deterministic token estimate. The constants are empirical heuristics; the
 * exact values are pinned by `tokenEstimatorId` so we can change them in a
 * versioned, auditable way. CJK-heavy text is estimated at ~2 chars/token
 * and Latin-script text at ~4 chars/token.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const charCount = [...text].length;
  const cjk = cjkFraction(text);
  // Weighted blend: cjk fraction at 0.5 chars/token (i.e. ceil(chars / 2)),
  // remaining at 0.25 (ceil(chars / 4)).
  const cjkChars = cjk * charCount;
  const latinChars = charCount - cjkChars;
  return Math.max(1, Math.ceil(cjkChars / 2 + latinChars / 4));
}

export const tokenEstimatorId = tokenEstimatorIdV1;
