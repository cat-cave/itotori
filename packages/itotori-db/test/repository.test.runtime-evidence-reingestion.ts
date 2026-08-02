import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";

import { describe, expect, it } from "vitest";

import { ItotoriProjectRepository } from "../src/repositories/project-repository.js";

import {
  localActor,
  projectFixture,
  projectFixtureUnitId,
  runtimeEvidenceReportFixture,
} from "./repository.test.shared.js";
import { migratedContext } from "./repository.test.legacy.js";

describe("ItotoriProjectRepository", () => {
  it("replaces stale runtime evidence projections when re-ingesting a corrected report", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
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
              bridgeUnitId: projectFixtureUnitId,
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
              bridgeUnitId: projectFixtureUnitId,
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
              bridgeUnitId: projectFixtureUnitId,
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
                  bridgeUnitId: projectFixtureUnitId,
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
                bridgeUnitId: projectFixtureUnitId,
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
              bridgeUnitId: projectFixtureUnitId,
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
            findingKind: "missing_capture",
            severity: "P3",
            bridgeUnitRef: {
              bridgeUnitId: projectFixtureUnitId,
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

      await expect(repo.getRuntimeStatus(localActor)).resolves.toMatchObject({
        runtimeReportId,
        runtimeStatus: "passed",
        frameCaptureCount: 0,
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
});
