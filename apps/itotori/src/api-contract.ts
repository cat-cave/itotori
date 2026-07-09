// fe-api-openapi-emit — the deterministic OpenAPI + JSON-Schema CONTRACT that is
// emitted FROM the api-schema.ts type-guard authority.
//
// DECISION (Trevor 2026-07-07): the hand-rolled type-guards in `api-schema.ts`
// remain the API contract AUTHORITY (declared in
// `docs/format-stability-and-compatibility-policy.md`; the server + client
// already assert through them). This module does NOT re-implement or migrate
// those guards to zod/valibot — a zod revisit is an evidence-gated deferred
// follow-up, NOT this node. Instead it hosts the SINGLE co-located route
// registry (`ITOTORI_API_ROUTES`) + a JSON-Schema `COMPONENT` table that BOTH
// the guards' world (the HTTP contract harness, which drives method/path from
// this registry AND validates responses against these schemas) AND the emitter
// consume. There is exactly one authority for the route topology (the
// `Record<ItotoriApiRouteId, …>` registry, compile-time-exhaustive against the
// guard union) and one emitted wire-contract artifact derived from it.
//
// Altitude of the emitted schema: it pins the WIRE ENVELOPE — the route
// topology (method / path / operationId / path params), the typed error shape,
// each body's top-level required keys, the `schemaVersion` const markers, and
// (for strict `asStrictRecord` bodies) `additionalProperties: false` so a
// renamed / leaked top-level field fails. The DEEP field-by-field contract
// stays with the guards (`assertItotoriApiResponse`), which the harness runs
// ALONGSIDE this schema.
//
// fe-openapi-parity-all-routes: every strict (`additionalProperties:false`)
// body's `required` list is GENERATED from `ITOTORI_STRICT_API_BODY_KEYS` — the
// SAME array the guard passes to `asStrictRecord`. There is no hand-authored
// second source for a strict body's envelope, so it cannot fork from the guard
// for ANY strict route (the reviewer / workspace / queue-health / asset-decision
// routes that previously lacked a parity fixture included). The loose
// (`additionalProperties:true`) bodies keep their guard<->schema parity proven
// by real response fixtures. The parity suite adds per-route teeth for all
// routes (a dropped required key or a leaked strict field fails).
import { ITOTORI_PRODUCT_VERSION } from "@itotori/localization-bridge-schema";
import {
  API_ERROR_RESPONSE_CODES,
  ITOTORI_STRICT_API_BODY_KEYS,
  reviewerSingleActionList,
  type ItotoriApiRouteId,
} from "./api-schema.js";
import { ITOTORI_API_ROUTE_IDS, ITOTORI_API_ROUTES, type ItotoriApiRoute } from "./api-routes.js";

// ---------------------------------------------------------------------------
// JSON value + deterministic sort
// ---------------------------------------------------------------------------

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * Recursively sort object keys (arrays keep their order) so a serialized
 * document is byte-identical regardless of authoring/insertion order. This is
 * the determinism backbone: the emitter never depends on key order.
 */
export function sortJsonDeep(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortJsonDeep);
  }
  if (value !== null && typeof value === "object") {
    const record = value as { readonly [key: string]: JsonValue };
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = sortJsonDeep(record[key] as JsonValue);
    }
    return out;
  }
  return value;
}

/** Serialize a JSON document deterministically (sorted keys, 2-space, trailing newline). */
export function serializeJsonDocument(value: JsonValue): string {
  return `${JSON.stringify(sortJsonDeep(value), null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// JSON-Schema COMPONENT table — one named schema per request/response body.
// ---------------------------------------------------------------------------

type Schema = { readonly [key: string]: JsonValue };
type Ref = (name: string) => Schema;

const str: Schema = { type: "string" };
const nullableStr: Schema = { type: ["string", "null"] };
const num: Schema = { type: "number" };
const bool: Schema = { type: "boolean" };
const arr: Schema = { type: "array" };
const obj: Schema = { type: "object" };
const any: Schema = {};

/**
 * Build an object schema. `required` keys are always present in `properties`
 * (defaulting to `any`) so `additionalProperties: false` never rejects a key it
 * simply forgot to list. `schemaVersion`, when supplied, is pinned as a `const`
 * (the SAME literal the guard asserts) and force-required.
 */
function object(spec: {
  required: readonly string[];
  properties?: Readonly<Record<string, Schema>>;
  additionalProperties: boolean;
  schemaVersion?: string;
}): Schema {
  const properties: Record<string, JsonValue> = { ...spec.properties };
  const required = [...spec.required];
  if (spec.schemaVersion !== undefined) {
    properties.schemaVersion = { const: spec.schemaVersion };
    if (!required.includes("schemaVersion")) {
      required.push("schemaVersion");
    }
  }
  for (const key of required) {
    if (!(key in properties)) {
      properties[key] = any;
    }
  }
  return {
    type: "object",
    properties,
    required: [...required].sort(),
    additionalProperties: spec.additionalProperties,
  };
}

/**
 * The JSON-Schema component table. Each builder receives `ref(name)` so a
 * component can point at another component with the correct `$ref` prefix
 * (`#/definitions/…` for the JSON-Schema bundle, `#/components/schemas/…` for
 * OpenAPI). Envelope-level by design (see file header).
 */
