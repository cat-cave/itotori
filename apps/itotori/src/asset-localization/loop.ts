// Asset-localization drafting / QA / export loop.
//
// The dialogue loop drafts a source UNIT, attaches QA annotations, and exports
// a patch payload. This module is the parallel loop for IMAGE / UI text,
// consuming the asset-OCR text regions + media-surface capability, and
// honoring the two upstream rules: OCR output is evidence (never ground
// truth), and unsupported engine asset patching stays EXPLICIT (a typed
// refusal, never a silent drop).
//
// The four stages, each a pure function over synthetic-testable inputs:
//   1. draftAssetTexts        — OCR text regions      → AssetTextDraft[]
//   2. runAssetDraftQa        — AssetTextDraft        → AssetQaFinding[]
//   3. buildAssetExportOutcome — draft + annotations + capability →
//                                AssetExportOutcome (patch | refusal)

import { createHash } from "node:crypto";
import {
  ASSET_TEXT_DRAFT_SCHEMA_VERSION,
  type AssetExportOutcome,
  type AssetOcrConfidence,
  type AssetPatchBackMode,
  type AssetPatchRefusalReason,
  type AssetQaFinding,
  type AssetQaFindingSeverity,
  type AssetTextDraft,
  type AssetTextDraftPolicy,
  type AssetTextProvenance,
} from "@itotori/localization-bridge-schema";
import type { EngineCapabilityLevelStatus } from "../services/engine-capability-matrix.js";

// ---------------------------------------------------------------------------
// OCR source shapes (subset of the asset-OCR text-regions manifest)
// ---------------------------------------------------------------------------

export type AssetOcrRegionSource = {
  regionId: string;
  provenance: {
    x: number;
    y: number;
    width: number;
    height: number;
    assetName: string;
    assetContentHash: string;
  };
  /** sha256 of the region crop the OCR ran on. */
  contentHash: string;
  recognition: {
    /** Exact-match recovered text (undefined for uncertain / unrecognized). */
    recoveredText?: string;
    /** Best-effort candidate for an uncertain region (evidence, not truth). */
    candidateText?: string;
    confidence: AssetOcrConfidence;
    isUncertain: boolean;
  };
};

export type AssetOcrDocument = {
  /** Inventory ref of the whole asset (media-surface / bridge asset ref). */
  assetRef: string;
  /** Asset kind (e.g. `imageWithText`, `uiArt`). */
  assetKind: string;
  /** Upstream node id that produced the OCR (provenance). */
  sourceNodeId: string;
  regions: AssetOcrRegionSource[];
};

/**
 * Injected translation function. Kept as a dependency so tests use a
 * deterministic map / fixture and NEVER a live LLM call. In production this
 * is backed by the same TranslationAgent the dialogue loop uses.
 */
export type AssetTranslateFn = (
  sourceText: string,
  context: { policy: AssetTextDraftPolicy; region: AssetOcrRegionSource; assetKind: string },
) => string;

// ---------------------------------------------------------------------------
// Stage 1 — draft
// ---------------------------------------------------------------------------

/** Regions that carry some OCR text (recovered or candidate) are draftable. */
export function draftableRegions(doc: AssetOcrDocument): AssetOcrRegionSource[] {
  return doc.regions.filter((region) => ocrSourceText(region).length > 0);
}

function ocrSourceText(region: AssetOcrRegionSource): string {
  return region.recognition.recoveredText ?? region.recognition.candidateText ?? "";
}

