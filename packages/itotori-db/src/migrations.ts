import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapLocalUser } from "./authorization.js";
import { withDatabase } from "./connection.js";

export async function migrate(databaseUrl?: string): Promise<void> {
  await withDatabase(async ({ db, pool }) => {
    const client = await pool.connect();
    let lockAcquired = false;
    try {
      await client.query("select pg_advisory_lock(8800030000000001)");
      lockAcquired = true;

      await client.query(`
        create table if not exists itotori_schema_migrations (
          migration_id text primary key,
          checksum text not null,
          applied_at timestamptz not null default now()
        )
      `);

      for (const migration of migrations) {
        const body = readFileSync(migrationPath(migration.file), "utf8");
        const checksum = createHash("sha256").update(body).digest("hex");
        try {
          await client.query("begin");
          const applied = await client.query<{ checksum: string }>(
            "select checksum from itotori_schema_migrations where migration_id = $1 for update",
            [migration.id],
          );
          const existing = applied.rows[0];
          if (existing) {
            if (existing.checksum !== checksum) {
              throw new Error(`migration ${migration.id} checksum mismatch`);
            }
          } else {
            await client.query(body);
            await client.query(
              "insert into itotori_schema_migrations (migration_id, checksum) values ($1, $2)",
              [migration.id, checksum],
            );
          }
          await client.query("commit");
        } catch (error) {
          await client.query("rollback");
          throw error;
        }
      }
    } finally {
      if (lockAcquired) {
        await client.query("select pg_advisory_unlock(8800030000000001)");
      }
      client.release();
    }

    await bootstrapLocalUser(db);
  }, databaseUrl);
}