const COMPONENTS: Readonly<Record<string, (ref: Ref) => Schema>> = {
  // Shared -----------------------------------------------------------------
  ApiErrorResponse: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiErrorResponse,
      properties: { error: str, code: { enum: [...API_ERROR_RESPONSE_CODES] } },
      additionalProperties: false,
    }),
  ReviewerQueuePermissionView: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ReviewerQueuePermissionView,
      properties: {
        actorUserId: str,
        canReadQueue: bool,
        canManageQueue: bool,
        denialReasons: { type: "array", items: str },
      },
      additionalProperties: false,
    }),

  // Asset decisions --------------------------------------------------------
  ApiAssetDecisionsResponse: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiAssetDecisionsResponse,
      properties: { decisions: arr },
      additionalProperties: false,
    }),
  ApiCandidateAssetsResponse: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiCandidateAssetsResponse,
      properties: { candidateAssets: arr },
      additionalProperties: false,
    }),

  // Catalog ----------------------------------------------------------------
  CatalogBenchmarkSeedFinderReadModel: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.CatalogBenchmarkSeedFinderReadModel,
      properties: { targetLanguage: str, rows: arr },
      additionalProperties: false,
      schemaVersion: "catalog.benchmark_seed_finder.v0.1",
    }),
  CatalogCompletenessBenchmarkPools: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.CatalogCompletenessBenchmarkPools,
      properties: { targetLanguage: str, pools: obj, publicReport: obj },
      additionalProperties: false,
    }),
  CatalogConflictReviewReadModel: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.CatalogConflictReviewReadModel,
      properties: { rows: arr },
      additionalProperties: false,
    }),
  CatalogOpportunityRankingReadModel: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.CatalogOpportunityRankingReadModel,
      properties: { targetLanguage: str, weightsVersion: str, rows: arr },
      additionalProperties: false,
      schemaVersion: "catalog.opportunity_ranking.v0.1",
    }),

  // Reviewer ---------------------------------------------------------------
  ReviewerQueueDashboardReadModel: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ReviewerQueueDashboardReadModel,
      properties: {
        localeBranchId: str,
        permission: ref("ReviewerQueuePermissionView"),
        rows: arr,
        aggregate: obj,
        defaultBatchRequest: obj,
      },
      additionalProperties: false,
      schemaVersion: "reviewer.queue_dashboard.v0.1",
    }),
  ReviewerDetailContext: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ReviewerDetailContext,
      properties: { reviewItemId: str, permission: ref("ReviewerQueuePermissionView") },
      additionalProperties: false,
    }),
  ReviewerBatchPreview: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ReviewerBatchPreview,
      properties: {
        permission: ref("ReviewerQueuePermissionView"),
        items: arr,
        aggregate: obj,
        allAllowed: bool,
        permissionDenied: bool,
      },
      additionalProperties: false,
    }),
  ReviewerBatchExecuteResult: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ReviewerBatchExecuteResult,
      properties: { applied: arr, refusedAll: bool, appliedAll: bool },
      additionalProperties: false,
    }),
  ReviewerSingleActionResult: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ReviewerSingleActionResult,
      properties: { applied: bool, refused: bool },
      additionalProperties: false,
    }),

  // Terminology ------------------------------------------------------------
  TerminologySearchReadModel: () =>
    object({
      required: ["query", "normalizedQuery", "localeBranchId", "results"],
      properties: { query: str, normalizedQuery: str, localeBranchId: str, results: arr },
      additionalProperties: true,
    }),
  WikiEntriesReadModel: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.WikiEntriesReadModel,
      properties: {
        generatedAt: str,
        filter: obj,
        pagination: obj,
        brandContext: obj,
        entries: arr,
      },
      additionalProperties: false,
      schemaVersion: "wiki.entries.v0.1",
    }),

  // Workspace --------------------------------------------------------------
  WorkspaceProjectBrowseReadModel: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.WorkspaceProjectBrowseReadModel,
      properties: {
        permission: ref("ReviewerQueuePermissionView"),
        projects: arr,
        diagnostics: arr,
      },
      additionalProperties: false,
      schemaVersion: "workspace.project_browse.v0.1",
    }),
  WorkspaceSceneBrowseReadModel: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.WorkspaceSceneBrowseReadModel,
      properties: {
        permission: ref("ReviewerQueuePermissionView"),
        projectId: str,
        localeBranchId: str,
        scenes: arr,
        diagnostics: arr,
      },
      additionalProperties: false,
      schemaVersion: "workspace.scene_browse.v0.1",
    }),
  WorkspaceAssetBrowseReadModel: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.WorkspaceAssetBrowseReadModel,
      properties: {
        permission: ref("ReviewerQueuePermissionView"),
        projectId: str,
        localeBranchId: str,
        assets: arr,
        diagnostics: arr,
      },
      additionalProperties: false,
      schemaVersion: "workspace.asset_browse.v0.1",
    }),
  WorkspaceComparisonReadModel: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.WorkspaceComparisonReadModel,
      properties: {
        permission: ref("ReviewerQueuePermissionView"),
        reviewItemId: str,
        localeBranchId: str,
        cells: arr,
        hasFinal: bool,
        runtimeEvidenceLinks: arr,
        diagnostics: arr,
      },
      additionalProperties: false,
      schemaVersion: "workspace.comparison.v0.1",
    }),
  WorkspaceSearchReadModel: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.WorkspaceSearchReadModel,
      properties: {
        permission: ref("ReviewerQueuePermissionView"),
        projectId: str,
        localeBranchId: str,
        query: str,
        normalizedQuery: str,
        mode: str,
        pagination: obj,
        results: arr,
        droppedOpaqueCount: num,
        diagnostics: arr,
      },
      additionalProperties: false,
      schemaVersion: "workspace.search.v0.1",
    }),
  WorkspaceCorrectionPreviewReadModel: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.WorkspaceCorrectionPreviewReadModel,
      properties: {
        permission: ref("ReviewerQueuePermissionView"),
        projectId: nullableStr,
        localeBranchId: str,
        sourceBundleId: nullableStr,
        targetLocale: nullableStr,
        units: arr,
        diagnostics: arr,
      },
      additionalProperties: false,
      schemaVersion: "workspace.correction_preview.v0.1",
    }),
  WorkspaceCorrectionSubmitReadModel: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.WorkspaceCorrectionSubmitReadModel,
      properties: {
        permission: ref("ReviewerQueuePermissionView"),
        localeBranchId: str,
        batchId: str,
        submittedCount: num,
        edits: arr,
        repairCandidateReportIds: arr,
        decisionQueueReportIds: arr,
        needsContextReportIds: arr,
        affectedBridgeUnitIds: arr,
        writebacks: arr,
        scheduledRerunJobIds: arr,
        diagnostics: arr,
      },
      additionalProperties: false,
      schemaVersion: "workspace.correction_submit.v0.1",
    }),

  // Projects / dashboards --------------------------------------------------
  ApiProjectsResponse: () =>
    object({ required: ["projects"], properties: { projects: arr }, additionalProperties: true }),
  ProjectDashboardStatus: () =>
    object({
      required: [
        "projectId",
        "projectKey",
        "name",
        "status",
        "sourceLocale",
        "sourceBundleId",
        "sourceBundleHash",
        "sourceBundleRevisionId",
        "branchCount",
        "unitCount",
        "findingCount",
        "artifactCount",
        "importStatus",
        "cost",
        "localeBranches",
      ],
      properties: {
        projectId: str,
        projectKey: str,
        name: str,
        status: str,
        sourceLocale: str,
        sourceBundleId: str,
        sourceBundleHash: str,
        sourceBundleRevisionId: str,
        branchCount: num,
        unitCount: num,
        findingCount: num,
        artifactCount: num,
        importStatus: obj,
        cost: obj,
        localeBranches: arr,
      },
      additionalProperties: true,
    }),
  DashboardDecisionReadModel: () =>
    object({
      required: ["projectId", "counts", "pendingDecisions"],
      properties: { projectId: str, counts: obj, pendingDecisions: arr },
      additionalProperties: true,
    }),
  ProjectOverviewReadModel: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ProjectOverviewReadModel,
      properties: {
        generatedAt: str,
        projectId: str,
        progress: ref("ProjectDashboardStatus"),
        decisions: ref("DashboardDecisionReadModel"),
        cost: ref("ProjectCostReport"),
        telemetry: obj,
        costDrilldown: ref("CostDrilldownPage"),
        passLedger: obj,
        benchmarkHeadline: obj,
        canSteer: bool,
      },
      additionalProperties: false,
      schemaVersion: "projects.overview.v0.1",
    }),
  ProjectCostReport: () =>
    object({
      required: [
        "projectId",
        "currency",
        "runCount",
        "billedMicrosUsd",
        "zeroRunCount",
        "totalsByCostKind",
        "recentRuns",
        "translationMemoryReuse",
      ],
      properties: {
        projectId: str,
        currency: str,
        runCount: num,
        billedMicrosUsd: num,
        zeroRunCount: num,
        totalsByCostKind: arr,
        recentRuns: arr,
        translationMemoryReuse: obj,
      },
      additionalProperties: true,
    }),
  CostDrilldownPage: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.CostDrilldownPage,
      properties: { filter: obj, pagination: obj, rows: arr },
      additionalProperties: false,
    }),
  JobsRunTableReadModel: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.JobsRunTableReadModel,
      properties: { generatedAt: str, filter: obj, pagination: obj, rows: arr },
      additionalProperties: false,
      schemaVersion: "jobs.run_table.v0.1",
    }),
  ApiBenchmarkReportsResponse: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiBenchmarkReportsResponse,
      properties: { reports: arr },
      additionalProperties: false,
    }),
  // itotori-bmk-cockpit-read-model — the benchmark cockpit read-model wire
  // envelope. The deep body fields (contestants / humanAnchor / confidence /
  // actionableBacklog) are typed objects — the schema pins the wire envelope
  // (the top-level required keys + the schemaVersion const); the guarded
  // runtime API asserts and re-projects the deep shape on the API boundary.
  BmkCockpitReadModel: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.BmkCockpitReadModel,
      properties: {
        generatedAt: str,
        projectId: str,
        localeBranchId: { type: ["string", "null"] },
        runId: str,
        targetLocale: str,
        kind: { enum: ["real_run", "fixture", "replay"] },
        status: { enum: ["succeeded", "failed", "partial"] },
        unitsScored: num,
        recordedAt: str,
        contestants: arr,
        rankedRoles: arr,
        humanAnchor: obj,
        confidence: obj,
        actionableBacklog: obj,
        actionableBacklogSize: num,
      },
      additionalProperties: false,
      schemaVersion: "itotori.bmk-cockpit.v0.1",
    }),
  // itotori-bmk-cockpit-history — paged run-history wire envelope.
  BmkCockpitRunHistoryPage: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.BmkCockpitRunHistoryPage,
      properties: { filter: obj, pagination: obj, rows: arr },
      additionalProperties: false,
    }),
  RuntimeDashboardStatus: () =>
    object({
      required: [
        "finalStatus",
        "runtimeRunId",
        "runtimeReportId",
        "runtimeStatus",
        "fidelityTier",
        "evidenceTier",
        "textEventCount",
        "frameCaptureCount",
        "screenshotArtifactCount",
        "recordingArtifactCount",
        "validationFindingCount",
        "traceEvents",
        "findings",
        "artifacts",
        "approximations",
        "unsupportedCapabilities",
        "limitations",
      ],
      properties: {
        finalStatus: str,
        runtimeStatus: str,
        fidelityTier: str,
        evidenceTier: str,
        textEventCount: num,
        frameCaptureCount: num,
        screenshotArtifactCount: num,
        recordingArtifactCount: num,
        validationFindingCount: num,
        traceEvents: arr,
        findings: arr,
        artifacts: arr,
        approximations: arr,
        unsupportedCapabilities: arr,
        limitations: arr,
      },
      additionalProperties: true,
    }),
  QueueHealthReadModel: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.QueueHealthReadModel,
      properties: { outbox: obj, jobs: obj },
      additionalProperties: false,
      schemaVersion: "itotori.queue_health.v0.1",
    }),
  ApiModelRoutingProvider: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiModelRoutingProvider,
      properties: {
        providerId: str,
        providerFamily: str,
        endpointFamily: str,
        providerName: str,
        metadata: obj,
      },
      additionalProperties: false,
    }),
  ApiModelRoutingModel: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiModelRoutingModel,
      properties: {
        modelRegistryId: str,
        providerId: str,
        modelId: str,
        capabilities: obj,
        pricing: obj,
      },
      additionalProperties: false,
    }),
  ApiModelRoutingPromptPreset: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiModelRoutingPromptPreset,
      properties: {
        promptPresetId: str,
        promptTemplateVersion: str,
        presetSchemaVersion: str,
        promptHash: str,
        configSnapshot: obj,
      },
      additionalProperties: false,
    }),
  ApiModelRoutingRoute: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiModelRoutingRoute,
      properties: {
        projectId: str,
        taskKind: str,
        providerId: str,
        modelId: str,
        modelRegistryId: str,
        fallbackModelIds: { type: "array", items: str },
        promptPresetId: str,
        promptTemplateVersion: str,
        updatedAt: str,
      },
      additionalProperties: false,
    }),
  ApiModelRoutingSettingsResponse: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiModelRoutingSettingsResponse,
      properties: {
        projectId: str,
        generatedAt: str,
        providers: { type: "array", items: ref("ApiModelRoutingProvider") },
        models: { type: "array", items: ref("ApiModelRoutingModel") },
        promptPresets: { type: "array", items: ref("ApiModelRoutingPromptPreset") },
        routes: { type: "array", items: ref("ApiModelRoutingRoute") },
      },
      additionalProperties: false,
      schemaVersion: "itotori.settings.model-routing.v0",
    }),
  ApiSaveModelRoutingSettingsRequest: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiSaveModelRoutingSettingsRequest,
      properties: {
        projectId: str,
        taskKind: str,
        providerId: str,
        modelId: str,
        fallbackModelIds: { type: "array", items: str },
        promptPresetId: str,
        promptTemplateVersion: str,
      },
      additionalProperties: false,
    }),
  ApiBranchPolicyRule: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiBranchPolicyRule,
      properties: { ruleId: str, guidance: str },
      additionalProperties: false,
    }),
  ApiBranchPolicySections: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiBranchPolicySections,
      properties: {
        tone: { type: "array", items: ref("ApiBranchPolicyRule") },
        terminology: { type: "array", items: ref("ApiBranchPolicyRule") },
        honorifics: { type: "array", items: ref("ApiBranchPolicyRule") },
        formatting: { type: "array", items: ref("ApiBranchPolicyRule") },
        protectedSpans: { type: "array", items: ref("ApiBranchPolicyRule") },
      },
      additionalProperties: false,
    }),
  ApiBranchPolicyPolicy: (ref) =>
    object({
      required: ["schemaVersion", "sections"],
      properties: {
        sections: ref("ApiBranchPolicySections"),
      },
      additionalProperties: false,
      schemaVersion: "style-guide-policy.v0",
    }),
  ApiBranchPolicySourceRevisionReference: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiBranchPolicySourceRevisionReference,
      properties: {
        sourceRevisionId: str,
        revisionKind: str,
        value: str,
      },
      additionalProperties: false,
    }),
  ApiBranchPolicyVersion: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiBranchPolicyVersion,
      properties: {
        styleGuideVersionId: str,
        status: str,
        versionSequence: num,
        createdAt: str,
        updatedAt: str,
        approvedAt: nullableStr,
        policy: ref("ApiBranchPolicyPolicy"),
      },
      additionalProperties: false,
    }),
  ApiBranchPolicyGlossaryReference: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiBranchPolicyGlossaryReference,
      properties: {
        referenceId: str,
        versionSequence: num,
        styleGuideVersionId: nullableStr,
        glossaryContentHash: str,
        glossaryTermCount: num,
        glossaryReviewItemCount: num,
        updateReason: str,
        createdAt: str,
      },
      additionalProperties: false,
    }),
  ApiBranchPolicySettingsResponse: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiBranchPolicySettingsResponse,
      properties: {
        projectId: str,
        localeBranchId: str,
        targetLocale: str,
        sourceRevision: ref("ApiBranchPolicySourceRevisionReference"),
        latestVersion: { oneOf: [ref("ApiBranchPolicyVersion"), { type: "null" }] },
        approvedVersion: { oneOf: [ref("ApiBranchPolicyVersion"), { type: "null" }] },
        branchReference: {
          oneOf: [ref("ApiBranchPolicyGlossaryReference"), { type: "null" }],
        },
        policy: ref("ApiBranchPolicyPolicy"),
      },
      additionalProperties: false,
      schemaVersion: "itotori.settings.branch-policy.v0",
    }),
  ApiSaveBranchPolicySettingsRequest: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiSaveBranchPolicySettingsRequest,
      properties: {
        projectId: str,
        localeBranchId: str,
        expectedPreviousVersionId: nullableStr,
        updateReason: str,
        policy: ref("ApiBranchPolicyPolicy"),
      },
      additionalProperties: false,
    }),
  ApiConfigureAuthSsoSettingsRequest: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiConfigureAuthSsoSettingsRequest,
      properties: {
        accountId: str,
        provider: obj,
        security: obj,
        sessionPolicy: obj,
      },
      additionalProperties: false,
    }),
  ApiConfigureAuthSsoSettingsResponse: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiConfigureAuthSsoSettingsResponse,
      properties: {
        accountId: str,
        provider: obj,
        security: obj,
        sessionPolicy: obj,
        updatedAt: str,
      },
      additionalProperties: false,
      schemaVersion: "itotori.auth.sso-settings.v0",
    }),
  ApiInviteMemberRequest: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiInviteMemberRequest,
      properties: {
        accountId: str,
        email: str,
        initialPermissionSetIds: { type: "array", items: str },
        expiresAt: str,
        reason: { oneOf: [str, { type: "null" }] },
        requestId: { oneOf: [str, { type: "null" }] },
      },
      additionalProperties: false,
    }),
  ApiMemberInvitationResponse: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiMemberInvitationResponse,
      properties: {
        invitationId: str,
        accountId: str,
        email: str,
        initialPermissionSetIds: { type: "array", items: str },
        expiresAt: str,
        acceptedAt: { oneOf: [str, { type: "null" }] },
        revokedAt: { oneOf: [str, { type: "null" }] },
        createdAt: str,
      },
      additionalProperties: false,
      schemaVersion: "itotori.auth.member-invitation.v0",
    }),
  ApiAcceptMemberInvitationRequest: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiAcceptMemberInvitationRequest,
      properties: {
        userId: str,
        principalId: str,
        displayName: str,
        email: str,
        externalIdentity: { oneOf: [obj, { type: "null" }] },
        reason: { oneOf: [str, { type: "null" }] },
        requestId: { oneOf: [str, { type: "null" }] },
      },
      additionalProperties: false,
    }),
  ApiMemberRecord: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiMemberRecord,
      properties: {
        membershipId: str,
        accountId: str,
        userId: str,
        principalId: str,
        email: { oneOf: [str, { type: "null" }] },
        displayName: str,
        permissionSetIds: { type: "array", items: str },
        createdAt: str,
      },
      additionalProperties: false,
    }),
  ApiMemberResponse: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiMemberResponse,
      properties: { member: ref("ApiMemberRecord") },
      additionalProperties: false,
      schemaVersion: "itotori.auth.member.v0",
    }),
  ApiMembersListResponse: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiMembersListResponse,
      properties: {
        accountId: str,
        members: { type: "array", items: ref("ApiMemberRecord") },
      },
      additionalProperties: false,
      schemaVersion: "itotori.auth.members.v0",
    }),
  ApiAuthBillingSeatUsageResponse: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiAuthBillingSeatUsageResponse,
      properties: {
        accountId: str,
        planId: str,
        planName: str,
        billingPeriod: { enum: ["monthly", "annual", "manual"] },
        seatLimit: num,
        includedSeats: num,
        usedSeats: num,
        pendingInvitations: num,
        availableSeats: num,
        overSeatLimit: bool,
        updatedAt: str,
      },
      additionalProperties: false,
      schemaVersion: "itotori.auth.billing-seat-usage.v0",
    }),
  ApiRemoveMemberRequest: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiRemoveMemberRequest,
      properties: {
        reason: { oneOf: [str, { type: "null" }] },
        requestId: { oneOf: [str, { type: "null" }] },
      },
      additionalProperties: false,
    }),
  ApiAuthSessionRecord: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiAuthSessionRecord,
      properties: {
        sessionId: str,
        principalId: str,
        createdAt: str,
        expiresAt: str,
        revokedAt: { oneOf: [str, { type: "null" }] },
        isActive: bool,
        deviceLabel: { oneOf: [str, { type: "null" }] },
        userAgent: { oneOf: [str, { type: "null" }] },
        ipAddress: { oneOf: [str, { type: "null" }] },
      },
      additionalProperties: false,
    }),
  ApiAuthSessionsListResponse: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiAuthSessionsListResponse,
      properties: {
        principalId: str,
        sessions: { type: "array", items: ref("ApiAuthSessionRecord") },
      },
      additionalProperties: false,
      schemaVersion: "itotori.auth.sessions.v0",
    }),
  ApiRevokeAuthSessionRequest: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiRevokeAuthSessionRequest,
      properties: {
        reason: { oneOf: [str, { type: "null" }] },
        requestId: { oneOf: [str, { type: "null" }] },
      },
      additionalProperties: false,
    }),
  ApiRevokeAuthSessionResponse: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiRevokeAuthSessionResponse,
      properties: { revokedSession: ref("ApiAuthSessionRecord") },
      additionalProperties: false,
      schemaVersion: "itotori.auth.session-revoked.v0",
    }),
  ApiRemoveMemberResponse: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiRemoveMemberResponse,
      properties: { removedMember: ref("ApiMemberRecord") },
      additionalProperties: false,
      schemaVersion: "itotori.auth.member-removed.v0",
    }),
  ApiPermissionSetRecord: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiPermissionSetRecord,
      properties: {
        permissionSetId: str,
        accountId: str,
        name: str,
        permissions: { type: "array", items: str },
      },
      additionalProperties: false,
    }),
  ApiPermissionSetsListResponse: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiPermissionSetsListResponse,
      properties: {
        accountId: str,
        permissionSets: { type: "array", items: ref("ApiPermissionSetRecord") },
      },
      additionalProperties: false,
      schemaVersion: "itotori.auth.permission-sets.v0",
    }),
  ApiPrincipalPermissionSetGrantRequest: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiPrincipalPermissionSetGrantRequest,
      properties: {
        reason: { oneOf: [str, { type: "null" }] },
        requestId: { oneOf: [str, { type: "null" }] },
      },
      additionalProperties: false,
    }),
  ApiPrincipalPermissionSetGrantResponse: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiPrincipalPermissionSetGrantResponse,
      properties: {
        principalId: str,
        permissionSetId: str,
        action: { enum: ["granted", "revoked"] },
        updatedMember: ref("ApiMemberRecord"),
      },
      additionalProperties: false,
      schemaVersion: "itotori.auth.permission-set-grant.v0",
    }),
  ApiAuthIdentityAccount: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiAuthIdentityAccount,
      properties: {
        membershipId: str,
        accountId: str,
        accountSlug: str,
        accountName: str,
        permissionSetIds: { type: "array", items: str },
        createdAt: str,
      },
      additionalProperties: false,
    }),
  ApiAuthIdentityResponse: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiAuthIdentityResponse,
      properties: {
        actorUserId: str,
        userId: str,
        principalId: { oneOf: [str, { type: "null" }] },
        email: { oneOf: [str, { type: "null" }] },
        displayName: str,
        accounts: { type: "array", items: ref("ApiAuthIdentityAccount") },
      },
      additionalProperties: false,
      schemaVersion: "itotori.auth.identity.v0",
    }),
  // fnd-caps-context — Studio capability permission view wire schemas.
  ApiStudioCapabilityDenials: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiStudioCapabilityDenials,
      properties: {
        flag: { oneOf: [str, { type: "null" }] },
        decide: { oneOf: [str, { type: "null" }] },
        steer: { oneOf: [str, { type: "null" }] },
        reveal: { oneOf: [str, { type: "null" }] },
        queueRead: { oneOf: [str, { type: "null" }] },
        queueManage: { oneOf: [str, { type: "null" }] },
      },
      additionalProperties: false,
    }),
  ApiAuthCapabilitiesResponse: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiAuthCapabilitiesResponse,
      properties: {
        actorUserId: str,
        canReadQueue: bool,
        canManageQueue: bool,
        canFlag: bool,
        canDecide: bool,
        canSteer: bool,
        canReveal: bool,
        denials: ref("ApiStudioCapabilityDenials"),
        denialReasons: { type: "array", items: str },
      },
      additionalProperties: false,
      schemaVersion: "itotori.auth.capabilities.v0",
    }),

  // Mutations --------------------------------------------------------------
  ApiProjectImportResponse: () =>
    object({
      required: ["project", "status"],
      properties: { project: obj, status: obj },
      additionalProperties: true,
    }),
  ApiDraftBranchResponse: () =>
    object({
      required: ["project", "status"],
      properties: { project: obj, status: obj },
      additionalProperties: true,
    }),
  ApiRecordFindingResponse: () =>
    object({
      required: ["findingId", "status"],
      properties: { findingId: str, status: { enum: ["open", "resolved", "superseded"] } },
      additionalProperties: true,
    }),
  ApiRecordDecisionResponse: () =>
    object({
      required: ["decisionId", "eventKind", "recorded"],
      properties: { decisionId: str, eventKind: str, recorded: bool },
      additionalProperties: true,
    }),
  ApiRecordBenchmarkResponse: () =>
    object({
      required: ["benchmarkRunId", "artifactId", "status", "systemCount", "findingCount"],
      properties: {
        benchmarkRunId: str,
        artifactId: str,
        status: { enum: ["passed", "failed", "partial"] },
        systemCount: num,
        findingCount: num,
      },
      additionalProperties: true,
    }),
  ApiRuntimeEvidenceResponse: () =>
    object({
      required: [
        "status",
        "bridgeId",
        "localeBranchId",
        "patchResultId",
        "runtimeReportId",
        "dashboard",
      ],
      properties: {
        status: { enum: ["hello_world_passed", "hello_world_failed"] },
        bridgeId: str,
        localeBranchId: str,
        patchResultId: str,
        runtimeReportId: str,
        patchExportId: str,
        dashboard: obj,
      },
      additionalProperties: true,
    }),

  // Request bodies ---------------------------------------------------------
  ApiProjectImportRequest: () =>
    object({
      required: ["bridge"],
      properties: { bridge: obj, bootstrapSelection: obj },
      additionalProperties: true,
    }),
  ApiDraftBranchRequest: () =>
    object({
      required: ["project", "targetLocale"],
      properties: { project: obj, targetLocale: str },
      additionalProperties: true,
    }),
  ApiRecordFindingRequest: () =>
    object({
      required: ["finding"],
      properties: {
        finding: obj,
        localeBranchId: str,
        status: { enum: ["open", "resolved", "superseded"] },
      },
      additionalProperties: true,
    }),
  ApiRecordDecisionRequest: () =>
    object({
      required: ["event"],
      properties: { event: obj, localeBranchId: str },
      additionalProperties: true,
    }),
  ApiRecordBenchmarkRequest: () =>
    object({
      required: ["benchmarkReport"],
      properties: { benchmarkReport: obj },
      additionalProperties: true,
    }),
  ApiRuntimeEvidenceRequest: () =>
    object({
      required: ["project", "runtimeReport"],
      properties: { project: obj, runtimeReport: obj },
      additionalProperties: true,
    }),
  ReviewerBatchActionRequest: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ReviewerBatchActionRequest,
      properties: { action: str, actorUserId: str, selections: arr },
      additionalProperties: false,
    }),
  ApiReviewerSingleActionRequest: () =>
    object({
      required: ["action", "actorUserId", "expectedSourceRevisionId"],
      properties: {
        action: { enum: [...reviewerSingleActionList] },
        actorUserId: str,
        expectedSourceRevisionId: str,
      },
      additionalProperties: true,
    }),
  ApiWorkspaceCorrectionSubmitRequest: () =>
    object({
      required: ["projectId", "localeBranchId", "targetLocale", "actorUserId", "corrections"],
      properties: {
        projectId: str,
        localeBranchId: str,
        sourceBundleId: str,
        targetLocale: str,
        actorUserId: str,
        corrections: arr,
        batchLabel: str,
        actorDisplayName: str,
      },
      additionalProperties: true,
    }),

  // Launch-pass (ovw-launch-pass-action) ----------------------------------
  ApiLaunchPassRequest: () =>
    object({
      required: ["localeBranchId"],
      properties: { localeBranchId: str },
      additionalProperties: true,
    }),
  ApiLaunchPassResponse: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiLaunchPassResponse,
      properties: { outcome: { enum: ["started", "refused"] } },
      additionalProperties: false,
      schemaVersion: "itotori.projects.launch-pass.v0",
    }),

  // play-routemap-ui — route/choice tree envelope -------------------------
  ApiPlayRouteMapNode: () =>
    object({
      required: [
        "routeKey",
        "routeMapId",
        "label",
        "summary",
        "col",
        "row",
        "state",
        "coverage",
        "issues",
      ],
      properties: {
        routeKey: str,
        routeMapId: str,
        label: str,
        summary: str,
        col: num,
        row: num,
        state: { enum: ["fresh", "stale"] },
        coverage: { enum: ["fresh", "stale"] },
        issues: num,
      },
      additionalProperties: false,
    }),
  ApiPlayRouteMapEdge: () =>
    object({
      required: ["fromRouteKey", "toRouteKey", "choiceKey", "choiceKind", "label"],
      properties: {
        fromRouteKey: str,
        toRouteKey: str,
        choiceKey: str,
        choiceKind: str,
        label: str,
      },
      additionalProperties: false,
    }),
  ApiPlayRouteMapCounts: () =>
    object({
      required: ["fresh", "stale", "total", "choiceCount"],
      properties: {
        fresh: num,
        stale: num,
        total: num,
        choiceCount: num,
      },
      additionalProperties: false,
    }),
  ApiPlayRouteMapResponse: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiPlayRouteMapResponse,
      properties: {
        nodes: { type: "array", items: ref("ApiPlayRouteMapNode") },
        edges: { type: "array", items: ref("ApiPlayRouteMapEdge") },
        counts: ref("ApiPlayRouteMapCounts"),
      },
      additionalProperties: false,
      schemaVersion: "itotori.play.route-map.v0",
    }),

  // play-mark-validated — scene coverage read/write envelopes --------------
  // Nested node/edge/counts shapes are named components so OpenAPI consumers
  // can enforce coverageState + counts fields (not bare array/object stubs).
  ApiPlaySceneCoverageNode: () =>
    object({
      required: ["sceneId", "label", "coverageState", "routeKey", "routeMapId"],
      properties: {
        sceneId: str,
        label: str,
        coverageState: { enum: ["needs_check", "flagged", "validated"] },
        routeKey: { type: ["string", "null"] },
        routeMapId: { type: ["string", "null"] },
      },
      additionalProperties: false,
    }),
  ApiPlaySceneCoverageEdge: () =>
    object({
      required: ["fromSceneId", "toSceneId", "choiceKey", "label"],
      properties: {
        fromSceneId: str,
        toSceneId: str,
        choiceKey: str,
        label: str,
      },
      additionalProperties: false,
    }),
  ApiPlaySceneCoverageCounts: () =>
    object({
      required: ["needsCheck", "flagged", "validated", "total"],
      properties: {
        needsCheck: num,
        flagged: num,
        validated: num,
        total: num,
      },
      additionalProperties: false,
    }),
  ApiPlaySetSceneCoverageRequest: () =>
    object({
      required: ["sceneId", "coverageState"],
      properties: {
        sceneId: str,
        coverageState: { enum: ["needs_check", "flagged", "validated"] },
      },
      additionalProperties: true,
    }),
  ApiPlaySceneCoverageResponse: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiPlaySceneCoverageResponse,
      properties: {
        nodes: { type: "array", items: ref("ApiPlaySceneCoverageNode") },
        edges: { type: "array", items: ref("ApiPlaySceneCoverageEdge") },
        counts: ref("ApiPlaySceneCoverageCounts"),
      },
      additionalProperties: false,
      schemaVersion: "itotori.play.scene-coverage.v0",
    }),
  ApiPlaySetSceneCoverageResponse: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiPlaySetSceneCoverageResponse,
      properties: {
        coverageState: { enum: ["needs_check", "flagged", "validated"] },
      },
      additionalProperties: false,
      schemaVersion: "itotori.play.set-scene-coverage.v0",
    }),

  // play-flag-composer — AnnotationComposer submit envelopes
  ApiPlayFlagAnnotationRequest: () =>
    object({
      required: ["note", "severity", "targetLocale"],
      properties: {
        note: str,
        severity: { enum: ["blocker", "critical", "warning", "note"] },
        category: str,
        targetLocale: str,
        bridgeUnitId: str,
        sourceUnitKey: str,
        sourceBundleId: str,
        sourceRevisionId: str,
        sceneId: str,
        suggestedEdit: str,
        actorUserId: str,
        actorDisplayName: str,
      },
      additionalProperties: true,
    }),
  ApiPlayFlagAnnotationResponse: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiPlayFlagAnnotationResponse,
      properties: {
        severity: { enum: ["blocker", "critical", "warning", "note"] },
        queueEnqueued: bool,
        duplicate: bool,
      },
      additionalProperties: false,
      schemaVersion: "itotori.play.flag-annotation.v0",
    }),
};

