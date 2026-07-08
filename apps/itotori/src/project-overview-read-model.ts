import type {
  BenchmarkReportSummary,
  CostDrilldownFilter,
  CostDrilldownPage,
  DashboardDecisionReadModel,
  ItotoriLocalizationPassLedgerRepositoryPort,
  LocalizationPassLedgerRecord,
  ProjectCostReport,
  ProjectDashboardStatus,
} from "@itotori/db";
import type { AuthorizationActor } from "@itotori/db";

export const PROJECT_OVERVIEW_SCHEMA_VERSION = "projects.overview.v0.1";

export type ProjectOverviewPassLedgerFilter = {
  projectId: string;
  localeBranchId: string | null;
};

export type ProjectOverviewPagination = {
  total: number;
  limit: number;
  offset: number;
  page: number;
  pageCount: number;
  hasMore: boolean;
  nextOffset: number | null;
};

export type ProjectOverviewPassLedgerRow = {
  passLedgerId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  passNumber: number;
  priorPassNumber: number | null;
  totalUsageCostUsd: number;
  zdrConfirmed: boolean;
  recordedAt: string;
};

export type ProjectOverviewPassLedgerPage = {
  filter: ProjectOverviewPassLedgerFilter;
  pagination: ProjectOverviewPagination;
  rows: ProjectOverviewPassLedgerRow[];
};

export type ProjectOverviewBenchmarkHeadline = {
  reportCount: number;
  latestReport: BenchmarkReportSummary | null;
};

export type ProjectOverviewReadModel = {
  schemaVersion: typeof PROJECT_OVERVIEW_SCHEMA_VERSION;
  generatedAt: string;
  projectId: string;
  progress: ProjectDashboardStatus;
  decisions: DashboardDecisionReadModel;
  cost: ProjectCostReport;
  costDrilldown: CostDrilldownPage;
  passLedger: ProjectOverviewPassLedgerPage;
  benchmarkHeadline: ProjectOverviewBenchmarkHeadline;
};

export type ProjectOverviewPassLedgerPageOptions = {
  localeBranchId?: string;
  limit?: number;
  offset?: number;
};

export type ProjectOverviewReadModelOptions = {
  projectId?: string;
  generatedAt?: Date;
  costDrilldown?: CostDrilldownFilter;
  passLedger?: ProjectOverviewPassLedgerPageOptions;
};

export type ComposeProjectOverviewInput = {
  actor: AuthorizationActor;
  status: ProjectDashboardStatus;
  decisions: DashboardDecisionReadModel;
  cost: ProjectCostReport;
  costDrilldown: CostDrilldownPage;
  benchmarkReports: readonly BenchmarkReportSummary[];
  passLedgerRepository?: ItotoriLocalizationPassLedgerRepositoryPort;
  options?: ProjectOverviewReadModelOptions;
};

const DEFAULT_PASS_LEDGER_LIMIT = 10;
const MAX_PASS_LEDGER_LIMIT = 100;

export async function composeProjectOverviewReadModel(
  input: ComposeProjectOverviewInput,
): Promise<ProjectOverviewReadModel> {
  const projectId = input.options?.projectId ?? input.status.projectId;
  const passLedger = await loadProjectOverviewPassLedgerPage({
    actor: input.actor,
    projectId,
    status: input.status,
    ...(input.passLedgerRepository !== undefined ? { repository: input.passLedgerRepository } : {}),
    ...(input.options?.passLedger !== undefined ? { options: input.options.passLedger } : {}),
  });

  return {
    schemaVersion: PROJECT_OVERVIEW_SCHEMA_VERSION,
    generatedAt: (input.options?.generatedAt ?? new Date()).toISOString(),
    projectId,
    progress: input.status,
    decisions: input.decisions,
    cost: input.cost,
    costDrilldown: input.costDrilldown,
    passLedger,
    benchmarkHeadline: {
      reportCount: input.benchmarkReports.length,
      latestReport: input.benchmarkReports[0] ?? null,
    },
  };
}

export async function loadProjectOverviewPassLedgerPage(input: {
  actor: AuthorizationActor;
  projectId: string;
  status: ProjectDashboardStatus;
  repository?: ItotoriLocalizationPassLedgerRepositoryPort;
  options?: ProjectOverviewPassLedgerPageOptions;
}): Promise<ProjectOverviewPassLedgerPage> {
  const localeBranchId = selectedPassLedgerLocaleBranchId(input.status, input.options);
  const limit = normalizePassLedgerLimit(input.options?.limit);
  const offset = normalizePassLedgerOffset(input.options?.offset);

  if (input.repository === undefined || localeBranchId === null) {
    return emptyPassLedgerPage(input.projectId, localeBranchId, limit, offset);
  }

  const records = await input.repository.loadPassesForBranch(input.actor, localeBranchId);
  const pageRows = records.slice(offset, offset + limit).map(passLedgerRow);
  return {
    filter: { projectId: input.projectId, localeBranchId },
    pagination: pagination(records.length, limit, offset),
    rows: pageRows,
  };
}

export function redactProjectOverviewReadModel(
  overview: ProjectOverviewReadModel,
  redactions: {
    progress: ProjectDashboardStatus;
    cost: ProjectCostReport;
    costDrilldown: CostDrilldownPage;
  },
): ProjectOverviewReadModel {
  return {
    ...overview,
    progress: redactions.progress,
    cost: redactions.cost,
    costDrilldown: redactions.costDrilldown,
    passLedger: {
      ...overview.passLedger,
      rows: [],
    },
  };
}

function selectedPassLedgerLocaleBranchId(
  status: ProjectDashboardStatus,
  options: ProjectOverviewPassLedgerPageOptions | undefined,
): string | null {
  if (options?.localeBranchId !== undefined) {
    return options.localeBranchId;
  }
  return status.selectedLocaleBranchId ?? status.localeBranches[0]?.localeBranchId ?? null;
}

function normalizePassLedgerLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_PASS_LEDGER_LIMIT;
  }
  return Math.min(limit, MAX_PASS_LEDGER_LIMIT);
}

function normalizePassLedgerOffset(offset: number | undefined): number {
  return offset ?? 0;
}

function emptyPassLedgerPage(
  projectId: string,
  localeBranchId: string | null,
  limit: number,
  offset: number,
): ProjectOverviewPassLedgerPage {
  return {
    filter: { projectId, localeBranchId },
    pagination: pagination(0, limit, offset),
    rows: [],
  };
}

function passLedgerRow(record: LocalizationPassLedgerRecord): ProjectOverviewPassLedgerRow {
  return {
    passLedgerId: record.passLedgerId,
    projectId: record.projectId,
    localeBranchId: record.localeBranchId,
    sourceRevisionId: record.sourceRevisionId,
    passNumber: record.passNumber,
    priorPassNumber: record.priorPassNumber ?? null,
    totalUsageCostUsd: record.totalUsageCostUsd,
    zdrConfirmed: record.zdrConfirmed,
    recordedAt: record.recordedAt.toISOString(),
  };
}

function pagination(total: number, limit: number, offset: number): ProjectOverviewPagination {
  const pageCount = total === 0 ? 0 : Math.ceil(total / limit);
  const hasMore = offset + limit < total;
  return {
    total,
    limit,
    offset,
    page: Math.floor(offset / limit) + 1,
    pageCount,
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
  };
}
