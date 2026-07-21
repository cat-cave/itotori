import { sql } from "drizzle-orm";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import {
  projectRunCostAccounts,
  projectRunCostReservations,
  projectRunProgress,
  projectRunStatusValues,
  projectRuns,
  projects,
  type ProjectRunProgressStatus,
  type ProjectRunStatus,
} from "../schema.js";
import {
  ItotoriProjectRunRepositoryError,
  assertCoverage,
  assertMicros,
  assertProgressStatus,
  assertRunStatus,
  canAdvance,
  emptyStatusCounts,
  fenceRejected,
  leaseFromRow,
  leaseSeconds,
  loadRun,
  loadRunOrNull,
  normalizeBlockers,
  normalizeCreate,
  normalizeLease,
  progressFromRow,
  progressRank,
  requireCurrentLease,
  requiredText,
  reservationById,
  reservationFromRow,
  rowsOf,
  toReservation,
  type SqlExecutor,
} from "./project-run-repository-internal.js";

export { ItotoriProjectRunRepositoryError } from "./project-run-repository-internal.js";

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
  state: "reserved" | "settled";
  createdAt: Date;
  settledAt: Date | null;
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
    totalCostMicrosUsd: number;
    averageCoveragePercent: number;
    blockers: Array<{ bridgeUnitId: string; role: string; blockers: string[] }>;
    units: ProjectRunProgressRecord[];
  };
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
  advanceRun(actor: AuthorizationActor, input: AdvanceProjectRunInput): Promise<ProjectRunRecord>;
  recordProgress(
    actor: AuthorizationActor,
    input: RecordProjectRunProgressInput,
  ): Promise<ProjectRunProgressRecord>;
  reserveCost(
    actor: AuthorizationActor,
    input: ReserveProjectRunCostInput,
  ): Promise<ProjectRunCostReservationRecord>;
  settleCost(
    actor: AuthorizationActor,
    input: SettleProjectRunCostInput,
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
  ): Promise<ProjectRunLiveReadModel | null>;
  listPortfolioProgress(actor: AuthorizationActor): Promise<ProjectRunPortfolioProgressSummary[]>;
}

