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
  it("tombstones units/assets omitted by a reimport and retains their history, then revives on re-add", async () => {
    // A bridge reimport that OMITS a previously-present source unit (and its
    // asset) must NOT hard-delete the rows — that would CASCADE away
    // locale-branch unit rows + runtime evidence refs + historical facts. The
    // rows are tombstoned (removed_at set) instead; dependents are retained;
    // re-adding the unit/asset revives it (removed_at back to NULL).
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);
      const bridge = bridgeV02Fixture();
      const omittedUnitId = "019ed001-0000-7000-8000-000000000210";
      const omittedAssetId = "019ed001-0000-7000-8000-000000000007";

      const firstImport = await repo.importSourceBundle(localActor, projectV02Fixture(bridge));
      expect(firstImport.units.removed).toBe(0);

      // Resolve the persisted bundle + revision to hang runtime evidence off of.
      const bundleRow = await context.pool.query<{
        source_bundle_id: string;
        source_bundle_revision_id: string;
      }>(
        "select source_bundle_id, source_bundle_revision_id from itotori_source_bundles where project_id = $1",
        ["project-v02"],
      );
      const sourceBundleId = bundleRow.rows[0]!.source_bundle_id;
      const sourceBundleRevisionId = bundleRow.rows[0]!.source_bundle_revision_id;

      // Import auto-creates one locale-branch unit row per unit: confirm the
      // omitted unit has locale-branch history (a translation row) before the
      // reimport.
      const branchUnitBefore = await context.pool.query<{ count: number }>(
        "select count(*)::int from itotori_locale_branch_units where bridge_unit_id = $1",
        [omittedUnitId],
      );
      expect(branchUnitBefore.rows[0]!.count).toBe(1);

      // Build a runtime evidence ref (CASCADE dependent) + an artifact back-
      // pointer (SET NULL dependent) pinned to the omitted unit. Under the old
      // hard-delete these would be destroyed / severed by the reimport.
      await context.pool.query(
        "insert into itotori_artifacts (artifact_id, project_id, bridge_unit_id, artifact_kind, metadata) values ($1,$2,$3,$4,$5)",
        ["i060-report-artifact", "project-v02", omittedUnitId, "runtime_report", "{}"],
      );
      await context.pool.query(
        `insert into itotori_runtime_evidence_runs
           (runtime_run_id, project_id, locale_branch_id, source_bundle_id, source_bundle_revision_id,
            runtime_report_artifact_id, adapter_name, status, fidelity_tier, report_created_at, metadata)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), $10)`,
        [
          "i060-run",
          "project-v02",
          "locale-v02-fr-fr",
          sourceBundleId,
          sourceBundleRevisionId,
          "i060-report-artifact",
          "utsushi-fixture",
          "passed",
          "layout_probe",
          "{}",
        ],
      );
      await context.pool.query(
        `insert into itotori_runtime_evidence_items
           (runtime_evidence_id, runtime_run_id, project_id, locale_branch_id, source_bundle_id,
            source_bundle_revision_id, bridge_unit_id, evidence_kind, metadata)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          "i060-evidence",
          "i060-run",
          "project-v02",
          "locale-v02-fr-fr",
          sourceBundleId,
          sourceBundleRevisionId,
          omittedUnitId,
          "trace_event",
          "{}",
        ],
      );
      await context.pool.query(
        `insert into itotori_runtime_evidence_bridge_unit_refs
           (runtime_evidence_id, bridge_unit_id, ref_role, source_unit_key, metadata)
         values ($1,$2,$3,$4,$5)`,
        ["i060-evidence", omittedUnitId, "primary", "metadata/package#title", "{}"],
      );

      // Reimport a bundle that OMITS the unit and its asset.
      const reimportBridge: BridgeBundleV02 = {
        ...bridge,
        sourceBundleRevision: {
          ...bridge.sourceBundleRevision,
          revisionId: "019ed001-0000-7000-8000-000000000113",
        },
        units: bridge.units.filter((unit) => unit.bridgeUnitId !== omittedUnitId),
        assets: bridge.assets.filter((asset) => asset.assetId !== omittedAssetId),
      };
      const omittingImport = await repo.importSourceBundle(
        localActor,
        projectV02Fixture(reimportBridge),
      );
      expect(omittingImport.units.removed).toBe(1);
      expect(omittingImport.assets.removed).toBe(1);

      // The unit + asset rows are RETAINED (not deleted) and TOMBSTONED.
      const unitRow = await context.pool.query<{ removed_at: string | null }>(
        "select removed_at from itotori_source_units where bridge_unit_id = $1",
        [omittedUnitId],
      );
      expect(unitRow.rows).toHaveLength(1);
      expect(unitRow.rows[0]!.removed_at).not.toBeNull();

      const assetRow = await context.pool.query<{ removed_at: string | null }>(
        "select removed_at from itotori_assets where asset_id = $1",
        [omittedAssetId],
      );
      expect(assetRow.rows).toHaveLength(1);
      expect(assetRow.rows[0]!.removed_at).not.toBeNull();

      // Every dependent is retained: locale-branch unit row, runtime evidence
      // ref (CASCADE dependent), and the artifact back-pointer (SET NULL dep).
      const branchUnitAfter = await context.pool.query<{ count: number }>(
        "select count(*)::int from itotori_locale_branch_units where bridge_unit_id = $1",
        [omittedUnitId],
      );
      expect(branchUnitAfter.rows[0]!.count).toBe(1);

      const evidenceRefAfter = await context.pool.query<{ count: number }>(
        "select count(*)::int from itotori_runtime_evidence_bridge_unit_refs where bridge_unit_id = $1",
        [omittedUnitId],
      );
      expect(evidenceRefAfter.rows[0]!.count).toBe(1);

      const artifactAfter = await context.pool.query<{ bridge_unit_id: string | null }>(
        "select bridge_unit_id from itotori_artifacts where artifact_id = $1",
        ["i060-report-artifact"],
      );
      expect(artifactAfter.rows[0]!.bridge_unit_id).toBe(omittedUnitId);

      // The reimport reflects the new ACTIVE set: tombstoned rows are excluded.
      const activeUnits = await context.pool.query<{ count: number }>(
        "select count(*)::int from itotori_source_units where source_bundle_id = $1 and removed_at is null",
        [sourceBundleId],
      );
      expect(activeUnits.rows[0]!.count).toBe(bridge.units.length - 1);
      const totalUnits = await context.pool.query<{ count: number }>(
        "select count(*)::int from itotori_source_units where source_bundle_id = $1",
        [sourceBundleId],
      );
      expect(totalUnits.rows[0]!.count).toBe(bridge.units.length);

      // Re-adding the unit/asset in a later reimport REVIVES it (removed_at back
      // to NULL) rather than duplicating the row.
      const revivingBridge: BridgeBundleV02 = {
        ...bridge,
        sourceBundleRevision: {
          ...bridge.sourceBundleRevision,
          revisionId: "019ed001-0000-7000-8000-000000000114",
        },
      };
      const revivingImport = await repo.importSourceBundle(
        localActor,
        projectV02Fixture(revivingBridge),
      );
      expect(revivingImport.units.removed).toBe(0);
      expect(revivingImport.assets.removed).toBe(0);

      const revivedUnit = await context.pool.query<{ removed_at: string | null; count: number }>(
        "select count(*)::int as count, max(removed_at) as removed_at from itotori_source_units where bridge_unit_id = $1",
        [omittedUnitId],
      );
      expect(revivedUnit.rows[0]!.count).toBe(1);
      expect(revivedUnit.rows[0]!.removed_at).toBeNull();

      const revivedAsset = await context.pool.query<{ removed_at: string | null; count: number }>(
        "select count(*)::int as count, max(removed_at) as removed_at from itotori_assets where asset_id = $1",
        [omittedAssetId],
      );
      expect(revivedAsset.rows[0]!.count).toBe(1);
      expect(revivedAsset.rows[0]!.removed_at).toBeNull();

      // History survived the whole cycle: the runtime evidence ref is still
      // attached to the (now revived) unit.
      const evidenceRefFinal = await context.pool.query<{ count: number }>(
        "select count(*)::int from itotori_runtime_evidence_bridge_unit_refs where bridge_unit_id = $1",
        [omittedUnitId],
      );
      expect(evidenceRefFinal.rows[0]!.count).toBe(1);
    } finally {
      await context.close();
    }
  });
  it("persists v0.2 patch exports with reordered explicit target span mappings", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);
      const bridge = bridgeV02Fixture();
      const unit = bridge.units[0]!;
      unit.sourceText = "{item} for {player}";
      unit.spans = [
        {
          spanId: "019ed001-0000-7000-8000-000000000831",
          spanKind: "variable_placeholder",
          raw: "{item}",
          startByte: 0,
          endByte: 6,
          preserveMode: "map",
          variableName: "item",
        },
        {
          spanId: "019ed001-0000-7000-8000-000000000832",
          spanKind: "variable_placeholder",
          raw: "{player}",
          startByte: 11,
          endByte: 19,
          preserveMode: "map",
          variableName: "player",
        },
      ];
      const project = projectV02Fixture(bridge);
      await repo.importSourceBundle(localActor, project);
      const patchExport = patchExportV02Fixture(bridge);
      patchExport.entries[0]!.targetText = "{player} gets {item}";
      patchExport.entries[0]!.protectedSpanMappings = [
        {
          raw: "{player}",
          sourceSpanId: "019ed001-0000-7000-8000-000000000832",
          sourceStartByte: 11,
          sourceEndByte: 19,
          targetStart: 0,
          targetEnd: 8,
        },
        {
          raw: "{item}",
          sourceSpanId: "019ed001-0000-7000-8000-000000000831",
          sourceStartByte: 0,
          sourceEndByte: 6,
          targetStart: 14,
          targetEnd: 20,
        },
      ];

      await expect(repo.savePatchExport(localActor, project, patchExport)).resolves.toBeUndefined();

      const artifactsResult = await context.pool.query<{ artifact_id: string }>(
        "select artifact_id from itotori_artifacts where artifact_id = $1",
        [patchExport.patchExportId],
      );
      expect(artifactsResult.rows).toEqual([{ artifact_id: patchExport.patchExportId }]);
    } finally {
      await context.close();
    }
  });
  it("rejects v0.2 patch exports with collapsed duplicate target span mappings", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);
      const bridge = bridgeV02Fixture();
      const unit = bridge.units[0]!;
      unit.sourceText = "{name} meets {name}";
      unit.spans = [
        {
          spanId: "019ed001-0000-7000-8000-000000000841",
          spanKind: "variable_placeholder",
          raw: "{name}",
          startByte: 0,
          endByte: 6,
          preserveMode: "map",
          variableName: "name",
        },
        {
          spanId: "019ed001-0000-7000-8000-000000000842",
          spanKind: "variable_placeholder",
          raw: "{name}",
          startByte: 13,
          endByte: 19,
          preserveMode: "map",
          variableName: "name",
        },
      ];
      const project = projectV02Fixture(bridge);
      await repo.importSourceBundle(localActor, project);
      const patchExport = patchExportV02Fixture(bridge);
      patchExport.entries[0]!.targetText = "{name} and {name}";
      // Collapsed duplicates: both mappings resolve to the SAME source span
      // (bytes 0..6) via explicit byte-range identity. This stays schema-valid
      // (the strict identity check only rejects duplicate `sourceSpanId`,
      // which is absent here), so it reaches the compatibility evaluator,
      // which flags the collapse as protected_span_mapping_mismatch.
      patchExport.entries[0]!.protectedSpanMappings = [
        {
          raw: "{name}",
          sourceStartByte: 0,
          sourceEndByte: 6,
          targetStart: 0,
          targetEnd: 6,
        },
        {
          raw: "{name}",
          sourceStartByte: 0,
          sourceEndByte: 6,
          targetStart: 11,
          targetEnd: 17,
        },
      ];

      await expect(repo.savePatchExport(localActor, project, patchExport)).rejects.toThrow(
        /protected_span_mapping_mismatch/,
      );
    } finally {
      await context.close();
    }
  });
  it("reads dashboard bundle fields and import status from the same latest import", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);
      const firstProject = projectFixture();
      const firstUnit = firstProject.bridge.units[0]!;
      const secondProject = projectFixture({
        bridge: {
          ...firstProject.bridge,
          bridgeId: "bridge-second",
          sourceBundleHash: "hash-second",
          units: [
            {
              ...firstUnit,
              bridgeUnitId: "bridge-unit-second",
              sourceUnitKey: "hello.scene.001.line.002",
              occurrenceId: "occurrence-2",
              sourceHash: "source-hash-second",
              patchRef: {
                ...firstUnit.patchRef,
                assetId: "source-second.json",
                sourceUnitKey: "hello.scene.001.line.002",
              },
            },
          ],
        },
      });

      await repo.importSourceBundle(localActor, firstProject);
      await repo.importSourceBundle(localActor, secondProject);
      await context.pool.query(
        `
        update itotori_source_bundles
        set imported_at = case source_bundle_id
          when $1 then $3::timestamptz
          when $2 then $4::timestamptz
        end
        where source_bundle_id in ($1, $2)
      `,
        ["bridge-test", "bridge-second", "2026-06-17T00:30:00.000Z", "2026-06-17T00:00:00.000Z"],
      );
      await context.pool.query(
        `
        update itotori_bridge_imports
        set imported_at = case source_bundle_id
          when $1 then $3::timestamptz
          when $2 then $4::timestamptz
        end
        where source_bundle_id in ($1, $2)
      `,
        ["bridge-test", "bridge-second", "2026-06-17T00:00:00.000Z", "2026-06-17T00:30:00.000Z"],
      );

      const status = await repo.getDashboardStatus();
      expect(status.sourceBundleId).toBe("bridge-second");
      expect(status.sourceBundleHash).toBe("hash-second");
      expect(status.importStatus).toMatchObject({
        bridgeId: "bridge-second",
        sourceBundleId: "bridge-second",
        sourceBundleHash: "hash-second",
        sourceBundleRevisionId: "bridge-second:bundle-revision",
      });
    } finally {
      await context.close();
    }
  });
});
