import {
  ItotoriLocalizationPassLedgerRepository,
  ItotoriModelLedgerRepository,
  ItotoriProjectRepository,
  localUserId,
  type AuthorizationActor,
  type ProjectDashboardStatus,
} from "@itotori/db";
import type { BenchmarkReportV02 } from "@itotori/localization-bridge-schema";
import { describe, expect, it } from "vitest";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { assertItotoriApiResponse } from "../src/api-schema.js";
import {
  ProjectOverviewProjectMismatchError,
  composeProjectOverviewReadModel,
} from "../src/project-overview-read-model.js";
import { ItotoriProjectWorkflowService } from "../src/services/project-workflow.js";
import {
  benchmarkReportFixture,
  bridgeFixture,
  nonJapaneseTargetProjectFixture,
} from "./api-fixtures.js";

const actor: AuthorizationActor = { userId: localUserId };
const dbBackedIt = process.env.DATABASE_URL ? it : it.skip;

describe("projects.overview read model", () => {
  dbBackedIt("composes the individual project cockpit source read models", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      const modelLedger = new ItotoriModelLedgerRepository(context.db);
      const passLedger = new ItotoriLocalizationPassLedgerRepository(context.db);
      const service = new ItotoriProjectWorkflowService(
        projectRepository,
        actor,
        undefined,
        modelLedger,
        undefined,
        undefined,
        passLedger,
      );

      const project = await service.importBridge(bridgeFixture);
      const importedStatus = await service.getDashboardStatus();
      const pass = await passLedger.recordPass(actor, {
        projectId: project.projectId,
        localeBranchId: project.localeBranchId,
        sourceRevisionId: importedStatus.sourceBundleRevisionId,
        recordedAt: new Date("2026-07-07T00:00:00.000Z"),
        totalUsageCostUsd: 0.0123,
        zdrConfirmed: true,
        recordBody: { accepted: 1, flagged: 0 },
      });
      const benchmarkReport = scopedBenchmarkReport(project.localeBranchId);
      await service.recordBenchmarkReport(project.projectId, { benchmarkReport });

      const costDrilldownFilter = {
        projectId: project.projectId,
        limit: 2,
        offset: 0,
      };
      const [progress, decisions, cost, telemetry, costDrilldown, benchmarkReports, passRows] =
        await Promise.all([
          service.getDashboardStatus(),
          service.getDashboardDecisions(project.projectId),
          service.getCostReport(project.projectId),
          service.getTelemetryTimeseries(project.projectId),
          service.getCostDrilldown(costDrilldownFilter),
          service.getBenchmarkReports(project.projectId),
          passLedger.loadPassesForBranch(actor, project.localeBranchId),
        ]);

      const overview = await service.getProjectOverview({
        projectId: project.projectId,
        generatedAt: new Date("2026-07-07T00:00:00.000Z"),
        costDrilldown: costDrilldownFilter,
        passLedger: { localeBranchId: project.localeBranchId, limit: 1, offset: 0 },
      });

      expect(() => assertItotoriApiResponse("projects.overview", overview)).not.toThrow();
      expect(overview.progress).toEqual(progress);
      expect(overview.decisions).toEqual(decisions);
      expect(overview.cost).toEqual(cost);
      expect(overview.telemetry).toEqual(telemetry);
      expect(overview.costDrilldown).toEqual(costDrilldown);
      expect(overview.passLedger).toMatchObject({
        filter: { projectId: project.projectId, localeBranchId: project.localeBranchId },
        pagination: { total: passRows.length, limit: 1, offset: 0 },
        rows: [
          {
            passLedgerId: pass.passLedgerId,
            projectId: project.projectId,
            localeBranchId: project.localeBranchId,
            sourceRevisionId: importedStatus.sourceBundleRevisionId,
            passNumber: pass.passNumber,
            priorPassNumber: null,
            totalUsageCostUsd: 0.0123,
            zdrConfirmed: true,
            recordedAt: "2026-07-07T00:00:00.000Z",
          },
        ],
      });
      expect(overview.benchmarkHeadline).toEqual({
        reportCount: benchmarkReports.length,
        latestReport: benchmarkReports[0] ?? null,
      });
    } finally {
      await context.close();
    }
  });

  dbBackedIt(
    "does NOT leak another project's pass ledger when a foreign locale-branch id is supplied",
    async () => {
      const context = await isolatedMigratedContext();
      try {
        const projectRepository = new ItotoriProjectRepository(context.db);
        const modelLedger = new ItotoriModelLedgerRepository(context.db);
        const passLedger = new ItotoriLocalizationPassLedgerRepository(context.db);
        const service = new ItotoriProjectWorkflowService(
          projectRepository,
          actor,
          undefined,
          modelLedger,
          undefined,
          undefined,
          passLedger,
        );

        // Project A (the target of the overview).
        const projectA = await service.importBridge(bridgeFixture);

        // Project B — a DIFFERENT project with its own locale branch and its
        // own pass ledger. Imported second, so it is also the globally-latest
        // project.
        await projectRepository.importSourceBundle(actor, nonJapaneseTargetProjectFixture);
        const statusB = await service.getDashboardStatus(nonJapaneseTargetProjectFixture.projectId);
        const foreignBranchId = nonJapaneseTargetProjectFixture.localeBranchId;
        const foreignPass = await passLedger.recordPass(actor, {
          projectId: nonJapaneseTargetProjectFixture.projectId,
          localeBranchId: foreignBranchId,
          sourceRevisionId: statusB.sourceBundleRevisionId,
          recordedAt: new Date("2026-07-07T00:00:00.000Z"),
          totalUsageCostUsd: 9.99,
          zdrConfirmed: true,
          recordBody: { secret: "project-B-pass-ledger" },
        });

        // Sanity: project B's pass ledger really does hold a row (so the test
        // proves suppression of REAL data, not the absence of any data).
        const foreignRows = await passLedger.loadPassesForBranch(actor, foreignBranchId);
        expect(foreignRows.map((row) => row.passLedgerId)).toContain(foreignPass.passLedgerId);

        // The attack: request project A's overview but hand in project B's
        // locale-branch id for the pass ledger.
        const overview = await service.getProjectOverview({
          projectId: projectA.projectId,
          generatedAt: new Date("2026-07-07T00:00:00.000Z"),
          passLedger: { localeBranchId: foreignBranchId },
        });

        // The whole payload is scoped to project A.
        expect(overview.projectId).toBe(projectA.projectId);
        expect(overview.progress.projectId).toBe(projectA.projectId);
        // The foreign branch is REFUSED (not project A's) — no rows, and the
        // filter reflects the refusal rather than echoing the foreign branch.
        expect(overview.passLedger.filter.localeBranchId).toBeNull();
        expect(overview.passLedger.rows).toEqual([]);
        expect(overview.passLedger.pagination.total).toBe(0);
        // Belt-and-suspenders: project B's secret never appears anywhere.
        expect(JSON.stringify(overview)).not.toContain("project-B-pass-ledger");
        expect(JSON.stringify(overview)).not.toContain(foreignPass.passLedgerId);
      } finally {
        await context.close();
      }
    },
  );

  dbBackedIt("composes a single-project payload even when another project is latest", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      const modelLedger = new ItotoriModelLedgerRepository(context.db);
      const service = new ItotoriProjectWorkflowService(
        projectRepository,
        actor,
        undefined,
        modelLedger,
      );

      // Project A first, then project B — B becomes the globally-latest.
      const projectA = await service.importBridge(bridgeFixture);
      await projectRepository.importSourceBundle(actor, nonJapaneseTargetProjectFixture);

      // The UNSCOPED dashboard status points at the latest project (B). This is
      // exactly the value the old overview spliced in as `progress` regardless
      // of the requested projectId.
      const latest = await service.getDashboardStatus();
      expect(latest.projectId).toBe(nonJapaneseTargetProjectFixture.projectId);

      const overview = await service.getProjectOverview({ projectId: projectA.projectId });

      // Every composed piece is project A's — no mixing of B's progress in.
      expect(overview.projectId).toBe(projectA.projectId);
      expect(overview.progress.projectId).toBe(projectA.projectId);
      expect(overview.cost.projectId).toBe(projectA.projectId);
      for (const branch of overview.progress.localeBranches) {
        expect(branch.localeBranchId).not.toBe(nonJapaneseTargetProjectFixture.localeBranchId);
      }
    } finally {
      await context.close();
    }
  });

  dbBackedIt("reads the pass ledger ONLY inside the permission boundary", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      const modelLedger = new ItotoriModelLedgerRepository(context.db);
      const passLedger = new ItotoriLocalizationPassLedgerRepository(context.db);
      const service = new ItotoriProjectWorkflowService(
        projectRepository,
        actor,
        undefined,
        modelLedger,
        undefined,
        undefined,
        passLedger,
      );

      const project = await service.importBridge(bridgeFixture);
      const importedStatus = await service.getDashboardStatus();
      await passLedger.recordPass(actor, {
        projectId: project.projectId,
        localeBranchId: project.localeBranchId,
        sourceRevisionId: importedStatus.sourceBundleRevisionId,
        recordedAt: new Date("2026-07-07T00:00:00.000Z"),
        totalUsageCostUsd: 0.0123,
        zdrConfirmed: true,
        recordBody: { accepted: 1 },
      });

      // Permitted caller (includePassLedger !== false) — the rows are read.
      const permitted = await service.getProjectOverview({
        projectId: project.projectId,
        passLedger: { localeBranchId: project.localeBranchId },
      });
      expect(permitted.passLedger.rows).toHaveLength(1);

      // Unpermitted caller (includePassLedger === false, as the API boundary
      // sets it for a caller lacking draft.write) — the ledger is NEVER read;
      // an empty page is composed inside the boundary.
      const redacted = await service.getProjectOverview({
        projectId: project.projectId,
        passLedger: { localeBranchId: project.localeBranchId },
        includePassLedger: false,
      });
      expect(redacted.passLedger.rows).toEqual([]);
      // The rest of the overview is unaffected.
      expect(redacted.progress.projectId).toBe(project.projectId);
    } finally {
      await context.close();
    }
  });

  it("refuses to compose a mixed-project overview at the composition seam", async () => {
    const statusForProjectB: ProjectDashboardStatus = {
      ...baseStatus(),
      projectId: "project-b",
    };
    await expect(
      composeProjectOverviewReadModel({
        actor,
        status: statusForProjectB,
        decisions: emptyDecisions(),
        cost: statusForProjectB.cost,
        telemetry: emptyTelemetryTimeseries(),
        costDrilldown: emptyCostDrilldown(),
        benchmarkReports: [],
        options: { projectId: "project-a" },
      }),
    ).rejects.toBeInstanceOf(ProjectOverviewProjectMismatchError);
  });
});

