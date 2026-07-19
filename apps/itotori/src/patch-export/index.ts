// ITOTORI-025 — public surface of the patch-export module.
//
// Bundles preflight, exporter, kaifuu-handoff, and CLI behind one
// import path so callers don't have to reach across files.

export {
  PatchExportPreflight,
  type DraftGlossaryRendering,
  type PatchExportPreflightDeps,
  type PreflightAssetResolutionLookup,
  type PreflightInput,
  type ScoredFindingsReport,
} from "./preflight.js";

export {
  PatchExporter,
  PatchExporterIdentityMismatchError,
  DeliveredPatchExporter,
  type DraftArtifactBundleLoad,
  type DeliveredPatchExportInput,
  type DraftArtifactBundleLoaderPort,
  type PatchExportInput,
  type PatchExporterDeps,
  type PreflightFailure,
  type SourceBridgeViewLoaderPort,
  type SelectedPatchDeliveryLoaderPort,
} from "./exporter.js";

export {
  createDeliveredPatchArchive,
  type DeliveredPatchArchive,
  type PatchDeliveryManifest,
} from "./delivery-archive.js";

export {
  prepareKaifuuPatchPayload,
  type KaifuuPatchAssetDirective,
  type KaifuuPatchPayload,
  type KaifuuPatchUnit,
} from "./kaifuu-handoff.js";

export {
  ExportPatchV2LocaleMismatchError,
  runExportPatchV2Command,
  type ExportPatchV2CliArgs,
  type ExportPatchV2CliIo,
  type PatchExportV2ProjectFixture,
  type PatchExportV2ProjectFixtureAssetRef,
  type PatchExportV2ProjectFixtureGlossaryTerm,
  type PatchExportV2ProjectFixtureSpan,
  type PatchExportV2ProjectFixtureUnit,
} from "./cli.js";

export {
  SourceBridgeViewLookupError,
  lookupSourceBridgeUnit,
  type SourceBridgeAssetRef,
  type SourceBridgeGlossaryTerm,
  type SourceBridgeProtectedSpan,
  type SourceBridgeUnit,
  type SourceBridgeView,
} from "./source-bridge-view.js";
