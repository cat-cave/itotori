import type { ItotoriApiRouteId } from "./api-schema.js";

// ---------------------------------------------------------------------------
// Route registry — the SINGLE authority for the /api route topology.
// ---------------------------------------------------------------------------

export type ItotoriApiRoute = {
  readonly method: "GET" | "POST";
  /** OpenAPI-style path template (`{param}` placeholders). */
  readonly pathTemplate: string;
  readonly operationId: string;
  readonly summary: string;
  readonly pathParams: readonly string[];
  /** Component name of the request body schema (POST routes with a body). */
  readonly requestSchema?: string;
  /** Component name of the 200 response body schema. */
  readonly responseSchema: string;
};

/** A non-JSON API route published in OpenAPI but intentionally not in the typed JSON client. */
export type ItotoriApiBinaryRoute = {
  readonly method: "GET";
  readonly pathTemplate: string;
  readonly operationId: string;
  readonly summary: string;
  readonly pathParams: readonly string[];
  readonly contentType: "application/x-tar";
};

export type ItotoriApiBinaryRouteId = "play.deliveryArchive" | "patchIteration.deliveryArchive";

/**
 * Every `/api` route, keyed by {@link ItotoriApiRouteId}. The
 * `Record<ItotoriApiRouteId, …>` type makes this table EXHAUSTIVE against the
 * guard union at compile time — adding or removing a route id without updating
 * this registry fails `tsc`, so the emitted contract can never drift out of the
 * set of routes the guards recognize. The HTTP contract harness drives its
 * method + path from here, and the emitter reflects it into OpenAPI + the
 * JSON-Schema bundle.
 */
