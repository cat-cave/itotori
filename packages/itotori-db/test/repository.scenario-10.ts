import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";

import { describe, expect, it } from "vitest";
import type { RuntimeEvidenceReportV02 } from "@itotori/localization-bridge-schema";

import { ItotoriProjectRepository } from "../src/repositories/project-repository.js";

import {
  localActor,
  projectFixture,
  runtimeEvidenceReportFixture,
} from "./repository.test.shared.js";
import { migratedContext } from "./repository.test.legacy.js";

describe("ItotoriProjectRepository", () => {
  it("stores runtime artifact references without embedding artifact blobs", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
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
  it("normalizes schema-portable runtime artifact refs to managed storage refs", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);
      const project = projectFixture();
      await repo.importSourceBundle(localActor, project);

      const runtimeReportId = "019ed003-0000-7000-8000-000000000905";
      const artifactId = "019ed003-0000-7000-8000-000000000935";
      const schemaUri = "artifacts/utsushi/schema-fixture/frame-0001.png";
      const managedUri = `artifacts/utsushi/runtime/${runtimeReportId}/screenshots/${artifactId}.png`;
      const runtimeReport = runtimeEvidenceReportFixture({
        runtimeReportId,
        captures: [
          {
            ...runtimeEvidenceReportFixture().captures[0]!,
            captureId: "019ed003-0000-7000-8000-000000000925",
            artifactRef: {
              ...runtimeEvidenceReportFixture().captures[0]!.artifactRef,
              artifactId,
              uri: schemaUri,
            },
          },
        ],
      });

      await repo.saveRuntimeReport(
        localActor,
        project,
        runtimeReport,
        "019ed003-0000-7000-8000-000000000985",
      );

      const itemRows = await context.pool.query<{
        portable_artifact_uri: string | null;
        metadata: Record<string, { uri?: string }>;
      }>(
        `
        select portable_artifact_uri, metadata
        from itotori_runtime_evidence_items
        where runtime_run_id = $1
          and evidence_kind = 'capture'
        `,
        [runtimeReportId],
      );

      expect(itemRows.rows).toHaveLength(1);
      expect(itemRows.rows[0]?.portable_artifact_uri).toBe(managedUri);
      expect(itemRows.rows[0]?.metadata.artifactRef?.uri).toBe(managedUri);
      expect(itemRows.rows[0]?.metadata.adapterLocalArtifactRef?.uri).toBe(schemaUri);

      const artifactRows = await context.pool.query<{
        uri: string | null;
        metadata: Record<string, { uri?: string }>;
      }>(
        `
        select uri, metadata
        from itotori_artifacts
        where artifact_id = $1
        `,
        [`${runtimeReportId}:${artifactId}`],
      );

      expect(artifactRows.rows).toHaveLength(1);
      expect(artifactRows.rows[0]?.uri).toBe(managedUri);
      expect(artifactRows.rows[0]?.metadata.artifactRef?.uri).toBe(managedUri);
      expect(artifactRows.rows[0]?.metadata.adapterLocalArtifactRef?.uri).toBe(schemaUri);
    } finally {
      await context.close();
    }
  });
});
