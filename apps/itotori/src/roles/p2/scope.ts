// Deriving the P2 Line Editor's EDIT SCOPE from the current draft plus the exact
// changed basis: a defect bundle the trusted QA workflow raised against that
// draft. The Line Editor is a MINOR-repair author continuation, so the scope is
// exactly the IMPLICATED units the defects name — never the whole scene.
//
// Everything here is a pure, deterministic reduction of the current draft and
// the defect bundle. Nothing calls a model. The inputs come from the cooperative
// pipeline, so this is a plain typed coherence guard (not an adversarial proof):
// it fails loud when the bundle does not describe THIS draft, when it is not a
// repair bundle, or when an implicated unit lacks the source fact whose protected
// placeholders and hash the OUTPUT patch must preserve. A non-repair bundle is
// refused HERE, before any dispatch — the editor never blind-retranslates.

import type { Defect, DefectBundle, Draft, DraftBatch, UnitFact } from "../../contracts/index.js";

/** The current authored line for one unit, keyed for the author thread + merge. */
export interface CurrentUnit {
  readonly unitId: string;
  readonly draft: Draft;
}

/** The source fact an implicated patch must preserve (hash + placeholders). */
export interface ImplicatedSource {
  readonly unitId: string;
  readonly sourceHash: string;
  readonly sourceSkeleton: string;
  readonly protectedPlaceholders: readonly {
    readonly placeholderId: string;
    readonly kind: "control-markup" | "variable" | "ruby";
    readonly sourceText: string;
  }[];
}

/** One defect narrowed to what the editor shows the author: the failing span and
 * the repair constraint, never the reviewer's internal identity. */
export interface ScopedDefect {
  readonly defectId: string;
  readonly unitId: string;
  readonly severity: Defect["severity"];
  readonly category: Defect["category"];
  readonly repairConstraint: string;
  readonly span: Defect["span"];
}

export interface EditScope {
  readonly parentDraftBatchId: string;
  readonly defectBundleId: string;
  readonly localizationSnapshotId: string;
  /** The implicated units, in current-draft play order — the ONLY units patched. */
  readonly implicatedUnitIds: readonly string[];
  /** Every current unit, keyed by id (the merge folds patches back over these). */
  readonly currentByUnit: ReadonlyMap<string, CurrentUnit>;
  /** Source facts for the implicated units (patch preservation basis). */
  readonly implicatedSource: ReadonlyMap<string, ImplicatedSource>;
  /** The scoped defects per implicated unit, in bundle order. */
  readonly defectsByUnit: ReadonlyMap<string, readonly ScopedDefect[]>;
}

export type ScopeFailureCode =
  | "not-a-repair-bundle"
  | "empty-defect-bundle"
  | "bundle-batch-mismatch"
  | "snapshot-mismatch"
  | "duplicate-current-unit"
  | "unknown-implicated-unit"
  | "missing-source-fact"
  | "source-hash-mismatch"
  | "malformed-source-skeleton";

/** A loud, typed refusal from scope derivation. Raised BEFORE any dispatch, so a
 * bundle that is not a genuine per-unit repair never reaches the model. */
export class ScopeError extends Error {
  constructor(
    readonly code: ScopeFailureCode,
    detail: string,
  ) {
    super(`p2 scope ${code}: ${detail}`);
    this.name = "ScopeError";
  }
}

const PLACEHOLDER_TOKEN = /\{\{([^{}]+)\}\}/gu;

/** Cheap sanity guard that the placeholder manifest describes the skeleton: the
 * masked {{id}} tokens are exactly the manifest ids, one to one. An accurate
 * manifest is what lets the finalize preservation check protect the byte patch. */
function checkPlaceholderManifest(
  sourceSkeleton: string,
  protectedPlaceholders: readonly { readonly placeholderId: string }[],
): string | null {
  const manifest = new Set<string>();
  for (const placeholder of protectedPlaceholders) {
    if (manifest.has(placeholder.placeholderId)) {
      return `declares a duplicate placeholder ${placeholder.placeholderId}`;
    }
    manifest.add(placeholder.placeholderId);
  }
  const seen = new Set<string>();
  for (const match of sourceSkeleton.matchAll(PLACEHOLDER_TOKEN)) {
    const id = match[1]!;
    if (!manifest.has(id)) return `skeleton names an unmanifested placeholder ${id}`;
    if (seen.has(id)) return `skeleton repeats placeholder ${id}`;
    seen.add(id);
  }
  if (seen.size !== manifest.size) return "a manifest placeholder is absent from the skeleton";
  return null;
}