function baseStatus(): ProjectDashboardStatus {
  const emptyCost = {
    projectId: "project-b",
    runCount: 0,
    tokensIn: 0,
    tokensOut: 0,
    billedMicrosUsd: 0,
    totalsByCostKind: [],
    recentRuns: [],
    translationMemoryReuse: { reuseEventCount: 0, reusedUnitCount: 0, recentEvents: [] },
  } as unknown as ProjectDashboardStatus["cost"];
  return {
    projectId: "project-b",
    projectKey: "project-b-key",
    name: "Project B",
    status: "importing",
    sourceLocale: "ja-JP",
    sourceBundleId: "bundle-b",
    sourceBundleHash: "hash-b",
    sourceBundleRevisionId: "rev-b",
    branchCount: 0,
    unitCount: 0,
    findingCount: 0,
    artifactCount: 0,
    latestEventKind: null,
    latestEventAt: null,
    selectedLocaleBranchId: null,
    currentStyleGuidePolicyVersionId: null,
    importStatus: { state: "pending" } as ProjectDashboardStatus["importStatus"],
    cost: emptyCost,
    localeBranches: [],
  };
}

function emptyDecisions(): Parameters<typeof composeProjectOverviewReadModel>[0]["decisions"] {
  return {
    schemaVersion: "projects.decisions.v0.1",
    generatedAt: "2026-07-07T00:00:00.000Z",
    projectId: "project-b",
    pendingDecisions: [],
    recentDecisions: [],
    counts: { pending: 0, recorded: 0 },
  } as unknown as Parameters<typeof composeProjectOverviewReadModel>[0]["decisions"];
}

function emptyCostDrilldown(): Parameters<
  typeof composeProjectOverviewReadModel
>[0]["costDrilldown"] {
  return {
    filter: {},
    pagination: {
      total: 0,
      limit: 10,
      offset: 0,
      page: 1,
      pageCount: 0,
      hasMore: false,
      nextOffset: null,
    },
    rows: [],
  } as unknown as Parameters<typeof composeProjectOverviewReadModel>[0]["costDrilldown"];
}

function emptyTelemetryTimeseries(): Parameters<
  typeof composeProjectOverviewReadModel
>[0]["telemetry"] {
  return {
    projectId: "project-b",
    bucket: "day",
    rows: [],
    throughputSeries: [],
    costPerRunSeries: [],
  };
}

function scopedBenchmarkReport(localeBranchId: string): BenchmarkReportV02 {
  return {
    ...JSON.parse(JSON.stringify(benchmarkReportFixture)),
    benchmarkRunId: "benchmark-run-project-overview",
    localeBranchId,
    createdAt: "2026-07-07T00:00:00.000Z",
  } as BenchmarkReportV02;
}
