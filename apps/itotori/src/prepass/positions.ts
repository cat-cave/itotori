// Deterministic play/reveal ordering + route membership, keyed by bridgeUnitId.
//
// Walks the decode in PLAY order: the replay-derived sceneDispatchOrder first,
// then any scene not on that order (appended by ascending sceneId), and within
// each scene the authoritative flat `units[]` (or, when a scene carries only
// message/choice shapes, its messages then choices then branch messages). Every
// element that carries a bridge ref gets the next monotonic play index, so the
// ordering is a pure function of the decode regardless of whether the optional
// per-element playOrder fields are populated.

import type {
  NarrativeChoice,
  NarrativeMessage,
  NarrativeScene,
  NarrativeStructure,
  NarrativeUnit,
} from "../structure/types.js";

export type NarrativePosition = {
  bridgeUnitId: string;
  sourceUnitKey: string;
  sceneId: string;
  playOrderIndex: number;
  revealSceneOrder: number | null;
  revealItemOrder: number | null;
  routeMembership: readonly string[];
};

function orderedScenes(structure: NarrativeStructure): NarrativeScene[] {
  const byId = new Map(structure.scenes.map((scene) => [scene.sceneId, scene]));
  const seen = new Set<string>();
  const ordered: NarrativeScene[] = [];
  for (const sceneId of structure.sceneDispatchOrder) {
    const scene = byId.get(sceneId);
    if (scene !== undefined && !seen.has(sceneId)) {
      seen.add(sceneId);
      ordered.push(scene);
    }
  }
  for (const scene of [...structure.scenes].sort((a, b) => a.sceneId.localeCompare(b.sceneId))) {
    if (!seen.has(scene.sceneId)) {
      seen.add(scene.sceneId);
      ordered.push(scene);
    }
  }
  return ordered;
}

function unitPosition(unit: NarrativeUnit): {
  bridgeUnitId: string;
  sourceUnitKey: string;
  revealSceneOrder: number | null;
  revealItemOrder: number | null;
  routeMembership: readonly string[];
} {
  return {
    bridgeUnitId: unit.bridgeRef.bridgeUnitId,
    sourceUnitKey: unit.bridgeRef.sourceUnitKey,
    revealSceneOrder: unit.revealOrder?.sceneOrder ?? null,
    revealItemOrder: unit.revealOrder?.itemOrder ?? null,
    routeMembership: unit.routeMembership,
  };
}

function messagePosition(message: NarrativeMessage): {
  bridgeUnitId: string;
  sourceUnitKey: string;
  revealSceneOrder: number | null;
  revealItemOrder: number | null;
  routeMembership: readonly string[];
} | null {
  const ref = message.bridgeRef;
  if (!ref || message.linkageStatus === "runtime_only") return null;
  return {
    bridgeUnitId: ref.bridgeUnitId,
    sourceUnitKey: ref.sourceUnitKey,
    revealSceneOrder: message.revealOrder?.sceneOrder ?? null,
    revealItemOrder: message.revealOrder?.itemOrder ?? null,
    routeMembership: message.routeMembership ?? [],
  };
}

function choicePosition(choice: NarrativeChoice): {
  bridgeUnitId: string;
  sourceUnitKey: string;
  revealSceneOrder: number | null;
  revealItemOrder: number | null;
  routeMembership: readonly string[];
} | null {
  const ref = choice.bridgeRef;
  if (!ref) return null;
  return {
    bridgeUnitId: ref.bridgeUnitId,
    sourceUnitKey: ref.sourceUnitKey,
    revealSceneOrder: null,
    revealItemOrder: null,
    routeMembership: [],
  };
}

/**
 * Build a bridgeUnitId -> {@link NarrativePosition} map in stable play order.
 * The first sighting of a bridge id fixes its play index; a later alternate
 * representation of the same unit (units[] plus a message/choice) does not
 * reorder it. Runtime-only messages contribute nothing.
 */
export function indexNarrativePositions(
  structure: NarrativeStructure,
): Map<string, NarrativePosition> {
  const positions = new Map<string, NarrativePosition>();
  let playOrderIndex = 0;
  const assign = (
    sceneId: string,
    element: {
      bridgeUnitId: string;
      sourceUnitKey: string;
      revealSceneOrder: number | null;
      revealItemOrder: number | null;
      routeMembership: readonly string[];
    } | null,
  ): void => {
    if (element === null || positions.has(element.bridgeUnitId)) return;
    positions.set(element.bridgeUnitId, {
      bridgeUnitId: element.bridgeUnitId,
      sourceUnitKey: element.sourceUnitKey,
      sceneId,
      playOrderIndex,
      revealSceneOrder: element.revealSceneOrder,
      revealItemOrder: element.revealItemOrder,
      routeMembership: element.routeMembership,
    });
    playOrderIndex += 1;
  };

  for (const scene of orderedScenes(structure)) {
    for (const unit of scene.units ?? []) assign(scene.sceneId, unitPosition(unit));
    for (const message of scene.messages) assign(scene.sceneId, messagePosition(message));
    for (const choice of scene.choices) {
      assign(scene.sceneId, choicePosition(choice));
      for (const message of choice.branchMessages) {
        assign(scene.sceneId, messagePosition(message));
      }
    }
  }
  return positions;
}