export const ITOTORI_API_ROUTES: Readonly<Record<ItotoriApiRouteId, ItotoriApiRoute>> = {
  "projects.list": {
    method: "GET",
    pathTemplate: "/api/projects",
    operationId: "projectsList",
    summary: "List projects with dashboard status.",
    pathParams: [],
    responseSchema: "ApiProjectsResponse",
  },
  "projects.status": {
    method: "GET",
    pathTemplate: "/api/projects/status",
    operationId: "projectsStatus",
    summary: "Project dashboard status.",
    pathParams: [],
    responseSchema: "ProjectDashboardStatus",
  },
  "projects.overview": {
    method: "GET",
    pathTemplate: "/api/projects/overview",
    operationId: "projectsOverview",
    summary: "Composed project overview cockpit read model.",
    pathParams: [],
    responseSchema: "ProjectOverviewReadModel",
  },
  "projects.decisions": {
    method: "GET",
    pathTemplate: "/api/projects/decisions",
    operationId: "projectsDecisions",
    summary: "Dashboard decision read model.",
    pathParams: [],
    responseSchema: "DashboardDecisionReadModel",
  },
  "projects.cost": {
    method: "GET",
    pathTemplate: "/api/projects/cost",
    operationId: "projectsCost",
    summary: "Project cost report.",
    pathParams: [],
    responseSchema: "ProjectCostReport",
  },
  "projects.costDrilldown": {
    method: "GET",
    pathTemplate: "/api/projects/cost/drilldown",
    operationId: "projectsCostDrilldown",
    summary: "Paged cost drill-down.",
    pathParams: [],
    responseSchema: "CostDrilldownPage",
  },
  "projects.benchmarks": {
    method: "GET",
    pathTemplate: "/api/projects/benchmarks",
    operationId: "projectsBenchmarks",
    summary: "Benchmark report summaries.",
    pathParams: [],
    responseSchema: "ApiBenchmarkReportsResponse",
  },
  // itotori-bmk-cockpit-read-model — the benchmark COCKPIT read-model for one
  // project. The benchmark is a DIAGNOSTIC INSTRUMENT (per §10 framing), not a
  // leaderboard — the actionable backlog is the primary output. Composes the
  // 5 contestants (official / self / self_nocontext / fan / mtl) + the §8
  // human anchor + a confidence rollup + the actionable backlog.
  "projects.bmkCockpit": {
    method: "GET",
    pathTemplate: "/api/projects/{projectId}/bmk-cockpit",
    operationId: "projectsBmkCockpit",
    summary: "Benchmark cockpit read model — contestants + anchor + confidence + backlog.",
    pathParams: ["projectId"],
    responseSchema: "BmkCockpitReadModel",
  },
  // itotori-bmk-cockpit-history — paged run history so a reviewer can confirm
  // the actionable backlog is shrinking over time.
  "projects.bmkCockpitHistory": {
    method: "GET",
    pathTemplate: "/api/projects/{projectId}/bmk-cockpit/history",
    operationId: "projectsBmkCockpitHistory",
    summary: "Benchmark cockpit run history.",
    pathParams: ["projectId"],
    responseSchema: "BmkCockpitRunHistoryPage",
  },
  "jobs.runTable": {
    method: "GET",
    pathTemplate: "/api/jobs/run-table",
    operationId: "jobsRunTable",
    summary: "Paged jobs run table with physical journal attempts and served provider facts.",
    pathParams: [],
    responseSchema: "JobsRunTableReadModel",
  },
  "runtime.status": {
    method: "GET",
    pathTemplate: "/api/runtime/v0.2/status",
    operationId: "runtimeStatus",
    summary: "Runtime dashboard status.",
    pathParams: [],
    responseSchema: "RuntimeDashboardStatus",
  },
  "catalog.conflicts": {
    method: "GET",
    pathTemplate: "/api/catalog/conflicts",
    operationId: "catalogConflicts",
    summary: "Catalog conflict review read model.",
    pathParams: [],
    responseSchema: "CatalogConflictReviewReadModel",
  },
  "catalog.completeness": {
    method: "GET",
    pathTemplate: "/api/catalog/completeness",
    operationId: "catalogCompleteness",
    summary: "Catalog completeness benchmark pools.",
    pathParams: [],
    responseSchema: "CatalogCompletenessBenchmarkPools",
  },
  "catalog.benchmarkSeeds": {
    method: "GET",
    pathTemplate: "/api/catalog/benchmark-seeds",
    operationId: "catalogBenchmarkSeeds",
    summary: "Catalog benchmark seed finder read model.",
    pathParams: [],
    responseSchema: "CatalogBenchmarkSeedFinderReadModel",
  },
  "catalog.contextPanel": {
    method: "GET",
    pathTemplate:
      "/api/projects/{projectId}/locale-branches/{localeBranchId}/catalog-context/{workId}",
    operationId: "catalogContextPanel",
    summary: "Catalog context panel read model for a work and target locale branch.",
    pathParams: ["projectId", "localeBranchId", "workId"],
    responseSchema: "CatalogContextPanelReadModel",
  },
  "catalog.opportunities": {
    method: "GET",
    pathTemplate: "/api/catalog/opportunities",
    operationId: "catalogOpportunities",
    summary: "Catalog opportunity ranking read model.",
    pathParams: [],
    responseSchema: "CatalogOpportunityRankingReadModel",
  },
  "terminology.search": {
    method: "GET",
    pathTemplate: "/api/terminology/search",
    operationId: "terminologySearch",
    summary: "Terminology search read model.",
    pathParams: [],
    responseSchema: "TerminologySearchReadModel",
  },
  "wiki.list": {
    method: "GET",
    pathTemplate: "/api/projects/{projectId}/locale-branches/{localeBranchId}/wiki",
    operationId: "wikiList",
    summary: "Browse the populated canonical context wiki.",
    pathParams: ["projectId", "localeBranchId"],
    responseSchema: "WikiContextEntriesReadModel",
  },
  "wiki.add": {
    method: "POST",
    pathTemplate: "/api/projects/{projectId}/locale-branches/{localeBranchId}/wiki",
    operationId: "wikiAdd",
    summary:
      "Add a note, glossary fact, or style instruction through canonical context correction.",
    pathParams: ["projectId", "localeBranchId"],
    requestSchema: "ApiWikiAddRequest",
    responseSchema: "ApiWikiEditResponse",
  },
  "wiki.show": {
    method: "GET",
    pathTemplate:
      "/api/projects/{projectId}/locale-branches/{localeBranchId}/wiki/{contextArtifactId}",
    operationId: "wikiShow",
    summary: "Show one canonical wiki entry with content, provenance, citations, and history.",
    pathParams: ["projectId", "localeBranchId", "contextArtifactId"],
    responseSchema: "WikiContextEntryReadModel",
  },
  "wiki.history": {
    method: "GET",
    pathTemplate:
      "/api/projects/{projectId}/locale-branches/{localeBranchId}/wiki/{contextArtifactId}/history",
    operationId: "wikiHistory",
    summary: "Show immutable canonical version history for a wiki entry.",
    pathParams: ["projectId", "localeBranchId", "contextArtifactId"],
    responseSchema: "WikiContextEntryHistoryReadModel",
  },
  "wiki.edit": {
    method: "POST",
    pathTemplate:
      "/api/projects/{projectId}/locale-branches/{localeBranchId}/wiki/{contextArtifactId}",
    operationId: "wikiEdit",
    summary: "Apply a canonical context correction for a wiki entry and schedule redraft.",
    pathParams: ["projectId", "localeBranchId", "contextArtifactId"],
    requestSchema: "ApiWikiEditRequest",
    responseSchema: "ApiWikiEditResponse",
  },
  "queue.health": {
    method: "GET",
    pathTemplate: "/api/queue/health",
    operationId: "queueHealth",
    summary: "Queue health read model (outbox + jobs).",
    pathParams: [],
    responseSchema: "QueueHealthReadModel",
  },
  "reviewer.queue": {
    method: "GET",
    pathTemplate: "/api/reviewer/queue",
    operationId: "reviewerQueue",
    summary: "Reviewer queue dashboard read model.",
    pathParams: [],
    responseSchema: "ReviewerQueueDashboardReadModel",
  },
  "reviewer.detail": {
    method: "GET",
    pathTemplate: "/api/reviewer/queue/{reviewItemId}/detail",
    operationId: "reviewerDetail",
    summary: "Reviewer queue item detail context.",
    pathParams: ["reviewItemId"],
    responseSchema: "ReviewerDetailContext",
  },
  "reviewer.batchPreview": {
    method: "POST",
    pathTemplate: "/api/reviewer/queue/batch-preview",
    operationId: "reviewerBatchPreview",
    summary: "Preview a reviewer batch action.",
    pathParams: [],
    requestSchema: "ReviewerBatchActionRequest",
    responseSchema: "ReviewerBatchPreview",
  },
  "reviewer.batchExecute": {
    method: "POST",
    pathTemplate: "/api/reviewer/queue/batch-confirm",
    operationId: "reviewerBatchExecute",
    summary: "Execute a reviewer batch action.",
    pathParams: [],
    requestSchema: "ReviewerBatchActionRequest",
    responseSchema: "ReviewerBatchExecuteResult",
  },
  "reviewer.itemAction": {
    method: "POST",
    pathTemplate: "/api/reviewer/queue/{reviewItemId}/action",
    operationId: "reviewerItemAction",
    summary: "Apply a single-item reviewer action.",
    pathParams: ["reviewItemId"],
    requestSchema: "ApiReviewerSingleActionRequest",
    responseSchema: "ReviewerSingleActionResult",
  },
  "workspace.projects": {
    method: "GET",
    pathTemplate: "/api/workspace/projects",
    operationId: "workspaceProjects",
    summary: "Workspace project browse read model.",
    pathParams: [],
    responseSchema: "WorkspaceProjectBrowseReadModel",
  },
  "workspace.scenes": {
    method: "GET",
    pathTemplate: "/api/workspace/scenes",
    operationId: "workspaceScenes",
    summary: "Workspace scene browse read model.",
    pathParams: [],
    responseSchema: "WorkspaceSceneBrowseReadModel",
  },
  "workspace.assets": {
    method: "GET",
    pathTemplate: "/api/workspace/assets",
    operationId: "workspaceAssets",
    summary: "Workspace asset browse read model.",
    pathParams: [],
    responseSchema: "WorkspaceAssetBrowseReadModel",
  },
  "workspace.comparison": {
    method: "GET",
    pathTemplate: "/api/workspace/comparison",
    operationId: "workspaceComparison",
    summary: "Workspace comparison read model.",
    pathParams: [],
    responseSchema: "WorkspaceComparisonReadModel",
  },
  "workspace.search": {
    method: "GET",
    pathTemplate: "/api/workspace/search",
    operationId: "workspaceSearch",
    summary: "Workspace search read model.",
    pathParams: [],
    responseSchema: "WorkspaceSearchReadModel",
  },
  "workspace.correctionPreview": {
    method: "GET",
    pathTemplate: "/api/workspace/corrections",
    operationId: "workspaceCorrectionPreview",
    summary: "Workspace correction preview read model.",
    pathParams: [],
    responseSchema: "WorkspaceCorrectionPreviewReadModel",
  },
  "workspace.correctionSubmit": {
    method: "POST",
    pathTemplate: "/api/workspace/corrections",
    operationId: "workspaceCorrectionSubmit",
    summary: "Submit feedback corrections to canonical context.",
    pathParams: [],
    requestSchema: "ApiWorkspaceCorrectionSubmitRequest",
    responseSchema: "WorkspaceCorrectionSubmitReadModel",
  },
  "assetDecisions.active": {
    method: "GET",
    pathTemplate: "/api/projects/{projectId}/locale-branches/{localeBranchId}/asset-decisions",
    operationId: "assetDecisionsActive",
    summary: "Active asset localization decisions.",
    pathParams: ["projectId", "localeBranchId"],
    responseSchema: "ApiAssetDecisionsResponse",
  },
  "assetDecisions.candidates": {
    method: "GET",
    pathTemplate:
      "/api/projects/{projectId}/locale-branches/{localeBranchId}/asset-decisions/candidates",
    operationId: "assetDecisionsCandidates",
    summary: "Candidate assets for localization decisions.",
    pathParams: ["projectId", "localeBranchId"],
    responseSchema: "ApiCandidateAssetsResponse",
  },
  "projects.decodeExtract": {
    method: "POST",
    pathTemplate: "/api/projects/decode-extract",
    operationId: "projectsDecodeExtract",
    summary: "Decode a game source (identify/inventory/extract) into a bridge bundle.",
    pathParams: [],
    requestSchema: "ApiProjectDecodeExtractRequest",
    responseSchema: "ApiProjectDecodeExtractResponse",
  },
  "imports.bridge": {
    method: "POST",
    pathTemplate: "/api/imports/bridge",
    operationId: "importsBridge",
    summary: "Import a bridge bundle.",
    pathParams: [],
    requestSchema: "ApiProjectImportRequest",
    responseSchema: "ApiProjectImportResponse",
  },
  "branches.draft": {
    method: "POST",
    pathTemplate: "/api/projects/{projectId}/branches",
    operationId: "branchesDraft",
    summary: "Draft a locale branch.",
    pathParams: ["projectId"],
    requestSchema: "ApiDraftBranchRequest",
    responseSchema: "ApiDraftBranchResponse",
  },
  "findings.record": {
    method: "POST",
    pathTemplate: "/api/projects/{projectId}/findings",
    operationId: "findingsRecord",
    summary: "Record a QA finding.",
    pathParams: ["projectId"],
    requestSchema: "ApiRecordFindingRequest",
    responseSchema: "ApiRecordFindingResponse",
  },
  "decisions.record": {
    method: "POST",
    pathTemplate: "/api/projects/{projectId}/decisions",
    operationId: "decisionsRecord",
    summary: "Record a triage decision event.",
    pathParams: ["projectId"],
    requestSchema: "ApiRecordDecisionRequest",
    responseSchema: "ApiRecordDecisionResponse",
  },
  "benchmarks.record": {
    method: "POST",
    pathTemplate: "/api/projects/{projectId}/benchmarks",
    operationId: "benchmarksRecord",
    summary: "Record a benchmark report.",
    pathParams: ["projectId"],
    requestSchema: "ApiRecordBenchmarkRequest",
    responseSchema: "ApiRecordBenchmarkResponse",
  },
  "runtimeEvidence.ingest": {
    method: "POST",
    pathTemplate: "/api/projects/{projectId}/runtime-evidence",
    operationId: "runtimeEvidenceIngest",
    summary: "Ingest a runtime evidence report.",
    pathParams: ["projectId"],
    requestSchema: "ApiRuntimeEvidenceRequest",
    responseSchema: "ApiRuntimeEvidenceResponse",
  },
  "settings.modelRouting.get": {
    method: "GET",
    pathTemplate: "/api/settings/model-routing",
    operationId: "settingsModelRoutingGet",
    summary: "Load project model routing settings and available provider/model/prompt choices.",
    pathParams: [],
    responseSchema: "ApiModelRoutingSettingsResponse",
  },
  "settings.modelRouting.save": {
    method: "POST",
    pathTemplate: "/api/settings/model-routing",
    operationId: "settingsModelRoutingSave",
    summary: "Save one project model-routing task route.",
    pathParams: [],
    requestSchema: "ApiSaveModelRoutingSettingsRequest",
    responseSchema: "ApiModelRoutingSettingsResponse",
  },
  "settings.branchPolicy.get": {
    method: "GET",
    pathTemplate:
      "/api/projects/{projectId}/locale-branches/{localeBranchId}/settings/branch-policy",
    operationId: "settingsBranchPolicyGet",
    summary: "Load editable branch policy and glossary reference state for a locale branch.",
    pathParams: ["projectId", "localeBranchId"],
    responseSchema: "ApiBranchPolicySettingsResponse",
  },
  "settings.branchPolicy.save": {
    method: "POST",
    pathTemplate:
      "/api/projects/{projectId}/locale-branches/{localeBranchId}/settings/branch-policy",
    operationId: "settingsBranchPolicySave",
    summary: "Save editable branch policy for a locale branch and refresh its glossary reference.",
    pathParams: ["projectId", "localeBranchId"],
    requestSchema: "ApiSaveBranchPolicySettingsRequest",
    responseSchema: "ApiBranchPolicySettingsResponse",
  },
  "settings.translationScope.get": {
    method: "GET",
    pathTemplate:
      "/api/projects/{projectId}/locale-branches/{localeBranchId}/settings/translation-scope",
    operationId: "settingsTranslationScopeGet",
    summary:
      "Load the config-driven translation scope (dialogue / +choices / +UI-text / +images) for a locale branch.",
    pathParams: ["projectId", "localeBranchId"],
    responseSchema: "ApiTranslationScopeSettingsResponse",
  },
  "settings.translationScope.save": {
    method: "POST",
    pathTemplate:
      "/api/projects/{projectId}/locale-branches/{localeBranchId}/settings/translation-scope",
    operationId: "settingsTranslationScopeSave",
    summary:
      "Save the config-driven translation scope for a locale branch. Read by the localize-fullproject command.",
    pathParams: ["projectId", "localeBranchId"],
    requestSchema: "ApiSaveTranslationScopeSettingsRequest",
    responseSchema: "ApiTranslationScopeSettingsResponse",
  },
  "settings.localizationRunConfig.save": {
    method: "POST",
    pathTemplate:
      "/api/projects/{projectId}/locale-branches/{localeBranchId}/settings/localization-run-config",
    operationId: "settingsLocalizationRunConfigSave",
    summary:
      "Register the operator-local config, data root, pinned model/provider pair, and run directory for launch-pass.",
    pathParams: ["projectId", "localeBranchId"],
    requestSchema: "ApiSaveLocalizationRunConfigRequest",
    responseSchema: "ApiLocalizationRunConfigResponse",
  },
  "auth.ssoSettings.configure": {
    method: "POST",
    pathTemplate: "/api/settings/security/sso",
    operationId: "authSsoSettingsConfigure",
    summary: "Configure account SSO provider and security/session policy.",
    pathParams: [],
    requestSchema: "ApiConfigureAuthSsoSettingsRequest",
    responseSchema: "ApiConfigureAuthSsoSettingsResponse",
  },
  "auth.members.list": {
    method: "GET",
    pathTemplate: "/api/auth/members",
    operationId: "authMembersList",
    summary: "List account members and granted permission sets.",
    pathParams: [],
    responseSchema: "ApiMembersListResponse",
  },
  "auth.billing.seatUsage": {
    method: "GET",
    pathTemplate: "/api/auth/billing/seat-usage",
    operationId: "authBillingSeatUsage",
    summary: "Load account plan and seat usage derived from auth memberships.",
    pathParams: [],
    responseSchema: "ApiAuthBillingSeatUsageResponse",
  },
  "auth.identity": {
    method: "GET",
    pathTemplate: "/api/auth/identity",
    operationId: "authIdentity",
    summary: "Resolve the signed-in actor and their account memberships.",
    pathParams: [],
    responseSchema: "ApiAuthIdentityResponse",
  },
  // fnd-caps-context — the actor's Studio capability permission VIEW
  // (canFlag / canDecide / canSteer / canReveal) resolved from exact
  // permission grants (capabilities, NOT roles).
  "auth.capabilities": {
    method: "GET",
    pathTemplate: "/api/auth/capabilities",
    operationId: "authCapabilities",
    summary: "Resolve the caller's Studio capability permission view (flag/decide/steer/reveal).",
    pathParams: [],
    responseSchema: "ApiAuthCapabilitiesResponse",
  },
  "auth.members.invite": {
    method: "POST",
    pathTemplate: "/api/auth/members/invitations",
    operationId: "authMembersInvite",
    summary: "Invite a member with optional initial permission sets.",
    pathParams: [],
    requestSchema: "ApiInviteMemberRequest",
    responseSchema: "ApiMemberInvitationResponse",
  },
  "auth.members.accept": {
    method: "POST",
    pathTemplate: "/api/auth/members/invitations/{invitationId}/accept",
    operationId: "authMembersAcceptInvitation",
    summary: "Accept a member invitation, creating membership and initial grants transactionally.",
    pathParams: ["invitationId"],
    requestSchema: "ApiAcceptMemberInvitationRequest",
    responseSchema: "ApiMemberResponse",
  },
  "auth.members.remove": {
    method: "POST",
    pathTemplate: "/api/auth/members/{membershipId}/remove",
    operationId: "authMembersRemove",
    summary: "Remove a member and revoke account-scoped permission-set grants.",
    pathParams: ["membershipId"],
    requestSchema: "ApiRemoveMemberRequest",
    responseSchema: "ApiRemoveMemberResponse",
  },
  "auth.permissionSets.list": {
    method: "GET",
    pathTemplate: "/api/auth/permission-sets",
    operationId: "authPermissionSetsList",
    summary: "List account permission sets available for member grants.",
    pathParams: [],
    responseSchema: "ApiPermissionSetsListResponse",
  },
  "auth.permissionSets.grant": {
    method: "POST",
    pathTemplate: "/api/auth/principals/{principalId}/permission-sets/{permissionSetId}/grant",
    operationId: "authPermissionSetsGrant",
    summary: "Grant a permission set to an account principal.",
    pathParams: ["principalId", "permissionSetId"],
    requestSchema: "ApiPrincipalPermissionSetGrantRequest",
    responseSchema: "ApiPrincipalPermissionSetGrantResponse",
  },
  "auth.permissionSets.revoke": {
    method: "POST",
    pathTemplate: "/api/auth/principals/{principalId}/permission-sets/{permissionSetId}/revoke",
    operationId: "authPermissionSetsRevoke",
    summary: "Revoke a permission set from an account principal.",
    pathParams: ["principalId", "permissionSetId"],
    requestSchema: "ApiPrincipalPermissionSetGrantRequest",
    responseSchema: "ApiPrincipalPermissionSetGrantResponse",
  },
  "auth.sessions.list": {
    method: "GET",
    pathTemplate: "/api/auth/principals/{principalId}/sessions",
    operationId: "authSessionsList",
    summary: "List active auth sessions and captured device metadata for a principal.",
    pathParams: ["principalId"],
    responseSchema: "ApiAuthSessionsListResponse",
  },
  "auth.sessions.revoke": {
    method: "POST",
    pathTemplate: "/api/auth/principals/{principalId}/sessions/{sessionId}/revoke",
    operationId: "authSessionsRevoke",
    summary: "Revoke an active auth session for a principal.",
    pathParams: ["principalId", "sessionId"],
    requestSchema: "ApiRevokeAuthSessionRequest",
    responseSchema: "ApiRevokeAuthSessionResponse",
  },
  // ovw-launch-pass-action — drive the next localization pass (folds queued
  // corrections -> pass N+1) via the project-driven-executor /
  // localize-fullproject driver. The HTTP surface is a thin, `canSteer`-gated
  // adapter; the driver itself is unchanged.
  "projects.launchPass": {
    method: "POST",
    pathTemplate: "/api/projects/{projectId}/launch-pass",
    operationId: "projectsLaunchPass",
    summary: "Launch the next localization pass or cancel an existing durable run.",
    pathParams: ["projectId"],
    requestSchema: "ApiLaunchPassRequest",
    responseSchema: "ApiLaunchPassResponse",
  },
  // play-routemap-ui — Play RouteMap route/choice tree from routeMaps/routeChoices.
  "play.routeMap": {
    method: "GET",
    pathTemplate: "/api/projects/{projectId}/locale-branches/{localeBranchId}/route-map",
    operationId: "playRouteMap",
    summary: "Play RouteMap route/choice tree with coverage state.",
    pathParams: ["projectId", "localeBranchId"],
    responseSchema: "ApiPlayRouteMapResponse",
  },
  // play-mark-validated — per-scene localization coverage (needs_check /
  // flagged / validated) driving the Play RouteMap.
  "play.sceneCoverage": {
    method: "GET",
    pathTemplate: "/api/projects/{projectId}/locale-branches/{localeBranchId}/scene-coverage",
    operationId: "playSceneCoverage",
    summary: "Play RouteMap scene localization coverage read model.",
    pathParams: ["projectId", "localeBranchId"],
    responseSchema: "ApiPlaySceneCoverageResponse",
  },
  "play.setSceneCoverage": {
    method: "POST",
    pathTemplate: "/api/projects/{projectId}/locale-branches/{localeBranchId}/scene-coverage",
    operationId: "playSetSceneCoverage",
    summary: "Set a scene's localization coverage state (validated / flagged / needs_check).",
    pathParams: ["projectId", "localeBranchId"],
    requestSchema: "ApiPlaySetSceneCoverageRequest",
    responseSchema: "ApiPlaySetSceneCoverageResponse",
  },
  // play-flag-composer — in-the-moment AnnotationComposer note → canonical
  // context correction via ManualFeedbackImport (feedback.import / canFlag).
  "play.flagAnnotation": {
    method: "POST",
    pathTemplate: "/api/projects/{projectId}/locale-branches/{localeBranchId}/flags",
    operationId: "playFlagAnnotation",
    summary: "Compose a playtest flag (AnnotationComposer) into a context correction.",
    pathParams: ["projectId", "localeBranchId"],
    requestSchema: "ApiPlayFlagAnnotationRequest",
    responseSchema: "ApiPlayFlagAnnotationResponse",
  },
  // p0-result-revision — a target-only play-tester edit creates a selected,
  // delivered child patch revision. The parent patch is path-scoped so the
  // body cannot fabricate patch identity, actor identity, or artifact paths.
  "play.targetEdit": {
    method: "POST",
    pathTemplate: "/api/play/patch-versions/{parentPatchVersionId}/target-edits",
    operationId: "playTargetEdit",
    summary: "Replace one delivered target line and select its child patch revision.",
    pathParams: ["parentPatchVersionId"],
    requestSchema: "ApiPlayTargetEditRequest",
    responseSchema: "ApiPlayTargetEditResponse",
  },
  // p0-result-revision — production delivery boundary for the selected patch.
  "play.delivery": {
    method: "GET",
    pathTemplate: "/api/play/runs/{runId}/delivery",
    operationId: "playDelivery",
    summary: "Load the selected delivered patch export for a run.",
    pathParams: ["runId"],
    responseSchema: "ApiPlayDeliveryResponse",
  },
  // p0-core-iterative-patch-versioning-and-playtest-feedback — exact-version
  // iteration topology. Historical versions are readable/playable; feedback
  // and refinement mutations remain resource-scoped to the observed base.
  "patchIteration.versions": {
    method: "GET",
    pathTemplate: "/api/play/locale-branches/{localeBranchId}/patch-versions",
    operationId: "patchIterationVersions",
    summary: "List durable patch versions and lineage for one locale branch.",
    pathParams: ["localeBranchId"],
    responseSchema: "ApiPatchIterationVersionsResponse",
  },
  "patchIteration.surface": {
    method: "GET",
    pathTemplate: "/api/play/patch-versions/{patchVersionId}",
    operationId: "patchIterationSurface",
    summary: "Load a historical patch play surface, feedback inbox, and informational QA callouts.",
    pathParams: ["patchVersionId"],
    responseSchema: "ApiPatchIterationSurfaceResponse",
  },
  "patchIteration.delivery": {
    method: "GET",
    pathTemplate: "/api/play/patch-versions/{patchVersionId}/delivery",
    operationId: "patchIterationDelivery",
    summary: "Load immutable archive metadata for one exact playable patch version.",
    pathParams: ["patchVersionId"],
    responseSchema: "ApiPatchIterationDeliveryResponse",
  },
  "patchIteration.play": {
    method: "POST",
    pathTemplate: "/api/play/patch-versions/{patchVersionId}/sessions",
    operationId: "patchIterationPlay",
    summary: "Start a play session for the exact playable patch version observed.",
    pathParams: ["patchVersionId"],
    requestSchema: "ApiPatchIterationPlayRequest",
    responseSchema: "ApiPatchIterationPlayResponse",
  },
  "patchIteration.feedbackBatch": {
    method: "POST",
    pathTemplate: "/api/play/patch-versions/{patchVersionId}/feedback-batches",
    operationId: "patchIterationFeedbackBatch",
    summary: "Create a persisted feedback batch for the exact patch version observed.",
    pathParams: ["patchVersionId"],
    requestSchema: "ApiPatchIterationFeedbackBatchRequest",
    responseSchema: "ApiPatchIterationFeedbackBatchResponse",
  },
  "patchIteration.feedback": {
    method: "POST",
    pathTemplate: "/api/play/patch-versions/{patchVersionId}/feedback",
    operationId: "patchIterationFeedback",
    summary: "Persist individual or batched result, comment, context, or wiki play-test feedback.",
    pathParams: ["patchVersionId"],
    requestSchema: "ApiPatchIterationFeedbackRequest",
    responseSchema: "ApiPatchIterationFeedbackResponse",
  },
  "patchIteration.refine": {
    method: "POST",
    pathTemplate: "/api/play/patch-versions/{patchVersionId}/refine",
    operationId: "patchIterationRefine",
    summary: "Freeze feedback/wiki inputs and complete a real-byte refinement patch version.",
    pathParams: ["patchVersionId"],
    requestSchema: "ApiPatchIterationRefineRequest",
    responseSchema: "ApiPatchIterationRefineResponse",
  },
};

