import { beforeAll, describe, expect, it } from "vitest";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { withDatabaseItotoriServices } from "../src/services/database-services.js";

const postgresDescribe = process.env.DATABASE_URL ? describe : describe.skip;

postgresDescribe("database project workflow", () => {
  beforeAll(() => {
    // The full service graph builds a field-memo cipher; supply a deterministic
    // test key when the harness has not set one (mirrors the other live-DB tests).
    process.env.ITOTORI_FIELD_CIPHER_KEY ??= Buffer.alloc(32, 11).toString("base64");
  });

  it("persists a project run and exposes recorded unit progress through the live read model", async () => {
    const context = await isolatedMigratedContext();
    try {
      await withDatabaseItotoriServices({ databaseUrl: context.databaseUrl }, async (services) => {
        const workflow = services.projectWorkflow;
        const projectId = "workflow-project-live";
        const localeBranchId = "workflow-branch-live";
        const runId = "workflow-run-live";

        await workflow.ensureRunProjectScope({
          projectId,
          localeBranchId,
          sourceRevisionId: "workflow-source-revision-live",
          sourceLocale: "ja-JP",
          targetLocale: "en-US",
          engineFamily: "synthetic_fixture",
          sourceRoot: "/fixture/source",
          buildRoot: "/fixture/build",
          extractProfile: { source: "workflow-live-db" },
        });
        const contextSnapshot = await workflow.putContext({
          sourceLanguage: "ja-JP",
          decode: revision("a"),
          sourceUnits: [{ unitId: "unit-live", sourceHash: hash("b") }],
          facts: [{ factId: "unit:unit-live", playOrderIndex: 0, routeScope: { kind: "global" } }],
          structure: revision("c"),
          routeGraph: revision("d"),
          glossary: revision("e"),
          style: revision("f"),
          revealHorizon: { kind: "complete" },
          humanCorrections: revision("0"),
          externalSources: null,
          contextScope: "whole-game",
        });
        const localizationSnapshot = await workflow.putLocalization({
          contextSnapshotId: contextSnapshot.snapshotId,
          targetLocale: "en-US",
          localeBranchId,
          acceptedBibleHead: null,
          acceptedTargetOutputHead: null,
        });

        await workflow.createRun({
          projectId,
          runId,
          localeBranchId,
          contextSnapshotId: contextSnapshot.snapshotId,
          localizationSnapshotId: localizationSnapshot.snapshotId,
          capMicrosUsd: 100,
        });
        const lease = await workflow.acquireLease({
          projectId,
          runId,
          leaseOwnerId: "workflow-driver-live",
          leaseDurationSeconds: 60,
        });
        await workflow.recordProgress({
          lease,
          bridgeUnitId: "unit-live",
          role: "writer",
          status: "drafted",
          costMicrosUsd: 13,
          coveragePercent: 75,
          blockers: ["review-needed"],
        });

        const live = await workflow.loadLiveReadModel(projectId, runId);
        expect(live).toMatchObject({
          run: {
            projectId,
            runId,
            localeBranchId,
            cost: { capMicrosUsd: 100, spentMicrosUsd: 0, reservedMicrosUsd: 0 },
          },
          progress: {
            totalCostMicrosUsd: 13,
            averageCoveragePercent: 75,
            statusCounts: { drafted: 1 },
            blockers: [{ bridgeUnitId: "unit-live", role: "writer", blockers: ["review-needed"] }],
          },
        });

        const persisted = await context.pool.query(
          "select run_id from itotori_project_runs where project_id = $1 and run_id = $2",
          [projectId, runId],
        );
        expect(persisted.rows).toEqual([{ run_id: runId }]);
      });
    } finally {
      await context.close();
    }
  });
});

function revision(character: string) {
  return { revisionId: `revision-${character}`, contentHash: hash(character) };
}

function hash(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}
