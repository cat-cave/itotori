import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import {
  ItotoriDraftJobRepository,
  draftJobAttemptStatusValues,
  draftJobStatusValues,
} from "../src/repositories/draft-job-repository.js";
import {
  cancelledDraftJobFixture,
  draftJobFixtureInput,
  draftJobFixtureLocaleBranchId,
  draftJobFixtureProjectId,
  failedDraftJobFixture,
  provisionDraftJobFixtureProject,
  queuedDraftJobFixture,
  retryableDraftJobFixture,
  runningDraftJobFixture,
  succeededDraftJobFixture,
} from "./draft-job-fixtures.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };
const deniedActor: AuthorizationActor = { userId: "user-without-required-permission" };

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

describe.skipIf(!process.env.DATABASE_URL)("ItotoriDraftJobRepository", () => {
  it("createDraftJob persists a queued job carrying policy versions, style/glossary versions, and context refs", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const repo = new ItotoriDraftJobRepository(context.db);

      const job = await repo.createDraftJob(
        localActor,
        draftJobFixtureInput({
          protectedSpanRefs: [
            { bridgeUnitId: "unit-draft-1", spanIndex: 0, spanKind: "honorific" },
          ],
          contextRefs: [
            {
              contextArtifactId: "context-scene-001",
              category: "scene-summary",
              contentHash: "abc123",
            },
          ],
        }),
      );

      expect(job.status).toBe(draftJobStatusValues.queued);
      expect(job.projectId).toBe(draftJobFixtureProjectId);
      expect(job.localeBranchId).toBe(draftJobFixtureLocaleBranchId);
      expect(job.bridgeUnitIds).toEqual(["unit-draft-1", "unit-draft-2"]);
      expect(job.styleGuideVersion).toBe("style-guide-v1");
      expect(job.glossaryVersion).toBe("glossary-v1");
      expect(job.protectedSpanRefs).toEqual([
        { bridgeUnitId: "unit-draft-1", spanIndex: 0, spanKind: "honorific" },
      ]);
      expect(job.policyVersions.promptTemplateVersion).toBe("itotori-draft-v1");
      expect(job.contextRefs).toHaveLength(1);
      expect(job.failureReason).toBeNull();
    } finally {
      await context.close();
    }
  });

  it("recordAttempt inserts a running attempt and promotes the parent job to running", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const { job, attempts } = await runningDraftJobFixture(context.db, localActor);

      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.status).toBe(draftJobAttemptStatusValues.running);
      expect(attempts[0]!.attemptIndex).toBe(1);
      expect(attempts[0]!.providerRunId).toBe("provider-run-running");
      expect(job.status).toBe(draftJobStatusValues.running);
    } finally {
      await context.close();
    }
  });

  it("markAttemptSucceeded flips both attempt and parent draft job to succeeded", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const { job, attempts } = await succeededDraftJobFixture(context.db, localActor);
      expect(job.status).toBe(draftJobStatusValues.succeeded);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.status).toBe(draftJobAttemptStatusValues.succeeded);
      expect(attempts[0]!.providerRunId).toBe("provider-run-succeeded");
      expect(attempts[0]!.recordedProviderArtifactId).toBe("recorded-artifact-success");
      expect(attempts[0]!.endedAt).not.toBeNull();
    } finally {
      await context.close();
    }
  });

  it("markAttemptFailed records failure_reason and sets parent failed for non-retryable failures", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const { job, attempts } = await failedDraftJobFixture(context.db, localActor);

      expect(job.status).toBe(draftJobStatusValues.failed);
      expect(job.failureReason).toBe("non-retryable provider error");
      expect(attempts[0]!.status).toBe(draftJobAttemptStatusValues.failed);
      expect(attempts[0]!.failureReason).toBe("non-retryable provider error");
    } finally {
      await context.close();
    }
  });

  it("markAttemptFailed with retryable=true sets parent + attempt to retryable", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const { job, attempts } = await retryableDraftJobFixture(context.db, localActor);
      expect(job.status).toBe(draftJobStatusValues.retryable);
      expect(attempts[0]!.status).toBe(draftJobAttemptStatusValues.retryable);
    } finally {
      await context.close();
    }
  });

  it("cancelDraftJob cancels a running job and its active attempt", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const { job, attempts } = await cancelledDraftJobFixture(context.db, localActor);
      expect(job.status).toBe(draftJobStatusValues.cancelled);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.status).toBe(draftJobAttemptStatusValues.cancelled);
      expect(attempts[0]!.endedAt).not.toBeNull();
    } finally {
      await context.close();
    }
  });

  it("cancelDraftJob refuses to cancel a job that has already succeeded", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const { job } = await succeededDraftJobFixture(context.db, localActor);
      const repo = new ItotoriDraftJobRepository(context.db);
      await expect(repo.cancelDraftJob(localActor, job.draftJobId)).rejects.toThrow(
        /cannot cancel draft job .* in terminal status succeeded/,
      );
    } finally {
      await context.close();
    }
  });

  it("cancelDraftJob refuses to cancel a job that has already been cancelled", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const { job } = await cancelledDraftJobFixture(context.db, localActor);
      const repo = new ItotoriDraftJobRepository(context.db);
      await expect(repo.cancelDraftJob(localActor, job.draftJobId)).rejects.toThrow(
        /cannot cancel draft job .* in terminal status cancelled/,
      );
    } finally {
      await context.close();
    }
  });

  it("loadDraftJob returns null when the draft job does not exist", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const repo = new ItotoriDraftJobRepository(context.db);
      const result = await repo.loadDraftJob(localActor, "draft-job-does-not-exist");
      expect(result).toBeNull();
    } finally {
      await context.close();
    }
  });

  it("loadDraftJobsByProject filters by status and respects the limit", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);

      // Two queued jobs, one succeeded, one cancelled.
      await queuedDraftJobFixture(context.db, localActor);
      await queuedDraftJobFixture(context.db, localActor);
      await succeededDraftJobFixture(context.db, localActor);
      await cancelledDraftJobFixture(context.db, localActor);

      const repo = new ItotoriDraftJobRepository(context.db);
      const queued = await repo.loadDraftJobsByProject(localActor, draftJobFixtureProjectId, {
        statusFilter: draftJobStatusValues.queued,
      });
      expect(queued.length).toBe(2);
      for (const job of queued) {
        expect(job.status).toBe(draftJobStatusValues.queued);
      }

      const limited = await repo.loadDraftJobsByProject(localActor, draftJobFixtureProjectId, {
        limit: 2,
      });
      expect(limited.length).toBe(2);
    } finally {
      await context.close();
    }
  });

  it("loadDraftJobAttempts returns attempts ordered by attempt_index", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const repo = new ItotoriDraftJobRepository(context.db);
      const job = await repo.createDraftJob(localActor, draftJobFixtureInput());
      await repo.recordAttempt(localActor, job.draftJobId, {
        attemptIndex: 1,
        startedAt: new Date("2026-06-23T13:00:00Z"),
      });

      // After marking the first attempt failed-retryable, record a second attempt.
      const attemptsAfterFirst = await repo.loadDraftJobAttempts(localActor, job.draftJobId);
      expect(attemptsAfterFirst).toHaveLength(1);
      await repo.markAttemptFailed(
        localActor,
        attemptsAfterFirst[0]!.draftJobAttemptId,
        "transient",
        true,
        new Date("2026-06-23T13:00:30Z"),
      );

      await repo.recordAttempt(localActor, job.draftJobId, {
        attemptIndex: 2,
        startedAt: new Date("2026-06-23T13:01:00Z"),
      });

      const attempts = await repo.loadDraftJobAttempts(localActor, job.draftJobId);
      expect(attempts.map((attempt) => attempt.attemptIndex)).toEqual([1, 2]);
    } finally {
      await context.close();
    }
  });

  it("two attempts with the same attemptIndex for the same draftJobId throw a unique-constraint error", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const repo = new ItotoriDraftJobRepository(context.db);
      const job = await repo.createDraftJob(localActor, draftJobFixtureInput());

      await repo.recordAttempt(localActor, job.draftJobId, {
        attemptIndex: 1,
        startedAt: new Date("2026-06-23T13:00:00Z"),
      });
      let captured: unknown;
      try {
        await repo.recordAttempt(localActor, job.draftJobId, {
          attemptIndex: 1,
          startedAt: new Date("2026-06-23T13:00:01Z"),
        });
      } catch (error) {
        captured = error;
      }
      expect(pgErrorCodeOf(captured)).toBe("23505");
    } finally {
      await context.close();
    }
  });

  it("denies draftWrite paths when the actor lacks the draft.write permission", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const repo = new ItotoriDraftJobRepository(context.db);
      await expect(repo.createDraftJob(deniedActor, draftJobFixtureInput())).rejects.toMatchObject({
        name: "AuthorizationError",
        permission: "draft.write",
      });
      await expect(
        repo.recordAttempt(deniedActor, "draft-job-x", {
          attemptIndex: 1,
          startedAt: new Date(),
        }),
      ).rejects.toMatchObject({ name: "AuthorizationError", permission: "draft.write" });
      await expect(
        repo.markAttemptSucceeded(deniedActor, "draft-job-attempt-x", new Date()),
      ).rejects.toMatchObject({ name: "AuthorizationError", permission: "draft.write" });
      await expect(
        repo.markAttemptFailed(deniedActor, "draft-job-attempt-x", "boom", false, new Date()),
      ).rejects.toMatchObject({ name: "AuthorizationError", permission: "draft.write" });
      await expect(repo.cancelDraftJob(deniedActor, "draft-job-x")).rejects.toMatchObject({
        name: "AuthorizationError",
        permission: "draft.write",
      });
    } finally {
      await context.close();
    }
  });

  it("denies catalogRead paths when the actor lacks the catalog.read permission", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const repo = new ItotoriDraftJobRepository(context.db);
      await expect(repo.loadDraftJob(deniedActor, "draft-job-x")).rejects.toMatchObject({
        name: "AuthorizationError",
        permission: "catalog.read",
      });
      await expect(
        repo.loadDraftJobsByProject(deniedActor, draftJobFixtureProjectId),
      ).rejects.toMatchObject({ name: "AuthorizationError", permission: "catalog.read" });
      await expect(repo.loadDraftJobAttempts(deniedActor, "draft-job-x")).rejects.toMatchObject({
        name: "AuthorizationError",
        permission: "catalog.read",
      });
    } finally {
      await context.close();
    }
  });
});