/** Materialize the component table with `$ref`s pointing at `prefix` + name. */
function materializeComponents(prefix: string): Record<string, JsonValue> {
  const ref: Ref = (name) => ({ $ref: `${prefix}${name}` });
  const out: Record<string, JsonValue> = {};
  for (const [name, build] of Object.entries(COMPONENTS)) {
    out[name] = build(ref) as JsonValue;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Route registry — the SINGLE authority for the /api route topology.
// ---------------------------------------------------------------------------

export {
  ITOTORI_API_ROUTE_IDS,
  ITOTORI_API_ROUTES,
  interpolateRoutePath,
  type ItotoriApiRoute,
} from "./api-routes.js";

// ---------------------------------------------------------------------------
// Emitted artifacts — the OpenAPI document + the JSON-Schema bundle.
// ---------------------------------------------------------------------------

const ERROR_STATUS_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "400": "Malformed request (bad_request).",
  "403": "Permission denied (forbidden).",
  "404": "Route or resource not found (not_found).",
  "405": "Method not allowed (method_not_allowed).",
  "500": "Internal error (internal_error).",
};

function openApiErrorResponses(): Record<string, JsonValue> {
  const responses: Record<string, JsonValue> = {};
  for (const [status, description] of Object.entries(ERROR_STATUS_DESCRIPTIONS)) {
    responses[status] = {
      description,
      content: {
        "application/json": { schema: { $ref: "#/components/schemas/ApiErrorResponse" } },
      },
    };
  }
  return responses;
}

/**
 * Build the deterministic OpenAPI 3.1 document derived from
 * {@link ITOTORI_API_ROUTES} + the component table. Carries the product version
 * (`ITOTORI_PRODUCT_VERSION`) per the format-stability policy. Serialize with
 * {@link serializeJsonDocument} for the committed artifact.
 */
export function buildItotoriOpenApiDocument(): JsonValue {
  const paths: Record<string, Record<string, JsonValue>> = {};
  for (const routeId of ITOTORI_API_ROUTE_IDS) {
    const route = ITOTORI_API_ROUTES[routeId];
    const operation: Record<string, JsonValue> = {
      operationId: route.operationId,
      summary: route.summary,
      "x-itotoriRouteId": routeId,
      responses: {
        "200": {
          description: "Success.",
          content: {
            "application/json": {
              schema: { $ref: `#/components/schemas/${route.responseSchema}` },
            },
          },
        },
        ...openApiErrorResponses(),
      },
    };
    if (route.pathParams.length > 0) {
      operation.parameters = route.pathParams.map((name) => ({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
      }));
    }
    if (route.requestSchema !== undefined) {
      operation.requestBody = {
        required: true,
        content: {
          "application/json": { schema: { $ref: `#/components/schemas/${route.requestSchema}` } },
        },
      };
    }
    const pathItem = paths[route.pathTemplate] ?? (paths[route.pathTemplate] = {});
    pathItem[route.method.toLowerCase()] = operation;
  }

  const document: JsonValue = {
    openapi: "3.1.0",
    info: {
      title: "Itotori /api contract",
      version: ITOTORI_PRODUCT_VERSION,
      description:
        "Emitted deterministically FROM the api-schema.ts type-guard authority " +
        "(fe-api-openapi-emit). Do not hand-edit; regenerate with the openapi " +
        "emitter. The guards remain the deep contract authority; this document " +
        "pins the wire envelope + route topology.",
    },
    paths,
    components: { schemas: materializeComponents("#/components/schemas/") },
  };
  return document;
}

/**
 * Build the standalone JSON-Schema bundle (draft-07 `definitions`) — the
 * committed `api-jsonschema.json`. Every request/response component is a named
 * definition; {@link jsonSchemaForRoute} slices out a validatable per-route
 * schema.
 */
export function buildItotoriJsonSchemaBundle(): JsonValue {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: `https://itotori.dev/api/json-schema/v${ITOTORI_PRODUCT_VERSION}`,
    title: "Itotori /api JSON-Schema bundle",
    description:
      "Emitted deterministically FROM api-schema.ts (fe-api-openapi-emit). Wire " +
      "envelope + route-body definitions; the guards remain the deep authority.",
    "x-itotoriProductVersion": ITOTORI_PRODUCT_VERSION,
    definitions: materializeComponents("#/definitions/"),
  };
}

