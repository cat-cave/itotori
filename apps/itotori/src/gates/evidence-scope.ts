// Gate: evidence visibility / scope / support (`evidence-scope`; categories
// `evidence`, `scope`).
//
// Every evidence id an accepted output cites must resolve to a context fact
// that is: (1) present in the corpus — else `evidence`; (2) a member of the
// SAME context snapshot — else `scope`; (3) visible to the cited unit, i.e. its
// visibility route scope covers the unit's route and its reveal horizon spans
// the unit's play order — else `scope`; and (4) in a correct support role — a
// fact may not cite ITSELF as its own supporting evidence — else `evidence`.
// The gate cannot run without the evidence corpus, so when evidence is present
// but no corpus is supplied it fails loud rather than skipping.

import type { Defect, Fact, RouteScope } from "../contracts/index.js";
import type { FactRouteScope, FactSnapshot } from "../prepass/index.js";

import { buildDefect, GateEvaluationError } from "./defect.js";
import { bindAccepted } from "./unit-index.js";
import type { AcceptedUnitOutput } from "./types.js";

function routesOf(scope: RouteScope | FactRouteScope): { global: boolean; routes: Set<string> } {
  if (scope.kind === "global") return { global: true, routes: new Set() };
  if (scope.kind === "route") return { global: false, routes: new Set([scope.routeId]) };
  return { global: false, routes: new Set(scope.routeIds) };
}

/** True iff a fact visible under `factScope` is in scope for a unit under
 * `unitScope` (global on either side covers, otherwise a shared route). */
function routeScopeCovers(factScope: RouteScope, unitScope: FactRouteScope): boolean {
  const fact = routesOf(factScope);
  const unit = routesOf(unitScope);
  if (fact.global || unit.global) return true;
  for (const route of unit.routes) {
    if (fact.routes.has(route)) return true;
  }
  return false;
}

export function evidenceScopeGate(
  snapshot: FactSnapshot,
  accepted: readonly AcceptedUnitOutput[],
  contextFacts: readonly Fact[],
  contextSnapshotId: string,
): Defect[] {
  const bound = bindAccepted(snapshot, accepted);
  const factById = new Map(contextFacts.map((fact) => [fact.factId, fact]));
  const defects: Defect[] = [];

  for (const { fact: unit, accepted: output } of bound.values()) {
    for (const evidenceId of output.evidenceIds) {
      const evidence = factById.get(evidenceId);
      if (evidence === undefined) {
        defects.push(
          buildDefect({
            unitId: unit.factId,
            category: "evidence",
            detail: `cited evidence ${evidenceId} does not resolve to a context fact`,
            basisFactIds: [unit.factId],
          }),
        );
        continue;
      }
      if (evidence.snapshotId !== contextSnapshotId) {
        defects.push(
          buildDefect({
            unitId: unit.factId,
            category: "scope",
            detail: `cited evidence ${evidenceId} belongs to snapshot ${evidence.snapshotId}, not the context snapshot ${contextSnapshotId}`,
            basisFactIds: [evidence.factId],
          }),
        );
        continue;
      }
      if (!routeScopeCovers(evidence.visibility.routeScope, unit.routeScope)) {
        defects.push(
          buildDefect({
            unitId: unit.factId,
            category: "scope",
            detail: `cited evidence ${evidenceId} is out of route scope for unit ${unit.factId}`,
            basisFactIds: [evidence.factId],
          }),
        );
        continue;
      }
      const play = unit.playReveal.playOrderIndex;
      const { fromPlayOrder, throughPlayOrder } = evidence.visibility;
      if (play < fromPlayOrder || (throughPlayOrder !== null && play > throughPlayOrder)) {
        defects.push(
          buildDefect({
            unitId: unit.factId,
            category: "scope",
            detail: `cited evidence ${evidenceId} reveals only [${fromPlayOrder}..${throughPlayOrder ?? "∞"}] but unit ${unit.factId} plays at ${play}`,
            basisFactIds: [evidence.factId],
          }),
        );
        continue;
      }
      if (evidence.source === "accepted-output" && evidence.value.outputId === output.outputId) {
        defects.push(
          buildDefect({
            unitId: unit.factId,
            category: "evidence",
            detail: `accepted output ${output.outputId} cites itself as its own supporting evidence`,
            basisFactIds: [unit.factId],
          }),
        );
      }
    }
  }
  return defects;
}

/** True when any accepted output carries evidence ids — the evidence-scope
 * gate MUST run (and cannot without a corpus) when this holds. */
export function requiresEvidenceCorpus(accepted: readonly AcceptedUnitOutput[]): boolean {
  return accepted.some((output) => output.evidenceIds.length > 0);
}

export function assertEvidenceCorpusPresent(
  accepted: readonly AcceptedUnitOutput[],
  contextFacts: readonly Fact[] | undefined,
  contextSnapshotId: string | undefined,
): asserts contextFacts is readonly Fact[] {
  if (
    requiresEvidenceCorpus(accepted) &&
    (contextFacts === undefined || contextSnapshotId === undefined)
  ) {
    throw new GateEvaluationError(
      "accepted outputs cite evidence but no context-fact corpus / snapshot id was supplied",
    );
  }
}
