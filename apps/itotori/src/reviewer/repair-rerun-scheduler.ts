// ITOTORI-084 — reviewer-triggered rerun scheduler.
//
// Converts persisted reviewer queue transitions into durable rerun jobs
// on the shared event/job queue. The scheduler owns payload shape,
// idempotency keys, and dependency order; downstream workers own
// execution.
//
// ITOTORI-048 — the payload + name/stage/reason constants now live in
// @itotori/db (packages/itotori-db/src/job-registry.ts) so the typed
// job-name registry is the single source of truth for name ↔ payload ↔
// handler. This module re-exports them for existing callers and builds
// jobs through the type-gated `buildRegisteredJobInput` builder.

import { createHash } from "node:crypto";
import type {
  AuthorizationActor,
  JobQueueInput,
  JobQueueRecord,
  ReviewerQueueAction,
  ReviewerQueueActionResult,
  ReviewerTriggeredRerunJobName,
  ReviewerTriggeredRerunPayload,
  ReviewerTriggeredRerunPolicyVersions,
  ReviewerTriggeredRerunReasonCode,
  ReviewerTriggeredRerunStage,
} from "@itotori/db";
import {
  buildRegisteredJobInput,
  jobIdempotencyPolicyValues,
  reviewerQueueActionValues,
  reviewerTriggeredRerunJobNameValues,
  reviewerTriggeredRerunPayloadSchemaVersion,
  reviewerTriggeredRerunReasonCodeValues,
  reviewerTriggeredRerunStageValues,
} from "@itotori/db";

// Re-export the registry-owned constants/types so existing imports of this
// module keep resolving. The canonical definitions live in @itotori/db.
export {
  reviewerTriggeredRerunJobNameValues,
  reviewerTriggeredRerunPayloadSchemaVersion,
  reviewerTriggeredRerunReasonCodeValues,
  reviewerTriggeredRerunStageValues,
} from "@itotori/db";
export type {
  ReviewerTriggeredRerunJobName,
  ReviewerTriggeredRerunPayload,
  ReviewerTriggeredRerunPolicyVersions,
  ReviewerTriggeredRerunReasonCode,
  ReviewerTriggeredRerunStage,
} from "@itotori/db";

export type ReviewerTriggeredRerunScheduleResult = {
  jobs: JobQueueRecord[];
};

export interface ReviewerTriggeredRerunQueuePort {
  enqueueJobs(
    actor: AuthorizationActor,
    input: readonly JobQueueInput[],
  ): Promise<JobQueueRecord[]>;
}

export interface ReviewerRepairRerunSchedulerPort {
  enqueueForReviewerAction(
    actor: AuthorizationActor,
    result: ReviewerQueueActionResult,
  ): Promise<ReviewerTriggeredRerunScheduleResult>;
}

export type ReviewerRepairRerunSchedulerOptions = {
  queue: ReviewerTriggeredRerunQueuePort;
};

export class ReviewerRepairRerunScheduler implements ReviewerRepairRerunSchedulerPort {
  constructor(private readonly options: ReviewerRepairRerunSchedulerOptions) {}

  async enqueueForReviewerAction(
    actor: AuthorizationActor,
    result: ReviewerQueueActionResult,
  ): Promise<ReviewerTriggeredRerunScheduleResult> {
    const inputs = buildReviewerTriggeredRerunJobInputs(result);
    const jobs = await this.options.queue.enqueueJobs(actor, inputs);
    return { jobs };
  }
}

export function buildReviewerTriggeredRerunJobInputs(
  result: ReviewerQueueActionResult,
): JobQueueInput[] {
  const reasonCodes = reasonCodesForAction(result.transition.action);
  if (reasonCodes.length === 0) {
    return [];
  }

  return buildRerunJobInputsFromPayloadContext(payloadContext(result, reasonCodes));
}

/**
 * Fan a fully-assembled rerun payload context out into the ordered
 * `draft-repair → qa-replay → export-regeneration → runtime-validation` job
 * chain. This is the shared lowering used both by reviewer-queue actions
 * (`buildReviewerTriggeredRerunJobInputs`) and by the workspace correction
 * writeback loop, which assembles its own context (correction reason codes,
 * affected units sharing the corrected source) rather than a queue transition.
 */
export function buildRerunJobInputsFromPayloadContext(
  context: Omit<ReviewerTriggeredRerunPayload, "stage">,
): JobQueueInput[] {
  const inputs: JobQueueInput[] = [];
  for (const stage of rerunStageOrder) {
    const payload: ReviewerTriggeredRerunPayload = { ...context, stage };
    const idempotencyKey = idempotencyKeyFor(payload);
    const jobId = `reviewer-rerun-${digest(idempotencyKey).slice(0, 16)}`;
    const jobName = jobNameForStage(stage);
    inputs.push(
      buildRegisteredJobInput(jobName, payload, {
        jobId,
        projectId: payload.projectId,
        localeBranchId: payload.localeBranchId,
        queueName: "reviewer-rerun",
        idempotency: {
          policy: jobIdempotencyPolicyValues.idempotent,
          key: idempotencyKey,
        },
        correlationId: `reviewer-rerun:${payload.reviewItemId}`,
        causationId: payload.transitionId,
        subjectRefs: subjectRefsFor(payload),
        dependsOnJobIds: inputs.length === 0 ? [] : [inputs[inputs.length - 1]!.jobId!],
        priority: priorityForStage(stage),
      }),
    );
  }
  return inputs;
}

