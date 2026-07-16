// A real-bytes claim fixture: a ReadModel built from a genuine Bridge v0.2
// bundle (from extraction) so evidence resolution runs against decoded bytes,
// not synthetic stand-ins. Scene 1 units are global; scene 2 units can be put
// on a route so out-of-route resolution is falsifiable. Reused by the claim
// validation and dependency proofs.

import { readFileSync } from "node:fs";

import {
  contextSnapshot,
  type LlmContextSnapshotInput,
  type LlmRevealHorizon,
  type LlmRevisionRef,
} from "@itotori/db";
import type { BridgeBundleV02, SpeakerContextV02 } from "@itotori/localization-bridge-schema";

import {
  buildReadModel,
  type CharacterProfile,
  type ReadModel,
} from "../../src/read-tools/index.js";
import {
  buildFactSnapshot,
  contextSnapshotFactsFrom,
  type FactSnapshot,
} from "../../src/prepass/index.js";
import type {
  NarrativeMessage,
  NarrativeScene,
  NarrativeStructure,
  NarrativeUnit,
} from "../../src/structure/types.js";

const BUNDLE_HASH = "sha256:3065996aa103c1c827f13998f8d44046d5df0b9d5f30a1f0027544de71be6927";

type Spec = {
  bridgeUnitId: string;
  sourceUnitKey: string;
  assetId: string;
  s: number;
  e: number;
  choice: boolean;
};

const S1_LINE: Spec = {
  bridgeUnitId: "a06a6efc-b1f0-7483-b225-40f197a3bc83",
  sourceUnitKey: "reallive:scene-0001#0000",
  assetId: "df9fc555-e560-7887-a9d1-6c5b0ac311a4",
  s: 17,
  e: 21,
  choice: false,
};
const S1_A: Spec = {
  bridgeUnitId: "9706a898-f08a-7ba9-99e6-c304e0235874",
  sourceUnitKey: "reallive:scene-0001#0001",
  assetId: "df9fc555-e560-7887-a9d1-6c5b0ac311a4",
  s: 29,
  e: 31,
  choice: true,
};
const S1_B: Spec = {
  bridgeUnitId: "b43c7e66-a03e-713b-89cc-797c5ff9216f",
  sourceUnitKey: "reallive:scene-0001#0002",
  assetId: "df9fc555-e560-7887-a9d1-6c5b0ac311a4",
  s: 29,
  e: 31,
  choice: true,
};
const S2_LINE: Spec = {
  bridgeUnitId: "d04f6e35-621e-78cf-80d0-1a3b0416db78",
  sourceUnitKey: "reallive:scene-0002#0000",
  assetId: "ca500bc0-3a3a-74ea-8273-341b123ec2c4",
  s: 17,
  e: 21,
  choice: false,
};
const S2_A: Spec = {
  bridgeUnitId: "402c8867-cf61-7afa-a110-843c4f9fab53",
  sourceUnitKey: "reallive:scene-0002#0001",
  assetId: "ca500bc0-3a3a-74ea-8273-341b123ec2c4",
  s: 29,
  e: 31,
  choice: true,
};
const S2_B: Spec = {
  bridgeUnitId: "84106326-5a71-737e-b369-b6a0ed46bf2a",
  sourceUnitKey: "reallive:scene-0002#0002",
  assetId: "ca500bc0-3a3a-74ea-8273-341b123ec2c4",
  s: 29,
  e: 31,
  choice: true,
};

export function loadBundle(): BridgeBundleV02 {
  const raw = readFileSync(new URL("../fixtures/whole-seen-bridge.json", import.meta.url), "utf8");
  return JSON.parse(raw) as BridgeBundleV02;
}

function unit(spec: Spec, index: number, routeMembership: string[]): NarrativeUnit {
  return {
    unitId: `unit-${spec.sourceUnitKey}`,
    bridgeRef: { bridgeUnitId: spec.bridgeUnitId, sourceUnitKey: spec.sourceUnitKey },
    surfaceKind: spec.choice ? "choice_label" : "dialogue",
    sourceText: "",
    characterId: null,
    evidenceTier: "E2",
    color: null,
    sourceAsset: { assetId: spec.assetId, assetKey: "" },
    byteOffsetInScene: spec.s,
    byteLength: spec.e - spec.s,
    rawByteHandle: `handle-${index}`,
    choiceId: spec.choice ? `choice-${spec.sourceUnitKey}` : null,
    playOrder: index,
    revealOrder: null,
    observedLineIds: [],
    routeMembership,
  };
}

function scene(
  sceneId: number,
  specs: Spec[],
  nextScene: number | null,
  routes: string[],
  messages: NarrativeMessage[] = [],
): NarrativeScene {
  return {
    sceneId,
    selectionControl: "none",
    nextScene,
    messages,
    choices: [],
    units: specs.map((spec, index) => unit(spec, index, routes)),
  };
}

/** One canonical character to attribute decode-only scene-1 messages to, so the
 * fact snapshot materializes a real character occurrence + index entry. */
export interface FixtureCharacterSpec {
  characterId: string;
  decodedLabel: string;
  /** How many decode-only lines this character speaks in scene 1. */
  lines: number;
  /** The play-order index of the ordered unit bound as this character's evidence. */
  boundUnitPlayOrder: number;
}

