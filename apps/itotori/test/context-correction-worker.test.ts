import { describe, expect, it, vi } from "vitest";
import {
  contextCorrectionRedraftJobName,
  contextCorrectionRedraftPayloadSchemaVersion,
  jobIdempotencyPolicyValues,
  jobStatusValues,
  jobTaskTypeValues,
  type AuthorizationActor,
  type ContextCorrectionRedraftPayload,
  type ItotoriEventQueueRepositoryPort,
  type JobQueueRecord,
} from "@itotori/db";
import { ContextCorrectionRerunWorker } from "../src/orchestrator/context-correction-worker.js";

const actor: AuthorizationActor = { userId: "context-correction-worker-test-user" };

const payload: ContextCorrectionRedraftPayload = {
  schemaVersion: contextCorrectionRedraftPayloadSchemaVersion,
  correctionId: "correction-zero-change",
  contextArtifactId: "glossary-captain-wato",
  contextEntryVersionId: "context-version-2",
  projectId: "project-context-correction",
  localeBranchId: "locale-branch-en-us",
  sourceRevisionId: "source-revision-1",
  affectedUnitIds: ["bridge-unit-a"],
};

class OneClaimQueue {
  private claimed = false;
  failureMessage: string | undefined;
  recoveryCalls = 0;
  claimOptions: unknown;

  constructor(private readonly job: JobQueueRecord) {}

  async claimJobs(
    _actor: AuthorizationActor,
    _workerId: string,
    options?: unknown,
  ): Promise<JobQueueRecord[]> {
    this.claimOptions = options;
    if (this.claimed) return [];
    this.claimed = true;
    return [this.job];
  }

  async recoverExpiredJobLeases(_actor: AuthorizationActor): Promise<JobQueueRecord[]> {
    this.recoveryCalls += 1;
    return [];
  }

  async failJob(
    _actor: AuthorizationActor,
    jobId: string,
    _workerId: string,
    input: { error: unknown },
  ): Promise<JobQueueRecord> {
    if (jobId !== this.job.jobId) throw new Error(`unexpected job ${jobId}`);
    this.failureMessage = input.error instanceof Error ? input.error.message : String(input.error);
    return this.job;
  }
}

function queuedCorrectionJob(): JobQueueRecord {
  const now = new Date("2026-07-12T00:00:00.000Z");
  return {
    jobId: "job-context-correction-zero-change",
    projectId: payload.projectId,
    localeBranchId: payload.localeBranchId,
    sourceEventId: null,
    triggerOutboxEventId: null,
    jobType: jobTaskTypeValues.rerun,
    jobName: contextCorrectionRedraftJobName,
    queueName: "context-correction",
    status: jobStatusValues.queued,
    idempotencyPolicy: jobIdempotencyPolicyValues.idempotent,
    idempotencyKey: "context-correction:zero-change",
    correlationId: "correlation-zero-change",
    causationId: null,
    subjectRefs: [],
    dependsOnJobIds: [],
    payload,
    priority: 0,
    availableAt: now,
    attemptCount: 1,
    maxAttempts: 3,
    lockedBy: "context-correction-worker-test",
    lockedAt: now,
    leaseExpiresAt: now,
    completedAt: null,
    lastError: null,
    errorHistory: [],
    result: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe("ContextCorrectionRerunWorker", () => {
  it("does not let a journal-id-only redrafter turn a zero-change verification into success", async () => {
    const queue = new OneClaimQueue(queuedCorrectionJob());
    const redraft = vi.fn(async () => ({ journalRunId: "journal-zero-change" }));
    const snapshotDrafts = vi.fn(async () => ({ "bridge-unit-a": "unchanged draft" }));
    const verifyRedraft = vi.fn(async () => ({
      redraftedUnitIds: ["bridge-unit-a"],
      changedDraftCount: 0,
    }));
    const worker = new ContextCorrectionRerunWorker({
      queue: queue as unknown as ItotoriEventQueueRepositoryPort,
      actor,
      workerId: "context-correction-worker-test",
      redrafter: { redraft },
      verifier: { snapshotDrafts, verifyRedraft },
    });

    expect(worker.hasRegisteredHandler()).toBe(true);
    await expect(worker.runUntilIdle()).resolves.toEqual({
      claimed: 1,
      succeeded: 0,
      failed: 1,
      leaseLost: 0,
    });
    expect(redraft).toHaveBeenCalledWith({
      ...payload,
      jobId: "job-context-correction-zero-change",
    });
    expect(verifyRedraft).toHaveBeenCalledWith({
      payload,
      journalRunId: "journal-zero-change",
      draftsBefore: { "bridge-unit-a": "unchanged draft" },
    });
    expect(queue.failureMessage).toContain("produced no changed draft");
    expect(queue.recoveryCalls).toBe(2);
    expect(queue.claimOptions).toEqual({
      queueName: "context-correction",
      limit: 1,
      leaseSeconds: 3_600,
    });
  });
});
