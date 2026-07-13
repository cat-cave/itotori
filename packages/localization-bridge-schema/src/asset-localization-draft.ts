// ITOTORI-041 — Asset-localization drafting / QA / patch-export wire schema.
//
// The dialogue text loop (draft-artifact-bundle.ts + qa-finding.ts +
// patch-export-bundle.ts) drafts a source UNIT, annotates it with QA, and
// exports a patch payload. THIS module is the distinct-but-parallel wire
// contract for IMAGE / UI text and other asset-localization payloads once
// OCR (KAIFUU-026 `asset-ocr`) and the asset inventory / media surface
// (KAIFUU-059 `media_surface`) exist.
//
// Two invariants are load-bearing and mirror the upstream Kaifuu rules:
//
//   1. OCR output is EVIDENCE, never asserted ground-truth translation
//      source (KAIFUU-026). A draft therefore carries its OCR provenance +
//      confidence + `sourceUncertain`, so a QA finding can flag an uncertain
//      source region instead of silently trusting it.
//
//   2. Unsupported engine asset patching stays EXPLICIT (KAIFUU-059
//      `MediaSurfaceError` / candidate-not-truth). An asset text draft that an
//      engine cannot patch becomes a TYPED `AssetPatchRefusal`, never
//      a silently dropped asset. "Asset localization does not pretend every
//      asset is editable."
//
// The dialogue loop is NOT reused wholesale: an asset draft keys off an OCR
// text region (asset ref + region id + pixel provenance), not a source-unit
// id + character offsets, and asset QA has its own category taxonomy
// (layout-risk, uncertain-ocr-source). What IS reused is the shape discipline
// (schema-versioned closed enums + strict assertions + typed refusals).

export const ASSET_TEXT_DRAFT_SCHEMA_VERSION = "itotori.asset-text-draft.v1" as const;

// ---------------------------------------------------------------------------
// Closed enums
// ---------------------------------------------------------------------------

/**
 * Localization policies that PRODUCE a translated text payload for an asset.
 * A strict subset of the `assetLocalizationDecisionPolicyValues` wire enum:
 * `keep_original`, `skip`, and `swap_with_replacement` do not yield a drafted
 * text string, so they are not draftable policies here.
 */
export const ASSET_TEXT_DRAFT_POLICIES = ["translate_text", "romanize", "full_localize"] as const;
export type AssetTextDraftPolicy = (typeof ASSET_TEXT_DRAFT_POLICIES)[number];

/** OCR confidence bucket carried through from the KAIFUU-026 recognition. */
export const ASSET_OCR_CONFIDENCES = ["high", "medium", "low"] as const;
export type AssetOcrConfidence = (typeof ASSET_OCR_CONFIDENCES)[number];

/** Asset QA severities. Mirrors the dialogue QA taxonomy (qa-finding.ts). */
export const ASSET_QA_FINDING_SEVERITIES = ["critical", "major", "minor", "info"] as const;
export type AssetQaFindingSeverity = (typeof ASSET_QA_FINDING_SEVERITIES)[number];

/**
 * Asset-specific QA categories. `layout-risk` and `uncertain-ocr-source` are
 * the two categories with no dialogue analogue — they are the reason this is
 * a distinct taxonomy and not the dialogue `QaFindingCategory` reused.
 */
export const ASSET_QA_FINDING_CATEGORIES = [
  "mismatch",
  "layout-risk",
  "uncertain-ocr-source",
  "empty-draft",
  "glossary-conflict",
  "other",
] as const;
export type AssetQaFindingCategory = (typeof ASSET_QA_FINDING_CATEGORIES)[number];

/**
 * Patch-back modes an engine can honor for a patchable asset text draft.
 * `re_encrypt_same_key` mirrors KAIFUU-059 `PatchBackMode::ReEncryptSameKey`
 * (RPG Maker MV/MZ text-bearing surface); the redraw / replacement / metadata
 * modes mirror the `ImageReplacementMode` / `AssetPolicyPatchMode` families.
 */
export const ASSET_PATCH_BACK_MODES = [
  "re_encrypt_same_key",
  "region_redraw",
  "asset_replacement",
  "metadata_only",
] as const;
export type AssetPatchBackMode = (typeof ASSET_PATCH_BACK_MODES)[number];

/**
 * Typed reasons an automatically drafted asset cannot be patched.
 * Every value is a capability error — never a silent drop or approval gate.
 *
 *   - `unsupported_engine`          — the engine's `patch` capability is not
 *                                     supported/partial (engine-capability-matrix).
 *   - `inventory_only`              — the asset is inventoried but not a
 *                                     localization surface (KAIFUU-059).
 *   - `key_absent`                  — encrypted media whose key is absent
 *                                     (KAIFUU-059 `HeldPendingKey`).
 *   - `capability_mismatch`         — surface is patchable in principle but the
 *                                     requested patch-back mode is unavailable.
 *   - `not_a_localization_surface`  — the profiled role is not text-bearing.
 */