const rerunStageOrder: ReadonlyArray<ReviewerTriggeredRerunStage> = [
  reviewerTriggeredRerunStageValues.draftRepair,
  reviewerTriggeredRerunStageValues.qaReplay,
  reviewerTriggeredRerunStageValues.exportRegeneration,
  reviewerTriggeredRerunStageValues.runtimeValidation,
];

function payloadContext(
  result: ReviewerQueueActionResult,
  reasonCodes: readonly ReviewerTriggeredRerunReasonCode[],
): Omit<ReviewerTriggeredRerunPayload, "stage"> {
  const metadataSources = metadataRecords(result);
  return {
    schemaVersion: reviewerTriggeredRerunPayloadSchemaVersion,
    projectId: result.item.projectId,
    localeBranchId: result.item.localeBranchId,
    sourceRevisionId: result.item.sourceRevisionId,
    affectedUnitIds: affectedUnitIds(result, metadataSources),
    artifactIds: sortedUnique([
      ...result.item.affectedArtifactIds,
      ...result.transition.affectedArtifactIds,
    ]),
    policyVersions: policyVersions(metadataSources),
    reasonCodes,
    reviewItemId: result.item.reviewItemId,
    transitionId: result.transition.transitionId,
    reviewerAction: result.transition.action,
    itemKind: result.item.itemKind,
    sourceItemRef: result.item.sourceItemRef,
    ...payloadOptionalFields(metadataSources),
  };
}

function reasonCodesForAction(action: ReviewerQueueAction): ReviewerTriggeredRerunReasonCode[] {
  switch (action) {
    case reviewerQueueActionValues.requestRepair:
      return [reviewerTriggeredRerunReasonCodeValues.reviewerRequestRepair];
    case reviewerQueueActionValues.updateGlossary:
      return [
        reviewerTriggeredRerunReasonCodeValues.reviewerGlossaryUpdate,
        reviewerTriggeredRerunReasonCodeValues.glossaryInvalidated,
      ];
    case reviewerQueueActionValues.updateStyle:
      return [
        reviewerTriggeredRerunReasonCodeValues.reviewerStyleUpdate,
        reviewerTriggeredRerunReasonCodeValues.policyInvalidated,
      ];
    case reviewerQueueActionValues.importRuntimeFeedback:
      return [
        reviewerTriggeredRerunReasonCodeValues.reviewerRuntimeFeedbackImport,
        reviewerTriggeredRerunReasonCodeValues.runtimeFeedbackRerun,
      ];
    case reviewerQueueActionValues.approve:
    case reviewerQueueActionValues.reject:
    case reviewerQueueActionValues.defer:
    case reviewerQueueActionValues.escalate:
      return [];
    default:
      return assertNever(action);
  }
}

function metadataRecords(
  result: ReviewerQueueActionResult,
): ReadonlyArray<Record<string, unknown>> {
  return [result.transition.metadata, result.item.metadata, recordOrEmpty(result.item.payload)];
}

function affectedUnitIds(
  result: ReviewerQueueActionResult,
  records: ReadonlyArray<Record<string, unknown>>,
): string[] {
  const direct =
    firstStringArray(records, "affectedUnitIds") ??
    firstStringArray(records, "affectedBridgeUnitIds") ??
    firstStringArray(records, "bridgeUnitIds") ??
    firstStringArray(records, "unitIds");
  return sortedUnique(direct ?? [result.item.sourceItemRef]);
}

function policyVersions(
  records: ReadonlyArray<Record<string, unknown>>,
): ReviewerTriggeredRerunPolicyVersions {
  const policyVersionRecords = records
    .map((record) => recordOrUndefined(record.policyVersions))
    .filter((record): record is Record<string, unknown> => record !== undefined);
  const allRecords = [...records, ...policyVersionRecords];
  return {
    styleGuideVersionId: firstString(allRecords, "styleGuideVersionId") ?? null,
    glossaryVersionId: firstString(allRecords, "glossaryVersionId") ?? null,
    pairPolicyVersionId: firstString(allRecords, "pairPolicyVersionId") ?? null,
    qaPolicyVersionId: firstString(allRecords, "qaPolicyVersionId") ?? null,
    exportPolicyVersionId: firstString(allRecords, "exportPolicyVersionId") ?? null,
    runtimeValidationPolicyVersionId:
      firstString(allRecords, "runtimeValidationPolicyVersionId") ?? null,
  };
}

