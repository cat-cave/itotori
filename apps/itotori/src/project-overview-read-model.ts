import type {
  BenchmarkReportSummary,
  CostDrilldownFilter,
  CostDrilldownPage,
  DashboardDecisionReadModel,
  ProjectCostReport,
  ProjectDashboardStatus,
  ProjectTelemetryTimeseries,
} from "@itotori/db";
import type { AuthorizationActor } from "@itotori/db";

export const PROJECT_OVERVIEW_SCHEMA_VERSION = "projects.overview.v0.1";

/** The selected branch scope for the durable execution-journal review surface. */
export type ProjectOverviewJournalFilter = {
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

/**
 * A reviewable projection of one durable localization run. Every count is
 * derived from normalized journal rows; no pass-record payload is read or
 * reconstructed here.
 */
export type ProjectOverviewJournalRow = {
  journalRunId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  targetLocale: string;
  createdAt: string;
  physicalCallCount: number;
  failedPhysicalCallCount: number;
  writtenOutcomeCount: number;
  candidateCount: number;
  qaFindingCount: number;
  contextRefCount: number;
  speakerLabelCount: number;
};

export type ProjectOverviewJournalPage = {
  filter: ProjectOverviewJournalFilter;
  pagination: ProjectOverviewPagination;
  rows: ProjectOverviewJournalRow[];
  /** Latest durable run on the selected branch, independent of page window. */
  latestRow?: ProjectOverviewJournalRow | null;
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
  telemetry: ProjectTelemetryTimeseries;
  costDrilldown: CostDrilldownPage;
  /** Durable run/attempt/outcome provenance for operator review. */
  journal: ProjectOverviewJournalPage;
  benchmarkHeadline: ProjectOverviewBenchmarkHeadline;
  /** Whether the caller may steer a new localization run. */
  canSteer: boolean;
};

export type ProjectOverviewJournalPageOptions = {
  localeBranchId?: string;
  limit?: number;
  offset?: number;
};

export type ProjectOverviewReadModelOptions = {
  projectId?: string;
  generatedAt?: Date;
  costDrilldown?: CostDrilldownFilter;
  journal?: ProjectOverviewJournalPageOptions;
  /**
   * Permission-bound composition guard. The HTTP boundary sets this from
   * `catalog.read`, the journal repository's read permission, before any
   * provenance is loaded with the trusted service actor.
   */
  includeJournal?: boolean;
  /** Server-derived permission to launch a new localization run. */
  canSteer?: boolean;
};

/** Refuses to compose a mixed-project overview. */
export class ProjectOverviewProjectMismatchError extends Error {
  constructor(
    readonly requestedProjectId: string,
    readonly statusProjectId: string,
  ) {
    super(
      `refusing to compose a mixed-project overview: requested projectId ${requestedProjectId} ` +
        `but the supplied dashboard status is for ${statusProjectId}`,
    );
    this.name = "ProjectOverviewProjectMismatchError";
  }
}

export type ComposeProjectOverviewInput = {
  actor: AuthorizationActor;
  status: ProjectDashboardStatus;
  decisions: DashboardDecisionReadModel;
  cost: ProjectCostReport;
  telemetry: ProjectTelemetryTimeseries;
  costDrilldown: CostDrilldownPage;
  benchmarkReports: readonly BenchmarkReportSummary[];
  options?: ProjectOverviewReadModelOptions;
};

const DEFAULT_JOURNAL_LIMIT = 10;
const MAX_JOURNAL_LIMIT = 100;

export async function composeProjectOverviewReadModel(
  input: ComposeProjectOverviewInput,
): Promise<ProjectOverviewReadModel> {
  if (
    input.options?.projectId !== undefined &&
    input.options.projectId !== input.status.projectId
  ) {
    throw new ProjectOverviewProjectMismatchError(input.options.projectId, input.status.projectId);
  }
  const projectId = input.options?.projectId ?? input.status.projectId;
  const journal = await loadProjectOverviewJournalPage({
    actor: input.actor,
    projectId,
    status: input.status,
    includeJournal: input.options?.includeJournal ?? true,
    ...(input.options?.journal !== undefined ? { options: input.options.journal } : {}),
  });

  return {
    schemaVersion: PROJECT_OVERVIEW_SCHEMA_VERSION,
    generatedAt: (input.options?.generatedAt ?? new Date()).toISOString(),
    projectId,
    progress: input.status,
    decisions: input.decisions,
    cost: input.cost,
    telemetry: input.telemetry,
    costDrilldown: input.costDrilldown,
    journal,
    benchmarkHeadline: {
      reportCount: input.benchmarkReports.length,
      latestReport: input.benchmarkReports[0] ?? null,
    },
    canSteer: input.options?.canSteer ?? true,
  };
}

/**
 * Load the overview's journal projection from the normalized journal tables.
 * A foreign branch id is refused before the repository is called, so a
 * project-scoped overview can never expose another project's run provenance.
 */
export async function loadProjectOverviewJournalPage(input: {
  actor: AuthorizationActor;
  projectId: string;
  status: ProjectDashboardStatus;
  includeJournal?: boolean;
  options?: ProjectOverviewJournalPageOptions;
}): Promise<ProjectOverviewJournalPage> {
  const localeBranchId = selectedJournalLocaleBranchId(input.status, input.options);
  const limit = normalizeJournalLimit(input.options?.limit);
  const offset = normalizeJournalOffset(input.options?.offset);
  // RB-074 removed the journal persistence substrate. Preserve the stable
  // overview envelope while making the retired provenance panel explicitly
  // empty; it must not reach a compatibility repository.
  void input.actor;
  void input.includeJournal;
  return emptyJournalPage(input.projectId, localeBranchId, limit, offset);
}

export function redactProjectOverviewReadModel(
  overview: ProjectOverviewReadModel,
  redactions: {
    progress: ProjectDashboardStatus;
    cost: ProjectCostReport;
    telemetry: ProjectTelemetryTimeseries;
    costDrilldown: CostDrilldownPage;
  },
): ProjectOverviewReadModel {
  return {
    ...overview,
    progress: redactions.progress,
    cost: redactions.cost,
    telemetry: redactions.telemetry,
    costDrilldown: redactions.costDrilldown,
    journal: {
      ...overview.journal,
      rows: [],
      latestRow: null,
    },
  };
}

function selectedJournalLocaleBranchId(
  status: ProjectDashboardStatus,
  options: ProjectOverviewJournalPageOptions | undefined,
): string | null {
  const requested = options?.localeBranchId;
  if (requested !== undefined) {
    return status.localeBranches.some((branch) => branch.localeBranchId === requested)
      ? requested
      : null;
  }
  return status.selectedLocaleBranchId ?? status.localeBranches[0]?.localeBranchId ?? null;
}

function normalizeJournalLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_JOURNAL_LIMIT;
  return Math.min(limit, MAX_JOURNAL_LIMIT);
}

function normalizeJournalOffset(offset: number | undefined): number {
  return offset ?? 0;
}

function emptyJournalPage(
  projectId: string,
  localeBranchId: string | null,
  limit: number,
  offset: number,
): ProjectOverviewJournalPage {
  return {
    filter: { projectId, localeBranchId },
    pagination: pagination(0, limit, offset),
    rows: [],
    latestRow: null,
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
