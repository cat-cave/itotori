import { beforeAll, describe, expect, it } from "vitest";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { handleReadOnlyItotoriApiRequest, readOnlyApiServices } from "../src/api-handlers.js";
import engineCapabilityMatrixJson from "../src/engine-capability/engine-capability-matrix.v0.1.json" with { type: "json" };
import {
  assertEngineCapabilityMatrixDocument,
  createProjectEngineFamilyRegistry,
} from "../src/services/engine-capability-matrix.js";
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

  it("returns three isolated project progress summaries from the portfolio API", async () => {
    const context = await isolatedMigratedContext();
    try {
      await withDatabaseItotoriServices({ databaseUrl: context.databaseUrl }, async (services) => {
        const engineFamilies = portfolioEngineFamilies();
        const projects = engineFamilies.map((engineFamily, index) => ({
          projectId: `portfolio-project-${index + 1}`,
          localeBranchId: `portfolio-branch-${index + 1}`,
          runId: `portfolio-run-${index + 1}`,
          engineFamily,
          progress: portfolioProgress(index),
        }));

        await Promise.all(
          projects.map(async (project, index) => {
            const workflow = services.projectWorkflow;
            const marker = String(index + 1);
            await workflow.ensureRunProjectScope({
              projectId: project.projectId,
              localeBranchId: project.localeBranchId,
              sourceRevisionId: `portfolio-source-revision-${index + 1}`,
              sourceLocale: "ja-JP",
              targetLocale: "en-US",
              engineFamily: project.engineFamily,
              sourceRoot: `/fixture/portfolio/source-${index + 1}`,
              buildRoot: `/fixture/portfolio/build-${index + 1}`,
              extractProfile: { surface: "portfolio-live-db" },
            });
            const contextSnapshot = await workflow.putContext({
              sourceLanguage: "ja-JP",
              decode: revision(marker),
              sourceUnits: [
                {
                  unitId: `portfolio-unit-${index + 1}`,
                  sourceHash: hash(marker),
                },
              ],
              facts: [
                {
                  factId: `unit:portfolio-unit-${index + 1}`,
                  playOrderIndex: 0,
                  routeScope: { kind: "global" },
                },
              ],
              structure: revision(marker),
              routeGraph: revision(marker),
              glossary: revision(marker),
              style: revision(marker),
              revealHorizon: { kind: "complete" },
              humanCorrections: revision(marker),
              externalSources: null,
              contextScope: "whole-game",
            });
            const localizationSnapshot = await workflow.putLocalization({
              contextSnapshotId: contextSnapshot.snapshotId,
              targetLocale: "en-US",
              localeBranchId: project.localeBranchId,
              acceptedBibleHead: null,
              acceptedTargetOutputHead: null,
            });
            await workflow.createRun({
              projectId: project.projectId,
              runId: project.runId,
              localeBranchId: project.localeBranchId,
              contextSnapshotId: contextSnapshot.snapshotId,
              localizationSnapshotId: localizationSnapshot.snapshotId,
              capMicrosUsd: null,
            });
            const lease = await workflow.acquireLease({
              projectId: project.projectId,
              runId: project.runId,
              leaseOwnerId: `portfolio-driver-${index + 1}`,
              leaseDurationSeconds: 60,
            });
            await Promise.all(
              project.progress.map((entry, progressIndex) =>
                workflow.recordProgress({
                  lease,
                  bridgeUnitId: `portfolio-unit-${index + 1}-${progressIndex + 1}`,
                  ...entry,
                }),
              ),
            );
          }),
        );

        const response = await handleReadOnlyItotoriApiRequest(
          { method: "GET", pathname: "/api/projects" },
          readOnlyApiServices({
            ...services,
            // withDatabaseItotoriServices leaves the authorization surface as an
            // unbound stub; the read-only route gate only needs requirePermission.
            authorization: { requirePermission: async () => undefined },
          }),
        );
        expect(response.statusCode).toBe(200);
        if (!("projects" in response.body)) {
          throw new Error("projects.list did not return a portfolio body");
        }

        expect(response.body.projects).toHaveLength(3);
        const byProjectId = new Map(
          response.body.projects.map((project) => [project.projectId, project]),
        );
        expect(byProjectId.get(projects[0]!.projectId)).toMatchObject({
          projectId: projects[0]!.projectId,
          progress: {
            runCount: 1,
            runStatusCounts: {
              queued: 1,
              running: 0,
              paused: 0,
              completed: 0,
              failed: 0,
              cancelled: 0,
            },
            unitCounts: { decoded: 1, drafted: 0, QA: 1, accepted: 0, patched: 0 },
            roleCounts: {
              reviewer: { decoded: 0, drafted: 0, QA: 1, accepted: 0, patched: 0 },
              writer: { decoded: 1, drafted: 0, QA: 0, accepted: 0, patched: 0 },
            },
            totalCostMicrosUsd: 8,
            averageCoveragePercent: 50,
            blockers: [
              {
                runId: projects[0]!.runId,
                bridgeUnitId: "portfolio-unit-1-1",
                role: "writer",
                blockers: ["needs-context"],
              },
            ],
          },
        });
        expect(byProjectId.get(projects[1]!.projectId)).toMatchObject({
          projectId: projects[1]!.projectId,
          progress: {
            runCount: 1,
            runStatusCounts: {
              queued: 1,
              running: 0,
              paused: 0,
              completed: 0,
              failed: 0,
              cancelled: 0,
            },
            unitCounts: { decoded: 0, drafted: 1, QA: 0, accepted: 1, patched: 0 },
            totalCostMicrosUsd: 18,
            averageCoveragePercent: 77.5,
            blockers: [],
          },
        });
        expect(byProjectId.get(projects[2]!.projectId)).toMatchObject({
          projectId: projects[2]!.projectId,
          progress: {
            runCount: 1,
            runStatusCounts: {
              queued: 1,
              running: 0,
              paused: 0,
              completed: 0,
              failed: 0,
              cancelled: 0,
            },
            unitCounts: { decoded: 0, drafted: 0, QA: 0, accepted: 0, patched: 1 },
            roleCounts: {
              patcher: { decoded: 0, drafted: 0, QA: 0, accepted: 0, patched: 1 },
            },
            totalCostMicrosUsd: 17,
            averageCoveragePercent: 100,
            blockers: [
              {
                runId: projects[2]!.runId,
                bridgeUnitId: "portfolio-unit-3-1",
                role: "patcher",
                blockers: ["awaiting-check"],
              },
            ],
          },
        });
      });
    } finally {
      await context.close();
    }
  });
});

