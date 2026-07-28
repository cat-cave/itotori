import { sql } from "drizzle-orm";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import {
  projectRunCostAccounts,
  projectRunProgress,
  projectRuns,
  projects,
  type ProjectRunStatus,
} from "../schema.js";
import {
  emptyStatusCounts,
  loadRunOrNull,
  progressFromRow,
  requiredText,
  rowsOf,
  type SqlExecutor,
} from "./project-run-repository-internal.js";
import {
  PROJECT_RUN_LIVE_READ_MODEL_SCHEMA_VERSION,
  type ProjectRunDashboardPage,
  type ProjectRunDashboardRow,
  type ProjectRunLiveReadModel,
  type ProjectRunPortfolioBlocker,
  type ProjectRunPortfolioProgressSummary,
  type ProjectRunProgressStatusCounts,
  type ProjectRunStatusCounts,
} from "./project-run-repository-types.js";

export async function loadProjectRunLiveReadModel(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
  projectId: string,
  runId: string,
): Promise<ProjectRunLiveReadModel | null> {
  await requirePermission(db, actor, permissionValues.catalogRead);
  const project = requiredText(projectId, "projectId");
  const run = requiredText(runId, "runId");
  const executor = db as unknown as SqlExecutor;
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

export async function listProjectRunDashboardRuns(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
  input: { projectId: string; localeBranchId: string | null; limit: number; offset: number },
): Promise<ProjectRunDashboardPage> {
  await requirePermission(db, actor, permissionValues.catalogRead);
  const projectId = requiredText(input.projectId, "projectId");
  const limit = Math.max(1, Math.min(input.limit, 100));
  const offset = Math.max(0, input.offset);
  const branchClause =
    input.localeBranchId === null
      ? sql``
      : sql`and run.locale_branch_id = ${requiredText(input.localeBranchId, "localeBranchId")}`;
  const totalRows = await rowsOf(
    db as unknown as SqlExecutor,
    sql`select count(*)::int as total from ${projectRuns} run
        where run.project_id = ${projectId} ${branchClause}`,
  );
  const rows = await rowsOf(
    db as unknown as SqlExecutor,
    sql`
      select
        run.run_id, run.project_id, run.locale_branch_id, run.status, run.created_at, run.updated_at,
        account.spent_micros_usd, account.reserved_micros_usd,
        coalesce(progress.attempted_unit_count, 0)::int as attempted_unit_count,
        coalesce(progress.finalized_unit_count, 0)::int as finalized_unit_count,
        coalesce(progress.patched_unit_count, 0)::int as patched_unit_count,
        coalesce(receipts.physical_call_count, 0)::int as physical_call_count,
        greatest(coalesce(receipts.deadline_failure_count, 0), coalesce(progress.deadline_blocker_count, 0))::int as deadline_failure_count,
        coalesce(receipts.served_pairs, '[]'::jsonb) as served_pairs,
        patch.patch_version_id, patch.status as patch_status
      from ${projectRuns} run
      join ${projectRunCostAccounts} account
        on account.run_id = run.run_id and account.project_id = run.project_id
      left join lateral (
        select
          count(distinct bridge_unit_id)::int as attempted_unit_count,
          count(distinct bridge_unit_id) filter (where status in ('accepted', 'patched'))::int as finalized_unit_count,
          count(distinct bridge_unit_id) filter (where status = 'patched')::int as patched_unit_count,
          count(distinct bridge_unit_id) filter (where blockers @> '["deadline-failed"]'::jsonb)::int as deadline_blocker_count
        from ${projectRunProgress}
        where run_id = run.run_id and project_id = run.project_id
      ) progress on true
      left join lateral (
        select
          count(distinct attempt.attempt_id)::int as physical_call_count,
          count(distinct attempt.attempt_id) filter (
            where attempt.attempt_status = 'in-flight' and attempt.deadline_at <= now()
          )::int as deadline_failure_count,
          coalesce(jsonb_agg(distinct jsonb_build_object(
            'model', attempt.served_model, 'provider', attempt.served_provider
          )) filter (where attempt.served_pair_status = 'confirmed'), '[]'::jsonb) as served_pairs
        from itotori_llm_conversation_events event
        join itotori_llm_http_attempts attempt on attempt.memo_key = event.memo_key
        where event.snapshot_kind = 'localization'
          and event.snapshot_id = run.localization_snapshot_id
      ) receipts on true
      left join lateral (
        select patch_version_id, status
        from itotori_localization_patch_versions
        where project_id = run.project_id and locale_branch_id = run.locale_branch_id
          and delivery_scope_id = run.run_id
        order by created_at desc, patch_version_id desc
        limit 1
      ) patch on true
      where run.project_id = ${projectId} ${branchClause}
      order by run.created_at desc, run.run_id desc
      limit ${limit} offset ${offset}
    `,
  );
  const pageRows = rows.map(projectRunDashboardRowFromRow);
  const total = numberOfDashboard(totalRows[0], "total");
  return { total, rows: pageRows, latestRow: pageRows[0] ?? null };
}

export async function listProjectRunPortfolioProgress(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
): Promise<ProjectRunPortfolioProgressSummary[]> {
  await requirePermission(db, actor, permissionValues.catalogRead);
  const result = await db.execute(sql`
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

function projectRunDashboardRowFromRow(row: Record<string, unknown>): ProjectRunDashboardRow {
  return {
    runId: dashboardText(row, "run_id"),
    projectId: dashboardText(row, "project_id"),
    localeBranchId: dashboardText(row, "locale_branch_id"),
    status: dashboardText(row, "status") as ProjectRunStatus,
    createdAt: dashboardDate(row, "created_at"),
    updatedAt: dashboardDate(row, "updated_at"),
    attemptedUnitCount: numberOfDashboard(row, "attempted_unit_count"),
    finalizedUnitCount: numberOfDashboard(row, "finalized_unit_count"),
    patchedUnitCount: numberOfDashboard(row, "patched_unit_count"),
    physicalCallCount: numberOfDashboard(row, "physical_call_count"),
    deadlineFailureCount: numberOfDashboard(row, "deadline_failure_count"),
    spentMicrosUsd: numberOfDashboard(row, "spent_micros_usd"),
    reservedMicrosUsd: numberOfDashboard(row, "reserved_micros_usd"),
    servedPairs: dashboardServedPairs(row.served_pairs),
    patchVersionId: dashboardNullableText(row, "patch_version_id"),
    patchStatus: dashboardNullableText(row, "patch_status"),
  };
}

function numberOfDashboard(row: Record<string, unknown> | undefined, field: string): number {
  const value = row?.[field];
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`dashboard ${field} is invalid`);
  return parsed;
}

function dashboardText(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`dashboard ${field} is missing`);
  return value;
}

function dashboardNullableText(row: Record<string, unknown>, field: string): string | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`dashboard ${field} is invalid`);
  return value;
}

function dashboardDate(row: Record<string, unknown>, field: string): Date {
  const value = row[field];
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error(`dashboard ${field} is invalid`);
  return date;
}

function dashboardServedPairs(value: unknown): Array<{ model: string; provider: string }> {
  if (!Array.isArray(value)) throw new Error("dashboard served_pairs is invalid");
  return value.map((pair) => {
    if (
      typeof pair !== "object" ||
      pair === null ||
      typeof (pair as Record<string, unknown>).model !== "string" ||
      typeof (pair as Record<string, unknown>).provider !== "string"
    ) {
      throw new Error("dashboard served pair is invalid");
    }
    return {
      model: (pair as Record<string, string>).model!,
      provider: (pair as Record<string, string>).provider!,
    };
  });
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