function sha256(input: string): string {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

function buildProvenance(doc: AssetOcrDocument, region: AssetOcrRegionSource): AssetTextProvenance {
  return {
    assetRef: doc.assetRef,
    assetName: region.provenance.assetName,
    assetContentHash: region.provenance.assetContentHash,
    regionId: region.regionId,
    regionContentHash: region.contentHash,
    region: {
      x: region.provenance.x,
      y: region.provenance.y,
      width: region.provenance.width,
      height: region.provenance.height,
    },
    ocrConfidence: region.recognition.confidence,
    sourceUncertain: region.recognition.isUncertain,
    ocrSourceNodeId: doc.sourceNodeId,
  };
}

export function draftAssetTextFromRegion(
  doc: AssetOcrDocument,
  region: AssetOcrRegionSource,
  policy: AssetTextDraftPolicy,
  translate: AssetTranslateFn,
): AssetTextDraft {
  const sourceText = ocrSourceText(region);
  const draftText = translate(sourceText, { policy, region, assetKind: doc.assetKind });
  const draftId = `asset-draft-${doc.assetRef}-${region.regionId}`;
  return {
    schemaVersion: ASSET_TEXT_DRAFT_SCHEMA_VERSION,
    draftId,
    assetKind: doc.assetKind,
    policy,
    sourceText,
    draftText,
    provenance: buildProvenance(doc, region),
    sourceRegionHash: region.contentHash,
    draftUnitHash: sha256(`${draftId}|${draftText}`),
  };
}

export function draftAssetTexts(
  doc: AssetOcrDocument,
  policy: AssetTextDraftPolicy,
  translate: AssetTranslateFn,
): AssetTextDraft[] {
  return draftableRegions(doc).map((region) =>
    draftAssetTextFromRegion(doc, region, policy, translate),
  );
}

// ---------------------------------------------------------------------------
// Stage 2 — QA (deterministic; no LLM)
// ---------------------------------------------------------------------------

/**
 * A drafted image region has a FIXED pixel width. A target string that
 * expands past this ratio of the source risks overflowing the region — a
 * layout risk with no dialogue analogue (dialogue reflows in a text box).
 */
export const ASSET_LAYOUT_EXPANSION_RATIO = 1.6;

function finding(
  draft: AssetTextDraft,
  index: number,
  severity: AssetQaFindingSeverity,
  category: AssetQaFinding["category"],
  message: string,
  recommendation: string,
  evidenceRefs: string[],
): AssetQaFinding {
  return {
    findingId: `asset-qa-${draft.draftId}-${index}`,
    assetDraftId: draft.draftId,
    regionId: draft.provenance.regionId,
    severity,
    category,
    message,
    recommendation,
    evidenceRefs,
  };
}

export function runAssetDraftQa(draft: AssetTextDraft): AssetQaFinding[] {
  const findings: AssetQaFinding[] = [];
  const regionRef = `${draft.provenance.assetName}#${draft.provenance.regionId}`;

  if (draft.draftText.trim().length === 0) {
    findings.push(
      finding(
        draft,
        findings.length,
        "critical",
        "empty-draft",
        "asset draft text is empty; the region would be blanked",
        "author a target string for the region or record a keep_original decision instead",
        [regionRef, draft.draftUnitHash],
      ),
    );
  }

  if (draft.provenance.sourceUncertain) {
    findings.push(
      finding(
        draft,
        findings.length,
        "major",
        "uncertain-ocr-source",
        `OCR source for ${draft.provenance.regionId} is uncertain (confidence=${draft.provenance.ocrConfidence}); the draft rests on a candidate, not ground truth`,
        "confirm the source glyphs against the asset before producing a corrected patch",
        [regionRef, draft.provenance.regionContentHash],
      ),
    );
  }

  if (
    draft.policy === "translate_text" &&
    draft.sourceText.length > 0 &&
    draft.draftText === draft.sourceText
  ) {
    findings.push(
      finding(
        draft,
        findings.length,
        "minor",
        "mismatch",
        "translate_text draft is byte-identical to the source; the region was not translated",
        "translate the region or switch the decision to keep_original",
        [regionRef],
      ),
    );
  }

  if (
    draft.sourceText.length > 0 &&
    draft.draftText.length > draft.sourceText.length * ASSET_LAYOUT_EXPANSION_RATIO
  ) {
    findings.push(
      finding(
        draft,
        findings.length,
        "major",
        "layout-risk",
        `draft (${draft.draftText.length} chars) expands past ${ASSET_LAYOUT_EXPANSION_RATIO}x the source (${draft.sourceText.length}) in a ${draft.provenance.region.width}px region`,
        "shorten the target or plan a region redraw with a resized text box",
        [regionRef, `region-width:${draft.provenance.region.width}`],
      ),
    );
  }

  return findings;
}

/** A critical asset finding is an annotation for play-test follow-up. */
export function isBlockingAssetFinding(finding: AssetQaFinding): boolean {
  return finding.severity === "critical";
}

// ---------------------------------------------------------------------------
// Stage 3 — patch / export handoff (unsupported patching stays EXPLICIT)
// ---------------------------------------------------------------------------

/**
 * The engine-side patch capability for an asset. Distilled from the
 * engine-capability-matrix (`levels.patch.status`) + the media-surface
 * `MediaAssetDecision` (surface role, key availability, the honored
 * patch-back mode). Kaifuu classifies; Itotori decides — this is the
 * classification Itotori's decision is gated on.
 */
export const ASSET_SURFACE_ROLES = [
  "text_bearing_image",
  "ui_texture",
  "song_metadata",
  "inventory_only",
] as const;
export type AssetSurfaceRole = (typeof ASSET_SURFACE_ROLES)[number];

export type AssetEngineCapability = {
  engineFamily: string;
  /** The `patch` level status from the engine-capability matrix. */
  patchStatus: EngineCapabilityLevelStatus;
  /** Profiled localization role. */
  surfaceRole: AssetSurfaceRole;
  /** Decrypt state: is the plaintext (key) available? */
  keyAvailable: boolean;
  /** The patch-back mode the engine will honor, or null if none. */
  patchBackMode: AssetPatchBackMode | null;
};

export function isLocalizationSurfaceRole(role: AssetSurfaceRole): boolean {
  return role !== "inventory_only";
}

/**
 * Turn an asset draft into a patch directive — or, when the engine cannot
 * patch the asset, a TYPED explicit refusal. QA is retained as an annotation;
 * no manual confirmation step can withhold an otherwise patchable asset.
 *
 * Capability order (first match wins):
 *   1. engine patch unsupported         → unsupported_engine
 *   2. inventory-only (not a surface)   → inventory_only / not_a_localization_surface
 *   3. encrypted media key absent       → key_absent
 *   4. no honored patch-back mode       → capability_mismatch
 *   5. otherwise                        → patch directive with QA annotations
 */
export function buildAssetExportOutcome(
  draft: AssetTextDraft,
  findings: AssetQaFinding[],
  capability: AssetEngineCapability,
): AssetExportOutcome {
  const assetRef = draft.provenance.assetRef;
  const regionId = draft.provenance.regionId;
  const refuse = (reason: AssetPatchRefusalReason, detail: string): AssetExportOutcome => ({
    kind: "explicit_refusal",
    assetRef,
    assetKind: draft.assetKind,
    regionId,
    reason,
    detail,
    draftId: draft.draftId,
  });

  if (capability.patchStatus !== "supported" && capability.patchStatus !== "partial") {
    return refuse(
      "unsupported_engine",
      `engine '${capability.engineFamily}' patch capability is '${capability.patchStatus}'; asset patch-back is not available for this engine`,
    );
  }

  if (!isLocalizationSurfaceRole(capability.surfaceRole)) {
    return refuse(
      "inventory_only",
      `asset role '${capability.surfaceRole}' is inventory-only, not a localization surface; the asset is inventoried but not editable`,
    );
  }

  if (!capability.keyAvailable) {
    return refuse(
      "key_absent",
      `encrypted media key is absent for '${assetRef}'; the plaintext is held pending a key and cannot be re-encrypted`,
    );
  }

  if (capability.patchBackMode === null) {
    return refuse(
      "capability_mismatch",
      `engine '${capability.engineFamily}' declares no patch-back mode for role '${capability.surfaceRole}'`,
    );
  }

  return {
    kind: "patch",
    assetRef,
    assetKind: draft.assetKind,
    regionId,
    policy: draft.policy,
    draftText: draft.draftText,
    patchBackMode: capability.patchBackMode,
    draftId: draft.draftId,
    qaFindings: findings.map((finding) => ({
      ...finding,
      evidenceRefs: [...finding.evidenceRefs],
    })),
    provenance: draft.provenance,
  };
}
