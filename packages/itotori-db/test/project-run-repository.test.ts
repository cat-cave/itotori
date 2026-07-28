import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import { type DatabaseContext } from "../src/connection.js";
import { ItotoriLlmSnapshotRepository } from "../src/repositories/llm-snapshot-repository.js";
import { ItotoriProjectRepository } from "../src/repositories/project-repository.js";
import {
  ItotoriProjectRunRepository,
  ItotoriProjectRunRepositoryError,
  type ProjectRunLease,
} from "../src/repositories/project-run-repository.js";
import { isolatedMigratedContext } from "./db-test-context.js";
import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";

const actor: AuthorizationActor = { userId: localUserId };

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
      expect(first?.progress.units).toHaveLength(1);
      expect(second?.progress.units).toHaveLength(0);
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

      const live = await fixture.runs.loadLiveReadModel(actor, fixture.projectId, "run-progress");
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
      expect(live?.progress.blockers).toEqual([
        { bridgeUnitId: "unit-a", role: "writer", blockers: ["terminology"] },
      ]);
    } finally {
      await fixture.context.close();
    }
  });

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
      } satisfies Partial<ItotoriProjectRunRepositoryError>);
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

  it("renews a lease, rejects a stale fence, and resumes with a newer fencing token", async () => {
    const fixture = await runFixture("lease");
    try {
      await fixture.runs.createRun(actor, runInput(fixture, "run-lease", 100));
      const first = await fixture.runs.acquireLease(
        actor,
        leaseInput(fixture, "run-lease", "driver-first"),
      );
      const renewed = await fixture.runs.renewLease(actor, {
        lease: first,
        leaseDurationSeconds: 120,
      });
      expect(renewed.fenceToken).toBe(first.fenceToken);
      await expect(
        fixture.runs.acquireLease(actor, leaseInput(fixture, "run-lease", "driver-other")),
      ).rejects.toMatchObject({
        code: "lease_unavailable",
      } satisfies Partial<ItotoriProjectRunRepositoryError>);
      await fixture.runs.advanceRun(actor, { lease: renewed, status: "running" });
      await fixture.runs.advanceRun(actor, { lease: renewed, status: "paused" });
      await fixture.runs.releaseLease(actor, renewed);

      const resumed = await fixture.runs.acquireLease(
        actor,
        leaseInput(fixture, "run-lease", "driver-resumed"),
      );
      expect(resumed.fenceToken).toBeGreaterThan(first.fenceToken);
      await expect(
        fixture.runs.advanceRun(actor, { lease: renewed, status: "running" }),
      ).rejects.toMatchObject({
        code: "fence_rejected",
      } satisfies Partial<ItotoriProjectRunRepositoryError>);
      const run = await fixture.runs.advanceRun(actor, { lease: resumed, status: "running" });
      expect(run.status).toBe("running");
    } finally {
      await fixture.context.close();
    }
  });
});

type RunFixture = Awaited<ReturnType<typeof runFixture>>;
type RunBranch = Pick<RunFixture, "localeBranchId" | "snapshots">;

async function runFixture(suffix: string) {
  const context = await isolatedMigratedContext();
  const projectId = `project-run-${suffix}`;
  const localeBranchId = `branch-run-${suffix}`;
  const projects = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
  await projects.ensureRunProjectScope(actor, {
    projectId,
    localeBranchId,
    sourceRevisionId: `revision-run-${suffix}`,
    targetLocale: "en-US",
    sourceLocale: "ja-JP",
    engineFamily: "synthetic_fixture",
    sourceRoot: "/fixture/source",
    buildRoot: "/fixture/build",
    extractProfile: { fixture: suffix },
  });
  const snapshots = await snapshotPair(context, localeBranchId);
  return {
    context,
    suffix,
    projectId,
    localeBranchId,
    snapshots,
    runs: new ItotoriProjectRunRepository(context.db),
  };
}

async function addRunBranch(fixture: RunFixture, suffix: string): Promise<RunBranch> {
  const localeBranchId = `branch-run-${suffix}`;
  const projects = new ItotoriProjectRepository(
    fixture.context.db,
    testProjectEngineFamilyRegistry,
  );
  await projects.ensureRunProjectScope(actor, {
    projectId: fixture.projectId,
    localeBranchId,
    sourceRevisionId: `revision-run-${fixture.suffix}`,
    targetLocale: "fr-FR",
    sourceLocale: "ja-JP",
    engineFamily: "synthetic_fixture",
    sourceRoot: "/fixture/source",
    buildRoot: "/fixture/build",
    extractProfile: { fixture: suffix },
  });
  return { localeBranchId, snapshots: await snapshotPair(fixture.context, localeBranchId) };
}

function runInput(
  fixture: RunFixture,
  runId: string,
  capMicrosUsd: number,
  branch: RunBranch = fixture,
) {
  return {
    projectId: fixture.projectId,
    runId,
    localeBranchId: branch.localeBranchId,
    contextSnapshotId: branch.snapshots.contextSnapshotId,
    localizationSnapshotId: branch.snapshots.localizationSnapshotId,
    capMicrosUsd,
  };
}

function leaseInput(
  fixture: Awaited<ReturnType<typeof runFixture>>,
  runId: string,
  leaseOwnerId: string,
) {
  return { projectId: fixture.projectId, runId, leaseOwnerId, leaseDurationSeconds: 60 };
}

function progressInput(
  lease: ProjectRunLease,
  bridgeUnitId: string,
  role: string,
  status: "decoded" | "drafted" | "QA" | "accepted" | "patched",
  costMicrosUsd: number,
  coveragePercent: number,
  blockers?: string[],
) {
  return {
    lease,
    bridgeUnitId,
    role,
    status,
    costMicrosUsd,
    coveragePercent,
    ...(blockers === undefined ? {} : { blockers }),
  };
}

async function snapshotPair(context: DatabaseContext, localeBranchId: string) {
  const snapshots = new ItotoriLlmSnapshotRepository(context.pool);
  const contextSnapshot = await snapshots.putContext({
    sourceLanguage: "ja-JP",
    decode: revision("a"),
    sourceUnits: [{ unitId: "unit-source", sourceHash: hash("b") }],
    facts: [{ factId: "unit:unit-source", playOrderIndex: 0, routeScope: { kind: "global" } }],
    structure: revision("c"),
    routeGraph: revision("d"),
    glossary: revision("e"),
    style: revision("f"),
    revealHorizon: { kind: "complete" },
    humanCorrections: revision("0"),
    externalSources: null,
    contextScope: "whole-game",
  });
  const localizationSnapshot = await snapshots.putLocalization({
    contextSnapshotId: contextSnapshot.snapshotId,
    targetLocale: "en-US",
    localeBranchId,
    acceptedBibleHead: null,
    acceptedTargetOutputHead: null,
  });
  return {
    contextSnapshotId: contextSnapshot.snapshotId,
    localizationSnapshotId: localizationSnapshot.snapshotId,
  };
}

function revision(character: string) {
  return { revisionId: `revision-${character}`, contentHash: hash(character) };
}

function hash(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}
