import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  asNonBlankTargetText,
  type SpeakerLabel,
  type WrittenUnitOutcome,
} from "@itotori/localization-bridge-schema";
import { AuthorizationError, localUserId, type AuthorizationActor } from "../src/authorization.js";
import {
  ItotoriLocalizationJournalRepository,
  type PersistLocalizationJournalAttemptInput,
} from "../src/repositories/localization-journal-repository.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };
const deniedActor: AuthorizationActor = { userId: "user-without-required-permission" };
const driverALease = { ownerId: "journal-driver-a", fenceToken: 1 } as const;

const scope = {
  projectId: "project-localization-journal",
  localeBranchId: "locale-branch-localization-journal",
  sourceRevisionId: "source-revision-localization-journal",
  targetLocale: "en-US",
} as const;

describe("ItotoriLocalizationJournalRepository", () => {
  it("atomically seeds ordered units, persists attempts before dispatch, and writes from an already-completed attempt", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      const seed = lifecycleSeedInput("journal-run-lifecycle");

      const run = await repository.seedRun(localActor, seed);
      expect(run).toMatchObject({
        runId: seed.runId,
        status: "running",
        frozenScope: seed.frozenScope,
        routingPolicy: seed.routingPolicy,
        costPolicy: seed.costPolicy,
        pausedBlocker: null,
      });
      // Retrying the launch write is exact/idempotent; it cannot duplicate or
      // reorder the frozen unit obligation set.
      await expect(repository.seedRun(localActor, seed)).resolves.toMatchObject({
        runId: seed.runId,
      });
      expect(await repository.loadRunUnits(localActor, seed.runId)).toMatchObject([
        {
          bridgeUnitId: "raw-bridge-unit-lifecycle-1",
          sourceUnitKey: "scene.lifecycle.1",
          unitOrdinal: 0,
          state: "pending",
          nextAction: { kind: "drive_unit", stage: "translation" },
        },
        {
          bridgeUnitId: "raw-bridge-unit-lifecycle-2",
          sourceUnitKey: "scene.lifecycle.2",
          unitOrdinal: 1,
          state: "pending",
          nextAction: { kind: "drive_unit", stage: "translation" },
        },
      ]);

      const begin = lifecycleBeginAttempt(seed.runId, "raw-bridge-unit-lifecycle-1");
      const dispatching = await repository.beginAttempt(localActor, begin);
      expect(dispatching).toMatchObject({
        attemptId: begin.attemptId,
        lifecycleState: "dispatching",
        requestedModelId: "model-lifecycle-requested",
        requestedProviderId: "provider-lifecycle-requested",
        providerRunId: begin.attemptId,
        modelId: null,
        providerId: null,
        costUsd: null,
        zdr: true,
        validationResult: null,
        completedAt: null,
      });
      await expect(repository.beginAttempt(localActor, begin)).resolves.toMatchObject({
        lifecycleState: "dispatching",
      });
      expect(await repository.loadAttemptsForRun(localActor, seed.runId)).toHaveLength(1);
      // Jobs/cost read models describe completed physical calls only; an
      // honest in-flight row is visible in the attempt journal, not fabricated
      // into a zero-cost served result.
      expect(
        await repository.loadJobsRunTable(localActor, { projectId: scope.projectId }),
      ).toMatchObject({ pagination: { total: 0 }, rows: [] });

      const completion = lifecycleCompleteAttempt(
        begin,
        "model-lifecycle-served",
        "provider-lifecycle-served",
      );
      const completed = await repository.completeAttempt(localActor, completion);
      expect(completed).toMatchObject({
        lifecycleState: "completed",
        modelId: "model-lifecycle-served",
        providerId: "provider-lifecycle-served",
        costUsd: "0.00000000000000000007",
        validationResult: "accepted",
        retryDecision: "write",
      });
      await expect(repository.completeAttempt(localActor, completion)).resolves.toMatchObject({
        lifecycleState: "completed",
      });
      await expect(
        repository.completeAttempt(localActor, { ...completion, costUsd: "0.5" }),
      ).rejects.toMatchObject({ code: "attempt_conflict" });

      const timeoutBegin = lifecycleBeginAttempt(seed.runId, "raw-bridge-unit-lifecycle-2");
      await repository.beginAttempt(localActor, timeoutBegin);
      const timeoutCompletion = {
        ...lifecycleCompleteAttempt(timeoutBegin, "unused-model", "unused-provider"),
        modelId: null,
        providerId: null,
        costUsd: null,
        costKind: undefined,
        usageResponseJson: undefined,
        tokensIn: null,
        tokensOut: null,
        tokenCountSource: undefined,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        cacheDiscountMicrosUsd: null,
        fallbackUsed: undefined,
        fallbackPlan: undefined,
        finishState: "timeout",
        validationResult: "provider_failed" as const,
        failureClass: "timeout",
        retryDecision: "advance" as const,
      };
      await expect(
        repository.completeAttempt(localActor, timeoutCompletion),
      ).resolves.toMatchObject({
        lifecycleState: "completed",
        modelId: null,
        providerId: null,
        costUsd: null,
        validationResult: "provider_failed",
      });
      // Providerless timeout evidence is durable, but is not projected as a
      // fake served/cost row in the legacy jobs read model.
      expect(
        await repository.loadJobsRunTable(localActor, { projectId: scope.projectId }),
      ).toMatchObject({ pagination: { total: 1 }, rows: [{ attemptId: begin.attemptId }] });

      const outcome: WrittenUnitOutcome = {
        id: "written-outcome-lifecycle",
        status: "written",
        unitId: begin.bridgeUnitId,
        targetLocale: scope.targetLocale,
        selectedCandidateId: "candidate-lifecycle",
        candidates: [
          {
            id: "candidate-lifecycle",
            outcomeId: "written-outcome-lifecycle",
            body: asNonBlankTargetText("Welcome back."),
            producedBy: {
              modelId: completion.modelId,
              providerId: completion.providerId,
            },
            attemptId: begin.attemptId,
            kind: "primary",
          },
        ],
        findings: [],
        qualityFlags: [],
        provenance: { origin: "invocation-supervisor" },
        writtenAt: "2026-07-12T12:00:02.000Z",
      };
      await repository.persistUnit(localActor, {
        runId: seed.runId,
        bridgeUnitId: begin.bridgeUnitId,
        sourceUnitKey: "scene.lifecycle.1",
        outcome,
        // The supervisor completed this attempt before materializing the
        // canonical outcome; it need not replay terminal attempt facts here.
        attempts: [],
        contextPacket: null,
        contextRefs: [],
        speakerLabels: [],
        qaDetails: {},
        lease: driverALease,
      });
      expect(await repository.loadRunUnits(localActor, seed.runId)).toMatchObject([
        { bridgeUnitId: begin.bridgeUnitId, state: "written", nextAction: null },
        { bridgeUnitId: "raw-bridge-unit-lifecycle-2", state: "pending" },
      ]);
    } finally {
      await context.close();
    }
  });

  it("rejects a frozen-run re-seed with an extra unit without persisting it", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      const seed = lifecycleSeedInput("journal-run-frozen-reseed-extra-unit");
      await repository.seedRun(localActor, seed);

      const extraUnit = {
        bridgeUnitId: "raw-bridge-unit-lifecycle-extra",
        sourceUnitKey: "scene.lifecycle.extra",
        nextAction: { kind: "drive_unit", stage: "translation" },
      };
      await expect(
        repository.seedRun(localActor, { ...seed, units: [...seed.units, extraUnit] }),
      ).rejects.toMatchObject({ code: "run_seed_conflict" });

      expect(
        (await repository.loadRunUnits(localActor, seed.runId)).map((unit) => unit.bridgeUnitId),
      ).toEqual(seed.units.map((unit) => unit.bridgeUnitId));
    } finally {
      await context.close();
    }
  });

  it("derives lease expiry from PostgreSQL despite executor host-clock skew", async () => {
    const context = await isolatedMigratedContext();
    const hostClock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2099-01-01T00:00:00Z"));
    try {
      await seedScope(context);
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      const seed = lifecycleSeedInput("journal-run-db-clock-lease");
      await repository.seedRun(localActor, seed);
      await repository.renewRunLease(localActor, seed.runId, driverALease);

      const leaseWindow = await context.db.execute(sql`
        select extract(epoch from (lease_expires_at - now())) as seconds_remaining
        from itotori_localization_journal_runs
        where run_id = ${seed.runId}
      `);
      const secondsRemaining = Number(
        (leaseWindow.rows[0] as { seconds_remaining: string }).seconds_remaining,
      );
      expect(secondsRemaining).toBeGreaterThan(110);
      expect(secondsRemaining).toBeLessThanOrEqual(121);
    } finally {
      hostClock.mockRestore();
      await context.close();
    }
  });

  it("guards operational pause/resume without changing pending unit work", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      const seed = lifecycleSeedInput("journal-run-pause-resume");
      await repository.seedRun(localActor, seed);
      const blocker = {
        kind: "provider_outage" as const,
        detail: "All configured routes returned retryable transport failures.",
        evidence: "attempts=route-a:2,route-b:2",
        raisedAt: "2026-07-12T12:05:00.000Z",
        operatorAction: "Wait for a provider route to recover, then resume.",
      };

      const paused = await repository.pauseRun(localActor, seed.runId, blocker, driverALease);
      expect(paused).toMatchObject({ status: "paused", pausedBlocker: blocker });
      await expect(
        repository.beginAttempt(
          localActor,
          lifecycleBeginAttempt(seed.runId, "raw-bridge-unit-lifecycle-1"),
        ),
      ).rejects.toMatchObject({ code: "invalid_run_transition" });
      await expect(
        repository.pauseRun(
          localActor,
          seed.runId,
          {
            ...blocker,
            detail: "A concurrent worker observed the same outage later.",
            evidence: "attempts=route-c:2",
          },
          driverALease,
        ),
      ).resolves.toMatchObject({
        status: "paused",
        // First-writer-wins: concurrent supervisors converge without
        // replacing the original operator evidence.
        pausedBlocker: blocker,
      });

      await repository.releaseRunLease(localActor, seed.runId, driverALease);
      const resumed = await repository.resumeRun(localActor, seed.runId, {
        ownerId: "journal-driver-b",
      });
      expect(resumed).toMatchObject({
        status: "running",
        pausedBlocker: null,
        leaseOwnerId: "journal-driver-b",
        fenceToken: 2,
      });
      const driverBLease = { ownerId: "journal-driver-b", fenceToken: resumed.fenceToken };
      const interrupted = lifecycleBeginAttempt(
        seed.runId,
        "raw-bridge-unit-lifecycle-1",
        driverBLease,
      );
      await repository.beginAttempt(localActor, interrupted);
      // A live running lease is never a crash-recovery signal. A second driver
      // cannot reconcile this still-live provider dispatch or take its unit.
      await expect(
        repository.resumeRun(localActor, seed.runId, { ownerId: "journal-driver-c" }),
      ).rejects.toMatchObject({ code: "run_lease_conflict" });
      expect(await repository.loadAttemptsForRun(localActor, seed.runId)).toMatchObject([
        {
          attemptId: interrupted.attemptId,
          lifecycleState: "dispatching",
          fenceToken: 2,
          completedAt: null,
        },
      ]);
      expect(await repository.loadRunUnits(localActor, seed.runId)).toMatchObject([
        {
          state: "claimed",
          claimOwnerId: "journal-driver-b",
          claimFenceToken: 2,
          nextAction: { kind: "drive_unit", stage: "translation" },
        },
        { state: "pending", nextAction: { kind: "drive_unit", stage: "translation" } },
      ]);

      await expect(
        repository.seedRun(localActor, {
          ...seed,
          units: seed.units.slice(0, 1),
        }),
      ).rejects.toMatchObject({ code: "run_seed_conflict" });
    } finally {
      await context.close();
    }
  });

  it("atomically claims a pending unit once and requires completion before the next attempt", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      const seed = lifecycleSeedInput("journal-run-atomic-unit-claim");
      await expect(
        repository.seedRun(localActor, {
          ...seed,
          runId: `${seed.runId}-unsafe-short-lease`,
          lease: { ownerId: driverALease.ownerId, leaseSeconds: 30 },
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      await repository.seedRun(localActor, seed);
      const first = lifecycleBeginAttempt(seed.runId, "raw-bridge-unit-lifecycle-1");
      const second = {
        ...first,
        attemptId: `${first.attemptId}-racer`,
        logicalCallId: `${first.logicalCallId}-racer`,
        artifactRef: `${first.artifactRef}-racer`,
      };

      const raced = await Promise.allSettled([
        repository.beginAttempt(localActor, first),
        repository.beginAttempt(localActor, second),
      ]);
      expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(raced.filter((result) => result.status === "rejected")).toEqual([
        expect.objectContaining({ reason: expect.objectContaining({ code: "unit_not_pending" }) }),
      ]);

      const winner = raced.find((result) => result.status === "fulfilled");
      if (winner?.status !== "fulfilled") throw new Error("claim race had no winner");
      const winningBegin = winner.value.attemptId === first.attemptId ? first : second;
      await repository.completeAttempt(
        localActor,
        lifecycleCompleteAttempt(
          winningBegin,
          "model-lifecycle-served",
          "provider-lifecycle-served",
        ),
      );
      expect(await repository.loadRunUnits(localActor, seed.runId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            bridgeUnitId: first.bridgeUnitId,
            state: "pending",
            claimOwnerId: null,
            claimFenceToken: null,
          }),
        ]),
      );

      await expect(
        repository.beginAttempt(localActor, {
          ...second,
          attemptId: `${second.attemptId}-after-release`,
          logicalCallId: `${second.logicalCallId}-after-release`,
          artifactRef: `${second.artifactRef}-after-release`,
          attemptIndex: 2,
        }),
      ).resolves.toMatchObject({ lifecycleState: "dispatching", fenceToken: 1 });
    } finally {
      await context.close();
    }
  });

  it("rejects a live second resumer and fences stale writes after an expired-lease takeover", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      const seed = lifecycleSeedInput("journal-run-resume-fence");
      await repository.seedRun(localActor, seed);
      const oldBegin = lifecycleBeginAttempt(seed.runId, "raw-bridge-unit-lifecycle-1");
      await repository.beginAttempt(localActor, oldBegin);

      await expect(
        repository.resumeRun(localActor, seed.runId, { ownerId: "journal-driver-b" }),
      ).rejects.toMatchObject({ code: "run_lease_conflict" });
      expect(await repository.loadAttemptsForRun(localActor, seed.runId)).toEqual([
        expect.objectContaining({
          attemptId: oldBegin.attemptId,
          lifecycleState: "dispatching",
          fenceToken: 1,
        }),
      ]);

      await context.db.execute(sql`
        update itotori_localization_journal_runs
        set lease_expires_at = now() - interval '1 second'
        where run_id = ${seed.runId}
      `);
      const takeover = await repository.resumeRun(localActor, seed.runId, {
        ownerId: "journal-driver-b",
      });
      expect(takeover).toMatchObject({
        status: "running",
        leaseOwnerId: "journal-driver-b",
        fenceToken: 2,
      });
      expect(await repository.loadAttemptsForRun(localActor, seed.runId)).toEqual([
        expect.objectContaining({
          attemptId: oldBegin.attemptId,
          lifecycleState: "completed",
          finishState: "interrupted",
          failureClass: "interrupted",
          fenceToken: 1,
        }),
      ]);

      await expect(
        repository.completeAttempt(
          localActor,
          lifecycleCompleteAttempt(oldBegin, "model-lifecycle-served", "provider-lifecycle-served"),
        ),
      ).rejects.toMatchObject({ code: "run_lease_lost" });
      await expect(
        repository.persistUnit(localActor, {
          runId: seed.runId,
          bridgeUnitId: oldBegin.bridgeUnitId,
          outcome: outcomeFixture(oldBegin.bridgeUnitId, "stale-owner"),
          attempts: [],
          contextPacket: null,
          contextRefs: [],
          speakerLabels: [],
          qaDetails: {
            "finding-tone-1": {
              recommendation: "Reject the stale write.",
              agentRationale: "A newer fence owns the run.",
              evidenceRefs: ["fence-2"],
            },
          },
          lease: oldBegin.lease,
        }),
      ).rejects.toMatchObject({ code: "run_lease_lost" });

      await expect(
        repository.beginAttempt(localActor, {
          ...lifecycleBeginAttempt(seed.runId, "raw-bridge-unit-lifecycle-1", {
            ownerId: "journal-driver-b",
            fenceToken: takeover.fenceToken,
          }),
          attemptId: "provider-run-lifecycle-fence-2-replacement",
          logicalCallId: "logical-lifecycle-fence-2-replacement",
          artifactRef: "provider-run:provider-run-lifecycle-fence-2-replacement",
          attemptIndex: 2,
        }),
      ).resolves.toMatchObject({ lifecycleState: "dispatching", fenceToken: 2 });
    } finally {
      await context.close();
    }
  });

  it("keeps a paused lease fenced until its in-flight attempt drains", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      const seed = lifecycleSeedInput("journal-run-paused-drain-fence");
      await repository.seedRun(localActor, seed);
      const begin = lifecycleBeginAttempt(seed.runId, "raw-bridge-unit-lifecycle-1");
      await repository.beginAttempt(localActor, begin);
      const blocker = {
        kind: "provider_outage" as const,
        detail: "A sibling unit exhausted its provider routes.",
        evidence: "failure-injection:paused-with-live-attempt",
        raisedAt: "2026-07-12T12:00:01.500Z",
        operatorAction: "Resume only after the original driver drains.",
      };
      await repository.pauseRun(localActor, seed.runId, blocker, driverALease);

      await expect(
        repository.resumeRun(localActor, seed.runId, { ownerId: "journal-driver-b" }),
      ).rejects.toMatchObject({ code: "run_lease_conflict" });
      await expect(
        repository.releaseRunLease(localActor, seed.runId, driverALease),
      ).rejects.toMatchObject({ code: "run_lease_conflict" });
      await expect(
        repository.completeAttempt(
          localActor,
          lifecycleCompleteAttempt(begin, "model-lifecycle-served", "provider-lifecycle-served"),
        ),
      ).resolves.toMatchObject({ lifecycleState: "completed", fenceToken: 1 });
      await repository.releaseRunLease(localActor, seed.runId, driverALease);
      const resumed = await repository.resumeRun(localActor, seed.runId, {
        ownerId: "journal-driver-b",
      });
      expect(resumed).toMatchObject({ status: "running", fenceToken: 2 });
      const crossFenceOutcome: WrittenUnitOutcome = {
        id: "written-outcome-cross-fence",
        status: "written",
        unitId: begin.bridgeUnitId,
        targetLocale: scope.targetLocale,
        selectedCandidateId: "candidate-cross-fence",
        candidates: [
          {
            id: "candidate-cross-fence",
            outcomeId: "written-outcome-cross-fence",
            body: asNonBlankTargetText("A stale-fence candidate."),
            producedBy: {
              modelId: "model-lifecycle-served",
              providerId: "provider-lifecycle-served",
            },
            attemptId: begin.attemptId,
            kind: "primary",
          },
        ],
        findings: [],
        qualityFlags: [],
        provenance: { origin: "cross-fence-failure-injection" },
        writtenAt: "2026-07-12T12:00:03.000Z",
      };
      await expect(
        repository.persistUnit(localActor, {
          runId: seed.runId,
          bridgeUnitId: begin.bridgeUnitId,
          sourceUnitKey: "scene.lifecycle.1",
          outcome: crossFenceOutcome,
          attempts: [],
          contextPacket: null,
          contextRefs: [],
          speakerLabels: [],
          qaDetails: {},
          lease: { ownerId: "journal-driver-b", fenceToken: resumed.fenceToken },
        }),
      ).rejects.toMatchObject({ code: "attempt_conflict" });
      await expect(
        repository.resumeRun(localActor, seed.runId, { ownerId: "journal-driver-b" }),
      ).rejects.toMatchObject({ code: "run_lease_conflict" });
    } finally {
      await context.close();
    }
  });

  it("rejects attempts and outcomes outside a frozen planned-unit set", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      const seed = lifecycleSeedInput("journal-run-frozen-unit-rejection");
      await repository.seedRun(localActor, seed);
      const unplannedUnitId = "raw-bridge-unit-not-in-frozen-scope";
      const attempts = attemptsFixture(seed.runId, unplannedUnitId, "unplanned");

      await expect(
        repository.persistAttempts(localActor, {
          runId: seed.runId,
          bridgeUnitId: seed.units[0]!.bridgeUnitId,
          attempts: attemptsFixture(seed.runId, seed.units[0]!.bridgeUnitId, "planned-unfenced"),
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      const plannedUnitId = seed.units[0]!.bridgeUnitId;
      const fabricatedPlannedAttempts = attemptsFixture(
        seed.runId,
        plannedUnitId,
        "planned-persist-unit",
      );
      await expect(
        repository.persistUnit(localActor, {
          runId: seed.runId,
          bridgeUnitId: plannedUnitId,
          outcome: outcomeFixture(plannedUnitId, "planned-persist-unit"),
          attempts: fabricatedPlannedAttempts,
          contextPacket: null,
          contextRefs: [],
          speakerLabels: [],
          qaDetails: {
            "finding-tone-1": {
              recommendation: "Use the fenced lifecycle.",
              agentRationale: "Fabricated terminal attempts must not bypass begin/complete.",
              evidenceRefs: ["failure-injection:fence-0-attempt"],
            },
          },
          lease: driverALease,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });

      await expect(
        repository.persistAttempts(localActor, {
          runId: seed.runId,
          bridgeUnitId: unplannedUnitId,
          attempts,
        }),
      ).rejects.toMatchObject({ code: "unit_not_seeded" });
      await expect(
        repository.persistUnit(localActor, {
          runId: seed.runId,
          bridgeUnitId: unplannedUnitId,
          outcome: outcomeFixture(unplannedUnitId, "unplanned"),
          attempts,
          contextPacket: null,
          contextRefs: [],
          speakerLabels: [],
          qaDetails: {
            "finding-tone-1": {
              recommendation: "Keep the frozen run immutable.",
              agentRationale: "Failure injection targets an unplanned unit.",
              evidenceRefs: ["frozen-scope"],
            },
          },
          lease: driverALease,
        }),
      ).rejects.toMatchObject({ code: "unit_not_seeded" });
      expect(await repository.loadRunUnits(localActor, seed.runId)).toHaveLength(seed.units.length);
    } finally {
      await context.close();
    }
  });

  it("persists N physical attempts and a lossless written-outcome provenance projection", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      const run = await repository.createRun(localActor, {
        runId: "journal-run-roundtrip",
        ...scope,
        createdAt: "2026-07-11T10:00:00.000Z",
      });
      expect(run).toMatchObject({ runId: "journal-run-roundtrip", ...scope });

      const attempts = attemptsFixture(run.runId, "raw-bridge-unit-1");
      // Failure-safe persistence happens before the terminal outcome. Repeating
      // the exact batch is idempotent rather than duplicating provider calls.
      expect(
        await repository.persistAttempts(localActor, {
          runId: run.runId,
          bridgeUnitId: "raw-bridge-unit-1",
          attempts,
        }),
      ).toHaveLength(3);

      const saved = await repository.persistUnit(localActor, {
        runId: run.runId,
        bridgeUnitId: "raw-bridge-unit-1",
        sourceUnitKey: "scene.001.line.001",
        outcome: outcomeFixture(),
        attempts,
        contextPacket: {
          structuredContext: { scene: "roof", relationship: "friends" },
          artifactRefs: ["scene:roof:v3"],
        },
        contextRefs: [
          {
            refKind: "context-artifact",
            refId: "scene:roof",
            versionRef: "scene:roof:v3",
            details: { category: "scene-summary" },
          },
          { refKind: "context-version", refId: "character:aya", versionRef: "aya:v7" },
        ],
        speakerLabels: [speakerLabelFixture("raw-bridge-unit-1")],
        qaDetails: {
          "finding-tone-1": {
            recommendation: "Use the established formal register.",
            agentRationale: "Aya speaks formally in the resolved scene context.",
            evidenceRefs: ["scene:roof:v3", "style:formal"],
            sourceSpan: { start: 0, end: 3 },
            draftSpan: { start: 0, end: 5 },
          },
        },
      });

      expect(saved.outcome.selectedCandidateId).toBe("candidate-repair");
      expect(saved.contextRefs).toHaveLength(2);
      expect(saved.speakerLabels).toEqual([speakerLabelFixture("raw-bridge-unit-1")]);

      const loadedAttempts = await repository.loadAttemptsForRun(localActor, run.runId);
      expect(loadedAttempts).toHaveLength(3);
      // This is deliberately beyond the old integer-micros precision. No
      // Number/toFixed/micros conversion occurs on either write or read.
      expect(
        loadedAttempts.find((attempt) => attempt.attemptId === "provider-run-context")?.costUsd,
      ).toBe("0.00000000000000000002");
      expect(loadedAttempts.map((attempt) => attempt.attemptId)).toEqual(
        expect.arrayContaining([
          "provider-run-context",
          "provider-run-primary",
          "provider-run-repair",
        ]),
      );
      expect(
        loadedAttempts.find((attempt) => attempt.attemptId === "provider-run-primary"),
      ).toMatchObject({ validationResult: "schema_invalid", retryDecision: "retry" });

      const loaded = await repository.loadRunOutcomes(localActor, run.runId);
      expect(loaded).toHaveLength(1);
      const outcome = loaded[0]!;
      expect(outcome.bridgeUnitId).toBe("raw-bridge-unit-1");
      expect(outcome.sourceUnitKey).toBe("scene.001.line.001");
      expect(outcome.outcome.candidates).toEqual(outcomeFixture().candidates);
      expect(outcome.outcome.findings).toEqual(outcomeFixture().findings);
      expect(outcome.outcome.qualityFlags).toEqual(["qa_unresolved", "repair_used"]);
      expect(outcome.outcome.provenance).toEqual({ origin: "agentic-loop", selected: "repair" });
      expect(outcome.contextPacket).toEqual({
        structuredContext: { scene: "roof", relationship: "friends" },
        artifactRefs: ["scene:roof:v3"],
      });
      expect(outcome.contextRefs).toEqual([
        {
          refKind: "context-artifact",
          refId: "scene:roof",
          versionRef: "scene:roof:v3",
          details: { category: "scene-summary" },
        },
        {
          refKind: "context-version",
          refId: "character:aya",
          versionRef: "aya:v7",
          details: null,
        },
      ]);
      expect(outcome.speakerLabels).toEqual([speakerLabelFixture("raw-bridge-unit-1")]);
      expect(outcome.qaDetails).toEqual({
        "finding-tone-1": {
          recommendation: "Use the established formal register.",
          agentRationale: "Aya speaks formally in the resolved scene context.",
          evidenceRefs: ["scene:roof:v3", "style:formal"],
          sourceSpan: { start: 0, end: 3 },
          draftSpan: { start: 0, end: 5 },
        },
      });

      // Candidate attempt ids are real provider-run ids and resolve through
      // the actual FK-backed physical attempts, not a legacy attempt table.
      expect(outcome.outcome.candidates.map((candidate) => candidate.attemptId)).toEqual([
        "provider-run-primary",
        "provider-run-repair",
      ]);
    } finally {
      await context.close();
    }
  });

  it("allows canonical outcome/candidate ids to recur in a later run without overwriting history", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      const first = await repository.createRun(localActor, { runId: "journal-run-one", ...scope });
      const second = await repository.createRun(localActor, { runId: "journal-run-two", ...scope });

      await repository.persistUnit(localActor, unitInput(first.runId, "raw-bridge-unit-1", "one"));
      await repository.persistUnit(localActor, unitInput(second.runId, "raw-bridge-unit-1", "two"));

      const [firstOutcome] = await repository.loadRunOutcomes(localActor, first.runId);
      const [secondOutcome] = await repository.loadRunOutcomes(localActor, second.runId);
      expect(firstOutcome?.outcome.id).toBe(secondOutcome?.outcome.id);
      expect(firstOutcome?.outcome.candidates.map((candidate) => candidate.id)).toEqual(
        secondOutcome?.outcome.candidates.map((candidate) => candidate.id),
      );
      expect(firstOutcome?.journalOutcomeId).not.toBe(secondOutcome?.journalOutcomeId);
      expect(await repository.loadAttemptsForRun(localActor, first.runId)).toHaveLength(3);
      expect(await repository.loadAttemptsForRun(localActor, second.runId)).toHaveLength(3);
    } finally {
      await context.close();
    }
  });

  it("keeps provider/parser failures durable when no written outcome exists and rejects candidate provenance gaps", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      const run = await repository.createRun(localActor, {
        runId: "journal-run-failure",
        ...scope,
      });
      const failureAttempt: PersistLocalizationJournalAttemptInput = {
        ...attemptsFixture(run.runId, "raw-bridge-unit-failure")[0]!,
        attemptId: "provider-run-parser-failure",
        providerRunId: "provider-run-parser-failure",
        logicalCallId: "parser-failure-logical-call",
        validationResult: "semantic_invalid",
        failureClass: "ParserFailure",
        retryDecision: "pause",
        errorClasses: ["ParserFailure"],
      };

      await repository.persistAttempts(localActor, {
        runId: run.runId,
        bridgeUnitId: "raw-bridge-unit-failure",
        attempts: [failureAttempt],
      });
      await repository.persistAttempts(localActor, {
        runId: run.runId,
        bridgeUnitId: "raw-bridge-unit-failure",
        attempts: [failureAttempt],
      });
      expect(await repository.loadAttemptsForRun(localActor, run.runId)).toHaveLength(1);
      expect(await repository.loadRunOutcomes(localActor, run.runId)).toEqual([]);

      const brokenOutcome = outcomeFixture("raw-bridge-unit-failure");
      brokenOutcome.candidates[0] = {
        ...brokenOutcome.candidates[0]!,
        attemptId: "provider-run-not-supplied",
      };
      await expect(
        repository.persistUnit(localActor, {
          runId: run.runId,
          bridgeUnitId: "raw-bridge-unit-failure",
          outcome: brokenOutcome,
          attempts: [failureAttempt],
          contextPacket: { preserved: true },
          contextRefs: [],
          speakerLabels: [],
          qaDetails: {
            "finding-tone-1": {
              recommendation: "Use the established formal register.",
              agentRationale: "QA evidence remains durable.",
              evidenceRefs: ["style:formal"],
            },
          },
        }),
      ).rejects.toMatchObject({
        name: "LocalizationJournalRepositoryError",
        code: "candidate_attempt_missing",
      });
    } finally {
      await context.close();
    }
  });

  it("lists journal runs chronologically and resolves the latest run for a branch", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      await repository.createRun(localActor, {
        runId: "journal-run-history-first",
        ...scope,
        createdAt: "2026-07-11T10:00:00.000Z",
      });
      await repository.createRun(localActor, {
        runId: "journal-run-history-second",
        ...scope,
        createdAt: "2026-07-11T10:01:00.000Z",
      });

      const history = await repository.loadRunsForBranch(localActor, scope.localeBranchId);
      expect(history.map((run) => run.runId)).toEqual([
        "journal-run-history-first",
        "journal-run-history-second",
      ]);
      expect(
        await repository.loadLatestRunForBranch(localActor, scope.localeBranchId),
      ).toMatchObject({
        runId: "journal-run-history-second",
      });
      await expect(
        repository.loadRunsForBranch(deniedActor, scope.localeBranchId),
      ).rejects.toMatchObject(new AuthorizationError(deniedActor, "catalog.read"));
    } finally {
      await context.close();
    }
  });

  it("rejects a selected candidate that does not belong to its written outcome at the SQL boundary", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      const run = await repository.createRun(localActor, {
        runId: "journal-run-dangling-selected-candidate",
        ...scope,
      });

      // This deliberately bypasses the canonical TypeScript assertion. The
      // migration-level composite FK must reject corruption even if a future
      // writer bypasses the repository and names a candidate that does not
      // exist for this outcome.
      await expect(
        context.db.execute(sql`
          insert into itotori_written_unit_outcomes (
            journal_outcome_id, outcome_id, run_id, bridge_unit_id,
            target_locale, selected_candidate_id, written_at
          ) values (
            'journal-outcome-dangling-selected-candidate',
            'outcome-dangling-selected-candidate',
            ${run.runId},
            'raw-bridge-unit-dangling-selected-candidate',
            ${scope.targetLocale},
            'candidate-that-does-not-exist',
            '2026-07-11T10:00:00.000Z'::timestamptz
          )
        `),
      ).rejects.toThrow(/selected_candidate/i);
    } finally {
      await context.close();
    }
  });

  it("enforces the draft.write/catalog.read authorization split", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      await expect(
        repository.createRun(deniedActor, { runId: "denied", ...scope }),
      ).rejects.toMatchObject(new AuthorizationError(deniedActor, "draft.write"));

      const run = await repository.createRun(localActor, { runId: "journal-run-auth", ...scope });
      const attempts = attemptsFixture(run.runId, "raw-bridge-unit-auth");
      await expect(
        repository.persistAttempts(deniedActor, {
          runId: run.runId,
          bridgeUnitId: "raw-bridge-unit-auth",
          attempts,
        }),
      ).rejects.toMatchObject(new AuthorizationError(deniedActor, "draft.write"));
      await expect(repository.loadRun(deniedActor, run.runId)).rejects.toMatchObject(
        new AuthorizationError(deniedActor, "catalog.read"),
      );
      await expect(
        repository.loadRunsForBranch(deniedActor, scope.localeBranchId),
      ).rejects.toMatchObject(new AuthorizationError(deniedActor, "catalog.read"));
      await expect(
        repository.loadLatestRunForBranch(deniedActor, scope.localeBranchId),
      ).rejects.toMatchObject(new AuthorizationError(deniedActor, "catalog.read"));
      await expect(repository.loadRunOutcomes(deniedActor, run.runId)).rejects.toMatchObject(
        new AuthorizationError(deniedActor, "catalog.read"),
      );
      await expect(repository.loadAttemptsForRun(deniedActor, run.runId)).rejects.toMatchObject(
        new AuthorizationError(deniedActor, "catalog.read"),
      );
    } finally {
      await context.close();
    }
  });
});