function portfolioEngineFamilies(): string[] {
  assertEngineCapabilityMatrixDocument(engineCapabilityMatrixJson);
  const engineFamilies = createProjectEngineFamilyRegistry(
    engineCapabilityMatrixJson,
  ).registrations();
  if (engineFamilies.length < 3) {
    throw new Error("the engine registry must provide at least three project families");
  }
  return engineFamilies.slice(0, 3).map((registration) => registration.engineFamily);
}

function portfolioProgress(index: number) {
  switch (index) {
    case 0:
      return [
        {
          role: "writer",
          status: "decoded" as const,
          costMicrosUsd: 3,
          coveragePercent: 20,
          blockers: ["needs-context"],
        },
        {
          role: "reviewer",
          status: "QA" as const,
          costMicrosUsd: 5,
          coveragePercent: 80,
          blockers: [],
        },
      ];
    case 1:
      return [
        {
          role: "writer",
          status: "drafted" as const,
          costMicrosUsd: 11,
          coveragePercent: 55,
          blockers: [],
        },
        {
          role: "reviewer",
          status: "accepted" as const,
          costMicrosUsd: 7,
          coveragePercent: 100,
          blockers: [],
        },
      ];
    case 2:
      return [
        {
          role: "patcher",
          status: "patched" as const,
          costMicrosUsd: 17,
          coveragePercent: 100,
          blockers: ["awaiting-check"],
        },
      ];
    default:
      throw new Error("portfolio fixture index is invalid");
  }
}

function revision(character: string) {
  return { revisionId: `revision-${character}`, contentHash: hash(character) };
}

function hash(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}
