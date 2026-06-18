import type {
  CatalogCompletenessBenchmarkPools,
  CatalogConflictReviewReadModel,
  DashboardDecisionReadModel,
  ProjectCostReport,
  ProjectDashboardStatus,
  RuntimeDashboardStatus,
} from "@itotori/db";
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

export type ItotoriApiRouteId =
  | "catalog.completeness"
  | "catalog.conflicts"
  | "projects.list"
  | "projects.status"
  | "projects.decisions"
  | "projects.cost"
  | "runtime.status"
  | "imports.bridge"
  | "branches.draft"
  | "findings.record"
  | "decisions.record"
  | "benchmarks.record"
  | "runtimeEvidence.ingest";

export type ApiErrorResponse = {
  error: string;
  code: "bad_request" | "forbidden" | "not_found" | "method_not_allowed" | "internal_error";
};

export type ApiProjectsResponse = {
  projects: ProjectDashboardStatus[];
};

export type ApiProjectCostResponse = ProjectCostReport;

export type ApiDashboardDecisionsResponse = DashboardDecisionReadModel;

export type ApiCatalogConflictReviewResponse = CatalogConflictReviewReadModel;

export type ApiCatalogCompletenessResponse = CatalogCompletenessBenchmarkPools;

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
  localeBranchId?: string;
  benchmarkReport: BenchmarkReportV02;
};

export type ApiRecordBenchmarkResponse = BenchmarkRecordResult;

export type ApiRuntimeEvidenceRequest = {
  project: ProjectState;
  runtimeReport: RuntimeVerificationReport | RuntimeEvidenceReportV02;
};

export type ApiRuntimeEvidenceResponse = RuntimeIngestResult;

export type ItotoriApiResponseBody =
  | ApiCatalogCompletenessResponse
  | ApiCatalogConflictReviewResponse
  | ApiProjectsResponse
  | ProjectDashboardStatus
  | ApiDashboardDecisionsResponse
  | ApiProjectCostResponse
  | RuntimeDashboardStatus
  | ApiProjectImportResponse
  | ApiDraftBranchResponse
  | ApiRecordFindingResponse
  | ApiRecordDecisionResponse
  | ApiRecordBenchmarkResponse
  | ApiRuntimeEvidenceResponse
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
    if (request.localeBranchId !== undefined) {
      assertString(request.localeBranchId, "ApiRecordBenchmarkRequest.localeBranchId");
    }
    assertBenchmarkReportV02(request.benchmarkReport);
    const result: ApiRecordBenchmarkRequest = { benchmarkReport: request.benchmarkReport };
    if (request.localeBranchId !== undefined) {
      result.localeBranchId = request.localeBranchId;
    }
    return result;
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

export function assertItotoriApiResponse(
  routeId: ItotoriApiRouteId,
  value: unknown,
): asserts value is ItotoriApiResponseBody {
  switch (routeId) {
    case "catalog.completeness":
      assertCatalogCompletenessBenchmarkPools(value);
      return;
    case "catalog.conflicts":
      assertCatalogConflictReviewReadModel(value);
      return;
    case "projects.list":
      assertProjectsResponse(value);
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
  }
}

