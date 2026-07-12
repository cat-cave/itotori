import { describe, expect, it } from "vitest";
import {
  ItotoriLocalizationJournalRepository,
  localUserId,
  type AuthorizationActor,
  type ItotoriLocalizationJournalRepositoryPort,
} from "@itotori/db";
import {
  SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
  STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
  STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
  type BridgeBundleV02,
  type LocalizationUnitV02,
} from "@itotori/localization-bridge-schema";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import {
  DEV_POLICY,
  fakeSemanticContextContent,
  type AgenticLoopProviderFactory,
  type PairPolicy,
} from "../src/orchestrator/agentic-loop.js";
import {
  runProjectDrivenExecutor,
  type DrivenPatchExportRecord,
} from "../src/orchestrator/project-driven-executor.js";
import { DrivenJournalPersistenceAdapter } from "../src/orchestrator/project-driven-executor-sinks.js";
import { DEV_PAIR } from "../src/providers/dev-pair.js";
import { FakeModelProvider } from "../src/providers/fake.js";
import type { ModelInvocationRequest } from "../src/providers/types.js";

const ACTOR: AuthorizationActor = { userId: localUserId };
const PROJECT_ID = "project-invocation-supervisor-resume";
const BRANCH_ID = "branch-invocation-supervisor-resume";
const REVISION_ID = "revision-invocation-supervisor-resume";
const BUNDLE_ID = "bundle-invocation-supervisor-resume";
const UNIT_ONE = "019ed200-0000-7000-8000-000000000001";
const UNIT_TWO = "019ed200-0000-7000-8000-000000000002";

