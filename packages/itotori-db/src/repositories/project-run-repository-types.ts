import type { AuthorizationActor } from "../authorization.js";
import type { ProjectRunProgressStatus, ProjectRunStatus } from "../schema.js";

export const PROJECT_RUN_LIVE_READ_MODEL_SCHEMA_VERSION = "itotori.project-run.live.v1";

export type ProjectRunLeaseFence = {
  projectId: string;
  runId: string;
  leaseOwnerId: string;
  fenceToken: number;
};

export type ProjectRunRecord = {
  projectId: string;
  runId: string;
  localeBranchId: string;
  contextSnapshotId: string;
  localizationSnapshotId: string;
  status: ProjectRunStatus;
  leaseOwnerId: string | null;
  leaseExpiresAt: Date | null;
  fenceToken: number;
  createdAt: Date;
  updatedAt: Date;
  cost: ProjectRunCostAccountRecord;
};

export type ProjectRunCostAccountRecord = {
  capMicrosUsd: number | null;
  spentMicrosUsd: number;
  reservedMicrosUsd: number;
};

export type ProjectRunProgressRecord = {
  bridgeUnitId: string;
  role: string;
  status: ProjectRunProgressStatus;
  costMicrosUsd: number;
  coveragePercent: number;
  blockers: string[];
  updatedAt: Date;
};

export type ProjectRunCostReservationRecord = {
  reservationId: string;
  reservedMicrosUsd: number;
  settledMicrosUsd: number | null;
  state: "reserved" | "settled" | "released";
  createdAt: Date;
  settledAt: Date | null;
  releasedAt: Date | null;
};

export type ProjectRunLease = ProjectRunLeaseFence & { leaseExpiresAt: Date };

export type CreateProjectRunInput = {
  projectId: string;
  runId: string;
  localeBranchId: string;
  contextSnapshotId: string;
  localizationSnapshotId: string;
  capMicrosUsd: number | null;
};

export type AdvanceProjectRunInput = { lease: ProjectRunLeaseFence; status: ProjectRunStatus };

export type RecordProjectRunProgressInput = {
  lease: ProjectRunLeaseFence;
  bridgeUnitId: string;
  role: string;
  status: ProjectRunProgressStatus;
  costMicrosUsd: number;
  coveragePercent: number;
  blockers?: readonly string[];
};

/** One lease-checked transaction. The repository refuses more than 500 rows. */
export type RecordProjectRunProgressBatchInput = {
  lease: ProjectRunLeaseFence;
  progress: readonly Omit<RecordProjectRunProgressInput, "lease">[];
};

export type ReserveProjectRunCostInput = {
  lease: ProjectRunLeaseFence;
  reservationId: string;
  reservedMicrosUsd: number;
};

export type SettleProjectRunCostInput = {
  lease: ProjectRunLeaseFence;
  reservationId: string;
  settledMicrosUsd: number;
};

export type ReleaseProjectRunCostInput = {
  lease: ProjectRunLeaseFence;
  reservationId: string;
};

export type AcquireProjectRunLeaseInput = {
  projectId: string;
  runId: string;
  leaseOwnerId: string;
  leaseDurationSeconds?: number;
};

export type RenewProjectRunLeaseInput = {
  lease: ProjectRunLeaseFence;
  leaseDurationSeconds?: number;
};

export type ProjectRunLiveReadModel = {
  schemaVersion: typeof PROJECT_RUN_LIVE_READ_MODEL_SCHEMA_VERSION;
  run: ProjectRunRecord;
  progress: {
    statusCounts: Record<ProjectRunProgressStatus, number>;
    unitCount: number;
    blockerCount: number;
    totalCostMicrosUsd: number;
    averageCoveragePercent: number;
  };
  unitPage?: ProjectRunProgressPage;
  blockerPage?: ProjectRunBlockerPage;
};

export type ProjectRunProgressPage = {
  total: number;
  limit: number;
  offset: number;
  items: ProjectRunProgressRecord[];
};

export type ProjectRunBlockerPage = {
  total: number;
  limit: number;
  offset: number;
  items: Array<{ bridgeUnitId: string; role: string; blockers: string[] }>;
};

export type ProjectRunLiveReadModelOptions = {
  unitPage?: { limit: number; offset: number };
  blockerPage?: { limit: number; offset: number };
};

