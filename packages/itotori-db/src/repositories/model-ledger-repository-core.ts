import { sql } from "drizzle-orm";
import { permissionValues, requirePermission, type AuthorizationActor } from "../authorization.js";
import {
  costLedgerEntries,
  modelProviders,
  providerCostKindValues,
  providerRuns,
  type ProviderCostKind,
} from "../schema.js";
import type {
  CostDrilldownFilter,
  CostDrilldownPage,
  CostKindBreakdown,
  ItotoriModelLedgerRepositoryPort,
  ProjectCostReport,
  ProjectTelemetryTimeseries,
  ProviderRunCostKindCountRow,
  ProviderRunCostKindCountWindow,
  ProviderRunZdrCountRow,
  ProviderRunZdrCountWindow,
} from "./model-ledger-repository-types.js";
import {
  asCostKind,
  clampDrilldownLimit,
  clampDrilldownOffset,
  drilldownRowFromRow,
  runFromRow,
  timestampToIso,
  zeroBreakdown,
} from "./model-ledger-repository-mappers.js";
import { getTranslationMemoryReuseCostReport } from "./model-ledger-repository-reports.js";
import { ModelLedgerRepositoryWrites } from "./model-ledger-repository-writes.js";

const costKinds = Object.values(providerCostKindValues) as ProviderCostKind[];

