import { describe, expect, it } from "vitest";
import { REQUESTED_PROVIDER_UNKNOWN } from "../src/providers/types.js";
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
import { addDecimalUsd, compareDecimalUsd } from "../src/providers/cost.js";
import type { ModelInvocationRequest, ProviderCost } from "../src/providers/types.js";

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
  it("atomically reserves exact sub-micro costs and reconciles a failed billed attempt", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context.pool);
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      const runId = "journal-run-atomic-exact-cost";
      const unitIds = Array.from(
        { length: 8 },
        (_value, index) => `raw-bridge-unit-atomic-cost-${String(index + 1)}`,
      );
      await repository.seedRun(ACTOR, atomicCostSeed(runId, unitIds));

      // Exercise the full fenced repository path with N concurrent callers.
      // That path also renews the run lease, so its run-row lock intentionally
      // serializes admissions. The repository-package race test separately
      // holds the account row and races the extracted account-only primitive,
      // proving this integration lock cannot mask a read/check/write TOCTOU.
      // Each observable snapshot here must still retain spent + reserved <=
      // cap.
      const raced = await Promise.all(
        unitIds.map(async (bridgeUnitId) => {
          const reservation = await repository.reserveAttemptCost(
            ACTOR,
            atomicCostAttempt(runId, bridgeUnitId),
          );
          const account = await repository.loadRunCostAccount(ACTOR, runId);
          expect(account).not.toBeNull();
          expect(
            compareDecimalUsd(
              addDecimalUsd(account?.spentCostUsd ?? "0", account?.reservedCostUsd ?? "0"),
              account?.capUsd ?? "0",
            ) <= 0,
          ).toBe(true);
          return reservation;
        }),
      );
      const admitted = raced.filter(
        (result): result is Extract<(typeof raced)[number], { admitted: true }> => result.admitted,
      );
      expect(admitted).toHaveLength(2);
      if (admitted.length !== 2) {
        throw new Error("atomic exact-cost fixture unexpectedly denied an admitted reservation");
      }

      expect(await repository.loadRunCostAccount(ACTOR, runId)).toMatchObject({
        capUsd: "0.00000098",
        spentCostUsd: "0",
        reservedCostUsd: "0.00000098",
      });

      await Promise.all([
        repository.completeAttempt(
          ACTOR,
          atomicCostCompletion(admitted[0].attempt, {
            failureClass: "malformed_response",
            refusalState: "malformed-http-200",
            retryDecision: "advance",
            validationResult: "semantic_invalid",
          }),
        ),
        repository.completeAttempt(ACTOR, atomicCostCompletion(admitted[1].attempt)),
      ]);

      // A known billed cost is charged even when the response is unusable.
      // Reconciliation moves the exact decimal out of reserved rather than
      // using an integer-micro rounded value that would lose both charges.
      const reconciledAccount = await repository.loadRunCostAccount(ACTOR, runId);
      expect(reconciledAccount).toMatchObject({
        capUsd: "0.00000098",
        spentCostUsd: "0.00000098",
      });
      expect(reconciledAccount?.reservedCostUsd).toMatch(/^0(?:\.0+)?$/u);
      expect(await repository.loadCostReservations(ACTOR, runId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            attemptId: admitted[0].attempt.attemptId,
            reservedUsd: "0.00000049",
            reconciledUsd: "0.00000049",
            state: "reconciled",
          }),
          expect.objectContaining({
            attemptId: admitted[1].attempt.attemptId,
            reservedUsd: "0.00000049",
            reconciledUsd: "0.00000049",
            state: "reconciled",
          }),
        ]),
      );
      expect(await repository.loadAttemptsForRun(ACTOR, runId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            attemptId: admitted[0].attempt.attemptId,
            billingState: "known",
            costUsd: "0.00000049",
            failureClass: "malformed_response",
            refusalState: "malformed-http-200",
          }),
          expect.objectContaining({
            attemptId: admitted[1].attempt.attemptId,
            billingState: "known",
            costUsd: "0.00000049",
          }),
        ]),
      );
    } finally {
      await context.close();
    }
  });

  it("reconciles a billed malformed provider response that the supervisor rejects", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context.pool);
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      const calls = new Map<string, number>();
      const healthyFactory = providerFactory(calls);
      const malformedFactory: AgenticLoopProviderFactory = (factoryInput) => {
        if (
          factoryInput.stage !== "translation" ||
          factoryInput.agentLabel !== "translation-primary"
        ) {
          return healthyFactory(factoryInput);
        }
        return new FakeModelProvider({
          providerName: "billed-malformed-translation-response",
          // This is a real provider result flowing through InvocationSupervisor:
          // the broken JSON body is NOT a hand-built completion record, while
          // the injected telemetry models a provider that billed the malformed
          // response.
          cost: ATOMIC_SUB_MICRO_BILLED_COST,
          generate: () => "{ malformed provider JSON",
        });
      };

      const result = await runProjectDrivenExecutor({
        ...executorInput(malformedFactory),
        pairPolicy: atomicCostPairPolicy(),
        budgetCapUsd: ATOMIC_COST_RAISED_CAP_USD,
        maxUnits: 1,
        sinks: {
          journal: new DrivenJournalPersistenceAdapter(repository, {
            actor: ACTOR,
            driverId: "billed-malformed-response-driver",
          }),
          patchExport: { exportPatch: async () => undefined },
        },
      });

      expect(result).toMatchObject({
        runState: "paused",
        patchExportCount: 0,
      });
      const attempts = await repository.loadAttemptsForRun(ACTOR, result.journalRunId);
      const malformedAttempts = attempts.filter(
        (attempt) =>
          attempt.stage === "translation" &&
          attempt.agentLabel === "translation-primary" &&
          attempt.failureClass === "invalid_json",
      );
      expect(malformedAttempts.length).toBeGreaterThan(0);
      expect(malformedAttempts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            lifecycleState: "completed",
            billingState: "known",
            costUsd: "0.00000049",
          }),
        ]),
      );

      const reservations = await repository.loadCostReservations(ACTOR, result.journalRunId);
      for (const attempt of malformedAttempts) {
        expect(reservations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              attemptId: attempt.attemptId,
              reservedUsd: "0.00000049",
              reconciledUsd: "0.00000049",
              state: "reconciled",
            }),
          ]),
        );
      }
      const account = await repository.loadRunCostAccount(ACTOR, result.journalRunId);
      const expectedBilledSpend = malformedAttempts.reduce(
        (total) => addDecimalUsd(total, ATOMIC_SUB_MICRO_BILLED_COST.amountUsd),
        "0",
      );
      expect(account).toMatchObject({ spentCostUsd: expectedBilledSpend, reservedCostUsd: "0" });
    } finally {
      await context.close();
    }
  });

  it("resumes a previously unlimited run with its raised persisted cap and enforces it", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context.pool);
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      const calls = new Map<string, number>();
      const patches: DrivenPatchExportRecord[] = [];
      const firstJournal = new DrivenJournalPersistenceAdapter(repository, {
        actor: ACTOR,
        driverId: "atomic-cost-uncapped-driver",
      });
      const result = await runProjectDrivenExecutor({
        ...executorInput(providerFactory(calls, ATOMIC_SUB_MICRO_BILLED_COST)),
        pairPolicy: atomicCostPairPolicy(),
        maxUnits: 1,
        // Deliberately omit budgetCapUsd. The durable adapter must still
        // reserve/reconcile every physical call against an unlimited account.
        sinks: {
          journal: firstJournal,
          patchExport: { exportPatch: async (record) => void patches.push(record) },
        },
      });

      // This focused fixture intentionally drives one unit from a two-unit
      // frozen scope, so no final patch is expected even though the paid
      // calls complete normally.
      expect(result).toMatchObject({ runState: "running", patchExportCount: 0 });
      expect(patches).toEqual([]);
      const account = await repository.loadRunCostAccount(ACTOR, result.journalRunId);
      expect(account).toMatchObject({ capUsd: null, reservedCostUsd: "0" });
      expect(compareDecimalUsd(account?.spentCostUsd ?? "0", "0")).toBeGreaterThan(0);
      const reservations = await repository.loadCostReservations(ACTOR, result.journalRunId);
      expect(reservations.length).toBeGreaterThan(0);
      expect(reservations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            state: "reconciled",
            reconciledUsd: ATOMIC_SUB_MICRO_BILLED_COST.amountUsd,
          }),
        ]),
      );

      // Make the intentionally partial unlimited run resumable without
      // fabricating a budget pause. The first adapter owns its live fence, so
      // exercise the same durable pause/release boundary an operator reaches
      // after a provider outage before assigning a finite cap.
      await firstJournal.pauseRun(result.journalRunId, {
        kind: "provider_outage",
        detail: "test fixture pauses the partial unlimited run before cap raise",
        evidence: "test:unlimited-cap-raise-resume",
        raisedAt: "2026-07-12T12:00:00.000Z",
        operatorAction: "raise the run cost cap, then resume",
      });
      await firstJournal.releasePausedRunLease(result.journalRunId);

      const addedCap = addDecimalUsd(
        String(account?.spentCostUsd ?? "0"),
        ATOMIC_SUB_MICRO_BILLED_COST.amountUsd,
      );
      await expect(
        repository.raiseRunCostCap(ACTOR, result.journalRunId, addedCap),
      ).resolves.toMatchObject({ capUsd: addedCap, spentCostUsd: account?.spentCostUsd });
      expect(await repository.loadRun(ACTOR, result.journalRunId)).toMatchObject({
        costPolicy: expect.objectContaining({ budgetCapUsd: addedCap }),
      });

      const resumedCalls = new Map<string, number>();
      const resumed = await runProjectDrivenExecutor({
        ...executorInput(providerFactory(resumedCalls, ATOMIC_SUB_MICRO_BILLED_COST)),
        pairPolicy: atomicCostPairPolicy(),
        resumeRunId: result.journalRunId,
        // Deliberately omit budgetCapUsd. Rebuilding null from this call would
        // produce run_seed_conflict; the persisted exact string must instead
        // seed the resume and stop after its one-call headroom.
        sinks: {
          journal: new DrivenJournalPersistenceAdapter(repository, {
            actor: ACTOR,
            driverId: "atomic-cost-uncapped-resume-driver",
          }),
          patchExport: { exportPatch: async () => undefined },
        },
      });

      expect(resumed).toMatchObject({
        journalRunId: result.journalRunId,
        runState: "paused",
        pausedBlocker: { kind: "budget_cap" },
        budgetStopped: true,
        patchExportCount: 0,
      });
      expect(resumedCalls.get("__all__")).toBe(1);
      expect(await repository.loadRun(ACTOR, result.journalRunId)).toMatchObject({
        costPolicy: expect.objectContaining({ budgetCapUsd: addedCap }),
      });
      expect(await repository.loadRunCostAccount(ACTOR, result.journalRunId)).toMatchObject({
        capUsd: addedCap,
        spentCostUsd: addedCap,
        reservedCostUsd: "0",
      });
    } finally {
      await context.close();
    }
  });

  it("retains unknown billing conservatively until a later exact settlement reconciles it", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context.pool);
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      const runId = "journal-run-later-cost-settlement";
      const bridgeUnitId = "raw-bridge-unit-later-cost-settlement";
      await repository.seedRun(ACTOR, atomicCostSeed(runId, [bridgeUnitId]));
      const reservation = await repository.reserveAttemptCost(
        ACTOR,
        atomicCostAttempt(runId, bridgeUnitId),
      );
      if (!reservation.admitted) {
        throw new Error("later-settlement fixture unexpectedly denied its reservation");
      }

      const unknownCompletion = atomicCostCompletion(reservation.attempt, {
        failureClass: "provider_network_error",
        retryDecision: "retry",
        validationResult: "semantic_invalid",
      });
      await repository.completeAttempt(ACTOR, {
        ...unknownCompletion,
        modelId: null,
        providerId: null,
        costUsd: null,
        costKind: undefined,
        billingState: "unknown",
        usageResponseJson: { _provider_settlement_pending: true },
      });
      expect(await repository.loadRunCostAccount(ACTOR, runId)).toMatchObject({
        spentCostUsd: "0",
        reservedCostUsd: "0.00000049",
      });

      await repository.reconcileAttemptBilling(ACTOR, {
        runId,
        attemptId: reservation.attempt.attemptId,
        // Extra trailing precision zeros prove this repair path normalizes
        // exact decimal text instead of comparing rounded micros.
        costUsd: "0.000000490",
        modelId: "atomic-cost-model",
        providerId: "atomic-cost-provider",
        usageResponseJson: { cost: "0.00000049" },
      });
      // It is safe for a reconciler retry to repeat the exact settled fact.
      await repository.reconcileAttemptBilling(ACTOR, {
        runId,
        attemptId: reservation.attempt.attemptId,
        costUsd: "0.00000049",
        modelId: "atomic-cost-model",
        providerId: "atomic-cost-provider",
      });

      expect(await repository.loadRunCostAccount(ACTOR, runId)).toMatchObject({
        spentCostUsd: "0.00000049",
        reservedCostUsd: "0",
      });
      expect(await repository.loadCostReservations(ACTOR, runId)).toEqual([
        expect.objectContaining({
          attemptId: reservation.attempt.attemptId,
          state: "reconciled",
          reconciledUsd: "0.00000049",
        }),
      ]);
      expect(await repository.loadAttemptsForRun(ACTOR, runId)).toEqual([
        expect.objectContaining({
          attemptId: reservation.attempt.attemptId,
          billingState: "known",
          costUsd: "0.00000049",
        }),
      ]);
    } finally {
      await context.close();
    }
  });

  it("pauses a real capped executor without a patch, then resumes the same run after a cap raise", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context.pool);
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      const firstCalls = new Map<string, number>();
      const firstPatches: DrivenPatchExportRecord[] = [];
      const first = await runProjectDrivenExecutor({
        ...executorInput(providerFactory(firstCalls, ATOMIC_SUB_MICRO_BILLED_COST)),
        pairPolicy: atomicCostPairPolicy(),
        budgetCapUsd: ATOMIC_COST_INITIAL_CAP_USD,
        sinks: {
          journal: new DrivenJournalPersistenceAdapter(repository, {
            actor: ACTOR,
            driverId: "atomic-cost-first-driver",
          }),
          patchExport: { exportPatch: async (record) => void firstPatches.push(record) },
        },
      });

      expect(first).toMatchObject({
        runState: "paused",
        pausedBlocker: { kind: "budget_cap" },
        patchExportCount: 0,
        budgetStopped: true,
      });
      expect(firstPatches).toEqual([]);
      expect(firstCalls.get("__all__") ?? 0).toBe(2);
      const pausedAccount = await repository.loadRunCostAccount(ACTOR, first.journalRunId);
      expect(pausedAccount).toMatchObject({
        capUsd: "0.00000098",
        spentCostUsd: "0.00000098",
      });
      expect(pausedAccount?.reservedCostUsd).toMatch(/^0(?:\.0+)?$/u);
      expect(await repository.loadAttemptsForRun(ACTOR, first.journalRunId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            billingState: "known",
            costUsd: "0.00000049",
            lifecycleState: "completed",
          }),
        ]),
      );

      // The operator-facing cap raise updates both the durable account and
      // frozen policy before node-3's existing resume path takes a new fence.
      await expect(
        repository.raiseRunCostCap(ACTOR, first.journalRunId, "0.0001"),
      ).resolves.toMatchObject({ capUsd: "0.0001" });
      expect(await repository.loadRun(ACTOR, first.journalRunId)).toMatchObject({
        costPolicy: expect.objectContaining({ budgetCapUsd: "0.0001" }),
      });

      const resumedCalls = new Map<string, number>();
      const resumedPatches: DrivenPatchExportRecord[] = [];
      const resumed = await runProjectDrivenExecutor({
        ...executorInput(providerFactory(resumedCalls, ATOMIC_SUB_MICRO_BILLED_COST)),
        pairPolicy: atomicCostPairPolicy(),
        budgetCapUsd: ATOMIC_COST_RAISED_CAP_USD,
        resumeRunId: first.journalRunId,
        sinks: {
          journal: new DrivenJournalPersistenceAdapter(repository, {
            actor: ACTOR,
            driverId: "atomic-cost-resume-driver",
          }),
          patchExport: { exportPatch: async (record) => void resumedPatches.push(record) },
        },
      });

      expect(resumed).toMatchObject({
        journalRunId: first.journalRunId,
        runState: "running",
        pausedBlocker: null,
        patchExportCount: 1,
      });
      expect(resumedPatches).toHaveLength(1);
      expect(
        (await repository.loadRunUnits(ACTOR, first.journalRunId)).every(
          (unit) => unit.state === "written",
        ),
      ).toBe(true);
      const resumedAccount = await repository.loadRunCostAccount(ACTOR, first.journalRunId);
      expect(resumedAccount).toMatchObject({
        capUsd: "0.0001",
      });
      expect(resumedAccount?.reservedCostUsd).toMatch(/^0(?:\.0+)?$/u);
    } finally {
      await context.close();
    }
  });

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
          if (property === "reserveAttemptCost") {
            return async (
              actor: Parameters<ItotoriLocalizationJournalRepositoryPort["reserveAttemptCost"]>[0],
              input: Parameters<ItotoriLocalizationJournalRepositoryPort["reserveAttemptCost"]>[1],
            ) => {
              const reservation = await target.reserveAttemptCost(actor, input);
              if (!reservation.admitted) return reservation;
              return {
                ...reservation,
                attempt: {
                  ...reservation.attempt,
                  leaseDeadline: { ...reservation.attempt.leaseDeadline, remainingMs: 0 },
                },
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
          if (property === "reserveAttemptCost") {
            return async (
              actor: Parameters<ItotoriLocalizationJournalRepositoryPort["reserveAttemptCost"]>[0],
              input: Parameters<ItotoriLocalizationJournalRepositoryPort["reserveAttemptCost"]>[1],
            ) => {
              const reservation = await target.reserveAttemptCost(actor, input);
              if (!reservation.admitted) return reservation;
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
              return { ...reservation, attempt: { ...reservation.attempt, leaseDeadline } };
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

const ATOMIC_COST_LEASE = { ownerId: "atomic-cost-driver", fenceToken: 1 } as const;
const ATOMIC_COST_INITIAL_CAP_USD = 0.00000098; // itotori-225-audit-allow: focused live-DB fixture cap admits exactly two 0.49-micro reservations before testing atomic budget pause
const ATOMIC_COST_RAISED_CAP_USD = 0.0001; // itotori-225-audit-allow: focused live-DB fixture cap raise leaves room for the complete two-unit executor resume
const ATOMIC_SUB_MICRO_MAX_USD = 0.00000049; // itotori-225-audit-allow: pair-policy fixture exposes an exact sub-micro worst case to the durable reservation seam
const ATOMIC_SUB_MICRO_BILLED_COST: ProviderCost = {
  costKind: "billed",
  currency: "USD",
  amountUsd: "0.00000049", // itotori-225-audit-allow: exact sub-micro billed fixture proves durable decimal accounting does not use the zero micros mirror
  amountMicrosUsd: 0,
};

function atomicCostSeed(runId: string, unitIds: readonly string[]) {
  return {
    runId,
    projectId: PROJECT_ID,
    localeBranchId: BRANCH_ID,
    sourceRevisionId: REVISION_ID,
    targetLocale: "en-US",
    frozenScope: { kind: "explicit_units", bridgeUnitIds: [...unitIds] },
    routingPolicy: { route: "atomic-cost-test" },
    costPolicy: {
      reservation: "atomic_exact_decimal",
      budgetCapUsd: "0.00000098",
    },
    units: unitIds.map((bridgeUnitId) => ({
      bridgeUnitId,
      sourceUnitKey: `scene.${bridgeUnitId}`,
      nextAction: { kind: "drive_unit", stage: "translation" },
    })),
    lease: { ownerId: ATOMIC_COST_LEASE.ownerId },
  };
}

function atomicCostAttempt(runId: string, bridgeUnitId: string) {
  return {
    attemptId: `provider-run-atomic-cost-${bridgeUnitId}`,
    runId,
    bridgeUnitId,
    stage: "translation",
    agentLabel: "atomic-cost-translator",
    logicalCallId: `logical-atomic-cost-${bridgeUnitId}`,
    attemptIndex: 1,
    requestedModelId: "atomic-cost-model",
    requestedProviderId: "atomic-cost-provider",
    zdr: true,
    artifactRef: `provider-run:atomic-cost-${bridgeUnitId}`,
    startedAt: "2026-07-12T12:00:01.000Z",
    lease: ATOMIC_COST_LEASE,
    worstCaseCostUsd: "0.00000049",
  };
}

function atomicCostCompletion(
  attempt: { attemptId: string; runId: string; bridgeUnitId: string },
  terminal: {
    failureClass?: string;
    refusalState?: string;
    retryDecision?: "advance" | "write";
    validationResult?: "accepted" | "semantic_invalid";
  } = {},
) {
  const failed = terminal.failureClass !== undefined;
  return {
    attemptId: attempt.attemptId,
    runId: attempt.runId,
    bridgeUnitId: attempt.bridgeUnitId,
    modelId: "atomic-cost-model",
    providerId: "atomic-cost-provider",
    costUsd: "0.00000049",
    costKind: "billed" as const,
    billingState: "known" as const,
    usageResponseJson: { cost: "0.00000049" },
    tokensIn: 0,
    tokensOut: 0,
    tokenCountSource: "provider_reported",
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheDiscountMicrosUsd: 0,
    fallbackUsed: false,
    fallbackPlan: ["atomic-cost-provider"],
    zdr: true,
    finishState: failed ? "error" : "stop",
    refusalState: terminal.refusalState ?? null,
    validationResult: terminal.validationResult ?? ("accepted" as const),
    failureClass: terminal.failureClass ?? null,
    retryDecision: terminal.retryDecision ?? ("write" as const),
    retryDelayMs: null,
    artifactRef: `provider-run:atomic-cost-${attempt.bridgeUnitId}`,
    errorClasses: failed ? [terminal.failureClass!] : [],
    completedAt: "2026-07-12T12:00:02.000Z",
    lease: ATOMIC_COST_LEASE,
  };
}

function atomicCostPairPolicy(): PairPolicy {
  const withAtomicMax = <T extends { maxPriceUsd: number; maximumBillableCostUsd?: number }>(
    posture: T,
  ): T => ({
    ...posture,
    maxPriceUsd: ATOMIC_SUB_MICRO_MAX_USD,
    maximumBillableCostUsd: ATOMIC_SUB_MICRO_MAX_USD,
  });
  return {
    context: {
      sceneSummary: withAtomicMax(DEV_POLICY.context.sceneSummary),
      characterRelationship: withAtomicMax(DEV_POLICY.context.characterRelationship),
      terminologyCandidate: withAtomicMax(DEV_POLICY.context.terminologyCandidate),
      routeChoiceMap: withAtomicMax(DEV_POLICY.context.routeChoiceMap),
    },
    preTranslation: {
      speakerLabel: withAtomicMax(DEV_POLICY.preTranslation.speakerLabel),
    },
    translation: {
      primary: withAtomicMax(DEV_POLICY.translation.primary),
      ...(DEV_POLICY.translation.regrade === undefined
        ? {}
        : { regrade: withAtomicMax(DEV_POLICY.translation.regrade) }),
    },
    qa: {
      styleAdherence: withAtomicMax(DEV_POLICY.qa.styleAdherence),
      semanticDrift: withAtomicMax(DEV_POLICY.qa.semanticDrift),
      toneRegister: withAtomicMax(DEV_POLICY.qa.toneRegister),
      unresolvedTerminology: withAtomicMax(DEV_POLICY.qa.unresolvedTerminology),
    },
    repair: {
      primary: withAtomicMax(DEV_POLICY.repair.primary),
    },
  };
}

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
    pair: { modelId: DEV_PAIR.modelId, providerId: REQUESTED_PROVIDER_UNKNOWN },
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

function providerFactory(
  calls: Map<string, number>,
  cost?: ProviderCost,
): AgenticLoopProviderFactory {
  return ({ stage, agentLabel }) =>
    new FakeModelProvider({
      providerName: `supervisor-db-${stage}-${agentLabel}`,
      ...(cost === undefined ? {} : { cost }),
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
