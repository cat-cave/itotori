// Offline proof for the factory that sources the live workflow dependencies.
// The persistence and dispatch boundary are deliberately structural fakes: this
// test proves deterministic factory composition, not a paid provider or database
// run. A real provider/database/built-bible pass remains operational evidence.

import { describe, expect, it } from "vitest";

import type { RunPolicyRequest } from "../src/run-policy/index.js";
import { createWorkflowPorts } from "../src/composition/workflow-ports.js";
import {
  createLiveLocalizationSubstrate,
  createLiveWorkflowPortDeps,
  type LiveWorkflowFactoryConfig,
} from "../src/composition/live/index.js";
import {
  buildRb024Snapshot,
  loadBridgeBundle,
  wholeGameStructure,
} from "./support/gate-fixtures.js";

const HASH = `sha256:${"a".repeat(64)}` as const;

function factoryConfig(): LiveWorkflowFactoryConfig {
  return {
    structureJson: parseableWholeGameStructure(),
    bridge: loadBridgeBundle(),
    targetLocale: "en-US",
    scope: {
      contextSnapshotId: HASH,
      localizationSnapshotId: HASH,
      schemaHash: HASH,
      runMode: "production",
      contextScope: "whole-game",
    },
    dispatchSnapshots: {
      decodeRevisionHash: HASH,
      glossaryRevisionHash: HASH,
      styleRevisionHash: HASH,
      acceptedOutputHeadHash: null,
    },
    dispatch: {
      profile: {
        name: "draft",
        version: "fixture-profile",
        deadlines: { normalMs: 1, deepMs: 1 },
        maxAttemptExposureUsd: "1", // synthetic exposure ceiling; no billed cost
      },
      admission: { scope: "factory-proof", confirmedCostCapUsd: "1" }, // synthetic cap; no billed cost
    },
    stores: {
      memoStore: {
        async singleflight() {
          throw new Error("the composition proof does not dispatch");
        },
      },
      contentAccess: { async requireContentRead() {} },
      accepted: {
        async readHead() {
          return null;
        },
        async acceptAndAdvance() {
          throw new Error("the composition proof does not finalize");
        },
      },
      wiki: {
        async listObjects() {
          // No bible is installed: readiness must block instead of fabricating
          // source or rendering entries.
          return [];
        },
      },
    },
    roles: {
      review: {
        async reviewLane() {
          return [];
        },
      },
      patchback: {
        buildInput() {
          throw new Error("the composition proof does not patch");
        },
        translatedBundlePath() {
          return "/tmp/factory-proof-translated.json";
        },
        async buildLqa() {
          return [];
        },
      },
      adjudicate: {
        buildRefs() {
          throw new Error("the composition proof does not adjudicate");
        },
        async readPayload() {
          throw new Error("the composition proof does not dispatch");
        },
        resolveEvidence: () => null,
      },
    },
    finalizeArtifact() {
      throw new Error("the composition proof does not finalize");
    },
    draftBudget: { budgetBytes: 1_024, overlapUnits: 1 },
  };
}

function parseableWholeGameStructure(): unknown {
  const structure = wholeGameStructure();
  return {
    ...structure,
    scenes: structure.scenes.map((scene) => {
      if (!("units" in scene)) return scene;
      return {
        ...scene,
        units: scene.units.map((unit) => ({
          ...unit,
          sourceAsset: { ...unit.sourceAsset, assetKey: `fixture:${unit.sourceAsset.assetId}` },
        })),
      };
    }),
  };
}

describe("live workflow factory", () => {
  it("constructs every workflow port from decoded facts and blocks an unbuilt bible", async () => {
    const deps = await createLiveWorkflowPortDeps(factoryConfig());
    const ports = createWorkflowPorts(deps);

    expect(Object.keys(ports).sort()).toEqual([
      "adjudicate",
      "draft",
      "gates",
      "patchback",
      "readiness",
      "repair",
      "review",
      "store",
    ]);
    expect(deps.readiness.snapshot.snapshotId).toBe(buildRb024Snapshot().snapshotId);

    const unitId = deps.readiness.snapshot.orderedUnits[0]!.factId;
    await expect(ports.readiness.resolve(unitId)).resolves.toMatchObject({ ready: false });
  });

  it("adapts the complete dependency set to the localize substrate port", async () => {
    const config = factoryConfig();
    const substrate = createLiveLocalizationSubstrate(config);
    const request = {
      runMode: "production",
      contextScope: "whole-game",
      outputScope: "dialogue-only",
      roster: [],
    } as RunPolicyRequest;
    const source = await substrate.resolvePortSource(request, {
      structureJson: config.structureJson,
      bridge: config.bridge,
    });

    expect(Object.keys(createWorkflowPorts(source.deps))).toHaveLength(8);
    const pilot = await substrate.resolvePortSource(
      { ...request, runMode: "pilot" },
      { structureJson: config.structureJson, bridge: config.bridge },
    );
    expect(pilot.deps.draft.buildInput).toBeTypeOf("function");
  });
});
