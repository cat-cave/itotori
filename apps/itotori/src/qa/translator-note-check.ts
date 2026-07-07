// ITOTORI-QA-NO-TRANSLATOR-NOTES-INSTRUCTION — Deterministic translator-note
// detector.
//
// At-scale v2 found: 3130/3131 dialogue units were clean English; the 1
// exception (scene 2051 unit 2) was a fully-translated line where the LLM
// appended a parenthetical TRANSLATOR'S NOTE / meta-commentary in the
// target. The translation prompt + QA rubric now instruct no translator-notes
// in the target text. This module is the matching DETERMINISTIC QA check:
// it scans every draft for residual parenthetical translator-notes /
// meta-commentary and emits a `QaFinding` per match. Pattern matching is
// fully local — no LLM call — so a regression in the prompt instruction
// surfaces deterministically and the check is test-pinned.
//
// Scope of detection (intentionally narrow):
//   * Explicit translator-note markers inside parentheses —
//     `(TL note: ...)`, `(TL's note: ...)`, `(translator note: ...)`,
//     `(translator's note: ...)`, `(trans note: ...)`, etc. — case-insensitive.
//   * Meta-commentary markers — `(meta: ...)`, `(meta-note: ...)`,
//     `(meta-commentary: ...)` — case-insensitive.
//
// Deliberately NOT covered:
//   * Bare parenthetical `(note: ...)` — too noisy (in-dialog "side note"
//     would match); callers can extend `TRANSLATOR_NOTE_PATTERNS` if they
//     want a stricter mode.

import { createHash } from "node:crypto";
import type {
  QaFinding,
  QaFindingCategory,
  QaFindingSeverity,
  QaFindingSpan,
} from "@itotori/localization-bridge-schema";

/**
 * Default severity for translator-note findings. `major` is the right
 * semantic weight: the target text is unpublishable without the
 * parenthetical stripped, but it does not introduce glossary / terminology
 * / tone drift, so it is not `critical`. Callers wanting a different
 * severity (e.g. for a strict-gate) can post-process the findings.
 */
export const TRANSLATOR_NOTE_FINDING_SEVERITY: QaFindingSeverity = "major";

/**
 * `other` is the only category whose semantics admit "translator-note in
 * target text": none of the closed-enum categories (mistranslation, tone,
 * glossary-conflict, protected-span-violation, terminology-drift,
 * redaction, context-mismatch) describes a residual parenthetical
 * translator-note. The finding is emitted with `draftSpan` covering the
 * offending parenthetical so the remediation can target it precisely.
 */
export const TRANSLATOR_NOTE_FINDING_CATEGORY: QaFindingCategory = "other";

/**
 * Stable rule id attached to translator-note findings as the sole
 * `evidenceRef`. Lets downstream consumers filter translator-note findings
 * (e.g. "apply the QA gate, exclude translator-note findings from the
 * scored workflow since they're separately handled") without parsing the
 * rationale string.
 */
export const TRANSLATOR_NOTE_RULE_ID = "qa-check:translator-note-parenthetical" as const;

/**
 * A single translator-note match inside one draft. Coordinates use Unicode
 * code-unit offsets into the draft string (same model the QA finding
 * `draftSpan` uses) so callers can splice the text back if they need to.
 */
export type TranslatorNoteMatch = {
  /** Inclusive start offset (Unicode code units) of the opening `(`. */
  start: number;
  /** Exclusive end offset (Unicode code units) one past the closing `)`. */
  end: number;
  /** The full matched parenthetical, including the parentheses. */
  text: string;
};

/**
 * Single regex that captures EVERY parenthetical translator-note /
 * meta-commentary shape the spec (ITOTORI-QA-NO-TRANSLATOR-NOTES-INSTRUCTION)
 * calls out. Anchored to the parenthetical boundaries so the captured text
 * is the exact substring to flag. Case-insensitive (`i` flag) so
 * `(TL NOTE: ...)`, `(Translator's Note: ...)` all match.
 *
 * Pattern anatomy:
 *   \(\s*                       opening paren, optional whitespace
 *     (?:
 *       TL['\u2019]?s?\s+note   "TL note" / "TL's note" / "TL note"
 *       |
 *       translator['\u2019]?s?\s+note   "translator note" / "translator's note"
 *       |
 *       trans\.?\s+note        "trans note" / "trans. note"
 *       |
 *       meta[\s-]+(?:commentary|note|comment)   "meta-commentary" / "meta note"
 *     )
 *   (?:\s*[:\-—]\s*|\s+)        optional `:` / `-` / `—` separator, or just whitespace
 *   [^)]*                       any non-`)` chars (the body of the note)
 *   \)                          closing paren
 */
const TRANSLATOR_NOTE_PARENTHETICAL: RegExp =
  /\(\s*(?:TL['\u2019]?s?\s+note|translator['\u2019]?s?\s+note|trans\.?\s+note|meta[\s-]+(?:commentary|note|comment))(?:\s*[:\-—]\s*|\s+)[^)]*\)/gi;

