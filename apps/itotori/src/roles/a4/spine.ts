// Adopt the route spine — never reconstruct topology.
//
// A4 does not re-derive the route. It ADOPTS the final progressive story-so-far
// authored by the scene fold and reasons over the deterministic dispatch order
// the decode already fixed. This module proves the adoption is honest: the
// spine must be a `story-so-far` object, it must actually run through the final
// dispatched scene, and the scenes it claims to cover must be EXACTLY the
// decode's `sceneDispatchOrder`. A spine that reordered, dropped, or stopped
// before a scene — the signature of a re-derived topology — is a loud failure,
// so the module can only reason over the authoritative order, never invent one.

import type { ReadModel } from "../../read-tools/index.js";
import type { RouteScope } from "../../contracts/index.js";

import { A4RoleError, A4_ROUTE_ARC_KIND, type A4RouteSpine } from "./types.js";

/** The route scope, spine object id, and covered order the reconciler adopts,
 * proven to match the deterministic topology. */
export interface AdoptedSpine {
  readonly routeScope: RouteScope;
  readonly spineObjectId: string;
  readonly spineVersion: number;
  /** Same-snapshot evidence the final story-so-far already cited. A4 re-resolves
   * it for the route-arc summary claim; it never invents a new route anchor. */
  readonly evidenceIds: readonly string[];
  readonly coveredSceneIds: readonly string[];
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function evidenceIdsOf(spine: A4RouteSpine["finalStorySoFar"]): readonly string[] {
  return [
    ...new Set(
      spine.claims.flatMap((claim) => claim.citations.map((citation) => citation.evidenceId)),
    ),
  ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * Adopt the spine or throw. The spine must be the final `story-so-far` object,
 * and its covered scenes must equal the decoded route order verbatim. Its
 * deterministic `throughSceneId` must also name the final dispatched scene, so
 * a stale intermediate story cannot masquerade as the final route spine. The
 * returned scope is the spine's own scope — inherited, not recomputed — so every
 * route-arc claim carries the route scope the spine was authored under.
 */
export function adoptSpine(model: ReadModel, spine: A4RouteSpine): AdoptedSpine {
  const object = spine.finalStorySoFar;
  if (object.kind !== "story-so-far") {
    throw new A4RoleError(
      "spine-not-story-so-far",
      `the spine must be a story-so-far object, got ${object.kind}`,
    );
  }
  const expectedOrder =
    spine.expectedSceneIds ?? model.factSnapshot.routeTopology.sceneDispatchOrder;
  if (!sameOrder(spine.coveredSceneIds, expectedOrder)) {
    throw new A4RoleError(
      "spine-topology-mismatch",
      `spine covers [${spine.coveredSceneIds.join(", ")}] but the decode dispatches ` +
        `[${expectedOrder.join(", ")}] — the authoritative topology is not reconstructed here`,
    );
  }
  const finalSceneId = expectedOrder.at(-1);
  if (finalSceneId === undefined || object.body.throughSceneId !== String(finalSceneId)) {
    throw new A4RoleError(
      "spine-final-scene-mismatch",
      `story through scene ${object.body.throughSceneId} is not the final dispatched scene ` +
        `${finalSceneId === undefined ? "(none)" : finalSceneId}`,
    );
  }
  const evidenceIds = evidenceIdsOf(object);
  if (evidenceIds.length === 0) {
    throw new A4RoleError(
      "spine-without-evidence",
      "the final story-so-far has no cited facts for the route-arc summary claim",
    );
  }
  return {
    routeScope: object.scope,
    spineObjectId: object.objectId,
    spineVersion: object.version,
    evidenceIds,
    coveredSceneIds: [...expectedOrder],
  };
}

/** A stable route identifier for a scope — used to key the emitted route-arc and
 * its claims. Deterministic across runs; never a model value. */
export function routeIdOf(scope: RouteScope): string {
  if (scope.kind === "route") return scope.routeId;
  if (scope.kind === "route-set") return scope.routeIds.join(".");
  return "global";
}

/** The kind string every route-arc object carries. */
export const ROUTE_ARC_KIND = A4_ROUTE_ARC_KIND;
