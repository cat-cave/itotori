// Bridge-linked narrative structure projection for RPG Maker sources.
//
// Kaifuu's whole-game extractor already owns the canonical source ordering,
// asset identity, JSON-pointer patch coordinates, and byte ranges. This
// provider projects those verified bridge facts into the common V2 structure
// graph without inventing a second decoder or a partial runtime trace.

import { readFileSync, writeFileSync } from "node:fs";

import {
  assertBridgeBundleV02,
  type BridgeBundleV02,
  type LocalizationUnitV02,
} from "@itotori/localization-bridge-schema";

import {
  NARRATIVE_STRUCTURE_V2,
  parseNarrativeStructure,
  SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS,
  type NarrativeLinkKind,
} from "../structure/index.js";

export class RpgMakerBridgeStructureError extends Error {
  constructor(detail: string) {
    super(`rpg-maker bridge structure refused: ${detail}`);
    this.name = "RpgMakerBridgeStructureError";
  }
}

export function writeRpgMakerBridgeStructure(input: {
  bridgePath: string;
  outputPath: string;
}): void {
  const bridge = readBridge(input.bridgePath);
  const structure = structureFromBridge(bridge);
  parseNarrativeStructure(structure, SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS);
  writeFileSync(input.outputPath, `${JSON.stringify(structure, null, 2)}\n`);
}

function readBridge(path: string): BridgeBundleV02 {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  assertBridgeBundleV02(value);
  return value;
}

function structureFromBridge(bridge: BridgeBundleV02) {
  const sceneId = "bridge:source-order";
  return {
    schemaVersion: NARRATIVE_STRUCTURE_V2,
    engine: "rpg-maker",
    entryScene: sceneId,
    sceneDispatchOrder: [sceneId],
    bridgeId: bridge.bridgeId,
    sourceBundleHash: bridge.sourceBundleHash,
    scenes: [
      {
        sceneId,
        selectionControl: "none",
        nextScene: null,
        messages: [],
        choices: [],
        units: bridge.units.map((unit, index) => structureUnit(unit, index)),
      },
    ],
  };
}

function structureUnit(unit: LocalizationUnitV02, index: number) {
  const range = unit.sourceLocation.range;
  if (range === undefined) {
    throw new RpgMakerBridgeStructureError(
      `bridge unit '${unit.bridgeUnitId}' has no sourceLocation.range`,
    );
  }
  const assetKey = unit.sourceAssetRef.assetKey;
  if (assetKey === undefined) {
    throw new RpgMakerBridgeStructureError(
      `bridge unit '${unit.bridgeUnitId}' has no sourceAssetRef.assetKey`,
    );
  }
  const linkKind = linkKindFor(unit);
  return {
    unitId: `unit:${unit.bridgeUnitId}`,
    bridgeRef: {
      bridgeUnitId: unit.bridgeUnitId,
      sourceUnitKey: unit.sourceUnitKey,
    },
    linkKind,
    surfaceKind: unit.surfaceKind,
    sourceText: unit.sourceText,
    characterId: null,
    evidenceTier: "E0",
    color: null,
    sourceAsset: { assetId: unit.sourceAssetRef.assetId, assetKey },
    engineEvidence: { sourceRange: range },
    choiceId: linkKind === "choice" ? `choice:${unit.bridgeUnitId}` : null,
    playOrder: index,
    revealOrder: { sceneOrder: 0, itemOrder: index },
    observedLineIds: [],
    routeMembership: [],
  };
}

function linkKindFor(unit: LocalizationUnitV02): NarrativeLinkKind {
  if (unit.surfaceKind === "choice_label") return "choice";
  if (unit.surfaceKind === "dialogue" || unit.surfaceKind === "narration") return "line";
  return "non-narrative";
}
