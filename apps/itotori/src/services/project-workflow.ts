import type { ItotoriProjectRecord } from "@itotori/db";

/** Retained file-shape for ingestion commands while the production workflow is
 * supplied exclusively through the new composition ports. */
export type ProjectState = ItotoriProjectRecord;
export type RuntimeIngestResult = any;
export type FindingRecordResult = any;
export type BenchmarkRecordResult = any;
export type PatchResultIngestionResult = any;
export type ConformanceIngestResult = any;
export type ConformanceIngestInput = any;
export type DecodeExtractInput = {
  gameId: string;
  gameVersion: string;
  sourceProfileId: string;
  sourceLocale: string;
  scene?: number;
  wholeSeen?: boolean;
  gameRoot?: string;
  vaultCanonicalId?: string;
};
export type DecodeExtractOutcome = any;
export type LaunchLocalizationPassInput = any;
export type LaunchLocalizationPassResult = any;

/** A deliberately broad compatibility type for read-only project metadata that
 * has not yet been reassembled on the new composition substrate. It contains
 * no provider, journal, repair, or agent implementation. */
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

export type DecodeExtractPort = {
  runDecodeExtract(input: DecodeExtractInput): Promise<DecodeExtractOutcome>;
};
