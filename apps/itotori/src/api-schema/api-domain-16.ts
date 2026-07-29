import {
  CatalogConflictKind,
  CatalogConflictReviewReadModel,
  ProjectDashboardStatus,
  QueueHealthReadModel,
  catalogConflictKindValues,
} from "./dependencies.js";
import { STRICT_API_BODY_KEYS } from "./api-domain-02.js";
import { ApiBenchmarkReportsResponse } from "./api-domain-03.js";
import { catalogConflictReviewStatusValues } from "./api-domain-15.js";
import {
  assertBenchmarkReportSummary,
  assertQueueJobRecord,
  assertQueueOutboxRecord,
} from "./api-domain-17.js";
import { assertProjectCostReport } from "./api-domain-18.js";
import { asRecord } from "./api-domain-28.js";
import {
  asArray,
  asStrictRecord,
  assertConflictReviewExactLinkRefs,
  assertConflictReviewFuzzyScores,
  assertConflictReviewProvenance,
  assertConflictReviewSourceIds,
  assertDateLike,
  assertEnum,
  assertLiteral,
  assertNonNegativeInteger,
  assertNonNegativeNumber,
  assertNullableEnum,
  assertNullableString,
  assertString,
  assertStringArray,
} from "./api-domain-29.js";

export function assertCatalogConflictReviewReadModel(
  value: unknown,
  label = "CatalogConflictReviewReadModel",
): asserts value is CatalogConflictReviewReadModel {
  const model = asStrictRecord(value, label, STRICT_API_BODY_KEYS.CatalogConflictReviewReadModel);
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
  assertNullableString(status.engineFamily, `${label}.engineFamily`);
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

export function assertBridgeImportStatus(value: unknown, label: string): void {
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

export function assertDiffCounts(value: unknown, label: string): void {
  const counts = asRecord(value, label);
  assertNonNegativeInteger(counts.added, `${label}.added`);
  assertNonNegativeInteger(counts.updated, `${label}.updated`);
  assertNonNegativeInteger(counts.removed, `${label}.removed`);
  assertNonNegativeInteger(counts.unchanged, `${label}.unchanged`);
}

export function assertCountTotal(
  value: unknown,
  total: unknown,
  label: string,
  totalLabel: string,
): void {
  const counts = asRecord(value, label);
  const countTotal = Number(counts.added) + Number(counts.updated) + Number(counts.unchanged);
  if (countTotal !== Number(total)) {
    throw new Error(`${label} current counts must add up to ${totalLabel}`);
  }
}

export function assertDecisionCount(value: unknown, expected: number, label: string): void {
  if (Number(value) !== expected) {
    throw new Error(`${label} must match pendingDecisions`);
  }
}

export function assertApiBenchmarkReportsResponse(
  value: unknown,
  label = "ApiBenchmarkReportsResponse",
): asserts value is ApiBenchmarkReportsResponse {
  const response = asStrictRecord(value, label, STRICT_API_BODY_KEYS.ApiBenchmarkReportsResponse);
  const reports = asArray(response.reports, `${label}.reports`);
  for (const [index, report] of reports.entries()) {
    assertBenchmarkReportSummary(report, `${label}.reports[${index}]`);
  }
}

/** policy — assert a {@link QueueHealthReadModel} (the queue.health body). */
export function assertQueueHealthReadModel(
  value: unknown,
  label = "QueueHealthReadModel",
): asserts value is QueueHealthReadModel {
  const model = asStrictRecord(value, label, STRICT_API_BODY_KEYS.QueueHealthReadModel);
  assertLiteral(model.schemaVersion, "itotori.queue_health.v0.1", `${label}.schemaVersion`);
  assertDateLike(model.generatedAt, `${label}.generatedAt`);
  assertQueueHealthSection(model.outbox, `${label}.outbox`, "outbox");
  assertQueueHealthSection(model.jobs, `${label}.jobs`, "jobs");
}

export function assertQueueHealthSection(
  value: unknown,
  label: string,
  section: "outbox" | "jobs",
): void {
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

export function assertQueueStatusCount(value: unknown, label: string): void {
  const record = asStrictRecord(value, label, ["status", "count"]);
  assertString(record.status, `${label}.status`);
  assertNonNegativeInteger(record.count, `${label}.count`);
}

export function assertQueueDeadLetterReview(
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
