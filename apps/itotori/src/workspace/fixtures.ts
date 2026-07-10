// ITOTORI-040 — typed workspace read-model fixtures.
//
// These fixtures cover ONLY the workspace read-models (no upstream
// records, no cost ledgers) so the pure renderers + the API denied-path
// can be pinned deterministically. Upstream record fixtures
// (ProjectDashboardStatus, SceneSummaryRecord, etc.) live in the test
// tree to keep production `src/` free of cost literals.

import type { WorkspacePermissionView } from "./read-model.js";
import {
  workspaceDiagnosticCodeValues,
  workspaceSearchModeValues,
  workspaceSearchResultKindValues,
  type WorkspaceAssetBrowseReadModel,
  type WorkspaceComparisonReadModel,
  type WorkspaceProjectBrowseReadModel,
  type WorkspaceSceneBrowseReadModel,
  type WorkspaceSearchReadModel,
} from "./read-model.js";
import { workspaceAssetBrowsePath, workspaceSceneBrowsePath } from "./api-service.js";

export const itotori040FixtureProjectId = "project-itotori-040";
export const itotori040FixtureLocaleBranchId = "locale-branch-itotori-040";
export const itotori040FixtureSourceRevisionId = "source-revision-itotori-040";
const fixtureGeneratedAt = new Date("2026-06-26T00:00:00Z");

export function workspaceReaderPermissionFixture(
  overrides: Partial<WorkspacePermissionView> = {},
): WorkspacePermissionView {
  return {
    actorUserId: "local-user",
    canReadQueue: true,
    canManageQueue: false,
    denialReasons: [],
    ...overrides,
  };
}

export function workspaceDeniedPermissionFixture(): WorkspacePermissionView {
  return {
    actorUserId: "unauthorized-user",
    canReadQueue: false,
    canManageQueue: false,
    denialReasons: ["user unauthorized-user is missing permission queue.read"],
  };
}

export function workspaceProjectBrowseFixture(
  overrides: Partial<WorkspaceProjectBrowseReadModel> = {},
): WorkspaceProjectBrowseReadModel {
  return {
    schemaVersion: "workspace.project_browse.v0.1",
    generatedAt: fixtureGeneratedAt,
    permission: workspaceReaderPermissionFixture(),
    projects: [
      {
        projectId: itotori040FixtureProjectId,
        projectKey: "sweetie-hd",
        name: "Oshioki Sweetie HD",
        status: "drafting",
        sourceLocale: "ja-JP",
        sourceBundleRevisionId: itotori040FixtureSourceRevisionId,
        branchCount: 1,
        unitCount: 42,
        localeBranches: [
          {
            localeBranchId: itotori040FixtureLocaleBranchId,
            projectId: itotori040FixtureProjectId,
            branchName: "English (informal)",
            sourceLocale: "ja-JP",
            targetLocale: "en-US",
            status: "drafting",
            unitCount: 42,
            translatedUnitCount: 18,
            openFindingCount: 3,
            artifactCount: 5,
            currentStyleGuidePolicyVersionId: "style-guide-version-itotori-040",
            sceneBrowsePath: workspaceSceneBrowsePath(
              itotori040FixtureProjectId,
              itotori040FixtureLocaleBranchId,
            ),
            assetBrowsePath: workspaceAssetBrowsePath(
              itotori040FixtureProjectId,
              itotori040FixtureLocaleBranchId,
            ),
          },
        ],
      },
    ],
    diagnostics: [],
    ...overrides,
  };
}

export function workspaceSceneBrowseFixture(
  overrides: Partial<WorkspaceSceneBrowseReadModel> = {},
): WorkspaceSceneBrowseReadModel {
  return {
    schemaVersion: "workspace.scene_browse.v0.1",
    generatedAt: fixtureGeneratedAt,
    permission: workspaceReaderPermissionFixture(),
    projectId: itotori040FixtureProjectId,
    localeBranchId: itotori040FixtureLocaleBranchId,
    pagination: {
      total: 1,
      limit: 100,
      offset: 0,
      page: 1,
      pageCount: 1,
      hasMore: false,
      nextOffset: null,
    },
    scenes: [
      {
        sceneId: "scene.001",
        sceneSummaryId: "scene-summary-itotori-040",
        localeBranchId: itotori040FixtureLocaleBranchId,
        sourceRevisionId: itotori040FixtureSourceRevisionId,
        summaryLocale: "en-US",
        summaryText: "Scene 1: the heroine greets the protagonist outside the school gate at dawn.",
        status: "active",
        stale: false,
        generatedAt: fixtureGeneratedAt,
        units: [
          {
            bridgeUnitId: "bridge-unit-itotori-040-1",
            reviewItemId: "reviewer-queue-itotori-040",
            sourceUnitKey: "scene.001.line.001",
            speaker: "Heroine",
            occurrenceId: "occurrence-1",
            sourceText: "こんにちは、世界。",
            cited: true,
          },
        ],
        citedUnitCount: 1,
      },
    ],
    diagnostics: [],
    ...overrides,
  };
}

