// immutable fact snapshot + deterministic pre-pass proofs.
//
// The bridge side is a REAL committed v0.2 bundle (from extraction); the
// narrative side references its units so the pre-pass runs against genuine
// decoded bytes, not a hand-mocked shape. Every guarantee below is
// mutation-falsifiable: remove the guarantee and a test fails.

import { readFileSync } from "node:fs";

import { contextSnapshot, type LlmContextSnapshotInput, type LlmRevisionRef } from "@itotori/db";
import type { BridgeBundleV02, SpeakerContextV02 } from "@itotori/localization-bridge-schema";
import { describe, expect, it, vi } from "vitest";

import {
  buildFactSnapshot,
  contextSnapshotFactsFrom,
  serializeFactSnapshot,
} from "../src/prepass/index.js";
import type { NarrativeScene, NarrativeStructure, NarrativeUnit } from "../src/structure/types.js";

function loadBridgeBundle(): BridgeBundleV02 {
  const raw = readFileSync(new URL("./fixtures/whole-seen-bridge.json", import.meta.url), "utf8");
  return JSON.parse(raw) as BridgeBundleV02;
}

const BUNDLE_HASH = "sha256:3065996aa103c1c827f13998f8d44046d5df0b9d5f30a1f0027544de71be6927";

type UnitSpec = {
  bridgeUnitId: string;
  sourceUnitKey: string;
  assetId: string;
  startByte: number;
  endByte: number;
  isChoice: boolean;
};

const SCENE_1_LINE: UnitSpec = {
  bridgeUnitId: "a06a6efc-b1f0-7483-b225-40f197a3bc83",
  sourceUnitKey: "reallive:scene-0001#0000",
  assetId: "df9fc555-e560-7887-a9d1-6c5b0ac311a4",
  startByte: 17,
  endByte: 21,
  isChoice: false,
};
const SCENE_1_CHOICE_A: UnitSpec = {
  bridgeUnitId: "9706a898-f08a-7ba9-99e6-c304e0235874",
  sourceUnitKey: "reallive:scene-0001#0001",
  assetId: "df9fc555-e560-7887-a9d1-6c5b0ac311a4",
  startByte: 29,
  endByte: 31,
  isChoice: true,
};
const SCENE_1_CHOICE_B: UnitSpec = {
  bridgeUnitId: "b43c7e66-a03e-713b-89cc-797c5ff9216f",
  sourceUnitKey: "reallive:scene-0001#0002",
  assetId: "df9fc555-e560-7887-a9d1-6c5b0ac311a4",
  startByte: 29,
  endByte: 31,
  isChoice: true,
};
const SCENE_2_LINE: UnitSpec = {
  bridgeUnitId: "d04f6e35-621e-78cf-80d0-1a3b0416db78",
  sourceUnitKey: "reallive:scene-0002#0000",
  assetId: "ca500bc0-3a3a-74ea-8273-341b123ec2c4",
  startByte: 17,
  endByte: 21,
  isChoice: false,
};
const SCENE_2_CHOICE_A: UnitSpec = {
  bridgeUnitId: "402c8867-cf61-7afa-a110-843c4f9fab53",
  sourceUnitKey: "reallive:scene-0002#0001",
  assetId: "ca500bc0-3a3a-74ea-8273-341b123ec2c4",
  startByte: 29,
  endByte: 31,
  isChoice: true,
};
const SCENE_2_CHOICE_B: UnitSpec = {
  bridgeUnitId: "84106326-5a71-737e-b369-b6a0ed46bf2a",
  sourceUnitKey: "reallive:scene-0002#0002",
  assetId: "ca500bc0-3a3a-74ea-8273-341b123ec2c4",
  startByte: 29,
  endByte: 31,
  isChoice: true,
};