function payloadOptionalFields(
  records: ReadonlyArray<Record<string, unknown>>,
): Partial<ReviewerTriggeredRerunPayload> {
  const fields: Partial<ReviewerTriggeredRerunPayload> = {};
  assignString(fields, "repairHint", firstString(records, "repairHint"));
  assignString(fields, "termId", firstString(records, "termId"));
  assignString(fields, "approvedTranslation", firstString(records, "approvedTranslation"));
  assignString(fields, "ruleLabel", firstString(records, "ruleLabel"));
  assignString(fields, "runtimeEvidenceTier", firstString(records, "evidenceTier"));
  assignStringArray(
    fields,
    "observationEventIds",
    firstStringArray(records, "observationEventIds"),
  );
  assignStringArray(fields, "artifactHashes", firstStringArray(records, "artifactHashes"));
  return fields;
}

function jobNameForStage(stage: ReviewerTriggeredRerunStage): ReviewerTriggeredRerunJobName {
  switch (stage) {
    case reviewerTriggeredRerunStageValues.draftRepair:
      return reviewerTriggeredRerunJobNameValues.draftRepair;
    case reviewerTriggeredRerunStageValues.qaReplay:
      return reviewerTriggeredRerunJobNameValues.qaReplay;
    case reviewerTriggeredRerunStageValues.exportRegeneration:
      return reviewerTriggeredRerunJobNameValues.exportRegeneration;
    case reviewerTriggeredRerunStageValues.runtimeValidation:
      return reviewerTriggeredRerunJobNameValues.runtimeValidation;
    default:
      return assertNever(stage);
  }
}

function priorityForStage(stage: ReviewerTriggeredRerunStage): number {
  switch (stage) {
    case reviewerTriggeredRerunStageValues.draftRepair:
      return 40;
    case reviewerTriggeredRerunStageValues.qaReplay:
      return 30;
    case reviewerTriggeredRerunStageValues.exportRegeneration:
      return 20;
    case reviewerTriggeredRerunStageValues.runtimeValidation:
      return 10;
    default:
      return assertNever(stage);
  }
}

function subjectRefsFor(payload: ReviewerTriggeredRerunPayload): unknown[] {
  return [
    { subjectKind: "reviewer_queue_item", subjectId: payload.reviewItemId },
    { subjectKind: "locale_branch", subjectId: payload.localeBranchId },
    ...payload.affectedUnitIds.map((subjectId) => ({ subjectKind: "bridge_unit", subjectId })),
    ...payload.artifactIds.map((subjectId) => ({ subjectKind: "artifact", subjectId })),
  ];
}

function idempotencyKeyFor(payload: ReviewerTriggeredRerunPayload): string {
  return `reviewer-rerun:${digest(
    stableStringify({
      schemaVersion: payload.schemaVersion,
      stage: payload.stage,
      projectId: payload.projectId,
      localeBranchId: payload.localeBranchId,
      sourceRevisionId: payload.sourceRevisionId,
      affectedUnitIds: payload.affectedUnitIds,
      artifactIds: payload.artifactIds,
      policyVersions: payload.policyVersions,
      reasonCodes: payload.reasonCodes,
      reviewItemId: payload.reviewItemId,
      reviewerAction: payload.reviewerAction,
      itemKind: payload.itemKind,
      sourceItemRef: payload.sourceItemRef,
      repairHint: payload.repairHint,
      termId: payload.termId,
      approvedTranslation: payload.approvedTranslation,
      ruleLabel: payload.ruleLabel,
      runtimeEvidenceTier: payload.runtimeEvidenceTier,
      observationEventIds: payload.observationEventIds,
      artifactHashes: payload.artifactHashes,
    }),
  )}`;
}

function firstString(
  records: ReadonlyArray<Record<string, unknown>>,
  key: string,
): string | undefined {
  for (const record of records) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function firstStringArray(
  records: ReadonlyArray<Record<string, unknown>>,
  key: string,
): string[] | undefined {
  for (const record of records) {
    const value = record[key];
    if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((entry) => typeof entry === "string" && entry.length > 0)
    ) {
      return value;
    }
  }
  return undefined;
}

function assignString<T extends keyof ReviewerTriggeredRerunPayload>(
  target: Partial<ReviewerTriggeredRerunPayload>,
  key: T,
  value: string | undefined,
): void {
  if (value !== undefined) {
    target[key] = value as Partial<ReviewerTriggeredRerunPayload>[T];
  }
}

function assignStringArray<T extends keyof ReviewerTriggeredRerunPayload>(
  target: Partial<ReviewerTriggeredRerunPayload>,
  key: T,
  value: string[] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value as Partial<ReviewerTriggeredRerunPayload>[T];
  }
}

function sortedUnique(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)].sort();
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return recordOrUndefined(value) ?? {};
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function assertNever(value: never): never {
  throw new Error(`reviewer rerun scheduler: unexpected value ${String(value)}`);
}
