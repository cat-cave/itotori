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
  ProjectTelemetryTimeseries,
  QueueHealthReadModel,
  AuthSessionAdminRecord,
  ActorIdentityAccountRecord,
  ActorIdentityRecord,
  AuthBillingPeriod,
  MemberInvitationRecord,
  MemberRecord,
  RuntimeDashboardStatus,
  TerminologySearchReadModel,
  WikiContextEntriesReadModel,
  WikiContextEntryHistoryReadModel,
  WikiContextEntryReadModel,
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
  translationScopeValues,
  wikiContextEntryKindList,
} from "./api-enum-values.js";
import {
  assertBenchmarkReportV02,
  assertBridgeBundle,
  assertBridgeBundleV02,
  assertFindingRecordFixtureV02,
  assertPatchExport,
  assertPatchExportV02,
  assertRuntimeReport,
  BENCHMARK_TOKEN_COUNT_SOURCES,
  BRIDGE_SCHEMA_VERSION_V02,
  type BenchmarkReportV02,
  type BridgeBundle,
  type BridgeBundleV02,
  type FindingRecordV02,
  type PatchExport,
  type PatchExportV02,
  type RuntimeEvidenceReportV02,
  type RuntimeVerificationReport,
} from "@itotori/localization-bridge-schema";
import type {
  BenchmarkRecordResult,
  FindingRecordResult,
  ProjectState,
  RuntimeIngestResult,
} from "./services/project-workflow.js";
import type {
  ProjectOverviewBenchmarkHeadline,
  ProjectOverviewJournalPage,
  ProjectOverviewJournalRow,
  ProjectOverviewReadModel,
} from "./project-overview-read-model.js";
import { PROJECT_OVERVIEW_SCHEMA_VERSION } from "./project-overview-read-model.js";
import type { BmkCockpitReadModel, BmkCockpitRunHistoryPage } from "./bmk-cockpit-read-model.js";
import {
  BMK_COCKPIT_CONTESTANT_ROLES,
  BMK_COCKPIT_SCHEMA_VERSION,
} from "./bmk-cockpit-read-model.js";
import type { CatalogContextPanelReadModel } from "./catalog-context-panel.js";
import type { WikiBrainEditResult } from "./wiki/service.js";

