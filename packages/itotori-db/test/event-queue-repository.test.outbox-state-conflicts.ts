import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";

import {
  ItotoriEventQueueRepository,
  type JobQueueInput,
  OutboxLeaseRevalidationError,
  outboxLeaseRevalidationReasons,
} from "../src/repositories/event-queue-repository.js";

import { ItotoriJobWorkerService } from "../src/services/event-queue-service.js";
import {
  jobIdempotencyPolicyValues,
  jobStatusValues,
  jobTaskTypeValues,
  outboxStatusValues,
} from "../src/schema.js";

const localActor: AuthorizationActor = { userId: localUserId };

function jobInput(overrides: Partial<JobQueueInput> = {}): JobQueueInput {
  return {
    jobId: "job-rerun-drafts",
    projectId: "project-test",
    localeBranchId: "locale-en-us",
    jobType: jobTaskTypeValues.rerun,
    jobName: "test.affected-drafts",
    idempotency: {
      policy: jobIdempotencyPolicyValues.idempotent,
      key: "job:rerun:affected-drafts",
    },
    subjectRefs: [{ subjectKind: "bridge_unit", subjectId: "bridge-unit-test" }],
    payload: { reason: "style-guide-version-created" },
    maxAttempts: 2,
    ...overrides,
  };
}

import {
  migratedContext,
  seedOutboxEvent,
  seedProject,
} from "./event-queue-repository.test.support.js";

