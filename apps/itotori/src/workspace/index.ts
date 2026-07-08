// ITOTORI-040 — public surface of the localization reviewer workspace.

export { workspaceDiagnosticCodeValues, workspaceSearchModeValues } from "./read-model.js";
export type {
  WorkspaceAssetBrowseReadModel,
  WorkspaceAssetEntry,
  WorkspaceComparisonCell,
  WorkspaceComparisonReadModel,
  WorkspaceDiagnostic,
  WorkspaceDiagnosticCode,
  WorkspaceLocaleBranchSummary,
  WorkspacePermissionView,
  WorkspaceProjectBrowseReadModel,
  WorkspaceProjectSummary,
  WorkspaceRuntimeEvidenceLink,
  WorkspaceSceneBrowseReadModel,
  WorkspaceSceneContext,
  WorkspaceSceneUnit,
  WorkspaceSearchMode,
  WorkspaceSearchReadModel,
  WorkspaceSearchResult,
} from "./read-model.js";

export {
  LocalizationWorkspaceApiService,
  workspaceAssetBrowsePath,
  workspaceComparisonPath,
  workspaceSceneBrowsePath,
  workspaceSearchPath,
} from "./api-service.js";
export type {
  LoadWorkspaceAssetBrowseInput,
  LoadWorkspaceComparisonInput,
  LoadWorkspaceProjectBrowseInput,
  LoadWorkspaceSceneBrowseInput,
  LoadWorkspaceSearchInput,
  LocalizationWorkspaceApiServiceDeps,
  LocalizationWorkspaceApiServicePort,
  LocalizationWorkspaceReadPort,
} from "./api-service.js";

// fnd-spa-shell — the HTML-string workspace VIEW renderers were deleted; the
// React `WorkspaceScreen` renders these read-models now. Routing (parse +
// API-target mapping) stays here as pure, framework-agnostic utilities.
export { parseWorkspaceRoute, workspaceRouteApiTarget, workspaceRoutePathRegex } from "./route.js";
export type { WorkspaceRoute } from "./route.js";

// ITOTORI-118 — workspace manual-correction mutation layer.
export {
  workspaceCorrectionDiagnosticCodeValues,
  workspaceCorrectionDispositionValues,
} from "./correction-model.js";
export type {
  WorkspaceCorrectionDiagnostic,
  WorkspaceCorrectionDiagnosticCode,
  WorkspaceCorrectionDisposition,
  WorkspaceCorrectionEditView,
  WorkspaceCorrectionGlossaryRef,
  WorkspaceCorrectionPermissionView,
  WorkspaceCorrectionPreviewReadModel,
  WorkspaceCorrectionPreviewUnit,
  WorkspaceCorrectionSubmitReadModel,
  WorkspaceCorrectionWritebackView,
} from "./correction-model.js";
export { WorkspaceCorrectionFeedbackLoop } from "./correction-feedback-loop.js";
export type {
  WorkspaceCorrectionFeedbackLoopDeps,
  WorkspaceCorrectionFeedbackLoopPort,
  WorkspaceCorrectionGlossaryPort,
  WorkspaceCorrectionTranslationMemoryPort,
  WorkspaceCorrectionWritebackInput,
  WorkspaceCorrectionWritebackResult,
} from "./correction-feedback-loop.js";
export { WorkspaceCorrectionService } from "./correction-service.js";
export type {
  LoadWorkspaceCorrectionPreviewInput,
  SubmitWorkspaceCorrectionsInput,
  WorkspaceCorrectionComparisonPort,
  WorkspaceCorrectionEditPersistPort,
  WorkspaceCorrectionServiceDeps,
  WorkspaceCorrectionServicePort,
  WorkspaceCorrectionSubmission,
} from "./correction-service.js";
export { renderWorkspaceCorrectionPreviewView } from "./correction-view.js";

export {
  itotori040FixtureLocaleBranchId,
  itotori040FixtureProjectId,
  itotori040FixtureSourceRevisionId,
  workspaceAssetBrowseFixture,
  workspaceComparisonFixture,
  workspaceDeniedComparisonFixture,
  workspaceDeniedPermissionFixture,
  workspaceProjectBrowseFixture,
  workspaceReaderPermissionFixture,
  workspaceSceneBrowseFixture,
  workspaceSearchFixture,
} from "./fixtures.js";
