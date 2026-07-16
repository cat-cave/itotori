// Materialize ordered units from the validated narrative<->localization join.
//
// The join has already proven every binding agrees on source hash + byte range
// and that the mapping is 1:1 and complete. Here we simply CITE the bridge
// unit's authoritative facts — speaker/color identity, protected spans, source
// hash, patch/runtime refs — and attach the decode's play/reveal position and
// route scope. No attribution, colour, or hash is recomputed: a fabricated
// speaker or skeleton is impossible because every field is copied from the
// bridge unit the join bound.

import { namespacedFactId } from "@itotori/db";
import type { LocalizationUnitV02 } from "@itotori/localization-bridge-schema";

import type { NarrativeLocalizationBinding } from "../structure/localization-join.js";

import { stableSegment } from "./fact-id.js";
import type { NarrativePosition } from "./positions.js";
import {
  FactSnapshotError,
  type FactRouteScope,
  type OrderedUnitFact,
  type ProtectedSkeletonFact,
} from "./types.js";

function routeScopeOf(routeMembership: readonly string[]): FactRouteScope {
  const routeIds = [...new Set(routeMembership)].sort(compareCodeUnits);
  if (routeIds.length === 0) return { kind: "global" };
  if (routeIds.length === 1) return { kind: "route", routeId: routeIds[0]! };
  return { kind: "route-set", routeIds };
}

/** Copy the bridge unit's decoded protected spans (ordered by start byte) as
 * the unit's masking skeleton, alongside its committed source hash. */
function protectedSkeletonOf(unit: LocalizationUnitV02): ProtectedSkeletonFact {
  const spans = [...unit.spans]
    .map((span) => ({
      spanKind: span.spanKind,
      preserveMode: span.preserveMode,
      raw: span.raw,
      startByte: span.startByte,
      endByte: span.endByte,
    }))
    .sort((a, b) => a.startByte - b.startByte || a.endByte - b.endByte);
  return { sourceHash: unit.sourceHash, spans };
}

/**
 * Materialize every bound unit into an {@link OrderedUnitFact}, sorted by play
 * order then source-unit key. Fails loud if a bound unit has no play position
 * (the position index must cover every bridge id the join accepted).
 */
export function materializeOrderedUnits(
  bindings: readonly NarrativeLocalizationBinding[],
  positions: ReadonlyMap<string, NarrativePosition>,
): OrderedUnitFact[] {
  const facts = bindings.map(({ link, unit }): OrderedUnitFact => {
    const position = positions.get(unit.bridgeUnitId);
    if (position === undefined) {
      throw new FactSnapshotError(`bound unit ${unit.bridgeUnitId} has no narrative play position`);
    }
    const namespace = link.kind === "choice" ? "choice" : "unit";
    return {
      factId: namespacedFactId(namespace, stableSegment(unit.bridgeUnitId)),
      bridgeUnitId: unit.bridgeUnitId,
      sourceUnitKey: unit.sourceUnitKey,
      sceneId: link.sceneId,
      linkKind: link.kind,
      surfaceKind: unit.surfaceKind,
      sourceHash: unit.sourceHash,
      byteRange: unit.sourceLocation.range ?? null,
      routeScope: routeScopeOf(position.routeMembership),
      playReveal: {
        playOrderIndex: position.playOrderIndex,
        revealSceneOrder: position.revealSceneOrder,
        revealItemOrder: position.revealItemOrder,
      },
      speaker: unit.speaker ?? null,
      protectedSkeleton: protectedSkeletonOf(unit),
      patchRef: unit.patchRef,
      runtimeExpectation: unit.runtimeExpectation,
    };
  });
  return facts.sort(
    (a, b) =>
      a.playReveal.playOrderIndex - b.playReveal.playOrderIndex ||
      compareCodeUnits(a.sourceUnitKey, b.sourceUnitKey),
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
