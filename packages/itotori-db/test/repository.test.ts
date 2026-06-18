import { readFileSync } from "node:fs";
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
  type ItotoriProjectRecord,
} from "../src/repositories/project-repository.js";
import {
  feedbackContextStatusValues,
  feedbackReportStatusValues,
  feedbackTriageLabelValues,
  feedbackTypeValues,
  ItotoriFeedbackRepository,
  type ManualFeedbackImportInput,
} from "../src/repositories/feedback-repository.js";
import {
  artifacts,
  events,
  feedbackReportEvidence,
  feedbackReports,
  feedbackSources,
  userPermissionGrants,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

function projectFixture(overrides: Partial<ItotoriProjectRecord> = {}): ItotoriProjectRecord {
  const project: ItotoriProjectRecord = {
    projectId: "project-test",
    localeBranchId: "locale-en-us",
    targetLocale: "en-US",
    drafts: { "bridge-unit-test": "Hello, {player}." },
    bridge: {
      schemaVersion: "0.1.0",
      bridgeId: "bridge-test",
      sourceBundleHash: "hash-test",
      sourceLocale: "ja-JP",
      extractorName: "kaifuu-fixture",
      extractorVersion: "0.0.0",
      units: [
        {
          bridgeUnitId: "bridge-unit-test",
          sourceUnitKey: "hello.scene.001.line.001",
          occurrenceId: "occurrence-1",
          sourceHash: "source-hash",
          sourceLocale: "ja-JP",
          sourceText: "こんにちは、{player}。",
          textSurface: "dialogue",
          protectedSpans: [
            { kind: "placeholder", raw: "{player}", start: 18, end: 26, preserveMode: "exact" },
          ],
          patchRef: {
            assetId: "source.json",
            writeMode: "replace",
            sourceUnitKey: "hello.scene.001.line.001",
          },
        },
      ],
    },
  };
  return { ...project, ...overrides };
}

function projectV02Fixture(bridge: BridgeBundleV02): ItotoriProjectRecord {
  return {
    projectId: "project-v02",
    localeBranchId: "locale-v02-fr-fr",
    targetLocale: "fr-FR",
    drafts: {},
    bridge,
  };
}

function bridgeV02Fixture(): BridgeBundleV02 {
  return JSON.parse(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "localization-bridge-schema",
        "test",
        "examples",
        "bridge-v0.2.json",
      ),
      "utf8",
    ),
  ) as BridgeBundleV02;
}

function manualFeedbackFixture(
  overrides: Partial<ManualFeedbackImportInput> = {},
): ManualFeedbackImportInput {
  return {
    projectId: "project-test",
    localeBranchId: "locale-en-us",
    sourceBundleId: "bridge-test",
    targetLocale: "en-US",
    feedbackSource: {
      sourceKind: "manual_playtest",
      label: "Manual playtest fixture",
      sourceChannel: "fixture",
      privacyReviewState: "reviewed",
    },
    feedbackType: feedbackTypeValues.stylePreference,
    reporter: { role: "playtester", displayName: "Fixture reviewer" },
    reporterNote: "The protagonist sounds too formal in this line.",
    lineReference: {
      bridgeUnitId: "bridge-unit-test",
      sourceUnitKey: "hello.scene.001.line.001",
      path: "source.json",
      line: 1,
    },
    attachments: [
      {
        attachmentKind: "screenshot",
        artifactId: "feedback-screenshot-1",
        uri: "fixture://feedback/screenshot/formal-tone",
        hash: "sha256:feedback-screenshot-1",
        caption: "message window with formal protagonist line",
        capturePosition: "hello.scene.001:frame001",
        evidenceTier: "E2",
      },
      {
        attachmentKind: "save_context",
        contextToken: "fixture-save-before-line",
        routeRef: "hello-route",
        sceneRef: "hello.scene.001",
      },
    ],
    privacyClassification: "internal",
    redactionState: "reviewed",
    reportedAt: "2026-06-17T00:00:00.000Z",
    ...overrides,
  };
}

function runtimeEvidenceReportFixture(
  overrides: Partial<RuntimeEvidenceReportV02> = {},
): RuntimeEvidenceReportV02 {
  return {
    schemaVersion: "0.2.0",
    runtimeReportId: "019ed003-0000-7000-8000-000000000901",
    adapterName: "utsushi-fixture",
    adapterVersion: "0.0.0",
    fidelityTier: "layout_probe",
    evidenceTier: "E2",
    runtimeCapabilities: {
      contractVersion: "0.2.0",
      capabilityClass: "launch_capture",
      fidelityTierCeiling: "layout_probe",
      evidenceTierCeiling: "E2",
      features: [
        {
          feature: "static_trace",
          status: "supported",
          evidenceTierCeiling: "E1",
          description: "Fixture static trace.",
          limitations: [],
        },
        {
          feature: "text_trace",
          status: "supported",
          evidenceTierCeiling: "E1",
          description: "Fixture text trace.",
          limitations: [],
        },
        {
          feature: "frame_capture",
          status: "partial",
          evidenceTierCeiling: "E2",
          description: "Fixture capture metadata.",
          limitations: ["No live engine screenshot API."],
        },
        {
          feature: "jump",
          status: "unsupported",
          description: "Jump is not required by the base contract.",
          limitations: [],
        },
        {
          feature: "snapshot",
          status: "unsupported",
          description: "Snapshot is not required by the base contract.",
          limitations: [],
        },
        {
          feature: "screenshot",
          status: "unsupported",
          description: "Screenshot API is not required by the base contract.",
          limitations: [],
        },
        {
          feature: "recording",
          status: "unsupported",
          description: "Recording is not required by the base contract.",
          limitations: [],
        },
      ],
      limitations: ["Fixture launch/capture boundary."],
    },
    controlledPlaybackSession: {
      sessionId: "019ed003-0000-7000-8000-000000000906",
      adapterName: "utsushi-fixture",
      adapterVersion: "0.0.0",
      capabilityClass: "launch_capture",
      requestedOperation: "capture",
      status: "passed",
      fidelityTier: "layout_probe",
      evidenceTier: "E2",
      featuresUsed: ["static_trace", "text_trace", "frame_capture"],
      limitations: ["No jump, snapshot, screenshot API, or recording API."],
    },
    status: "passed",
    createdAt: "2026-06-17T00:00:00.000Z",
    traceEvents: [
      {
        traceEventId: "019ed003-0000-7000-8000-000000000911",
        eventKind: "text_observed",
        bridgeUnitRef: {
          bridgeUnitId: "bridge-unit-test",
          sourceUnitKey: "hello.scene.001.line.001",
        },
        frame: 1,
        traceKey: "hello.line.001",
        observedText: "Hello, {player}.",
      },
    ],
    branchEvents: [],
    captures: [
      {
        captureId: "019ed003-0000-7000-8000-000000000921",
        bridgeUnitRef: {
          bridgeUnitId: "bridge-unit-test",
          sourceUnitKey: "hello.scene.001.line.001",
        },
        evidenceTier: "E2",
        frame: 1,
        width: 320,
        height: 180,
        nonZeroPixels: 57600,
        artifactRef: {
          artifactId: "019ed003-0000-7000-8000-000000000931",
          artifactKind: "screenshot",
          uri: "artifacts/utsushi/runtime/019ed003-0000-7000-8000-000000000901/screenshots/019ed003-0000-7000-8000-000000000931.png",
          mediaType: "image/png",
        },
      },
    ],
    recordings: [],
    approximations: [
      {
        approximationId: "019ed003-0000-7000-8000-000000000941",
        approximationTier: "deterministic_fixture",
        scope: "fixture runtime",
        description: "Fixture evidence validates runtime plumbing, not engine fidelity.",
        affectedBridgeUnitRefs: [
          {
            bridgeUnitId: "bridge-unit-test",
            sourceUnitKey: "hello.scene.001.line.001",
          },
        ],
        evidenceTierCeiling: "E2",
      },
    ],
    validationFindings: [],
    limitations: ["No reference-runtime pixel comparison is performed."],
    ...overrides,
  };
}

