// A3 Scene Analyst — mutation-falsifiable proofs over REAL decoded bytes.
//
// Every clause of the role fails if its guarantee is removed:
//   Clause 1 — A3 reads each COMPLETE scene, never a planner fragment.
//   Clause 2 — it serially FOLDS the prior accepted story-so-far into a cited
//              scene-summary + updated story-so-far, in the SOURCE LANGUAGE.
//   Clause 3 — every citation belongs to the visible snapshot (the citation
//              gate), the final story-so-far covers the full route history, and decoded
//              counts/speakers are index-derived, never model outputs.
//
// The model boundary is a RECORDED responder (no network, no DB): the fold is
// deterministic and the guarantees are the module's, not the model's.

import { describe, expect, it } from "vitest";

import { ClaimValidationError, validateWikiObjectClaims } from "../src/wiki/claim-validation.js";
import { buildEvidenceIndex } from "../src/wiki/evidence-index.js";
import {
  A3RoleError,
  assembleSceneSummary,
  assertCompleteSceneUnits,
  citeableSceneUnits,
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

const SCENE_1 = "scene:0001";
const SCENE_2 = "scene:0002";
const SCENE_3 = "scene:0003";
const SCENE_99 = "scene:0099";

/** A recorded responder that cites the scene's own first unit by its short
 * scene-local label (u1) and deliberately LIES about the message count and
 * speakers — the module must ignore both. */
function recordedCaller(seen?: Array<StorySoFarState | null>): A3ModelCaller {
  return async (request) => {
    seen?.push(request.priorStory);
    const anchor = citeableSceneUnits(request.scene)[0]!.label;
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
    const scene = readCompleteScene(model, CONTEXT, SCENE_1);
    expect(scene.units.length).toBe(scene.factCard.unitCount);
    expect(scene.units.every((unit) => unit.value.sceneId === SCENE_1)).toBe(true);
  });

  it("PROOF: a pre-sliced FRAGMENT of a scene is rejected (fragment-scene)", () => {
    const { model } = buildClaimFixture();
    const full = readCompleteScene(model, CONTEXT, SCENE_1).units.map((unit) => unit.factId);
    // The complete set passes; dropping one unit is a fragment and FAILS.
    expect(() => assertCompleteSceneUnits(model, SCENE_1, full)).not.toThrow();
    try {
      assertCompleteSceneUnits(model, SCENE_1, full.slice(0, full.length - 1));
      throw new Error("expected a fragment-scene failure");
    } catch (error) {
      expect(error).toBeInstanceOf(A3RoleError);
      expect((error as A3RoleError).code).toBe("fragment-scene");
    }
  });

  it("PROOF: an unknown scene and an empty scene both fail loud", () => {
    const { model } = buildClaimFixture();
    expect(() => readCompleteScene(model, CONTEXT, SCENE_99)).toThrow(/unknown-scene/);
    // Scene 3 exists in the snapshot but carries no translatable units.
    expect(() => readCompleteScene(model, CONTEXT, SCENE_3)).toThrow(/empty-scene/);
  });
});

