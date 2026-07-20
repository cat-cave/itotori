import { describe, expect, it, vi } from "vitest";

const dispatchSpy = vi.hoisted(() => vi.fn());

vi.mock("../src/llm/dispatch.js", () => ({ dispatch: dispatchSpy }));

import { canonicalJson } from "../src/llm/canonical-json.js";
import { deepSeekV4FlashProfile } from "../src/llm/role-model-profiles.js";
import {
  buildLocalizerCall,
  dispatchLocalizerCall,
  type SkeletonUnit,
  type WholeSceneSegment,
} from "../src/roles/p1/index.js";
import { specialistFor } from "../src/roster/index.js";

const HASH = `sha256:${"a".repeat(64)}` as const;

const unit: SkeletonUnit = {
  unitId: "unit.direct",
  sceneId: "scene.direct",
  playOrderIndex: 0,
  sourceHash: HASH,
  sourceSkeleton: "source line",
  protectedPlaceholders: [],
  bytes: 11,
};

const segment: WholeSceneSegment = {
  mode: "whole-scene",
  sceneId: unit.sceneId,
  unitIds: [unit.unitId],
};

function seed(call: ReturnType<typeof buildLocalizerCall>): Record<string, unknown> {
  for (const payload of call.payloads.values()) {
    try {
      const value = JSON.parse(payload) as Record<string, unknown>;
      if (value.kind === "localizer-seed") return value;
    } catch {
      // The system instruction is intentionally plaintext but not JSON.
    }
  }
  throw new Error("localizer seed payload missing");
}

describe("pure-MTL P1 direct call", () => {
  it("uses the qualifying P1 DeepSeek certified dispatch while sealing an empty direct-translation basis", async () => {
    dispatchSpy.mockResolvedValue({ status: "failure" });
    const call = buildLocalizerCall({
      specialist: specialistFor("P1"),
      segment,
      unitsById: new Map([[unit.unitId, unit]]),
      bibleBasis: "pure-mtl-ablation",
      bibleRenderingIds: [],
      priorAcceptedTarget: new Map(),
      contextSnapshotId: HASH,
      localizationSnapshotId: HASH,
      runMode: "test-dev",
      contextScope: "whole-game",
      schemaHash: HASH,
    });

    // The call is still P1's public certified-dispatch input, not a bespoke
    // provider request. It has the exact same profile/model/policy as P1.
    expect(call.spec.roleId).toBe("P1");
    expect(call.spec.requestedModel).toBe(deepSeekV4FlashProfile.model);
    expect(call.spec.modelProfileVersion).toBe(deepSeekV4FlashProfile.version);
    expect(canonicalJson(call.spec.providerPolicy)).toBe(
      canonicalJson(deepSeekV4FlashProfile.providerPolicy),
    );

    const directSeed = seed(call);
    expect(directSeed.draftBasis).toBe("pure-mtl-ablation");
    expect(directSeed.bibleRenderingIds).toEqual([]);
    expect(directSeed).not.toHaveProperty("unitBible");
    expect(directSeed.skeletons).toEqual([
      expect.objectContaining({
        unitId: unit.unitId,
        sourceHash: unit.sourceHash,
        sourceSkeleton: unit.sourceSkeleton,
      }),
    ]);

    // The injected dispatch is the deterministic test seam for the same P1
    // public wrapper. It observes the certified CallSpec, never a provider API.
    await dispatchLocalizerCall(call, {} as never);
    expect(dispatchSpy).toHaveBeenCalledOnce();
    expect(dispatchSpy.mock.calls[0]?.[0]).toEqual(call.spec);
  });
});