export const ASSET_PATCH_REFUSAL_REASONS = [
  "unsupported_engine",
  "inventory_only",
  "key_absent",
  "capability_mismatch",
  "not_a_localization_surface",
] as const;
export type AssetPatchRefusalReason = (typeof ASSET_PATCH_REFUSAL_REASONS)[number];

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/**
 * Ties an asset draft back to its asset provenance / inventory ref. Every
 * field is derived from the KAIFUU-026 OCR text region + KAIFUU-059 media
 * surface — the draft is never severed from the region it came from.
 */
export type AssetTextProvenance = {
  /** Inventory ref of the whole asset (media-surface / bridge asset ref). */
  assetRef: string;
  /** Human/inventory asset name (e.g. `title-card.png`). */
  assetName: string;
  /** sha256 of the whole source asset bytes. */
  assetContentHash: string;
  /** OCR region id inside the asset (e.g. `region-0001`). */
  regionId: string;
  /** sha256 of the region crop the OCR ran on. */
  regionContentHash: string;
  /** Pixel bounds of the region within the asset. */
  region: { x: number; y: number; width: number; height: number };
  /** OCR confidence bucket for the recovered/candidate source text. */
  ocrConfidence: AssetOcrConfidence;
  /**
   * True iff the OCR source is UNCERTAIN (a candidate, not an exact match).
   * A draft off an uncertain region is still allowed — but QA MUST flag it.
   */
  sourceUncertain: boolean;
  /** Upstream node that produced the provenance (e.g. `KAIFUU-026`). */
  ocrSourceNodeId: string;
};

/**
 * An asset (image / UI) text draft record. Distinct-but-parallel to the
 * dialogue `PatchExportDraft`: a `draftText` translation of an OCR'd
 * `sourceText`, keyed by region provenance instead of a source-unit id.
 */
export type AssetTextDraft = {
  schemaVersion: typeof ASSET_TEXT_DRAFT_SCHEMA_VERSION;
  draftId: string;
  assetKind: string;
  policy: AssetTextDraftPolicy;
  /** Recovered (exact) or candidate (uncertain) OCR text for the region. */
  sourceText: string;
  /** The drafted target-locale text for the region. */
  draftText: string;
  provenance: AssetTextProvenance;
  sourceRegionHash: string;
  draftUnitHash: string;
};

/**
 * A QA finding against an asset draft. Parallels the dialogue `QaFinding`
 * but keyed by `assetDraftId` + `regionId` (not `bridgeUnitId`) and using the
 * asset QA taxonomy.
 */
export type AssetQaFinding = {
  findingId: string;
  assetDraftId: string;
  regionId: string;
  severity: AssetQaFindingSeverity;
  category: AssetQaFindingCategory;
  message: string;
  recommendation: string;
  evidenceRefs: string[];
};

/** An automatically generated, engine-patchable asset draft → a patch directive. */
export type AssetPatchDirective = {
  kind: "patch";
  assetRef: string;
  assetKind: string;
  regionId: string;
  policy: AssetTextDraftPolicy;
  draftText: string;
  patchBackMode: AssetPatchBackMode;
  /** The source draft that produced this patch directive. */
  draftId: string;
  /** QA annotations travel with the patch but never gate it. */
  qaFindings: AssetQaFinding[];
  provenance: AssetTextProvenance;
};

/**
 * The EXPLICIT typed refusal: an asset draft that cannot become a patch is
 * surfaced with a reason and detail, never dropped.
 */
export type AssetPatchRefusal = {
  kind: "explicit_refusal";
  assetRef: string;
  assetKind: string;
  regionId: string;
  reason: AssetPatchRefusalReason;
  detail: string;
  draftId: string;
};

export type AssetExportOutcome = AssetPatchDirective | AssetPatchRefusal;

// ---------------------------------------------------------------------------
// Validation surface
// ---------------------------------------------------------------------------

export class AssetLocalizationDraftValidationError extends Error {
  constructor(
    public readonly path: string,
    public readonly rule: string,
    public readonly detail: string,
  ) {
    super(`AssetLocalizationDraft.${path} failed rule '${rule}': ${detail}`);
    this.name = "AssetLocalizationDraftValidationError";
  }
}

const err = (path: string, rule: string, detail: string): AssetLocalizationDraftValidationError =>
  new AssetLocalizationDraftValidationError(path, rule, detail);

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string") {
    throw err(path, "type", "expected string");
  }
  if (value.length === 0) {
    throw err(path, "minLength", "must be non-empty");
  }
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string") {
    throw err(path, "type", "expected string");
  }
}

function assertFiniteNumber(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw err(path, "type", "expected finite number");
  }
}

function assertEnum(
  value: unknown,
  allowed: ReadonlyArray<string>,
  path: string,
): asserts value is string {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw err(path, "enum", `must be one of [${allowed.join(", ")}]`);
  }
}