/** Stable, sorted list of every route id (deterministic iteration order). */
export const ITOTORI_API_ROUTE_IDS: readonly ItotoriApiRouteId[] = Object.keys(
  ITOTORI_API_ROUTES,
).sort() as ItotoriApiRouteId[];

/**
 * Binary download topology. This is adjacent to (rather than inside) the JSON
 * route registry because the typed JSON response guard/client must never try
 * to parse archive bytes as an API response body.
 */
export const ITOTORI_API_BINARY_ROUTES: Readonly<
  Record<ItotoriApiBinaryRouteId, ItotoriApiBinaryRoute>
> = {
  "play.deliveryArchive": {
    method: "GET",
    pathTemplate: "/api/play/runs/{runId}/delivery/archive",
    operationId: "playDeliveryArchive",
    summary: "Download the selected delivered patch archive for a run.",
    pathParams: ["runId"],
    contentType: "application/x-tar",
  },
  "patchIteration.deliveryArchive": {
    method: "GET",
    pathTemplate: "/api/play/patch-versions/{patchVersionId}/delivery/archive",
    operationId: "patchIterationDeliveryArchive",
    summary: "Download the immutable delivered patch archive for one exact patch version.",
    pathParams: ["patchVersionId"],
    contentType: "application/x-tar",
  },
};

/** Public, encoded URL used by the JSON delivery metadata response. */
export function playDeliveryArchivePath(runId: string): string {
  return `/api/play/runs/${encodeURIComponent(runId)}/delivery/archive`;
}

/** Public, encoded URL for the immutable historical-version archive endpoint. */
export function patchIterationDeliveryArchivePath(patchVersionId: string): string {
  return `/api/play/patch-versions/${encodeURIComponent(patchVersionId)}/delivery/archive`;
}

/**
 * Interpolate a route's `{param}` path template with concrete values (used by
 * the HTTP contract harness to build a request URL). Throws if a template
 * placeholder is missing from `params`.
 */
export function interpolateRoutePath(
  routeId: ItotoriApiRouteId,
  params?: Readonly<Record<string, string>>,
): string {
  const template = ITOTORI_API_ROUTES[routeId].pathTemplate;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params?.[name];
    if (value === undefined) {
      throw new Error(`route ${routeId} requires path param "${name}"`);
    }
    return value;
  });
}
