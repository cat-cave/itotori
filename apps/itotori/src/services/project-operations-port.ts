import type {
  BenchmarkReportSummary,
  CostDrilldownFilter,
  CostDrilldownPage,
  DashboardDecisionReadModel,
  ItotoriConformanceRepositoryPort,
  ItotoriLlmSnapshotRepository,
  ItotoriProjectRepositoryPort,
  ItotoriProjectRunRepositoryPort,
  LocaleBranchIdentity,
  ProjectCostReport,
  ProjectDashboardStatus,
  ProjectRunPortfolioProgressSummary,
  RuntimeDashboardStatus,
} from "@itotori/db";
import type {
  BenchmarkReportV02,
  BridgeBundle,
  BridgeBundleV02,
  ConformanceManifestV01,
  ConformanceResultV01,
  FindingRecordV02,
  PatchResultV02,
  RuntimeEvidenceReportV02,
  RuntimeVerificationReport,
} from "@itotori/localization-bridge-schema";
import type { DecodeExtractPort } from "../extract/decode-extract-runner.js";
import type {
  ProjectOverviewReadModel,
  ProjectOverviewReadModelOptions,
} from "../project-overview-read-model.js";
import type { ProjectState } from "./project-types.js";

/**
 * The type-only project-operations boundary shared by the retained CLI and API
 * handlers. Implementations are injected by composition; this module owns no
 * workflow or provider behavior.
 */
export type RuntimeIngestResult = {
  status: "hello_world_passed" | "hello_world_failed";
  bridgeId: string;
  localeBranchId: string;
  patchExportId: string | undefined;
  patchResultId: string;
  runtimeReportId: string;
  dashboard: ProjectDashboardStatus;
};

export type FindingRecordResult = {
  findingId: string;
  status: "open" | "resolved" | "superseded";
};

export type BenchmarkRecordResult = {
  benchmarkRunId: string;
  artifactId: string;
  status: string;
  systemCount: number;
  findingCount: number;
};

export type ProjectPortfolioEntry = ProjectDashboardStatus & {
  progress: ProjectRunPortfolioProgressSummary;
};

export type LaunchLocalizationPassResult =
  | {
      outcome: "started";
      journalRunId: string;
      startedAt: Date;
    }
  | {
      outcome: "refused";
      refusalMessage: string;
    };