function lifecycleSeedInput(runId: string) {
  return {
    runId,
    ...scope,
    frozenScope: {
      kind: "explicit_units",
      unitIds: ["raw-bridge-unit-lifecycle-1", "raw-bridge-unit-lifecycle-2"],
    },
    routingPolicy: { routes: ["model-lifecycle-requested/provider-lifecycle-requested"] },
    costPolicy: { kind: "simple_cap_seam", capUsd: "1.00" },
    units: [
      {
        bridgeUnitId: "raw-bridge-unit-lifecycle-1",
        sourceUnitKey: "scene.lifecycle.1",
        nextAction: { kind: "drive_unit", stage: "translation" },
      },
      {
        bridgeUnitId: "raw-bridge-unit-lifecycle-2",
        sourceUnitKey: "scene.lifecycle.2",
        nextAction: { kind: "drive_unit", stage: "translation" },
      },
    ],
    lease: { ownerId: driverALease.ownerId },
    createdAt: "2026-07-12T12:00:00.000Z",
  };
}

function lifecycleBeginAttempt(
  runId: string,
  bridgeUnitId: string,
  lease: { ownerId: string; fenceToken: number } = driverALease,
) {
  return {
    attemptId: `provider-run-lifecycle-${bridgeUnitId}`,
    runId,
    bridgeUnitId,
    stage: "translation",
    agentLabel: "translator",
    logicalCallId: `logical-lifecycle-${bridgeUnitId}`,
    attemptIndex: 1,
    requestedModelId: "model-lifecycle-requested",
    requestedProviderId: "provider-lifecycle-requested",
    zdr: true,
    artifactRef: `provider-run:provider-run-lifecycle-${bridgeUnitId}`,
    startedAt: "2026-07-12T12:00:01.000Z",
    lease,
  };
}