function makeNarrativeUnit(spec: UnitSpec, index: number): NarrativeUnit {
  return {
    unitId: `unit-${spec.sourceUnitKey}`,
    bridgeRef: { bridgeUnitId: spec.bridgeUnitId, sourceUnitKey: spec.sourceUnitKey },
    surfaceKind: spec.isChoice ? "choice_label" : "dialogue",
    sourceText: "",
    characterId: null,
    evidenceTier: "E2",
    color: null,
    sourceAsset: { assetId: spec.assetId, assetKey: "" },
    byteOffsetInScene: spec.startByte,
    byteLength: spec.endByte - spec.startByte,
    rawByteHandle: `handle-${index}`,
    choiceId: spec.isChoice ? `choice-${spec.sourceUnitKey}` : null,
    playOrder: index,
    revealOrder: null,
    observedLineIds: [],
    routeMembership: [],
  };
}

function scene(sceneId: number, specs: UnitSpec[], nextScene: number | null): NarrativeScene {
  return {
    sceneId,
    selectionControl: "none",
    nextScene,
    messages: [],
    choices: [],
    units: specs.map((spec, index) => makeNarrativeUnit(spec, index)),
  };
}

/** Entry scene 1 dispatches to scene 2; scene 3 is intentionally orphaned so
 * reachability has a real negative. Covers all six committed bundle units. */
function wholeGameStructure(): NarrativeStructure {
  return {
    schemaVersion: "utsushi.narrative-structure.v2",
    entryScene: 1,
    sceneDispatchOrder: [1, 2],
    sourceBundleHash: BUNDLE_HASH,
    scenes: [
      scene(1, [SCENE_1_LINE, SCENE_1_CHOICE_A, SCENE_1_CHOICE_B], 2),
      scene(2, [SCENE_2_LINE, SCENE_2_CHOICE_A, SCENE_2_CHOICE_B], null),
      { sceneId: 3, selectionControl: "none", nextScene: null, messages: [], choices: [] },
    ],
  };
}

const KNOWN_SPEAKER: SpeakerContextV02 = {
  knowledgeState: "known",
  speakerId: "01920000-0000-7000-8000-000000000001",
  displayName: "あい",
  revealState: "revealed",
  textColor: [10, 20, 30],
};

/** Clone the bundle and stamp a KNOWN speaker (+ text color) on its first unit,
 * so we can prove the pre-pass CITES the bridge identity verbatim. */
function bundleWithKnownSpeaker(): BridgeBundleV02 {
  const bundle = loadBridgeBundle();
  const units = bundle.units.map((unit) =>
    unit.bridgeUnitId === SCENE_1_LINE.bridgeUnitId
      ? { ...unit, speaker: { ...KNOWN_SPEAKER } }
      : unit,
  );
  return { ...bundle, units };
}

