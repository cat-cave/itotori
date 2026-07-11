// ITOTORI-025 — SourceBridgeView.
//
// The patch-export preflight needs to know the current source bridge's
// hash (for the `sourceBridgeIntegrity` check), the per-source-unit
// text + hash (so we can populate `PatchExportDraft.sourceText` and
// detect a stale bundle), and the protected-span ranges on the source
// side (so we can verify every draft mapping covers a declared span).
//
// In production this view is projected from a v0.2 BridgeBundleV02; in
// the fixture path it loads from disk as a `SourceBridgeViewFixture`
// shape. The exporter does NOT depend on `BridgeBundleV02` directly —
// it only sees the narrow surface below — so the same exporter runs
// against either source.

import type {
  PatchExportProtectedSpanKind,
  PatchExportProtectedSpanPreservationRule,
} from "@itotori/localization-bridge-schema";

export type SourceBridgeProtectedSpan = {
  spanRef: string;
  sourceStart: number;
  sourceEnd: number;
  sourceText: string;
  kind: PatchExportProtectedSpanKind;
  preservationRule: PatchExportProtectedSpanPreservationRule;
  /**
   * When true, this span is carried structurally (re-emitted from
   * opcodes/headers), NOT spliced into the body; the draft is not expected to
   * contain it, so the coverage/mapping checks skip it.
   */
  outOfBand?: boolean;
  /**
   * For `glossary` spans, the documented target-form the draft is
   * expected to use (e.g. "Hero" for 勇者). When set, the preflight
   * `protectedSpanCoverage` check accepts this form in the draft as
   * proof the span survived; the exporter uses it to build the
   * draft-side range for the patch.
   *
   * Required when `kind === 'glossary'`; ignored for other kinds.
   */
  expectedTargetForm?: string;
};

export type SourceBridgeUnit = {
  sourceUnitId: string;
  sourceText: string;
  sourceUnitHash: string;
  /**
   * Asset references the unit depends on. Used by the preflight
   * `noUnresolvedAssetDecisions` check — every ref here MUST resolve
   * to a non-`unresolved` policy.
   */
  assetRefs: ReadonlyArray<SourceBridgeAssetRef>;
  protectedSpans: ReadonlyArray<SourceBridgeProtectedSpan>;
  /**
   * Glossary terms the unit uses; the `glossaryConsistency` preflight
   * check warns when two units in the bundle resolve the same term to
   * different draft renderings.
   */
  glossaryTerms?: ReadonlyArray<SourceBridgeGlossaryTerm>;
};

export type SourceBridgeAssetRef = {
  kind: string;
  ref: string;
  assetKind: string;
};

export type SourceBridgeGlossaryTerm = {
  termId: string;
  sourceForm: string;
  expectedTargetForm: string;
};

export type SourceBridgeView = {
  projectId: string;
  localeBranchId: string;
  sourceBridgeHash: string;
  targetLocale: string;
  units: ReadonlyArray<SourceBridgeUnit>;
};

export class SourceBridgeViewLookupError extends Error {
  constructor(public readonly sourceUnitId: string) {
    super(`source-bridge view has no unit for sourceUnitId=${sourceUnitId}`);
    this.name = "SourceBridgeViewLookupError";
  }
}

export function lookupSourceBridgeUnit(
  view: SourceBridgeView,
  sourceUnitId: string,
): SourceBridgeUnit {
  const match = view.units.find((unit) => unit.sourceUnitId === sourceUnitId);
  if (match === undefined) {
    throw new SourceBridgeViewLookupError(sourceUnitId);
  }
  return match;
}
