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
};
