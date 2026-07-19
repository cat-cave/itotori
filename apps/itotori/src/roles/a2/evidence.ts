// A2's snapshot-pinned occurrence evidence.
//
// The terminology pre-pass already owns the whole-game enumeration. This module
// does NOT scan source text or recount aliases; it only maps the candidate's
// fixed occurrence unit keys back to readable same-snapshot facts. The prompt
// gets short labels (o1, o2, …), and citation resolution binds those labels to
// the immutable fact ids after the model responds.

import type { DecodeGetUnitsResult } from "../../contracts/index.js";
import { decodeGetUnits, type ReadModel, type ReadToolCaller } from "../../read-tools/index.js";

import type { AmbiguousTermCandidate } from "./candidates.js";

/** A loud failure when the pre-pass's occurrence enumeration cannot be read
 * back from the immutable snapshot that A2 is about to cite. */
export class TermOccurrenceEvidenceError extends Error {
  constructor(
    readonly termKey: string,
    detail: string,
  ) {
    super(`term occurrence evidence for ${termKey}: ${detail}`);
    this.name = "TermOccurrenceEvidenceError";
  }
}

/** One fixed occurrence rendered with a short label the model can copy. */
export interface CiteableTermOccurrence {
  readonly label: string;
  readonly factId: string;
  readonly sourceUnitKey: string;
  readonly sourceText: string;
}

/** The exact RB-025 result A2 consumes before it reasons about the candidate. */
export interface TermOccurrenceEvidence {
  readonly occurrencePages: readonly DecodeGetUnitsResult[];
  readonly occurrences: readonly CiteableTermOccurrence[];
}

const SOURCE_WIKI_A2_CALLER: ReadToolCaller = {
  roleId: "A2",
  routeVisibility: { kind: "global" },
  localeBranchId: null,
};

const MAX_BYTES = 8_388_608;
const MAX_OCCURRENCES_PER_READ = 256;

/**
 * Read exactly the candidate's byte-derived occurrence units through the
 * RB-025 source read surface. The candidate's ordered keys determine the
 * labels; no text search, alias grouping, or count is performed here.
 */
export function readTermOccurrenceEvidence(
  model: ReadModel,
  candidate: AmbiguousTermCandidate,
): TermOccurrenceEvidence {
  const unitsBySourceKey = new Map(
    model.factSnapshot.orderedUnits.map((unit) => [unit.sourceUnitKey, unit]),
  );
  const occurrenceFactIds = candidate.occurrenceUnitKeys.map((sourceUnitKey) => {
    const unit = unitsBySourceKey.get(sourceUnitKey);
    if (unit === undefined) {
      throw new TermOccurrenceEvidenceError(
        candidate.termKey,
        `byte-derived occurrence ${sourceUnitKey} is absent from the snapshot`,
      );
    }
    return unit.factId;
  });

  if (new Set(occurrenceFactIds).size !== occurrenceFactIds.length) {
    throw new TermOccurrenceEvidenceError(
      candidate.termKey,
      "byte-derived occurrence keys map to duplicate snapshot facts",
    );
  }
  if (occurrenceFactIds.length === 0) {
    throw new TermOccurrenceEvidenceError(
      candidate.termKey,
      "an ambiguous candidate without byte-derived occurrences cannot support a ruling",
    );
  }

  const occurrencePages: DecodeGetUnitsResult[] = [];
  for (let offset = 0; offset < occurrenceFactIds.length; offset += MAX_OCCURRENCES_PER_READ) {
    const factIds = occurrenceFactIds.slice(offset, offset + MAX_OCCURRENCES_PER_READ);
    const page = decodeGetUnits(model, SOURCE_WIKI_A2_CALLER, {
      selector: { kind: "unit-ids", unitIds: factIds },
      maxRows: factIds.length,
      maxBytes: MAX_BYTES,
    });
    if (page.page.kind !== "complete" || page.facts.length !== factIds.length) {
      throw new TermOccurrenceEvidenceError(
        candidate.termKey,
        "exact occurrence read was incomplete",
      );
    }
    occurrencePages.push(page);
  }

  const factsById = new Map(
    occurrencePages.flatMap((page) => page.facts).map((fact) => [fact.factId, fact]),
  );
  const occurrences = candidate.occurrenceUnitKeys.map((sourceUnitKey, index) => {
    const unit = unitsBySourceKey.get(sourceUnitKey)!;
    const fact = factsById.get(unit.factId);
    if (fact === undefined) {
      throw new TermOccurrenceEvidenceError(
        candidate.termKey,
        `exact occurrence read omitted ${sourceUnitKey}`,
      );
    }
    return {
      label: `o${index + 1}`,
      factId: fact.factId,
      sourceUnitKey,
      sourceText: fact.value.sourceSurface,
    };
  });

  return { occurrencePages, occurrences };
}
