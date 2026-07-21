import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ProjectRunLease,
  ProjectRunLiveReadModel,
  ProjectRunProgressStatus,
} from "@itotori/db";
import type { LocalizationRunPlane } from "../composition/localize-entrypoint.js";
import type { ItotoriProjectWorkflowPort } from "../services/project-operations-port.js";
import type { PhysicalAttemptCostObserver } from "../llm/physical-attempt-policy.js";
import type { WorkflowPorts } from "../workflow/index.js";

const PROGRESS_ROLE = "localize";
const LEASE_DURATION_SECONDS = 90;
const LEASE_RENEWAL_INTERVAL_MS = 30_000;

type RunWorkflow = Pick<
  ItotoriProjectWorkflowPort,
  | "createRun"
  | "acquireLease"
  | "renewLease"
  | "releaseLease"
  | "advanceRun"
  | "recordProgress"
  | "reserveCost"
  | "settleCost"
  | "loadLiveReadModel"
>;

type CostScope = {
  readonly unitIds: readonly string[];
  readonly failureStage: string;
};

type CostReservation = CostScope & {
  readonly reservationId: string;
};

const statusRank: Record<ProjectRunProgressStatus, number> = {
  decoded: 1,
  drafted: 2,
  QA: 3,
  accepted: 4,
  patched: 5,
};

/**
 * Couples the workflow's real port completions and physical LLM attempts to one
 * durable project run. It deliberately has no engine knowledge: project/run
 * identity, snapshots, and exposure ceiling arrive as data from the live
 * substrate.
 */
export class LocalizeRunTracker {
  readonly #costScopes = new AsyncLocalStorage<CostScope>();
  readonly #reservations = new Map<string, CostReservation>();
  readonly #statusByUnit = new Map<string, ProjectRunProgressStatus>();
  readonly #costByUnit = new Map<string, number>();
  /** Every durable progress/cost write is retained here until it settles. The
   * terminal run transition must not race a callback that still owns the DB
   * service scope. */
  readonly #pendingWrites = new Set<Promise<void>>();
  #lease: ProjectRunLease | undefined;
  #renewalTimer: ReturnType<typeof setInterval> | undefined;
  #renewal: Promise<void> | undefined;
  #renewalError: unknown;
  #acceptingWrites = true;
  #finished = false;

  constructor(
    private readonly workflow: RunWorkflow,
    private readonly plane: LocalizationRunPlane,
  ) {}

  async start(unitIds: readonly string[]): Promise<void> {
    await this.workflow.createRun({
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
      leaseDurationSeconds: LEASE_DURATION_SECONDS,
    });
    await this.workflow.advanceRun({ lease: this.lease(), status: "running" });
    this.startLeaseRenewal();
    await Promise.all([...new Set(unitIds)].map((unitId) => this.record(unitId, "decoded")));
  }

