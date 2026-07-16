// The deterministic ambiguous-candidate surface the Terminology Analyst reasons
// over — and the byte-derived enumeration guard that ignores a model's lies.
//
// The analyst is handed the WHOLE-GAME term / alias / occurrence / conflict
// index the pre-pass materialized mechanically from decoded bytes. It does NOT
// reason over every term: it reasons ONLY over the genuinely AMBIGUOUS ones the
// index flags — a term whose policy records disagree on a ruling, or a source
// form claimed by two distinct term keys. Everything the analyst is allowed to
// treat as fact — the alias set, the occurrence count, the exact occurrence unit
// keys — is copied VERBATIM from that byte-derived index. A model that re-counts,
// re-enumerates the aliases, or cites a unit the term never occurs in is not a
// new fact: it is a lie the guard rejects. The analyst may author only meaning,
// register, source scope, and confidence over this fixed enumeration.

import type {
  FactSnapshot,
  GlossaryConflictFact,
  TerminologyOccurrenceFact,
} from "../../prepass/index.js";
import type { WikiObject } from "../../contracts/index.js";

/** The narrowed source term-ruling object the analyst emits. */
export type TermRulingObject = Extract<WikiObject, { kind: "term-ruling" }>;

/** One genuinely ambiguous term the deterministic index flagged, carrying its
 * BYTE-DERIVED enumeration: the alias set, the exact occurrence count, and the
 * exact occurrence unit keys — none of which the model may alter. */
export interface AmbiguousTermCandidate {
  readonly termKey: string;
  /** The deterministic policy label for the key (may be multi-valued in conflict). */
  readonly policyAction: string;
  /** Byte-derived source forms grouped under this key, in stable order. */
  readonly aliases: readonly string[];
  /** Byte-derived occurrence count — the mechanical substring hit count. */
  readonly occurrenceCount: number;
  /** Byte-derived occurrence unit keys — the exact units the forms hit. */
  readonly occurrenceUnitKeys: readonly string[];
  /** Why the index flagged this term as ambiguous (≥1 conflict). */
  readonly conflicts: readonly GlossaryConflictFact[];
}

/** Each distinct way a model output fails the byte-derived enumeration. Every
 * code maps to a rejected lie; the proof falsifies each one independently. */
export type TermEnumerationFailure =
  | "not-a-candidate"
  | "off-candidate"
  | "alias-enumeration-drift"
  | "unknown-source-form"
  | "ghost-occurrence";

/** A loud, typed rejection: a model that re-counts, re-enumerates, or cites a
 * unit the term never occurs in is refused here rather than admitted. */
export class TermEnumerationError extends Error {
  constructor(
    readonly failure: TermEnumerationFailure,
    readonly termKey: string,
    detail: string,
  ) {
    super(`terminology enumeration ${failure} for ${termKey}: ${detail}`);
    this.name = "TermEnumerationError";
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The term keys a single conflict names, resolved against the real term-key set
 * so a joined collision label ("a+b") expands to its true participants without
 * fragile parsing: a whole label that is itself a real key stays intact. */
function conflictParticipants(
  conflict: GlossaryConflictFact,
  termKeys: ReadonlySet<string>,
): readonly string[] {
  if (termKeys.has(conflict.termKey)) return [conflict.termKey];
  return conflict.termKey.split("+").filter((part) => termKeys.has(part));
}

/**
 * Select ONLY the ambiguous candidates from the whole-game index. A term with no
 * flagging conflict is deliberately absent — the analyst never sees, and so can
 * never rule on, an unambiguous term. Each returned candidate carries the exact
 * byte-derived enumeration from its terminology fact; the model contributes
 * nothing to it.
 */
export function ambiguousTermCandidates(
  index: Pick<FactSnapshot, "terminology" | "glossaryConflicts">,
): AmbiguousTermCandidate[] {
  const byKey = new Map<string, TerminologyOccurrenceFact>();
  for (const fact of index.terminology) byKey.set(fact.termKey, fact);
  const termKeys = new Set(byKey.keys());

  const conflictsByKey = new Map<string, GlossaryConflictFact[]>();
  for (const conflict of index.glossaryConflicts) {
    for (const key of conflictParticipants(conflict, termKeys)) {
      const bucket = conflictsByKey.get(key) ?? [];
      bucket.push(conflict);
      conflictsByKey.set(key, bucket);
    }
  }

  const candidates: AmbiguousTermCandidate[] = [];
  for (const [termKey, conflicts] of conflictsByKey) {
    const fact = byKey.get(termKey);
    if (!fact) continue;
    candidates.push({
      termKey: fact.termKey,
      policyAction: fact.policyAction,
      aliases: [...fact.aliases].sort(compareCodeUnits),
      occurrenceCount: fact.occurrenceCount,
      occurrenceUnitKeys: [...fact.occurrenceUnitKeys].sort(compareCodeUnits),
      conflicts: [...conflicts].sort((a, b) => compareCodeUnits(a.factId, b.factId)),
    });
  }
  return candidates.sort((a, b) => compareCodeUnits(a.termKey, b.termKey));
}

/** Whether a term key is one the index flagged ambiguous — the only terms the
 * analyst is permitted to rule on. */
export function isAmbiguousCandidate(
  index: Pick<FactSnapshot, "terminology" | "glossaryConflicts">,
  termKey: string,
): boolean {
  return ambiguousTermCandidates(index).some((candidate) => candidate.termKey === termKey);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, i) => value === right[i]);
}