// DB-backed: skips visibly in portable (no-DATABASE_URL) shards, runs in the
// tier1-db lane where a live Postgres is provisioned (matches the repo's
// DATABASE_URL skip-gate convention, e.g. project-workflow.test.ts).
describe.skipIf(!process.env.DATABASE_URL)("InvocationSupervisor durable pause/resume", () => {
  it("seeds every unit before dispatch, pauses without a patch, and resumes only pending work", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context.pool);
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      const firstCalls = new Map<string, number>();
      const firstPatches: DrivenPatchExportRecord[] = [];
      const first = await runProjectDrivenExecutor({
        ...executorInput(providerFactory(firstCalls)),
        costAdmission: {
          admit: async ({ bridgeUnitId }) =>
            bridgeUnitId === UNIT_TWO
              ? {
                  admitted: false,
                  detail: "injected cost denial for second unit",
                  evidence: "failure-injection:cost-denied",
                }
              : { admitted: true },
        },
        sinks: {
          journal: new DrivenJournalPersistenceAdapter(repository, { actor: ACTOR }),
          patchExport: { exportPatch: async (record) => void firstPatches.push(record) },
        },
      });

      expect(first.runState).toBe("paused");
      expect(first.pausedBlocker).toMatchObject({
        kind: "budget_cap",
        detail: "injected cost denial for second unit",
      });
      expect(first.patchExportCount).toBe(0);
      expect(firstPatches).toEqual([]);
      expect(firstCalls.get(UNIT_ONE)).toBeGreaterThan(0);
      expect(firstCalls.get(UNIT_TWO) ?? 0).toBe(0);

      const pausedRun = await repository.loadRun(ACTOR, first.journalRunId);
      const pausedUnits = await repository.loadRunUnits(ACTOR, first.journalRunId);
      expect(pausedRun).toMatchObject({
        status: "paused",
        pausedBlocker: { kind: "budget_cap" },
        frozenScope: { bridgeUnitIds: [UNIT_ONE, UNIT_TWO] },
      });
      expect(pausedUnits.map((unit) => [unit.bridgeUnitId, unit.state])).toEqual([
        [UNIT_ONE, "written"],
        [UNIT_TWO, "pending"],
      ]);
      expect(pausedUnits.every((unit) => !("sourceText" in (unit.nextAction ?? {})))).toBe(true);

      const resumedCalls = new Map<string, number>();
      const resumedPatches: DrivenPatchExportRecord[] = [];
      const resumed = await runProjectDrivenExecutor({
        ...executorInput(providerFactory(resumedCalls)),
        resumeRunId: first.journalRunId,
        costAdmission: { admit: async () => ({ admitted: true }) },
        sinks: {
          journal: new DrivenJournalPersistenceAdapter(repository, { actor: ACTOR }),
          patchExport: { exportPatch: async (record) => void resumedPatches.push(record) },
        },
      });

      expect(resumed.journalRunId).toBe(first.journalRunId);
      expect(resumed.runState).toBe("running");
      expect(resumed.pausedBlocker).toBeNull();
      expect(resumedCalls.get(UNIT_ONE) ?? 0).toBe(0);
      expect(resumedCalls.get(UNIT_TWO)).toBeGreaterThan(0);
      expect(resumed.patchExportCount).toBe(1);
      expect(resumedPatches).toHaveLength(1);
      expect(resumed.patchReport.writtenUnits.map((unit) => unit.bridgeUnitId)).toEqual([
        UNIT_ONE,
        UNIT_TWO,
      ]);

      const completedUnits = await repository.loadRunUnits(ACTOR, first.journalRunId);
      const attempts = await repository.loadAttemptsForRun(ACTOR, first.journalRunId);
      expect(completedUnits.every((unit) => unit.state === "written")).toBe(true);
      expect(attempts.length).toBe(
        (firstCalls.get("__all__") ?? 0) + (resumedCalls.get("__all__") ?? 0),
      );
      expect(attempts.every((attempt) => attempt.lifecycleState === "completed")).toBe(true);
      expect(attempts.every((attempt) => attempt.costUsd === "0")).toBe(true);
    } finally {
      await context.close();
    }
  });

  it("persists providerless outage attempts and resumes after all routes recover", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context.pool);
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      const outageFactory: AgenticLoopProviderFactory = ({ stage, agentLabel }) =>
        new FakeModelProvider({
          providerName: `outage-${stage}-${agentLabel}`,
          generate: () => {
            throw Object.assign(new Error("injected HTTP 503 outage"), { status: 503 });
          },
        });
      const paused = await runProjectDrivenExecutor({
        ...executorInput(outageFactory),
        sinks: {
          journal: new DrivenJournalPersistenceAdapter(repository, { actor: ACTOR }),
          patchExport: { exportPatch: async () => undefined },
        },
      });

      expect(paused.runState).toBe("paused");
      expect(paused.pausedBlocker).toMatchObject({
        kind: "provider_outage",
        operatorAction: expect.stringContaining("resume"),
      });
      expect(paused.patchExportCount).toBe(0);
      const outageAttempts = await repository.loadAttemptsForRun(ACTOR, paused.journalRunId);
      expect(outageAttempts).toHaveLength(2);
      expect(outageAttempts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            lifecycleState: "completed",
            modelId: null,
            providerId: null,
            costUsd: null,
            failureClass: "provider_unavailable",
          }),
        ]),
      );

      const resumedCalls = new Map<string, number>();
      const patches: DrivenPatchExportRecord[] = [];
      const resumed = await runProjectDrivenExecutor({
        ...executorInput(providerFactory(resumedCalls)),
        resumeRunId: paused.journalRunId,
        sinks: {
          journal: new DrivenJournalPersistenceAdapter(repository, { actor: ACTOR }),
          patchExport: { exportPatch: async (record) => void patches.push(record) },
        },
      });

      expect(resumed.runState).toBe("running");
      expect(resumed.patchExportCount).toBe(1);
      expect(patches).toHaveLength(1);
      expect(
        (await repository.loadRunUnits(ACTOR, paused.journalRunId)).every(
          (unit) => unit.state === "written",
        ),
      ).toBe(true);
    } finally {
      await context.close();
    }
  });

  it("persists an itotori_bug pause when enrichment breaches the hard retry ceiling", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context.pool);
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      const calls = new Map<string, number>();
      const healthyFactory = providerFactory(calls);
      const ceilingFactory: AgenticLoopProviderFactory = (factoryInput) => {
        if (factoryInput.stage !== "context" || factoryInput.agentLabel !== "scene-summary") {
          return healthyFactory(factoryInput);
        }
        return new FakeModelProvider({
          providerName: "ceiling-context-scene-summary",
          generate: () => {
            calls.set("scene-summary", (calls.get("scene-summary") ?? 0) + 1);
            return "";
          },
        });
      };
      const patches: DrivenPatchExportRecord[] = [];

      const result = await runProjectDrivenExecutor({
        ...executorInput(ceilingFactory),
        pairPolicy: enrichmentCeilingPairPolicy(),
        sinks: {
          journal: new DrivenJournalPersistenceAdapter(repository, { actor: ACTOR }),
          patchExport: { exportPatch: async (record) => void patches.push(record) },
        },
      });

      expect(result.runState).toBe("paused");
      expect(result.pausedBlocker).toMatchObject({
        kind: "itotori_bug",
        detail: expect.stringContaining("hard retry ceiling 12"),
      });
      expect(result.patchExportCount).toBe(0);
      expect(patches).toEqual([]);
      expect(calls.get("scene-summary")).toBe(12);

      const [pausedRun, units, attempts] = await Promise.all([
        repository.loadRun(ACTOR, result.journalRunId),
        repository.loadRunUnits(ACTOR, result.journalRunId),
        repository.loadAttemptsForRun(ACTOR, result.journalRunId),
      ]);
      expect(pausedRun).toMatchObject({
        status: "paused",
        pausedBlocker: { kind: "itotori_bug" },
      });
      expect(units.every((unit) => unit.state === "pending")).toBe(true);
      expect(attempts).toHaveLength(12);
      expect(
        attempts.every(
          (attempt) =>
            attempt.stage === "context" &&
            attempt.agentLabel === "scene-summary" &&
            attempt.lifecycleState === "completed" &&
            attempt.failureClass === "empty",
        ),
      ).toBe(true);
    } finally {
      await context.close();
    }
  });

  it("renews a slow provider dispatch beyond its lease window so a second driver cannot dispatch", async () => {
    const context = await isolatedMigratedContext();
    let releaseDispatch: (() => void) | undefined;
    let firstExecution: ReturnType<typeof runProjectDrivenExecutor> | undefined;
    try {
      await seedScope(context.pool);
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      const firstCalls = new Map<string, number>();
      const healthyFirstFactory = providerFactory(firstCalls);
      const dispatchGate = new Promise<void>((resolve) => {
        releaseDispatch = resolve;
      });
      let markDispatchStarted!: () => void;
      const dispatchStarted = new Promise<void>((resolve) => {
        markDispatchStarted = resolve;
      });
      let liveDispatchCount = 0;
      const blockingFactory: AgenticLoopProviderFactory = (factoryInput) => {
        if (factoryInput.stage !== "context" || factoryInput.agentLabel !== "scene-summary") {
          return healthyFirstFactory(factoryInput);
        }
        const provider = new FakeModelProvider({
          providerName: "live-first-driver-scene-summary",
          generate: () => fakeSemanticContextContent("scene-summary"),
        });
        return {
          descriptor: provider.descriptor,
          invoke: async (request) => {
            liveDispatchCount += 1;
            markDispatchStarted();
            await dispatchGate;
            return provider.invoke(request);
          },
        };
      };

      firstExecution = runProjectDrivenExecutor({
        ...executorInput(blockingFactory),
        maxUnits: 1,
        sinks: {
          journal: new DrivenJournalPersistenceAdapter(repository, {
            actor: ACTOR,
            driverId: "live-driver-a",
            leaseHeartbeatIntervalMs: 100,
            leaseHeartbeatTimeoutMs: 5_000,
          }),
          patchExport: { exportPatch: async () => undefined },
        },
      });
      await dispatchStarted;
      const activeRun = await repository.loadLatestRunForBranch(ACTOR, BRANCH_ID);
      if (activeRun === null) throw new Error("live first driver did not seed its run");
      expect(activeRun).toMatchObject({
        status: "running",
        leaseOwnerId: "live-driver-a",
        fenceToken: 1,
      });

      // Compress this test's initially granted DB lease window. The provider
      // remains blocked beyond it; only the adapter heartbeat can keep the
      // database-owned lease live (production retains the 120-second floor).
      await context.pool.query(
        `
        update itotori_localization_journal_runs
        set lease_expires_at = now() + interval '800 milliseconds'
        where run_id = $1
        `,
        [activeRun.runId],
      );
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const renewedLease = await context.pool.query<{ renewed: boolean }>(
        `
        select lease_expires_at > now() + interval '60 seconds' as renewed
        from itotori_localization_journal_runs
        where run_id = $1
        `,
        [activeRun.runId],
      );
      expect(renewedLease.rows[0]).toMatchObject({ renewed: true });

      const secondCalls = new Map<string, number>();
      await expect(
        runProjectDrivenExecutor({
          ...executorInput(providerFactory(secondCalls)),
          maxUnits: 1,
          resumeRunId: activeRun.runId,
          sinks: {
            journal: new DrivenJournalPersistenceAdapter(repository, {
              actor: ACTOR,
              driverId: "live-driver-b",
            }),
            patchExport: { exportPatch: async () => undefined },
          },
        }),
      ).rejects.toThrow(/running lease fence .* still live/u);
      expect(liveDispatchCount).toBe(1);
      expect(secondCalls.get("__all__") ?? 0).toBe(0);
      expect(await repository.loadAttemptsForRun(ACTOR, activeRun.runId)).toEqual([
        expect.objectContaining({
          lifecycleState: "dispatching",
          fenceToken: 1,
          completedAt: null,
        }),
      ]);

      releaseDispatch?.();
      await firstExecution;
      expect(
        (await repository.loadAttemptsForRun(ACTOR, activeRun.runId)).some(
          (attempt) => attempt.finishState === "interrupted",
        ),
      ).toBe(false);
    } finally {
      releaseDispatch?.();
      await firstExecution?.catch(() => undefined);
      await context.close();
    }
  });

  it("fails closed before provider dispatch when the DB lease has no safe abort margin", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context.pool);
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      const exhaustedDeadlineJournal = new Proxy(repository, {
        get(target, property) {
          if (property === "beginAttempt") {
            return async (
              actor: Parameters<ItotoriLocalizationJournalRepositoryPort["beginAttempt"]>[0],
              input: Parameters<ItotoriLocalizationJournalRepositoryPort["beginAttempt"]>[1],
            ) => {
              const dispatching = await target.beginAttempt(actor, input);
              return {
                ...dispatching,
                leaseDeadline: { ...dispatching.leaseDeadline, remainingMs: 0 },
              };
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as ItotoriLocalizationJournalRepositoryPort;
      let physicalDispatches = 0;
      const healthyFactory = providerFactory(new Map());
      const countingFactory: AgenticLoopProviderFactory = (factoryInput) => {
        const provider = healthyFactory(factoryInput);
        return {
          descriptor: provider.descriptor,
          invoke: async (request) => {
            physicalDispatches += 1;
            return await provider.invoke(request);
          },
        };
      };

      const result = await runProjectDrivenExecutor({
        ...executorInput(countingFactory),
        maxUnits: 1,
        sinks: {
          journal: new DrivenJournalPersistenceAdapter(exhaustedDeadlineJournal, {
            actor: ACTOR,
            driverId: "exhausted-deadline-driver",
          }),
          patchExport: { exportPatch: async () => undefined },
        },
      });

      expect(physicalDispatches).toBe(0);
      expect(result).toMatchObject({
        runState: "paused",
        pausedBlocker: { kind: "provider_outage" },
      });
      const attempts = await repository.loadAttemptsForRun(ACTOR, result.journalRunId);
      expect(attempts.length).toBeGreaterThan(0);
      expect(attempts.every((attempt) => attempt.failureClass === "timeout")).toBe(true);
    } finally {
      await context.close();
    }
  });

  it("aborts driver A at the DB lease deadline before an expired-lease takeover dispatches", async () => {
    const context = await isolatedMigratedContext();
    let releaseDispatch: (() => void) | undefined;
    let releaseCompletion: (() => void) | undefined;
    let firstExecution: ReturnType<typeof runProjectDrivenExecutor> | undefined;
    try {
      await seedScope(context.pool);
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      const completionGate = new Promise<void>((resolve) => {
        releaseCompletion = resolve;
      });
      let markCompletionBlocked!: () => void;
      const completionBlocked = new Promise<void>((resolve) => {
        markCompletionBlocked = resolve;
      });
      const deadlineJournal = new Proxy(repository, {
        get(target, property) {
          if (property === "beginAttempt") {
            return async (
              actor: Parameters<ItotoriLocalizationJournalRepositoryPort["beginAttempt"]>[0],
              input: Parameters<ItotoriLocalizationJournalRepositoryPort["beginAttempt"]>[1],
            ) => {
              const dispatching = await target.beginAttempt(actor, input);
              // Keep the production 120-second floor while making this one
              // DB-issued deadline observable in a focused integration test.
              const compressed = await context.pool.query<{
                leaseExpiresAt: Date;
                remainingMs: number;
              }>(
                `
                update itotori_localization_journal_runs
                set lease_expires_at = clock_timestamp() + interval '2 seconds'
                where run_id = $1
                returning
                  lease_expires_at as "leaseExpiresAt",
                  greatest(
                    0,
                    extract(epoch from (lease_expires_at - clock_timestamp())) * 1000
                  )::double precision as "remainingMs"
                `,
                [input.runId],
              );
              const leaseDeadline = compressed.rows[0];
              if (leaseDeadline === undefined) {
                throw new Error(`failed to compress test lease for ${input.runId}`);
              }
              return { ...dispatching, leaseDeadline };
            };
          }
          if (property === "completeAttempt") {
            return async (
              actor: Parameters<ItotoriLocalizationJournalRepositoryPort["completeAttempt"]>[0],
              input: Parameters<ItotoriLocalizationJournalRepositoryPort["completeAttempt"]>[1],
            ) => {
              // A lease-deadline abort happens conservatively before expiry.
              // Hold A's completion write so it cannot renew the compressed
              // lease before the takeover assertion exercises the DB boundary.
              markCompletionBlocked();
              await completionGate;
              return await target.completeAttempt(actor, input);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as ItotoriLocalizationJournalRepositoryPort;

      let markDispatchStarted!: () => void;
      const dispatchStarted = new Promise<void>((resolve) => {
        markDispatchStarted = resolve;
      });
      let markDispatchAborted!: () => void;
      const dispatchAborted = new Promise<void>((resolve) => {
        markDispatchAborted = resolve;
      });
      const eventOrder: string[] = [];
      let driverAAborted = false;
      let driverAAbortReason: unknown;
      let driverAPhysicalDispatches = 0;
      const healthyFirstFactory = providerFactory(new Map());
      const blockingFactory: AgenticLoopProviderFactory = (factoryInput) => {
        if (factoryInput.stage !== "context" || factoryInput.agentLabel !== "scene-summary") {
          return healthyFirstFactory(factoryInput);
        }
        const provider = new FakeModelProvider({
          providerName: "lease-deadline-driver-a-scene-summary",
          generate: () => fakeSemanticContextContent("scene-summary"),
        });
        return {
          descriptor: provider.descriptor,
          invoke: async (request) => {
            driverAPhysicalDispatches += 1;
            markDispatchStarted();
            await new Promise<void>((resolve, reject) => {
              const signal = request.signal;
              if (signal === undefined) {
                reject(new Error("supervised dispatch did not provide an AbortSignal"));
                return;
              }
              const onAbort = (): void => {
                driverAAborted = true;
                driverAAbortReason = signal.reason;
                eventOrder.push("driver-a-aborted");
                markDispatchAborted();
                reject(signal.reason);
              };
              releaseDispatch = () => {
                signal.removeEventListener("abort", onAbort);
                resolve();
              };
              if (signal.aborted) onAbort();
              else signal.addEventListener("abort", onAbort, { once: true });
            });
            return provider.invoke(request);
          },
        };
      };

      firstExecution = runProjectDrivenExecutor({
        ...executorInput(blockingFactory),
        maxUnits: 1,
        sinks: {
          journal: new DrivenJournalPersistenceAdapter(deadlineJournal, {
            actor: ACTOR,
            driverId: "lease-deadline-driver-a",
            leaseHeartbeatIntervalMs: 5_000,
            leaseHeartbeatTimeoutMs: 500,
          }),
          patchExport: { exportPatch: async () => undefined },
        },
      });
      await dispatchStarted;
      const activeRun = await repository.loadLatestRunForBranch(ACTOR, BRANCH_ID);
      if (activeRun === null) throw new Error("deadline driver did not seed its run");

      await expect(
        repository.resumeRun(ACTOR, activeRun.runId, { ownerId: "lease-deadline-probe" }),
      ).rejects.toMatchObject({ code: "run_lease_conflict" });

      await dispatchAborted;
      await completionBlocked;
      expect(driverAAbortReason).toMatchObject({
        name: "JournalRunLeaseDeadlineError",
        message: expect.stringContaining("reached DB lease deadline"),
      });
      const liveAtAbort = await context.pool.query<{ live: boolean }>(
        `
        select lease_expires_at > clock_timestamp() as live
        from itotori_localization_journal_runs
        where run_id = $1
        `,
        [activeRun.runId],
      );
      expect(liveAtAbort.rows[0]).toMatchObject({ live: true });

      let expired = false;
      for (let poll = 0; poll < 120; poll += 1) {
        const result = await context.pool.query<{ expired: boolean }>(
          `
          select lease_expires_at <= clock_timestamp() as expired
          from itotori_localization_journal_runs
          where run_id = $1
          `,
          [activeRun.runId],
        );
        if (result.rows[0]?.expired === true) {
          expired = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(expired).toBe(true);

      const secondCalls = new Map<string, number>();
      const healthySecondFactory = providerFactory(secondCalls);
      const secondFactory: AgenticLoopProviderFactory = (factoryInput) => {
        const provider = healthySecondFactory(factoryInput);
        return {
          descriptor: provider.descriptor,
          invoke: async (request) => {
            eventOrder.push("driver-b-dispatched");
            if (!driverAAborted) {
              throw new Error("driver B dispatched before driver A observed its lease abort");
            }
            return await provider.invoke(request);
          },
        };
      };
      const resumed = await runProjectDrivenExecutor({
        ...executorInput(secondFactory),
        maxUnits: 1,
        resumeRunId: activeRun.runId,
        sinks: {
          journal: new DrivenJournalPersistenceAdapter(repository, {
            actor: ACTOR,
            driverId: "lease-deadline-driver-b",
          }),
          patchExport: { exportPatch: async () => undefined },
        },
      });

      expect(resumed.runState).toBe("running");
      expect(driverAPhysicalDispatches).toBe(1);
      expect(secondCalls.get("__all__") ?? 0).toBeGreaterThan(0);
      expect(eventOrder.indexOf("driver-a-aborted")).toBeLessThan(
        eventOrder.indexOf("driver-b-dispatched"),
      );
      const attempts = await repository.loadAttemptsForRun(ACTOR, activeRun.runId);
      expect(attempts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fenceToken: 1,
            finishState: "interrupted",
            failureClass: "interrupted",
          }),
          expect.objectContaining({
            fenceToken: 2,
            lifecycleState: "completed",
          }),
        ]),
      );

      releaseCompletion?.();
      await expect(firstExecution).rejects.toMatchObject({ code: "run_lease_lost" });
    } finally {
      releaseDispatch?.();
      releaseCompletion?.();
      await firstExecution?.catch(() => undefined);
      await context.close();
    }
  });

  it("aborts the provider and settles the executor when lease renewal hangs", async () => {
    const context = await isolatedMigratedContext();
    let releaseDispatch: (() => void) | undefined;
    let execution: ReturnType<typeof runProjectDrivenExecutor> | undefined;
    try {
      await seedScope(context.pool);
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      const heartbeatTimeoutDetail = "journal lease heartbeat exceeded 50ms";
      let renewalCalls = 0;
      const failingRenewalJournal = new Proxy(repository, {
        get(target, property) {
          if (property === "renewRunLease") {
            return () => {
              renewalCalls += 1;
              return new Promise<never>(() => undefined);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as ItotoriLocalizationJournalRepositoryPort;

      let markDispatchStarted!: () => void;
      const dispatchStarted = new Promise<void>((resolve) => {
        markDispatchStarted = resolve;
      });
      let markDispatchAborted!: () => void;
      const dispatchAborted = new Promise<void>((resolve) => {
        markDispatchAborted = resolve;
      });
      let physicalDispatches = 0;
      const healthyFactory = providerFactory(new Map());
      const blockingFactory: AgenticLoopProviderFactory = (factoryInput) => {
        if (factoryInput.stage !== "context" || factoryInput.agentLabel !== "scene-summary") {
          return healthyFactory(factoryInput);
        }
        const provider = new FakeModelProvider({
          providerName: "heartbeat-failure-scene-summary",
          generate: () => fakeSemanticContextContent("scene-summary"),
        });
        return {
          descriptor: provider.descriptor,
          invoke: async (request) => {
            physicalDispatches += 1;
            markDispatchStarted();
            await new Promise<void>((resolve, reject) => {
              const signal = request.signal;
              if (signal === undefined) {
                reject(new Error("supervised dispatch did not provide an AbortSignal"));
                return;
              }
              const onAbort = (): void => {
                markDispatchAborted();
                reject(signal.reason);
              };
              releaseDispatch = () => {
                signal.removeEventListener("abort", onAbort);
                resolve();
              };
              if (signal.aborted) onAbort();
              else signal.addEventListener("abort", onAbort, { once: true });
            });
            return provider.invoke(request);
          },
        };
      };

      execution = runProjectDrivenExecutor({
        ...executorInput(blockingFactory),
        maxUnits: 1,
        sinks: {
          journal: new DrivenJournalPersistenceAdapter(failingRenewalJournal, {
            actor: ACTOR,
            driverId: "heartbeat-failure-driver",
            leaseHeartbeatIntervalMs: 50,
          }),
          patchExport: { exportPatch: async () => undefined },
        },
      });
      await dispatchStarted;
      await dispatchAborted;
      const result = await execution;

      expect(physicalDispatches).toBe(1);
      expect(result).toMatchObject({
        runState: "paused",
        pausedBlocker: {
          kind: "itotori_bug",
          detail: expect.stringContaining(heartbeatTimeoutDetail),
        },
      });
      const attempts = await repository.loadAttemptsForRun(ACTOR, result.journalRunId);
      expect(attempts).toEqual([
        expect.objectContaining({
          lifecycleState: "completed",
          failureClass: "itotori_bug",
        }),
      ]);
      const callsAtSettlement = renewalCalls;
      expect(callsAtSettlement).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(renewalCalls).toBe(callsAtSettlement);
    } finally {
      releaseDispatch?.();
      await execution?.catch(() => undefined);
      await context.close();
    }
  });
});

function enrichmentCeilingPairPolicy(): PairPolicy {
  return {
    ...DEV_POLICY,
    context: {
      ...DEV_POLICY.context,
      sceneSummary: {
        ...DEV_POLICY.context.sceneSummary,
        // More than six two-attempt routes forces the universal hard ceiling
        // before a complete route pass can degrade into best-effort content.
        fallbackModels: Array.from(
          { length: 7 },
          (_value, index) => `scene-summary-fallback-${String(index + 1)}`,
        ),
      },
    },
  };
}

function executorInput(providerFactoryValue: AgenticLoopProviderFactory) {
  const bridge = bridgeFixture();
  return {
    bridge,
    rawBridge: JSON.parse(JSON.stringify(bridge)) as unknown,
    pairPolicy: DEV_POLICY,
    pair: { modelId: DEV_PAIR.modelId, providerId: DEV_PAIR.providerId },
    projectId: PROJECT_ID,
    localeBranchId: BRANCH_ID,
    sourceRevisionId: REVISION_ID,
    actor: ACTOR,
    providerFactory: providerFactoryValue,
    translationScope: "dialogue-only" as const,
    engineProfile: "rpg-maker-mv-mz" as const,
    concurrency: 1,
    maxRepairAttempts: 0,
  };
}

function providerFactory(calls: Map<string, number>): AgenticLoopProviderFactory {
  return ({ stage, agentLabel }) =>
    new FakeModelProvider({
      providerName: `supervisor-db-${stage}-${agentLabel}`,
      generate: (request) => {
        calls.set("__all__", (calls.get("__all__") ?? 0) + 1);
        if (request.taskKind === "experiment" && agentLabel !== "speaker-label") {
          return fakeSemanticContextContent(agentLabel);
        }
        const unitId = bridgeUnitIdOf(request);
        calls.set(unitId, (calls.get(unitId) ?? 0) + 1);
        if (request.taskKind === "experiment") return speakerContent(unitId);
        if (request.taskKind === "draft_translation") {
          return translationContent(
            unitId,
            unitId === UNIT_ONE ? "First target." : "Second target.",
          );
        }
        if (request.taskKind === "llm_qa") return cleanQaContent();
        throw new Error(`unexpected task ${request.taskKind}`);
      },
    });
}

function bridgeUnitIdOf(request: ModelInvocationRequest): string {
  const match = JSON.stringify(request).match(/019ed200-[0-9a-f]{4}-7000-8000-[0-9a-f]{12}/u);
  if (match === null) throw new Error("fixture provider could not find bridge unit id");
  return match[0];
}

function speakerContent(bridgeUnitId: string): string {
  return JSON.stringify({
    schemaVersion: SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
    labels: [
      {
        bridgeUnitId,
        speakerId: { kind: "narration" },
        confidence: "high",
        evidenceRefs: [],
        agentRationale: "durable resume fixture",
      },
    ],
  });
}

function translationContent(bridgeUnitId: string, draftText: string): string {
  return JSON.stringify({
    schemaVersion: STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
    drafts: [
      {
        bridgeUnitId,
        sourceLocale: "ja-JP",
        targetLocale: "en-US",
        draftText,
        protectedSpanRefs: [],
        citationRefs: [],
        agentRationale: "durable resume fixture",
        confidenceFloor: "medium",
      },
    ],
  });
}

function cleanQaContent(): string {
  return JSON.stringify({
    schemaVersion: STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
    findings: [],
  });
}

function bridgeFixture(): BridgeBundleV02 {
  return {
    schemaVersion: "0.2.0",
    bridgeId: "invocation-supervisor-resume-bridge",
    sourceLocale: "ja-JP",
    units: [unitFixture(UNIT_ONE, "一番目", 1), unitFixture(UNIT_TWO, "二番目", 2)],
  } as unknown as BridgeBundleV02;
}

function unitFixture(
  bridgeUnitId: string,
  sourceText: string,
  ordinal: number,
): LocalizationUnitV02 {
  const assetId = `019ed200-0000-7000-9000-${String(ordinal).padStart(12, "0")}`;
  return {
    bridgeUnitId,
    surfaceId: assetId,
    surfaceKind: "dialogue",
    sourceUnitKey: `scene/line-${ordinal}`,
    occurrenceId: `resume-occurrence-${ordinal}`,
    sourceLocale: "ja-JP",
    sourceText,
    sourceHash: `resume-source-hash-${ordinal}`,
    sourceRevision: { revisionId: REVISION_ID, revisionKind: "content_hash", value: "v1" },
    sourceAssetRef: { assetId, assetKey: `resume-asset-${ordinal}` },
    sourceLocation: { containerKey: `resume-asset-${ordinal}` },
    speaker: { knowledgeState: "unknown" },
    context: {},
    spans: [],
    patchRef: {
      assetId,
      writeMode: "replace",
      sourceUnitKey: `scene/line-${ordinal}`,
      sourceRevision: { revisionId: REVISION_ID, revisionKind: "content_hash", value: "v1" },
    },
    runtimeExpectation: { expectationKind: "metadata_only" },
  };
}

async function seedScope(
  pool: Awaited<ReturnType<typeof isolatedMigratedContext>>["pool"],
): Promise<void> {
  await pool.query(`insert into itotori_workspaces (workspace_id, name) values ($1, $2)`, [
    "workspace-invocation-supervisor-resume",
    "Invocation Supervisor Resume",
  ]);
  await pool.query(
    `insert into itotori_projects (project_id, workspace_id, project_key, name, source_locale, status)
     values ($1, $2, $3, $4, 'ja-JP', 'imported')`,
    [
      PROJECT_ID,
      "workspace-invocation-supervisor-resume",
      "supervisor-resume",
      "Supervisor Resume",
    ],
  );
  await pool.query(
    `insert into itotori_source_revisions (source_revision_id, project_id, revision_kind, value)
     values ($1, $2, 'bridge_revision', 'v1')`,
    [REVISION_ID, PROJECT_ID],
  );
  await pool.query(
    `insert into itotori_source_bundles (
       source_bundle_id, project_id, source_bundle_revision_id, bridge_id,
       schema_version, source_bundle_hash, source_locale, extractor_name,
       extractor_version, unit_count, asset_count
     ) values ($1, $2, $3, 'resume-bridge', '0.2.0', 'hash:resume', 'ja-JP', 'fixture', '1', 2, 2)`,
    [BUNDLE_ID, PROJECT_ID, REVISION_ID],
  );
  await pool.query(
    `insert into itotori_locale_branches (
       locale_branch_id, project_id, source_bundle_id, target_locale, branch_name, status
     ) values ($1, $2, $3, 'en-US', 'Resume branch', 'active')`,
    [BRANCH_ID, PROJECT_ID, BUNDLE_ID],
  );
}