function lifecycleCompleteAttempt(
  begin: ReturnType<typeof lifecycleBeginAttempt>,
  modelId: string,
  providerId: string,
) {
  return {
    attemptId: begin.attemptId,
    runId: begin.runId,
    bridgeUnitId: begin.bridgeUnitId,
    modelId,
    providerId,
    costUsd: "0.00000000000000000007",
    costKind: "billed" as const,
    usageResponseJson: { cost: 0.00000000000000000007 }, // itotori-225-audit-allow: synthetic sub-micro provider usage.cost fixture exercising exact-decimal cost persistence, not a real billed amount
    tokensIn: 9,
    tokensOut: 4,
    tokenCountSource: "provider_reported",
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheDiscountMicrosUsd: 0,
    fallbackUsed: true,
    fallbackPlan: ["provider-lifecycle-requested", providerId],
    zdr: true,
    finishState: "stop",
    refusalState: null,
    validationResult: "accepted" as const,
    failureClass: null,
    retryDecision: "write" as const,
    retryDelayMs: null,
    artifactRef: begin.artifactRef,
    errorClasses: [],
    completedAt: "2026-07-12T12:00:02.000Z",
    lease: begin.lease,
  };
}

function unitInput(
  runId: string,
  bridgeUnitId: string,
  suffix: string,
): Parameters<ItotoriLocalizationJournalRepository["persistUnit"]>[1] {
  const attempts = attemptsFixture(runId, bridgeUnitId, suffix);
  return {
    runId,
    bridgeUnitId,
    outcome: outcomeFixture(bridgeUnitId, suffix),
    attempts,
    contextPacket: { run: suffix },
    contextRefs: [],
    speakerLabels: [],
    qaDetails: {
      "finding-tone-1": {
        recommendation: "Use the established formal register.",
        agentRationale: "QA evidence remains durable.",
        evidenceRefs: ["style:formal"],
      },
    },
  };
}