describe("clause 2 — serial fold into cited source-language objects", () => {
  it("PROOF: the fold is serial — each step consumes the prior accepted story-so-far", async () => {
    const { model } = buildClaimFixture();
    const seen: Array<StorySoFarState | null> = [];
    const result = await foldRoute(model, CONTEXT, recordedCaller(seen));

    // Walked in play order (sceneDispatchOrder = [scene:0001, scene:0002]).
    expect(result.scenes.map((scene) => scene.sceneId)).toEqual([SCENE_1, SCENE_2]);
    // The first step has no prior; the second consumes the story THROUGH scene 1.
    expect(seen[0]).toBeNull();
    expect(seen[1]?.throughSceneId).toBe(SCENE_1);
    // The story-so-far chain is a provable dependency edge on the prior object.
    const secondStoryDeps = result.scenes[1]!.storySoFar.dependencies.map(
      (d) => d.upstreamObjectId,
    );
    expect(secondStoryDeps).toContain(`story-so-far:${SCENE_1}`);
  });

  it("PROOF: every emitted object is authored in the SOURCE LANGUAGE", async () => {
    const { model } = buildClaimFixture();
    const result = await foldRoute(model, CONTEXT, recordedCaller());
    for (const scene of result.scenes) {
      expect(scene.sceneSummary.lang).toBe(model.sourceLanguage);
      expect(scene.storySoFar.lang).toBe(model.sourceLanguage);
    }
  });

  it("PROOF: each analyst-written object stays provisional and traceable", async () => {
    const { model } = buildClaimFixture();
    const result = await foldRoute(model, CONTEXT, recordedCaller());

    for (const scene of result.scenes) {
      for (const object of [scene.sceneSummary, scene.storySoFar]) {
        expect(object.provisional).toBe(true);
        expect(object.provenance.authorRoleId).toBe("A3");
        expect(object.provenance.contextSnapshotId).toBe(model.snapshotId);
      }
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
    expect(final.kind === "story-so-far" ? final.body.throughSceneId : null).toBe(SCENE_2);
  });

  it("PROOF: A3 labels each unit u1,u2,… and the model copies [u1] in [uN] order", () => {
    const { model } = buildClaimFixture();
    const scene = readCompleteScene(model, CONTEXT, SCENE_1);
    const citeable = citeableSceneUnits(scene);
    // Small, scene-local labels the flash model can copy verbatim — NOT the large
    // global play-order index it mis-transcribed.
    expect(citeable.map((entry) => entry.label)).toEqual(
      scene.units.map((_, index) => `u${index + 1}`),
    );
    // Each label binds back to the real fact id of the unit at that position.
    expect(citeable[0]!.label).toBe("u1");
    expect(citeable[0]!.factId).toBe(scene.units[0]!.factId);
  });

  it("PROOF: a cited scene-local label resolves to the fact id and snapshot machine fields", () => {
    const { model } = buildClaimFixture();
    const scene = readCompleteScene(model, CONTEXT, SCENE_1);
    const citedUnit = scene.units[0]!;
    // The model copies the short label u1 shown for the first unit — no drop is
    // needed for a correct citation.
    const label = citeableSceneUnits(scene)[0]!.label;
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

  it("PROOF: a claim citing ONLY an out-of-range label is DROPPED, not crashed over", () => {
    const { model } = buildClaimFixture();
    const scene = readCompleteScene(model, CONTEXT, SCENE_1);
    // The safety net: a label past the scene's unit count (the flash model
    // mis-copied it) names no unit and is repaired away rather than crashing.
    const outOfRange = "u999";
    // Assembling does NOT throw: the unprovable claim is repaired away, so one
    // flash-model transcription slip cannot hard-fail the whole build.
    const object = assembleSceneSummary(model, CONTEXT, scene, {
      beat: "b",
      subtext: "s",
      sceneOpenThreads: [],
      sceneClaims: [
        {
          statement: "存在しない証拠を引く主張。",
          kind: "beat",
          confidence: "high",
          evidenceUnitIds: [outOfRange],
        },
      ],
      storySummary: "x",
      storyOpenThreads: [],
      storyClaims: [],
    });
    // The claim carried no resolvable citation, so it was discarded — never
    // admitted uncited.
    expect(object.claims).toHaveLength(0);
  });

  it("PROOF: a MIX of a real and a mis-cited label keeps ONLY the resolvable citation", () => {
    const { model } = buildClaimFixture();
    const scene = readCompleteScene(model, CONTEXT, SCENE_1);
    const good = citeableSceneUnits(scene)[0]!.label;
    const bad = "u999";
    const object = assembleSceneSummary(model, CONTEXT, scene, {
      beat: "b",
      subtext: "s",
      sceneOpenThreads: [],
      sceneClaims: [
        {
          statement: "直接的な語り口。",
          kind: "beat",
          confidence: "high",
          evidenceUnitIds: [good, bad],
        },
      ],
      storySummary: "x",
      storyOpenThreads: [],
      storyClaims: [],
    });
    const index = buildEvidenceIndex(model);
    // The claim survives with its real support; the mis-cited label is gone.
    expect(object.claims).toHaveLength(1);
    const citations = object.claims[0]!.citations;
    expect(citations).toHaveLength(1);
    expect(citations[0]!.evidenceId).toBe(scene.units[0]!.factId);
    // Gate NOT weakened: every surviving citation resolves against the snapshot.
    for (const claim of object.claims) {
      for (const citation of claim.citations) {
        expect(index.get(citation.evidenceId)).toBeDefined();
      }
    }
  });

  it("PROOF: the gate the repair feeds still REJECTS a fabricated citation", () => {
    const { model } = buildClaimFixture();
    const scene = readCompleteScene(model, CONTEXT, SCENE_1);
    const good = citeableSceneUnits(scene)[0]!.label;
    const object = assembleSceneSummary(model, CONTEXT, scene, {
      beat: "b",
      subtext: "s",
      sceneOpenThreads: [],
      sceneClaims: [
        {
          statement: "直接的な語り口。",
          kind: "beat",
          confidence: "high",
          evidenceUnitIds: [good],
        },
      ],
      storySummary: "x",
      storyOpenThreads: [],
      storyClaims: [],
    });
    // The repair does not soften the citation gate: hand a claim a fabricated
    // evidence id straight to the gate and it still fails loud (the repair
    // only prevents a fabricated citation from ever reaching the object, it
    // never admits one).
    const tampered = {
      ...object,
      claims: [
        {
          ...object.claims[0]!,
          citations: [
            {
              ...object.claims[0]!.citations[0]!,
              evidenceId: "unit:fabricated-does-not-exist",
            },
          ],
        },
      ],
    };
    try {
      validateWikiObjectClaims(tampered, model);
      throw new Error("expected the citation gate to reject the fabricated citation");
    } catch (error) {
      expect(error).toBeInstanceOf(ClaimValidationError);
      expect((error as ClaimValidationError).code).toBe("evidence-unresolvable");
    }
  });

  it("PROOF: a model that mis-cites every claim does NOT hard-crash the fold", async () => {
    const { model } = buildClaimFixture();
    // Every claim cites a play-order label present in NO scene — the whole-game
    // failure mode. The fold must survive and admit nothing unresolved.
    const misCiting: A3ModelCaller = async () => ({
      beat: "b",
      subtext: "s",
      sceneOpenThreads: [],
      sceneClaims: [
        { statement: "誤引用。", kind: "beat", confidence: "high", evidenceUnitIds: ["999999"] },
      ],
      storySummary: "x",
      storyOpenThreads: [],
      storyClaims: [
        {
          statement: "誤引用（物語）。",
          kind: "story-so-far",
          confidence: "low",
          evidenceUnitIds: ["999999"],
        },
      ],
    });
    const result = await foldRoute(model, CONTEXT, misCiting);
    // The full route folded instead of throwing on scene 1's first claim.
    expect(result.scenes.length).toBe(model.factSnapshot.routeTopology.sceneDispatchOrder.length);
    const index = buildEvidenceIndex(model);
    for (const scene of result.scenes) {
      for (const object of [scene.sceneSummary, scene.storySoFar]) {
        // Every unprovable claim was dropped; nothing unresolved was admitted.
        expect(object.claims).toHaveLength(0);
        for (const claim of object.claims) {
          for (const citation of claim.citations) {
            expect(index.get(citation.evidenceId)).toBeDefined();
          }
        }
      }
    }
  });

  it("PROOF: counts and speakers are INDEX-derived, never model outputs", async () => {
    const { model } = buildClaimFixture();
    const result = await foldRoute(model, CONTEXT, recordedCaller());
    const first = result.scenes[0]!;
    const card = model.factSnapshot.scenes.find((scene) => scene.sceneId === SCENE_1)!;

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
    expect(summary.kind === "scene-summary" ? summary.body.sceneId : null).toBe(SCENE_1);
  });
});