describe("ItotoriProjectRepository", () => {
  it("persists project, source bundle, units, artifacts, and branch status", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db);
      await repo.reset(localActor);
      const project = projectFixture();

      await repo.importSourceBundle(localActor, project);
      await repo.saveDrafts(localActor, project);
      await repo.savePatchExport(localActor, project, {
        schemaVersion: "0.1.0",
        patchExportId: "patch-test",
        sourceBridgeId: "bridge-test",
        sourceBundleHash: "hash-test",
        sourceLocale: "ja-JP",
        targetLocale: "en-US",
        entries: [
          {
            entryId: "entry-test",
            bridgeUnitId: "bridge-unit-test",
            sourceUnitKey: "hello.scene.001.line.001",
            sourceHash: "source-hash",
            targetText: "Hello, {player}.",
            protectedSpanMappings: [{ raw: "{player}", targetStart: 7, targetEnd: 15 }],
          },
        ],
      });
      const status = await repo.saveRuntimeReport(
        localActor,
        project,
        {
          schemaVersion: "0.1.0",
          runtimeReportId: "runtime-test",
          adapterName: "utsushi-fixture",
          fidelityTier: "layout_probe",
          status: "passed",
          textEvents: [
            {
              runtimeTextEventId: "runtime-text-test",
              bridgeUnitId: "bridge-unit-test",
              text: "Hello, {player}.",
              frame: 1,
            },
          ],
          frameCaptures: [
            {
              frameCaptureId: "frame-test",
              bridgeUnitId: "bridge-unit-test",
              width: 320,
              height: 180,
              nonZeroPixels: 57600,
              artifactPath: "fixture://frame/1",
            },
          ],
          approximations: ["fixture"],
        },
        "patch-result-test",
      );

      expect(status.status).toBe("runtime_ingested");
      expect(status.sourceBundleId).toBe("bridge-test");
      expect(status.sourceBundleRevisionId).toBe("bridge-test:bundle-revision");
      expect(status.unitCount).toBe(1);
      expect(status.branchCount).toBe(1);
      expect(status.localeBranches[0]?.translatedUnitCount).toBe(1);
      expect(status.artifactCount).toBe(4);
      expect(status.latestEventKind).toBe("patch_result_recorded");
      expect(status.importStatus).toMatchObject({
        projectId: "project-test",
        bridgeId: "bridge-test",
        sourceBundleId: "bridge-test",
        sourceBundleRevisionId: "bridge-test:bundle-revision",
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

      const runtimeStatus = await repo.getRuntimeStatus();
      expect(runtimeStatus).toEqual({
        finalStatus: "hello_world_passed",
        runtimeRunId: "runtime-test",
        runtimeReportId: "runtime-test",
        runtimeStatus: "passed",
        fidelityTier: "layout_probe",
        evidenceTier: null,
        textEventCount: 1,
        frameCaptureCount: 1,
        screenshotArtifactCount: 1,
        recordingArtifactCount: 0,
        validationFindingCount: 0,
        traceEvents: [
          {
            runtimeEventId: "runtime-test:runtime-text-test",
            eventKind: "trace_event",
            bridgeUnitId: "bridge-unit-test",
            sourceUnitKey: "hello.scene.001.line.001",
            draftId: "locale-en-us:bridge-unit-test",
            runtimeTargetId: null,
            evidenceTier: null,
            frame: 1,
            textPreview: null,
            artifactIds: [],
          },
        ],
        findings: [],
        artifacts: [
          {
            artifactId: "runtime-test:frame-test",
            artifactKind: "frame_capture",
            uri: "fixture://frame/1",
            hash: null,
            mediaType: null,
            byteSize: null,
            bridgeUnitId: "bridge-unit-test",
            sourceUnitKey: "hello.scene.001.line.001",
            diagnostic:
              "blocked unmanaged artifact link: runtime artifact uri must be a portable relative artifact path: fixture://frame/1",
          },
        ],
        approximations: [],
        unsupportedCapabilities: [],
        limitations: [],
      });
    } finally {
      await context.close();
    }
  });

  it("rejects invalid bridge bundles before project import writes", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db);
      await repo.reset(localActor);
      const project = projectFixture();
      const unit = project.bridge.units[0]!;
      const invalidProject = projectFixture({
        bridge: {
          ...project.bridge,
          units: [
            {
              ...unit,
              protectedSpans: [
                {
                  ...unit.protectedSpans[0]!,
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
      const repo = new ItotoriProjectRepository(context.db);
      await repo.reset(localActor);
      const bridge = bridgeV02Fixture();
      const duplicateBridge: BridgeBundleV02 = {
        ...bridge,
        units: bridge.units.map((unit, index) =>
          index === 1 ? { ...unit, bridgeUnitId: bridge.units[0]!.bridgeUnitId } : unit,
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
      const repo = new ItotoriProjectRepository(context.db);
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
      const repo = new ItotoriProjectRepository(context.db);
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

  it("reads dashboard bundle fields and import status from the same latest import", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db);
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

  it("rejects reused bridge unit ids from another source bundle before mutation", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db);
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
      const repo = new ItotoriProjectRepository(context.db);
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

  it("reimports a migrated legacy bridge through its existing source bundle id", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db);
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

  it("persists v0.2 runtime evidence tiers and bridge-linked evidence artifacts", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db);
      await repo.reset(localActor);
      const project = projectFixture();
      await repo.importSourceBundle(localActor, project);

      await repo.saveRuntimeReport(
        localActor,
        project,
        {
          schemaVersion: "0.2.0",
          runtimeReportId: "019ed003-0000-7000-8000-000000000001",
          adapterName: "utsushi-fixture",
          adapterVersion: "0.0.0",
          fidelityTier: "layout_probe",
          evidenceTier: "E2",
          runtimeCapabilities: {
            contractVersion: "0.2.0",
            capabilityClass: "launch_capture",
            fidelityTierCeiling: "layout_probe",
            evidenceTierCeiling: "E2",
            features: [
              {
                feature: "static_trace",
                status: "supported",
                evidenceTierCeiling: "E1",
                description: "Fixture static trace.",
                limitations: [],
              },
              {
                feature: "text_trace",
                status: "supported",
                evidenceTierCeiling: "E1",
                description: "Fixture text trace.",
                limitations: [],
              },
              {
                feature: "branch_discovery",
                status: "partial",
                evidenceTierCeiling: "E1",
                description: "Fixture branch metadata.",
                limitations: ["Synthetic branch metadata only."],
              },
              {
                feature: "frame_capture",
                status: "partial",
                evidenceTierCeiling: "E2",
                description: "Fixture capture metadata.",
                limitations: ["No live engine screenshot API."],
              },
              {
                feature: "jump",
                status: "unsupported",
                description: "Jump is not required by the base contract.",
                limitations: [],
              },
              {
                feature: "snapshot",
                status: "unsupported",
                description: "Snapshot is not required by the base contract.",
                limitations: [],
              },
              {
                feature: "screenshot",
                status: "unsupported",
                description: "Screenshot API is not required by the base contract.",
                limitations: [],
              },
              {
                feature: "recording",
                status: "unsupported",
                description: "Recording is not required by the base contract.",
                limitations: [],
              },
            ],
            limitations: ["Fixture launch/capture boundary."],
          },
          controlledPlaybackSession: {
            sessionId: "019ed003-0000-7000-8000-000000000006",
            adapterName: "utsushi-fixture",
            adapterVersion: "0.0.0",
            capabilityClass: "launch_capture",
            requestedOperation: "capture",
            status: "passed",
            fidelityTier: "layout_probe",
            evidenceTier: "E2",
            featuresUsed: ["static_trace", "text_trace", "branch_discovery", "frame_capture"],
            limitations: ["No jump, snapshot, screenshot API, or recording API."],
          },
          status: "passed",
          createdAt: "2026-06-17T00:00:00.000Z",
          traceEvents: [
            {
              traceEventId: "019ed003-0000-7000-8000-000000000101",
              eventKind: "text_observed",
              bridgeUnitRef: {
                bridgeUnitId: "bridge-unit-test",
                sourceUnitKey: "hello.scene.001.line.001",
              },
              frame: 1,
              traceKey: "hello.line.001",
              observedText: "Hello, {player}.",
            },
          ],
          branchEvents: [
            {
              branchEventId: "019ed003-0000-7000-8000-000000000201",
              bridgeUnitRef: {
                bridgeUnitId: "bridge-unit-test",
                sourceUnitKey: "hello.scene.001.line.001",
              },
              frame: 2,
              branchPointKey: "hello.choice.001",
              promptText: "Choose a route",
              options: [
                {
                  optionId: "019ed003-0000-7000-8000-000000000211",
                  label: "Stay",
                  labelBridgeUnitRef: {
                    bridgeUnitId: "bridge-unit-test",
                    sourceUnitKey: "hello.scene.001.line.001",
                  },
                  targetRouteKey: "hello.stay",
                  targetBridgeUnitRef: {
                    bridgeUnitId: "bridge-unit-test",
                    sourceUnitKey: "hello.scene.001.line.001",
                  },
                },
              ],
              selectedOptionId: "019ed003-0000-7000-8000-000000000211",
            },
          ],
          captures: [
            {
              captureId: "019ed003-0000-7000-8000-000000000301",
              bridgeUnitRef: {
                bridgeUnitId: "bridge-unit-test",
                sourceUnitKey: "hello.scene.001.line.001",
              },
              evidenceTier: "E2",
              frame: 1,
              width: 320,
              height: 180,
              nonZeroPixels: 57600,
              artifactRef: {
                artifactId: "019ed003-0000-7000-8000-000000000401",
                artifactKind: "screenshot",
                uri: "artifacts/utsushi/runtime/019ed003-0000-7000-8000-000000000001/screenshots/019ed003-0000-7000-8000-000000000401.png",
                mediaType: "image/png",
              },
            },
          ],
          recordings: [],
          approximations: [
            {
              approximationId: "019ed003-0000-7000-8000-000000000701",
              approximationTier: "deterministic_fixture",
              scope: "fixture runtime",
              description: "Fixture evidence validates runtime plumbing, not engine fidelity.",
              affectedBridgeUnitRefs: [
                {
                  bridgeUnitId: "bridge-unit-test",
                  sourceUnitKey: "hello.scene.001.line.001",
                },
              ],
              evidenceTierCeiling: "E2",
            },
          ],
          validationFindings: [],
          limitations: ["No reference-runtime pixel comparison is performed."],
        },
        "patch-result-v02",
      );

      const runtimeStatus = await repo.getRuntimeStatus();
      expect(runtimeStatus).toMatchObject({
        runtimeRunId: "019ed003-0000-7000-8000-000000000001",
        runtimeReportId: "019ed003-0000-7000-8000-000000000001",
        runtimeStatus: "passed",
        fidelityTier: "layout_probe",
        evidenceTier: "E2",
        textEventCount: 1,
        frameCaptureCount: 1,
        screenshotArtifactCount: 1,
        recordingArtifactCount: 0,
        validationFindingCount: 0,
        traceEvents: [
          {
            runtimeEventId:
              "019ed003-0000-7000-8000-000000000001:019ed003-0000-7000-8000-000000000101",
            eventKind: "text_observed",
            bridgeUnitId: "bridge-unit-test",
            sourceUnitKey: "hello.scene.001.line.001",
            draftId: "locale-en-us:bridge-unit-test",
            runtimeTargetId: "hello.line.001",
            evidenceTier: null,
            frame: 1,
            textPreview: "Hello, {player}.",
            artifactIds: [],
          },
          {
            runtimeEventId:
              "019ed003-0000-7000-8000-000000000001:019ed003-0000-7000-8000-000000000201",
            eventKind: "branch_event",
            bridgeUnitId: "bridge-unit-test",
            sourceUnitKey: "hello.scene.001.line.001",
            draftId: "locale-en-us:bridge-unit-test",
            runtimeTargetId: "hello.choice.001",
            evidenceTier: null,
            frame: 2,
            textPreview: null,
            artifactIds: [],
          },
        ],
        artifacts: [
          expect.objectContaining({
            artifactId: "019ed003-0000-7000-8000-000000000001:019ed003-0000-7000-8000-000000000401",
            artifactKind: "screenshot",
            uri: "artifacts/utsushi/runtime/019ed003-0000-7000-8000-000000000001/screenshots/019ed003-0000-7000-8000-000000000401.png",
            hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
            mediaType: "image/png",
            byteSize: null,
            bridgeUnitId: "bridge-unit-test",
            sourceUnitKey: "hello.scene.001.line.001",
            diagnostic: null,
          }),
        ],
      });

      const runtimeReportArtifact = await context.pool.query<{
        metadata: {
          runtimeCapabilities?: { capabilityClass?: string; evidenceTierCeiling?: string };
          controlledPlaybackSession?: {
            requestedOperation?: string;
            evidenceTier?: string;
          };
        };
      }>("select metadata from itotori_artifacts where artifact_id = $1", [
        "019ed003-0000-7000-8000-000000000001",
      ]);
      expect(runtimeReportArtifact.rows[0]?.metadata.runtimeCapabilities).toMatchObject({
        capabilityClass: "launch_capture",
        evidenceTierCeiling: "E2",
      });
      expect(runtimeReportArtifact.rows[0]?.metadata.controlledPlaybackSession).toMatchObject({
        requestedOperation: "capture",
        evidenceTier: "E2",
      });

      const artifactResult = await context.pool.query<{
        artifact_kind: string;
        uri: string | null;
        hash: string | null;
      }>("select artifact_kind, uri, hash from itotori_artifacts where artifact_id = $1", [
        "019ed003-0000-7000-8000-000000000001:019ed003-0000-7000-8000-000000000401",
      ]);
      expect(artifactResult.rows[0]).toMatchObject({
        artifact_kind: "screenshot",
        uri: "artifacts/utsushi/runtime/019ed003-0000-7000-8000-000000000001/screenshots/019ed003-0000-7000-8000-000000000401.png",
        hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      });

      const evidenceArtifacts = await context.pool.query<{
        artifact_id: string;
        artifact_kind: string;
        bridge_unit_id: string | null;
        metadata: Record<string, unknown>;
      }>(
        `
        select artifact_id, artifact_kind, bridge_unit_id, metadata
        from itotori_artifacts
        where artifact_kind in ('runtime_trace_event', 'runtime_branch_event')
        order by artifact_kind
      `,
      );
      expect(evidenceArtifacts.rows).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("normalizes multiple runtime evidence runs with validation findings", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db);
      await repo.reset(localActor);
      const project = projectFixture();
      await repo.importSourceBundle(localActor, project);

      await repo.saveRuntimeReport(
        localActor,
        project,
        runtimeEvidenceReportFixture(),
        "019ed003-0000-7000-8000-000000000981",
      );

      await repo.saveRuntimeReport(
        localActor,
        project,
        runtimeEvidenceReportFixture({
          runtimeReportId: "019ed003-0000-7000-8000-000000000902",
          status: "failed",
          createdAt: "2026-06-17T00:10:00.000Z",
          traceEvents: [
            {
              traceEventId: "019ed003-0000-7000-8000-000000000912",
              eventKind: "text_observed",
              bridgeUnitRef: {
                bridgeUnitId: "bridge-unit-test",
                sourceUnitKey: "hello.scene.001.line.001",
              },
              frame: 2,
              traceKey: "hello.line.001",
              observedText: "Bonjour, {player}.",
              artifactRef: {
                artifactId: "019ed003-0000-7000-8000-000000000932",
                artifactKind: "trace_log",
                uri: "artifacts/utsushi/runtime/019ed003-0000-7000-8000-000000000902/traces/019ed003-0000-7000-8000-000000000932.json",
                mediaType: "application/json",
              },
            },
          ],
          captures: [
            {
              captureId: "019ed003-0000-7000-8000-000000000922",
              bridgeUnitRef: {
                bridgeUnitId: "bridge-unit-test",
                sourceUnitKey: "hello.scene.001.line.001",
              },
              evidenceTier: "E2",
              frame: 2,
              width: 320,
              height: 180,
              nonZeroPixels: 57600,
              artifactRef: {
                artifactId: "019ed003-0000-7000-8000-000000000933",
                artifactKind: "screenshot",
                uri: "artifacts/utsushi/runtime/019ed003-0000-7000-8000-000000000902/screenshots/019ed003-0000-7000-8000-000000000933.png",
                mediaType: "image/png",
              },
            },
          ],
          approximations: [
            {
              approximationId: "019ed003-0000-7000-8000-000000000942",
              approximationTier: "deterministic_fixture",
              scope: "fixture runtime",
              description: "Fixture evidence validates runtime plumbing, not engine fidelity.",
              affectedBridgeUnitRefs: [
                {
                  bridgeUnitId: "bridge-unit-test",
                  sourceUnitKey: "hello.scene.001.line.001",
                },
              ],
              evidenceTierCeiling: "E2",
            },
          ],
          validationFindings: [
            {
              findingId: "019ed003-0000-7000-8000-000000000951",
              findingKind: "text_mismatch",
              severity: "P2",
              bridgeUnitRef: {
                bridgeUnitId: "bridge-unit-test",
                sourceUnitKey: "hello.scene.001.line.001",
              },
              artifactRef: {
                artifactId: "019ed003-0000-7000-8000-000000000961",
                artifactKind: "trace_log",
                uri: "artifacts/utsushi/runtime/019ed003-0000-7000-8000-000000000902/traces/019ed003-0000-7000-8000-000000000961.json",
                mediaType: "application/json",
              },
              message: "Observed runtime text differed from the drafted locale branch text.",
              evidenceTier: "E1",
            },
          ],
        }),
        "019ed003-0000-7000-8000-000000000982",
      );

      const runs = await context.pool.query<{
        runtime_run_id: string;
        status: string;
        source_bundle_revision_id: string;
        runtime_report_artifact_id: string;
        patch_result_artifact_id: string;
        validation_finding_count: number;
      }>(
        `
        select
          runtime_run_id,
          status,
          source_bundle_revision_id,
          runtime_report_artifact_id,
          patch_result_artifact_id,
          validation_finding_count
        from itotori_runtime_evidence_runs
        order by report_created_at
      `,
      );
      expect(runs.rows).toEqual([
        {
          runtime_run_id: "019ed003-0000-7000-8000-000000000901",
          status: "passed",
          source_bundle_revision_id: "bridge-test:bundle-revision",
          runtime_report_artifact_id: "019ed003-0000-7000-8000-000000000901",
          patch_result_artifact_id: "019ed003-0000-7000-8000-000000000981",
          validation_finding_count: 0,
        },
        {
          runtime_run_id: "019ed003-0000-7000-8000-000000000902",
          status: "failed",
          source_bundle_revision_id: "bridge-test:bundle-revision",
          runtime_report_artifact_id: "019ed003-0000-7000-8000-000000000902",
          patch_result_artifact_id: "019ed003-0000-7000-8000-000000000982",
          validation_finding_count: 1,
        },
      ]);

      await expect(repo.getRuntimeStatus()).resolves.toMatchObject({
        finalStatus: "hello_world_failed",
        runtimeReportId: "019ed003-0000-7000-8000-000000000902",
        runtimeStatus: "failed",
        validationFindingCount: 1,
      });

      await expect(
        repo.getRuntimeStatus("019ed003-0000-7000-8000-000000000901"),
      ).resolves.toMatchObject({
        finalStatus: "hello_world_passed",
        runtimeRunId: "019ed003-0000-7000-8000-000000000901",
        runtimeReportId: "019ed003-0000-7000-8000-000000000901",
        runtimeStatus: "passed",
        validationFindingCount: 0,
      });

      const managedArtifacts = await context.pool.query<{
        artifact_id: string;
        artifact_kind: string;
        uri: string;
        hash: string | null;
      }>(
        `
        select artifact_id, artifact_kind, uri, hash
        from itotori_artifacts
        where metadata->>'runtimeReportId' = $1
          and uri like 'artifacts/utsushi/runtime/%'
        order by artifact_id
      `,
        ["019ed003-0000-7000-8000-000000000902"],
      );
      expect(managedArtifacts.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            artifact_kind: "screenshot",
            hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
          }),
          expect.objectContaining({
            artifact_kind: "trace_log",
            hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
          }),
        ]),
      );
      expect(managedArtifacts.rows.every((artifact) => artifact.hash !== null)).toBe(true);
      expect(
        managedArtifacts.rows.some((artifact) =>
          ["runtime_trace_event", "runtime_branch_event"].includes(artifact.artifact_kind),
        ),
      ).toBe(false);

      const evidence = await context.pool.query<{
        runtime_evidence_id: string;
        evidence_kind: string;
        bridge_unit_id: string | null;
        artifact_id: string | null;
        portable_artifact_uri: string | null;
      }>(
        `
        select
          runtime_evidence_id,
          evidence_kind,
          bridge_unit_id,
          artifact_id,
          portable_artifact_uri
        from itotori_runtime_evidence_items
        where runtime_run_id = $1
        order by evidence_kind, runtime_evidence_id
      `,
        ["019ed003-0000-7000-8000-000000000902"],
      );
      expect(evidence.rows).toEqual([
        {
          runtime_evidence_id:
            "019ed003-0000-7000-8000-000000000902:019ed003-0000-7000-8000-000000000942",
          evidence_kind: "approximation",
          bridge_unit_id: "bridge-unit-test",
          artifact_id: null,
          portable_artifact_uri: null,
        },
        {
          runtime_evidence_id:
            "019ed003-0000-7000-8000-000000000902:019ed003-0000-7000-8000-000000000922",
          evidence_kind: "capture",
          bridge_unit_id: "bridge-unit-test",
          artifact_id: "019ed003-0000-7000-8000-000000000902:019ed003-0000-7000-8000-000000000933",
          portable_artifact_uri:
            "artifacts/utsushi/runtime/019ed003-0000-7000-8000-000000000902/screenshots/019ed003-0000-7000-8000-000000000933.png",
        },
        {
          runtime_evidence_id:
            "019ed003-0000-7000-8000-000000000902:019ed003-0000-7000-8000-000000000912",
          evidence_kind: "trace_event",
          bridge_unit_id: "bridge-unit-test",
          artifact_id: "019ed003-0000-7000-8000-000000000902:019ed003-0000-7000-8000-000000000932",
          portable_artifact_uri:
            "artifacts/utsushi/runtime/019ed003-0000-7000-8000-000000000902/traces/019ed003-0000-7000-8000-000000000932.json",
        },
      ]);

      const refs = await context.pool.query<{ ref_role: string; bridge_unit_id: string }>(
        `
        select ref_role, bridge_unit_id
        from itotori_runtime_evidence_bridge_unit_refs
        where runtime_evidence_id in ($1, $2, $3)
        order by ref_role, runtime_evidence_id
      `,
        [
          "019ed003-0000-7000-8000-000000000902:019ed003-0000-7000-8000-000000000912",
          "019ed003-0000-7000-8000-000000000902:019ed003-0000-7000-8000-000000000922",
          "019ed003-0000-7000-8000-000000000902:019ed003-0000-7000-8000-000000000942",
        ],
      );
      expect(refs.rows).toEqual([
        { ref_role: "affected", bridge_unit_id: "bridge-unit-test" },
        { ref_role: "primary", bridge_unit_id: "bridge-unit-test" },
        { ref_role: "primary", bridge_unit_id: "bridge-unit-test" },
      ]);

      const validation = await context.pool.query<{
        finding_id: string;
        finding_kind: string;
        severity: string;
        message: string;
        bridge_unit_id: string | null;
        artifact_id: string | null;
        finding_status: string;
        quality_category: string | null;
        artifact_uri: string | null;
      }>(
        `
        select
          rvf.finding_id,
          rvf.finding_kind,
          rvf.severity,
          rvf.message,
          rvf.bridge_unit_id,
          rvf.artifact_id,
          f.status as finding_status,
          f.quality_category,
          a.uri as artifact_uri
        from itotori_runtime_validation_findings rvf
        join itotori_findings f using (finding_id)
        left join itotori_artifacts a on a.artifact_id = rvf.artifact_id
        where rvf.runtime_run_id = $1
      `,
        ["019ed003-0000-7000-8000-000000000902"],
      );
      expect(validation.rows[0]).toEqual({
        finding_id: "019ed003-0000-7000-8000-000000000902:019ed003-0000-7000-8000-000000000951",
        finding_kind: "text_mismatch",
        severity: "P2",
        message: "Observed runtime text differed from the drafted locale branch text.",
        bridge_unit_id: "bridge-unit-test",
        artifact_id: "019ed003-0000-7000-8000-000000000902:019ed003-0000-7000-8000-000000000961",
        finding_status: "open",
        quality_category: "runtime_validation",
        artifact_uri:
          "artifacts/utsushi/runtime/019ed003-0000-7000-8000-000000000902/traces/019ed003-0000-7000-8000-000000000961.json",
      });
    } finally {
      await context.close();
    }
  });

  it("namespaces repeated runtime evidence child ids across reports", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db);
      await repo.reset(localActor);
      const project = projectFixture();
      await repo.importSourceBundle(localActor, project);

      const firstRuntimeReportId = "019ed003-0000-7000-8000-000000000b01";
      const secondRuntimeReportId = "019ed003-0000-7000-8000-000000000b02";
      const traceEventId = "019ed003-0000-7000-8000-000000000b11";
      const branchEventId = "019ed003-0000-7000-8000-000000000b12";
      const branchOptionId = "019ed003-0000-7000-8000-000000000b13";
      const captureId = "019ed003-0000-7000-8000-000000000b21";
      const captureArtifactId = "019ed003-0000-7000-8000-000000000b31";
      const recordingId = "019ed003-0000-7000-8000-000000000b22";
      const recordingArtifactId = "019ed003-0000-7000-8000-000000000b32";
      const comparisonId = "019ed003-0000-7000-8000-000000000b23";
      const comparisonArtifactId = "019ed003-0000-7000-8000-000000000b33";
      const approximationId = "019ed003-0000-7000-8000-000000000b41";
      const validationFindingId = "019ed003-0000-7000-8000-000000000b51";

      const reportWithLocalIds = (
        runtimeReportId: string,
        createdAt: string,
      ): RuntimeEvidenceReportV02 =>
        runtimeEvidenceReportFixture({
          runtimeReportId,
          createdAt,
          status: "failed",
          traceEvents: [
            {
              traceEventId,
              eventKind: "text_observed",
              bridgeUnitRef: {
                bridgeUnitId: "bridge-unit-test",
                sourceUnitKey: "hello.scene.001.line.001",
              },
              frame: 1,
              traceKey: "hello.line.001",
              observedText: "Hello, {player}.",
            },
          ],
          branchEvents: [
            {
              branchEventId,
              bridgeUnitRef: {
                bridgeUnitId: "bridge-unit-test",
                sourceUnitKey: "hello.scene.001.line.001",
              },
              frame: 2,
              branchPointKey: "hello.choice.collision",
              promptText: "Choose a route",
              options: [
                {
                  optionId: branchOptionId,
                  label: "Shared local option",
                  labelBridgeUnitRef: {
                    bridgeUnitId: "bridge-unit-test",
                    sourceUnitKey: "hello.scene.001.line.001",
                  },
                },
              ],
              selectedOptionId: branchOptionId,
            },
          ],
          captures: [
            {
              captureId,
              bridgeUnitRef: {
                bridgeUnitId: "bridge-unit-test",
                sourceUnitKey: "hello.scene.001.line.001",
              },
              evidenceTier: "E2",
              frame: 1,
              width: 320,
              height: 180,
              nonZeroPixels: 57600,
              artifactRef: {
                artifactId: captureArtifactId,
                artifactKind: "screenshot",
                uri: `artifacts/utsushi/runtime/${runtimeReportId}/screenshots/${captureArtifactId}.png`,
                mediaType: "image/png",
              },
            },
          ],
          recordings: [
            {
              recordingId,
              bridgeUnitRef: {
                bridgeUnitId: "bridge-unit-test",
                sourceUnitKey: "hello.scene.001.line.001",
              },
              evidenceTier: "E3",
              startedAtFrame: 1,
              frameCount: 12,
              width: 320,
              height: 180,
              encoding: "vp9/webm",
              artifactRef: {
                artifactId: recordingArtifactId,
                artifactKind: "recording",
                uri: `artifacts/utsushi/runtime/${runtimeReportId}/recordings/${recordingArtifactId}.webm`,
                mediaType: "video/webm",
              },
            },
          ],
          approximations: [
            {
              approximationId,
              approximationTier: "deterministic_fixture",
              scope: "fixture runtime",
              description: "Fixture evidence validates runtime plumbing, not engine fidelity.",
              affectedBridgeUnitRefs: [
                {
                  bridgeUnitId: "bridge-unit-test",
                  sourceUnitKey: "hello.scene.001.line.001",
                },
              ],
              evidenceTierCeiling: "E2",
            },
          ],
          referenceComparisons: [
            {
              comparisonId,
              comparisonKind: "conformance_fixture",
              status: "failed",
              scope: "shared local comparison",
              coveredBridgeUnitRefs: [
                {
                  bridgeUnitId: "bridge-unit-test",
                  sourceUnitKey: "hello.scene.001.line.001",
                },
              ],
              artifactRef: {
                artifactId: comparisonArtifactId,
                artifactKind: "reference_comparison",
                uri: `artifacts/utsushi/runtime/${runtimeReportId}/conformance-reports/${comparisonArtifactId}.json`,
                mediaType: "application/json",
              },
            },
          ],
          validationFindings: [
            {
              findingId: validationFindingId,
              findingKind: "text_mismatch",
              severity: "P2",
              bridgeUnitRef: {
                bridgeUnitId: "bridge-unit-test",
                sourceUnitKey: "hello.scene.001.line.001",
              },
              message: `Runtime text mismatch for ${runtimeReportId}.`,
              evidenceTier: "E1",
            },
          ],
        });

      await repo.saveRuntimeReport(
        localActor,
        project,
        reportWithLocalIds(firstRuntimeReportId, "2026-06-17T00:30:00.000Z"),
        "patch-result-collision-1",
      );
      await repo.saveRuntimeReport(
        localActor,
        project,
        reportWithLocalIds(secondRuntimeReportId, "2026-06-17T00:31:00.000Z"),
        "patch-result-collision-2",
      );

      const evidenceRows = await context.pool.query<{
        runtime_run_id: string;
        runtime_evidence_id: string;
        evidence_kind: string;
        artifact_id: string | null;
        adapter_local_evidence_id: string | null;
      }>(
        `
        select
          runtime_run_id,
          runtime_evidence_id,
          evidence_kind,
          artifact_id,
          metadata->>'adapterLocalEvidenceId' as adapter_local_evidence_id
        from itotori_runtime_evidence_items
        where runtime_run_id in ($1, $2)
        order by runtime_run_id, evidence_kind
      `,
        [firstRuntimeReportId, secondRuntimeReportId],
      );
      expect(evidenceRows.rows).toEqual([
        {
          runtime_run_id: firstRuntimeReportId,
          runtime_evidence_id: `${firstRuntimeReportId}:${approximationId}`,
          evidence_kind: "approximation",
          artifact_id: null,
          adapter_local_evidence_id: approximationId,
        },
        {
          runtime_run_id: firstRuntimeReportId,
          runtime_evidence_id: `${firstRuntimeReportId}:${branchEventId}`,
          evidence_kind: "branch_event",
          artifact_id: null,
          adapter_local_evidence_id: branchEventId,
        },
        {
          runtime_run_id: firstRuntimeReportId,
          runtime_evidence_id: `${firstRuntimeReportId}:${captureId}`,
          evidence_kind: "capture",
          artifact_id: `${firstRuntimeReportId}:${captureArtifactId}`,
          adapter_local_evidence_id: captureId,
        },
        {
          runtime_run_id: firstRuntimeReportId,
          runtime_evidence_id: `${firstRuntimeReportId}:${recordingId}`,
          evidence_kind: "recording",
          artifact_id: `${firstRuntimeReportId}:${recordingArtifactId}`,
          adapter_local_evidence_id: recordingId,
        },
        {
          runtime_run_id: firstRuntimeReportId,
          runtime_evidence_id: `${firstRuntimeReportId}:${comparisonId}`,
          evidence_kind: "reference_comparison",
          artifact_id: `${firstRuntimeReportId}:${comparisonArtifactId}`,
          adapter_local_evidence_id: comparisonId,
        },
        {
          runtime_run_id: firstRuntimeReportId,
          runtime_evidence_id: `${firstRuntimeReportId}:${traceEventId}`,
          evidence_kind: "trace_event",
          artifact_id: null,
          adapter_local_evidence_id: traceEventId,
        },
        {
          runtime_run_id: secondRuntimeReportId,
          runtime_evidence_id: `${secondRuntimeReportId}:${approximationId}`,
          evidence_kind: "approximation",
          artifact_id: null,
          adapter_local_evidence_id: approximationId,
        },
        {
          runtime_run_id: secondRuntimeReportId,
          runtime_evidence_id: `${secondRuntimeReportId}:${branchEventId}`,
          evidence_kind: "branch_event",
          artifact_id: null,
          adapter_local_evidence_id: branchEventId,
        },
        {
          runtime_run_id: secondRuntimeReportId,
          runtime_evidence_id: `${secondRuntimeReportId}:${captureId}`,
          evidence_kind: "capture",
          artifact_id: `${secondRuntimeReportId}:${captureArtifactId}`,
          adapter_local_evidence_id: captureId,
        },
        {
          runtime_run_id: secondRuntimeReportId,
          runtime_evidence_id: `${secondRuntimeReportId}:${recordingId}`,
          evidence_kind: "recording",
          artifact_id: `${secondRuntimeReportId}:${recordingArtifactId}`,
          adapter_local_evidence_id: recordingId,
        },
        {
          runtime_run_id: secondRuntimeReportId,
          runtime_evidence_id: `${secondRuntimeReportId}:${comparisonId}`,
          evidence_kind: "reference_comparison",
          artifact_id: `${secondRuntimeReportId}:${comparisonArtifactId}`,
          adapter_local_evidence_id: comparisonId,
        },
        {
          runtime_run_id: secondRuntimeReportId,
          runtime_evidence_id: `${secondRuntimeReportId}:${traceEventId}`,
          evidence_kind: "trace_event",
          artifact_id: null,
          adapter_local_evidence_id: traceEventId,
        },
      ]);

      const artifactRows = await context.pool.query<{
        artifact_id: string;
        artifact_kind: string;
        runtime_report_id: string | null;
        adapter_local_artifact_id: string | null;
        uri: string | null;
      }>(
        `
        select
          artifact_id,
          artifact_kind,
          metadata->>'runtimeReportId' as runtime_report_id,
          metadata->>'adapterLocalArtifactId' as adapter_local_artifact_id,
          uri
        from itotori_artifacts
        where artifact_id in ($1, $2, $3, $4, $5, $6)
        order by artifact_id
      `,
        [
          `${firstRuntimeReportId}:${captureArtifactId}`,
          `${firstRuntimeReportId}:${recordingArtifactId}`,
          `${firstRuntimeReportId}:${comparisonArtifactId}`,
          `${secondRuntimeReportId}:${captureArtifactId}`,
          `${secondRuntimeReportId}:${recordingArtifactId}`,
          `${secondRuntimeReportId}:${comparisonArtifactId}`,
        ],
      );
      expect(artifactRows.rows).toEqual([
        {
          artifact_id: `${firstRuntimeReportId}:${captureArtifactId}`,
          artifact_kind: "screenshot",
          runtime_report_id: firstRuntimeReportId,
          adapter_local_artifact_id: captureArtifactId,
          uri: `artifacts/utsushi/runtime/${firstRuntimeReportId}/screenshots/${captureArtifactId}.png`,
        },
        {
          artifact_id: `${firstRuntimeReportId}:${recordingArtifactId}`,
          artifact_kind: "recording",
          runtime_report_id: firstRuntimeReportId,
          adapter_local_artifact_id: recordingArtifactId,
          uri: `artifacts/utsushi/runtime/${firstRuntimeReportId}/recordings/${recordingArtifactId}.webm`,
        },
        {
          artifact_id: `${firstRuntimeReportId}:${comparisonArtifactId}`,
          artifact_kind: "reference_comparison",
          runtime_report_id: firstRuntimeReportId,
          adapter_local_artifact_id: comparisonArtifactId,
          uri: `artifacts/utsushi/runtime/${firstRuntimeReportId}/conformance-reports/${comparisonArtifactId}.json`,
        },
        {
          artifact_id: `${secondRuntimeReportId}:${captureArtifactId}`,
          artifact_kind: "screenshot",
          runtime_report_id: secondRuntimeReportId,
          adapter_local_artifact_id: captureArtifactId,
          uri: `artifacts/utsushi/runtime/${secondRuntimeReportId}/screenshots/${captureArtifactId}.png`,
        },
        {
          artifact_id: `${secondRuntimeReportId}:${recordingArtifactId}`,
          artifact_kind: "recording",
          runtime_report_id: secondRuntimeReportId,
          adapter_local_artifact_id: recordingArtifactId,
          uri: `artifacts/utsushi/runtime/${secondRuntimeReportId}/recordings/${recordingArtifactId}.webm`,
        },
        {
          artifact_id: `${secondRuntimeReportId}:${comparisonArtifactId}`,
          artifact_kind: "reference_comparison",
          runtime_report_id: secondRuntimeReportId,
          adapter_local_artifact_id: comparisonArtifactId,
          uri: `artifacts/utsushi/runtime/${secondRuntimeReportId}/conformance-reports/${comparisonArtifactId}.json`,
        },
      ]);

      const validationRows = await context.pool.query<{
        runtime_run_id: string;
        finding_id: string;
        adapter_local_finding_id: string | null;
        message: string;
      }>(
        `
        select
          runtime_run_id,
          finding_id,
          metadata->>'adapterLocalFindingId' as adapter_local_finding_id,
          message
        from itotori_runtime_validation_findings
        where runtime_run_id in ($1, $2)
        order by runtime_run_id
        `,
        [firstRuntimeReportId, secondRuntimeReportId],
      );
      expect(validationRows.rows).toEqual([
        {
          runtime_run_id: firstRuntimeReportId,
          finding_id: `${firstRuntimeReportId}:${validationFindingId}`,
          adapter_local_finding_id: validationFindingId,
          message: `Runtime text mismatch for ${firstRuntimeReportId}.`,
        },
        {
          runtime_run_id: secondRuntimeReportId,
          finding_id: `${secondRuntimeReportId}:${validationFindingId}`,
          adapter_local_finding_id: validationFindingId,
          message: `Runtime text mismatch for ${secondRuntimeReportId}.`,
        },
      ]);
    } finally {
      await context.close();
    }
  });

  it("replaces stale runtime evidence projections when re-ingesting a corrected report", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db);
      await repo.reset(localActor);
      const project = projectFixture();
      await repo.importSourceBundle(localActor, project);

      const runtimeReportId = "019ed003-0000-7000-8000-000000000a18";
      const firstReport = runtimeEvidenceReportFixture({
        runtimeReportId,
        status: "failed",
        createdAt: "2026-06-17T00:20:00.000Z",
        captures: [
          {
            captureId: "019ed003-0000-7000-8000-000000000a21",
            bridgeUnitRef: {
              bridgeUnitId: "bridge-unit-test",
              sourceUnitKey: "hello.scene.001.line.001",
            },
            evidenceTier: "E2",
            frame: 1,
            width: 320,
            height: 180,
            nonZeroPixels: 57600,
            artifactRef: {
              artifactId: "019ed003-0000-7000-8000-000000000a31",
              artifactKind: "screenshot",
              uri: "artifacts/utsushi/runtime/019ed003-0000-7000-8000-000000000a18/screenshots/019ed003-0000-7000-8000-000000000a31.png",
              mediaType: "image/png",
            },
          },
          {
            captureId: "019ed003-0000-7000-8000-000000000a22",
            bridgeUnitRef: {
              bridgeUnitId: "bridge-unit-test",
              sourceUnitKey: "hello.scene.001.line.001",
            },
            evidenceTier: "E2",
            frame: 2,
            width: 320,
            height: 180,
            nonZeroPixels: 57600,
            artifactRef: {
              artifactId: "019ed003-0000-7000-8000-000000000a32",
              artifactKind: "screenshot",
              uri: "artifacts/utsushi/runtime/019ed003-0000-7000-8000-000000000a18/screenshots/019ed003-0000-7000-8000-000000000a32.png",
              mediaType: "image/png",
            },
          },
        ],
        branchEvents: [
          {
            branchEventId: "019ed003-0000-7000-8000-000000000a41",
            bridgeUnitRef: {
              bridgeUnitId: "bridge-unit-test",
              sourceUnitKey: "hello.scene.001.line.001",
            },
            frame: 3,
            branchPointKey: "hello.choice.reingest",
            promptText: "Choose a corrected route",
            options: [
              {
                optionId: "019ed003-0000-7000-8000-000000000a42",
                label: "Old route",
                labelBridgeUnitRef: {
                  bridgeUnitId: "bridge-unit-test",
                  sourceUnitKey: "hello.scene.001.line.001",
                },
              },
            ],
            selectedOptionId: "019ed003-0000-7000-8000-000000000a42",
          },
        ],
        referenceComparisons: [
          {
            comparisonId: "019ed003-0000-7000-8000-000000000a51",
            comparisonKind: "conformance_fixture",
            status: "failed",
            scope: "stale comparison",
            coveredBridgeUnitRefs: [
              {
                bridgeUnitId: "bridge-unit-test",
                sourceUnitKey: "hello.scene.001.line.001",
              },
            ],
            artifactRef: {
              artifactId: "019ed003-0000-7000-8000-000000000a52",
              artifactKind: "reference_comparison",
              uri: "artifacts/utsushi/runtime/019ed003-0000-7000-8000-000000000a18/conformance-reports/019ed003-0000-7000-8000-000000000a52.json",
              mediaType: "application/json",
            },
          },
        ],
        validationFindings: [
          {
            findingId: "019ed003-0000-7000-8000-000000000a61",
            findingKind: "text_mismatch",
            severity: "P2",
            bridgeUnitRef: {
              bridgeUnitId: "bridge-unit-test",
              sourceUnitKey: "hello.scene.001.line.001",
            },
            artifactRef: {
              artifactId: "019ed003-0000-7000-8000-000000000a62",
              artifactKind: "trace_log",
              uri: "artifacts/utsushi/runtime/019ed003-0000-7000-8000-000000000a18/traces/019ed003-0000-7000-8000-000000000a62.json",
              mediaType: "application/json",
            },
            message: "Stale runtime text mismatch.",
            evidenceTier: "E1",
          },
          {
            findingId: "019ed003-0000-7000-8000-000000000a63",
            findingKind: "capture_missing",
            severity: "P3",
            bridgeUnitRef: {
              bridgeUnitId: "bridge-unit-test",
              sourceUnitKey: "hello.scene.001.line.001",
            },
            message: "Stale capture validation finding.",
            evidenceTier: "E2",
          },
        ],
      });

      await repo.saveRuntimeReport(localActor, project, firstReport, "patch-result-reingest-old");
      await expect(repo.getDashboardDecisions()).resolves.toMatchObject({
        counts: { runtimeValidationDecisionCount: 2 },
      });

      const correctedReport = runtimeEvidenceReportFixture({
        runtimeReportId,
        createdAt: "2026-06-17T00:25:00.000Z",
        captures: [firstReport.captures[0]!],
        branchEvents: [],
        referenceComparisons: [],
        validationFindings: [],
      });

      await repo.saveRuntimeReport(
        localActor,
        project,
        correctedReport,
        "patch-result-reingest-new",
      );

      await expect(repo.getRuntimeStatus()).resolves.toMatchObject({
        runtimeReportId,
        runtimeStatus: "passed",
        frameCaptureCount: 1,
        screenshotArtifactCount: 1,
        validationFindingCount: 0,
      });

      await expect(repo.getDashboardDecisions()).resolves.toMatchObject({
        counts: { runtimeValidationDecisionCount: 0 },
        pendingDecisions: [],
      });

      const normalizedCounts = await context.pool.query<{
        capture_count: number;
        validation_finding_count: number;
        evidence_row_count: number;
        ref_row_count: number;
      }>(
        `
        select
          count(*) filter (where rei.evidence_kind = 'capture')::int as capture_count,
          (
            select count(*)::int
            from itotori_runtime_validation_findings
            where runtime_run_id = $1
          ) as validation_finding_count,
          count(distinct rei.runtime_evidence_id)::int as evidence_row_count,
          count(rebur.runtime_evidence_id)::int as ref_row_count
        from itotori_runtime_evidence_items rei
        left join itotori_runtime_evidence_bridge_unit_refs rebur
          on rebur.runtime_evidence_id = rei.runtime_evidence_id
        where rei.runtime_run_id = $1
      `,
        [runtimeReportId],
      );
      expect(normalizedCounts.rows[0]).toEqual({
        capture_count: 1,
        validation_finding_count: 0,
        evidence_row_count: 3,
        ref_row_count: 3,
      });

      const staleRows = await context.pool.query<{ row_kind: string; row_id: string }>(
        `
        select 'evidence' as row_kind, runtime_evidence_id as row_id
        from itotori_runtime_evidence_items
        where runtime_evidence_id in (
          '019ed003-0000-7000-8000-000000000a18:019ed003-0000-7000-8000-000000000a22',
          '019ed003-0000-7000-8000-000000000a18:019ed003-0000-7000-8000-000000000a41',
          '019ed003-0000-7000-8000-000000000a18:019ed003-0000-7000-8000-000000000a51'
        )
        union all
        select 'finding' as row_kind, finding_id as row_id
        from itotori_findings
        where finding_id in (
          '019ed003-0000-7000-8000-000000000a18:019ed003-0000-7000-8000-000000000a61',
          '019ed003-0000-7000-8000-000000000a18:019ed003-0000-7000-8000-000000000a63'
        )
        union all
        select 'artifact' as row_kind, artifact_id as row_id
        from itotori_artifacts
        where artifact_id in (
          '019ed003-0000-7000-8000-000000000a18:019ed003-0000-7000-8000-000000000a32',
          '019ed003-0000-7000-8000-000000000a18:019ed003-0000-7000-8000-000000000a41',
          '019ed003-0000-7000-8000-000000000a18:019ed003-0000-7000-8000-000000000a52',
          '019ed003-0000-7000-8000-000000000a18:019ed003-0000-7000-8000-000000000a62',
          'patch-result-reingest-old'
        )
        order by row_kind, row_id
      `,
      );
      expect(staleRows.rows).toEqual([]);

      const retainedArtifacts = await context.pool.query<{ artifact_id: string }>(
        `
        select artifact_id
        from itotori_artifacts
        where artifact_id in ($1, $2, $3)
        order by artifact_id
      `,
        [
          runtimeReportId,
          "019ed003-0000-7000-8000-000000000a18:019ed003-0000-7000-8000-000000000a31",
          "patch-result-reingest-new",
        ],
      );
      expect(retainedArtifacts.rows.map((row) => row.artifact_id)).toEqual([
        "019ed003-0000-7000-8000-000000000a18",
        "019ed003-0000-7000-8000-000000000a18:019ed003-0000-7000-8000-000000000a31",
        "patch-result-reingest-new",
      ]);
    } finally {
      await context.close();
    }
  });

  it("stores runtime artifact references without embedding artifact blobs", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db);
      await repo.reset(localActor);
      const project = projectFixture();
      await repo.importSourceBundle(localActor, project);

      const base = runtimeEvidenceReportFixture();
      const runtimeReport = runtimeEvidenceReportFixture({
        runtimeReportId: "019ed003-0000-7000-8000-000000000904",
        fidelityTier: "reference_fidelity",
        evidenceTier: "E4",
        runtimeCapabilities: {
          ...base.runtimeCapabilities!,
          capabilityClass: "reference_vm",
          fidelityTierCeiling: "reference_fidelity",
          evidenceTierCeiling: "E4",
          features: [
            ...base.runtimeCapabilities!.features.filter(
              (feature) => !["recording", "reference_comparison"].includes(feature.feature),
            ),
            {
              feature: "recording",
              status: "supported",
              evidenceTierCeiling: "E3",
              description: "Stores runtime recording artifact references.",
              limitations: [],
            },
            {
              feature: "reference_comparison",
              status: "supported",
              evidenceTierCeiling: "E4",
              description: "Stores conformance comparison artifact references.",
              limitations: [],
            },
          ],
        },
        controlledPlaybackSession: {
          ...base.controlledPlaybackSession!,
          capabilityClass: "reference_vm",
          requestedOperation: "smoke_validation",
          fidelityTier: "reference_fidelity",
          evidenceTier: "E4",
          featuresUsed: [
            "static_trace",
            "text_trace",
            "frame_capture",
            "recording",
            "reference_comparison",
          ],
        },
        traceEvents: [
          {
            ...base.traceEvents[0]!,
            artifactRef: {
              artifactId: "019ed003-0000-7000-8000-000000000971",
              artifactKind: "trace_log",
              uri: "artifacts/utsushi/runtime/019ed003-0000-7000-8000-000000000904/traces/019ed003-0000-7000-8000-000000000971.json",
              mediaType: "application/json",
              byteSize: 128,
              data: "raw-trace-blob-should-not-persist",
            } as RuntimeEvidenceReportV02["traceEvents"][number]["artifactRef"] & {
              data: string;
            },
          },
        ],
        captures: [
          {
            ...base.captures[0]!,
            artifactRef: {
              artifactId: "019ed003-0000-7000-8000-000000000972",
              artifactKind: "screenshot",
              uri: "artifacts/utsushi/runtime/019ed003-0000-7000-8000-000000000904/screenshots/019ed003-0000-7000-8000-000000000972.png",
              mediaType: "image/png",
              byteSize: 256,
              bytes: "raw-pixel-data-should-not-persist",
            } as RuntimeEvidenceReportV02["captures"][number]["artifactRef"] & {
              bytes: string;
            },
          },
        ],
        recordings: [
          {
            recordingId: "019ed003-0000-7000-8000-000000000973",
            bridgeUnitRef: {
              bridgeUnitId: "bridge-unit-test",
              sourceUnitKey: "hello.scene.001.line.001",
            },
            evidenceTier: "E3",
            startedAtFrame: 1,
            frameCount: 12,
            width: 320,
            height: 180,
            encoding: "vp9/webm",
            artifactRef: {
              artifactId: "019ed003-0000-7000-8000-000000000974",
              artifactKind: "recording",
              uri: "artifacts/utsushi/runtime/019ed003-0000-7000-8000-000000000904/recordings/019ed003-0000-7000-8000-000000000974.webm",
              mediaType: "video/webm",
              byteSize: 512,
              data: "raw-video-data-should-not-persist",
            } as RuntimeEvidenceReportV02["recordings"][number]["artifactRef"] & {
              data: string;
            },
          },
        ],
        referenceComparisons: [
          {
            comparisonId: "019ed003-0000-7000-8000-000000000975",
            comparisonKind: "conformance_fixture",
            status: "passed",
            scope: "runtime artifact storage contract",
            coveredBridgeUnitRefs: [
              {
                bridgeUnitId: "bridge-unit-test",
                sourceUnitKey: "hello.scene.001.line.001",
              },
            ],
            artifactRef: {
              artifactId: "019ed003-0000-7000-8000-000000000976",
              artifactKind: "reference_comparison",
              uri: "artifacts/utsushi/runtime/019ed003-0000-7000-8000-000000000904/conformance-reports/019ed003-0000-7000-8000-000000000976.json",
              mediaType: "application/json",
              byteSize: 768,
              data: "raw-conformance-data-should-not-persist",
            } as NonNullable<
              RuntimeEvidenceReportV02["referenceComparisons"]
            >[number]["artifactRef"] & { data: string },
          },
        ],
      });

      await repo.saveRuntimeReport(
        localActor,
        project,
        runtimeReport,
        "019ed003-0000-7000-8000-000000000984",
      );

      const itemRows = await context.pool.query<{
        runtime_evidence_id: string;
        evidence_kind: string;
        artifact_id: string | null;
        portable_artifact_uri: string | null;
        metadata: Record<string, unknown>;
      }>(
        `
        select runtime_evidence_id, evidence_kind, artifact_id, portable_artifact_uri, metadata
        from itotori_runtime_evidence_items
        where runtime_run_id = $1
          and evidence_kind in ('trace_event', 'capture', 'recording', 'reference_comparison')
        order by evidence_kind, runtime_evidence_id
        `,
        ["019ed003-0000-7000-8000-000000000904"],
      );

      expect(itemRows.rows).toHaveLength(4);
      for (const row of itemRows.rows) {
        expect(row.artifact_id).toBeTruthy();
        expect(row.portable_artifact_uri).toMatch(/^artifacts\/utsushi\/runtime\//);
        const metadata = JSON.stringify(row.metadata);
        expect(metadata).not.toContain("raw-trace-blob-should-not-persist");
        expect(metadata).not.toContain("raw-pixel-data-should-not-persist");
        expect(metadata).not.toContain("raw-video-data-should-not-persist");
        expect(metadata).not.toContain("raw-conformance-data-should-not-persist");
      }

      const artifactRows = await context.pool.query<{
        artifact_kind: string;
        uri: string | null;
        metadata: Record<string, unknown>;
      }>(
        `
        select artifact_kind, uri, metadata
        from itotori_artifacts
        where artifact_id in ($1, $2, $3, $4)
        order by artifact_kind
        `,
        [
          "019ed003-0000-7000-8000-000000000904:019ed003-0000-7000-8000-000000000971",
          "019ed003-0000-7000-8000-000000000904:019ed003-0000-7000-8000-000000000972",
          "019ed003-0000-7000-8000-000000000904:019ed003-0000-7000-8000-000000000974",
          "019ed003-0000-7000-8000-000000000904:019ed003-0000-7000-8000-000000000976",
        ],
      );

      expect(artifactRows.rows.map((row) => row.artifact_kind).sort()).toEqual([
        "recording",
        "reference_comparison",
        "screenshot",
        "trace_log",
      ]);
      for (const row of artifactRows.rows) {
        expect(row.uri).toMatch(/^artifacts\/utsushi\/runtime\//);
        expect(JSON.stringify(row.metadata)).not.toMatch(/raw-.*-should-not-persist/);
      }
    } finally {
      await context.close();
    }
  });

  it("rejects traversal and raw runtime artifact paths", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db);
      await repo.reset(localActor);
      const project = projectFixture();
      await repo.importSourceBundle(localActor, project);

      const runtimeReport = {
        schemaVersion: "0.1.0" as const,
        runtimeReportId: "runtime-path-test",
        adapterName: "utsushi-fixture",
        fidelityTier: "layout_probe",
        status: "passed" as const,
        textEvents: [],
        frameCaptures: [
          {
            frameCaptureId: "frame-path-test",
            bridgeUnitId: "bridge-unit-test",
            width: 320,
            height: 180,
            nonZeroPixels: 57600,
            artifactPath: "../capture.png",
          },
        ],
        approximations: [],
      };

      await expect(
        repo.saveRuntimeReport(localActor, project, runtimeReport, "patch-result-traversal"),
      ).rejects.toThrow(/portable relative artifact path/);

      await expect(
        repo.saveRuntimeReport(
          localActor,
          project,
          {
            ...runtimeReport,
            runtimeReportId: "runtime-raw-test",
            frameCaptures: [
              {
                ...runtimeReport.frameCaptures[0]!,
                frameCaptureId: "frame-raw-test",
                artifactPath: "data:image/png;base64,AAAA",
              },
            ],
          },
          "patch-result-raw",
        ),
      ).rejects.toThrow(/portable relative artifact path/);

      await expect(
        repo.saveRuntimeReport(
          localActor,
          project,
          runtimeEvidenceReportFixture({
            runtimeReportId: "019ed003-0000-7000-8000-000000000903",
            captures: [
              {
                ...runtimeEvidenceReportFixture().captures[0]!,
                captureId: "019ed003-0000-7000-8000-000000000923",
                artifactRef: {
                  ...runtimeEvidenceReportFixture().captures[0]!.artifactRef,
                  artifactId: "019ed003-0000-7000-8000-000000000934",
                  uri: "../capture.png",
                },
              },
            ],
          }),
          "019ed003-0000-7000-8000-000000000983",
        ),
      ).rejects.toThrow(/portable relative artifact path/);
    } finally {
      await context.close();
    }
  });

  it("supports multiple locale branches for one project", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db);
      await repo.reset(localActor);

      await repo.importSourceBundle(localActor, projectFixture());
      await repo.importSourceBundle(
        localActor,
        projectFixture({
          localeBranchId: "locale-fr-fr",
          targetLocale: "fr-FR",
          drafts: { "bridge-unit-test": "Bonjour, {player}." },
        }),
      );

      const status = await repo.getDashboardStatus();
      expect(status.branchCount).toBe(2);
      expect(status.localeBranches.map((branch) => branch.targetLocale).sort()).toEqual([
        "en-US",
        "fr-FR",
      ]);
    } finally {
      await context.close();
    }
  });

  it("records append-only events, findings, and artifact links", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db);
      await repo.reset(localActor);
      await repo.importSourceBundle(localActor, projectFixture());

      await repo.appendEvent(localActor, {
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        event: {
          eventId: "event-finding",
          eventKind: "qa_finding_reported",
          occurredAt: "2026-06-17T00:00:00.000Z",
          actor: { actorKind: "tool", displayName: "deterministic-check" },
          findingId: "finding-test",
          subjectRefs: [{ subjectKind: "bridge_unit", subjectId: "bridge-unit-test" }],
          provenance: [],
          causalLinks: [],
          payload: { check: "protected-span" },
        },
      });

      await expect(
        context.pool.query("update itotori_events set event_kind = $1 where event_id = $2", [
          "task_started",
          "event-finding",
        ]),
      ).rejects.toThrow(/append-only/);

      await repo.recordFinding(localActor, {
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        finding: {
          findingId: "finding-test",
          findingKind: "protected_span_issue",
          severity: "P1",
          qualityCategory: "protected_content",
          title: "Protected span moved",
          description: "A placeholder was not preserved.",
          impact: "Patch output could break runtime substitution.",
          createdAt: "2026-06-17T00:00:00.000Z",
          firstSeenEventId: "event-finding",
          affectedRefs: [{ subjectKind: "bridge_unit", subjectId: "bridge-unit-test" }],
          evidence: [],
          provenance: [],
          causalLinks: [],
        },
      });
      await repo.linkArtifact(localActor, {
        artifactId: "artifact-finding",
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        bridgeUnitId: "bridge-unit-test",
        findingId: "finding-test",
        artifactKind: "validator_message",
        uri: "fixture://validator/protected-span",
        metadata: { rule: "protected-span" },
      });

      const status = await repo.getDashboardStatus();
      expect(status.findingCount).toBe(1);
      expect(status.localeBranches[0]?.openFindingCount).toBe(1);
      expect(status.artifactCount).toBe(1);
    } finally {
      await context.close();
    }
  });

  it("reads dashboard pending decisions without inferring across finding sources", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db);
      await repo.reset(localActor);
      const project = projectFixture();
      await repo.importSourceBundle(localActor, project);

      await repo.recordFinding(localActor, {
        projectId: "project-test",
        finding: {
          findingId: "finding-project-level",
          findingKind: "terminology_consistency",
          severity: "P2",
          qualityCategory: "terminology",
          title: "Project terminology review",
          description: "A glossary-level term needs human confirmation.",
          impact: "All locale branches could drift on a named term.",
          createdAt: "2026-06-17T00:00:00.000Z",
          affectedRefs: [{ subjectKind: "project", subjectId: "project-test" }],
          evidence: [],
          provenance: [],
          causalLinks: [],
        },
      });

      await repo.recordFinding(localActor, {
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        finding: {
          findingId: "finding-locale-branch",
          findingKind: "protected_span_issue",
          severity: "P1",
          qualityCategory: "protected_content",
          title: "Protected span moved",
          description: "A placeholder was not preserved.",
          impact: "Patch output could break runtime substitution.",
          createdAt: "2026-06-17T00:01:00.000Z",
          affectedRefs: [{ subjectKind: "bridge_unit", subjectId: "bridge-unit-test" }],
          evidence: [],
          provenance: [],
          causalLinks: [],
        },
      });

      await repo.saveRuntimeReport(
        localActor,
        project,
        runtimeEvidenceReportFixture({
          runtimeReportId: "019ed003-0000-7000-8000-000000000999",
          status: "failed",
          createdAt: "2026-06-17T00:02:00.000Z",
          validationFindings: [
            {
              findingId: "finding-runtime-validation",
              findingKind: "text_mismatch",
              severity: "P2",
              bridgeUnitRef: {
                bridgeUnitId: "bridge-unit-test",
                sourceUnitKey: "hello.scene.001.line.001",
              },
              message: "Observed runtime text differed from the drafted locale branch text.",
              evidenceTier: "E1",
            },
          ],
        }),
        "019ed003-0000-7000-8000-000000000998",
      );

      await expect(repo.getDashboardDecisions()).resolves.toMatchObject({
        projectId: "project-test",
        counts: {
          pendingDecisionCount: 3,
          projectFindingDecisionCount: 1,
          localeBranchFindingDecisionCount: 1,
          runtimeValidationDecisionCount: 1,
        },
        pendingDecisions: [
          {
            decisionKind: "project_finding",
            findingId: "finding-project-level",
            localeBranchId: null,
            targetLocale: null,
            runtimeRunId: null,
          },
          {
            decisionKind: "locale_branch_finding",
            findingId: "finding-locale-branch",
            localeBranchId: "locale-en-us",
            targetLocale: "en-US",
            runtimeRunId: null,
          },
          {
            decisionKind: "runtime_validation",
            findingId: "019ed003-0000-7000-8000-000000000999:finding-runtime-validation",
            localeBranchId: "locale-en-us",
            targetLocale: "en-US",
            runtimeRunId: "019ed003-0000-7000-8000-000000000999",
            runtimeStatus: "failed",
          },
        ],
      });

      const status = await repo.getDashboardStatus();
      expect(status.findingCount).toBe(3);
      expect(status.localeBranches[0]?.openFindingCount).toBe(1);
    } finally {
      await context.close();
    }
  });

  it("imports contextual manual feedback with line, screenshot, save context, and note", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db);
      const feedbackRepo = new ItotoriFeedbackRepository(context.db);
      await repo.reset(localActor);
      await repo.importSourceBundle(localActor, projectFixture());

      const result = await feedbackRepo.importManualFeedback(localActor, manualFeedbackFixture());

      expect(result).toMatchObject({
        duplicate: false,
        reportCount: 1,
        triageLabel: feedbackTriageLabelValues.styleDisputeCandidate,
        reportStatus: feedbackReportStatusValues.open,
        contextStatus: feedbackContextStatusValues.contextualized,
      });

      const report = await context.db
        .select()
        .from(feedbackReports)
        .where(eq(feedbackReports.feedbackReportId, result.feedbackReportId))
        .limit(1);
      expect(report[0]).toMatchObject({
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        bridgeUnitId: "bridge-unit-test",
        feedbackType: feedbackTypeValues.stylePreference,
        reporterRole: "playtester",
        reporterNote: "The protagonist sounds too formal in this line.",
        reportCount: 1,
      });
      expect(report[0]?.lineReference).toMatchObject({
        sourceUnitKey: "hello.scene.001.line.001",
        path: "source.json",
        line: 1,
      });
      expect(report[0]?.attachmentSummary).toMatchObject({
        counts: {
          screenshot: 1,
          save_context: 1,
        },
        artifactIds: ["feedback-screenshot-1"],
      });

      const source = await context.db
        .select()
        .from(feedbackSources)
        .where(eq(feedbackSources.feedbackSourceId, result.feedbackSourceId))
        .limit(1);
      expect(source[0]).toMatchObject({
        projectId: "project-test",
        sourceKind: "manual_playtest",
        label: "Manual playtest fixture",
      });

      const evidence = await context.db
        .select()
        .from(feedbackReportEvidence)
        .where(eq(feedbackReportEvidence.feedbackReportId, result.feedbackReportId));
      expect(evidence).toHaveLength(1);
      expect(evidence[0]?.attachments).toHaveLength(2);
      expect(evidence[0]?.contextSignals).toMatchObject({
        lineReference: { bridgeUnitId: "bridge-unit-test" },
      });

      const linkedArtifact = await context.db
        .select()
        .from(artifacts)
        .where(eq(artifacts.artifactId, "feedback-screenshot-1"))
        .limit(1);
      expect(linkedArtifact[0]).toMatchObject({
        artifactKind: "feedback_screenshot",
        bridgeUnitId: "bridge-unit-test",
      });
      expect(linkedArtifact[0]?.metadata).toMatchObject({
        feedbackReportId: result.feedbackReportId,
        feedbackEvidenceId: result.feedbackEvidenceId,
      });

      const importedEvent = await context.db
        .select()
        .from(events)
        .where(eq(events.eventKind, "feedback_report_imported"))
        .limit(1);
      expect(importedEvent[0]?.payload).toMatchObject({
        duplicate: false,
        triageLabel: feedbackTriageLabelValues.styleDisputeCandidate,
        reportCount: 1,
      });
    } finally {
      await context.close();
    }
  });

  it("keeps feedback without source or context in needs_context", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db);
      const feedbackRepo = new ItotoriFeedbackRepository(context.db);
      await repo.reset(localActor);
      await repo.importSourceBundle(localActor, projectFixture());

      const result = await feedbackRepo.importManualFeedback(localActor, {
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        targetLocale: "en-US",
        feedbackType: feedbackTypeValues.objectiveDefect,
        reporter: { role: "playtester" },
        reporterNote: "Something looked wrong, but I forgot where.",
        reportedAt: "2026-06-17T00:00:00.000Z",
      });

      expect(result).toMatchObject({
        contextStatus: feedbackContextStatusValues.needsContext,
        reportStatus: feedbackReportStatusValues.needsContext,
        triageLabel: feedbackTriageLabelValues.needsContext,
      });

      const report = await context.db
        .select()
        .from(feedbackReports)
        .where(eq(feedbackReports.feedbackReportId, result.feedbackReportId))
        .limit(1);
      expect(report[0]).toMatchObject({
        feedbackType: feedbackTypeValues.objectiveDefect,
        reportStatus: feedbackReportStatusValues.needsContext,
        triageLabel: feedbackTriageLabelValues.needsContext,
      });
    } finally {
      await context.close();
    }
  });

  it("does not treat empty line references or bare screenshots as context", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db);
      const feedbackRepo = new ItotoriFeedbackRepository(context.db);
      await repo.reset(localActor);
      await repo.importSourceBundle(localActor, projectFixture());

      const result = await feedbackRepo.importManualFeedback(
        localActor,
        manualFeedbackFixture({
          feedbackType: feedbackTypeValues.objectiveDefect,
          reporterNote: "Something looked wrong in a screenshot, but no location was exported.",
          lineReference: {},
          attachments: [{ attachmentKind: "screenshot" }],
        }),
      );

      expect(result).toMatchObject({
        contextStatus: feedbackContextStatusValues.needsContext,
        reportStatus: feedbackReportStatusValues.needsContext,
        triageLabel: feedbackTriageLabelValues.needsContext,
      });

      const report = await context.db
        .select()
        .from(feedbackReports)
        .where(eq(feedbackReports.feedbackReportId, result.feedbackReportId))
        .limit(1);
      expect(report[0]?.lineReference).toBeNull();

      const evidence = await context.db
        .select()
        .from(feedbackReportEvidence)
        .where(eq(feedbackReportEvidence.feedbackReportId, result.feedbackReportId))
        .limit(1);
      expect(evidence[0]?.contextSignals).toEqual({});
      expect(evidence[0]?.attachments).toEqual([{ attachmentKind: "screenshot" }]);
    } finally {
      await context.close();
    }
  });

  it("labels style preferences separately from objective defect candidates", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db);
      const feedbackRepo = new ItotoriFeedbackRepository(context.db);
      await repo.reset(localActor);
      await repo.importSourceBundle(localActor, projectFixture());

      const style = await feedbackRepo.importManualFeedback(
        localActor,
        manualFeedbackFixture({ reporterNote: "The protagonist should sound harsher here." }),
      );
      const objective = await feedbackRepo.importManualFeedback(
        localActor,
        manualFeedbackFixture({
          feedbackType: feedbackTypeValues.objectiveDefect,
          reporterNote: "The line has a typo in the player-facing text.",
          attachments: [
            {
              attachmentKind: "screenshot",
              artifactId: "feedback-screenshot-typo",
              uri: "fixture://feedback/screenshot/typo",
              capturePosition: "hello.scene.001:frame002",
            },
          ],
        }),
      );

      expect(style.triageLabel).toBe(feedbackTriageLabelValues.styleDisputeCandidate);
      expect(objective.triageLabel).toBe(feedbackTriageLabelValues.objectiveDefectCandidate);
    } finally {
      await context.close();
    }
  });

  it("does not aggregate different feedback types with the same explicit dedupe key", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db);
      const feedbackRepo = new ItotoriFeedbackRepository(context.db);
      await repo.reset(localActor);
      await repo.importSourceBundle(localActor, projectFixture());

      const style = await feedbackRepo.importManualFeedback(
        localActor,
        manualFeedbackFixture({
          dedupeKey: "external-ticket-123",
          reporterNote: "The protagonist should sound less formal here.",
        }),
      );
      const objective = await feedbackRepo.importManualFeedback(
        localActor,
        manualFeedbackFixture({
          dedupeKey: "external-ticket-123",
          feedbackType: feedbackTypeValues.objectiveDefect,
          reporterNote: "The player-facing line contains the wrong term.",
        }),
      );

      expect(style.dedupeKey).not.toBe(objective.dedupeKey);
      expect(objective).toMatchObject({
        duplicate: false,
        reportCount: 1,
        triageLabel: feedbackTriageLabelValues.objectiveDefectCandidate,
      });

      const reports = await context.db
        .select()
        .from(feedbackReports)
        .where(eq(feedbackReports.projectId, "project-test"));
      expect(reports).toHaveLength(2);
      expect(new Set(reports.map((report) => report.feedbackType))).toEqual(
        new Set([feedbackTypeValues.stylePreference, feedbackTypeValues.objectiveDefect]),
      );

      const evidence = await context.db
        .select()
        .from(feedbackReportEvidence)
        .where(eq(feedbackReportEvidence.feedbackReportId, objective.feedbackReportId))
        .limit(1);
      expect(evidence[0]?.metadata).toMatchObject({
        importedFeedbackType: feedbackTypeValues.objectiveDefect,
      });
    } finally {
      await context.close();
    }
  });

  it("aggregates duplicate manual feedback evidence under one canonical report", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db);
      const feedbackRepo = new ItotoriFeedbackRepository(context.db);
      await repo.reset(localActor);
      await repo.importSourceBundle(localActor, projectFixture());

      const first = await feedbackRepo.importManualFeedback(
        localActor,
        manualFeedbackFixture({ feedbackReportId: "feedback-formal-tone" }),
      );
      const second = await feedbackRepo.importManualFeedback(
        localActor,
        manualFeedbackFixture({
          feedbackReportId: "feedback-formal-tone-copy",
          feedbackEvidenceId: "feedback-formal-tone-evidence-2",
          reporter: { role: "playtester", displayName: "Second fixture reviewer" },
          attachments: [
            {
              attachmentKind: "screenshot",
              artifactId: "feedback-screenshot-duplicate",
              uri: "fixture://feedback/screenshot/formal-tone-2",
              hash: "sha256:feedback-screenshot-duplicate",
              caption: "same formal tone issue from another frame",
              capturePosition: "hello.scene.001:frame003",
            },
          ],
          reportedAt: "2026-06-17T00:05:00.000Z",
        }),
      );

      expect(second).toMatchObject({
        duplicate: true,
        feedbackReportId: first.feedbackReportId,
        reportCount: 2,
      });

      const reports = await context.db
        .select()
        .from(feedbackReports)
        .where(eq(feedbackReports.dedupeKey, first.dedupeKey));
      expect(reports).toHaveLength(1);
      expect(reports[0]?.reportCount).toBe(2);

      const evidence = await context.db
        .select()
        .from(feedbackReportEvidence)
        .where(eq(feedbackReportEvidence.feedbackReportId, first.feedbackReportId));
      expect(evidence).toHaveLength(2);

      const duplicateEvent = await context.db
        .select()
        .from(events)
        .where(eq(events.eventKind, "feedback_report_duplicate_aggregated"))
        .limit(1);
      expect(duplicateEvent[0]?.payload).toMatchObject({
        duplicate: true,
        reportCount: 2,
      });
    } finally {
      await context.close();
    }
  });

  it("bootstraps the MVP local user with every permission", async () => {
    const context = await migratedContext();
    try {
      const grants = await context.db
        .select({ permission: userPermissionGrants.permission })
        .from(userPermissionGrants)
        .where(eq(userPermissionGrants.userId, localUserId));

      expect(new Set(grants.map((grant) => grant.permission))).toEqual(new Set(allPermissions));
    } finally {
      await context.close();
    }
  });

  it("rejects repository mutations without the required permission", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db);

      await expect(
        repo.importSourceBundle({ userId: "user-without-grants" }, projectFixture()),
      ).rejects.toMatchObject({
        name: "AuthorizationError",
        permission: permissionValues.projectImport,
      });
    } finally {
      await context.close();
    }
  });

  it("creates indexes for common project, branch, event, finding, and artifact lookups", async () => {
    const context = await migratedContext();
    try {
      const result = await context.db.execute(sql`
        select indexname
        from pg_indexes
        where schemaname = current_schema()
          and indexname in (
            'itotori_source_units_project_locale_key_idx',
            'itotori_source_bundles_revision_idx',
            'itotori_events_project_branch_time_idx',
            'itotori_findings_project_branch_status_idx',
            'itotori_artifacts_project_branch_kind_idx'
          )
      `);
      expect(new Set(result.rows.map((row) => String(row.indexname)))).toEqual(
        new Set([
          "itotori_source_units_project_locale_key_idx",
          "itotori_source_bundles_revision_idx",
          "itotori_events_project_branch_time_idx",
          "itotori_findings_project_branch_status_idx",
          "itotori_artifacts_project_branch_kind_idx",
        ]),
      );
    } finally {
      await context.close();
    }
  });

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

async function migratedContext() {
  return isolatedMigratedContext();
}

function requiredDatabaseUrl(): string {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for DB-backed repository tests");
  }
  return process.env.DATABASE_URL;
}

function migrationSql(file: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "..", "migrations", file), "utf8");
}

async function seedLegacyHelloWorldState(pool: pg.Pool): Promise<void> {
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

function databaseUrlWithSearchPath(databaseUrl: string, schemaName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`invalid SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}