function attemptsFixture(
  runId: string,
  bridgeUnitId: string,
  suffix = "",
): PersistLocalizationJournalAttemptInput[] {
  const id = (base: string) => `${base}${suffix.length > 0 ? `-${suffix}` : ""}`;
  return [
    {
      attemptId: id("provider-run-context"),
      runId,
      bridgeUnitId,
      stage: "context",
      agentLabel: "scene-summary",
      logicalCallId: id("logical-context"),
      attemptIndex: 1,
      modelId: "model-context",
      providerId: "provider-a",
      providerRunId: id("provider-run-context"),
      costUsd: "0.00000000000000000002",
      tokensIn: 12,
      tokensOut: 8,
      zdr: true,
      finishState: "stop",
      refusalState: null,
      validationResult: "accepted",
      failureClass: null,
      retryDecision: "advance",
      retryDelayMs: null,
      artifactRef: `provider-run:${id("provider-run-context")}`,
      errorClasses: [],
      startedAt: "2026-07-11T10:01:00.000Z",
      completedAt: "2026-07-11T10:01:01.000Z",
    },
    {
      attemptId: id("provider-run-primary"),
      runId,
      bridgeUnitId,
      stage: "translation",
      agentLabel: "translator",
      logicalCallId: id("logical-translation"),
      attemptIndex: 1,
      modelId: "model-translate",
      providerId: "provider-a",
      providerRunId: id("provider-run-primary"),
      costUsd: "0.00000602",
      tokensIn: 21,
      tokensOut: 9,
      zdr: true,
      finishState: "stop",
      refusalState: null,
      validationResult: "schema_invalid",
      failureClass: "schema_validation",
      retryDecision: "retry",
      retryDelayMs: 25,
      artifactRef: `provider-run:${id("provider-run-primary")}`,
      errorClasses: ["schema_validation"],
      startedAt: "2026-07-11T10:02:00.000Z",
      completedAt: "2026-07-11T10:02:01.000Z",
    },
    {
      attemptId: id("provider-run-repair"),
      runId,
      bridgeUnitId,
      stage: "repair",
      agentLabel: "repair-translator",
      logicalCallId: id("logical-repair"),
      attemptIndex: 1,
      modelId: "model-repair",
      providerId: "provider-b",
      providerRunId: id("provider-run-repair"),
      costUsd: "0.00000000000000000003",
      tokensIn: 25,
      tokensOut: 10,
      zdr: true,
      finishState: "stop",
      refusalState: null,
      validationResult: "accepted",
      failureClass: null,
      retryDecision: "write",
      retryDelayMs: null,
      artifactRef: `provider-run:${id("provider-run-repair")}`,
      errorClasses: [],
      startedAt: "2026-07-11T10:03:00.000Z",
      completedAt: "2026-07-11T10:03:01.000Z",
    },
  ];
}

