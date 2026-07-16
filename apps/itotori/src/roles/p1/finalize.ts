// Deterministic assembly + guarantees for the P1 localizer's output.
//
// The model returns one DraftBatch per plan segment. This module ties every
// returned batch back to the plan and to the exact source skeletons, and proves
// the four localizer guarantees the schema alone cannot:
//   - only NON-OVERLAP CORES finalize — a batch may only finalize its plan core,
//     and no unit may be finalized by two chunks (no double-finalize);
//   - CARDINALITY / ORDER / SOURCE HASHES are exact against the source scene;
//   - protected PLACEHOLDERS are preserved (none dropped, none fabricated);
//   - typed UNCERTAINTY is surfaced, never a silent guess.
// Any violation throws a typed FinalizeError — a mismatch is a failure, never a
// repaired or fabricated result.

import type { Draft, DraftBatch } from "../../contracts/index.js";
import type { LocalizationSegment, SkeletonUnit } from "./plan.js";

export type FinalizeFailureCode =
  | "segment-batch-mismatch"
  | "scope-kind-mismatch"
  | "double-finalize"
  | "unit-cardinality"
  | "unit-order"
  | "source-hash"
  | "protected-span";

export class FinalizeError extends Error {
  constructor(
    readonly code: FinalizeFailureCode,
    detail: string,
  ) {
    super(`p1 finalize ${code}: ${detail}`);
    this.name = "FinalizeError";
  }
}

/** A typed uncertainty surfaced for one finalized unit (never dropped). */
export interface UncertainUnit {
  readonly unitId: string;
  readonly uncertainty: readonly Draft["uncertainty"][number][];
}

function idsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Assert a returned batch is exactly the batch the plan expected for a segment:
 * the same scope kind, scene, chunk coordinates, core, and overlap. */
export function assertBatchMatchesSegment(segment: LocalizationSegment, batch: DraftBatch): void {
  const scope = batch.scope;
  if (segment.mode !== scope.kind) {
    throw new FinalizeError(
      "scope-kind-mismatch",
      `plan segment is ${segment.mode} but batch scope is ${scope.kind}`,
    );
  }
  if (scope.kind === "whole-scene" && segment.mode === "whole-scene") {
    if (scope.sceneId !== segment.sceneId) {
      throw new FinalizeError("segment-batch-mismatch", "whole-scene batch names another scene");
    }
    if (!idsEqual(scope.expectedUnitIds, segment.unitIds)) {
      throw new FinalizeError("segment-batch-mismatch", "whole-scene expected units differ");
    }
    return;
  }
  if (scope.kind === "overlapping-chunk" && segment.mode === "overlapping-chunk") {
    if (
      scope.sceneId !== segment.sceneId ||
      scope.chunkIndex !== segment.chunkIndex ||
      scope.chunkCount !== segment.chunkCount
    ) {
      throw new FinalizeError("segment-batch-mismatch", "chunk coordinates differ from the plan");
    }
    if (!idsEqual(scope.coreUnitIds, segment.coreUnitIds)) {
      throw new FinalizeError("segment-batch-mismatch", "chunk core units differ from the plan");
    }
    if (!idsEqual(scope.overlapUnitIds, segment.overlapUnitIds)) {
      throw new FinalizeError("segment-batch-mismatch", "chunk overlap units differ from the plan");
    }
    return;
  }
  throw new FinalizeError("scope-kind-mismatch", "segment and batch scope kinds are incompatible");
}

/** Validate a single returned batch against its plan segment AND its finalizing
 * core's source hashes/placeholders — BEFORE it is folded into the author thread.
 * A forged or source-violating batch fails here, so an unvalidated target can
 * never taint a subsequent dispatch. Returns the validated plan-core drafts. */
export function validateSegmentBatch(
  segment: LocalizationSegment,
  batch: DraftBatch,
  unitsById: ReadonlyMap<string, SkeletonUnit>,
): readonly Draft[] {
  assertBatchMatchesSegment(segment, batch);
  const coreIds = segment.mode === "whole-scene" ? segment.unitIds : segment.coreUnitIds;
  const coreUnits = coreIds.map((unitId) => {
    const unit = unitsById.get(unitId);
    if (!unit) throw new FinalizeError("segment-batch-mismatch", `core unit ${unitId} is unknown`);
    return unit;
  });
  // The batch schema guarantees `drafts` equal the core ids in order; check the
  // core drafts against the VERIFIED source hashes and placeholders.
  assertExactAgainstSource(coreUnits, batch.drafts);
  assertPlaceholdersPreserved(coreUnits, batch.drafts);
  return batch.drafts;
}

