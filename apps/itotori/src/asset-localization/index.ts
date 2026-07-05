// ITOTORI-041 — public surface of the asset-localization drafting / QA /
// review / export loop.

export {
  ASSET_LAYOUT_EXPANSION_RATIO,
  ASSET_REVIEW_ACTIONS,
  ASSET_REVIEW_STATES,
  ASSET_SURFACE_ROLES,
  buildAssetExportOutcome,
  buildAssetReviewItem,
  decideAssetReview,
  draftableRegions,
  draftAssetTextFromRegion,
  draftAssetTexts,
  isBlockingAssetFinding,
  isLocalizationSurfaceRole,
  runAssetDraftQa,
  type AssetEngineCapability,
  type AssetOcrDocument,
  type AssetOcrRegionSource,
  type AssetReviewAction,
  type AssetReviewDecision,
  type AssetReviewItem,
  type AssetReviewState,
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
