import {
  DashboardDecisionReadModel,
  ProjectOverviewBenchmarkHeadline,
  ProjectOverviewJournalPage,
  ProjectOverviewJournalRow,
  RuntimeDashboardStatus,
} from "./dependencies.js";
import { assertDecisionCount } from "./api-domain-16.js";
import { assertBenchmarkReportSummary } from "./api-domain-17.js";
import {
  assertRuntimeDashboardApproximations,
  assertRuntimeDashboardArtifacts,
  assertRuntimeDashboardFindings,
  assertRuntimeDashboardTraceEvents,
  assertRuntimeDashboardUnsupportedCapabilities,
} from "./api-domain-21.js";
import { asRecord } from "./api-domain-28.js";
import {
  asArray,
  asStrictRecord,
  assertBoolean,
  assertDateLike,
  assertEnum,
  assertNonNegativeInteger,
  assertNull,
  assertNullableString,
  assertPositiveInteger,
  assertString,
  assertStringArray,
} from "./api-domain-29.js";

export function assertProjectOverviewJournalPage(
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

export function assertProjectOverviewPagination(value: unknown, label: string): void {
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

export function assertProjectOverviewJournalRow(
  value: unknown,
  label: string,
): asserts value is ProjectOverviewJournalRow {
  const row = asStrictRecord(value, label, [
    "journalRunId",
    "projectId",
    "localeBranchId",
    "status",
    "createdAt",
    "updatedAt",
    "wallClockMs",
    "attemptedUnitCount",
    "finalizedUnitCount",
    "patchedUnitCount",
    "physicalCallCount",
    "deadlineFailureCount",
    "spentMicrosUsd",
    "reservedMicrosUsd",
    "servedPairs",
    "patchVersionId",
    "patchStatus",
  ]);
  assertString(row.journalRunId, `${label}.journalRunId`);
  assertString(row.projectId, `${label}.projectId`);
  assertString(row.localeBranchId, `${label}.localeBranchId`);
  assertString(row.status, `${label}.status`);
  assertDateLike(row.createdAt, `${label}.createdAt`);
  assertDateLike(row.updatedAt, `${label}.updatedAt`);
  assertNonNegativeInteger(row.wallClockMs, `${label}.wallClockMs`);
  assertNonNegativeInteger(row.attemptedUnitCount, `${label}.attemptedUnitCount`);
  assertNonNegativeInteger(row.finalizedUnitCount, `${label}.finalizedUnitCount`);
  assertNonNegativeInteger(row.patchedUnitCount, `${label}.patchedUnitCount`);
  assertNonNegativeInteger(row.physicalCallCount, `${label}.physicalCallCount`);
  assertNonNegativeInteger(row.deadlineFailureCount, `${label}.deadlineFailureCount`);
  assertNonNegativeInteger(row.spentMicrosUsd, `${label}.spentMicrosUsd`);
  assertNonNegativeInteger(row.reservedMicrosUsd, `${label}.reservedMicrosUsd`);
  for (const [index, pair] of asArray(row.servedPairs, `${label}.servedPairs`).entries()) {
    const served = asStrictRecord(pair, `${label}.servedPairs[${index}]`, ["model", "provider"]);
    assertString(served.model, `${label}.servedPairs[${index}].model`);
    assertString(served.provider, `${label}.servedPairs[${index}].provider`);
  }
  assertNullableString(row.patchVersionId, `${label}.patchVersionId`);
  assertNullableString(row.patchStatus, `${label}.patchStatus`);
}

export function assertProjectOverviewBenchmarkHeadline(
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
    // policy — KIND-SPECIFIC nullable-field invariants (fail-closed).
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
