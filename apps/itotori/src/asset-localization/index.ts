// ITOTORI-041 — public surface of the asset-localization drafting / QA /
// patch-export loop.

export {
  ASSET_LAYOUT_EXPANSION_RATIO,
  ASSET_SURFACE_ROLES,
  buildAssetExportOutcome,
  draftableRegions,
  draftAssetTextFromRegion,
  draftAssetTexts,
  isBlockingAssetFinding,
  isLocalizationSurfaceRole,
  runAssetDraftQa,
  type AssetEngineCapability,
  type AssetOcrDocument,
  type AssetOcrRegionSource,
  type AssetSurfaceRole,
  type AssetTranslateFn,
} from "./loop.js";

export {
  fixtureTranslateFn,
  inventoryOnlyCapabilityFixture,
  keyAbsentCapabilityFixture,
  supportedEngineCapabilityFixture,
  titleCardOcrDocumentFixture,
  unsupportedEngineCapabilityFixture,
} from "./fixtures.js";