export type ItotoriApiRouteId =
  | "assetDecisions.active"
  | "assetDecisions.candidates"
  | "catalog.benchmarkSeeds"
  | "catalog.contextPanel"
  | "catalog.completeness"
  | "catalog.conflicts"
  | "catalog.opportunities"
  | "terminology.search"
  | "wiki.list"
  | "wiki.show"
  | "wiki.history"
  | "wiki.edit"
  | "wiki.add"
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
  // p3-in-studio-decode-extract-trigger — run the REAL identify -> inventory ->
  // extract decode pipeline from a game source path/handle and return the
  // produced v0.2 bridge (replaces the manual bridge-JSON upload as the primary
  // Studio on-ramp). Gated on `project.import` — the same authority `imports.bridge`
  // carries, since it produces the same import artifact.
  | "projects.decodeExtract"
  | "imports.bridge"
  | "branches.draft"
  | "findings.record"
  | "benchmarks.record"
  | "runtimeEvidence.ingest"
  | "settings.modelRouting.get"
  | "settings.modelRouting.save"
  | "settings.branchPolicy.get"
  | "settings.branchPolicy.save"
  | "settings.translationScope.get"
  | "settings.translationScope.save"
  | "settings.localizationRunConfig.save"
  | "auth.ssoSettings.configure"
  | "auth.billing.seatUsage"
  | "auth.members.list"
  | "auth.members.invite"
  | "auth.members.accept"
  | "auth.members.remove"
  | "auth.permissionSets.list"
  | "auth.permissionSets.grant"
  | "auth.permissionSets.revoke"
  | "auth.sessions.list"
  | "auth.sessions.revoke"
  | "auth.identity"
  // fnd-caps-context — the actor's Studio capability permission VIEW
  // (canFlag / canSteer / canReveal), resolved from exact
  // permission grants via the auth-002 effective-permission resolver.
  | "auth.capabilities"
  // ovw-launch-pass-action — the Overview "launch next pass" mutation drives
  // the next localization pass via the
  // project-driven-executor / localize-fullproject driver. `canSteer`-gated
  // (the `draft.write` steer permission). The HTTP surface is a thin adapter;
  // the driver itself is unchanged.
  | "projects.launchPass"
  | "play.routeMap"
  // play-flag-composer — in-the-moment AnnotationComposer flag → canonical
  // context correction via ManualFeedbackImport (feedback.import / canFlag).
  | "play.flagAnnotation"
  // p0-result-revision — a play tester replaces one delivered target line,
  // creating and selecting a child delivered patch revision.
  | "play.targetEdit"
  // p0-result-revision — inspect the selected delivered patch for a run.
  | "play.delivery"
  // p0-core-iterative-patch-versioning-and-playtest-feedback — historical
  // version play surface, exact observed sessions, persisted feedback inbox,
  // and refinement launch all share the node-11 coordinator.
  | "patchIteration.versions"
  | "patchIteration.surface"
  | "patchIteration.delivery"
  | "patchIteration.play"
  | "patchIteration.feedbackBatch"
  | "patchIteration.feedback"
  | "patchIteration.refine";

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
  ApiAssetDecisionsResponse: ["decisions"],
  ApiCandidateAssetsResponse: ["candidateAssets"],
  WikiContextEntriesReadModel: ["schemaVersion", "generatedAt", "filter", "pagination", "entries"],
  WikiContextEntryReadModel: ["schemaVersion", "generatedAt", "entry"],
  WikiContextEntryHistoryReadModel: [
    "schemaVersion",
    "generatedAt",
    "contextArtifactId",
    "headVersionId",
    "versions",
  ],
  ApiWikiEditResponse: [
    "schemaVersion",
    "generatedAt",
    "correctionId",
    "contextArtifactId",
    "contextEntryVersionId",
    "affectedUnitIds",
    "invalidatedArtifactIds",
    "redraftJobId",
    "rerun",
    "entry",
  ],
  CatalogBenchmarkSeedFinderReadModel: ["schemaVersion", "targetLanguage", "generatedAt", "rows"],
  CatalogContextPanelReadModel: [
    "schemaVersion",
    "generatedAt",
    "params",
    "row",
    "releases",
    "projectState",
  ],
  CatalogCompletenessBenchmarkPools: ["targetLanguage", "pools", "publicReport"],
  CatalogConflictReviewReadModel: ["rows"],
  CatalogOpportunityRankingReadModel: [
    "schemaVersion",
    "targetLanguage",
    "generatedAt",
    "weightsVersion",
    "rows",
  ],
  CostDrilldownPage: ["filter", "pagination", "rows"],
  JobsRunTableReadModel: ["schemaVersion", "generatedAt", "filter", "pagination", "rows"],
  ProjectOverviewReadModel: [
    "schemaVersion",
    "generatedAt",
    "projectId",
    "progress",
    "decisions",
    "cost",
    "telemetry",
    "costDrilldown",
    "journal",
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
  ApiModelRoutingProvider: [
    "providerId",
    "providerFamily",
    "endpointFamily",
    "providerName",
    "metadata",
  ],
  ApiModelRoutingModel: ["modelRegistryId", "providerId", "modelId", "capabilities", "pricing"],
  ApiModelRoutingPromptPreset: [
    "promptPresetId",
    "promptTemplateVersion",
    "presetSchemaVersion",
    "promptHash",
    "configSnapshot",
  ],
  ApiModelRoutingRoute: [
    "projectId",
    "taskKind",
    "providerId",
    "modelId",
    "modelRegistryId",
    "fallbackModelIds",
    "promptPresetId",
    "promptTemplateVersion",
    "updatedAt",
  ],
  ApiModelRoutingSettingsResponse: [
    "schemaVersion",
    "projectId",
    "generatedAt",
    "providers",
    "models",
    "promptPresets",
    "routes",
  ],
  ApiBranchPolicyRule: ["ruleId", "guidance"],
  ApiBranchPolicySections: ["tone", "terminology", "honorifics", "formatting", "protectedSpans"],
  ApiBranchPolicySourceRevisionReference: ["sourceRevisionId", "revisionKind", "value"],
  ApiBranchPolicyVersion: [
    "styleGuideVersionId",
    "status",
    "versionSequence",
    "createdAt",
    "updatedAt",
    "approvedAt",
    "policy",
  ],
  ApiBranchPolicyGlossaryReference: [
    "referenceId",
    "versionSequence",
    "styleGuideVersionId",
    "glossaryContentHash",
    "glossaryTermCount",
    "updateReason",
    "createdAt",
  ],
  ApiBranchPolicySettingsResponse: [
    "schemaVersion",
    "projectId",
    "localeBranchId",
    "targetLocale",
    "sourceRevision",
    "latestVersion",
    "approvedVersion",
    "branchReference",
    "policy",
  ],
  ApiTranslationScopeSettingsResponse: [
    "schemaVersion",
    "projectId",
    "localeBranchId",
    "scope",
    "updatedAt",
  ],
  ApiSaveTranslationScopeSettingsRequest: ["projectId", "localeBranchId", "scope"],
  ApiLocalizationRunConfigResponse: [
    "schemaVersion",
    "projectId",
    "localeBranchId",
    "configPath",
    "dataRoot",
    "pairPolicyPath",
    "modelId",
    "providerId",
    "runDir",
    "updatedAt",
  ],
  ApiSaveLocalizationRunConfigRequest: [
    "projectId",
    "localeBranchId",
    "configPath",
    "dataRoot",
    "pairPolicyPath",
    "modelId",
    "providerId",
    "runDir",
  ],
  ApiSaveBranchPolicySettingsRequest: [
    "projectId",
    "localeBranchId",
    "expectedPreviousVersionId",
    "updateReason",
    "policy",
  ],
  ApiSaveModelRoutingSettingsRequest: [
    "projectId",
    "taskKind",
    "providerId",
    "modelId",
    "fallbackModelIds",
    "promptPresetId",
    "promptTemplateVersion",
  ],
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
  ApiAuthBillingSeatUsageResponse: [
    "schemaVersion",
    "accountId",
    "planId",
    "planName",
    "billingPeriod",
    "seatLimit",
    "includedSeats",
    "usedSeats",
    "pendingInvitations",
    "availableSeats",
    "overSeatLimit",
    "updatedAt",
  ],
  ApiRemoveMemberRequest: ["reason", "requestId"],
  ApiRemoveMemberResponse: ["schemaVersion", "removedMember"],
  ApiPermissionSetRecord: ["permissionSetId", "accountId", "name", "permissions"],
  ApiPermissionSetsListResponse: ["schemaVersion", "accountId", "permissionSets"],
  ApiPrincipalPermissionSetGrantRequest: ["reason", "requestId"],
  ApiPrincipalPermissionSetGrantResponse: [
    "schemaVersion",
    "principalId",
    "permissionSetId",
    "action",
    "updatedMember",
  ],
  ApiAuthSessionRecord: [
    "sessionId",
    "principalId",
    "createdAt",
    "expiresAt",
    "revokedAt",
    "isActive",
    "deviceLabel",
    "userAgent",
    "ipAddress",
  ],
  ApiAuthSessionsListResponse: ["schemaVersion", "principalId", "sessions"],
  ApiRevokeAuthSessionRequest: ["reason", "requestId"],
  ApiRevokeAuthSessionResponse: ["schemaVersion", "revokedSession"],
  ApiAuthIdentityAccount: [
    "membershipId",
    "accountId",
    "accountSlug",
    "accountName",
    "permissionSetIds",
    "createdAt",
  ],
  ApiAuthIdentityResponse: [
    "schemaVersion",
    "actorUserId",
    "userId",
    "principalId",
    "email",
    "displayName",
    "accounts",
  ],
  // fnd-caps-context — Studio capability permission view wire envelope.
  ApiAuthCapabilitiesResponse: [
    "schemaVersion",
    "actorUserId",
    "canFlag",
    "canSteer",
    "canReveal",
    "denials",
    "denialReasons",
  ],
  ApiStudioCapabilityDenials: ["flag", "steer", "reveal"],
  // ovw-launch-pass-action — the typed launch-pass response envelope. The
  // schemaVersion const pins the wire shape; a renamed / leaked field fails a
  // contract test instead of silently drifting.
  ApiLaunchPassResponse: [
    "schemaVersion",
    "outcome",
    "journalRunId",
    "startedAt",
    "refusalMessage",
  ],
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
  // play-flag-composer — AnnotationComposer submit result (severity-scaled flag).
  ApiPlayFlagAnnotationResponse: [
    "schemaVersion",
    "projectId",
    "localeBranchId",
    "feedbackReportId",
    "feedbackEvidenceId",
    "severity",
    "category",
    "note",
    "triageLabel",
    "contextStatus",
    "contextCorrectionId",
    "duplicate",
  ],
  // p0-result-revision — the target-only request body intentionally excludes
  // actor identity, artifact paths, and source text. Those values are bound
  // at the production service boundary or remain server-side provenance.
  ApiPlayTargetEditRequest: ["bridgeUnitId", "targetBody"],
  ApiPlayTargetEditResponse: [
    "schemaVersion",
    "resultRevisionId",
    "patchVersionId",
    "runId",
    "parentPatchVersionId",
    "bridgeUnitId",
    "targetBody",
    "status",
    "selectedAt",
    "idempotentReplay",
  ],
  ApiPlayDeliveryResponse: [
    "schemaVersion",
    "patchVersionId",
    "runId",
    "parentPatchVersionId",
    "status",
    "selectedAt",
    "artifactHashes",
    "downloadUrl",
    "units",
  ],
  ApiPlayDeliveryUnit: ["bridgeUnitId", "unitOrdinal", "targetBody"],
  ApiPatchIterationDeliveryResponse: [
    "schemaVersion",
    "patchVersionId",
    "runId",
    "parentPatchVersionId",
    "origin",
    "status",
    "playableAt",
    "artifactHashes",
    "downloadUrl",
    "units",
  ],
  ApiPatchIterationVersionsResponse: ["schemaVersion", "versions"],
  ApiPatchIterationSurfaceResponse: ["schemaVersion", "patch", "versions", "feedback"],
  ApiPatchIterationPlayRequest: ["launchDescriptor"],
  ApiPatchIterationPlayResponse: ["schemaVersion", "session"],
  ApiPatchIterationFeedbackBatchRequest: ["feedbackBatchId", "label"],
  ApiPatchIterationFeedbackBatchResponse: ["schemaVersion", "batch"],
  ApiPatchIterationFeedbackRequest: [
    "feedbackBatchId",
    "playSessionId",
    "eventKind",
    "body",
    "metadata",
    "targetBody",
    "resultRevisionId",
    "contextArtifactId",
    "contextEntryVersionId",
    "contextFeedback",
    "affectedBridgeUnitIds",
  ],
  ApiPatchIterationFeedbackResponse: ["schemaVersion", "feedback"],
  ApiPatchIterationRefineRequest: [
    "feedbackBatchIds",
    "feedbackEventIds",
    "scopeUnitIds",
    "targetBodiesByUnit",
    "wikiHeads",
  ],
  ApiPatchIterationRefineResponse: ["schemaVersion", "refinement", "patch"],
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

export type ApiCatalogContextPanelResponse = CatalogContextPanelReadModel;

export type ApiCatalogOpportunitiesResponse = CatalogOpportunityRankingReadModel;

export type ApiTerminologySearchResponse = TerminologySearchReadModel;

/** Generic node-6 context-brain browse surface. */
export type ApiWikiListResponse = WikiContextEntriesReadModel;

/** One canonical entry with content, provenance, citations, impact, and lineage. */
export type ApiWikiShowResponse = WikiContextEntryReadModel;

/** Immutable version history for one canonical entry. */
export type ApiWikiHistoryResponse = WikiContextEntryHistoryReadModel;

/**
 * A human correction body. Identity/scope/category/source revision/data and
 * citations are deliberately absent: the server loads those from the existing
 * canonical entry before calling ContextCorrectionService.
 */
export type ApiWikiEditRequest = {
  body: string;
  reason: string;
  title?: string;
  affectedUnitIds?: string[];
};

/** Result of the node-8-backed canonical wiki correction. */
export type ApiWikiEditResponse = WikiBrainEditResult;

export type ApiWikiAddKind = "note" | "glossary" | "style";

/** New human context is also a node-8 correction; source scope is mandatory. */
export type ApiWikiAddRequest = {
  sourceRevisionId: string;
  kind: ApiWikiAddKind;
  title: string;
  body: string;
  reason: string;
  affectedUnitIds: string[];
};

export type ApiWikiAddResponse = ApiWikiEditResponse;

export type ApiAssetDecisionsResponse = {
  decisions: AssetDecisionRecord[];
};

export type ApiCandidateAssetsResponse = {
  candidateAssets: CandidateAssetRecord[];
};

export type ApiProjectImportRequest = {
  bridge: BridgeBundle | BridgeBundleV02;
  bootstrapSelection?: ApiBootstrapCatalogSelection;
};

/**
 * p3-in-studio-decode-extract-trigger — point the Studio at a game source and
 * run the REAL identify -> inventory -> extract decode pipeline. Sourcing is
 * EITHER a by-id vault handle OR a raw game root; identity is the four RealLive
 * metadata fields; mode is per-scene (`scene`) XOR whole-Seen (`wholeSeen`).
 */
export type ApiProjectDecodeExtractRequest = {
  vaultCanonicalId?: string;
  gameRoot?: string;
  gameId: string;
  gameVersion: string;
  sourceProfileId: string;
  sourceLocale: string;
  scene?: number;
  wholeSeen?: boolean;
};

/**
 * The produced v0.2 BridgeBundle (read back from the file kaifuu wrote), the
 * resolved decode mode, and the exact kaifuu-cli invocation. The bridge feeds
 * the SAME `imports.bridge` ingestion path the manual upload used.
 */
export type ApiProjectDecodeExtractResponse = {
  bridge: BridgeBundleV02;
  mode: "per-scene" | "whole-seen";
  command: string;
};

export type ApiBootstrapCatalogSourceId = {
  catalogSource: CatalogSource;
  sourceId: string;
  externalIdKind: CatalogExternalIdKind;
};

export type ApiBootstrapCatalogCandidate = {
  workId: string;
  canonicalTitle: string;
  sourceIds: ApiBootstrapCatalogSourceId[];
  adapterId: string | null;
};

export type ApiBootstrapCatalogSelection = {
  selectedWorkId: string;
  candidates: ApiBootstrapCatalogCandidate[];
};

export type ApiProjectImportResponse = {
  project: ProjectState;
  status: ProjectDashboardStatus;
};

export type ApiDraftBranchRequest = {
  project: ProjectState;
  targetLocale: string;
};

export type ApiDraftBranchResponse =
  | {
      /** The draft workflow completed. */
      outcome: "drafted";
      project: ProjectState;
      status: ProjectDashboardStatus;
      refusalMessage: null;
    }
  | {
      /** The provider refused before producing a draft. */
      outcome: "refused";
      project: null;
      status: null;
      refusalMessage: string;
    };

export type ApiRecordFindingRequest = {
  localeBranchId?: string;
  finding: FindingRecordV02;
  status?: "open" | "resolved" | "superseded";
};

export type ApiRecordFindingResponse = FindingRecordResult;

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

export type ApiModelRoutingProvider = {
  providerId: string;
  providerFamily: string;
  endpointFamily: string;
  providerName: string;
  metadata: Record<string, unknown>;
};

export type ApiModelRoutingModel = {
  modelRegistryId: string;
  providerId: string;
  modelId: string;
  capabilities: Record<string, unknown>;
  pricing: Record<string, unknown>;
};

export type ApiModelRoutingPromptPreset = {
  promptPresetId: string;
  promptTemplateVersion: string;
  presetSchemaVersion: string;
  promptHash: string;
  configSnapshot: Record<string, unknown>;
};

export type ApiModelRoutingRoute = {
  projectId: string;
  taskKind: string;
  providerId: string;
  modelId: string;
  modelRegistryId: string;
  fallbackModelIds: string[];
  promptPresetId: string;
  promptTemplateVersion: string;
  updatedAt: string;
};

export type ApiModelRoutingSettingsResponse = {
  schemaVersion: "itotori.settings.model-routing.v0";
  projectId: string;
  generatedAt: string;
  providers: ApiModelRoutingProvider[];
  models: ApiModelRoutingModel[];
  promptPresets: ApiModelRoutingPromptPreset[];
  routes: ApiModelRoutingRoute[];
};

export type ApiSaveModelRoutingSettingsRequest = {
  projectId: string;
  taskKind: string;
  providerId: string;
  modelId: string;
  fallbackModelIds: readonly string[];
  promptPresetId: string;
  promptTemplateVersion: string;
};

export type ApiBranchPolicyRule = {
  ruleId: string;
  guidance: string;
};

export type ApiBranchPolicySections = {
  tone: ApiBranchPolicyRule[];
  terminology: ApiBranchPolicyRule[];
  honorifics: ApiBranchPolicyRule[];
  formatting: ApiBranchPolicyRule[];
  protectedSpans: ApiBranchPolicyRule[];
};

export type ApiBranchPolicyPolicy = {
  schemaVersion: "style-guide-policy.v0";
  sections: ApiBranchPolicySections;
};

export type ApiBranchPolicySourceRevisionReference = {
  sourceRevisionId: string;
  revisionKind: string;
  value: string;
};

export type ApiBranchPolicyVersion = {
  styleGuideVersionId: string;
  status: string;
  versionSequence: number;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  policy: ApiBranchPolicyPolicy;
};

export type ApiBranchPolicyGlossaryReference = {
  referenceId: string;
  versionSequence: number;
  styleGuideVersionId: string | null;
  glossaryContentHash: string;
  glossaryTermCount: number;
  updateReason: string;
  createdAt: string;
};

export type ApiBranchPolicySettingsResponse = {
  schemaVersion: "itotori.settings.branch-policy.v0";
  projectId: string;
  localeBranchId: string;
  targetLocale: string;
  sourceRevision: ApiBranchPolicySourceRevisionReference;
  latestVersion: ApiBranchPolicyVersion | null;
  approvedVersion: ApiBranchPolicyVersion | null;
  branchReference: ApiBranchPolicyGlossaryReference | null;
  policy: ApiBranchPolicyPolicy;
};

export type ApiSaveBranchPolicySettingsRequest = {
  projectId: string;
  localeBranchId: string;
  expectedPreviousVersionId: string | null;
  updateReason: string;
  policy: ApiBranchPolicyPolicy;
};

// itotori-translation-scope-settings — config-driven translation scope
// (dialogue / +choices / +UI-text / +images) the whole-project localize
// command reads. See `apps/itotori/src/orchestrator/localize-fullproject-command.ts`
// (`LocalizeFullProjectConfig.translationScope`) and
// `crates/kaifuu-reallive/src/scope.rs` for the tiers this mirrors.
export type ApiTranslationScope =
  (typeof translationScopeValues)[keyof typeof translationScopeValues];

export type ApiTranslationScopeSettingsResponse = {
  schemaVersion: "itotori.settings.translation-scope.v0";
  projectId: string;
  localeBranchId: string;
  scope: ApiTranslationScope;
  updatedAt: string;
};

export type ApiSaveTranslationScopeSettingsRequest = {
  projectId: string;
  localeBranchId: string;
  scope: ApiTranslationScope;
};

/** Operator-local whole-project inputs used by the Studio launch-pass driver. */
export type ApiLocalizationRunConfigResponse = {
  schemaVersion: "itotori.settings.localization-run-config.v0";
  projectId: string;
  localeBranchId: string;
  configPath: string;
  dataRoot: string;
  pairPolicyPath: string;
  modelId: string;
  providerId: string;
  runDir: string;
  updatedAt: string;
};

export type ApiSaveLocalizationRunConfigRequest = {
  projectId: string;
  localeBranchId: string;
  configPath: string;
  dataRoot: string;
  pairPolicyPath: string;
  modelId: string;
  providerId: string;
  runDir: string;
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

export type ApiAuthBillingSeatUsageResponse = {
  schemaVersion: "itotori.auth.billing-seat-usage.v0";
  accountId: string;
  planId: string;
  planName: string;
  billingPeriod: AuthBillingPeriod;
  seatLimit: number;
  includedSeats: number;
  usedSeats: number;
  pendingInvitations: number;
  availableSeats: number;
  overSeatLimit: boolean;
  updatedAt: string;
};

export type ApiAuthSessionRecord = Omit<
  AuthSessionAdminRecord,
  "createdAt" | "expiresAt" | "revokedAt"
> & {
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
};

export type ApiAuthSessionsListResponse = {
  schemaVersion: "itotori.auth.sessions.v0";
  principalId: string;
  sessions: ApiAuthSessionRecord[];
};

export type ApiRevokeAuthSessionRequest = {
  reason: string | null;
  requestId: string | null;
};

export type ApiRevokeAuthSessionResponse = {
  schemaVersion: "itotori.auth.session-revoked.v0";
  revokedSession: ApiAuthSessionRecord;
};

export type ApiAuthIdentityAccount = Omit<ActorIdentityAccountRecord, "createdAt"> & {
  createdAt: string;
};

export type ApiAuthIdentityResponse = Omit<ActorIdentityRecord, "accounts"> & {
  schemaVersion: "itotori.auth.identity.v0";
  accounts: ApiAuthIdentityAccount[];
};

/**
 * fnd-caps-context — the actor's Studio capability permission VIEW on the
 * wire. Sourced server-side from exact permission grants (capabilities, NOT
 * roles) via `resolveStudioCapabilityPermissionView`. The SPA CapsProvider
 * consumes this shape to gate flag / steer / reveal actions.
 */
export type ApiAuthCapabilitiesResponse = {
  schemaVersion: "itotori.auth.capabilities.v0";
  actorUserId: string;
  canFlag: boolean;
  canSteer: boolean;
  canReveal: boolean;
  denials: {
    flag: string | null;
    steer: string | null;
    reveal: string | null;
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

export type ApiPermissionSetRecord = {
  permissionSetId: string;
  accountId: string;
  name: string;
  permissions: string[];
};

export type ApiPermissionSetsListResponse = {
  schemaVersion: "itotori.auth.permission-sets.v0";
  accountId: string;
  permissionSets: ApiPermissionSetRecord[];
};

export type ApiPrincipalPermissionSetGrantRequest = {
  reason: string | null;
  requestId: string | null;
};

export type ApiPrincipalPermissionSetGrantResponse = {
  schemaVersion: "itotori.auth.permission-set-grant.v0";
  principalId: string;
  permissionSetId: string;
  action: "granted" | "revoked";
  updatedMember: ApiMemberRecord;
};

/**
 * ovw-launch-pass-action — request body for the launch-pass mutation. The
 * Overview action wires through the typed client. The body carries the locale
 * branch the next pass is scoped to; the server VERIFIES it against the
 * project's server-side ownership set (a forged branch is refused) before the
 * driver is touched. An operator may instead request cancellation of one
 * existing durable run in that same authoritative scope. The project id lives
 * on the URL path.
 */
export type ApiLaunchPassRequest =
  | {
      /** The locale branch the next pass is scoped to (validated server-side). */
      localeBranchId: string;
      /** Omitted/false for a normal launch. */
      cancelled?: false;
      /** A run id is legal only for an explicit cancellation. */
      resumeRunId?: undefined;
    }
  | {
      /** The authoritative branch scope the existing run must belong to. */
      localeBranchId: string;
      /** Explicit operator cancellation; never inferred from a bare run id. */
      cancelled: true;
      /** Immutable durable journal run id to abort. */
      resumeRunId: string;
    };

/**
 * ovw-launch-pass-action — response body for the launch-pass mutation. A thin,
 * driver-agnostic confirmation the UI can render after a click: a typed
 * `outcome` (`started` / `refused`) plus the durable journal run identity +
 * start timestamp (on `started`) or a refusal reason (on `refused`). A refused
 * launch is surfaced in-band so the Overview strip renders it like any driver
 * response, never as a silent success.
 */
export type ApiLaunchPassResponse = {
  schemaVersion: "itotori.projects.launch-pass.v1";
  /** The driver outcome: the journal run was started, or the driver refused it. */
  outcome: "started" | "refused";
  /** The immutable journal run id on `started`; `null` on `refused`. */
  journalRunId: string | null;
  /** ISO timestamp the pass was started on `started`; `null` on `refused`. */
  startedAt: string | null;
  /** Refusal reason (non-empty) on `refused`; `null` on `started`. */
  refusalMessage: string | null;
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

/** Closed ordinal severity scale for play-flag-composer (annotation-severity tokens). */
export type ApiPlayFlagSeverity = "blocker" | "critical" | "warning" | "note";

export const API_PLAY_FLAG_SEVERITIES = [
  "blocker",
  "critical",
  "warning",
  "note",
] as const satisfies readonly ApiPlayFlagSeverity[];

/**
 * play-flag-composer — request body for composing an in-the-moment playtest
 * flag. projectId + localeBranchId live on the URL path.
 */
export type ApiPlayFlagAnnotationRequest = {
  note: string;
  severity: ApiPlayFlagSeverity;
  /** Free-form category (tone / layout / glossary / …). */
  category?: string;
  /** The persisted target unit required for the canonical correction. */
  bridgeUnitId: string;
  sourceUnitKey?: string;
  sourceBundleId?: string;
  sourceRevisionId?: string;
  sceneId?: string;
  suggestedEdit?: string;
  actorUserId?: string;
  actorDisplayName?: string;
};

/**
 * play-flag-composer — receipt for a completed canonical context correction.
 */
export type ApiPlayFlagAnnotationResponse = {
  schemaVersion: "itotori.play.flag-annotation.v0";
  projectId: string;
  localeBranchId: string;
  feedbackReportId: string;
  feedbackEvidenceId: string;
  severity: ApiPlayFlagSeverity;
  category: string;
  note: string;
  triageLabel: string;
  contextStatus: string;
  /** Durable canonical-context write created by this successful flag. */
  contextCorrectionId: string;
  duplicate: boolean;
};

/**
 * p0-result-revision — the play-tester mutation accepts exactly one target
 * line. The parent delivered patch is the URL resource; actor provenance and
 * artifact roots are bound server-side and cannot be fabricated in the body.
 */
export type ApiPlayTargetEditRequest = {
  bridgeUnitId: string;
  targetBody: string;
};

/**
 * p0-result-revision — concise mutation confirmation. It identifies the new
 * result revision and selected child delivered patch without exposing source
 * text or server-local artifact paths.
 */
export type ApiPlayTargetEditResponse = {
  schemaVersion: "itotori.play.target-edit.v0";
  resultRevisionId: string;
  patchVersionId: string;
  runId: string;
  parentPatchVersionId: string;
  bridgeUnitId: string;
  targetBody: string;
  status: "playable";
  selectedAt: string;
  idempotentReplay: boolean;
};

/** p0-result-revision — one ordered delivered target unit in the export view. */
export type ApiPlayDeliveryUnit = {
  bridgeUnitId: string;
  unitOrdinal: number;
  targetBody: string;
};

/**
 * p0-result-revision — selected, deliverable patch export for a run. Artifact
 * references and hashes prove the production delivery artifact selected by the
 * mutation; units remain in their patch ordinal order.
 */
export type ApiPlayDeliveryResponse = {
  schemaVersion: "itotori.play.delivery.v0";
  patchVersionId: string;
  runId: string;
  parentPatchVersionId: string | null;
  status: string;
  selectedAt: string;
  artifactHashes: Record<string, string>;
  /** Authenticated binary delivery endpoint; never a server filesystem path. */
  downloadUrl: string;
  units: ApiPlayDeliveryUnit[];
};

// ---------------------------------------------------------------------------
// Node 11 — patch-version iteration wire shapes. These deliberately expose
// immutable identifiers and delivery hashes, never local artifact paths.
// ---------------------------------------------------------------------------

/**
 * Exact immutable-version delivery. Unlike `ApiPlayDeliveryResponse`, this
 * remains available after a newer version becomes the selected run delivery.
 */
export type ApiPatchIterationDeliveryResponse = {
  schemaVersion: "itotori.patch-iteration.delivery.v0";
  patchVersionId: string;
  runId: string;
  parentPatchVersionId: string | null;
  origin: "run_finalizer" | "play_tester_edit" | "refinement_run";
  status: "playable";
  playableAt: string;
  artifactHashes: Record<string, string>;
  /** Authenticated exact-version archive endpoint; never a server path. */
  downloadUrl: string;
  units: ApiPlayDeliveryUnit[];
};

export type ApiPatchIterationQaCallout = {
  journalFindingId: string;
  bridgeUnitId: string;
  severity: string;
  category: string;
  note: string;
  confidence: string;
  contested: boolean;
  informational: true;
};

export type ApiPatchIterationUnit = {
  bridgeUnitId: string;
  sourceRunId: string;
  journalOutcomeId: string;
  resultRevisionId: string;
  targetBody: string;
  memberOrigin: "run_written_outcome" | "reused_from_base" | "play_tester_edit";
  reusedFromPatchVersionId: string | null;
  unitOrdinal: number;
};

export type ApiPatchIterationPatch = {
  patchVersionId: string;
  runId: string;
  parentPatchVersionId: string | null;
  origin: "run_finalizer" | "play_tester_edit" | "refinement_run";
  status: string;
  playableAt: string | null;
  selectedAt: string | null;
  artifactHashes: Record<string, string>;
  units: ApiPatchIterationUnit[];
  qaCallouts: ApiPatchIterationQaCallout[];
};

export type ApiPatchIterationVersion = {
  patchVersionId: string;
  runId: string;
  parentPatchVersionId: string | null;
  origin: "run_finalizer" | "play_tester_edit" | "refinement_run";
  status: string;
  playableAt: string | null;
  selectedAt: string | null;
  artifactHashes: Record<string, string>;
  basePatchVersionId: string | null;
};

export type ApiPatchIterationFeedbackEvent = {
  feedbackEventId: string;
  feedbackBatchId: string;
  observedPatchVersionId: string;
  playSessionId: string | null;
  actorUserId: string;
  eventKind: "result_edit" | "comment" | "added_context" | "wiki_edit";
  body: string | null;
  metadata: Record<string, unknown>;
  resultRevisionId: string | null;
  contextArtifactId: string | null;
  contextEntryVersionId: string | null;
  affectedBridgeUnitIds: string[];
  createdAt: string;
};

export type ApiPatchIterationFeedbackBatch = {
  feedbackBatchId: string;
  observedPatchVersionId: string;
  actorUserId: string;
  selectionKind: "individual" | "batch";
  label: string | null;
  createdAt: string;
  updatedAt: string;
  events: ApiPatchIterationFeedbackEvent[];
};

export type ApiPatchIterationFeedbackInbox = {
  observedPatchVersionId: string;
  batches: ApiPatchIterationFeedbackBatch[];
};

export type ApiPatchIterationSession = {
  playSessionId: string;
  observedPatchVersionId: string;
  actorUserId: string;
  status: "active" | "completed" | "abandoned";
  startedAt: string;
  endedAt: string | null;
  qaCallouts: ApiPatchIterationQaCallout[];
};

export type ApiPatchIterationRefinementMember = {
  bridgeUnitId: string;
  strategy: "reuse" | "redraft" | "new_scope";
  basePatchVersionId: string | null;
  baseSourceRunId: string | null;
  baseJournalOutcomeId: string | null;
  baseResultRevisionId: string | null;
};

export type ApiPatchIterationRefinement = {
  runId: string;
  basePatchVersionId: string;
  feedbackBatchIds: string[];
  wikiHeads: Array<{ contextArtifactId: string; contextEntryVersionId: string }>;
  members: ApiPatchIterationRefinementMember[];
};

export type ApiPatchIterationVersionsResponse = {
  schemaVersion: "itotori.patch-iteration.versions.v0";
  versions: ApiPatchIterationVersion[];
};

export type ApiPatchIterationSurfaceResponse = {
  schemaVersion: "itotori.patch-iteration.surface.v0";
  patch: ApiPatchIterationPatch;
  versions: ApiPatchIterationVersion[];
  feedback: ApiPatchIterationFeedbackInbox;
};

export type ApiPatchIterationPlayRequest = {
  launchDescriptor?: Record<string, unknown>;
};

export type ApiPatchIterationPlayResponse = {
  schemaVersion: "itotori.patch-iteration.play.v0";
  session: ApiPatchIterationSession;
};

export type ApiPatchIterationFeedbackBatchRequest = {
  feedbackBatchId?: string;
  label?: string;
};

export type ApiPatchIterationFeedbackBatchResponse = {
  schemaVersion: "itotori.patch-iteration.feedback-batch.v0";
  batch: ApiPatchIterationFeedbackBatch;
};

/**
 * A first-class context correction performed through the existing WikiBrain
 * boundary. The observed patch supplies project/branch/source identity; this
 * payload intentionally contains only the human correction itself.
 */
export type ApiPatchIterationContextFeedback =
  | {
      operation: "add";
      kind: ApiWikiAddKind;
      title: string;
      body: string;
      reason: string;
      affectedBridgeUnitIds: string[];
    }
  | {
      operation: "edit";
      contextArtifactId: string;
      body: string;
      reason: string;
      title?: string;
      affectedBridgeUnitIds?: string[];
    };

export type ApiPatchIterationFeedbackRequest = {
  feedbackBatchId?: string;
  playSessionId?: string;
  eventKind: ApiPatchIterationFeedbackEvent["eventKind"];
  body?: string;
  metadata?: Record<string, unknown>;
  targetBody?: string;
  resultRevisionId?: string;
  contextArtifactId?: string;
  contextEntryVersionId?: string;
  contextFeedback?: ApiPatchIterationContextFeedback;
  affectedBridgeUnitIds?: string[];
};

export type ApiPatchIterationFeedbackResponse = {
  schemaVersion: "itotori.patch-iteration.feedback.v0";
  feedback: ApiPatchIterationFeedbackEvent;
};

export type ApiPatchIterationRefineRequest = {
  feedbackBatchIds?: string[];
  feedbackEventIds?: string[];
  scopeUnitIds?: string[];
  targetBodiesByUnit?: Record<string, string>;
  wikiHeads?: Array<{ contextArtifactId: string; contextEntryVersionId: string }>;
};

export type ApiPatchIterationRefineResponse = {
  schemaVersion: "itotori.patch-iteration.refine.v0";
  refinement: ApiPatchIterationRefinement;
  patch: ApiPatchIterationPatch;
};

export type ItotoriApiResponseBody =
  | ApiAssetDecisionsResponse
  | ApiCandidateAssetsResponse
  | ApiCatalogBenchmarkSeedsResponse
  | ApiCatalogContextPanelResponse
  | ApiCatalogCompletenessResponse
  | ApiCatalogConflictReviewResponse
  | ApiCatalogOpportunitiesResponse
  | ApiTerminologySearchResponse
  | ApiWikiListResponse
  | ApiWikiShowResponse
  | ApiWikiHistoryResponse
  | ApiWikiEditResponse
  | ApiWikiAddResponse
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
  | ApiProjectDecodeExtractResponse
  | ApiProjectImportResponse
  | ApiDraftBranchResponse
  | ApiRecordFindingResponse
  | ApiRecordBenchmarkResponse
  | ApiRuntimeEvidenceResponse
  | ApiModelRoutingSettingsResponse
  | ApiBranchPolicySettingsResponse
  | ApiTranslationScopeSettingsResponse
  | ApiLocalizationRunConfigResponse
  | ApiConfigureAuthSsoSettingsResponse
  | ApiMemberInvitationResponse
  | ApiMemberResponse
  | ApiMembersListResponse
  | ApiAuthBillingSeatUsageResponse
  | ApiRemoveMemberResponse
  | ApiPermissionSetsListResponse
  | ApiPrincipalPermissionSetGrantResponse
  | ApiAuthSessionsListResponse
  | ApiRevokeAuthSessionResponse
  | ApiAuthIdentityResponse
  | ApiAuthCapabilitiesResponse
  | ApiLaunchPassResponse
  | ApiPlayRouteMapResponse
  | ApiPlayFlagAnnotationResponse
  | ApiPlayTargetEditResponse
  | ApiPlayDeliveryResponse
  | ApiPatchIterationVersionsResponse
  | ApiPatchIterationSurfaceResponse
  | ApiPatchIterationDeliveryResponse
  | ApiPatchIterationPlayResponse
  | ApiPatchIterationFeedbackBatchResponse
  | ApiPatchIterationFeedbackResponse
  | ApiPatchIterationRefineResponse
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
    const bootstrapSelection =
      request.bootstrapSelection === undefined
        ? undefined
        : parseBootstrapCatalogSelection(request.bootstrapSelection, request.bridge);
    return {
      bridge: request.bridge,
      ...(bootstrapSelection === undefined ? {} : { bootstrapSelection }),
    };
  });
}

export function parseProjectDecodeExtractRequest(body: unknown): ApiProjectDecodeExtractRequest {
  return parseRequest("ApiProjectDecodeExtractRequest", () => {
    const request = asRecord(body, "ApiProjectDecodeExtractRequest");
    // Identity — the four required RealLive metadata fields.
    assertString(request.gameId, "ApiProjectDecodeExtractRequest.gameId");
    assertString(request.gameVersion, "ApiProjectDecodeExtractRequest.gameVersion");
    assertString(request.sourceProfileId, "ApiProjectDecodeExtractRequest.sourceProfileId");
    assertString(request.sourceLocale, "ApiProjectDecodeExtractRequest.sourceLocale");
    // Sourcing — exactly one of vaultCanonicalId / gameRoot must be provided.
    if (request.vaultCanonicalId !== undefined) {
      assertString(request.vaultCanonicalId, "ApiProjectDecodeExtractRequest.vaultCanonicalId");
    }
    if (request.gameRoot !== undefined) {
      assertString(request.gameRoot, "ApiProjectDecodeExtractRequest.gameRoot");
    }
    const hasVault =
      typeof request.vaultCanonicalId === "string" && request.vaultCanonicalId.length > 0;
    const hasGameRoot = typeof request.gameRoot === "string" && request.gameRoot.length > 0;
    if (hasVault === hasGameRoot) {
      throw new Error(
        "ApiProjectDecodeExtractRequest sourcing requires EXACTLY ONE of vaultCanonicalId or gameRoot",
      );
    }
    // Mode — exactly one of scene (u16) / wholeSeen must be selected.
    const wholeSeen = request.wholeSeen === true;
    const hasScene = request.scene !== undefined;
    if (wholeSeen === hasScene) {
      throw new Error(
        "ApiProjectDecodeExtractRequest requires EXACTLY ONE decode mode: scene (u16) or wholeSeen",
      );
    }
    let scene: number | undefined;
    if (hasScene) {
      const value = request.scene;
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 65_535) {
        throw new Error("ApiProjectDecodeExtractRequest.scene must be a u16 (0..65535)");
      }
      scene = value;
    }
    return {
      gameId: request.gameId,
      gameVersion: request.gameVersion,
      sourceProfileId: request.sourceProfileId,
      sourceLocale: request.sourceLocale,
      ...(hasVault ? { vaultCanonicalId: request.vaultCanonicalId as string } : {}),
      ...(hasGameRoot ? { gameRoot: request.gameRoot as string } : {}),
      ...(scene !== undefined ? { scene } : {}),
      ...(wholeSeen ? { wholeSeen: true } : {}),
    };
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

function parseBootstrapCatalogSelection(
  value: unknown,
  bridge: BridgeBundle | BridgeBundleV02,
): ApiBootstrapCatalogSelection {
  const selection = asStrictRecord(value, "ApiBootstrapCatalogSelection", [
    "selectedWorkId",
    "candidates",
  ]);
  assertString(selection.selectedWorkId, "ApiBootstrapCatalogSelection.selectedWorkId");
  const candidates = parseBootstrapCatalogCandidates(
    selection.candidates,
    "ApiBootstrapCatalogSelection.candidates",
  );
  const parsed = { selectedWorkId: selection.selectedWorkId, candidates };
  assertBootstrapSelectionMatchesBridge(parsed, bridge);
  return parsed;
}

function parseBootstrapCatalogCandidates(
  value: unknown,
  label: string,
): ApiBootstrapCatalogCandidate[] {
  const rows = asArray(value, label);
  if (rows.length === 0) {
    throw new Error(`${label} must include at least one candidate`);
  }
  return rows.map((candidateValue, index) => {
    const candidateLabel = `${label}[${index}]`;
    const candidate = asStrictRecord(candidateValue, candidateLabel, [
      "workId",
      "canonicalTitle",
      "sourceIds",
      "adapterId",
    ]);
    assertPublicOpportunityString(candidate.workId, `${candidateLabel}.workId`);
    assertPublicOpportunityString(candidate.canonicalTitle, `${candidateLabel}.canonicalTitle`);
    assertCatalogBenchmarkSeedSourceIds(candidate.sourceIds, `${candidateLabel}.sourceIds`);
    assertNullablePublicOpportunityString(candidate.adapterId, `${candidateLabel}.adapterId`);
    return {
      workId: candidate.workId,
      canonicalTitle: candidate.canonicalTitle,
      sourceIds: candidate.sourceIds as ApiBootstrapCatalogSourceId[],
      adapterId: candidate.adapterId,
    };
  });
}

function assertBootstrapSelectionMatchesBridge(
  selection: ApiBootstrapCatalogSelection,
  bridge: BridgeBundle | BridgeBundleV02,
): void {
  const selected = selection.candidates.find(
    (candidate) => candidate.workId === selection.selectedWorkId,
  );
  if (selected === undefined) {
    throw new Error("ApiBootstrapCatalogSelection.selectedWorkId must identify a candidate");
  }

  if (bridge.schemaVersion !== BRIDGE_SCHEMA_VERSION_V02) {
    return;
  }

  const bridgeIdentity = bridgeSourceIdentityValues(bridge);
  const selectedIdentity = catalogCandidateIdentityValues(selected);
  if (intersects(bridgeIdentity, selectedIdentity)) {
    return;
  }

  throw new Error("Selected catalog candidate does not match the uploaded bridge source identity");
}

function bridgeSourceIdentityValues(bridge: BridgeBundleV02): Set<string> {
  return new Set([bridge.sourceGame.gameId]);
}

function catalogCandidateIdentityValues(candidate: ApiBootstrapCatalogCandidate): Set<string> {
  return new Set([
    candidate.workId,
    ...candidate.sourceIds.flatMap((sourceId) => [
      sourceId.sourceId,
      `${sourceId.catalogSource}:${sourceId.sourceId}`,
    ]),
  ]);
}

function intersects(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) {
    if (right.has(value)) {
      return true;
    }
  }
  return false;
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

export function parseSaveModelRoutingSettingsRequest(
  body: unknown,
): ApiSaveModelRoutingSettingsRequest {
  return parseRequest("ApiSaveModelRoutingSettingsRequest", () => {
    const request = asStrictRecord(
      body,
      "ApiSaveModelRoutingSettingsRequest",
      ITOTORI_STRICT_API_BODY_KEYS.ApiSaveModelRoutingSettingsRequest,
    );
    assertString(request.projectId, "ApiSaveModelRoutingSettingsRequest.projectId");
    assertString(request.taskKind, "ApiSaveModelRoutingSettingsRequest.taskKind");
    assertString(request.providerId, "ApiSaveModelRoutingSettingsRequest.providerId");
    assertString(request.modelId, "ApiSaveModelRoutingSettingsRequest.modelId");
    assertStringArray(
      request.fallbackModelIds,
      "ApiSaveModelRoutingSettingsRequest.fallbackModelIds",
    );
    const fallbackModelIds = asArray(
      request.fallbackModelIds,
      "ApiSaveModelRoutingSettingsRequest.fallbackModelIds",
    ) as string[];
    assertString(request.promptPresetId, "ApiSaveModelRoutingSettingsRequest.promptPresetId");
    assertString(
      request.promptTemplateVersion,
      "ApiSaveModelRoutingSettingsRequest.promptTemplateVersion",
    );
    return {
      projectId: request.projectId,
      taskKind: request.taskKind,
      providerId: request.providerId,
      modelId: request.modelId,
      fallbackModelIds: [...fallbackModelIds],
      promptPresetId: request.promptPresetId,
      promptTemplateVersion: request.promptTemplateVersion,
    };
  });
}

export function parseSaveBranchPolicySettingsRequest(
  body: unknown,
): ApiSaveBranchPolicySettingsRequest {
  return parseRequest("ApiSaveBranchPolicySettingsRequest", () => {
    const request = asStrictRecord(
      body,
      "ApiSaveBranchPolicySettingsRequest",
      ITOTORI_STRICT_API_BODY_KEYS.ApiSaveBranchPolicySettingsRequest,
    );
    assertString(request.projectId, "ApiSaveBranchPolicySettingsRequest.projectId");
    assertString(request.localeBranchId, "ApiSaveBranchPolicySettingsRequest.localeBranchId");
    assertNullableString(
      request.expectedPreviousVersionId,
      "ApiSaveBranchPolicySettingsRequest.expectedPreviousVersionId",
    );
    assertString(request.updateReason, "ApiSaveBranchPolicySettingsRequest.updateReason");
    return {
      projectId: request.projectId,
      localeBranchId: request.localeBranchId,
      expectedPreviousVersionId: request.expectedPreviousVersionId,
      updateReason: request.updateReason,
      policy: parseBranchPolicyPolicy(request.policy, "ApiSaveBranchPolicySettingsRequest.policy"),
    };
  });
}

export function parseSaveTranslationScopeSettingsRequest(
  body: unknown,
): ApiSaveTranslationScopeSettingsRequest {
  return parseRequest("ApiSaveTranslationScopeSettingsRequest", () => {
    const request = asStrictRecord(
      body,
      "ApiSaveTranslationScopeSettingsRequest",
      ITOTORI_STRICT_API_BODY_KEYS.ApiSaveTranslationScopeSettingsRequest,
    );
    assertString(request.projectId, "ApiSaveTranslationScopeSettingsRequest.projectId");
    assertString(request.localeBranchId, "ApiSaveTranslationScopeSettingsRequest.localeBranchId");
    assertEnum(
      request.scope,
      Object.values(translationScopeValues) as ApiTranslationScope[],
      "ApiSaveTranslationScopeSettingsRequest.scope",
    );
    return {
      projectId: request.projectId,
      localeBranchId: request.localeBranchId,
      scope: request.scope,
    };
  });
}

export function parseSaveLocalizationRunConfigRequest(
  body: unknown,
): ApiSaveLocalizationRunConfigRequest {
  return parseRequest("ApiSaveLocalizationRunConfigRequest", () => {
    const request = asStrictRecord(
      body,
      "ApiSaveLocalizationRunConfigRequest",
      ITOTORI_STRICT_API_BODY_KEYS.ApiSaveLocalizationRunConfigRequest,
    );
    const stringFields = [
      "projectId",
      "localeBranchId",
      "configPath",
      "dataRoot",
      "pairPolicyPath",
      "modelId",
      "providerId",
      "runDir",
    ] as const;
    const stringField = (field: (typeof stringFields)[number]): string => {
      const value = request[field];
      assertString(value, `ApiSaveLocalizationRunConfigRequest.${field}`);
      return value;
    };
    return {
      projectId: stringField("projectId"),
      localeBranchId: stringField("localeBranchId"),
      configPath: stringField("configPath"),
      dataRoot: stringField("dataRoot"),
      pairPolicyPath: stringField("pairPolicyPath"),
      modelId: stringField("modelId"),
      providerId: stringField("providerId"),
      runDir: stringField("runDir"),
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

export function parsePrincipalPermissionSetGrantRequest(
  body: unknown,
): ApiPrincipalPermissionSetGrantRequest {
  return parseRequest("ApiPrincipalPermissionSetGrantRequest", () => {
    const request = asStrictRecord(
      body,
      "ApiPrincipalPermissionSetGrantRequest",
      ITOTORI_STRICT_API_BODY_KEYS.ApiPrincipalPermissionSetGrantRequest,
    );
    assertNullableString(request.reason, "ApiPrincipalPermissionSetGrantRequest.reason");
    assertNullableString(request.requestId, "ApiPrincipalPermissionSetGrantRequest.requestId");
    return { reason: request.reason, requestId: request.requestId };
  });
}

export function parseRevokeAuthSessionRequest(body: unknown): ApiRevokeAuthSessionRequest {
  return parseRequest("ApiRevokeAuthSessionRequest", () => {
    const request = asStrictRecord(
      body,
      "ApiRevokeAuthSessionRequest",
      ITOTORI_STRICT_API_BODY_KEYS.ApiRevokeAuthSessionRequest,
    );
    assertNullableString(request.reason, "ApiRevokeAuthSessionRequest.reason");
    assertNullableString(request.requestId, "ApiRevokeAuthSessionRequest.requestId");
    return { reason: request.reason, requestId: request.requestId };
  });
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
    case "catalog.contextPanel":
      assertCatalogContextPanelReadModel(value);
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
    case "terminology.search":
      assertTerminologySearchReadModel(value);
      return;
    case "wiki.list":
      assertWikiListResponse(value);
      return;
    case "wiki.show":
      assertWikiShowResponse(value);
      return;
    case "wiki.history":
      assertWikiHistoryResponse(value);
      return;
    case "wiki.edit":
      assertWikiEditResponse(value);
      return;
    case "wiki.add":
      assertWikiEditResponse(value);
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
    case "projects.decodeExtract":
      assertProjectDecodeExtractResponse(value);
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
    case "benchmarks.record":
      assertRecordBenchmarkResponse(value);
      return;
    case "runtimeEvidence.ingest":
      assertRuntimeEvidenceResponse(value);
      return;
    case "settings.modelRouting.get":
    case "settings.modelRouting.save":
      assertModelRoutingSettingsResponse(value);
      return;
    case "settings.branchPolicy.get":
    case "settings.branchPolicy.save":
      assertBranchPolicySettingsResponse(value);
      return;
    case "settings.translationScope.get":
    case "settings.translationScope.save":
      assertTranslationScopeSettingsResponse(value);
      return;
    case "settings.localizationRunConfig.save":
      assertLocalizationRunConfigResponse(value);
      return;
    case "auth.ssoSettings.configure":
      assertConfigureAuthSsoSettingsResponse(value);
      return;
    case "auth.billing.seatUsage":
      assertAuthBillingSeatUsageResponse(value);
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
    case "auth.permissionSets.list":
      assertPermissionSetsListResponse(value);
      return;
    case "auth.permissionSets.grant":
    case "auth.permissionSets.revoke":
      assertPrincipalPermissionSetGrantResponse(value);
      return;
    case "auth.sessions.list":
      assertAuthSessionsListResponse(value);
      return;
    case "auth.sessions.revoke":
      assertRevokeAuthSessionResponse(value);
      return;
    case "auth.identity":
      assertAuthIdentityResponse(value);
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
    case "play.flagAnnotation":
      assertPlayFlagAnnotationResponse(value);
      return;
    case "play.targetEdit":
      assertPlayTargetEditResponse(value);
      return;
    case "play.delivery":
      assertPlayDeliveryResponse(value);
      return;
    case "patchIteration.versions":
      assertPatchIterationVersionsResponse(value);
      return;
    case "patchIteration.surface":
      assertPatchIterationSurfaceResponse(value);
      return;
    case "patchIteration.delivery":
      assertPatchIterationDeliveryResponse(value);
      return;
    case "patchIteration.play":
      assertPatchIterationPlayResponse(value);
      return;
    case "patchIteration.feedbackBatch":
      assertPatchIterationFeedbackBatchResponse(value);
      return;
    case "patchIteration.feedback":
      assertPatchIterationFeedbackResponse(value);
      return;
    case "patchIteration.refine":
      assertPatchIterationRefineResponse(value);
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

const wikiContextArtifactCategoryList = [
  "scene_summary",
  "character_note",
  "route_map",
  "speaker_label",
  "terminology_candidate",
  "glossary",
  "style",
  "context_note",
] as const;

const wikiContextArtifactStatusList = ["active", "stale", "superseded", "rejected"] as const;

/** Assert the generic node-6 context-brain list response used by `wiki.list`. */
export function assertWikiListResponse(
  value: unknown,
  label = "WikiContextEntriesReadModel",
): asserts value is ApiWikiListResponse {
  const model = asStrictRecord(
    value,
    label,
    ITOTORI_STRICT_API_BODY_KEYS.WikiContextEntriesReadModel,
  );
  assertLiteral(model.schemaVersion, "wiki.context.entries.v0.1", `${label}.schemaVersion`);
  assertDateLike(model.generatedAt, `${label}.generatedAt`);
  const filter = asStrictRecord(model.filter, `${label}.filter`, [
    "projectId",
    "localeBranchId",
    "sourceRevisionId",
    "kind",
    "includeStale",
  ]);
  assertString(filter.projectId, `${label}.filter.projectId`);
  assertString(filter.localeBranchId, `${label}.filter.localeBranchId`);
  assertNullableString(filter.sourceRevisionId, `${label}.filter.sourceRevisionId`);
  if (filter.kind !== null) {
    assertEnum(filter.kind, wikiContextEntryKindList, `${label}.filter.kind`);
  }
  assertBoolean(filter.includeStale, `${label}.filter.includeStale`);
  assertWikiContextPagination(model.pagination, `${label}.pagination`);
  const entries = asArray(model.entries, `${label}.entries`);
  for (const [index, entry] of entries.entries()) {
    assertWikiContextEntry(entry, `${label}.entries[${index}]`);
  }
}

/** Assert detail/content/provenance/history returned by `wiki.show`. */
export function assertWikiShowResponse(
  value: unknown,
  label = "WikiContextEntryReadModel",
): asserts value is ApiWikiShowResponse {
  const model = asStrictRecord(
    value,
    label,
    ITOTORI_STRICT_API_BODY_KEYS.WikiContextEntryReadModel,
  );
  assertLiteral(model.schemaVersion, "wiki.context.entry.v0.1", `${label}.schemaVersion`);
  assertDateLike(model.generatedAt, `${label}.generatedAt`);
  assertWikiContextEntry(model.entry, `${label}.entry`, { includesHistory: true });
}

/** Assert immutable context-entry lineage returned by `wiki.history`. */
export function assertWikiHistoryResponse(
  value: unknown,
  label = "WikiContextEntryHistoryReadModel",
): asserts value is ApiWikiHistoryResponse {
  const model = asStrictRecord(
    value,
    label,
    ITOTORI_STRICT_API_BODY_KEYS.WikiContextEntryHistoryReadModel,
  );
  assertLiteral(model.schemaVersion, "wiki.context.entry-history.v0.1", `${label}.schemaVersion`);
  assertDateLike(model.generatedAt, `${label}.generatedAt`);
  assertString(model.contextArtifactId, `${label}.contextArtifactId`);
  assertNullableString(model.headVersionId, `${label}.headVersionId`);
  const versions = asArray(model.versions, `${label}.versions`);
  for (const [index, version] of versions.entries()) {
    assertWikiContextEntryVersion(version, `${label}.versions[${index}]`);
  }
}

/** Assert the durable correction/writeback receipt returned by `wiki.edit`. */
export function assertWikiEditResponse(
  value: unknown,
  label = "ApiWikiEditResponse",
): asserts value is ApiWikiEditResponse {
  const response = asStrictRecord(value, label, ITOTORI_STRICT_API_BODY_KEYS.ApiWikiEditResponse);
  assertLiteral(response.schemaVersion, "wiki.context.edit.v0.2", `${label}.schemaVersion`);
  assertDateLike(response.generatedAt, `${label}.generatedAt`);
  assertString(response.correctionId, `${label}.correctionId`);
  assertString(response.contextArtifactId, `${label}.contextArtifactId`);
  assertString(response.contextEntryVersionId, `${label}.contextEntryVersionId`);
  assertStringArray(response.affectedUnitIds, `${label}.affectedUnitIds`);
  assertStringArray(response.invalidatedArtifactIds, `${label}.invalidatedArtifactIds`);
  assertString(response.redraftJobId, `${label}.redraftJobId`);
  assertContextCorrectionRerunStatus(response.rerun, `${label}.rerun`);
  assertWikiContextEntry(response.entry, `${label}.entry`, { includesHistory: true });
}

function assertContextCorrectionRerunStatus(value: unknown, label: string): void {
  const rerun = asStrictRecord(value, label, ["state", "jobStatus", "error"]);
  assertEnum(rerun.state, ["succeeded", "pending", "failed"] as const, `${label}.state`);
  assertNullableString(rerun.error, `${label}.error`);
  switch (rerun.state) {
    case "succeeded":
      assertLiteral(rerun.jobStatus, "succeeded", `${label}.jobStatus`);
      if (rerun.error !== null) {
        throw new Error(`${label}.error must be null when rerun.state is succeeded`);
      }
      return;
    case "pending":
      assertEnum(
        rerun.jobStatus,
        ["queued", "running", "retry_waiting"] as const,
        `${label}.jobStatus`,
      );
      return;
    case "failed":
      assertEnum(rerun.jobStatus, ["dead_letter", "cancelled"] as const, `${label}.jobStatus`);
      return;
  }
}

/** Parse the only client-controlled fields of an existing canonical wiki edit. */
export function parseWikiEditRequest(body: unknown): ApiWikiEditRequest {
  return parseRequest("ApiWikiEditRequest", () => {
    const request = asStrictRecord(body, "ApiWikiEditRequest", [
      "body",
      "reason",
      "title",
      "affectedUnitIds",
    ]);
    assertString(request.body, "ApiWikiEditRequest.body");
    assertString(request.reason, "ApiWikiEditRequest.reason");
    const parsed: ApiWikiEditRequest = {
      body: request.body.trim(),
      reason: request.reason.trim(),
    };
    if (parsed.body.length === 0) {
      throw new Error("ApiWikiEditRequest.body must be non-blank");
    }
    if (parsed.reason.length === 0) {
      throw new Error("ApiWikiEditRequest.reason must be non-blank");
    }
    if (request.title !== undefined) {
      assertString(request.title, "ApiWikiEditRequest.title");
      const title = request.title.trim();
      if (title.length === 0) {
        throw new Error("ApiWikiEditRequest.title must be non-blank");
      }
      parsed.title = title;
    }
    if (request.affectedUnitIds !== undefined) {
      const values = asArray(request.affectedUnitIds, "ApiWikiEditRequest.affectedUnitIds");
      parsed.affectedUnitIds = values.map((value, index) => {
        assertString(value, `ApiWikiEditRequest.affectedUnitIds[${index}]`);
        const unitId = value.trim();
        if (unitId.length === 0) {
          throw new Error(`ApiWikiEditRequest.affectedUnitIds[${index}] must be non-blank`);
        }
        return unitId;
      });
    }
    return parsed;
  });
}

/** Parse a new note/glossary/style entry with an explicit source-unit scope. */
export function parseWikiAddRequest(body: unknown): ApiWikiAddRequest {
  return parseRequest("ApiWikiAddRequest", () => {
    const request = asStrictRecord(body, "ApiWikiAddRequest", [
      "sourceRevisionId",
      "kind",
      "title",
      "body",
      "reason",
      "affectedUnitIds",
    ]);
    assertString(request.sourceRevisionId, "ApiWikiAddRequest.sourceRevisionId");
    assertEnum(request.kind, ["note", "glossary", "style"] as const, "ApiWikiAddRequest.kind");
    assertString(request.title, "ApiWikiAddRequest.title");
    assertString(request.body, "ApiWikiAddRequest.body");
    assertString(request.reason, "ApiWikiAddRequest.reason");
    const affectedUnitIds = asArray(
      request.affectedUnitIds,
      "ApiWikiAddRequest.affectedUnitIds",
    ).map((value, index) => {
      assertString(value, `ApiWikiAddRequest.affectedUnitIds[${index}]`);
      const unitId = value.trim();
      if (unitId.length === 0) {
        throw new Error(`ApiWikiAddRequest.affectedUnitIds[${index}] must be non-blank`);
      }
      return unitId;
    });
    if (affectedUnitIds.length === 0) {
      throw new Error("ApiWikiAddRequest.affectedUnitIds must contain at least one unit");
    }
    const parsed = {
      sourceRevisionId: request.sourceRevisionId.trim(),
      kind: request.kind,
      title: request.title.trim(),
      body: request.body.trim(),
      reason: request.reason.trim(),
      affectedUnitIds,
    };
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.length === 0) {
        throw new Error(`ApiWikiAddRequest.${key} must be non-blank`);
      }
    }
    return parsed;
  });
}

function assertWikiContextPagination(value: unknown, label: string): void {
  const pagination = asStrictRecord(value, label, [
    "total",
    "limit",
    "offset",
    "hasMore",
    "nextOffset",
  ]);
  assertNonNegativeInteger(pagination.total, `${label}.total`);
  assertPositiveInteger(pagination.limit, `${label}.limit`);
  assertNonNegativeInteger(pagination.offset, `${label}.offset`);
  assertBoolean(pagination.hasMore, `${label}.hasMore`);
  if (pagination.nextOffset !== null) {
    assertNonNegativeInteger(pagination.nextOffset, `${label}.nextOffset`);
  }
}

function assertWikiContextEntry(
  value: unknown,
  label: string,
  options: { includesHistory?: boolean } = {},
): void {
  const entry = asStrictRecord(value, label, [
    "contextArtifactId",
    "projectId",
    "localeBranchId",
    "sourceRevisionId",
    "category",
    "kind",
    "status",
    "title",
    "body",
    "data",
    "contentHash",
    "headVersionId",
    "versionCount",
    "provenance",
    "citations",
    "impact",
    "createdAt",
    "updatedAt",
    ...(options.includesHistory === true ? ["history"] : []),
  ]);
  assertString(entry.contextArtifactId, `${label}.contextArtifactId`);
  assertString(entry.projectId, `${label}.projectId`);
  assertString(entry.localeBranchId, `${label}.localeBranchId`);
  assertString(entry.sourceRevisionId, `${label}.sourceRevisionId`);
  assertEnum(entry.category, wikiContextArtifactCategoryList, `${label}.category`);
  assertEnum(entry.kind, wikiContextEntryKindList, `${label}.kind`);
  assertEnum(entry.status, wikiContextArtifactStatusList, `${label}.status`);
  assertString(entry.title, `${label}.title`);
  assertString(entry.body, `${label}.body`);
  asRecord(entry.data, `${label}.data`);
  assertString(entry.contentHash, `${label}.contentHash`);
  assertNullableString(entry.headVersionId, `${label}.headVersionId`);
  assertNonNegativeInteger(entry.versionCount, `${label}.versionCount`);
  assertWikiContextProvenance(entry.provenance, `${label}.provenance`);
  const citations = asArray(entry.citations, `${label}.citations`);
  for (const [index, citation] of citations.entries()) {
    assertWikiContextCitation(citation, `${label}.citations[${index}]`);
  }
  assertWikiContextImpact(entry.impact, `${label}.impact`);
  assertDateLike(entry.createdAt, `${label}.createdAt`);
  assertDateLike(entry.updatedAt, `${label}.updatedAt`);
  if (options.includesHistory === true) {
    const history = asArray(entry.history, `${label}.history`);
    for (const [index, version] of history.entries()) {
      assertWikiContextEntryVersion(version, `${label}.history[${index}]`);
    }
  }
}

function assertWikiContextEntryVersion(value: unknown, label: string): void {
  const version = asStrictRecord(value, label, [
    "contextEntryVersionId",
    "contextArtifactId",
    "parentVersionId",
    "projectId",
    "localeBranchId",
    "sourceRevisionId",
    "category",
    "kind",
    "status",
    "title",
    "body",
    "data",
    "contentHash",
    "provenance",
    "citations",
    "impact",
    "createdAt",
    "isHead",
  ]);
  assertString(version.contextEntryVersionId, `${label}.contextEntryVersionId`);
  assertString(version.contextArtifactId, `${label}.contextArtifactId`);
  assertNullableString(version.parentVersionId, `${label}.parentVersionId`);
  assertString(version.projectId, `${label}.projectId`);
  assertString(version.localeBranchId, `${label}.localeBranchId`);
  assertString(version.sourceRevisionId, `${label}.sourceRevisionId`);
  assertEnum(version.category, wikiContextArtifactCategoryList, `${label}.category`);
  assertEnum(version.kind, wikiContextEntryKindList, `${label}.kind`);
  assertEnum(version.status, wikiContextArtifactStatusList, `${label}.status`);
  assertString(version.title, `${label}.title`);
  assertString(version.body, `${label}.body`);
  asRecord(version.data, `${label}.data`);
  assertString(version.contentHash, `${label}.contentHash`);
  assertWikiContextProvenance(version.provenance, `${label}.provenance`);
  const citations = asArray(version.citations, `${label}.citations`);
  for (const [index, citation] of citations.entries()) {
    assertWikiContextCitation(citation, `${label}.citations[${index}]`);
  }
  assertWikiContextImpact(version.impact, `${label}.impact`);
  assertDateLike(version.createdAt, `${label}.createdAt`);
  assertBoolean(version.isHead, `${label}.isHead`);
}

function assertWikiContextCitation(value: unknown, label: string): void {
  const citation = asStrictRecord(value, label, [
    "bridgeUnitId",
    "sourceRevisionId",
    "sourceHash",
    "citation",
    "metadata",
  ]);
  assertString(citation.bridgeUnitId, `${label}.bridgeUnitId`);
  assertString(citation.sourceRevisionId, `${label}.sourceRevisionId`);
  assertString(citation.sourceHash, `${label}.sourceHash`);
  assertString(citation.citation, `${label}.citation`);
  asRecord(citation.metadata, `${label}.metadata`);
}

function assertWikiContextProvenance(value: unknown, label: string): void {
  const provenance = asStrictRecord(value, label, [
    "producedByAgent",
    "producedByTool",
    "producerVersion",
    "createdByUserId",
    "origin",
    "runId",
    "providerRunId",
    "provenance",
  ]);
  assertNullableString(provenance.producedByAgent, `${label}.producedByAgent`);
  assertNullableString(provenance.producedByTool, `${label}.producedByTool`);
  assertString(provenance.producerVersion, `${label}.producerVersion`);
  assertNullableString(provenance.createdByUserId, `${label}.createdByUserId`);
  assertNullableString(provenance.origin, `${label}.origin`);
  assertNullableString(provenance.runId, `${label}.runId`);
  assertNullableString(provenance.providerRunId, `${label}.providerRunId`);
  asRecord(provenance.provenance, `${label}.provenance`);
}

function assertWikiContextImpact(value: unknown, label: string): void {
  const impact = asStrictRecord(value, label, [
    "affectedUnitIds",
    "invalidatedReason",
    "invalidatedAt",
  ]);
  assertStringArray(impact.affectedUnitIds, `${label}.affectedUnitIds`);
  assertNullableString(impact.invalidatedReason, `${label}.invalidatedReason`);
  assertNullableDateLike(impact.invalidatedAt, `${label}.invalidatedAt`);
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

export function assertCatalogContextPanelReadModel(
  value: unknown,
  label = "CatalogContextPanelReadModel",
): asserts value is CatalogContextPanelReadModel {
  const model = asStrictRecord(
    value,
    label,
    ITOTORI_STRICT_API_BODY_KEYS.CatalogContextPanelReadModel,
  );
  assertLiteral(model.schemaVersion, "catalog.context_panel_route.v0.1", `${label}.schemaVersion`);
  assertDateLike(model.generatedAt, `${label}.generatedAt`);
  const params = asStrictRecord(model.params, `${label}.params`, [
    "projectId",
    "localeBranchId",
    "workId",
  ]);
  assertPublicBenchmarkSeedString(params.projectId, `${label}.params.projectId`);
  assertPublicBenchmarkSeedString(params.localeBranchId, `${label}.params.localeBranchId`);
  assertPublicBenchmarkSeedString(params.workId, `${label}.params.workId`);
  assertCatalogBenchmarkSeedRow(model.row, `${label}.row`);
  assertCatalogReleaseRecords(model.releases, `${label}.releases`);
  const projectState = asStrictRecord(model.projectState, `${label}.projectState`, [
    "targetLanguage",
    "localeBranch",
  ]);
  assertPublicBenchmarkSeedString(
    projectState.targetLanguage,
    `${label}.projectState.targetLanguage`,
  );
  if (projectState.localeBranch !== null) {
    assertLocaleBranchStatus(projectState.localeBranch, `${label}.projectState.localeBranch`);
  }
}

function assertCatalogBenchmarkSeedRow(value: unknown, label: string): void {
  const row = asStrictRecord(value, label, [
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
  assertPublicBenchmarkSeedString(row.workId, `${label}.workId`);
  assertPublicBenchmarkSeedString(row.canonicalTitle, `${label}.canonicalTitle`);
  assertNullablePublicBenchmarkSeedString(row.originalLanguage, `${label}.originalLanguage`);
  assertCatalogBenchmarkSeedSourceIds(row.sourceIds, `${label}.sourceIds`);
  assertEnum(
    row.completenessPool,
    ["mtl_only", "fan_partial", "no_english", "unknown", "conflict"] as const,
    `${label}.completenessPool`,
  );
  assertCatalogBenchmarkSeedTranslationStatuses(
    row.translationStatuses,
    `${label}.translationStatuses`,
  );
  assertEnum(
    row.localOwnership,
    ["owned", "not_owned", "unknown"] as const,
    `${label}.localOwnership`,
  );
  assertNonNegativeNumber(row.localEvidenceCount, `${label}.localEvidenceCount`);
  assertEnum(
    row.demandBucket,
    ["none", "low", "medium", "high", "very_high"] as const,
    `${label}.demandBucket`,
  );
  assertCatalogBenchmarkSeedReadiness(row.readiness, `${label}.readiness`);
  assertCatalogBenchmarkSeedProvenance(row.provenance, `${label}.provenance`);
  assertEnum(
    row.decision,
    ["seed", "candidate", "demoted", "excluded"] as const,
    `${label}.decision`,
  );
  assertNonNegativeInteger(row.rank, `${label}.rank`);
  if (row.seedRank !== null) {
    assertNonNegativeInteger(row.seedRank, `${label}.seedRank`);
  }
  assertPublicBenchmarkSeedStringArray(row.explanationCodes, `${label}.explanationCodes`);
}

function assertCatalogReleaseRecords(value: unknown, label: string): void {
  const releases = asArray(value, label);
  for (const [index, releaseValue] of releases.entries()) {
    const releaseLabel = `${label}[${index}]`;
    const release = asStrictRecord(releaseValue, releaseLabel, [
      "releaseId",
      "workId",
      "catalogSource",
      "sourceReleaseId",
      "releaseTitle",
      "releaseKind",
      "editionName",
      "milestone",
      "packageKind",
      "engineName",
      "engineSource",
      "engineConfidence",
      "engineProvenanceId",
      "platform",
      "language",
      "releaseDate",
      "releaseYear",
      "isOfficial",
      "sourceProvenanceId",
      "metadata",
      "createdAt",
      "updatedAt",
    ]);
    assertPublicBenchmarkSeedString(release.releaseId, `${releaseLabel}.releaseId`);
    assertPublicBenchmarkSeedString(release.workId, `${releaseLabel}.workId`);
    assertEnum(
      release.catalogSource,
      Object.values(catalogSourceValues) as CatalogSource[],
      `${releaseLabel}.catalogSource`,
    );
    assertNullablePublicBenchmarkSeedString(
      release.sourceReleaseId,
      `${releaseLabel}.sourceReleaseId`,
    );
    assertPublicBenchmarkSeedString(release.releaseTitle, `${releaseLabel}.releaseTitle`);
    assertPublicBenchmarkSeedString(release.releaseKind, `${releaseLabel}.releaseKind`);
    assertNullablePublicBenchmarkSeedString(release.editionName, `${releaseLabel}.editionName`);
    assertNullablePublicBenchmarkSeedString(release.milestone, `${releaseLabel}.milestone`);
    assertPublicBenchmarkSeedString(release.packageKind, `${releaseLabel}.packageKind`);
    assertNullablePublicBenchmarkSeedString(release.engineName, `${releaseLabel}.engineName`);
    assertNullablePublicBenchmarkSeedString(release.engineSource, `${releaseLabel}.engineSource`);
    if (release.engineConfidence !== null) {
      assertEnum(
        release.engineConfidence,
        Object.values(catalogConfidenceValues) as CatalogConfidence[],
        `${releaseLabel}.engineConfidence`,
      );
    }
    assertNullablePublicBenchmarkSeedString(
      release.engineProvenanceId,
      `${releaseLabel}.engineProvenanceId`,
    );
    assertNullablePublicBenchmarkSeedString(release.platform, `${releaseLabel}.platform`);
    assertNullablePublicBenchmarkSeedString(release.language, `${releaseLabel}.language`);
    assertNullablePublicBenchmarkSeedString(release.releaseDate, `${releaseLabel}.releaseDate`);
    if (release.releaseYear !== null) {
      assertNonNegativeInteger(release.releaseYear, `${releaseLabel}.releaseYear`);
    }
    assertBoolean(release.isOfficial, `${releaseLabel}.isOfficial`);
    assertNullablePublicBenchmarkSeedString(
      release.sourceProvenanceId,
      `${releaseLabel}.sourceProvenanceId`,
    );
    asRecord(release.metadata, `${releaseLabel}.metadata`);
    assertDateLike(release.createdAt, `${releaseLabel}.createdAt`);
    assertDateLike(release.updatedAt, `${releaseLabel}.updatedAt`);
  }
}

function assertLocaleBranchStatus(value: unknown, label: string): void {
  const branch = asStrictRecord(value, label, [
    "localeBranchId",
    "targetLocale",
    "status",
    "currentStyleGuidePolicyVersionId",
    "unitCount",
    "translatedUnitCount",
    "openFindingCount",
    "artifactCount",
  ]);
  assertString(branch.localeBranchId, `${label}.localeBranchId`);
  assertString(branch.targetLocale, `${label}.targetLocale`);
  assertString(branch.status, `${label}.status`);
  assertNullableString(
    branch.currentStyleGuidePolicyVersionId,
    `${label}.currentStyleGuidePolicyVersionId`,
  );
  assertNonNegativeInteger(branch.unitCount, `${label}.unitCount`);
  assertNonNegativeInteger(branch.translatedUnitCount, `${label}.translatedUnitCount`);
  assertNonNegativeInteger(branch.openFindingCount, `${label}.openFindingCount`);
  assertNonNegativeInteger(branch.artifactCount, `${label}.artifactCount`);
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
  assertLiteral(model.schemaVersion, "jobs.run_table.v0.2", `${label}.schemaVersion`);
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
    "journalRunId",
    "attemptId",
    "providerRunId",
    "bridgeUnitId",
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
  assertString(row.journalRunId, `${label}.journalRunId`);
  assertString(row.attemptId, `${label}.attemptId`);
  assertString(row.providerRunId, `${label}.providerRunId`);
  assertString(row.bridgeUnitId, `${label}.bridgeUnitId`);
  assertString(row.projectId, `${label}.projectId`);
  assertString(row.localeBranchId, `${label}.localeBranchId`);
  assertString(row.task, `${label}.task`);
  assertString(row.status, `${label}.status`);
  assertString(row.servedModel, `${label}.servedModel`);
  assertString(row.servedProvider, `${label}.servedProvider`);
  assertBoolean(row.zdr, `${label}.zdr`);
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
  const fallback = asStrictRecord(value, label, ["availability", "used", "plan", "chain"]);
  assertEnum(fallback.availability, ["captured", "not_captured"] as const, `${label}.availability`);
  if (fallback.availability === "captured") {
    assertBoolean(fallback.used, `${label}.used`);
    for (const [index, entry] of asArray(fallback.plan, `${label}.plan`).entries()) {
      assertString(entry, `${label}.plan[${index}]`);
    }
  } else if (fallback.used !== null || fallback.plan !== null) {
    throw new Error(`${label} without captured fallback facts must use null used/plan`);
  }
  for (const [index, entry] of asArray(fallback.chain, `${label}.chain`).entries()) {
    assertString(entry, `${label}.chain[${index}]`);
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
  assertProjectTelemetryTimeseries(model.telemetry, `${label}.telemetry`);
  assertProjectCostDrilldownResponse(model.costDrilldown, `${label}.costDrilldown`);
  assertProjectOverviewJournalPage(model.journal, `${label}.journal`);
  assertProjectOverviewBenchmarkHeadline(model.benchmarkHeadline, `${label}.benchmarkHeadline`);
  // ovw-launch-pass-action — the server-derived steer capability the Overview
  // launch-pass action gates itself on.
  assertBoolean(model.canSteer, `${label}.canSteer`);
}

function assertProjectTelemetryTimeseries(
  value: unknown,
  label: string,
): asserts value is ProjectTelemetryTimeseries {
  const telemetry = asStrictRecord(value, label, [
    "projectId",
    "bucket",
    "rows",
    "throughputSeries",
    "costPerRunSeries",
  ]);
  assertString(telemetry.projectId, `${label}.projectId`);
  assertLiteral(telemetry.bucket, "day", `${label}.bucket`);
  const rows = asArray(telemetry.rows, `${label}.rows`);
  for (const [index, rowValue] of rows.entries()) {
    const row = asStrictRecord(rowValue, `${label}.rows[${index}]`, [
      "bucketStart",
      "runCount",
      "billedMicrosUsd",
      "costPerRunMicrosUsd",
    ]);
    assertDateLike(row.bucketStart, `${label}.rows[${index}].bucketStart`);
    assertNonNegativeInteger(row.runCount, `${label}.rows[${index}].runCount`);
    assertNonNegativeInteger(row.billedMicrosUsd, `${label}.rows[${index}].billedMicrosUsd`);
    assertNonNegativeNumber(row.costPerRunMicrosUsd, `${label}.rows[${index}].costPerRunMicrosUsd`);
  }
  const throughputSeries = assertNumberSeries(
    telemetry.throughputSeries,
    `${label}.throughputSeries`,
  );
  const costPerRunSeries = assertNumberSeries(
    telemetry.costPerRunSeries,
    `${label}.costPerRunSeries`,
  );
  if (throughputSeries.length !== rows.length) {
    throw new Error(`${label}.throughputSeries length must match rows length`);
  }
  if (costPerRunSeries.length !== rows.length) {
    throw new Error(`${label}.costPerRunSeries length must match rows length`);
  }
}

function assertNumberSeries(value: unknown, label: string): unknown[] {
  const series = asArray(value, label);
  for (const [index, item] of series.entries()) {
    assertNonNegativeNumber(item, `${label}[${index}]`);
  }
  return series;
}

function assertProjectOverviewJournalPage(
  value: unknown,
  label: string,
): asserts value is ProjectOverviewJournalPage {
  const page = asStrictRecord(value, label, ["filter", "pagination", "rows", "latestRow"]);
  const filter = asStrictRecord(page.filter, `${label}.filter`, ["projectId", "localeBranchId"]);
  assertString(filter.projectId, `${label}.filter.projectId`);
  assertNullableString(filter.localeBranchId, `${label}.filter.localeBranchId`);
  assertProjectOverviewPagination(page.pagination, `${label}.pagination`);
  const rows = asArray(page.rows, `${label}.rows`);
  if (rows.length > Number((page.pagination as { limit: unknown }).limit)) {
    throw new Error(`${label}.rows must not exceed pagination.limit`);
  }
  for (const [index, row] of rows.entries()) {
    assertProjectOverviewJournalRow(row, `${label}.rows[${index}]`);
  }
  if ("latestRow" in page && page.latestRow !== null) {
    assertProjectOverviewJournalRow(page.latestRow, `${label}.latestRow`);
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

function assertProjectOverviewJournalRow(
  value: unknown,
  label: string,
): asserts value is ProjectOverviewJournalRow {
  const row = asStrictRecord(value, label, [
    "journalRunId",
    "projectId",
    "localeBranchId",
    "sourceRevisionId",
    "targetLocale",
    "createdAt",
    "physicalCallCount",
    "failedPhysicalCallCount",
    "writtenOutcomeCount",
    "candidateCount",
    "qaFindingCount",
    "contextRefCount",
    "speakerLabelCount",
  ]);
  assertString(row.journalRunId, `${label}.journalRunId`);
  assertString(row.projectId, `${label}.projectId`);
  assertString(row.localeBranchId, `${label}.localeBranchId`);
  assertString(row.sourceRevisionId, `${label}.sourceRevisionId`);
  assertString(row.targetLocale, `${label}.targetLocale`);
  assertDateLike(row.createdAt, `${label}.createdAt`);
  assertNonNegativeInteger(row.physicalCallCount, `${label}.physicalCallCount`);
  assertNonNegativeInteger(row.failedPhysicalCallCount, `${label}.failedPhysicalCallCount`);
  assertNonNegativeInteger(row.writtenOutcomeCount, `${label}.writtenOutcomeCount`);
  assertNonNegativeInteger(row.candidateCount, `${label}.candidateCount`);
  assertNonNegativeInteger(row.qaFindingCount, `${label}.qaFindingCount`);
  assertNonNegativeInteger(row.contextRefCount, `${label}.contextRefCount`);
  assertNonNegativeInteger(row.speakerLabelCount, `${label}.speakerLabelCount`);
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

function assertProjectDecodeExtractResponse(
  value: unknown,
): asserts value is ApiProjectDecodeExtractResponse {
  const response = asRecord(value, "ApiProjectDecodeExtractResponse");
  // The bridge is the real decode artifact — validate it through the SAME
  // `assertBridgeInput` the import route uses (the decode runner already
  // narrowed it to v0.2 via `assertBridgeBundleV02`), so the wire body cannot
  // fork from the bridge contract.
  assertBridgeInput(response.bridge);
  assertEnum(
    response.mode,
    ["per-scene", "whole-seen"] as const,
    "ApiProjectDecodeExtractResponse.mode",
  );
  assertString(response.command, "ApiProjectDecodeExtractResponse.command");
}

function assertDraftBranchResponse(value: unknown): asserts value is ApiDraftBranchResponse {
  const response = asRecord(value, "ApiDraftBranchResponse");
  assertEnum(response.outcome, ["drafted", "refused"] as const, "ApiDraftBranchResponse.outcome");
  if (response.outcome === "drafted") {
    assertProjectState(response.project, "ApiDraftBranchResponse.project");
    assertProjectDashboardStatus(response.status, "ApiDraftBranchResponse.status");
    assertNull(response.refusalMessage, "ApiDraftBranchResponse.refusalMessage");
    return;
  }
  assertNull(response.project, "ApiDraftBranchResponse.project");
  assertNull(response.status, "ApiDraftBranchResponse.status");
  assertString(response.refusalMessage, "ApiDraftBranchResponse.refusalMessage");
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

function assertModelRoutingSettingsResponse(
  value: unknown,
): asserts value is ApiModelRoutingSettingsResponse {
  const response = asStrictRecord(
    value,
    "ApiModelRoutingSettingsResponse",
    ITOTORI_STRICT_API_BODY_KEYS.ApiModelRoutingSettingsResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.settings.model-routing.v0",
    "ApiModelRoutingSettingsResponse.schemaVersion",
  );
  assertString(response.projectId, "ApiModelRoutingSettingsResponse.projectId");
  assertDateLike(response.generatedAt, "ApiModelRoutingSettingsResponse.generatedAt");
  for (const [index, provider] of asArray(
    response.providers,
    "ApiModelRoutingSettingsResponse.providers",
  ).entries()) {
    assertModelRoutingProvider(provider, `ApiModelRoutingSettingsResponse.providers[${index}]`);
  }
  for (const [index, model] of asArray(
    response.models,
    "ApiModelRoutingSettingsResponse.models",
  ).entries()) {
    assertModelRoutingModel(model, `ApiModelRoutingSettingsResponse.models[${index}]`);
  }
  for (const [index, preset] of asArray(
    response.promptPresets,
    "ApiModelRoutingSettingsResponse.promptPresets",
  ).entries()) {
    assertModelRoutingPromptPreset(
      preset,
      `ApiModelRoutingSettingsResponse.promptPresets[${index}]`,
    );
  }
  for (const [index, route] of asArray(
    response.routes,
    "ApiModelRoutingSettingsResponse.routes",
  ).entries()) {
    assertModelRoutingRoute(route, `ApiModelRoutingSettingsResponse.routes[${index}]`);
  }
}

function assertBranchPolicySettingsResponse(
  value: unknown,
): asserts value is ApiBranchPolicySettingsResponse {
  const response = asStrictRecord(
    value,
    "ApiBranchPolicySettingsResponse",
    ITOTORI_STRICT_API_BODY_KEYS.ApiBranchPolicySettingsResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.settings.branch-policy.v0",
    "ApiBranchPolicySettingsResponse.schemaVersion",
  );
  assertString(response.projectId, "ApiBranchPolicySettingsResponse.projectId");
  assertString(response.localeBranchId, "ApiBranchPolicySettingsResponse.localeBranchId");
  assertString(response.targetLocale, "ApiBranchPolicySettingsResponse.targetLocale");
  assertBranchPolicySourceRevision(
    response.sourceRevision,
    "ApiBranchPolicySettingsResponse.sourceRevision",
  );
  assertNullableBranchPolicyVersion(
    response.latestVersion,
    "ApiBranchPolicySettingsResponse.latestVersion",
  );
  assertNullableBranchPolicyVersion(
    response.approvedVersion,
    "ApiBranchPolicySettingsResponse.approvedVersion",
  );
  assertNullableBranchPolicyReference(
    response.branchReference,
    "ApiBranchPolicySettingsResponse.branchReference",
  );
  parseBranchPolicyPolicy(response.policy, "ApiBranchPolicySettingsResponse.policy");
}

function assertTranslationScopeSettingsResponse(
  value: unknown,
): asserts value is ApiTranslationScopeSettingsResponse {
  const response = asStrictRecord(
    value,
    "ApiTranslationScopeSettingsResponse",
    ITOTORI_STRICT_API_BODY_KEYS.ApiTranslationScopeSettingsResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.settings.translation-scope.v0",
    "ApiTranslationScopeSettingsResponse.schemaVersion",
  );
  assertString(response.projectId, "ApiTranslationScopeSettingsResponse.projectId");
  assertString(response.localeBranchId, "ApiTranslationScopeSettingsResponse.localeBranchId");
  assertEnum(
    response.scope,
    Object.values(translationScopeValues) as ApiTranslationScope[],
    "ApiTranslationScopeSettingsResponse.scope",
  );
  assertDateLike(response.updatedAt, "ApiTranslationScopeSettingsResponse.updatedAt");
}

function assertLocalizationRunConfigResponse(
  value: unknown,
): asserts value is ApiLocalizationRunConfigResponse {
  const response = asStrictRecord(
    value,
    "ApiLocalizationRunConfigResponse",
    ITOTORI_STRICT_API_BODY_KEYS.ApiLocalizationRunConfigResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.settings.localization-run-config.v0",
    "ApiLocalizationRunConfigResponse.schemaVersion",
  );
  for (const field of [
    "projectId",
    "localeBranchId",
    "configPath",
    "dataRoot",
    "pairPolicyPath",
    "modelId",
    "providerId",
    "runDir",
  ] as const) {
    assertString(response[field], `ApiLocalizationRunConfigResponse.${field}`);
  }
  assertDateLike(response.updatedAt, "ApiLocalizationRunConfigResponse.updatedAt");
}

function assertBranchPolicySourceRevision(value: unknown, label: string): void {
  const sourceRevision = asStrictRecord(
    value,
    label,
    ITOTORI_STRICT_API_BODY_KEYS.ApiBranchPolicySourceRevisionReference,
  );
  assertString(sourceRevision.sourceRevisionId, `${label}.sourceRevisionId`);
  assertString(sourceRevision.revisionKind, `${label}.revisionKind`);
  assertString(sourceRevision.value, `${label}.value`);
}

function assertNullableBranchPolicyVersion(value: unknown, label: string): void {
  if (value === null) {
    return;
  }
  const version = asStrictRecord(value, label, ITOTORI_STRICT_API_BODY_KEYS.ApiBranchPolicyVersion);
  assertString(version.styleGuideVersionId, `${label}.styleGuideVersionId`);
  assertString(version.status, `${label}.status`);
  assertNonNegativeInteger(version.versionSequence, `${label}.versionSequence`);
  assertDateLike(version.createdAt, `${label}.createdAt`);
  assertDateLike(version.updatedAt, `${label}.updatedAt`);
  assertNullableString(version.approvedAt, `${label}.approvedAt`);
  if (version.approvedAt !== null) {
    assertDateLike(version.approvedAt, `${label}.approvedAt`);
  }
  parseBranchPolicyPolicy(version.policy, `${label}.policy`);
}

function assertNullableBranchPolicyReference(value: unknown, label: string): void {
  if (value === null) {
    return;
  }
  const reference = asStrictRecord(
    value,
    label,
    ITOTORI_STRICT_API_BODY_KEYS.ApiBranchPolicyGlossaryReference,
  );
  assertString(reference.referenceId, `${label}.referenceId`);
  assertNonNegativeInteger(reference.versionSequence, `${label}.versionSequence`);
  assertNullableString(reference.styleGuideVersionId, `${label}.styleGuideVersionId`);
  assertString(reference.glossaryContentHash, `${label}.glossaryContentHash`);
  assertNonNegativeInteger(reference.glossaryTermCount, `${label}.glossaryTermCount`);
  assertString(reference.updateReason, `${label}.updateReason`);
  assertDateLike(reference.createdAt, `${label}.createdAt`);
}

function parseBranchPolicyPolicy(value: unknown, label: string): ApiBranchPolicyPolicy {
  const policy = asStrictRecord(value, label, ["schemaVersion", "sections"]);
  assertLiteral(policy.schemaVersion, "style-guide-policy.v0", `${label}.schemaVersion`);
  return {
    schemaVersion: "style-guide-policy.v0",
    sections: parseBranchPolicySections(policy.sections, `${label}.sections`),
  };
}

function parseBranchPolicySections(value: unknown, label: string): ApiBranchPolicySections {
  const sections = asStrictRecord(
    value,
    label,
    ITOTORI_STRICT_API_BODY_KEYS.ApiBranchPolicySections,
  );
  return {
    tone: parseBranchPolicyRules(sections.tone, `${label}.tone`),
    terminology: parseBranchPolicyRules(sections.terminology, `${label}.terminology`),
    honorifics: parseBranchPolicyRules(sections.honorifics, `${label}.honorifics`),
    formatting: parseBranchPolicyRules(sections.formatting, `${label}.formatting`),
    protectedSpans: parseBranchPolicyRules(sections.protectedSpans, `${label}.protectedSpans`),
  };
}

function parseBranchPolicyRules(value: unknown, label: string): ApiBranchPolicyRule[] {
  return asArray(value, label).map((entry, index) => {
    const ruleLabel = `${label}[${index}]`;
    const rule = asStrictRecord(entry, ruleLabel, ITOTORI_STRICT_API_BODY_KEYS.ApiBranchPolicyRule);
    assertString(rule.ruleId, `${ruleLabel}.ruleId`);
    assertString(rule.guidance, `${ruleLabel}.guidance`);
    return { ruleId: rule.ruleId, guidance: rule.guidance };
  });
}

function assertModelRoutingProvider(
  value: unknown,
  label: string,
): asserts value is ApiModelRoutingProvider {
  const provider = asStrictRecord(
    value,
    label,
    ITOTORI_STRICT_API_BODY_KEYS.ApiModelRoutingProvider,
  );
  assertString(provider.providerId, `${label}.providerId`);
  assertString(provider.providerFamily, `${label}.providerFamily`);
  assertString(provider.endpointFamily, `${label}.endpointFamily`);
  assertString(provider.providerName, `${label}.providerName`);
  asRecord(provider.metadata, `${label}.metadata`);
}

function assertModelRoutingModel(
  value: unknown,
  label: string,
): asserts value is ApiModelRoutingModel {
  const model = asStrictRecord(value, label, ITOTORI_STRICT_API_BODY_KEYS.ApiModelRoutingModel);
  assertString(model.modelRegistryId, `${label}.modelRegistryId`);
  assertString(model.providerId, `${label}.providerId`);
  assertString(model.modelId, `${label}.modelId`);
  asRecord(model.capabilities, `${label}.capabilities`);
  asRecord(model.pricing, `${label}.pricing`);
}

function assertModelRoutingPromptPreset(
  value: unknown,
  label: string,
): asserts value is ApiModelRoutingPromptPreset {
  const preset = asStrictRecord(
    value,
    label,
    ITOTORI_STRICT_API_BODY_KEYS.ApiModelRoutingPromptPreset,
  );
  assertString(preset.promptPresetId, `${label}.promptPresetId`);
  assertString(preset.promptTemplateVersion, `${label}.promptTemplateVersion`);
  assertString(preset.presetSchemaVersion, `${label}.presetSchemaVersion`);
  assertString(preset.promptHash, `${label}.promptHash`);
  asRecord(preset.configSnapshot, `${label}.configSnapshot`);
}

function assertModelRoutingRoute(
  value: unknown,
  label: string,
): asserts value is ApiModelRoutingRoute {
  const route = asStrictRecord(value, label, ITOTORI_STRICT_API_BODY_KEYS.ApiModelRoutingRoute);
  assertString(route.projectId, `${label}.projectId`);
  assertString(route.taskKind, `${label}.taskKind`);
  assertString(route.providerId, `${label}.providerId`);
  assertString(route.modelId, `${label}.modelId`);
  assertString(route.modelRegistryId, `${label}.modelRegistryId`);
  assertStringArray(route.fallbackModelIds, `${label}.fallbackModelIds`);
  assertString(route.promptPresetId, `${label}.promptPresetId`);
  assertString(route.promptTemplateVersion, `${label}.promptTemplateVersion`);
  assertDateLike(route.updatedAt, `${label}.updatedAt`);
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

function assertAuthBillingSeatUsageResponse(
  value: unknown,
): asserts value is ApiAuthBillingSeatUsageResponse {
  const response = asStrictRecord(
    value,
    "ApiAuthBillingSeatUsageResponse",
    ITOTORI_STRICT_API_BODY_KEYS.ApiAuthBillingSeatUsageResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.auth.billing-seat-usage.v0",
    "ApiAuthBillingSeatUsageResponse.schemaVersion",
  );
  assertString(response.accountId, "ApiAuthBillingSeatUsageResponse.accountId");
  assertString(response.planId, "ApiAuthBillingSeatUsageResponse.planId");
  assertString(response.planName, "ApiAuthBillingSeatUsageResponse.planName");
  assertEnum(
    response.billingPeriod,
    ["monthly", "annual", "manual"] as const,
    "ApiAuthBillingSeatUsageResponse.billingPeriod",
  );
  assertPositiveInteger(response.seatLimit, "ApiAuthBillingSeatUsageResponse.seatLimit");
  assertNonNegativeInteger(response.includedSeats, "ApiAuthBillingSeatUsageResponse.includedSeats");
  assertNonNegativeInteger(response.usedSeats, "ApiAuthBillingSeatUsageResponse.usedSeats");
  assertNonNegativeInteger(
    response.pendingInvitations,
    "ApiAuthBillingSeatUsageResponse.pendingInvitations",
  );
  assertNonNegativeInteger(
    response.availableSeats,
    "ApiAuthBillingSeatUsageResponse.availableSeats",
  );
  assertBoolean(response.overSeatLimit, "ApiAuthBillingSeatUsageResponse.overSeatLimit");
  assertDateLike(response.updatedAt, "ApiAuthBillingSeatUsageResponse.updatedAt");
}

function assertPermissionSetsListResponse(
  value: unknown,
): asserts value is ApiPermissionSetsListResponse {
  const response = asStrictRecord(
    value,
    "ApiPermissionSetsListResponse",
    ITOTORI_STRICT_API_BODY_KEYS.ApiPermissionSetsListResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.auth.permission-sets.v0",
    "ApiPermissionSetsListResponse.schemaVersion",
  );
  assertString(response.accountId, "ApiPermissionSetsListResponse.accountId");
  const permissionSets = asArray(
    response.permissionSets,
    "ApiPermissionSetsListResponse.permissionSets",
  );
  for (const [index, permissionSet] of permissionSets.entries()) {
    assertPermissionSetRecord(
      permissionSet,
      `ApiPermissionSetsListResponse.permissionSets[${index}]`,
    );
  }
}

function assertPrincipalPermissionSetGrantResponse(
  value: unknown,
): asserts value is ApiPrincipalPermissionSetGrantResponse {
  const response = asStrictRecord(
    value,
    "ApiPrincipalPermissionSetGrantResponse",
    ITOTORI_STRICT_API_BODY_KEYS.ApiPrincipalPermissionSetGrantResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.auth.permission-set-grant.v0",
    "ApiPrincipalPermissionSetGrantResponse.schemaVersion",
  );
  assertString(response.principalId, "ApiPrincipalPermissionSetGrantResponse.principalId");
  assertString(response.permissionSetId, "ApiPrincipalPermissionSetGrantResponse.permissionSetId");
  assertEnum(
    response.action,
    ["granted", "revoked"] as const,
    "ApiPrincipalPermissionSetGrantResponse.action",
  );
  assertMemberRecord(
    response.updatedMember,
    "ApiPrincipalPermissionSetGrantResponse.updatedMember",
  );
}

function assertAuthSessionsListResponse(
  value: unknown,
): asserts value is ApiAuthSessionsListResponse {
  const response = asStrictRecord(
    value,
    "ApiAuthSessionsListResponse",
    ITOTORI_STRICT_API_BODY_KEYS.ApiAuthSessionsListResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.auth.sessions.v0",
    "ApiAuthSessionsListResponse.schemaVersion",
  );
  assertString(response.principalId, "ApiAuthSessionsListResponse.principalId");
  const sessions = asArray(response.sessions, "ApiAuthSessionsListResponse.sessions");
  for (const [index, session] of sessions.entries()) {
    assertAuthSessionRecord(session, `ApiAuthSessionsListResponse.sessions[${index}]`);
  }
}

function assertRevokeAuthSessionResponse(
  value: unknown,
): asserts value is ApiRevokeAuthSessionResponse {
  const response = asStrictRecord(
    value,
    "ApiRevokeAuthSessionResponse",
    ITOTORI_STRICT_API_BODY_KEYS.ApiRevokeAuthSessionResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.auth.session-revoked.v0",
    "ApiRevokeAuthSessionResponse.schemaVersion",
  );
  assertAuthSessionRecord(response.revokedSession, "ApiRevokeAuthSessionResponse.revokedSession");
}

function assertAuthIdentityResponse(value: unknown): asserts value is ApiAuthIdentityResponse {
  const response = asStrictRecord(
    value,
    "ApiAuthIdentityResponse",
    ITOTORI_STRICT_API_BODY_KEYS.ApiAuthIdentityResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.auth.identity.v0",
    "ApiAuthIdentityResponse.schemaVersion",
  );
  assertString(response.actorUserId, "ApiAuthIdentityResponse.actorUserId");
  assertString(response.userId, "ApiAuthIdentityResponse.userId");
  assertNullableString(response.principalId, "ApiAuthIdentityResponse.principalId");
  assertNullableString(response.email, "ApiAuthIdentityResponse.email");
  assertString(response.displayName, "ApiAuthIdentityResponse.displayName");
  const accounts = asArray(response.accounts, "ApiAuthIdentityResponse.accounts");
  for (const [index, account] of accounts.entries()) {
    assertAuthIdentityAccount(account, `ApiAuthIdentityResponse.accounts[${index}]`);
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
  assertBoolean(response.canFlag, "ApiAuthCapabilitiesResponse.canFlag");
  assertBoolean(response.canSteer, "ApiAuthCapabilitiesResponse.canSteer");
  assertBoolean(response.canReveal, "ApiAuthCapabilitiesResponse.canReveal");
  const denials = asStrictRecord(
    response.denials,
    "ApiAuthCapabilitiesResponse.denials",
    ITOTORI_STRICT_API_BODY_KEYS.ApiStudioCapabilityDenials,
  );
  assertNullableString(denials.flag, "ApiAuthCapabilitiesResponse.denials.flag");
  assertNullableString(denials.steer, "ApiAuthCapabilitiesResponse.denials.steer");
  assertNullableString(denials.reveal, "ApiAuthCapabilitiesResponse.denials.reveal");
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

function assertAuthIdentityAccount(
  value: unknown,
  label: string,
): asserts value is ApiAuthIdentityAccount {
  const account = asStrictRecord(value, label, ITOTORI_STRICT_API_BODY_KEYS.ApiAuthIdentityAccount);
  assertString(account.membershipId, `${label}.membershipId`);
  assertString(account.accountId, `${label}.accountId`);
  assertString(account.accountSlug, `${label}.accountSlug`);
  assertString(account.accountName, `${label}.accountName`);
  assertStringArray(account.permissionSetIds, `${label}.permissionSetIds`);
  assertDateLike(account.createdAt, `${label}.createdAt`);
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

function assertPermissionSetRecord(
  value: unknown,
  label: string,
): asserts value is ApiPermissionSetRecord {
  const permissionSet = asStrictRecord(
    value,
    label,
    ITOTORI_STRICT_API_BODY_KEYS.ApiPermissionSetRecord,
  );
  assertString(permissionSet.permissionSetId, `${label}.permissionSetId`);
  assertString(permissionSet.accountId, `${label}.accountId`);
  assertString(permissionSet.name, `${label}.name`);
  assertStringArray(permissionSet.permissions, `${label}.permissions`);
}

function assertAuthSessionRecord(
  value: unknown,
  label: string,
): asserts value is ApiAuthSessionRecord {
  const session = asStrictRecord(value, label, ITOTORI_STRICT_API_BODY_KEYS.ApiAuthSessionRecord);
  assertString(session.sessionId, `${label}.sessionId`);
  assertString(session.principalId, `${label}.principalId`);
  assertDateLike(session.createdAt, `${label}.createdAt`);
  assertDateLike(session.expiresAt, `${label}.expiresAt`);
  assertNullableDateLike(session.revokedAt, `${label}.revokedAt`);
  assertBoolean(session.isActive, `${label}.isActive`);
  assertNullableString(session.deviceLabel, `${label}.deviceLabel`);
  assertNullableString(session.userAgent, `${label}.userAgent`);
  assertNullableString(session.ipAddress, `${label}.ipAddress`);
}

// ovw-launch-pass-action — assert the launch-pass response envelope. The
// schemaVersion literal pins the wire shape; `outcome` pins to started/refused.
// A `started` outcome MUST carry a journal run identity + start timestamp and
// no refusal; a `refused` outcome MUST carry a non-empty refusal message and
// null run/timestamp — so a refused launch can NEVER masquerade as a started
// one (or as a silent 200 with empty fields).
function assertLaunchPassResponse(value: unknown): asserts value is ApiLaunchPassResponse {
  const response = asStrictRecord(
    value,
    "ApiLaunchPassResponse",
    ITOTORI_STRICT_API_BODY_KEYS.ApiLaunchPassResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.projects.launch-pass.v1",
    "ApiLaunchPassResponse.schemaVersion",
  );
  assertEnum(response.outcome, ["started", "refused"] as const, "ApiLaunchPassResponse.outcome");
  if (response.outcome === "started") {
    assertString(response.journalRunId, "ApiLaunchPassResponse.journalRunId");
    assertString(response.startedAt, "ApiLaunchPassResponse.startedAt");
    assertNull(response.refusalMessage, "ApiLaunchPassResponse.refusalMessage");
    return;
  }
  assertNull(response.journalRunId, "ApiLaunchPassResponse.journalRunId");
  assertNull(response.startedAt, "ApiLaunchPassResponse.startedAt");
  assertString(response.refusalMessage, "ApiLaunchPassResponse.refusalMessage");
}

/**
 * ovw-launch-pass-action — parse + validate the launch-pass request body. The
 * locale branch is required (the project id lives on the URL path); the server
 * additionally verifies the branch against the project's ownership set before
 * the driver runs. Cancellation is deliberately an explicit pair:
 * `cancelled:true` plus a non-blank `resumeRunId`. A bare run id can therefore
 * never silently turn a normal launch into a privileged cancellation.
 */
export function parseLaunchPassRequest(body: unknown): ApiLaunchPassRequest {
  return parseRequest("ApiLaunchPassRequest", () => {
    const request = asRecord(body, "ApiLaunchPassRequest");
    assertString(request.localeBranchId, "ApiLaunchPassRequest.localeBranchId");
    if (request.cancelled !== undefined && typeof request.cancelled !== "boolean") {
      throw new Error("ApiLaunchPassRequest.cancelled must be a boolean when supplied");
    }
    if (request.cancelled !== true) {
      if (request.resumeRunId !== undefined) {
        throw new Error("ApiLaunchPassRequest.resumeRunId is legal only when cancelled is true");
      }
      return {
        localeBranchId: request.localeBranchId,
        ...(request.cancelled === false ? { cancelled: false as const } : {}),
      };
    }
    assertString(request.resumeRunId, "ApiLaunchPassRequest.resumeRunId");
    const resumeRunId = request.resumeRunId.trim();
    if (resumeRunId.length === 0) {
      throw new Error("ApiLaunchPassRequest.resumeRunId must be non-blank");
    }
    return {
      localeBranchId: request.localeBranchId,
      cancelled: true,
      resumeRunId,
    };
  });
}

/**
 * p0-result-revision — parse the deliberately narrow play-tester input. The
 * parent patch lives in the path; only the unit identity and replacement
 * target body may cross the public boundary. Strictness rejects actor ids,
 * artifact/file paths, source text, and every other accidental escape hatch.
 */
export function parsePlayTargetEditRequest(body: unknown): ApiPlayTargetEditRequest {
  return parseRequest("ApiPlayTargetEditRequest", () => {
    const request = asStrictRecord(
      body,
      "ApiPlayTargetEditRequest",
      ITOTORI_STRICT_API_BODY_KEYS.ApiPlayTargetEditRequest,
    );
    assertString(request.bridgeUnitId, "ApiPlayTargetEditRequest.bridgeUnitId");
    assertString(request.targetBody, "ApiPlayTargetEditRequest.targetBody");
    const bridgeUnitId = request.bridgeUnitId.trim();
    if (bridgeUnitId.length === 0) {
      throw new ApiValidationError("ApiPlayTargetEditRequest.bridgeUnitId must be non-empty");
    }
    if (request.targetBody.trim().length === 0) {
      throw new ApiValidationError("ApiPlayTargetEditRequest.targetBody must be non-blank");
    }
    return { bridgeUnitId, targetBody: request.targetBody };
  });
}

/** Node 11 request parsers keep patch identity in the URL and freeze only typed inputs. */
export function parsePatchIterationPlayRequest(body: unknown): ApiPatchIterationPlayRequest {
  return parseRequest("ApiPatchIterationPlayRequest", () => {
    const request = asStrictRecord(
      body,
      "ApiPatchIterationPlayRequest",
      ITOTORI_STRICT_API_BODY_KEYS.ApiPatchIterationPlayRequest,
    );
    if (request.launchDescriptor === undefined) return {};
    return { launchDescriptor: { ...asRecord(request.launchDescriptor, "launchDescriptor") } };
  });
}

export function parsePatchIterationFeedbackBatchRequest(
  body: unknown,
): ApiPatchIterationFeedbackBatchRequest {
  return parseRequest("ApiPatchIterationFeedbackBatchRequest", () => {
    const request = asStrictRecord(
      body,
      "ApiPatchIterationFeedbackBatchRequest",
      ITOTORI_STRICT_API_BODY_KEYS.ApiPatchIterationFeedbackBatchRequest,
    );
    return {
      ...(request.feedbackBatchId === undefined
        ? {}
        : { feedbackBatchId: parseNonBlankApiString(request.feedbackBatchId, "feedbackBatchId") }),
      ...(request.label === undefined
        ? {}
        : { label: parseNonBlankApiString(request.label, "label") }),
    };
  });
}

const apiPatchIterationFeedbackEventKinds = [
  "result_edit",
  "comment",
  "added_context",
  "wiki_edit",
] as const satisfies readonly ApiPatchIterationFeedbackRequest["eventKind"][];

const apiPatchIterationContextFeedbackOperations = [
  "add",
  "edit",
] as const satisfies readonly ApiPatchIterationContextFeedback["operation"][];

function parsePatchIterationContextFeedback(value: unknown): ApiPatchIterationContextFeedback {
  const contextFeedback = asRecord(value, "contextFeedback");
  assertEnum(
    contextFeedback.operation,
    apiPatchIterationContextFeedbackOperations,
    "contextFeedback.operation",
  );
  if (contextFeedback.operation === "add") {
    const add = asStrictRecord(value, "contextFeedback", [
      "operation",
      "kind",
      "title",
      "body",
      "reason",
      "affectedBridgeUnitIds",
    ]);
    assertEnum(add.kind, ["note", "glossary", "style"] as const, "contextFeedback.kind");
    const affectedBridgeUnitIds = parseNonBlankApiStringArray(
      add.affectedBridgeUnitIds,
      "contextFeedback.affectedBridgeUnitIds",
    );
    if (affectedBridgeUnitIds.length === 0) {
      throw new ApiValidationError(
        "contextFeedback.affectedBridgeUnitIds must contain at least one unit",
      );
    }
    return {
      operation: "add",
      kind: add.kind,
      title: parseNonBlankApiString(add.title, "contextFeedback.title"),
      body: parseNonBlankApiString(add.body, "contextFeedback.body"),
      reason: parseNonBlankApiString(add.reason, "contextFeedback.reason"),
      affectedBridgeUnitIds,
    };
  }

  const edit = asStrictRecord(value, "contextFeedback", [
    "operation",
    "contextArtifactId",
    "body",
    "reason",
    "title",
    "affectedBridgeUnitIds",
  ]);
  const response: Extract<ApiPatchIterationContextFeedback, { operation: "edit" }> = {
    operation: "edit",
    contextArtifactId: parseNonBlankApiString(
      edit.contextArtifactId,
      "contextFeedback.contextArtifactId",
    ),
    body: parseNonBlankApiString(edit.body, "contextFeedback.body"),
    reason: parseNonBlankApiString(edit.reason, "contextFeedback.reason"),
  };
  if (edit.title !== undefined) {
    response.title = parseNonBlankApiString(edit.title, "contextFeedback.title");
  }
  if (edit.affectedBridgeUnitIds !== undefined) {
    response.affectedBridgeUnitIds = parseNonBlankApiStringArray(
      edit.affectedBridgeUnitIds,
      "contextFeedback.affectedBridgeUnitIds",
    );
  }
  return response;
}

export function parsePatchIterationFeedbackRequest(
  body: unknown,
): ApiPatchIterationFeedbackRequest {
  return parseRequest("ApiPatchIterationFeedbackRequest", () => {
    const request = asStrictRecord(
      body,
      "ApiPatchIterationFeedbackRequest",
      ITOTORI_STRICT_API_BODY_KEYS.ApiPatchIterationFeedbackRequest,
    );
    assertEnum(request.eventKind, apiPatchIterationFeedbackEventKinds, "eventKind");
    const response: ApiPatchIterationFeedbackRequest = { eventKind: request.eventKind };
    if (request.feedbackBatchId !== undefined) {
      response.feedbackBatchId = parseNonBlankApiString(request.feedbackBatchId, "feedbackBatchId");
    }
    if (request.playSessionId !== undefined) {
      response.playSessionId = parseNonBlankApiString(request.playSessionId, "playSessionId");
    }
    if (request.body !== undefined) response.body = parseNonBlankApiString(request.body, "body");
    if (request.metadata !== undefined)
      response.metadata = { ...asRecord(request.metadata, "metadata") };
    if (request.targetBody !== undefined) {
      response.targetBody = parseNonBlankApiString(request.targetBody, "targetBody");
    }
    if (request.resultRevisionId !== undefined) {
      response.resultRevisionId = parseNonBlankApiString(
        request.resultRevisionId,
        "resultRevisionId",
      );
    }
    if (request.contextArtifactId !== undefined) {
      response.contextArtifactId = parseNonBlankApiString(
        request.contextArtifactId,
        "contextArtifactId",
      );
    }
    if (request.contextEntryVersionId !== undefined) {
      response.contextEntryVersionId = parseNonBlankApiString(
        request.contextEntryVersionId,
        "contextEntryVersionId",
      );
    }
    if (request.contextFeedback !== undefined) {
      response.contextFeedback = parsePatchIterationContextFeedback(request.contextFeedback);
    }
    if (request.affectedBridgeUnitIds !== undefined) {
      response.affectedBridgeUnitIds = parseNonBlankApiStringArray(
        request.affectedBridgeUnitIds,
        "affectedBridgeUnitIds",
      );
    }
    if (response.eventKind === "comment") {
      if (response.body === undefined) {
        throw new ApiValidationError(
          "comment feedback requires a non-blank body for its canonical context correction",
        );
      }
      if (
        response.affectedBridgeUnitIds === undefined ||
        response.affectedBridgeUnitIds.length === 0
      ) {
        throw new ApiValidationError(
          "comment feedback requires at least one affectedBridgeUnitId for its canonical context correction",
        );
      }
    }
    return response;
  });
}

export function parsePatchIterationRefineRequest(body: unknown): ApiPatchIterationRefineRequest {
  return parseRequest("ApiPatchIterationRefineRequest", () => {
    const request = asStrictRecord(
      body,
      "ApiPatchIterationRefineRequest",
      ITOTORI_STRICT_API_BODY_KEYS.ApiPatchIterationRefineRequest,
    );
    const response: ApiPatchIterationRefineRequest = {};
    if (request.feedbackBatchIds !== undefined) {
      response.feedbackBatchIds = parseNonBlankApiStringArray(
        request.feedbackBatchIds,
        "feedbackBatchIds",
      );
    }
    if (request.feedbackEventIds !== undefined) {
      response.feedbackEventIds = parseNonBlankApiStringArray(
        request.feedbackEventIds,
        "feedbackEventIds",
      );
    }
    if (request.scopeUnitIds !== undefined) {
      response.scopeUnitIds = parseNonBlankApiStringArray(request.scopeUnitIds, "scopeUnitIds");
    }
    if (request.targetBodiesByUnit !== undefined) {
      const targetBodies = asRecord(request.targetBodiesByUnit, "targetBodiesByUnit");
      const normalized: Record<string, string> = {};
      for (const [unitId, targetBody] of Object.entries(targetBodies)) {
        if (unitId.trim().length === 0) {
          throw new ApiValidationError("targetBodiesByUnit keys must be non-blank");
        }
        normalized[unitId] = parseNonBlankApiString(targetBody, `targetBodiesByUnit.${unitId}`);
      }
      response.targetBodiesByUnit = normalized;
    }
    if (request.wikiHeads !== undefined) {
      const values = asArray(request.wikiHeads, "wikiHeads");
      response.wikiHeads = values.map((value, index) => {
        const head = asStrictRecord(value, `wikiHeads[${index}]`, [
          "contextArtifactId",
          "contextEntryVersionId",
        ]);
        return {
          contextArtifactId: parseNonBlankApiString(
            head.contextArtifactId,
            `wikiHeads[${index}].contextArtifactId`,
          ),
          contextEntryVersionId: parseNonBlankApiString(
            head.contextEntryVersionId,
            `wikiHeads[${index}].contextEntryVersionId`,
          ),
        };
      });
    }
    return response;
  });
}

function parseNonBlankApiString(value: unknown, label: string): string {
  assertString(value, label);
  const normalized = value.trim();
  if (normalized.length === 0) throw new ApiValidationError(`${label} must be non-blank`);
  return normalized;
}

function parseNonBlankApiStringArray(value: unknown, label: string): string[] {
  const values = asArray(value, label);
  const seen = new Set<string>();
  return values.map((entry, index) => {
    const normalized = parseNonBlankApiString(entry, `${label}[${index}]`);
    if (seen.has(normalized))
      throw new ApiValidationError(`${label} contains duplicate ${normalized}`);
    seen.add(normalized);
    return normalized;
  });
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

function assertPlayRouteMapNode(
  value: unknown,
  label: string,
): asserts value is ApiPlayRouteMapNode {
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

function assertPlayRouteMapEdge(
  value: unknown,
  label: string,
): asserts value is ApiPlayRouteMapEdge {
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

/**
 * play-flag-composer — parse + validate the AnnotationComposer submit body.
 * projectId + localeBranchId live on the URL path; the body carries the note,
 * severity ramp, required target unit, and optional scene anchors.
 */
export function parsePlayFlagAnnotationRequest(body: unknown): ApiPlayFlagAnnotationRequest {
  return parseRequest("ApiPlayFlagAnnotationRequest", () => {
    const request = asStrictRecord(body, "ApiPlayFlagAnnotationRequest", [
      "note",
      "severity",
      "category",
      "bridgeUnitId",
      "sourceUnitKey",
      "sourceBundleId",
      "sourceRevisionId",
      "sceneId",
      "suggestedEdit",
      "actorUserId",
      "actorDisplayName",
    ]);
    assertString(request.note, "ApiPlayFlagAnnotationRequest.note");
    if (request.note.trim().length === 0) {
      throw new ApiValidationError("ApiPlayFlagAnnotationRequest.note must be non-empty");
    }
    assertEnum(request.severity, API_PLAY_FLAG_SEVERITIES, "ApiPlayFlagAnnotationRequest.severity");
    assertString(request.bridgeUnitId, "ApiPlayFlagAnnotationRequest.bridgeUnitId");
    const bridgeUnitId = request.bridgeUnitId.trim();
    if (bridgeUnitId.length === 0) {
      throw new ApiValidationError("ApiPlayFlagAnnotationRequest.bridgeUnitId must be non-empty");
    }
    const parsed: ApiPlayFlagAnnotationRequest = {
      note: request.note.trim(),
      severity: request.severity,
      bridgeUnitId,
    };
    if (request.category !== undefined) {
      assertString(request.category, "ApiPlayFlagAnnotationRequest.category");
      parsed.category = request.category;
    }
    if (request.sourceUnitKey !== undefined) {
      assertString(request.sourceUnitKey, "ApiPlayFlagAnnotationRequest.sourceUnitKey");
      parsed.sourceUnitKey = request.sourceUnitKey;
    }
    if (request.sourceBundleId !== undefined) {
      assertString(request.sourceBundleId, "ApiPlayFlagAnnotationRequest.sourceBundleId");
      parsed.sourceBundleId = request.sourceBundleId;
    }
    if (request.sourceRevisionId !== undefined) {
      assertString(request.sourceRevisionId, "ApiPlayFlagAnnotationRequest.sourceRevisionId");
      parsed.sourceRevisionId = request.sourceRevisionId;
    }
    if (request.sceneId !== undefined) {
      assertString(request.sceneId, "ApiPlayFlagAnnotationRequest.sceneId");
      parsed.sceneId = request.sceneId;
    }
    if (request.suggestedEdit !== undefined) {
      assertString(request.suggestedEdit, "ApiPlayFlagAnnotationRequest.suggestedEdit");
      parsed.suggestedEdit = request.suggestedEdit;
    }
    if (request.actorUserId !== undefined) {
      assertString(request.actorUserId, "ApiPlayFlagAnnotationRequest.actorUserId");
      parsed.actorUserId = request.actorUserId;
    }
    if (request.actorDisplayName !== undefined) {
      assertString(request.actorDisplayName, "ApiPlayFlagAnnotationRequest.actorDisplayName");
      parsed.actorDisplayName = request.actorDisplayName;
    }
    return parsed;
  });
}

function assertPlayFlagAnnotationResponse(
  value: unknown,
): asserts value is ApiPlayFlagAnnotationResponse {
  const response = asStrictRecord(
    value,
    "ApiPlayFlagAnnotationResponse",
    ITOTORI_STRICT_API_BODY_KEYS.ApiPlayFlagAnnotationResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.play.flag-annotation.v0",
    "ApiPlayFlagAnnotationResponse.schemaVersion",
  );
  assertString(response.projectId, "ApiPlayFlagAnnotationResponse.projectId");
  assertString(response.localeBranchId, "ApiPlayFlagAnnotationResponse.localeBranchId");
  assertString(response.feedbackReportId, "ApiPlayFlagAnnotationResponse.feedbackReportId");
  assertString(response.feedbackEvidenceId, "ApiPlayFlagAnnotationResponse.feedbackEvidenceId");
  assertEnum(response.severity, API_PLAY_FLAG_SEVERITIES, "ApiPlayFlagAnnotationResponse.severity");
  assertString(response.category, "ApiPlayFlagAnnotationResponse.category");
  assertString(response.note, "ApiPlayFlagAnnotationResponse.note");
  assertString(response.triageLabel, "ApiPlayFlagAnnotationResponse.triageLabel");
  assertString(response.contextStatus, "ApiPlayFlagAnnotationResponse.contextStatus");
  assertString(response.contextCorrectionId, "ApiPlayFlagAnnotationResponse.contextCorrectionId");
  assertBoolean(response.duplicate, "ApiPlayFlagAnnotationResponse.duplicate");
}

function assertPlayTargetEditResponse(value: unknown): asserts value is ApiPlayTargetEditResponse {
  const response = asStrictRecord(
    value,
    "ApiPlayTargetEditResponse",
    ITOTORI_STRICT_API_BODY_KEYS.ApiPlayTargetEditResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.play.target-edit.v0",
    "ApiPlayTargetEditResponse.schemaVersion",
  );
  assertString(response.resultRevisionId, "ApiPlayTargetEditResponse.resultRevisionId");
  assertString(response.patchVersionId, "ApiPlayTargetEditResponse.patchVersionId");
  assertString(response.runId, "ApiPlayTargetEditResponse.runId");
  assertString(response.parentPatchVersionId, "ApiPlayTargetEditResponse.parentPatchVersionId");
  assertString(response.bridgeUnitId, "ApiPlayTargetEditResponse.bridgeUnitId");
  assertString(response.targetBody, "ApiPlayTargetEditResponse.targetBody");
  assertLiteral(response.status, "playable", "ApiPlayTargetEditResponse.status");
  assertDateLike(response.selectedAt, "ApiPlayTargetEditResponse.selectedAt");
  assertBoolean(response.idempotentReplay, "ApiPlayTargetEditResponse.idempotentReplay");
}

function assertPlayDeliveryResponse(value: unknown): asserts value is ApiPlayDeliveryResponse {
  const response = asStrictRecord(
    value,
    "ApiPlayDeliveryResponse",
    ITOTORI_STRICT_API_BODY_KEYS.ApiPlayDeliveryResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.play.delivery.v0",
    "ApiPlayDeliveryResponse.schemaVersion",
  );
  assertString(response.patchVersionId, "ApiPlayDeliveryResponse.patchVersionId");
  assertString(response.runId, "ApiPlayDeliveryResponse.runId");
  assertNullableString(
    response.parentPatchVersionId,
    "ApiPlayDeliveryResponse.parentPatchVersionId",
  );
  assertString(response.status, "ApiPlayDeliveryResponse.status");
  assertDateLike(response.selectedAt, "ApiPlayDeliveryResponse.selectedAt");
  assertStringRecord(response.artifactHashes, "ApiPlayDeliveryResponse.artifactHashes");
  assertString(response.downloadUrl, "ApiPlayDeliveryResponse.downloadUrl");
  assertPlayDeliveryUnits(response.units, "ApiPlayDeliveryResponse.units");
}

function assertPlayDeliveryUnits(value: unknown, label: string): void {
  const units = asArray(value, label);
  let previousOrdinal = -1;
  for (const [index, value] of units.entries()) {
    const unit = asStrictRecord(
      value,
      `${label}[${index}]`,
      ITOTORI_STRICT_API_BODY_KEYS.ApiPlayDeliveryUnit,
    );
    assertString(unit.bridgeUnitId, `${label}[${index}].bridgeUnitId`);
    assertNonNegativeInteger(unit.unitOrdinal, `${label}[${index}].unitOrdinal`);
    if (unit.unitOrdinal <= previousOrdinal) {
      throw new Error(`${label} must be strictly ordered by unitOrdinal`);
    }
    previousOrdinal = unit.unitOrdinal;
    assertString(unit.targetBody, `${label}[${index}].targetBody`);
  }
}

function assertPatchIterationDeliveryResponse(
  value: unknown,
): asserts value is ApiPatchIterationDeliveryResponse {
  const response = asStrictRecord(
    value,
    "ApiPatchIterationDeliveryResponse",
    ITOTORI_STRICT_API_BODY_KEYS.ApiPatchIterationDeliveryResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.patch-iteration.delivery.v0",
    "ApiPatchIterationDeliveryResponse.schemaVersion",
  );
  assertString(response.patchVersionId, "ApiPatchIterationDeliveryResponse.patchVersionId");
  assertString(response.runId, "ApiPatchIterationDeliveryResponse.runId");
  assertNullableString(
    response.parentPatchVersionId,
    "ApiPatchIterationDeliveryResponse.parentPatchVersionId",
  );
  assertPatchIterationOrigin(response.origin, "ApiPatchIterationDeliveryResponse.origin");
  assertLiteral(response.status, "playable", "ApiPatchIterationDeliveryResponse.status");
  assertDateLike(response.playableAt, "ApiPatchIterationDeliveryResponse.playableAt");
  assertStringRecord(response.artifactHashes, "ApiPatchIterationDeliveryResponse.artifactHashes");
  assertString(response.downloadUrl, "ApiPatchIterationDeliveryResponse.downloadUrl");
  assertPlayDeliveryUnits(response.units, "ApiPatchIterationDeliveryResponse.units");
}

function assertPatchIterationVersionsResponse(
  value: unknown,
): asserts value is ApiPatchIterationVersionsResponse {
  const response = asStrictRecord(
    value,
    "ApiPatchIterationVersionsResponse",
    ITOTORI_STRICT_API_BODY_KEYS.ApiPatchIterationVersionsResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.patch-iteration.versions.v0",
    "ApiPatchIterationVersionsResponse.schemaVersion",
  );
  const versions = asArray(response.versions, "ApiPatchIterationVersionsResponse.versions");
  for (const [index, version] of versions.entries()) {
    assertPatchIterationVersion(version, `ApiPatchIterationVersionsResponse.versions[${index}]`);
  }
}

function assertPatchIterationSurfaceResponse(
  value: unknown,
): asserts value is ApiPatchIterationSurfaceResponse {
  const response = asStrictRecord(
    value,
    "ApiPatchIterationSurfaceResponse",
    ITOTORI_STRICT_API_BODY_KEYS.ApiPatchIterationSurfaceResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.patch-iteration.surface.v0",
    "ApiPatchIterationSurfaceResponse.schemaVersion",
  );
  assertPatchIterationPatch(response.patch, "ApiPatchIterationSurfaceResponse.patch");
  const versions = asArray(response.versions, "ApiPatchIterationSurfaceResponse.versions");
  for (const [index, version] of versions.entries()) {
    assertPatchIterationVersion(version, `ApiPatchIterationSurfaceResponse.versions[${index}]`);
  }
  assertPatchIterationFeedbackInbox(response.feedback, "ApiPatchIterationSurfaceResponse.feedback");
}

function assertPatchIterationPlayResponse(
  value: unknown,
): asserts value is ApiPatchIterationPlayResponse {
  const response = asStrictRecord(
    value,
    "ApiPatchIterationPlayResponse",
    ITOTORI_STRICT_API_BODY_KEYS.ApiPatchIterationPlayResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.patch-iteration.play.v0",
    "ApiPatchIterationPlayResponse.schemaVersion",
  );
  assertPatchIterationSession(response.session, "ApiPatchIterationPlayResponse.session");
}

function assertPatchIterationFeedbackBatchResponse(
  value: unknown,
): asserts value is ApiPatchIterationFeedbackBatchResponse {
  const response = asStrictRecord(
    value,
    "ApiPatchIterationFeedbackBatchResponse",
    ITOTORI_STRICT_API_BODY_KEYS.ApiPatchIterationFeedbackBatchResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.patch-iteration.feedback-batch.v0",
    "ApiPatchIterationFeedbackBatchResponse.schemaVersion",
  );
  assertPatchIterationFeedbackBatch(
    response.batch,
    "ApiPatchIterationFeedbackBatchResponse.batch",
    true,
  );
}

function assertPatchIterationFeedbackResponse(
  value: unknown,
): asserts value is ApiPatchIterationFeedbackResponse {
  const response = asStrictRecord(
    value,
    "ApiPatchIterationFeedbackResponse",
    ITOTORI_STRICT_API_BODY_KEYS.ApiPatchIterationFeedbackResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.patch-iteration.feedback.v0",
    "ApiPatchIterationFeedbackResponse.schemaVersion",
  );
  assertPatchIterationFeedbackEvent(
    response.feedback,
    "ApiPatchIterationFeedbackResponse.feedback",
  );
}

function assertPatchIterationRefineResponse(
  value: unknown,
): asserts value is ApiPatchIterationRefineResponse {
  const response = asStrictRecord(
    value,
    "ApiPatchIterationRefineResponse",
    ITOTORI_STRICT_API_BODY_KEYS.ApiPatchIterationRefineResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.patch-iteration.refine.v0",
    "ApiPatchIterationRefineResponse.schemaVersion",
  );
  assertPatchIterationRefinement(response.refinement, "ApiPatchIterationRefineResponse.refinement");
  assertPatchIterationPatch(response.patch, "ApiPatchIterationRefineResponse.patch");
}

function assertPatchIterationPatch(value: unknown, label: string): void {
  const patch = asStrictRecord(value, label, [
    "patchVersionId",
    "runId",
    "parentPatchVersionId",
    "origin",
    "status",
    "playableAt",
    "selectedAt",
    "artifactHashes",
    "units",
    "qaCallouts",
  ]);
  assertString(patch.patchVersionId, `${label}.patchVersionId`);
  assertString(patch.runId, `${label}.runId`);
  assertNullableString(patch.parentPatchVersionId, `${label}.parentPatchVersionId`);
  assertPatchIterationOrigin(patch.origin, `${label}.origin`);
  assertString(patch.status, `${label}.status`);
  assertNullableDateLike(patch.playableAt, `${label}.playableAt`);
  assertNullableDateLike(patch.selectedAt, `${label}.selectedAt`);
  assertStringRecord(patch.artifactHashes, `${label}.artifactHashes`);
  const units = asArray(patch.units, `${label}.units`);
  let priorOrdinal = -1;
  for (const [index, unit] of units.entries()) {
    assertPatchIterationUnit(unit, `${label}.units[${index}]`);
    const unitRecord = unit as { unitOrdinal: number };
    if (unitRecord.unitOrdinal <= priorOrdinal) {
      throw new Error(`${label}.units must be ordered by unitOrdinal`);
    }
    priorOrdinal = unitRecord.unitOrdinal;
  }
  const callouts = asArray(patch.qaCallouts, `${label}.qaCallouts`);
  for (const [index, callout] of callouts.entries()) {
    assertPatchIterationQaCallout(callout, `${label}.qaCallouts[${index}]`);
  }
}

function assertPatchIterationVersion(value: unknown, label: string): void {
  const version = asStrictRecord(value, label, [
    "patchVersionId",
    "runId",
    "parentPatchVersionId",
    "origin",
    "status",
    "playableAt",
    "selectedAt",
    "artifactHashes",
    "basePatchVersionId",
  ]);
  assertString(version.patchVersionId, `${label}.patchVersionId`);
  assertString(version.runId, `${label}.runId`);
  assertNullableString(version.parentPatchVersionId, `${label}.parentPatchVersionId`);
  assertPatchIterationOrigin(version.origin, `${label}.origin`);
  assertString(version.status, `${label}.status`);
  assertNullableDateLike(version.playableAt, `${label}.playableAt`);
  assertNullableDateLike(version.selectedAt, `${label}.selectedAt`);
  assertStringRecord(version.artifactHashes, `${label}.artifactHashes`);
  assertNullableString(version.basePatchVersionId, `${label}.basePatchVersionId`);
}

function assertPatchIterationUnit(value: unknown, label: string): void {
  const unit = asStrictRecord(value, label, [
    "bridgeUnitId",
    "sourceRunId",
    "journalOutcomeId",
    "resultRevisionId",
    "targetBody",
    "memberOrigin",
    "reusedFromPatchVersionId",
    "unitOrdinal",
  ]);
  assertString(unit.bridgeUnitId, `${label}.bridgeUnitId`);
  assertString(unit.sourceRunId, `${label}.sourceRunId`);
  assertString(unit.journalOutcomeId, `${label}.journalOutcomeId`);
  assertString(unit.resultRevisionId, `${label}.resultRevisionId`);
  assertString(unit.targetBody, `${label}.targetBody`);
  assertEnum(
    unit.memberOrigin,
    ["run_written_outcome", "reused_from_base", "play_tester_edit"] as const,
    `${label}.memberOrigin`,
  );
  assertNullableString(unit.reusedFromPatchVersionId, `${label}.reusedFromPatchVersionId`);
  assertNonNegativeInteger(unit.unitOrdinal, `${label}.unitOrdinal`);
}

function assertPatchIterationQaCallout(value: unknown, label: string): void {
  const callout = asStrictRecord(value, label, [
    "journalFindingId",
    "bridgeUnitId",
    "severity",
    "category",
    "note",
    "confidence",
    "contested",
    "informational",
  ]);
  assertString(callout.journalFindingId, `${label}.journalFindingId`);
  assertString(callout.bridgeUnitId, `${label}.bridgeUnitId`);
  assertString(callout.severity, `${label}.severity`);
  assertString(callout.category, `${label}.category`);
  assertString(callout.note, `${label}.note`);
  assertString(callout.confidence, `${label}.confidence`);
  assertBoolean(callout.contested, `${label}.contested`);
  assertBoolean(callout.informational, `${label}.informational`);
  if (callout.informational !== true) {
    throw new Error(`${label}.informational must be true`);
  }
}

function assertPatchIterationFeedbackInbox(value: unknown, label: string): void {
  const inbox = asStrictRecord(value, label, ["observedPatchVersionId", "batches"]);
  assertString(inbox.observedPatchVersionId, `${label}.observedPatchVersionId`);
  const batches = asArray(inbox.batches, `${label}.batches`);
  for (const [index, batch] of batches.entries()) {
    assertPatchIterationFeedbackBatch(batch, `${label}.batches[${index}]`, true);
  }
}

function assertPatchIterationFeedbackBatch(
  value: unknown,
  label: string,
  withEvents: boolean,
): void {
  const fields = [
    "feedbackBatchId",
    "observedPatchVersionId",
    "actorUserId",
    "selectionKind",
    "label",
    "createdAt",
    "updatedAt",
    ...(withEvents ? ["events"] : []),
  ];
  const batch = asStrictRecord(value, label, fields);
  assertString(batch.feedbackBatchId, `${label}.feedbackBatchId`);
  assertString(batch.observedPatchVersionId, `${label}.observedPatchVersionId`);
  assertString(batch.actorUserId, `${label}.actorUserId`);
  assertEnum(batch.selectionKind, ["individual", "batch"] as const, `${label}.selectionKind`);
  assertNullableString(batch.label, `${label}.label`);
  assertDateLike(batch.createdAt, `${label}.createdAt`);
  assertDateLike(batch.updatedAt, `${label}.updatedAt`);
  if (withEvents) {
    const events = asArray(batch.events, `${label}.events`);
    for (const [index, event] of events.entries()) {
      assertPatchIterationFeedbackEvent(event, `${label}.events[${index}]`);
    }
  }
}

function assertPatchIterationFeedbackEvent(value: unknown, label: string): void {
  const event = asStrictRecord(value, label, [
    "feedbackEventId",
    "feedbackBatchId",
    "observedPatchVersionId",
    "playSessionId",
    "actorUserId",
    "eventKind",
    "body",
    "metadata",
    "resultRevisionId",
    "contextArtifactId",
    "contextEntryVersionId",
    "affectedBridgeUnitIds",
    "createdAt",
  ]);
  assertString(event.feedbackEventId, `${label}.feedbackEventId`);
  assertString(event.feedbackBatchId, `${label}.feedbackBatchId`);
  assertString(event.observedPatchVersionId, `${label}.observedPatchVersionId`);
  assertNullableString(event.playSessionId, `${label}.playSessionId`);
  assertString(event.actorUserId, `${label}.actorUserId`);
  assertEnum(event.eventKind, apiPatchIterationFeedbackEventKinds, `${label}.eventKind`);
  assertNullableString(event.body, `${label}.body`);
  asRecord(event.metadata, `${label}.metadata`);
  assertNullableString(event.resultRevisionId, `${label}.resultRevisionId`);
  assertNullableString(event.contextArtifactId, `${label}.contextArtifactId`);
  assertNullableString(event.contextEntryVersionId, `${label}.contextEntryVersionId`);
  assertStringArray(event.affectedBridgeUnitIds, `${label}.affectedBridgeUnitIds`);
  assertDateLike(event.createdAt, `${label}.createdAt`);
}

function assertPatchIterationSession(value: unknown, label: string): void {
  const session = asStrictRecord(value, label, [
    "playSessionId",
    "observedPatchVersionId",
    "actorUserId",
    "status",
    "startedAt",
    "endedAt",
    "qaCallouts",
  ]);
  assertString(session.playSessionId, `${label}.playSessionId`);
  assertString(session.observedPatchVersionId, `${label}.observedPatchVersionId`);
  assertString(session.actorUserId, `${label}.actorUserId`);
  assertEnum(session.status, ["active", "completed", "abandoned"] as const, `${label}.status`);
  assertDateLike(session.startedAt, `${label}.startedAt`);
  assertNullableDateLike(session.endedAt, `${label}.endedAt`);
  const callouts = asArray(session.qaCallouts, `${label}.qaCallouts`);
  for (const [index, callout] of callouts.entries()) {
    assertPatchIterationQaCallout(callout, `${label}.qaCallouts[${index}]`);
  }
}

function assertPatchIterationRefinement(value: unknown, label: string): void {
  const refinement = asStrictRecord(value, label, [
    "runId",
    "basePatchVersionId",
    "feedbackBatchIds",
    "wikiHeads",
    "members",
  ]);
  assertString(refinement.runId, `${label}.runId`);
  assertString(refinement.basePatchVersionId, `${label}.basePatchVersionId`);
  assertStringArray(refinement.feedbackBatchIds, `${label}.feedbackBatchIds`);
  const wikiHeads = asArray(refinement.wikiHeads, `${label}.wikiHeads`);
  for (const [index, headValue] of wikiHeads.entries()) {
    const head = asStrictRecord(headValue, `${label}.wikiHeads[${index}]`, [
      "contextArtifactId",
      "contextEntryVersionId",
    ]);
    assertString(head.contextArtifactId, `${label}.wikiHeads[${index}].contextArtifactId`);
    assertString(head.contextEntryVersionId, `${label}.wikiHeads[${index}].contextEntryVersionId`);
  }
  const members = asArray(refinement.members, `${label}.members`);
  for (const [index, memberValue] of members.entries()) {
    const member = asStrictRecord(memberValue, `${label}.members[${index}]`, [
      "bridgeUnitId",
      "strategy",
      "basePatchVersionId",
      "baseSourceRunId",
      "baseJournalOutcomeId",
      "baseResultRevisionId",
    ]);
    assertString(member.bridgeUnitId, `${label}.members[${index}].bridgeUnitId`);
    assertEnum(
      member.strategy,
      ["reuse", "redraft", "new_scope"] as const,
      `${label}.members[${index}].strategy`,
    );
    assertNullableString(
      member.basePatchVersionId,
      `${label}.members[${index}].basePatchVersionId`,
    );
    assertNullableString(member.baseSourceRunId, `${label}.members[${index}].baseSourceRunId`);
    assertNullableString(
      member.baseJournalOutcomeId,
      `${label}.members[${index}].baseJournalOutcomeId`,
    );
    assertNullableString(
      member.baseResultRevisionId,
      `${label}.members[${index}].baseResultRevisionId`,
    );
  }
}

function assertPatchIterationOrigin(value: unknown, label: string): void {
  assertEnum(value, ["run_finalizer", "play_tester_edit", "refinement_run"] as const, label);
}

function assertStringRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, string> {
  const record = asRecord(value, label);
  for (const [key, entry] of Object.entries(record)) {
    assertString(entry, `${label}.${key}`);
  }
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
