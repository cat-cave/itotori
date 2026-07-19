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
// for every strict route. The loose
// (`additionalProperties:true`) bodies keep their guard<->schema parity proven
// by real response fixtures. The parity suite adds per-route teeth for all
// routes (a dropped required key or a leaked strict field fails).
import { ITOTORI_PRODUCT_VERSION } from "@itotori/localization-bridge-schema";
import {
  API_ERROR_RESPONSE_CODES,
  ITOTORI_STRICT_API_BODY_KEYS,
  type ItotoriApiRouteId,
} from "./api-schema.js";
import {
  ITOTORI_API_BINARY_ROUTES,
  ITOTORI_API_ROUTE_IDS,
  ITOTORI_API_ROUTES,
} from "./api-routes.js";

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
  CatalogContextPanelReadModel: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.CatalogContextPanelReadModel,
      properties: { params: obj, row: obj, releases: arr, projectState: obj },
      additionalProperties: false,
      schemaVersion: "catalog.context_panel_route.v0.1",
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

  // Terminology ------------------------------------------------------------
  TerminologySearchReadModel: () =>
    object({
      required: ["query", "normalizedQuery", "localeBranchId", "results"],
      properties: { query: str, normalizedQuery: str, localeBranchId: str, results: arr },
      additionalProperties: true,
    }),
  WikiContextEntriesReadModel: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.WikiContextEntriesReadModel,
      properties: {
        generatedAt: str,
        filter: obj,
        pagination: obj,
        entries: arr,
      },
      additionalProperties: false,
      schemaVersion: "wiki.context.entries.v0.1",
    }),
  WikiContextEntryReadModel: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.WikiContextEntryReadModel,
      properties: { generatedAt: str, entry: obj },
      additionalProperties: false,
      schemaVersion: "wiki.context.entry.v0.1",
    }),
  WikiContextEntryHistoryReadModel: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.WikiContextEntryHistoryReadModel,
      properties: {
        generatedAt: str,
        contextArtifactId: str,
        headVersionId: nullableStr,
        versions: arr,
      },
      additionalProperties: false,
      schemaVersion: "wiki.context.entry-history.v0.1",
    }),
  ApiWikiEditRequest: () =>
    object({
      required: ["body", "reason"],
      properties: {
        body: str,
        reason: str,
        title: str,
        affectedUnitIds: arr,
      },
      additionalProperties: false,
    }),
  ApiWikiAddRequest: () =>
    object({
      required: ["sourceRevisionId", "kind", "title", "body", "reason", "affectedUnitIds"],
      properties: {
        sourceRevisionId: str,
        kind: { enum: ["note", "glossary", "style"] },
        title: str,
        body: str,
        reason: str,
        affectedUnitIds: arr,
      },
      additionalProperties: false,
    }),
  ApiWikiEditResponse: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiWikiEditResponse,
      properties: {
        generatedAt: str,
        correctionId: str,
        contextArtifactId: str,
        contextEntryVersionId: str,
        affectedUnitIds: arr,
        invalidatedArtifactIds: arr,
        redraftJobId: str,
        rerun: object({
          required: ["state", "jobStatus", "error"],
          properties: {
            state: { enum: ["succeeded", "pending", "failed"] },
            jobStatus: {
              enum: ["queued", "running", "retry_waiting", "succeeded", "dead_letter", "cancelled"],
            },
            error: nullableStr,
          },
          additionalProperties: false,
        }),
        entry: obj,
      },
      additionalProperties: false,
      schemaVersion: "wiki.context.edit.v0.2",
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
        journal: obj,
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
      schemaVersion: "jobs.run_table.v0.2",
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
  ApiTranslationScopeSettingsResponse: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiTranslationScopeSettingsResponse,
      properties: {
        projectId: str,
        localeBranchId: str,
        scope: {
          enum: ["dialogue-only", "dialogue-and-choices", "dialogue-choices-ui", "all"],
        },
        updatedAt: str,
      },
      additionalProperties: false,
      schemaVersion: "itotori.settings.translation-scope.v0",
    }),
  ApiSaveTranslationScopeSettingsRequest: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiSaveTranslationScopeSettingsRequest,
      properties: {
        projectId: str,
        localeBranchId: str,
        scope: {
          enum: ["dialogue-only", "dialogue-and-choices", "dialogue-choices-ui", "all"],
        },
      },
      additionalProperties: false,
    }),
  ApiLocalizationRunConfigResponse: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiLocalizationRunConfigResponse,
      properties: {
        projectId: str,
        localeBranchId: str,
        configPath: str,
        dataRoot: str,
        pairPolicyPath: str,
        modelId: str,
        providerId: str,
        runDir: str,
        updatedAt: str,
      },
      additionalProperties: false,
      schemaVersion: "itotori.settings.localization-run-config.v0",
    }),
  ApiSaveLocalizationRunConfigRequest: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiSaveLocalizationRunConfigRequest,
      properties: {
        projectId: str,
        localeBranchId: str,
        configPath: str,
        dataRoot: str,
        pairPolicyPath: str,
        modelId: str,
        providerId: str,
        runDir: str,
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
        steer: { oneOf: [str, { type: "null" }] },
        reveal: { oneOf: [str, { type: "null" }] },
      },
      additionalProperties: false,
    }),
  ApiAuthCapabilitiesResponse: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiAuthCapabilitiesResponse,
      properties: {
        actorUserId: str,
        canFlag: bool,
        canSteer: bool,
        canReveal: bool,
        denials: ref("ApiStudioCapabilityDenials"),
        denialReasons: { type: "array", items: str },
      },
      additionalProperties: false,
      schemaVersion: "itotori.auth.capabilities.v0",
    }),

  // Mutations --------------------------------------------------------------
  ApiProjectDecodeExtractResponse: () =>
    object({
      required: ["bridge", "mode", "command"],
      properties: {
        bridge: obj,
        mode: { enum: ["per-scene", "whole-seen"] },
        command: str,
      },
      additionalProperties: true,
    }),
  ApiProjectImportResponse: () =>
    object({
      required: ["project", "status"],
      properties: { project: obj, status: obj },
      additionalProperties: true,
    }),
  ApiDraftBranchResponse: () =>
    object({
      required: ["outcome", "project", "status", "refusalMessage"],
      properties: {
        outcome: { enum: ["drafted", "refused"] },
        project: { oneOf: [obj, { type: "null" }] },
        status: { oneOf: [obj, { type: "null" }] },
        refusalMessage: { oneOf: [str, { type: "null" }] },
      },
      additionalProperties: true,
    }),
  ApiRecordFindingResponse: () =>
    object({
      required: ["findingId", "status"],
      properties: { findingId: str, status: { enum: ["open", "resolved", "superseded"] } },
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
  ApiProjectDecodeExtractRequest: () =>
    object({
      required: ["gameId", "gameVersion", "sourceProfileId", "sourceLocale"],
      properties: {
        vaultCanonicalId: str,
        gameRoot: str,
        gameId: str,
        gameVersion: str,
        sourceProfileId: str,
        sourceLocale: str,
        scene: num,
        wholeSeen: bool,
      },
      additionalProperties: true,
    }),
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
  // Launch-pass (ovw-launch-pass-action) ----------------------------------
  ApiLaunchPassRequest: () =>
    object({
      required: ["localeBranchId"],
      properties: { localeBranchId: str, cancelled: bool, resumeRunId: str },
      additionalProperties: true,
    }),
  ApiLaunchPassResponse: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiLaunchPassResponse,
      properties: { outcome: { enum: ["started", "refused"] } },
      additionalProperties: false,
      schemaVersion: "itotori.projects.launch-pass.v1",
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

  // play-flag-composer — AnnotationComposer submit envelopes
  ApiPlayFlagAnnotationRequest: () =>
    object({
      required: ["note", "severity", "bridgeUnitId"],
      properties: {
        note: str,
        severity: { enum: ["blocker", "critical", "warning", "note"] },
        category: str,
        bridgeUnitId: str,
        sourceUnitKey: str,
        sourceBundleId: str,
        sourceRevisionId: str,
        sceneId: str,
        suggestedEdit: str,
        actorUserId: str,
        actorDisplayName: str,
      },
      additionalProperties: false,
    }),
  ApiPlayFlagAnnotationResponse: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiPlayFlagAnnotationResponse,
      properties: {
        severity: { enum: ["blocker", "critical", "warning", "note"] },
        contextCorrectionId: str,
        duplicate: bool,
      },
      additionalProperties: false,
      schemaVersion: "itotori.play.flag-annotation.v0",
    }),

  // p0-result-revision — target-only play-tester edit and selected delivery
  // inspection. Actor identity, source text, and artifact-root paths are
  // deliberately absent from the mutation request contract.
  ApiPlayTargetEditRequest: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiPlayTargetEditRequest,
      properties: { bridgeUnitId: str, targetBody: str },
      additionalProperties: false,
    }),
  ApiPlayTargetEditResponse: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiPlayTargetEditResponse,
      properties: {
        resultRevisionId: str,
        patchVersionId: str,
        runId: str,
        parentPatchVersionId: str,
        bridgeUnitId: str,
        targetBody: str,
        status: { const: "playable" },
        selectedAt: str,
        idempotentReplay: bool,
      },
      additionalProperties: false,
      schemaVersion: "itotori.play.target-edit.v0",
    }),
  ApiPlayDeliveryUnit: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiPlayDeliveryUnit,
      properties: { bridgeUnitId: str, unitOrdinal: num, targetBody: str },
      additionalProperties: false,
    }),
  ApiPlayDeliveryResponse: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiPlayDeliveryResponse,
      properties: {
        patchVersionId: str,
        runId: str,
        parentPatchVersionId: nullableStr,
        status: str,
        selectedAt: str,
        artifactHashes: { type: "object", additionalProperties: str },
        downloadUrl: str,
        units: { type: "array", items: ref("ApiPlayDeliveryUnit") },
      },
      additionalProperties: false,
      schemaVersion: "itotori.play.delivery.v0",
    }),

  // p0-core-iterative-patch-versioning-and-playtest-feedback — historical
  // patch play surface. Public schemas deliberately carry hashes/identity,
  // not private artifact refs or filesystem paths.
  ApiPatchIterationDeliveryResponse: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiPatchIterationDeliveryResponse,
      properties: {
        patchVersionId: str,
        runId: str,
        parentPatchVersionId: nullableStr,
        origin: { enum: ["run_finalizer", "play_tester_edit", "refinement_run"] },
        status: { const: "playable" },
        playableAt: str,
        artifactHashes: { type: "object", additionalProperties: str },
        downloadUrl: str,
        units: { type: "array", items: ref("ApiPlayDeliveryUnit") },
      },
      additionalProperties: false,
      schemaVersion: "itotori.patch-iteration.delivery.v0",
    }),
  ApiPatchIterationQaCallout: () =>
    object({
      required: [
        "journalFindingId",
        "bridgeUnitId",
        "severity",
        "category",
        "note",
        "confidence",
        "contested",
        "informational",
      ],
      properties: { contested: bool, informational: { const: true } },
      additionalProperties: false,
    }),
  ApiPatchIterationUnit: () =>
    object({
      required: [
        "bridgeUnitId",
        "sourceRunId",
        "journalOutcomeId",
        "resultRevisionId",
        "targetBody",
        "memberOrigin",
        "reusedFromPatchVersionId",
        "unitOrdinal",
      ],
      properties: {
        reusedFromPatchVersionId: nullableStr,
        memberOrigin: {
          enum: ["run_written_outcome", "reused_from_base", "play_tester_edit"],
        },
        unitOrdinal: num,
      },
      additionalProperties: false,
    }),
  ApiPatchIterationPatch: (ref) =>
    object({
      required: [
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
      ],
      properties: {
        parentPatchVersionId: nullableStr,
        origin: { enum: ["run_finalizer", "play_tester_edit", "refinement_run"] },
        playableAt: nullableStr,
        selectedAt: nullableStr,
        artifactHashes: { type: "object", additionalProperties: str },
        units: { type: "array", items: ref("ApiPatchIterationUnit") },
        qaCallouts: { type: "array", items: ref("ApiPatchIterationQaCallout") },
      },
      additionalProperties: false,
    }),
  ApiPatchIterationVersion: () =>
    object({
      required: [
        "patchVersionId",
        "runId",
        "parentPatchVersionId",
        "origin",
        "status",
        "playableAt",
        "selectedAt",
        "artifactHashes",
        "basePatchVersionId",
      ],
      properties: {
        parentPatchVersionId: nullableStr,
        origin: { enum: ["run_finalizer", "play_tester_edit", "refinement_run"] },
        playableAt: nullableStr,
        selectedAt: nullableStr,
        artifactHashes: { type: "object", additionalProperties: str },
        basePatchVersionId: nullableStr,
      },
      additionalProperties: false,
    }),
  ApiPatchIterationFeedbackEvent: () =>
    object({
      required: [
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
      ],
      properties: {
        playSessionId: nullableStr,
        eventKind: { enum: ["result_edit", "comment", "added_context", "wiki_edit"] },
        body: nullableStr,
        metadata: { type: "object", additionalProperties: true },
        resultRevisionId: nullableStr,
        contextArtifactId: nullableStr,
        contextEntryVersionId: nullableStr,
        affectedBridgeUnitIds: { type: "array", items: str },
      },
      additionalProperties: false,
    }),
  ApiPatchIterationFeedbackBatch: (ref) =>
    object({
      required: [
        "feedbackBatchId",
        "observedPatchVersionId",
        "actorUserId",
        "selectionKind",
        "label",
        "createdAt",
        "updatedAt",
        "events",
      ],
      properties: {
        selectionKind: { enum: ["individual", "batch"] },
        label: nullableStr,
        events: { type: "array", items: ref("ApiPatchIterationFeedbackEvent") },
      },
      additionalProperties: false,
    }),
  ApiPatchIterationFeedbackInbox: (ref) =>
    object({
      required: ["observedPatchVersionId", "batches"],
      properties: { batches: { type: "array", items: ref("ApiPatchIterationFeedbackBatch") } },
      additionalProperties: false,
    }),
  ApiPatchIterationSession: (ref) =>
    object({
      required: [
        "playSessionId",
        "observedPatchVersionId",
        "actorUserId",
        "status",
        "startedAt",
        "endedAt",
        "qaCallouts",
      ],
      properties: {
        status: { enum: ["active", "completed", "abandoned"] },
        endedAt: nullableStr,
        qaCallouts: { type: "array", items: ref("ApiPatchIterationQaCallout") },
      },
      additionalProperties: false,
    }),
  ApiPatchIterationRefinementMember: () =>
    object({
      required: [
        "bridgeUnitId",
        "strategy",
        "basePatchVersionId",
        "baseSourceRunId",
        "baseJournalOutcomeId",
        "baseResultRevisionId",
      ],
      properties: {
        strategy: { enum: ["reuse", "redraft", "new_scope"] },
        basePatchVersionId: nullableStr,
        baseSourceRunId: nullableStr,
        baseJournalOutcomeId: nullableStr,
        baseResultRevisionId: nullableStr,
      },
      additionalProperties: false,
    }),
  ApiPatchIterationRefinement: (ref) =>
    object({
      required: ["runId", "basePatchVersionId", "feedbackBatchIds", "wikiHeads", "members"],
      properties: {
        feedbackBatchIds: { type: "array", items: str },
        wikiHeads: {
          type: "array",
          items: object({
            required: ["contextArtifactId", "contextEntryVersionId"],
            additionalProperties: false,
          }),
        },
        members: { type: "array", items: ref("ApiPatchIterationRefinementMember") },
      },
      additionalProperties: false,
    }),
  ApiPatchIterationVersionsResponse: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiPatchIterationVersionsResponse,
      properties: { versions: { type: "array", items: ref("ApiPatchIterationVersion") } },
      additionalProperties: false,
      schemaVersion: "itotori.patch-iteration.versions.v0",
    }),
  ApiPatchIterationSurfaceResponse: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiPatchIterationSurfaceResponse,
      properties: {
        patch: ref("ApiPatchIterationPatch"),
        versions: { type: "array", items: ref("ApiPatchIterationVersion") },
        feedback: ref("ApiPatchIterationFeedbackInbox"),
      },
      additionalProperties: false,
      schemaVersion: "itotori.patch-iteration.surface.v0",
    }),
  ApiPatchIterationPlayRequest: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiPatchIterationPlayRequest,
      properties: { launchDescriptor: { type: "object", additionalProperties: true } },
      additionalProperties: false,
    }),
  ApiPatchIterationPlayResponse: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiPatchIterationPlayResponse,
      properties: {
        receipt: object({
          required: ["runtime", "engine", "scene", "replay", "observedTextLineCount"],
          properties: {
            runtime: { const: "utsushi-reallive" },
            engine: { const: "reallive" },
            scene: { type: "integer", minimum: 0 },
            replay: { const: "observed" },
            observedTextLineCount: { type: "integer", minimum: 0 },
          },
          additionalProperties: false,
        }),
      },
      additionalProperties: false,
      schemaVersion: "itotori.patch-iteration.play.v0",
    }),
  ApiPatchIterationFeedbackBatchRequest: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiPatchIterationFeedbackBatchRequest,
      properties: { feedbackBatchId: str, label: str },
      additionalProperties: false,
    }),
  ApiPatchIterationFeedbackBatchResponse: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiPatchIterationFeedbackBatchResponse,
      properties: { batch: ref("ApiPatchIterationFeedbackBatch") },
      additionalProperties: false,
      schemaVersion: "itotori.patch-iteration.feedback-batch.v0",
    }),
  ApiPatchIterationContextFeedback: () => ({
    oneOf: [
      object({
        required: ["operation", "kind", "title", "body", "reason", "affectedBridgeUnitIds"],
        properties: {
          operation: { const: "add" },
          kind: { enum: ["note", "glossary", "style"] },
          title: str,
          body: str,
          reason: str,
          affectedBridgeUnitIds: { type: "array", items: str },
        },
        additionalProperties: false,
      }),
      object({
        required: ["operation", "contextArtifactId", "body", "reason"],
        properties: {
          operation: { const: "edit" },
          contextArtifactId: str,
          body: str,
          reason: str,
          title: str,
          affectedBridgeUnitIds: { type: "array", items: str },
        },
        additionalProperties: false,
      }),
    ],
  }),
  ApiPatchIterationFeedbackRequest: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiPatchIterationFeedbackRequest,
      properties: {
        feedbackBatchId: str,
        playSessionId: str,
        eventKind: { enum: ["result_edit", "comment", "added_context", "wiki_edit"] },
        body: str,
        metadata: { type: "object", additionalProperties: true },
        targetBody: str,
        resultRevisionId: str,
        contextArtifactId: str,
        contextEntryVersionId: str,
        contextFeedback: ref("ApiPatchIterationContextFeedback"),
        affectedBridgeUnitIds: { type: "array", items: str },
      },
      additionalProperties: false,
    }),
  ApiPatchIterationFeedbackResponse: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiPatchIterationFeedbackResponse,
      properties: { feedback: ref("ApiPatchIterationFeedbackEvent") },
      additionalProperties: false,
      schemaVersion: "itotori.patch-iteration.feedback.v0",
    }),
  ApiPatchIterationRefineRequest: () =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiPatchIterationRefineRequest,
      properties: {
        feedbackBatchIds: { type: "array", items: str },
        feedbackEventIds: { type: "array", items: str },
        scopeUnitIds: { type: "array", items: str },
        targetBodiesByUnit: { type: "object", additionalProperties: str },
        wikiHeads: {
          type: "array",
          items: object({
            required: ["contextArtifactId", "contextEntryVersionId"],
            additionalProperties: false,
          }),
        },
      },
      additionalProperties: false,
    }),
  ApiPatchIterationRefineResponse: (ref) =>
    object({
      required: ITOTORI_STRICT_API_BODY_KEYS.ApiPatchIterationRefineResponse,
      properties: {
        refinement: ref("ApiPatchIterationRefinement"),
        patch: ref("ApiPatchIterationPatch"),
      },
      additionalProperties: false,
      schemaVersion: "itotori.patch-iteration.refine.v0",
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
  ITOTORI_API_BINARY_ROUTES,
  ITOTORI_API_ROUTE_IDS,
  ITOTORI_API_ROUTES,
  interpolateRoutePath,
  patchIterationDeliveryArchivePath,
  playDeliveryArchivePath,
  type ItotoriApiBinaryRoute,
  type ItotoriApiBinaryRouteId,
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

/** Extra, route-specific error statuses beyond the shared envelope. */
const BINARY_ROUTE_EXTRA_STATUS_DESCRIPTIONS: Readonly<Record<number, string>> = {
  501: "Not configured in this API build (internal_error).",
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
  for (const [routeId, route] of Object.entries(ITOTORI_API_BINARY_ROUTES)) {
    const responses: Record<string, JsonValue> = {
      "200": {
        description: "Selected delivered patch archive.",
        content: {
          [route.contentType]: {
            schema: { type: "string", format: "binary" },
          },
        },
      },
      ...openApiErrorResponses(),
    };
    for (const status of route.additionalErrorStatuses ?? []) {
      responses[String(status)] = {
        description: BINARY_ROUTE_EXTRA_STATUS_DESCRIPTIONS[status] ?? "Error (internal_error).",
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/ApiErrorResponse" } },
        },
      };
    }
    const operation: Record<string, JsonValue> = {
      operationId: route.operationId,
      summary: route.summary,
      "x-itotoriBinaryRouteId": routeId,
      responses,
    };
    if (route.pathParams.length > 0) {
      operation.parameters = route.pathParams.map((name) => ({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
      }));
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
