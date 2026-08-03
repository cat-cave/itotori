import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { ProjectRunLease } from "../src/index.js";
import {
  actor,
  leaseInput,
  progressInput,
  runFixture,
  runInput,
  type RunFixture,
} from "./project-run-test-fixtures.js";

describe("ItotoriProjectRunRepository resume", () => {
  it("re-enters an exact running run after its lease expires without regressing startup progress", async () => {
    const fixture = await runFixture("resume");
    try {
      const input = runInput(fixture, "run-resume", 100);
      const created = await fixture.runs.createRun(actor, input);
      const firstLease = await fixture.runs.acquireLease(
        actor,
        leaseInput(fixture, input.runId, "worker-killed"),
      );
      await fixture.runs.advanceRun(actor, { lease: firstLease, status: "running" });
      await fixture.runs.recordProgressBatch(actor, startupBatch(firstLease, ["unit-a", "unit-b"]));
      await fixture.runs.recordProgress(
        actor,
        progressInput(firstLease, "unit-a", "localize", "QA", 0, 100),
      );
      await fixture.context.db.execute(sql`
        update itotori_project_runs
        set lease_expires_at = now() - interval '1 second'
        where run_id = ${input.runId}
      `);

      const resumed = await fixture.runs.createOrResumeRun(actor, input);
      expect(resumed).toMatchObject({
        runId: created.runId,
        projectId: created.projectId,
        status: "running",
        cost: { capMicrosUsd: 100 },
      });

      const restartedLease = await fixture.runs.acquireLease(
        actor,
        leaseInput(fixture, input.runId, "worker-restarted"),
      );
      await fixture.runs.advanceRun(actor, { lease: restartedLease, status: "running" });
      await fixture.runs.recordProgressBatch(
        actor,
        startupBatch(restartedLease, ["unit-a", "unit-b"]),
      );

      const live = await fixture.runs.loadLiveReadModel(actor, fixture.projectId, input.runId);
      expect(live?.run.fenceToken).toBeGreaterThan(firstLease.fenceToken);
      expect(live?.progress.statusCounts).toMatchObject({ decoded: 1, QA: 1 });
      await fixture.runs.releaseLease(actor, restartedLease);
    } finally {
      await fixture.context.close();
    }
  });

  it("rejects mismatched immutable bindings and terminal runs", async () => {
    const fixture = await runFixture("resume-rejection");
    try {
      const input = runInput(fixture, "run-resume-rejection", 100);
      await fixture.runs.createRun(actor, input);
      const mismatches = [
        { ...input, projectId: "other-project" },
        { ...input, localeBranchId: "other-branch" },
        { ...input, contextSnapshotId: "other-context" },
        { ...input, localizationSnapshotId: "other-localization" },
        { ...input, capMicrosUsd: 101 },
      ];
      for (const mismatch of mismatches) {
        await expect(fixture.runs.createOrResumeRun(actor, mismatch)).rejects.toMatchObject({
          code: "run_resume_rejected",
        });
      }

      const lease = await fixture.runs.acquireLease(
        actor,
        leaseInput(fixture, input.runId, "terminal-worker"),
      );
      await fixture.runs.advanceRun(actor, { lease, status: "running" });
      await fixture.runs.advanceRun(actor, { lease, status: "completed" });
      await fixture.runs.releaseLease(actor, lease);
      await expect(fixture.runs.createOrResumeRun(actor, input)).rejects.toMatchObject({
        code: "run_resume_rejected",
      });
    } finally {
      await fixture.context.close();
    }
  });
});

function startupBatch(lease: ProjectRunLease, unitIds: readonly string[]) {
  return {
    lease,
    progress: unitIds.map((bridgeUnitId) => ({
      bridgeUnitId,
      role: "localize",
      status: "decoded" as const,
      costMicrosUsd: 0,
      coveragePercent: 0,
      blockers: [],
    })),
  };
}