function outcomeFixture(bridgeUnitId = "raw-bridge-unit-1", suffix = ""): WrittenUnitOutcome {
  const providerRun = (base: string) => `${base}${suffix.length > 0 ? `-${suffix}` : ""}`;
  return {
    id: "written-outcome-deterministic",
    status: "written",
    unitId: bridgeUnitId,
    targetLocale: scope.targetLocale,
    selectedCandidateId: "candidate-repair",
    candidates: [
      {
        id: "candidate-primary",
        outcomeId: "written-outcome-deterministic",
        body: asNonBlankTargetText("Good evening."),
        producedBy: { modelId: "model-translate", providerId: "provider-a" },
        attemptId: providerRun("provider-run-primary"),
        kind: "primary",
      },
      {
        id: "candidate-repair",
        outcomeId: "written-outcome-deterministic",
        body: asNonBlankTargetText("Good evening, Aya."),
        producedBy: { modelId: "model-repair", providerId: "provider-b" },
        attemptId: providerRun("provider-run-repair"),
        kind: "repair",
      },
    ],
    findings: [
      {
        id: "finding-tone-1",
        outcomeId: "written-outcome-deterministic",
        candidateId: "candidate-repair",
        severity: "minor",
        category: "tone",
        note: "Register should remain formal.",
        contested: true,
        confidence: 0.75,
      },
    ],
    qualityFlags: ["qa_unresolved", "repair_used"],
    provenance: { origin: "agentic-loop", selected: "repair" },
    writtenAt: "2026-07-11T10:03:01.000Z",
  };
}

