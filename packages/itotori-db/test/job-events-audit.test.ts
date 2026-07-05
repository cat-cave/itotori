import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
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
  jobEventTypeValues,
  jobIdempotencyPolicyValues,
  jobStatusValues,
  jobTaskTypeValues,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

/**
 * Walks the error chain looking for a Postgres error code (DatabaseError.code).
 * The append-only trigger raises via plpgsql `raise exception`, which surfaces
 * as SQLSTATE P0001 (raise_exception).
 */
function pgErrorCodeOf(error: unknown): string | undefined {
  let current: unknown = error;
  while (current !== undefined && current !== null) {
    if (typeof current === "object" && "code" in current) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string") {
        return code;
      }
    }
    if (typeof current === "object" && "cause" in current) {
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return undefined;
}

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

async function seedProject(db: ItotoriDatabase): Promise<void> {
  const repo = new ItotoriProjectRepository(db);
  await repo.reset(localActor);
  await repo.importSourceBundle(localActor, projectFixture());
}

describe.skipIf(!process.env.DATABASE_URL)("job lifecycle audit trail (itotori_job_events)", () => {
  it("appends an immutable event for every lifecycle transition (queued -> running -> succeeded)", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProject(context.db);
      const queue = new ItotoriEventQueueRepository(context.db);

      await queue.enqueueJob(localActor, jobInput());
      const claimed = await queue.claimJobs(localActor, "worker-a", { limit: 1 });
      expect(claimed).toHaveLength(1);
      await queue.completeJob(localActor, "job-rerun-drafts", "worker-a", { ok: true });

      const events = await queue.getJobEvents(localActor, "job-rerun-drafts");
      expect(events.map((e) => e.eventType)).toEqual([
        jobEventTypeValues.enqueued,
        jobEventTypeValues.claimed,
        jobEventTypeValues.succeeded,
      ]);

      expect(events[0]).toMatchObject({
        priorStatus: null,
        nextStatus: jobStatusValues.queued,
        attemptCount: 0,
        workerId: null,
      });
      expect(events[1]).toMatchObject({
        priorStatus: jobStatusValues.queued,
        nextStatus: jobStatusValues.running,
        attemptCount: 1,
        workerId: "worker-a",
      });
      expect(events[2]).toMatchObject({
        priorStatus: jobStatusValues.running,
        nextStatus: jobStatusValues.succeeded,
        attemptCount: 1,
        workerId: "worker-a",
      });
      // The trail is monotonically ordered and correlated back to the job.
      for (const event of events) {
        expect(event.jobId).toBe("job-rerun-drafts");
        expect(event.projectId).toBe("project-test");
        expect(event.recordedAt).toBeInstanceOf(Date);
      }
    } finally {
      await context.close();
    }
  });

  it("records failure detail across retry_scheduled and dead_lettered transitions", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProject(context.db);
      const queue = new ItotoriEventQueueRepository(context.db);

      // maxAttempts: 2 -> first failure schedules a retry, second dead-letters.
      await queue.enqueueJob(localActor, jobInput());
      await queue.claimJobs(localActor, "worker-a", { limit: 1 });
      await queue.failJob(localActor, "job-rerun-drafts", "worker-a", {
        error: new Error("provider timeout"),
        retryAfterSeconds: 0,
      });
      await queue.claimJobs(localActor, "worker-a", { limit: 1 });
      await queue.failJob(localActor, "job-rerun-drafts", "worker-a", {
        error: new Error("provider timeout again"),
        retryAfterSeconds: 0,
      });

      const events = await queue.getJobEvents(localActor, "job-rerun-drafts");
      expect(events.map((e) => e.eventType)).toEqual([
        jobEventTypeValues.enqueued,
        jobEventTypeValues.claimed,
        jobEventTypeValues.retryScheduled,
        jobEventTypeValues.claimed,
        jobEventTypeValues.deadLettered,
      ]);

      const retry = events[2];
      expect(retry).toMatchObject({ nextStatus: jobStatusValues.retryWaiting });
      expect(retry?.detail).toMatchObject({ lastError: "provider timeout", terminal: false });

      const deadLetter = events[4];
      expect(deadLetter).toMatchObject({ nextStatus: jobStatusValues.deadLetter });
      expect(deadLetter?.detail).toMatchObject({
        lastError: "provider timeout again",
        terminal: true,
      });
    } finally {
      await context.close();
    }
  });

  it("rejects an in-place rewrite of a recorded job_event (immutability)", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProject(context.db);
      const queue = new ItotoriEventQueueRepository(context.db);
      await queue.enqueueJob(localActor, jobInput());

      const events = await queue.getJobEvents(localActor, "job-rerun-drafts");
      expect(events).toHaveLength(1);
      const eventId = events[0]!.jobEventId;

      let captured: unknown;
      try {
        await context.pool.query(
          `update itotori_job_events set next_status = $1 where job_event_id = $2`,
          [jobStatusValues.succeeded, eventId],
        );
      } catch (error) {
        captured = error;
      }
      expect(pgErrorCodeOf(captured)).toBe("P0001");
      expect(String((captured as { message?: unknown })?.message)).toMatch(/append-only/);

      // The recorded event is unchanged.
      const after = await queue.getJobEvents(localActor, "job-rerun-drafts");
      expect(after[0]?.nextStatus).toBe(jobStatusValues.queued);
    } finally {
      await context.close();
    }
  });

  it("rejects an ad-hoc delete of a recorded job_event (immutability)", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProject(context.db);
      const queue = new ItotoriEventQueueRepository(context.db);
      await queue.enqueueJob(localActor, jobInput());
      const events = await queue.getJobEvents(localActor, "job-rerun-drafts");
      const eventId = events[0]!.jobEventId;

      let captured: unknown;
      try {
        await context.pool.query(`delete from itotori_job_events where job_event_id = $1`, [
          eventId,
        ]);
      } catch (error) {
        captured = error;
      }
      expect(pgErrorCodeOf(captured)).toBe("P0001");
      expect(String((captured as { message?: unknown })?.message)).toMatch(/append-only/);

      const after = await queue.getJobEvents(localActor, "job-rerun-drafts");
      expect(after).toHaveLength(1);
    } finally {
      await context.close();
    }
  });

  it("retention prunes terminal-job events past the window and keeps recent + non-terminal ones", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProject(context.db);
      const queue = new ItotoriEventQueueRepository(context.db);

      // Terminal job: enqueue -> claim -> complete (status = succeeded).
      await queue.enqueueJob(
        localActor,
        jobInput({ jobId: "job-terminal", idempotency: { policy: "idempotent", key: "k-term" } }),
      );
      await queue.claimJobs(localActor, "worker-a", { limit: 1 });
      await queue.completeJob(localActor, "job-terminal", "worker-a", {});

      // Non-terminal job: enqueue only (status = queued).
      await queue.enqueueJob(
        localActor,
        jobInput({ jobId: "job-open", idempotency: { policy: "idempotent", key: "k-open" } }),
      );

      const terminalBefore = await queue.getJobEvents(localActor, "job-terminal");
      expect(terminalBefore).toHaveLength(3);
      const openBefore = await queue.getJobEvents(localActor, "job-open");
      expect(openBefore).toHaveLength(1);

      // A generous window keeps everything: all events are recent.
      await expect(queue.pruneJobEvents(localActor, { olderThanDays: 3650 })).resolves.toBe(0);
      expect(await queue.getJobEvents(localActor, "job-terminal")).toHaveLength(3);

      // Window 0 prunes the TERMINAL job's now-past-window events, but the
      // OPEN (non-terminal) job's events are kept regardless of age.
      await expect(queue.pruneJobEvents(localActor, { olderThanDays: 0 })).resolves.toBe(3);
      expect(await queue.getJobEvents(localActor, "job-terminal")).toHaveLength(0);
      expect(await queue.getJobEvents(localActor, "job-open")).toHaveLength(1);

      // The prune flag is transaction-local: an ad-hoc delete outside the
      // sanctioned path is still rejected.
      const openEventId = openBefore[0]!.jobEventId;
      let captured: unknown;
      try {
        await context.pool.query(`delete from itotori_job_events where job_event_id = $1`, [
          openEventId,
        ]);
      } catch (error) {
        captured = error;
      }
      expect(pgErrorCodeOf(captured)).toBe("P0001");
    } finally {
      await context.close();
    }
  });
});
