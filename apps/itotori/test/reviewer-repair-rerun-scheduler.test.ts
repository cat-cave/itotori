import { describe, expect, it } from "vitest";
import type {
  AuthorizationActor,
  JobQueueInput,
  JobQueueRecord,
  ReviewerQueueActionResult,
} from "@itotori/db";
import { jobStatusValues, jobTaskTypeValues } from "@itotori/db";
import {
  buildReviewerTriggeredRerunJobInputs,
  fixtureBatchRepairRerun,
  fixturePolicyInvalidationRerun,
  fixtureRuntimeFeedbackRerun,
  fixtureSingleItemRepairRerun,
  ReviewerRepairRerunScheduler,
  reviewerTriggeredRerunJobNameValues,
  reviewerTriggeredRerunPayloadSchemaVersion,
  reviewerTriggeredRerunReasonCodeValues,
  reviewerTriggeredRerunStageValues,
  type ReviewerTriggeredRerunPayload,
  type ReviewerTriggeredRerunQueuePort,
} from "../src/reviewer/index.js";

const actor: AuthorizationActor = { userId: "local-user" };
const queuedAt = new Date("2026-06-26T12:00:00Z");

describe("ReviewerRepairRerunScheduler", () => {
  it("maps a single repair request to the durable draft -> QA -> export -> runtime chain", () => {
    const inputs = buildReviewerTriggeredRerunJobInputs(fixtureSingleItemRepairRerun());

    expect(inputs.map((input) => input.jobName)).toEqual([
      reviewerTriggeredRerunJobNameValues.draftRepair,
      reviewerTriggeredRerunJobNameValues.qaReplay,
      reviewerTriggeredRerunJobNameValues.exportRegeneration,
      reviewerTriggeredRerunJobNameValues.runtimeValidation,
    ]);
    expect(inputs.map((input) => input.dependsOnJobIds)).toEqual([
      [],
      [inputs[0]!.jobId],
      [inputs[1]!.jobId],
      [inputs[2]!.jobId],
    ]);
    for (const input of inputs) {
      const payload = input.payload as ReviewerTriggeredRerunPayload;
      expect(input.jobType).toBe(jobTaskTypeValues.rerun);
      expect(input.queueName).toBe("reviewer-rerun");
      expect(payload.schemaVersion).toBe(reviewerTriggeredRerunPayloadSchemaVersion);
      expect(payload.projectId).toBe("project-itotori-084");
      expect(payload.localeBranchId).toBe("locale-branch-itotori-084");
      expect(payload.sourceRevisionId).toBe("source-revision-itotori-084");
      expect(payload.affectedUnitIds).toEqual(["bridge-unit-itotori-084-a"]);
      expect(payload.artifactIds).toEqual([
        "artifact-itotori-084-draft",
        "artifact-itotori-084-export",
      ]);
      expect(payload.reasonCodes).toEqual([
        reviewerTriggeredRerunReasonCodeValues.reviewerRequestRepair,
      ]);
    }
  });

  it("keeps batch repair jobs targeted per reviewer item", () => {
    const inputs = fixtureBatchRepairRerun().flatMap((result) =>
      buildReviewerTriggeredRerunJobInputs(result),
    );

    expect(inputs).toHaveLength(8);
    const firstPayloads = inputs
      .slice(0, 4)
      .map((input) => input.payload as ReviewerTriggeredRerunPayload);
    const secondPayloads = inputs
      .slice(4)
      .map((input) => input.payload as ReviewerTriggeredRerunPayload);
    expect(new Set(firstPayloads.flatMap((payload) => payload.affectedUnitIds))).toEqual(
      new Set(["bridge-unit-itotori-084-a"]),
    );
    expect(new Set(secondPayloads.flatMap((payload) => payload.affectedUnitIds))).toEqual(
      new Set(["bridge-unit-itotori-084-b"]),
    );
  });

  it("carries policy and glossary versions for policy invalidation reruns", () => {
    const [draft] = buildReviewerTriggeredRerunJobInputs(fixturePolicyInvalidationRerun());
    const payload = draft!.payload as ReviewerTriggeredRerunPayload;

    expect(payload.stage).toBe(reviewerTriggeredRerunStageValues.draftRepair);
    expect(payload.reasonCodes).toEqual([
      reviewerTriggeredRerunReasonCodeValues.reviewerStyleUpdate,
      reviewerTriggeredRerunReasonCodeValues.policyInvalidated,
    ]);
    expect(payload.policyVersions).toEqual({
      styleGuideVersionId: "style-guide-version-itotori-084",
      glossaryVersionId: "glossary-version-itotori-084",
      pairPolicyVersionId: "pair-policy-v0.3",
      qaPolicyVersionId: "qa-policy-itotori-084",
      exportPolicyVersionId: "export-policy-itotori-084",
      runtimeValidationPolicyVersionId: "runtime-policy-itotori-084",
    });
    expect(payload.ruleLabel).toBe("Honorifics: retain -san in voiced lines");
  });

  it("carries runtime feedback evidence into every rerun stage payload", () => {
    const inputs = buildReviewerTriggeredRerunJobInputs(fixtureRuntimeFeedbackRerun());
    for (const input of inputs) {
      const payload = input.payload as ReviewerTriggeredRerunPayload;
      expect(payload.reasonCodes).toEqual([
        reviewerTriggeredRerunReasonCodeValues.reviewerRuntimeFeedbackImport,
        reviewerTriggeredRerunReasonCodeValues.runtimeFeedbackRerun,
      ]);
      expect(payload.runtimeEvidenceTier).toBe("tier-2-trace");
      expect(payload.observationEventIds).toEqual(["runtime-observation-itotori-084"]);
      expect(payload.artifactHashes).toEqual(["sha256:runtime-itotori-084"]);
    }
    expect((inputs[3]!.payload as ReviewerTriggeredRerunPayload).stage).toBe(
      reviewerTriggeredRerunStageValues.runtimeValidation,
    );
  });

  it("uses durable idempotency keys so equivalent pending reruns dedupe", async () => {
    const queue = new DedupingQueue();
    const scheduler = new ReviewerRepairRerunScheduler({ queue });
    const fixture = fixtureSingleItemRepairRerun();

    await scheduler.enqueueForReviewerAction(actor, fixture);
    await scheduler.enqueueForReviewerAction(actor, equivalentTransitionReplay(fixture));

    expect(queue.records).toHaveLength(4);
    expect(queue.enqueuedInputs).toHaveLength(8);
    expect(new Set(queue.records.map((record) => record.idempotencyKey)).size).toBe(4);
  });
});

