/**
 * Retired legacy localization-journal boundary.
 *
 * The resume/agentic localization subsystem no longer owns a database
 * contract. These exports remain only so the package barrel stays loadable
 * while consumers migrate to the new pipeline.
 */
type Retired = any;

export type LocalizationJournalTimestamp = Retired;
export type LocalizationJournalAttemptValidationResult = Retired;
export type LocalizationJournalAttemptRetryDecision = Retired;
export type LocalizationJournalAttemptCostKind = Retired;
export type LocalizationJournalAttemptBillingState = Retired;
export type LocalizationJournalAttemptLifecycleState = Retired;
export const LOCALIZATION_JOURNAL_RUN_LEASE_SECONDS = 120;
export type LocalizationJournalRunLeaseIdentity = Retired;
export type LocalizationJournalRunLeaseDeadline = Retired;
export type SeedLocalizationJournalRunLeaseInput = Retired;
export type LocalizationJournalRunStatus = Retired;
export type LocalizationJournalOperationalBlocker = Retired;
export type LocalizationJournalUnitNextAction = Retired;
export type LocalizationJournalRunUnitState = Retired;
export type SeedLocalizationJournalRunUnitInput = Retired;
export type SeedLocalizationJournalRefinementWikiHeadInput = Retired;
export type SeedLocalizationJournalRefinementInput = Retired;
export type SeedLocalizationJournalRunInput = Retired;
export type BeginLocalizationJournalAttemptInput = Retired;
export type ReserveLocalizationJournalAttemptInput = Retired;
export type LocalizationJournalRunCostAccountRecord = Retired;
export type LocalizationJournalCostReservationRecord = Retired;
export type ReserveLocalizationJournalAttemptResult = Retired;
export type CompleteLocalizationJournalAttemptInput = Retired;
export type ReconcileLocalizationJournalAttemptBillingInput = Retired;
export type PersistLocalizationJournalAttemptInput = Retired;
export type PersistLocalizationJournalAttemptsInput = Retired;
export type LocalizationJournalOutcomeContextRefInput = Retired;
export type LocalizationJournalOutcomeContextRef = Retired;
export type LocalizationJournalQaDetail = Retired;
export type LocalizationJournalQaDetailsByFindingId = Retired;
export type PersistLocalizationJournalUnitInput = Retired;
export type CreateLocalizationJournalRunInput = Retired;
export type LocalizationJournalRunRecord = Retired;
export type LocalizationJournalRunUnitRecord = Retired;
export type LocalizationJournalAttemptRecord = Retired;
export type LocalizationJournalDispatchingAttemptRecord = Retired;
export type LocalizationJournalRenewedRunRecord = Retired;
export type LocalizationJournalOutcomeRecord = Retired;
export type LocalizationJournalAttemptAggregateRow = Retired;
export type LocalizationJournalAttemptAggregateOptions = Retired;
export type LocalizationJournalZdrAggregateRow = Retired;
export type LocalizationJournalCostKindAggregateRow = Retired;
export const JOBS_RUN_TABLE_SCHEMA_VERSION = "retired";
export const JOBS_RUN_TABLE_DEFAULT_LIMIT = 20;
export const JOBS_RUN_TABLE_MAX_LIMIT = 100;
export type JobsRunTablePagination = {
  total: number;
  limit: number;
  offset: number;
  page: number;
  pageCount: number;
  hasMore: boolean;
  nextOffset: number | null;
};
export type JobsRunTableFilter = { projectId: string | null };
export type JobsRunTableTokens = { in: number | null; out: number | null; total: number | null };
export type JobsRunTableCost = { unit: "usd"; amount: string };
export type JobsRunTableFallback = {
  availability: "captured" | "not_captured";
  used: boolean | null;
  plan: string[] | null;
  chain: string[];
};
export type JobsRunTableRow = {
  runId: string;
  journalRunId: string;
  attemptId: string;
  providerRunId: string;
  bridgeUnitId: string;
  projectId: string;
  localeBranchId: string;
  task: string;
  status: string;
  servedModel: string;
  servedProvider: string;
  zdr: boolean;
  cost: JobsRunTableCost;
  tokens: JobsRunTableTokens;
  fallback: JobsRunTableFallback;
  createdAt: string;
};
export type JobsRunTableReadModel = {
  schemaVersion: string;
  generatedAt: string;
  filter: JobsRunTableFilter;
  pagination: JobsRunTablePagination;
  rows: JobsRunTableRow[];
};
export type LoadJobsRunTableOptions = Retired;
export type ItotoriLocalizationJournalRepositoryPort = Retired;

export class LocalizationJournalRepositoryError extends Error {}
export class ItotoriLocalizationJournalRepository {
  [key: string]: Retired;
  constructor(..._args: Retired[]) {}
}
export async function reserveRunCostAccountInTx(..._args: Retired[]): Promise<Retired> {
  throw new LocalizationJournalRepositoryError("The legacy localization journal has been removed.");
}
