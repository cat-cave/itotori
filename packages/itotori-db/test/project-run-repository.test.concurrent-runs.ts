import { describe, expect, it } from "vitest";
import { LocalizeRunTracker } from "../../../apps/itotori/src/cli/localize-run-tracker.js";
import {
  listProjectRunDashboardRuns,
  listProjectRunPortfolioProgress,
  loadProjectRunLiveReadModel,
} from "../src/index.js";
import {
  ItotoriProjectRunCostCapError,
  ItotoriProjectRunRepository,
  ItotoriProjectRunRepositoryError,
} from "../src/repositories/project-run-repository.js";
import {
  actor,
  addRunBranch,
  leaseInput,
  progressInput,
  runFixture,
  runInput,
  type RunFixture,
} from "./project-run-test-fixtures.js";

describe("ItotoriProjectRunRepository", () => {
  it("isolates concurrent run costs, progress, caps, and leases across project branches", async () => {
    const fixture = await runFixture("isolation");
    try {
      const secondBranch = await addRunBranch(fixture, "isolation-second");
      await fixture.runs.createRun(actor, runInput(fixture, "run-isolation-one", 100));
      await fixture.runs.createRun(actor, runInput(fixture, "run-isolation-two", 30, secondBranch));
      const firstLease = await fixture.runs.acquireLease(
        actor,
        leaseInput(fixture, "run-isolation-one", "driver-one"),
      );
      const secondLease = await fixture.runs.acquireLease(
        actor,
        leaseInput(fixture, "run-isolation-two", "driver-two"),
      );

      await fixture.runs.reserveCost(actor, {
        lease: firstLease,
        reservationId: "reservation-isolation",
        reservedMicrosUsd: 60,
      });
      await fixture.runs.recordProgress(
        actor,
        progressInput(firstLease, "unit-one", "writer", "drafted", 9, 55, ["needs review"]),
      );
      await fixture.runs.reserveCost(actor, {
        lease: secondLease,
        reservationId: "reservation-isolation",
        reservedMicrosUsd: 20,
      });
      await fixture.runs.settleCost(actor, {
        lease: secondLease,
        reservationId: "reservation-isolation",
        settledMicrosUsd: 15,
      });

      const first = await fixture.runs.loadLiveReadModel(
        actor,
        fixture.projectId,
        "run-isolation-one",
      );
      const second = await fixture.runs.loadLiveReadModel(
        actor,
        fixture.projectId,
        "run-isolation-two",
      );
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(first?.run.localeBranchId).toBe(fixture.localeBranchId);
      expect(second?.run.localeBranchId).toBe(secondBranch.localeBranchId);
      expect(first?.run.cost).toEqual({
        capMicrosUsd: 100,
        spentMicrosUsd: 0,
        reservedMicrosUsd: 60,
      });
      expect(second?.run.cost).toEqual({
        capMicrosUsd: 30,
        spentMicrosUsd: 15,
        reservedMicrosUsd: 0,
      });
      expect(first?.run.leaseOwnerId).toBe("driver-one");
      expect(second?.run.leaseOwnerId).toBe("driver-two");
      expect(first?.progress.unitCount).toBe(1);
      expect(second?.progress.unitCount).toBe(0);
    } finally {
      await fixture.context.close();
    }
  });

  it("names the active-run constraint and row identity when a retry collides", async () => {
    const fixture = await runFixture("active-branch");
    try {
      await fixture.runs.createRun(actor, runInput(fixture, "run-active-first", 100));

      await expect(
        fixture.runs.createRun(actor, runInput(fixture, "run-active-second", 100)),
      ).rejects.toThrow(
        `project run collision: constraint 'itotori_project_runs_one_active_branch_idx' rejected project '${fixture.projectId}', run 'run-active-second'`,
      );
    } finally {
      await fixture.context.close();
    }
  });

  it("names the primary-key constraint and recovery action when a run ID is reused", async () => {
    const fixture = await runFixture("run-id-collision");
    try {
      await fixture.runs.createRun(actor, runInput(fixture, "run-reused", 100));
      const lease = await fixture.runs.acquireLease(
        actor,
        leaseInput(fixture, "run-reused", "driver"),
      );
      await fixture.runs.advanceRun(actor, { lease, status: "running" });
      await fixture.runs.advanceRun(actor, { lease, status: "completed" });
      await fixture.runs.releaseLease(actor, lease);

      await expect(
        fixture.runs.createRun(actor, runInput(fixture, "run-reused", 100)),
      ).rejects.toThrow(
        `project run-id collision: constraint 'itotori_project_runs_pkey' rejected project '${fixture.projectId}', run 'run-reused'. This run ID already exists; choose a new run ID, or resume the existing run.`,
      );
    } finally {
      await fixture.context.close();
    }
  });

  it("names the snapshot-binding trigger and attempted branch when the snapshot belongs elsewhere", async () => {
    const fixture = await runFixture("foreign-key-diagnostic");
    try {
      await expect(
        fixture.runs.createRun(actor, {
          ...runInput(fixture, "run-missing-branch", 100),
          localeBranchId: "missing-branch",
        }),
      ).rejects.toThrow(
        `project run snapshot-binding rejection: trigger 'itotori_validate_project_run_snapshot_binding' rejected project '${fixture.projectId}', run 'run-missing-branch' on locale branch 'missing-branch'. The localization snapshot is bound to a different locale branch; verify the run's locale branch matches its localization snapshot before retrying.`,
      );
    } finally {
      await fixture.context.close();
    }
  });

  it("preserves forward unit-role progress and returns the live UI read model", async () => {
    const fixture = await runFixture("progress");
    try {
      await fixture.runs.createRun(actor, runInput(fixture, "run-progress", 200));
      const lease = await fixture.runs.acquireLease(
        actor,
        leaseInput(fixture, "run-progress", "driver-progress"),
      );
      await fixture.runs.recordProgress(
        actor,
        progressInput(lease, "unit-a", "writer", "decoded", 1, 20),
      );
      await fixture.runs.recordProgress(
        actor,
        progressInput(lease, "unit-a", "writer", "drafted", 4, 60, ["terminology"]),
      );
      await fixture.runs.recordProgress(
        actor,
        progressInput(lease, "unit-a", "reviewer", "QA", 3, 80),
      );
      await fixture.runs.recordProgress(
        actor,
        progressInput(lease, "unit-c", "reviewer", "accepted", 2, 100),
      );
      await fixture.runs.recordProgress(
        actor,
        progressInput(lease, "unit-d", "patcher", "patched", 7, 100),
      );
      await expect(
        fixture.runs.recordProgress(
          actor,
          progressInput(lease, "unit-a", "writer", "decoded", 1, 20),
        ),
      ).rejects.toMatchObject({
        code: "progress_regression",
      } satisfies Partial<ItotoriProjectRunRepositoryError>);

      const defaultLive = await fixture.runs.loadLiveReadModel(
        actor,
        fixture.projectId,
        "run-progress",
      );
      expect(defaultLive).not.toHaveProperty("unitPage");
      expect(defaultLive).not.toHaveProperty("blockerPage");
      expect(defaultLive?.progress).not.toHaveProperty("units");
      expect(defaultLive?.progress).not.toHaveProperty("blockers");
      const live = await fixture.runs.loadLiveReadModel(actor, fixture.projectId, "run-progress", {
        unitPage: { limit: 2, offset: 1 },
        blockerPage: { limit: 1, offset: 0 },
      });
      expect(live?.schemaVersion).toBe("itotori.project-run.live.v1");
      expect(live?.progress.statusCounts).toEqual({
        decoded: 0,
        drafted: 1,
        QA: 1,
        accepted: 1,
        patched: 1,
      });
      expect(live?.progress.totalCostMicrosUsd).toBe(16);
      expect(live?.progress.averageCoveragePercent).toBe(85);
      expect(live?.progress).toMatchObject({ unitCount: 4, blockerCount: 1 });
      expect(live?.unitPage).toMatchObject({ total: 4, limit: 2, offset: 1 });
      expect(live?.unitPage?.items).toHaveLength(2);
      expect(live?.blockerPage).toEqual({
        total: 1,
        limit: 1,
        offset: 0,
        items: [{ bridgeUnitId: "unit-a", role: "writer", blockers: ["terminology"] }],
      });
    } finally {
      await fixture.context.close();
    }
  });

  it("keeps three 80k-run read models aggregate until a detail page is requested", async () => {
    const fixture = await runFixture("scale-bounds");
    let trackers: LocalizeRunTracker[] = [];
    try {
      const branches = await Promise.all([
        addRunBranch(fixture, "scale-bounds-two"),
        addRunBranch(fixture, "scale-bounds-three"),
      ]);
      const runs = [fixture, ...branches].map((branch, index) => ({
        runId: `run-scale-${index + 1}`,
        branch,
        owner: `scale-owner-${index + 1}`,
      }));
      trackers = runs.map(
        ({ runId, branch, owner }) =>
          new LocalizeRunTracker(runWorkflow(fixture), {
            ...runInput(fixture, runId, 1_000_000, branch),
            leaseOwnerId: owner,
          }),
      );
      await Promise.all(
        trackers.map(
          async (tracker, index) =>
            await tracker.start(
              Array.from(
                { length: 80_000 },
                (_, unitIndex) => `run-${index + 1}-unit-${unitIndex}`,
              ),
            ),
        ),
      );

      const models = await Promise.all(
        runs.map(
          async ({ runId }) =>
            await fixture.runs.loadLiveReadModel(actor, fixture.projectId, runId),
        ),
      );
      for (const model of models) {
        expect(model?.progress).toMatchObject({
          unitCount: 80_000,
          blockerCount: 0,
          statusCounts: { decoded: 80_000 },
        });
        expect(model).not.toHaveProperty("unitPage");
        expect(model?.progress).not.toHaveProperty("units");
      }
      const page = await fixture.runs.loadLiveReadModel(actor, fixture.projectId, runs[0]!.runId, {
        unitPage: { limit: 100, offset: 79_900 },
      });
      expect(page?.unitPage).toMatchObject({ total: 80_000, limit: 100, offset: 79_900 });
      expect(page?.unitPage?.items).toHaveLength(100);
    } finally {
      await Promise.allSettled(trackers.map(async (tracker) => await tracker.fail()));
      await fixture.context.close();
    }
  }, 120_000);

  it("reserves before dispatch, enforces the run cap, and settles into the isolated account", async () => {
    const fixture = await runFixture("cost");
    try {
      await fixture.runs.createRun(actor, runInput(fixture, "run-cost", 100));
      const lease = await fixture.runs.acquireLease(
        actor,
        leaseInput(fixture, "run-cost", "driver-cost"),
      );
      await fixture.runs.reserveCost(actor, {
        lease,
        reservationId: "reservation-cost-a",
        reservedMicrosUsd: 60,
      });
      await expect(
        fixture.runs.reserveCost(actor, {
          lease,
          reservationId: "reservation-cost-b",
          reservedMicrosUsd: 41,
        }),
      ).rejects.toMatchObject({
        code: "cost_cap_exceeded",
        capMicrosUsd: 100,
        spentMicrosUsd: 0,
        reservedMicrosUsd: 60,
        requestedMicrosUsd: 41,
        remainingMicrosUsd: 40,
      } satisfies Partial<ItotoriProjectRunCostCapError>);
      const settled = await fixture.runs.settleCost(actor, {
        lease,
        reservationId: "reservation-cost-a",
        settledMicrosUsd: 55,
      });
      expect(settled).toMatchObject({ state: "settled", settledMicrosUsd: 55 });
      await fixture.runs.reserveCost(actor, {
        lease,
        reservationId: "reservation-cost-c",
        reservedMicrosUsd: 45,
      });
      const live = await fixture.runs.loadLiveReadModel(actor, fixture.projectId, "run-cost");
      expect(live?.run.cost).toEqual({
        capMicrosUsd: 100,
        spentMicrosUsd: 55,
        reservedMicrosUsd: 45,
      });
    } finally {
      await fixture.context.close();
    }
  });

  it("reads attempted, finalized, patched, and in-flight reservation facts for the dashboard", async () => {
    const fixture = await runFixture("dashboard-run");
    try {
      await fixture.runs.createRun(actor, runInput(fixture, "run-dashboard", 1_000));
      const lease = await fixture.runs.acquireLease(
        actor,
        leaseInput(fixture, "run-dashboard", "dashboard-driver"),
      );
      await fixture.runs.recordProgress(
        actor,
        progressInput(lease, "unit-attempted", "localize", "decoded", 0, 0),
      );
      await fixture.runs.recordProgress(
        actor,
        progressInput(lease, "unit-finalized", "localize", "accepted", 12, 100),
      );
      await fixture.runs.recordProgress(
        actor,
        progressInput(lease, "unit-patched", "localize", "patched", 18, 100),
      );
      await fixture.runs.reserveCost(actor, {
        lease,
        reservationId: "dashboard-in-flight",
        reservedMicrosUsd: 40,
      });

      const page = await fixture.runs.listDashboardRuns(actor, {
        projectId: fixture.projectId,
        localeBranchId: fixture.localeBranchId,
        limit: 10,
        offset: 0,
      });

      expect(page.total).toBe(1);
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0]).toMatchObject({
        runId: "run-dashboard",
        attemptedUnitCount: 3,
        finalizedUnitCount: 2,
        patchedUnitCount: 1,
        spentMicrosUsd: 0,
        reservedMicrosUsd: 40,
        servedPairs: [],
        patchVersionId: null,
      });
    } finally {
      await fixture.context.close();
    }
  });

  it("exposes live, dashboard, and portfolio read models from public package exports", async () => {
    const fixture = await runFixture("public-read-model-exports");
    try {
      await fixture.runs.createRun(actor, runInput(fixture, "run-public-exports", 100));
      const lease = await fixture.runs.acquireLease(
        actor,
        leaseInput(fixture, "run-public-exports", "public-export-driver"),
      );
      await fixture.runs.recordProgress(
        actor,
        progressInput(lease, "unit-public-export", "writer", "drafted", 11, 50, ["review"]),
      );

      const live = await loadProjectRunLiveReadModel(
        fixture.context.db,
        actor,
        fixture.projectId,
        "run-public-exports",
        { unitPage: { limit: 10, offset: 0 } },
      );
      const dashboard = await listProjectRunDashboardRuns(fixture.context.db, actor, {
        projectId: fixture.projectId,
        localeBranchId: fixture.localeBranchId,
        limit: 10,
        offset: 0,
      });
      const portfolio = await listProjectRunPortfolioProgress(fixture.context.db, actor);

      expect(live?.unitPage?.items).toMatchObject([
        { bridgeUnitId: "unit-public-export", blockers: ["review"] },
      ]);
      expect(dashboard.rows).toMatchObject([
        { runId: "run-public-exports", attemptedUnitCount: 1 },
      ]);
      expect(portfolio).toMatchObject([
        { projectId: fixture.projectId, runCount: 1, unitCounts: { drafted: 1 } },
      ]);
    } finally {
      await fixture.context.close();
    }
  }, 20_000);
  it("terminally releases an unknown-cost reservation without inventing spend", async () => {
    const fixture = await runFixture("released-cost");
    try {
      await fixture.runs.createRun(actor, runInput(fixture, "run-released-cost", 100));
      const lease = await fixture.runs.acquireLease(
        actor,
        leaseInput(fixture, "run-released-cost", "driver-released-cost"),
      );
      await fixture.runs.reserveCost(actor, {
        lease,
        reservationId: "reservation-released",
        reservedMicrosUsd: 60,
      });
      const released = await fixture.runs.releaseCost(actor, {
        lease,
        reservationId: "reservation-released",
      });
      expect(released).toMatchObject({
        state: "released",
        settledMicrosUsd: null,
        releasedAt: expect.any(Date),
      });
      await expect(
        fixture.runs.releaseCost(actor, { lease, reservationId: "reservation-released" }),
      ).resolves.toMatchObject({ state: "released" });
      const live = await fixture.runs.loadLiveReadModel(
        actor,
        fixture.projectId,
        "run-released-cost",
      );
      expect(live?.run.cost).toEqual({
        capMicrosUsd: 100,
        spentMicrosUsd: 0,
        reservedMicrosUsd: 0,
      });
    } finally {
      await fixture.context.close();
    }
  });
});
function runWorkflow(fixture: RunFixture) {
  return {
    createRun: async (input: Parameters<ItotoriProjectRunRepository["createRun"]>[1]) =>
      await fixture.runs.createRun(actor, input),
    acquireLease: async (input: Parameters<ItotoriProjectRunRepository["acquireLease"]>[1]) =>
      await fixture.runs.acquireLease(actor, input),
    renewLease: async (input: Parameters<ItotoriProjectRunRepository["renewLease"]>[1]) =>
      await fixture.runs.renewLease(actor, input),
    releaseLease: async (input: Parameters<ItotoriProjectRunRepository["releaseLease"]>[1]) =>
      await fixture.runs.releaseLease(actor, input),
    advanceRun: async (input: Parameters<ItotoriProjectRunRepository["advanceRun"]>[1]) =>
      await fixture.runs.advanceRun(actor, input),
    recordProgress: async (input: Parameters<ItotoriProjectRunRepository["recordProgress"]>[1]) =>
      await fixture.runs.recordProgress(actor, input),
    recordProgressBatch: async (
      input: Parameters<ItotoriProjectRunRepository["recordProgressBatch"]>[1],
    ) => await fixture.runs.recordProgressBatch(actor, input),
    reserveCost: async (input: Parameters<ItotoriProjectRunRepository["reserveCost"]>[1]) =>
      await fixture.runs.reserveCost(actor, input),
    settleCost: async (input: Parameters<ItotoriProjectRunRepository["settleCost"]>[1]) =>
      await fixture.runs.settleCost(actor, input),
    loadLiveReadModel: async (
      projectId: string,
      runId: string,
      options?: Parameters<ItotoriProjectRunRepository["loadLiveReadModel"]>[3],
    ) => await fixture.runs.loadLiveReadModel(actor, projectId, runId, options),
  };
}
