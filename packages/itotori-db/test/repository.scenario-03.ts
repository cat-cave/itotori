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
  it("rejects reused bridge unit ids from another source bundle before mutation", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);
      const firstProject = projectFixture();
      const firstUnit = firstProject.bridge.units[0]!;
      const conflictingProject = projectFixture({
        bridge: {
          ...firstProject.bridge,
          bridgeId: "bridge-conflict",
          sourceBundleHash: "hash-conflict",
          units: [
            {
              ...firstUnit,
              sourceUnitKey: "hello.scene.001.line.002",
              occurrenceId: "occurrence-2",
              sourceHash: "source-hash-conflict",
              patchRef: {
                ...firstUnit.patchRef,
                assetId: "source-conflict.json",
                sourceUnitKey: "hello.scene.001.line.002",
              },
            },
          ],
        },
      });

      await repo.importSourceBundle(localActor, firstProject);
      await expect(repo.importSourceBundle(localActor, conflictingProject)).rejects.toThrow(
        /bridge unit bridge-unit-test already belongs to project project-test source bundle bridge-test/,
      );

      const counts = await context.pool.query<{
        source_bundles: number;
        bridge_imports: number;
      }>(`
        select
          (select count(*)::int from itotori_source_bundles) as source_bundles,
          (select count(*)::int from itotori_bridge_imports) as bridge_imports
      `);
      expect(counts.rows[0]).toEqual({
        source_bundles: 1,
        bridge_imports: 1,
      });
    } finally {
      await context.close();
    }
  });
  it("rejects reimport that changes bridge unit id for a stable source unit key", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);
      const project = projectFixture();
      const firstImport = await repo.importSourceBundle(localActor, project);
      const firstUnit = project.bridge.units[0]!;
      const rekeyedProject = projectFixture({
        drafts: { "bridge-unit-rekeyed": "Hello, {player}." },
        bridge: {
          ...project.bridge,
          sourceBundleHash: "hash-rekeyed",
          units: [
            {
              ...firstUnit,
              bridgeUnitId: "bridge-unit-rekeyed",
              sourceHash: "source-hash-rekeyed",
            },
          ],
        },
      });

      await expect(repo.importSourceBundle(localActor, rekeyedProject)).rejects.toThrow(
        /sourceUnitKey hello\.scene\.001\.line\.001 is already linked to bridgeUnitId bridge-unit-test; reimport cannot change it to bridge-unit-rekeyed/,
      );

      const unitRows = await context.pool.query<{
        bridge_unit_id: string;
        source_unit_key: string;
        source_hash: string;
      }>(
        `
        select bridge_unit_id, source_unit_key, source_hash
        from itotori_source_units
        order by bridge_unit_id
      `,
      );
      expect(unitRows.rows).toEqual([
        {
          bridge_unit_id: "bridge-unit-test",
          source_unit_key: "hello.scene.001.line.001",
          source_hash: "source-hash",
        },
      ]);

      const counts = await context.pool.query<{
        source_revisions: number;
        bridge_imports: number;
      }>(`
        select
          (select count(*)::int from itotori_source_revisions) as source_revisions,
          (select count(*)::int from itotori_bridge_imports) as bridge_imports
      `);
      expect(counts.rows[0]).toEqual({
        source_revisions: firstImport.sourceRevisionCount,
        bridge_imports: 1,
      });
    } finally {
      await context.close();
    }
  });
  it("rejects asset ids reused by another project with a semantic ownership diagnostic", async () => {
    // An asset id that already belongs to a different project's source bundle
    // is rejected with a semantic ownership diagnostic — not a silent accept
    // and not a generic DB error. The asset guard fires inside
    // assertImportOwnership BEFORE any project/bundle/unit rows are written, so
    // the second project leaves no partial mutation behind. The second bridge
    // uses a fresh bridge id (so the bundle/bridge ownership guard does not
    // fire) and bridge-id-prefixed revisions (so the revision guard does not
    // fire); only the asset id is reused, isolating the asset guard.
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);
      const firstProject = projectFixture();
      await repo.importSourceBundle(localActor, firstProject);

      const secondProject = projectFixture({
        projectId: "project-cross-asset",
        localeBranchId: "locale-cross-asset",
        bridge: {
          ...firstProject.bridge,
          bridgeId: "bridge-cross-asset",
          sourceBundleHash: "hash-cross-asset",
        },
      });

      await expect(repo.importSourceBundle(localActor, secondProject)).rejects.toThrow(
        /asset source\.json already belongs to project project-test source bundle bridge-test/,
      );

      const counts = await context.pool.query<{
        projects: number;
        source_bundles: number;
        bridge_imports: number;
        assets: number;
      }>(`
        select
          (select count(*)::int from itotori_projects) as projects,
          (select count(*)::int from itotori_source_bundles) as source_bundles,
          (select count(*)::int from itotori_bridge_imports) as bridge_imports,
          (select count(*)::int from itotori_assets) as assets
      `);
      expect(counts.rows[0]).toEqual({
        projects: 1,
        source_bundles: 1,
        bridge_imports: 1,
        assets: 1,
      });
    } finally {
      await context.close();
    }
  });
  it("rejects source revision ids reused by another project with a semantic ownership diagnostic", async () => {
    // A source-revision id that already belongs to another project is rejected
    // with a semantic ownership diagnostic. assertImportOwnership checks
    // revisions BEFORE assets/units, so reusing the v0.2 fixture's revisions
    // under a fresh bridge id (no bundle/bridge conflict) isolates the revision
    // guard as the one that fires. The sourceBundleRevision value is rebased
    // onto the second bundle's hash so the bundle passes schema
    // validation, but its revision id is still reused from the first project.
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);
      const bridge = bridgeV02Fixture();
      const firstImport = await repo.importSourceBundle(localActor, projectV02Fixture(bridge));

      const secondBundleHash = v02Sha256("cross-project-revision-reuse");
      const secondBridge: BridgeBundleV02 = {
        ...bridge,
        bridgeId: "019ed001-0000-7000-8000-000000000099",
        sourceBundleHash: secondBundleHash,
        sourceBundleRevision: {
          ...bridge.sourceBundleRevision,
          value: secondBundleHash,
        },
      };
      const secondProject: ItotoriProjectRecord = {
        projectId: "project-cross-revision",
        engineFamily: "synthetic_fixture",
        sourceRoot: "/workspace/source",
        buildRoot: "/workspace/build",
        extractProfile: { adapter: "fixture" },
        localeBranchId: "locale-cross-revision-fr-fr",
        targetLocale: "fr-FR",
        drafts: {},
        bridge: secondBridge,
      };

      await expect(repo.importSourceBundle(localActor, secondProject)).rejects.toThrow(
        /source revision [0-9a-f-]+ already belongs to project project-v02/,
      );

      const counts = await context.pool.query<{
        projects: number;
        source_bundles: number;
        bridge_imports: number;
        source_revisions: number;
      }>(`
        select
          (select count(*)::int from itotori_projects) as projects,
          (select count(*)::int from itotori_source_bundles) as source_bundles,
          (select count(*)::int from itotori_bridge_imports) as bridge_imports,
          (select count(*)::int from itotori_source_revisions) as source_revisions
      `);
      expect(counts.rows[0]).toEqual({
        projects: 1,
        source_bundles: 1,
        bridge_imports: 1,
        source_revisions: firstImport.sourceRevisionCount,
      });
    } finally {
      await context.close();
    }
  });
  it("rejects bridge unit ids reused by another project with a semantic ownership diagnostic", async () => {
    // A bridge-unit id that already belongs to another project's source bundle
    // is rejected with a semantic ownership diagnostic. The second bridge uses
    // a fresh bridge id, fresh asset id (via patchRef), and bridge-id-prefixed
    // revisions, so only the bridgeUnitId is reused — isolating the bridge-unit
    // guard (the last ownership check).
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);
      const firstProject = projectFixture();
      const firstUnit = firstProject.bridge.units[0]!;
      await repo.importSourceBundle(localActor, firstProject);

      const secondProject = projectFixture({
        projectId: "project-cross-unit",
        localeBranchId: "locale-cross-unit",
        bridge: {
          ...firstProject.bridge,
          bridgeId: "bridge-cross-unit",
          sourceBundleHash: "hash-cross-unit",
          units: [
            {
              ...firstUnit,
              patchRef: {
                ...firstUnit.patchRef,
                assetId: "source-cross-unit.json",
              },
            },
          ],
        },
      });

      await expect(repo.importSourceBundle(localActor, secondProject)).rejects.toThrow(
        /bridge unit bridge-unit-test already belongs to project project-test source bundle bridge-test/,
      );

      const counts = await context.pool.query<{
        projects: number;
        source_bundles: number;
        bridge_imports: number;
        source_units: number;
      }>(`
        select
          (select count(*)::int from itotori_projects) as projects,
          (select count(*)::int from itotori_source_bundles) as source_bundles,
          (select count(*)::int from itotori_bridge_imports) as bridge_imports,
          (select count(*)::int from itotori_source_units) as source_units
      `);
      expect(counts.rows[0]).toEqual({
        projects: 1,
        source_bundles: 1,
        bridge_imports: 1,
        source_units: 1,
      });
    } finally {
      await context.close();
    }
  });
  it("imports more source-unit keys than one Postgres statement can bind", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);
      const project = projectFixture();
      const prototype = project.bridge.units[0]!;
      const unitCount = 65_536;
      const units = Array.from({ length: unitCount }, (_, index) => {
        const suffix = String(index).padStart(5, "0");
        const sourceUnitKey = `large-import.scene.001.line.${suffix}`;
        return {
          ...prototype,
          bridgeUnitId: `large-import-unit-${suffix}`,
          sourceUnitKey,
          occurrenceId: `large-import-occurrence-${suffix}`,
          sourceHash: `large-import-source-hash-${suffix}`,
          patchRef: { ...prototype.patchRef, sourceUnitKey },
        };
      });

      const imported = await repo.importSourceBundle(
        localActor,
        projectFixture({
          bridge: {
            ...project.bridge,
            bridgeId: "large-import-bridge",
            sourceBundleHash: "large-import-hash",
            units,
          },
        }),
      );

      expect(imported.unitCount).toBe(unitCount);
      expect(imported.units).toMatchObject({ added: unitCount, updated: 0, removed: 0 });
    } finally {
      await context.close();
    }
  }, 180_000);
  it("rejects a reimport that reuses a source revision id with different content", async () => {
    // A same-project reimport may NOT reuse a source-revision id with different
    // content. The revision already belongs to this project (so the
    // cross-project ownership guard does not fire), but diffSourceRevisions
    // rejects the content drift with a semantic diagnostic before any mutation.
    // The sourceBundleHash + sourceBundleRevision.value move together (schema
    // validation requires the content-hash revision to match the bundle hash).
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);
      const bridge = bridgeV02Fixture();
      const firstImport = await repo.importSourceBundle(localActor, projectV02Fixture(bridge));

      const reimportedBridge: BridgeBundleV02 = {
        ...bridge,
        sourceBundleHash: v02Sha256("reimport-different-content"),
        sourceBundleRevision: {
          ...bridge.sourceBundleRevision,
          value: v02Sha256("reimport-different-content"),
        },
      };

      await expect(
        repo.importSourceBundle(localActor, projectV02Fixture(reimportedBridge)),
      ).rejects.toThrow(
        new RegExp(
          `source revision ${escapeRegExp(firstImport.sourceBundleRevisionId)} already exists with different content`,
        ),
      );

      const counts = await context.pool.query<{
        bridge_imports: number;
        source_revisions: number;
      }>(`
        select
          (select count(*)::int from itotori_bridge_imports) as bridge_imports,
          (select count(*)::int from itotori_source_revisions) as source_revisions
      `);
      expect(counts.rows[0]).toEqual({
        bridge_imports: 1,
        source_revisions: firstImport.sourceRevisionCount,
      });
    } finally {
      await context.close();
    }
  });
});