export class ItotoriProjectRunRepository implements ItotoriProjectRunRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async createRun(
    actor: AuthorizationActor,
    input: CreateProjectRunInput,
  ): Promise<ProjectRunRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    const normalized = normalizeCreate(input);
    return this.db.transaction(async (tx) => {
      const executor = tx as unknown as SqlExecutor;
      const rows = await rowsOf(
        executor,
        sql`
        insert into ${projectRuns} (
          run_id, project_id, locale_branch_id, context_snapshot_id, localization_snapshot_id, status
        ) values (
          ${normalized.runId}, ${normalized.projectId}, ${normalized.localeBranchId},
          ${normalized.contextSnapshotId}, ${normalized.localizationSnapshotId}, ${projectRunStatusValues.queued}
        ) returning *
      `,
      );
      if (rows[0] === undefined) throw new Error("project run insert did not return a row");
      await executor.execute(sql`
        insert into ${projectRunCostAccounts} (run_id, project_id, cap_micros_usd)
        values (${normalized.runId}, ${normalized.projectId}, ${normalized.capMicrosUsd})
      `);
      return loadRun(executor, normalized.projectId, normalized.runId);
    });
  }

  async advanceRun(
    actor: AuthorizationActor,
    input: AdvanceProjectRunInput,
  ): Promise<ProjectRunRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    const lease = normalizeLease(input.lease);
    assertRunStatus(input.status);
    return this.db.transaction(async (tx) => {
      const executor = tx as unknown as SqlExecutor;
      const run = await requireCurrentLease(executor, lease);
      if (!canAdvance(String(run.status), input.status)) {
        throw new ItotoriProjectRunRepositoryError(
          "run_transition_rejected",
          `cannot advance run from ${String(run.status)} to ${input.status}`,
        );
      }
      await executor.execute(sql`
        update ${projectRuns} set status = ${input.status}, updated_at = now()
        where run_id = ${lease.runId} and project_id = ${lease.projectId}
      `);
      return loadRun(executor, lease.projectId, lease.runId);
    });
  }

  async recordProgress(
    actor: AuthorizationActor,
    input: RecordProjectRunProgressInput,
  ): Promise<ProjectRunProgressRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    const lease = normalizeLease(input.lease);
    const bridgeUnitId = requiredText(input.bridgeUnitId, "bridgeUnitId");
    const role = requiredText(input.role, "role");
    assertProgressStatus(input.status);
    assertMicros(input.costMicrosUsd, "costMicrosUsd");
    assertCoverage(input.coveragePercent);
    const blockers = normalizeBlockers(input.blockers ?? []);
    return this.db.transaction(async (tx) => {
      const executor = tx as unknown as SqlExecutor;
      await requireCurrentLease(executor, lease);
      const rows = await rowsOf(
        executor,
        sql`
        insert into ${projectRunProgress} (
          run_id, project_id, bridge_unit_id, role, status, cost_micros_usd, coverage_percent, blockers
        ) values (
          ${lease.runId}, ${lease.projectId}, ${bridgeUnitId}, ${role}, ${input.status},
          ${input.costMicrosUsd}, ${input.coveragePercent}, ${JSON.stringify(blockers)}::jsonb
        )
        on conflict (run_id, bridge_unit_id, role) do update set
          status = excluded.status, cost_micros_usd = excluded.cost_micros_usd,
          coverage_percent = excluded.coverage_percent, blockers = excluded.blockers, updated_at = now()
        where ${progressRank(projectRunProgress.status)} <= ${progressRank(sql`excluded.status`)}
        returning *
      `,
      );
      if (rows[0] === undefined) {
        throw new ItotoriProjectRunRepositoryError(
          "progress_regression",
          "project run progress cannot move backwards",
        );
      }
      return progressFromRow(rows[0]);
    });
  }

  async reserveCost(
    actor: AuthorizationActor,
    input: ReserveProjectRunCostInput,
  ): Promise<ProjectRunCostReservationRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    const lease = normalizeLease(input.lease);
    const reservationId = requiredText(input.reservationId, "reservationId");
    assertMicros(input.reservedMicrosUsd, "reservedMicrosUsd");
    return this.db.transaction(async (tx) => {
      const executor = tx as unknown as SqlExecutor;
      await requireCurrentLease(executor, lease);
      const inserted = await rowsOf(
        executor,
        sql`
        insert into ${projectRunCostReservations} (reservation_id, run_id, project_id, reserved_micros_usd)
        values (${reservationId}, ${lease.runId}, ${lease.projectId}, ${input.reservedMicrosUsd})
        on conflict (run_id, reservation_id) do nothing returning *
      `,
      );
      if (inserted[0] === undefined) {
        const existing = await reservationById(executor, lease.runId, reservationId);
        if (
          existing === null ||
          existing.projectId !== lease.projectId ||
          existing.reservedMicrosUsd !== input.reservedMicrosUsd
        ) {
          throw new Error("cost reservation ID is already bound to another reservation");
        }
        return toReservation(existing);
      }
      const updated = await rowsOf(
        executor,
        sql`
        update ${projectRunCostAccounts}
        set reserved_micros_usd = reserved_micros_usd + ${input.reservedMicrosUsd}, updated_at = now()
        where run_id = ${lease.runId} and project_id = ${lease.projectId}
          and (cap_micros_usd is null or spent_micros_usd + reserved_micros_usd + ${input.reservedMicrosUsd} <= cap_micros_usd)
        returning run_id
      `,
      );
      if (updated[0] === undefined) {
        throw new ItotoriProjectRunRepositoryError(
          "cost_cap_exceeded",
          "project run cost cap would be exceeded by this reservation",
        );
      }
      return reservationFromRow(inserted[0]);
    });
  }

  async settleCost(
    actor: AuthorizationActor,
    input: SettleProjectRunCostInput,
  ): Promise<ProjectRunCostReservationRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    const lease = normalizeLease(input.lease);
    const reservationId = requiredText(input.reservationId, "reservationId");
    assertMicros(input.settledMicrosUsd, "settledMicrosUsd");
    return this.db.transaction(async (tx) => {
      const executor = tx as unknown as SqlExecutor;
      await requireCurrentLease(executor, lease);
      const reservation = await reservationById(executor, lease.runId, reservationId, true);
      if (reservation === null || reservation.projectId !== lease.projectId) {
        throw new ItotoriProjectRunRepositoryError(
          "unknown_run",
          "cost reservation is outside this run",
        );
      }
      if (reservation.state === "settled") {
        if (reservation.settledMicrosUsd !== input.settledMicrosUsd)
          throw new Error("cost reservation is already settled to a different amount");
        return toReservation(reservation);
      }
      await executor.execute(sql`
        update ${projectRunCostAccounts}
        set spent_micros_usd = spent_micros_usd + ${input.settledMicrosUsd},
            reserved_micros_usd = reserved_micros_usd - ${reservation.reservedMicrosUsd}, updated_at = now()
        where run_id = ${lease.runId} and project_id = ${lease.projectId}
      `);
      const settled = await rowsOf(
        executor,
        sql`
        update ${projectRunCostReservations}
        set state = 'settled', settled_micros_usd = ${input.settledMicrosUsd}, settled_at = now()
        where run_id = ${lease.runId} and reservation_id = ${reservationId} and state = 'reserved' returning *
      `,
      );
      if (settled[0] === undefined) throw new Error("cost settlement lost its reservation");
      return reservationFromRow(settled[0]);
    });
  }

  async acquireLease(
    actor: AuthorizationActor,
    input: AcquireProjectRunLeaseInput,
  ): Promise<ProjectRunLease> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    const projectId = requiredText(input.projectId, "projectId");
    const runId = requiredText(input.runId, "runId");
    const ownerId = requiredText(input.leaseOwnerId, "leaseOwnerId");
    const seconds = leaseSeconds(input.leaseDurationSeconds);
    const rows = await rowsOf(
      this.db as unknown as SqlExecutor,
      sql`
      update ${projectRuns}
      set lease_owner_id = ${ownerId}, lease_expires_at = now() + (${seconds}::double precision * interval '1 second'),
          fence_token = fence_token + 1, updated_at = now()
      where run_id = ${runId} and project_id = ${projectId}
        and (lease_expires_at is null or lease_expires_at <= now())
      returning project_id, run_id, lease_owner_id, lease_expires_at, fence_token
    `,
    );
    if (rows[0] === undefined)
      throw new ItotoriProjectRunRepositoryError(
        "lease_unavailable",
        "project run lease is unavailable",
      );
    return leaseFromRow(rows[0]);
  }

  async renewLease(
    actor: AuthorizationActor,
    input: RenewProjectRunLeaseInput,
  ): Promise<ProjectRunLease> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    const lease = normalizeLease(input.lease);
    const seconds = leaseSeconds(input.leaseDurationSeconds);
    const rows = await rowsOf(
      this.db as unknown as SqlExecutor,
      sql`
      update ${projectRuns}
      set lease_expires_at = now() + (${seconds}::double precision * interval '1 second'), updated_at = now()
      where run_id = ${lease.runId} and project_id = ${lease.projectId}
        and lease_owner_id = ${lease.leaseOwnerId} and fence_token = ${lease.fenceToken}
        and lease_expires_at > now()
      returning project_id, run_id, lease_owner_id, lease_expires_at, fence_token
    `,
    );
    if (rows[0] === undefined) throw fenceRejected();
    return leaseFromRow(rows[0]);
  }

  async releaseLease(actor: AuthorizationActor, input: ProjectRunLeaseFence): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    const lease = normalizeLease(input);
    const rows = await rowsOf(
      this.db as unknown as SqlExecutor,
      sql`
      update ${projectRuns} set lease_owner_id = null, lease_expires_at = null, updated_at = now()
      where run_id = ${lease.runId} and project_id = ${lease.projectId}
        and lease_owner_id = ${lease.leaseOwnerId} and fence_token = ${lease.fenceToken}
        and lease_expires_at > now() returning run_id
    `,
    );
    if (rows[0] === undefined) throw fenceRejected();
  }

  async loadLiveReadModel(
    actor: AuthorizationActor,
    projectId: string,
    runId: string,
  ): Promise<ProjectRunLiveReadModel | null> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const project = requiredText(projectId, "projectId");
    const run = requiredText(runId, "runId");
    const executor = this.db as unknown as SqlExecutor;
    const runRecord = await loadRunOrNull(executor, project, run);
    if (runRecord === null) return null;
    const units = (
      await rowsOf(
        executor,
        sql`
      select * from ${projectRunProgress}
      where run_id = ${run} and project_id = ${project}
      order by bridge_unit_id asc, role asc
    `,
      )
    ).map(progressFromRow);
    const statusCounts = emptyStatusCounts();
    for (const unit of units) statusCounts[unit.status] += 1;
    const totalCostMicrosUsd = units.reduce((sum, unit) => sum + unit.costMicrosUsd, 0);
    const averageCoveragePercent =
      units.length === 0
        ? 0
        : units.reduce((sum, unit) => sum + unit.coveragePercent, 0) / units.length;
    return {
      schemaVersion: PROJECT_RUN_LIVE_READ_MODEL_SCHEMA_VERSION,
      run: runRecord,
      progress: {
        statusCounts,
        totalCostMicrosUsd,
        averageCoveragePercent,
        blockers: units
          .filter((unit) => unit.blockers.length > 0)
          .map(({ bridgeUnitId, role, blockers }) => ({ bridgeUnitId, role, blockers })),
        units,
      },
    };
  }

  async listPortfolioProgress(
    actor: AuthorizationActor,
  ): Promise<ProjectRunPortfolioProgressSummary[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const result = await this.db.execute(sql`
      with project_rollups as (
        select
          p.project_id,
          count(distinct r.run_id)::int as run_count,
          count(distinct r.run_id) filter (where r.status = 'queued')::int as queued_run_count,
          count(distinct r.run_id) filter (where r.status = 'running')::int as running_run_count,
          count(distinct r.run_id) filter (where r.status = 'paused')::int as paused_run_count,
          count(distinct r.run_id) filter (where r.status = 'completed')::int as completed_run_count,
          count(distinct r.run_id) filter (where r.status = 'failed')::int as failed_run_count,
          count(distinct r.run_id) filter (where r.status = 'cancelled')::int as cancelled_run_count,
          count(distinct progress.bridge_unit_id) filter (
            where progress.status = 'decoded'
          )::int as decoded_unit_count,
          count(distinct progress.bridge_unit_id) filter (
            where progress.status = 'drafted'
          )::int as drafted_unit_count,
          count(distinct progress.bridge_unit_id) filter (
            where progress.status = 'QA'
          )::int as qa_unit_count,
          count(distinct progress.bridge_unit_id) filter (
            where progress.status = 'accepted'
          )::int as accepted_unit_count,
          count(distinct progress.bridge_unit_id) filter (
            where progress.status = 'patched'
          )::int as patched_unit_count,
          coalesce(sum(progress.cost_micros_usd), 0)::text as total_cost_micros_usd,
          coalesce(avg(progress.coverage_percent), 0)::double precision as average_coverage_percent,
          coalesce(
            jsonb_agg(
              jsonb_build_object(
                'runId', progress.run_id,
                'bridgeUnitId', progress.bridge_unit_id,
                'role', progress.role,
                'blockers', progress.blockers
              )
              order by progress.run_id asc, progress.bridge_unit_id asc, progress.role asc
            ) filter (where jsonb_array_length(progress.blockers) > 0),
            '[]'::jsonb
          ) as blockers
        from ${projects} p
        left join ${projectRuns} r on r.project_id = p.project_id
        left join ${projectRunProgress} progress
          on progress.project_id = r.project_id and progress.run_id = r.run_id
        group by p.project_id
      ),
      role_rollups as (
        select
          project_id,
          role,
          count(*) filter (where status = 'decoded')::int as decoded_count,
          count(*) filter (where status = 'drafted')::int as drafted_count,
          count(*) filter (where status = 'QA')::int as qa_count,
          count(*) filter (where status = 'accepted')::int as accepted_count,
          count(*) filter (where status = 'patched')::int as patched_count
        from ${projectRunProgress}
        group by project_id, role
      ),
      role_counts as (
        select
          project_id,
          jsonb_object_agg(
            role,
            jsonb_build_object(
              'decoded', decoded_count,
              'drafted', drafted_count,
              'QA', qa_count,
              'accepted', accepted_count,
              'patched', patched_count
            ) order by role asc
          ) as role_counts
        from role_rollups
        group by project_id
      )
      select
        rollup.project_id,
        rollup.run_count,
        rollup.queued_run_count,
        rollup.running_run_count,
        rollup.paused_run_count,
        rollup.completed_run_count,
        rollup.failed_run_count,
        rollup.cancelled_run_count,
        rollup.decoded_unit_count,
        rollup.drafted_unit_count,
        rollup.qa_unit_count,
        rollup.accepted_unit_count,
        rollup.patched_unit_count,
        rollup.total_cost_micros_usd,
        rollup.average_coverage_percent,
        rollup.blockers,
        coalesce(roles.role_counts, '{}'::jsonb) as role_counts
      from project_rollups rollup
      left join role_counts roles on roles.project_id = rollup.project_id
      order by rollup.project_id asc
    `);
    return (result.rows as Array<Record<string, unknown>>).map(portfolioProgressFromRow);
  }
}

