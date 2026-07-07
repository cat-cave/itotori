import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import { type ItotoriDatabase } from "../src/connection.js";
import {
  ItotoriEventQueueRepository,
  QUEUE_HEALTH_READ_MODEL_SCHEMA_VERSION,
  type JobQueueInput,
  type OutboxEventInput,
} from "../src/repositories/event-queue-repository.js";
import {
  ItotoriProjectRepository,
  type ItotoriProjectRecord,
} from "../src/repositories/project-repository.js";
import {
  jobIdempotencyPolicyValues,
  jobStatusValues,
  jobTaskTypeValues,
  outboxEventTypeValues,
  outboxStatusValues,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

function projectFixture(overrides: Partial<ItotoriProjectRecord> = {}): ItotoriProjectRecord {
  const projectId = overrides.projectId ?? "project-test";
  const project: ItotoriProjectRecord = {
    projectId,
    localeBranchId: "locale-en-us",
    targetLocale: "en-US",
    drafts: { [`${projectId}-unit`]: "Hello, {player}." },
    bridge: {
      schemaVersion: "0.1.0",
      bridgeId: `bridge-${projectId}`,
      sourceBundleHash: `hash-${projectId}`,
      sourceLocale: "ja-JP",
      extractorName: "kaifuu-fixture",
      extractorVersion: "0.0.0",
      units: [
        {
          bridgeUnitId: `${projectId}-bridge-unit`,
          sourceUnitKey: `${projectId}.hello.scene.001.line.001`,
          occurrenceId: `${projectId}-occurrence-1`,
          sourceHash: `${projectId}-source-hash`,
          sourceLocale: "ja-JP",
          sourceText: "こんにちは、{player}。",
          textSurface: "dialogue",
          protectedSpans: [],
          patchRef: {
            assetId: `${projectId}-source.json`,
            writeMode: "replace",
            sourceUnitKey: `${projectId}.hello.scene.001.line.001`,
          },
        },
      ],
    },
  };
  return { ...project, ...overrides };
}

function jobInput(overrides: Partial<JobQueueInput> = {}): JobQueueInput {
  return {
    projectId: "project-test",
    localeBranchId: "locale-en-us",
    jobType: jobTaskTypeValues.rerun,
    jobName: "rerun.affected-drafts",
    idempotency: {
      policy: jobIdempotencyPolicyValues.idempotent,
      key: "job:rerun:affected-drafts",
    },
    subjectRefs: [{ subjectKind: "bridge_unit", subjectId: "project-test-bridge-unit" }],
    payload: { reason: "queue-health-fixture" },
    maxAttempts: 3,
    ...overrides,
  };
}

function outboxInput(overrides: Partial<OutboxEventInput> = {}): OutboxEventInput {
  return {
    projectId: "project-test",
    localeBranchId: "locale-en-us",
    eventType: outboxEventTypeValues.rerunRequested,
    idempotencyKey: "outbox:rerun",
    payload: { reason: "queue-health-fixture" },
    ...overrides,
  };
}

describe("ItotoriEventQueueRepository.loadQueueHealth", () => {
  it("computes outbox lag, job status counts, retry load, and dead-letter review from queue state", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProject(context.db);
      const queue = new ItotoriEventQueueRepository(context.db);

      // --- Jobs: drive one row into each status to exercise the breakdown. ---
      // job-queued is future-dated so it stays queued (not claimable) and, being
      // created first, is the oldest non-terminal job (the lag reference).
      const queuedJob = await queue.enqueueJob(
        localActor,
        jobInput({
          jobId: "job-queued",
          availableAt: new Date(Date.now() + 60_000),
          idempotency: { policy: jobIdempotencyPolicyValues.idempotent, key: "job:queued" },
        }),
      );
      await queue.enqueueJob(
        localActor,
        jobInput({
          jobId: "job-succeeded",
          idempotency: { policy: jobIdempotencyPolicyValues.idempotent, key: "job:succeeded" },
        }),
      );
      const [claimedSucceeded] = await queue.claimJobs(localActor, "worker-a", { limit: 1 });
      expect(claimedSucceeded?.jobId).toBe("job-succeeded");
      await queue.completeJob(localActor, "job-succeeded", "worker-a", { ok: true });

      await queue.enqueueJob(
        localActor,
        jobInput({
          jobId: "job-running",
          idempotency: { policy: jobIdempotencyPolicyValues.idempotent, key: "job:running" },
        }),
      );
      const [claimedRunning] = await queue.claimJobs(localActor, "worker-a", { limit: 1 });
      expect(claimedRunning?.jobId).toBe("job-running");

      await queue.enqueueJob(
        localActor,
        jobInput({
          jobId: "job-retry",
          maxAttempts: 3,
          idempotency: { policy: jobIdempotencyPolicyValues.idempotent, key: "job:retry" },
        }),
      );
      const [claimedRetry] = await queue.claimJobs(localActor, "worker-a", { limit: 1 });
      expect(claimedRetry?.jobId).toBe("job-retry");
      const retried = await queue.failJob(localActor, "job-retry", "worker-a", {
        error: new Error("transient"),
      });
      expect(retried.status).toBe(jobStatusValues.retryWaiting);

      await queue.enqueueJob(
        localActor,
        jobInput({
          jobId: "job-dead",
          maxAttempts: 1,
          idempotency: { policy: jobIdempotencyPolicyValues.idempotent, key: "job:dead" },
        }),
      );
      const [claimedDead] = await queue.claimJobs(localActor, "worker-a", { limit: 1 });
      expect(claimedDead?.jobId).toBe("job-dead");
      const deadJob = await queue.failJob(localActor, "job-dead", "worker-a", {
        error: new Error("terminal"),
      });
      expect(deadJob.status).toBe(jobStatusValues.deadLetter);

      // --- Outbox: one pending (oldest un-processed), one retrying, one dead. ---
      const retryOutbox = await queue.appendOutboxEvent(
        localActor,
        outboxInput({
          outboxEventId: "outbox-retry",
          idempotencyKey: "outbox:retry",
          maxAttempts: 25,
        }),
      );
      const [claimedOutboxRetry] = await queue.claimOutboxEvents(localActor, "worker-b", {
        limit: 1,
      });
      expect(claimedOutboxRetry?.outboxEventId).toBe("outbox-retry");
      const retriedOutbox = await queue.markOutboxEventFailed(
        localActor,
        "outbox-retry",
        "worker-b",
        { error: new Error("transient publish") },
      );
      expect(retriedOutbox.status).toBe(outboxStatusValues.retryWaiting);

      await queue.appendOutboxEvent(
        localActor,
        outboxInput({
          outboxEventId: "outbox-dead",
          idempotencyKey: "outbox:dead",
          maxAttempts: 1,
        }),
      );
      const [claimedOutboxDead] = await queue.claimOutboxEvents(localActor, "worker-b", {
        limit: 1,
      });
      expect(claimedOutboxDead?.outboxEventId).toBe("outbox-dead");
      const deadOutbox = await queue.markOutboxEventFailed(localActor, "outbox-dead", "worker-b", {
        error: new Error("terminal publish"),
      });
      expect(deadOutbox.status).toBe(outboxStatusValues.deadLetter);

      const pendingOutbox = await queue.appendOutboxEvent(
        localActor,
        outboxInput({
          outboxEventId: "outbox-pending",
          idempotencyKey: "outbox:pending",
        }),
      );
      expect(pendingOutbox.status).toBe(outboxStatusValues.pending);

      const health = await queue.loadQueueHealth(localActor);

      // Schema contract + generatedAt is a real timestamp.
      expect(health.schemaVersion).toBe(QUEUE_HEALTH_READ_MODEL_SCHEMA_VERSION);
      expect(health.generatedAt).toBeInstanceOf(Date);

      // Outbox lag: oldest un-processed is the retry event (created first, still
      // non-terminal in retry_waiting). Lag is a non-negative number of seconds.
      expect(health.outbox.unprocessedCount).toBe(2);
      expect(health.outbox.oldestUnprocessedAt?.getTime()).toBe(retryOutbox.createdAt.getTime());
      expect(health.outbox.unprocessedLagSeconds).toBeGreaterThanOrEqual(0);
      expect(health.outbox.retryingCount).toBe(1);
      expect(statusMap(health.outbox.statusCounts)).toMatchObject({
        pending: 1,
        publishing: 0,
        published: 0,
        retry_waiting: 1,
        dead_letter: 1,
      });
      expect(health.outbox.deadLetter.count).toBe(1);
      expect(health.outbox.deadLetter.recent.map((row) => row.outboxEventId)).toEqual([
        "outbox-dead",
      ]);

      // Jobs: pending (non-terminal) = queued + running + retry_waiting.
      expect(health.jobs.unprocessedCount).toBe(3);
      expect(health.jobs.oldestUnprocessedAt?.getTime()).toBe(queuedJob.createdAt.getTime());
      expect(health.jobs.unprocessedLagSeconds).toBeGreaterThanOrEqual(0);
      expect(health.jobs.retryingCount).toBe(1);
      expect(statusMap(health.jobs.statusCounts)).toMatchObject({
        queued: 1,
        running: 1,
        retry_waiting: 1,
        succeeded: 1,
        dead_letter: 1,
        cancelled: 0,
      });
      expect(health.jobs.deadLetter.count).toBe(1);
      expect(health.jobs.deadLetter.recent.map((row) => row.jobId)).toEqual(["job-dead"]);
    } finally {
      await context.close();
    }
  });

  it("reports null lag and an empty dead-letter review when the queue is drained", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProject(context.db);
      const queue = new ItotoriEventQueueRepository(context.db);

      // A fully-published outbox event + a succeeded job leave nothing un-processed.
      await queue.appendOutboxEvent(
        localActor,
        outboxInput({ outboxEventId: "outbox-done", idempotencyKey: "outbox:done" }),
      );
      const [claimed] = await queue.claimOutboxEvents(localActor, "worker-c", { limit: 1 });
      expect(claimed?.outboxEventId).toBe("outbox-done");
      await queue.markOutboxEventPublished(localActor, "outbox-done", "worker-c");

      await queue.enqueueJob(
        localActor,
        jobInput({
          jobId: "job-done",
          idempotency: { policy: jobIdempotencyPolicyValues.idempotent, key: "job:done" },
        }),
      );
      await queue.claimJobs(localActor, "worker-c", { limit: 1 });
      await queue.completeJob(localActor, "job-done", "worker-c");

      const health = await queue.loadQueueHealth(localActor);

      expect(health.outbox.unprocessedCount).toBe(0);
      expect(health.outbox.oldestUnprocessedAt).toBeNull();
      expect(health.outbox.unprocessedLagSeconds).toBeNull();
      expect(statusMap(health.outbox.statusCounts)).toMatchObject({ published: 1 });
      expect(health.outbox.deadLetter).toEqual({ count: 0, recent: [] });

      expect(health.jobs.unprocessedCount).toBe(0);
      expect(health.jobs.oldestUnprocessedAt).toBeNull();
      expect(health.jobs.unprocessedLagSeconds).toBeNull();
      expect(statusMap(health.jobs.statusCounts)).toMatchObject({ succeeded: 1 });
      expect(health.jobs.deadLetter).toEqual({ count: 0, recent: [] });
    } finally {
      await context.close();
    }
  });

  it("scopes by projectId and bounds the dead-letter preview", async () => {
    const context = await isolatedMigratedContext();
    try {
      // Seed BOTH projects after a single reset (seedProject resets, so calling
      // it twice would wipe the first project).
      const projectRepo = new ItotoriProjectRepository(context.db);
      await projectRepo.reset(localActor);
      await projectRepo.importSourceBundle(localActor, projectFixture());
      await projectRepo.importSourceBundle(
        localActor,
        projectFixture({ projectId: "project-other", localeBranchId: "locale-other" }),
      );
      const queue = new ItotoriEventQueueRepository(context.db);

      // Three dead-letter jobs in project-test, one in project-other.
      for (const [index, jobId] of ["dead-a", "dead-b", "dead-c"].entries()) {
        await queue.enqueueJob(
          localActor,
          jobInput({
            projectId: "project-test",
            jobId,
            maxAttempts: 1,
            idempotency: {
              policy: jobIdempotencyPolicyValues.idempotent,
              key: `job:dead:${index}`,
            },
          }),
        );
        await queue.claimJobs(localActor, "worker-d", { limit: 1 });
        await queue.failJob(localActor, jobId, "worker-d", { error: "boom" });
      }
      await queue.enqueueJob(
        localActor,
        jobInput({
          projectId: "project-other",
          localeBranchId: "locale-other",
          jobId: "dead-other",
          maxAttempts: 1,
          idempotency: {
            policy: jobIdempotencyPolicyValues.idempotent,
            key: "job:dead:other",
          },
        }),
      );
      await queue.claimJobs(localActor, "worker-d", { limit: 1 });
      await queue.failJob(localActor, "dead-other", "worker-d", { error: "boom" });

      // Global view sees all four dead-letter jobs; count is unbounded.
      const globalHealth = await queue.loadQueueHealth(localActor);
      expect(globalHealth.jobs.deadLetter.count).toBe(4);
      expect(globalHealth.jobs.deadLetter.recent).toHaveLength(4);

      // Scoped + bounded: only project-test's rows, at most one in the preview.
      const scopedHealth = await queue.loadQueueHealth(localActor, {
        projectId: "project-test",
        deadLetterLimit: 1,
      });
      expect(scopedHealth.jobs.deadLetter.count).toBe(3);
      expect(scopedHealth.jobs.deadLetter.recent).toHaveLength(1);
      expect(["dead-a", "dead-b", "dead-c"]).toContain(
        scopedHealth.jobs.deadLetter.recent[0]!.jobId,
      );
    } finally {
      await context.close();
    }
  });

  it("rejects an out-of-range dead-letter limit", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProject(context.db);
      const queue = new ItotoriEventQueueRepository(context.db);
      await expect(queue.loadQueueHealth(localActor, { deadLetterLimit: 0 })).rejects.toThrow(
        /dead-letter limit/,
      );
      await expect(queue.loadQueueHealth(localActor, { deadLetterLimit: 201 })).rejects.toThrow(
        /dead-letter limit/,
      );
    } finally {
      await context.close();
    }
  });
});

function statusMap(counts: { status: string; count: number }[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const entry of counts) {
    map[entry.status] = entry.count;
  }
  return map;
}

async function seedProject(
  db: ItotoriDatabase,
  overrides: Partial<ItotoriProjectRecord> = {},
): Promise<void> {
  const repo = new ItotoriProjectRepository(db);
  await repo.reset(localActor);
  await repo.importSourceBundle(localActor, projectFixture(overrides));
}
