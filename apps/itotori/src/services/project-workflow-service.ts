import { createHash } from "node:crypto";
import type {
  AuthorizationActor,
  BenchmarkReportSummary,
  CostDrilldownFilter,
  CostDrilldownPage,
  DashboardDecisionReadModel,
  ItotoriConformanceRepositoryPort,
  ItotoriLlmSnapshotRepository,
  ItotoriLocalizationPassRunConfigRepositoryPort,
  ItotoriModelLedgerRepositoryPort,
  ItotoriProjectRepositoryPort,
  ItotoriProjectRunRepositoryPort,
  LocaleBranchIdentity,
  ProjectCostReport,
  ProjectDashboardStatus,
  ProjectTelemetryTimeseries,
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
import {
  createDecodeExtractRunner,
  type DecodeExtractPort,
} from "../extract/decode-extract-runner.js";
import {
  composeProjectOverviewReadModel,
  type ProjectOverviewReadModel,
  type ProjectOverviewReadModelOptions,
} from "../project-overview-read-model.js";
import type { ProjectState } from "./project-types.js";
import type {
  BenchmarkRecordResult,
  FindingRecordResult,
  ItotoriProjectWorkflowPort,
  LaunchLocalizationPassResult,
  RuntimeIngestResult,
} from "./project-operations-port.js";
import { benchmarkArtifactInput } from "./project-workflow-benchmark.js";

export class ProjectWorkflowCapabilityError extends Error {
  constructor(readonly capability: string) {
    super(`project workflow requires the ${capability} capability, which is not installed`);
    this.name = "ProjectWorkflowCapabilityError";
  }
}

export type ProjectWorkflowServiceDeps = {
  actor: AuthorizationActor;
  projects: ItotoriProjectRepositoryPort;
  runs: ItotoriProjectRunRepositoryPort;
  snapshots: Pick<ItotoriLlmSnapshotRepository, "putContext" | "putLocalization">;
  ledger: ItotoriModelLedgerRepositoryPort;
  passRunConfig: ItotoriLocalizationPassRunConfigRepositoryPort;
  conformance: ItotoriConformanceRepositoryPort;
  decodeExtract?: DecodeExtractPort;
  defaultTargetLocale: string;
};

/**
 * The production project-operations façade. It owns no in-memory project or
 * run state: every read and mutation reaches the persisted project/run plane.
 */
export class ItotoriProjectWorkflowService implements ItotoriProjectWorkflowPort {
  private readonly decodeRunner: DecodeExtractPort;

  constructor(private readonly deps: ProjectWorkflowServiceDeps) {
    this.decodeRunner = deps.decodeExtract ?? createDecodeExtractRunner();
  }

  async reset(): Promise<void> {
    await this.deps.projects.reset(this.deps.actor);
  }

  async ensureRunProjectScope(
    input: Parameters<ItotoriProjectRepositoryPort["ensureRunProjectScope"]>[1],
  ) {
    return await this.deps.projects.ensureRunProjectScope(this.deps.actor, input);
  }

  async putContext(input: Parameters<ItotoriLlmSnapshotRepository["putContext"]>[0]) {
    return await this.deps.snapshots.putContext(input);
  }

  async putLocalization(input: Parameters<ItotoriLlmSnapshotRepository["putLocalization"]>[0]) {
    return await this.deps.snapshots.putLocalization(input);
  }

  async createRun(input: Parameters<ItotoriProjectRunRepositoryPort["createRun"]>[1]) {
    return await this.deps.runs.createRun(this.deps.actor, input);
  }

  async advanceRun(input: Parameters<ItotoriProjectRunRepositoryPort["advanceRun"]>[1]) {
    return await this.deps.runs.advanceRun(this.deps.actor, input);
  }

  async recordProgress(input: Parameters<ItotoriProjectRunRepositoryPort["recordProgress"]>[1]) {
    return await this.deps.runs.recordProgress(this.deps.actor, input);
  }

  async reserveCost(input: Parameters<ItotoriProjectRunRepositoryPort["reserveCost"]>[1]) {
    return await this.deps.runs.reserveCost(this.deps.actor, input);
  }

  async settleCost(input: Parameters<ItotoriProjectRunRepositoryPort["settleCost"]>[1]) {
    return await this.deps.runs.settleCost(this.deps.actor, input);
  }

  async acquireLease(input: Parameters<ItotoriProjectRunRepositoryPort["acquireLease"]>[1]) {
    return await this.deps.runs.acquireLease(this.deps.actor, input);
  }

  async renewLease(input: Parameters<ItotoriProjectRunRepositoryPort["renewLease"]>[1]) {
    return await this.deps.runs.renewLease(this.deps.actor, input);
  }

  async releaseLease(input: Parameters<ItotoriProjectRunRepositoryPort["releaseLease"]>[1]) {
    return await this.deps.runs.releaseLease(this.deps.actor, input);
  }

  async loadLiveReadModel(projectId: string, runId: string) {
    return await this.deps.runs.loadLiveReadModel(this.deps.actor, projectId, runId);
  }

  async listLocaleBranchIdentities(projectId: string): Promise<LocaleBranchIdentity[]> {
    return await this.deps.projects.listLocaleBranchIdentities(projectId);
  }

  async getDashboardStatus(projectId?: string): Promise<ProjectDashboardStatus> {
    return await this.deps.projects.getDashboardStatus(projectId);
  }

  async getRuntimeStatus(runtimeRunId?: string): Promise<RuntimeDashboardStatus> {
    return await this.deps.projects.getRuntimeStatus(this.deps.actor, runtimeRunId);
  }

  async getDashboardDecisions(projectId?: string): Promise<DashboardDecisionReadModel> {
    return await this.deps.projects.getDashboardDecisions(projectId);
  }

  async getProjectOverview(
    options: ProjectOverviewReadModelOptions = {},
  ): Promise<ProjectOverviewReadModel> {
    const status = await this.deps.projects.getDashboardStatus(options.projectId);
    const projectId = options.projectId ?? status.projectId;
    const costDrilldown: CostDrilldownFilter = {
      ...options.costDrilldown,
      ...(options.costDrilldown?.projectId === undefined ? { projectId } : {}),
    };
    const [decisions, cost, telemetry, drilldown, benchmarks] = await Promise.all([
      this.getDashboardDecisions(projectId),
      this.getCostReport(projectId),
      this.getTelemetry(projectId),
      this.getCostDrilldown(costDrilldown),
      this.getBenchmarkReports(projectId),
    ]);
    return await composeProjectOverviewReadModel({
      actor: this.deps.actor,
      status,
      decisions,
      cost,
      telemetry,
      costDrilldown: drilldown,
      benchmarkReports: benchmarks,
      options: { ...options, projectId },
    });
  }

  async getCostReport(projectId?: string): Promise<ProjectCostReport> {
    return await this.deps.ledger.getProjectCostReport(this.deps.actor, projectId);
  }

  async getCostDrilldown(filter: CostDrilldownFilter = {}): Promise<CostDrilldownPage> {
    return await this.deps.ledger.getCostLedgerDrilldown(this.deps.actor, filter);
  }

  async getBenchmarkReports(projectId?: string): Promise<BenchmarkReportSummary[]> {
    const resolvedProjectId = projectId ?? (await this.getDashboardStatus()).projectId;
    return await this.deps.projects.listBenchmarkReports(resolvedProjectId);
  }

  async importBridge(bridge: BridgeBundle | BridgeBundleV02): Promise<ProjectState> {
    const project = projectForBridge(bridge, this.deps.defaultTargetLocale);
    const importStatus = await this.deps.projects.importSourceBundle(this.deps.actor, project);
    return { ...project, importStatus };
  }

  async decodeExtract(input: Parameters<DecodeExtractPort["runDecodeExtract"]>[0]) {
    return await this.decodeRunner.runDecodeExtract(input);
  }

  async ingestRuntimeReport(
    project: ProjectState,
    runtimeReport: RuntimeVerificationReport | RuntimeEvidenceReportV02,
  ): Promise<{ project: ProjectState; result: RuntimeIngestResult }> {
    const nextProject = { ...project, runtimeReport };
    const dashboard = await this.deps.projects.saveRuntimeReport(
      this.deps.actor,
      nextProject,
      runtimeReport,
      `${runtimeReport.runtimeReportId}:patch-result`,
    );
    return {
      project: nextProject,
      result: {
        status: runtimeReport.status === "passed" ? "hello_world_passed" : "hello_world_failed",
        bridgeId: project.bridge.bridgeId,
        localeBranchId: project.localeBranchId,
        patchExportId: project.patchExport?.patchExportId,
        patchResultId: `${runtimeReport.runtimeReportId}:patch-result`,
        runtimeReportId: runtimeReport.runtimeReportId,
        dashboard,
      },
    };
  }

  async ingestPatchResult(_project: ProjectState, _patchResult: PatchResultV02): Promise<never> {
    throw new ProjectWorkflowCapabilityError("patch-result persistence");
  }

  async ingestConformanceReport(
    project: ProjectState,
    input: { manifest?: ConformanceManifestV01; results: ConformanceResultV01[] },
  ) {
    const runId = conformanceRunId(project.projectId, input);
    const recordedAt = latestRecordedAt(input.results);
    const saved = await this.deps.conformance.saveConformanceRun(this.deps.actor, {
      conformanceRunId: runId,
      projectId: project.projectId,
      localeBranchId: project.localeBranchId,
      reportArtifactId: `${runId}:report`,
      ...(input.manifest === undefined ? {} : { manifest: input.manifest }),
      results: input.results.map((result, index) => ({
        conformanceResultId: `${runId}:result:${String(index).padStart(3, "0")}`,
        result,
      })),
      recordedAt,
      metadata: {},
    });
    return { project, result: saved };
  }

  async recordFinding(
    projectId: string,
    input: {
      localeBranchId?: string;
      finding: FindingRecordV02;
      status?: "open" | "resolved" | "superseded";
    },
  ): Promise<FindingRecordResult> {
    await this.deps.projects.recordFinding(this.deps.actor, { projectId, ...input });
    return { findingId: input.finding.findingId, status: input.status ?? "open" };
  }

  async recordBenchmarkReport(
    projectId: string,
    input: { benchmarkReport: BenchmarkReportV02 },
  ): Promise<BenchmarkRecordResult> {
    await this.deps.projects.recordBenchmarkArtifactWithProviderLedger(
      this.deps.actor,
      benchmarkArtifactInput(projectId, input.benchmarkReport),
    );
    return {
      benchmarkRunId: input.benchmarkReport.benchmarkRunId,
      artifactId: input.benchmarkReport.benchmarkRunId,
      status: input.benchmarkReport.status,
      systemCount: input.benchmarkReport.systemsCompared.length,
      findingCount: input.benchmarkReport.findingRecords.length,
    };
  }

  async launchNextLocalizationPass(input: {
    projectId: string;
    localeBranchId: string;
  }): Promise<LaunchLocalizationPassResult> {
    const config = await this.deps.passRunConfig.resolveRunConfig(
      input.projectId,
      input.localeBranchId,
    );
    if (config === null) {
      return {
        outcome: "refused",
        refusalMessage: `no pass run configuration is saved for project ${input.projectId} and locale branch ${input.localeBranchId}`,
      };
    }
    void config;
    throw new ProjectWorkflowCapabilityError("localization pass execution");
  }

  private async getTelemetry(projectId: string): Promise<ProjectTelemetryTimeseries> {
    return await this.deps.ledger.getProjectTelemetryTimeseries(this.deps.actor, projectId);
  }
}

function projectForBridge(
  bridge: BridgeBundle | BridgeBundleV02,
  targetLocale: string,
): ProjectState {
  const projectId = bridge.schemaVersion === "0.2.0" ? bridge.sourceGame.gameId : bridge.bridgeId;
  const localeBranchId = `${projectId}:${targetLocale}`;
  // The bridge import API predates mp-01's explicit engine-binding fields.
  // Preserve its real source-bundle write; engine-aware onboarding supplies a
  // complete binding through ensureRunProjectScope before creating a run.
  return {
    projectId,
    bridge,
    localeBranchId,
    targetLocale,
    drafts: {},
  } as ProjectState;
}

function conformanceRunId(
  projectId: string,
  input: { manifest?: ConformanceManifestV01; results: ConformanceResultV01[] },
): string {
  const content = JSON.stringify({
    projectId,
    manifest: input.manifest ?? null,
    results: input.results,
  });
  return `conformance:${createHash("sha256").update(content).digest("hex")}`;
}

function latestRecordedAt(results: readonly ConformanceResultV01[]): Date {
  const latest = results.reduce(
    (current, result) => Math.max(current, Date.parse(result.recordedAt)),
    Number.NEGATIVE_INFINITY,
  );
  return Number.isFinite(latest) ? new Date(latest) : new Date();
}
