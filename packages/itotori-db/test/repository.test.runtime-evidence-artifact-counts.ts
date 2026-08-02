import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";

import { describe, expect, it } from "vitest";

import { ItotoriProjectRepository } from "../src/repositories/project-repository.js";

import {
  localActor,
  projectFixture,
  projectFixtureUnitId,
  requiredFixtureValue,
  runtimeEvidenceReportFixture,
} from "./repository.test.shared.js";
import { migratedContext } from "./repository.test.legacy.js";

describe("ItotoriProjectRepository", () => {
  it("returns current screenshot counts without populating the retired frame-capture scalar", async () => {
    // DAG-node-runtime-status-double-counted-capture-scalars-on-wire: the
    // runtime status API scalars historically resolved both
    // frameCaptureCount and screenshotArtifactCount to the SAME
    // capture_count column on itotori_runtime_evidence_runs, so a single
    // capture was reported as BOTH a frame-capture AND a screenshot on the
    // wire. Each current capture is one screenshot artifact. This fixture
    // proves the repository returns the real per-artifactKind counts.
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
                bridgeUnitId: projectFixtureUnitId,
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
                bridgeUnitId: projectFixtureUnitId,
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
                bridgeUnitId: projectFixtureUnitId,
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

      // A second current run with two captures remains screenshot-only. After
      // this save the latest run switches to the new current report.
      const secondReportId = "019ed003-0000-7000-8000-000000000c01";
      const capture = requiredFixtureValue(
        runtimeEvidenceReportFixture().captures[0],
        "runtime capture",
      );
      await repo.saveRuntimeReport(
        localActor,
        project,
        runtimeEvidenceReportFixture({
          runtimeReportId: secondReportId,
          createdAt: "2026-06-17T00:45:00.000Z",
          captures: [
            {
              ...capture,
              captureId: "019ed003-0000-7000-8000-000000000c11",
              frame: 1,
              artifactRef: {
                ...capture.artifactRef,
                artifactId: "019ed003-0000-7000-8000-000000000c21",
                uri: `artifacts/utsushi/runtime/${secondReportId}/screenshots/019ed003-0000-7000-8000-000000000c21.png`,
              },
            },
            {
              ...capture,
              captureId: "019ed003-0000-7000-8000-000000000c12",
              frame: 2,
              artifactRef: {
                ...capture.artifactRef,
                artifactId: "019ed003-0000-7000-8000-000000000c22",
                uri: `artifacts/utsushi/runtime/${secondReportId}/screenshots/019ed003-0000-7000-8000-000000000c22.png`,
              },
            },
          ],
        }),
        "019ed003-0000-7000-8000-000000000c91",
      );

      await expect(repo.getRuntimeStatus(localActor)).resolves.toMatchObject({
        runtimeRunId: secondReportId,
        frameCaptureCount: 0,
        screenshotArtifactCount: 2,
      });

      const secondArtifactCounts = await context.pool.query<{
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
        [secondReportId],
      );
      expect(secondArtifactCounts.rows[0]).toEqual({ screenshot: 2, frame_capture: 0 });
    } finally {
      await context.close();
    }
  });
});
