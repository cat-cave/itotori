import { describe, expect, it } from "vitest";
import type { BridgeBundle } from "@itotori/localization-bridge-schema";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import {
  ItotoriProjectRepository,
  type ItotoriProjectRecord,
} from "../src/repositories/project-repository.js";
import {
  ItotoriSceneSummaryRepository,
  sceneSummaryInvalidatedReasonValues,
  sceneSummaryStatusValues,
  type SaveSceneSummaryInput,
} from "../src/repositories/scene-summary-repository.js";
import { sourceUnits } from "../src/schema.js";
import { eq } from "drizzle-orm";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

const PROJECT_ID = "project-scene-summary";
const LOCALE_BRANCH_ID = "locale-scene-summary";
const SOURCE_REVISION_ID = "bridge-scene-summary:bundle-revision";

describe("ItotoriSceneSummaryRepository", () => {
  it("round-trips a Fresh summary with citations and replaces on re-save at the same template version", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.importSourceBundle(localActor, fixtureProject());
      const repository = new ItotoriSceneSummaryRepository(context.db);

      const input = sceneSummaryInputFixture("scene-1", "summary-1");
      const saved = await repository.saveSummary(localActor, input);
      expect(saved.status).toBe(sceneSummaryStatusValues.fresh);
      expect(saved.citations).toHaveLength(2);
      expect(saved.citations.map((c) => c.bridgeUnitId)).toEqual(["unit-1", "unit-2"]);
      expect(saved.citations.map((c) => c.citeOrdinal)).toEqual([1, 2]);

      // Re-save replaces the row at the same unique key.
      const replacement: SaveSceneSummaryInput = {
        ...input,
        sceneSummaryId: "summary-1b",
        summaryText: "replacement summary",
      };
      const replaced = await repository.saveSummary(localActor, replacement);
      expect(replaced.sceneSummaryId).toBe("summary-1b");

      const loaded = await repository.loadSummaryByScene(localActor, {
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        sourceRevisionId: SOURCE_REVISION_ID,
        sceneId: "scene-1",
      });
      expect(loaded?.sceneSummaryId).toBe("summary-1b");
      expect(loaded?.summaryText).toBe("replacement summary");

      const all = await repository.loadSummaries(localActor, {
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        sourceRevisionId: SOURCE_REVISION_ID,
      });
      expect(all).toHaveLength(1);
    } finally {
      await context.close();
    }
  });

  it("supports multiple template versions for the same scene without conflict", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.importSourceBundle(localActor, fixtureProject());
      const repository = new ItotoriSceneSummaryRepository(context.db);

      const v1 = sceneSummaryInputFixture("scene-1", "summary-v1");
      await repository.saveSummary(localActor, v1);
      const v2: SaveSceneSummaryInput = {
        ...sceneSummaryInputFixture("scene-1", "summary-v2"),
        promptTemplateVersion: "itotori-scene-summary-v2",
      };
      await repository.saveSummary(localActor, v2);

      const all = await repository.loadSummaries(localActor, {
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        sourceRevisionId: SOURCE_REVISION_ID,
        sceneId: "scene-1",
      });
      expect(all).toHaveLength(2);

      const filtered = await repository.loadSummaries(localActor, {
        projectId: PROJECT_ID,
        promptTemplateVersion: "itotori-scene-summary-v2",
      });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]!.summaryText).toContain("scene-1");
    } finally {
      await context.close();
    }
  });

  it("markStale flips status idempotently and only for Fresh rows", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.importSourceBundle(localActor, fixtureProject());
      const repository = new ItotoriSceneSummaryRepository(context.db);
      const saved = await repository.saveSummary(
        localActor,
        sceneSummaryInputFixture("scene-1", "summary-1"),
      );

      await repository.markStale(localActor, {
        sceneSummaryId: saved.sceneSummaryId,
        reason: sceneSummaryInvalidatedReasonValues.sourceHashDrift,
      });
      const afterFirst = await repository.loadSummaryByScene(localActor, {
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        sourceRevisionId: SOURCE_REVISION_ID,
        sceneId: "scene-1",
      });
      expect(afterFirst?.status).toBe(sceneSummaryStatusValues.stale);
      expect(afterFirst?.invalidatedReason).toBe(
        sceneSummaryInvalidatedReasonValues.sourceHashDrift,
      );
      expect(afterFirst?.invalidatedAt).not.toBeNull();

      // Second call is a no-op (no Fresh row remaining).
      await repository.markStale(localActor, {
        sceneSummaryId: saved.sceneSummaryId,
        reason: sceneSummaryInvalidatedReasonValues.manual,
      });
      const afterSecond = await repository.loadSummaryByScene(localActor, {
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        sourceRevisionId: SOURCE_REVISION_ID,
        sceneId: "scene-1",
      });
      expect(afterSecond?.invalidatedReason).toBe(
        sceneSummaryInvalidatedReasonValues.sourceHashDrift,
      );
    } finally {
      await context.close();
    }
  });

  it("currentSourceHashesForBridgeUnits reflects DB-side source hashes", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.importSourceBundle(localActor, fixtureProject());
      const repository = new ItotoriSceneSummaryRepository(context.db);

      const before = await repository.currentSourceHashesForBridgeUnits(localActor, {
        bridgeUnitIds: ["unit-1", "unit-2"],
      });
      expect(before.get("unit-1")).toBe("hash-1");
      expect(before.get("unit-2")).toBe("hash-2");

      await context.db
        .update(sourceUnits)
        .set({ sourceHash: "hash-1-mutated" })
        .where(eq(sourceUnits.bridgeUnitId, "unit-1"));

      const after = await repository.currentSourceHashesForBridgeUnits(localActor, {
        bridgeUnitIds: ["unit-1", "unit-2"],
      });
      expect(after.get("unit-1")).toBe("hash-1-mutated");
      expect(after.get("unit-2")).toBe("hash-2");
    } finally {
      await context.close();
    }
  });

  it("loadBridgeUnitsForSummary returns canonical source text and speaker", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.importSourceBundle(localActor, fixtureProject());
      const repository = new ItotoriSceneSummaryRepository(context.db);

      const map = await repository.loadBridgeUnitsForSummary(localActor, {
        bridgeUnitIds: ["unit-1", "unit-2"],
      });
      expect(map.get("unit-1")?.sourceText).toBe("こんにちは");
      expect(map.get("unit-2")?.sourceText).toBe("さようなら");
    } finally {
      await context.close();
    }
  });
});

