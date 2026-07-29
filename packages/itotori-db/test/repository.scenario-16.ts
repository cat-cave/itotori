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
  it("backfills legacy hello-world state during the v0.2 migration", async () => {
    const databaseUrl = requiredDatabaseUrl();
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const schemaName = `itotori_migration_${Date.now()}_${Math.random().toString(16).slice(2)}`;

    await admin.query(`create schema ${quoteIdentifier(schemaName)}`);
    const pool = new pg.Pool({
      connectionString: databaseUrlWithSearchPath(databaseUrl, schemaName),
    });
    try {
      await pool.query(migrationSql("0001_hello_world.sql"));
      await pool.query(migrationSql("0002_permissions.sql"));
      await seedLegacyHelloWorldState(pool);
      await pool.query(migrationSql("0003_persistence_v02.sql"));

      const project = await pool.query<{
        status: string;
        source_locale: string;
      }>("select status, source_locale from itotori_projects where project_id = $1", [
        "legacy-project",
      ]);
      expect(project.rows[0]).toEqual({
        status: "runtime_ingested",
        source_locale: "ja-JP",
      });

      const unit = await pool.query<{
        bridge_unit_id: string;
        target_text: string | null;
      }>(
        `
        select su.bridge_unit_id, lbu.target_text
        from itotori_source_units su
        join itotori_locale_branch_units lbu using (bridge_unit_id)
        where su.bridge_unit_id = $1
      `,
        ["legacy-unit"],
      );
      expect(unit.rows[0]).toEqual({
        bridge_unit_id: "legacy-unit",
        target_text: "Hello, {player}.",
      });

      const artifactsResult = await pool.query<{
        artifact_id: string;
        artifact_kind: string;
        metadata: Record<string, unknown>;
      }>(
        `
        select artifact_id, artifact_kind, metadata
        from itotori_artifacts
        where project_id = $1
        order by artifact_kind
      `,
        ["legacy-project"],
      );
      expect(artifactsResult.rows.map((row) => row.artifact_id).sort()).toEqual([
        "legacy-patch",
        "legacy-patch-result",
        "legacy-runtime",
      ]);
      expect(
        artifactsResult.rows.find((row) => row.artifact_kind === "runtime_report")?.metadata,
      ).toMatchObject({
        status: "passed",
        fidelityTier: "layout_probe",
        textEventCount: 1,
        frameCaptureCount: 1,
      });

      const runtimeStatus = await pool.query<{
        final_status: string;
        runtime_report_id: string;
      }>(
        `
        select
          patch.metadata->>'finalStatus' as final_status,
          runtime.artifact_id as runtime_report_id
        from itotori_artifacts patch
        join itotori_artifacts runtime on runtime.project_id = patch.project_id
        where patch.artifact_kind = 'patch_result'
          and runtime.artifact_kind = 'runtime_report'
          and patch.project_id = $1
      `,
        ["legacy-project"],
      );
      expect(runtimeStatus.rows[0]).toEqual({
        final_status: "hello_world_passed",
        runtime_report_id: "legacy-runtime",
      });

      const eventsResult = await pool.query<{ event_kind: string }>(
        "select event_kind from itotori_events where project_id = $1 order by event_kind",
        ["legacy-project"],
      );
      expect(eventsResult.rows.map((row) => row.event_kind)).toEqual([
        "patch_result_recorded",
        "runtime_report_migrated",
      ]);

      const legacyTable = await pool.query<{ table_name: string | null }>(
        "select to_regclass('itotori_legacy_projects')::text as table_name",
      );
      expect(legacyTable.rows[0]?.table_name).toBe("itotori_legacy_projects");
    } finally {
      await pool.end();
      await admin.query(`drop schema ${quoteIdentifier(schemaName)} cascade`);
      await admin.end();
    }
  });
});
