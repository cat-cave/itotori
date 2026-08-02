import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";

import { describe, expect, it } from "vitest";

import {
  FormatVersionMismatchError,
  type BridgeBundleV02,
} from "@itotori/localization-bridge-schema";

import { ItotoriProjectRepository } from "../src/repositories/project-repository.js";

import {
  bridgeV02Fixture,
  localActor,
  projectFixture,
  projectV02Fixture,
  v02Sha256,
} from "./repository.test.shared.js";
import { migratedContext } from "./repository.test.legacy.js";

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
  it("rejects a legacy bridge reimport without remapping its persisted source bundle", async () => {
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

      const legacyProject = projectFixture({
        bridge: {
          schemaVersion: "0.1.0",
          bridgeId: "bridge-test",
          sourceBundleHash: "hash-test",
          sourceLocale: "ja-JP",
          extractorName: "legacy-hello-world",
          extractorVersion: "0.1.0",
          units: [],
        },
      });
      const rejection = repo.importSourceBundle(localActor, legacyProject);
      await expect(rejection).rejects.toBeInstanceOf(FormatVersionMismatchError);
      await expect(rejection).rejects.toThrow(/Migration path:/u);

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
          source_bundle_revision_id: "legacy:project-test:bundle-revision",
          unit_count: 0,
          asset_count: 0,
        },
      ]);

      const mutationCounts = await context.pool.query<{
        bridge_imports: number;
        source_units: number;
        artifacts: number;
      }>(`
        select
          (select count(*)::int from itotori_bridge_imports) as bridge_imports,
          (select count(*)::int from itotori_source_units) as source_units,
          (select count(*)::int from itotori_artifacts) as artifacts
      `);
      expect(mutationCounts.rows[0]).toEqual({
        bridge_imports: 0,
        source_units: 0,
        artifacts: 0,
      });
    } finally {
      await context.close();
    }
  });
});
