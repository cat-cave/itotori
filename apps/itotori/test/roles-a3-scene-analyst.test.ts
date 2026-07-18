// A3 Scene Analyst — mutation-falsifiable proofs over REAL decoded bytes.
//
// Every clause of the role fails if its guarantee is removed:
//   Clause 1 — A3 reads each COMPLETE scene, never a planner fragment.
//   Clause 2 — it serially FOLDS the prior accepted story-so-far into a cited
//              scene-summary + updated story-so-far, in the SOURCE LANGUAGE.
//   Clause 3 — every citation belongs to the visible snapshot (RB-031), the
//              final story-so-far covers the full route history, and decoded
//              counts/speakers are index-derived, never model outputs.
//
// The model boundary is a RECORDED responder (no network, no DB): the fold is
// deterministic and the guarantees are the module's, not the model's.

import { describe, expect, it } from "vitest";

import { ClaimValidationError } from "../src/wiki/claim-validation.js";
import { buildEvidenceIndex } from "../src/wiki/evidence-index.js";
import {
  A3RoleError,
  assembleSceneSummary,
  assertCompleteSceneUnits,
  foldRoute,
  readCompleteScene,
  type A3Context,
  type A3ModelCaller,
  type A3SceneNarrative,
  type StorySoFarState,
} from "../src/roles/a3/index.js";
import { buildClaimFixture } from "./support/claim-fixture.js";

const CONTEXT: A3Context = {
  runMode: "test-dev",
  contextScope: "whole-game",
  routeVisibility: { kind: "global" },
  localeBranchId: null,
};

/** A recorded responder that cites the scene's own first unit and deliberately
 * LIES about the message count and speakers — the module must ignore both. */
function recordedCaller(seen?: Array<StorySoFarState | null>): A3ModelCaller {
  return async (request) => {
    seen?.push(request.priorStory);
    const anchor = String(request.scene.units[0]!.value.playOrderIndex);
    const narrative: A3SceneNarrative = {
      beat: "けいこは教室で小さな決断をする。",
      subtext: "迷いの下に、静かな決意がある。",
      sceneOpenThreads: ["だれが真実を知っているのか"],
      sceneClaims: [
        {
          statement: "この場面は直接的な語り口を用いる。",
          kind: "beat",
          confidence: "high",
          evidenceUnitIds: [anchor],
        },
      ],
      storySummary: `シーン${request.scene.sceneId}までに、物語は静かに動き出す。`,
      storyOpenThreads: ["未解決の伏線"],
      storyClaims: [
        {
          statement: "物語はここまで一貫している。",
          kind: "story-so-far",
          confidence: "medium",
          evidenceUnitIds: [anchor],
        },
      ],
      assertedMessageCount: 999,
      assertedSpeakerLabels: ["ghost-speaker"],
    };
    return narrative;
  };
}

describe("clause 1 — A3 reads each COMPLETE scene, never a fragment", () => {
  it("PROOF: reads the full ordered unit stream, proven complete against the fact card", () => {
    const { model } = buildClaimFixture();
    const scene = readCompleteScene(model, CONTEXT, 1);
    expect(scene.units.length).toBe(scene.factCard.unitCount);
    expect(scene.units.every((unit) => unit.value.sceneId === "1")).toBe(true);
  });

  it("PROOF: a pre-sliced FRAGMENT of a scene is rejected (fragment-scene)", () => {
    const { model } = buildClaimFixture();
    const full = readCompleteScene(model, CONTEXT, 1).units.map((unit) => unit.factId);
    // The complete set passes; dropping one unit is a fragment and FAILS.
    expect(() => assertCompleteSceneUnits(model, 1, full)).not.toThrow();
    try {
      assertCompleteSceneUnits(model, 1, full.slice(0, full.length - 1));
      throw new Error("expected a fragment-scene failure");
    } catch (error) {
      expect(error).toBeInstanceOf(A3RoleError);
      expect((error as A3RoleError).code).toBe("fragment-scene");
    }
  });

  it("PROOF: an unknown scene and an empty scene both fail loud", () => {
    const { model } = buildClaimFixture();
    expect(() => readCompleteScene(model, CONTEXT, 99)).toThrow(/unknown-scene/);
    // Scene 3 exists in the snapshot but carries no translatable units.
    expect(() => readCompleteScene(model, CONTEXT, 3)).toThrow(/empty-scene/);
  });
});

