import {
  ProjectState,
  RUNTIME_ARTIFACT_HASH_PROVENANCES,
  RuntimeDashboardStatus,
  assertRuntimeEvidenceReportV02,
  isExtractModeForEngine,
} from "./dependencies.js";
import {
  ApiDraftBranchResponse,
  ApiProjectDecodeExtractResponse,
  ApiProjectImportResponse,
  ApiProjectsResponse,
  ApiRecordBenchmarkResponse,
  ApiRecordFindingResponse,
  ApiRuntimeEvidenceResponse,
} from "./api-response-types.js";
import {
  assertBridgeImportStatus,
  assertProjectDashboardStatus,
} from "./api-catalog-review-dashboard-validation.js";
import {
  REDACTED_RUNTIME_FINDING_MESSAGE,
  assertRuntimeDashboardStatus,
} from "./api-project-overview-dashboard-validation.js";
import {
  asRecord,
  assertBridgeInput,
  assertPatchExportInput,
} from "./api-request-validation-helpers.js";
import {
  asArray,
  assertEnum,
  assertNonNegativeInteger,
  assertNull,
  assertNullableEnum,
  assertNullableNonNegativeInteger,
  assertNullableString,
  assertString,
  assertStringArray,
} from "./api-validation-primitives.js";

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

export function assertRuntimeDashboardTraceEvents(value: unknown, label: string): void {
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

export function assertRuntimeDashboardFindings(value: unknown, label: string): void {
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

export function assertRuntimeDashboardArtifacts(value: unknown, label: string): void {
  const rows = asArray(value, label);
  for (const [index, rowValue] of rows.entries()) {
    const row = asRecord(rowValue, `${label}[${index}]`);
    assertString(row.artifactId, `${label}[${index}].artifactId`);
    assertString(row.artifactKind, `${label}[${index}].artifactKind`);
    assertNullableString(row.uri, `${label}[${index}].uri`);
    assertNullableString(row.hash, `${label}[${index}].hash`);
    // Runtime artifact hash provenance discriminator.
    // `content` = adapter-supplied content hash; `repository_fallback` =
    // repository-generated deterministic placeholder; null = missing/legacy.
    assertNullableEnum(
      row.hashProvenance,
      RUNTIME_ARTIFACT_HASH_PROVENANCES,
      `${label}[${index}].hashProvenance`,
    );
    assertNullableString(row.mediaType, `${label}[${index}].mediaType`);
    assertNullableNonNegativeInteger(row.byteSize, `${label}[${index}].byteSize`);
    assertNullableString(row.bridgeUnitId, `${label}[${index}].bridgeUnitId`);
    assertNullableString(row.sourceUnitKey, `${label}[${index}].sourceUnitKey`);
    assertNullableString(row.diagnostic, `${label}[${index}].diagnostic`);
  }
}

export function assertRuntimeDashboardApproximations(value: unknown, label: string): void {
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

export function assertRuntimeDashboardUnsupportedCapabilities(value: unknown, label: string): void {
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
    assertRuntimeEvidenceReportV02(project.runtimeReport);
  }
}

export function assertProjectsResponse(value: unknown): asserts value is ApiProjectsResponse {
  const response = asRecord(value, "ApiProjectsResponse");
  const projects = asArray(response.projects, "ApiProjectsResponse.projects");
  for (const [index, project] of projects.entries()) {
    assertProjectDashboardStatus(project, `ApiProjectsResponse.projects[${index}]`);
    assertProjectPortfolioProgress(
      asRecord(project, `ApiProjectsResponse.projects[${index}]`).progress,
      `ApiProjectsResponse.projects[${index}].progress`,
    );
  }
}

export function assertProjectPortfolioProgress(value: unknown, label: string): void {
  const progress = asRecord(value, label);
  assertNonNegativeInteger(progress.runCount, `${label}.runCount`);
  assertProjectRunStatusCounts(progress.runStatusCounts, `${label}.runStatusCounts`);
  assertProjectRunProgressStatusCounts(progress.unitCounts, `${label}.unitCounts`);
  const roleCounts = asRecord(progress.roleCounts, `${label}.roleCounts`);
  for (const [role, counts] of Object.entries(roleCounts)) {
    assertString(role, `${label}.roleCounts role`);
    assertProjectRunProgressStatusCounts(counts, `${label}.roleCounts.${role}`);
  }
  assertNonNegativeInteger(progress.totalCostMicrosUsd, `${label}.totalCostMicrosUsd`);
  if (
    typeof progress.averageCoveragePercent !== "number" ||
    !Number.isFinite(progress.averageCoveragePercent) ||
    progress.averageCoveragePercent < 0 ||
    progress.averageCoveragePercent > 100
  ) {
    throw new Error(`${label}.averageCoveragePercent must be between 0 and 100`);
  }
  const blockers = asArray(progress.blockers, `${label}.blockers`);
  for (const [index, blockerValue] of blockers.entries()) {
    const blocker = asRecord(blockerValue, `${label}.blockers[${index}]`);
    assertString(blocker.runId, `${label}.blockers[${index}].runId`);
    assertString(blocker.bridgeUnitId, `${label}.blockers[${index}].bridgeUnitId`);
    assertString(blocker.role, `${label}.blockers[${index}].role`);
    assertStringArray(blocker.blockers, `${label}.blockers[${index}].blockers`);
  }
}

export function assertProjectRunStatusCounts(value: unknown, label: string): void {
  const counts = asRecord(value, label);
  assertNonNegativeInteger(counts.queued, `${label}.queued`);
  assertNonNegativeInteger(counts.running, `${label}.running`);
  assertNonNegativeInteger(counts.paused, `${label}.paused`);
  assertNonNegativeInteger(counts.completed, `${label}.completed`);
  assertNonNegativeInteger(counts.failed, `${label}.failed`);
  assertNonNegativeInteger(counts.cancelled, `${label}.cancelled`);
}

export function assertProjectRunProgressStatusCounts(value: unknown, label: string): void {
  const counts = asRecord(value, label);
  assertNonNegativeInteger(counts.decoded, `${label}.decoded`);
  assertNonNegativeInteger(counts.drafted, `${label}.drafted`);
  assertNonNegativeInteger(counts.QA, `${label}.QA`);
  assertNonNegativeInteger(counts.accepted, `${label}.accepted`);
  assertNonNegativeInteger(counts.patched, `${label}.patched`);
}

export function assertProjectImportResponse(
  value: unknown,
): asserts value is ApiProjectImportResponse {
  const response = asRecord(value, "ApiProjectImportResponse");
  assertProjectState(response.project, "ApiProjectImportResponse.project");
  assertProjectDashboardStatus(response.status, "ApiProjectImportResponse.status");
}

export function assertProjectDecodeExtractResponse(
  value: unknown,
): asserts value is ApiProjectDecodeExtractResponse {
  const response = asRecord(value, "ApiProjectDecodeExtractResponse");
  // The bridge is the real decode artifact — validate it through the SAME
  // `assertBridgeInput` the import route uses (the decode runner already
  // narrowed it to v0.2 via `assertBridgeBundleV02`), so the wire body cannot
  // fork from the bridge contract.
  assertBridgeInput(response.bridge);
  assertString(response.engine, "ApiProjectDecodeExtractResponse.engine");
  assertString(response.mode, "ApiProjectDecodeExtractResponse.mode");
  if (!isExtractModeForEngine(response.engine, response.mode)) {
    throw new Error(
      `ApiProjectDecodeExtractResponse.mode '${response.mode}' is not supported by engine '${response.engine}'`,
    );
  }
  assertString(response.command, "ApiProjectDecodeExtractResponse.command");
}

export function assertDraftBranchResponse(value: unknown): asserts value is ApiDraftBranchResponse {
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

export function assertRecordFindingResponse(
  value: unknown,
): asserts value is ApiRecordFindingResponse {
  const response = asRecord(value, "ApiRecordFindingResponse");
  assertString(response.findingId, "ApiRecordFindingResponse.findingId");
  assertEnum(
    response.status,
    ["open", "resolved", "superseded"] as const,
    "ApiRecordFindingResponse.status",
  );
}

export function assertRecordBenchmarkResponse(
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

export function assertRuntimeEvidenceResponse(
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
