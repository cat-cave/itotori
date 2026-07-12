import {
  ItotoriLocalizationJournalRepository,
  ItotoriModelLedgerRepository,
  ItotoriProjectRepository,
  localUserId,
  type AuthorizationActor,
  type ProjectDashboardStatus,
} from "@itotori/db";
import { asNonBlankTargetText, type BenchmarkReportV02 } from "@itotori/localization-bridge-schema";
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
// Each case creates and migrates its own live Postgres schema. The app suite
// runs these alongside other DB-backed cases, so use the DB suite's timeout
// rather than Vitest's 5s unit-test default.
const dbIntegrationTimeoutMs = 90_000;

describe("projects.overview read model", () => {
  dbBackedIt(
    "renders persisted journal provenance through the composed overview",
    async () => {
      const context = await isolatedMigratedContext();
      try {
        const projectRepository = new ItotoriProjectRepository(context.db);
        const modelLedger = new ItotoriModelLedgerRepository(context.db);
        const journal = new ItotoriLocalizationJournalRepository(context.db);
        const service = new ItotoriProjectWorkflowService(
          projectRepository,
          actor,
          undefined,
          modelLedger,
          undefined,
          undefined,
          journal,
        );

        const project = await service.importBridge(bridgeFixture);
        const importedStatus = await service.getDashboardStatus();
        const run = await persistJournalRun({
          journal,
          projectId: project.projectId,
          localeBranchId: project.localeBranchId,
          sourceRevisionId: importedStatus.sourceBundleRevisionId,
          runId: "journal-run-project-overview",
        });
        const benchmarkReport = scopedBenchmarkReport(project.localeBranchId);
        await service.recordBenchmarkReport(project.projectId, { benchmarkReport });

        const costDrilldownFilter = { projectId: project.projectId, limit: 2, offset: 0 };
        const [progress, decisions, cost, telemetry, costDrilldown, benchmarkReports, journalRuns] =
          await Promise.all([
            service.getDashboardStatus(),
            service.getDashboardDecisions(project.projectId),
            service.getCostReport(project.projectId),
            service.getTelemetryTimeseries(project.projectId),
            service.getCostDrilldown(costDrilldownFilter),
            service.getBenchmarkReports(project.projectId),
            journal.loadRunsForBranch(actor, project.localeBranchId),
          ]);

        const overview = await service.getProjectOverview({
          projectId: project.projectId,
          generatedAt: new Date("2026-07-07T00:00:00.000Z"),
          costDrilldown: costDrilldownFilter,
          journal: { localeBranchId: project.localeBranchId, limit: 1, offset: 0 },
        });

        expect(() => assertItotoriApiResponse("projects.overview", overview)).not.toThrow();
        expect(overview.progress).toEqual(progress);
        expect(overview.decisions).toEqual(decisions);
        expect(overview.cost).toEqual(cost);
        expect(overview.telemetry).toEqual(telemetry);
        expect(overview.costDrilldown).toEqual(costDrilldown);
        expect(overview.journal).toMatchObject({
          filter: { projectId: project.projectId, localeBranchId: project.localeBranchId },
          pagination: { total: journalRuns.length, limit: 1, offset: 0 },
          rows: [
            {
              journalRunId: run.runId,
              projectId: project.projectId,
              localeBranchId: project.localeBranchId,
              sourceRevisionId: importedStatus.sourceBundleRevisionId,
              targetLocale: "en-US",
              physicalCallCount: 1,
              failedPhysicalCallCount: 0,
              writtenOutcomeCount: 1,
              candidateCount: 1,
              qaFindingCount: 1,
              contextRefCount: 1,
              speakerLabelCount: 0,
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
    },
    dbIntegrationTimeoutMs,
  );

  dbBackedIt(
    "does NOT leak another project's journal when a foreign locale-branch id is supplied",
    async () => {
      const context = await isolatedMigratedContext();
      try {
        const projectRepository = new ItotoriProjectRepository(context.db);
        const modelLedger = new ItotoriModelLedgerRepository(context.db);
        const journal = new ItotoriLocalizationJournalRepository(context.db);
        const service = new ItotoriProjectWorkflowService(
          projectRepository,
          actor,
          undefined,
          modelLedger,
          undefined,
          undefined,
          journal,
        );

        const projectA = await service.importBridge(bridgeFixture);
        await projectRepository.importSourceBundle(actor, nonJapaneseTargetProjectFixture);
        const statusB = await service.getDashboardStatus(nonJapaneseTargetProjectFixture.projectId);
        const foreignRun = await persistJournalRun({
          journal,
          projectId: nonJapaneseTargetProjectFixture.projectId,
          localeBranchId: nonJapaneseTargetProjectFixture.localeBranchId,
          sourceRevisionId: statusB.sourceBundleRevisionId,
          runId: "journal-run-project-b-secret",
        });
        expect(
          (
            await journal.loadRunsForBranch(actor, nonJapaneseTargetProjectFixture.localeBranchId)
          ).map((row) => row.runId),
        ).toContain(foreignRun.runId);

        const overview = await service.getProjectOverview({
          projectId: projectA.projectId,
          generatedAt: new Date("2026-07-07T00:00:00.000Z"),
          journal: { localeBranchId: nonJapaneseTargetProjectFixture.localeBranchId },
        });

        expect(overview.projectId).toBe(projectA.projectId);
        expect(overview.progress.projectId).toBe(projectA.projectId);
        expect(overview.journal.filter.localeBranchId).toBeNull();
        expect(overview.journal.rows).toEqual([]);
        expect(overview.journal.pagination.total).toBe(0);
        expect(JSON.stringify(overview)).not.toContain(foreignRun.runId);
      } finally {
        await context.close();
      }
    },
    dbIntegrationTimeoutMs,
  );

  dbBackedIt(
    "composes a single-project payload even when another project is latest",
    async () => {
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

        const projectA = await service.importBridge(bridgeFixture);
        await projectRepository.importSourceBundle(actor, nonJapaneseTargetProjectFixture);
        const latest = await service.getDashboardStatus();
        expect(latest.projectId).toBe(nonJapaneseTargetProjectFixture.projectId);

        const overview = await service.getProjectOverview({ projectId: projectA.projectId });
        expect(overview.projectId).toBe(projectA.projectId);
        expect(overview.progress.projectId).toBe(projectA.projectId);
        expect(overview.cost.projectId).toBe(projectA.projectId);
        for (const branch of overview.progress.localeBranches) {
          expect(branch.localeBranchId).not.toBe(nonJapaneseTargetProjectFixture.localeBranchId);
        }
      } finally {
        await context.close();
      }
    },
    dbIntegrationTimeoutMs,
  );

  dbBackedIt(
    "reads the journal only inside the catalog.read composition boundary",
    async () => {
      const context = await isolatedMigratedContext();
      try {
        const projectRepository = new ItotoriProjectRepository(context.db);
        const modelLedger = new ItotoriModelLedgerRepository(context.db);
        const journal = new ItotoriLocalizationJournalRepository(context.db);
        const service = new ItotoriProjectWorkflowService(
          projectRepository,
          actor,
          undefined,
          modelLedger,
          undefined,
          undefined,
          journal,
        );
        const project = await service.importBridge(bridgeFixture);
        const importedStatus = await service.getDashboardStatus();
        await persistJournalRun({
          journal,
          projectId: project.projectId,
          localeBranchId: project.localeBranchId,
          sourceRevisionId: importedStatus.sourceBundleRevisionId,
          runId: "journal-run-permission-boundary",
        });

        const permitted = await service.getProjectOverview({
          projectId: project.projectId,
          journal: { localeBranchId: project.localeBranchId },
        });
        expect(permitted.journal.rows).toHaveLength(1);

        const redacted = await service.getProjectOverview({
          projectId: project.projectId,
          journal: { localeBranchId: project.localeBranchId },
          includeJournal: false,
        });
        expect(redacted.journal.rows).toEqual([]);
        expect(redacted.progress.projectId).toBe(project.projectId);
      } finally {
        await context.close();
      }
    },
    dbIntegrationTimeoutMs,
  );

  it("refuses to compose a mixed-project overview at the composition seam", async () => {
    const statusForProjectB: ProjectDashboardStatus = { ...baseStatus(), projectId: "project-b" };
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

async function persistJournalRun(input: {
  journal: ItotoriLocalizationJournalRepository;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  runId: string;
}): Promise<{ runId: string }> {
  const run = await input.journal.createRun(actor, {
    runId: input.runId,
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceRevisionId: input.sourceRevisionId,
    targetLocale: "en-US",
    createdAt: "2026-07-07T00:00:00.000Z",
  });
  const bridgeUnitId = `bridge-unit-${input.runId}`;
  const attemptId = `provider-run-${input.runId}`;
  await input.journal.persistUnit(actor, {
    runId: run.runId,
    bridgeUnitId,
    attempts: [
      {
        attemptId,
        runId: run.runId,
        bridgeUnitId,
        stage: "translation",
        agentLabel: "translator",
        logicalCallId: `logical-${input.runId}`,
        attemptIndex: 0,
        modelId: "model-overview",
        providerId: "provider-overview",
        providerRunId: attemptId,
        costUsd: "0.000001",
        tokensIn: 4,
        tokensOut: 3,
        zdr: true,
        finishState: "stop",
        refusalState: null,
        validationResult: "accepted",
        failureClass: null,
        retryDecision: "write",
        retryDelayMs: null,
        artifactRef: `artifact:${attemptId}`,
        errorClasses: [],
        startedAt: "2026-07-07T00:00:01.000Z",
        completedAt: "2026-07-07T00:00:02.000Z",
      },
    ],
    outcome: {
      id: `outcome-${input.runId}`,
      status: "written",
      unitId: bridgeUnitId,
      targetLocale: "en-US",
      selectedCandidateId: `candidate-${input.runId}`,
      candidates: [
        {
          id: `candidate-${input.runId}`,
          outcomeId: `outcome-${input.runId}`,
          body: asNonBlankTargetText("Durable journal target."),
          producedBy: { modelId: "model-overview", providerId: "provider-overview" },
          attemptId,
          kind: "primary",
        },
      ],
      findings: [
        {
          id: `finding-${input.runId}`,
          outcomeId: `outcome-${input.runId}`,
          candidateId: `candidate-${input.runId}`,
          severity: "minor",
          category: "style",
          note: "Visible provenance finding.",
          contested: false,
          confidence: 0.8,
        },
      ],
      qualityFlags: ["qa_noted"],
      provenance: { source: "overview-db-test" },
      writtenAt: "2026-07-07T00:00:02.000Z",
    },
    contextPacket: { glossary: "resolved" },
    contextRefs: [{ refKind: "glossary", refId: "glossary-overview", versionRef: "v1" }],
    speakerLabels: [],
    qaDetails: {
      [`finding-${input.runId}`]: {
        recommendation: "Keep the resolved register.",
        agentRationale: "The journal overview must expose QA provenance.",
        evidenceRefs: ["glossary-overview:v1"],
      },
    },
  });
  return { runId: run.runId };
}

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
