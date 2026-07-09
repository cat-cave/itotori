import type {
  AssetDecisionRecord,
  AssetLocalizationDecisionAssetKind,
  CandidateAssetRecord,
  CatalogConfidence,
  CatalogBenchmarkSeedFinderReadModel,
  CatalogCompletenessBenchmarkPools,
  CatalogCompletenessPool,
  CatalogConflictKind,
  CatalogConflictReviewReadModel,
  CatalogConflictReviewStatus,
  CatalogConflictStatus,
  CatalogExternalIdKind,
  CatalogLanguageStatus,
  CatalogLanguageStatusScope,
  CatalogOpportunityDecision,
  CatalogOpportunityFactorName,
  CatalogOpportunityMarketPrevalenceSignal,
  CatalogOpportunityRankingReadModel,
  CatalogOpportunityRuntimeEvidenceSignal,
  CatalogRawContentRedactionClass,
  CatalogSource,
  CatalogSourceRecordKind,
  BenchmarkQaAgentSummary,
  BenchmarkReportSummary,
  CostDrilldownPage,
  DashboardDecisionReadModel,
  JobsRunTableReadModel,
  ProjectCostReport,
  ProjectDashboardStatus,
  QueueHealthReadModel,
  MemberInvitationRecord,
  MemberRecord,
  ReviewerQueueAction,
  RuntimeDashboardStatus,
  TerminologySearchReadModel,
  WikiEntriesReadModel,
} from "@itotori/db";
import {
  assetLocalizationDecisionAssetKindList,
  assetLocalizationDecisionPolicyList,
  catalogCandidateMatchStatusValues,
  catalogCompletenessPoolValues,
  catalogConfidenceValues,
  catalogConflictKindValues,
  catalogConflictStatusValues,
  catalogExternalIdKindValues,
  catalogLanguageStatusScopeValues,
  catalogLanguageStatusValues,
  catalogRawContentRedactionClassValues,
  catalogSourceRecordKindValues,
  catalogSourceValues,
  feedbackTypeValues,
  reviewerQueueActionList,
  reviewerQueueItemKindList,
  reviewerQueueItemStateList,
  wikiEntryKindValues,
} from "@itotori/db";
import type { FeedbackType } from "@itotori/db";
import {
  assertBenchmarkReportV02,
  assertBridgeBundle,
  assertBridgeBundleV02,
  assertFindingRecordFixtureV02,
  assertPatchExport,
  assertPatchExportV02,
  assertRuntimeReport,
  assertTriageBundleV02,
  BENCHMARK_TOKEN_COUNT_SOURCES,
  BRIDGE_SCHEMA_VERSION_V02,
  TRIAGE_EVENT_KINDS,
  type BenchmarkReportV02,
  type BridgeBundle,
  type BridgeBundleV02,
  type FindingRecordV02,
  type PatchExport,
  type PatchExportV02,
  type RuntimeEvidenceReportV02,
  type RuntimeVerificationReport,
  type TriageEventV02,
} from "@itotori/localization-bridge-schema";
import type {
  BenchmarkRecordResult,
  DecisionRecordResult,
  FindingRecordResult,
  ProjectState,
  RuntimeIngestResult,
} from "./services/project-workflow.js";
import type {
  ReviewerQueueDashboardReadModel,
  ReviewerQueueDashboardRow,
  ReviewerQueueDashboardState,
  ReviewerSingleActionRequest,
  ReviewerSingleActionResult,
} from "./reviewer/api-service.js";
import { reviewerQueueDashboardStateValues } from "./reviewer/api-service.js";
import type { ReviewerBatchActionRequest, ReviewerBatchPreview } from "./reviewer/batch-preview.js";
import type { ReviewerBatchExecuteResult } from "./reviewer/batch-execute.js";
import type { ReviewerDetailContext } from "./reviewer/detail-fixtures.js";
import {
  workspaceDiagnosticCodeValues,
  workspaceSearchResultKindValues,
  workspaceSearchModeValues,
} from "./workspace/read-model.js";
import type {
  WorkspaceAssetBrowseReadModel,
  WorkspaceComparisonReadModel,
  WorkspaceProjectBrowseReadModel,
  WorkspaceSceneBrowseReadModel,
  WorkspaceSearchReadModel,
} from "./workspace/read-model.js";
import {
  workspaceCorrectionDiagnosticCodeValues,
  workspaceCorrectionDispositionValues,
} from "./workspace/correction-model.js";
import type {
  WorkspaceCorrectionPreviewReadModel,
  WorkspaceCorrectionSubmitReadModel,
} from "./workspace/correction-model.js";
import type {
  SubmitWorkspaceCorrectionsInput,
  WorkspaceCorrectionSubmission,
} from "./workspace/correction-service.js";
import type {
  ProjectOverviewBenchmarkHeadline,
  ProjectOverviewPassLedgerPage,
  ProjectOverviewPassLedgerRow,
  ProjectOverviewReadModel,
} from "./project-overview-read-model.js";
import { PROJECT_OVERVIEW_SCHEMA_VERSION } from "./project-overview-read-model.js";
import type { BmkCockpitReadModel, BmkCockpitRunHistoryPage } from "./bmk-cockpit-read-model.js";
import {
  BMK_COCKPIT_CONTESTANT_ROLES,
  BMK_COCKPIT_SCHEMA_VERSION,
} from "./bmk-cockpit-read-model.js";

export type ItotoriApiRouteId =
  | "assetDecisions.active"
  | "assetDecisions.candidates"
  | "catalog.benchmarkSeeds"
  | "catalog.completeness"
  | "catalog.conflicts"
  | "catalog.opportunities"
  | "reviewer.queue"
  | "reviewer.detail"
  | "reviewer.batchPreview"
  | "reviewer.batchExecute"
  | "reviewer.itemAction"
  | "terminology.search"
  | "wiki.entries"
  | "workspace.projects"
  | "workspace.scenes"
  | "workspace.assets"
  | "workspace.comparison"
  | "workspace.search"
  | "workspace.correctionPreview"
  | "workspace.correctionSubmit"
  | "projects.list"
  | "projects.overview"
  | "projects.status"
  | "projects.decisions"
  | "projects.cost"
  | "projects.costDrilldown"
  | "projects.benchmarks"
  // itotori-bmk-cockpit-read-model — the benchmark COCKPIT read-model route.
  // Returns the LATEST benchmark run's composed shape (5 contestants
  // official/self/self_nocontext/fan/mtl + human anchor + confidence + the
  // actionable improvement backlog). The benchmark is a DIAGNOSTIC INSTRUMENT,
  // not a leaderboard — the actionable backlog is the primary output.
  | "projects.bmkCockpit"
  // itotori-bmk-cockpit-history — paged run history, so a reviewer can confirm
  // the actionable backlog is shrinking over time. Same gate as `bmkCockpit`.
  | "projects.bmkCockpitHistory"
  | "jobs.runTable"
  | "runtime.status"
  | "queue.health"
  | "imports.bridge"
  | "branches.draft"
  | "findings.record"
  | "decisions.record"
  | "benchmarks.record"
  | "runtimeEvidence.ingest"
  | "auth.ssoSettings.configure"
  | "auth.members.list"
  | "auth.members.invite"
  | "auth.members.accept"
  | "auth.members.remove"
  // fnd-caps-context — the actor's Studio capability permission VIEW
  // (canFlag / canDecide / canSteer / canReveal), resolved from exact
  // permission grants via the auth-002 effective-permission resolver.
  | "auth.capabilities"
  // ovw-launch-pass-action — the Overview "launch next pass" mutation: folds
  // queued corrections and DRIVES the next localization pass via the
  // project-driven-executor / localize-fullproject driver. `canSteer`-gated
  // (the `draft.write` steer permission). The HTTP surface is a thin adapter;
  // the driver itself is unchanged.
  | "projects.launchPass"
  // play-mark-validated — per-scene localization coverage for the Play RouteMap.
  // GET loads nodes/edges with coverage state; POST sets a scene's state
  // (needs_check / flagged / validated). Persistence is `itotori_scene_localization_coverage`.
  | "play.routeMap"
  | "play.sceneCoverage"
  | "play.setSceneCoverage";

export type ApiErrorResponse = {
  error: string;
  code: "bad_request" | "forbidden" | "not_found" | "method_not_allowed" | "internal_error";
};

export const API_ERROR_RESPONSE_CODES = [
  "bad_request",
  "forbidden",
  "not_found",
  "method_not_allowed",
  "internal_error",
] as const satisfies readonly ApiErrorResponse["code"][];

/**
 * fe-openapi-parity-all-routes — the SINGLE authority for every STRICT
 * (`additionalProperties:false`) API body's top-level key list. Each guard
 * below passes its array here to {@link asStrictRecord} (so a leaked/renamed
 * top-level key is rejected by the runtime guard) AND the OpenAPI emitter
 * (`api-contract.ts`) generates that component's `required` +
 * `additionalProperties:false` from the SAME array. There is therefore exactly
 * one source for a strict body's envelope — the emitted JSON-Schema cannot fork
 * from the guard, for EVERY strict route (not just the ones with a parity
 * fixture). `schemaVersion`, when present, is listed in `keys` (the guard
 * asserts it as a literal) and the emitter pins it as a `const`.
 *
 * DECISION (Trevor 2026-07-07): the guards remain the contract AUTHORITY and
 * zod stays deferred; this metadata is a reusable VIEW of the guards' existing
 * strict key-lists, not a second schema definition. Deep field types stay with
 * the guards; this pins only the wire envelope (top-level keys + strictness +
 * schemaVersion const), consistent with the emitter's stated altitude.
 */