class DedupingQueue implements ReviewerTriggeredRerunQueuePort {
  readonly records: JobQueueRecord[] = [];
  readonly enqueuedInputs: JobQueueInput[] = [];
  private readonly byIdempotencyKey = new Map<string, JobQueueRecord>();

  async enqueueJobs(
    _actor: AuthorizationActor,
    inputs: readonly JobQueueInput[],
  ): Promise<JobQueueRecord[]> {
    this.enqueuedInputs.push(...inputs);
    const records: JobQueueRecord[] = [];
    for (const input of inputs) {
      records.push(this.enqueueOne(input));
    }
    return records;
  }

  private enqueueOne(input: JobQueueInput): JobQueueRecord {
    const key = input.idempotency.policy === "idempotent" ? input.idempotency.key : input.jobId!;
    const existing = this.byIdempotencyKey.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const record = jobRecordFromInput(input);
    this.byIdempotencyKey.set(key, record);
    this.records.push(record);
    return record;
  }
}

function equivalentTransitionReplay(result: ReviewerQueueActionResult): ReviewerQueueActionResult {
  return {
    item: result.item,
    transition: {
      ...result.transition,
      transitionId: "reviewer-transition-itotori-084-equivalent-replay",
    },
  };
}

function jobRecordFromInput(input: JobQueueInput): JobQueueRecord {
  return {
    jobId: input.jobId!,
    projectId: input.projectId,
    localeBranchId: input.localeBranchId ?? null,
    sourceEventId: input.sourceEventId ?? null,
    triggerOutboxEventId: input.triggerOutboxEventId ?? null,
    jobType: input.jobType,
    jobName: input.jobName,
    queueName: input.queueName ?? "default",
    status: jobStatusValues.queued,
    idempotencyPolicy: input.idempotency.policy,
    idempotencyKey: input.idempotency.policy === "idempotent" ? input.idempotency.key : null,
    correlationId: input.correlationId ?? input.jobId!,
    causationId: input.causationId ?? null,
    subjectRefs: input.subjectRefs ?? [],
    dependsOnJobIds: input.dependsOnJobIds ?? [],
    payload: input.payload ?? {},
    priority: input.priority ?? 0,
    availableAt: queuedAt,
    attemptCount: 0,
    maxAttempts: input.maxAttempts ?? 3,
    lockedBy: null,
    lockedAt: null,
    leaseExpiresAt: null,
    completedAt: null,
    lastError: null,
    errorHistory: [],
    result: null,
    createdAt: queuedAt,
    updatedAt: queuedAt,
  };
}
