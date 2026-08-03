// Deterministic Q2/Q4 projections over verified final accepted targets.

import type { AcceptedTargetLine } from "../../roles/q2/index.js";
import type { Q4OriginTranslation } from "../../roles/q4/index.js";
import { endpointVisibleOnReviewScope } from "../../roles/q4/index.js";
import type { OrderedUnitFact } from "../../prepass/index.js";
import {
  knownSpeakerId,
  primaryRouteId,
  projectSceneUnitFact,
  toRouteScope,
  type DecodeFactSource,
} from "./assemblers/index.js";
import type { AcceptedTargetRecord } from "./accepted-target-history.js";
import { ProductionRoleBindingError } from "./production-role-support.js";

/** The accepted heads pinned to this run after source-hash validation. */
export interface AcceptedTargetIndex {
  readonly records: readonly AcceptedTargetRecord[];
}

/** Bind each persisted accepted target to the exact current decode source. A
 * history record from another snapshot or source revision is never prompt input. */
export function indexAcceptedTargets(input: {
  readonly records: readonly AcceptedTargetRecord[];
  readonly facts: DecodeFactSource;
}): AcceptedTargetIndex {
  const seen = new Set<string>();
  for (const record of input.records) {
    if (seen.has(record.unitId)) {
      throw new ProductionRoleBindingError(`accepted target history repeats ${record.unitId}`);
    }
    seen.add(record.unitId);
    const fact = input.facts.orderedFact(record.unitId);
    if (fact.sourceHash !== record.sourceHash) {
      throw new ProductionRoleBindingError(
        `accepted target ${record.outputId} is stale for ${record.unitId}`,
      );
    }
  }
  return { records: [...input.records] };
}

/** Project a speaker's accepted lines. `OrderedUnitFact` has no decoded
 * counterpart field, so only the honest base-register (`null`) form is emitted. */
export function voiceAcceptedHistory(input: {
  readonly accepted: AcceptedTargetIndex;
  readonly facts: DecodeFactSource;
  readonly speakerId: string;
}): readonly AcceptedTargetLine[] {
  const lines = input.accepted.records.flatMap((record) => {
    const fact = projectSceneUnitFact(record.unitId, input.facts);
    if (knownSpeakerId(fact) !== input.speakerId) return [];
    const ordered = input.facts.orderedFact(record.unitId);
    const routeId = primaryRouteId(ordered.routeScope);
    if (routeId === null) return [];
    return [
      {
        historyId: record.outputId,
        unitId: record.unitId,
        counterpartId: null,
        routeId,
        playOrder: ordered.playReveal.playOrderIndex,
        text: record.targetSkeleton,
      },
    ];
  });
  return lines.sort(compareVoiceHistory);
}

/** Project only accepted, prior, route-visible origins for the continuity lane. */
export function continuityOrigins(input: {
  readonly accepted: AcceptedTargetIndex;
  readonly facts: DecodeFactSource;
  readonly current: OrderedUnitFact;
}): readonly Q4OriginTranslation[] {
  const reviewScope = toRouteScope(input.current.routeScope);
  return input.accepted.records
    .filter((record) => record.unitId !== input.current.factId)
    .flatMap((record) => {
      const origin = input.facts.orderedFact(record.unitId);
      if (origin.playReveal.playOrderIndex >= input.current.playReveal.playOrderIndex) return [];
      if (!endpointVisibleOnReviewScope(origin.routeScope, reviewScope)) return [];
      return [{ unitId: record.unitId, acceptedTarget: record.targetSkeleton }];
    })
    .sort((left, right) => compareOrigins(left, right, input.facts));
}

function compareVoiceHistory(left: AcceptedTargetLine, right: AcceptedTargetLine): number {
  if (left.playOrder !== right.playOrder) return left.playOrder - right.playOrder;
  return compareStrings(left.unitId, right.unitId);
}

function compareOrigins(
  left: Q4OriginTranslation,
  right: Q4OriginTranslation,
  facts: DecodeFactSource,
): number {
  const leftOrder = facts.orderedFact(left.unitId).playReveal.playOrderIndex;
  const rightOrder = facts.orderedFact(right.unitId).playReveal.playOrderIndex;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return compareStrings(left.unitId, right.unitId);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