export class ItotoriModelLedgerRepository
  extends ModelLedgerRepositoryWrites
  implements ItotoriModelLedgerRepositoryPort
{
  /**
   * gate-project-status-and-cost-reads — the privileged cost report read.
   * Actor-checked HERE (repository layer, where the data is read) so an
   * internal caller with an unprivileged actor cannot bypass the gate.
   * The unchecked assembly lives in `assembleProjectCostReport`, which is
   * NOT part of the port contract and is only consumed same-package by the
   * dashboard-status assembly — whose sensitive fields (recentRuns +
   * translation-memory targetText) are redacted at the API boundary for
   * unprivileged callers.
   */
  async getProjectCostReport(
    actor: AuthorizationActor,
    projectId?: string,
  ): Promise<ProjectCostReport> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    return this.assembleProjectCostReport(projectId);
  }

  async assembleProjectCostReport(projectId?: string): Promise<ProjectCostReport> {
    const targetProjectId = projectId ?? (await this.latestProjectId());
    const totalsResult = await this.db.execute(sql`
      select
        cost_kind,
        count(*)::int as run_count,
        coalesce(sum(amount_micros_usd), 0)::text as amount_micros_usd,
        coalesce(sum(prompt_tokens), 0)::int as prompt_tokens,
        coalesce(sum(completion_tokens), 0)::int as completion_tokens,
        coalesce(sum(total_tokens), 0)::int as total_tokens
      from ${costLedgerEntries}
      where project_id = ${targetProjectId}
      group by cost_kind
    `);

    const byKind = new Map<ProviderCostKind, CostKindBreakdown>();
    for (const costKind of costKinds) {
      byKind.set(costKind, {
        costKind,
        runCount: 0,
        amountMicrosUsd: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      });
    }
    for (const row of totalsResult.rows as Array<Record<string, unknown>>) {
      const costKind = asCostKind(row.cost_kind);
      byKind.set(costKind, {
        costKind,
        runCount: Number(row.run_count ?? 0),
        amountMicrosUsd: Number(row.amount_micros_usd ?? 0),
        promptTokens: Number(row.prompt_tokens ?? 0),
        completionTokens: Number(row.completion_tokens ?? 0),
        totalTokens: Number(row.total_tokens ?? 0),
      });
    }

    const recentRunsResult = await this.db.execute(sql`
      select
        pr.provider_run_id,
        pr.task_kind,
        pr.status,
        pr.started_at,
        pr.structured_output_mode,
        pr.retry_count,
        pr.error_classes,
        mp.provider_family,
        mp.endpoint_family,
        mp.provider_name,
        pr.requested_model_id,
        pr.actual_model_id,
        pr.upstream_provider,
        pr.route_settings_hash,
        pr.prompt_preset_id,
        pr.prompt_template_version,
        pr.prompt_hash,
        pr.fallback_used,
        pr.fallback_plan,
        cle.cost_kind,
        cle.amount_micros_usd::text as amount_micros_usd,
        cle.token_count_source,
        cle.prompt_tokens,
        cle.completion_tokens,
        cle.reasoning_tokens,
        cle.cached_input_tokens,
        cle.total_tokens,
        pr.routing_posture
      from ${providerRuns} pr
      join ${modelProviders} mp on mp.provider_id = pr.provider_id
      join ${costLedgerEntries} cle on cle.provider_run_id = pr.provider_run_id
      where pr.project_id = ${targetProjectId}
      order by pr.started_at desc, pr.provider_run_id desc
      limit 20
    `);

    const recentRuns = (recentRunsResult.rows as Array<Record<string, unknown>>).map(runFromRow);
    const translationMemoryReuse = await getTranslationMemoryReuseCostReport(
      this.db,
      targetProjectId,
    );
    const billed = byKind.get(providerCostKindValues.billed)?.amountMicrosUsd ?? 0;

    return {
      projectId: targetProjectId,
      currency: "USD",
      runCount: [...byKind.values()].reduce((sum, row) => sum + row.runCount, 0),
      billedMicrosUsd: billed,
      zeroRunCount: byKind.get(providerCostKindValues.zero)?.runCount ?? 0,
      totalsByCostKind: costKinds.map(
        (costKind) => byKind.get(costKind) ?? zeroBreakdown(costKind),
      ),
      recentRuns,
      translationMemoryReuse,
    };
  }

  async getCostLedgerDrilldown(
    actor: AuthorizationActor,
    filter: CostDrilldownFilter = {},
  ): Promise<CostDrilldownPage> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    if (filter.from && filter.to && filter.from.getTime() > filter.to.getTime()) {
      throw new Error("getCostLedgerDrilldown filter.from must not be after filter.to");
    }
    const limit = clampDrilldownLimit(filter.limit);
    const offset = clampDrilldownOffset(filter.offset);
    const targetProjectId = filter.projectId ?? (await this.latestProjectId());
    const systemId = filter.systemId ?? null;
    const from = filter.from ?? null;
    const to = filter.to ?? null;

    const conditions = [sql`pr.project_id = ${targetProjectId}`];
    if (systemId !== null) {
      conditions.push(sql`pr.system_id = ${systemId}`);
    }
    if (from !== null) {
      conditions.push(sql`pr.started_at >= ${from}`);
    }
    if (to !== null) {
      conditions.push(sql`pr.started_at <= ${to}`);
    }
    const whereClause = sql.join(conditions, sql` and `);

    const totalResult = await this.db.execute(sql`
      select count(*)::int as total
      from ${providerRuns} pr
      where ${whereClause}
    `);
    const total = Number((totalResult.rows[0] as Record<string, unknown> | undefined)?.total ?? 0);

    const rowsResult = await this.db.execute(sql`
      select
        pr.provider_run_id,
        pr.project_id,
        pr.system_id,
        pr.task_kind,
        pr.status,
        pr.started_at,
        pr.provider_id,
        pr.requested_model_id,
        pr.actual_model_id,
        pr.upstream_provider,
        pr.route_settings_hash,
        pr.adapter_metadata,
        mp.provider_family,
        mp.endpoint_family,
        mp.provider_name,
        cle.cost_ledger_entry_id,
        cle.cost_kind,
        cle.amount_micros_usd::text as amount_micros_usd
      from ${providerRuns} pr
      join ${modelProviders} mp on mp.provider_id = pr.provider_id
      left join ${costLedgerEntries} cle on cle.provider_run_id = pr.provider_run_id
      where ${whereClause}
      order by pr.started_at desc, pr.provider_run_id desc
      limit ${limit}
      offset ${offset}
    `);

    const rows = (rowsResult.rows as Array<Record<string, unknown>>).map(drilldownRowFromRow);
    const pageCount = total === 0 ? 0 : Math.ceil(total / limit);
    const hasMore = offset + rows.length < total;
    return {
      filter: {
        projectId: targetProjectId,
        systemId,
        from: from === null ? null : from.toISOString(),
        to: to === null ? null : to.toISOString(),
      },
      pagination: {
        total,
        limit,
        offset,
        page: Math.floor(offset / limit) + 1,
        pageCount,
        hasMore,
        nextOffset: hasMore ? offset + limit : null,
      },
      rows,
    };
  }

  async getProjectTelemetryTimeseries(
    actor: AuthorizationActor,
    projectId?: string,
  ): Promise<ProjectTelemetryTimeseries> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const targetProjectId = projectId ?? (await this.latestProjectId());
    const result = await this.db.execute(sql`
      select
        date_trunc('day', pr.started_at) as bucket_start,
        count(*)::int as run_count,
        coalesce(sum(cle.amount_micros_usd), 0)::text as billed_micros_usd
      from ${providerRuns} pr
      left join ${costLedgerEntries} cle on cle.provider_run_id = pr.provider_run_id
      where pr.project_id = ${targetProjectId}
      group by bucket_start
      order by bucket_start asc
    `);
    const rows = (result.rows as Array<Record<string, unknown>>).map((row) => {
      const runCount = Number(row.run_count ?? 0);
      const billedMicrosUsd = Number(row.billed_micros_usd ?? 0);
      return {
        bucketStart: timestampToIso(row.bucket_start),
        runCount,
        billedMicrosUsd,
        costPerRunMicrosUsd: runCount === 0 ? 0 : billedMicrosUsd / runCount,
      };
    });
    return {
      projectId: targetProjectId,
      bucket: "day",
      rows,
      throughputSeries: rows.map((row) => row.runCount),
      costPerRunSeries: rows.map((row) => row.costPerRunMicrosUsd),
    };
  }

  /**
   * Count provider runs grouped by (requested_model_id, provider_id),
   * split by whether the captured routing posture has `zdr = true` on
   * the wire. The filter is `routing_posture->>'zdr' = 'true'`;
   * pre-migration sentinel rows (`{"_pre_itotori_230": true}`) do NOT
   * match and are correctly excluded from the ZDR-enforced count.
   */
  async countZdrEnforcedByPair(
    actor: AuthorizationActor,
    projectId: string,
    window: ProviderRunZdrCountWindow,
  ): Promise<ProviderRunZdrCountRow[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    if (window.from.getTime() > window.to.getTime()) {
      throw new Error("countZdrEnforcedByPair window.from must not be after window.to");
    }
    const result = await this.db.execute(sql`
      select
        pr.requested_model_id as model_id,
        pr.provider_id,
        count(*)::int as invocation_count,
        count(*) filter (where pr.routing_posture->>'zdr' = 'true')::int as zdr_enforced_count
      from ${providerRuns} pr
      where pr.project_id = ${projectId}
        and pr.started_at >= ${window.from}
        and pr.started_at <= ${window.to}
      group by pr.requested_model_id, pr.provider_id
      order by pr.requested_model_id asc, pr.provider_id asc
    `);
    return (result.rows as Array<Record<string, unknown>>).map((row) => ({
      modelId: String(row.model_id),
      providerId: String(row.provider_id),
      invocationCount: Number(row.invocation_count ?? 0),
      zdrEnforcedCount: Number(row.zdr_enforced_count ?? 0),
    }));
  }

  async countCostKindsByPair(
    actor: AuthorizationActor,
    projectId: string,
    window: ProviderRunCostKindCountWindow,
  ): Promise<ProviderRunCostKindCountRow[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    if (window.from.getTime() > window.to.getTime()) {
      throw new Error("countCostKindsByPair window.from must not be after window.to");
    }
    const result = await this.db.execute(sql`
      select
        pr.requested_model_id as model_id,
        pr.provider_id,
        cle.cost_kind,
        count(*)::int as invocation_count,
        coalesce(sum(cle.amount_micros_usd), 0)::text as amount_micros_usd
      from ${providerRuns} pr
      join ${costLedgerEntries} cle on cle.provider_run_id = pr.provider_run_id
      where pr.project_id = ${projectId}
        and pr.started_at >= ${window.from}
        and pr.started_at <= ${window.to}
      group by pr.requested_model_id, pr.provider_id, cle.cost_kind
      order by pr.requested_model_id asc, pr.provider_id asc, cle.cost_kind asc
    `);
    return (result.rows as Array<Record<string, unknown>>).map((row) => ({
      modelId: String(row.model_id),
      providerId: String(row.provider_id),
      costKind: asCostKind(row.cost_kind),
      invocationCount: Number(row.invocation_count ?? 0),
      amountMicrosUsd: Number(row.amount_micros_usd ?? 0),
    }));
  }
}
