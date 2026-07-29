import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { describe, expect, it } from "vitest";
import type { RuntimeEvidenceReportV02 } from "@itotori/localization-bridge-schema";
import type { BridgeBundleV02 } from "@itotori/localization-bridge-schema";
import {
  allPermissions,
  localUserId,
  permissionValues,
  type AuthorizationActor,
} from "../src/authorization.js";
import {
  ItotoriProjectRepository,
  RuntimeRunNotFoundError,
  type ItotoriProjectRecord,
} from "../src/repositories/project-repository.js";
import { createDatabaseContext } from "../src/connection.js";
import { ItotoriLocalizationResultRevisionRepository } from "../src/repositories/localization-result-revision-repository.js";
import { migrate, migrations } from "../src/migrations.js";
import {
  feedbackContextStatusValues,
  feedbackReportStatusValues,
  feedbackTriageLabelValues,
  feedbackTypeValues,
  ItotoriFeedbackRepository,
  parseManualFeedbackImportInput,
  type ManualFeedbackImportInput,
} from "../src/repositories/feedback-repository.js";
import {
  artifacts,
  events,
  feedbackReportEvidence,
  feedbackReports,
  feedbackSources,
  localeBranches,
  sourceBundles,
  userPermissionGrants,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";
import {
  bridgeV02Fixture,
  escapeRegExp,
  invalidLegacyRuntimeArtifactUriCases,
  invalidManagedRuntimeArtifactUriCases,
  localActor,
  manualFeedbackFixture,
  patchExportV02Fixture,
  projectFixture,
  projectV02Fixture,
  runtimeEvidenceReportFixture,
  stableSerializeHashInput,
  stableSerializeValue,
  v02Sha256,
} from "./repository.test.shared.js";
import {
  databaseUrlWithSearchPath,
  migratedContext,
  migrationSql,
  quoteIdentifier,
  requiredDatabaseUrl,
  seedLegacyHelloWorldState,
  seedLegacySelectedPatchForRetirement,
} from "./repository.test.legacy.js";

describe("ItotoriProjectRepository", () => {
  it("keeps locale branch table, index, and foreign-key migration contracts stable", async () => {
    const context = await migratedContext();
    try {
      const columns = await context.db.execute(sql`
        select table_name, column_name, data_type, is_nullable
        from information_schema.columns
        where table_schema = current_schema()
          and table_name in ('itotori_locale_branches', 'itotori_locale_branch_units')
        order by table_name, ordinal_position
      `);
      expect(
        columns.rows.map((row) => ({
          tableName: String(row.table_name),
          columnName: String(row.column_name),
          dataType: String(row.data_type),
          nullable: String(row.is_nullable) === "YES",
        })),
      ).toEqual([
        {
          tableName: "itotori_locale_branch_units",
          columnName: "locale_branch_id",
          dataType: "text",
          nullable: false,
        },
        {
          tableName: "itotori_locale_branch_units",
          columnName: "bridge_unit_id",
          dataType: "text",
          nullable: false,
        },
        {
          tableName: "itotori_locale_branch_units",
          columnName: "target_text",
          dataType: "text",
          nullable: true,
        },
        {
          tableName: "itotori_locale_branch_units",
          columnName: "updated_at",
          dataType: "timestamp with time zone",
          nullable: false,
        },
        {
          tableName: "itotori_locale_branch_units",
          columnName: "style_guide_version_id",
          dataType: "text",
          nullable: true,
        },
        {
          tableName: "itotori_locale_branch_units",
          columnName: "glossary_reference_id",
          dataType: "text",
          nullable: true,
        },
        {
          tableName: "itotori_locale_branches",
          columnName: "locale_branch_id",
          dataType: "text",
          nullable: false,
        },
        {
          tableName: "itotori_locale_branches",
          columnName: "project_id",
          dataType: "text",
          nullable: false,
        },
        {
          tableName: "itotori_locale_branches",
          columnName: "source_bundle_id",
          dataType: "text",
          nullable: false,
        },
        {
          tableName: "itotori_locale_branches",
          columnName: "target_locale",
          dataType: "text",
          nullable: false,
        },
        {
          tableName: "itotori_locale_branches",
          columnName: "branch_name",
          dataType: "text",
          nullable: false,
        },
        {
          tableName: "itotori_locale_branches",
          columnName: "status",
          dataType: "text",
          nullable: false,
        },
        {
          tableName: "itotori_locale_branches",
          columnName: "created_by_user_id",
          dataType: "text",
          nullable: true,
        },
        {
          tableName: "itotori_locale_branches",
          columnName: "created_at",
          dataType: "timestamp with time zone",
          nullable: false,
        },
        {
          tableName: "itotori_locale_branches",
          columnName: "updated_at",
          dataType: "timestamp with time zone",
          nullable: false,
        },
      ]);

      const keyConstraints = await context.db.execute(sql`
        select
          c.relname as table_name,
          con.conname as constraint_name,
          con.contype as constraint_type,
          pg_get_constraintdef(con.oid) as constraint_definition
        from pg_constraint con
        join pg_class c on c.oid = con.conrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = current_schema()
          and c.relname in ('itotori_locale_branches', 'itotori_locale_branch_units')
          and con.contype in ('p', 'u')
        order by c.relname, con.conname
      `);
      expect(
        keyConstraints.rows.map((row) => ({
          tableName: String(row.table_name),
          constraintName: String(row.constraint_name),
          constraintType: String(row.constraint_type),
          constraintDefinition: String(row.constraint_definition),
        })),
      ).toEqual([
        {
          tableName: "itotori_locale_branch_units",
          constraintName: "itotori_locale_branch_units_pkey",
          constraintType: "p",
          constraintDefinition: "PRIMARY KEY (locale_branch_id, bridge_unit_id)",
        },
        {
          tableName: "itotori_locale_branches",
          constraintName: "itotori_locale_branches_pkey",
          constraintType: "p",
          constraintDefinition: "PRIMARY KEY (locale_branch_id)",
        },
      ]);

      const indexes = await context.db.execute(sql`
        select
          index_class.relname as index_name,
          table_class.relname as table_name,
          index_record.indisunique,
          array_to_string(array_agg(attribute.attname order by key.ordinality), ',') as column_names
        from pg_index index_record
        join pg_class table_class on table_class.oid = index_record.indrelid
        join pg_namespace namespace on namespace.oid = table_class.relnamespace
        join pg_class index_class on index_class.oid = index_record.indexrelid
        join lateral unnest(index_record.indkey) with ordinality as key(attnum, ordinality)
          on true
        join pg_attribute attribute
          on attribute.attrelid = table_class.oid
          and attribute.attnum = key.attnum
        where namespace.nspname = current_schema()
          and index_class.relname in (
            'itotori_locale_branches_project_locale_idx',
            'itotori_locale_branches_bundle_idx',
            'itotori_locale_branch_units_bridge_unit_idx',
            'itotori_locale_branch_units_glossary_reference_idx',
            'itotori_locale_branch_units_style_guide_version_idx'
          )
        group by index_class.relname, table_class.relname, index_record.indisunique
        order by index_class.relname
      `);
      expect(
        indexes.rows.map((row) => ({
          indexName: String(row.index_name),
          tableName: String(row.table_name),
          unique: row.indisunique === true,
          columnNames: String(row.column_names),
        })),
      ).toEqual([
        {
          indexName: "itotori_locale_branch_units_bridge_unit_idx",
          tableName: "itotori_locale_branch_units",
          unique: false,
          columnNames: "bridge_unit_id",
        },
        {
          indexName: "itotori_locale_branch_units_glossary_reference_idx",
          tableName: "itotori_locale_branch_units",
          unique: false,
          columnNames: "glossary_reference_id",
        },
        {
          indexName: "itotori_locale_branch_units_style_guide_version_idx",
          tableName: "itotori_locale_branch_units",
          unique: false,
          columnNames: "style_guide_version_id",
        },
        {
          indexName: "itotori_locale_branches_bundle_idx",
          tableName: "itotori_locale_branches",
          unique: false,
          columnNames: "source_bundle_id",
        },
        {
          indexName: "itotori_locale_branches_project_locale_idx",
          tableName: "itotori_locale_branches",
          unique: false,
          columnNames: "project_id,target_locale",
        },
      ]);

      const foreignKeys = await context.db.execute(sql`
        select
          c.relname as table_name,
          con.conname as constraint_name,
          pg_get_constraintdef(con.oid) as constraint_definition
        from pg_constraint con
        join pg_class c on c.oid = con.conrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = current_schema()
          and c.relname in ('itotori_locale_branches', 'itotori_locale_branch_units')
          and con.contype = 'f'
        order by c.relname, con.conname
      `);
      expect(
        foreignKeys.rows.map((row) => ({
          tableName: String(row.table_name),
          constraintName: String(row.constraint_name),
          constraintDefinition: String(row.constraint_definition),
        })),
      ).toEqual([
        {
          tableName: "itotori_locale_branch_units",
          constraintName: "itotori_locale_branch_units_bridge_unit_id_fkey",
          constraintDefinition:
            "FOREIGN KEY (bridge_unit_id) REFERENCES itotori_source_units(bridge_unit_id) ON DELETE CASCADE",
        },
        {
          tableName: "itotori_locale_branch_units",
          constraintName: "itotori_locale_branch_units_glossary_reference_id_fkey",
          constraintDefinition:
            "FOREIGN KEY (glossary_reference_id) REFERENCES itotori_branch_policy_glossary_references(reference_id) ON DELETE SET NULL",
        },
        {
          tableName: "itotori_locale_branch_units",
          constraintName: "itotori_locale_branch_units_locale_branch_id_fkey",
          constraintDefinition:
            "FOREIGN KEY (locale_branch_id) REFERENCES itotori_locale_branches(locale_branch_id) ON DELETE CASCADE",
        },
        {
          tableName: "itotori_locale_branch_units",
          constraintName: "itotori_locale_branch_units_style_guide_version_id_fkey",
          constraintDefinition:
            "FOREIGN KEY (style_guide_version_id) REFERENCES itotori_style_guide_versions(style_guide_version_id) ON DELETE SET NULL",
        },
        {
          tableName: "itotori_locale_branches",
          constraintName: "itotori_locale_branches_created_by_user_id_fkey",
          constraintDefinition:
            "FOREIGN KEY (created_by_user_id) REFERENCES itotori_users(user_id) ON DELETE SET NULL",
        },
        {
          tableName: "itotori_locale_branches",
          constraintName: "itotori_locale_branches_project_id_fkey",
          constraintDefinition:
            "FOREIGN KEY (project_id) REFERENCES itotori_projects(project_id) ON DELETE CASCADE",
        },
        {
          tableName: "itotori_locale_branches",
          constraintName: "itotori_locale_branches_source_bundle_id_fkey",
          constraintDefinition:
            "FOREIGN KEY (source_bundle_id) REFERENCES itotori_source_bundles(source_bundle_id) ON DELETE RESTRICT",
        },
      ]);
    } finally {
      await context.close();
    }
  });
  it("preserves selected patches and play feedback while retiring the legacy persistence graph", async () => {
    const databaseUrl = requiredDatabaseUrl();
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const schemaName = `itotori_context_migration_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const schemaUrl = databaseUrlWithSearchPath(databaseUrl, schemaName);

    await admin.query(`create schema ${quoteIdentifier(schemaName)}`);
    const pool = new pg.Pool({ connectionString: schemaUrl });
    try {
      await pool.query(`
        create table if not exists itotori_schema_migrations (
          migration_id text primary key,
          checksum text not null,
          applied_at timestamptz not null default now()
        )
      `);

      const retirementMigrationIndex = migrations.findIndex(
        (migration) => migration.id === "0111_retire_journal_finalizer_context_artifacts",
      );
      expect(retirementMigrationIndex).toBeGreaterThan(0);
      for (const migration of migrations.slice(0, retirementMigrationIndex)) {
        const body = migrationSql(migration.file);
        await pool.query(body);
        await pool.query(
          "insert into itotori_schema_migrations (migration_id, checksum) values ($1, $2)",
          [migration.id, createHash("sha256").update(body).digest("hex")],
        );
      }

      await seedLegacySelectedPatchForRetirement(pool);

      await migrate(schemaUrl);

      const upgraded = createDatabaseContext(schemaUrl);
      try {
        const repository = new ItotoriLocalizationResultRevisionRepository(upgraded.db, {
          async materialize() {
            throw new Error("the upgrade readability proof does not materialize a child patch");
          },
        });
        const selected = await repository.loadSelectedPatchExport(localActor, {
          patchVersionId: "patch-retirement-selected",
        });
        expect(selected).toMatchObject({
          patchVersionId: "patch-retirement-selected",
          runId: "run-retirement-selected",
          status: "playable",
          units: [
            {
              bridgeUnitId: "unit-retained-citation",
              resultRevisionId: "run-result:run-retirement-selected:unit-retained-citation",
              targetBody: "Selected target survives the retirement.",
            },
          ],
        });
      } finally {
        await upgraded.close();
      }

      const feedback = await pool.query<{
        output_revision_id: string;
        subject_ref: string | null;
      }>(`
        select output_revision_id, subject_ref
        from itotori_play_test_feedback_events
        where feedback_event_id = 'feedback-retirement-selected'
      `);
      expect(feedback.rows).toEqual([
        {
          output_revision_id: "run-result:run-retirement-selected:unit-retained-citation",
          subject_ref: null,
        },
      ]);

      const feedbackUnits = await pool.query<{ bridge_unit_id: string }>(`
        select bridge_unit_id
        from itotori_play_test_feedback_event_units
        where feedback_event_id = 'feedback-retirement-selected'
      `);
      expect(feedbackUnits.rows).toEqual([{ bridge_unit_id: "unit-retained-citation" }]);

      const retiredTables = await pool.query<{ table_name: string }>(`
        select table_name
        from information_schema.tables
        where table_schema = current_schema()
          and table_name in (
            'itotori_context_artifacts',
            'itotori_context_entry_versions',
            'itotori_context_artifact_source_units',
            'itotori_localization_journal_runs',
            'itotori_localization_journal_run_units',
            'itotori_llm_attempts',
            'itotori_localization_cost_reservations',
            'itotori_localization_run_cost_accounts',
            'itotori_written_unit_outcomes',
            'itotori_translation_candidates',
            'itotori_localization_result_revisions',
            'itotori_written_qa_findings',
            'itotori_outcome_context_refs',
            'itotori_outcome_speaker_labels',
            'itotori_localization_run_terminal_summaries',
            'itotori_localization_run_finalizer_outbox',
            'itotori_play_sessions'
          )
      `);
      expect(retiredTables.rows).toEqual([]);
    } finally {
      await pool.end();
      await admin.query(`drop schema ${quoteIdentifier(schemaName)} cascade`);
      await admin.end();
    }
  });
});