function fixtureProject(): ItotoriProjectRecord {
  const bridge: BridgeBundle = {
    schemaVersion: "0.1.0",
    bridgeId: "bridge-scene-summary",
    sourceBundleHash: "hash-scene-summary",
    sourceLocale: "ja-JP",
    extractorName: "kaifuu-fixture",
    extractorVersion: "0.0.0",
    units: [
      {
        bridgeUnitId: "unit-1",
        sourceUnitKey: "scene.001.line.001",
        occurrenceId: "occ-1",
        sourceHash: "hash-1",
        sourceLocale: "ja-JP",
        sourceText: "こんにちは",
        textSurface: "dialogue",
        protectedSpans: [],
        patchRef: {
          assetId: "asset.json",
          writeMode: "replace",
          sourceUnitKey: "scene.001.line.001",
        },
      },
      {
        bridgeUnitId: "unit-2",
        sourceUnitKey: "scene.001.line.002",
        occurrenceId: "occ-2",
        sourceHash: "hash-2",
        sourceLocale: "ja-JP",
        sourceText: "さようなら",
        textSurface: "dialogue",
        protectedSpans: [],
        patchRef: {
          assetId: "asset.json",
          writeMode: "replace",
          sourceUnitKey: "scene.001.line.002",
        },
      },
    ],
  };
  return {
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
    targetLocale: "en-US",
    drafts: {},
    bridge,
  };
}

function sceneSummaryInputFixture(sceneId: string, sceneSummaryId: string): SaveSceneSummaryInput {
  return {
    sceneSummaryId,
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
    sourceRevisionId: SOURCE_REVISION_ID,
    sceneId,
    summaryLocale: "ja-JP",
    summaryText: `${sceneId} の要約`,
    modelProviderFamily: "fake",
    modelId: "itotori-fake-scene-summary-v0",
    modelContextWindowTokens: 16000,
    modelMaxOutputTokens: 256,
    promptTemplateVersion: "itotori-scene-summary-v1",
    promptHash: "0123456789abcdef".repeat(4),
    inputTokenEstimate: 42,
    completionTokens: 12,
    generatedAt: new Date("2026-06-23T12:00:00Z"),
    citations: [
      { bridgeUnitId: "unit-1", citedSourceHash: "hash-1", citeOrdinal: 1 },
      { bridgeUnitId: "unit-2", citedSourceHash: "hash-2", citeOrdinal: 2 },
    ],
  };
}