describe("clause 2 — serial fold into cited source-language objects", () => {
  it("PROOF: the fold is serial — each step consumes the prior accepted story-so-far", async () => {
    const { model } = buildClaimFixture();
    const seen: Array<StorySoFarState | null> = [];
    const result = await foldRoute(model, CONTEXT, recordedCaller(seen));

    // Walked in play order (sceneDispatchOrder = [1, 2]).
    expect(result.scenes.map((scene) => scene.sceneId)).toEqual([1, 2]);
    // The first step has no prior; the second consumes the story THROUGH scene 1.
    expect(seen[0]).toBeNull();
    expect(seen[1]?.throughSceneId).toBe(1);
    // The story-so-far chain is a provable dependency edge on the prior object.
    const secondStoryDeps = result.scenes[1]!.storySoFar.dependencies.map(
      (d) => d.upstreamObjectId,
    );
    expect(secondStoryDeps).toContain("story-so-far:1");
  });

  it("PROOF: every emitted object is authored in the SOURCE LANGUAGE", async () => {
    const { model } = buildClaimFixture();
    const result = await foldRoute(model, CONTEXT, recordedCaller());
    for (const scene of result.scenes) {
      expect(scene.sceneSummary.lang).toBe(model.sourceLanguage);
      expect(scene.storySoFar.lang).toBe(model.sourceLanguage);
    }
  });
});

describe("clause 3 — citations in-snapshot, full-route coverage, index-derived counts", () => {
  it("PROOF: the final story-so-far covers the FULL route history", async () => {
    const { model } = buildClaimFixture();
    const result = await foldRoute(model, CONTEXT, recordedCaller());
    expect(result.coveredSceneIds).toEqual([
      ...model.factSnapshot.routeTopology.sceneDispatchOrder,
    ]);
    // Through the LAST dispatched scene — the route spine A4 adopts.
    const final = result.finalStorySoFar;
    expect(final.kind).toBe("story-so-far");
    expect(final.kind === "story-so-far" ? final.body.throughSceneId : null).toBe("2");
  });

  it("PROOF: a cited scene play-order label resolves to the fact id and snapshot machine fields", () => {
    const { model } = buildClaimFixture();
    const scene = readCompleteScene(model, CONTEXT, 1);
    const citedUnit = scene.units[0]!;
    const label = String(citedUnit.value.playOrderIndex);
    const object = assembleSceneSummary(model, CONTEXT, scene, {
      beat: "b",
      subtext: "s",
      sceneOpenThreads: [],
      sceneClaims: [
        {
          statement: "直接的な語り口。",
          kind: "beat",
          confidence: "high",
          evidenceUnitIds: [label],
        },
      ],
      storySummary: "x",
      storyOpenThreads: [],
      storyClaims: [],
    });
    const index = buildEvidenceIndex(model);
    // The persisted citation has the real fact id and every machine coordinate
    // comes from that snapshot record, not from the model's short label.
    const citation = object.claims[0]!.citations[0]!;
    const record = index.get(citedUnit.factId)!;
    expect(citation.evidenceId).toBe(citedUnit.factId);
    expect(citation.evidenceHash).toBe(record.hash);
    expect(citation.snapshotId).toBe(record.snapshotId);
    expect(citation.subject).toEqual(record.subject);
    expect(citation.playOrderIndex).toBe(record.fromPlayOrder);
  });

  it("PROOF: a label outside the current scene FAILS (RB-031 evidence-unresolvable)", () => {
    const { model } = buildClaimFixture();
    const scene = readCompleteScene(model, CONTEXT, 1);
    try {
      assembleSceneSummary(model, CONTEXT, scene, {
        beat: "b",
        subtext: "s",
        sceneOpenThreads: [],
        sceneClaims: [
          {
            statement: "存在しない証拠を引く主張。",
            kind: "beat",
            confidence: "high",
            // This is a genuine label in scene 2, but it was not shown in scene 1.
            evidenceUnitIds: [
              String(readCompleteScene(model, CONTEXT, 2).units[0]!.value.playOrderIndex),
            ],
          },
        ],
        storySummary: "x",
        storyOpenThreads: [],
        storyClaims: [],
      });
      throw new Error("expected an unresolvable-citation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ClaimValidationError);
      expect((error as ClaimValidationError).code).toBe("evidence-unresolvable");
    }
  });

  it("PROOF: counts and speakers are INDEX-derived, never model outputs", async () => {
    const { model } = buildClaimFixture();
    const result = await foldRoute(model, CONTEXT, recordedCaller());
    const first = result.scenes[0]!;
    const card = model.factSnapshot.scenes.find((scene) => scene.sceneId === 1)!;

    // The emitted count is the decode's, NOT the model's asserted 999.
    expect(first.factCard.messageCount).toBe(card.messageCount);
    expect(first.factCard.messageCount).not.toBe(999);
    // The model's fabricated speaker never reaches the emitted speaker set.
    expect(first.speakerLabels).not.toContain("ghost-speaker");
    // The scene-summary body carries ONLY prose + the deterministic scene id —
    // there is no field a re-count or re-attribution could occupy.
    const summary = first.sceneSummary;
    expect(summary.kind === "scene-summary" ? Object.keys(summary.body).sort() : []).toEqual([
      "beat",
      "openThreads",
      "sceneId",
      "subtext",
    ]);
    expect(summary.kind === "scene-summary" ? summary.body.sceneId : null).toBe("1");
  });
});
