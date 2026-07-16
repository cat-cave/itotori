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
import { deriveWorkSource, type RouteWork, type WorkSource } from "./work-source.js";
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

function foldItem(role: RoleId, route: RouteWork, kinds: readonly WikiObjectKind[]): WorkItem {
  const steps = route.sceneIds.map((sceneId) =>
    step(
      role,
      `${role}:route:${route.routeId}:scene:${sceneId}`,
      { kind: "scene", id: `${sceneId}` },
      route.scope,
      kinds,
    ),
  );
  return { itemId: `${role}:route:${route.routeId}`, role, laneId: route.routeId, steps };
}

/** Enumerate the independent work items for one role over the work source. The
 * granularity — declared on the specialist — selects the fan-out. */
function itemsForRole(specialist: Specialist, source: WorkSource): WorkItem[] {
  const role = specialist.roleId;
  const kinds = authoredKinds(specialist);
  const global: RouteScope = { kind: "global" };
  switch (specialist.granularity) {
    case "per-game":
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
    case "per-term":
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
    case "per-scene":
      return source.routes.map((route) => foldItem(role, route, kinds));
    case "per-route":
      return source.routes.map((route) =>
        singleStepItem(
          role,
          `${role}:route:${route.routeId}`,
          route.routeId,
          { kind: "route", id: route.routeId },
          route.scope,
          kinds,
        ),
      );
    case "per-character":
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
    case "per-character-pair":
      return source.pairs.map(([a, b]) =>
        singleStepItem(
          role,
          `${role}:pair:${a}--${b}`,
          `${a}--${b}`,
          { kind: "character", id: `${a}--${b}` },
          global,
          kinds,
        ),
      );
    case "per-character-route":
      return source.characterIds.flatMap((characterId) =>
        source.routes.map((route) =>
          singleStepItem(
            role,
            `${role}:cr:${characterId}:${route.routeId}`,
            `${characterId}:${route.routeId}`,
            { kind: "character", id: characterId },
            route.scope,
            kinds,
          ),
        ),
      );
    case "per-unit":
      return source.units.map((unit) =>
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
      // A localizer/reviewer granularity never reaches this analyst-only planner.
      throw new Error(`role ${role} has non-analyst granularity ${specialist.granularity}`);
  }
}

/** Build the whole-game source-Wiki plan for a fact snapshot (default roster:
 * all analysts). Pure and deterministic. */
export function buildSourceWikiPlan(
  snapshot: FactSnapshot,
  selection?: readonly RoleId[],
): SourceWikiPlan {
  const specialists = selectSourceWikiRoles(selection);
  const source = deriveWorkSource(snapshot);
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