export function workspaceAssetBrowseFixture(
  overrides: Partial<WorkspaceAssetBrowseReadModel> = {},
): WorkspaceAssetBrowseReadModel {
  return {
    schemaVersion: "workspace.asset_browse.v0.1",
    generatedAt: fixtureGeneratedAt,
    permission: workspaceReaderPermissionFixture(),
    projectId: itotori040FixtureProjectId,
    localeBranchId: itotori040FixtureLocaleBranchId,
    assets: [
      {
        assetRef: { kind: "bridgeAssetRef", ref: "asset-image-1" },
        assetKind: "ui_art",
        displayLabel: "cg/title.png",
        decided: true,
        decisionPolicy: "localize",
        decisionRationale: "Title card has burned-in source text.",
      },
    ],
    diagnostics: [],
    ...overrides,
  };
}

export function workspaceComparisonFixture(
  overrides: Partial<WorkspaceComparisonReadModel> = {},
): WorkspaceComparisonReadModel {
  return {
    schemaVersion: "workspace.comparison.v0.1",
    generatedAt: fixtureGeneratedAt,
    permission: workspaceReaderPermissionFixture(),
    reviewItemId: "reviewer-queue-itotori-040",
    localeBranchId: itotori040FixtureLocaleBranchId,
    sourceRevisionId: itotori040FixtureSourceRevisionId,
    bridgeUnitId: "bridge-unit-itotori-040-1",
    sourceUnitKey: "scene.001.line.001",
    contextNote: "Greeting in scene 1.",
    cells: [
      { side: "source", locale: "ja-JP", text: "こんにちは、世界。", label: "Source (ja-JP)" },
      { side: "draft", locale: "en-US", text: "Hello, world.", label: "Draft (en-US)" },
      {
        side: "final",
        locale: "en-US",
        text: "Hello there, world!",
        label: "Final / approved (en-US)",
      },
    ],
    hasFinal: true,
    runtimeEvidenceLinks: [
      {
        evidenceKind: "text_trace",
        evidenceTier: "tier-2-trace",
        runtimeTargetId: "utsushi-runtime-target-fixture",
        observationEventIds: ["observation-event-text-1"],
        artifactHashes: ["sha256:text-trace-bytes-1"],
        providerProofRefs: ["provider:openrouter:run-text-trace-1"],
        summary: "Text trace covering scene 1 greeting.",
      },
    ],
    diagnostics: [],
    ...overrides,
  };
}

export function workspaceSearchFixture(
  overrides: Partial<WorkspaceSearchReadModel> = {},
): WorkspaceSearchReadModel {
  return {
    schemaVersion: "workspace.search.v0.1",
    generatedAt: fixtureGeneratedAt,
    permission: workspaceReaderPermissionFixture(),
    projectId: itotori040FixtureProjectId,
    localeBranchId: itotori040FixtureLocaleBranchId,
    query: "世界",
    normalizedQuery: "世界",
    mode: workspaceSearchModeValues.all,
    pagination: {
      total: 1,
      limit: 25,
      offset: 0,
      page: 1,
      pageCount: 1,
      hasMore: false,
      nextOffset: null,
    },
    results: [
      {
        resultKind: workspaceSearchResultKindValues.unit,
        matchKind: "exact",
        id: "search-document-itotori-040",
        title: "世界",
        subtitle: "bridge-unit-itotori-040-1",
        targetPath: "/workspace/comparison?reviewItemId=search-document-itotori-040",
        localeBranchId: itotori040FixtureLocaleBranchId,
        sourceArtifactId: "bridge-unit-itotori-040-1",
        bridgeUnitRef: "bridge-unit-itotori-040-1",
        sourceRevisionId: itotori040FixtureSourceRevisionId,
        sourceLocale: "ja-JP",
        targetLocale: "en-US",
        snippet: "世界",
        score: 1,
        matchRefId: "search-document-itotori-040",
      },
    ],
    droppedOpaqueCount: 0,
    diagnostics: [],
    ...overrides,
  };
}

export function workspaceDeniedComparisonFixture(
  reviewItemId: string,
): WorkspaceComparisonReadModel {
  return {
    schemaVersion: "workspace.comparison.v0.1",
    generatedAt: fixtureGeneratedAt,
    permission: workspaceDeniedPermissionFixture(),
    reviewItemId,
    localeBranchId: null,
    sourceRevisionId: null,
    bridgeUnitId: null,
    sourceUnitKey: null,
    contextNote: null,
    cells: [],
    hasFinal: false,
    runtimeEvidenceLinks: [],
    diagnostics: [
      {
        code: workspaceDiagnosticCodeValues.permissionDenied,
        message: "Workspace read blocked: user unauthorized-user is missing permission queue.read",
      },
    ],
  };
}
