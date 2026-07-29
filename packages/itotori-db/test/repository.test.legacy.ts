import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate, migrations } from "../src/migrations.js";
import { isolatedMigratedContext } from "./db-test-context.js";

export async function migratedContext() {
  return isolatedMigratedContext();
}

export function requiredDatabaseUrl(): string {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for DB-backed repository tests");
  }
  return process.env.DATABASE_URL;
}

export function migrationSql(file: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "..", "migrations", file), "utf8");
}

export async function seedLegacySelectedPatchForRetirement(pool: pg.Pool): Promise<void> {
  await pool.query(`
    insert into itotori_workspaces (workspace_id, name)
    values ('workspace-retained-citation', 'Retained citation workspace')
  `);
  await pool.query(`
    insert into itotori_projects (
      project_id,
      workspace_id,
      project_key,
      name,
      source_locale,
      status
    )
    values (
      'project-retained-citation',
      'workspace-retained-citation',
      'retained-citation',
      'Retained citation project',
      'ja-JP',
      'imported'
    )
  `);
  await pool.query(`
    insert into itotori_source_revisions (
      source_revision_id,
      project_id,
      revision_kind,
      value
    )
    values (
      'revision-retained-citation',
      'project-retained-citation',
      'bridge_revision',
      'retained-citation-v1'
    )
  `);
  await pool.query(`
    insert into itotori_source_bundles (
      source_bundle_id,
      project_id,
      source_bundle_revision_id,
      bridge_id,
      schema_version,
      source_bundle_hash,
      source_locale,
      extractor_name,
      extractor_version,
      unit_count,
      asset_count
    )
    values (
      'bundle-retained-citation',
      'project-retained-citation',
      'revision-retained-citation',
      'bridge-retained-citation',
      '0.2.0',
      'hash:bundle-retained-citation',
      'ja-JP',
      'fixture-extractor',
      '1.0.0',
      1,
      1
    )
  `);
  await pool.query(`
    insert into itotori_assets (
      asset_id,
      project_id,
      source_bundle_id,
      source_revision_id,
      asset_key,
      asset_kind,
      source_hash
    )
    values (
      'asset-retained-citation',
      'project-retained-citation',
      'bundle-retained-citation',
      'revision-retained-citation',
      'scene-010',
      'script',
      'hash:asset-retained-citation'
    )
  `);
  await pool.query(`
    insert into itotori_source_units (
      bridge_unit_id,
      project_id,
      source_bundle_id,
      source_asset_id,
      source_revision_id,
      surface_id,
      surface_kind,
      source_unit_key,
      occurrence_id,
      source_locale,
      source_text,
      source_hash,
      source_location,
      context,
      spans,
      patch_ref,
      runtime_expectation
    )
    values (
      'unit-retained-citation',
      'project-retained-citation',
      'bundle-retained-citation',
      'asset-retained-citation',
      'revision-retained-citation',
      'scene-010',
      'dialogue',
      'scene.010.retained',
      'occurrence-retained-citation',
      'ja-JP',
      'Retained source line',
      'hash:retained-citation',
      '{}'::jsonb,
      '{}'::jsonb,
      '[]'::jsonb,
      '{}'::jsonb,
      '{}'::jsonb
    )
  `);
  await pool.query(`
    insert into itotori_locale_branches (
      locale_branch_id,
      project_id,
      source_bundle_id,
      target_locale,
      branch_name,
      status
    )
    values (
      'locale-retained-citation',
      'project-retained-citation',
      'bundle-retained-citation',
      'en-US',
      'English',
      'active'
    )
  `);
  await pool.query(`
    insert into itotori_context_artifacts (
      context_artifact_id,
      project_id,
      locale_branch_id,
      source_revision_id,
      category,
      title,
      normalized_title,
      body,
      content_hash,
      produced_by_tool,
      producer_version
    )
    values (
      'context-artifact-retained-citation',
      'project-retained-citation',
      'locale-retained-citation',
      'revision-retained-citation',
      'scene_summary',
      'Retained citation',
      'retained citation',
      'Citation rows must survive source unit removal.',
      'sha256:retained-citation',
      'tool.context-artifacts',
      '1.0.0'
    )
  `);
  await pool.query(`
    insert into itotori_context_artifact_source_units (
      context_artifact_id,
      bridge_unit_id,
      source_revision_id,
      source_hash,
      citation
    )
    values (
      'context-artifact-retained-citation',
      'unit-retained-citation',
      'revision-retained-citation',
      'hash:retained-citation',
      'scene.010.retained'
    )
  `);

  const client = await pool.connect();
  try {
    await client.query(`
      begin;
      set constraints all deferred;

      insert into itotori_localization_journal_runs (
        run_id, project_id, locale_branch_id, source_revision_id, target_locale, status
      ) values (
        'run-retirement-selected',
        'project-retained-citation',
        'locale-retained-citation',
        'revision-retained-citation',
        'en-US',
        'succeeded'
      );

      insert into itotori_localization_journal_run_units (
        run_id, bridge_unit_id, source_unit_key, unit_ordinal, state, next_action
      ) values (
        'run-retirement-selected',
        'unit-retained-citation',
        'scene.010.retained',
        0,
        'written',
        null
      );

      insert into itotori_llm_attempts (
        attempt_id, run_id, bridge_unit_id, stage, agent_label, logical_call_id,
        attempt_index, lifecycle_state, model_id, provider_id, provider_run_id,
        cost_usd, billing_state, zdr, validation_result, retry_decision,
        started_at, completed_at
      ) values (
        'attempt-retirement-selected',
        'run-retirement-selected',
        'unit-retained-citation',
        'translation',
        'fixture-agent',
        'logical-retirement-selected',
        0,
        'completed',
        'fixture-model',
        'fixture-provider',
        'provider-retirement-selected',
        0,
        'known',
        true,
        'accepted',
        'write',
        now(),
        now()
      );

      insert into itotori_written_unit_outcomes (
        journal_outcome_id, outcome_id, run_id, bridge_unit_id, source_unit_key,
        target_locale, selected_candidate_id, written_at
      ) values (
        'outcome-retirement-selected',
        'outcome-retirement-selected',
        'run-retirement-selected',
        'unit-retained-citation',
        'scene.010.retained',
        'en-US',
        'candidate-retirement-selected',
        now()
      );

      insert into itotori_translation_candidates (
        journal_candidate_id, candidate_id, journal_outcome_id, run_id, bridge_unit_id,
        candidate_ordinal, body, model_id, provider_id, attempt_id, kind
      ) values (
        'journal-candidate-retirement-selected',
        'candidate-retirement-selected',
        'outcome-retirement-selected',
        'run-retirement-selected',
        'unit-retained-citation',
        0,
        'Selected target survives the retirement.',
        'fixture-model',
        'fixture-provider',
        'attempt-retirement-selected',
        'primary'
      );

      insert into itotori_localization_result_revisions (
        result_revision_id, journal_outcome_id, run_id, bridge_unit_id,
        selected_candidate_id, target_body, origin
      ) values (
        'run-result:run-retirement-selected:unit-retained-citation',
        'outcome-retirement-selected',
        'run-retirement-selected',
        'unit-retained-citation',
        'candidate-retirement-selected',
        'Selected target survives the retirement.',
        'run_written_outcome'
      );

      insert into itotori_localization_run_finalizer_outbox (
        run_id, stage, status, idempotency_key, payload, evidence
      ) values
        ('run-retirement-selected', 'patch_build', 'succeeded', 'localization-finalizer:run-retirement-selected:patch_build', '{}'::jsonb, '{}'::jsonb),
        ('run-retirement-selected', 'patch_apply', 'succeeded', 'localization-finalizer:run-retirement-selected:patch_apply', '{}'::jsonb, '{}'::jsonb),
        ('run-retirement-selected', 'validation', 'succeeded', 'localization-finalizer:run-retirement-selected:validation', '{}'::jsonb, '{}'::jsonb);

      insert into itotori_localization_patch_versions (
        patch_version_id, run_id, status, artifact_hashes, artifact_refs, origin
      ) values (
        'patch-retirement-selected',
        'run-retirement-selected',
        'building',
        '{"translatedBridge":"sha256:retirement-selected"}'::jsonb,
        '{"translatedBridge":"artifacts/retirement-selected.json"}'::jsonb,
        'run_finalizer'
      );

      insert into itotori_localization_patch_version_units (
        patch_version_id, run_id, bridge_unit_id, journal_outcome_id,
        result_revision_id, source_run_id, member_origin, unit_ordinal
      ) values (
        'patch-retirement-selected',
        'run-retirement-selected',
        'unit-retained-citation',
        'outcome-retirement-selected',
        'run-result:run-retirement-selected:unit-retained-citation',
        'run-retirement-selected',
        'run_written_outcome',
        0
      );

      update itotori_localization_patch_versions
      set status = 'playable', playable_at = now(), selected_at = now()
      where patch_version_id = 'patch-retirement-selected';

      insert into itotori_play_test_feedback_batches (
        feedback_batch_id, observed_patch_version_id, actor_user_id, selection_kind
      ) values (
        'feedback-batch-retirement-selected',
        'patch-retirement-selected',
        'local-user',
        'individual'
      );

      insert into itotori_play_test_feedback_events (
        feedback_event_id, feedback_batch_id, observed_patch_version_id, actor_user_id,
        event_kind, metadata, result_revision_id
      ) values (
        'feedback-retirement-selected',
        'feedback-batch-retirement-selected',
        'patch-retirement-selected',
        'local-user',
        'result_edit',
        '{}'::jsonb,
        'run-result:run-retirement-selected:unit-retained-citation'
      );

      insert into itotori_play_test_feedback_event_units (
        feedback_event_id, observed_patch_version_id, bridge_unit_id
      ) values (
        'feedback-retirement-selected',
        'patch-retirement-selected',
        'unit-retained-citation'
      );

      commit;
    `);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function seedLegacyHelloWorldState(pool: pg.Pool): Promise<void> {
  await pool.query(`
    insert into itotori_projects (
      project_id,
      bridge_id,
      source_locale,
      target_locale,
      locale_branch_id,
      status
    )
    values (
      'legacy-project',
      'legacy-bridge',
      'ja-JP',
      'en-US',
      'legacy-locale-en-us',
      'hello_world_passed'
    )
  `);
  await pool.query(`
    insert into itotori_bridge_units (
      bridge_unit_id,
      project_id,
      source_unit_key,
      source_text,
      target_text,
      text_surface,
      protected_span_count
    )
    values (
      'legacy-unit',
      'legacy-project',
      'hello.scene.001.line.001',
      'こんにちは、{player}。',
      'Hello, {player}.',
      'dialogue',
      1
    )
  `);
  await pool.query(`
    insert into itotori_patch_exports (
      patch_export_id,
      project_id,
      target_locale,
      entry_count
    )
    values ('legacy-patch', 'legacy-project', 'en-US', 1)
  `);
  await pool.query(`
    insert into itotori_runtime_reports (
      runtime_report_id,
      project_id,
      status,
      fidelity_tier,
      text_event_count,
      frame_capture_count
    )
    values ('legacy-runtime', 'legacy-project', 'passed', 'layout_probe', 1, 1)
  `);
  await pool.query(`
    insert into itotori_hello_world_runs (
      run_id,
      project_id,
      patch_result_id,
      final_status
    )
    values ('legacy-run', 'legacy-project', 'legacy-patch-result', 'hello_world_passed')
  `);
}

export function databaseUrlWithSearchPath(databaseUrl: string, schemaName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}

export function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`invalid SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}