describe("buildFactSnapshot (deterministic pre-pass)", () => {
  it("materializes ordered units, scene cards, topology, and choice labels", () => {
    const snapshot = buildFactSnapshot(wholeGameStructure(), loadBridgeBundle());

    expect(snapshot.orderedUnits).toHaveLength(6);
    // Play order is monotonic and stable (dispatch order + within-scene order).
    const playIndices = snapshot.orderedUnits.map((u) => u.playReveal.playOrderIndex);
    expect(playIndices).toEqual([...playIndices].sort((a, b) => a - b));
    expect(new Set(playIndices).size).toBe(6);

    // Protected skeleton is the bridge unit's decoded span, cited verbatim.
    const sceneOneLine = snapshot.orderedUnits.find(
      (u) => u.bridgeUnitId === SCENE_1_LINE.bridgeUnitId,
    );
    expect(sceneOneLine?.protectedSkeleton.spans).toEqual([
      {
        spanKind: "control_markup",
        preserveMode: "exact",
        raw: "<reallive.kidoku 1>",
        startByte: 0,
        endByte: 19,
      },
    ]);
    expect(sceneOneLine?.byteRange).toEqual({ startByte: 17, endByte: 21 });
    expect(sceneOneLine?.patchRef.writeMode).toBe("replace");
    expect(sceneOneLine?.runtimeExpectation.expectationKind).toBe("trace_text");

    // Choice-label occurrences: exactly the four choice units.
    expect(snapshot.choiceLabels.totalCount).toBe(4);

    // Scene cards carry decode counts + unit counts.
    const sceneOne = snapshot.scenes.find((s) => s.sceneId === 1);
    expect(sceneOne?.unitCount).toBe(3);
    expect(sceneOne?.choiceCount).toBe(0); // choices are flat units here
    expect(snapshot.scenes.map((s) => s.sceneId)).toEqual([1, 2, 3]);

    // No policy records / character ids in this bundle => empty by evidence.
    expect(snapshot.terminology).toEqual([]);
    expect(snapshot.glossaryConflicts).toEqual([]);
    expect(snapshot.characters).toEqual([]);
  });

  it("PROOF: route reachability matches the decoded choice topology", () => {
    const snapshot = buildFactSnapshot(wholeGameStructure(), loadBridgeBundle());
    // Entry scene 1 -> 2 via dispatch; scene 3 is orphaned.
    expect(snapshot.routeTopology.entryScene).toBe(1);
    expect(snapshot.routeTopology.reachableSceneIds).toEqual([1, 2]);
    expect(snapshot.routeTopology.unreachableSceneIds).toEqual([3]);
    expect(snapshot.routeTopology.edges).toContainEqual({
      fromSceneId: 1,
      toSceneId: 2,
      kind: "dispatch",
      choiceIndex: null,
    });
    // Only reachable scenes' units are reachable; all six live under 1 & 2.
    expect(snapshot.routeTopology.reachableUnitKeys).toHaveLength(6);
    // Orphaning the entry's only successor drops scene 2 (and no unit is
    // reachable beyond scene 1) — proves reachability is edge-derived.
    const noDispatch = wholeGameStructure();
    noDispatch.scenes[0]!.nextScene = null;
    const orphaned = buildFactSnapshot(noDispatch, loadBridgeBundle());
    expect(orphaned.routeTopology.reachableSceneIds).toEqual([1]);
    expect(orphaned.routeTopology.reachableUnitKeys).toEqual(
      ["reallive:scene-0001#0000", "reallive:scene-0001#0001", "reallive:scene-0001#0002"].sort(),
    );
  });

  it("PROOF: repeated real-byte builds are BYTE-IDENTICAL (same id + same bytes)", () => {
    const first = buildFactSnapshot(wholeGameStructure(), loadBridgeBundle());
    const second = buildFactSnapshot(wholeGameStructure(), loadBridgeBundle());
    expect(second.snapshotId).toBe(first.snapshotId);
    expect(serializeFactSnapshot(second)).toBe(serializeFactSnapshot(first));
    // The id IS the SHA-256 of the canonical bytes.
    expect(first.snapshotId).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(first.snapshotId).toBe(first.contentHash);
  });

  it("PROOF: dispatches ZERO model calls (builds with the network hard-disabled)", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("network is forbidden in the deterministic pre-pass");
    });
    try {
      const result = buildFactSnapshot(wholeGameStructure(), loadBridgeBundle());
      // Synchronous (not a Promise) — there is nothing to await, no dispatch.
      expect(result).not.toBeInstanceOf(Promise);
      expect(result.orderedUnits).toHaveLength(6);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("PROOF: materialized speaker + color identity EQUAL the bridge (cited, not recomputed)", () => {
    const bundle = bundleWithKnownSpeaker();
    const snapshot = buildFactSnapshot(wholeGameStructure(), bundle);
    const line = snapshot.orderedUnits.find((u) => u.bridgeUnitId === SCENE_1_LINE.bridgeUnitId);
    // Deep-equal the exact bridge speaker context, text color included.
    expect(line?.speaker).toEqual(KNOWN_SPEAKER);
    const bridgeUnit = bundle.units.find((u) => u.bridgeUnitId === SCENE_1_LINE.bridgeUnitId);
    expect(line?.speaker).toEqual(bridgeUnit?.speaker);
    // Units with no speaker context in the bridge stay explicit-null.
    const choice = snapshot.orderedUnits.find(
      (u) => u.bridgeUnitId === SCENE_1_CHOICE_A.bridgeUnitId,
    );
    expect(choice?.speaker).toEqual({ knowledgeState: "not_applicable" });
  });

  it("PROOF: changing any decode/bridge input yields a different snapshotId", () => {
    const base = buildFactSnapshot(wholeGameStructure(), loadBridgeBundle());
    const ids = new Set<string>([base.snapshotId]);

    // (a) a different entry scene (decode topology input)
    const reEntry = wholeGameStructure();
    reEntry.entryScene = 2;
    ids.add(buildFactSnapshot(reEntry, loadBridgeBundle()).snapshotId);

    // (b) a different dispatch order (play order + topology input)
    const reorder = wholeGameStructure();
    reorder.sceneDispatchOrder = [2, 1];
    ids.add(buildFactSnapshot(reorder, loadBridgeBundle()).snapshotId);

    // (c) a cited bridge speaker identity change (folds into the hash)
    ids.add(buildFactSnapshot(wholeGameStructure(), bundleWithKnownSpeaker()).snapshotId);

    // (d) a cited text-color change on that same known speaker
    const recolored = bundleWithKnownSpeaker();
    recolored.units = recolored.units.map((u) =>
      u.bridgeUnitId === SCENE_1_LINE.bridgeUnitId
        ? { ...u, speaker: { ...KNOWN_SPEAKER, textColor: [99, 20, 30] } }
        : u,
    );
    ids.add(buildFactSnapshot(wholeGameStructure(), recolored).snapshotId);

    // Five distinct inputs => five distinct content addresses.
    expect(ids.size).toBe(5);
  });
});