/**
 * Public list of patterns the detector runs. Exposed for tests + advanced
 * consumers who want to extend detection (e.g. add a Japanese 訳注 marker
 * or a project-specific tag) without rewriting the check. Order is
 * immaterial — `findTranslatorNoteMatches` merges matches across the list
 * and dedupes overlapping spans.
 */
export const TRANSLATOR_NOTE_PATTERNS: ReadonlyArray<RegExp> = [TRANSLATOR_NOTE_PARENTHETICAL];

/**
 * Run every registered pattern over the draft text and return the union of
 * matches, sorted by start offset. Overlapping matches are merged — the
 * first-seen span wins and any later match starting before its end is
 * dropped. This keeps the finding stream clean: a draft with both a
 * `(TL note: ...)` and a `(meta-note: ...)` parenthetical nested inside
 * produces one merged finding, not two stacked on the same byte range.
 */
export function findTranslatorNoteMatches(draftText: string): TranslatorNoteMatch[] {
  if (typeof draftText !== "string" || draftText.length === 0) {
    return [];
  }
  const matches: TranslatorNoteMatch[] = [];
  for (const pattern of TRANSLATOR_NOTE_PATTERNS) {
    // Reset stateful regex state — the global flag persists `lastIndex`
    // across calls, so we re-create the regex per pattern iteration here.
    pattern.lastIndex = 0;
    const re = new RegExp(pattern.source, pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(draftText)) !== null) {
      if (m[0].length === 0) {
        // Defensive: a zero-width match would infinite-loop. Should not
        // happen because `[^)]*` is empty-allowed but `\)` then forces a
        // closing paren, so the minimum match length is `()`. Bail.
        re.lastIndex += 1;
        continue;
      }
      matches.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    }
  }
  if (matches.length <= 1) {
    return matches;
  }
  matches.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: TranslatorNoteMatch[] = [matches[0]!];
  for (let i = 1; i < matches.length; i += 1) {
    const last = merged[merged.length - 1]!;
    const cur = matches[i]!;
    if (cur.start < last.end) {
      // Overlap: drop the inner match. The first-seen span already covers
      // its text, so emitting both would double-flag the same bytes.
      continue;
    }
    merged.push(cur);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Finding synthesis
// ---------------------------------------------------------------------------

export type TranslatorNoteCheckUnit = {
  bridgeUnitId: string;
  draftText: string;
};

/**
 * Synthesize a deterministic UUID7-shaped finding id from the
 * (bridgeUnitId, occurrenceIndex) pair. The id MUST be stable across calls
 * with the same input so the scored-finding workflow can key its
 * `byBridgeUnit` map and tests can pin exact finding ids. The version
 * nibble is forced to `7` and the variant nibble to `8` so the output
 * passes `isUuid7`.
 */
function deterministicTranslatorNoteFindingId(
  bridgeUnitId: string,
  occurrenceIndex: number,
): string {
  const seed = `${bridgeUnitId}|translator-note|${occurrenceIndex}`;
  const hash = createHash("sha256").update(seed).digest("hex");
  const chars = hash.slice(0, 32);
  return [
    chars.slice(0, 8),
    chars.slice(8, 12),
    `7${chars.slice(13, 16)}`,
    `8${chars.slice(17, 20)}`,
    chars.slice(20, 32),
  ].join("-");
}

function buildFinding(
  bridgeUnitId: string,
  occurrenceIndex: number,
  span: TranslatorNoteMatch,
): QaFinding {
  const draftSpan: QaFindingSpan = { start: span.start, end: span.end };
  return {
    findingId: deterministicTranslatorNoteFindingId(bridgeUnitId, occurrenceIndex),
    bridgeUnitId,
    severity: TRANSLATOR_NOTE_FINDING_SEVERITY,
    category: TRANSLATOR_NOTE_FINDING_CATEGORY,
    draftSpan,
    evidenceRefs: [TRANSLATOR_NOTE_RULE_ID],
    recommendation:
      "Remove the parenthetical translator-note / meta-commentary from `draftText`. " +
      "The target line must contain only the target-language rendering of the source; " +
      "translator commentary belongs in `agentRationale`, never in the published text.",
    agentRationale:
      "Draft contains a parenthetical translator-note or meta-commentary " +
      `(${JSON.stringify(span.text)} at draftSpan [${span.start}, ${span.end}]). ` +
      "This violates the no-translator-notes instruction in the translation prompt + " +
      "QA rubric and must be stripped before publishing the target line.",
  };
}

/**
 * Run the translator-note check across every unit and return one
 * `QaFinding` per match (in the order they were discovered, sorted by
 * bridge unit input order). Units with a clean draft emit zero findings.
 *
 * The check is deterministic — same `units` array in, same `QaFinding[]`
 * out — so it is safe to use directly in tests and to fold into the
 * scored-finding workflow without special-casing.
 */
export function detectTranslatorNoteFindings(
  units: ReadonlyArray<TranslatorNoteCheckUnit>,
): QaFinding[] {
  const findings: QaFinding[] = [];
  for (const unit of units) {
    const matches = findTranslatorNoteMatches(unit.draftText);
    for (let i = 0; i < matches.length; i += 1) {
      findings.push(buildFinding(unit.bridgeUnitId, i, matches[i]!));
    }
  }
  return findings;
}