function indexCurrentDraft(currentDraft: DraftBatch): Map<string, CurrentUnit> {
  const byUnit = new Map<string, CurrentUnit>();
  for (const [position, draft] of currentDraft.drafts.entries()) {
    if (byUnit.has(draft.unitId)) {
      throw new ScopeError("duplicate-current-unit", `unit ${draft.unitId} appears twice`);
    }
    byUnit.set(draft.unitId, { unitId: draft.unitId, draft });
    void position;
  }
  return byUnit;
}

function scopeDefect(defect: Defect): ScopedDefect {
  return {
    defectId: defect.defectId,
    unitId: defect.unitId,
    severity: defect.severity,
    category: defect.category,
    repairConstraint: defect.repairConstraint,
    span: defect.span,
  };
}

/**
 * Derive the edit scope: exactly the implicated units, their source facts, and
 * their scoped defects. Fails loud when the bundle is not a repair, is empty, or
 * does not describe THIS draft/snapshot, or when an implicated unit is unknown to
 * the draft or lacks a matching source fact.
 */
export function deriveEditScope(
  currentDraft: DraftBatch,
  defectBundle: DefectBundle,
  units: readonly UnitFact[],
): EditScope {
  // The Line Editor acts ONLY on a repair bundle — an adjudication, escalation,
  // or resolved bundle is not its work and is refused before any dispatch.
  if (defectBundle.resolution !== "repair") {
    throw new ScopeError(
      "not-a-repair-bundle",
      `resolution ${defectBundle.resolution} is not a per-unit repair`,
    );
  }
  if (defectBundle.defects.length === 0) {
    throw new ScopeError("empty-defect-bundle", "a repair bundle names at least one defect");
  }
  if (defectBundle.draftBatchId !== currentDraft.batchId) {
    throw new ScopeError(
      "bundle-batch-mismatch",
      `bundle targets ${defectBundle.draftBatchId}, current draft is ${currentDraft.batchId}`,
    );
  }
  if (defectBundle.localizationSnapshotId !== currentDraft.localizationSnapshotId) {
    throw new ScopeError(
      "snapshot-mismatch",
      "bundle and current draft disagree on the localization snapshot",
    );
  }

  const currentByUnit = indexCurrentDraft(currentDraft);
  const factByUnit = new Map<string, UnitFact>(units.map((fact) => [fact.value.unitId, fact]));

  // Implicated ids: the defects' units, de-duplicated and ordered by the current
  // draft's play order so the patch batch and thread are deterministic.
  const orderOf = new Map<string, number>();
  currentDraft.drafts.forEach((draft, index) => orderOf.set(draft.unitId, index));
  const defectsByUnit = new Map<string, ScopedDefect[]>();
  for (const defect of defectBundle.defects) {
    if (!currentByUnit.has(defect.unitId)) {
      throw new ScopeError(
        "unknown-implicated-unit",
        `defect ${defect.defectId} names unit ${defect.unitId}, absent from the current draft`,
      );
    }
    const list = defectsByUnit.get(defect.unitId) ?? [];
    list.push(scopeDefect(defect));
    defectsByUnit.set(defect.unitId, list);
  }
  const implicatedUnitIds = [...defectsByUnit.keys()].sort(
    (left, right) => orderOf.get(left)! - orderOf.get(right)!,
  );

  const implicatedSource = new Map<string, ImplicatedSource>();
  for (const unitId of implicatedUnitIds) {
    const fact = factByUnit.get(unitId);
    if (!fact) {
      throw new ScopeError("missing-source-fact", `implicated unit ${unitId} has no source fact`);
    }
    const value = fact.value;
    if (value.sourceHash !== currentByUnit.get(unitId)!.draft.sourceHash) {
      throw new ScopeError(
        "source-hash-mismatch",
        `unit ${unitId} source fact hash disagrees with the current draft`,
      );
    }
    const detail = checkPlaceholderManifest(value.sourceSkeleton, value.protectedPlaceholders);
    if (detail !== null) {
      throw new ScopeError("malformed-source-skeleton", `unit ${unitId} ${detail}`);
    }
    implicatedSource.set(unitId, {
      unitId,
      sourceHash: value.sourceHash,
      sourceSkeleton: value.sourceSkeleton,
      protectedPlaceholders: value.protectedPlaceholders.map((placeholder) => ({
        placeholderId: placeholder.placeholderId,
        kind: placeholder.kind,
        sourceText: placeholder.sourceText,
      })),
    });
  }

  return {
    parentDraftBatchId: currentDraft.batchId,
    defectBundleId: defectBundle.bundleId,
    localizationSnapshotId: currentDraft.localizationSnapshotId,
    implicatedUnitIds,
    currentByUnit,
    implicatedSource,
    defectsByUnit,
  };
}
