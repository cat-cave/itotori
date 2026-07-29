import { BenchmarkQaAgentSummary, BenchmarkReportSummary } from "./dependencies.js";
import { asRecord } from "./api-request-validation-helpers.js";
import {
  asArray,
  asStrictRecord,
  assertDateLike,
  assertNonNegativeInteger,
  assertNonNegativeNumber,
  assertNullableString,
  assertPositiveInteger,
  assertString,
} from "./api-validation-primitives.js";

export function assertQueueOutboxRecord(value: unknown, label: string): void {
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

export function assertQueueJobRecord(value: unknown, label: string): void {
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

export function assertBenchmarkReportSummary(
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

export function assertBenchmarkQaAgentSummary(
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
