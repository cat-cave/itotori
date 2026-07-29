import { API_ERROR_RESPONSE_CODES, STRICT_API_BODY_KEYS } from "./api-schema.js";
import { extractCapabilities } from "./extract/extract-adapter-registry.js";
import {
  any,
  arr,
  bool,
  nullableStr,
  num,
  obj,
  object,
  str,
  type Ref,
  type Schema,
} from "./api-contract-schema.js";
import type { JsonValue } from "./api-contract-json.js";
import type { ComponentBuilders } from "./api-contract-components.js";

function extractFormFieldSchema(input: "text" | "number"): Schema {
  return input === "number" ? { type: "integer" } : str;
}

/** The public decode/extract request variants are generated from the registry. */
export function extractRequestVariants(): Schema[] {
  return extractCapabilities().flatMap((capability) =>
    capability.modes.map((mode) => {
      const fields = [...capability.fields, ...mode.fields];
      const properties: Record<string, Schema> = {
        engine: { const: capability.engine },
      };
      for (const field of fields) {
        properties[field.key] = extractFormFieldSchema(field.input);
      }
      for (const [key, value] of Object.entries(mode.fixedValues)) {
        properties[key] = { const: value };
      }
      const variant = object({
        required: [
          "engine",
          ...fields.filter((field) => field.required).map((field) => field.key),
          ...Object.keys(mode.fixedValues),
        ],
        properties,
        additionalProperties: false,
      });
      const constraints = capability.constraints.map((constraint) => ({
        oneOf: constraint.fields.map((field) => ({ required: [field] })),
      }));
      return constraints.length === 0 ? variant : { allOf: [variant, ...constraints] };
    }),
  );
}

/** The public decode/extract response variants are generated from the registry. */
export function extractResponseVariants(): Schema[] {
  return extractCapabilities().flatMap((capability) =>
    capability.modes.map((mode) =>
      object({
        required: ["bridge", "engine", "mode", "command"],
        properties: {
          bridge: obj,
          engine: { const: capability.engine },
          mode: { const: mode.id },
          command: str,
        },
        additionalProperties: true,
      }),
    ),
  );
}

