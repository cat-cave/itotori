// Deterministic finalization guards for P2 Line Editor patches.
//
// The model may author the replacement target for an implicated line, but it
// cannot widen the patch, alter source identity, drop a protected span, emit a
// target the selected policy's codec cannot carry, or mutate any parent draft
// outside the exact edit scope.

import type { Draft, DraftBatch } from "../../contracts/index.js";
import type { LocalizationTargetPolicy } from "../../gates/index.js";
import { AUTHOR_CONTINUATION_MODE, type EditScope } from "./scope.js";

export type FinalizeFailureCode =
  | "scope-kind-mismatch"
  | "repair-mode-mismatch"
  | "parent-batch-mismatch"
  | "bundle-mismatch"
  | "failed-ids-mismatch"
  | "unaffected-mutated"
  | "unit-cardinality"
  | "unit-order"
  | "source-hash"
  | "protected-span"
  | "encoding"
  | "choice-encoding"
  | "basis-mismatch"
  | "resolving-evidence";

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

/** Bind a returned repair-patch scope to P2's current author-thread scope. */
export function assertRepairPatchMatchesScope(scope: EditScope, batch: DraftBatch): void {
  if (batch.scope.kind !== "repair-patch") {
    throw new FinalizeError(
      "scope-kind-mismatch",
      `expected repair-patch, got ${batch.scope.kind}`,
    );
  }
  if (batch.scope.repairMode !== AUTHOR_CONTINUATION_MODE) {
    throw new FinalizeError(
      "repair-mode-mismatch",
      `P2 requires ${AUTHOR_CONTINUATION_MODE}, got ${batch.scope.repairMode}`,
    );
  }
  if (batch.scope.parentDraftBatchId !== scope.currentDraft.batchId) {
    throw new FinalizeError("parent-batch-mismatch", "patch names another parent draft batch");
  }
  if (batch.scope.defectBundleId !== scope.defectBundle.bundleId) {
    throw new FinalizeError("bundle-mismatch", "patch names another defect bundle");
  }
  if (!idsEqual(batch.scope.failedUnitIds, scope.implicatedUnitIds)) {
    throw new FinalizeError(
      "failed-ids-mismatch",
      "patch scope is not exactly the current draft's implicated ids in order",
    );
  }
}

/** Exact patch cardinality, current play order, and source hash binding. */
export function assertExactAgainstSource(scope: EditScope, drafts: readonly Draft[]): void {
  const implicated = new Set(scope.implicatedUnitIds);
  for (const draft of drafts) {
    if (!implicated.has(draft.unitId)) {
      throw new FinalizeError(
        "unaffected-mutated",
        `patch includes passing/unaffected unit ${draft.unitId}`,
      );
    }
  }
  if (drafts.length !== scope.implicatedUnitIds.length) {
    throw new FinalizeError(
      "unit-cardinality",
      `patch has ${drafts.length} drafts for ${scope.implicatedUnitIds.length} implicated units`,
    );
  }
  for (const [index, unit] of scope.implicatedUnits.entries()) {
    const draft = drafts[index]!;
    if (draft.unitId !== unit.value.unitId) {
      throw new FinalizeError(
        "unit-order",
        `patch position ${index} is ${draft.unitId}, expected ${unit.value.unitId}`,
      );
    }
    if (draft.sourceHash !== unit.value.sourceHash) {
      throw new FinalizeError(
        "source-hash",
        `unit ${draft.unitId} patch hash does not match its source fact`,
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

/** Preserve every protected source placeholder exactly; no additions either. */
export function assertPlaceholdersPreserved(scope: EditScope, drafts: readonly Draft[]): void {
  const unitsById = new Map(scope.implicatedUnits.map((unit) => [unit.value.unitId, unit]));
  for (const draft of drafts) {
    const unit = unitsById.get(draft.unitId);
    if (!unit) {
      throw new FinalizeError("unaffected-mutated", `patch includes ${draft.unitId}`);
    }
    const expected = new Map<string, number>();
    for (const placeholder of unit.value.protectedPlaceholders) {
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
          `unit ${draft.unitId} fabricated protected placeholder ${id}`,
        );
      }
    }
  }
}

/** P2 has to stay patchback-safe under the selected target policy before its
 * implicated deterministic lane reruns. */
export function assertTargetEncodable(
  drafts: readonly Draft[],
  policy: LocalizationTargetPolicy,
): void {
  for (const draft of drafts) {
    const offending = policy.firstDisallowedCodePoint(draft.targetSkeleton);
    if (offending !== null) {
      throw new FinalizeError(
        "encoding",
        `unit ${draft.unitId} target contains ${offending.label} (${offending.reason}) — not ${policy.codec}-representable`,
      );
    }
  }
}

function assertChoiceEncoding(scope: EditScope, drafts: readonly Draft[]): void {
  const unitsById = new Map(scope.implicatedUnits.map((unit) => [unit.value.unitId, unit]));
  for (const draft of drafts) {
    const unit = unitsById.get(draft.unitId)!;
    if (unit.value.surfaceKind !== "choice_label") continue;
    if (unit.value.choiceContext === null) {
      throw new FinalizeError(
        "choice-encoding",
        `choice-label unit ${draft.unitId} is missing deterministic choice context`,
      );
    }
    if (/[\r\n]/u.test(draft.targetSkeleton)) {
      throw new FinalizeError(
        "choice-encoding",
        `choice-label unit ${draft.unitId} must remain one encoded choice label`,
      );
    }
  }
}

function assertExactBibleBasis(scope: EditScope, drafts: readonly Draft[]): void {
  for (const draft of drafts) {
    if (
      draft.basis.kind !== "wiki-first" ||
      !idsEqual(draft.basis.bibleRenderingIds, scope.bibleRenderingIds)
    ) {
      throw new FinalizeError(
        "basis-mismatch",
        `unit ${draft.unitId} patch does not cite the exact localized-bible basis`,
      );
    }
    const resolvingEvidence = new Set(
      (scope.defectsByUnit.get(draft.unitId) ?? []).flatMap((defect) => defect.evidenceIds),
    );
    if (!draft.evidenceIds.some((evidenceId) => resolvingEvidence.has(evidenceId))) {
      throw new FinalizeError(
        "resolving-evidence",
        `unit ${draft.unitId} patch cites none of its exact changed-basis evidence`,
      );
    }
  }
}

/**
 * Merge a validated P2 patch into its parent.  Untouched drafts are returned by
 * reference, not cloned: that gives callers a direct byte-and-identity proof
 * that P2 did not alter unaffected content.
 */
export function mergePatch(
  currentDraft: DraftBatch,
  scope: EditScope,
  patch: DraftBatch,
  policy: LocalizationTargetPolicy,
): readonly Draft[] {
  if (currentDraft !== scope.currentDraft) {
    throw new FinalizeError("parent-batch-mismatch", "merge parent is not the derived edit parent");
  }
  assertRepairPatchMatchesScope(scope, patch);
  assertExactAgainstSource(scope, patch.drafts);
  assertPlaceholdersPreserved(scope, patch.drafts);
  assertTargetEncodable(patch.drafts, policy);
  assertChoiceEncoding(scope, patch.drafts);
  assertExactBibleBasis(scope, patch.drafts);

  const patchById = new Map(patch.drafts.map((draft) => [draft.unitId, draft]));
  return currentDraft.drafts.map((draft) => patchById.get(draft.unitId) ?? draft);
}
