// The deterministic culture / wordplay / dialect / honorific candidate surface
// the Cultural Adaptation Analyst reasons over — and the byte-derived guards
// that refuse a flag the source bytes never carried.
//
// The analyst does NOT fan out over every line. It reasons ONLY over the units a
// MECHANICAL pre-pass flags: a unit whose decoded source text carries a fixed
// honorific / dialect / cultural marker, or whose decode carries a ruby
// (furigana) annotation span — the deterministic wordplay signal. The marker
// tables and the ruby-span rule are fixed and literal, so two scans over the
// same bytes flag exactly the same set. Everything a flag is allowed to treat as
// fact — the matched marker substrings, the source unit key, the unit's fact id
// — is copied VERBATIM from the read model's decoded bundle. A flag that names a
// marker the unit's source text never contains, or a wordplay flag on a unit
// with no ruby span, is not a new fact: it is a lie the guard rejects. The
// analyst may author only communicative function and bounded options over this
// fixed set — never a replacement translation.

import type { BridgeSpanV02, LocalizationUnitV02 } from "@itotori/localization-bridge-schema";

import type { WikiObject } from "../../contracts/index.js";
import type { FactSnapshot } from "../../prepass/index.js";
import type { ReadModel } from "../../read-tools/index.js";

/** The narrowed source adaptation-note object the analyst emits. */
export type AdaptationNoteObject = Extract<WikiObject, { kind: "adaptation-note" }>;

/** The four aspects the analyst is cast to reason over. Every flagged unit
 * carries at least one; the set is derived mechanically, never by a model. */
export type AdaptationCategory = "culture" | "dialect" | "honorific" | "wordplay";

/** The fixed, literal honorific markers whose presence flags a unit. Suffixes
 * and address terms whose communicative weight rarely survives a naive gloss. */
const HONORIFIC_MARKERS: readonly string[] = [
  "さん",
  "さま",
  "様",
  "ちゃん",
  "くん",
  "君",
  "せんぱい",
  "先輩",
  "せんせい",
  "先生",
  "どの",
  "殿",
  "たん",
];

/** The fixed, literal regional-dialect markers whose presence flags a unit.
 * Distinctive copulas / sentence-final particles, not pan-dialectal fragments. */
const DIALECT_MARKERS: readonly string[] = [
  "やねん",
  "どすえ",
  "じゃけぇ",
  "ばってん",
  "なんしとーと",
  "だっぺ",
  "ずら",
  "へんで",
];

/** The fixed, literal cultural-reference markers whose presence flags a unit.
 * Concrete customs / objects that carry setting-specific meaning. */
const CULTURE_MARKERS: readonly string[] = [
  "お盆",
  "花見",
  "正月",
  "こたつ",
  "浴衣",
  "初詣",
  "文化祭",
  "お年玉",
  "畳",
  "絵馬",
];

/** The decode span kind that signals wordplay: a ruby (furigana) annotation is
 * a reading gloss the source author attached, frequently a pun or double meaning
 * the surface form alone does not carry. */
const RUBY_SPAN_KIND = "ruby_annotation";

/** One unit the deterministic pre-pass flagged for cultural adaptation, carrying
 * its BYTE-DERIVED evidence: the matched marker substrings and whether the decode
 * carries a ruby span — none of which a model may alter. */
export interface FlaggedAdaptationCandidate {
  /** The flagged unit's snapshot fact id — a note MUST map to this unit. */
  readonly unitFactId: string;
  /** The decode's source unit key (stable, human-readable anchor). */
  readonly sourceUnitKey: string;
  /** The bridge unit id whose decoded source text was scanned. */
  readonly bridgeUnitId: string;
  /** The aspects flagged for this unit, in stable order (≥1). */
  readonly categories: readonly AdaptationCategory[];
  /** The verbatim marker substrings found in the source text, in stable order. */
  readonly markers: readonly string[];
  /** Whether the decode carries a ruby (furigana) wordplay span. */
  readonly hasRubyWordplay: boolean;
  /** The decoded source line the flag was derived from (byte-derived fact). */
  readonly sourceText: string;
  /** The unit's deterministic play-order position. */
  readonly playOrderIndex: number;
}

/** Each distinct way a flag or a note fails the byte-derived / function-and-
 * options contract. Every code maps to a rejected lie; the proof falsifies each
 * one independently. */
