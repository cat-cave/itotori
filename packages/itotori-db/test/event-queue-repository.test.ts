import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, permissionValues, type AuthorizationActor } from "../src/authorization.js";
import { type ItotoriDatabase } from "../src/connection.js";
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
import { isolatedMigratedContext } from "./db-test-context.js";

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
            { kind: "placeholder", raw: "{player}", start: 18, end: 26, preserveMode: "exact" },
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
            jobId: "job-rerun-drafts-changed-idempotency",
            idempotency: {
              policy: jobIdempotencyPolicyValues.idempotent,
              key: "job:rerun:affected-drafts:v2",
            },
          }),
          jobInput({
            jobId: "job-rerun-drafts-non-idempotent",
            jobName: "rerun.affected-drafts.non-idempotent",
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
      ).resolves.toEqual({ claimed: 1, published: 0, failed: 1 });

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
      ).resolves.toEqual({ claimed: 1, published: 1, failed: 0 });

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
          jobName: "rerun.draft-repair",
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
          jobName: "rerun.qa-replay",
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
          jobName: "rerun.export-regeneration",
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
          jobName: "rerun.runtime-validation",
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
        },
      );
      await expect(failingWorker.runAvailable({ limit: 1, retryAfterSeconds: 0 })).resolves.toEqual(
        {
          claimed: 1,
          succeeded: 0,
          failed: 1,
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

async function migratedContext() {
  return isolatedMigratedContext();
}

async function seedProject(db: ItotoriDatabase): Promise<void> {
  const repo = new ItotoriProjectRepository(db);
  await repo.reset(localActor);
  await repo.importSourceBundle(localActor, projectFixture());
}