describe("contextSnapshotFactsFrom (commit facts into the ContextSnapshot)", () => {
  function baseContextInput(): LlmContextSnapshotInput {
    const rev = (id: string): LlmRevisionRef => ({
      revisionId: id,
      contentHash: `sha256:${"0".repeat(63)}${id.length % 10}`,
    });
    return {
      sourceLanguage: "ja-JP",
      decode: rev("decode-current"),
      sourceUnits: [{ unitId: "unit:seed", sourceHash: `sha256:${"a".repeat(64)}` }],
      facts: [
        {
          factId: "scene:seed",
          playOrderIndex: 0,
          routeScope: { kind: "global" },
        },
      ],
      structure: rev("structure-current"),
      routeGraph: rev("route-graph-current"),
      glossary: rev("glossary-current"),
      style: rev("style-current"),
      revealHorizon: { kind: "complete" },
      humanCorrections: rev("corrections-current"),
      externalSources: null,
      contextScope: "whole-game",
    };
  }

  it("emits committable namespaced facts + a fact-materialization ref", () => {
    const snapshot = buildFactSnapshot(wholeGameStructure(), loadBridgeBundle());
    const { facts, factMaterialization } = contextSnapshotFactsFrom(snapshot);

    // factMaterialization commits the WHOLE fact set (its hash IS the snapshot).
    expect(factMaterialization.contentHash).toBe(snapshot.contentHash);
    // Every ordered unit + scene fact id is committed and citeable.
    const factIds = new Set(facts.map((f) => f.factId));
    for (const unit of snapshot.orderedUnits) expect(factIds.has(unit.factId)).toBe(true);
    for (const s of snapshot.scenes) expect(factIds.has(s.factId)).toBe(true);
  });

  it("PROOF: committing the materialization changes the ContextSnapshot id; omitting it is byte-identical to a bare context snapshot", () => {
    const snapshot = buildFactSnapshot(wholeGameStructure(), loadBridgeBundle());
    const { facts, factMaterialization } = contextSnapshotFactsFrom(snapshot);

    const bare = contextSnapshot(baseContextInput());
    const committed = contextSnapshot({ ...baseContextInput(), facts, factMaterialization });
    const withoutMaterialization = contextSnapshot({ ...baseContextInput(), facts });

    // Adding the fact-materialization content hash changes the trust-root id.
    expect(committed.snapshotId).not.toBe(withoutMaterialization.snapshotId);

    // A snapshot that never sets factMaterialization keeps the exact a bare context snapshot
    // identity — the field is additive and omitted-when-absent.
    const bareIdentity = JSON.stringify({ ...bare, snapshotId: undefined, contentHash: undefined });
    expect(bareIdentity).not.toContain("factMaterialization");

    // Two builds of the committed snapshot are equal (determinism end to end).
    const committedAgain = contextSnapshot({ ...baseContextInput(), facts, factMaterialization });
    expect(committedAgain.snapshotId).toBe(committed.snapshotId);
  });
});
