// Normalize the P2 Line Editor's bounded author-continuation scope.
//
// P2 never receives a whole scene as a drafting prompt.  It receives the
// current batch only as a trusted parent and projects exactly the draft lines
// implicated by a minor repair bundle.  This projection makes a blind
// retranslation structurally unavailable to the call builder.

import type { Defect, DefectBundle, Draft, DraftBatch, UnitFact } from "../../contracts/index.js";

export const AUTHOR_CONTINUATION_MODE = "author-continuation" as const;

export type EditFailureCode =
  | "not-a-repair-bundle"
  | "empty-defect-bundle"
  | "bundle-batch-mismatch"
  | "bundle-snapshot-mismatch"
  | "non-minor-defect"
  | "meaning-defect"
  | "unknown-implicated-unit"
  | "missing-source-fact"
  | "duplicate-source-fact"
  | "source-hash"
  | "non-wiki-basis"
  | "bible-basis-mismatch";

/** A loud refusal before a P2 author-continuation can reach dispatch. */
export class EditScopeError extends Error {
  constructor(
    readonly code: EditFailureCode,
    detail: string,
  ) {
    super(`p2 edit ${code}: ${detail}`);
    this.name = "EditScopeError";
  }
}

export interface EditScope {
  /** The immutable parent batch whose author thread P2 continues. */
  readonly currentDraft: DraftBatch;
  readonly defectBundle: DefectBundle;
  /** Exact P2 patch order: the current author's play order, never defect order. */
  readonly implicatedUnitIds: readonly string[];
  readonly implicatedDrafts: readonly Draft[];
  readonly implicatedUnits: readonly UnitFact[];
  readonly defectsByUnit: ReadonlyMap<string, readonly Defect[]>;
  /** Every affected line already cites this exact localized bible basis. */
  readonly bibleRenderingIds: readonly string[];
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function sameBasis(left: readonly string[], right: readonly string[]): boolean {
  return sameIds(left, right);
}

function requireMinorNonMeaning(defect: Defect): void {
  if (defect.severity !== "minor") {
    throw new EditScopeError(
      "non-minor-defect",
      `defect ${defect.defectId} is ${defect.severity}; material repairs belong to P3`,
    );
  }
  if (defect.category === "meaning") {
    throw new EditScopeError(
      "meaning-defect",
      `defect ${defect.defectId} is a meaning defect; P2 cannot retranslate it`,
    );
  }
}

/**
 * Derive P2's exact patch scope from a current parent draft, a joined minor
 * defect bundle, and decode facts.  A malformed or broader request fails
 * before dispatch; it is never silently narrowed into a different job.
 */
export function deriveEditScope(
  currentDraft: DraftBatch,
  defectBundle: DefectBundle,
  units: readonly UnitFact[],
): EditScope {
  if (defectBundle.resolution !== "repair") {
    throw new EditScopeError(
      "not-a-repair-bundle",
      `bundle resolution is '${defectBundle.resolution}', not 'repair'`,
    );
  }
  if (defectBundle.defects.length === 0) {
    throw new EditScopeError("empty-defect-bundle", "a P2 edit needs at least one exact defect");
  }
  if (defectBundle.draftBatchId !== currentDraft.batchId) {
    throw new EditScopeError(
      "bundle-batch-mismatch",
      `bundle names ${defectBundle.draftBatchId}, current draft is ${currentDraft.batchId}`,
    );
  }
  if (defectBundle.localizationSnapshotId !== currentDraft.localizationSnapshotId) {
    throw new EditScopeError(
      "bundle-snapshot-mismatch",
      "defect bundle and current draft have different localization snapshots",
    );
  }

  const currentById = new Map(currentDraft.drafts.map((draft) => [draft.unitId, draft]));
  const unitsById = new Map<string, UnitFact>();
  for (const unit of units) {
    if (unitsById.has(unit.value.unitId)) {
      throw new EditScopeError("duplicate-source-fact", `unit ${unit.value.unitId} appears twice`);
    }
    unitsById.set(unit.value.unitId, unit);
  }

  const defectsByUnit = new Map<string, Defect[]>();
  for (const defect of defectBundle.defects) {
    requireMinorNonMeaning(defect);
    if (!currentById.has(defect.unitId)) {
      throw new EditScopeError(
        "unknown-implicated-unit",
        `defect ${defect.defectId} names absent draft ${defect.unitId}`,
      );
    }
    if (!unitsById.has(defect.unitId)) {
      throw new EditScopeError(
        "missing-source-fact",
        `defect ${defect.defectId} names ${defect.unitId} without a source fact`,
      );
    }
    const byUnit = defectsByUnit.get(defect.unitId) ?? [];
    byUnit.push(defect);
    defectsByUnit.set(defect.unitId, byUnit);
  }

  // The current batch defines stable play order.  Defect arrival order must
  // never make a continuation reorder an author's lines.
  const implicatedDrafts = currentDraft.drafts.filter((draft) => defectsByUnit.has(draft.unitId));
  const implicatedUnitIds = implicatedDrafts.map((draft) => draft.unitId);
  const implicatedUnits = implicatedUnitIds.map((unitId) => unitsById.get(unitId)!);

  for (const [index, draft] of implicatedDrafts.entries()) {
    const unit = implicatedUnits[index]!;
    if (draft.sourceHash !== unit.value.sourceHash) {
      throw new EditScopeError(
        "source-hash",
        `current draft ${draft.unitId} does not match its pinned source fact`,
      );
    }
  }

  const firstDraft = implicatedDrafts[0]!;
  if (firstDraft.basis.kind !== "wiki-first") {
    throw new EditScopeError("non-wiki-basis", "P2 requires a localized-bible current draft");
  }
  const bibleRenderingIds = firstDraft.basis.bibleRenderingIds;
  for (const draft of implicatedDrafts) {
    if (draft.basis.kind !== "wiki-first") {
      throw new EditScopeError(
        "non-wiki-basis",
        `draft ${draft.unitId} bypasses the localized bible`,
      );
    }
    if (!sameBasis(draft.basis.bibleRenderingIds, bibleRenderingIds)) {
      throw new EditScopeError(
        "bible-basis-mismatch",
        "implicated current drafts do not share one exact localized-bible basis",
      );
    }
  }

  return {
    currentDraft,
    defectBundle,
    implicatedUnitIds,
    implicatedDrafts,
    implicatedUnits,
    defectsByUnit,
    bibleRenderingIds: [...bibleRenderingIds],
  };
}