function portfolioProgressFromRow(
  row: Record<string, unknown>,
): ProjectRunPortfolioProgressSummary {
  return {
    projectId: requiredPortfolioText(row.project_id, "project_id"),
    runCount: portfolioCount(row.run_count, "run_count"),
    runStatusCounts: runStatusCountsFromRow(row),
    unitCounts: unitStatusCountsFromRow(row),
    roleCounts: roleCountsFromRow(row.role_counts),
    totalCostMicrosUsd: portfolioCount(row.total_cost_micros_usd, "total_cost_micros_usd"),
    averageCoveragePercent: portfolioCoverage(row.average_coverage_percent),
    blockers: portfolioBlockersFromRow(row.blockers),
  };
}

function runStatusCountsFromRow(row: Record<string, unknown>): ProjectRunStatusCounts {
  return {
    queued: portfolioCount(row.queued_run_count, "queued_run_count"),
    running: portfolioCount(row.running_run_count, "running_run_count"),
    paused: portfolioCount(row.paused_run_count, "paused_run_count"),
    completed: portfolioCount(row.completed_run_count, "completed_run_count"),
    failed: portfolioCount(row.failed_run_count, "failed_run_count"),
    cancelled: portfolioCount(row.cancelled_run_count, "cancelled_run_count"),
  };
}

