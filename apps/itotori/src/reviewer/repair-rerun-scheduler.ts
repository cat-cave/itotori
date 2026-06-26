// ITOTORI-084 — reviewer-triggered rerun scheduler.
//
// Converts persisted reviewer queue transitions into durable rerun jobs
// on the shared event/job queue. The scheduler owns payload shape,
// idempotency keys, and dependency order; downstream workers own
// execution.

import { createHash } from "node:crypto";
import type {
  AuthorizationActor,
  JobQueueInput,
  JobQueueRecord,
  ReviewerQueueAction,
  ReviewerQueueActionResult,
  ReviewerQueueItemKind,
} from "@itotori/db";
import {
  jobIdempotencyPolicyValues,
  jobTaskTypeValues,
  reviewerQueueActionValues,
} from "@itotori/db";

export const reviewerTriggeredRerunPayloadSchemaVersion =
  "itotori.reviewer_triggered_rerun.v1" as const;

export const reviewerTriggeredRerunStageValues = {
  draftRepair: "draft-repair",
  qaReplay: "qa-replay",
  exportRegeneration: "export-regeneration",
  runtimeValidation: "runtime-validation",
} as const;

export type ReviewerTriggeredRerunStage =
  (typeof reviewerTriggeredRerunStageValues)[keyof typeof reviewerTriggeredRerunStageValues];

export const reviewerTriggeredRerunJobNameValues = {
  draftRepair: "rerun.draft-repair",
  qaReplay: "rerun.qa-replay",
  exportRegeneration: "rerun.export-regeneration",
  runtimeValidation: "rerun.runtime-validation",
} as const;

export type ReviewerTriggeredRerunJobName =
  (typeof reviewerTriggeredRerunJobNameValues)[keyof typeof reviewerTriggeredRerunJobNameValues];

export const reviewerTriggeredRerunReasonCodeValues = {
  reviewerRequestRepair: "reviewer_request_repair",
  reviewerGlossaryUpdate: "reviewer_glossary_update",
  reviewerStyleUpdate: "reviewer_style_update",
  reviewerRuntimeFeedbackImport: "reviewer_runtime_feedback_import",
  glossaryInvalidated: "glossary_invalidated",
  policyInvalidated: "policy_invalidated",
  runtimeFeedbackRerun: "runtime_feedback_rerun",
} as const;

export type ReviewerTriggeredRerunReasonCode =
  (typeof reviewerTriggeredRerunReasonCodeValues)[keyof typeof reviewerTriggeredRerunReasonCodeValues];

export type ReviewerTriggeredRerunPolicyVersions = {
  styleGuideVersionId: string | null;
  glossaryVersionId: string | null;
  pairPolicyVersionId: string | null;
  qaPolicyVersionId: string | null;
  exportPolicyVersionId: string | null;
  runtimeValidationPolicyVersionId: string | null;
};

export type ReviewerTriggeredRerunPayload = {
  schemaVersion: typeof reviewerTriggeredRerunPayloadSchemaVersion;
  stage: ReviewerTriggeredRerunStage;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  affectedUnitIds: readonly string[];
  artifactIds: readonly string[];
  policyVersions: ReviewerTriggeredRerunPolicyVersions;
  reasonCodes: readonly ReviewerTriggeredRerunReasonCode[];
  reviewItemId: string;
  transitionId: string;
  reviewerAction: ReviewerQueueAction;
  itemKind: ReviewerQueueItemKind;
  sourceItemRef: string;
  repairHint?: string;
  termId?: string;
  approvedTranslation?: string;
  ruleLabel?: string;
  runtimeEvidenceTier?: string;
  observationEventIds?: string[];
  artifactHashes?: string[];
};

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

  const context = payloadContext(result, reasonCodes);
  const inputs: JobQueueInput[] = [];
  for (const stage of rerunStageOrder) {
    const payload: ReviewerTriggeredRerunPayload = { ...context, stage };
    const idempotencyKey = idempotencyKeyFor(payload);
    const jobId = `reviewer-rerun-${digest(idempotencyKey).slice(0, 16)}`;
    inputs.push({
      jobId,
      projectId: payload.projectId,
      localeBranchId: payload.localeBranchId,
      jobType: jobTaskTypeValues.rerun,
      jobName: jobNameForStage(stage),
      queueName: "reviewer-rerun",
      idempotency: {
        policy: jobIdempotencyPolicyValues.idempotent,
        key: idempotencyKey,
      },
      correlationId: `reviewer-rerun:${payload.reviewItemId}`,
      causationId: payload.transitionId,
      subjectRefs: subjectRefsFor(payload),
      dependsOnJobIds: inputs.length === 0 ? [] : [inputs[inputs.length - 1]!.jobId!],
      payload: payload as unknown as Record<string, unknown>,
      priority: priorityForStage(stage),
    });
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
