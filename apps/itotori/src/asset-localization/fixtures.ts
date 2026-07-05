// ITOTORI-041 — synthetic fixtures for the asset-localization loop.
//
// Derived from the KAIFUU-026 public OCR golden
// (`fixtures/public/ocr-ui/title-card.text-regions.golden.json`) — a synthetic
// title card with an exact-match region, an uncertain candidate region, and a
// media-surface capability profile. No copyrighted bytes; deterministic.

import type { AssetEngineCapability, AssetOcrDocument, AssetTranslateFn } from "./loop.js";

const TITLE_CARD_HASH = "sha256:a5fe464bfb1fae0b0adb1e99a47f2cc7e56663dca5a7ac17ef7b66ce49aa221d";

/**
 * A synthetic OCR document: a "NEW GAME" title card whose "NEW" region is an
 * exact match and whose "LOAD" region is an uncertain candidate (mirrors the
 * KAIFUU-026 golden's region-0004 uncertain finding).
 */
export function titleCardOcrDocumentFixture(): AssetOcrDocument {
  return {
    assetRef: "bridgeAssetRef:title-card.png",
    assetKind: "imageWithText",
    sourceNodeId: "KAIFUU-026",
    regions: [
      {
        regionId: "region-0001",
        provenance: {
          x: 3,
          y: 3,
          width: 17,
          height: 7,
          assetName: "title-card.png",
          assetContentHash: TITLE_CARD_HASH,
        },
        contentHash: "sha256:e1d15dfb6c6fcbc8a1e871f65adcc65873d8774073ee5a0579a9d957262b74ca",
        recognition: {
          recoveredText: "NEW",
          confidence: "high",
          isUncertain: false,
        },
      },
      {
        regionId: "region-0004",
        provenance: {
          x: 3,
          y: 23,
          width: 23,
          height: 7,
          assetName: "title-card.png",
          assetContentHash: TITLE_CARD_HASH,
        },
        contentHash: "sha256:47091dc6f54eb8091ef055ba1beed5a880a4c127c5d8fb1e8e15df047ef9b643",
        recognition: {
          candidateText: "LOAD",
          confidence: "medium",
          isUncertain: true,
        },
      },
    ],
  };
}

/** Deterministic translate map (JA-neutral synthetic; no LLM). */
export function fixtureTranslateFn(overrides: Record<string, string> = {}): AssetTranslateFn {
  const table: Record<string, string> = {
    NEW: "NUEVO",
    LOAD: "CARGAR",
    ...overrides,
  };
  return (sourceText) => table[sourceText] ?? sourceText;
}

/** A supported engine: RPG Maker MV/MZ text-bearing surface, key present. */
export function supportedEngineCapabilityFixture(
  overrides: Partial<AssetEngineCapability> = {},
): AssetEngineCapability {
  return {
    engineFamily: "rpg_maker_mv_mz",
    patchStatus: "supported",
    surfaceRole: "text_bearing_image",
    keyAvailable: true,
    patchBackMode: "re_encrypt_same_key",
    ...overrides,
  };
}

/** An engine whose `patch` capability is unsupported (e.g. Siglus / KiriKiri). */
export function unsupportedEngineCapabilityFixture(
  overrides: Partial<AssetEngineCapability> = {},
): AssetEngineCapability {
  return {
    engineFamily: "siglus",
    patchStatus: "unsupported",
    surfaceRole: "text_bearing_image",
    keyAvailable: false,
    patchBackMode: null,
    ...overrides,
  };
}

/** A supported engine but the asset is inventory-only (not a surface). */
export function inventoryOnlyCapabilityFixture(
  overrides: Partial<AssetEngineCapability> = {},
): AssetEngineCapability {
  return {
    engineFamily: "rpg_maker_mv_mz",
    patchStatus: "supported",
    surfaceRole: "inventory_only",
    keyAvailable: true,
    patchBackMode: null,
    ...overrides,
  };
}

/** A supported text-bearing surface whose encrypted-media key is absent. */
export function keyAbsentCapabilityFixture(
  overrides: Partial<AssetEngineCapability> = {},
): AssetEngineCapability {
  return {
    engineFamily: "rpg_maker_mv_mz",
    patchStatus: "supported",
    surfaceRole: "text_bearing_image",
    keyAvailable: false,
    patchBackMode: "re_encrypt_same_key",
    ...overrides,
  };
}
