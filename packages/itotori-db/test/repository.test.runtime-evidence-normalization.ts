import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";

import { describe, expect, it } from "vitest";

import { ItotoriProjectRepository } from "../src/repositories/project-repository.js";

import {
  localActor,
  projectFixture,
  projectFixtureBundleRevisionId,
  projectFixtureUnitId,
  runtimeEvidenceReportFixture,
} from "./repository.test.shared.js";
import { migratedContext } from "./repository.test.legacy.js";

describe("ItotoriProjectRepository", () => {
  it("normalizes multiple runtime evidence runs with validation findings", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
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
                bridgeUnitId: projectFixtureUnitId,
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
                bridgeUnitId: projectFixtureUnitId,
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
                  bridgeUnitId: projectFixtureUnitId,
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
                bridgeUnitId: projectFixtureUnitId,
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
          source_bundle_revision_id: projectFixtureBundleRevisionId,
          runtime_report_artifact_id: "019ed003-0000-7000-8000-000000000901",
          patch_result_artifact_id: "019ed003-0000-7000-8000-000000000981",
          validation_finding_count: 0,
        },
        {
          runtime_run_id: "019ed003-0000-7000-8000-000000000902",
          status: "failed",
          source_bundle_revision_id: projectFixtureBundleRevisionId,
          runtime_report_artifact_id: "019ed003-0000-7000-8000-000000000902",
          patch_result_artifact_id: "019ed003-0000-7000-8000-000000000982",
          validation_finding_count: 1,
        },
      ]);

      await expect(repo.getRuntimeStatus(localActor)).resolves.toMatchObject({
        finalStatus: "hello_world_failed",
        runtimeReportId: "019ed003-0000-7000-8000-000000000902",
        runtimeStatus: "failed",
        validationFindingCount: 1,
      });

      await expect(
        repo.getRuntimeStatus(localActor, "019ed003-0000-7000-8000-000000000901"),
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
          bridge_unit_id: projectFixtureUnitId,
          artifact_id: null,
          portable_artifact_uri: null,
        },
        {
          runtime_evidence_id:
            "019ed003-0000-7000-8000-000000000902:019ed003-0000-7000-8000-000000000922",
          evidence_kind: "capture",
          bridge_unit_id: projectFixtureUnitId,
          artifact_id: "019ed003-0000-7000-8000-000000000902:019ed003-0000-7000-8000-000000000933",
          portable_artifact_uri:
            "artifacts/utsushi/runtime/019ed003-0000-7000-8000-000000000902/screenshots/019ed003-0000-7000-8000-000000000933.png",
        },
        {
          runtime_evidence_id:
            "019ed003-0000-7000-8000-000000000902:019ed003-0000-7000-8000-000000000912",
          evidence_kind: "trace_event",
          bridge_unit_id: projectFixtureUnitId,
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
        { ref_role: "affected", bridge_unit_id: projectFixtureUnitId },
        { ref_role: "primary", bridge_unit_id: projectFixtureUnitId },
        { ref_role: "primary", bridge_unit_id: projectFixtureUnitId },
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
        bridge_unit_id: projectFixtureUnitId,
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
});
