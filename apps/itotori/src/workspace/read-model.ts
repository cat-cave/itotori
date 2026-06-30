// ITOTORI-040 — read-model types for the localization reviewer workspace.
//
// The workspace is the READ-oriented surface a reviewer uses to browse
// projects, locale branches, scenes, units, and assets, and to compare
// source / draft / final text — BEFORE the manual-correction workflows
// (ITOTORI-118) layer on top. Every type here is a projection over an
// EXISTING read-model (project dashboard status, locale-branch identity,
// scene summaries, asset decisions, exact / terminology search, reviewer
// detail context). The workspace never reaches into Postgres directly:
// it composes the read-model ports the rest of the app already exposes
// (see `api-service.ts`).
//
// Audit focus addressed by these shapes:
//   - "Queue-only UX that hides project context": the browse read-models
//     carry the full project → locale-branch → scene → unit → asset
//     hierarchy, not just a flat reviewer queue.
//   - "Read-only workspace accidentally mutating localization state":
//     every type is a plain read projection; there are no mutation verbs
//     and no edit-history fields (owned by ITOTORI-118).
//   - "Unsearchable large projects": the search read-model carries typed,
//     citation-bearing rows (source artifact id + locale branch id +
//     bridge unit ref) so results are navigable, never opaque snippets.
//
// Locale-branch identity (ITOTORI-059) is load-bearing: browse reads are
// scoped to a single `localeBranchId` and any record whose own
// `localeBranchId` disagrees with the requested branch is dropped and
// surfaced as a `branch_conflation_guard` diagnostic — browse must never
// conflate two branches that happen to share a target locale.

import type { ReviewerQueuePermissionView } from "../auth.js";

/**
 * The workspace reuses the reviewer-queue permission view: the read
 * workspace is gated on `queue.read`, exactly like the reviewer detail
 * page. `canManageQueue` is surfaced only so the renderer can decide
 * whether to advertise the (separately gated) correction workflows.
 */
export type WorkspacePermissionView = ReviewerQueuePermissionView;

/**
 * Closed taxonomy of workspace-level diagnostics. Each code maps to a
 * visible banner so missing / stale / conflated context is never hidden
 * behind an empty panel.
 */
export const workspaceDiagnosticCodeValues = {
  permissionDenied: "workspace_permission_denied",
  branchConflationGuard: "workspace_branch_conflation_guard",
  missingSceneSummaries: "workspace_missing_scene_summaries",
  staleSceneSummary: "workspace_stale_scene_summary",
  missingUnits: "workspace_missing_units",
  opaqueSearchResultDropped: "workspace_opaque_search_result_dropped",
  comparisonUnavailable: "workspace_comparison_unavailable",
} as const;

export type WorkspaceDiagnosticCode =
  (typeof workspaceDiagnosticCodeValues)[keyof typeof workspaceDiagnosticCodeValues];

export type WorkspaceDiagnostic = {
  code: WorkspaceDiagnosticCode;
  message: string;
};

export const workspaceSearchModeValues = {
  all: "all",
  exact: "exact",
  terminology: "terminology",
} as const;

export type WorkspaceSearchMode =
  (typeof workspaceSearchModeValues)[keyof typeof workspaceSearchModeValues];

// ---------------------------------------------------------------------------
// Project / locale-branch browse
// ---------------------------------------------------------------------------

/**
 * One locale branch under a project. The reviewer navigates branches by
 * `branchName` + `targetLocale`; `localeBranchId` keeps branches that
 * share a target locale distinct (ITOTORI-059).
 */
export type WorkspaceLocaleBranchSummary = {
  localeBranchId: string;
  projectId: string;
  branchName: string;
  sourceLocale: string;
  targetLocale: string;
  status: string;
  unitCount: number;
  translatedUnitCount: number;
  openFindingCount: number;
  artifactCount: number;
  currentStyleGuidePolicyVersionId: string | null;
  /** API path the SPA fetches to browse this branch's scenes. */
  sceneBrowsePath: string;
  /** API path the SPA fetches to browse this branch's assets. */
  assetBrowsePath: string;
};

export type WorkspaceProjectSummary = {
  projectId: string;
  projectKey: string;
  name: string;
  status: string;
  sourceLocale: string;
  sourceBundleRevisionId: string;
  branchCount: number;
  unitCount: number;
  localeBranches: WorkspaceLocaleBranchSummary[];
};

export type WorkspaceProjectBrowseReadModel = {
  schemaVersion: "workspace.project_browse.v0.1";
  generatedAt: Date;
  permission: WorkspacePermissionView;
  projects: WorkspaceProjectSummary[];
  diagnostics: WorkspaceDiagnostic[];
};

// ---------------------------------------------------------------------------
// Scene / unit browse (translated-summary navigation)
// ---------------------------------------------------------------------------

/**
 * One unit cited by a scene summary. The non-source-language reviewer
 * navigates by `sourceUnitKey` + `speaker`; the source text is included
 * for the reviewer who CAN read the source, but it is never required to
 * navigate. There is intentionally NO draft / target text here — that
 * lives behind the comparison view.
 */
