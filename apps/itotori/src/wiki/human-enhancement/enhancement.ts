// The bounded child enhancement: reconcile a model proposal against the human
// delta under three hard rules.
//
//   1. Exact human text is preserved — UNLESS a decoded fact conflicts with it,
//      in which case the decoded fact (authoritative, byte-derived) wins. The
//      model never overrides a human edit; only ground truth does.
//   2. Fields the session did not touch or implicate are preserved verbatim.
//   3. The reconciled version is NON-PROVISIONAL and authored by "enhancement".
//
// The model call itself is RB-012's dispatch; this module is model-agnostic and
// takes an injected {@link EnhancementRunner}, so the reconciliation guarantees
// are proven deterministically on a recorded proposal — no live inference.

import {
  changedLeafPaths,
  getAtPath,
  isPathWithin,
  pathKey,
  withoutValueAtPath,
  withValueAtPath,
  type FieldPath,
  type JsonValue,
} from "./field-path.js";
import { isEnhancementAffected, isHumanTouched, type CoalescedHumanDelta } from "./human-delta.js";

/** An authoritative, byte-derived fact the human text must not contradict. */
export interface DecodedFact {
  readonly fieldPath: FieldPath;
  readonly value: JsonValue;
}

/** The input a bounded child enhancement receives: the pre-session object, the
 * human-applied object, and the coalesced human delta. */
export interface EnhancementRequest {
  readonly priorObjectJson: JsonValue;
  readonly humanAppliedJson: JsonValue;
  readonly delta: CoalescedHumanDelta;
  /** Human-touched paths whose value a decoded fact contradicts. */
  readonly decodedFactConflicts: readonly FieldPath[];
}

/** What the model proposes: a full candidate object plus the memo that produced
 * it (the RB-012 call identity, for provenance). */
export interface EnhancementProposal {
  readonly objectJson: JsonValue;
  readonly authorMemoKey?: string;
}

/** The seam over RB-012. Production wraps `dispatch`; the proof injects a
 * recorded proposal so the reconciliation is exercised offline. */
export type EnhancementRunner = (request: EnhancementRequest) => Promise<EnhancementProposal>;

/** Human-touched paths whose current value contradicts a decoded fact, mapped
 * to the authoritative value that must replace them. Deterministic; no model. */
export function detectDecodedFactConflicts(
  humanAppliedJson: JsonValue,
  decodedFacts: readonly DecodedFact[],
  delta: CoalescedHumanDelta,
): Map<string, JsonValue> {
  const conflicts = new Map<string, JsonValue>();
  for (const fact of decodedFacts) {
    if (!isHumanTouched(fact.fieldPath, delta)) continue;
    const current = getAtPath(humanAppliedJson, fact.fieldPath);
    if (JSON.stringify(current ?? null) !== JSON.stringify(fact.value)) {
      conflicts.set(pathKey(fact.fieldPath), fact.value);
    }
  }
  return conflicts;
}

/** Adopt the proposal's leaf value at `path` into `result`, but only as a
 * modification or removal of an already-present field. A structural addition
 * the model invents is ignored — the enhancement is bounded to the fields the
 * session actually implicates. */
function adoptProposalLeaf(result: JsonValue, proposalJson: JsonValue, path: FieldPath): JsonValue {
  const proposed = getAtPath(proposalJson, path);
  const present = getAtPath(result, path) !== undefined;
  if (proposed === undefined) {
    return present ? withoutValueAtPath(result, path) : result;
  }
  return present ? withValueAtPath(result, path, proposed) : result;
}

export interface ReconcileInput {
  readonly humanAppliedJson: JsonValue;
  readonly proposal: EnhancementProposal;
  readonly delta: CoalescedHumanDelta;
  /** Decoded-fact resolutions: human-touched path key -> authoritative value. */
  readonly conflictResolutions: ReadonlyMap<string, JsonValue>;
}

/**
 * Produce the reconciled object body/claims from the human-applied object and
 * the model proposal. Provenance and version stamping happen in the service;
 * this function owns only the three preservation rules over the content.
 */
export function reconcileEnhancement(input: ReconcileInput): JsonValue {
  let result = input.humanAppliedJson;

  // Rule 1b: a decoded fact overrides the human text it contradicts.
  for (const [key, value] of input.conflictResolutions) {
    const path = JSON.parse(key) as FieldPath;
    result = withValueAtPath(result, path, value);
  }

  // Rules 1a + 2: adopt the proposal only on enhancement-affected, non-human
  // leaves; preserve human text and untouched fields verbatim.
  for (const path of changedLeafPaths(input.humanAppliedJson, input.proposal.objectJson)) {
    if (isHumanTouched(path, input.delta)) continue;
    if (!isEnhancementAffected(path, input.delta)) continue;
    result = adoptProposalLeaf(result, input.proposal.objectJson, path);
  }

  return result;
}

/** True when `path` is inside the object body subtree. */
export function isBodyPath(path: FieldPath): boolean {
  return isPathWithin(path, ["body"]);
}
