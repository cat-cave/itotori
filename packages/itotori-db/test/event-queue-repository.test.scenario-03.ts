import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, permissionValues, type AuthorizationActor } from "../src/authorization.js";

import {
  ItotoriEventQueueRepository,
  JobLeaseRevalidationError,
  jobLeaseRevalidationReasons,
  type JobQueueInput,
} from "../src/repositories/event-queue-repository.js";

import { ItotoriJobWorkerService } from "../src/services/event-queue-service.js";
import {
  jobIdempotencyPolicyValues,
  jobStatusValues,
  jobTaskTypeValues,
  userPermissionGrants,
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

import { migratedContext, seedProject } from "./event-queue-repository.test.shared-01.js";

describe("ItotoriEventQueueRepository", () => {
  it("rejects completion from an expired-but-unrecovered lease and stays deterministic", async () => {
    const context = await migratedContext();
    try {
      await seedProject(context.db);
      const queue = new ItotoriEventQueueRepository(context.db);
      await queue.enqueueJob(localActor, jobInput({ maxAttempts: 2 }));

      const [claimed] = await queue.claimJobs(localActor, "worker-a", {
        limit: 1,
        leaseSeconds: 0,
      });
      expect(claimed).toMatchObject({
        jobId: "job-rerun-drafts",
        status: jobStatusValues.running,
        lockedBy: "worker-a",
        attemptCount: 1,
      });

      // Lease is expired (leaseSeconds: 0) but NOT yet recovered: the row still
      // reads status=running, locked_by=worker-a. A naive owner-only check would
      // let worker-a complete; revalidation must reject it.
      const error = await queue
        .completeJob(localActor, "job-rerun-drafts", "worker-a", { checked: true })
        .then(
          () => {
            throw new Error("expected stale completion to be rejected");
          },
          (caught: unknown) => caught,
        );
      expect(error).toBeInstanceOf(JobLeaseRevalidationError);
      const revalidation = error as JobLeaseRevalidationError;
      expect(revalidation.reason).toBe(jobLeaseRevalidationReasons.leaseExpired);
      expect(revalidation.expectedOwner).toBe("worker-a");
      expect(revalidation.actualOwner).toBe("worker-a");
      expect(revalidation.jobStatus).toBe(jobStatusValues.running);
      expect(revalidation.leaseExpiresAt).toBeInstanceOf(Date);
      expect(revalidation.message).toContain("lease ownership revalidation failed");
      expect(revalidation.message).toContain("reason=lease_expired");

      // Final job state was NOT corrupted by the rejected completion.
      const afterReject = await queue.getJob(localActor, "job-rerun-drafts");
      expect(afterReject).toMatchObject({
        status: jobStatusValues.running,
        lockedBy: "worker-a",
        completedAt: null,
        result: null,
        attemptCount: 1,
      });

      // Recovery remains the sole authority and the retry stays deterministic.
      const recovered = await queue.recoverExpiredJobLeases(localActor);
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({
        jobId: "job-rerun-drafts",
        status: jobStatusValues.retryWaiting,
        attemptCount: 1,
        lockedBy: null,
      });

      const [reclaimed] = await queue.claimJobs(localActor, "worker-b", { limit: 1 });
      expect(reclaimed).toMatchObject({
        status: jobStatusValues.running,
        lockedBy: "worker-b",
        attemptCount: 2,
      });
      const completed = await queue.completeJob(localActor, "job-rerun-drafts", "worker-b", {
        checked: true,
      });
      expect(completed).toMatchObject({
        status: jobStatusValues.succeeded,
        attemptCount: 2,
        result: { checked: true },
      });
    } finally {
      await context.close();
    }
  });

  it("rejects completion from a worker whose lease was taken over by another owner", async () => {
    const context = await migratedContext();
    try {
      await seedProject(context.db);
      const queue = new ItotoriEventQueueRepository(context.db);
      await queue.enqueueJob(localActor, jobInput({ maxAttempts: 3 }));

      await queue.claimJobs(localActor, "worker-a", { limit: 1, leaseSeconds: 0 });
      await queue.recoverExpiredJobLeases(localActor);
      const [ownerB] = await queue.claimJobs(localActor, "worker-b", { limit: 1 });
      expect(ownerB).toMatchObject({
        status: jobStatusValues.running,
        lockedBy: "worker-b",
        attemptCount: 2,
      });

      // worker-a is stale: worker-b now owns the running lease.
      const error = await queue
        .completeJob(localActor, "job-rerun-drafts", "worker-a", { stale: true })
        .then(
          () => {
            throw new Error("expected ownership-transfer completion to be rejected");
          },
          (caught: unknown) => caught,
        );
      expect(error).toBeInstanceOf(JobLeaseRevalidationError);
      const revalidation = error as JobLeaseRevalidationError;
      expect(revalidation.reason).toBe(jobLeaseRevalidationReasons.ownerMismatch);
      expect(revalidation.expectedOwner).toBe("worker-a");
      expect(revalidation.actualOwner).toBe("worker-b");
      expect(revalidation.jobStatus).toBe(jobStatusValues.running);

      // The genuine owner (worker-b) is unaffected and still completes cleanly.
      const afterReject = await queue.getJob(localActor, "job-rerun-drafts");
      expect(afterReject).toMatchObject({
        status: jobStatusValues.running,
        lockedBy: "worker-b",
        result: null,
      });
      const completed = await queue.completeJob(localActor, "job-rerun-drafts", "worker-b", {
        owner: "b",
      });
      expect(completed).toMatchObject({
        status: jobStatusValues.succeeded,
        result: { owner: "b" },
      });
    } finally {
      await context.close();
    }
  });

  it("rejects a duplicate completion without overwriting the first result", async () => {
    const context = await migratedContext();
    try {
      await seedProject(context.db);
      const queue = new ItotoriEventQueueRepository(context.db);
      await queue.enqueueJob(localActor, jobInput({ maxAttempts: 2 }));

      const [claimed] = await queue.claimJobs(localActor, "worker-a", { limit: 1 });
      expect(claimed?.status).toBe(jobStatusValues.running);

      const first = await queue.completeJob(localActor, "job-rerun-drafts", "worker-a", {
        result: "first",
      });
      expect(first).toMatchObject({
        status: jobStatusValues.succeeded,
        result: { result: "first" },
      });
      const firstCompletedAt = first.completedAt;
      expect(firstCompletedAt).toBeInstanceOf(Date);

      const error = await queue
        .completeJob(localActor, "job-rerun-drafts", "worker-a", { result: "second" })
        .then(
          () => {
            throw new Error("expected duplicate completion to be rejected");
          },
          (caught: unknown) => caught,
        );
      expect(error).toBeInstanceOf(JobLeaseRevalidationError);
      const revalidation = error as JobLeaseRevalidationError;
      expect(revalidation.reason).toBe(jobLeaseRevalidationReasons.notRunning);
      expect(revalidation.actualOwner).toBeNull();
      expect(revalidation.jobStatus).toBe(jobStatusValues.succeeded);

      // The duplicate must NOT overwrite the recorded result or completion time.
      const afterDuplicate = await queue.getJob(localActor, "job-rerun-drafts");
      expect(afterDuplicate).toMatchObject({
        status: jobStatusValues.succeeded,
        result: { result: "first" },
      });
      expect(afterDuplicate?.completedAt?.getTime()).toBe(firstCompletedAt?.getTime());
    } finally {
      await context.close();
    }
  });

  it("rejects a stale failJob so dead-letter transitions stay deterministic", async () => {
    const context = await migratedContext();
    try {
      await seedProject(context.db);
      const queue = new ItotoriEventQueueRepository(context.db);
      await queue.enqueueJob(localActor, jobInput({ maxAttempts: 1 }));

      const [claimed] = await queue.claimJobs(localActor, "worker-a", {
        limit: 1,
        leaseSeconds: 0,
      });
      expect(claimed).toMatchObject({ status: jobStatusValues.running, attemptCount: 1 });

      // A stale worker must not be able to drive the dead-letter transition.
      const error = await queue
        .failJob(localActor, "job-rerun-drafts", "worker-a", { error: new Error("stale failure") })
        .then(
          () => {
            throw new Error("expected stale failJob to be rejected");
          },
          (caught: unknown) => caught,
        );
      expect(error).toBeInstanceOf(JobLeaseRevalidationError);
      expect((error as JobLeaseRevalidationError).reason).toBe(
        jobLeaseRevalidationReasons.leaseExpired,
      );
      expect((error as JobLeaseRevalidationError).operation).toBe("fail");

      // Still running (not mis-transitioned); recovery performs the single,
      // deterministic dead-letter transition.
      const afterReject = await queue.getJob(localActor, "job-rerun-drafts");
      expect(afterReject).toMatchObject({
        status: jobStatusValues.running,
        lastError: null,
      });
      const recovered = await queue.recoverExpiredJobLeases(localActor);
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({
        status: jobStatusValues.deadLetter,
        attemptCount: 1,
        lastError: "lease expired",
      });
    } finally {
      await context.close();
    }
  });

  it("counts a mid-handler lease loss as leaseLost without corrupting state", async () => {
    const context = await migratedContext();
    try {
      await seedProject(context.db);
      const queue = new ItotoriEventQueueRepository(context.db);
      await queue.enqueueJob(localActor, jobInput({ maxAttempts: 2 }));

      // Lease is issued with leaseSeconds: 0 so it is already expired by the time
      // the handler returns and the worker attempts completeJob.
      const worker = new ItotoriJobWorkerService(queue, localActor, "worker-slow", {
        byName: {
          "test.affected-drafts": async () => ({ done: true }),
        },
      });
      await expect(worker.runAvailable({ limit: 1, leaseSeconds: 0 })).resolves.toEqual({
        claimed: 1,
        succeeded: 0,
        failed: 0,
        leaseLost: 1,
      });

      const afterLoss = await queue.getJob(localActor, "job-rerun-drafts");
      expect(afterLoss).toMatchObject({
        status: jobStatusValues.running,
        lockedBy: "worker-slow",
        result: null,
      });
    } finally {
      await context.close();
    }
  });

  it("bootstraps queue permissions and lookup indexes", async () => {
    const context = await migratedContext();
    try {
      const grant = await context.db
        .select({ permission: userPermissionGrants.permission })
        .from(userPermissionGrants)
        .where(eq(userPermissionGrants.permission, permissionValues.queueManage))
        .limit(1);
      expect(grant[0]?.permission).toBe(permissionValues.queueManage);
      const readGrant = await context.db
        .select({ permission: userPermissionGrants.permission })
        .from(userPermissionGrants)
        .where(eq(userPermissionGrants.permission, permissionValues.queueRead))
        .limit(1);
      expect(readGrant[0]?.permission).toBe(permissionValues.queueRead);

      const result = await context.db.execute(sql`
        select indexname
        from pg_indexes
        where schemaname = current_schema()
          and indexname in (
            'itotori_event_outbox_ready_idx',
            'itotori_event_outbox_idempotency_key_idx',
            'itotori_jobs_ready_idx',
            'itotori_jobs_idempotency_key_idx'
          )
      `);
      expect(new Set(result.rows.map((row) => String(row.indexname)))).toEqual(
        new Set([
          "itotori_event_outbox_ready_idx",
          "itotori_event_outbox_idempotency_key_idx",
          "itotori_jobs_ready_idx",
          "itotori_jobs_idempotency_key_idx",
        ]),
      );
    } finally {
      await context.close();
    }
  });
});