function assertObject(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw err(path, "type", "expected object");
  }
}

function assertProvenance(value: unknown, path: string): asserts value is AssetTextProvenance {
  assertObject(value, path);
  const record = value as Record<string, unknown>;
  assertNonEmptyString(record.assetRef, `${path}.assetRef`);
  assertNonEmptyString(record.assetName, `${path}.assetName`);
  assertNonEmptyString(record.assetContentHash, `${path}.assetContentHash`);
  assertNonEmptyString(record.regionId, `${path}.regionId`);
  assertNonEmptyString(record.regionContentHash, `${path}.regionContentHash`);
  assertObject(record.region, `${path}.region`);
  const region = record.region as Record<string, unknown>;
  assertFiniteNumber(region.x, `${path}.region.x`);
  assertFiniteNumber(region.y, `${path}.region.y`);
  assertFiniteNumber(region.width, `${path}.region.width`);
  assertFiniteNumber(region.height, `${path}.region.height`);
  assertEnum(record.ocrConfidence, ASSET_OCR_CONFIDENCES, `${path}.ocrConfidence`);
  if (typeof record.sourceUncertain !== "boolean") {
    throw err(`${path}.sourceUncertain`, "type", "expected boolean");
  }
  assertNonEmptyString(record.ocrSourceNodeId, `${path}.ocrSourceNodeId`);
}

export function assertAssetTextDraft(value: unknown): asserts value is AssetTextDraft {
  assertObject(value, "");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== ASSET_TEXT_DRAFT_SCHEMA_VERSION) {
    throw err(
      "schemaVersion",
      "const",
      `expected ${ASSET_TEXT_DRAFT_SCHEMA_VERSION}, got ${String(record.schemaVersion)}`,
    );
  }
  assertNonEmptyString(record.draftId, "draftId");
  assertNonEmptyString(record.assetKind, "assetKind");
  assertEnum(record.policy, ASSET_TEXT_DRAFT_POLICIES, "policy");
  // sourceText may legitimately be empty when the OCR region is unrecognized
  // but a draft was still authored manually; draftText must be a string.
  assertString(record.sourceText, "sourceText");
  assertString(record.draftText, "draftText");
  assertProvenance(record.provenance, "provenance");
  assertNonEmptyString(record.sourceRegionHash, "sourceRegionHash");
  assertNonEmptyString(record.draftUnitHash, "draftUnitHash");
}

export function assertAssetQaFinding(value: unknown): asserts value is AssetQaFinding {
  assertObject(value, "");
  const record = value as Record<string, unknown>;
  assertNonEmptyString(record.findingId, "findingId");
  assertNonEmptyString(record.assetDraftId, "assetDraftId");
  assertNonEmptyString(record.regionId, "regionId");
  assertEnum(record.severity, ASSET_QA_FINDING_SEVERITIES, "severity");
  assertEnum(record.category, ASSET_QA_FINDING_CATEGORIES, "category");
  assertNonEmptyString(record.message, "message");
  assertNonEmptyString(record.recommendation, "recommendation");
  if (!Array.isArray(record.evidenceRefs)) {
    throw err("evidenceRefs", "type", "expected array");
  }
  for (const [index, ref] of record.evidenceRefs.entries()) {
    assertNonEmptyString(ref, `evidenceRefs[${index}]`);
  }
}

export function assertAssetExportOutcome(value: unknown): asserts value is AssetExportOutcome {
  assertObject(value, "");
  const record = value as Record<string, unknown>;
  assertNonEmptyString(record.assetRef, "assetRef");
  assertNonEmptyString(record.assetKind, "assetKind");
  assertNonEmptyString(record.regionId, "regionId");
  assertNonEmptyString(record.draftId, "draftId");
  if (record.kind === "patch") {
    assertEnum(record.policy, ASSET_TEXT_DRAFT_POLICIES, "policy");
    assertString(record.draftText, "draftText");
    assertEnum(record.patchBackMode, ASSET_PATCH_BACK_MODES, "patchBackMode");
    if (!Array.isArray(record.qaFindings)) {
      throw err("qaFindings", "type", "expected array");
    }
    for (const finding of record.qaFindings) {
      assertAssetQaFinding(finding);
    }
    assertProvenance(record.provenance, "provenance");
    return;
  }
  if (record.kind === "explicit_refusal") {
    assertEnum(record.reason, ASSET_PATCH_REFUSAL_REASONS, "reason");
    assertNonEmptyString(record.detail, "detail");
    return;
  }
  throw err("kind", "enum", "must be 'patch' or 'explicit_refusal'");
}

/** True iff the outcome is an explicit typed refusal (never a silent drop). */
export function isAssetPatchRefusal(outcome: AssetExportOutcome): outcome is AssetPatchRefusal {
  return outcome.kind === "explicit_refusal";
}
