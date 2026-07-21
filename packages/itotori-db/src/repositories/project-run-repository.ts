import { sql } from "drizzle-orm";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import {
  projectRunCostAccounts,
  projectRunCostReservations,
  projectRunProgress,
  projectRunStatusValues,
  projectRuns,
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
}
