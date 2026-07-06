// benchmark-deterministic-metric-suite (§3) — pure deterministic text helpers.
//
// Every helper here is a total function of its string input: same input →
// same output, no locale/clock/random dependence. These back the wrap,
// residue, voice-fingerprint, and back-translation-tripwire metrics.

/** Residual source-script scan: Hiragana, Katakana, and CJK unified ideographs. */
const JP_SCRIPT_PATTERN = /[぀-ヿ㐀-䶿一-鿿]/gu;

/** Count residual source-script codepoints in a string. */
export function countResidualSourceScript(text: string): number {
  return (text.match(JP_SCRIPT_PATTERN) ?? []).length;
}

/**
 * Greedy word-wrap into lines no wider than `columns` monospace cells.
 * A token longer than `columns` is placed on its own line and reported as an
 * unbreakable overrun by {@link wrapOverrun}. Deterministic.
 */
export function wrapLines(text: string, columns: number): string[] {
  const words = text.split(/\s+/u).filter((word) => word.length > 0);
  if (words.length === 0) {
    return [];
  }
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length <= columns) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  lines.push(current);
  return lines;
}

/** Wrap result: line count and the worst per-line overrun (cells past `columns`). */
export type WrapFit = {
  lineCount: number;
  worstOverrun: number;
};

export function wrapOverrun(text: string, columns: number): WrapFit {
  const lines = wrapLines(text, columns);
  let worstOverrun = 0;
  for (const line of lines) {
    const overrun = line.length - columns;
    if (overrun > worstOverrun) {
      worstOverrun = overrun;
    }
  }
  return { lineCount: lines.length, worstOverrun };
}

/** Contraction and politeness markers used by the voice fingerprint. */
const CONTRACTION_PATTERN = /\b\w+n['’]t\b|['’](?:re|s|ll|ve|m|d)\b/giu;
const POLITENESS_MARKERS = [
  "please",
  "thank you",
  "thanks",
  "would you",
  "could you",
  "may i",
  "excuse me",
  "pardon",
  "sir",
  "madam",
  "ma'am",
  "if you don't mind",
] as const;

/** A deterministic, reference-free style fingerprint of one line of prose. */
export type StyleFeatures = {
  meanSentenceLength: number;
  contractionRate: number;
  politenessRate: number;
};

export function styleFeatures(text: string): StyleFeatures {
  const sentences = text.split(/[.!?。！？]+/u).filter((s) => s.trim().length > 0);
  const sentenceCount = Math.max(1, sentences.length);
  const words = text.split(/\s+/u).filter((word) => word.length > 0);
  const wordCount = Math.max(1, words.length);
  const contractionCount = (text.match(CONTRACTION_PATTERN) ?? []).length;
  const lowered = text.toLowerCase();
  let politenessCount = 0;
  for (const marker of POLITENESS_MARKERS) {
    politenessCount += countOccurrences(lowered, marker);
  }
  return {
    meanSentenceLength: words.length / sentenceCount,
    contractionRate: contractionCount / wordCount,
    politenessRate: politenessCount / sentenceCount,
  };
}

/** Count non-overlapping occurrences of `needle` in `haystack` (literal). */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** Population mean of a non-empty numeric list. */
export function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Population standard deviation of a non-empty numeric list. */
export function stddev(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const m = mean(values);
  const variance = mean(values.map((value) => (value - m) ** 2));
  return Math.sqrt(variance);
}

/**
 * Coefficient of variation (stddev / mean): a scale-free spread measure so
 * short and long lines are comparable. Zero mean with zero spread → 0 (no
 * drift); zero mean with nonzero spread → the raw stddev (still comparable).
 */
export function coefficientOfVariation(values: number[]): number {
  const m = mean(values);
  const s = stddev(values);
  if (m === 0) {
    return s;
  }
  return s / Math.abs(m);
}

/** Multiset of adjacent character bigrams of a string (whitespace collapsed). */
function characterBigrams(text: string): Map<string, number> {
  const normalized = text.replace(/\s+/gu, "");
  const bigrams = new Map<string, number>();
  for (let i = 0; i + 1 < normalized.length; i += 1) {
    const bigram = normalized.slice(i, i + 2);
    bigrams.set(bigram, (bigrams.get(bigram) ?? 0) + 1);
  }
  return bigrams;
}

/**
 * Sørensen–Dice similarity over character-bigram multisets, in [0, 1].
 * Deterministic and language-agnostic — used only as the tripwire distance for
 * back-translation gross-meaning-loss detection, never as a quality score.
 */
export function characterBigramDice(a: string, b: string): number {
  const bigramsA = characterBigrams(a);
  const bigramsB = characterBigrams(b);
  let sizeA = 0;
  for (const count of bigramsA.values()) {
    sizeA += count;
  }
  let sizeB = 0;
  for (const count of bigramsB.values()) {
    sizeB += count;
  }
  if (sizeA === 0 && sizeB === 0) {
    return 1;
  }
  if (sizeA === 0 || sizeB === 0) {
    return 0;
  }
  let intersection = 0;
  for (const [bigram, countA] of bigramsA) {
    const countB = bigramsB.get(bigram);
    if (countB !== undefined) {
      intersection += Math.min(countA, countB);
    }
  }
  return (2 * intersection) / (sizeA + sizeB);
}
