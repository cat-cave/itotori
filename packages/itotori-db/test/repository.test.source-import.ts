import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";

import { describe, expect, it } from "vitest";

import {
  FormatVersionMismatchError,
  assertBridgeBundleV02,
  type BridgeBundleV02,
} from "@itotori/localization-bridge-schema";

import {
  ItotoriProjectRepository,
  RuntimeRunNotFoundError,
} from "../src/repositories/project-repository.js";

import {
  bridgeV02Fixture,
  localActor,
  patchExportV02Fixture,
  projectFixture,
  projectFixtureBridgeId,
  projectFixtureBundleRevisionId,
  projectFixtureUnitId,
  projectV02Fixture,
  requiredFixtureValue,
  runtimeEvidenceReportFixture,
} from "./repository.test.shared.js";
import { migratedContext } from "./repository.test.legacy.js";

describe("ItotoriProjectRepository", () => {
  it("persists project, source bundle, units, artifacts, and branch status", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);
      const project = projectFixture();
      assertBridgeBundleV02(project.bridge);
      const unit = requiredFixtureValue(project.bridge.units[0], "project bridge unit");

      await repo.importSourceBundle(localActor, project);
      await repo.saveDrafts(localActor, project);
      await repo.savePatchExport(
        localActor,
        project,
        patchExportV02Fixture(project.bridge, {
          targetLocale: project.targetLocale,
          targetText: requiredFixtureValue(
            project.drafts[unit.bridgeUnitId],
            "project target draft",
          ),
        }),
      );
      const status = await repo.saveRuntimeReport(
        localActor,
        project,
        runtimeEvidenceReportFixture({ createdAt: new Date().toISOString() }),
        "patch-result-test",
      );

      expect(status.status).toBe("runtime_ingested");
      expect(status.sourceBundleId).toBe(projectFixtureBridgeId);
      expect(status.sourceBundleRevisionId).toBe(projectFixtureBundleRevisionId);
      expect(status.unitCount).toBe(1);
      expect(status.branchCount).toBe(1);
      expect(status.localeBranches[0]?.translatedUnitCount).toBe(1);
      expect(status.artifactCount).toBe(4);
      expect(status.latestEventKind).toBe("patch_result_recorded");
      expect(status.importStatus).toMatchObject({
        projectId: "project-test",
        bridgeId: projectFixtureBridgeId,
        sourceBundleId: projectFixtureBridgeId,
        sourceBundleRevisionId: projectFixtureBundleRevisionId,
        unitCount: 1,
        assetCount: 1,
        sourceRevisionCount: 4,
        validationFailureCount: 0,
        units: { added: 1, updated: 0, removed: 0, unchanged: 0 },
        assets: { added: 1, updated: 0, removed: 0, unchanged: 0 },
        sourceRevisions: { added: 4, existing: 0 },
        futureReferences: {
          catalogWorkId: null,
          localCorpusEntryId: null,
          readinessProfileId: null,
          completenessStatusId: null,
        },
      });
      expect(status.importStatus.importedAt).toContain("T");

      const runtimeStatus = await repo.getRuntimeStatus(localActor);
      expect(runtimeStatus).toEqual({
        finalStatus: "hello_world_passed",
        runtimeRunId: "019ed003-0000-7000-8000-000000000901",
        runtimeReportId: "019ed003-0000-7000-8000-000000000901",
        runtimeStatus: "passed",
        fidelityTier: "layout_probe",
        evidenceTier: "E2",
        textEventCount: 1,
        frameCaptureCount: 0,
        screenshotArtifactCount: 1,
        recordingArtifactCount: 0,
        validationFindingCount: 0,
        traceEvents: [
          {
            runtimeEventId:
              "019ed003-0000-7000-8000-000000000901:019ed003-0000-7000-8000-000000000911",
            eventKind: "text_observed",
            bridgeUnitId: projectFixtureUnitId,
            sourceUnitKey: unit.sourceUnitKey,
            draftId: `locale-en-us:${projectFixtureUnitId}`,
            runtimeTargetId: "hello.line.001",
            evidenceTier: null,
            frame: 1,
            textPreview: "Hello, {player}.",
            artifactIds: [],
          },
        ],
        findings: [],
        artifacts: [
          {
            artifactId: "019ed003-0000-7000-8000-000000000901:019ed003-0000-7000-8000-000000000931",
            artifactKind: "screenshot",
            uri: "artifacts/utsushi/runtime/019ed003-0000-7000-8000-000000000901/screenshots/019ed003-0000-7000-8000-000000000931.png",
            hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
            hashProvenance: "repository_fallback",
            mediaType: "image/png",
            byteSize: null,
            bridgeUnitId: projectFixtureUnitId,
            sourceUnitKey: unit.sourceUnitKey,
            diagnostic: null,
          },
        ],
        approximations: [
          {
            approximationId: "019ed003-0000-7000-8000-000000000941",
            approximationTier: "deterministic_fixture",
            scope: "fixture runtime",
            description: "Fixture evidence validates runtime plumbing, not engine fidelity.",
            evidenceTierCeiling: "E2",
            bridgeUnitIds: [projectFixtureUnitId],
          },
        ],
        unsupportedCapabilities: [
          {
            feature: "jump",
            status: "unsupported",
            fidelityTierCeiling: null,
            evidenceTierCeiling: null,
            limitations: [],
          },
          {
            feature: "snapshot",
            status: "unsupported",
            fidelityTierCeiling: null,
            evidenceTierCeiling: null,
            limitations: [],
          },
          {
            feature: "screenshot",
            status: "unsupported",
            fidelityTierCeiling: null,
            evidenceTierCeiling: null,
            limitations: [],
          },
          {
            feature: "recording",
            status: "unsupported",
            fidelityTierCeiling: null,
            evidenceTierCeiling: null,
            limitations: [],
          },
        ],
        limitations: ["No reference-runtime pixel comparison is performed."],
      });

      await expect(repo.getRuntimeStatus(localActor, "runtime-run-stale")).rejects.toEqual(
        new RuntimeRunNotFoundError("runtime-run-stale"),
      );
    } finally {
      await context.close();
    }
  });
  it("rejects invalid bridge bundles before project import writes", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);
      const project = projectFixture();
      assertBridgeBundleV02(project.bridge);
      const unit = requiredFixtureValue(project.bridge.units[0], "project bridge unit");
      const span = requiredFixtureValue(unit.spans[0], "project bridge span");
      const invalidProject = projectFixture({
        bridge: {
          ...project.bridge,
          units: [
            {
              ...unit,
              spans: [
                {
                  ...span,
                  raw: "{missing}",
                },
              ],
            },
          ],
        },
      });

      await expect(repo.importSourceBundle(localActor, invalidProject)).rejects.toThrow(
        /byte range/,
      );

      const counts = await context.pool.query<{
        projects: number;
        source_revisions: number;
        bridge_imports: number;
      }>(`
        select
          (select count(*)::int from itotori_projects) as projects,
          (select count(*)::int from itotori_source_revisions) as source_revisions,
          (select count(*)::int from itotori_bridge_imports) as bridge_imports
      `);
      expect(counts.rows[0]).toEqual({
        projects: 0,
        source_revisions: 0,
        bridge_imports: 0,
      });
    } finally {
      await context.close();
    }
  });
  it("rejects duplicate v0.2 bridge unit ids before project import writes", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);
      const bridge = bridgeV02Fixture();
      const firstUnit = requiredFixtureValue(bridge.units[0], "first bridge unit");
      const duplicateBridge: BridgeBundleV02 = {
        ...bridge,
        units: bridge.units.map((unit, index) =>
          index === 1 ? { ...unit, bridgeUnitId: firstUnit.bridgeUnitId } : unit,
        ),
      };

      await expect(
        repo.importSourceBundle(localActor, projectV02Fixture(duplicateBridge)),
      ).rejects.toThrow(/bridgeUnitId must be unique/);

      const counts = await context.pool.query<{
        projects: number;
        source_bundles: number;
        source_units: number;
        bridge_imports: number;
      }>(`
        select
          (select count(*)::int from itotori_projects) as projects,
          (select count(*)::int from itotori_source_bundles) as source_bundles,
          (select count(*)::int from itotori_source_units) as source_units,
          (select count(*)::int from itotori_bridge_imports) as bridge_imports
      `);
      expect(counts.rows[0]).toEqual({
        projects: 0,
        source_bundles: 0,
        source_units: 0,
        bridge_imports: 0,
      });
    } finally {
      await context.close();
    }
  });
  it("rejects conflicting duplicate source revision ids before project import writes", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);
      const bridge = bridgeV02Fixture();
      const conflictingBridge: BridgeBundleV02 = {
        ...bridge,
        sourceGame: {
          ...bridge.sourceGame,
          sourceProfileRevision: {
            revisionId: bridge.sourceBundleRevision.revisionId,
            revisionKind: "manual_snapshot",
            value: "profile snapshot that does not match the source bundle revision",
          },
        },
      };

      await expect(
        repo.importSourceBundle(localActor, projectV02Fixture(conflictingBridge)),
      ).rejects.toThrow(/source revision .* appears multiple times with different content/);

      const counts = await context.pool.query<{
        projects: number;
        source_revisions: number;
        source_bundles: number;
        bridge_imports: number;
      }>(`
        select
          (select count(*)::int from itotori_projects) as projects,
          (select count(*)::int from itotori_source_revisions) as source_revisions,
          (select count(*)::int from itotori_source_bundles) as source_bundles,
          (select count(*)::int from itotori_bridge_imports) as bridge_imports
      `);
      expect(counts.rows[0]).toEqual({
        projects: 0,
        source_revisions: 0,
        source_bundles: 0,
        bridge_imports: 0,
      });
    } finally {
      await context.close();
    }
  });
  it("records source revision diffs on v0.2 reimport without duplicating revisions", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);
      const bridge = bridgeV02Fixture();
      const project = projectV02Fixture(bridge);

      const firstImport = await repo.importSourceBundle(localActor, project);
      const reimportedBridge: BridgeBundleV02 = {
        ...bridge,
        sourceBundleRevision: {
          ...bridge.sourceBundleRevision,
          revisionId: "019ed001-0000-7000-8000-000000000113",
        },
      };
      const secondImport = await repo.importSourceBundle(
        localActor,
        projectV02Fixture(reimportedBridge),
      );

      expect(firstImport.sourceRevisions).toEqual({
        added: firstImport.sourceRevisionCount,
        existing: 0,
      });
      expect(secondImport.sourceRevisions).toEqual({
        added: 1,
        existing: firstImport.sourceRevisionCount - 1,
      });
      expect(secondImport.units).toMatchObject({
        added: 0,
        updated: 0,
        removed: 0,
        unchanged: bridge.units.length,
      });
      expect(secondImport.assets).toMatchObject({
        added: 0,
        updated: 0,
        removed: 0,
        unchanged: bridge.assets.length,
      });

      const imports = await context.pool.query<{
        source_bundle_revision_id: string;
        added_source_revision_count: number;
        existing_source_revision_count: number;
      }>(
        `
        select
          source_bundle_revision_id,
          added_source_revision_count,
          existing_source_revision_count
        from itotori_bridge_imports
        where project_id = $1
        order by source_bundle_revision_id
      `,
        ["project-v02"],
      );
      expect(imports.rows).toEqual([
        {
          source_bundle_revision_id: "019ed001-0000-7000-8000-000000000112",
          added_source_revision_count: firstImport.sourceRevisionCount,
          existing_source_revision_count: 0,
        },
        {
          source_bundle_revision_id: "019ed001-0000-7000-8000-000000000113",
          added_source_revision_count: 1,
          existing_source_revision_count: firstImport.sourceRevisionCount - 1,
        },
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
  it("rejects v0.1 bridge imports with the typed migration requirement and no writes", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);
      const legacyProject = projectFixture({
        bridge: {
          schemaVersion: "0.1.0",
          bridgeId: "legacy-bridge-test",
          sourceBundleHash: "legacy-hash-test",
          sourceLocale: "ja-JP",
          extractorName: "legacy-fixture",
          extractorVersion: "0.1.0",
          units: [],
        },
      });

      const rejection = repo.importSourceBundle(localActor, legacyProject);
      await expect(rejection).rejects.toBeInstanceOf(FormatVersionMismatchError);
      await expect(rejection).rejects.toThrow(/Migration path:/u);

      const counts = await context.pool.query<{
        projects: number;
        source_revisions: number;
        bridge_imports: number;
      }>(`
        select
          (select count(*)::int from itotori_projects) as projects,
          (select count(*)::int from itotori_source_revisions) as source_revisions,
          (select count(*)::int from itotori_bridge_imports) as bridge_imports
      `);
      expect(counts.rows[0]).toEqual({
        projects: 0,
        source_revisions: 0,
        bridge_imports: 0,
      });
    } finally {
      await context.close();
    }
  });
});
