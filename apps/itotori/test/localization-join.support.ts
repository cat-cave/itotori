import { readFileSync } from "node:fs";

import type { BridgeBundleV02 } from "@itotori/localization-bridge-schema";

import type {
  NarrativeChoice,
  NarrativeMessage,
  NarrativeScene,
  NarrativeStructure,
  NarrativeUnit,
} from "../src/structure/index.js";

export function loadBridgeBundle(): BridgeBundleV02 {
  const raw = readFileSync(new URL("./fixtures/whole-seen-bridge.json", import.meta.url), "utf8");
  return JSON.parse(raw) as BridgeBundleV02;
}

export const BUNDLE_HASH =
  "sha256:3065996aa103c1c827f13998f8d44046d5df0b9d5f30a1f0027544de71be6927";

export type UnitSpec = {
  bridgeUnitId: string;
  sourceUnitKey: string;
  assetId: string;
  startByte: number;
  endByte: number;
  isChoice: boolean;
};

export function realliveEvidence(
  startByte: number | null,
  byteLength: number | null,
  rawByteHandle?: string,
) {
  return {
    reallive: {
      byteOffsetInScene: startByte,
      byteLength,
      ...(rawByteHandle === undefined ? {} : { rawByteHandle }),
    },
  };
}

export function sceneRef(sceneId: number): string {
  return `scene:${String(sceneId).padStart(4, "0")}`;
}

export const SCENE_1_LINE: UnitSpec = {
  bridgeUnitId: "a06a6efc-b1f0-7483-b225-40f197a3bc83",
  sourceUnitKey: "reallive:scene-0001#0000",
  assetId: "df9fc555-e560-7887-a9d1-6c5b0ac311a4",
  startByte: 17,
  endByte: 21,
  isChoice: false,
};

export const SCENE_1_CHOICE_A: UnitSpec = {
  bridgeUnitId: "9706a898-f08a-7ba9-99e6-c304e0235874",
  sourceUnitKey: "reallive:scene-0001#0001",
  assetId: "df9fc555-e560-7887-a9d1-6c5b0ac311a4",
  startByte: 29,
  endByte: 31,
  isChoice: true,
};

export const SCENE_1_CHOICE_B: UnitSpec = {
  bridgeUnitId: "b43c7e66-a03e-713b-89cc-797c5ff9216f",
  sourceUnitKey: "reallive:scene-0001#0002",
  assetId: "df9fc555-e560-7887-a9d1-6c5b0ac311a4",
  startByte: 29,
  endByte: 31,
  isChoice: true,
};

export const SCENE_2_LINE: UnitSpec = {
  bridgeUnitId: "d04f6e35-621e-78cf-80d0-1a3b0416db78",
  sourceUnitKey: "reallive:scene-0002#0000",
  assetId: "ca500bc0-3a3a-74ea-8273-341b123ec2c4",
  startByte: 17,
  endByte: 21,
  isChoice: false,
};

export const SCENE_2_CHOICE_A: UnitSpec = {
  bridgeUnitId: "402c8867-cf61-7afa-a110-843c4f9fab53",
  sourceUnitKey: "reallive:scene-0002#0001",
  assetId: "ca500bc0-3a3a-74ea-8273-341b123ec2c4",
  startByte: 29,
  endByte: 31,
  isChoice: true,
};

export const SCENE_2_CHOICE_B: UnitSpec = {
  bridgeUnitId: "84106326-5a71-737e-b369-b6a0ed46bf2a",
  sourceUnitKey: "reallive:scene-0002#0002",
  assetId: "ca500bc0-3a3a-74ea-8273-341b123ec2c4",
  startByte: 29,
  endByte: 31,
  isChoice: true,
};

export function makeNarrativeUnit(spec: UnitSpec, index: number): NarrativeUnit {
  return {
    unitId: `unit-${spec.sourceUnitKey}`,
    bridgeRef: {
      bridgeUnitId: spec.bridgeUnitId,
      sourceUnitKey: spec.sourceUnitKey,
    },
    surfaceKind: spec.isChoice ? "choice_label" : "dialogue",
    sourceText: "",
    characterId: null,
    evidenceTier: "E2",
    color: null,
    sourceAsset: { assetId: spec.assetId, assetKey: "" },
    engineEvidence: realliveEvidence(
      spec.startByte,
      spec.endByte - spec.startByte,
      `handle-${index}`,
    ),
    choiceId: spec.isChoice ? `choice-${spec.sourceUnitKey}` : null,
    playOrder: index,
    revealOrder: null,
    observedLineIds: [],
    routeMembership: [],
  };
}

export function makeMessage(spec: UnitSpec): NarrativeMessage {
  return {
    order: 0,
    speaker: null,
    text: "",
    textSurface: null,
    engineEvidence: realliveEvidence(spec.startByte, spec.endByte - spec.startByte),
    sourceAsset: { assetId: spec.assetId, assetKey: "" },
    bridgeRef: {
      bridgeUnitId: spec.bridgeUnitId,
      sourceUnitKey: spec.sourceUnitKey,
    },
    linkageStatus: "bridge_linked",
  };
}

export function makeChoice(spec: UnitSpec, optionIndex: number): NarrativeChoice {
  return {
    optionIndex,
    label: "",
    branchEntryScene: null,
    choiceId: `choice-${spec.sourceUnitKey}`,
    bridgeRef: {
      bridgeUnitId: spec.bridgeUnitId,
      sourceUnitKey: spec.sourceUnitKey,
    },
    sourceAsset: { assetId: spec.assetId, assetKey: "" },
    engineEvidence: realliveEvidence(spec.startByte, spec.endByte - spec.startByte),
    branchMessages: [],
  };
}

export function scene(sceneId: number, specs: UnitSpec[]): NarrativeScene {
  return {
    sceneId: sceneRef(sceneId),
    selectionControl: "none",
    nextScene: null,
    messages: [],
    choices: [],
    units: specs.map((spec, index) => makeNarrativeUnit(spec, index)),
  };
}

export function structureFor(scenes: NarrativeScene[]): NarrativeStructure {
  return {
    schemaVersion: "utsushi.narrative-structure.v2",
    engine: "reallive",
    entryScene: scenes[0]?.sceneId ?? "scene:0001",
    sceneDispatchOrder: scenes.map((s) => s.sceneId),
    sourceBundleHash: BUNDLE_HASH,
    scenes,
  };
}

export function wellFormedStructure(): NarrativeStructure {
  return structureFor([
    scene(1, [SCENE_1_LINE, SCENE_1_CHOICE_A, SCENE_1_CHOICE_B]),
    scene(2, [SCENE_2_LINE, SCENE_2_CHOICE_A, SCENE_2_CHOICE_B]),
  ]);
}

export function messageChoiceStructure(): NarrativeStructure {
  const messageChoiceScene = (
    sceneId: number,
    line: UnitSpec,
    choiceA: UnitSpec,
    choiceB: UnitSpec,
  ): NarrativeScene => ({
    sceneId: sceneRef(sceneId),
    selectionControl: "none",
    nextScene: null,
    messages: [makeMessage(line)],
    choices: [makeChoice(choiceA, 0), makeChoice(choiceB, 1)],
  });
  return structureFor([
    messageChoiceScene(1, SCENE_1_LINE, SCENE_1_CHOICE_A, SCENE_1_CHOICE_B),
    messageChoiceScene(2, SCENE_2_LINE, SCENE_2_CHOICE_A, SCENE_2_CHOICE_B),
  ]);
}

export function caught(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
}
