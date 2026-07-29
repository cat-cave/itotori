import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";

import { describe, expect, it } from "vitest";

import { ItotoriProjectRepository } from "../src/repositories/project-repository.js";

import { localActor, projectFixture } from "./repository.test.shared.js";
import { migratedContext } from "./repository.test.legacy.js";

describe("ItotoriProjectRepository", () => {
  it("persists v0.2 runtime evidence tiers and bridge-linked evidence artifacts", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);
      const project = projectFixture();
      project.drafts = {
        ...project.drafts,
        "bridge-unit-branch-label": "Stay",
        "bridge-unit-branch-target": "Stayed route starts.",
      };
      project.bridge.units = [
        ...project.bridge.units,
        {
          bridgeUnitId: "bridge-unit-branch-label",
          sourceUnitKey: "hello.scene.001.choice.001.label",
          occurrenceId: "occurrence-branch-label",
          sourceHash: "source-hash-branch-label",
          sourceLocale: "ja-JP",
          sourceText: "Stay label source.",
          textSurface: "dialogue",
          protectedSpans: [],
          patchRef: {
            assetId: "source.json",
            writeMode: "replace",
            sourceUnitKey: "hello.scene.001.choice.001.label",
          },
        },
        {
          bridgeUnitId: "bridge-unit-branch-target",
          sourceUnitKey: "hello.scene.001.route.stay.001",
          occurrenceId: "occurrence-branch-target",
          sourceHash: "source-hash-branch-target",
          sourceLocale: "ja-JP",
          sourceText: "Stayed route source.",
          textSurface: "dialogue",
          protectedSpans: [],
          patchRef: {
            assetId: "source.json",
            writeMode: "replace",
            sourceUnitKey: "hello.scene.001.route.stay.001",
          },
        },
      ];
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
                    bridgeUnitId: "bridge-unit-branch-label",
                    sourceUnitKey: "hello.scene.001.choice.001.label",
                  },
                  targetRouteKey: "hello.stay",
                  targetBridgeUnitRef: {
                    bridgeUnitId: "bridge-unit-branch-target",
                    sourceUnitKey: "hello.scene.001.route.stay.001",
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

      const runtimeStatus = await repo.getRuntimeStatus(localActor);
      expect(runtimeStatus).toMatchObject({
        runtimeRunId: "019ed003-0000-7000-8000-000000000001",
        runtimeReportId: "019ed003-0000-7000-8000-000000000001",
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

      const branchEventEvidence = await context.pool.query<{
        metadata: {
          event?: unknown;
        };
      }>("select metadata from itotori_runtime_evidence_items where runtime_evidence_id = $1", [
        "019ed003-0000-7000-8000-000000000001:019ed003-0000-7000-8000-000000000201",
      ]);
      expect(branchEventEvidence.rows[0]?.metadata.event).toEqual({
        branchEventId: "019ed003-0000-7000-8000-000000000201",
        bridgeUnitRef: {
          bridgeUnitId: "bridge-unit-test",
          sourceUnitKey: "hello.scene.001.line.001",
        },
        frame: 2,
        branchPointKey: "hello.choice.001",
        promptText: "Choose a route",
        selectedOptionId: "019ed003-0000-7000-8000-000000000211",
        options: [
          {
            optionId: "019ed003-0000-7000-8000-000000000211",
            label: "Stay",
            labelBridgeUnitRef: {
              bridgeUnitId: "bridge-unit-branch-label",
              sourceUnitKey: "hello.scene.001.choice.001.label",
            },
            targetRouteKey: "hello.stay",
            targetBridgeUnitRef: {
              bridgeUnitId: "bridge-unit-branch-target",
              sourceUnitKey: "hello.scene.001.route.stay.001",
            },
          },
        ],
      });

      const branchUnitRefs = await context.pool.query<{
        ref_role: string;
        bridge_unit_id: string;
        source_unit_key: string;
        metadata: Record<string, unknown>;
      }>(
        `
        select ref_role, bridge_unit_id, source_unit_key, metadata
        from itotori_runtime_evidence_bridge_unit_refs
        where runtime_evidence_id = $1
        order by ref_role
      `,
        ["019ed003-0000-7000-8000-000000000001:019ed003-0000-7000-8000-000000000201"],
      );
      expect(branchUnitRefs.rows).toEqual([
        {
          ref_role: "branch_label",
          bridge_unit_id: "bridge-unit-branch-label",
          source_unit_key: "hello.scene.001.choice.001.label",
          metadata: { optionId: "019ed003-0000-7000-8000-000000000211" },
        },
        {
          ref_role: "branch_target",
          bridge_unit_id: "bridge-unit-branch-target",
          source_unit_key: "hello.scene.001.route.stay.001",
          metadata: { optionId: "019ed003-0000-7000-8000-000000000211" },
        },
        {
          ref_role: "primary",
          bridge_unit_id: "bridge-unit-test",
          source_unit_key: "hello.scene.001.line.001",
          metadata: {},
        },
      ]);
    } finally {
      await context.close();
    }
  });
});
