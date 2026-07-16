// Bridge the materialized fact snapshot into the ContextSnapshot.
//
// The ContextSnapshot is the trust root. We commit the fact snapshot two ways:
//   * `factMaterialization` — a revision ref whose contentHash IS the fact
//     snapshot's content hash, so the ContextSnapshot's own snapshotId folds in
//     the ENTIRE materialized fact set (any changed fact => new context id); and
//   * `facts` — the stable, citeable namespaced fact ids (unit/choice/scene/
//     character/glossary) with play order + route scope, for bounded projection.

import type { LlmRevisionRef, LlmSnapshotFact, LlmSnapshotFactRouteScope } from "@itotori/db";

import type { FactRouteScope, FactSnapshot } from "./types.js";

function toSnapshotRouteScope(scope: FactRouteScope): LlmSnapshotFactRouteScope {
  if (scope.kind === "route") return { kind: "route", routeId: scope.routeId };
  if (scope.kind === "route-set") return { kind: "route-set", routeIds: [...scope.routeIds] };
  return { kind: "global" };
}

/** The fact-materialization revision ref (contentHash === snapshot content). */
export function factMaterializationRef(snapshot: FactSnapshot): LlmRevisionRef {
  return {
    revisionId: snapshot.contentHash.replace(/^sha256:/u, ""),
    contentHash: snapshot.contentHash,
  };
}

/**
 * Derive the committable `facts` array (every namespaced fact id in the
 * materialization) plus the `factMaterialization` revision ref. Merge these
 * into an {@link LlmContextSnapshotInput} to commit the facts into a snapshot.
 */
export function contextSnapshotFactsFrom(snapshot: FactSnapshot): {
  facts: LlmSnapshotFact[];
  factMaterialization: LlmRevisionRef;
} {
  const facts: LlmSnapshotFact[] = [];

  for (const unit of snapshot.orderedUnits) {
    facts.push({
      factId: unit.factId,
      playOrderIndex: unit.playReveal.playOrderIndex,
      routeScope: toSnapshotRouteScope(unit.routeScope),
    });
  }
  for (const scene of snapshot.scenes) {
    facts.push({
      factId: scene.factId,
      playOrderIndex: scene.playOrderIndex ?? 0,
      routeScope: { kind: "global" },
    });
  }
  for (const character of snapshot.characters) {
    facts.push({
      factId: character.factId,
      playOrderIndex: 0,
      routeScope: { kind: "global" },
    });
  }
  for (const term of snapshot.terminology) {
    facts.push({
      factId: term.factId,
      playOrderIndex: 0,
      routeScope: { kind: "global" },
    });
  }

  return { facts, factMaterialization: factMaterializationRef(snapshot) };
}
