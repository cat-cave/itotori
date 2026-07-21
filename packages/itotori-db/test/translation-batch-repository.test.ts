import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";
import { describe, expect, it } from "vitest";
import type { BridgeBundle } from "@itotori/localization-bridge-schema";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import {
  ItotoriProjectRepository,
  type ItotoriProjectRecord,
} from "../src/repositories/project-repository.js";
import {
  ItotoriTranslationBatchRepository,
  type SaveTranslationBatchesInput,
} from "../src/repositories/translation-batch-repository.js";
import {
  translationBatchContextRefInclusionReasonValues,
  translationBatchContextRefKindValues,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

describe("ItotoriTranslationBatchRepository", () => {
  it("round-trips batches, units, and context refs and replaces them on re-save", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
      await projectRepository.importSourceBundle(localActor, fixtureProject());
      const repository = new ItotoriTranslationBatchRepository(context.db);

      const saveInput = batchesFixture();
      const saved = await repository.saveBatches(localActor, saveInput);
      expect(saved).toHaveLength(2);

      const loaded = await repository.loadBatches(localActor, {
        projectId: saveInput.projectId,
        localeBranchId: saveInput.localeBranchId,
        sourceRevisionId: saveInput.sourceRevisionId,
      });
      expect(loaded).toHaveLength(2);
      expect(loaded.map((batch) => batch.batchOrdinal)).toEqual([1, 2]);
      const first = loaded[0]!;
      expect(first.units.map((unit) => unit.bridgeUnitId)).toEqual(["unit-1"]);
      expect(
        first.contextRefs.find(
          (ref) => ref.refKind === translationBatchContextRefKindValues.glossaryTerm,
        ),
      ).toBeDefined();
      // ITOTORI-220 — the pinned provider half of the (modelId, providerId)
      // pair survives the save/load round-trip; it is the real provider, not
      // dropped and never the "unknown" sentinel.
      expect(first.providerId).toBe("fake-fixture");
      expect(first.providerId).not.toBe("unknown");
      expect(loaded[1]!.providerId).toBe("fake-fixture");
      expect(first.modelTargetFillRatio).toBeCloseTo(0.7, 3);
      expect(first.modelContextWindowTokens).toBe(8000);
      expect(first.nearCapWarning).toBe(false);
      expect(first.tokenEstimate).toBe(100);
      expect(first.tokenBudgetCap).toBe(1000);

      const single = await repository.loadBatchById(localActor, first.batchId);
      expect(single?.batchId).toBe(first.batchId);
      expect(single?.units).toHaveLength(1);
      expect(single?.contextRefs).toHaveLength(1);

      // Re-save replaces existing batches for the triple.
      const replacementInput: SaveTranslationBatchesInput = {
        ...saveInput,
        batches: [saveInput.batches[0]!],
      };
      const replaced = await repository.saveBatches(localActor, replacementInput);
      expect(replaced).toHaveLength(1);
      const reloaded = await repository.loadBatches(localActor, {
        projectId: saveInput.projectId,
        localeBranchId: saveInput.localeBranchId,
        sourceRevisionId: saveInput.sourceRevisionId,
      });
      expect(reloaded).toHaveLength(1);
    } finally {
      await context.close();
    }
  });

  it("filters by sceneId when supplied", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
      await projectRepository.importSourceBundle(localActor, fixtureProject());
      const repository = new ItotoriTranslationBatchRepository(context.db);
      const input = batchesFixture();
      await repository.saveBatches(localActor, input);

      const sceneOne = await repository.loadBatches(localActor, {
        projectId: input.projectId,
        sceneId: "scene-1",
      });
      expect(sceneOne).toHaveLength(1);
      expect(sceneOne[0]!.batchOrdinal).toBe(1);
    } finally {
      await context.close();
    }
  });
});

function fixtureProject(): ItotoriProjectRecord {
  const bridge: BridgeBundle = {
    schemaVersion: "0.1.0",
    bridgeId: "bridge-tbatch",
    sourceBundleHash: "hash-tbatch",
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
        sourceUnitKey: "scene.002.line.001",
        occurrenceId: "occ-2",
        sourceHash: "hash-2",
        sourceLocale: "ja-JP",
        sourceText: "さようなら",
        textSurface: "dialogue",
        protectedSpans: [],
        patchRef: {
          assetId: "asset.json",
          writeMode: "replace",
          sourceUnitKey: "scene.002.line.001",
        },
      },
    ],
  };
  return {
    projectId: "project-tbatch",
    engineFamily: "synthetic_fixture",
    sourceRoot: "/workspace/source",
    buildRoot: "/workspace/build",
    extractProfile: { adapter: "fixture" },
    localeBranchId: "locale-tbatch",
    targetLocale: "en-US",
    drafts: {},
    bridge,
  };
}

function batchesFixture(): SaveTranslationBatchesInput {
  return {
    projectId: "project-tbatch",
    localeBranchId: "locale-tbatch",
    sourceRevisionId: "bridge-tbatch:bundle-revision",
    batches: [
      {
        batchId: "019ed018-0000-7000-8000-000000000201",
        batchOrdinal: 1,
        tokenEstimate: 100,
        tokenBudgetCap: 1000,
        sceneId: "scene-1",
        sceneSplitIndex: null,
        routeId: null,
        modelProviderFamily: "fake",
        modelId: "fake-test",
        providerId: "fake-fixture",
        modelContextWindowTokens: 8000,
        modelMaxOutputTokens: 1024,
        modelTargetFillRatio: 0.7,
        modelPromptOverheadTokens: 200,
        tokenEstimatorId: "itotori-batch-estimator-v1",
        nearCapWarning: false,
        generatedAt: new Date("2026-06-23T00:00:00Z"),
        units: [
          {
            bridgeUnitId: "unit-1",
            sourceUnitKey: "scene.001.line.001",
            sourceHash: "hash-1",
            unitOrdinal: 1,
          },
        ],
        contextRefs: [
          {
            refKind: translationBatchContextRefKindValues.glossaryTerm,
            refId: "term-1",
            refSecondaryId: "",
            inclusionReason: translationBatchContextRefInclusionReasonValues.hit,
            hitBridgeUnitIds: ["unit-1"],
            details: { termKey: "test", preferredSourceForm: "こんにちは" },
          },
        ],
      },
      {
        batchId: "019ed018-0000-7000-8000-000000000202",
        batchOrdinal: 2,
        tokenEstimate: 90,
        tokenBudgetCap: 1000,
        sceneId: "scene-2",
        sceneSplitIndex: null,
        routeId: null,
        modelProviderFamily: "fake",
        modelId: "fake-test",
        providerId: "fake-fixture",
        modelContextWindowTokens: 8000,
        modelMaxOutputTokens: 1024,
        modelTargetFillRatio: 0.7,
        modelPromptOverheadTokens: 200,
        tokenEstimatorId: "itotori-batch-estimator-v1",
        nearCapWarning: false,
        generatedAt: new Date("2026-06-23T00:00:00Z"),
        units: [
          {
            bridgeUnitId: "unit-2",
            sourceUnitKey: "scene.002.line.001",
            sourceHash: "hash-2",
            unitOrdinal: 1,
          },
        ],
        contextRefs: [],
      },
    ],
  };
}
