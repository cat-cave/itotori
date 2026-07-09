import type {
  BenchmarkReportSummary,
  CostDrilldownFilter,
  CostDrilldownPage,
  DashboardDecisionReadModel,
  ItotoriLocalizationPassLedgerRepositoryPort,
  LocalizationPassLedgerRecord,
  ProjectCostReport,
  ProjectDashboardStatus,
  ProjectTelemetryTimeseries,
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
  /**
   * Per-pass quality score (a 0..5 scalar) sourced from the pass's record body
   * when the orchestrator recorded one — null when the pass has no score field
   * (a real `null` is honest, never a fabricated zero). The Overview pass-
   * ledger panel renders this column from this field verbatim.
   */
  score: number | null;
  /**
   * The count of feedback notes this pass consumed (carried in from reviewers /
   * prior-pass corrections). Sourced from `consumedFeedbackNotes.length` in the
   * record body; falls back to a top-level `feedback` integer when the body
   * uses the legacy shape. Always present (zero is a real value).
   */
  feedback: number;
  /**
   * A free-form per-pass note (the orchestrator's iteration comment). Sourced
   * from the record body; empty string when none was recorded.
   */
  note: string;
};

export type ProjectOverviewPassLedgerPage = {
  filter: ProjectOverviewPassLedgerFilter;
  pagination: ProjectOverviewPagination;
  rows: ProjectOverviewPassLedgerRow[];
  /**
   * Canonical latest pass for the selected locale branch, independent of the
   * current page window. The page rows remain ascending/paginated for the ledger
   * table; summary surfaces use this field so page 1 cannot masquerade as the
   * latest pass when the branch has more rows than the page limit.
   */
  latestRow?: ProjectOverviewPassLedgerRow | null;
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
  passLedger: ProjectOverviewPassLedgerPage;
  benchmarkHeadline: ProjectOverviewBenchmarkHeadline;
  /**
   * ovw-launch-pass-action — whether the CALLER may STEER the localization
   * (drive the next pass). Sourced server-side from the caller's `draft.write`
   * (steer) permission — the SAME permission that protects the pass ledger —
   * so the Overview launch-pass action gates itself off this composed payload
   * (never a client-fabricated capability). Defaults to `true` for trusted
   * internal (non-HTTP) callers; the API boundary sets it from the permission.
   */
  canSteer: boolean;
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
  /**
   * SECURITY (redaction/permission boundary) — whether the caller is permitted
   * to see the `draft.write`-protected pass ledger. When `false`, the pass
   * ledger is NEVER read from the repository; an empty page is composed inside
   * the boundary so no protected rows are ever assembled for an unpermitted
   * caller. Defaults to `true` for trusted internal (non-HTTP) callers; the API
   * boundary sets it from the caller's `draft.write` permission.
   */
  includePassLedger?: boolean;
  /**
   * ovw-launch-pass-action — whether the caller may STEER the localization
   * (drive the next pass). Surfaced on the composed overview as `canSteer` so
   * the Overview launch-pass action gates itself off the payload it already
   * reads. Defaults to `true` for trusted internal callers; the API boundary
   * sets it from the caller's `draft.write` (steer) permission — the SAME
   * permission as `includePassLedger`.
   */
  canSteer?: boolean;
};

/**
 * SECURITY — refuses to compose a MIXED-PROJECT overview. The composed
 * `progress` (and the locale-branch set that scopes the pass ledger) is taken
 * from `status`; if a caller targets `projectId` A while handing in project B's
 * status, the overview would splice B's progress + branches onto A's cost /
 * decisions. This error makes that impossible at the composition seam.
 */
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
  passLedgerRepository?: ItotoriLocalizationPassLedgerRepositoryPort;
  options?: ProjectOverviewReadModelOptions;
};

const DEFAULT_PASS_LEDGER_LIMIT = 10;
const MAX_PASS_LEDGER_LIMIT = 100;