function characterMessages(characters: readonly FixtureCharacterSpec[]): NarrativeMessage[] {
  const messages: NarrativeMessage[] = [];
  let order = 0;
  for (const character of characters) {
    for (let line = 0; line < character.lines; line += 1) {
      messages.push({
        order,
        speaker: character.decodedLabel,
        characterId: character.characterId,
        text: character.decodedLabel,
        textSurface: character.decodedLabel,
      });
      order += 1;
    }
  }
  return messages;
}

function structure(
  scene2Routes: string[],
  characters: readonly FixtureCharacterSpec[],
): NarrativeStructure {
  return {
    schemaVersion: "utsushi.narrative-structure.v2",
    entryScene: 1,
    sceneDispatchOrder: [1, 2],
    sourceBundleHash: BUNDLE_HASH,
    scenes: [
      scene(1, [S1_LINE, S1_A, S1_B], 2, [], characterMessages(characters)),
      scene(2, [S2_LINE, S2_A, S2_B], null, scene2Routes),
      { sceneId: 3, selectionControl: "none", nextScene: null, messages: [], choices: [] },
    ],
  };
}

const revision = (id: string): LlmRevisionRef => ({
  revisionId: id,
  contentHash: `sha256:${"0".repeat(63)}${id.length % 10}`,
});

function makeContext(snapshot: FactSnapshot, revealHorizon: LlmRevealHorizon) {
  const { facts, factMaterialization } = contextSnapshotFactsFrom(snapshot);
  const input: LlmContextSnapshotInput = {
    sourceLanguage: "ja-JP",
    decode: revision("decode"),
    sourceUnits: snapshot.orderedUnits.map((u) => ({ unitId: u.factId, sourceHash: u.sourceHash })),
    facts,
    structure: revision("structure"),
    routeGraph: revision("route-graph"),
    glossary: revision("glossary"),
    style: revision("style"),
    revealHorizon,
    humanCorrections: revision("corrections"),
    externalSources: null,
    contextScope: "whole-game",
    factMaterialization,
  };
  return contextSnapshot(input);
}

export interface ClaimFixtureOptions {
  revealHorizon?: LlmRevealHorizon;
  scene2Routes?: string[];
  /** Canonical characters to seed into the deterministic index + profiles. */
  characters?: readonly FixtureCharacterSpec[];
  /** Override the decoded bundle the READ MODEL exposes (source text / spans),
   * while the fact snapshot stays built from the real fixture bytes. The override
   * must keep the same bridgeUnitIds so snapshot units still bind. Used to stage
   * decoded source text a source-text-scanning role reasons over. */
  modelBundle?: (bundle: BridgeBundleV02) => BridgeBundleV02;
  /** Override a bundle unit's decoded speaker context, keyed by sourceUnitKey.
   * The default bundle carries `not_applicable` speakers; this lets a proof stage
   * known / parser-unknown / reader-unknown speakers on specific units. */
  unitSpeakers?: ReadonlyMap<string, SpeakerContextV02>;
}

/** Apply per-unit speaker overrides onto a freshly loaded bundle. */
function patchSpeakers(
  bundle: BridgeBundleV02,
  unitSpeakers: ReadonlyMap<string, SpeakerContextV02> | undefined,
): BridgeBundleV02 {
  if (!unitSpeakers || unitSpeakers.size === 0) return bundle;
  return {
    ...bundle,
    units: bundle.units.map((unit) => {
      const speaker = unitSpeakers.get(unit.sourceUnitKey);
      return speaker ? { ...unit, speaker } : unit;
    }),
  };
}

/** Build the immutable read model + fact snapshot for the fixture bytes. */
export function buildClaimFixture(options: ClaimFixtureOptions = {}): {
  model: ReadModel;
  snapshot: FactSnapshot;
} {
  const revealHorizon = options.revealHorizon ?? { kind: "complete" };
  const scene2Routes = options.scene2Routes ?? [];
  const characters = options.characters ?? [];
  // unitSpeakers patch the fact snapshot (A10 reads unknown speakers from it); modelBundle
  // overrides ONLY the read model's source text, leaving the snapshot on real fixture bytes.
  const snapshotBundle = patchSpeakers(loadBundle(), options.unitSpeakers);
  const modelBundle = patchSpeakers(
    options.modelBundle ? options.modelBundle(loadBundle()) : loadBundle(),
    options.unitSpeakers,
  );
  const snapshot = buildFactSnapshot(structure(scene2Routes, characters), snapshotBundle);
  const characterProfiles = new Map<string, CharacterProfile>(
    characters.map((character) => [
      character.characterId,
      {
        decodedLabel: character.decodedLabel,
        revealStatus: "revealed",
        unitIds: [unitFactIdAt(snapshot, character.boundUnitPlayOrder)],
      },
    ]),
  );
  const model = buildReadModel({
    contextSnapshot: makeContext(snapshot, revealHorizon),
    factSnapshot: snapshot,
    bundle: modelBundle,
    characterProfiles,
  });
  return { model, snapshot };
}

/** The fact id of the ordered unit at a given play order (0-based). */
export function unitFactIdAt(snapshot: FactSnapshot, playOrderIndex: number): string {
  return snapshot.orderedUnits.find((u) => u.playReveal.playOrderIndex === playOrderIndex)!.factId;
}