/** Collect the finalized drafts across every segment's batch. Only the plan core
 * of each chunk finalizes, and a unit finalized by two chunks is rejected as a
 * double-finalize. Returns the drafts in play order. */
export function assembleFinalizedDrafts(
  segments: readonly LocalizationSegment[],
  batches: readonly DraftBatch[],
): readonly Draft[] {
  if (segments.length !== batches.length) {
    throw new FinalizeError(
      "segment-batch-mismatch",
      `${segments.length} segments but ${batches.length} batches`,
    );
  }
  const finalized: Draft[] = [];
  const finalizedIds = new Set<string>();
  for (const [index, segment] of segments.entries()) {
    const batch = batches[index]!;
    assertBatchMatchesSegment(segment, batch);
    const coreIds = segment.mode === "whole-scene" ? segment.unitIds : segment.coreUnitIds;
    const coreSet = new Set(coreIds);
    for (const draft of batch.drafts) {
      if (!coreSet.has(draft.unitId)) {
        // A chunk draft that is not in the plan core would finalize an overlap
        // (context) unit — reject rather than double-finalize it later.
        throw new FinalizeError(
          "double-finalize",
          `unit ${draft.unitId} is not a finalizing core unit of this segment`,
        );
      }
      if (finalizedIds.has(draft.unitId)) {
        throw new FinalizeError("double-finalize", `unit ${draft.unitId} finalized twice`);
      }
      finalizedIds.add(draft.unitId);
      finalized.push(draft);
    }
  }
  return finalized;
}

/** Assert the finalized drafts match the source scene EXACTLY: same count, same
 * order, and every source hash preserved. */
export function assertExactAgainstSource(
  sourceUnits: readonly SkeletonUnit[],
  finalized: readonly Draft[],
): void {
  if (finalized.length !== sourceUnits.length) {
    throw new FinalizeError(
      "unit-cardinality",
      `finalized ${finalized.length} units for a ${sourceUnits.length}-unit scene`,
    );
  }
  for (const [index, unit] of sourceUnits.entries()) {
    const draft = finalized[index]!;
    if (draft.unitId !== unit.unitId) {
      throw new FinalizeError(
        "unit-order",
        `position ${index} is ${draft.unitId}, source has ${unit.unitId}`,
      );
    }
    if (draft.sourceHash !== unit.sourceHash) {
      throw new FinalizeError(
        "source-hash",
        `unit ${unit.unitId} draft hash ${draft.sourceHash} != source ${unit.sourceHash}`,
      );
    }
  }
}

const PLACEHOLDER_TOKEN = /\{\{([^{}]+)\}\}/gu;

function placeholderMultiset(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(PLACEHOLDER_TOKEN)) {
    const id = match[1]!;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** Assert every draft preserves its source unit's protected placeholders exactly:
 * each source placeholder token appears in the target the same number of times,
 * and the target introduces no unknown/fabricated placeholder token. */
export function assertPlaceholdersPreserved(
  sourceUnits: readonly SkeletonUnit[],
  finalized: readonly Draft[],
): void {
  const byUnit = new Map(sourceUnits.map((unit) => [unit.unitId, unit]));
  for (const draft of finalized) {
    const unit = byUnit.get(draft.unitId)!;
    const expected = new Map<string, number>();
    for (const placeholder of unit.protectedPlaceholders) {
      expected.set(placeholder.placeholderId, (expected.get(placeholder.placeholderId) ?? 0) + 1);
    }
    const actual = placeholderMultiset(draft.targetSkeleton);
    for (const [id, count] of expected) {
      if (actual.get(id) !== count) {
        throw new FinalizeError(
          "protected-span",
          `unit ${draft.unitId} dropped protected placeholder ${id}`,
        );
      }
    }
    for (const id of actual.keys()) {
      if (!expected.has(id)) {
        throw new FinalizeError(
          "protected-span",
          `unit ${draft.unitId} fabricated placeholder ${id}`,
        );
      }
    }
  }
}

/** Surface the typed uncertainty every draft declares (dropping the pure-`none`
 * drafts). The schema already forbids an empty or `none`-plus-flag declaration,
 * so a surfaced entry is always a real, typed uncertainty — not a silent guess. */
export function surfaceUncertainties(finalized: readonly Draft[]): readonly UncertainUnit[] {
  return finalized
    .filter((draft) => !(draft.uncertainty.length === 1 && draft.uncertainty[0] === "none"))
    .map((draft) => ({ unitId: draft.unitId, uncertainty: [...draft.uncertainty] }));
}
