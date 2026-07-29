import { sql } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { translationMemoryReuseEvents } from "../schema.js";
import type { TranslationMemoryDiagnostic } from "./translation-memory-repository.js";
import type { TranslationMemoryReuseCostReport } from "./model-ledger-repository-types.js";
import { translationMemoryReuseFromRow } from "./model-ledger-repository-mappers.js";

export async function getTranslationMemoryReuseCostReport(
  db: ItotoriDatabase,
  projectId: string,
): Promise<TranslationMemoryReuseCostReport> {
  // Defensive aggregation. The repository API only writes well-formed
  // `cost_impact` JSON, but raw SQL backfills / historical rows can
  // carry non-object JSON, missing keys, or non-numeric / non-boolean
  // values. Casting a non-numeric text to int aborts the WHOLE query
  // (`invalid input syntax for type integer`), which makes the project
  // cost report unavailable. We classify each row in a CTE and
  // conditionally sum / cast only the well-formed rows; malformed rows
  // are counted in `malformed_cost_impact_count` and exposed via a
  // diagnostic so the report REMAINS AVAILABLE.
  const totalsResult = await db.execute(sql`
    with project_events as (
      select
        reuse_status,
        cost_impact,
        -- Well-formed predicate: cost_impact must be a JSON object AND
        -- every numeric / boolean field the aggregation reads must be the
        -- expected scalar shape. NULL (missing key) is tolerated; a key
        -- whose value is the wrong JSON type is NOT.
        (
          jsonb_typeof(cost_impact) = 'object'
          and (
            cost_impact->>'providerCallAvoided' is null
            or cost_impact->>'providerCallAvoided' in ('true', 'false')
          )
          and (
            cost_impact->>'estimatedPromptTokensSaved' is null
            or cost_impact->>'estimatedPromptTokensSaved' ~ '^-?\\d+$'
          )
          and (
            cost_impact->>'estimatedCompletionTokensSaved' is null
            or cost_impact->>'estimatedCompletionTokensSaved' ~ '^-?\\d+$'
          )
          and (
            cost_impact->>'estimatedTotalTokensSaved' is null
            or cost_impact->>'estimatedTotalTokensSaved' ~ '^-?\\d+$'
          )
          and (
            cost_impact->>'estimatedCostUsdSaved' is null
            or cost_impact->>'estimatedCostUsdSaved' ~ '^-?\\d+(\\.\\d+)?$'
          )
        ) as is_cost_impact_well_formed
      from ${translationMemoryReuseEvents}
      where project_id = ${projectId}
    )
    select
      count(*)::int as reuse_event_count,
      count(*) filter (where reuse_status = 'applied')::int as applied_count,
      count(*) filter (where reuse_status = 'suggested')::int as suggested_count,
      count(*) filter (where not is_cost_impact_well_formed)::int
        as malformed_cost_impact_count,
      count(*) filter (
        where is_cost_impact_well_formed
          and (cost_impact->>'providerCallAvoided')::boolean is true
      )::int as provider_call_avoided_count,
      coalesce(
        sum(
          case when is_cost_impact_well_formed
            then (cost_impact->>'estimatedPromptTokensSaved')::int
          end
        ),
        0
      )::int as estimated_prompt_tokens_saved,
      coalesce(
        sum(
          case when is_cost_impact_well_formed
            then (cost_impact->>'estimatedCompletionTokensSaved')::int
          end
        ),
        0
      )::int as estimated_completion_tokens_saved,
      coalesce(
        sum(
          case when is_cost_impact_well_formed
            then (cost_impact->>'estimatedTotalTokensSaved')::int
          end
        ),
        0
      )::int as estimated_total_tokens_saved,
      sum(
        case when is_cost_impact_well_formed
          then (cost_impact->>'estimatedCostUsdSaved')::numeric
        end
      )::text as estimated_cost_usd_saved
    from project_events
  `);
  const totals = (totalsResult.rows[0] ?? {}) as Record<string, unknown>;

  const recentEventsResult = await db.execute(sql`
    select
      reuse_event_id,
      locale_branch_id,
      target_bridge_unit_id,
      memory_segment_id,
      match_kind,
      match_score,
      reuse_status,
      source_hash,
      candidate_source_hash,
      target_text,
      cost_impact,
      provenance,
      created_at
    from ${translationMemoryReuseEvents}
    where project_id = ${projectId}
    order by created_at desc, reuse_event_id desc
    limit 20
  `);

  const recentEvents = (recentEventsResult.rows as Array<Record<string, unknown>>).map(
    translationMemoryReuseFromRow,
  );
  const malformedCostImpactCount = Number(totals.malformed_cost_impact_count ?? 0);
  const diagnostics: TranslationMemoryDiagnostic[] =
    malformedCostImpactCount === 0
      ? []
      : [
          {
            code: "translation_memory.reuse_event.cost_impact.malformed",
            severity: "warning",
            message:
              "One or more translation-memory reuse events for this project have a malformed cost_impact JSON shape. Their cost-impact fields were skipped from the aggregation so the report remains available; the affected rows are still listed in `recentEvents` with `malformedCostImpact: true` and zeroed cost fields. Repair by re-deriving cost_impact for the affected events.",
            reasonCode: "malformed_cost_impact_json",
            field: "cost_impact",
            metadata: {
              projectId,
              malformedCostImpactCount,
            },
          },
        ];

  return {
    reuseEventCount: Number(totals.reuse_event_count ?? 0),
    appliedCount: Number(totals.applied_count ?? 0),
    suggestedCount: Number(totals.suggested_count ?? 0),
    providerCallAvoidedCount: Number(totals.provider_call_avoided_count ?? 0),
    estimatedPromptTokensSaved: Number(totals.estimated_prompt_tokens_saved ?? 0),
    estimatedCompletionTokensSaved: Number(totals.estimated_completion_tokens_saved ?? 0),
    estimatedTotalTokensSaved: Number(totals.estimated_total_tokens_saved ?? 0),
    estimatedCostUsdSaved:
      totals.estimated_cost_usd_saved === null || totals.estimated_cost_usd_saved === undefined
        ? null
        : Number(totals.estimated_cost_usd_saved),
    recentEvents,
    malformedCostImpactCount,
    diagnostics,
  };
}
