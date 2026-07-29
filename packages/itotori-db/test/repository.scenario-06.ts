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
  it("returns distinct per-artifactKind runtime capture scalars (frame-capture vs screenshot, not double-counted)", async () => {
    // DAG-node-runtime-status-double-counted-capture-scalars-on-wire: the
    // runtime status API scalars historically resolved both
    // frameCaptureCount and screenshotArtifactCount to the SAME
    // capture_count column on itotori_runtime_evidence_runs, so a single
    // capture was reported as BOTH a frame-capture AND a screenshot on the
    // wire. Each capture is in fact ONE artifact with a single
    // artifact_kind (legacy RuntimeVerificationReport -> frame_capture;
    // RuntimeEvidenceReportV02 -> screenshot). This fixture proves the
    // repository now returns the REAL per-artifactKind counts.
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);
      const project = projectFixture();
      await repo.importSourceBundle(localActor, project);

      // V02 run with 3 captures -> 3 screenshot artifacts, 0 frame_capture artifacts.
      const v02ReportId = "019ed003-0000-7000-8000-000000000b01";
      await repo.saveRuntimeReport(
        localActor,
        project,
        runtimeEvidenceReportFixture({
          runtimeReportId: v02ReportId,
          createdAt: "2026-06-17T00:30:00.000Z",
          captures: [
            {
              captureId: "019ed003-0000-7000-8000-000000000b11",
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
                artifactId: "019ed003-0000-7000-8000-000000000b21",
                artifactKind: "screenshot",
                uri: `artifacts/utsushi/runtime/${v02ReportId}/screenshots/019ed003-0000-7000-8000-000000000b21.png`,
                mediaType: "image/png",
              },
            },
            {
              captureId: "019ed003-0000-7000-8000-000000000b12",
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
                artifactId: "019ed003-0000-7000-8000-000000000b22",
                artifactKind: "screenshot",
                uri: `artifacts/utsushi/runtime/${v02ReportId}/screenshots/019ed003-0000-7000-8000-000000000b22.png`,
                mediaType: "image/png",
              },
            },
            {
              captureId: "019ed003-0000-7000-8000-000000000b13",
              bridgeUnitRef: {
                bridgeUnitId: "bridge-unit-test",
                sourceUnitKey: "hello.scene.001.line.001",
              },
              evidenceTier: "E2",
              frame: 3,
              width: 320,
              height: 180,
              nonZeroPixels: 57600,
              artifactRef: {
                artifactId: "019ed003-0000-7000-8000-000000000b23",
                artifactKind: "screenshot",
                uri: `artifacts/utsushi/runtime/${v02ReportId}/screenshots/019ed003-0000-7000-8000-000000000b23.png`,
                mediaType: "image/png",
              },
            },
          ],
        }),
        "019ed003-0000-7000-8000-000000000b91",
      );

      // The latest run is the V02 one (newer createdAt). Real per-kind
      // counts: 3 screenshots, 0 frame_captures. The pre-fix
      // capture-count-for-both bug would have reported
      // frameCaptureCount=3 AND screenshotArtifactCount=3.
      await expect(repo.getRuntimeStatus(localActor)).resolves.toMatchObject({
        runtimeRunId: v02ReportId,
        frameCaptureCount: 0,
        screenshotArtifactCount: 3,
      });

      const v02ArtifactCounts = await context.pool.query<{
        screenshot: number;
        frame_capture: number;
      }>(
        `
        select
          count(*) filter (where artifact_kind = 'screenshot')::int as screenshot,
          count(*) filter (where artifact_kind = 'frame_capture')::int as frame_capture
        from itotori_artifacts
        where metadata->>'runtimeReportId' = $1
      `,
        [v02ReportId],
      );
      expect(v02ArtifactCounts.rows[0]).toEqual({ screenshot: 3, frame_capture: 0 });

      // Legacy run with 2 frameCaptures -> 2 frame_capture artifacts, 0
      // screenshot artifacts. After this second save the latest run is the
      // legacy one, so getRuntimeStatus must switch to the legacy counts.
      const legacyReportId = "019ed003-0000-7000-8000-000000000c01";
      await repo.saveRuntimeReport(
        localActor,
        project,
        {
          schemaVersion: "0.1.0",
          runtimeReportId: legacyReportId,
          adapterName: "utsushi-fixture",
          fidelityTier: "layout_probe",
          status: "passed",
          textEvents: [
            {
              runtimeTextEventId: `${legacyReportId}:text-1`,
              bridgeUnitId: "bridge-unit-test",
              text: "Hello, {player}.",
              frame: 1,
            },
          ],
          frameCaptures: [
            {
              frameCaptureId: `${legacyReportId}:frame-1`,
              bridgeUnitId: "bridge-unit-test",
              width: 320,
              height: 180,
              nonZeroPixels: 57600,
              artifactPath: `artifacts/utsushi/runtime/${legacyReportId}/frames/${legacyReportId}-frame-1.png`,
            },
            {
              frameCaptureId: `${legacyReportId}:frame-2`,
              bridgeUnitId: "bridge-unit-test",
              width: 320,
              height: 180,
              nonZeroPixels: 57600,
              artifactPath: `artifacts/utsushi/runtime/${legacyReportId}/frames/${legacyReportId}-frame-2.png`,
            },
          ],
          approximations: ["fixture"],
        },
        "019ed003-0000-7000-8000-000000000c91",
      );

      await expect(repo.getRuntimeStatus(localActor)).resolves.toMatchObject({
        runtimeRunId: legacyReportId,
        frameCaptureCount: 2,
        screenshotArtifactCount: 0,
      });

      const legacyArtifactCounts = await context.pool.query<{
        screenshot: number;
        frame_capture: number;
      }>(
        `
        select
          count(*) filter (where artifact_kind = 'screenshot')::int as screenshot,
          count(*) filter (where artifact_kind = 'frame_capture')::int as frame_capture
        from itotori_artifacts
        where metadata->>'runtimeReportId' = $1
      `,
        [legacyReportId],
      );
      expect(legacyArtifactCounts.rows[0]).toEqual({ screenshot: 0, frame_capture: 2 });
    } finally {
      await context.close();
    }
  });
});
