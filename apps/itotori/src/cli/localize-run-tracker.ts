import { AsyncLocalStorage } from "node:async_hooks";
import {
  type ProjectRunLease,
  type ProjectRunLiveReadModel,
  type ProjectRunProgressStatus,
} from "@itotori/db";
import type { LocalizationRunPlane } from "../composition/localize-entrypoint.js";
import type { PhysicalAttemptCostObserver } from "../llm/physical-attempt-policy.js";
import type { WorkflowPorts } from "../workflow/index.js";
import { localizeFailureBlocker } from "./localize-failure-blocker.js";
import {
  allocateMicros,
  ceilingMicrosUsd,
  exactMicrosUsd,
  reservationIdFor,
  terminalAttemptBlocker,
} from "./localize-run-cost.js";
import {
  type CostReservation,
  type CostScope,
  type RunWorkflow,
  statusRank,
} from "./localize-run-tracker-state.js";
import {
  isLocalizationPassPause,
  LocalizationPassPausedError,
} from "../services/localization-pass-control.js";

const PROGRESS_ROLE = "localize";
const LEASE_DURATION_SECONDS = 90;
const LEASE_RENEWAL_INTERVAL_MS = 30_000;
export const STARTUP_PROGRESS_BATCH_SIZE = 500;
export type LocalizeRunTrackerTiming = {
  readonly leaseDurationSeconds?: number;
  readonly leaseRenewalIntervalMs?: number;
};
export class LocalizeRunTracker {
  readonly #costScopes = new AsyncLocalStorage<CostScope>();
  readonly #reservations = new Map<string, CostReservation>();
  readonly #statusByUnit = new Map<string, ProjectRunProgressStatus>();
  readonly #costByUnit = new Map<string, number>();
  readonly #failureBlockerByUnit = new Map<string, string>();
  /** Writes must settle before the terminal transition. */
  readonly #pendingWrites = new Set<Promise<void>>();
  /** Pause waits for every fanned-out workflow operation to observe abort. */
  readonly #pendingOperations = new Set<Promise<unknown>>();
  #lease: ProjectRunLease | undefined;
  #renewalTimer: ReturnType<typeof setInterval> | undefined;
  #renewal: Promise<void> | undefined;
  #renewalError: unknown;
  #acceptingWrites = true;
  #finished = false;
  constructor(
    private readonly workflow: RunWorkflow,
    private readonly plane: LocalizationRunPlane,
    private readonly timing: LocalizeRunTrackerTiming = {},
    private readonly pauseSignal?: AbortSignal,
  ) {}
  async start(unitIds: readonly string[]): Promise<void> {
    await this.workflow.createOrResumeRun({
      projectId: this.plane.projectId,
      runId: this.plane.runId,
      localeBranchId: this.plane.localeBranchId,
      contextSnapshotId: this.plane.contextSnapshotId,
      localizationSnapshotId: this.plane.localizationSnapshotId,
      capMicrosUsd: this.plane.capMicrosUsd,
    });
    this.#lease = await this.workflow.acquireLease({
      projectId: this.plane.projectId,
      runId: this.plane.runId,
      leaseOwnerId: this.plane.leaseOwnerId,
      leaseDurationSeconds: this.timing.leaseDurationSeconds ?? LEASE_DURATION_SECONDS,
    });
    await this.workflow.advanceRun({ lease: this.lease(), status: "running" });
    this.startLeaseRenewal();
    const uniqueUnitIds = [...new Set(unitIds)];
    for (let start = 0; start < uniqueUnitIds.length; start += STARTUP_PROGRESS_BATCH_SIZE) {
      await this.recordStartupBatch(
        uniqueUnitIds.slice(start, start + STARTUP_PROGRESS_BATCH_SIZE),
      );
    }
  }

  readonly costObserver: PhysicalAttemptCostObserver = {
    onAttemptStarted: async ({ memoKey, attempt, maxAttemptExposureUsd }) => {
      const scope = this.#costScopes.getStore();
      if (scope === undefined) return;
      this.assertWritesOpen();
      this.assertLeaseHealthy();
      const reservationId = reservationIdFor(memoKey, attempt.ordinal);
      await this.trackWrite(async () => {
        await this.workflow.reserveCost({
          lease: this.lease(),
          reservationId,
          reservedMicrosUsd: ceilingMicrosUsd(maxAttemptExposureUsd, "max attempt exposure"),
        });
      });
      this.#reservations.set(reservationId, { ...scope, reservationId });
    },
    onAttemptCompleted: async ({ memoKey, attempt, execution }) => {
      const reservationId = reservationIdFor(memoKey, attempt.ordinal);
      const reservation = this.#reservations.get(reservationId);
      if (reservation === undefined) return;
      this.assertWritesOpen();
      if (execution.kind === "completed" && execution.billing.status === "confirmed") {
        const settledMicrosUsd = exactMicrosUsd(execution.billing.costUsd, "provider billed cost");
        await this.trackWrite(async () => {
          await this.workflow.settleCost({ lease: this.lease(), reservationId, settledMicrosUsd });
        });
        this.#reservations.delete(reservationId);
        for (const [unitId, amount] of allocateMicros(settledMicrosUsd, reservation.unitIds)) {
          this.#costByUnit.set(unitId, (this.#costByUnit.get(unitId) ?? 0) + amount);
        }
        return;
      }
      await this.trackWrite(async () => {
        await this.workflow.releaseCost({ lease: this.lease(), reservationId });
      });
      this.#reservations.delete(reservationId);
      const blocker = terminalAttemptBlocker(execution);
      for (const unitId of reservation.unitIds) this.#failureBlockerByUnit.set(unitId, blocker);
      if (execution.kind === "incomplete") return;
      throw new Error("localize run refused an LLM step without provider-confirmed billed cost");
    },
  };

  wrapPorts(ports: WorkflowPorts): WorkflowPorts {
    const hydrateBuildLqaEvidence = ports.patchback.hydrateBuildLqaEvidence;
    const recordFinalizationData = ports.draft.recordFinalizationData;
    return {
      ...ports,
      memoIdentity: ports.memoIdentity,
      readiness: {
        resolve: async (unitId) =>
          await this.withFailure([unitId], "readiness", () => ports.readiness.resolve(unitId)),
      },
      draft: {
        ...(recordFinalizationData === undefined ? {} : { recordFinalizationData }),
        draftScene: async (input) =>
          await this.withTransition(
            input.scene.units.map((unit) => unit.unitId),
            "draft",
            "drafted",
            () => ports.draft.draftScene(input),
          ),
      },
      gates: {
        evaluate: async (scene) =>
          await this.withFailure(
            scene.units.map((unit) => unit.unitId),
            "deterministic-gates",
            () => ports.gates.evaluate(scene),
          ),
      },
      review: {
        review: async (input) =>
          // The initial stratified-review dispatch supplies its selected drafted
          // units in `input.unitIds` (correction reruns use the same field).
          // QA is the state entered by the review role, so persist it before a
          // reviewer can block and, critically, before the workflow can accept
          // the unit after that review returns.
          await this.withTransition(
            input.unitIds,
            "QA",
            "QA",
            () => ports.review.review(input),
            "before",
          ),
      },
      repair: {
        lineEdit: async (input) =>
          await this.withScope(input.unitIds, "repair", () => ports.repair.lineEdit(input)),
        semanticRepair: async (input) =>
          await this.withScope(input.unitIds, "repair", () => ports.repair.semanticRepair(input)),
      },
      adjudicate: {
        adjudicate: async (input) =>
          await this.withScope([input.unitId], "adjudication", () =>
            ports.adjudicate.adjudicate(input),
          ),
      },
      patchback: {
        exportPatch: async (input) =>
          await this.withTransition(
            input.finalized.map((unit) => unit.unitId),
            "patch",
            "patched",
            () => ports.patchback.exportPatch(input),
          ),
        buildLqaReview: async (input) =>
          await this.withScope(input.unitIds, "build-lqa", () =>
            ports.patchback.buildLqaReview(input),
          ),
        ...(hydrateBuildLqaEvidence === undefined
          ? {}
          : {
              hydrateBuildLqaEvidence: async (input) =>
                await this.withScope(
                  input.unitIds,
                  "build-lqa",
                  async () => await hydrateBuildLqaEvidence(input),
                ),
            }),
      },
      store: {
        readUnitHead: async (unitId, stage) =>
          await this.guardOperation(async () => {
            const head = await ports.store.readUnitHead(unitId, stage);
            if (stage === "final" && head !== null) await this.record(unitId, "accepted");
            return head;
          }),
        finalizeUnit: async (input) =>
          await this.guardOperation(async () => {
            const ref = await ports.store.finalizeUnit(input);
            if (input.stage === "final") await this.record(input.unitId, "accepted");
            return ref;
          }),
        runMemoizedStep: async (memoKey, produce) =>
          await this.guardOperation(
            async () => await ports.store.runMemoizedStep(memoKey, produce),
          ),
        attemptLineage: () => ports.store.attemptLineage(),
      },
    };
  }

  async complete(): Promise<ProjectRunLiveReadModel | null> {
    return await this.finish("completed");
  }

  async pause(): Promise<ProjectRunLiveReadModel | null> {
    if (this.#lease === undefined || this.#finished) {
      return await this.workflow.loadLiveReadModel(this.plane.projectId, this.plane.runId);
    }
    return await this.finish("paused");
  }

  async fail(): Promise<void> {
    if (this.#lease === undefined || this.#finished) return;
    await this.finish("failed");
  }

  private async withTransition<T>(
    unitIds: readonly string[],
    failureStage: string,
    status: ProjectRunProgressStatus,
    operation: () => Promise<T>,
    transitionAt: "before" | "after" = "after",
  ): Promise<T> {
    return await this.trackOperation(
      async () =>
        await this.#costScopes.run({ unitIds, failureStage }, async () => {
          try {
            this.throwIfPaused();
            if (transitionAt === "before") {
              await Promise.all(unitIds.map((unitId) => this.record(unitId, status)));
            }
            const value = await operation();
            this.throwIfPaused();
            if (transitionAt === "after") {
              await Promise.all(unitIds.map((unitId) => this.record(unitId, status)));
            }
            return value;
          } catch (error: unknown) {
            if (isLocalizationPassPause(this.pauseSignal)) {
              throw new LocalizationPassPausedError(this.plane.runId);
            }
            await this.recordFailure(unitIds, failureStage, error);
            throw error;
          }
        }),
    );
  }

  private async withScope<T>(
    unitIds: readonly string[],
    failureStage: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return await this.trackOperation(
      async () =>
        await this.#costScopes.run({ unitIds, failureStage }, async () => {
          try {
            this.throwIfPaused();
            const value = await operation();
            this.throwIfPaused();
            return value;
          } catch (error: unknown) {
            if (isLocalizationPassPause(this.pauseSignal)) {
              throw new LocalizationPassPausedError(this.plane.runId);
            }
            await this.recordFailure(unitIds, failureStage, error);
            throw error;
          }
        }),
    );
  }

  private async withFailure<T>(
    unitIds: readonly string[],
    failureStage: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return await this.trackOperation(async () => {
      try {
        this.throwIfPaused();
        const value = await operation();
        this.throwIfPaused();
        return value;
      } catch (error: unknown) {
        if (isLocalizationPassPause(this.pauseSignal)) {
          throw new LocalizationPassPausedError(this.plane.runId);
        }
        await this.recordFailure(unitIds, failureStage, error);
        throw error;
      }
    });
  }

  private async recordFailure(
    unitIds: readonly string[],
    stage: string,
    error: unknown,
  ): Promise<void> {
    await Promise.all(
      unitIds.map(
        async (unitId) =>
          await this.record(unitId, this.#statusByUnit.get(unitId) ?? "decoded", [
            this.#failureBlockerByUnit.get(unitId) ?? localizeFailureBlocker(stage, error),
          ]),
      ),
    );
  }

  private async record(
    unitId: string,
    nextStatus: ProjectRunProgressStatus,
    blockers: readonly string[] = [],
  ): Promise<void> {
    this.assertWritesOpen();
    this.assertLeaseHealthy();
    const previous = this.#statusByUnit.get(unitId);
    if (previous !== undefined && statusRank[previous] > statusRank[nextStatus]) return;
    await this.trackWrite(async () => {
      await this.workflow.recordProgress({
        lease: this.lease(),
        bridgeUnitId: unitId,
        role: PROGRESS_ROLE,
        status: nextStatus,
        costMicrosUsd: this.#costByUnit.get(unitId) ?? 0,
        coveragePercent: nextStatus === "decoded" ? 0 : 100,
        blockers,
      });
    });
    this.#statusByUnit.set(unitId, nextStatus);
  }

  /** Startup uses bounded inserts; narrow test doubles retain the per-unit fallback. */
  private async recordStartupBatch(unitIds: readonly string[]): Promise<void> {
    const workflow = this.workflow;
    const recordProgressBatch = workflow.recordProgressBatch;
    if (recordProgressBatch !== undefined) {
      const initialStatus: ProjectRunProgressStatus = "decoded";
      await this.trackWrite(async () => {
        const progress = await recordProgressBatch.call(workflow, {
          lease: this.lease(),
          progress: unitIds.map((bridgeUnitId) => ({
            bridgeUnitId,
            role: PROGRESS_ROLE,
            status: initialStatus,
            costMicrosUsd: 0,
            coveragePercent: 0,
            blockers: [],
          })),
        });
        for (const entry of progress) this.#statusByUnit.set(entry.bridgeUnitId, entry.status);
        for (const entry of progress) this.#costByUnit.set(entry.bridgeUnitId, entry.costMicrosUsd);
      });
      return;
    }
    await Promise.all(unitIds.map(async (unitId) => await this.record(unitId, "decoded")));
  }

  private async finish(
    status: "completed" | "failed" | "paused",
  ): Promise<ProjectRunLiveReadModel | null> {
    this.stopLeaseRenewal();
    await this.#renewal;
    await this.drainOperations();
    // Close the gate and drain callbacks before the terminal transition.
    this.#acceptingWrites = false;
    await this.drainWrites();
    try {
      await this.workflow.advanceRun({ lease: this.lease(), status });
    } catch (error: unknown) {
      if (status === "completed") {
        await this.workflow.advanceRun({ lease: this.lease(), status: "failed" });
      }
      throw error;
    } finally {
      await this.workflow.releaseLease(this.lease());
      this.#finished = true;
    }
    return await this.workflow.loadLiveReadModel(this.plane.projectId, this.plane.runId);
  }

  private async trackWrite(write: () => Promise<void>): Promise<void> {
    this.assertWritesOpen();
    let pending!: Promise<void>;
    pending = Promise.resolve()
      .then(write)
      .finally(() => {
        this.#pendingWrites.delete(pending);
      });
    this.#pendingWrites.add(pending);
    await pending;
  }

  private async drainWrites(): Promise<void> {
    // A callback can enqueue another write while its predecessor settles (for
    // example, a cost settlement followed by its progress update). Snapshot and
    // repeat until the run owns no durable progress/cost work.
    while (this.#pendingWrites.size > 0) {
      await Promise.all(this.#pendingWrites);
    }
  }

  private async trackOperation<T>(operation: () => Promise<T>): Promise<T> {
    let pending!: Promise<T>;
    pending = Promise.resolve()
      .then(operation)
      .finally(() => {
        this.#pendingOperations.delete(pending);
      });
    this.#pendingOperations.add(pending);
    return await pending;
  }

  private async drainOperations(): Promise<void> {
    while (this.#pendingOperations.size > 0) {
      await Promise.allSettled(this.#pendingOperations);
    }
  }

  private async guardOperation<T>(operation: () => Promise<T>): Promise<T> {
    return await this.trackOperation(async () => {
      this.throwIfPaused();
      const value = await operation();
      this.throwIfPaused();
      return value;
    });
  }

  private lease(): ProjectRunLease {
    if (this.#lease === undefined) throw new Error("localize run lease was not acquired");
    return this.#lease;
  }

  private startLeaseRenewal(): void {
    this.#renewalTimer = setInterval(() => {
      if (this.#renewal !== undefined) return;
      this.#renewal = this.workflow
        .renewLease({
          lease: this.lease(),
          leaseDurationSeconds: this.timing.leaseDurationSeconds ?? LEASE_DURATION_SECONDS,
        })
        .then((lease) => {
          this.#lease = lease;
        })
        .catch((error: unknown) => {
          this.#renewalError = error;
        })
        .finally(() => {
          this.#renewal = undefined;
        });
    }, this.timing.leaseRenewalIntervalMs ?? LEASE_RENEWAL_INTERVAL_MS);
    this.#renewalTimer.unref?.();
  }

  private stopLeaseRenewal(): void {
    if (this.#renewalTimer !== undefined) clearInterval(this.#renewalTimer);
    this.#renewalTimer = undefined;
  }

  private assertLeaseHealthy(): void {
    if (this.#renewalError !== undefined) throw this.#renewalError;
  }

  private assertWritesOpen(): void {
    if (!this.#acceptingWrites) {
      throw new Error("localize run progress/cost writer was used after the run finished");
    }
  }

  private throwIfPaused(): void {
    if (isLocalizationPassPause(this.pauseSignal)) {
      throw new LocalizationPassPausedError(this.plane.runId);
    }
  }
}
