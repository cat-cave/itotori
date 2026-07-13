import { describe, expect, it, vi } from "vitest";
import { wikiContextEntryFixture } from "./api-fixtures.js";
import { WikiBrainService } from "../src/wiki/service.js";
import type { ContextCorrectionResult } from "../src/orchestrator/context-correction-service.js";

describe("WikiBrainService", () => {
  it("keeps an identical edit retry idempotent by excluding prior correction markers from semantic data", async () => {
    const persistedHead = {
      ...wikiContextEntryFixture,
      entry: {
        ...wikiContextEntryFixture.entry,
        data: {
          ...wikiContextEntryFixture.entry.data,
          correctionId: "context-correction-prior",
          correctionKind: "scene_summary",
        },
      },
    };
    const showEntry = vi.fn(async () => persistedHead);
    const apply = vi.fn(async (input) => {
      const correction: ContextCorrectionResult = {
        correctionId: `context-correction-${JSON.stringify(input.data)}`,
        contextArtifact: {
          contextArtifactId: "context-artifact-hero-scene",
          headVersionId: "context-version-hero-scene-2",
        } as ContextCorrectionResult["contextArtifact"],
        affectedUnitIds: ["bridge-unit-1"],
        invalidatedArtifactIds: [],
        redraftJob: { jobId: "context-redraft-job-2" } as ContextCorrectionResult["redraftJob"],
      };
      return correction;
    });
    const service = new WikiBrainService({
      readRepository: {
        listEntries: vi.fn(),
        showEntry,
        listEntryHistory: vi.fn(),
      },
      contextCorrections: { apply },
      now: () => new Date("2026-07-12T00:00:00.000Z"),
    });
    const edit = {
      projectId: "project-1",
      localeBranchId: "locale-1",
      contextArtifactId: "context-artifact-hero-scene",
      body: "The corrected canonical scene fact.",
      reason: "Playtest retry.",
    };

    const first = await service.edit(edit);
    const retry = await service.edit(edit);

    expect(first.correctionId).toBe(retry.correctionId);
    expect(apply).toHaveBeenCalledTimes(2);
    for (const call of apply.mock.calls) {
      expect(call[0]).toMatchObject({
        kind: "scene_summary",
        sourceRevisionId: "source-revision-1",
        data: { sceneId: "scene-prologue", summaryLocale: "en-US" },
      });
      expect(call[0].data).not.toHaveProperty("correctionId");
      expect(call[0].data).not.toHaveProperty("correctionKind");
    }
  });
});
