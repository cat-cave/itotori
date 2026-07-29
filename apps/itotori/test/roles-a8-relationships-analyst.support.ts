import type { WikiObject } from "../src/contracts/index.js";
import {
  assembleCharacterBio,
  buildCharacterPortrait,
  characterIndex as a7CharacterIndex,
  readCharacterEvidence as a7ReadEvidence,
  type A7BioDraft,
  type A7Context,
  type A7PortraitProvider,
} from "../src/roles/a7/index.js";
import {
  assembleCharacterBackground,
  characterIndex,
  counterpartIds,
  readCharacterEvidence,
  sceneEvidenceId,
  type A8BackgroundDraft,
  type A8BackgroundRequest,
  type A8Context,
  type A8ModelCaller,
  type A8RelationshipDraft,
} from "../src/roles/a8/index.js";
import { buildClaimFixture, type FixtureCharacterSpec } from "./support/claim-fixture.js";

export const CONTEXT: A8Context = {
  runMode: "test-dev",
  contextScope: "whole-game",
  routeVisibility: { kind: "global" },
  localeBranchId: null,
};

export const A7_CONTEXT: A7Context = {
  runMode: "test-dev",
  contextScope: "whole-game",
  routeVisibility: { kind: "global" },
  localeBranchId: null,
};

export const SCENE_1 = "scene:0001";

export const SCENE_2 = "scene:0002";

export const SCENE_3 = "scene:0003";

export const SCENE_999 = "scene:0999";

export const CHARACTERS: readonly FixtureCharacterSpec[] = [
  { characterId: "nam-11", decodedLabel: "アイ", lines: 2, boundUnitPlayOrder: 0 },
  { characterId: "nam-22", decodedLabel: "ケイ", lines: 1, boundUnitPlayOrder: 1 },
];

export function fixture() {
  return buildClaimFixture({ characters: CHARACTERS, scene2Routes: ["route-a"] });
}

export const portraits: A7PortraitProvider = (characterId) => ({
  status: "available",
  facts: {
    artifactUri: `artifacts/utsushi/runtime/test-run/screenshots/portrait-${characterId}.png`,
    contentHash: `sha256:${(characterId === "nam-11" ? "a" : "b").repeat(64)}`,
    mediaType: "image/png",
    dimensions: { width: 256, height: 256 },
    access: { redaction: "default-redacted", permission: "project-member" },
  },
});

export function bioFor(
  model: ReturnType<typeof fixture>["model"],
  characterId: string,
): WikiObject {
  const character = a7CharacterIndex(model).find((c) => c.characterId === characterId)!;
  const evidence = a7ReadEvidence(model, A7_CONTEXT, character);
  const draft: A7BioDraft = {
    storyRole: `${evidence.decodedLabel} は物語を動かす。`,
    definingTraits: ["まっすぐ"],
    notableMomentEvidenceIds: [evidence.notableUnitIds[0]!],
    claims: [],
  };
  return assembleCharacterBio(
    model,
    A7_CONTEXT,
    evidence,
    draft,
    buildCharacterPortrait(characterId, portraits(characterId)),
  );
}

export function bioProvider(model: ReturnType<typeof fixture>["model"]) {
  const bios = new Map(CHARACTERS.map((c) => [c.characterId, bioFor(model, c.characterId)]));
  return (characterId: string): WikiObject => bios.get(characterId)!;
}

export function recordedCaller(): A8ModelCaller {
  return async (request) => {
    const other = request.counterpartIds.find((id) => id !== request.character.characterId)!;
    const relationships: A8RelationshipDraft[] = [
      {
        counterpartId: other,
        relationship: "幼なじみ。",
        confidence: "high",
        scope: { kind: "global" },
        establishingSceneIds: [sceneEvidenceId(SCENE_1)],
      },
    ];
    return { background: `${request.character.decodedLabel} の生い立ち。`, relationships };
  };
}

export function assembleOne(
  model: ReturnType<typeof fixture>["model"],
  characterId: string,
  relationships: readonly A8RelationshipDraft[],
  bio?: WikiObject,
): WikiObject {
  const character = characterIndex(model).find((c) => c.characterId === characterId)!;
  const evidence = readCharacterEvidence(model, CONTEXT, character);
  const request: A8BackgroundRequest = {
    character: evidence,
    bio: bio ?? bioFor(model, characterId),
    counterpartIds: counterpartIds(model),
    sourceLanguage: model.sourceLanguage,
  };
  const draft: A8BackgroundDraft = { background: "生い立ち。", relationships };
  return assembleCharacterBackground(model, CONTEXT, evidence, request, draft);
}
