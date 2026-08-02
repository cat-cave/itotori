import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";

import { describe, expect, it } from "vitest";
import type { RuntimeEvidenceReportV02 } from "@itotori/localization-bridge-schema";

import { ItotoriProjectRepository } from "../src/repositories/project-repository.js";

import {
  failedRuntimeEvidenceReportFixture,
  localActor,
  projectFixture,
  projectFixtureUnitId,
  requiredFixtureValue,
  runtimeEvidenceReportFixture,
} from "./repository.test.shared.js";
import { migratedContext } from "./repository.test.legacy.js";

describe("ItotoriProjectRepository", () => {
  it("namespaces repeated runtime evidence child ids across reports", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
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
      const baseReport = runtimeEvidenceReportFixture();
      const baseCapabilities = requiredFixtureValue(
        baseReport.runtimeCapabilities,
        "runtime capability contract",
      );
      const baseSession = requiredFixtureValue(
        baseReport.controlledPlaybackSession,
        "runtime controlled playback session",
      );
      const replayCapabilities = {
        ...baseCapabilities,
        capabilityClass: "partial_vm",
        fidelityTierCeiling: "replay_review",
        evidenceTierCeiling: "E3",
        features: [
          ...baseCapabilities.features.filter((feature) => feature.feature !== "recording"),
          {
            feature: "branch_discovery",
            status: "supported",
            evidenceTierCeiling: "E3",
            description: "Discovers fixture branch metadata.",
            limitations: [],
          },
          {
            feature: "recording",
            status: "supported",
            evidenceTierCeiling: "E3",
            description: "Records fixture playback evidence.",
            limitations: [],
          },
          {
            feature: "reference_comparison",
            status: "partial",
            evidenceTierCeiling: "E3",
            description: "Compares fixture runtime evidence.",
            limitations: ["No reference-fidelity claim is made."],
          },
        ],
      } satisfies NonNullable<RuntimeEvidenceReportV02["runtimeCapabilities"]>;
      const replaySession = {
        ...baseSession,
        capabilityClass: "partial_vm",
        requestedOperation: "smoke_validation",
        status: "failed",
        fidelityTier: "replay_review",
        evidenceTier: "E3",
        featuresUsed: [
          "static_trace",
          "text_trace",
          "branch_discovery",
          "frame_capture",
          "recording",
          "reference_comparison",
        ],
      } satisfies NonNullable<RuntimeEvidenceReportV02["controlledPlaybackSession"]>;

      const reportWithLocalIds = (
        runtimeReportId: string,
        createdAt: string,
      ): RuntimeEvidenceReportV02 =>
        failedRuntimeEvidenceReportFixture({
          runtimeReportId,
          createdAt,
          fidelityTier: "replay_review",
          evidenceTier: "E3",
          runtimeCapabilities: replayCapabilities,
          controlledPlaybackSession: replaySession,
          traceEvents: [
            {
              traceEventId,
              eventKind: "text_observed",
              bridgeUnitRef: {
                bridgeUnitId: projectFixtureUnitId,
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
                bridgeUnitId: projectFixtureUnitId,
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
                    bridgeUnitId: projectFixtureUnitId,
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
                bridgeUnitId: projectFixtureUnitId,
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
                bridgeUnitId: projectFixtureUnitId,
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
                  bridgeUnitId: projectFixtureUnitId,
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
                  bridgeUnitId: projectFixtureUnitId,
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
                bridgeUnitId: projectFixtureUnitId,
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
});