  /** The observer reaches the exact physical-attempt boundary; memo hits do not
   * invoke it, so a replay never creates a synthetic reservation or cost. */
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
          // This is a measured profile upper bound used solely to enforce the
          // cap before dispatch; it is never reported as spent progress.
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
      if (execution.billing.status !== "confirmed") {
        throw new Error("localize run refused an LLM step without provider-confirmed billed cost");
      }
      const settledMicrosUsd = exactMicrosUsd(execution.billing.costUsd, "provider billed cost");
      await this.trackWrite(async () => {
        await this.workflow.settleCost({ lease: this.lease(), reservationId, settledMicrosUsd });
      });
      this.#reservations.delete(reservationId);
      for (const [unitId, amount] of allocateMicros(settledMicrosUsd, reservation.unitIds)) {
        this.#costByUnit.set(unitId, (this.#costByUnit.get(unitId) ?? 0) + amount);
      }
    },
  };

  /** Wrap only the workflow boundaries whose successful completion proves a
   * concrete per-unit transition. No end-of-run fill is performed. */
  wrapPorts(ports: WorkflowPorts): WorkflowPorts {
    return {
      ...ports,
      readiness: {
        resolve: async (unitId) =>
          await this.withFailure([unitId], "readiness", () => ports.readiness.resolve(unitId)),
      },
      draft: {
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
      },
      store: {
        readUnitHead: async (unitId, stage) => {
          const head = await ports.store.readUnitHead(unitId, stage);
          if (stage === "final" && head !== null) await this.record(unitId, "accepted");
          return head;
        },
        finalizeUnit: async (input) => {
          const ref = await ports.store.finalizeUnit(input);
          if (input.stage === "final") await this.record(input.unitId, "accepted");
          return ref;
        },
        runMemoizedStep: async (memoKey, produce) =>
          await ports.store.runMemoizedStep(memoKey, produce),
        attemptLineage: () => ports.store.attemptLineage(),
      },
    };
  }

  async complete(): Promise<ProjectRunLiveReadModel | null> {
    return await this.finish("completed");
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
    return await this.#costScopes.run({ unitIds, failureStage }, async () => {
      try {
        if (transitionAt === "before") {
          await Promise.all(unitIds.map((unitId) => this.record(unitId, status)));
        }
        const value = await operation();
        if (transitionAt === "after") {
          await Promise.all(unitIds.map((unitId) => this.record(unitId, status)));
        }
        return value;
      } catch (error: unknown) {
        await this.recordFailure(unitIds, failureStage);
        throw error;
      }
    });
  }

  private async withScope<T>(
    unitIds: readonly string[],
    failureStage: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return await this.#costScopes.run({ unitIds, failureStage }, async () => {
      try {
        return await operation();
      } catch (error: unknown) {
        await this.recordFailure(unitIds, failureStage);
        throw error;
      }
    });
  }

  private async withFailure<T>(
    unitIds: readonly string[],
    failureStage: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      await this.recordFailure(unitIds, failureStage);
      throw error;
    }
  }

  private async recordFailure(unitIds: readonly string[], stage: string): Promise<void> {
    await Promise.all(
      unitIds.map(
        async (unitId) =>
          await this.record(unitId, this.#statusByUnit.get(unitId) ?? "decoded", [
            `${stage}-failed`,
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
        // Coverage means actual completion of this unit's CURRENT stage. A unit
        // is not called covered until the corresponding port has returned.
        coveragePercent: nextStatus === "decoded" ? 0 : 100,
        blockers,
      });
    });
    this.#statusByUnit.set(unitId, nextStatus);
  }

  private async finish(status: "completed" | "failed"): Promise<ProjectRunLiveReadModel | null> {
    this.stopLeaseRenewal();
    await this.#renewal;
    // The workflow and physical-attempt boundary await their callbacks. Closing
    // this gate makes a broken detached callback fail before it can touch the
    // service, and the drain covers every callback that began before the gate.
    this.#acceptingWrites = false;
    await this.drainWrites();
    try {
      await this.workflow.advanceRun({ lease: this.lease(), status });
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

  private lease(): ProjectRunLease {
    if (this.#lease === undefined) throw new Error("localize run lease was not acquired");
    return this.#lease;
  }

  private startLeaseRenewal(): void {
    this.#renewalTimer = setInterval(() => {
      if (this.#renewal !== undefined) return;
      this.#renewal = this.workflow
        .renewLease({ lease: this.lease(), leaseDurationSeconds: LEASE_DURATION_SECONDS })
        .then((lease) => {
          this.#lease = lease;
        })
        .catch((error: unknown) => {
          this.#renewalError = error;
        })
        .finally(() => {
          this.#renewal = undefined;
        });
    }, LEASE_RENEWAL_INTERVAL_MS);
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
}

function reservationIdFor(memoKey: string, ordinal: number): string {
  return `llm:${memoKey}:${ordinal}`;
}

/** Reject fractional micros rather than inventing a rounded billed amount. */
function exactMicrosUsd(value: string, label: string): number {
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(value);
  if (match === null || (match[2]?.length ?? 0) > 6) {
    throw new Error(`${label} is not representable in whole micros-USD`);
  }
  const whole = Number(match[1]);
  const fraction = `${match[2] ?? ""}${"0".repeat(6 - (match[2]?.length ?? 0))}`;
  const micros = whole * 1_000_000 + Number(fraction);
  if (!Number.isSafeInteger(micros)) throw new Error(`${label} is outside the project-run range`);
  return micros;
}

function ceilingMicrosUsd(value: string, label: string): number {
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(value);
  if (match === null || (match[2]?.length ?? 0) > 18) {
    throw new Error(`${label} must be a non-negative decimal USD value`);
  }
  const whole = Number(match[1]);
  const fraction = match[2] ?? "";
  const micros =
    whole * 1_000_000 +
    Number(`${fraction.slice(0, 6)}${"0".repeat(Math.max(0, 6 - fraction.length))}`);
  if (!Number.isSafeInteger(micros)) throw new Error(`${label} is outside the project-run range`);
  return micros + (Number(fraction.slice(6) || "0") === 0 ? 0 : 1);
}

/** Spread one real physical-call charge deterministically across the units that
 * actually shared that call. The allocations always sum to the billed micros. */
function allocateMicros(amount: number, unitIds: readonly string[]): ReadonlyMap<string, number> {
  const ids = [...new Set(unitIds)].sort();
  if (ids.length === 0 || amount === 0) return new Map();
  const each = Math.floor(amount / ids.length);
  const remainder = amount % ids.length;
  return new Map(ids.map((unitId, index) => [unitId, each + (index < remainder ? 1 : 0)]));
}
