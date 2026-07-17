// Build the deterministic whole-game source-Wiki plan.
//
// The plan is a pure function of the selected roster and the fact-derived work
// source. It selects the analyst roster (default: all of A1-A10), orders the
// roles into dependency LEVELS from the manifest DAG, and enumerates the
// independent work each role fans out over — with each work item's SERIAL step
// chain and each step's assigned target artifacts. A3 (per-scene) is the one
// progressive fold: its item per route is a serial chain over the route's scenes;
// every other analyst is a single-step item. No model runs here.

import { orderAnalystLevels } from "./ordering.js";
import { selectSourceWikiRoles } from "./roster-selection.js";
import { deriveWorkSource, type WorkSource } from "./work-source.js";
import { artifactKey } from "./accept.js";
import {
  WHOLE_GAME_CONTEXT_SCOPE,
  type ArtifactTarget,
  type Phase,
  type SourceWikiPlan,
  type WorkItem,
  type WorkStep,
} from "./types.js";
import { ROSTER, type Specialist } from "../roster/index.js";
import type { EntityRef, RoleId, RouteScope, WikiObject } from "../contracts/index.js";
import type { FactSnapshot } from "../prepass/index.js";
import type { ReadModel } from "../read-tools/index.js";

type WikiObjectKind = WikiObject["kind"];

/** The wiki-object kinds a role authors per step. Every analyst authors its one
 * declared kind, except A3 which emits both a scene-summary and the running
 * story-so-far for each folded scene. Derived from the manifest, not hardcoded
 * beyond the one documented A3 exception. */
function authoredKinds(specialist: Specialist): readonly WikiObjectKind[] {
  if (specialist.roleId === "A3") return ["scene-summary", "story-so-far"];
  return [specialist.wikiObjectKind];
}

function targetsFor(
  kinds: readonly WikiObjectKind[],
  subject: EntityRef,
  scope: RouteScope,
): ArtifactTarget[] {
  return kinds.map((kind) => ({ kind, subject, scope, key: artifactKey(kind, subject, scope) }));
}

function step(
  role: RoleId,
  stepId: string,
  subject: EntityRef,
  scope: RouteScope,
  kinds: readonly WikiObjectKind[],
): WorkStep {
  return { stepId, role, subject, scope, targets: targetsFor(kinds, subject, scope) };
}

function singleStepItem(
  role: RoleId,
  itemId: string,
  laneId: string,
  subject: EntityRef,
  scope: RouteScope,
  kinds: readonly WikiObjectKind[],
): WorkItem {
  return { itemId, role, laneId, steps: [step(role, itemId, subject, scope, kinds)] };
}

function a3FoldItem(source: WorkSource): WorkItem {
  const steps = source.scenes.map((scene) => {
    const subject = { kind: "scene" as const, id: String(scene.sceneId) };
    return {
      stepId: `A3:game:scene:${scene.sceneId}`,
      role: "A3" as const,
      subject,
      scope: scene.storyScope,
      targets: [
        ...targetsFor(["scene-summary"], subject, scene.sceneScope),
        ...targetsFor(["story-so-far"], subject, scene.storyScope),
      ],
    };
  });
  return { itemId: "A3:game", role: "A3", laneId: "game", steps };
}

function routeSubjectId(scope: RouteScope): string {
  if (scope.kind === "route") return scope.routeId;
  if (scope.kind === "route-set") return scope.routeIds.join(".");
  return "global";
}

/** Enumerate the independent work items for one role over the work source. The
 * granularity — declared on the specialist — selects the fan-out. */
function itemsForRole(specialist: Specialist, source: WorkSource): WorkItem[] {
  const role = specialist.roleId;
  const kinds = authoredKinds(specialist);
  const global: RouteScope = { kind: "global" };
  switch (role) {
    case "A1":
      return [
        singleStepItem(
          role,
          `${role}:game`,
          "game",
          { kind: "game", id: source.gameId },
          global,
          kinds,
        ),
      ];
    case "A2":
      return source.termKeys.map((termKey) =>
        singleStepItem(
          role,
          `${role}:term:${termKey}`,
          termKey,
          { kind: "glossary-term", id: termKey },
          global,
          kinds,
        ),
      );
    case "A3":
      return source.scenes.length === 0 ? [] : [a3FoldItem(source)];
    case "A4": {
      const finalScope = source.scenes.at(-1)?.storyScope;
      if (finalScope === undefined) return [];
      return [
        singleStepItem(
          role,
          `A4:route:${routeSubjectId(finalScope)}`,
          routeSubjectId(finalScope),
          { kind: "route", id: routeSubjectId(finalScope) },
          finalScope,
          kinds,
        ),
      ];
    }
    case "A5":
      return source.characterIds.map((characterId) =>
        singleStepItem(
          role,
          `${role}:char:${characterId}`,
          characterId,
          { kind: "character", id: characterId },
          global,
          kinds,
        ),
      );
    case "A8":
      return source.portraitCharacterIds.map((characterId) =>
        singleStepItem(
          role,
          `${role}:char:${characterId}`,
          characterId,
          { kind: "character", id: characterId },
          global,
          kinds,
        ),
      );
    case "A7":
      return source.portraitCharacterIds.map((characterId) =>
        singleStepItem(
          role,
          `${role}:char:${characterId}`,
          characterId,
          { kind: "character", id: characterId },
          global,
          kinds,
        ),
      );
    case "A9":
      return source.characterRoutePairs.map((pair) =>
        singleStepItem(
          role,
          `${role}:cr:${pair.characterId}:${pair.routeId}`,
          `${pair.characterId}:${pair.routeId}`,
          { kind: "character", id: pair.characterId },
          { kind: "route", routeId: pair.routeId },
          kinds,
        ),
      );
    case "A6":
      return source.adaptationUnits.map((unit) =>
        singleStepItem(
          role,
          `${role}:unit:${unit.unitId}`,
          unit.unitId,
          { kind: "unit", id: unit.unitId },
          unit.scope,
          kinds,
        ),
      );
    case "A10":
      return source.unknownSpeakerUnits.map((unit) =>
        singleStepItem(
          role,
          `${role}:unit:${unit.unitId}`,
          unit.unitId,
          { kind: "unit", id: unit.unitId },
          unit.scope,
          kinds,
        ),
      );
    default:
      throw new Error(`source-Wiki planner has no emission mapping for ${role}`);
  }
}

/** Build the whole-game source-Wiki plan for a fact snapshot (default roster:
 * all analysts). Pure and deterministic. */
export function buildSourceWikiPlan(
  snapshot: FactSnapshot,
  selection?: readonly RoleId[],
  options?: {
    readonly readModel?: ReadModel;
    readonly portraitCharacterIds?: readonly string[];
  },
): SourceWikiPlan {
  const specialists = selectSourceWikiRoles(selection);
  const source = deriveWorkSource(snapshot, options);
  const levels = orderAnalystLevels(specialists);
  const phases: Phase[] = levels.map((roles, index) => ({
    level: index,
    roles,
    items: roles.flatMap((roleId) => itemsForRole(ROSTER[roleId], source)),
  }));
  return {
    roles: specialists.map((specialist) => specialist.roleId),
    contextScope: WHOLE_GAME_CONTEXT_SCOPE,
    phases,
  };
}