/**
 * Persisted, operator-facing run facts.  This deliberately joins the run's
 * immutable localization snapshot to physical LLM receipts: a served pair is
 * absent when it was not captured, never inferred from routing configuration.
 */
export type ProjectRunDashboardRow = {
  runId: string;
  projectId: string;
  localeBranchId: string;
  status: ProjectRunStatus;
  createdAt: Date;
  updatedAt: Date;
  attemptedUnitCount: number;
  finalizedUnitCount: number;
  patchedUnitCount: number;
  physicalCallCount: number;
  deadlineFailureCount: number;
  spentMicrosUsd: number;
  reservedMicrosUsd: number;
  servedPairs: Array<{ model: string; provider: string }>;
  patchVersionId: string | null;
  patchStatus: string | null;
};

export type ProjectRunDashboardPage = {
  total: number;
  rows: ProjectRunDashboardRow[];
  latestRow: ProjectRunDashboardRow | null;
};

/** Counts for each durable unit-progress state. */
export type ProjectRunProgressStatusCounts = Record<ProjectRunProgressStatus, number>;

/** Counts for each durable run status. */
export type ProjectRunStatusCounts = Record<ProjectRunStatus, number>;

/** A blocked unit-role record, scoped to the run that produced it. */
export type ProjectRunPortfolioBlocker = {
  runId: string;
  bridgeUnitId: string;
  role: string;
  blockers: string[];
};

/**
 * Cross-run, per-project live-progress rollup for the portfolio surface.
 *
 * `unitCounts` counts distinct bridge units in each state; `roleCounts`
 * counts unit-role records, preserving the role that owns the work. Both are
 * SQL aggregates rather than a materialized collection of every unit.
 */
export type ProjectRunPortfolioProgressSummary = {
  projectId: string;
  runCount: number;
  runStatusCounts: ProjectRunStatusCounts;
  unitCounts: ProjectRunProgressStatusCounts;
  roleCounts: Record<string, ProjectRunProgressStatusCounts>;
  totalCostMicrosUsd: number;
  averageCoveragePercent: number;
  blockers: ProjectRunPortfolioBlocker[];
};

export interface ItotoriProjectRunRepositoryPort {
  createRun(actor: AuthorizationActor, input: CreateProjectRunInput): Promise<ProjectRunRecord>;
  /** Re-enter a non-terminal run only when every immutable run binding agrees. */
  createOrResumeRun(
    actor: AuthorizationActor,
    input: CreateProjectRunInput,
  ): Promise<ProjectRunRecord>;
  advanceRun(actor: AuthorizationActor, input: AdvanceProjectRunInput): Promise<ProjectRunRecord>;
  recordProgress(
    actor: AuthorizationActor,
    input: RecordProjectRunProgressInput,
  ): Promise<ProjectRunProgressRecord>;
  recordProgressBatch(
    actor: AuthorizationActor,
    input: RecordProjectRunProgressBatchInput,
  ): Promise<ProjectRunProgressRecord[]>;
  reserveCost(
    actor: AuthorizationActor,
    input: ReserveProjectRunCostInput,
  ): Promise<ProjectRunCostReservationRecord>;
  settleCost(
    actor: AuthorizationActor,
    input: SettleProjectRunCostInput,
  ): Promise<ProjectRunCostReservationRecord>;
  releaseCost(
    actor: AuthorizationActor,
    input: ReleaseProjectRunCostInput,
  ): Promise<ProjectRunCostReservationRecord>;
  acquireLease(
    actor: AuthorizationActor,
    input: AcquireProjectRunLeaseInput,
  ): Promise<ProjectRunLease>;
  renewLease(actor: AuthorizationActor, input: RenewProjectRunLeaseInput): Promise<ProjectRunLease>;
  releaseLease(actor: AuthorizationActor, lease: ProjectRunLeaseFence): Promise<void>;
  loadLiveReadModel(
    actor: AuthorizationActor,
    projectId: string,
    runId: string,
    options?: ProjectRunLiveReadModelOptions,
  ): Promise<ProjectRunLiveReadModel | null>;
  listDashboardRuns(
    actor: AuthorizationActor,
    input: { projectId: string; localeBranchId: string | null; limit: number; offset: number },
  ): Promise<ProjectRunDashboardPage>;
  listPortfolioProgress(actor: AuthorizationActor): Promise<ProjectRunPortfolioProgressSummary[]>;
}
