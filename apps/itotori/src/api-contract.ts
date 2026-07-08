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
// by real response fixtures. The parity suite adds per-route teeth for all 35
// routes (a dropped required key or a leaked strict field fails).
import { ITOTORI_PRODUCT_VERSION } from "@itotori/localization-bridge-schema";
import {
  API_ERROR_RESPONSE_CODES,
  ITOTORI_STRICT_API_BODY_KEYS,
  reviewerSingleActionList,
  type ItotoriApiRouteId,
} from "./api-schema.js";

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
        localeBranchId: str,
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
    object({ required: ["bridge"], properties: { bridge: obj }, additionalProperties: true }),
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
      required: [
        "projectId",
        "localeBranchId",
        "sourceBundleId",
        "targetLocale",
        "actorUserId",
        "corrections",
      ],
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
    summary: "Paged jobs run table with served model/provider ledger rows.",
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
    summary: "Submit workspace corrections.",
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
  // ovw-launch-pass-action — drive the next localization pass (folds queued
  // corrections -> pass N+1) via the project-driven-executor /
  // localize-fullproject driver. The HTTP surface is a thin, `canSteer`-gated
  // adapter; the driver itself is unchanged.
  "projects.launchPass": {
    method: "POST",
    pathTemplate: "/api/projects/{projectId}/launch-pass",
    operationId: "projectsLaunchPass",
    summary: "Launch the next localization pass (folds queued corrections).",
    pathParams: ["projectId"],
    requestSchema: "ApiLaunchPassRequest",
    responseSchema: "ApiLaunchPassResponse",
  },
};

/** Stable, sorted list of every route id (deterministic iteration order). */
export const ITOTORI_API_ROUTE_IDS: readonly ItotoriApiRouteId[] = Object.keys(
  ITOTORI_API_ROUTES,
).sort() as ItotoriApiRouteId[];

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
