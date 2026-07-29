import { sql } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { costLedgerEntries, modelProviders, projects, providerRuns } from "../schema.js";
import type { ProviderRunCostSummary } from "./model-ledger-repository-types.js";
import { runFromRow } from "./model-ledger-repository-mappers.js";

export class ModelLedgerRepositoryBase {
  constructor(protected readonly db: ItotoriDatabase) {}

  protected async getProviderRunCostSummary(
    projectId: string,
    providerRunId: string,
  ): Promise<ProviderRunCostSummary | undefined> {
    const result = await this.db.execute(sql`
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
      where pr.project_id = ${projectId}
        and pr.provider_run_id = ${providerRunId}
      limit 1
    `);
    const first = result.rows[0] as Record<string, unknown> | undefined;
    return first ? runFromRow(first) : undefined;
  }

  protected async latestProjectId(): Promise<string> {
    const result = await this.db.execute(sql`
      select project_id
      from ${projects}
      order by updated_at desc
      limit 1
    `);
    const first = result.rows[0] as Record<string, unknown> | undefined;
    if (!first) {
      throw new Error("no Itotori project state found");
    }
    return String(first.project_id);
  }
}
