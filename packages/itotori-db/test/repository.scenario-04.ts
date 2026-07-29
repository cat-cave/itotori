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
  it("preserves import-status invariants on an idempotent same-revision reimport", async () => {
    // Reimporting the EXACT same (sourceBundleId, sourceBundleRevisionId)
    // upserts the existing bridge_imports row (unique index) — it does NOT
    // create a duplicate. The bridgeImportId is deterministic per (project,
    // bundle, revision), the diff counts collapse to all-unchanged/existing,
    // and the diff-count partitions sum to the totals across both imports. The
    // project status stays "imported" (no invalid transition).
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);
      const bridge = bridgeV02Fixture();
      const project = projectV02Fixture(bridge);

      const firstImport = await repo.importSourceBundle(localActor, project);
      const secondImport = await repo.importSourceBundle(localActor, project);

      expect(secondImport.bridgeImportId).toBe(firstImport.bridgeImportId);
      expect(secondImport.units).toEqual({
        added: 0,
        updated: 0,
        removed: 0,
        unchanged: bridge.units.length,
      });
      expect(secondImport.assets).toEqual({
        added: 0,
        updated: 0,
        removed: 0,
        unchanged: bridge.assets.length,
      });
      expect(secondImport.sourceRevisions).toEqual({
        added: 0,
        existing: firstImport.sourceRevisionCount,
      });

      for (const status of [firstImport, secondImport]) {
        expect(status.sourceRevisions.added + status.sourceRevisions.existing).toBe(
          status.sourceRevisionCount,
        );
        expect(status.units.added + status.units.updated + status.units.unchanged).toBe(
          status.unitCount,
        );
        expect(status.assets.added + status.assets.updated + status.assets.unchanged).toBe(
          status.assetCount,
        );
      }

      const imports = await context.pool.query<{ count: number }>(
        "select count(*)::int from itotori_bridge_imports where project_id = $1",
        ["project-v02"],
      );
      expect(imports.rows[0]?.count).toBe(1);

      const projectRow = await context.pool.query<{ status: string }>(
        "select status from itotori_projects where project_id = $1",
        ["project-v02"],
      );
      expect(projectRow.rows[0]?.status).toBe("imported");
    } finally {
      await context.close();
    }
  });
  it("preserves import-status diff invariants across a new-revision reimport", async () => {
    // A reimport that advances the sourceBundleRevision creates a NEW
    // bridge_imports row (one per revision) with a distinct deterministic
    // bridgeImportId, while the diff counts transition correctly (one added
    // revision, the rest existing; units/assets all unchanged). The diff-count
    // partitions sum to the totals across the transition — no invalid status.
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);
      const bridge = bridgeV02Fixture();
      const firstImport = await repo.importSourceBundle(localActor, projectV02Fixture(bridge));

      const reimportedBridge: BridgeBundleV02 = {
        ...bridge,
        sourceBundleHash: v02Sha256("new-revision-reimport-invariants"),
        sourceBundleRevision: {
          ...bridge.sourceBundleRevision,
          revisionId: "019ed001-0000-7000-8000-000000000115",
          value: v02Sha256("new-revision-reimport-invariants"),
        },
      };
      const secondImport = await repo.importSourceBundle(
        localActor,
        projectV02Fixture(reimportedBridge),
      );

      expect(secondImport.bridgeImportId).not.toBe(firstImport.bridgeImportId);
      expect(secondImport.sourceBundleRevisionId).toBe("019ed001-0000-7000-8000-000000000115");

      expect(firstImport.sourceRevisions).toEqual({
        added: firstImport.sourceRevisionCount,
        existing: 0,
      });
      expect(secondImport.sourceRevisions).toEqual({
        added: 1,
        existing: firstImport.sourceRevisionCount - 1,
      });
      expect(secondImport.units).toEqual({
        added: 0,
        updated: 0,
        removed: 0,
        unchanged: bridge.units.length,
      });
      expect(secondImport.assets).toEqual({
        added: 0,
        updated: 0,
        removed: 0,
        unchanged: bridge.assets.length,
      });

      for (const status of [firstImport, secondImport]) {
        expect(status.sourceRevisions.added + status.sourceRevisions.existing).toBe(
          status.sourceRevisionCount,
        );
        expect(status.units.added + status.units.updated + status.units.unchanged).toBe(
          status.unitCount,
        );
        expect(status.assets.added + status.assets.updated + status.assets.unchanged).toBe(
          status.assetCount,
        );
      }

      const imports = await context.pool.query<{ bridge_import_id: string }>(
        "select bridge_import_id from itotori_bridge_imports where project_id = $1 order by source_bundle_revision_id",
        ["project-v02"],
      );
      expect(imports.rows).toEqual([
        { bridge_import_id: firstImport.bridgeImportId },
        { bridge_import_id: secondImport.bridgeImportId },
      ]);

      const revisions = await context.pool.query<{ count: number }>(
        "select count(*)::int from itotori_source_revisions where project_id = $1",
        ["project-v02"],
      );
      expect(revisions.rows[0]?.count).toBe(firstImport.sourceRevisionCount + 1);
    } finally {
      await context.close();
    }
  });
  it("reimports a migrated legacy bridge through its existing source bundle id", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);
      await context.pool.query(
        `
        insert into itotori_workspaces (workspace_id, name)
        values ('local-workspace', 'Local workspace')
      `,
      );
      await context.pool.query(
        `
        insert into itotori_projects (
          project_id,
          workspace_id,
          project_key,
          name,
          source_locale,
          status,
          created_by_user_id
        )
        values (
          'project-test',
          'local-workspace',
          'project-test',
          'project-test',
          'ja-JP',
          'runtime_ingested',
          'local-user'
        )
      `,
      );
      await context.pool.query(
        `
        insert into itotori_source_revisions (
          source_revision_id,
          project_id,
          revision_kind,
          value
        )
        values (
          'legacy:project-test:bundle-revision',
          'project-test',
          'legacy_bridge_id',
          'bridge-test'
        )
      `,
      );
      await context.pool.query(
        `
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
          'legacy:project-test:source-bundle',
          'project-test',
          'legacy:project-test:bundle-revision',
          'bridge-test',
          '0.1.0',
          'legacy:bridge-test',
          'ja-JP',
          'legacy-hello-world',
          '0.1.0',
          0,
          0
        )
      `,
      );

      const importStatus = await repo.importSourceBundle(localActor, projectFixture());

      expect(importStatus).toMatchObject({
        bridgeId: "bridge-test",
        sourceBundleId: "legacy:project-test:source-bundle",
        sourceBundleRevisionId: "bridge-test:bundle-revision",
        unitCount: 1,
        assetCount: 1,
      });

      const bundles = await context.pool.query<{
        source_bundle_id: string;
        bridge_id: string;
        source_bundle_revision_id: string;
        unit_count: number;
        asset_count: number;
      }>(
        `
        select
          source_bundle_id,
          bridge_id,
          source_bundle_revision_id,
          unit_count,
          asset_count
        from itotori_source_bundles
      `,
      );
      expect(bundles.rows).toEqual([
        {
          source_bundle_id: "legacy:project-test:source-bundle",
          bridge_id: "bridge-test",
          source_bundle_revision_id: "bridge-test:bundle-revision",
          unit_count: 1,
          asset_count: 1,
        },
      ]);

      const importedProject = { ...projectFixture(), importStatus };
      await repo.savePatchExport(localActor, importedProject, {
        schemaVersion: "0.1.0",
        patchExportId: "legacy-remap-patch",
        sourceBridgeId: "bridge-test",
        sourceBundleHash: "hash-test",
        sourceLocale: "ja-JP",
        targetLocale: "en-US",
        entries: [
          {
            entryId: "legacy-remap-entry",
            bridgeUnitId: "bridge-unit-test",
            sourceUnitKey: "hello.scene.001.line.001",
            sourceHash: "source-hash",
            targetText: "Hello, {player}.",
            protectedSpanMappings: [{ raw: "{player}", targetStart: 7, targetEnd: 15 }],
          },
        ],
      });
      await repo.saveRuntimeReport(
        localActor,
        importedProject,
        runtimeEvidenceReportFixture(),
        "legacy-remap-patch-result",
      );

      const artifactBundles = await context.pool.query<{
        artifact_id: string;
        source_bundle_id: string | null;
      }>(
        `
        select artifact_id, source_bundle_id
        from itotori_artifacts
        where artifact_id in ($1, $2, $3)
        order by artifact_id
      `,
        ["019ed003-0000-7000-8000-000000000901", "legacy-remap-patch", "legacy-remap-patch-result"],
      );
      expect(artifactBundles.rows).toEqual([
        {
          artifact_id: "019ed003-0000-7000-8000-000000000901",
          source_bundle_id: "legacy:project-test:source-bundle",
        },
        {
          artifact_id: "legacy-remap-patch",
          source_bundle_id: "legacy:project-test:source-bundle",
        },
        {
          artifact_id: "legacy-remap-patch-result",
          source_bundle_id: "legacy:project-test:source-bundle",
        },
      ]);

      const runtimeRows = await context.pool.query<{
        row_kind: string;
        source_bundle_id: string;
        source_bundle_revision_id: string;
      }>(`
        select
          'run' as row_kind,
          source_bundle_id,
          source_bundle_revision_id
        from itotori_runtime_evidence_runs
        union all
        select
          'item' as row_kind,
          source_bundle_id,
          source_bundle_revision_id
        from itotori_runtime_evidence_items
        order by row_kind, source_bundle_id, source_bundle_revision_id
      `);
      expect(runtimeRows.rows.length).toBeGreaterThan(0);
      expect(
        runtimeRows.rows.every(
          (row) =>
            row.source_bundle_id === "legacy:project-test:source-bundle" &&
            row.source_bundle_revision_id === "bridge-test:bundle-revision",
        ),
      ).toBe(true);
    } finally {
      await context.close();
    }
  });
});
