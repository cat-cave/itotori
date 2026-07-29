// PatchExportBundle wire schema.
//
// The patch-export service (apps/itotori/src/patch-export/exporter.ts)
// emits one of these bundles per successful run. The bundle is the
// **engine-agnostic** patch-ready payload Kaifuu consumes; itotori is the
// source of truth for translation drafts, protected-span mappings, asset
// decisions, and preflight evidence, and Kaifuu only sees the v0.2 shape.
//
// No partial bundle is ever produced: if any blocking preflight check
// fails, the exporter returns a typed `PreflightFailure` instead of a
// bundle. The schema therefore embeds the FULL preflight result list as
// a first-class field so the proof of soundness travels with the
// bundle.
//
// Source compatibility metadata is required:
//   - `sourceBridgeHash` proves the bundle was drafted against the
//     current source bridge bundle's hash.
//   - `provenance.draftArtifactBundleId` names the upstream draft
//     bundle.
//
// Protected-span mappings are required: every span the source declared
// MUST appear here with a draft-side range. The exporter rejects a
// draft that lost a span (the preflight `protectedSpanCoverage` check
// catches this).

import { type NonBlankTargetText } from "./target-text.js";

// v3 removes the obsolete all-drafts-accepted gate and tightens emitted target
// bodies to the same non-blank, non-source-replay invariant as WrittenUnitOutcome.
export const PATCH_EXPORT_BUNDLE_SCHEMA_VERSION = "itotori.patch-export-bundle.v3" as const;

// ---------------------------------------------------------------------------
// Closed enums
// ---------------------------------------------------------------------------

/**
 * Closed enum of preflight checks the exporter runs. Each value
 * corresponds to one method on `PatchExportPreflight` in the app
 * package. The schema owns the wire enum; the app owns the runtime
 * check; the asserter rejects unknown values so a downstream consumer
 * never sees a check it does not know how to display.
 */
export const PATCH_EXPORT_PREFLIGHT_CHECK_KINDS = [
  "sourceBridgeIntegrity",
  "noUnresolvedAssetDecisions",
  "protectedSpanCoverage",
  "qaScoreThreshold",
  "glossaryConsistency",
] as const;
export type PatchExportPreflightCheckKind = (typeof PATCH_EXPORT_PREFLIGHT_CHECK_KINDS)[number];

export const PATCH_EXPORT_PREFLIGHT_STATUSES = ["pass", "fail", "warn"] as const;
export type PatchExportPreflightStatus = (typeof PATCH_EXPORT_PREFLIGHT_STATUSES)[number];

/**
 * Protected-span mapping kind. Mirrors
 * `apps/itotori/src/draft/protected-span-validator.ts`'s
 * `DRAFT_PROTECTED_SPAN_KINDS` enum; the schema owns the wire enum so
 * Kaifuu can branch on the patch-time preservation rule without
 * reaching back into the validator package.
 */
export const PATCH_EXPORT_PROTECTED_SPAN_KINDS = [
  "source_unit",
  "markup",
  "variable",
  "glossary",
] as const;
export type PatchExportProtectedSpanKind = (typeof PATCH_EXPORT_PROTECTED_SPAN_KINDS)[number];

/**
 * Preservation rule the patcher MUST enforce when writing the draft
 * text back into the source asset. The enum is closed; new rules
 * require a schema-version bump.
 *
 *   - `verbatim`               — span MUST appear byte-equal in the
 *                                draft (variables, markup, do-not-translate).
 *   - `case_preserving`        — glossary term MUST appear with the
 *                                documented capitalization.
 *   - `markup_well_formed`     — markup span MUST parse cleanly (no
 *                                unbalanced tags).
 */
export const PATCH_EXPORT_PROTECTED_SPAN_PRESERVATION_RULES = [
  "verbatim",
  "case_preserving",
  "markup_well_formed",
] as const;
export type PatchExportProtectedSpanPreservationRule =
  (typeof PATCH_EXPORT_PROTECTED_SPAN_PRESERVATION_RULES)[number];

/**
 * Closed enum mirroring the asset-decision policy values from
 * `@itotori/db`'s `assetLocalizationDecisionPolicyValues`. The patch
 * export bundle carries the resolved policy as a literal string so
 * Kaifuu never has to call back into itotori to learn what action to
 * take. The asserter rejects unknown values.
 */
export const PATCH_EXPORT_ASSET_DECISION_POLICIES = [
  "keep_original",
  "translate_text",
  "swap_with_replacement",
  "romanize",
  "full_localize",
  "skip",
] as const;
export type PatchExportAssetDecisionPolicy = (typeof PATCH_EXPORT_ASSET_DECISION_POLICIES)[number];

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export type ProtectedSpanMapping = {
  spanRef: string;
  sourceStart: number;
  sourceEnd: number;
  draftStart: number;
  draftEnd: number;
  kind: PatchExportProtectedSpanKind;
  preservationRule: PatchExportProtectedSpanPreservationRule;
};

export type PatchExportDraft = {
  sourceUnitId: string;
  draftId: string;
  sourceText: string;
  draftText: NonBlankTargetText;
  protectedSpanMappings: ProtectedSpanMapping[];
  sourceUnitHash: string;
  draftUnitHash: string;
};

export type PatchExportAssetDecision = {
  assetRef: string;
  assetKind: string;
  policy: PatchExportAssetDecisionPolicy;
  decisionId: string;
  rationale?: string;
};

export type PreflightResult = {
  check: PatchExportPreflightCheckKind;
  status: PatchExportPreflightStatus;
  detail?: string;
  blockingExport: boolean;
};

export type PatchExportProvenance = {
  draftArtifactBundleId: string;
  agreedQaScore?: number;
  exportedAt: string;
  exportedByUserId: string;
};

export type PatchExportBundle = {
  schemaVersion: typeof PATCH_EXPORT_BUNDLE_SCHEMA_VERSION;
  projectId: string;
  localeBranchId: string;
  sourceBridgeHash: string;
  targetLocale: string;
  drafts: PatchExportDraft[];
  assetDecisions: PatchExportAssetDecision[];
  preflightResults: PreflightResult[];
  provenance: PatchExportProvenance;
};

// ---------------------------------------------------------------------------
// Validation surface
// ---------------------------------------------------------------------------

export class PatchExportBundleValidationError extends Error {
  constructor(
    public readonly path: string,
    public readonly rule: string,
    public readonly detail: string,
  ) {
    super(`PatchExportBundle.${path} failed rule '${rule}': ${detail}`);
    this.name = "PatchExportBundleValidationError";
  }
}