/**
 * A validatable JSON-Schema (draft-07) for one route's request or response
 * body: a `$ref` into the full `definitions` bundle. Returns `null` when the
 * route has no body of that kind (e.g. a GET request). Used by the HTTP
 * contract harness (validates real responses) and the parity test.
 */
export function jsonSchemaForRoute(
  routeId: ItotoriApiRouteId,
  kind: "request" | "response",
): JsonValue | null {
  const route = ITOTORI_API_ROUTES[routeId];
  const name = kind === "request" ? route.requestSchema : route.responseSchema;
  if (name === undefined) {
    return null;
  }
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $ref: `#/definitions/${name}`,
    definitions: materializeComponents("#/definitions/"),
  };
}

/** The JSON-Schema for the typed {@link ApiErrorResponse} body (any route may emit one). */
export function jsonSchemaForApiError(): JsonValue {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $ref: "#/definitions/ApiErrorResponse",
    definitions: materializeComponents("#/definitions/"),
  };
}

/** Serialized committed OpenAPI document (deterministic). */
export function serializeItotoriOpenApiDocument(): string {
  return serializeJsonDocument(buildItotoriOpenApiDocument());
}

/** Serialized committed JSON-Schema bundle (deterministic). */
export function serializeItotoriJsonSchemaBundle(): string {
  return serializeJsonDocument(buildItotoriJsonSchemaBundle());
}
