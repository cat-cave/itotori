// Read P1's complete scene/bible context through the strict local tool surface.
//
// This is deliberately not a caller-provided prompt bundle. `decode_get_units`,
// `outputs_get_accepted`, and `glossary_lookup` enforce P1's permission,
// snapshot, reveal, route, and locale boundaries before a localizer can reason.

import type { GlossaryFactValue, RouteScope, UnitFact } from "../../contracts/index.js";
import {
  decodeGetUnits,
  glossaryLookup,
  outputsGetAccepted,
  type ReadModel,
  type ReadToolCaller,
} from "../../read-tools/index.js";

import { normalizeScene } from "./plan.js";
import {
  P1_ROLE_ID,
  P1RoleError,
  type P1Context,
  type P1ReadScene,
  type P1SceneInput,
} from "./agent-types.js";

const MAX_ROWS = 100_000;
const MAX_BYTES = 8_388_608;

/** The P1 identity granted to the local read-tool surface. */
export function p1Caller(context: P1Context): ReadToolCaller {
  return {
    roleId: P1_ROLE_ID,
    routeVisibility: context.routeVisibility,
    localeBranchId: context.localeBranchId,
  };
}

function routeIdsOf(scope: RouteScope): readonly string[] {
  if (scope.kind === "global") return [];
  return scope.kind === "route" ? [scope.routeId] : scope.routeIds;
}

/** Deterministically derive the narrowest scene scope from the decoded units. */
function scopeFor(units: readonly UnitFact[]): RouteScope {
  const scopes = units.map((unit) => unit.value.routeScopes[0]!);
  if (scopes.some((scope) => scope.kind === "global")) return { kind: "global" };
  const routeIds = [...new Set(scopes.flatMap(routeIdsOf))].sort((a, b) => a.localeCompare(b));
  return routeIds.length === 1
    ? { kind: "route", routeId: routeIds[0]! }
    : { kind: "route-set", routeIds };
}

/** Read and prove one full source scene, the exact accepted localized-bible
 * entries, all visible glossary facts, and earlier accepted target dialogue. */
export function readP1Scene(
  model: ReadModel,
  context: P1Context,
  input: P1SceneInput,
): P1ReadScene {
  const factCard = model.factSnapshot.scenes.find((scene) => scene.sceneId === input.sceneId);
  if (!factCard) throw new P1RoleError("unknown-scene", `no scene ${input.sceneId} in snapshot`);
  if (factCard.unitCount === 0) {
    throw new P1RoleError("empty-scene", `scene ${input.sceneId} has no translatable units`);
  }
  if (input.bibleSubjectIds.length === 0) {
    throw new P1RoleError(
      "missing-bible-entry",
      "P1 requires at least one localized-bible subject",
    );
  }

  const caller = p1Caller(context);
  const unitResult = decodeGetUnits(model, caller, {
    selector: { kind: "scene", sceneId: input.sceneId },
    maxRows: MAX_ROWS,
    maxBytes: MAX_BYTES,
  });
  if (unitResult.page.kind !== "complete" || unitResult.facts.length !== factCard.unitCount) {
    throw new P1RoleError(
      "incomplete-scene",
      `scene ${input.sceneId} returned ${unitResult.facts.length} of ${factCard.unitCount} units`,
    );
  }
  const sceneId = String(input.sceneId);
  if (unitResult.facts.some((unit) => unit.value.sceneId !== sceneId)) {
    throw new P1RoleError(
      "incomplete-scene",
      `scene ${input.sceneId} contains another scene's unit`,
    );
  }

  const bibleResult = outputsGetAccepted(model, caller, {
    subjectIds: [...input.bibleSubjectIds],
    stage: "localized-bible",
    maxRows: MAX_ROWS,
    maxBytes: MAX_BYTES,
  });
  if (bibleResult.page.kind !== "complete") {
    throw new P1RoleError("incomplete-bible", "localized-bible read was truncated");
  }
  const bibleBySubject = new Map(
    bibleResult.outputs
      .filter((output) => output.subjectType === "localized-rendering")
      .map((output) => [output.subjectId, output.value] as const),
  );
  for (const subjectId of input.bibleSubjectIds) {
    if (!bibleBySubject.has(subjectId)) {
      throw new P1RoleError(
        "missing-bible-entry",
        `no accepted localized rendering for ${subjectId}`,
      );
    }
  }

  const glossaryResult = glossaryLookup(model, caller, {
    selector: { kind: "all" },
    maxRows: MAX_ROWS,
    maxBytes: MAX_BYTES,
  });
  if (glossaryResult.page.kind !== "complete") {
    throw new P1RoleError("incomplete-bible", "localized glossary read was truncated");
  }

  // Read all scene-addressed accepted targets once. Existing P1-finalized cores
  // subsequently overwrite this map only after their validation succeeds.
  const priorResult = outputsGetAccepted(model, caller, {
    subjectIds: unitResult.facts.map((unit) => unit.factId),
    maxRows: MAX_ROWS,
    maxBytes: MAX_BYTES,
  });
  if (priorResult.page.kind !== "complete") {
    throw new P1RoleError("incomplete-scene", "accepted-target read was truncated");
  }
  const priorAcceptedTarget = new Map<string, { version: number; targetSkeleton: string }>();
  for (const output of priorResult.outputs) {
    if (output.subjectType !== "unit") continue;
    const prior = priorAcceptedTarget.get(output.subjectId);
    if (!prior || output.version > prior.version) {
      priorAcceptedTarget.set(output.subjectId, {
        version: output.version,
        targetSkeleton: output.value.targetSkeleton,
      });
    }
  }

  const units = unitResult.facts;
  return {
    sceneId,
    units,
    normalizedUnits: normalizeScene(units).units,
    scope: scopeFor(units),
    bibleEntries: input.bibleSubjectIds.map((subjectId) => bibleBySubject.get(subjectId)!),
    glossaryEntries: glossaryResult.facts.map((fact) => fact.value as GlossaryFactValue),
    priorAcceptedTarget: new Map(
      [...priorAcceptedTarget].map(([unitId, prior]) => [unitId, prior.targetSkeleton]),
    ),
  };
}