function speakerLabelFixture(bridgeUnitId: string): SpeakerLabel {
  return {
    bridgeUnitId,
    speakerId: { kind: "named", characterId: "aya", displayName: "Aya" },
    confidence: "high",
    evidenceRefs: ["scene:roof:v3", "character:aya:v7"],
    agentRationale: "The preceding named line and character card identify Aya.",
  };
}

async function seedScope(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
): Promise<void> {
  await context.db.execute(sql`
    insert into itotori_workspaces (workspace_id, name)
    values ('workspace-localization-journal', 'Localization Journal Workspace')
  `);
  await context.db.execute(sql`
    insert into itotori_projects (
      project_id, workspace_id, project_key, name, source_locale, status
    ) values (
      ${scope.projectId}, 'workspace-localization-journal', 'localization-journal',
      'Localization Journal Project', 'ja-JP', 'imported'
    )
  `);
  await context.db.execute(sql`
    insert into itotori_source_revisions (source_revision_id, project_id, revision_kind, value)
    values (${scope.sourceRevisionId}, ${scope.projectId}, 'bridge_revision', 'journal-v1')
  `);
  await context.db.execute(sql`
    insert into itotori_source_bundles (
      source_bundle_id, project_id, source_bundle_revision_id, bridge_id,
      schema_version, source_bundle_hash, source_locale,
      extractor_name, extractor_version, unit_count, asset_count
    ) values (
      'source-bundle-localization-journal', ${scope.projectId}, ${scope.sourceRevisionId},
      'bridge-localization-journal', '0.2.0', 'hash:journal', 'ja-JP',
      'fixture-extractor', '1.0.0', 0, 0
    )
  `);
  await context.db.execute(sql`
    insert into itotori_locale_branches (
      locale_branch_id, project_id, source_bundle_id, target_locale, branch_name, status
    ) values (
      ${scope.localeBranchId}, ${scope.projectId}, 'source-bundle-localization-journal',
      ${scope.targetLocale}, 'Journal branch', 'active'
    )
  `);
}
