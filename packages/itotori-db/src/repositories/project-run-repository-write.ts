import { sql } from "drizzle-orm";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import {
  projectRunCostAccounts,
  projectRunCostReservations,
  projectRunProgress,
  projectRunStatusValues,
  projectRuns,
} from "../schema.js";
import {
  ItotoriProjectRunCostCapError,
  ItotoriProjectRunRepositoryError,
  assertCoverage,
  assertMicros,
  assertProgressStatus,
  assertRunStatus,
  canAdvance,
  fenceRejected,
  leaseFromRow,
  leaseSeconds,
  loadRun,
  normalizeBlockers,
  normalizeCreate,
  normalizeLease,
  nullableNumberOf,
  numberOf,
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
import { rethrowProjectRunConstraint } from "./project-run-diagnostics.js";
import { createOrResumeProjectRun } from "./project-run-repository-resume.js";
import {
  type AcquireProjectRunLeaseInput,
  type AdvanceProjectRunInput,
  type CreateProjectRunInput,
  type ItotoriProjectRunRepositoryPort,
  type ProjectRunCostReservationRecord,
  type ProjectRunDashboardPage,
  type ProjectRunLease,
  type ProjectRunLeaseFence,
  type ProjectRunLiveReadModel,
  type ProjectRunLiveReadModelOptions,
  type ProjectRunPortfolioProgressSummary,
  type ProjectRunProgressRecord,
  type ProjectRunRecord,
  type RecordProjectRunProgressInput,
  type RecordProjectRunProgressBatchInput,
  type ReleaseProjectRunCostInput,
  type RenewProjectRunLeaseInput,
  type ReserveProjectRunCostInput,
  type SettleProjectRunCostInput,
} from "./project-run-repository-types.js";
import {
  listProjectRunDashboardRuns,
  listProjectRunPortfolioProgress,
  loadProjectRunLiveReadModel,
} from "./project-run-repository-read-model.js";

const MAX_PROGRESS_BATCH_SIZE = 500;

export class ItotoriProjectRunRepository implements ItotoriProjectRunRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async createRun(
    actor: AuthorizationActor,
    input: CreateProjectRunInput,
  ): Promise<ProjectRunRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    const normalized = normalizeCreate(input);
    try {
      return await this.db.transaction(async (tx) => {
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
    } catch (error) {
      rethrowProjectRunConstraint(error, normalized);
    }
  }

  async createOrResumeRun(
    actor: AuthorizationActor,
    input: CreateProjectRunInput,
  ): Promise<ProjectRunRecord> {
    return await createOrResumeProjectRun(this.db, actor, input);
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

  async recordProgressBatch(
    actor: AuthorizationActor,
    input: RecordProjectRunProgressBatchInput,
  ): Promise<ProjectRunProgressRecord[]> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    const lease = normalizeLease(input.lease);
    if (input.progress.length === 0 || input.progress.length > MAX_PROGRESS_BATCH_SIZE) {
      throw new Error(`progress batch must contain 1 through ${MAX_PROGRESS_BATCH_SIZE} rows`);
    }
    const progress = input.progress.map((entry) => ({
      bridgeUnitId: requiredText(entry.bridgeUnitId, "bridgeUnitId"),
      role: requiredText(entry.role, "role"),
      status: entry.status,
      costMicrosUsd: entry.costMicrosUsd,
      coveragePercent: entry.coveragePercent,
      blockers: normalizeBlockers(entry.blockers ?? []),
    }));
    for (const entry of progress) {
      assertProgressStatus(entry.status);
      assertMicros(entry.costMicrosUsd, "costMicrosUsd");
      assertCoverage(entry.coveragePercent);
    }
    const isDecodedStartup = progress.every(
      (entry) =>
        entry.status === "decoded" &&
        entry.costMicrosUsd === 0 &&
        entry.coveragePercent === 0 &&
        entry.blockers.length === 0,
    );
    return await this.db.transaction(async (tx) => {
      const executor = tx as unknown as SqlExecutor;
      await requireCurrentLease(executor, lease);
      const values = progress.map(
        (entry) => sql`(
          ${lease.runId}, ${lease.projectId}, ${entry.bridgeUnitId}, ${entry.role}, ${entry.status},
          ${entry.costMicrosUsd}, ${entry.coveragePercent}, ${JSON.stringify(entry.blockers)}::jsonb
        )`,
      );
      const conflictClause = isDecodedStartup
        ? sql`
            on conflict (run_id, bridge_unit_id, role) do update set
              status = ${projectRunProgress.status}
          `
        : sql`
            on conflict (run_id, bridge_unit_id, role) do update set
              status = excluded.status, cost_micros_usd = excluded.cost_micros_usd,
              coverage_percent = excluded.coverage_percent, blockers = excluded.blockers, updated_at = now()
            where ${progressRank(projectRunProgress.status)} <= ${progressRank(sql`excluded.status`)}
          `;
      const rows = await rowsOf(
        executor,
        sql`
          insert into ${projectRunProgress} (
            run_id, project_id, bridge_unit_id, role, status, cost_micros_usd, coverage_percent, blockers
          ) values ${sql.join(values, sql`, `)}
          ${conflictClause}
          returning *
        `,
      );
      if (!isDecodedStartup && rows.length !== progress.length) {
        throw new ItotoriProjectRunRepositoryError(
          "progress_regression",
          "project run progress cannot move backwards",
        );
      }
      return rows.map(progressFromRow);
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
        const accounts = await rowsOf(
          executor,
          sql`
            select cap_micros_usd, spent_micros_usd, reserved_micros_usd
            from ${projectRunCostAccounts}
            where run_id = ${lease.runId} and project_id = ${lease.projectId}
            for update
          `,
        );
        const account = accounts[0];
        if (account === undefined) throw new Error("project run cost account was not found");
        const capMicrosUsd = nullableNumberOf(account, "cap_micros_usd");
        if (capMicrosUsd === null) throw new Error("uncapped project run refused a reservation");
        throw new ItotoriProjectRunCostCapError(
          capMicrosUsd,
          numberOf(account, "spent_micros_usd"),
          numberOf(account, "reserved_micros_usd"),
          input.reservedMicrosUsd,
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

  async releaseCost(
    actor: AuthorizationActor,
    input: ReleaseProjectRunCostInput,
  ): Promise<ProjectRunCostReservationRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    const lease = normalizeLease(input.lease);
    const reservationId = requiredText(input.reservationId, "reservationId");
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
      if (reservation.state === "released") return toReservation(reservation);
      if (reservation.state === "settled") {
        throw new Error("settled cost reservation cannot be released");
      }
      await executor.execute(sql`
        update ${projectRunCostAccounts}
        set reserved_micros_usd = reserved_micros_usd - ${reservation.reservedMicrosUsd}, updated_at = now()
        where run_id = ${lease.runId} and project_id = ${lease.projectId}
      `);
      const released = await rowsOf(
        executor,
        sql`
        update ${projectRunCostReservations}
        set state = 'released', released_at = now()
        where run_id = ${lease.runId} and reservation_id = ${reservationId} and state = 'reserved'
        returning *
      `,
      );
      if (released[0] === undefined) throw new Error("cost release lost its reservation");
      return reservationFromRow(released[0]);
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
    options: ProjectRunLiveReadModelOptions = {},
  ): Promise<ProjectRunLiveReadModel | null> {
    return loadProjectRunLiveReadModel(this.db, actor, projectId, runId, options);
  }

  async listDashboardRuns(
    actor: AuthorizationActor,
    input: { projectId: string; localeBranchId: string | null; limit: number; offset: number },
  ): Promise<ProjectRunDashboardPage> {
    return listProjectRunDashboardRuns(this.db, actor, input);
  }

  async listPortfolioProgress(
    actor: AuthorizationActor,
  ): Promise<ProjectRunPortfolioProgressSummary[]> {
    return listProjectRunPortfolioProgress(this.db, actor);
  }
}
