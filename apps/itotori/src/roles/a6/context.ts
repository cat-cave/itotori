// The Cultural Adaptation Analyst's bounded source context.
//
// Candidate selection remains a deterministic RB-024 pre-pass. Before A6 asks
// the model to describe an adaptation strategy, however, it must READ the
// selected unit and its immediate setup/payoff through the RB-025 surface. The
// role therefore never treats an in-memory candidate as its whole context: the
// exact unit, neighbor window, and any matching operator reference excerpts are
// returned by the typed, visibility-checked tools below.

import type {
  DecodeGetNeighborsResult,
  DecodeGetUnitsResult,
  ReferencesSearchResult,
} from "../../contracts/index.js";
import {
  decodeGetNeighbors,
  decodeGetUnits,
  referencesSearch,
  type ReadModel,
  type ReadToolCaller,
} from "../../read-tools/index.js";

import type { FlaggedAdaptationCandidate } from "./candidates.js";

/** A loud failure when a supposedly dispatchable candidate cannot be recovered
 * from the same immutable, globally visible source context. */
export class AdaptationContextError extends Error {
  constructor(
    readonly unitFactId: string,
    detail: string,
  ) {
    super(`adaptation context for ${unitFactId}: ${detail}`);
    this.name = "AdaptationContextError";
  }
}

/** The exact RB-025 pages A6 consumed for one candidate. Keeping the envelopes
 * makes the source of every prompt fact inspectable by callers and tests. */
export interface AdaptationReadContext {
  readonly unit: DecodeGetUnitsResult["facts"][number];
  readonly unitPage: DecodeGetUnitsResult;
  readonly neighborsPage: DecodeGetNeighborsResult;
  readonly referencesPage: ReferencesSearchResult;
}

const SOURCE_WIKI_A6_CALLER: ReadToolCaller = {
  roleId: "A6",
  routeVisibility: { kind: "global" },
  localeBranchId: null,
};

const MAX_ROWS = 8;
const MAX_BYTES = 1_048_576;

/**
 * Read the bounded context an A6 note may rely on. `decode_get_units` proves
 * that the dispatched fact is readable at the current snapshot, while
 * `decode_get_neighbors` gives the consultant the local setup/payoff window.
 * `references_search` is deliberately local and optional in effect: an empty
 * result is useful evidence that no operator reference matched the fixed
 * marker/source query, not a reason to invent a cultural fact.
 */
export function readAdaptationContext(
  model: ReadModel,
  candidate: FlaggedAdaptationCandidate,
): AdaptationReadContext {
  const unitPage = decodeGetUnits(model, SOURCE_WIKI_A6_CALLER, {
    selector: { kind: "unit-ids", unitIds: [candidate.unitFactId] },
    maxRows: 1,
    maxBytes: MAX_BYTES,
  });
  const unit = unitPage.facts.find((fact) => fact.factId === candidate.unitFactId);
  if (unit === undefined) {
    throw new AdaptationContextError(
      candidate.unitFactId,
      "exact unit read returned no candidate fact",
    );
  }

  const neighborsPage = decodeGetNeighbors(model, SOURCE_WIKI_A6_CALLER, {
    anchorUnitIds: [candidate.unitFactId],
    before: 2,
    after: 2,
    maxRows: 5,
    maxBytes: MAX_BYTES,
  });
  if (!neighborsPage.facts.some((fact) => fact.factId === candidate.unitFactId)) {
    throw new AdaptationContextError(candidate.unitFactId, "neighbor window omitted its anchor");
  }

  const query = candidate.markers[0] ?? candidate.sourceText;
  const referencesPage = referencesSearch(model, SOURCE_WIKI_A6_CALLER, {
    query,
    maxRows: MAX_ROWS,
    maxBytes: MAX_BYTES,
  });

  return { unit, unitPage, neighborsPage, referencesPage };
}
