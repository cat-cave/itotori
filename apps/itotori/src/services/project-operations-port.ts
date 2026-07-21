import type {
  ItotoriLlmSnapshotRepository,
  ItotoriProjectRepositoryPort,
  ItotoriProjectRunRepositoryPort,
} from "@itotori/db";

/**
 * The type-only project-operations boundary shared by the retained CLI and API
 * handlers. Implementations are injected by composition; this module owns no
 * workflow or provider behavior.
 */
export type RuntimeIngestResult = any;
export type FindingRecordResult = any;
export type BenchmarkRecordResult = any;

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
  reset(): Promise<any>;
  listLocaleBranchIdentities(...args: any[]): Promise<any>;
  getDashboardStatus(...args: any[]): Promise<any>;
  getRuntimeStatus(...args: any[]): Promise<any>;
  getDashboardDecisions(...args: any[]): Promise<any>;
  getProjectOverview(...args: any[]): Promise<any>;
  getCostReport(...args: any[]): Promise<any>;
  getCostDrilldown(...args: any[]): Promise<any>;
  getBenchmarkReports(...args: any[]): Promise<any>;
  importBridge(...args: any[]): Promise<any>;
  decodeExtract(...args: any[]): Promise<any>;
  ingestRuntimeReport(...args: any[]): Promise<any>;
  ingestPatchResult(...args: any[]): Promise<any>;
  ingestConformanceReport(...args: any[]): Promise<any>;
  recordFinding(...args: any[]): Promise<any>;
  recordBenchmarkReport(...args: any[]): Promise<any>;
  launchNextLocalizationPass(...args: any[]): Promise<any>;
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
  reserveCost(
    input: Parameters<ItotoriProjectRunRepositoryPort["reserveCost"]>[1],
  ): ReturnType<ItotoriProjectRunRepositoryPort["reserveCost"]>;
  settleCost(
    input: Parameters<ItotoriProjectRunRepositoryPort["settleCost"]>[1],
  ): ReturnType<ItotoriProjectRunRepositoryPort["settleCost"]>;
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
  ): ReturnType<ItotoriProjectRunRepositoryPort["loadLiveReadModel"]>;
};
