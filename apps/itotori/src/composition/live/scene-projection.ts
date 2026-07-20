// The decode → `WorkflowScene[]` adapter — projects a decoded narrative-structure
// artifact into the driver's coherence-ordered work items.
//
// The utsushi-side producer (`../../structure-export/utsushi-structure-seam.ts`)
// writes the narrative-structure JSON; `../../structure/` parses it into the
// normalized decode-side model. This adapter turns that model into what the
// deterministic driver sequences on: one `WorkflowScene` per dispatched, unit-
// bearing scene, in authoritative dispatch order, each carrying the minimal
// decode-derived unit identity (source hash, speaker, route, first-appearance
// risk signal). It also emits the per-unit decode fact + rendering-id map the
// draft assembler (`DraftDeps.buildInput`) consumes to build the P1 input.
//
// Projection is over the v2 unit-bearing export: `firstAppearance` is computed as
// a speaker's first occurrence across the dispatch order. A dispatch-only scene
// with no translatable units is skipped (it carries no work), never emitted empty.

import { createHash } from "node:crypto";
import {
  SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS,
  parseNarrativeStructure,
  type NarrativeScene,
  type NarrativeUnit,
} from "../../structure/index.js";
import type { WorkflowScene, WorkflowUnit } from "../../workflow/index.js";

/** One unit's decode facts, the substrate the draft assembler needs to build the
 * P1 localize input beyond the driver's light sequencing identity. */
export interface DecodeUnitFact {
  readonly unitId: string;
  readonly sceneId: string;
  readonly sourceHash: `sha256:${string}`;
  readonly sourceText: string;
  readonly surfaceKind: string;
  readonly speakerId: string | null;
  readonly routeId: string | null;
}

/** The projection of a decoded structure into the driver's inputs. */
export interface DecodeSceneProjection {
  /** The coherence-ordered scenes the driver sequences and gates. */
  readonly scenes: readonly WorkflowScene[];
  /** Per-unit decode-declared rendering ids (the observed line identities) — the
   * seed `DraftDeps.buildInput` cites; the readiness port resolves the localized-
   * bible rendering ids that supersede these. */
  readonly renderingIdsByUnit: ReadonlyMap<string, readonly string[]>;
  /** Per-unit decode facts for the draft assembler. */
  readonly factsByUnit: ReadonlyMap<string, DecodeUnitFact>;
}

/** Project a decoded narrative-structure artifact (the JSON the structure-export
 * seam writes) into `WorkflowScene[]` + the per-unit fact/rendering maps. */
export function projectDecodeStructure(structureJson: unknown): DecodeSceneProjection {
  const structure = parseNarrativeStructure(structureJson, SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS);
  const sceneById = new Map<number, NarrativeScene>(
    structure.scenes.map((scene) => [scene.sceneId, scene]),
  );

  const seenSpeakers = new Set<string>();
  const scenes: WorkflowScene[] = [];
  const renderingIdsByUnit = new Map<string, readonly string[]>();
  const factsByUnit = new Map<string, DecodeUnitFact>();

  for (const sceneId of structure.sceneDispatchOrder) {
    const scene = sceneById.get(sceneId);
    if (scene === undefined) continue;
    const decodeUnits = orderedUnits(scene);
    if (decodeUnits.length === 0) continue;

    const sceneKey = String(sceneId);
    const sceneRoute = firstRoute(scene.routeMembership);
    const units: WorkflowUnit[] = decodeUnits.map((unit) => {
      const speakerId = unit.characterId;
      const firstAppearance = speakerId !== null && !seenSpeakers.has(speakerId);
      if (speakerId !== null) seenSpeakers.add(speakerId);
      const routeId = firstRoute(unit.routeMembership) ?? sceneRoute;
      const sourceHash = sha256(unit.sourceText);

      renderingIdsByUnit.set(unit.unitId, [...unit.observedLineIds]);
      factsByUnit.set(unit.unitId, {
        unitId: unit.unitId,
        sceneId: sceneKey,
        sourceHash,
        sourceText: unit.sourceText,
        surfaceKind: unit.surfaceKind,
        speakerId,
        routeId,
      });
      return {
        unitId: unit.unitId,
        sourceHash,
        surfaceKind: unit.surfaceKind,
        speakerId,
        routeId,
        firstAppearance,
      };
    });

    scenes.push({ sceneId: sceneKey, units });
  }

  return { scenes, renderingIdsByUnit, factsByUnit };
}

/** A scene's translatable units in play order — decode records `playOrder`, so a
 * missing play order sorts last but stably by unit id. */
function orderedUnits(scene: NarrativeScene): readonly NarrativeUnit[] {
  const units = scene.units ?? [];
  return [...units].sort((left, right) => {
    const leftOrder = left.playOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.playOrder ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.unitId < right.unitId ? -1 : left.unitId > right.unitId ? 1 : 0;
  });
}

function firstRoute(routeMembership: readonly string[] | undefined): string | null {
  return routeMembership && routeMembership.length > 0 ? routeMembership[0]! : null;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