describe("ItotoriEventQueueRepository", () => {
  it("rejects a duplicate outbox publish mark without re-publishing the event", async () => {
    const context = await migratedContext();
    try {
      await seedProject(context.db);
      const queue = new ItotoriEventQueueRepository(context.db);
      await seedOutboxEvent(queue);

      const [claimed] = await queue.claimOutboxEvents(localActor, "publisher-a", { limit: 1 });
      expect(claimed?.status).toBe(outboxStatusValues.publishing);

      const first = await queue.markOutboxEventPublished(
        localActor,
        "outbox-agent-task",
        "publisher-a",
      );
      expect(first).toMatchObject({ status: outboxStatusValues.published });
      const firstPublishedAt = first.publishedAt;
      expect(firstPublishedAt).toBeInstanceOf(Date);

      const error = await queue
        .markOutboxEventPublished(localActor, "outbox-agent-task", "publisher-a")
        .then(
          () => {
            throw new Error("expected duplicate publish mark to be rejected");
          },
          (caught: unknown) => caught,
        );
      expect(error).toBeInstanceOf(OutboxLeaseRevalidationError);
      const revalidation = error as OutboxLeaseRevalidationError;
      expect(revalidation.reason).toBe(outboxLeaseRevalidationReasons.notPublishing);
      expect(revalidation.actualOwner).toBeNull();
      expect(revalidation.outboxStatus).toBe(outboxStatusValues.published);

      // The duplicate must NOT re-stamp the publish time or otherwise mutate state.
      const afterDuplicate = await queue.getOutboxEvent(localActor, "outbox-agent-task");
      expect(afterDuplicate).toMatchObject({ status: outboxStatusValues.published });
      expect(afterDuplicate?.publishedAt?.getTime()).toBe(firstPublishedAt?.getTime());
    } finally {
      await context.close();
    }
  });

  it("rejects a stale outbox fail mark so retry transitions stay deterministic", async () => {
    const context = await migratedContext();
    try {
      await seedProject(context.db);
      const queue = new ItotoriEventQueueRepository(context.db);
      await seedOutboxEvent(queue);

      const [claimed] = await queue.claimOutboxEvents(localActor, "publisher-a", {
        limit: 1,
        leaseSeconds: 0,
      });
      expect(claimed).toMatchObject({ status: outboxStatusValues.publishing, attemptCount: 1 });

      // A stale publisher must not be able to drive the retry/dead-letter transition.
      const error = await queue
        .markOutboxEventFailed(localActor, "outbox-agent-task", "publisher-a", {
          error: new Error("stale broker outage"),
        })
        .then(
          () => {
            throw new Error("expected stale fail mark to be rejected");
          },
          (caught: unknown) => caught,
        );
      expect(error).toBeInstanceOf(OutboxLeaseRevalidationError);
      expect((error as OutboxLeaseRevalidationError).reason).toBe(
        outboxLeaseRevalidationReasons.leaseExpired,
      );
      expect((error as OutboxLeaseRevalidationError).operation).toBe("fail");

      // Still publishing (not mis-transitioned) and no error recorded by the stale mark;
      // recovery performs the single, deterministic retry transition.
      const afterReject = await queue.getOutboxEvent(localActor, "outbox-agent-task");
      expect(afterReject).toMatchObject({
        status: outboxStatusValues.publishing,
        lastError: null,
        attemptCount: 1,
      });
      const recovered = await queue.recoverExpiredOutboxLeases(localActor);
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({
        status: outboxStatusValues.retryWaiting,
        attemptCount: 1,
        lastError: "lease expired",
      });
    } finally {
      await context.close();
    }
  });

  it("prevents duplicate job leases and recovers expired leases for another worker", async () => {
    const context = await migratedContext();
    try {
      await seedProject(context.db);
      const queue = new ItotoriEventQueueRepository(context.db);
      await queue.enqueueJob(localActor, jobInput());

      const workerA = await queue.claimJobs(localActor, "worker-a", {
        limit: 1,
        leaseSeconds: 0,
      });
      expect(workerA).toHaveLength(1);
      expect(workerA[0]).toMatchObject({
        jobId: "job-rerun-drafts",
        status: jobStatusValues.running,
        lockedBy: "worker-a",
        attemptCount: 1,
      });

      await expect(queue.claimJobs(localActor, "worker-b", { limit: 1 })).resolves.toEqual([]);

      const recovered = await queue.recoverExpiredJobLeases(localActor);
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({
        jobId: "job-rerun-drafts",
        status: jobStatusValues.retryWaiting,
        lastError: "lease expired",
      });

      const workerB = await queue.claimJobs(localActor, "worker-b", { limit: 1 });
      expect(workerB).toHaveLength(1);
      expect(workerB[0]).toMatchObject({
        jobId: "job-rerun-drafts",
        status: jobStatusValues.running,
        lockedBy: "worker-b",
        attemptCount: 2,
      });
      expect(workerB[0]?.errorHistory[0]).toMatchObject({
        workerId: "worker-a",
        attempt: 1,
        error: "lease expired",
      });
    } finally {
      await context.close();
    }
  });

  it("claims dependent jobs only after all dependency jobs have succeeded", async () => {
    const context = await migratedContext();
    try {
      await seedProject(context.db);
      const queue = new ItotoriEventQueueRepository(context.db);
      await queue.enqueueJob(
        localActor,
        jobInput({
          jobId: "job-rerun-draft-repair",
          jobName: "test.draft-repair",
          idempotency: {
            policy: jobIdempotencyPolicyValues.idempotent,
            key: "job:rerun:draft-repair",
          },
          priority: 40,
        }),
      );
      await queue.enqueueJob(
        localActor,
        jobInput({
          jobId: "job-rerun-qa-replay",
          jobName: "test.qa-replay",
          idempotency: {
            policy: jobIdempotencyPolicyValues.idempotent,
            key: "job:rerun:qa-replay",
          },
          dependsOnJobIds: ["job-rerun-draft-repair"],
          priority: 30,
        }),
      );
      await queue.enqueueJob(
        localActor,
        jobInput({
          jobId: "job-rerun-export-regeneration",
          jobName: "test.export-regeneration",
          idempotency: {
            policy: jobIdempotencyPolicyValues.idempotent,
            key: "job:rerun:export-regeneration",
          },
          dependsOnJobIds: ["job-rerun-qa-replay"],
          priority: 20,
        }),
      );
      await queue.enqueueJob(
        localActor,
        jobInput({
          jobId: "job-rerun-runtime-validation",
          jobName: "test.runtime-validation",
          idempotency: {
            policy: jobIdempotencyPolicyValues.idempotent,
            key: "job:rerun:runtime-validation",
          },
          dependsOnJobIds: ["job-rerun-export-regeneration"],
          priority: 10,
        }),
      );

      const draft = await queue.claimJobs(localActor, "worker-draft", { limit: 10 });
      expect(draft.map((job) => job.jobId)).toEqual(["job-rerun-draft-repair"]);
      await expect(queue.claimJobs(localActor, "worker-blocked", { limit: 10 })).resolves.toEqual(
        [],
      );

      await queue.completeJob(localActor, "job-rerun-draft-repair", "worker-draft");
      const qa = await queue.claimJobs(localActor, "worker-qa", { limit: 10 });
      expect(qa.map((job) => job.jobId)).toEqual(["job-rerun-qa-replay"]);

      await queue.completeJob(localActor, "job-rerun-qa-replay", "worker-qa");
      const exported = await queue.claimJobs(localActor, "worker-export", { limit: 10 });
      expect(exported.map((job) => job.jobId)).toEqual(["job-rerun-export-regeneration"]);

      await queue.completeJob(localActor, "job-rerun-export-regeneration", "worker-export");
      const runtime = await queue.claimJobs(localActor, "worker-runtime", { limit: 10 });
      expect(runtime.map((job) => job.jobId)).toEqual(["job-rerun-runtime-validation"]);
      expect(runtime[0]?.dependsOnJobIds).toEqual(["job-rerun-export-regeneration"]);
    } finally {
      await context.close();
    }
  });

  it("dead-letters expired job leases after the final allowed attempt", async () => {
    const context = await migratedContext();
    try {
      await seedProject(context.db);
      const queue = new ItotoriEventQueueRepository(context.db);
      await queue.enqueueJob(
        localActor,
        jobInput({
          jobId: "job-final-lease-expired",
          idempotency: {
            policy: jobIdempotencyPolicyValues.idempotent,
            key: "job:final-lease-expired",
          },
          maxAttempts: 1,
        }),
      );

      const claimed = await queue.claimJobs(localActor, "worker-final", {
        limit: 1,
        leaseSeconds: 0,
      });
      expect(claimed).toHaveLength(1);
      expect(claimed[0]).toMatchObject({
        jobId: "job-final-lease-expired",
        status: jobStatusValues.running,
        attemptCount: 1,
      });

      const recovered = await queue.recoverExpiredJobLeases(localActor);
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({
        jobId: "job-final-lease-expired",
        status: jobStatusValues.deadLetter,
        attemptCount: 1,
        lastError: "lease expired",
        lockedBy: null,
        leaseExpiresAt: null,
      });
      expect(recovered[0]?.errorHistory[0]).toMatchObject({
        workerId: "worker-final",
        attempt: 1,
        error: "lease expired",
        terminal: true,
      });

      await expect(queue.claimJobs(localActor, "worker-retry", { limit: 1 })).resolves.toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("runs queued jobs through worker handlers and preserves retry errors through dead-letter", async () => {
    const context = await migratedContext();
    try {
      await seedProject(context.db);
      const queue = new ItotoriEventQueueRepository(context.db);
      await queue.enqueueJob(
        localActor,
        jobInput({
          jobId: "job-deterministic-success",
          jobType: jobTaskTypeValues.deterministicToolTask,
          jobName: "tool.protected-span-check",
          idempotency: {
            policy: jobIdempotencyPolicyValues.idempotent,
            key: "job:deterministic:success",
          },
          maxAttempts: 1,
        }),
      );
      await queue.enqueueJob(
        localActor,
        jobInput({
          jobId: "job-triage-fails",
          jobType: jobTaskTypeValues.triageLoop,
          jobName: "triage.feedback-loop",
          idempotency: {
            policy: jobIdempotencyPolicyValues.idempotent,
            key: "job:triage:fails",
          },
          maxAttempts: 2,
          priority: -1,
        }),
      );

      const successWorker = new ItotoriJobWorkerService(queue, localActor, "worker-success", {
        byType: {
          [jobTaskTypeValues.deterministicToolTask]: async (job) => ({
            checked: true,
            jobName: job.jobName,
          }),
        },
      });
      await expect(successWorker.runAvailable({ limit: 1 })).resolves.toEqual({
        claimed: 1,
        succeeded: 1,
        failed: 0,
        leaseLost: 0,
      });

      const succeeded = await queue.getJob(localActor, "job-deterministic-success");
      expect(succeeded).toMatchObject({
        status: jobStatusValues.succeeded,
        result: { checked: true, jobName: "tool.protected-span-check" },
      });

      const failingWorker = new ItotoriJobWorkerService(queue, localActor, "worker-fails", {
        byName: {
          "triage.feedback-loop": async () => {
            throw new Error("triage model unavailable");
          },
        },
      });
      await expect(failingWorker.runAvailable({ limit: 1, retryAfterSeconds: 0 })).resolves.toEqual(
        {
          claimed: 1,
          succeeded: 0,
          failed: 1,
          leaseLost: 0,
        },
      );
      await expect(failingWorker.runAvailable({ limit: 1, retryAfterSeconds: 0 })).resolves.toEqual(
        {
          claimed: 1,
          succeeded: 0,
          failed: 1,
          leaseLost: 0,
        },
      );

      const failed = await queue.getJob(localActor, "job-triage-fails");
      expect(failed).toMatchObject({
        status: jobStatusValues.deadLetter,
        attemptCount: 2,
        lastError: "triage model unavailable",
      });
      expect(failed?.errorHistory).toHaveLength(2);
      expect(failed?.errorHistory[1]).toMatchObject({
        workerId: "worker-fails",
        attempt: 2,
        terminal: true,
      });
    } finally {
      await context.close();
    }
  });
});