export const ITOTORI_STRICT_API_BODY_KEYS = {
  ApiErrorResponse: ["error", "code"],
  ReviewerQueuePermissionView: ["actorUserId", "canReadQueue", "canManageQueue", "denialReasons"],
  ApiAssetDecisionsResponse: ["decisions"],
  ApiCandidateAssetsResponse: ["candidateAssets"],
  WikiEntriesReadModel: ["schemaVersion", "generatedAt", "filter", "pagination", "entries"],
  CatalogBenchmarkSeedFinderReadModel: ["schemaVersion", "targetLanguage", "generatedAt", "rows"],
  CatalogCompletenessBenchmarkPools: ["targetLanguage", "pools", "publicReport"],
  CatalogConflictReviewReadModel: ["rows"],
  CatalogOpportunityRankingReadModel: [
    "schemaVersion",
    "targetLanguage",
    "generatedAt",
    "weightsVersion",
    "rows",
  ],
  ReviewerQueueDashboardReadModel: [
    "schemaVersion",
    "localeBranchId",
    "generatedAt",
    "permission",
    "rows",
    "aggregate",
    "defaultBatchRequest",
  ],
  ReviewerDetailContext: [
    "reviewItemId",
    "permission",
    "item",
    "source",
    "draft",
    "policy",
    "glossary",
    "branchReference",
    "qaFindings",
    "runtimeEvidence",
    "rationaleRefs",
    "transitions",
    "diagnostics",
  ],
  ReviewerBatchPreview: [
    "request",
    "permission",
    "items",
    "aggregate",
    "allAllowed",
    "permissionDenied",
  ],
  ReviewerBatchExecuteResult: ["request", "preview", "applied", "refusedAll", "appliedAll"],
  ReviewerSingleActionResult: ["request", "preview", "outcome", "applied", "refused"],
  CostDrilldownPage: ["filter", "pagination", "rows"],
  JobsRunTableReadModel: ["schemaVersion", "generatedAt", "filter", "pagination", "rows"],
  ProjectOverviewReadModel: [
    "schemaVersion",
    "generatedAt",
    "projectId",
    "progress",
    "decisions",
    "cost",
    "costDrilldown",
    "passLedger",
    "benchmarkHeadline",
    // ovw-launch-pass-action — whether the CALLER may steer the localization
    // (the `draft.write` steer permission). Sourced server-side so the Overview
    // launch-pass action gates itself off the composed payload it already reads
    // (never a client-fabricated capability). See `composeProjectOverviewReadModel`.
    "canSteer",
  ],
  ApiBenchmarkReportsResponse: ["reports"],
  // itotori-bmk-cockpit-read-model — the benchmark cockpit read-model envelope.
  BmkCockpitReadModel: [
    "schemaVersion",
    "generatedAt",
    "projectId",
    "localeBranchId",
    "runId",
    "targetLocale",
    "kind",
    "status",
    "unitsScored",
    "recordedAt",
    "contestants",
    "rankedRoles",
    "humanAnchor",
    "confidence",
    "actionableBacklog",
    "actionableBacklogSize",
  ],
  // itotori-bmk-cockpit-history — paged run-history rows envelope.
  BmkCockpitRunHistoryPage: ["filter", "pagination", "rows"],
  QueueHealthReadModel: ["schemaVersion", "generatedAt", "outbox", "jobs"],
  ApiConfigureAuthSsoSettingsRequest: ["accountId", "provider", "security", "sessionPolicy"],
  ApiConfigureAuthSsoSettingsResponse: [
    "schemaVersion",
    "accountId",
    "provider",
    "security",
    "sessionPolicy",
    "updatedAt",
  ],
  ApiInviteMemberRequest: [
    "accountId",
    "email",
    "initialPermissionSetIds",
    "expiresAt",
    "reason",
    "requestId",
  ],
  ApiMemberInvitationResponse: [
    "schemaVersion",
    "invitationId",
    "accountId",
    "email",
    "initialPermissionSetIds",
    "expiresAt",
    "acceptedAt",
    "revokedAt",
    "createdAt",
  ],
  ApiAcceptMemberInvitationRequest: [
    "userId",
    "principalId",
    "displayName",
    "email",
    "externalIdentity",
    "reason",
    "requestId",
  ],
  ApiMemberRecord: [
    "membershipId",
    "accountId",
    "userId",
    "principalId",
    "email",
    "displayName",
    "permissionSetIds",
    "createdAt",
  ],
  ApiMemberResponse: ["schemaVersion", "member"],
  ApiMembersListResponse: ["schemaVersion", "accountId", "members"],
  ApiRemoveMemberRequest: ["reason", "requestId"],
  ApiRemoveMemberResponse: ["schemaVersion", "removedMember"],
  // fnd-caps-context — Studio capability permission view wire envelope.
  ApiAuthCapabilitiesResponse: [
    "schemaVersion",
    "actorUserId",
    "canReadQueue",
    "canManageQueue",
    "canFlag",
    "canDecide",
    "canSteer",
    "canReveal",
    "denials",
    "denialReasons",
  ],
  ApiStudioCapabilityDenials: ["flag", "decide", "steer", "reveal", "queueRead", "queueManage"],
  WorkspaceProjectBrowseReadModel: [
    "schemaVersion",
    "generatedAt",
    "permission",
    "projects",
    "diagnostics",
  ],
  WorkspaceSceneBrowseReadModel: [
    "schemaVersion",
    "generatedAt",
    "permission",
    "projectId",
    "localeBranchId",
    "scenes",
    "diagnostics",
  ],
  WorkspaceAssetBrowseReadModel: [
    "schemaVersion",
    "generatedAt",
    "permission",
    "projectId",
    "localeBranchId",
    "assets",
    "diagnostics",
  ],
  WorkspaceComparisonReadModel: [
    "schemaVersion",
    "generatedAt",
    "permission",
    "reviewItemId",
    "localeBranchId",
    "sourceRevisionId",
    "bridgeUnitId",
    "sourceUnitKey",
    "contextNote",
    "cells",
    "hasFinal",
    "runtimeEvidenceLinks",
    "diagnostics",
  ],
  WorkspaceSearchReadModel: [
    "schemaVersion",
    "generatedAt",
    "permission",
    "projectId",
    "localeBranchId",
    "query",
    "normalizedQuery",
    "mode",
    "pagination",
    "results",
    "droppedOpaqueCount",
    "diagnostics",
  ],
  WorkspaceCorrectionPreviewReadModel: [
    "schemaVersion",
    "generatedAt",
    "permission",
    "localeBranchId",
    "units",
    "diagnostics",
  ],
  WorkspaceCorrectionSubmitReadModel: [
    "schemaVersion",
    "generatedAt",
    "permission",
    "localeBranchId",
    "batchId",
    "batchLabel",
    "submittedCount",
    "edits",
    "repairCandidateReportIds",
    "decisionQueueReportIds",
    "needsContextReportIds",
    "affectedBridgeUnitIds",
    "writebacks",
    "scheduledRerunJobIds",
    "diagnostics",
  ],
  ReviewerBatchActionRequest: ["action", "actorUserId", "selections"],
  // ovw-launch-pass-action — the typed launch-pass response envelope. The
  // schemaVersion const pins the wire shape; a renamed / leaked field fails a
  // contract test instead of silently drifting.
  ApiLaunchPassResponse: ["schemaVersion", "outcome", "passNumber", "startedAt", "refusalMessage"],
  // play-routemap-ui — route/choice tree envelope.
  ApiPlayRouteMapResponse: [
    "schemaVersion",
    "generatedAt",
    "projectId",
    "localeBranchId",
    "nodes",
    "edges",
    "counts",
  ],
  // play-mark-validated — coverage read model + set response (strict).
  ApiPlaySceneCoverageResponse: [
    "schemaVersion",
    "generatedAt",
    "projectId",
    "localeBranchId",
    "nodes",
    "edges",
    "counts",
  ],
  ApiPlaySetSceneCoverageResponse: [
    "schemaVersion",
    "projectId",
    "localeBranchId",
    "sceneId",
    "coverageState",
    "updatedAt",
    "updatedByUserId",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type ItotoriStrictApiBodyName = keyof typeof ITOTORI_STRICT_API_BODY_KEYS;

/**
 * ITOTORI-051 — assert an {@link ApiErrorResponse} body. Error responses are
 * not tied to a single route id (every route may emit one), so they are
 * validated independently of {@link assertItotoriApiResponse}. The MSW
 * mutation contract handlers + tests use this so a typed error-shape change
 * (a renamed `code` enum value, a missing `error` string, an extra leaked
 * field) fails a dashboard contract test instead of silently diverging.
 */
export function assertItotoriApiErrorResponse(
  value: unknown,
  label = "ApiErrorResponse",
): asserts value is ApiErrorResponse {
  const response = asStrictRecord(value, label, ITOTORI_STRICT_API_BODY_KEYS.ApiErrorResponse);
  assertString(response.error, `${label}.error`);
  assertEnum(response.code, API_ERROR_RESPONSE_CODES, `${label}.code`);
}

export type ApiProjectsResponse = {
  projects: ProjectDashboardStatus[];
};

export type ApiProjectCostResponse = ProjectCostReport;

export type ApiProjectCostDrilldownResponse = CostDrilldownPage;

export type ApiProjectOverviewResponse = ProjectOverviewReadModel;

export type ApiJobsRunTableResponse = JobsRunTableReadModel;

export type ApiBenchmarkReportsResponse = {
  reports: BenchmarkReportSummary[];
};

/**
 * itotori-bmk-cockpit-read-model — the typed /api/projects/{projectId}/bmk-cockpit
 * response. The cockpit composes the persisted benchmark run body onto the §10
 * framing's vocabulary: 5 contestants (official / self / self_nocontext / fan /
 * mtl) + the §8 human anchor + a confidence rollup + the actionable backlog.
 */
export type ApiBmkCockpitResponse = BmkCockpitReadModel;

/** itotori-bmk-cockpit-history — paged run-history response. */
export type ApiBmkCockpitHistoryResponse = BmkCockpitRunHistoryPage;

/** ITOTORI-047 — typed queue-health read-model (outbox lag, job/retry/dead-letter). */
export type ApiQueueHealthResponse = QueueHealthReadModel;

export type ApiDashboardDecisionsResponse = DashboardDecisionReadModel;

export type ApiCatalogConflictReviewResponse = CatalogConflictReviewReadModel;

export type ApiCatalogCompletenessResponse = CatalogCompletenessBenchmarkPools;

export type ApiCatalogBenchmarkSeedsResponse = CatalogBenchmarkSeedFinderReadModel;

export type ApiCatalogOpportunitiesResponse = CatalogOpportunityRankingReadModel;

export type ApiTerminologySearchResponse = TerminologySearchReadModel;

export type ApiWikiEntriesResponse = WikiEntriesReadModel;

export type ApiWorkspaceProjectBrowseResponse = WorkspaceProjectBrowseReadModel;

export type ApiWorkspaceSceneBrowseResponse = WorkspaceSceneBrowseReadModel;

export type ApiWorkspaceAssetBrowseResponse = WorkspaceAssetBrowseReadModel;

export type ApiWorkspaceComparisonResponse = WorkspaceComparisonReadModel;

export type ApiWorkspaceSearchResponse = WorkspaceSearchReadModel;

export type ApiWorkspaceCorrectionPreviewResponse = WorkspaceCorrectionPreviewReadModel;

export type ApiWorkspaceCorrectionSubmitResponse = WorkspaceCorrectionSubmitReadModel;

export type ApiWorkspaceCorrectionSubmitRequest = Omit<
  SubmitWorkspaceCorrectionsInput,
  "permission"
>;

export type ApiReviewerQueueDashboardResponse = ReviewerQueueDashboardReadModel;

export type ApiReviewerDetailResponse = ReviewerDetailContext;

export type ApiReviewerBatchPreviewRequest = ReviewerBatchActionRequest;

export type ApiReviewerBatchPreviewResponse = ReviewerBatchPreview;

export type ApiReviewerBatchExecuteRequest = ReviewerBatchActionRequest;

export type ApiReviewerBatchExecuteResponse = ReviewerBatchExecuteResult;

/** ITOTORI-082 — single-item reviewer action. */
export type ApiReviewerSingleActionRequest = ReviewerSingleActionRequest;

export type ApiReviewerSingleActionResponse = ReviewerSingleActionResult;

export type ApiAssetDecisionsResponse = {
  decisions: AssetDecisionRecord[];
};

export type ApiCandidateAssetsResponse = {
  candidateAssets: CandidateAssetRecord[];
};

export type ApiProjectImportRequest = {
  bridge: BridgeBundle | BridgeBundleV02;
};

export type ApiProjectImportResponse = {
  project: ProjectState;
  status: ProjectDashboardStatus;
};

export type ApiDraftBranchRequest = {
  project: ProjectState;
  targetLocale: string;
};

export type ApiDraftBranchResponse = {
  project: ProjectState;
  status: ProjectDashboardStatus;
};

export type ApiRecordFindingRequest = {
  localeBranchId?: string;
  finding: FindingRecordV02;
  status?: "open" | "resolved" | "superseded";
};

export type ApiRecordFindingResponse = FindingRecordResult;

export type ApiRecordDecisionRequest = {
  localeBranchId?: string;
  event: TriageEventV02;
};

export type ApiRecordDecisionResponse = DecisionRecordResult;

export type ApiRecordBenchmarkRequest = {
  benchmarkReport: BenchmarkReportV02;
};

export type ApiRecordBenchmarkResponse = BenchmarkRecordResult;

export type ApiRuntimeEvidenceRequest = {
  project: ProjectState;
  runtimeReport: RuntimeVerificationReport | RuntimeEvidenceReportV02;
};

export type ApiRuntimeEvidenceResponse = RuntimeIngestResult;

export type ApiAuthSsoProviderConfig =
  | {
      protocol: "oidc";
      providerId: string;
      displayName: string;
      enabled: boolean;
      issuer: string;
      clientId: string;
      scopes: readonly string[];
    }
  | {
      protocol: "saml";
      providerId: string;
      displayName: string;
      enabled: boolean;
      ssoUrl: string;
      entityId: string;
      certificateFingerprint?: string;
    };

export type ApiAccountSecuritySettings = {
  requireSso: boolean;
  requireMfa: boolean;
  allowPasswordLogin: boolean;
};

export type ApiAuthSessionPolicy = {
  idleTimeoutMinutes: number;
  absoluteTimeoutMinutes: number;
};

export type ApiConfigureAuthSsoSettingsRequest = {
  accountId: string;
  provider: ApiAuthSsoProviderConfig;
  security: ApiAccountSecuritySettings;
  sessionPolicy: ApiAuthSessionPolicy;
};

export type ApiConfigureAuthSsoSettingsResponse = ApiConfigureAuthSsoSettingsRequest & {
  schemaVersion: "itotori.auth.sso-settings.v0";
  updatedAt: string;
};

export type ApiInviteMemberRequest = {
  accountId: string;
  email: string;
  initialPermissionSetIds: readonly string[];
  expiresAt: string;
  reason: string | null;
  requestId: string | null;
};

export type ApiMemberInvitationResponse = Omit<
  MemberInvitationRecord,
  "expiresAt" | "acceptedAt" | "revokedAt" | "createdAt"
> & {
  schemaVersion: "itotori.auth.member-invitation.v0";
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export type ApiExternalIdentityLinkRequest = {
  provider: string;
  subject: string;
};

export type ApiAcceptMemberInvitationRequest = {
  userId: string;
  principalId: string;
  displayName: string;
  email: string;
  externalIdentity: ApiExternalIdentityLinkRequest | null;
  reason: string | null;
  requestId: string | null;
};

export type ApiMemberRecord = Omit<MemberRecord, "createdAt"> & {
  createdAt: string;
};

export type ApiMemberResponse = {
  schemaVersion: "itotori.auth.member.v0";
  member: ApiMemberRecord;
};

export type ApiMembersListResponse = {
  schemaVersion: "itotori.auth.members.v0";
  accountId: string;
  members: ApiMemberRecord[];
};

/**
 * fnd-caps-context — the actor's Studio capability permission VIEW on the
 * wire. Sourced server-side from exact permission grants (capabilities, NOT
 * roles) via `resolveStudioCapabilityPermissionView`. The SPA CapsProvider
 * consumes this shape to gate flag / decide / steer / reveal actions.
 */
export type ApiAuthCapabilitiesResponse = {
  schemaVersion: "itotori.auth.capabilities.v0";
  actorUserId: string;
  canReadQueue: boolean;
  canManageQueue: boolean;
  canFlag: boolean;
  canDecide: boolean;
  canSteer: boolean;
  canReveal: boolean;
  denials: {
    flag: string | null;
    decide: string | null;
    steer: string | null;
    reveal: string | null;
    queueRead: string | null;
    queueManage: string | null;
  };
  denialReasons: string[];
};

export type ApiRemoveMemberRequest = {
  reason: string | null;
  requestId: string | null;
};

export type ApiRemoveMemberResponse = {
  schemaVersion: "itotori.auth.member-removed.v0";
  removedMember: ApiMemberRecord;
};

/**
 * ovw-launch-pass-action — request body for the launch-pass mutation. The
 * Overview action wires through the typed client. The body carries the locale
 * branch the next pass is scoped to; the server VERIFIES it against the
 * project's server-side ownership set (a forged branch is refused) before the
 * driver is touched. The project id lives on the URL path.
 */
export type ApiLaunchPassRequest = {
  /** The locale branch the next pass is scoped to (validated server-side). */
  localeBranchId: string;
};

/**
 * ovw-launch-pass-action — response body for the launch-pass mutation. A thin,
 * driver-agnostic confirmation the UI can render after a click: a typed
 * `outcome` (`started` / `refused`) plus the launched pass number + start
 * timestamp (on `started`) or a refusal reason (on `refused`). A refused launch
 * is surfaced in-band so the Overview strip renders it like any driver
 * response, never as a silent success.
 */
export type ApiLaunchPassResponse = {
  schemaVersion: "itotori.projects.launch-pass.v0";
  /** The driver outcome: the pass was started, or the driver refused it. */
  outcome: "started" | "refused";
  /** The pass number that was launched (> 0) on `started`; `null` on `refused`. */
  passNumber: number | null;
  /** ISO timestamp the pass was started on `started`; `null` on `refused`. */
  startedAt: string | null;
  /** Refusal reason (non-empty) on `refused`; `null` on `started`. */
  refusalMessage: string | null;
};

/** Closed coverage vocabulary (play-mark-validated). */
export type ApiSceneCoverageState = "needs_check" | "flagged" | "validated";

export const API_SCENE_COVERAGE_STATES = [
  "needs_check",
  "flagged",
  "validated",
] as const satisfies readonly ApiSceneCoverageState[];

/**
 * play-mark-validated — request body for setting a scene's coverage state.
 * projectId + localeBranchId live on the URL path; the body carries the scene
 * and the target state.
 */
export type ApiPlaySetSceneCoverageRequest = {
  sceneId: string;
  coverageState: ApiSceneCoverageState;
};

/**
 * play-mark-validated — one RouteMap node with its coverage state. `sceneId` is
 * the opaque game-agnostic key (matches scene-summary / route-map identity when
 * shared). Unpersisted scenes default to `needs_check`.
 */
export type ApiPlaySceneCoverageNode = {
  sceneId: string;
  label: string;
  coverageState: ApiSceneCoverageState;
  routeKey: string | null;
  routeMapId: string | null;
};

/** play-mark-validated — one choice edge between scenes on the RouteMap. */
export type ApiPlaySceneCoverageEdge = {
  fromSceneId: string;
  toSceneId: string;
  choiceKey: string;
  label: string;
};

/** play-mark-validated — aggregate counts for the branch's coverage. */
export type ApiPlaySceneCoverageCounts = {
  needsCheck: number;
  flagged: number;
  validated: number;
  total: number;
};

/**
 * play-mark-validated — GET response: the Play RouteMap coverage read-model.
 * Nodes carry per-scene coverage; edges come from routeChoices.
 */
export type ApiPlaySceneCoverageResponse = {
  schemaVersion: "itotori.play.scene-coverage.v0";
  generatedAt: string;
  projectId: string;
  localeBranchId: string;
  nodes: ApiPlaySceneCoverageNode[];
  edges: ApiPlaySceneCoverageEdge[];
  counts: ApiPlaySceneCoverageCounts;
};

/**
 * play-mark-validated — POST response: the scene's durable coverage after the
 * upsert. The client re-fetches the full map (or patches local state) from this.
 */
export type ApiPlaySetSceneCoverageResponse = {
  schemaVersion: "itotori.play.set-scene-coverage.v0";
  projectId: string;
  localeBranchId: string;
  sceneId: string;
  coverageState: ApiSceneCoverageState;
  updatedAt: string;
  updatedByUserId: string;
};

// play-routemap-ui — route/choice tree read-model response. Coverage is derived
// from the route-choice map status (Fresh -> fresh, Stale -> stale).
export type ApiPlayRouteMapCoverageState = "fresh" | "stale";

export type ApiPlayRouteMapNode = {
  routeKey: string;
  routeMapId: string;
  label: string;
  summary: string;
  col: number;
  row: number;
  state: ApiPlayRouteMapCoverageState;
  coverage: ApiPlayRouteMapCoverageState;
  issues: number;
};

export type ApiPlayRouteMapEdge = {
  fromRouteKey: string;
  toRouteKey: string;
  choiceKey: string;
  choiceKind: string;
  label: string;
};

export type ApiPlayRouteMapCounts = {
  fresh: number;
  stale: number;
  total: number;
  choiceCount: number;
};

export type ApiPlayRouteMapResponse = {
  schemaVersion: "itotori.play.route-map.v0";
  generatedAt: string;
  projectId: string;
  localeBranchId: string;
  nodes: ApiPlayRouteMapNode[];
  edges: ApiPlayRouteMapEdge[];
  counts: ApiPlayRouteMapCounts;
};

export type ItotoriApiResponseBody =
  | ApiAssetDecisionsResponse
  | ApiCandidateAssetsResponse
  | ApiCatalogBenchmarkSeedsResponse
  | ApiCatalogCompletenessResponse
  | ApiCatalogConflictReviewResponse
  | ApiCatalogOpportunitiesResponse
  | ApiReviewerQueueDashboardResponse
  | ApiReviewerDetailResponse
  | ApiReviewerBatchPreviewResponse
  | ApiReviewerBatchExecuteResponse
  | ApiReviewerSingleActionResponse
  | ApiTerminologySearchResponse
  | ApiWikiEntriesResponse
  | ApiWorkspaceProjectBrowseResponse
  | ApiWorkspaceSceneBrowseResponse
  | ApiWorkspaceAssetBrowseResponse
  | ApiWorkspaceComparisonResponse
  | ApiWorkspaceSearchResponse
  | ApiWorkspaceCorrectionPreviewResponse
  | ApiWorkspaceCorrectionSubmitResponse
  | ApiProjectsResponse
  | ApiProjectOverviewResponse
  | ProjectDashboardStatus
  | ApiDashboardDecisionsResponse
  | ApiProjectCostResponse
  | ApiProjectCostDrilldownResponse
  | ApiBenchmarkReportsResponse
  | ApiBmkCockpitResponse
  | ApiBmkCockpitHistoryResponse
  | ApiJobsRunTableResponse
  | ApiQueueHealthResponse
  | RuntimeDashboardStatus
  | ApiProjectImportResponse
  | ApiDraftBranchResponse
  | ApiRecordFindingResponse
  | ApiRecordDecisionResponse
  | ApiRecordBenchmarkResponse
  | ApiRuntimeEvidenceResponse
  | ApiConfigureAuthSsoSettingsResponse
  | ApiMemberInvitationResponse
  | ApiMemberResponse
  | ApiMembersListResponse
  | ApiRemoveMemberResponse
  | ApiAuthCapabilitiesResponse
  | ApiLaunchPassResponse
  | ApiPlayRouteMapResponse
  | ApiPlaySceneCoverageResponse
  | ApiPlaySetSceneCoverageResponse
  | ApiErrorResponse;

export class ApiValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiValidationError";
  }
}

export function parseProjectImportRequest(body: unknown): ApiProjectImportRequest {
  return parseRequest("ApiProjectImportRequest", () => {
    const request = asRecord(body, "ApiProjectImportRequest");
    assertBridgeInput(request.bridge);
    return { bridge: request.bridge };
  });
}

export function parseDraftBranchRequest(body: unknown): ApiDraftBranchRequest {
  return parseRequest("ApiDraftBranchRequest", () => {
    const request = asRecord(body, "ApiDraftBranchRequest");
    assertProjectState(request.project, "ApiDraftBranchRequest.project");
    assertString(request.targetLocale, "ApiDraftBranchRequest.targetLocale");
    return { project: request.project, targetLocale: request.targetLocale };
  });
}

export function parseRecordFindingRequest(body: unknown): ApiRecordFindingRequest {
  return parseRequest("ApiRecordFindingRequest", () => {
    const request = asRecord(body, "ApiRecordFindingRequest");
    if (request.localeBranchId !== undefined) {
      assertString(request.localeBranchId, "ApiRecordFindingRequest.localeBranchId");
    }
    assertFindingRecordInput(request.finding, "ApiRecordFindingRequest.finding");
    const result: ApiRecordFindingRequest = { finding: request.finding };
    if (request.localeBranchId !== undefined) {
      result.localeBranchId = request.localeBranchId;
    }
    if (request.status !== undefined) {
      assertEnum(
        request.status,
        ["open", "resolved", "superseded"] as const,
        "ApiRecordFindingRequest.status",
      );
      result.status = request.status;
    }
    return result;
  });
}

export function parseRecordDecisionRequest(body: unknown): ApiRecordDecisionRequest {
  return parseRequest("ApiRecordDecisionRequest", () => {
    const request = asRecord(body, "ApiRecordDecisionRequest");
    if (request.localeBranchId !== undefined) {
      assertString(request.localeBranchId, "ApiRecordDecisionRequest.localeBranchId");
    }
    assertDecisionEvent(request.event, "ApiRecordDecisionRequest.event");
    const result: ApiRecordDecisionRequest = { event: request.event };
    if (request.localeBranchId !== undefined) {
      result.localeBranchId = request.localeBranchId;
    }
    return result;
  });
}

export function parseRecordBenchmarkRequest(body: unknown): ApiRecordBenchmarkRequest {
  return parseRequest("ApiRecordBenchmarkRequest", () => {
    const request = asRecord(body, "ApiRecordBenchmarkRequest");
    assertBenchmarkReportV02(request.benchmarkReport);
    // ITOTORI-059 — the recorded benchmark MUST self-identify its locale
    // branch. There is no separate envelope channel and no project-level
    // fallback: a report that omits localeBranchId is rejected so cost +
    // benchmark records can never be attributed to the wrong branch.
    if (request.benchmarkReport.localeBranchId === undefined) {
      throw new ApiValidationError(
        "ApiRecordBenchmarkRequest.benchmarkReport.localeBranchId is required (a benchmark must identify its target locale branch)",
      );
    }
    return { benchmarkReport: request.benchmarkReport };
  });
}

export function parseRuntimeEvidenceRequest(body: unknown): ApiRuntimeEvidenceRequest {
  return parseRequest("ApiRuntimeEvidenceRequest", () => {
    const request = asRecord(body, "ApiRuntimeEvidenceRequest");
    assertProjectState(request.project, "ApiRuntimeEvidenceRequest.project");
    assertRuntimeReport(request.runtimeReport);
    return { project: request.project, runtimeReport: request.runtimeReport };
  });
}

export function parseConfigureAuthSsoSettingsRequest(
  body: unknown,
): ApiConfigureAuthSsoSettingsRequest {
  return parseRequest("ApiConfigureAuthSsoSettingsRequest", () => {
    const request = asStrictRecord(
      body,
      "ApiConfigureAuthSsoSettingsRequest",
      ITOTORI_STRICT_API_BODY_KEYS.ApiConfigureAuthSsoSettingsRequest,
    );
    assertString(request.accountId, "ApiConfigureAuthSsoSettingsRequest.accountId");
    return {
      accountId: request.accountId,
      provider: parseAuthSsoProviderConfig(
        request.provider,
        "ApiConfigureAuthSsoSettingsRequest.provider",
      ),
      security: parseAccountSecuritySettings(
        request.security,
        "ApiConfigureAuthSsoSettingsRequest.security",
      ),
      sessionPolicy: parseAuthSessionPolicy(
        request.sessionPolicy,
        "ApiConfigureAuthSsoSettingsRequest.sessionPolicy",
      ),
    };
  });
}

export function parseInviteMemberRequest(body: unknown): ApiInviteMemberRequest {
  return parseRequest("ApiInviteMemberRequest", () => {
    const request = asStrictRecord(
      body,
      "ApiInviteMemberRequest",
      ITOTORI_STRICT_API_BODY_KEYS.ApiInviteMemberRequest,
    );
    assertString(request.accountId, "ApiInviteMemberRequest.accountId");
    assertString(request.email, "ApiInviteMemberRequest.email");
    assertStringArray(
      request.initialPermissionSetIds,
      "ApiInviteMemberRequest.initialPermissionSetIds",
    );
    assertDateLike(request.expiresAt, "ApiInviteMemberRequest.expiresAt");
    assertNullableString(request.reason, "ApiInviteMemberRequest.reason");
    assertNullableString(request.requestId, "ApiInviteMemberRequest.requestId");
    const expiresAt =
      request.expiresAt instanceof Date
        ? request.expiresAt.toISOString()
        : String(request.expiresAt);
    return {
      accountId: request.accountId,
      email: request.email,
      initialPermissionSetIds: request.initialPermissionSetIds as string[],
      expiresAt,
      reason: request.reason,
      requestId: request.requestId,
    };
  });
}

export function parseAcceptMemberInvitationRequest(
  body: unknown,
): ApiAcceptMemberInvitationRequest {
  return parseRequest("ApiAcceptMemberInvitationRequest", () => {
    const request = asStrictRecord(
      body,
      "ApiAcceptMemberInvitationRequest",
      ITOTORI_STRICT_API_BODY_KEYS.ApiAcceptMemberInvitationRequest,
    );
    assertString(request.userId, "ApiAcceptMemberInvitationRequest.userId");
    assertString(request.principalId, "ApiAcceptMemberInvitationRequest.principalId");
    assertString(request.displayName, "ApiAcceptMemberInvitationRequest.displayName");
    assertString(request.email, "ApiAcceptMemberInvitationRequest.email");
    assertNullableString(request.reason, "ApiAcceptMemberInvitationRequest.reason");
    assertNullableString(request.requestId, "ApiAcceptMemberInvitationRequest.requestId");
    return {
      userId: request.userId,
      principalId: request.principalId,
      displayName: request.displayName,
      email: request.email,
      externalIdentity: parseNullableExternalIdentityLink(
        request.externalIdentity,
        "ApiAcceptMemberInvitationRequest.externalIdentity",
      ),
      reason: request.reason,
      requestId: request.requestId,
    };
  });
}

export function parseRemoveMemberRequest(body: unknown): ApiRemoveMemberRequest {
  return parseRequest("ApiRemoveMemberRequest", () => {
    const request = asStrictRecord(
      body,
      "ApiRemoveMemberRequest",
      ITOTORI_STRICT_API_BODY_KEYS.ApiRemoveMemberRequest,
    );
    assertNullableString(request.reason, "ApiRemoveMemberRequest.reason");
    assertNullableString(request.requestId, "ApiRemoveMemberRequest.requestId");
    return { reason: request.reason, requestId: request.requestId };
  });
}

export function parseReviewerBatchPreviewRequest(body: unknown): ApiReviewerBatchPreviewRequest {
  return parseRequest("ApiReviewerBatchPreviewRequest", () => {
    const request = asStrictRecord(
      body,
      "ApiReviewerBatchPreviewRequest",
      ITOTORI_STRICT_API_BODY_KEYS.ReviewerBatchActionRequest,
    );
    assertEnum(
      request.action,
      reviewerQueueActionList as readonly ReviewerQueueAction[],
      "ApiReviewerBatchPreviewRequest.action",
    );
    assertString(request.actorUserId, "ApiReviewerBatchPreviewRequest.actorUserId");
    const selections = asArray(request.selections, "ApiReviewerBatchPreviewRequest.selections").map(
      (value, index) => {
        const selection = asStrictRecord(
          value,
          `ApiReviewerBatchPreviewRequest.selections[${index}]`,
          ["reviewItemId", "expectedSourceRevisionId"],
        );
        assertString(
          selection.reviewItemId,
          `ApiReviewerBatchPreviewRequest.selections[${index}].reviewItemId`,
        );
        assertString(
          selection.expectedSourceRevisionId,
          `ApiReviewerBatchPreviewRequest.selections[${index}].expectedSourceRevisionId`,
        );
        return {
          reviewItemId: selection.reviewItemId,
          expectedSourceRevisionId: selection.expectedSourceRevisionId,
        };
      },
    );
    return {
      action: request.action,
      actorUserId: request.actorUserId,
      selections,
    };
  });
}

export function parseReviewerBatchExecuteRequest(body: unknown): ApiReviewerBatchExecuteRequest {
  return parseReviewerBatchActionRequestBody(body, "ApiReviewerBatchExecuteRequest");
}

/**
 * ITOTORI-082 — single-item reviewer action. Only the 5 per-item verbs
 * are accepted here (accept/reject/defer/escalate/request_repair); the
 * glossary/style/runtime-feedback verbs stay batch/agentic-loop
 * concerns. `reviewItemId` is threaded in from the URL path, never the
 * body, so the item acted upon always matches the route.
 */
export const reviewerSingleActionList = [
  "approve",
  "reject",
  "defer",
  "escalate",
  "request_repair",
] as const satisfies readonly ReviewerQueueAction[];

export function parseReviewerSingleActionRequest(
  body: unknown,
  reviewItemId: string,
): ApiReviewerSingleActionRequest {
  return parseRequest("ApiReviewerSingleActionRequest", () => {
    assertString(reviewItemId, "ApiReviewerSingleActionRequest.reviewItemId");
    const preview = asRecord(body, "ApiReviewerSingleActionRequest");
    assertEnum(preview.action, reviewerSingleActionList, "ApiReviewerSingleActionRequest.action");
    const allowedKeys = allowedKeysForSingleAction(preview.action);
    const request = asStrictRecord(body, "ApiReviewerSingleActionRequest", allowedKeys);
    assertString(request.actorUserId, "ApiReviewerSingleActionRequest.actorUserId");
    assertString(
      request.expectedSourceRevisionId,
      "ApiReviewerSingleActionRequest.expectedSourceRevisionId",
    );
    const base = {
      reviewItemId,
      actorUserId: request.actorUserId,
      expectedSourceRevisionId: request.expectedSourceRevisionId,
    };
    switch (preview.action) {
      case "approve":
        return { ...base, action: "approve" };
      case "reject":
        return { ...base, action: "reject" };
      case "defer":
        assertString(request.deferReason, "ApiReviewerSingleActionRequest.deferReason");
        return { ...base, action: "defer", deferReason: request.deferReason };
      case "escalate":
        assertString(request.escalationReason, "ApiReviewerSingleActionRequest.escalationReason");
        assertString(request.escalationTarget, "ApiReviewerSingleActionRequest.escalationTarget");
        return {
          ...base,
          action: "escalate",
          escalationReason: request.escalationReason,
          escalationTarget: request.escalationTarget,
        };
      case "request_repair":
        assertString(request.repairHint, "ApiReviewerSingleActionRequest.repairHint");
        return { ...base, action: "request_repair", repairHint: request.repairHint };
      default: {
        const exhaustive: never = preview.action;
        throw new Error(`unhandled single reviewer action: ${String(exhaustive)}`);
      }
    }
  });
}

function allowedKeysForSingleAction(
  action: (typeof reviewerSingleActionList)[number],
): readonly string[] {
  const base = ["action", "actorUserId", "expectedSourceRevisionId"] as const;
  switch (action) {
    case "approve":
    case "reject":
      return base;
    case "defer":
      return [...base, "deferReason"];
    case "escalate":
      return [...base, "escalationReason", "escalationTarget"];
    case "request_repair":
      return [...base, "repairHint"];
    default: {
      const exhaustive: never = action;
      throw new Error(`unhandled single reviewer action: ${String(exhaustive)}`);
    }
  }
}

export function assertItotoriApiResponse(
  routeId: ItotoriApiRouteId,
  value: unknown,
): asserts value is ItotoriApiResponseBody {
  switch (routeId) {
    case "assetDecisions.active":
      assertApiAssetDecisionsResponse(value);
      return;
    case "assetDecisions.candidates":
      assertApiCandidateAssetsResponse(value);
      return;
    case "catalog.benchmarkSeeds":
      assertCatalogBenchmarkSeedFinderReadModel(value);
      return;
    case "catalog.completeness":
      assertCatalogCompletenessBenchmarkPools(value);
      return;
    case "catalog.conflicts":
      assertCatalogConflictReviewReadModel(value);
      return;
    case "catalog.opportunities":
      assertCatalogOpportunityRankingReadModel(value);
      return;
    case "reviewer.queue":
      assertReviewerQueueDashboardReadModel(value);
      return;
    case "reviewer.detail":
      assertReviewerDetailContext(value);
      return;
    case "reviewer.batchPreview":
      assertReviewerBatchPreview(value);
      return;
    case "reviewer.batchExecute":
      assertReviewerBatchExecuteResult(value);
      return;
    case "reviewer.itemAction":
      assertReviewerSingleActionResult(value);
      return;
    case "terminology.search":
      assertTerminologySearchReadModel(value);
      return;
    case "wiki.entries":
      assertWikiEntriesReadModel(value);
      return;
    case "workspace.projects":
      assertWorkspaceProjectBrowseReadModel(value);
      return;
    case "workspace.scenes":
      assertWorkspaceSceneBrowseReadModel(value);
      return;
    case "workspace.assets":
      assertWorkspaceAssetBrowseReadModel(value);
      return;
    case "workspace.comparison":
      assertWorkspaceComparisonReadModel(value);
      return;
    case "workspace.search":
      assertWorkspaceSearchReadModel(value);
      return;
    case "workspace.correctionPreview":
      assertWorkspaceCorrectionPreviewReadModel(value);
      return;
    case "workspace.correctionSubmit":
      assertWorkspaceCorrectionSubmitReadModel(value);
      return;
    case "projects.list":
      assertProjectsResponse(value);
      return;
    case "projects.overview":
      assertProjectOverviewReadModel(value);
      return;
    case "projects.status":
      assertProjectDashboardStatus(value);
      return;
    case "projects.decisions":
      assertDashboardDecisionReadModel(value);
      return;
    case "projects.cost":
      assertProjectCostReport(value);
      return;
    case "projects.costDrilldown":
      assertProjectCostDrilldownResponse(value);
      return;
    case "projects.benchmarks":
      assertApiBenchmarkReportsResponse(value);
      return;
    case "projects.bmkCockpit":
      assertBmkCockpitReadModel(value);
      return;
    case "projects.bmkCockpitHistory":
      assertBmkCockpitRunHistoryPage(value);
      return;
    case "jobs.runTable":
      assertJobsRunTableReadModel(value);
      return;
    case "queue.health":
      assertQueueHealthReadModel(value);
      return;
    case "runtime.status":
      assertRuntimeDashboardStatus(value);
      return;
    case "imports.bridge":
      assertProjectImportResponse(value);
      return;
    case "branches.draft":
      assertDraftBranchResponse(value);
      return;
    case "findings.record":
      assertRecordFindingResponse(value);
      return;
    case "decisions.record":
      assertRecordDecisionResponse(value);
      return;
    case "benchmarks.record":
      assertRecordBenchmarkResponse(value);
      return;
    case "runtimeEvidence.ingest":
      assertRuntimeEvidenceResponse(value);
      return;
    case "auth.ssoSettings.configure":
      assertConfigureAuthSsoSettingsResponse(value);
      return;
    case "auth.members.list":
      assertMembersListResponse(value);
      return;
    case "auth.members.invite":
      assertMemberInvitationResponse(value);
      return;
    case "auth.members.accept":
      assertMemberResponse(value);
      return;
    case "auth.members.remove":
      assertRemoveMemberResponse(value);
      return;
    case "auth.capabilities":
      assertAuthCapabilitiesResponse(value);
      return;
    case "projects.launchPass":
      assertLaunchPassResponse(value);
      return;
    case "play.routeMap":
      assertPlayRouteMapResponse(value);
      return;
    case "play.sceneCoverage":
      assertPlaySceneCoverageResponse(value);
      return;
    case "play.setSceneCoverage":
      assertPlaySetSceneCoverageResponse(value);
      return;
  }
}

function assertApiAssetDecisionsResponse(
  value: unknown,
  label = "ApiAssetDecisionsResponse",
): asserts value is ApiAssetDecisionsResponse {
  const response = asStrictRecord(
    value,
    label,
    ITOTORI_STRICT_API_BODY_KEYS.ApiAssetDecisionsResponse,
  );
  const decisions = asArray(response.decisions, `${label}.decisions`);
  for (const [index, decision] of decisions.entries()) {
    assertAssetDecisionRecord(decision, `${label}.decisions[${index}]`);
  }
}

function assertApiCandidateAssetsResponse(
  value: unknown,
  label = "ApiCandidateAssetsResponse",
): asserts value is ApiCandidateAssetsResponse {
  const response = asStrictRecord(
    value,
    label,
    ITOTORI_STRICT_API_BODY_KEYS.ApiCandidateAssetsResponse,
  );
  const candidateAssets = asArray(response.candidateAssets, `${label}.candidateAssets`);
  for (const [index, candidate] of candidateAssets.entries()) {
    assertCandidateAssetRecord(candidate, `${label}.candidateAssets[${index}]`);
  }
}

function assertAssetDecisionRecord(
  value: unknown,
  label: string,
): asserts value is AssetDecisionRecord {
  const record = asStrictRecord(value, label, [
    "decisionId",
    "projectId",
    "localeBranchId",
    "assetRef",
    "assetKind",
    "decisionPolicy",
    "decisionRationale",
    "decidedByUserId",
    "decidedAt",
    "supersededAt",
    "supersededByDecisionId",
    "createdAt",
  ]);
  assertString(record.decisionId, `${label}.decisionId`);
  assertString(record.projectId, `${label}.projectId`);
  assertString(record.localeBranchId, `${label}.localeBranchId`);
  assertAssetRef(record.assetRef, `${label}.assetRef`);
  assertAssetDecisionKind(record.assetKind, `${label}.assetKind`);
  assertEnum(record.decisionPolicy, assetLocalizationDecisionPolicyList, `${label}.decisionPolicy`);
  assertNullableString(record.decisionRationale, `${label}.decisionRationale`);
  assertNullableString(record.decidedByUserId, `${label}.decidedByUserId`);
  assertDateLike(record.decidedAt, `${label}.decidedAt`);
  assertNullableDateLike(record.supersededAt, `${label}.supersededAt`);
  assertNullableString(record.supersededByDecisionId, `${label}.supersededByDecisionId`);
  assertDateLike(record.createdAt, `${label}.createdAt`);
}

function assertCandidateAssetRecord(
  value: unknown,
  label: string,
): asserts value is CandidateAssetRecord {
  const record = asStrictRecord(value, label, ["assetRef", "assetKind", "displayLabel"]);
  assertAssetRef(record.assetRef, `${label}.assetRef`);
  assertAssetDecisionKind(record.assetKind, `${label}.assetKind`);
  if (record.displayLabel !== undefined) {
    assertString(record.displayLabel, `${label}.displayLabel`);
  }
}

function assertAssetRef(value: unknown, label: string): void {
  const assetRef = asRecord(value, label);
  assertString(assetRef.kind, `${label}.kind`);
  assertString(assetRef.ref, `${label}.ref`);
}

function assertAssetDecisionKind(
  value: unknown,
  label: string,
): asserts value is AssetLocalizationDecisionAssetKind {
  assertEnum(value, assetLocalizationDecisionAssetKindList, label);
}

export function assertWikiEntriesReadModel(
  value: unknown,
  label = "WikiEntriesReadModel",
): asserts value is WikiEntriesReadModel {
  const model = asStrictRecord(value, label, ITOTORI_STRICT_API_BODY_KEYS.WikiEntriesReadModel);
  assertLiteral(model.schemaVersion, "wiki.entries.v0.1", `${label}.schemaVersion`);
  assertDateLike(model.generatedAt, `${label}.generatedAt`);
  const filter = asStrictRecord(model.filter, `${label}.filter`, [
    "projectId",
    "localeBranchId",
    "sourceRevisionId",
    "kind",
  ]);
  assertString(filter.projectId, `${label}.filter.projectId`);
  assertString(filter.localeBranchId, `${label}.filter.localeBranchId`);
  assertNullableString(filter.sourceRevisionId, `${label}.filter.sourceRevisionId`);
  if (filter.kind !== null) {
    assertEnum(filter.kind, Object.values(wikiEntryKindValues), `${label}.filter.kind`);
  }
  const pagination = asStrictRecord(model.pagination, `${label}.pagination`, [
    "total",
    "limit",
    "offset",
    "hasMore",
    "nextOffset",
  ]);
  assertNonNegativeInteger(pagination.total, `${label}.pagination.total`);
  assertNonNegativeInteger(pagination.limit, `${label}.pagination.limit`);
  assertNonNegativeInteger(pagination.offset, `${label}.pagination.offset`);
  assertBoolean(pagination.hasMore, `${label}.pagination.hasMore`);
  if (pagination.nextOffset !== null) {
    assertNonNegativeInteger(pagination.nextOffset, `${label}.pagination.nextOffset`);
  }
  const entries = asArray(model.entries, `${label}.entries`);
  for (const [index, entryValue] of entries.entries()) {
    const entryLabel = `${label}.entries[${index}]`;
    const entry = asRecord(entryValue, entryLabel);
    assertString(entry.entryId, `${entryLabel}.entryId`);
    assertEnum(entry.kind, Object.values(wikiEntryKindValues), `${entryLabel}.kind`);
    assertString(entry.title, `${entryLabel}.title`);
    const related = asArray(entry.related, `${entryLabel}.related`);
    for (const [relatedIndex, relatedValue] of related.entries()) {
      const relatedLabel = `${entryLabel}.related[${relatedIndex}]`;
      const relatedRef = asStrictRecord(relatedValue, relatedLabel, [
        "refKind",
        "refId",
        "label",
        "relation",
      ]);
      assertString(relatedRef.refKind, `${relatedLabel}.refKind`);
      assertString(relatedRef.refId, `${relatedLabel}.refId`);
      assertString(relatedRef.label, `${relatedLabel}.label`);
      assertString(relatedRef.relation, `${relatedLabel}.relation`);
    }
  }
}

export function assertReviewerQueueDashboardReadModel(
  value: unknown,
  label = "ReviewerQueueDashboardReadModel",
): asserts value is ReviewerQueueDashboardReadModel {
  const model = asStrictRecord(
    value,
    label,
    ITOTORI_STRICT_API_BODY_KEYS.ReviewerQueueDashboardReadModel,
  );
  assertLiteral(model.schemaVersion, "reviewer.queue_dashboard.v0.1", `${label}.schemaVersion`);
  assertString(model.localeBranchId, `${label}.localeBranchId`);
  assertDateLike(model.generatedAt, `${label}.generatedAt`);
  assertReviewerQueuePermissionView(model.permission, `${label}.permission`);
  const rows = asArray(model.rows, `${label}.rows`);
  for (const [index, row] of rows.entries()) {
    assertReviewerQueueDashboardRow(row, `${label}.rows[${index}]`);
  }
  assertReviewerQueueDashboardAggregate(model.aggregate, `${label}.aggregate`);
  assertReviewerBatchActionRequest(model.defaultBatchRequest, `${label}.defaultBatchRequest`);
}

function assertReviewerQueueDashboardRow(
  value: unknown,
  label: string,
): asserts value is ReviewerQueueDashboardRow {
  const row = asStrictRecord(value, label, [
    "reviewItemId",
    "projectId",
    "localeBranchId",
    "sourceRevisionId",
    "itemKind",
    "sourceItemRef",
    "summary",
    "priority",
    "state",
    "dashboardState",
    "lastAction",
    "batchActionId",
    "findingId",
    "decisionId",
    "detailPath",
    "selectedForBatch",
    "createdAt",
    "updatedAt",
    "resolvedAt",
  ]);
  assertString(row.reviewItemId, `${label}.reviewItemId`);
  assertString(row.projectId, `${label}.projectId`);
  assertString(row.localeBranchId, `${label}.localeBranchId`);
  assertString(row.sourceRevisionId, `${label}.sourceRevisionId`);
  assertEnum(row.itemKind, reviewerQueueItemKindList, `${label}.itemKind`);
  assertString(row.sourceItemRef, `${label}.sourceItemRef`);
  assertString(row.summary, `${label}.summary`);
  assertNonNegativeInteger(row.priority, `${label}.priority`);
  assertEnum(row.state, reviewerQueueItemStateList, `${label}.state`);
  assertEnum(
    row.dashboardState,
    Object.values(reviewerQueueDashboardStateValues) as ReviewerQueueDashboardState[],
    `${label}.dashboardState`,
  );
  assertNullableReviewerQueueAction(row.lastAction, `${label}.lastAction`);
  assertNullableString(row.batchActionId, `${label}.batchActionId`);
  assertNullableString(row.findingId, `${label}.findingId`);
  assertNullableString(row.decisionId, `${label}.decisionId`);
  assertString(row.detailPath, `${label}.detailPath`);
  assertBoolean(row.selectedForBatch, `${label}.selectedForBatch`);
  assertDateLike(row.createdAt, `${label}.createdAt`);
  assertDateLike(row.updatedAt, `${label}.updatedAt`);
  assertNullableDateLike(row.resolvedAt, `${label}.resolvedAt`);
}

function assertReviewerQueueDashboardAggregate(value: unknown, label: string): void {
  const aggregate = asStrictRecord(value, label, [
    "pending",
    "resolved",
    "deferred",
    "escalated",
    "batch_applied",
  ]);
  for (const state of Object.values(reviewerQueueDashboardStateValues)) {
    assertNonNegativeInteger(aggregate[state], `${label}.${state}`);
  }
}

function assertReviewerQueuePermissionView(value: unknown, label: string): void {
  const permission = asStrictRecord(
    value,
    label,
    ITOTORI_STRICT_API_BODY_KEYS.ReviewerQueuePermissionView,
  );
  assertString(permission.actorUserId, `${label}.actorUserId`);
  assertBoolean(permission.canReadQueue, `${label}.canReadQueue`);
  assertBoolean(permission.canManageQueue, `${label}.canManageQueue`);
  assertStringArray(permission.denialReasons, `${label}.denialReasons`);
}

const workspaceDiagnosticCodeList = Object.values(workspaceDiagnosticCodeValues);
const workspaceSearchModeList = Object.values(workspaceSearchModeValues);

function assertWorkspaceDiagnostics(value: unknown, label: string): void {
  const diagnostics = asArray(value, label);
  for (const [index, diagnosticValue] of diagnostics.entries()) {
    const diagnostic = asStrictRecord(diagnosticValue, `${label}[${index}]`, ["code", "message"]);
    assertEnum(diagnostic.code, workspaceDiagnosticCodeList, `${label}[${index}].code`);
    assertString(diagnostic.message, `${label}[${index}].message`);
  }
}

const workspaceCorrectionDiagnosticCodeList = Object.values(
  workspaceCorrectionDiagnosticCodeValues,
);
const workspaceCorrectionDispositionList = Object.values(workspaceCorrectionDispositionValues);
const feedbackTypeList = Object.values(feedbackTypeValues);

function assertWorkspaceCorrectionDiagnostics(value: unknown, label: string): void {
  const diagnostics = asArray(value, label);
  for (const [index, diagnosticValue] of diagnostics.entries()) {
    const diagnostic = asStrictRecord(diagnosticValue, `${label}[${index}]`, ["code", "message"]);
    assertEnum(diagnostic.code, workspaceCorrectionDiagnosticCodeList, `${label}[${index}].code`);
    assertString(diagnostic.message, `${label}[${index}].message`);
  }
}

export function assertWorkspaceCorrectionPreviewReadModel(
  value: unknown,
  label = "WorkspaceCorrectionPreviewReadModel",
): asserts value is WorkspaceCorrectionPreviewReadModel {
  const model = asStrictRecord(
    value,
    label,
    ITOTORI_STRICT_API_BODY_KEYS.WorkspaceCorrectionPreviewReadModel,
  );
  assertLiteral(model.schemaVersion, "workspace.correction_preview.v0.1", `${label}.schemaVersion`);
  assertDateLike(model.generatedAt, `${label}.generatedAt`);
  assertReviewerQueuePermissionView(model.permission, `${label}.permission`);
  assertString(model.localeBranchId, `${label}.localeBranchId`);
  const units = asArray(model.units, `${label}.units`);
  for (const [index, unitValue] of units.entries()) {
    const unitLabel = `${label}.units[${index}]`;
    const unit = asStrictRecord(unitValue, unitLabel, [
      "reviewItemId",
      "localeBranchId",
      "sourceRevisionId",
      "bridgeUnitId",
      "sourceUnitKey",
      "sourceLocale",
      "sourceText",
      "targetLocale",
      "draftText",
      "finalText",
      "styleGuidePolicyVersionId",
      "styleGuidePolicyStatus",
      "glossary",
      "runtimeEvidenceLinks",
      "screenshotArtifactHashes",
      "diagnostics",
    ]);
    assertString(unit.reviewItemId, `${unitLabel}.reviewItemId`);
    assertNullableString(unit.localeBranchId, `${unitLabel}.localeBranchId`);
    assertNullableString(unit.sourceRevisionId, `${unitLabel}.sourceRevisionId`);
    assertNullableString(unit.bridgeUnitId, `${unitLabel}.bridgeUnitId`);
    assertNullableString(unit.sourceUnitKey, `${unitLabel}.sourceUnitKey`);
    assertNullableString(unit.sourceLocale, `${unitLabel}.sourceLocale`);
    assertNullableString(unit.sourceText, `${unitLabel}.sourceText`);
    assertNullableString(unit.targetLocale, `${unitLabel}.targetLocale`);
    assertNullableString(unit.draftText, `${unitLabel}.draftText`);
    assertNullableString(unit.finalText, `${unitLabel}.finalText`);
    assertNullableString(unit.styleGuidePolicyVersionId, `${unitLabel}.styleGuidePolicyVersionId`);
    assertNullableString(unit.styleGuidePolicyStatus, `${unitLabel}.styleGuidePolicyStatus`);
    const glossary = asArray(unit.glossary, `${unitLabel}.glossary`);
    for (const [glossaryIndex, glossaryValue] of glossary.entries()) {
      const glossaryLabel = `${unitLabel}.glossary[${glossaryIndex}]`;
      const ref = asStrictRecord(glossaryValue, glossaryLabel, [
        "termId",
        "sourceTerm",
        "preferredTranslation",
        "status",
      ]);
      assertString(ref.termId, `${glossaryLabel}.termId`);
      assertString(ref.sourceTerm, `${glossaryLabel}.sourceTerm`);
      assertString(ref.preferredTranslation, `${glossaryLabel}.preferredTranslation`);
      assertString(ref.status, `${glossaryLabel}.status`);
    }
    asArray(unit.runtimeEvidenceLinks, `${unitLabel}.runtimeEvidenceLinks`);
    assertStringArray(unit.screenshotArtifactHashes, `${unitLabel}.screenshotArtifactHashes`);
    assertWorkspaceCorrectionDiagnostics(unit.diagnostics, `${unitLabel}.diagnostics`);
  }
  assertWorkspaceCorrectionDiagnostics(model.diagnostics, `${label}.diagnostics`);
}

export function assertWorkspaceCorrectionSubmitReadModel(
  value: unknown,
  label = "WorkspaceCorrectionSubmitReadModel",
): asserts value is WorkspaceCorrectionSubmitReadModel {
  const model = asStrictRecord(
    value,
    label,
    ITOTORI_STRICT_API_BODY_KEYS.WorkspaceCorrectionSubmitReadModel,
  );
  assertLiteral(model.schemaVersion, "workspace.correction_submit.v0.1", `${label}.schemaVersion`);
  assertDateLike(model.generatedAt, `${label}.generatedAt`);
  assertReviewerQueuePermissionView(model.permission, `${label}.permission`);
  assertString(model.localeBranchId, `${label}.localeBranchId`);
  assertString(model.batchId, `${label}.batchId`);
  assertNullableString(model.batchLabel, `${label}.batchLabel`);
  assertNonNegativeInteger(model.submittedCount, `${label}.submittedCount`);
  const edits = asArray(model.edits, `${label}.edits`);
  for (const [index, editValue] of edits.entries()) {
    const editLabel = `${label}.edits[${index}]`;
    const edit = asStrictRecord(editValue, editLabel, [
      "correctionEditId",
      "projectId",
      "localeBranchId",
      "sourceRevisionId",
      "bridgeUnitId",
      "actorUserId",
      "reason",
      "beforeText",
      "afterText",
      "disposition",
      "triageLabel",
      "feedbackReportId",
      "feedbackEvidenceId",
      "reviewItemId",
      "duplicate",
    ]);
    assertString(edit.correctionEditId, `${editLabel}.correctionEditId`);
    assertString(edit.projectId, `${editLabel}.projectId`);
    assertString(edit.localeBranchId, `${editLabel}.localeBranchId`);
    assertString(edit.sourceRevisionId, `${editLabel}.sourceRevisionId`);
    assertString(edit.bridgeUnitId, `${editLabel}.bridgeUnitId`);
    assertString(edit.actorUserId, `${editLabel}.actorUserId`);
    assertString(edit.reason, `${editLabel}.reason`);
    assertNullableString(edit.beforeText, `${editLabel}.beforeText`);
    assertString(edit.afterText, `${editLabel}.afterText`);
    assertEnum(edit.disposition, workspaceCorrectionDispositionList, `${editLabel}.disposition`);
    assertString(edit.triageLabel, `${editLabel}.triageLabel`);
    assertString(edit.feedbackReportId, `${editLabel}.feedbackReportId`);
    assertString(edit.feedbackEvidenceId, `${editLabel}.feedbackEvidenceId`);
    assertNullableString(edit.reviewItemId, `${editLabel}.reviewItemId`);
    assertBoolean(edit.duplicate, `${editLabel}.duplicate`);
  }
  assertStringArray(model.repairCandidateReportIds, `${label}.repairCandidateReportIds`);
  assertStringArray(model.decisionQueueReportIds, `${label}.decisionQueueReportIds`);
  assertStringArray(model.needsContextReportIds, `${label}.needsContextReportIds`);
  assertStringArray(model.affectedBridgeUnitIds, `${label}.affectedBridgeUnitIds`);
  const writebacks = asArray(model.writebacks, `${label}.writebacks`);
  for (const [index, writebackValue] of writebacks.entries()) {
    const writebackLabel = `${label}.writebacks[${index}]`;
    const writeback = asStrictRecord(writebackValue, writebackLabel, [
      "bridgeUnitId",
      "memorySegmentId",
      "termId",
      "affectedBridgeUnitIds",
      "scheduledJobIds",
    ]);
    assertString(writeback.bridgeUnitId, `${writebackLabel}.bridgeUnitId`);
    assertNullableString(writeback.memorySegmentId, `${writebackLabel}.memorySegmentId`);
    assertNullableString(writeback.termId, `${writebackLabel}.termId`);
    assertStringArray(writeback.affectedBridgeUnitIds, `${writebackLabel}.affectedBridgeUnitIds`);
    assertStringArray(writeback.scheduledJobIds, `${writebackLabel}.scheduledJobIds`);
  }
  assertStringArray(model.scheduledRerunJobIds, `${label}.scheduledRerunJobIds`);
  assertWorkspaceCorrectionDiagnostics(model.diagnostics, `${label}.diagnostics`);
}

export function parseWorkspaceCorrectionSubmitRequest(
  body: unknown,
): ApiWorkspaceCorrectionSubmitRequest {
  return parseRequest("ApiWorkspaceCorrectionSubmitRequest", () => {
    const request = asRecord(body, "ApiWorkspaceCorrectionSubmitRequest");
    assertString(request.projectId, "ApiWorkspaceCorrectionSubmitRequest.projectId");
    assertString(request.localeBranchId, "ApiWorkspaceCorrectionSubmitRequest.localeBranchId");
    assertString(request.sourceBundleId, "ApiWorkspaceCorrectionSubmitRequest.sourceBundleId");
    assertString(request.targetLocale, "ApiWorkspaceCorrectionSubmitRequest.targetLocale");
    assertString(request.actorUserId, "ApiWorkspaceCorrectionSubmitRequest.actorUserId");
    const corrections = asArray(
      request.corrections,
      "ApiWorkspaceCorrectionSubmitRequest.corrections",
    ).map((value, index) => {
      const correctionLabel = `ApiWorkspaceCorrectionSubmitRequest.corrections[${index}]`;
      const correction = asRecord(value, correctionLabel);
      assertString(correction.bridgeUnitId, `${correctionLabel}.bridgeUnitId`);
      assertString(correction.sourceRevisionId, `${correctionLabel}.sourceRevisionId`);
      assertString(correction.reason, `${correctionLabel}.reason`);
      assertString(correction.correctedText, `${correctionLabel}.correctedText`);
      const parsed: WorkspaceCorrectionSubmission = {
        bridgeUnitId: correction.bridgeUnitId,
        sourceRevisionId: correction.sourceRevisionId,
        reason: correction.reason,
        correctedText: correction.correctedText,
      };
      if (correction.sourceUnitKey !== undefined) {
        assertString(correction.sourceUnitKey, `${correctionLabel}.sourceUnitKey`);
        parsed.sourceUnitKey = correction.sourceUnitKey;
      }
      if (correction.draftText !== undefined) {
        assertString(correction.draftText, `${correctionLabel}.draftText`);
        parsed.draftText = correction.draftText;
      }
      if (correction.feedbackType !== undefined) {
        assertEnum(
          correction.feedbackType,
          feedbackTypeList as readonly FeedbackType[],
          `${correctionLabel}.feedbackType`,
        );
        parsed.feedbackType = correction.feedbackType;
      }
      return parsed;
    });
    const result: ApiWorkspaceCorrectionSubmitRequest = {
      projectId: request.projectId,
      localeBranchId: request.localeBranchId,
      sourceBundleId: request.sourceBundleId,
      targetLocale: request.targetLocale,
      actorUserId: request.actorUserId,
      corrections,
    };
    if (request.batchLabel !== undefined) {
      assertString(request.batchLabel, "ApiWorkspaceCorrectionSubmitRequest.batchLabel");
      result.batchLabel = request.batchLabel;
    }
    if (request.actorDisplayName !== undefined) {
      assertString(
        request.actorDisplayName,
        "ApiWorkspaceCorrectionSubmitRequest.actorDisplayName",
      );
      result.actorDisplayName = request.actorDisplayName;
    }
    return result;
  });
}

export function assertWorkspaceProjectBrowseReadModel(
  value: unknown,
  label = "WorkspaceProjectBrowseReadModel",
): asserts value is WorkspaceProjectBrowseReadModel {
  const model = asStrictRecord(
    value,
    label,
    ITOTORI_STRICT_API_BODY_KEYS.WorkspaceProjectBrowseReadModel,
  );
  assertLiteral(model.schemaVersion, "workspace.project_browse.v0.1", `${label}.schemaVersion`);
  assertDateLike(model.generatedAt, `${label}.generatedAt`);
  assertReviewerQueuePermissionView(model.permission, `${label}.permission`);
  const projects = asArray(model.projects, `${label}.projects`);
  for (const [index, projectValue] of projects.entries()) {
    const project = asStrictRecord(projectValue, `${label}.projects[${index}]`, [
      "projectId",
      "projectKey",
      "name",
      "status",
      "sourceLocale",
      "sourceBundleRevisionId",
      "branchCount",
      "unitCount",
      "localeBranches",
    ]);
    const projectLabel = `${label}.projects[${index}]`;
    assertString(project.projectId, `${projectLabel}.projectId`);
    assertString(project.projectKey, `${projectLabel}.projectKey`);
    assertString(project.name, `${projectLabel}.name`);
    assertString(project.status, `${projectLabel}.status`);
    assertString(project.sourceLocale, `${projectLabel}.sourceLocale`);
    assertString(project.sourceBundleRevisionId, `${projectLabel}.sourceBundleRevisionId`);
    assertNonNegativeInteger(project.branchCount, `${projectLabel}.branchCount`);
    assertNonNegativeInteger(project.unitCount, `${projectLabel}.unitCount`);
    const branches = asArray(project.localeBranches, `${projectLabel}.localeBranches`);
    for (const [branchIndex, branchValue] of branches.entries()) {
      assertWorkspaceLocaleBranchSummary(
        branchValue,
        `${projectLabel}.localeBranches[${branchIndex}]`,
      );
    }
  }
  assertWorkspaceDiagnostics(model.diagnostics, `${label}.diagnostics`);
}

function assertWorkspaceLocaleBranchSummary(value: unknown, label: string): void {
  const branch = asStrictRecord(value, label, [
    "localeBranchId",
    "projectId",
    "branchName",
    "sourceLocale",
    "targetLocale",
    "status",
    "unitCount",
    "translatedUnitCount",
    "openFindingCount",
    "artifactCount",
    "currentStyleGuidePolicyVersionId",
    "sceneBrowsePath",
    "assetBrowsePath",
  ]);
  assertString(branch.localeBranchId, `${label}.localeBranchId`);
  assertString(branch.projectId, `${label}.projectId`);
  assertString(branch.branchName, `${label}.branchName`);
  assertString(branch.sourceLocale, `${label}.sourceLocale`);
  assertString(branch.targetLocale, `${label}.targetLocale`);
  assertString(branch.status, `${label}.status`);
  assertNonNegativeInteger(branch.unitCount, `${label}.unitCount`);
  assertNonNegativeInteger(branch.translatedUnitCount, `${label}.translatedUnitCount`);
  assertNonNegativeInteger(branch.openFindingCount, `${label}.openFindingCount`);
  assertNonNegativeInteger(branch.artifactCount, `${label}.artifactCount`);
  assertNullableString(
    branch.currentStyleGuidePolicyVersionId,
    `${label}.currentStyleGuidePolicyVersionId`,
  );
  assertString(branch.sceneBrowsePath, `${label}.sceneBrowsePath`);
  assertString(branch.assetBrowsePath, `${label}.assetBrowsePath`);
}

export function assertWorkspaceSceneBrowseReadModel(
  value: unknown,
  label = "WorkspaceSceneBrowseReadModel",
): asserts value is WorkspaceSceneBrowseReadModel {
  const model = asStrictRecord(
    value,
    label,
    ITOTORI_STRICT_API_BODY_KEYS.WorkspaceSceneBrowseReadModel,
  );
  assertLiteral(model.schemaVersion, "workspace.scene_browse.v0.1", `${label}.schemaVersion`);
  assertDateLike(model.generatedAt, `${label}.generatedAt`);
  assertReviewerQueuePermissionView(model.permission, `${label}.permission`);
  assertString(model.projectId, `${label}.projectId`);
  assertString(model.localeBranchId, `${label}.localeBranchId`);
  const scenes = asArray(model.scenes, `${label}.scenes`);
  for (const [index, sceneValue] of scenes.entries()) {
    const sceneLabel = `${label}.scenes[${index}]`;
    const scene = asStrictRecord(sceneValue, sceneLabel, [
      "sceneId",
      "sceneSummaryId",
      "localeBranchId",
      "sourceRevisionId",
      "summaryLocale",
      "summaryText",
      "status",
      "stale",
      "generatedAt",
      "units",
      "citedUnitCount",
    ]);
    assertString(scene.sceneId, `${sceneLabel}.sceneId`);
    assertString(scene.sceneSummaryId, `${sceneLabel}.sceneSummaryId`);
    assertString(scene.localeBranchId, `${sceneLabel}.localeBranchId`);
    assertString(scene.sourceRevisionId, `${sceneLabel}.sourceRevisionId`);
    assertString(scene.summaryLocale, `${sceneLabel}.summaryLocale`);
    assertString(scene.summaryText, `${sceneLabel}.summaryText`);
    assertString(scene.status, `${sceneLabel}.status`);
    assertBoolean(scene.stale, `${sceneLabel}.stale`);
    assertDateLike(scene.generatedAt, `${sceneLabel}.generatedAt`);
    assertNonNegativeInteger(scene.citedUnitCount, `${sceneLabel}.citedUnitCount`);
    const units = asArray(scene.units, `${sceneLabel}.units`);
    for (const [unitIndex, unitValue] of units.entries()) {
      const unitLabel = `${sceneLabel}.units[${unitIndex}]`;
      const unit = asStrictRecord(unitValue, unitLabel, [
        "bridgeUnitId",
        "sourceUnitKey",
        "speaker",
        "occurrenceId",
        "sourceText",
        "cited",
      ]);
      assertString(unit.bridgeUnitId, `${unitLabel}.bridgeUnitId`);
      assertString(unit.sourceUnitKey, `${unitLabel}.sourceUnitKey`);
      assertNullableString(unit.speaker, `${unitLabel}.speaker`);
      assertString(unit.occurrenceId, `${unitLabel}.occurrenceId`);
      assertNullableString(unit.sourceText, `${unitLabel}.sourceText`);
      assertBoolean(unit.cited, `${unitLabel}.cited`);
    }
  }
  assertWorkspaceDiagnostics(model.diagnostics, `${label}.diagnostics`);
}

export function assertWorkspaceAssetBrowseReadModel(
  value: unknown,
  label = "WorkspaceAssetBrowseReadModel",
): asserts value is WorkspaceAssetBrowseReadModel {
  const model = asStrictRecord(
    value,
    label,
    ITOTORI_STRICT_API_BODY_KEYS.WorkspaceAssetBrowseReadModel,
  );
  assertLiteral(model.schemaVersion, "workspace.asset_browse.v0.1", `${label}.schemaVersion`);
  assertDateLike(model.generatedAt, `${label}.generatedAt`);
  assertReviewerQueuePermissionView(model.permission, `${label}.permission`);
  assertString(model.projectId, `${label}.projectId`);
  assertString(model.localeBranchId, `${label}.localeBranchId`);
  const assets = asArray(model.assets, `${label}.assets`);
  for (const [index, assetValue] of assets.entries()) {
    const assetLabel = `${label}.assets[${index}]`;
    const asset = asStrictRecord(assetValue, assetLabel, [
      "assetRef",
      "assetKind",
      "displayLabel",
      "decided",
      "decisionPolicy",
      "decisionRationale",
    ]);
    const assetRef = asStrictRecord(asset.assetRef, `${assetLabel}.assetRef`, ["kind", "ref"]);
    assertString(assetRef.kind, `${assetLabel}.assetRef.kind`);
    assertString(assetRef.ref, `${assetLabel}.assetRef.ref`);
    assertString(asset.assetKind, `${assetLabel}.assetKind`);
    assertNullableString(asset.displayLabel, `${assetLabel}.displayLabel`);
    assertBoolean(asset.decided, `${assetLabel}.decided`);
    assertNullableString(asset.decisionPolicy, `${assetLabel}.decisionPolicy`);
    assertNullableString(asset.decisionRationale, `${assetLabel}.decisionRationale`);
  }
  assertWorkspaceDiagnostics(model.diagnostics, `${label}.diagnostics`);
}

export function assertWorkspaceComparisonReadModel(
  value: unknown,
  label = "WorkspaceComparisonReadModel",
): asserts value is WorkspaceComparisonReadModel {
  const model = asStrictRecord(
    value,
    label,
    ITOTORI_STRICT_API_BODY_KEYS.WorkspaceComparisonReadModel,
  );
  assertLiteral(model.schemaVersion, "workspace.comparison.v0.1", `${label}.schemaVersion`);
  assertDateLike(model.generatedAt, `${label}.generatedAt`);
  assertReviewerQueuePermissionView(model.permission, `${label}.permission`);
  assertString(model.reviewItemId, `${label}.reviewItemId`);
  assertNullableString(model.localeBranchId, `${label}.localeBranchId`);
  assertNullableString(model.sourceRevisionId, `${label}.sourceRevisionId`);
  assertNullableString(model.bridgeUnitId, `${label}.bridgeUnitId`);
  assertNullableString(model.sourceUnitKey, `${label}.sourceUnitKey`);
  assertNullableString(model.contextNote, `${label}.contextNote`);
  assertBoolean(model.hasFinal, `${label}.hasFinal`);
  const cells = asArray(model.cells, `${label}.cells`);
  for (const [index, cellValue] of cells.entries()) {
    const cellLabel = `${label}.cells[${index}]`;
    const cell = asStrictRecord(cellValue, cellLabel, ["side", "locale", "text", "label"]);
    assertEnum(cell.side, ["source", "draft", "final"] as const, `${cellLabel}.side`);
    assertString(cell.locale, `${cellLabel}.locale`);
    assertString(cell.text, `${cellLabel}.text`);
    assertString(cell.label, `${cellLabel}.label`);
  }
  const links = asArray(model.runtimeEvidenceLinks, `${label}.runtimeEvidenceLinks`);
  for (const [index, linkValue] of links.entries()) {
    const linkLabel = `${label}.runtimeEvidenceLinks[${index}]`;
    const link = asStrictRecord(linkValue, linkLabel, [
      "evidenceKind",
      "evidenceTier",
      "runtimeTargetId",
      "observationEventIds",
      "artifactHashes",
      "providerProofRefs",
      "summary",
    ]);
    assertString(link.evidenceKind, `${linkLabel}.evidenceKind`);
    assertString(link.evidenceTier, `${linkLabel}.evidenceTier`);
    assertString(link.runtimeTargetId, `${linkLabel}.runtimeTargetId`);
    assertStringArray(link.observationEventIds, `${linkLabel}.observationEventIds`);
    assertStringArray(link.artifactHashes, `${linkLabel}.artifactHashes`);
    assertStringArray(link.providerProofRefs, `${linkLabel}.providerProofRefs`);
    assertString(link.summary, `${linkLabel}.summary`);
  }
  assertWorkspaceDiagnostics(model.diagnostics, `${label}.diagnostics`);
}

export function assertWorkspaceSearchReadModel(
  value: unknown,
  label = "WorkspaceSearchReadModel",
): asserts value is WorkspaceSearchReadModel {
  const model = asStrictRecord(value, label, ITOTORI_STRICT_API_BODY_KEYS.WorkspaceSearchReadModel);
  assertLiteral(model.schemaVersion, "workspace.search.v0.1", `${label}.schemaVersion`);
  assertDateLike(model.generatedAt, `${label}.generatedAt`);
  assertReviewerQueuePermissionView(model.permission, `${label}.permission`);
  assertString(model.projectId, `${label}.projectId`);
  assertString(model.localeBranchId, `${label}.localeBranchId`);
  assertString(model.query, `${label}.query`);
  assertString(model.normalizedQuery, `${label}.normalizedQuery`);
  assertEnum(model.mode, workspaceSearchModeList, `${label}.mode`);
  assertProjectOverviewPagination(model.pagination, `${label}.pagination`);
  assertNonNegativeInteger(model.droppedOpaqueCount, `${label}.droppedOpaqueCount`);
  const results = asArray(model.results, `${label}.results`);
  if (results.length > Number((model.pagination as { limit: unknown }).limit)) {
    throw new Error(`${label}.results must not exceed pagination.limit`);
  }
  for (const [index, resultValue] of results.entries()) {
    const resultLabel = `${label}.results[${index}]`;
    const result = asStrictRecord(resultValue, resultLabel, [
      "resultKind",
      "matchKind",
      "id",
      "title",
      "subtitle",
      "targetPath",
      "localeBranchId",
      "sourceArtifactId",
      "bridgeUnitRef",
      "sourceRevisionId",
      "sourceLocale",
      "targetLocale",
      "snippet",
      "score",
      "matchRefId",
    ]);
    assertEnum(
      result.resultKind,
      Object.values(workspaceSearchResultKindValues),
      `${resultLabel}.resultKind`,
    );
    assertEnum(
      result.matchKind,
      ["exact", "terminology", "entity", "action"] as const,
      `${resultLabel}.matchKind`,
    );
    assertString(result.id, `${resultLabel}.id`);
    assertString(result.title, `${resultLabel}.title`);
    assertNullableString(result.subtitle, `${resultLabel}.subtitle`);
    assertString(result.targetPath, `${resultLabel}.targetPath`);
    // Acceptance: every search result MUST cite a locale branch id, a
    // source artifact id, and a bridge unit ref (never an opaque snippet).
    assertString(result.localeBranchId, `${resultLabel}.localeBranchId`);
    assertString(result.sourceArtifactId, `${resultLabel}.sourceArtifactId`);
    assertString(result.bridgeUnitRef, `${resultLabel}.bridgeUnitRef`);
    assertNullableString(result.sourceRevisionId, `${resultLabel}.sourceRevisionId`);
    assertNullableString(result.sourceLocale, `${resultLabel}.sourceLocale`);
    assertNullableString(result.targetLocale, `${resultLabel}.targetLocale`);
    assertString(result.snippet, `${resultLabel}.snippet`);
    assertFiniteNumber(result.score, `${resultLabel}.score`);
    assertNullableString(result.matchRefId, `${resultLabel}.matchRefId`);
  }
  assertWorkspaceDiagnostics(model.diagnostics, `${label}.diagnostics`);
}

function assertReviewerBatchActionRequest(value: unknown, label: string): void {
  const request = asStrictRecord(
    value,
    label,
    ITOTORI_STRICT_API_BODY_KEYS.ReviewerBatchActionRequest,
  );
  assertEnum(
    request.action,
    reviewerQueueActionList as readonly ReviewerQueueAction[],
    `${label}.action`,
  );
  assertString(request.actorUserId, `${label}.actorUserId`);
  const selections = asArray(request.selections, `${label}.selections`);
  for (const [index, selectionValue] of selections.entries()) {
    const selection = asStrictRecord(selectionValue, `${label}.selections[${index}]`, [
      "reviewItemId",
      "expectedSourceRevisionId",
    ]);
    assertString(selection.reviewItemId, `${label}.selections[${index}].reviewItemId`);
    assertString(
      selection.expectedSourceRevisionId,
      `${label}.selections[${index}].expectedSourceRevisionId`,
    );
  }
}

function parseReviewerBatchActionRequestBody(
  body: unknown,
  label: string,
): ReviewerBatchActionRequest {
  return parseRequest(label, () => {
    const request = asStrictRecord(
      body,
      label,
      ITOTORI_STRICT_API_BODY_KEYS.ReviewerBatchActionRequest,
    );
    assertEnum(
      request.action,
      reviewerQueueActionList as readonly ReviewerQueueAction[],
      `${label}.action`,
    );
    assertString(request.actorUserId, `${label}.actorUserId`);
    const selections = asArray(request.selections, `${label}.selections`).map((value, index) => {
      const selection = asStrictRecord(value, `${label}.selections[${index}]`, [
        "reviewItemId",
        "expectedSourceRevisionId",
      ]);
      assertString(selection.reviewItemId, `${label}.selections[${index}].reviewItemId`);
      assertString(
        selection.expectedSourceRevisionId,
        `${label}.selections[${index}].expectedSourceRevisionId`,
      );
      return {
        reviewItemId: selection.reviewItemId,
        expectedSourceRevisionId: selection.expectedSourceRevisionId,
      };
    });
    return {
      action: request.action,
      actorUserId: request.actorUserId,
      selections,
    };
  });
}

function assertReviewerDetailContext(
  value: unknown,
  label = "ReviewerDetailContext",
): asserts value is ReviewerDetailContext {
  const context = asStrictRecord(value, label, ITOTORI_STRICT_API_BODY_KEYS.ReviewerDetailContext);
  assertString(context.reviewItemId, `${label}.reviewItemId`);
  assertReviewerQueuePermissionView(context.permission, `${label}.permission`);
  if (context.item !== null) {
    assertReviewerQueueItemRecord(context.item, `${label}.item`);
  }
  if (context.branchReference !== null) {
    assertReviewerDetailBranchReference(context.branchReference, `${label}.branchReference`);
  }
  asArray(context.glossary, `${label}.glossary`);
  asArray(context.qaFindings, `${label}.qaFindings`);
  asArray(context.runtimeEvidence, `${label}.runtimeEvidence`);
  asArray(context.rationaleRefs, `${label}.rationaleRefs`);
  asArray(context.transitions, `${label}.transitions`);
  asArray(context.diagnostics, `${label}.diagnostics`);
}

// ITOTORI-139 — branch policy/glossary reference provenance on the
// reviewer detail (review context) API response. A non-DB consumer that
// receives the `reviewer.detail` JSON body validates and reads the exact
// reference (branchPolicyRef + glossaryRef) the draft was produced under.
function assertReviewerDetailBranchReference(value: unknown, label: string): void {
  const reference = asStrictRecord(value, label, [
    "referenceId",
    "localeBranchId",
    "versionSequence",
    "draftId",
    "branchPolicyRef",
    "glossaryRef",
    "supersedesReferenceId",
    "updateReason",
  ]);
  assertString(reference.referenceId, `${label}.referenceId`);
  assertString(reference.localeBranchId, `${label}.localeBranchId`);
  assertNonNegativeInteger(reference.versionSequence, `${label}.versionSequence`);
  assertString(reference.draftId, `${label}.draftId`);
  assertNullableString(reference.branchPolicyRef, `${label}.branchPolicyRef`);
  assertString(reference.glossaryRef, `${label}.glossaryRef`);
  assertNullableString(reference.supersedesReferenceId, `${label}.supersedesReferenceId`);
  assertString(reference.updateReason, `${label}.updateReason`);
}

function assertReviewerBatchPreview(
  value: unknown,
  label = "ReviewerBatchPreview",
): asserts value is ReviewerBatchPreview {
  const preview = asStrictRecord(value, label, ITOTORI_STRICT_API_BODY_KEYS.ReviewerBatchPreview);
  assertReviewerBatchActionRequest(preview.request, `${label}.request`);
  assertReviewerQueuePermissionView(preview.permission, `${label}.permission`);
  asArray(preview.items, `${label}.items`);
  const aggregate = asStrictRecord(preview.aggregate, `${label}.aggregate`, [
    "total",
    "allowed",
    "denied",
    "stale",
    "notFound",
    "duplicate",
    "runtimeEvidenceInvariant",
    "invalidInput",
    "invalidTransition",
    "concurrentModification",
    "permissionDeniedRead",
    "permissionDeniedManage",
  ]);
  for (const key of Object.keys(aggregate)) {
    assertNonNegativeInteger(aggregate[key], `${label}.aggregate.${key}`);
  }
  assertBoolean(preview.allAllowed, `${label}.allAllowed`);
  assertBoolean(preview.permissionDenied, `${label}.permissionDenied`);
}

function assertReviewerBatchExecuteResult(
  value: unknown,
  label = "ReviewerBatchExecuteResult",
): asserts value is ReviewerBatchExecuteResult {
  const result = asStrictRecord(
    value,
    label,
    ITOTORI_STRICT_API_BODY_KEYS.ReviewerBatchExecuteResult,
  );
  assertReviewerBatchActionRequest(result.request, `${label}.request`);
  assertReviewerBatchPreview(result.preview, `${label}.preview`);
  const applied = asArray(result.applied, `${label}.applied`);
  for (const [index, entryValue] of applied.entries()) {
    assertReviewerBatchExecuteOutcome(entryValue, `${label}.applied[${index}]`);
  }
  assertBoolean(result.refusedAll, `${label}.refusedAll`);
  assertBoolean(result.appliedAll, `${label}.appliedAll`);
}

function assertReviewerSingleActionResult(
  value: unknown,
  label = "ReviewerSingleActionResult",
): asserts value is ReviewerSingleActionResult {
  const result = asStrictRecord(
    value,
    label,
    ITOTORI_STRICT_API_BODY_KEYS.ReviewerSingleActionResult,
  );
  assertReviewerSingleActionRequest(result.request, `${label}.request`);
  // `preview` is one BatchPreviewItem; the batch preview schema only
  // asserts the item array shape, so assert the load-bearing fields here.
  const preview = asRecord(result.preview, `${label}.preview`);
  assertString(preview.reviewItemId, `${label}.preview.reviewItemId`);
  assertString(preview.status, `${label}.preview.status`);
  assertEnum(
    preview.action,
    reviewerQueueActionList as readonly ReviewerQueueAction[],
    `${label}.preview.action`,
  );
  // `outcome` mirrors a single batch-confirm outcome (applied | refused).
  assertReviewerBatchExecuteOutcome(result.outcome, `${label}.outcome`);
  assertBoolean(result.applied, `${label}.applied`);
  assertBoolean(result.refused, `${label}.refused`);
}

function assertReviewerSingleActionRequest(value: unknown, label: string): void {
  const request = asRecord(value, label);
  assertString(request.reviewItemId, `${label}.reviewItemId`);
  assertString(request.actorUserId, `${label}.actorUserId`);
  assertString(request.expectedSourceRevisionId, `${label}.expectedSourceRevisionId`);
  assertEnum(request.action, reviewerSingleActionList, `${label}.action`);
}

function assertReviewerBatchExecuteOutcome(value: unknown, label: string): void {
  const outcome = asRecord(value, label);
  assertEnum(outcome.kind, ["applied", "refused"] as const, `${label}.kind`);
  if (outcome.kind === "applied") {
    const applied = asStrictRecord(value, label, ["kind", "reviewItemId", "result"]);
    assertString(applied.reviewItemId, `${label}.reviewItemId`);
    assertReviewerQueueActionResult(applied.result, `${label}.result`);
    return;
  }
  const refused = asStrictRecord(value, label, [
    "kind",
    "reviewItemId",
    "status",
    "code",
    "message",
    "diagnostics",
  ]);
  assertString(refused.reviewItemId, `${label}.reviewItemId`);
  assertString(refused.status, `${label}.status`);
  assertString(refused.code, `${label}.code`);
  assertString(refused.message, `${label}.message`);
  asArray(refused.diagnostics, `${label}.diagnostics`);
}

function assertReviewerQueueActionResult(value: unknown, label: string): void {
  const result = asStrictRecord(value, label, ["item", "transition"]);
  assertReviewerQueueItemRecord(result.item, `${label}.item`);
  assertReviewerQueueTransitionRecord(result.transition, `${label}.transition`);
}

function assertReviewerQueueTransitionRecord(value: unknown, label: string): void {
  const transition = asStrictRecord(value, label, [
    "transitionId",
    "reviewItemId",
    "localeBranchId",
    "sourceRevisionId",
    "itemKind",
    "action",
    "priorState",
    "nextState",
    "actorUserId",
    "affectedArtifactIds",
    "diagnostics",
    "metadata",
    "createdAt",
  ]);
  assertString(transition.transitionId, `${label}.transitionId`);
  assertString(transition.reviewItemId, `${label}.reviewItemId`);
  assertString(transition.localeBranchId, `${label}.localeBranchId`);
  assertString(transition.sourceRevisionId, `${label}.sourceRevisionId`);
  assertEnum(transition.itemKind, reviewerQueueItemKindList, `${label}.itemKind`);
  assertEnum(
    transition.action,
    reviewerQueueActionList as readonly ReviewerQueueAction[],
    `${label}.action`,
  );
  assertEnum(transition.priorState, reviewerQueueItemStateList, `${label}.priorState`);
  assertEnum(transition.nextState, reviewerQueueItemStateList, `${label}.nextState`);
  assertString(transition.actorUserId, `${label}.actorUserId`);
  assertStringArray(transition.affectedArtifactIds, `${label}.affectedArtifactIds`);
  asArray(transition.diagnostics, `${label}.diagnostics`);
  asRecord(transition.metadata, `${label}.metadata`);
  assertDateLike(transition.createdAt, `${label}.createdAt`);
}

function assertReviewerQueueItemRecord(value: unknown, label: string): void {
  const item = asStrictRecord(value, label, [
    "reviewItemId",
    "projectId",
    "localeBranchId",
    "sourceRevisionId",
    "itemKind",
    "sourceItemRef",
    "state",
    "priority",
    "summary",
    "affectedArtifactIds",
    "evidenceTier",
    "observationEventIds",
    "artifactHashes",
    "payload",
    "metadata",
    "createdByUserId",
    "assignedToUserId",
    "createdAt",
    "updatedAt",
    "resolvedAt",
  ]);
  assertString(item.reviewItemId, `${label}.reviewItemId`);
  assertString(item.projectId, `${label}.projectId`);
  assertString(item.localeBranchId, `${label}.localeBranchId`);
  assertString(item.sourceRevisionId, `${label}.sourceRevisionId`);
  assertEnum(item.itemKind, reviewerQueueItemKindList, `${label}.itemKind`);
  assertString(item.sourceItemRef, `${label}.sourceItemRef`);
  assertEnum(item.state, reviewerQueueItemStateList, `${label}.state`);
  assertNonNegativeInteger(item.priority, `${label}.priority`);
  assertString(item.summary, `${label}.summary`);
  assertStringArray(item.affectedArtifactIds, `${label}.affectedArtifactIds`);
  assertNullableString(item.evidenceTier, `${label}.evidenceTier`);
  if (item.observationEventIds !== null) {
    assertStringArray(item.observationEventIds, `${label}.observationEventIds`);
  }
  if (item.artifactHashes !== null) {
    assertStringArray(item.artifactHashes, `${label}.artifactHashes`);
  }
  asRecord(item.payload, `${label}.payload`);
  asRecord(item.metadata, `${label}.metadata`);
  assertNullableString(item.createdByUserId, `${label}.createdByUserId`);
  assertNullableString(item.assignedToUserId, `${label}.assignedToUserId`);
  assertDateLike(item.createdAt, `${label}.createdAt`);
  assertDateLike(item.updatedAt, `${label}.updatedAt`);
  assertNullableDateLike(item.resolvedAt, `${label}.resolvedAt`);
}

function assertNullableReviewerQueueAction(value: unknown, label: string): void {
  if (value !== null) {
    assertEnum(value, reviewerQueueActionList as readonly ReviewerQueueAction[], label);
  }
}

export function assertCatalogOpportunityRankingReadModel(
  value: unknown,
  label = "CatalogOpportunityRankingReadModel",
): asserts value is CatalogOpportunityRankingReadModel {
  const model = asStrictRecord(
    value,
    label,
    ITOTORI_STRICT_API_BODY_KEYS.CatalogOpportunityRankingReadModel,
  );
  assertLiteral(model.schemaVersion, "catalog.opportunity_ranking.v0.1", `${label}.schemaVersion`);
  assertPublicOpportunityString(model.targetLanguage, `${label}.targetLanguage`);
  assertDateLike(model.generatedAt, `${label}.generatedAt`);
  assertPublicOpportunityString(model.weightsVersion, `${label}.weightsVersion`);
  const rows = asArray(model.rows, `${label}.rows`);
  for (const [index, rowValue] of rows.entries()) {
    assertCatalogOpportunityRow(rowValue, `${label}.rows[${index}]`);
  }
}

function assertCatalogOpportunityRow(value: unknown, label: string): void {
  const row = asStrictRecord(value, label, [
    "rank",
    "workId",
    "canonicalTitle",
    "originalLanguage",
    "sourceIds",
    "engineName",
    "adapterId",
    "readiness",
    "runtimeEvidenceReadiness",
    "completenessPool",
    "translationStatuses",
    "demandFacts",
    "localOwnership",
    "localEvidenceCount",
    "marketPrevalence",
    "decision",
    "score",
    "factorBreakdown",
    "explanationCodes",
    "provenance",
    "demotions",
  ]);
  assertNonNegativeInteger(row.rank, `${label}.rank`);
  assertPublicOpportunityString(row.workId, `${label}.workId`);
  assertPublicOpportunityString(row.canonicalTitle, `${label}.canonicalTitle`);
  assertNullablePublicOpportunityString(row.originalLanguage, `${label}.originalLanguage`);
  assertCatalogBenchmarkSeedSourceIds(row.sourceIds, `${label}.sourceIds`);
  assertNullablePublicOpportunityString(row.engineName, `${label}.engineName`);
  assertNullablePublicOpportunityString(row.adapterId, `${label}.adapterId`);
  assertCatalogBenchmarkSeedReadiness(row.readiness, `${label}.readiness`);
  assertCatalogOpportunityRuntimeEvidenceReadiness(
    row.runtimeEvidenceReadiness,
    `${label}.runtimeEvidenceReadiness`,
  );
  assertEnum(
    row.completenessPool,
    ["mtl_only", "fan_partial", "no_english", "unknown", "conflict"] as const,
    `${label}.completenessPool`,
  );
  assertCatalogBenchmarkSeedTranslationStatuses(
    row.translationStatuses,
    `${label}.translationStatuses`,
  );
  assertCatalogOpportunityDemandFacts(row.demandFacts, `${label}.demandFacts`);
  assertEnum(
    row.localOwnership,
    ["owned", "not_owned", "unknown"] as const,
    `${label}.localOwnership`,
  );
  assertNonNegativeNumber(row.localEvidenceCount, `${label}.localEvidenceCount`);
  assertEnum(
    row.marketPrevalence,
    [
      "public_and_local_aggregate",
      "public_only",
      "local_aggregate_only",
      "unknown",
    ] as CatalogOpportunityMarketPrevalenceSignal[],
    `${label}.marketPrevalence`,
  );
  assertEnum(
    row.decision,
    ["candidate", "demoted", "excluded"] as CatalogOpportunityDecision[],
    `${label}.decision`,
  );
  assertFiniteNumber(row.score, `${label}.score`);
  assertCatalogOpportunityFactors(row.factorBreakdown, `${label}.factorBreakdown`);
  assertPublicOpportunityStringArray(row.explanationCodes, `${label}.explanationCodes`);
  assertCatalogBenchmarkSeedProvenance(row.provenance, `${label}.provenance`);
  assertCatalogOpportunityDemotions(row.demotions, `${label}.demotions`);
}

function assertCatalogOpportunityRuntimeEvidenceReadiness(value: unknown, label: string): void {
  const readiness = asStrictRecord(value, label, [
    "status",
    "publicFixtureEvidenceCount",
    "privateLocalAggregateEvidenceCount",
  ]);
  assertEnum(
    readiness.status,
    [
      "public_and_aggregate",
      "public_fixture",
      "private_local_aggregate",
      "partial_public_and_aggregate",
      "partial_public_fixture",
      "partial_private_local_aggregate",
      "unknown",
    ] as CatalogOpportunityRuntimeEvidenceSignal[],
    `${label}.status`,
  );
  assertNonNegativeNumber(
    readiness.publicFixtureEvidenceCount,
    `${label}.publicFixtureEvidenceCount`,
  );
  assertNonNegativeNumber(
    readiness.privateLocalAggregateEvidenceCount,
    `${label}.privateLocalAggregateEvidenceCount`,
  );
}

function assertCatalogOpportunityDemandFacts(value: unknown, label: string): void {
  const facts = asStrictRecord(value, label, [
    "demandBucket",
    "dlCount",
    "ratingAverage",
    "ratingCount",
    "wishlistCount",
    "bestRank",
    "workType",
  ]);
  assertEnum(
    facts.demandBucket,
    ["none", "low", "medium", "high", "very_high"] as const,
    `${label}.demandBucket`,
  );
  assertNullableNonNegativeInteger(facts.dlCount, `${label}.dlCount`);
  assertNullableNonNegativeNumber(facts.ratingAverage, `${label}.ratingAverage`);
  assertNullableNonNegativeInteger(facts.ratingCount, `${label}.ratingCount`);
  assertNullableNonNegativeInteger(facts.wishlistCount, `${label}.wishlistCount`);
  assertNullableNonNegativeInteger(facts.bestRank, `${label}.bestRank`);
  assertNullablePublicOpportunityString(facts.workType, `${label}.workType`);
}

function assertCatalogOpportunityFactors(value: unknown, label: string): void {
  const factors = asArray(value, label);
  for (const [index, factorValue] of factors.entries()) {
    const factorLabel = `${label}[${index}]`;
    const factor = asStrictRecord(factorValue, factorLabel, [
      "factor",
      "weight",
      "rawValue",
      "weightedScore",
      "evidenceRefs",
      "explanationCode",
    ]);
    assertEnum(
      factor.factor,
      [
        "translation_completeness",
        "local_ownership",
        "dlsite_demand",
        "platform_language_conflict",
        "market_prevalence",
        "adapter_readiness",
        "runtime_evidence_readiness",
        "dlsite_work_type",
        "existing_translation_status",
        "benchmark_usefulness",
        "unknown_evidence",
      ] as CatalogOpportunityFactorName[],
      `${factorLabel}.factor`,
    );
    assertFiniteNumber(factor.weight, `${factorLabel}.weight`);
    assertCatalogOpportunityRawValue(factor.rawValue, `${factorLabel}.rawValue`);
    assertFiniteNumber(factor.weightedScore, `${factorLabel}.weightedScore`);
    assertPublicOpportunityStringArray(factor.evidenceRefs, `${factorLabel}.evidenceRefs`);
    assertPublicOpportunityString(factor.explanationCode, `${factorLabel}.explanationCode`);
  }
}

function assertCatalogOpportunityRawValue(value: unknown, label: string): void {
  if (value === null || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    assertFiniteNumber(value, label);
    return;
  }
  assertPublicOpportunityString(value, label);
}

function assertCatalogOpportunityDemotions(value: unknown, label: string): void {
  const demotions = asArray(value, label);
  for (const [index, demotionValue] of demotions.entries()) {
    const demotionLabel = `${label}[${index}]`;
    const demotion = asStrictRecord(demotionValue, demotionLabel, [
      "reasonCode",
      "conflictOrigin",
      "conflictId",
      "severity",
      "sourceIds",
    ]);
    assertPublicOpportunityString(demotion.reasonCode, `${demotionLabel}.reasonCode`);
    assertEnum(
      demotion.conflictOrigin,
      ["fixture_authored", "repository_derived"] as const,
      `${demotionLabel}.conflictOrigin`,
    );
    assertNullablePublicOpportunityString(demotion.conflictId, `${demotionLabel}.conflictId`);
    assertEnum(
      demotion.severity,
      ["error", "warning", "info"] as const,
      `${demotionLabel}.severity`,
    );
    assertCatalogOpportunityDemotionSourceIds(demotion.sourceIds, `${demotionLabel}.sourceIds`);
  }
}

function assertCatalogOpportunityDemotionSourceIds(value: unknown, label: string): void {
  const sourceIds = asArray(value, label);
  for (const [index, sourceIdValue] of sourceIds.entries()) {
    const sourceId = asStrictRecord(sourceIdValue, `${label}[${index}]`, [
      "catalogSource",
      "sourceId",
    ]);
    assertEnum(
      sourceId.catalogSource,
      Object.values(catalogSourceValues) as CatalogSource[],
      `${label}[${index}].catalogSource`,
    );
    if (sourceId.catalogSource === catalogSourceValues.localCorpus) {
      throw new Error(`${label}[${index}].catalogSource must not expose local corpus sources`);
    }
    assertPublicOpportunityString(sourceId.sourceId, `${label}[${index}].sourceId`);
  }
}

export function assertCatalogBenchmarkSeedFinderReadModel(
  value: unknown,
  label = "CatalogBenchmarkSeedFinderReadModel",
): asserts value is CatalogBenchmarkSeedFinderReadModel {
  const model = asStrictRecord(
    value,
    label,
    ITOTORI_STRICT_API_BODY_KEYS.CatalogBenchmarkSeedFinderReadModel,
  );
  assertLiteral(
    model.schemaVersion,
    "catalog.benchmark_seed_finder.v0.1",
    `${label}.schemaVersion`,
  );
  assertString(model.targetLanguage, `${label}.targetLanguage`);
  assertDateLike(model.generatedAt, `${label}.generatedAt`);
  const rows = asArray(model.rows, `${label}.rows`);
  for (const [index, rowValue] of rows.entries()) {
    const rowLabel = `${label}.rows[${index}]`;
    const row = asStrictRecord(rowValue, rowLabel, [
      "workId",
      "canonicalTitle",
      "originalLanguage",
      "sourceIds",
      "completenessPool",
      "translationStatuses",
      "localOwnership",
      "localEvidenceCount",
      "demandBucket",
      "readiness",
      "provenance",
      "decision",
      "rank",
      "seedRank",
      "explanationCodes",
    ]);
    assertPublicBenchmarkSeedString(row.workId, `${rowLabel}.workId`);
    assertPublicBenchmarkSeedString(row.canonicalTitle, `${rowLabel}.canonicalTitle`);
    assertNullablePublicBenchmarkSeedString(row.originalLanguage, `${rowLabel}.originalLanguage`);
    assertCatalogBenchmarkSeedSourceIds(row.sourceIds, `${rowLabel}.sourceIds`);
    assertEnum(
      row.completenessPool,
      ["mtl_only", "fan_partial", "no_english", "unknown", "conflict"] as const,
      `${rowLabel}.completenessPool`,
    );
    assertCatalogBenchmarkSeedTranslationStatuses(
      row.translationStatuses,
      `${rowLabel}.translationStatuses`,
    );
    assertEnum(
      row.localOwnership,
      ["owned", "not_owned", "unknown"] as const,
      `${rowLabel}.localOwnership`,
    );
    assertNonNegativeNumber(row.localEvidenceCount, `${rowLabel}.localEvidenceCount`);
    assertEnum(
      row.demandBucket,
      ["none", "low", "medium", "high", "very_high"] as const,
      `${rowLabel}.demandBucket`,
    );
    assertCatalogBenchmarkSeedReadiness(row.readiness, `${rowLabel}.readiness`);
    assertCatalogBenchmarkSeedProvenance(row.provenance, `${rowLabel}.provenance`);
    assertEnum(
      row.decision,
      ["seed", "candidate", "demoted", "excluded"] as const,
      `${rowLabel}.decision`,
    );
    assertNonNegativeInteger(row.rank, `${rowLabel}.rank`);
    if (row.seedRank !== null) {
      assertNonNegativeInteger(row.seedRank, `${rowLabel}.seedRank`);
    }
    assertPublicBenchmarkSeedStringArray(row.explanationCodes, `${rowLabel}.explanationCodes`);
  }
}

function assertCatalogBenchmarkSeedSourceIds(value: unknown, label: string): void {
  const sourceIds = asArray(value, label);
  for (const [index, sourceIdValue] of sourceIds.entries()) {
    const sourceId = asStrictRecord(sourceIdValue, `${label}[${index}]`, [
      "catalogSource",
      "sourceId",
      "externalIdKind",
    ]);
    assertEnum(
      sourceId.catalogSource,
      Object.values(catalogSourceValues) as CatalogSource[],
      `${label}[${index}].catalogSource`,
    );
    if (sourceId.catalogSource === catalogSourceValues.localCorpus) {
      throw new Error(`${label}[${index}].catalogSource must not expose local corpus sources`);
    }
    assertPublicBenchmarkSeedString(sourceId.sourceId, `${label}[${index}].sourceId`);
    assertEnum(
      sourceId.externalIdKind,
      Object.values(catalogExternalIdKindValues) as CatalogExternalIdKind[],
      `${label}[${index}].externalIdKind`,
    );
  }
}

function assertCatalogBenchmarkSeedTranslationStatuses(value: unknown, label: string): void {
  const statuses = asArray(value, label);
  for (const [index, statusValue] of statuses.entries()) {
    const status = asStrictRecord(statusValue, `${label}[${index}]`, [
      "language",
      "status",
      "confidence",
      "statusScope",
      "platform",
    ]);
    assertPublicBenchmarkSeedString(status.language, `${label}[${index}].language`);
    assertEnum(
      status.status,
      Object.values(catalogLanguageStatusValues) as CatalogLanguageStatus[],
      `${label}[${index}].status`,
    );
    assertEnum(
      status.confidence,
      Object.values(catalogConfidenceValues) as CatalogConfidence[],
      `${label}[${index}].confidence`,
    );
    assertEnum(
      status.statusScope,
      Object.values(catalogLanguageStatusScopeValues) as CatalogLanguageStatusScope[],
      `${label}[${index}].statusScope`,
    );
    assertNullablePublicBenchmarkSeedString(status.platform, `${label}[${index}].platform`);
  }
}

function assertCatalogBenchmarkSeedReadiness(value: unknown, label: string): void {
  const readiness = asStrictRecord(value, label, [
    "adapterId",
    "identify",
    "inventory",
    "extract",
    "patch",
    "helper",
    "runtime",
  ]);
  assertNullablePublicBenchmarkSeedString(readiness.adapterId, `${label}.adapterId`);
  for (const level of ["identify", "inventory", "extract", "patch", "helper", "runtime"] as const) {
    assertEnum(
      readiness[level],
      ["supported", "partial", "unsupported", "unknown"] as const,
      `${label}.${level}`,
    );
  }
}

function assertCatalogBenchmarkSeedProvenance(value: unknown, label: string): void {
  const provenance = asArray(value, label);
  for (const [index, provenanceValue] of provenance.entries()) {
    const entry = asStrictRecord(provenanceValue, `${label}[${index}]`, [
      "catalogSource",
      "sourceId",
      "sourceRecordKind",
      "sourceVersion",
      "fixtureId",
      "redactionClass",
    ]);
    assertEnum(
      entry.catalogSource,
      Object.values(catalogSourceValues) as CatalogSource[],
      `${label}[${index}].catalogSource`,
    );
    if (entry.catalogSource === catalogSourceValues.localCorpus) {
      throw new Error(`${label}[${index}].catalogSource must not expose local corpus sources`);
    }
    assertPublicBenchmarkSeedString(entry.sourceId, `${label}[${index}].sourceId`);
    assertEnum(
      entry.sourceRecordKind,
      [
        catalogSourceRecordKindValues.recordedFixture,
        catalogSourceRecordKindValues.importerRequest,
      ] as CatalogSourceRecordKind[],
      `${label}[${index}].sourceRecordKind`,
    );
    assertNullablePublicBenchmarkSeedString(
      entry.sourceVersion,
      `${label}[${index}].sourceVersion`,
    );
    assertNullablePublicBenchmarkSeedString(entry.fixtureId, `${label}[${index}].fixtureId`);
    assertEnum(
      entry.redactionClass,
      Object.values(catalogRawContentRedactionClassValues) as CatalogRawContentRedactionClass[],
      `${label}[${index}].redactionClass`,
    );
    if (entry.redactionClass === catalogRawContentRedactionClassValues.privateCorpus) {
      throw new Error(`${label}[${index}].redactionClass must not expose private corpus data`);
    }
  }
}

function assertPublicBenchmarkSeedString(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  assertNoBenchmarkSeedPrivateLeakage(value, label);
}

function assertNullablePublicBenchmarkSeedString(
  value: unknown,
  label: string,
): asserts value is string | null {
  assertNullableString(value, label);
  if (value !== null) {
    assertNoBenchmarkSeedPrivateLeakage(value, label);
  }
}

function assertPublicBenchmarkSeedStringArray(value: unknown, label: string): void {
  const entries = asArray(value, label);
  for (const [index, entry] of entries.entries()) {
    assertPublicBenchmarkSeedString(entry, `${label}[${index}]`);
  }
}

const benchmarkSeedPrivateLeakagePatterns = [
  /(?:^|[ "'=])file:/iu,
  /(?:^|[ "'=])\/(?:home|tmp|var|scratch|private)(?:\/|$)/iu,
  /[A-Z]:\\/u,
  /\.(?:zip|7z|rar|tar|gz|ks)(?:$|[\\/!?#:])/iu,
  /private[-_ ](?:title|path|corpus)/iu,
  /(?:rawPayloadSecret|local-scan-entry-secret|private-story-title|private_path_hash|path_hash)/iu,
] as const;

function assertNoBenchmarkSeedPrivateLeakage(value: string, label: string): void {
  if (benchmarkSeedPrivateLeakagePatterns.some((pattern) => pattern.test(value))) {
    throw new Error(`${label} must not expose private response data`);
  }
}

function assertPublicOpportunityString(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  assertNoOpportunityPrivateLeakage(value, label);
}

function assertNullablePublicOpportunityString(
  value: unknown,
  label: string,
): asserts value is string | null {
  assertNullableString(value, label);
  if (value !== null) {
    assertNoOpportunityPrivateLeakage(value, label);
  }
}

function assertPublicOpportunityStringArray(value: unknown, label: string): void {
  const entries = asArray(value, label);
  for (const [index, entry] of entries.entries()) {
    assertPublicOpportunityString(entry, `${label}[${index}]`);
  }
}

const opportunityPrivateLeakagePatterns = [
  ...benchmarkSeedPrivateLeakagePatterns,
  /(?:localScanEntryId|local_scan_entry_id|pathHash|path_hash|rawText|raw_text)/iu,
  /(?:SECRET_KEY|helper log|rawPayloadSecret|screenshot)/iu,
  /\.(?:xp3|wolf|rvdata2|rpgmvp|rpgmvm|rpgmvo|unity3d|assetbundle)(?:$|[\\/!?#:])/iu,
] as const;

function assertNoOpportunityPrivateLeakage(value: string, label: string): void {
  if (opportunityPrivateLeakagePatterns.some((pattern) => pattern.test(value))) {
    throw new Error(`${label} must not expose private response data`);
  }
}

export function assertTerminologySearchReadModel(
  value: unknown,
  label = "TerminologySearchReadModel",
): asserts value is TerminologySearchReadModel {
  const model = asRecord(value, label);
  assertString(model.query, `${label}.query`);
  assertString(model.normalizedQuery, `${label}.normalizedQuery`);
  assertString(model.localeBranchId, `${label}.localeBranchId`);
  const results = asArray(model.results, `${label}.results`);
  for (const [index, resultValue] of results.entries()) {
    const result = asRecord(resultValue, `${label}.results[${index}]`);
    assertNonNegativeInteger(result.score, `${label}.results[${index}].score`);
    const matchKinds = asArray(result.matchKinds, `${label}.results[${index}].matchKinds`);
    for (const [matchIndex, matchKind] of matchKinds.entries()) {
      assertEnum(
        matchKind,
        ["exact_source", "exact_translation", "alias", "lexical_hook"] as const,
        `${label}.results[${index}].matchKinds[${matchIndex}]`,
      );
    }
    const term = asRecord(result.term, `${label}.results[${index}].term`);
    assertString(term.termId, `${label}.results[${index}].term.termId`);
    assertString(term.projectId, `${label}.results[${index}].term.projectId`);
    assertString(term.localeBranchId, `${label}.results[${index}].term.localeBranchId`);
    assertString(term.sourceTerm, `${label}.results[${index}].term.sourceTerm`);
    assertString(term.normalizedSourceTerm, `${label}.results[${index}].term.normalizedSourceTerm`);
    assertString(term.sourceLocale, `${label}.results[${index}].term.sourceLocale`);
    assertString(term.targetLocale, `${label}.results[${index}].term.targetLocale`);
    assertString(term.preferredTranslation, `${label}.results[${index}].term.preferredTranslation`);
    assertString(
      term.normalizedPreferredTranslation,
      `${label}.results[${index}].term.normalizedPreferredTranslation`,
    );
    assertString(term.termKind, `${label}.results[${index}].term.termKind`);
    assertNullableString(term.partOfSpeech, `${label}.results[${index}].term.partOfSpeech`);
    assertString(term.status, `${label}.results[${index}].term.status`);
    assertBoolean(term.caseSensitive, `${label}.results[${index}].term.caseSensitive`);
    assertNullableString(term.notes, `${label}.results[${index}].term.notes`);
    asRecord(term.metadata, `${label}.results[${index}].term.metadata`);
    assertNullableString(term.createdByUserId, `${label}.results[${index}].term.createdByUserId`);
    assertDateLike(term.createdAt, `${label}.results[${index}].term.createdAt`);
    assertDateLike(term.updatedAt, `${label}.results[${index}].term.updatedAt`);
    assertTerminologyAliases(term.aliases, `${label}.results[${index}].term.aliases`);
    assertTerminologySourceReferences(
      term.sourceReferences,
      `${label}.results[${index}].term.sourceReferences`,
    );
    if (term.semanticIndex !== null) {
      assertTerminologySemanticIndex(
        term.semanticIndex,
        `${label}.results[${index}].term.semanticIndex`,
      );
    }
  }
}

function assertTerminologyAliases(value: unknown, label: string): void {
  const aliases = asArray(value, label);
  for (const [index, aliasValue] of aliases.entries()) {
    const alias = asRecord(aliasValue, `${label}[${index}]`);
    assertString(alias.aliasId, `${label}[${index}].aliasId`);
    assertString(alias.termId, `${label}[${index}].termId`);
    assertString(alias.aliasText, `${label}[${index}].aliasText`);
    assertString(alias.normalizedAliasText, `${label}[${index}].normalizedAliasText`);
    assertString(alias.aliasKind, `${label}[${index}].aliasKind`);
    assertNullableString(alias.locale, `${label}[${index}].locale`);
    asRecord(alias.metadata, `${label}[${index}].metadata`);
    assertDateLike(alias.createdAt, `${label}[${index}].createdAt`);
  }
}

function assertTerminologySourceReferences(value: unknown, label: string): void {
  const references = asArray(value, label);
  for (const [index, referenceValue] of references.entries()) {
    const reference = asRecord(referenceValue, `${label}[${index}]`);
    assertString(reference.sourceRefId, `${label}[${index}].sourceRefId`);
    assertString(reference.termId, `${label}[${index}].termId`);
    assertNullableString(reference.sourceRevisionId, `${label}[${index}].sourceRevisionId`);
    assertNullableString(reference.bridgeUnitId, `${label}[${index}].bridgeUnitId`);
    assertNullableString(reference.sourceProvenanceId, `${label}[${index}].sourceProvenanceId`);
    assertString(reference.referenceKind, `${label}[${index}].referenceKind`);
    assertString(reference.citation, `${label}[${index}].citation`);
    assertNullableString(reference.context, `${label}[${index}].context`);
    asRecord(reference.metadata, `${label}[${index}].metadata`);
    assertDateLike(reference.createdAt, `${label}[${index}].createdAt`);
  }
}

function assertTerminologySemanticIndex(value: unknown, label: string): void {
  const semantic = asRecord(value, label);
  assertString(semantic.semanticIndexId, `${label}.semanticIndexId`);
  assertString(semantic.termId, `${label}.termId`);
  assertString(semantic.searchDocument, `${label}.searchDocument`);
  assertStringArray(semantic.searchTokens, `${label}.searchTokens`);
  assertString(semantic.embeddingProvider, `${label}.embeddingProvider`);
  assertString(semantic.embeddingModel, `${label}.embeddingModel`);
  assertNonNegativeInteger(semantic.embeddingDimension, `${label}.embeddingDimension`);
  if (semantic.embeddingVector !== null) {
    const vector = asArray(semantic.embeddingVector, `${label}.embeddingVector`);
    for (const [index, component] of vector.entries()) {
      if (typeof component !== "number") {
        throw new Error(`${label}.embeddingVector[${index}] must be a number`);
      }
    }
  }
  assertString(semantic.contentHash, `${label}.contentHash`);
  assertString(semantic.status, `${label}.status`);
  asRecord(semantic.metadata, `${label}.metadata`);
  if (semantic.refreshedAt !== null) {
    assertDateLike(semantic.refreshedAt, `${label}.refreshedAt`);
  }
  assertDateLike(semantic.createdAt, `${label}.createdAt`);
  assertDateLike(semantic.updatedAt, `${label}.updatedAt`);
}

export function assertCatalogCompletenessBenchmarkPools(
  value: unknown,
  label = "CatalogCompletenessBenchmarkPools",
): asserts value is CatalogCompletenessBenchmarkPools {
  const model = asStrictRecord(
    value,
    label,
    ITOTORI_STRICT_API_BODY_KEYS.CatalogCompletenessBenchmarkPools,
  );
  assertString(model.targetLanguage, `${label}.targetLanguage`);
  const pools = asStrictRecord(model.pools, `${label}.pools`, [
    "mtl_only",
    "fan_partial",
    "no_english",
    "unknown",
    "conflict",
  ]);
  for (const poolName of [
    "mtl_only",
    "fan_partial",
    "no_english",
    "unknown",
    "conflict",
  ] as const) {
    const works = asArray(pools[poolName], `${label}.pools.${poolName}`);
    for (const [index, workValue] of works.entries()) {
      const work = asStrictRecord(workValue, `${label}.pools.${poolName}[${index}]`, [
        "workId",
        "canonicalTitle",
        "originalLanguage",
        "sourceIds",
        "privateSourceCount",
        "statuses",
        "conflicts",
      ]);
      assertString(work.workId, `${label}.pools.${poolName}[${index}].workId`);
      assertString(work.canonicalTitle, `${label}.pools.${poolName}[${index}].canonicalTitle`);
      assertNullableString(
        work.originalLanguage,
        `${label}.pools.${poolName}[${index}].originalLanguage`,
      );
      assertConflictReviewSourceIds(
        work.sourceIds,
        `${label}.pools.${poolName}[${index}].sourceIds`,
      );
      assertNonNegativeInteger(
        work.privateSourceCount,
        `${label}.pools.${poolName}[${index}].privateSourceCount`,
      );
      const statuses = asArray(work.statuses, `${label}.pools.${poolName}[${index}].statuses`);
      for (const [statusIndex, statusValue] of statuses.entries()) {
        const statusLabel = `${label}.pools.${poolName}[${index}].statuses[${statusIndex}]`;
        const status = asStrictRecord(statusValue, statusLabel, [
          "languageStatusId",
          "language",
          "status",
          "statusScope",
          "platform",
          "releaseId",
          "sourceProvenanceId",
          "source",
          "privateSourceCount",
          "confidence",
          "observedAt",
          "importedAt",
          "parserVersion",
          "rawContentRedactionClass",
        ]);
        assertString(
          status.languageStatusId,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].languageStatusId`,
        );
        assertString(
          status.language,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].language`,
        );
        assertEnum(
          status.status,
          Object.values(catalogLanguageStatusValues) as CatalogLanguageStatus[],
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].status`,
        );
        assertEnum(
          status.statusScope,
          Object.values(catalogLanguageStatusScopeValues) as CatalogLanguageStatusScope[],
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].statusScope`,
        );
        assertNullableString(
          status.platform,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].platform`,
        );
        assertNullableString(
          status.releaseId,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].releaseId`,
        );
        assertNullableString(
          status.sourceProvenanceId,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].sourceProvenanceId`,
        );
        assertEnum(
          status.confidence,
          Object.values(catalogConfidenceValues) as CatalogConfidence[],
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].confidence`,
        );
        assertDateLike(
          status.observedAt,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].observedAt`,
        );
        assertDateLike(
          status.importedAt,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].importedAt`,
        );
        assertString(
          status.parserVersion,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].parserVersion`,
        );
        assertString(
          status.rawContentRedactionClass,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].rawContentRedactionClass`,
        );
        assertPublicCatalogRedactionClass(
          status.rawContentRedactionClass,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].rawContentRedactionClass`,
        );
        if (status.source !== null) {
          const sourceLabel = `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source`;
          const source = asStrictRecord(status.source, sourceLabel, [
            "sourceProvenanceId",
            "catalogSource",
            "sourceRecordKind",
            "sourceId",
            "sourceVersion",
            "fetchedAt",
            "rawContentRedactionClass",
          ]);
          assertString(
            source.sourceProvenanceId,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.sourceProvenanceId`,
          );
          assertString(
            source.catalogSource,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.catalogSource`,
          );
          assertPublicCatalogSource(
            source.catalogSource,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.catalogSource`,
          );
          assertString(
            source.sourceRecordKind,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.sourceRecordKind`,
          );
          assertPublicCatalogSourceRecordKind(
            source.sourceRecordKind,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.sourceRecordKind`,
          );
          assertString(
            source.sourceId,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.sourceId`,
          );
          assertNoCatalogPrivateLeakage(
            source.sourceId,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.sourceId`,
          );
          assertNullableString(
            source.sourceVersion,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.sourceVersion`,
          );
          assertDateLike(
            source.fetchedAt,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.fetchedAt`,
          );
          assertString(
            source.rawContentRedactionClass,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.rawContentRedactionClass`,
          );
          assertPublicCatalogRedactionClass(
            source.rawContentRedactionClass,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.rawContentRedactionClass`,
          );
        }
        assertNonNegativeInteger(
          status.privateSourceCount,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].privateSourceCount`,
        );
      }
      const conflicts = asArray(work.conflicts, `${label}.pools.${poolName}[${index}].conflicts`);
      for (const [conflictIndex, conflictValue] of conflicts.entries()) {
        const conflict = asStrictRecord(
          conflictValue,
          `${label}.pools.${poolName}[${index}].conflicts[${conflictIndex}]`,
          ["conflictId", "status", "reasonCode", "sourceIds", "privateSourceCount"],
        );
        assertString(
          conflict.conflictId,
          `${label}.pools.${poolName}[${index}].conflicts[${conflictIndex}].conflictId`,
        );
        assertEnum(
          conflict.status,
          Object.values(catalogConflictStatusValues) as CatalogConflictStatus[],
          `${label}.pools.${poolName}[${index}].conflicts[${conflictIndex}].status`,
        );
        assertString(
          conflict.reasonCode,
          `${label}.pools.${poolName}[${index}].conflicts[${conflictIndex}].reasonCode`,
        );
        assertConflictReviewSourceIds(
          conflict.sourceIds,
          `${label}.pools.${poolName}[${index}].conflicts[${conflictIndex}].sourceIds`,
        );
        assertNonNegativeInteger(
          conflict.privateSourceCount,
          `${label}.pools.${poolName}[${index}].conflicts[${conflictIndex}].privateSourceCount`,
        );
      }
    }
  }
  const publicReport = asStrictRecord(model.publicReport, `${label}.publicReport`, [
    "schemaVersion",
    "targetLanguage",
    "generatedAt",
    "totalWorkCount",
    "conflictCount",
    "pools",
    "statuses",
  ]);
  assertString(publicReport.schemaVersion, `${label}.publicReport.schemaVersion`);
  assertString(publicReport.targetLanguage, `${label}.publicReport.targetLanguage`);
  assertDateLike(publicReport.generatedAt, `${label}.publicReport.generatedAt`);
  assertNonNegativeInteger(publicReport.totalWorkCount, `${label}.publicReport.totalWorkCount`);
  assertNonNegativeInteger(publicReport.conflictCount, `${label}.publicReport.conflictCount`);
  const reportPools = asArray(publicReport.pools, `${label}.publicReport.pools`);
  for (const [index, poolValue] of reportPools.entries()) {
    const pool = asStrictRecord(poolValue, `${label}.publicReport.pools[${index}]`, [
      "pool",
      "workCount",
      "sourceIds",
    ]);
    assertEnum(
      pool.pool,
      Object.values(catalogCompletenessPoolValues) as CatalogCompletenessPool[],
      `${label}.publicReport.pools[${index}].pool`,
    );
    assertNonNegativeInteger(pool.workCount, `${label}.publicReport.pools[${index}].workCount`);
    assertConflictReviewSourceIds(
      pool.sourceIds,
      `${label}.publicReport.pools[${index}].sourceIds`,
    );
  }
  const reportStatuses = asArray(publicReport.statuses, `${label}.publicReport.statuses`);
  for (const [index, statusValue] of reportStatuses.entries()) {
    const status = asStrictRecord(statusValue, `${label}.publicReport.statuses[${index}]`, [
      "status",
      "factCount",
      "sourceIds",
    ]);
    assertEnum(
      status.status,
      Object.values(catalogLanguageStatusValues) as CatalogLanguageStatus[],
      `${label}.publicReport.statuses[${index}].status`,
    );
    assertNonNegativeInteger(
      status.factCount,
      `${label}.publicReport.statuses[${index}].factCount`,
    );
    assertConflictReviewSourceIds(
      status.sourceIds,
      `${label}.publicReport.statuses[${index}].sourceIds`,
    );
  }
}

const catalogConflictReviewStatusValues: readonly CatalogConflictReviewStatus[] = [
  ...Object.values(catalogConflictStatusValues),
  ...Object.values(catalogCandidateMatchStatusValues),
];

export function assertCatalogConflictReviewReadModel(
  value: unknown,
  label = "CatalogConflictReviewReadModel",
): asserts value is CatalogConflictReviewReadModel {
  const model = asStrictRecord(
    value,
    label,
    ITOTORI_STRICT_API_BODY_KEYS.CatalogConflictReviewReadModel,
  );
  const rows = asArray(model.rows, `${label}.rows`);
  for (const [index, rowValue] of rows.entries()) {
    const row = asStrictRecord(rowValue, `${label}.rows[${index}]`, [
      "reviewId",
      "catalogRecordId",
      "conflictId",
      "candidateIds",
      "candidateCatalogIds",
      "exactLinkRefs",
      "fuzzyScores",
      "sourceIds",
      "provenance",
      "privateSourceCount",
      "severity",
      "status",
      "reasonCode",
      "reasonDetail",
      "conflictOrigin",
      "conflictKind",
      "detectedAt",
      "resolution",
    ]);
    assertString(row.reviewId, `${label}.rows[${index}].reviewId`);
    assertString(row.catalogRecordId, `${label}.rows[${index}].catalogRecordId`);
    assertNullableString(row.conflictId, `${label}.rows[${index}].conflictId`);
    assertStringArray(row.candidateIds, `${label}.rows[${index}].candidateIds`);
    assertStringArray(row.candidateCatalogIds, `${label}.rows[${index}].candidateCatalogIds`);
    assertConflictReviewExactLinkRefs(row.exactLinkRefs, `${label}.rows[${index}].exactLinkRefs`);
    assertConflictReviewFuzzyScores(row.fuzzyScores, `${label}.rows[${index}].fuzzyScores`);
    assertConflictReviewSourceIds(row.sourceIds, `${label}.rows[${index}].sourceIds`);
    assertConflictReviewProvenance(row.provenance, `${label}.rows[${index}].provenance`);
    assertNonNegativeInteger(row.privateSourceCount, `${label}.rows[${index}].privateSourceCount`);
    assertEnum(
      row.severity,
      ["error", "warning", "info"] as const,
      `${label}.rows[${index}].severity`,
    );
    assertEnum(row.status, catalogConflictReviewStatusValues, `${label}.rows[${index}].status`);
    assertString(row.reasonCode, `${label}.rows[${index}].reasonCode`);
    assertString(row.reasonDetail, `${label}.rows[${index}].reasonDetail`);
    assertEnum(
      row.conflictOrigin,
      ["fixture_authored", "repository_derived"] as const,
      `${label}.rows[${index}].conflictOrigin`,
    );
    assertNullableEnum(
      row.conflictKind,
      Object.values(catalogConflictKindValues) as CatalogConflictKind[],
      `${label}.rows[${index}].conflictKind`,
    );
    assertDateLike(row.detectedAt, `${label}.rows[${index}].detectedAt`);
    if (row.resolution !== null) {
      const resolution = asStrictRecord(row.resolution, `${label}.rows[${index}].resolution`, [
        "reviewerId",
        "action",
        "resolvedAt",
        "priorCandidateIds",
      ]);
      assertString(resolution.reviewerId, `${label}.rows[${index}].resolution.reviewerId`);
      assertString(resolution.action, `${label}.rows[${index}].resolution.action`);
      assertDateLike(resolution.resolvedAt, `${label}.rows[${index}].resolution.resolvedAt`);
      assertStringArray(
        resolution.priorCandidateIds,
        `${label}.rows[${index}].resolution.priorCandidateIds`,
      );
    }
  }
}

export function assertProjectDashboardStatus(
  value: unknown,
  label = "ProjectDashboardStatus",
): asserts value is ProjectDashboardStatus {
  const status = asRecord(value, label);
  assertString(status.projectId, `${label}.projectId`);
  assertString(status.projectKey, `${label}.projectKey`);
  assertString(status.name, `${label}.name`);
  assertString(status.status, `${label}.status`);
  assertString(status.sourceLocale, `${label}.sourceLocale`);
  assertString(status.sourceBundleId, `${label}.sourceBundleId`);
  assertString(status.sourceBundleHash, `${label}.sourceBundleHash`);
  assertString(status.sourceBundleRevisionId, `${label}.sourceBundleRevisionId`);
  assertNonNegativeInteger(status.branchCount, `${label}.branchCount`);
  assertNonNegativeInteger(status.unitCount, `${label}.unitCount`);
  assertNonNegativeInteger(status.findingCount, `${label}.findingCount`);
  assertNonNegativeInteger(status.artifactCount, `${label}.artifactCount`);
  assertNullableString(status.latestEventKind, `${label}.latestEventKind`);
  assertNullableString(status.latestEventAt, `${label}.latestEventAt`);
  assertNullableString(status.selectedLocaleBranchId, `${label}.selectedLocaleBranchId`);
  assertNullableString(
    status.currentStyleGuidePolicyVersionId,
    `${label}.currentStyleGuidePolicyVersionId`,
  );
  assertBridgeImportStatus(status.importStatus, `${label}.importStatus`);
  assertProjectCostReport(status.cost, `${label}.cost`);
  const branches = asArray(status.localeBranches, `${label}.localeBranches`);
  for (const [index, branchValue] of branches.entries()) {
    const branch = asRecord(branchValue, `${label}.localeBranches[${index}]`);
    assertString(branch.localeBranchId, `${label}.localeBranches[${index}].localeBranchId`);
    assertString(branch.targetLocale, `${label}.localeBranches[${index}].targetLocale`);
    assertString(branch.status, `${label}.localeBranches[${index}].status`);
    assertNullableString(
      branch.currentStyleGuidePolicyVersionId,
      `${label}.localeBranches[${index}].currentStyleGuidePolicyVersionId`,
    );
    assertNonNegativeInteger(branch.unitCount, `${label}.localeBranches[${index}].unitCount`);
    assertNonNegativeInteger(
      branch.translatedUnitCount,
      `${label}.localeBranches[${index}].translatedUnitCount`,
    );
    assertNonNegativeInteger(
      branch.openFindingCount,
      `${label}.localeBranches[${index}].openFindingCount`,
    );
    assertNonNegativeInteger(
      branch.artifactCount,
      `${label}.localeBranches[${index}].artifactCount`,
    );
  }
}

function assertBridgeImportStatus(value: unknown, label: string): void {
  const status = asRecord(value, label);
  assertString(status.bridgeImportId, `${label}.bridgeImportId`);
  assertString(status.projectId, `${label}.projectId`);
  assertString(status.bridgeId, `${label}.bridgeId`);
  assertString(status.sourceBundleId, `${label}.sourceBundleId`);
  assertString(status.sourceBundleHash, `${label}.sourceBundleHash`);
  assertString(status.sourceBundleRevisionId, `${label}.sourceBundleRevisionId`);
  assertString(status.schemaVersion, `${label}.schemaVersion`);
  assertString(status.sourceLocale, `${label}.sourceLocale`);
  assertString(status.importedAt, `${label}.importedAt`);
  assertNonNegativeInteger(status.unitCount, `${label}.unitCount`);
  assertNonNegativeInteger(status.assetCount, `${label}.assetCount`);
  assertNonNegativeInteger(status.sourceRevisionCount, `${label}.sourceRevisionCount`);
  assertNonNegativeInteger(status.validationFailureCount, `${label}.validationFailureCount`);
  assertDiffCounts(status.units, `${label}.units`);
  assertDiffCounts(status.assets, `${label}.assets`);
  const sourceRevisions = asRecord(status.sourceRevisions, `${label}.sourceRevisions`);
  assertNonNegativeInteger(sourceRevisions.added, `${label}.sourceRevisions.added`);
  assertNonNegativeInteger(sourceRevisions.existing, `${label}.sourceRevisions.existing`);
  assertCountTotal(status.units, status.unitCount, `${label}.units`, `${label}.unitCount`);
  assertCountTotal(status.assets, status.assetCount, `${label}.assets`, `${label}.assetCount`);
  const sourceRevisionTotal = Number(sourceRevisions.added) + Number(sourceRevisions.existing);
  if (sourceRevisionTotal !== Number(status.sourceRevisionCount)) {
    throw new Error(`${label}.sourceRevisions must add up to ${label}.sourceRevisionCount`);
  }
  const futureReferences = asRecord(status.futureReferences, `${label}.futureReferences`);
  assertNullableString(futureReferences.catalogWorkId, `${label}.futureReferences.catalogWorkId`);
  assertNullableString(
    futureReferences.localCorpusEntryId,
    `${label}.futureReferences.localCorpusEntryId`,
  );
  assertNullableString(
    futureReferences.readinessProfileId,
    `${label}.futureReferences.readinessProfileId`,
  );
  assertNullableString(
    futureReferences.completenessStatusId,
    `${label}.futureReferences.completenessStatusId`,
  );
}

function assertDiffCounts(value: unknown, label: string): void {
  const counts = asRecord(value, label);
  assertNonNegativeInteger(counts.added, `${label}.added`);
  assertNonNegativeInteger(counts.updated, `${label}.updated`);
  assertNonNegativeInteger(counts.removed, `${label}.removed`);
  assertNonNegativeInteger(counts.unchanged, `${label}.unchanged`);
}

function assertCountTotal(value: unknown, total: unknown, label: string, totalLabel: string): void {
  const counts = asRecord(value, label);
  const countTotal = Number(counts.added) + Number(counts.updated) + Number(counts.unchanged);
  if (countTotal !== Number(total)) {
    throw new Error(`${label} current counts must add up to ${totalLabel}`);
  }
}

function assertDecisionCount(value: unknown, expected: number, label: string): void {
  if (Number(value) !== expected) {
    throw new Error(`${label} must match pendingDecisions`);
  }
}

function assertApiBenchmarkReportsResponse(
  value: unknown,
  label = "ApiBenchmarkReportsResponse",
): asserts value is ApiBenchmarkReportsResponse {
  const response = asStrictRecord(
    value,
    label,
    ITOTORI_STRICT_API_BODY_KEYS.ApiBenchmarkReportsResponse,
  );
  const reports = asArray(response.reports, `${label}.reports`);
  for (const [index, report] of reports.entries()) {
    assertBenchmarkReportSummary(report, `${label}.reports[${index}]`);
  }
}

const BMK_COCKPIT_CONTESTANT_KINDS = [
  "official_localization",
  "itotori_context_on",
  "itotori_context_off",
  "fan_edited_mtl",
  "raw_mtl_baseline",
] as const;

const BMK_COCKPIT_RUN_KINDS = ["real_run", "fixture", "replay"] as const;

const BMK_COCKPIT_RUN_STATUSES = ["succeeded", "failed", "partial"] as const;

const BMK_COCKPIT_CONFIDENCE_BASES = ["pearson", "agreement", "none"] as const;

const BMK_COCKPIT_BACKLOG_RANK_TIERS = [
  "top_priority",
  "improvement_backlog",
  "regression_protection",
] as const;

const BMK_COCKPIT_BACKLOG_SIGNAL_SOURCES = ["blind_judge_panel", "deterministic_metric"] as const;

const BMK_COCKPIT_BACKLOG_SCOPE_KINDS = ["scene", "speaker", "corpus_wide"] as const;

const BMK_COCKPIT_BACKLOG_LADDER_SCALES = ["judge_mean_0_4", "metric_0_1"] as const;

const BMK_COCKPIT_REGRESSION_DIRECTIONS = ["new", "improved", "regressed", "unchanged"] as const;

function assertBmkCockpitReadModel(
  value: unknown,
  label = "BmkCockpitReadModel",
): asserts value is BmkCockpitReadModel {
  const model = asStrictRecord(value, label, ITOTORI_STRICT_API_BODY_KEYS.BmkCockpitReadModel);
  assertLiteral(model.schemaVersion, BMK_COCKPIT_SCHEMA_VERSION, `${label}.schemaVersion`);
  assertDateLike(model.generatedAt, `${label}.generatedAt`);
  assertString(model.projectId, `${label}.projectId`);
  assertNullableString(model.localeBranchId, `${label}.localeBranchId`);
  assertString(model.runId, `${label}.runId`);
  assertString(model.targetLocale, `${label}.targetLocale`);
  assertEnum(model.kind, BMK_COCKPIT_RUN_KINDS, `${label}.kind`);
  assertEnum(model.status, BMK_COCKPIT_RUN_STATUSES, `${label}.status`);
  assertNonNegativeInteger(model.unitsScored, `${label}.unitsScored`);
  assertDateLike(model.recordedAt, `${label}.recordedAt`);

  const contestants = asArray(model.contestants, `${label}.contestants`);
  for (const [index, contestant] of contestants.entries()) {
    assertBmkCockpitContestant(contestant, `${label}.contestants[${index}]`);
  }

  const rankedRoles = asArray(model.rankedRoles, `${label}.rankedRoles`);
  for (const [index, role] of rankedRoles.entries()) {
    assertEnum(role, BMK_COCKPIT_CONTESTANT_ROLES, `${label}.rankedRoles[${index}]`);
  }

  assertBmkCockpitHumanAnchor(model.humanAnchor, `${label}.humanAnchor`);
  assertBmkCockpitConfidence(model.confidence, `${label}.confidence`);
  const backlogSize = assertBmkCockpitBacklog(
    model.actionableBacklog,
    `${label}.actionableBacklog`,
  );
  assertNonNegativeInteger(model.actionableBacklogSize, `${label}.actionableBacklogSize`);
  if (model.actionableBacklogSize !== backlogSize) {
    throw new Error(`${label}.actionableBacklogSize must match actionableBacklog.items.length`);
  }
}

function assertBmkCockpitContestant(value: unknown, label: string): void {
  const contestant = asStrictRecord(value, label, [
    "role",
    "contestantKind",
    "aggregateScore",
    "rank",
    "judgeMean",
    "metricMean",
    "coverage",
  ]);
  assertEnum(contestant.role, BMK_COCKPIT_CONTESTANT_ROLES, `${label}.role`);
  assertEnum(contestant.contestantKind, BMK_COCKPIT_CONTESTANT_KINDS, `${label}.contestantKind`);
  assertNullableNonNegativeNumber(contestant.aggregateScore, `${label}.aggregateScore`);
  assertNullableNonNegativeInteger(contestant.rank, `${label}.rank`);
  assertNullableNonNegativeNumber(contestant.judgeMean, `${label}.judgeMean`);
  assertNullableNonNegativeNumber(contestant.metricMean, `${label}.metricMean`);
  assertNullableNonNegativeNumber(contestant.coverage, `${label}.coverage`);
}

function assertBmkCockpitHumanAnchor(value: unknown, label: string): void {
  const anchor = asStrictRecord(value, label, [
    "raters",
    "judgeIds",
    "byDimensionCount",
    "divergentDimensionCount",
    "overall",
  ]);
  assertStringArray(anchor.raters, `${label}.raters`);
  assertStringArray(anchor.judgeIds, `${label}.judgeIds`);
  assertNonNegativeInteger(anchor.byDimensionCount, `${label}.byDimensionCount`);
  assertNonNegativeInteger(anchor.divergentDimensionCount, `${label}.divergentDimensionCount`);

  const overall = asStrictRecord(anchor.overall, `${label}.overall`, [
    "itemsCompared",
    "normalizedAgreement",
    "signedMeanDiff",
    "pearson",
  ]);
  assertNonNegativeInteger(overall.itemsCompared, `${label}.overall.itemsCompared`);
  assertNullableNonNegativeNumber(
    overall.normalizedAgreement,
    `${label}.overall.normalizedAgreement`,
  );
  assertNullableFiniteNumber(overall.signedMeanDiff, `${label}.overall.signedMeanDiff`);
  assertNullableFiniteNumber(overall.pearson, `${label}.overall.pearson`);
}

function assertBmkCockpitConfidence(value: unknown, label: string): void {
  const confidence = asStrictRecord(value, label, [
    "pearson",
    "normalizedAgreement",
    "value",
    "basis",
  ]);
  assertNullableFiniteNumber(confidence.pearson, `${label}.pearson`);
  assertNullableNonNegativeNumber(confidence.normalizedAgreement, `${label}.normalizedAgreement`);
  assertNullableNonNegativeNumber(confidence.value, `${label}.value`);
  assertEnum(confidence.basis, BMK_COCKPIT_CONFIDENCE_BASES, `${label}.basis`);
}

function assertBmkCockpitBacklog(value: unknown, label: string): number {
  const backlog = asStrictRecord(value, label, [
    "systemUnderTestId",
    "fanMtlSystemId",
    "professionalSystemId",
    "items",
    "countsByRank",
    "perDimensionRegression",
    "perSignalScores",
    "dag",
    "adjudicatedFindings",
  ]);
  assertString(backlog.systemUnderTestId, `${label}.systemUnderTestId`);
  assertNullableString(backlog.fanMtlSystemId, `${label}.fanMtlSystemId`);
  assertNullableString(backlog.professionalSystemId, `${label}.professionalSystemId`);
  assertBmkCockpitBacklogCounts(backlog.countsByRank, `${label}.countsByRank`);

  const items = asArray(backlog.items, `${label}.items`);
  for (const [index, item] of items.entries()) {
    assertBmkCockpitBacklogItem(item, `${label}.items[${index}]`);
  }

  const regressions = asArray(backlog.perDimensionRegression, `${label}.perDimensionRegression`);
  for (const [index, regression] of regressions.entries()) {
    assertBmkCockpitRegressionRef(regression, `${label}.perDimensionRegression[${index}]`, true);
  }

  const scores = asArray(backlog.perSignalScores, `${label}.perSignalScores`);
  for (const [index, score] of scores.entries()) {
    assertBmkCockpitSignalScore(score, `${label}.perSignalScores[${index}]`);
  }

  assertBmkCockpitBacklogDag(backlog.dag, `${label}.dag`);
  asArray(backlog.adjudicatedFindings, `${label}.adjudicatedFindings`);
  return items.length;
}

function assertBmkCockpitBacklogCounts(value: unknown, label: string): void {
  const counts = asStrictRecord(value, label, BMK_COCKPIT_BACKLOG_RANK_TIERS);
  for (const tier of BMK_COCKPIT_BACKLOG_RANK_TIERS) {
    assertNonNegativeInteger(counts[tier], `${label}.${tier}`);
  }
}

function assertBmkCockpitBacklogItem(value: unknown, label: string): void {
  const item = asStrictRecord(value, label, [
    "backlogItemId",
    "failureMode",
    "dimension",
    "signalSource",
    "scope",
    "evidence",
    "cause",
    "causeAdjudicated",
    "fixCandidate",
    "rank",
    "ladder",
    "regressionRef",
    "findingIds",
    "worstSeverity",
    "priorityOrder",
  ]);
  assertString(item.backlogItemId, `${label}.backlogItemId`);
  assertString(item.failureMode, `${label}.failureMode`);
  assertString(item.dimension, `${label}.dimension`);
  assertEnum(item.signalSource, BMK_COCKPIT_BACKLOG_SIGNAL_SOURCES, `${label}.signalSource`);
  assertBmkCockpitBacklogScope(item.scope, `${label}.scope`);
  assertBmkCockpitBacklogEvidence(item.evidence, `${label}.evidence`);
  assertString(item.cause, `${label}.cause`);
  assertBoolean(item.causeAdjudicated, `${label}.causeAdjudicated`);
  assertString(item.fixCandidate, `${label}.fixCandidate`);
  assertEnum(item.rank, BMK_COCKPIT_BACKLOG_RANK_TIERS, `${label}.rank`);
  assertBmkCockpitBacklogLadder(item.ladder, `${label}.ladder`);
  if (item.regressionRef !== null) {
    assertBmkCockpitRegressionRef(item.regressionRef, `${label}.regressionRef`, false);
  }
  assertStringArray(item.findingIds, `${label}.findingIds`);
  assertString(item.worstSeverity, `${label}.worstSeverity`);
  assertNonNegativeInteger(item.priorityOrder, `${label}.priorityOrder`);
}

function assertBmkCockpitBacklogScope(value: unknown, label: string): void {
  const scope = asStrictRecord(value, label, [
    "scopeKind",
    "scopeId",
    "unitCount",
    "unitIds",
    "description",
  ]);
  assertEnum(scope.scopeKind, BMK_COCKPIT_BACKLOG_SCOPE_KINDS, `${label}.scopeKind`);
  assertString(scope.scopeId, `${label}.scopeId`);
  assertNonNegativeInteger(scope.unitCount, `${label}.unitCount`);
  assertStringArray(scope.unitIds, `${label}.unitIds`);
  assertString(scope.description, `${label}.description`);
}

function assertBmkCockpitBacklogEvidence(value: unknown, label: string): void {
  const rows = asArray(value, label);
  for (const [index, evidenceValue] of rows.entries()) {
    const evidence = asStrictRecord(evidenceValue, `${label}[${index}]`, [
      "unitId",
      "label",
      "sourceSpan",
      "decodedContextUsed",
      "rationale",
      "judgeId",
      "findingId",
    ]);
    assertString(evidence.unitId, `${label}[${index}].unitId`);
    assertString(evidence.label, `${label}[${index}].label`);
    assertString(evidence.sourceSpan, `${label}[${index}].sourceSpan`);
    assertString(evidence.decodedContextUsed, `${label}[${index}].decodedContextUsed`);
    assertString(evidence.rationale, `${label}[${index}].rationale`);
    if (evidence.judgeId !== undefined) {
      assertString(evidence.judgeId, `${label}[${index}].judgeId`);
    }
    assertString(evidence.findingId, `${label}[${index}].findingId`);
  }
}

function assertBmkCockpitBacklogLadder(value: unknown, label: string): void {
  const ladder = asStrictRecord(value, label, [
    "scale",
    "systemUnderTestScore",
    "fanMtlScore",
    "professionalScore",
    "beatsFanMtl",
    "beatsProfessional",
  ]);
  assertEnum(ladder.scale, BMK_COCKPIT_BACKLOG_LADDER_SCALES, `${label}.scale`);
  assertNullableFiniteNumber(ladder.systemUnderTestScore, `${label}.systemUnderTestScore`);
  assertNullableFiniteNumber(ladder.fanMtlScore, `${label}.fanMtlScore`);
  assertNullableFiniteNumber(ladder.professionalScore, `${label}.professionalScore`);
  assertNullableBoolean(ladder.beatsFanMtl, `${label}.beatsFanMtl`);
  assertNullableBoolean(ladder.beatsProfessional, `${label}.beatsProfessional`);
}

function assertBmkCockpitRegressionRef(
  value: unknown,
  label: string,
  includesLabel: boolean,
): void {
  const regression = asStrictRecord(value, label, [
    "signalSource",
    "key",
    "currentScore",
    "priorScore",
    "delta",
    "direction",
    "summary",
    ...(includesLabel ? ["label"] : []),
  ]);
  assertEnum(regression.signalSource, BMK_COCKPIT_BACKLOG_SIGNAL_SOURCES, `${label}.signalSource`);
  assertString(regression.key, `${label}.key`);
  assertFiniteNumber(regression.currentScore, `${label}.currentScore`);
  assertNullableFiniteNumber(regression.priorScore, `${label}.priorScore`);
  assertNullableFiniteNumber(regression.delta, `${label}.delta`);
  assertEnum(regression.direction, BMK_COCKPIT_REGRESSION_DIRECTIONS, `${label}.direction`);
  assertString(regression.summary, `${label}.summary`);
  if (includesLabel) {
    assertString(regression.label, `${label}.label`);
  }
}

function assertBmkCockpitSignalScore(value: unknown, label: string): void {
  const score = asStrictRecord(value, label, ["signalSource", "key", "label", "score"]);
  assertEnum(score.signalSource, BMK_COCKPIT_BACKLOG_SIGNAL_SOURCES, `${label}.signalSource`);
  assertString(score.key, `${label}.key`);
  assertString(score.label, `${label}.label`);
  assertNonNegativeNumber(score.score, `${label}.score`);
}

function assertBmkCockpitBacklogDag(value: unknown, label: string): void {
  const dag = asStrictRecord(value, label, ["nodes", "findings"]);
  const nodes = asArray(dag.nodes, `${label}.nodes`);
  for (const [index, node] of nodes.entries()) {
    assertBmkCockpitBacklogDagNode(node, `${label}.nodes[${index}]`);
  }
  asArray(dag.findings, `${label}.findings`);
}

function assertBmkCockpitBacklogDagNode(value: unknown, label: string): void {
  const node = asStrictRecord(value, label, [
    "nodeId",
    "title",
    "rank",
    "priorityOrder",
    "dimension",
    "cause",
    "fixCandidate",
    "findingIds",
    "scope",
  ]);
  assertString(node.nodeId, `${label}.nodeId`);
  assertString(node.title, `${label}.title`);
  assertEnum(node.rank, BMK_COCKPIT_BACKLOG_RANK_TIERS, `${label}.rank`);
  assertNonNegativeInteger(node.priorityOrder, `${label}.priorityOrder`);
  assertString(node.dimension, `${label}.dimension`);
  assertString(node.cause, `${label}.cause`);
  assertString(node.fixCandidate, `${label}.fixCandidate`);
  assertStringArray(node.findingIds, `${label}.findingIds`);
  assertBmkCockpitBacklogScope(node.scope, `${label}.scope`);
}

function assertBmkCockpitRunHistoryPage(
  value: unknown,
  label = "BmkCockpitRunHistoryPage",
): asserts value is BmkCockpitRunHistoryPage {
  const page = asStrictRecord(value, label, ITOTORI_STRICT_API_BODY_KEYS.BmkCockpitRunHistoryPage);
  const filter = asStrictRecord(page.filter, `${label}.filter`, ["projectId", "localeBranchId"]);
  assertString(filter.projectId, `${label}.filter.projectId`);
  assertNullableString(filter.localeBranchId, `${label}.filter.localeBranchId`);

  const pagination = asStrictRecord(page.pagination, `${label}.pagination`, [
    "limit",
    "offset",
    "hasMore",
    "nextOffset",
  ]);
  assertPositiveInteger(pagination.limit, `${label}.pagination.limit`);
  assertNonNegativeInteger(pagination.offset, `${label}.pagination.offset`);
  assertBoolean(pagination.hasMore, `${label}.pagination.hasMore`);
  if (pagination.nextOffset !== null) {
    assertNonNegativeInteger(pagination.nextOffset, `${label}.pagination.nextOffset`);
  }
  if (pagination.hasMore === (pagination.nextOffset === null)) {
    throw new Error(`${label}.pagination.hasMore must agree with nextOffset`);
  }

  const rows = asArray(page.rows, `${label}.rows`);
  if (rows.length > Number(pagination.limit)) {
    throw new Error(`${label}.rows must not exceed pagination.limit`);
  }
  for (const [index, row] of rows.entries()) {
    assertBmkCockpitRunHistoryRow(row, `${label}.rows[${index}]`);
  }
}

function assertBmkCockpitRunHistoryRow(value: unknown, label: string): void {
  const row = asStrictRecord(value, label, [
    "runId",
    "projectId",
    "localeBranchId",
    "targetLocale",
    "kind",
    "status",
    "unitsScored",
    "recordedAt",
    "bestRole",
    "actionableBacklogSize",
    "confidence",
  ]);
  assertString(row.runId, `${label}.runId`);
  assertString(row.projectId, `${label}.projectId`);
  assertNullableString(row.localeBranchId, `${label}.localeBranchId`);
  assertString(row.targetLocale, `${label}.targetLocale`);
  assertEnum(row.kind, BMK_COCKPIT_RUN_KINDS, `${label}.kind`);
  assertEnum(row.status, BMK_COCKPIT_RUN_STATUSES, `${label}.status`);
  assertNonNegativeInteger(row.unitsScored, `${label}.unitsScored`);
  assertDateLike(row.recordedAt, `${label}.recordedAt`);
  assertNullableEnum(row.bestRole, BMK_COCKPIT_CONTESTANT_ROLES, `${label}.bestRole`);
  assertNonNegativeInteger(row.actionableBacklogSize, `${label}.actionableBacklogSize`);
  assertNullableNonNegativeNumber(row.confidence, `${label}.confidence`);
}

/** ITOTORI-047 — assert a {@link QueueHealthReadModel} (the queue.health body). */
export function assertQueueHealthReadModel(
  value: unknown,
  label = "QueueHealthReadModel",
): asserts value is QueueHealthReadModel {
  const model = asStrictRecord(value, label, ITOTORI_STRICT_API_BODY_KEYS.QueueHealthReadModel);
  assertLiteral(model.schemaVersion, "itotori.queue_health.v0.1", `${label}.schemaVersion`);
  assertDateLike(model.generatedAt, `${label}.generatedAt`);
  assertQueueHealthSection(model.outbox, `${label}.outbox`, "outbox");
  assertQueueHealthSection(model.jobs, `${label}.jobs`, "jobs");
}

function assertQueueHealthSection(value: unknown, label: string, section: "outbox" | "jobs"): void {
  const sectionKeys = [
    "unprocessedCount",
    "oldestUnprocessedAt",
    "unprocessedLagSeconds",
    "statusCounts",
    "retryingCount",
    "deadLetter",
  ];
  const sectionRecord = asStrictRecord(value, label, sectionKeys);
  assertNonNegativeInteger(sectionRecord.unprocessedCount, `${label}.unprocessedCount`);
  if (sectionRecord.oldestUnprocessedAt !== null) {
    assertDateLike(sectionRecord.oldestUnprocessedAt, `${label}.oldestUnprocessedAt`);
  }
  if (sectionRecord.unprocessedLagSeconds !== null) {
    assertNonNegativeNumber(sectionRecord.unprocessedLagSeconds, `${label}.unprocessedLagSeconds`);
  }
  const statusCounts = asArray(sectionRecord.statusCounts, `${label}.statusCounts`);
  for (const [index, entry] of statusCounts.entries()) {
    assertQueueStatusCount(entry, `${label}.statusCounts[${index}]`);
  }
  assertNonNegativeInteger(sectionRecord.retryingCount, `${label}.retryingCount`);
  assertQueueDeadLetterReview(sectionRecord.deadLetter, `${label}.deadLetter`, section);
}

function assertQueueStatusCount(value: unknown, label: string): void {
  const record = asStrictRecord(value, label, ["status", "count"]);
  assertString(record.status, `${label}.status`);
  assertNonNegativeInteger(record.count, `${label}.count`);
}

function assertQueueDeadLetterReview(
  value: unknown,
  label: string,
  section: "outbox" | "jobs",
): void {
  const review = asStrictRecord(value, label, ["count", "recent"]);
  assertNonNegativeInteger(review.count, `${label}.count`);
  const recent = asArray(review.recent, `${label}.recent`);
  for (const [index, entry] of recent.entries()) {
    if (section === "outbox") {
      assertQueueOutboxRecord(entry, `${label}.recent[${index}]`);
    } else {
      assertQueueJobRecord(entry, `${label}.recent[${index}]`);
    }
  }
}

function assertQueueOutboxRecord(value: unknown, label: string): void {
  const record = asStrictRecord(value, label, [
    "outboxEventId",
    "projectId",
    "localeBranchId",
    "sourceEventId",
    "eventType",
    "status",
    "idempotencyKey",
    "correlationId",
    "causationId",
    "payload",
    "availableAt",
    "attemptCount",
    "maxAttempts",
    "lockedBy",
    "lockedAt",
    "leaseExpiresAt",
    "publishedAt",
    "lastError",
    "errorHistory",
    "createdAt",
    "updatedAt",
  ]);
  assertString(record.outboxEventId, `${label}.outboxEventId`);
  assertString(record.projectId, `${label}.projectId`);
  if (record.localeBranchId !== null) {
    assertString(record.localeBranchId, `${label}.localeBranchId`);
  }
  if (record.sourceEventId !== null) {
    assertString(record.sourceEventId, `${label}.sourceEventId`);
  }
  assertString(record.eventType, `${label}.eventType`);
  assertString(record.status, `${label}.status`);
  assertString(record.idempotencyKey, `${label}.idempotencyKey`);
  assertString(record.correlationId, `${label}.correlationId`);
  if (record.causationId !== null) {
    assertString(record.causationId, `${label}.causationId`);
  }
  asRecord(record.payload, `${label}.payload`);
  assertDateLike(record.availableAt, `${label}.availableAt`);
  assertNonNegativeInteger(record.attemptCount, `${label}.attemptCount`);
  assertPositiveInteger(record.maxAttempts, `${label}.maxAttempts`);
  if (record.lockedBy !== null) {
    assertString(record.lockedBy, `${label}.lockedBy`);
  }
  if (record.lockedAt !== null) {
    assertDateLike(record.lockedAt, `${label}.lockedAt`);
  }
  if (record.leaseExpiresAt !== null) {
    assertDateLike(record.leaseExpiresAt, `${label}.leaseExpiresAt`);
  }
  if (record.publishedAt !== null) {
    assertDateLike(record.publishedAt, `${label}.publishedAt`);
  }
  if (record.lastError !== null) {
    assertString(record.lastError, `${label}.lastError`);
  }
  asArray(record.errorHistory, `${label}.errorHistory`);
  assertDateLike(record.createdAt, `${label}.createdAt`);
  assertDateLike(record.updatedAt, `${label}.updatedAt`);
}

function assertQueueJobRecord(value: unknown, label: string): void {
  const record = asStrictRecord(value, label, [
    "jobId",
    "projectId",
    "localeBranchId",
    "sourceEventId",
    "triggerOutboxEventId",
    "jobType",
    "jobName",
    "queueName",
    "status",
    "idempotencyPolicy",
    "idempotencyKey",
    "correlationId",
    "causationId",
    "subjectRefs",
    "dependsOnJobIds",
    "payload",
    "priority",
    "availableAt",
    "attemptCount",
    "maxAttempts",
    "lockedBy",
    "lockedAt",
    "leaseExpiresAt",
    "completedAt",
    "lastError",
    "errorHistory",
    "result",
    "createdAt",
    "updatedAt",
  ]);
  assertString(record.jobId, `${label}.jobId`);
  assertString(record.projectId, `${label}.projectId`);
  if (record.localeBranchId !== null) {
    assertString(record.localeBranchId, `${label}.localeBranchId`);
  }
  if (record.sourceEventId !== null) {
    assertString(record.sourceEventId, `${label}.sourceEventId`);
  }
  if (record.triggerOutboxEventId !== null) {
    assertString(record.triggerOutboxEventId, `${label}.triggerOutboxEventId`);
  }
  assertString(record.jobType, `${label}.jobType`);
  assertString(record.jobName, `${label}.jobName`);
  assertString(record.queueName, `${label}.queueName`);
  assertString(record.status, `${label}.status`);
  assertString(record.idempotencyPolicy, `${label}.idempotencyPolicy`);
  if (record.idempotencyKey !== null) {
    assertString(record.idempotencyKey, `${label}.idempotencyKey`);
  }
  assertString(record.correlationId, `${label}.correlationId`);
  if (record.causationId !== null) {
    assertString(record.causationId, `${label}.causationId`);
  }
  asArray(record.subjectRefs, `${label}.subjectRefs`);
  asArray(record.dependsOnJobIds, `${label}.dependsOnJobIds`);
  asRecord(record.payload, `${label}.payload`);
  assertNonNegativeInteger(record.priority, `${label}.priority`);
  assertDateLike(record.availableAt, `${label}.availableAt`);
  assertNonNegativeInteger(record.attemptCount, `${label}.attemptCount`);
  assertPositiveInteger(record.maxAttempts, `${label}.maxAttempts`);
  if (record.lockedBy !== null) {
    assertString(record.lockedBy, `${label}.lockedBy`);
  }
  if (record.lockedAt !== null) {
    assertDateLike(record.lockedAt, `${label}.lockedAt`);
  }
  if (record.leaseExpiresAt !== null) {
    assertDateLike(record.leaseExpiresAt, `${label}.leaseExpiresAt`);
  }
  if (record.completedAt !== null) {
    assertDateLike(record.completedAt, `${label}.completedAt`);
  }
  if (record.lastError !== null) {
    assertString(record.lastError, `${label}.lastError`);
  }
  asArray(record.errorHistory, `${label}.errorHistory`);
  if (record.result !== null) {
    asRecord(record.result, `${label}.result`);
  }
  assertDateLike(record.createdAt, `${label}.createdAt`);
  assertDateLike(record.updatedAt, `${label}.updatedAt`);
}

function assertBenchmarkReportSummary(
  value: unknown,
  label: string,
): asserts value is BenchmarkReportSummary {
  const report = asRecord(value, label);
  assertString(report.benchmarkRunId, `${label}.benchmarkRunId`);
  assertString(report.projectId, `${label}.projectId`);
  assertNullableString(report.localeBranchId, `${label}.localeBranchId`);
  assertString(report.benchmarkName, `${label}.benchmarkName`);
  assertString(report.status, `${label}.status`);
  assertString(report.createdAt, `${label}.createdAt`);
  assertString(report.sourceLocale, `${label}.sourceLocale`);
  assertString(report.targetLocale, `${label}.targetLocale`);
  assertNonNegativeInteger(report.systemCount, `${label}.systemCount`);
  assertNonNegativeInteger(report.findingCount, `${label}.findingCount`);
  assertNonNegativeNumber(report.penaltyTotal, `${label}.penaltyTotal`);
  const qaAgents = asArray(report.qaAgents, `${label}.qaAgents`);
  for (const [index, agent] of qaAgents.entries()) {
    assertBenchmarkQaAgentSummary(agent, `${label}.qaAgents[${index}]`);
  }
}

function assertBenchmarkQaAgentSummary(
  value: unknown,
  label: string,
): asserts value is BenchmarkQaAgentSummary {
  const agent = asRecord(value, label);
  assertString(agent.qaAgentId, `${label}.qaAgentId`);
  assertString(agent.qaAgentVersion, `${label}.qaAgentVersion`);
  assertString(agent.evaluatedSystemId, `${label}.evaluatedSystemId`);
  assertNonNegativeInteger(agent.truePositives, `${label}.truePositives`);
  assertNonNegativeInteger(agent.falsePositives, `${label}.falsePositives`);
  assertNonNegativeInteger(agent.falseNegatives, `${label}.falseNegatives`);
  assertNonNegativeNumber(agent.seededPrecision, `${label}.seededPrecision`);
  assertNonNegativeNumber(agent.seededRecall, `${label}.seededRecall`);
  assertNonNegativeNumber(agent.f1, `${label}.f1`);
  assertNonNegativeInteger(agent.findingsEmitted, `${label}.findingsEmitted`);
  assertNonNegativeInteger(agent.scorableFindings, `${label}.scorableFindings`);
}

export function assertProjectCostReport(
  value: unknown,
  label = "ProjectCostReport",
): asserts value is ProjectCostReport {
  const report = asRecord(value, label);
  assertString(report.projectId, `${label}.projectId`);
  assertEnum(report.currency, ["USD"] as const, `${label}.currency`);
  assertNonNegativeInteger(report.runCount, `${label}.runCount`);
  assertNonNegativeInteger(report.billedMicrosUsd, `${label}.billedMicrosUsd`);
  assertNonNegativeInteger(report.zeroRunCount, `${label}.zeroRunCount`);
  const totals = asArray(report.totalsByCostKind, `${label}.totalsByCostKind`);
  for (const [index, totalValue] of totals.entries()) {
    const total = asRecord(totalValue, `${label}.totalsByCostKind[${index}]`);
    assertEnum(
      total.costKind,
      ["billed", "provider_estimate", "zero"] as const,
      `${label}.totalsByCostKind[${index}].costKind`,
    );
    assertNonNegativeInteger(total.runCount, `${label}.totalsByCostKind[${index}].runCount`);
    assertNonNegativeInteger(
      total.amountMicrosUsd,
      `${label}.totalsByCostKind[${index}].amountMicrosUsd`,
    );
    assertNonNegativeInteger(
      total.promptTokens,
      `${label}.totalsByCostKind[${index}].promptTokens`,
    );
    assertNonNegativeInteger(
      total.completionTokens,
      `${label}.totalsByCostKind[${index}].completionTokens`,
    );
    assertNonNegativeInteger(total.totalTokens, `${label}.totalsByCostKind[${index}].totalTokens`);
  }
  const recentRuns = asArray(report.recentRuns, `${label}.recentRuns`);
  for (const [index, runValue] of recentRuns.entries()) {
    const run = asRecord(runValue, `${label}.recentRuns[${index}]`);
    assertString(run.providerRunId, `${label}.recentRuns[${index}].providerRunId`);
    assertString(run.taskKind, `${label}.recentRuns[${index}].taskKind`);
    assertString(run.status, `${label}.recentRuns[${index}].status`);
    assertString(run.startedAt, `${label}.recentRuns[${index}].startedAt`);
    assertString(run.structuredOutputMode, `${label}.recentRuns[${index}].structuredOutputMode`);
    assertNonNegativeInteger(run.retryCount, `${label}.recentRuns[${index}].retryCount`);
    const errorClasses = asArray(run.errorClasses, `${label}.recentRuns[${index}].errorClasses`);
    for (const [errorIndex, errorClass] of errorClasses.entries()) {
      assertString(errorClass, `${label}.recentRuns[${index}].errorClasses[${errorIndex}]`);
    }
    assertString(run.providerFamily, `${label}.recentRuns[${index}].providerFamily`);
    assertString(run.endpointFamily, `${label}.recentRuns[${index}].endpointFamily`);
    assertString(run.providerName, `${label}.recentRuns[${index}].providerName`);
    assertString(run.requestedModelId, `${label}.recentRuns[${index}].requestedModelId`);
    assertString(run.actualModelId, `${label}.recentRuns[${index}].actualModelId`);
    assertNullableString(run.upstreamProvider, `${label}.recentRuns[${index}].upstreamProvider`);
    assertNullableString(run.routeSettingsHash, `${label}.recentRuns[${index}].routeSettingsHash`);
    assertString(run.promptPresetId, `${label}.recentRuns[${index}].promptPresetId`);
    assertString(run.promptTemplateVersion, `${label}.recentRuns[${index}].promptTemplateVersion`);
    assertString(run.promptHash, `${label}.recentRuns[${index}].promptHash`);
    assertBoolean(run.fallbackUsed, `${label}.recentRuns[${index}].fallbackUsed`);
    const fallbackPlan = asArray(run.fallbackPlan, `${label}.recentRuns[${index}].fallbackPlan`);
    for (const [fallbackIndex, fallbackModel] of fallbackPlan.entries()) {
      assertString(fallbackModel, `${label}.recentRuns[${index}].fallbackPlan[${fallbackIndex}]`);
    }
    assertEnum(
      run.costKind,
      ["billed", "provider_estimate", "zero"] as const,
      `${label}.recentRuns[${index}].costKind`,
    );
    if (run.amountMicrosUsd !== null) {
      assertNonNegativeInteger(
        run.amountMicrosUsd,
        `${label}.recentRuns[${index}].amountMicrosUsd`,
      );
    }
    assertEnum(
      run.tokenCountSource,
      BENCHMARK_TOKEN_COUNT_SOURCES,
      `${label}.recentRuns[${index}].tokenCountSource`,
    );
    const tokenTotalLabel = `${label}.recentRuns[${index}].totalTokens`;
    for (const tokenField of [
      "promptTokens",
      "completionTokens",
      "reasoningTokens",
      "cachedInputTokens",
    ] as const) {
      if (run[tokenField] !== null) {
        assertNonNegativeInteger(run[tokenField], `${label}.recentRuns[${index}].${tokenField}`);
      }
    }
    if (run.totalTokens !== null) {
      assertNonNegativeInteger(run.totalTokens, tokenTotalLabel);
    }
    if (run.tokenCountSource === "unknown" && run.totalTokens !== null) {
      throw new Error(
        `${label}.recentRuns[${index}] unknown token source must not include totalTokens`,
      );
    }
    const tokenSubtotal =
      (run.promptTokens === null ? 0 : Number(run.promptTokens)) +
      (run.completionTokens === null ? 0 : Number(run.completionTokens)) +
      (run.reasoningTokens === null ? 0 : Number(run.reasoningTokens));
    if (run.totalTokens !== null && run.totalTokens < tokenSubtotal) {
      throw new Error(
        `${tokenTotalLabel} must cover promptTokens, completionTokens, and reasoningTokens`,
      );
    }
    // ITOTORI-230 — every run row carries the captured OR routing
    // posture (the `provider: { order, allow_fallbacks, data_collection,
    // zdr, require_parameters }` block that hit the wire) on
    // `routing_posture`. Pre-migration rows carry the sentinel
    // `{_pre_itotori_230: true}`. We validate the field is present and
    // an object; the typed shape is enforced at the application layer
    // (OpenRouterRoutingPosture).
    asRecord(run.routingPosture, `${label}.recentRuns[${index}].routingPosture`);
  }
  const reuse = asRecord(report.translationMemoryReuse, `${label}.translationMemoryReuse`);
  assertNonNegativeInteger(
    reuse.reuseEventCount,
    `${label}.translationMemoryReuse.reuseEventCount`,
  );
  assertNonNegativeInteger(reuse.appliedCount, `${label}.translationMemoryReuse.appliedCount`);
  assertNonNegativeInteger(reuse.suggestedCount, `${label}.translationMemoryReuse.suggestedCount`);
  assertNonNegativeInteger(
    reuse.providerCallAvoidedCount,
    `${label}.translationMemoryReuse.providerCallAvoidedCount`,
  );
  assertNonNegativeInteger(
    reuse.estimatedPromptTokensSaved,
    `${label}.translationMemoryReuse.estimatedPromptTokensSaved`,
  );
  assertNonNegativeInteger(
    reuse.estimatedCompletionTokensSaved,
    `${label}.translationMemoryReuse.estimatedCompletionTokensSaved`,
  );
  assertNonNegativeInteger(
    reuse.estimatedTotalTokensSaved,
    `${label}.translationMemoryReuse.estimatedTotalTokensSaved`,
  );
  if (reuse.estimatedCostUsdSaved !== null) {
    assertNonNegativeNumber(
      reuse.estimatedCostUsdSaved,
      `${label}.translationMemoryReuse.estimatedCostUsdSaved`,
    );
  }
  const recentEvents = asArray(reuse.recentEvents, `${label}.translationMemoryReuse.recentEvents`);
  for (const [index, eventValue] of recentEvents.entries()) {
    const event = asRecord(eventValue, `${label}.translationMemoryReuse.recentEvents[${index}]`);
    assertString(
      event.reuseEventId,
      `${label}.translationMemoryReuse.recentEvents[${index}].reuseEventId`,
    );
    assertString(
      event.localeBranchId,
      `${label}.translationMemoryReuse.recentEvents[${index}].localeBranchId`,
    );
    assertString(
      event.targetBridgeUnitId,
      `${label}.translationMemoryReuse.recentEvents[${index}].targetBridgeUnitId`,
    );
    assertString(
      event.memorySegmentId,
      `${label}.translationMemoryReuse.recentEvents[${index}].memorySegmentId`,
    );
    assertString(
      event.matchKind,
      `${label}.translationMemoryReuse.recentEvents[${index}].matchKind`,
    );
    assertNonNegativeInteger(
      event.matchScore,
      `${label}.translationMemoryReuse.recentEvents[${index}].matchScore`,
    );
    assertString(
      event.reuseStatus,
      `${label}.translationMemoryReuse.recentEvents[${index}].reuseStatus`,
    );
    assertString(
      event.sourceHash,
      `${label}.translationMemoryReuse.recentEvents[${index}].sourceHash`,
    );
    assertString(
      event.candidateSourceHash,
      `${label}.translationMemoryReuse.recentEvents[${index}].candidateSourceHash`,
    );
    assertString(
      event.targetText,
      `${label}.translationMemoryReuse.recentEvents[${index}].targetText`,
    );
    assertBoolean(
      event.providerCallAvoided,
      `${label}.translationMemoryReuse.recentEvents[${index}].providerCallAvoided`,
    );
    assertNonNegativeInteger(
      event.estimatedPromptTokensSaved,
      `${label}.translationMemoryReuse.recentEvents[${index}].estimatedPromptTokensSaved`,
    );
    assertNonNegativeInteger(
      event.estimatedCompletionTokensSaved,
      `${label}.translationMemoryReuse.recentEvents[${index}].estimatedCompletionTokensSaved`,
    );
    assertNonNegativeInteger(
      event.estimatedTotalTokensSaved,
      `${label}.translationMemoryReuse.recentEvents[${index}].estimatedTotalTokensSaved`,
    );
    if (event.estimatedCostUsdSaved !== null) {
      assertNonNegativeNumber(
        event.estimatedCostUsdSaved,
        `${label}.translationMemoryReuse.recentEvents[${index}].estimatedCostUsdSaved`,
      );
    }
    assertString(
      event.calculation,
      `${label}.translationMemoryReuse.recentEvents[${index}].calculation`,
    );
    asRecord(event.provenance, `${label}.translationMemoryReuse.recentEvents[${index}].provenance`);
    assertString(
      event.createdAt,
      `${label}.translationMemoryReuse.recentEvents[${index}].createdAt`,
    );
  }
}

export function assertProjectCostDrilldownResponse(
  value: unknown,
  label = "ApiProjectCostDrilldownResponse",
): asserts value is ApiProjectCostDrilldownResponse {
  const page = asStrictRecord(value, label, ITOTORI_STRICT_API_BODY_KEYS.CostDrilldownPage);

  const filter = asStrictRecord(page.filter, `${label}.filter`, [
    "projectId",
    "systemId",
    "from",
    "to",
  ]);
  assertString(filter.projectId, `${label}.filter.projectId`);
  assertNullableString(filter.systemId, `${label}.filter.systemId`);
  assertNullableString(filter.from, `${label}.filter.from`);
  assertNullableString(filter.to, `${label}.filter.to`);

  const pagination = asStrictRecord(page.pagination, `${label}.pagination`, [
    "total",
    "limit",
    "offset",
    "page",
    "pageCount",
    "hasMore",
    "nextOffset",
  ]);
  assertNonNegativeInteger(pagination.total, `${label}.pagination.total`);
  assertPositiveInteger(pagination.limit, `${label}.pagination.limit`);
  assertNonNegativeInteger(pagination.offset, `${label}.pagination.offset`);
  assertPositiveInteger(pagination.page, `${label}.pagination.page`);
  assertNonNegativeInteger(pagination.pageCount, `${label}.pagination.pageCount`);
  assertBoolean(pagination.hasMore, `${label}.pagination.hasMore`);
  if (pagination.nextOffset !== null) {
    assertNonNegativeInteger(pagination.nextOffset, `${label}.pagination.nextOffset`);
  }
  // Determinism/consistency invariant: hasMore and nextOffset must agree.
  if (pagination.hasMore === (pagination.nextOffset === null)) {
    throw new Error(`${label}.pagination.hasMore must agree with nextOffset`);
  }

  const rows = asArray(page.rows, `${label}.rows`);
  if (rows.length > Number(pagination.limit)) {
    throw new Error(`${label}.rows must not exceed pagination.limit`);
  }
  for (const [index, rowValue] of rows.entries()) {
    const row = asStrictRecord(rowValue, `${label}.rows[${index}]`, [
      "providerRunId",
      "projectId",
      "systemId",
      "taskKind",
      "status",
      "startedAt",
      "cost",
      "provider",
    ]);
    assertString(row.providerRunId, `${label}.rows[${index}].providerRunId`);
    assertString(row.projectId, `${label}.rows[${index}].projectId`);
    assertNullableString(row.systemId, `${label}.rows[${index}].systemId`);
    assertString(row.taskKind, `${label}.rows[${index}].taskKind`);
    assertString(row.status, `${label}.rows[${index}].status`);
    assertString(row.startedAt, `${label}.rows[${index}].startedAt`);
    assertCostDrilldownRowCost(row.cost, `${label}.rows[${index}].cost`);
    assertCostDrilldownProviderMetadata(row.provider, `${label}.rows[${index}].provider`);
  }
}

function assertCostDrilldownRowCost(value: unknown, label: string): void {
  // ITOTORI-053 — zero and unknown are DISTINCT states, never collapsed. The
  // `state` discriminator carries the distinction (there is intentionally no
  // `costKind: "unknown"` — that is the deleted, audit-forbidden ledger enum).
  const record = asRecord(value, label);
  assertEnum(record.state, ["billed", "zero", "unknown"] as const, `${label}.state`);
  if (record.state === "unknown") {
    // An unrecorded cost carries NO amount fields — it must not masquerade as
    // a $0.00 billed record.
    for (const key of Object.keys(record)) {
      if (key !== "state") {
        throw new Error(`${label}.${key} is not permitted on an unknown-cost row`);
      }
    }
    return;
  }
  asStrictRecord(record, label, ["state", "amountMicrosUsd", "displayAmountUsd"]);
  assertNonNegativeInteger(record.amountMicrosUsd, `${label}.amountMicrosUsd`);
  assertString(record.displayAmountUsd, `${label}.displayAmountUsd`);
  if (
    record.state === "zero" &&
    (record.amountMicrosUsd !== 0 || record.displayAmountUsd !== "0")
  ) {
    throw new Error(`${label} zero-cost row must carry amountMicrosUsd 0 and displayAmountUsd "0"`);
  }
}

function assertCostDrilldownProviderMetadata(value: unknown, label: string): void {
  const provider = asStrictRecord(value, label, [
    "providerId",
    "providerFamily",
    "endpointFamily",
    "providerName",
    "requestedModelId",
    "actualModelId",
    "upstreamProvider",
    "routeSettingsHash",
    "adapterMetadata",
  ]);
  assertString(provider.providerId, `${label}.providerId`);
  assertString(provider.providerFamily, `${label}.providerFamily`);
  assertString(provider.endpointFamily, `${label}.endpointFamily`);
  assertString(provider.providerName, `${label}.providerName`);
  assertString(provider.requestedModelId, `${label}.requestedModelId`);
  assertString(provider.actualModelId, `${label}.actualModelId`);
  assertNullableString(provider.upstreamProvider, `${label}.upstreamProvider`);
  assertNullableString(provider.routeSettingsHash, `${label}.routeSettingsHash`);
  // Curated adapter metadata (jsonb object). Only allowlisted keys surface
  // (sanitizeAdapterMetadata is default-deny); the API schema only asserts
  // the surviving value is an object.
  asRecord(provider.adapterMetadata, `${label}.adapterMetadata`);
}

export function assertJobsRunTableReadModel(
  value: unknown,
  label = "JobsRunTableReadModel",
): asserts value is ApiJobsRunTableResponse {
  const model = asStrictRecord(value, label, ITOTORI_STRICT_API_BODY_KEYS.JobsRunTableReadModel);
  assertLiteral(model.schemaVersion, "jobs.run_table.v0.1", `${label}.schemaVersion`);
  assertDateLike(model.generatedAt, `${label}.generatedAt`);
  const filter = asStrictRecord(model.filter, `${label}.filter`, ["projectId"]);
  assertNullableString(filter.projectId, `${label}.filter.projectId`);
  assertProjectOverviewPagination(model.pagination, `${label}.pagination`);
  const rows = asArray(model.rows, `${label}.rows`);
  if (rows.length > Number((model.pagination as { limit: unknown }).limit)) {
    throw new Error(`${label}.rows must not exceed pagination.limit`);
  }
  for (const [index, row] of rows.entries()) {
    assertJobsRunTableRow(row, `${label}.rows[${index}]`);
  }
}

function assertJobsRunTableRow(value: unknown, label: string): void {
  const row = asStrictRecord(value, label, [
    "runId",
    "ledgerEntryId",
    "draftJobId",
    "draftJobAttemptId",
    "providerRunId",
    "jobId",
    "projectId",
    "localeBranchId",
    "task",
    "status",
    "servedModel",
    "servedProvider",
    "zdr",
    "cost",
    "tokens",
    "fallback",
    "createdAt",
  ]);
  assertString(row.runId, `${label}.runId`);
  assertString(row.ledgerEntryId, `${label}.ledgerEntryId`);
  assertString(row.draftJobId, `${label}.draftJobId`);
  assertString(row.draftJobAttemptId, `${label}.draftJobAttemptId`);
  assertNullableString(row.providerRunId, `${label}.providerRunId`);
  assertNullableString(row.jobId, `${label}.jobId`);
  assertString(row.projectId, `${label}.projectId`);
  assertString(row.localeBranchId, `${label}.localeBranchId`);
  assertString(row.task, `${label}.task`);
  assertString(row.status, `${label}.status`);
  assertNullableString(row.servedModel, `${label}.servedModel`);
  assertString(row.servedProvider, `${label}.servedProvider`);
  if (row.zdr !== null) {
    assertBoolean(row.zdr, `${label}.zdr`);
  }
  assertJobsRunTableCost(row.cost, `${label}.cost`);
  assertJobsRunTableTokens(row.tokens, `${label}.tokens`);
  assertJobsRunTableFallback(row.fallback, `${label}.fallback`);
  assertDateLike(row.createdAt, `${label}.createdAt`);
}

function assertJobsRunTableCost(value: unknown, label: string): void {
  const cost = asStrictRecord(value, label, ["unit", "amount"]);
  assertString(cost.unit, `${label}.unit`);
  assertString(cost.amount, `${label}.amount`);
}

function assertJobsRunTableTokens(value: unknown, label: string): void {
  const tokens = asStrictRecord(value, label, ["in", "out", "total"]);
  if (tokens.in !== null) {
    assertNonNegativeInteger(tokens.in, `${label}.in`);
  }
  if (tokens.out !== null) {
    assertNonNegativeInteger(tokens.out, `${label}.out`);
  }
  if (tokens.total !== null) {
    assertNonNegativeInteger(tokens.total, `${label}.total`);
  }
}

function assertJobsRunTableFallback(value: unknown, label: string): void {
  const fallback = asStrictRecord(value, label, ["used", "plan", "chain"]);
  assertBoolean(fallback.used, `${label}.used`);
  for (const [index, entry] of asArray(fallback.plan, `${label}.plan`).entries()) {
    assertString(entry, `${label}.plan[${index}]`);
  }
  for (const [index, entryValue] of asArray(fallback.chain, `${label}.chain`).entries()) {
    const entry = asStrictRecord(entryValue, `${label}.chain[${index}]`, [
      "modelProviderFamily",
      "modelId",
      "failureReason",
      "attemptedAt",
    ]);
    assertString(entry.modelProviderFamily, `${label}.chain[${index}].modelProviderFamily`);
    assertString(entry.modelId, `${label}.chain[${index}].modelId`);
    assertString(entry.failureReason, `${label}.chain[${index}].failureReason`);
    assertDateLike(entry.attemptedAt, `${label}.chain[${index}].attemptedAt`);
  }
}

export function assertProjectOverviewReadModel(
  value: unknown,
  label = "ProjectOverviewReadModel",
): asserts value is ProjectOverviewReadModel {
  const model = asStrictRecord(value, label, ITOTORI_STRICT_API_BODY_KEYS.ProjectOverviewReadModel);
  assertLiteral(model.schemaVersion, PROJECT_OVERVIEW_SCHEMA_VERSION, `${label}.schemaVersion`);
  assertDateLike(model.generatedAt, `${label}.generatedAt`);
  assertString(model.projectId, `${label}.projectId`);
  assertProjectDashboardStatus(model.progress, `${label}.progress`);
  assertDashboardDecisionReadModel(model.decisions, `${label}.decisions`);
  assertProjectCostReport(model.cost, `${label}.cost`);
  assertProjectCostDrilldownResponse(model.costDrilldown, `${label}.costDrilldown`);
  assertProjectOverviewPassLedgerPage(model.passLedger, `${label}.passLedger`);
  assertProjectOverviewBenchmarkHeadline(model.benchmarkHeadline, `${label}.benchmarkHeadline`);
  // ovw-launch-pass-action — the server-derived steer capability the Overview
  // launch-pass action gates itself on.
  assertBoolean(model.canSteer, `${label}.canSteer`);
}

function assertProjectOverviewPassLedgerPage(
  value: unknown,
  label: string,
): asserts value is ProjectOverviewPassLedgerPage {
  const page = asStrictRecord(value, label, ["filter", "pagination", "rows"]);
  const filter = asStrictRecord(page.filter, `${label}.filter`, ["projectId", "localeBranchId"]);
  assertString(filter.projectId, `${label}.filter.projectId`);
  assertNullableString(filter.localeBranchId, `${label}.filter.localeBranchId`);
  assertProjectOverviewPagination(page.pagination, `${label}.pagination`);
  const rows = asArray(page.rows, `${label}.rows`);
  if (rows.length > Number((page.pagination as { limit: unknown }).limit)) {
    throw new Error(`${label}.rows must not exceed pagination.limit`);
  }
  for (const [index, row] of rows.entries()) {
    assertProjectOverviewPassLedgerRow(row, `${label}.rows[${index}]`);
  }
}

function assertProjectOverviewPagination(value: unknown, label: string): void {
  const pagination = asStrictRecord(value, label, [
    "total",
    "limit",
    "offset",
    "page",
    "pageCount",
    "hasMore",
    "nextOffset",
  ]);
  assertNonNegativeInteger(pagination.total, `${label}.total`);
  assertPositiveInteger(pagination.limit, `${label}.limit`);
  assertNonNegativeInteger(pagination.offset, `${label}.offset`);
  assertPositiveInteger(pagination.page, `${label}.page`);
  assertNonNegativeInteger(pagination.pageCount, `${label}.pageCount`);
  assertBoolean(pagination.hasMore, `${label}.hasMore`);
  if (pagination.nextOffset !== null) {
    assertNonNegativeInteger(pagination.nextOffset, `${label}.nextOffset`);
  }
  if (pagination.hasMore === (pagination.nextOffset === null)) {
    throw new Error(`${label}.hasMore must agree with nextOffset`);
  }
}

function assertProjectOverviewPassLedgerRow(
  value: unknown,
  label: string,
): asserts value is ProjectOverviewPassLedgerRow {
  const row = asStrictRecord(value, label, [
    "passLedgerId",
    "projectId",
    "localeBranchId",
    "sourceRevisionId",
    "passNumber",
    "priorPassNumber",
    "totalUsageCostUsd",
    "zdrConfirmed",
    "recordedAt",
    "score",
    "feedback",
    "note",
  ]);
  assertString(row.passLedgerId, `${label}.passLedgerId`);
  assertString(row.projectId, `${label}.projectId`);
  assertString(row.localeBranchId, `${label}.localeBranchId`);
  assertString(row.sourceRevisionId, `${label}.sourceRevisionId`);
  assertPositiveInteger(row.passNumber, `${label}.passNumber`);
  if (row.priorPassNumber !== null) {
    assertPositiveInteger(row.priorPassNumber, `${label}.priorPassNumber`);
  }
  assertNonNegativeNumber(row.totalUsageCostUsd, `${label}.totalUsageCostUsd`);
  assertBoolean(row.zdrConfirmed, `${label}.zdrConfirmed`);
  assertDateLike(row.recordedAt, `${label}.recordedAt`);
  if (row.score !== null) {
    assertNonNegativeNumber(row.score, `${label}.score`);
  }
  assertNonNegativeInteger(row.feedback, `${label}.feedback`);
  if (typeof row.note !== "string") {
    throw new Error(`${label}.note must be a string`);
  }
}

function assertProjectOverviewBenchmarkHeadline(
  value: unknown,
  label: string,
): asserts value is ProjectOverviewBenchmarkHeadline {
  const headline = asStrictRecord(value, label, ["reportCount", "latestReport"]);
  assertNonNegativeInteger(headline.reportCount, `${label}.reportCount`);
  if (headline.latestReport !== null) {
    assertBenchmarkReportSummary(headline.latestReport, `${label}.latestReport`);
  }
}

export function assertDashboardDecisionReadModel(
  value: unknown,
  label = "DashboardDecisionReadModel",
): asserts value is DashboardDecisionReadModel {
  const model = asRecord(value, label);
  assertString(model.projectId, `${label}.projectId`);
  const counts = asRecord(model.counts, `${label}.counts`);
  assertNonNegativeInteger(counts.pendingDecisionCount, `${label}.counts.pendingDecisionCount`);
  assertNonNegativeInteger(
    counts.projectFindingDecisionCount,
    `${label}.counts.projectFindingDecisionCount`,
  );
  assertNonNegativeInteger(
    counts.localeBranchFindingDecisionCount,
    `${label}.counts.localeBranchFindingDecisionCount`,
  );
  assertNonNegativeInteger(
    counts.runtimeValidationDecisionCount,
    `${label}.counts.runtimeValidationDecisionCount`,
  );
  const pendingDecisions = asArray(model.pendingDecisions, `${label}.pendingDecisions`);
  for (const [index, decisionValue] of pendingDecisions.entries()) {
    const decision = asRecord(decisionValue, `${label}.pendingDecisions[${index}]`);
    assertString(decision.decisionId, `${label}.pendingDecisions[${index}].decisionId`);
    assertEnum(
      decision.decisionKind,
      ["project_finding", "locale_branch_finding", "runtime_validation"] as const,
      `${label}.pendingDecisions[${index}].decisionKind`,
    );
    assertString(decision.projectId, `${label}.pendingDecisions[${index}].projectId`);
    assertString(decision.findingId, `${label}.pendingDecisions[${index}].findingId`);
    assertString(decision.findingKind, `${label}.pendingDecisions[${index}].findingKind`);
    assertString(decision.severity, `${label}.pendingDecisions[${index}].severity`);
    assertNullableString(
      decision.qualityCategory,
      `${label}.pendingDecisions[${index}].qualityCategory`,
    );
    assertString(decision.title, `${label}.pendingDecisions[${index}].title`);
    assertNullableString(
      decision.localeBranchId,
      `${label}.pendingDecisions[${index}].localeBranchId`,
    );
    assertNullableString(decision.targetLocale, `${label}.pendingDecisions[${index}].targetLocale`);
    assertNullableString(decision.branchStatus, `${label}.pendingDecisions[${index}].branchStatus`);
    assertNullableString(decision.runtimeRunId, `${label}.pendingDecisions[${index}].runtimeRunId`);
    assertNullableString(
      decision.runtimeStatus,
      `${label}.pendingDecisions[${index}].runtimeStatus`,
    );
    assertString(decision.createdAt, `${label}.pendingDecisions[${index}].createdAt`);
    // ITOTORI-114 — KIND-SPECIFIC nullable-field invariants (fail-closed).
    // A read-model row whose fields contradict its decisionKind is a
    // corrupt/mislabelled record; reject it rather than surface (and
    // mis-count) an internally-inconsistent decision on the dashboard.
    const decisionLabel = `${label}.pendingDecisions[${index}]`;
    switch (decision.decisionKind) {
      case "project_finding":
        // A project-level finding is neither branch- nor run-scoped:
        // every branch/run field MUST be null.
        assertNull(decision.localeBranchId, `${decisionLabel}.localeBranchId (project_finding)`);
        assertNull(decision.targetLocale, `${decisionLabel}.targetLocale (project_finding)`);
        assertNull(decision.branchStatus, `${decisionLabel}.branchStatus (project_finding)`);
        assertNull(decision.runtimeRunId, `${decisionLabel}.runtimeRunId (project_finding)`);
        assertNull(decision.runtimeStatus, `${decisionLabel}.runtimeStatus (project_finding)`);
        break;
      case "locale_branch_finding":
        // A branch finding is scoped to a locale branch (localeBranchId
        // required) and is NOT a runtime validation (run fields null).
        assertString(
          decision.localeBranchId,
          `${decisionLabel}.localeBranchId (locale_branch_finding)`,
        );
        assertNull(decision.runtimeRunId, `${decisionLabel}.runtimeRunId (locale_branch_finding)`);
        assertNull(
          decision.runtimeStatus,
          `${decisionLabel}.runtimeStatus (locale_branch_finding)`,
        );
        break;
      case "runtime_validation":
        // A runtime validation finding MUST identify its runtime run; it
        // may also carry branch context, but it is counted as a runtime
        // validation (by decisionKind below), never as a branch finding.
        assertString(decision.runtimeRunId, `${decisionLabel}.runtimeRunId (runtime_validation)`);
        break;
    }
  }
  assertDecisionCount(
    counts.pendingDecisionCount,
    pendingDecisions.length,
    `${label}.counts.pendingDecisionCount`,
  );
  assertDecisionCount(
    counts.projectFindingDecisionCount,
    pendingDecisions.filter((decision) => {
      const record = asRecord(decision, `${label}.pendingDecisions[]`);
      return record.decisionKind === "project_finding";
    }).length,
    `${label}.counts.projectFindingDecisionCount`,
  );
  assertDecisionCount(
    counts.localeBranchFindingDecisionCount,
    pendingDecisions.filter((decision) => {
      const record = asRecord(decision, `${label}.pendingDecisions[]`);
      return record.decisionKind === "locale_branch_finding";
    }).length,
    `${label}.counts.localeBranchFindingDecisionCount`,
  );
  assertDecisionCount(
    counts.runtimeValidationDecisionCount,
    pendingDecisions.filter((decision) => {
      const record = asRecord(decision, `${label}.pendingDecisions[]`);
      return record.decisionKind === "runtime_validation";
    }).length,
    `${label}.counts.runtimeValidationDecisionCount`,
  );
}

export function assertRuntimeDashboardStatus(
  value: unknown,
  label = "RuntimeDashboardStatus",
): asserts value is RuntimeDashboardStatus {
  const status = asRecord(value, label);
  assertString(status.finalStatus, `${label}.finalStatus`);
  assertNullableString(status.runtimeRunId, `${label}.runtimeRunId`);
  assertNullableString(status.runtimeReportId, `${label}.runtimeReportId`);
  assertNullableString(status.runtimeStatus, `${label}.runtimeStatus`);
  assertNullableString(status.fidelityTier, `${label}.fidelityTier`);
  assertNullableString(status.evidenceTier, `${label}.evidenceTier`);
  assertNonNegativeInteger(status.textEventCount, `${label}.textEventCount`);
  assertNonNegativeInteger(status.frameCaptureCount, `${label}.frameCaptureCount`);
  assertNonNegativeInteger(status.screenshotArtifactCount, `${label}.screenshotArtifactCount`);
  assertNonNegativeInteger(status.recordingArtifactCount, `${label}.recordingArtifactCount`);
  assertNonNegativeInteger(status.validationFindingCount, `${label}.validationFindingCount`);
  assertRuntimeDashboardTraceEvents(status.traceEvents, `${label}.traceEvents`);
  assertRuntimeDashboardFindings(status.findings, `${label}.findings`);
  assertRuntimeDashboardArtifacts(status.artifacts, `${label}.artifacts`);
  assertRuntimeDashboardApproximations(status.approximations, `${label}.approximations`);
  assertRuntimeDashboardUnsupportedCapabilities(
    status.unsupportedCapabilities,
    `${label}.unsupportedCapabilities`,
  );
  assertStringArray(status.limitations, `${label}.limitations`);
}

/**
 * gate-runtime-status-reads-and-redact-evidence-previews — the sentinel a
 * redacted runtime status uses in place of a finding's free-text message.
 * A non-empty string keeps the shape valid under
 * `assertRuntimeDashboardStatus` (which rejects empty strings) while
 * carrying no evidence text.
 */
export const REDACTED_RUNTIME_FINDING_MESSAGE = "[redacted]";

/**
 * gate-runtime-status-reads-and-redact-evidence-previews — validates the
 * UNPRIVILEGED (redacted) runtime status shape and REJECTS any
 * leakage-shaped response. On top of the structural
 * `assertRuntimeDashboardStatus` check it requires that every sensitive
 * field is redacted: no `traceEvents[].textPreview` (evidence text from
 * observedText/promptText), no `findings[].message` free text (only the
 * redaction sentinel), and no `artifacts[].uri` / `artifacts[].hash`
 * (managed artifact locators + content hashes). Emitting a response that
 * still carries any of these on the unprivileged path throws here, so a
 * leak-shaped body cannot be returned to an unprivileged caller.
 */
export function assertRedactedRuntimeDashboardStatus(
  value: unknown,
  label = "RedactedRuntimeDashboardStatus",
): asserts value is RuntimeDashboardStatus {
  assertRuntimeDashboardStatus(value, label);
  const status = value as RuntimeDashboardStatus;
  for (const [index, event] of status.traceEvents.entries()) {
    if (event.textPreview !== null) {
      throw new Error(
        `${label}.traceEvents[${index}].textPreview must be redacted (null) but leaked evidence text`,
      );
    }
  }
  for (const [index, finding] of status.findings.entries()) {
    if (finding.message !== REDACTED_RUNTIME_FINDING_MESSAGE) {
      throw new Error(
        `${label}.findings[${index}].message must be redacted to the sentinel but leaked finding free text`,
      );
    }
  }
  for (const [index, artifact] of status.artifacts.entries()) {
    if (artifact.uri !== null) {
      throw new Error(
        `${label}.artifacts[${index}].uri must be redacted (null) but leaked an artifact URI`,
      );
    }
    if (artifact.hash !== null) {
      throw new Error(
        `${label}.artifacts[${index}].hash must be redacted (null) but leaked an artifact hash`,
      );
    }
  }
}

function assertRuntimeDashboardTraceEvents(value: unknown, label: string): void {
  const rows = asArray(value, label);
  for (const [index, rowValue] of rows.entries()) {
    const row = asRecord(rowValue, `${label}[${index}]`);
    assertString(row.runtimeEventId, `${label}[${index}].runtimeEventId`);
    assertString(row.eventKind, `${label}[${index}].eventKind`);
    assertNullableString(row.bridgeUnitId, `${label}[${index}].bridgeUnitId`);
    assertNullableString(row.sourceUnitKey, `${label}[${index}].sourceUnitKey`);
    assertNullableString(row.draftId, `${label}[${index}].draftId`);
    assertNullableString(row.runtimeTargetId, `${label}[${index}].runtimeTargetId`);
    assertNullableString(row.evidenceTier, `${label}[${index}].evidenceTier`);
    assertNullableNonNegativeInteger(row.frame, `${label}[${index}].frame`);
    assertNullableString(row.textPreview, `${label}[${index}].textPreview`);
    assertStringArray(row.artifactIds, `${label}[${index}].artifactIds`);
  }
}

function assertRuntimeDashboardFindings(value: unknown, label: string): void {
  const rows = asArray(value, label);
  for (const [index, rowValue] of rows.entries()) {
    const row = asRecord(rowValue, `${label}[${index}]`);
    assertString(row.findingId, `${label}[${index}].findingId`);
    assertString(row.findingKind, `${label}[${index}].findingKind`);
    assertString(row.severity, `${label}[${index}].severity`);
    assertString(row.message, `${label}[${index}].message`);
    assertString(row.evidenceTier, `${label}[${index}].evidenceTier`);
    assertNullableString(row.bridgeUnitId, `${label}[${index}].bridgeUnitId`);
    assertNullableString(row.sourceUnitKey, `${label}[${index}].sourceUnitKey`);
    assertNullableString(row.artifactId, `${label}[${index}].artifactId`);
  }
}

function assertRuntimeDashboardArtifacts(value: unknown, label: string): void {
  const rows = asArray(value, label);
  for (const [index, rowValue] of rows.entries()) {
    const row = asRecord(rowValue, `${label}[${index}]`);
    assertString(row.artifactId, `${label}[${index}].artifactId`);
    assertString(row.artifactKind, `${label}[${index}].artifactKind`);
    assertNullableString(row.uri, `${label}[${index}].uri`);
    assertNullableString(row.hash, `${label}[${index}].hash`);
    assertNullableString(row.mediaType, `${label}[${index}].mediaType`);
    assertNullableNonNegativeInteger(row.byteSize, `${label}[${index}].byteSize`);
    assertNullableString(row.bridgeUnitId, `${label}[${index}].bridgeUnitId`);
    assertNullableString(row.sourceUnitKey, `${label}[${index}].sourceUnitKey`);
    assertNullableString(row.diagnostic, `${label}[${index}].diagnostic`);
  }
}

function assertRuntimeDashboardApproximations(value: unknown, label: string): void {
  const rows = asArray(value, label);
  for (const [index, rowValue] of rows.entries()) {
    const row = asRecord(rowValue, `${label}[${index}]`);
    assertString(row.approximationId, `${label}[${index}].approximationId`);
    assertString(row.approximationTier, `${label}[${index}].approximationTier`);
    assertString(row.scope, `${label}[${index}].scope`);
    assertString(row.description, `${label}[${index}].description`);
    assertString(row.evidenceTierCeiling, `${label}[${index}].evidenceTierCeiling`);
    assertStringArray(row.bridgeUnitIds, `${label}[${index}].bridgeUnitIds`);
  }
}

function assertRuntimeDashboardUnsupportedCapabilities(value: unknown, label: string): void {
  const rows = asArray(value, label);
  for (const [index, rowValue] of rows.entries()) {
    const row = asRecord(rowValue, `${label}[${index}]`);
    assertString(row.feature, `${label}[${index}].feature`);
    assertString(row.status, `${label}[${index}].status`);
    assertNullableString(row.fidelityTierCeiling, `${label}[${index}].fidelityTierCeiling`);
    assertNullableString(row.evidenceTierCeiling, `${label}[${index}].evidenceTierCeiling`);
    assertStringArray(row.limitations, `${label}[${index}].limitations`);
  }
}

export function assertProjectState(
  value: unknown,
  label = "ProjectState",
): asserts value is ProjectState {
  const project = asRecord(value, label);
  assertString(project.projectId, `${label}.projectId`);
  assertString(project.localeBranchId, `${label}.localeBranchId`);
  assertString(project.targetLocale, `${label}.targetLocale`);
  assertBridgeInput(project.bridge);
  const drafts = asRecord(project.drafts, `${label}.drafts`);
  for (const [draftKey, draftValue] of Object.entries(drafts)) {
    assertString(draftValue, `${label}.drafts.${draftKey}`);
  }
  if (project.importStatus !== undefined) {
    assertBridgeImportStatus(project.importStatus, `${label}.importStatus`);
  }
  if (project.patchExport !== undefined) {
    assertPatchExportInput(project.patchExport, `${label}.patchExport`);
  }
  if (project.runtimeReport !== undefined) {
    assertRuntimeReport(project.runtimeReport);
  }
}

function assertProjectsResponse(value: unknown): asserts value is ApiProjectsResponse {
  const response = asRecord(value, "ApiProjectsResponse");
  const projects = asArray(response.projects, "ApiProjectsResponse.projects");
  for (const [index, project] of projects.entries()) {
    assertProjectDashboardStatus(project, `ApiProjectsResponse.projects[${index}]`);
  }
}

function assertProjectImportResponse(value: unknown): asserts value is ApiProjectImportResponse {
  const response = asRecord(value, "ApiProjectImportResponse");
  assertProjectState(response.project, "ApiProjectImportResponse.project");
  assertProjectDashboardStatus(response.status, "ApiProjectImportResponse.status");
}

function assertDraftBranchResponse(value: unknown): asserts value is ApiDraftBranchResponse {
  const response = asRecord(value, "ApiDraftBranchResponse");
  assertProjectState(response.project, "ApiDraftBranchResponse.project");
  assertProjectDashboardStatus(response.status, "ApiDraftBranchResponse.status");
}

function assertRecordFindingResponse(value: unknown): asserts value is ApiRecordFindingResponse {
  const response = asRecord(value, "ApiRecordFindingResponse");
  assertString(response.findingId, "ApiRecordFindingResponse.findingId");
  assertEnum(
    response.status,
    ["open", "resolved", "superseded"] as const,
    "ApiRecordFindingResponse.status",
  );
}

function assertRecordDecisionResponse(value: unknown): asserts value is ApiRecordDecisionResponse {
  const response = asRecord(value, "ApiRecordDecisionResponse");
  assertString(response.decisionId, "ApiRecordDecisionResponse.decisionId");
  assertEnum(response.eventKind, TRIAGE_EVENT_KINDS, "ApiRecordDecisionResponse.eventKind");
  assertBoolean(response.recorded, "ApiRecordDecisionResponse.recorded");
}

function assertRecordBenchmarkResponse(
  value: unknown,
): asserts value is ApiRecordBenchmarkResponse {
  const response = asRecord(value, "ApiRecordBenchmarkResponse");
  assertString(response.benchmarkRunId, "ApiRecordBenchmarkResponse.benchmarkRunId");
  assertString(response.artifactId, "ApiRecordBenchmarkResponse.artifactId");
  assertEnum(
    response.status,
    ["passed", "failed", "partial"] as const,
    "ApiRecordBenchmarkResponse.status",
  );
  assertNonNegativeInteger(response.systemCount, "ApiRecordBenchmarkResponse.systemCount");
  assertNonNegativeInteger(response.findingCount, "ApiRecordBenchmarkResponse.findingCount");
}

function assertRuntimeEvidenceResponse(
  value: unknown,
): asserts value is ApiRuntimeEvidenceResponse {
  const response = asRecord(value, "ApiRuntimeEvidenceResponse");
  assertEnum(
    response.status,
    ["hello_world_passed", "hello_world_failed"] as const,
    "ApiRuntimeEvidenceResponse.status",
  );
  assertString(response.bridgeId, "ApiRuntimeEvidenceResponse.bridgeId");
  assertString(response.localeBranchId, "ApiRuntimeEvidenceResponse.localeBranchId");
  assertString(response.patchResultId, "ApiRuntimeEvidenceResponse.patchResultId");
  assertString(response.runtimeReportId, "ApiRuntimeEvidenceResponse.runtimeReportId");
  if (response.patchExportId !== undefined) {
    assertString(response.patchExportId, "ApiRuntimeEvidenceResponse.patchExportId");
  }
  assertProjectDashboardStatus(response.dashboard, "ApiRuntimeEvidenceResponse.dashboard");
}

function assertConfigureAuthSsoSettingsResponse(
  value: unknown,
): asserts value is ApiConfigureAuthSsoSettingsResponse {
  const response = asStrictRecord(
    value,
    "ApiConfigureAuthSsoSettingsResponse",
    ITOTORI_STRICT_API_BODY_KEYS.ApiConfigureAuthSsoSettingsResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.auth.sso-settings.v0",
    "ApiConfigureAuthSsoSettingsResponse.schemaVersion",
  );
  assertString(response.accountId, "ApiConfigureAuthSsoSettingsResponse.accountId");
  parseAuthSsoProviderConfig(response.provider, "ApiConfigureAuthSsoSettingsResponse.provider");
  parseAccountSecuritySettings(response.security, "ApiConfigureAuthSsoSettingsResponse.security");
  parseAuthSessionPolicy(
    response.sessionPolicy,
    "ApiConfigureAuthSsoSettingsResponse.sessionPolicy",
  );
  assertDateLike(response.updatedAt, "ApiConfigureAuthSsoSettingsResponse.updatedAt");
}

function assertMemberInvitationResponse(
  value: unknown,
): asserts value is ApiMemberInvitationResponse {
  const response = asStrictRecord(
    value,
    "ApiMemberInvitationResponse",
    ITOTORI_STRICT_API_BODY_KEYS.ApiMemberInvitationResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.auth.member-invitation.v0",
    "ApiMemberInvitationResponse.schemaVersion",
  );
  assertString(response.invitationId, "ApiMemberInvitationResponse.invitationId");
  assertString(response.accountId, "ApiMemberInvitationResponse.accountId");
  assertString(response.email, "ApiMemberInvitationResponse.email");
  assertStringArray(
    response.initialPermissionSetIds,
    "ApiMemberInvitationResponse.initialPermissionSetIds",
  );
  assertDateLike(response.expiresAt, "ApiMemberInvitationResponse.expiresAt");
  assertNullableDateLike(response.acceptedAt, "ApiMemberInvitationResponse.acceptedAt");
  assertNullableDateLike(response.revokedAt, "ApiMemberInvitationResponse.revokedAt");
  assertDateLike(response.createdAt, "ApiMemberInvitationResponse.createdAt");
}

function assertMemberResponse(value: unknown): asserts value is ApiMemberResponse {
  const response = asStrictRecord(
    value,
    "ApiMemberResponse",
    ITOTORI_STRICT_API_BODY_KEYS.ApiMemberResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.auth.member.v0",
    "ApiMemberResponse.schemaVersion",
  );
  assertMemberRecord(response.member, "ApiMemberResponse.member");
}

function assertMembersListResponse(value: unknown): asserts value is ApiMembersListResponse {
  const response = asStrictRecord(
    value,
    "ApiMembersListResponse",
    ITOTORI_STRICT_API_BODY_KEYS.ApiMembersListResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.auth.members.v0",
    "ApiMembersListResponse.schemaVersion",
  );
  assertString(response.accountId, "ApiMembersListResponse.accountId");
  const members = asArray(response.members, "ApiMembersListResponse.members");
  for (const [index, member] of members.entries()) {
    assertMemberRecord(member, `ApiMembersListResponse.members[${index}]`);
  }
}

function assertAuthCapabilitiesResponse(
  value: unknown,
): asserts value is ApiAuthCapabilitiesResponse {
  const response = asStrictRecord(
    value,
    "ApiAuthCapabilitiesResponse",
    ITOTORI_STRICT_API_BODY_KEYS.ApiAuthCapabilitiesResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.auth.capabilities.v0",
    "ApiAuthCapabilitiesResponse.schemaVersion",
  );
  assertString(response.actorUserId, "ApiAuthCapabilitiesResponse.actorUserId");
  assertBoolean(response.canReadQueue, "ApiAuthCapabilitiesResponse.canReadQueue");
  assertBoolean(response.canManageQueue, "ApiAuthCapabilitiesResponse.canManageQueue");
  assertBoolean(response.canFlag, "ApiAuthCapabilitiesResponse.canFlag");
  assertBoolean(response.canDecide, "ApiAuthCapabilitiesResponse.canDecide");
  assertBoolean(response.canSteer, "ApiAuthCapabilitiesResponse.canSteer");
  assertBoolean(response.canReveal, "ApiAuthCapabilitiesResponse.canReveal");
  const denials = asStrictRecord(
    response.denials,
    "ApiAuthCapabilitiesResponse.denials",
    ITOTORI_STRICT_API_BODY_KEYS.ApiStudioCapabilityDenials,
  );
  assertNullableString(denials.flag, "ApiAuthCapabilitiesResponse.denials.flag");
  assertNullableString(denials.decide, "ApiAuthCapabilitiesResponse.denials.decide");
  assertNullableString(denials.steer, "ApiAuthCapabilitiesResponse.denials.steer");
  assertNullableString(denials.reveal, "ApiAuthCapabilitiesResponse.denials.reveal");
  assertNullableString(denials.queueRead, "ApiAuthCapabilitiesResponse.denials.queueRead");
  assertNullableString(denials.queueManage, "ApiAuthCapabilitiesResponse.denials.queueManage");
  const denialReasons = asArray(
    response.denialReasons,
    "ApiAuthCapabilitiesResponse.denialReasons",
  );
  for (const [index, reason] of denialReasons.entries()) {
    assertString(reason, `ApiAuthCapabilitiesResponse.denialReasons[${index}]`);
  }
}

function assertRemoveMemberResponse(value: unknown): asserts value is ApiRemoveMemberResponse {
  const response = asStrictRecord(
    value,
    "ApiRemoveMemberResponse",
    ITOTORI_STRICT_API_BODY_KEYS.ApiRemoveMemberResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.auth.member-removed.v0",
    "ApiRemoveMemberResponse.schemaVersion",
  );
  assertMemberRecord(response.removedMember, "ApiRemoveMemberResponse.removedMember");
}

function assertMemberRecord(value: unknown, label: string): asserts value is ApiMemberRecord {
  const member = asStrictRecord(value, label, ITOTORI_STRICT_API_BODY_KEYS.ApiMemberRecord);
  assertString(member.membershipId, `${label}.membershipId`);
  assertString(member.accountId, `${label}.accountId`);
  assertString(member.userId, `${label}.userId`);
  assertString(member.principalId, `${label}.principalId`);
  assertNullableString(member.email, `${label}.email`);
  assertString(member.displayName, `${label}.displayName`);
  assertStringArray(member.permissionSetIds, `${label}.permissionSetIds`);
  assertDateLike(member.createdAt, `${label}.createdAt`);
}

// ovw-launch-pass-action — assert the launch-pass response envelope. The
// schemaVersion literal pins the wire shape; `outcome` pins to started/refused.
// A `started` outcome MUST carry a positive pass number + a start timestamp and
// no refusal; a `refused` outcome MUST carry a non-empty refusal message and
// null pass/timestamp — so a refused launch can NEVER masquerade as a started
// one (or as a silent 200 with empty fields).
function assertLaunchPassResponse(value: unknown): asserts value is ApiLaunchPassResponse {
  const response = asStrictRecord(
    value,
    "ApiLaunchPassResponse",
    ITOTORI_STRICT_API_BODY_KEYS.ApiLaunchPassResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.projects.launch-pass.v0",
    "ApiLaunchPassResponse.schemaVersion",
  );
  assertEnum(response.outcome, ["started", "refused"] as const, "ApiLaunchPassResponse.outcome");
  if (response.outcome === "started") {
    assertPositiveInteger(response.passNumber, "ApiLaunchPassResponse.passNumber");
    assertString(response.startedAt, "ApiLaunchPassResponse.startedAt");
    assertNull(response.refusalMessage, "ApiLaunchPassResponse.refusalMessage");
    return;
  }
  assertNull(response.passNumber, "ApiLaunchPassResponse.passNumber");
  assertNull(response.startedAt, "ApiLaunchPassResponse.startedAt");
  assertString(response.refusalMessage, "ApiLaunchPassResponse.refusalMessage");
}

/**
 * ovw-launch-pass-action — parse + validate the launch-pass request body. The
 * locale branch is required (the project id lives on the URL path); the server
 * additionally verifies the branch against the project's ownership set before
 * the driver runs.
 */
export function parseLaunchPassRequest(body: unknown): ApiLaunchPassRequest {
  return parseRequest("ApiLaunchPassRequest", () => {
    const request = asRecord(body, "ApiLaunchPassRequest");
    assertString(request.localeBranchId, "ApiLaunchPassRequest.localeBranchId");
    return { localeBranchId: request.localeBranchId };
  });
}

/**
 * play-mark-validated — parse + validate the set-coverage request body. The
 * scene id and coverage state are required; the project / branch live on the
 * URL path and are ownership-verified server-side before the write.
 */
export function parsePlaySetSceneCoverageRequest(body: unknown): ApiPlaySetSceneCoverageRequest {
  return parseRequest("ApiPlaySetSceneCoverageRequest", () => {
    const request = asRecord(body, "ApiPlaySetSceneCoverageRequest");
    assertString(request.sceneId, "ApiPlaySetSceneCoverageRequest.sceneId");
    if (request.sceneId.trim().length === 0) {
      throw new ApiValidationError("ApiPlaySetSceneCoverageRequest.sceneId must be non-empty");
    }
    assertEnum(
      request.coverageState,
      API_SCENE_COVERAGE_STATES,
      "ApiPlaySetSceneCoverageRequest.coverageState",
    );
    return {
      sceneId: request.sceneId.trim(),
      coverageState: request.coverageState,
    };
  });
}

function assertPlaySceneCoverageResponse(
  value: unknown,
): asserts value is ApiPlaySceneCoverageResponse {
  const response = asStrictRecord(
    value,
    "ApiPlaySceneCoverageResponse",
    ITOTORI_STRICT_API_BODY_KEYS.ApiPlaySceneCoverageResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.play.scene-coverage.v0",
    "ApiPlaySceneCoverageResponse.schemaVersion",
  );
  assertString(response.generatedAt, "ApiPlaySceneCoverageResponse.generatedAt");
  assertString(response.projectId, "ApiPlaySceneCoverageResponse.projectId");
  assertString(response.localeBranchId, "ApiPlaySceneCoverageResponse.localeBranchId");
  if (!Array.isArray(response.nodes)) {
    throw new Error("ApiPlaySceneCoverageResponse.nodes must be an array");
  }
  for (const [index, node] of response.nodes.entries()) {
    assertPlaySceneCoverageNode(node, `ApiPlaySceneCoverageResponse.nodes[${index}]`);
  }
  if (!Array.isArray(response.edges)) {
    throw new Error("ApiPlaySceneCoverageResponse.edges must be an array");
  }
  for (const [index, edge] of response.edges.entries()) {
    assertPlaySceneCoverageEdge(edge, `ApiPlaySceneCoverageResponse.edges[${index}]`);
  }
  assertPlaySceneCoverageCounts(response.counts, "ApiPlaySceneCoverageResponse.counts");
}

function assertPlaySceneCoverageNode(value: unknown, label: string): void {
  const node = asRecord(value, label);
  assertString(node.sceneId, `${label}.sceneId`);
  assertString(node.label, `${label}.label`);
  assertEnum(node.coverageState, API_SCENE_COVERAGE_STATES, `${label}.coverageState`);
  if (node.routeKey !== null) {
    assertString(node.routeKey, `${label}.routeKey`);
  }
  if (node.routeMapId !== null) {
    assertString(node.routeMapId, `${label}.routeMapId`);
  }
}

function assertPlaySceneCoverageEdge(value: unknown, label: string): void {
  const edge = asRecord(value, label);
  assertString(edge.fromSceneId, `${label}.fromSceneId`);
  assertString(edge.toSceneId, `${label}.toSceneId`);
  assertString(edge.choiceKey, `${label}.choiceKey`);
  assertString(edge.label, `${label}.label`);
}

function assertPlaySceneCoverageCounts(value: unknown, label: string): void {
  const counts = asRecord(value, label);
  assertNonNegativeInteger(counts.needsCheck, `${label}.needsCheck`);
  assertNonNegativeInteger(counts.flagged, `${label}.flagged`);
  assertNonNegativeInteger(counts.validated, `${label}.validated`);
  assertNonNegativeInteger(counts.total, `${label}.total`);
}

function assertPlayRouteMapResponse(value: unknown): asserts value is ApiPlayRouteMapResponse {
  const response = asStrictRecord(
    value,
    "ApiPlayRouteMapResponse",
    ITOTORI_STRICT_API_BODY_KEYS.ApiPlayRouteMapResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.play.route-map.v0",
    "ApiPlayRouteMapResponse.schemaVersion",
  );
  assertString(response.generatedAt, "ApiPlayRouteMapResponse.generatedAt");
  assertString(response.projectId, "ApiPlayRouteMapResponse.projectId");
  assertString(response.localeBranchId, "ApiPlayRouteMapResponse.localeBranchId");
  if (!Array.isArray(response.nodes)) {
    throw new ApiValidationError("ApiPlayRouteMapResponse.nodes must be an array");
  }
  if (!Array.isArray(response.edges)) {
    throw new ApiValidationError("ApiPlayRouteMapResponse.edges must be an array");
  }
  for (let i = 0; i < response.nodes.length; i += 1) {
    assertPlayRouteMapNode(response.nodes[i], `ApiPlayRouteMapResponse.nodes[${i}]`);
  }
  for (let i = 0; i < response.edges.length; i += 1) {
    assertPlayRouteMapEdge(response.edges[i], `ApiPlayRouteMapResponse.edges[${i}]`);
  }
  assertPlayRouteMapCounts(response.counts, "ApiPlayRouteMapResponse.counts");
}

function assertPlayRouteMapNode(value: unknown, label: string): asserts value is ApiPlayRouteMapNode {
  const node = asRecord(value, label);
  assertString(node.routeKey, `${label}.routeKey`);
  assertString(node.routeMapId, `${label}.routeMapId`);
  assertString(node.label, `${label}.label`);
  assertString(node.summary, `${label}.summary`);
  assertNonNegativeInteger(node.col, `${label}.col`);
  assertNonNegativeInteger(node.row, `${label}.row`);
  assertEnum(node.state, ["fresh", "stale"] as const, `${label}.state`);
  assertEnum(node.coverage, ["fresh", "stale"] as const, `${label}.coverage`);
  assertNonNegativeInteger(node.issues, `${label}.issues`);
}

function assertPlayRouteMapEdge(value: unknown, label: string): asserts value is ApiPlayRouteMapEdge {
  const edge = asRecord(value, label);
  assertString(edge.fromRouteKey, `${label}.fromRouteKey`);
  assertString(edge.toRouteKey, `${label}.toRouteKey`);
  assertString(edge.choiceKey, `${label}.choiceKey`);
  assertString(edge.choiceKind, `${label}.choiceKind`);
  assertString(edge.label, `${label}.label`);
}

function assertPlayRouteMapCounts(
  value: unknown,
  label: string,
): asserts value is ApiPlayRouteMapCounts {
  const counts = asRecord(value, label);
  assertNonNegativeInteger(counts.fresh, `${label}.fresh`);
  assertNonNegativeInteger(counts.stale, `${label}.stale`);
  assertNonNegativeInteger(counts.total, `${label}.total`);
  assertNonNegativeInteger(counts.choiceCount, `${label}.choiceCount`);
}

function assertPlaySetSceneCoverageResponse(
  value: unknown,
): asserts value is ApiPlaySetSceneCoverageResponse {
  const response = asStrictRecord(
    value,
    "ApiPlaySetSceneCoverageResponse",
    ITOTORI_STRICT_API_BODY_KEYS.ApiPlaySetSceneCoverageResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.play.set-scene-coverage.v0",
    "ApiPlaySetSceneCoverageResponse.schemaVersion",
  );
  assertString(response.projectId, "ApiPlaySetSceneCoverageResponse.projectId");
  assertString(response.localeBranchId, "ApiPlaySetSceneCoverageResponse.localeBranchId");
  assertString(response.sceneId, "ApiPlaySetSceneCoverageResponse.sceneId");
  assertEnum(
    response.coverageState,
    API_SCENE_COVERAGE_STATES,
    "ApiPlaySetSceneCoverageResponse.coverageState",
  );
  assertString(response.updatedAt, "ApiPlaySetSceneCoverageResponse.updatedAt");
  assertString(response.updatedByUserId, "ApiPlaySetSceneCoverageResponse.updatedByUserId");
}

function parseAuthSsoProviderConfig(value: unknown, label: string): ApiAuthSsoProviderConfig {
  const base = asRecord(value, label);
  assertEnum(base.protocol, ["oidc", "saml"] as const, `${label}.protocol`);
  const allowedKeys =
    base.protocol === "oidc"
      ? ["protocol", "providerId", "displayName", "enabled", "issuer", "clientId", "scopes"]
      : [
          "protocol",
          "providerId",
          "displayName",
          "enabled",
          "ssoUrl",
          "entityId",
          "certificateFingerprint",
        ];
  const provider = asStrictRecord(value, label, allowedKeys);
  assertString(provider.providerId, `${label}.providerId`);
  assertString(provider.displayName, `${label}.displayName`);
  assertBoolean(provider.enabled, `${label}.enabled`);
  if (provider.protocol === "oidc") {
    assertString(provider.issuer, `${label}.issuer`);
    assertString(provider.clientId, `${label}.clientId`);
    assertStringArray(provider.scopes, `${label}.scopes`);
    return {
      protocol: "oidc",
      providerId: provider.providerId,
      displayName: provider.displayName,
      enabled: provider.enabled,
      issuer: provider.issuer,
      clientId: provider.clientId,
      scopes: provider.scopes as string[],
    };
  }
  assertString(provider.ssoUrl, `${label}.ssoUrl`);
  assertString(provider.entityId, `${label}.entityId`);
  const samlProvider: ApiAuthSsoProviderConfig = {
    protocol: "saml",
    providerId: provider.providerId,
    displayName: provider.displayName,
    enabled: provider.enabled,
    ssoUrl: provider.ssoUrl,
    entityId: provider.entityId,
  };
  if (provider.certificateFingerprint !== undefined) {
    assertString(provider.certificateFingerprint, `${label}.certificateFingerprint`);
    samlProvider.certificateFingerprint = provider.certificateFingerprint;
  }
  return samlProvider;
}

function parseNullableExternalIdentityLink(
  value: unknown,
  label: string,
): ApiExternalIdentityLinkRequest | null {
  if (value === null) {
    return null;
  }
  const link = asStrictRecord(value, label, ["provider", "subject"]);
  assertString(link.provider, `${label}.provider`);
  assertString(link.subject, `${label}.subject`);
  return { provider: link.provider, subject: link.subject };
}

function parseAccountSecuritySettings(value: unknown, label: string): ApiAccountSecuritySettings {
  const settings = asStrictRecord(value, label, ["requireSso", "requireMfa", "allowPasswordLogin"]);
  assertBoolean(settings.requireSso, `${label}.requireSso`);
  assertBoolean(settings.requireMfa, `${label}.requireMfa`);
  assertBoolean(settings.allowPasswordLogin, `${label}.allowPasswordLogin`);
  return {
    requireSso: settings.requireSso,
    requireMfa: settings.requireMfa,
    allowPasswordLogin: settings.allowPasswordLogin,
  };
}

function parseAuthSessionPolicy(value: unknown, label: string): ApiAuthSessionPolicy {
  const policy = asStrictRecord(value, label, ["idleTimeoutMinutes", "absoluteTimeoutMinutes"]);
  assertPositiveInteger(policy.idleTimeoutMinutes, `${label}.idleTimeoutMinutes`);
  assertPositiveInteger(policy.absoluteTimeoutMinutes, `${label}.absoluteTimeoutMinutes`);
  if (policy.absoluteTimeoutMinutes < policy.idleTimeoutMinutes) {
    throw new ApiValidationError(
      `${label}.absoluteTimeoutMinutes must be greater than or equal to idleTimeoutMinutes`,
    );
  }
  return {
    idleTimeoutMinutes: policy.idleTimeoutMinutes,
    absoluteTimeoutMinutes: policy.absoluteTimeoutMinutes,
  };
}

export function assertBridgeInput(value: unknown): asserts value is BridgeBundle | BridgeBundleV02 {
  const bridge = asRecord(value, "BridgeInput");
  if (bridge.schemaVersion === BRIDGE_SCHEMA_VERSION_V02) {
    assertBridgeBundleV02(value);
    return;
  }
  assertBridgeBundle(value);
}

function assertPatchExportInput(
  value: unknown,
  label: string,
): asserts value is PatchExport | PatchExportV02 {
  const patch = asRecord(value, label);
  if (patch.schemaVersion === BRIDGE_SCHEMA_VERSION_V02) {
    assertPatchExportV02(value);
    return;
  }
  assertPatchExport(value);
}

function assertFindingRecordInput(
  value: unknown,
  label: string,
): asserts value is FindingRecordV02 {
  assertFindingRecordFixtureV02({
    schemaVersion: BRIDGE_SCHEMA_VERSION_V02,
    findingFixtureId: "019ed004-0000-7000-8000-000000000004",
    finding: value,
    compatibilityNotes: [],
  });
  const finding = asRecord(value, label);
  if (finding.findingId === undefined) {
    throw new Error(`${label}.findingId is required`);
  }
}

function assertDecisionEvent(value: unknown, label: string): asserts value is TriageEventV02 {
  assertTriageBundleV02({
    schemaVersion: BRIDGE_SCHEMA_VERSION_V02,
    triageBundleId: "019ed004-0000-7000-8000-000000000005",
    events: [value],
    tasks: [],
    findings: [],
  });
  const event = asRecord(value, label);
  if (event.eventKind !== "triage_decision_recorded") {
    throw new Error(`${label}.eventKind must be triage_decision_recorded`);
  }
}

function parseRequest<T>(label: string, parser: () => T): T {
  try {
    return parser();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ApiValidationError(`${label}: ${message}`);
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asStrictRecord(
  value: unknown,
  label: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  const record = asRecord(value, label);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`${label}.${key} is not part of the public API response`);
    }
  }
  return record;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertLiteral<T extends string>(
  value: unknown,
  expected: T,
  label: string,
): asserts value is T {
  if (value !== expected) {
    throw new Error(`${label} must be ${expected}`);
  }
}

function assertNullableString(value: unknown, label: string): asserts value is string | null {
  if (value !== null && typeof value !== "string") {
    throw new Error(`${label} must be a string or null`);
  }
}

function assertNull(value: unknown, label: string): asserts value is null {
  if (value !== null) {
    throw new Error(`${label} must be null`);
  }
}

function assertStringArray(value: unknown, label: string): void {
  const entries = asArray(value, label);
  for (const [index, entry] of entries.entries()) {
    assertString(entry, `${label}[${index}]`);
  }
}

function assertConflictReviewSourceIds(value: unknown, label: string): void {
  const rows = asArray(value, label);
  for (const [index, rowValue] of rows.entries()) {
    const row = asStrictRecord(rowValue, `${label}[${index}]`, ["catalogSource", "sourceId"]);
    assertString(row.catalogSource, `${label}[${index}].catalogSource`);
    assertPublicCatalogSource(row.catalogSource, `${label}[${index}].catalogSource`);
    assertString(row.sourceId, `${label}[${index}].sourceId`);
    assertNoCatalogPrivateLeakage(row.sourceId, `${label}[${index}].sourceId`);
  }
}

function assertConflictReviewExactLinkRefs(value: unknown, label: string): void {
  const rows = asArray(value, label);
  for (const [index, rowValue] of rows.entries()) {
    const row = asStrictRecord(rowValue, `${label}[${index}]`, [
      "externalIdId",
      "catalogSource",
      "sourceId",
      "externalIdKind",
      "workId",
      "sourceProvenanceId",
    ]);
    assertString(row.externalIdId, `${label}[${index}].externalIdId`);
    assertString(row.catalogSource, `${label}[${index}].catalogSource`);
    assertPublicCatalogSource(row.catalogSource, `${label}[${index}].catalogSource`);
    assertString(row.sourceId, `${label}[${index}].sourceId`);
    assertNoCatalogPrivateLeakage(row.sourceId, `${label}[${index}].sourceId`);
    assertEnum(
      row.externalIdKind,
      Object.values(catalogExternalIdKindValues) as CatalogExternalIdKind[],
      `${label}[${index}].externalIdKind`,
    );
    assertString(row.workId, `${label}[${index}].workId`);
    assertNullableString(row.sourceProvenanceId, `${label}[${index}].sourceProvenanceId`);
  }
}

function assertConflictReviewFuzzyScores(value: unknown, label: string): void {
  const rows = asArray(value, label);
  for (const [index, rowValue] of rows.entries()) {
    const row = asStrictRecord(rowValue, `${label}[${index}]`, [
      "candidateId",
      "score",
      "diagnosticCode",
      "generatorVersion",
    ]);
    assertString(row.candidateId, `${label}[${index}].candidateId`);
    assertNonNegativeInteger(row.score, `${label}[${index}].score`);
    assertString(row.diagnosticCode, `${label}[${index}].diagnosticCode`);
    assertString(row.generatorVersion, `${label}[${index}].generatorVersion`);
  }
}

function assertConflictReviewProvenance(value: unknown, label: string): void {
  const rows = asArray(value, label);
  for (const [index, rowValue] of rows.entries()) {
    const row = asStrictRecord(rowValue, `${label}[${index}]`, [
      "sourceProvenanceId",
      "catalogSource",
      "sourceId",
      "sourceRecordKind",
      "payloadHash",
      "fetchedAt",
    ]);
    assertString(row.sourceProvenanceId, `${label}[${index}].sourceProvenanceId`);
    assertString(row.catalogSource, `${label}[${index}].catalogSource`);
    assertPublicCatalogSource(row.catalogSource, `${label}[${index}].catalogSource`);
    assertString(row.sourceId, `${label}[${index}].sourceId`);
    assertNoCatalogPrivateLeakage(row.sourceId, `${label}[${index}].sourceId`);
    assertString(row.sourceRecordKind, `${label}[${index}].sourceRecordKind`);
    assertPublicCatalogSourceRecordKind(
      row.sourceRecordKind,
      `${label}[${index}].sourceRecordKind`,
    );
    assertNullableString(row.payloadHash, `${label}[${index}].payloadHash`);
    assertDateLike(row.fetchedAt, `${label}[${index}].fetchedAt`);
  }
}

function assertPublicCatalogSource(value: string, label: string): void {
  assertEnum(value, Object.values(catalogSourceValues) as CatalogSource[], label);
  if (value === catalogSourceValues.localCorpus) {
    throw new Error(`${label} must not expose local corpus sources`);
  }
}

function assertPublicCatalogSourceRecordKind(value: string, label: string): void {
  assertEnum(
    value,
    Object.values(catalogSourceRecordKindValues) as CatalogSourceRecordKind[],
    label,
  );
  if (value === catalogSourceRecordKindValues.localScan) {
    throw new Error(`${label} must not expose local scan sources`);
  }
}

function assertPublicCatalogRedactionClass(value: string, label: string): void {
  assertEnum(
    value,
    Object.values(catalogRawContentRedactionClassValues) as CatalogRawContentRedactionClass[],
    label,
  );
  if (value === catalogRawContentRedactionClassValues.privateCorpus) {
    throw new Error(`${label} must not expose private corpus data`);
  }
}

function assertNoCatalogPrivateLeakage(value: string, label: string): void {
  if (benchmarkSeedPrivateLeakagePatterns.some((pattern) => pattern.test(value))) {
    throw new Error(`${label} must not expose private response data`);
  }
}

function assertDateLike(value: unknown, label: string): void {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (date === null || Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be a date`);
  }
}

function assertNullableDateLike(value: unknown, label: string): void {
  if (value !== null) {
    assertDateLike(value, label);
  }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function assertNonNegativeNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
}

function assertNullableNonNegativeInteger(
  value: unknown,
  label: string,
): asserts value is number | null {
  if (value !== null) {
    assertNonNegativeInteger(value, label);
  }
}

function assertNullableNonNegativeNumber(
  value: unknown,
  label: string,
): asserts value is number | null {
  if (value !== null) {
    assertNonNegativeNumber(value, label);
  }
}

function assertNullableFiniteNumber(value: unknown, label: string): asserts value is number | null {
  if (value !== null) {
    assertFiniteNumber(value, label);
  }
}

function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
}

function assertNullableBoolean(value: unknown, label: string): asserts value is boolean | null {
  if (value !== null) {
    assertBoolean(value, label);
  }
}

function assertEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(
      `${label} must be one of ${allowed.join(", ")} (received ${JSON.stringify(value)})`,
    );
  }
}

function assertNullableEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): asserts value is T | null {
  if (value === null) {
    return;
  }
  assertEnum(value, allowed, label);
}