export const migrations = [
  {
    id: "0001_hello_world",
    file: "0001_hello_world.sql",
  },
  {
    id: "0002_permissions",
    file: "0002_permissions.sql",
  },
  {
    id: "0003_persistence_v02",
    file: "0003_persistence_v02.sql",
  },
  {
    id: "0004_feedback_sources",
    file: "0004_feedback_sources.sql",
  },
  {
    id: "0005_event_queue_foundation",
    file: "0005_event_queue_foundation.sql",
  },
  {
    id: "0006_model_registry_cost_ledger",
    file: "0006_model_registry_cost_ledger.sql",
  },
  {
    id: "0007_runtime_evidence_ingestion",
    file: "0007_runtime_evidence_ingestion.sql",
  },
  {
    id: "0008_bridge_import_status",
    file: "0008_bridge_import_status.sql",
  },
  {
    id: "0009_catalog_foundation",
    file: "0009_catalog_foundation.sql",
  },
  {
    id: "0010_catalog_candidate_matches",
    file: "0010_catalog_candidate_matches.sql",
  },
  {
    id: "0011_catalog_crawler_jobs",
    file: "0011_catalog_crawler_jobs.sql",
  },
  {
    id: "0012_optional_provider_run_timing",
    file: "0012_optional_provider_run_timing.sql",
  },
  {
    id: "0013_queue_read_permission",
    file: "0013_queue_read_permission.sql",
  },
  {
    id: "0014_catalog_completeness_evidence",
    file: "0014_catalog_completeness_evidence.sql",
  },
  {
    id: "0015_style_guide_versions",
    file: "0015_style_guide_versions.sql",
  },
  {
    id: "0016_affected_work_invalidated_outbox",
    file: "0016_affected_work_invalidated_outbox.sql",
  },
  {
    id: "0017_catalog_demand_facts",
    file: "0017_catalog_demand_facts.sql",
  },
  {
    id: "0018_locale_branch_unit_style_guide_provenance",
    file: "0018_locale_branch_unit_style_guide_provenance.sql",
  },
  {
    id: "0019_catalog_edition_milestone_mapping",
    file: "0019_catalog_edition_milestone_mapping.sql",
  },
  {
    id: "0020_terminology_glossary",
    file: "0020_terminology_glossary.sql",
  },
  {
    id: "0021_glossary_review_items",
    file: "0021_glossary_review_items.sql",
  },
  {
    id: "0022_branch_policy_glossary_references",
    file: "0022_branch_policy_glossary_references.sql",
  },
  {
    id: "0023_translation_memory",
    file: "0023_translation_memory.sql",
  },
  {
    id: "0024_exact_search_documents",
    file: "0024_exact_search_documents.sql",
  },
  {
    id: "0025_context_artifacts",
    file: "0025_context_artifacts.sql",
  },
  {
    id: "0026_context_artifact_source_unit_retention",
    file: "0026_context_artifact_source_unit_retention.sql",
  },
  {
    id: "0027_translation_batches",
    file: "0027_translation_batches.sql",
  },
  {
    id: "0028_runtime_conformance_results",
    file: "0028_runtime_conformance_results.sql",
  },
  {
    id: "0029_scene_summaries",
    file: "0029_scene_summaries.sql",
  },
  {
    id: "0030_engine_capability_reports",
    file: "0030_engine_capability_reports.sql",
  },
  {
    id: "0031_character_relationships",
    file: "0031_character_relationships.sql",
  },
  {
    id: "0032_route_choice_maps",
    file: "0032_route_choice_maps.sql",
  },
  {
    id: "0033_terminology_candidates",
    file: "0033_terminology_candidates.sql",
  },
  {
    id: "0034_draft_jobs",
    file: "0034_draft_jobs.sql",
  },
  {
    id: "0035_draft_attempt_provider_ledger",
    file: "0035_draft_attempt_provider_ledger.sql",
  },
  {
    id: "0036_asset_localization_decisions",
    file: "0036_asset_localization_decisions.sql",
  },
  {
    id: "0037_audit_findings",
    file: "0037_audit_findings.sql",
  },
  {
    id: "0038_draft_attempt_provider_ledger_provider_id_required",
    file: "0038_draft_attempt_provider_ledger_provider_id_required.sql",
  },
  {
    id: "0039_drop_unknown_cost_kind",
    file: "0039_drop_unknown_cost_kind.sql",
  },
  {
    id: "0040_provider_ledger_routing_posture",
    file: "0040_provider_ledger_routing_posture.sql",
  },
  {
    id: "0041_ledger_real_cost_enforcement",
    file: "0041_ledger_real_cost_enforcement.sql",
  },
  {
    id: "0042_provider_ledger_cache_discount",
    file: "0042_provider_ledger_cache_discount.sql",
  },
  {
    id: "0043_reviewer_queue_items",
    file: "0043_reviewer_queue_items.sql",
  },
  {
    id: "0044_job_dependencies",
    file: "0044_job_dependencies.sql",
  },
  {
    id: "0045_reviewer_queue_deferred",
    file: "0045_reviewer_queue_deferred.sql",
  },
  {
    id: "0046_engine_capability_evidence",
    file: "0046_engine_capability_evidence.sql",
  },
  {
    id: "0047_provider_id_pair_integrity",
    file: "0047_provider_id_pair_integrity.sql",
  },
  {
    id: "0048_catalog_conflict_unknown_kind",
    file: "0048_catalog_conflict_unknown_kind.sql",
  },
  {
    id: "0049_provider_ledger_token_count_source",
    file: "0049_provider_ledger_token_count_source.sql",
  },
  {
    id: "0050_workspace_correction_edits",
    file: "0050_workspace_correction_edits.sql",
  },
  {
    id: "0051_source_unit_asset_tombstone",
    file: "0051_source_unit_asset_tombstone.sql",
  },
  {
    id: "0052_job_lifecycle_events",
    file: "0052_job_lifecycle_events.sql",
  },
  {
    id: "0053_style_guide_version_reference_integrity",
    file: "0053_style_guide_version_reference_integrity.sql",
  },
  {
    id: "0054_style_guide_version_changed_outbox_payload_contract",
    file: "0054_style_guide_version_changed_outbox_payload_contract.sql",
  },
  {
    id: "0055_catalog_seed_target_inert_status",
    file: "0055_catalog_seed_target_inert_status.sql",
  },
  {
    id: "0056_style_guide_approve_permission",
    file: "0056_style_guide_approve_permission.sql",
  },
  {
    id: "0057_style_guide_draft_provenance_backfill",
    file: "0057_style_guide_draft_provenance_backfill.sql",
  },
  {
    id: "0058_localization_pass_ledger",
    file: "0058_localization_pass_ledger.sql",
  },
  {
    id: "0059_auth_principal_schema",
    file: "0059_auth_principal_schema.sql",
  },
  {
    id: "0060_auth_permission_set_model",
    file: "0060_auth_permission_set_model.sql",
  },
  {
    id: "0061_auth_authorization_boundary_hardening",
    file: "0061_auth_authorization_boundary_hardening.sql",
  },
  {
    id: "0062_catalog_release_mapping_source_traversal_index",
    file: "0062_catalog_release_mapping_source_traversal_index.sql",
  },
  {
    id: "0063_translation_memory_check_constraints",
    file: "0063_translation_memory_check_constraints.sql",
  },
  {
    id: "0064_benchmark_runs",
    file: "0064_benchmark_runs.sql",
  },
  {
    id: "0065_auth_provider_claim_quarantine",
    file: "0065_auth_provider_claim_quarantine.sql",
  },
  {
    id: "0066_auth_sso_settings",
    file: "0066_auth_sso_settings.sql",
  },
  {
    id: "0067_auth_members_manage_permission",
    file: "0067_auth_members_manage_permission.sql",
  },
  {
    id: "0068_scene_localization_coverage",
    file: "0068_scene_localization_coverage.sql",
  },
  {
    id: "0069_auth_permissions_manage_permission",
    file: "0069_auth_permissions_manage_permission.sql",
  },
  {
    id: "0070_auth_session_admin_tools",
    file: "0070_auth_session_admin_tools.sql",
  },
  {
    id: "0071_wiki_brand_contexts",
    file: "0071_wiki_brand_contexts.sql",
  },
  {
    id: "0072_auth_account_billing_seats",
    file: "0072_auth_account_billing_seats.sql",
  },
  {
    id: "0073_model_routing_settings",
    file: "0073_model_routing_settings.sql",
  },
  {
    id: "0074_translation_scope_settings",
    file: "0074_translation_scope_settings.sql",
  },
  {
    id: "0075_localization_pass_run_configs",
    file: "0075_localization_pass_run_configs.sql",
  },
  {
    id: "0076_localization_attempt_outcome_journal",
    file: "0076_localization_attempt_outcome_journal.sql",
  },
] as const;

function migrationPath(file: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "migrations", file);
}
