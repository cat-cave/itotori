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
  it("isolates concurrent run costs, progress, caps, and leases within one project", async () => {
    const fixture = await runFixture("isolation");
    try {
      await fixture.runs.createRun(actor, runInput(fixture, "run-isolation-one", 100));
      await fixture.runs.createRun(actor, runInput(fixture, "run-isolation-two", 30));
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
    projectId,
    localeBranchId,
    snapshots,
    runs: new ItotoriProjectRunRepository(context.db),
  };
}

function runInput(
  fixture: Awaited<ReturnType<typeof runFixture>>,
  runId: string,
  capMicrosUsd: number,
) {
  return {
    projectId: fixture.projectId,
    runId,
    localeBranchId: fixture.localeBranchId,
    contextSnapshotId: fixture.snapshots.contextSnapshotId,
    localizationSnapshotId: fixture.snapshots.localizationSnapshotId,
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