export const baseComponentBuilders: ComponentBuilders = {
  ApiErrorResponse: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiErrorResponse,
      properties: { error: str, code: { enum: [...API_ERROR_RESPONSE_CODES] } },
      additionalProperties: false,
    }),
  // Asset decisions --------------------------------------------------------
  ApiAssetDecisionsResponse: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiAssetDecisionsResponse,
      properties: { decisions: arr },
      additionalProperties: false,
    }),
  ApiCandidateAssetsResponse: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiCandidateAssetsResponse,
      properties: { candidateAssets: arr },
      additionalProperties: false,
    }),

  // Catalog ----------------------------------------------------------------
  CatalogBenchmarkSeedFinderReadModel: () =>
    object({
      required: STRICT_API_BODY_KEYS.CatalogBenchmarkSeedFinderReadModel,
      properties: { targetLanguage: str, rows: arr },
      additionalProperties: false,
      schemaVersion: "catalog.benchmark_seed_finder.v0.1",
    }),
  CatalogContextPanelReadModel: () =>
    object({
      required: STRICT_API_BODY_KEYS.CatalogContextPanelReadModel,
      properties: { params: obj, row: obj, releases: arr, projectState: obj },
      additionalProperties: false,
      schemaVersion: "catalog.context_panel_route.v0.1",
    }),
  CatalogCompletenessBenchmarkPools: () =>
    object({
      required: STRICT_API_BODY_KEYS.CatalogCompletenessBenchmarkPools,
      properties: { targetLanguage: str, pools: obj, publicReport: obj },
      additionalProperties: false,
    }),
  CatalogConflictReviewReadModel: () =>
    object({
      required: STRICT_API_BODY_KEYS.CatalogConflictReviewReadModel,
      properties: { rows: arr },
      additionalProperties: false,
    }),
  CatalogOpportunityRankingReadModel: () =>
    object({
      required: STRICT_API_BODY_KEYS.CatalogOpportunityRankingReadModel,
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
  ApiWikiWriteRequest: () =>
    object({
      required: ["input", "assertion"],
      properties: { input: obj, assertion: obj },
      additionalProperties: false,
    }),
  ApiWikiApplyRequest: () =>
    object({
      required: ["inputIds", "assertion"],
      properties: { inputIds: arr, assertion: obj },
      additionalProperties: false,
    }),
  ApiWikiObjectListResponse: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiWikiObjectListResponse,
      properties: { generatedAt: str, snapshotId: str, sourceObjects: arr, renderings: arr },
      additionalProperties: false,
      schemaVersion: "itotori.wiki.objects.v1",
    }),
  ApiWikiObjectShowResponse: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiWikiObjectShowResponse,
      properties: { generatedAt: str, view: obj, history: arr, dependencyImpact: obj },
      additionalProperties: false,
      schemaVersion: "itotori.wiki.object.v1",
    }),
  ApiWikiObjectHistoryResponse: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiWikiObjectHistoryResponse,
      properties: { generatedAt: str, view: obj, history: arr },
      additionalProperties: false,
      schemaVersion: "itotori.wiki.history.v1",
    }),
  ApiWikiObjectWriteResponse: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiWikiObjectWriteResponse,
      properties: { generatedAt: str, receipt: obj, history: arr, dependencyImpact: obj },
      additionalProperties: false,
      schemaVersion: "itotori.wiki.write.v1",
    }),
  ApiWikiObjectApplyResponse: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiWikiObjectApplyResponse,
      properties: { generatedAt: str, receipt: obj, history: arr, dependencyImpact: obj },
      additionalProperties: false,
      schemaVersion: "itotori.wiki.apply.v1",
    }),

  // Projects / dashboards --------------------------------------------------
  ApiProjectsResponse: (ref) =>
    object({
      required: ["projects"],
      properties: { projects: { type: "array", items: ref("ProjectPortfolioEntry") } },
      additionalProperties: true,
    }),
  ProjectPortfolioEntry: (ref) => ({
    allOf: [
      ref("ProjectDashboardStatus"),
      object({
        required: ["progress"],
        properties: { progress: ref("ProjectPortfolioProgressSummary") },
        additionalProperties: true,
      }),
    ],
  }),
  ProjectPortfolioProgressSummary: (ref) =>
    object({
      required: [
        "runCount",
        "runStatusCounts",
        "unitCounts",
        "roleCounts",
        "totalCostMicrosUsd",
        "averageCoveragePercent",
        "blockers",
      ],
      properties: {
        runCount: num,
        runStatusCounts: ref("ProjectRunStatusCounts"),
        unitCounts: ref("ProjectRunProgressStatusCounts"),
        roleCounts: {
          type: "object",
          additionalProperties: ref("ProjectRunProgressStatusCounts"),
        },
        totalCostMicrosUsd: num,
        averageCoveragePercent: num,
        blockers: {
          type: "array",
          items: object({
            required: ["runId", "bridgeUnitId", "role", "blockers"],
            properties: { runId: str, bridgeUnitId: str, role: str, blockers: arr },
            additionalProperties: false,
          }),
        },
      },
      additionalProperties: false,
    }),
  ProjectRunStatusCounts: () =>
    object({
      required: ["queued", "running", "paused", "completed", "failed", "cancelled"],
      properties: {
        queued: num,
        running: num,
        paused: num,
        completed: num,
        failed: num,
        cancelled: num,
      },
      additionalProperties: false,
    }),
  ProjectRunProgressStatusCounts: () =>
    object({
      required: ["decoded", "drafted", "QA", "accepted", "patched"],
      properties: { decoded: num, drafted: num, QA: num, accepted: num, patched: num },
      additionalProperties: false,
    }),
  ProjectDashboardStatus: () =>
    object({
      required: [
        "projectId",
        "projectKey",
        "name",
        "status",
        "sourceLocale",
        "engineFamily",
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
        engineFamily: { anyOf: [str, { type: "null" }] },
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
      required: STRICT_API_BODY_KEYS.ProjectOverviewReadModel,
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
      required: STRICT_API_BODY_KEYS.CostDrilldownPage,
      properties: { filter: obj, pagination: obj, rows: arr },
      additionalProperties: false,
    }),
  JobsRunTableReadModel: () =>
    object({
      required: STRICT_API_BODY_KEYS.JobsRunTableReadModel,
      properties: { generatedAt: str, filter: obj, pagination: obj, rows: arr },
      additionalProperties: false,
      schemaVersion: "jobs.run_table.v0.3",
    }),
  ApiBenchmarkReportsResponse: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiBenchmarkReportsResponse,
      properties: { reports: arr },
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
      required: STRICT_API_BODY_KEYS.QueueHealthReadModel,
      properties: { outbox: obj, jobs: obj },
      additionalProperties: false,
      schemaVersion: "itotori.queue_health.v0.1",
    }),
};