export type ItotoriProjectWorkflowPort = {
  reset(): Promise<void>;
  listLocaleBranchIdentities(projectId: string): Promise<LocaleBranchIdentity[]>;
  listPortfolio(): Promise<ProjectPortfolioEntry[]>;
  getDashboardStatus(projectId?: string): Promise<ProjectDashboardStatus>;
  getDashboardStatusForProject(projectId: string): Promise<ProjectDashboardStatus>;
  getRuntimeStatus(runtimeRunId?: string, projectId?: string): Promise<RuntimeDashboardStatus>;
  getDashboardDecisions(projectId?: string): Promise<DashboardDecisionReadModel>;
  getProjectOverview(options?: ProjectOverviewReadModelOptions): Promise<ProjectOverviewReadModel>;
  getCostReport(projectId?: string): Promise<ProjectCostReport>;
  getCostDrilldown(filter?: CostDrilldownFilter): Promise<CostDrilldownPage>;
  getBenchmarkReports(projectId?: string): Promise<BenchmarkReportSummary[]>;
  importBridge(bridge: BridgeBundle | BridgeBundleV02): Promise<ProjectState>;
  decodeExtract(
    input: Parameters<DecodeExtractPort["runDecodeExtract"]>[0],
  ): ReturnType<DecodeExtractPort["runDecodeExtract"]>;
  ingestRuntimeReport(
    project: ProjectState,
    runtimeReport: RuntimeVerificationReport | RuntimeEvidenceReportV02,
  ): Promise<{ project: ProjectState; result: RuntimeIngestResult }>;
  ingestPatchResult(project: ProjectState, patchResult: PatchResultV02): Promise<never>;
  ingestConformanceReport(
    project: ProjectState,
    input: { manifest?: ConformanceManifestV01; results: ConformanceResultV01[] },
  ): Promise<{
    project: ProjectState;
    result: Awaited<ReturnType<ItotoriConformanceRepositoryPort["saveConformanceRun"]>>;
  }>;
  recordFinding(
    projectId: string,
    input: {
      localeBranchId?: string;
      finding: FindingRecordV02;
      status?: "open" | "resolved" | "superseded";
    },
  ): Promise<FindingRecordResult>;
  recordBenchmarkReport(
    projectId: string,
    input: { benchmarkReport: BenchmarkReportV02 },
  ): Promise<BenchmarkRecordResult>;
  launchNextLocalizationPass(input: {
    projectId: string;
    localeBranchId: string;
  }): Promise<LaunchLocalizationPassResult>;
} & {
  ensureRunProjectScope(
    input: Parameters<ItotoriProjectRepositoryPort["ensureRunProjectScope"]>[1],
  ): ReturnType<ItotoriProjectRepositoryPort["ensureRunProjectScope"]>;
  putContext(
    input: Parameters<ItotoriLlmSnapshotRepository["putContext"]>[0],
  ): ReturnType<ItotoriLlmSnapshotRepository["putContext"]>;
  putLocalization(
    input: Parameters<ItotoriLlmSnapshotRepository["putLocalization"]>[0],
  ): ReturnType<ItotoriLlmSnapshotRepository["putLocalization"]>;
  createRun(
    input: Parameters<ItotoriProjectRunRepositoryPort["createRun"]>[1],
  ): ReturnType<ItotoriProjectRunRepositoryPort["createRun"]>;
  advanceRun(
    input: Parameters<ItotoriProjectRunRepositoryPort["advanceRun"]>[1],
  ): ReturnType<ItotoriProjectRunRepositoryPort["advanceRun"]>;
  recordProgress(
    input: Parameters<ItotoriProjectRunRepositoryPort["recordProgress"]>[1],
  ): ReturnType<ItotoriProjectRunRepositoryPort["recordProgress"]>;
  recordProgressBatch(
    input: Parameters<ItotoriProjectRunRepositoryPort["recordProgressBatch"]>[1],
  ): ReturnType<ItotoriProjectRunRepositoryPort["recordProgressBatch"]>;
  reserveCost(
    input: Parameters<ItotoriProjectRunRepositoryPort["reserveCost"]>[1],
  ): ReturnType<ItotoriProjectRunRepositoryPort["reserveCost"]>;
  settleCost(
    input: Parameters<ItotoriProjectRunRepositoryPort["settleCost"]>[1],
  ): ReturnType<ItotoriProjectRunRepositoryPort["settleCost"]>;
  releaseCost(
    input: Parameters<ItotoriProjectRunRepositoryPort["releaseCost"]>[1],
  ): ReturnType<ItotoriProjectRunRepositoryPort["releaseCost"]>;
  acquireLease(
    input: Parameters<ItotoriProjectRunRepositoryPort["acquireLease"]>[1],
  ): ReturnType<ItotoriProjectRunRepositoryPort["acquireLease"]>;
  renewLease(
    input: Parameters<ItotoriProjectRunRepositoryPort["renewLease"]>[1],
  ): ReturnType<ItotoriProjectRunRepositoryPort["renewLease"]>;
  releaseLease(
    input: Parameters<ItotoriProjectRunRepositoryPort["releaseLease"]>[1],
  ): ReturnType<ItotoriProjectRunRepositoryPort["releaseLease"]>;
  loadLiveReadModel(
    projectId: Parameters<ItotoriProjectRunRepositoryPort["loadLiveReadModel"]>[1],
    runId: Parameters<ItotoriProjectRunRepositoryPort["loadLiveReadModel"]>[2],
    options?: Parameters<ItotoriProjectRunRepositoryPort["loadLiveReadModel"]>[3],
  ): ReturnType<ItotoriProjectRunRepositoryPort["loadLiveReadModel"]>;
};
