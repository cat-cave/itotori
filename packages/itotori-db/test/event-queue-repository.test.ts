import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, permissionValues, type AuthorizationActor } from "../src/authorization.js";
import { createDatabaseContext, type ItotoriDatabase } from "../src/connection.js";
import { migrate } from "../src/migrations.js";
import {
  ItotoriEventQueueRepository,
  type JobQueueInput,
} from "../src/repositories/event-queue-repository.js";
import {
  ItotoriProjectRepository,
  type ItotoriProjectRecord,
} from "../src/repositories/project-repository.js";
import {
  ItotoriJobWorkerService,
  ItotoriOutboxPublisherService,
} from "../src/services/event-queue-service.js";
import {
  eventOutbox,
  jobIdempotencyPolicyValues,
  jobQueue,
  jobStatusValues,
  jobTaskTypeValues,
  outboxEventTypeValues,
  outboxStatusValues,
  userPermissionGrants,
} from "../src/schema.js";

const localActor: AuthorizationActor = { userId: localUserId };

function projectFixture(overrides: Partial<ItotoriProjectRecord> = {}): ItotoriProjectRecord {
  const project: ItotoriProjectRecord = {
    projectId: "project-test",
    localeBranchId: "locale-en-us",
    targetLocale: "en-US",
    drafts: { "bridge-unit-test": "Hello, {player}." },
    bridge: {
      schemaVersion: "0.1.0",
      bridgeId: "bridge-test",
      sourceBundleHash: "hash-test",
      sourceLocale: "ja-JP",
      extractorName: "kaifuu-fixture",
      extractorVersion: "0.0.0",
      units: [
        {
          bridgeUnitId: "bridge-unit-test",
          sourceUnitKey: "hello.scene.001.line.001",
          occurrenceId: "occurrence-1",
          sourceHash: "source-hash",
          sourceLocale: "ja-JP",
          sourceText: "こんにちは、{player}。",
          textSurface: "dialogue",
          protectedSpans: [
            { kind: "placeholder", raw: "{player}", start: 6, end: 14, preserveMode: "exact" },
          ],
          patchRef: {
            assetId: "source.json",
            writeMode: "replace",
            sourceUnitKey: "hello.scene.001.line.001",
          },
        },
      ],
    },
  };
  return { ...project, ...overrides };
}

function jobInput(overrides: Partial<JobQueueInput> = {}): JobQueueInput {
  return {
    jobId: "job-rerun-drafts",
    projectId: "project-test",
    localeBranchId: "locale-en-us",
    jobType: jobTaskTypeValues.rerun,
    jobName: "rerun.affected-drafts",
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
            jobId: "job-rerun-drafts-duplicate-id",
            idempotency: {
              policy: jobIdempotencyPolicyValues.idempotent,
              key: "job:rerun:affected-drafts",
            },
          }),
        ],
      });

      expect(duplicate.outboxEvent.outboxEventId).toBe("outbox-rerun-requested");
      expect(duplicate.jobs[0]?.jobId).toBe("job-rerun-drafts");

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
      ).resolves.toEqual({ claimed: 1, published: 0, failed: 1 });

      const afterFailure = await queue.getOutboxEvent("outbox-agent-task");
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
      ).resolves.toEqual({ claimed: 1, published: 1, failed: 0 });

      const published = await queue.getOutboxEvent("outbox-agent-task");
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
      });

      const succeeded = await queue.getJob("job-deterministic-success");
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
        },
      );
      await expect(failingWorker.runAvailable({ limit: 1, retryAfterSeconds: 0 })).resolves.toEqual(
        {
          claimed: 1,
          succeeded: 0,
          failed: 1,
        },
      );

      const failed = await queue.getJob("job-triage-fails");
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

  it("bootstraps queue permissions and lookup indexes", async () => {
    const context = await migratedContext();
    try {
      const grant = await context.db
        .select({ permission: userPermissionGrants.permission })
        .from(userPermissionGrants)
        .where(eq(userPermissionGrants.permission, permissionValues.queueManage))
        .limit(1);
      expect(grant[0]?.permission).toBe(permissionValues.queueManage);

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

async function migratedContext() {
  const databaseUrl = requiredDatabaseUrl();
  await migrate(databaseUrl);
  return createDatabaseContext(databaseUrl);
}

async function seedProject(db: ItotoriDatabase): Promise<void> {
  const repo = new ItotoriProjectRepository(db);
  await repo.reset(localActor);
  await repo.importSourceBundle(localActor, projectFixture());
}

function requiredDatabaseUrl(): string {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for DB-backed repository tests");
  }
  return process.env.DATABASE_URL;
}
