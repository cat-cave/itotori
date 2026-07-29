import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";

import {
  ItotoriEventQueueRepository,
  type JobQueueInput,
  OutboxLeaseRevalidationError,
  outboxLeaseRevalidationReasons,
} from "../src/repositories/event-queue-repository.js";

import { ItotoriOutboxPublisherService } from "../src/services/event-queue-service.js";
import {
  eventOutbox,
  jobIdempotencyPolicyValues,
  jobQueue,
  jobTaskTypeValues,
  outboxEventTypeValues,
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
} from "./event-queue-repository.test.shared-01.js";

describe("ItotoriEventQueueRepository", () => {
  it("atomically appends outbox events with typed follow-up jobs and idempotent dedupe", async () => {
    const context = await migratedContext();
    try {
      await seedProject(context.db);
      const queue = new ItotoriEventQueueRepository(context.db);

      const scheduled = await queue.appendOutboxEventWithJobs(localActor, {
        event: {
          outboxEventId: "outbox-rerun-requested",
          projectId: "project-test",
          localeBranchId: "locale-en-us",
          eventType: outboxEventTypeValues.rerunRequested,
          idempotencyKey: "outbox:style-v8-rerun",
          payload: {
            decisionId: "decision-style-v8",
            rerunScope: "affected_context_cluster",
          },
        },
        jobs: [
          jobInput({
            jobId: "job-agent-task",
            jobType: jobTaskTypeValues.agentTask,
            jobName: "agent.context-summary",
            idempotency: {
              policy: jobIdempotencyPolicyValues.idempotent,
              key: "job:agent:context-summary",
            },
          }),
          jobInput({
            jobId: "job-deterministic-tool",
            jobType: jobTaskTypeValues.deterministicToolTask,
            jobName: "tool.protected-span-check",
            idempotency: {
              policy: jobIdempotencyPolicyValues.idempotent,
              key: "job:tool:protected-span-check",
            },
          }),
          jobInput(),
          jobInput({
            jobId: "job-triage-loop",
            jobType: jobTaskTypeValues.triageLoop,
            jobName: "triage.feedback-loop",
            idempotency: {
              policy: jobIdempotencyPolicyValues.idempotent,
              key: "job:triage:feedback-loop",
            },
          }),
        ],
      });

      expect(scheduled.outboxEvent).toMatchObject({
        outboxEventId: "outbox-rerun-requested",
        status: outboxStatusValues.pending,
        eventType: outboxEventTypeValues.rerunRequested,
      });
      expect(scheduled.jobs.map((job) => job.jobType).sort()).toEqual([
        jobTaskTypeValues.agentTask,
        jobTaskTypeValues.deterministicToolTask,
        jobTaskTypeValues.rerun,
        jobTaskTypeValues.triageLoop,
      ]);
      expect(new Set(scheduled.jobs.map((job) => job.triggerOutboxEventId))).toEqual(
        new Set(["outbox-rerun-requested"]),
      );

      const duplicate = await queue.appendOutboxEventWithJobs(localActor, {
        event: {
          outboxEventId: "outbox-rerun-requested-duplicate-id",
          projectId: "project-test",
          localeBranchId: "locale-en-us",
          eventType: outboxEventTypeValues.rerunRequested,
          idempotencyKey: "outbox:style-v8-rerun",
          payload: { decisionId: "decision-style-v8" },
        },
        jobs: [
          jobInput({
            jobId: "job-rerun-drafts-changed-idempotency",
            idempotency: {
              policy: jobIdempotencyPolicyValues.idempotent,
              key: "job:rerun:affected-drafts:v2",
            },
          }),
          jobInput({
            jobId: "job-rerun-drafts-non-idempotent",
            jobName: "test.affected-drafts.non-idempotent",
            idempotency: {
              policy: jobIdempotencyPolicyValues.nonIdempotent,
            },
          }),
        ],
      });

      expect(duplicate.outboxEvent.outboxEventId).toBe("outbox-rerun-requested");
      expect(duplicate.jobs).toEqual([]);
      await expect(
        queue.getJob(localActor, "job-rerun-drafts-changed-idempotency"),
      ).resolves.toBeNull();
      await expect(queue.getJob(localActor, "job-rerun-drafts-non-idempotent")).resolves.toBeNull();

      const counts = await context.db.execute(sql`
        select
          (select count(*)::int from ${eventOutbox}) as outbox_count,
          (select count(*)::int from ${jobQueue}) as job_count
      `);
      expect(counts.rows[0]).toMatchObject({ outbox_count: 1, job_count: 4 });
    } finally {
      await context.close();
    }
  });

  it("publishes outbox events with retry history before marking them published", async () => {
    const context = await migratedContext();
    try {
      await seedProject(context.db);
      const queue = new ItotoriEventQueueRepository(context.db);
      await queue.appendOutboxEvent(localActor, {
        outboxEventId: "outbox-agent-task",
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        eventType: outboxEventTypeValues.agentTaskRequested,
        idempotencyKey: "outbox:agent-task",
        payload: { agentTask: "context-summary" },
        maxAttempts: 2,
      });

      let publishAttempts = 0;
      const publisher = new ItotoriOutboxPublisherService(
        queue,
        localActor,
        "publisher-1",
        async () => {
          publishAttempts += 1;
          if (publishAttempts === 1) {
            throw new Error("temporary broker outage");
          }
        },
      );

      await expect(
        publisher.publishAvailable({ limit: 1, leaseSeconds: 60, retryAfterSeconds: 0 }),
      ).resolves.toEqual({ claimed: 1, published: 0, failed: 1, leaseLost: 0 });

      const afterFailure = await queue.getOutboxEvent(localActor, "outbox-agent-task");
      expect(afterFailure).toMatchObject({
        status: outboxStatusValues.retryWaiting,
        attemptCount: 1,
        lastError: "temporary broker outage",
      });
      expect(afterFailure?.errorHistory).toHaveLength(1);
      expect(afterFailure?.errorHistory[0]).toMatchObject({
        workerId: "publisher-1",
        attempt: 1,
        terminal: false,
      });

      await expect(
        publisher.publishAvailable({ limit: 1, leaseSeconds: 60, retryAfterSeconds: 0 }),
      ).resolves.toEqual({ claimed: 1, published: 1, failed: 0, leaseLost: 0 });

      const published = await queue.getOutboxEvent(localActor, "outbox-agent-task");
      expect(published).toMatchObject({
        status: outboxStatusValues.published,
        attemptCount: 2,
        publishedAt: expect.any(Date),
        lockedBy: null,
      });
      expect(published?.errorHistory).toHaveLength(1);
    } finally {
      await context.close();
    }
  });

  it("dead-letters expired outbox leases after the final allowed attempt", async () => {
    const context = await migratedContext();
    try {
      await seedProject(context.db);
      const queue = new ItotoriEventQueueRepository(context.db);
      await queue.appendOutboxEvent(localActor, {
        outboxEventId: "outbox-final-lease-expired",
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        eventType: outboxEventTypeValues.agentTaskRequested,
        idempotencyKey: "outbox:final-lease-expired",
        payload: { agentTask: "context-summary" },
        maxAttempts: 1,
      });

      const claimed = await queue.claimOutboxEvents(localActor, "publisher-final", {
        limit: 1,
        leaseSeconds: 0,
      });
      expect(claimed).toHaveLength(1);
      expect(claimed[0]).toMatchObject({
        outboxEventId: "outbox-final-lease-expired",
        status: outboxStatusValues.publishing,
        attemptCount: 1,
      });

      const recovered = await queue.recoverExpiredOutboxLeases(localActor);
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({
        outboxEventId: "outbox-final-lease-expired",
        status: outboxStatusValues.deadLetter,
        attemptCount: 1,
        lastError: "lease expired",
        lockedBy: null,
        leaseExpiresAt: null,
      });
      expect(recovered[0]?.errorHistory[0]).toMatchObject({
        workerId: "publisher-final",
        attempt: 1,
        error: "lease expired",
        terminal: true,
      });

      await expect(
        queue.claimOutboxEvents(localActor, "publisher-retry", { limit: 1 }),
      ).resolves.toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("rejects an outbox publish mark from an expired-but-unrecovered lease and stays deterministic", async () => {
    const context = await migratedContext();
    try {
      await seedProject(context.db);
      const queue = new ItotoriEventQueueRepository(context.db);
      await seedOutboxEvent(queue);

      const [claimed] = await queue.claimOutboxEvents(localActor, "publisher-a", {
        limit: 1,
        leaseSeconds: 0,
      });
      expect(claimed).toMatchObject({
        outboxEventId: "outbox-agent-task",
        status: outboxStatusValues.publishing,
        lockedBy: "publisher-a",
        attemptCount: 1,
      });

      // Lease is expired (leaseSeconds: 0) but NOT yet recovered: the row still
      // reads status=publishing, locked_by=publisher-a. A naive owner-only check
      // would let publisher-a mark it published; revalidation must reject it.
      const error = await queue
        .markOutboxEventPublished(localActor, "outbox-agent-task", "publisher-a")
        .then(
          () => {
            throw new Error("expected stale publish mark to be rejected");
          },
          (caught: unknown) => caught,
        );
      expect(error).toBeInstanceOf(OutboxLeaseRevalidationError);
      const revalidation = error as OutboxLeaseRevalidationError;
      expect(revalidation.reason).toBe(outboxLeaseRevalidationReasons.leaseExpired);
      expect(revalidation.operation).toBe("publish");
      expect(revalidation.expectedOwner).toBe("publisher-a");
      expect(revalidation.actualOwner).toBe("publisher-a");
      expect(revalidation.outboxStatus).toBe(outboxStatusValues.publishing);
      expect(revalidation.leaseExpiresAt).toBeInstanceOf(Date);
      expect(revalidation.message).toContain("lease ownership revalidation failed");
      expect(revalidation.message).toContain("reason=lease_expired");

      // Final outbox state was NOT corrupted by the rejected mark.
      const afterReject = await queue.getOutboxEvent(localActor, "outbox-agent-task");
      expect(afterReject).toMatchObject({
        status: outboxStatusValues.publishing,
        lockedBy: "publisher-a",
        publishedAt: null,
        attemptCount: 1,
      });

      // Recovery remains the sole authority and the retry stays deterministic.
      const recovered = await queue.recoverExpiredOutboxLeases(localActor);
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({
        outboxEventId: "outbox-agent-task",
        status: outboxStatusValues.retryWaiting,
        attemptCount: 1,
        lockedBy: null,
      });

      const [reclaimed] = await queue.claimOutboxEvents(localActor, "publisher-b", { limit: 1 });
      expect(reclaimed).toMatchObject({
        status: outboxStatusValues.publishing,
        lockedBy: "publisher-b",
        attemptCount: 2,
      });
      const published = await queue.markOutboxEventPublished(
        localActor,
        "outbox-agent-task",
        "publisher-b",
      );
      expect(published).toMatchObject({
        status: outboxStatusValues.published,
        attemptCount: 2,
        publishedAt: expect.any(Date),
        lockedBy: null,
      });
    } finally {
      await context.close();
    }
  });

  it("rejects an outbox mark from a publisher whose lease was taken over by another owner", async () => {
    const context = await migratedContext();
    try {
      await seedProject(context.db);
      const queue = new ItotoriEventQueueRepository(context.db);
      await seedOutboxEvent(queue);

      await queue.claimOutboxEvents(localActor, "publisher-a", { limit: 1, leaseSeconds: 0 });
      await queue.recoverExpiredOutboxLeases(localActor);
      const [ownerB] = await queue.claimOutboxEvents(localActor, "publisher-b", { limit: 1 });
      expect(ownerB).toMatchObject({
        status: outboxStatusValues.publishing,
        lockedBy: "publisher-b",
        attemptCount: 2,
      });

      // publisher-a is stale: publisher-b now owns the publishing lease.
      const error = await queue
        .markOutboxEventPublished(localActor, "outbox-agent-task", "publisher-a")
        .then(
          () => {
            throw new Error("expected ownership-transfer mark to be rejected");
          },
          (caught: unknown) => caught,
        );
      expect(error).toBeInstanceOf(OutboxLeaseRevalidationError);
      const revalidation = error as OutboxLeaseRevalidationError;
      expect(revalidation.reason).toBe(outboxLeaseRevalidationReasons.ownerMismatch);
      expect(revalidation.expectedOwner).toBe("publisher-a");
      expect(revalidation.actualOwner).toBe("publisher-b");
      expect(revalidation.outboxStatus).toBe(outboxStatusValues.publishing);

      // The genuine owner (publisher-b) is unaffected and still publishes cleanly.
      const afterReject = await queue.getOutboxEvent(localActor, "outbox-agent-task");
      expect(afterReject).toMatchObject({
        status: outboxStatusValues.publishing,
        lockedBy: "publisher-b",
        publishedAt: null,
      });
      const published = await queue.markOutboxEventPublished(
        localActor,
        "outbox-agent-task",
        "publisher-b",
      );
      expect(published).toMatchObject({
        status: outboxStatusValues.published,
        lockedBy: null,
      });
    } finally {
      await context.close();
    }
  });
});