export type WorkspaceSceneUnit = {
  bridgeUnitId: string;
  sourceUnitKey: string;
  speaker: string | null;
  occurrenceId: string;
  sourceText: string | null;
  /** True when the summary cited this unit (vs. only present in scope). */
  cited: boolean;
};

/**
 * One scene, navigable purely by its TRANSLATED summary. `summaryLocale`
 * is the locale the reviewer reads in; `summaryText` is the human-facing
 * summary that lets a reviewer who does not speak `sourceLocale` decide
 * whether the scene is relevant.
 */
export type WorkspaceSceneContext = {
  sceneId: string;
  sceneSummaryId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  summaryLocale: string;
  summaryText: string;
  status: string;
  stale: boolean;
  generatedAt: Date;
  units: WorkspaceSceneUnit[];
  citedUnitCount: number;
};

export type WorkspaceSceneBrowseReadModel = {
  schemaVersion: "workspace.scene_browse.v0.1";
  generatedAt: Date;
  permission: WorkspacePermissionView;
  projectId: string;
  localeBranchId: string;
  scenes: WorkspaceSceneContext[];
  diagnostics: WorkspaceDiagnostic[];
};

// ---------------------------------------------------------------------------
// Asset browse
// ---------------------------------------------------------------------------

export type WorkspaceAssetEntry = {
  assetRef: { kind: string; ref: string };
  assetKind: string;
  displayLabel: string | null;
  decided: boolean;
  decisionPolicy: string | null;
  decisionRationale: string | null;
};

export type WorkspaceAssetBrowseReadModel = {
  schemaVersion: "workspace.asset_browse.v0.1";
  generatedAt: Date;
  permission: WorkspacePermissionView;
  projectId: string;
  localeBranchId: string;
  assets: WorkspaceAssetEntry[];
  diagnostics: WorkspaceDiagnostic[];
};

// ---------------------------------------------------------------------------
// Source / draft / final comparison
// ---------------------------------------------------------------------------

export type WorkspaceComparisonCell = {
  /** "source" | "draft" | "final" — which side of the comparison. */
  side: "source" | "draft" | "final";
  locale: string;
  text: string;
  /** Stable label the renderer shows above the cell. */
  label: string;
};

/**
 * Runtime-evidence link for the comparison view. Carries the evidence
 * tier, runtime target, observation events, artifact hashes, and provider
 * proof refs verbatim — never a local file path — so a reviewer can jump
 * to the runtime proof that a draft rendered correctly in-game.
 */
export type WorkspaceRuntimeEvidenceLink = {
  evidenceKind: string;
  evidenceTier: string;
  runtimeTargetId: string;
  observationEventIds: string[];
  artifactHashes: string[];
  providerProofRefs: string[];
  summary: string;
};

export type WorkspaceComparisonReadModel = {
  schemaVersion: "workspace.comparison.v0.1";
  generatedAt: Date;
  permission: WorkspacePermissionView;
  reviewItemId: string;
  localeBranchId: string | null;
  sourceRevisionId: string | null;
  bridgeUnitId: string | null;
  sourceUnitKey: string | null;
  /** Translated context note (if any) — readable without the source. */
  contextNote: string | null;
  cells: WorkspaceComparisonCell[];
  /** True when a reviewed/approved final text exists for this unit. */
  hasFinal: boolean;
  runtimeEvidenceLinks: WorkspaceRuntimeEvidenceLink[];
  diagnostics: WorkspaceDiagnostic[];
};

// ---------------------------------------------------------------------------
// Searchable context
// ---------------------------------------------------------------------------

/**
 * A single search hit. Every hit MUST cite a source artifact id, a locale
 * branch id, and a bridge unit ref — the acceptance guarantee that search
 * results are navigable, not opaque RAG snippets. Hits that cannot supply
 * all three citations are dropped by the service and counted in
 * `droppedOpaqueCount`.
 */
export type WorkspaceSearchResult = {
  matchKind: "exact" | "terminology";
  localeBranchId: string;
  sourceArtifactId: string;
  bridgeUnitRef: string;
  sourceRevisionId: string | null;
  sourceLocale: string | null;
  targetLocale: string | null;
  /** Human-readable matched term / phrase. Never an embedding blob. */
  snippet: string;
  score: number;
  /** Optional cross-link into the comparison/detail surface. */
  matchRefId: string | null;
};

export type WorkspaceSearchReadModel = {
  schemaVersion: "workspace.search.v0.1";
  generatedAt: Date;
  permission: WorkspacePermissionView;
  projectId: string;
  localeBranchId: string;
  query: string;
  normalizedQuery: string;
  mode: WorkspaceSearchMode;
  results: WorkspaceSearchResult[];
  /** Hits dropped because they lacked the required citations. */
  droppedOpaqueCount: number;
  diagnostics: WorkspaceDiagnostic[];
};
