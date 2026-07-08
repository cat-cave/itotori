import {
  ItotoriLocalizationPassLedgerRepository,
  ItotoriModelLedgerRepository,
  ItotoriProjectRepository,
  localUserId,
  type AuthorizationActor,
} from "@itotori/db";
import type { BenchmarkReportV02 } from "@itotori/localization-bridge-schema";
import { describe, expect, it } from "vitest";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { assertItotoriApiResponse } from "../src/api-schema.js";
import { ItotoriProjectWorkflowService } from "../src/services/project-workflow.js";
import { benchmarkReportFixture, bridgeFixture } from "./api-fixtures.js";

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
      const [progress, decisions, cost, costDrilldown, benchmarkReports, passRows] =
        await Promise.all([
          service.getDashboardStatus(),
          service.getDashboardDecisions(project.projectId),
          service.getCostReport(project.projectId),
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
});

function scopedBenchmarkReport(localeBranchId: string): BenchmarkReportV02 {
  return {
    ...JSON.parse(JSON.stringify(benchmarkReportFixture)),
    benchmarkRunId: "benchmark-run-project-overview",
    localeBranchId,
    createdAt: "2026-07-07T00:00:00.000Z",
  } as BenchmarkReportV02;
}