/**
 * Reject a model output whose ALIAS enumeration is not exactly the byte-derived
 * one. The analyst rules on a fixed enumeration; adding, dropping, or reordering
 * an alias is a re-count the guard refuses. The ruling must also be FOR the
 * dispatched candidate and its source form must be one the index actually saw.
 */
export function assertByteDerivedTermEnumeration(
  ruling: TermRulingObject,
  candidate: AmbiguousTermCandidate,
): void {
  if (ruling.body.termId !== candidate.termKey) {
    throw new TermEnumerationError(
      "off-candidate",
      candidate.termKey,
      `ruling names term ${ruling.body.termId}, not the dispatched candidate`,
    );
  }
  const bodyAliases = [...ruling.body.aliases].sort(compareCodeUnits);
  if (!arraysEqual(bodyAliases, candidate.aliases)) {
    throw new TermEnumerationError(
      "alias-enumeration-drift",
      candidate.termKey,
      "aliases must be the byte-derived enumeration, not the model's re-count",
    );
  }
  if (!candidate.aliases.includes(ruling.body.sourceForm)) {
    throw new TermEnumerationError(
      "unknown-source-form",
      candidate.termKey,
      `source form ${ruling.body.sourceForm} is not a byte-derived alias`,
    );
  }
}

/** The evidence subject ids of a candidate's byte-derived occurrence units,
 * resolved through the snapshot's ordered units (unit key → fact id). */
export function occurrenceUnitFactIds(
  index: Pick<FactSnapshot, "orderedUnits">,
  candidate: AmbiguousTermCandidate,
): ReadonlySet<string> {
  const bySourceKey = new Map<string, string>();
  for (const unit of index.orderedUnits) bySourceKey.set(unit.sourceUnitKey, unit.factId);
  const ids = new Set<string>();
  for (const key of candidate.occurrenceUnitKeys) {
    const factId = bySourceKey.get(key);
    if (factId !== undefined) ids.add(factId);
  }
  return ids;
}

/**
 * Reject a ruling that cites a unit the term never occurs in. Every unit-subject
 * citation must resolve to one of the candidate's byte-derived occurrence units;
 * a citation to any other unit is a GHOST occurrence — a fact the bytes never
 * supported — and is refused. Non-unit citations are left to claim validation.
 */
export function assertOccurrenceCitationsByteDerived(
  ruling: TermRulingObject,
  candidate: AmbiguousTermCandidate,
  index: Pick<FactSnapshot, "orderedUnits">,
): void {
  const occurrences = occurrenceUnitFactIds(index, candidate);
  for (const claim of ruling.claims) {
    for (const citation of claim.citations) {
      if (citation.subject.kind !== "unit") continue;
      if (!occurrences.has(citation.subject.id)) {
        throw new TermEnumerationError(
          "ghost-occurrence",
          candidate.termKey,
          `citation ${citation.evidenceId} is not a byte-derived occurrence of the term`,
        );
      }
    }
  }
}
