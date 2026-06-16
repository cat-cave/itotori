import { describe, expect, it } from "vitest";
import { createDatabaseContext } from "../src/connection.js";
import { migrate } from "../src/migrations.js";
import {
  HelloWorldRepository,
  type ProjectRecord,
} from "../src/repositories/hello-world-repository.js";

describe("HelloWorldRepository", () => {
  it("persists and reads hello-world status against Postgres", async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required for DB-backed repository tests");
    }

    await migrate(process.env.DATABASE_URL);
    const context = createDatabaseContext(process.env.DATABASE_URL);
    try {
      const repo = new HelloWorldRepository(context.db);
      await repo.reset();
      const project: ProjectRecord = {
        projectId: "project-test",
        localeBranchId: "locale-test",
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
                { kind: "placeholder", raw: "{player}", start: 6, end: 14, preserveMode: "exact" },
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

      await repo.saveImportedProject(project);
      await repo.saveDrafts(project);
      await repo.savePatchExport(project, {
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

      expect(status.finalStatus).toBe("hello_world_passed");
      expect(status.unitCount).toBe(1);
      expect(status.translatedUnitCount).toBe(1);
      expect(status.runtimeReportId).toBe("runtime-test");
    } finally {
      await context.close();
    }
  });
});