function roleCountsFromRow(value: unknown): Record<string, ProjectRunProgressStatusCounts> {
  if (!isRecord(value)) throw new Error("database row role_counts is not an object");
  return Object.fromEntries(
    Object.entries(value).map(([role, counts]) => {
      if (role.trim().length === 0) throw new Error("database row role_counts has an empty role");
      if (!isRecord(counts)) throw new Error("database row role_counts has invalid status counts");
      return [role, roleStatusCountsFromRow(counts)];
    }),
  );
}

function unitStatusCountsFromRow(row: Record<string, unknown>): ProjectRunProgressStatusCounts {
  return {
    decoded: portfolioCount(row.decoded_unit_count, "decoded_unit_count"),
    drafted: portfolioCount(row.drafted_unit_count, "drafted_unit_count"),
    QA: portfolioCount(row.qa_unit_count, "qa_unit_count"),
    accepted: portfolioCount(row.accepted_unit_count, "accepted_unit_count"),
    patched: portfolioCount(row.patched_unit_count, "patched_unit_count"),
  };
}

function roleStatusCountsFromRow(row: Record<string, unknown>): ProjectRunProgressStatusCounts {
  return {
    decoded: portfolioCount(row.decoded, "role_counts.decoded"),
    drafted: portfolioCount(row.drafted, "role_counts.drafted"),
    QA: portfolioCount(row.QA, "role_counts.QA"),
    accepted: portfolioCount(row.accepted, "role_counts.accepted"),
    patched: portfolioCount(row.patched, "role_counts.patched"),
  };
}

function portfolioBlockersFromRow(value: unknown): ProjectRunPortfolioBlocker[] {
  if (!Array.isArray(value)) throw new Error("database row blockers is not an array");
  return value.map((blocker) => {
    if (!isRecord(blocker)) throw new Error("database row blockers has an invalid entry");
    const blockers = blocker.blockers;
    if (!Array.isArray(blockers) || !blockers.every((entry) => typeof entry === "string")) {
      throw new Error("database row blockers has an invalid blocker list");
    }
    return {
      runId: requiredPortfolioText(blocker.runId, "blockers.runId"),
      bridgeUnitId: requiredPortfolioText(blocker.bridgeUnitId, "blockers.bridgeUnitId"),
      role: requiredPortfolioText(blocker.role, "blockers.role"),
      blockers,
    };
  });
}

function portfolioCount(value: unknown, label: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`database row ${label} is not a non-negative safe integer`);
  }
  return count;
}

function portfolioCoverage(value: unknown): number {
  const coverage = Number(value);
  if (!Number.isFinite(coverage) || coverage < 0 || coverage > 100) {
    throw new Error("database row average_coverage_percent is invalid");
  }
  return coverage;
}

function requiredPortfolioText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`database row ${label} is not non-empty text`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