export async function composeProjectOverviewReadModel(
  input: ComposeProjectOverviewInput,
): Promise<ProjectOverviewReadModel> {
  // P2 — the target project is authoritative. When a `projectId` is requested
  // it MUST equal the supplied status' project; otherwise progress + the
  // locale-branch set (which scopes the pass ledger) would come from a
  // different project than cost / decisions / benchmarks.
  if (
    input.options?.projectId !== undefined &&
    input.options.projectId !== input.status.projectId
  ) {
    throw new ProjectOverviewProjectMismatchError(input.options.projectId, input.status.projectId);
  }
  const projectId = input.options?.projectId ?? input.status.projectId;
  const passLedger = await loadProjectOverviewPassLedgerPage({
    actor: input.actor,
    projectId,
    status: input.status,
    includePassLedger: input.options?.includePassLedger ?? true,
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
    telemetry: input.telemetry,
    costDrilldown: input.costDrilldown,
    passLedger,
    benchmarkHeadline: {
      reportCount: input.benchmarkReports.length,
      latestReport: input.benchmarkReports[0] ?? null,
    },
    // ovw-launch-pass-action — the caller's steer capability. Defaults to true
    // for trusted internal callers; the API boundary passes the caller's
    // `draft.write` permission.
    canSteer: input.options?.canSteer ?? true,
  };
}

export async function loadProjectOverviewPassLedgerPage(input: {
  actor: AuthorizationActor;
  projectId: string;
  status: ProjectDashboardStatus;
  includePassLedger?: boolean;
  repository?: ItotoriLocalizationPassLedgerRepositoryPort;
  options?: ProjectOverviewPassLedgerPageOptions;
}): Promise<ProjectOverviewPassLedgerPage> {
  const localeBranchId = selectedPassLedgerLocaleBranchId(input.status, input.options);
  const limit = normalizePassLedgerLimit(input.options?.limit);
  const offset = normalizePassLedgerOffset(input.options?.offset);

  // The pass ledger is read (and its rows composed) ONLY inside the
  // permission boundary and ONLY for a branch this project owns:
  //   - `includePassLedger === false` — the caller lacks the `draft.write`
  //     permission that protects the ledger; never read it.
  //   - `localeBranchId === null` — either no branch is selectable or the
  //     caller supplied a branch that does NOT belong to this project (see
  //     `selectedPassLedgerLocaleBranchId`); refusing here closes the
  //     cross-project pass-ledger leak.
  const includePassLedger = input.includePassLedger ?? true;
  if (!includePassLedger || input.repository === undefined || localeBranchId === null) {
    return emptyPassLedgerPage(input.projectId, localeBranchId, limit, offset);
  }

  const records = await input.repository.loadPassesForBranch(input.actor, localeBranchId);
  const pageRows = records.slice(offset, offset + limit).map(passLedgerRow);
  const latestRecord = latestPassLedgerRecord(records);
  return {
    filter: { projectId: input.projectId, localeBranchId },
    pagination: pagination(records.length, limit, offset),
    rows: pageRows,
    latestRow: latestRecord === null ? null : passLedgerRow(latestRecord),
  };
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
    passLedger: {
      ...overview.passLedger,
      rows: [],
      latestRow: null,
    },
  };
}

function selectedPassLedgerLocaleBranchId(
  status: ProjectDashboardStatus,
  options: ProjectOverviewPassLedgerPageOptions | undefined,
): string | null {
  const requested = options?.localeBranchId;
  if (requested !== undefined) {
    // SECURITY (cross-project leak) — a caller-supplied locale-branch id is
    // TRUSTED only after confirming it belongs to the TARGET project.
    // `status.localeBranches` is the target project's own branch set (the
    // status is scoped to the target project), so a branch id from ANOTHER
    // project is not present here and is refused (→ null → empty page). This
    // is what makes it impossible to read another project's pass ledger by
    // passing its branch id.
    const projectOwnsBranch = status.localeBranches.some(
      (branch) => branch.localeBranchId === requested,
    );
    return projectOwnsBranch ? requested : null;
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
    latestRow: null,
  };
}

function latestPassLedgerRecord(
  records: readonly LocalizationPassLedgerRecord[],
): LocalizationPassLedgerRecord | null {
  let latest: LocalizationPassLedgerRecord | null = null;
  for (const record of records) {
    if (latest === null || record.passNumber > latest.passNumber) {
      latest = record;
    }
  }
  return latest;
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
    ...extractPassLedgerIterationSignals(record.recordBody),
  };
}

/**
 * Per-pass iteration signals (score / feedback / note) defensively extracted
 * from the generic pass record body. The body is opaque to this read-model —
 * `score` is null when absent (a real null is honest, never fabricated zero);
 * `feedback` falls back to a top-level integer then to the consumed-feedback
 * notes array length (zero is a real value); `note` is the empty string when
 * the body carried no free-form note. The record body shape is owned by the
 * orchestrator's `LocalizationPassRecord`; this reader is shaped to accept its
 * currently-recorded keys (`score` / `feedback` / `note`) AND its structured
 * `consumedFeedbackNotes` fallback.
 */
function extractPassLedgerIterationSignals(recordBody: Record<string, unknown>): {
  score: number | null;
  feedback: number;
  note: string;
} {
  const scoreValue = recordBody["score"];
  const noteValue = recordBody["note"];
  const feedbackValue = recordBody["feedback"];
  const consumedFeedbackNotes = recordBody["consumedFeedbackNotes"];
  const feedbackCount =
    typeof feedbackValue === "number"
      ? feedbackValue
      : Array.isArray(consumedFeedbackNotes)
        ? consumedFeedbackNotes.length
        : 0;
  return {
    score: typeof scoreValue === "number" ? scoreValue : null,
    feedback: feedbackCount,
    note: typeof noteValue === "string" ? noteValue : "",
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