export type AdaptationFailure =
  | "not-a-candidate"
  | "off-unit"
  | "marker-not-in-source"
  | "wordplay-without-ruby"
  | "empty-flag"
  | "target-language-note"
  | "missing-bounded-options"
  | "replacement-not-function";

/** A loud, typed rejection: a fabricated flag or a replacement-translation note
 * is refused here rather than admitted. */
export class AdaptationEvidenceError extends Error {
  constructor(
    readonly failure: AdaptationFailure,
    readonly unitFactId: string,
    detail: string,
  ) {
    super(`adaptation ${failure} for ${unitFactId}: ${detail}`);
    this.name = "AdaptationEvidenceError";
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The verbatim markers from a fixed table that occur as substrings of the text,
 * de-duplicated and in stable order — a purely mechanical substring match. */
function matchedMarkers(text: string, table: readonly string[]): string[] {
  const found = new Set<string>();
  for (const marker of table) {
    if (text.includes(marker)) found.add(marker);
  }
  return [...found].sort(compareCodeUnits);
}

function hasRubySpan(spans: readonly BridgeSpanV02[]): boolean {
  return spans.some((span) => span.spanKind === RUBY_SPAN_KIND);
}

/** Classify one decoded unit deterministically. Returns the flagged categories +
 * verbatim markers, or `null` when the unit carries no adaptation signal. */
function classifyUnit(
  unit: LocalizationUnitV02,
): { categories: AdaptationCategory[]; markers: string[]; hasRuby: boolean } | null {
  const honorific = matchedMarkers(unit.sourceText, HONORIFIC_MARKERS);
  const dialect = matchedMarkers(unit.sourceText, DIALECT_MARKERS);
  const culture = matchedMarkers(unit.sourceText, CULTURE_MARKERS);
  const hasRuby = hasRubySpan(unit.spans);

  const categories: AdaptationCategory[] = [];
  if (culture.length > 0) categories.push("culture");
  if (dialect.length > 0) categories.push("dialect");
  if (honorific.length > 0) categories.push("honorific");
  if (hasRuby) categories.push("wordplay");
  if (categories.length === 0) return null;

  const markers = [...new Set([...culture, ...dialect, ...honorific])].sort(compareCodeUnits);
  return { categories, markers, hasRuby };
}

/**
 * Select ONLY the units the deterministic pre-pass flags for cultural
 * adaptation, in stable fact-id order. A unit with no marker and no ruby span is
 * deliberately absent — the analyst never sees, and so can never fan out over, an
 * unflagged line. Each returned candidate carries the exact byte-derived evidence
 * from the read model's decoded bundle; a model contributes nothing to it.
 */
export function flaggedAdaptationCandidates(
  model: Pick<ReadModel, "factSnapshot" | "bundleUnits">,
): FlaggedAdaptationCandidate[] {
  const candidates: FlaggedAdaptationCandidate[] = [];
  for (const fact of model.factSnapshot.orderedUnits) {
    const unit = model.bundleUnits.get(fact.bridgeUnitId);
    if (!unit) continue;
    const classified = classifyUnit(unit);
    if (!classified) continue;
    candidates.push({
      unitFactId: fact.factId,
      sourceUnitKey: fact.sourceUnitKey,
      bridgeUnitId: fact.bridgeUnitId,
      categories: classified.categories,
      markers: classified.markers,
      hasRubyWordplay: classified.hasRuby,
      sourceText: unit.sourceText,
      playOrderIndex: fact.playReveal.playOrderIndex,
    });
  }
  return candidates.sort((a, b) => compareCodeUnits(a.unitFactId, b.unitFactId));
}

/** Whether a unit is one the pre-pass flagged — the only units the analyst is
 * permitted to author a note for. */
export function isFlaggedUnit(
  model: Pick<ReadModel, "factSnapshot" | "bundleUnits">,
  unitFactId: string,
): boolean {
  return flaggedAdaptationCandidates(model).some((c) => c.unitFactId === unitFactId);
}

/**
 * Reject a candidate whose evidence is not byte-derived. Every marker must occur
 * verbatim in the unit's decoded source text, a wordplay flag must be backed by a
 * real ruby span, and the flag must carry ≥1 category — so a hand-built or
 * tampered candidate cannot smuggle a marker the bytes never contained.
 */
export function assertFlagByteDerived(
  candidate: FlaggedAdaptationCandidate,
  model: Pick<ReadModel, "bundleUnits">,
): void {
  if (candidate.categories.length === 0) {
    throw new AdaptationEvidenceError(
      "empty-flag",
      candidate.unitFactId,
      "a flagged candidate must carry at least one category",
    );
  }
  const unit = model.bundleUnits.get(candidate.bridgeUnitId);
  if (!unit) {
    throw new AdaptationEvidenceError(
      "not-a-candidate",
      candidate.unitFactId,
      `no decoded bundle unit for ${candidate.bridgeUnitId}`,
    );
  }
  for (const marker of candidate.markers) {
    if (!unit.sourceText.includes(marker)) {
      throw new AdaptationEvidenceError(
        "marker-not-in-source",
        candidate.unitFactId,
        `marker ${marker} is not a substring of the decoded source text`,
      );
    }
  }
  if (candidate.categories.includes("wordplay") && !hasRubySpan(unit.spans)) {
    throw new AdaptationEvidenceError(
      "wordplay-without-ruby",
      candidate.unitFactId,
      "a wordplay flag requires a ruby annotation span in the decode",
    );
  }
}

/** Reject a note that does not map to the dispatched flagged unit. The note's
 * subject entity ref and its body subject id must both name the candidate's real
 * unit — a note about any other unit is refused. */
export function assertNoteMapsToFlaggedUnit(
  note: AdaptationNoteObject,
  candidate: FlaggedAdaptationCandidate,
): void {
  if (note.subject.kind !== "unit" || note.subject.id !== candidate.unitFactId) {
    throw new AdaptationEvidenceError(
      "off-unit",
      candidate.unitFactId,
      `note subject ${note.subject.kind}:${note.subject.id} is not the dispatched unit`,
    );
  }
  if (note.body.subjectId !== candidate.unitFactId) {
    throw new AdaptationEvidenceError(
      "off-unit",
      candidate.unitFactId,
      `note body subject ${note.body.subjectId} is not the dispatched unit`,
    );
  }
}

/**
 * Reject a note that is a replacement translation rather than an analysis. The
 * note must be authored in the SOURCE language (a target-language object is a
 * rendering, not an adaptation note) and must offer bounded options — a
 * communicative function plus ≥1 strategy option, never a single ad-hoc target
 * form. The body schema carries no replacement-text field; this refuses the two
 * remaining ways a model could smuggle one in.
 */
export function assertNoteIsFunctionAndOptions(
  note: AdaptationNoteObject,
  sourceLanguage: string,
): void {
  if (note.lang !== sourceLanguage) {
    throw new AdaptationEvidenceError(
      "target-language-note",
      note.body.subjectId,
      `note must be authored in ${sourceLanguage}, not ${note.lang}`,
    );
  }
  if (note.body.communicativeFunction.trim().length === 0) {
    throw new AdaptationEvidenceError(
      "replacement-not-function",
      note.body.subjectId,
      "a note must describe the communicative function",
    );
  }
  if (note.body.boundedOptions.length === 0) {
    throw new AdaptationEvidenceError(
      "missing-bounded-options",
      note.body.subjectId,
      "a note must offer bounded options, never a single replacement",
    );
  }
  for (const option of note.body.boundedOptions) {
    if (option.tradeoffs.length === 0) {
      throw new AdaptationEvidenceError(
        "replacement-not-function",
        note.body.subjectId,
        `option ${option.optionId} must state its tradeoffs, not stand as a bare replacement`,
      );
    }
  }
}

/** The byte-derived evidence surfaced authoritatively on the result so a
 * downstream consumer reads the pre-pass's flag, never the model's. */
export function flagEvidence(candidate: FlaggedAdaptationCandidate): {
  readonly unitFactId: string;
  readonly categories: readonly AdaptationCategory[];
  readonly markers: readonly string[];
  readonly hasRubyWordplay: boolean;
} {
  return {
    unitFactId: candidate.unitFactId,
    categories: candidate.categories,
    markers: candidate.markers,
    hasRubyWordplay: candidate.hasRubyWordplay,
  };
}

/** A thin alias so downstream can name the fact family without reaching into the
 * prepass module for the whole snapshot type. */
export type AdaptationFactSnapshot = Pick<FactSnapshot, "orderedUnits">;