export function assertCatalogCompletenessBenchmarkPools(
  value: unknown,
  label = "CatalogCompletenessBenchmarkPools",
): asserts value is CatalogCompletenessBenchmarkPools {
  const model = asRecord(value, label);
  assertString(model.targetLanguage, `${label}.targetLanguage`);
  const pools = asRecord(model.pools, `${label}.pools`);
  for (const poolName of [
    "mtl_only",
    "fan_partial",
    "no_english",
    "unknown",
    "conflict",
  ] as const) {
    const works = asArray(pools[poolName], `${label}.pools.${poolName}`);
    for (const [index, workValue] of works.entries()) {
      const work = asRecord(workValue, `${label}.pools.${poolName}[${index}]`);
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
      const statuses = asArray(work.statuses, `${label}.pools.${poolName}[${index}].statuses`);
      for (const [statusIndex, statusValue] of statuses.entries()) {
        const status = asRecord(
          statusValue,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}]`,
        );
        assertString(
          status.languageStatusId,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].languageStatusId`,
        );
        assertString(status.language, `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].language`);
        assertString(status.status, `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].status`);
        assertString(
          status.confidence,
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
        if (status.source !== null) {
          const source = asRecord(
            status.source,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source`,
          );
          assertString(
            source.sourceProvenanceId,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.sourceProvenanceId`,
          );
          assertString(
            source.catalogSource,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.catalogSource`,
          );
          assertString(
            source.sourceRecordKind,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.sourceRecordKind`,
          );
          assertString(
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
        }
      }
      const conflicts = asArray(work.conflicts, `${label}.pools.${poolName}[${index}].conflicts`);
      for (const [conflictIndex, conflictValue] of conflicts.entries()) {
        const conflict = asRecord(
          conflictValue,
          `${label}.pools.${poolName}[${index}].conflicts[${conflictIndex}]`,
        );
        assertString(
          conflict.conflictId,
          `${label}.pools.${poolName}[${index}].conflicts[${conflictIndex}].conflictId`,
        );
        assertString(
          conflict.status,
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
      }
    }
  }
  const publicReport = asRecord(model.publicReport, `${label}.publicReport`);
  assertString(publicReport.schemaVersion, `${label}.publicReport.schemaVersion`);
  assertString(publicReport.targetLanguage, `${label}.publicReport.targetLanguage`);
  assertDateLike(publicReport.generatedAt, `${label}.publicReport.generatedAt`);
  assertNonNegativeInteger(publicReport.totalWorkCount, `${label}.publicReport.totalWorkCount`);
  assertNonNegativeInteger(publicReport.conflictCount, `${label}.publicReport.conflictCount`);
  const reportPools = asArray(publicReport.pools, `${label}.publicReport.pools`);
  for (const [index, poolValue] of reportPools.entries()) {
    const pool = asRecord(poolValue, `${label}.publicReport.pools[${index}]`);
    assertString(pool.pool, `${label}.publicReport.pools[${index}].pool`);
    assertNonNegativeInteger(pool.workCount, `${label}.publicReport.pools[${index}].workCount`);
    assertConflictReviewSourceIds(pool.sourceIds, `${label}.publicReport.pools[${index}].sourceIds`);
  }
  const reportStatuses = asArray(publicReport.statuses, `${label}.publicReport.statuses`);
  for (const [index, statusValue] of reportStatuses.entries()) {
    const status = asRecord(statusValue, `${label}.publicReport.statuses[${index}]`);
    assertString(status.status, `${label}.publicReport.statuses[${index}].status`);
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

export function assertCatalogConflictReviewReadModel(
  value: unknown,
  label = "CatalogConflictReviewReadModel",
): asserts value is CatalogConflictReviewReadModel {
  const model = asRecord(value, label);
  const rows = asArray(model.rows, `${label}.rows`);
  for (const [index, rowValue] of rows.entries()) {
    const row = asRecord(rowValue, `${label}.rows[${index}]`);
    assertString(row.reviewId, `${label}.rows[${index}].reviewId`);
    assertString(row.catalogRecordId, `${label}.rows[${index}].catalogRecordId`);
    assertNullableString(row.conflictId, `${label}.rows[${index}].conflictId`);
    assertStringArray(row.candidateIds, `${label}.rows[${index}].candidateIds`);
    assertStringArray(row.candidateCatalogIds, `${label}.rows[${index}].candidateCatalogIds`);
    assertConflictReviewExactLinkRefs(row.exactLinkRefs, `${label}.rows[${index}].exactLinkRefs`);
    assertConflictReviewFuzzyScores(row.fuzzyScores, `${label}.rows[${index}].fuzzyScores`);
    assertConflictReviewSourceIds(row.sourceIds, `${label}.rows[${index}].sourceIds`);
    assertConflictReviewProvenance(row.provenance, `${label}.rows[${index}].provenance`);
    assertEnum(
      row.severity,
      ["error", "warning", "info"] as const,
      `${label}.rows[${index}].severity`,
    );
    assertString(row.status, `${label}.rows[${index}].status`);
    assertString(row.reasonCode, `${label}.rows[${index}].reasonCode`);
    assertString(row.reasonDetail, `${label}.rows[${index}].reasonDetail`);
    assertNullableString(row.conflictKind, `${label}.rows[${index}].conflictKind`);
    assertDateLike(row.detectedAt, `${label}.rows[${index}].detectedAt`);
    if (row.resolution !== null) {
      const resolution = asRecord(row.resolution, `${label}.rows[${index}].resolution`);
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
  assertBridgeImportStatus(status.importStatus, `${label}.importStatus`);
  assertProjectCostReport(status.cost, `${label}.cost`);
  const branches = asArray(status.localeBranches, `${label}.localeBranches`);
  for (const [index, branchValue] of branches.entries()) {
    const branch = asRecord(branchValue, `${label}.localeBranches[${index}]`);
    assertString(branch.localeBranchId, `${label}.localeBranches[${index}].localeBranchId`);
    assertString(branch.targetLocale, `${label}.localeBranches[${index}].targetLocale`);
    assertString(branch.status, `${label}.localeBranches[${index}].status`);
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

export function assertProjectCostReport(
  value: unknown,
  label = "ProjectCostReport",
): asserts value is ProjectCostReport {
  const report = asRecord(value, label);
  assertString(report.projectId, `${label}.projectId`);
  assertEnum(report.currency, ["USD"] as const, `${label}.currency`);
  assertNonNegativeInteger(report.runCount, `${label}.runCount`);
  assertNonNegativeInteger(report.billedMicrosUsd, `${label}.billedMicrosUsd`);
  assertNonNegativeInteger(report.estimatedMicrosUsd, `${label}.estimatedMicrosUsd`);
  assertNonNegativeInteger(report.zeroRunCount, `${label}.zeroRunCount`);
  assertNonNegativeInteger(report.unknownRunCount, `${label}.unknownRunCount`);
  assertBoolean(report.includesUnknownCost, `${label}.includesUnknownCost`);
  const totals = asArray(report.totalsByCostKind, `${label}.totalsByCostKind`);
  for (const [index, totalValue] of totals.entries()) {
    const total = asRecord(totalValue, `${label}.totalsByCostKind[${index}]`);
    assertEnum(
      total.costKind,
      ["billed", "provider_estimate", "local_estimate", "zero", "unknown"] as const,
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
      ["billed", "provider_estimate", "local_estimate", "zero", "unknown"] as const,
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
    asRecord(run.dataHandling, `${label}.recentRuns[${index}].dataHandling`);
    if (run.accountPrivacy !== null) {
      asRecord(run.accountPrivacy, `${label}.recentRuns[${index}].accountPrivacy`);
    }
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

function assertNullableString(value: unknown, label: string): asserts value is string | null {
  if (value !== null && typeof value !== "string") {
    throw new Error(`${label} must be a string or null`);
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
    const row = asRecord(rowValue, `${label}[${index}]`);
    assertString(row.catalogSource, `${label}[${index}].catalogSource`);
    assertString(row.sourceId, `${label}[${index}].sourceId`);
  }
}

function assertConflictReviewExactLinkRefs(value: unknown, label: string): void {
  const rows = asArray(value, label);
  for (const [index, rowValue] of rows.entries()) {
    const row = asRecord(rowValue, `${label}[${index}]`);
    assertString(row.externalIdId, `${label}[${index}].externalIdId`);
    assertString(row.catalogSource, `${label}[${index}].catalogSource`);
    assertString(row.sourceId, `${label}[${index}].sourceId`);
    assertString(row.externalIdKind, `${label}[${index}].externalIdKind`);
    assertString(row.workId, `${label}[${index}].workId`);
    assertNullableString(row.sourceProvenanceId, `${label}[${index}].sourceProvenanceId`);
  }
}

function assertConflictReviewFuzzyScores(value: unknown, label: string): void {
  const rows = asArray(value, label);
  for (const [index, rowValue] of rows.entries()) {
    const row = asRecord(rowValue, `${label}[${index}]`);
    assertString(row.candidateId, `${label}[${index}].candidateId`);
    assertNonNegativeInteger(row.score, `${label}[${index}].score`);
    assertString(row.diagnosticCode, `${label}[${index}].diagnosticCode`);
    assertString(row.generatorVersion, `${label}[${index}].generatorVersion`);
  }
}

function assertConflictReviewProvenance(value: unknown, label: string): void {
  const rows = asArray(value, label);
  for (const [index, rowValue] of rows.entries()) {
    const row = asRecord(rowValue, `${label}[${index}]`);
    assertString(row.sourceProvenanceId, `${label}[${index}].sourceProvenanceId`);
    assertString(row.catalogSource, `${label}[${index}].catalogSource`);
    assertString(row.sourceId, `${label}[${index}].sourceId`);
    assertString(row.sourceRecordKind, `${label}[${index}].sourceRecordKind`);
    assertNullableString(row.payloadHash, `${label}[${index}].payloadHash`);
    assertDateLike(row.fetchedAt, `${label}[${index}].fetchedAt`);
  }
}

function assertDateLike(value: unknown, label: string): void {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (date === null || Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be a date`);
  }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
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

function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
}

function assertEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of ${allowed.join(", ")}`);
  }
}
