// Read one COMPLETE scene through the strict read-tool surface.
//
// A3 must run at complete-scene scope — never a planner fragment and never a
// truncated window. This module reads the full ordered unit stream via
// `decode_get_units` and PROVES completeness against the deterministic scene
// fact card: a truncated page, a wrong unit count, or a unit that belongs to a
// different scene is a loud failure, not a silently-shortened read. Counts and
// speakers are taken from the fact card and the decoded speaker projection — the
// model never re-counts a line or re-attributes a speaker.

import { decodeGetUnits, type ReadModel, type ReadToolCaller } from "../../read-tools/index.js";
import type { RouteScope, UnitFact } from "../../contracts/index.js";
import type { SceneFactCard } from "../../prepass/index.js";

import { A3RoleError, A3_ROLE_ID, type A3Context, type CompleteScene } from "./types.js";

const MAX_ROWS = 100_000;
const MAX_BYTES = 8_388_608;

/** The A3 caller identity for the local read tools. */
export function a3Caller(context: A3Context): ReadToolCaller {
  return {
    roleId: A3_ROLE_ID,
    routeVisibility: context.routeVisibility,
    localeBranchId: context.localeBranchId,
  };
}

/** The route ids a scope names (empty for global). */
function routeIdsOf(scope: RouteScope): readonly string[] {
  if (scope.kind === "global") return [];
  if (scope.kind === "route") return [scope.routeId];
  return scope.routeIds;
}

/** The scene's route scope, derived from its units: global if any unit is
 * global, otherwise the sorted union of the units' route ids. */
function sceneScope(units: readonly UnitFact[]): RouteScope {
  const scopes = units.map((unit) => unit.value.routeScopes[0]!);
  if (scopes.some((scope) => scope.kind === "global")) return { kind: "global" };
  const ids = [...new Set(scopes.flatMap(routeIdsOf))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (ids.length === 1) return { kind: "route", routeId: ids[0]! };
  return { kind: "route-set", routeIds: ids };
}

/** Distinct reveal-safe speaker labels present in the scene, in first-seen
 * order. Purely a projection of the decoded speaker truth — never a model call. */
function speakerLabelsOf(units: readonly UnitFact[]): readonly string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const unit of units) {
    const speaker = unit.value.speaker;
    if (!speaker) continue;
    if (seen.has(speaker.revealSafeLabel)) continue;
    seen.add(speaker.revealSafeLabel);
    labels.push(speaker.revealSafeLabel);
  }
  return labels;
}

function factCardFor(model: ReadModel, sceneId: string): SceneFactCard {
  const card = model.factSnapshot.scenes.find((scene) => scene.sceneId === sceneId);
  if (!card) throw new A3RoleError("unknown-scene", `no scene ${sceneId} in this snapshot`);
  return card;
}

/**
 * Read the COMPLETE scene, or throw. The read is proven complete against the
 * deterministic fact card: the page must be exhausted (not truncated), the
 * returned unit count must equal the fact card's unit count, and every returned
 * unit must belong to this scene. A fragment CANNOT pass.
 */
export function readCompleteScene(
  model: ReadModel,
  context: A3Context,
  sceneId: string,
): CompleteScene {
  const factCard = factCardFor(model, sceneId);
  if (factCard.unitCount === 0) {
    throw new A3RoleError("empty-scene", `scene ${sceneId} has no translatable units`);
  }
  const caller = a3Caller(context);
  const result = decodeGetUnits(model, caller, {
    selector: { kind: "scene", sceneId },
    maxRows: MAX_ROWS,
    maxBytes: MAX_BYTES,
  });
  if (result.page.kind !== "complete") {
    throw new A3RoleError(
      "incomplete-scene",
      `scene ${sceneId} read was truncated (${result.page.returnedRows} of ${factCard.unitCount})`,
    );
  }
  const units = result.facts;
  if (units.length !== factCard.unitCount) {
    throw new A3RoleError(
      "incomplete-scene",
      `scene ${sceneId} returned ${units.length} units, fact card counts ${factCard.unitCount}`,
    );
  }
  const sceneKey = sceneId;
  for (const unit of units) {
    if (unit.value.sceneId !== sceneKey) {
      throw new A3RoleError(
        "fragment-scene",
        `unit ${unit.factId} belongs to scene ${unit.value.sceneId}, not ${sceneKey}`,
      );
    }
  }
  return {
    sceneId,
    units,
    factCard,
    scope: sceneScope(units),
    speakerLabels: speakerLabelsOf(units),
    characterIds: factCard.characterIds,
  };
}

/** Assert a caller-supplied unit set is exactly the COMPLETE scene — the guard a
 * fold uses to refuse a pre-sliced planner fragment handed in from outside. */
export function assertCompleteSceneUnits(
  model: ReadModel,
  sceneId: string,
  unitIds: readonly string[],
): void {
  const factCard = factCardFor(model, sceneId);
  if (unitIds.length !== factCard.unitCount) {
    throw new A3RoleError(
      "fragment-scene",
      `scene ${sceneId} handed ${unitIds.length} units, complete scene is ${factCard.unitCount}`,
    );
  }
}
