// Deterministic validation + merge for the P2 Line Editor's output.
//
// The model returns ONE draft batch scoped as a `repair-patch` in
// `author-continuation` mode. This module ties that patch back to the edit scope
// and proves the guarantees the schema alone cannot:
//   - the patch is an AUTHOR-CONTINUATION repair of exactly THIS bundle/draft;
//   - it patches ONLY the implicated units (its failed ids equal the implicated
//     ids in order) — no unimplicated unit is touched;
//   - each patched line preserves its source hash, its protected placeholders,
//     and Shift-JIS representability on the OUTPUT (the byte-level patch holds);
//   - merging the patch over the current draft leaves every UNAFFECTED unit
//     BYTE-IDENTICAL (same target skeleton, same object identity).
// Any violation throws a typed FinalizeError — a mismatch is a failure, never a
// repaired or fabricated result.

import type { Draft, DraftBatch } from "../../contracts/index.js";
import { firstNonSjisCodePoint } from "../../gates/shift-jis.js";
import type { EditScope, ImplicatedSource } from "./scope.js";

export type FinalizeFailureCode =
  | "scope-kind-mismatch"
  | "repair-mode-mismatch"
  | "parent-batch-mismatch"
  | "defect-bundle-mismatch"
  | "snapshot-mismatch"
  | "implicated-mismatch"
  | "unit-cardinality"
  | "unit-order"
  | "source-hash"
  | "protected-span"
  | "encoding"
  | "unaffected-mutated";

export class FinalizeError extends Error {
  constructor(
    readonly code: FinalizeFailureCode,
    detail: string,
  ) {
    super(`p2 finalize ${code}: ${detail}`);
    this.name = "FinalizeError";
  }
}

function idsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Assert the returned batch is the exact repair patch the scope expects: an
 * author-continuation `repair-patch` naming THIS parent draft, THIS bundle, THIS
 * snapshot, and finalizing EXACTLY the implicated units in order. This is what
 * proves the patch is scoped to the implicated ids and is not a fresh fork. */
export function assertRepairPatchMatchesScope(scope: EditScope, batch: DraftBatch): void {
  const patchScope = batch.scope;
  if (patchScope.kind !== "repair-patch") {
    throw new FinalizeError(
      "scope-kind-mismatch",
      `expected a repair-patch, batch scope is ${patchScope.kind}`,
    );
  }
  if (patchScope.repairMode !== "author-continuation") {
    throw new FinalizeError(
      "repair-mode-mismatch",
      `repair mode ${patchScope.repairMode} is not the line editor's author continuation`,
    );
  }
  if (patchScope.parentDraftBatchId !== scope.parentDraftBatchId) {
    throw new FinalizeError("parent-batch-mismatch", "patch names another parent draft batch");
  }
  if (patchScope.defectBundleId !== scope.defectBundleId) {
    throw new FinalizeError("defect-bundle-mismatch", "patch names another defect bundle");
  }
  if (batch.localizationSnapshotId !== scope.localizationSnapshotId) {
    throw new FinalizeError("snapshot-mismatch", "patch names another localization snapshot");
  }
  // PATCHES ONLY THE IMPLICATED IDS: the failed set must equal the implicated set
  // in order. The batch schema already ties `drafts` to `failedUnitIds`, so this
  // proves no unimplicated unit is patched and every implicated one is.
  if (!idsEqual(patchScope.failedUnitIds, scope.implicatedUnitIds)) {
    throw new FinalizeError(
      "implicated-mismatch",
      "patch failed units are not exactly the implicated units in order",
    );
  }
}

/** Assert the patched drafts match the implicated source EXACTLY: same count,
 * same order, and every source hash preserved. */
export function assertExactAgainstSource(scope: EditScope, patched: readonly Draft[]): void {
  const implicated = scope.implicatedUnitIds;
  if (patched.length !== implicated.length) {
    throw new FinalizeError(
      "unit-cardinality",
      `patched ${patched.length} units for ${implicated.length} implicated units`,
    );
  }
  for (const [index, unitId] of implicated.entries()) {
    const draft = patched[index]!;
    if (draft.unitId !== unitId) {
      throw new FinalizeError(
        "unit-order",
        `position ${index} is ${draft.unitId}, implicated set has ${unitId}`,
      );
    }
    const source = scope.implicatedSource.get(unitId)!;
    if (draft.sourceHash !== source.sourceHash) {
      throw new FinalizeError(
        "source-hash",
        `unit ${unitId} patch hash ${draft.sourceHash} != source ${source.sourceHash}`,
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

function expectedPlaceholders(source: ImplicatedSource): Map<string, number> {
  const expected = new Map<string, number>();
  for (const placeholder of source.protectedPlaceholders) {
    expected.set(placeholder.placeholderId, (expected.get(placeholder.placeholderId) ?? 0) + 1);
  }
  return expected;
}

/** Assert every patched line preserves its source unit's protected placeholders
 * exactly: each token appears the same number of times, and no unknown token is
 * fabricated. Preserving the placeholders is what preserves the byte-level patch. */
export function assertPlaceholdersPreserved(scope: EditScope, patched: readonly Draft[]): void {
  for (const draft of patched) {
    const source = scope.implicatedSource.get(draft.unitId)!;
    const expected = expectedPlaceholders(source);
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

/** Assert every patched target survives the Shift-JIS patchback on the OUTPUT: a
 * repaired line that introduced an un-encodable codepoint would fail to patch, so
 * it is refused here rather than corrupting the byte stream. */
export function assertSjisPreserved(patched: readonly Draft[]): void {
  for (const draft of patched) {
    const offending = firstNonSjisCodePoint(draft.targetSkeleton);
    if (offending !== null) {
      throw new FinalizeError(
        "encoding",
        `unit ${draft.unitId} target contains ${offending.label} (${offending.reason})`,
      );
    }
  }
}

/**
 * Fold the validated patch over the current draft. The implicated units take
 * their patched line; every UNAFFECTED unit keeps the SAME draft object it had —
 * so an unimplicated line is byte-identical by construction, and this asserts it.
 * Returns the merged full draft list in the current draft's order.
 */
export function mergePatch(
  currentDraft: DraftBatch,
  scope: EditScope,
  batch: DraftBatch,
): readonly Draft[] {
  const patchByUnit = new Map(batch.drafts.map((draft) => [draft.unitId, draft]));
  const implicated = new Set(scope.implicatedUnitIds);
  const merged: Draft[] = [];
  for (const draft of currentDraft.drafts) {
    if (implicated.has(draft.unitId)) {
      merged.push(patchByUnit.get(draft.unitId)!);
      continue;
    }
    // UNAFFECTED unit: it must not appear in the patch and stays byte-identical.
    if (patchByUnit.has(draft.unitId)) {
      throw new FinalizeError(
        "unaffected-mutated",
        `unit ${draft.unitId} is unimplicated but the patch carries it`,
      );
    }
    merged.push(draft);
  }
  return merged;
}
