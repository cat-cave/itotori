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
] as const;

function migrationPath(file: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "migrations", file);
}
