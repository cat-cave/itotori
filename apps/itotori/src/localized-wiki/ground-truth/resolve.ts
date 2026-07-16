// Resolve one unit against the installed bible — the ground-truth binding.
//
// For a unit, this looks up the EXACT installed rendering for every entry the
// unit requires (name, term, style, voice, arc), records a fine-grained
// dependency on each (so a later bible change finds this unit as a consumer),
// and returns the resolved rendering ids the P1/Q role inputs cite as their
// basis. A required entry that is not installed does not fall back to an ad-hoc
// decision — it throws {@link MissingBibleEntryError}, blocking the draft. The
// resolution is deterministic: the same unit + snapshot + bible always bind to
// the same renderings, dependencies, and hash.

import { llmSha256, type LlmWikiDependency, type LlmWikiScope } from "@itotori/db";

import type { FactSnapshot, OrderedUnitFact } from "../../prepass/index.js";
import { deriveUnitRequirements, type RequirementOptions } from "./requirements.js";
import { MissingBibleEntryError, type InstalledBible, type UnitBibleBinding } from "./types.js";

/** Normalize a unit's decode route scope to the persisted dependency scope. */
function toWikiScope(scope: OrderedUnitFact["routeScope"]): LlmWikiScope {
  if (scope.kind === "route") return { kind: "route", routeId: scope.routeId };
  if (scope.kind === "route-set") return { kind: "route-set", routeIds: [...scope.routeIds] };
  return { kind: "global" };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Resolve the bible ground truth for one unit. Every required entry must be
 * installed; the resolved renderings feed the role inputs and their consumption
 * is recorded as fine-grained dependencies. Throws if any entry is missing. */
export function resolveUnitBibleGroundTruth(
  unit: OrderedUnitFact,
  snapshot: FactSnapshot,
  bible: InstalledBible,
  options: RequirementOptions = {},
): UnitBibleBinding {
  const required = deriveUnitRequirements(unit, snapshot, options);
  const scope = toWikiScope(unit.routeScope);
  const playOrder = unit.playReveal.playOrderIndex;

  const dependencyByRendering = new Map<string, LlmWikiDependency>();
  for (const entry of required) {
    const rendering = bible.lookup(entry);
    if (rendering === undefined) {
      // A missing required entry BLOCKS — no ad-hoc fallback, ever.
      throw new MissingBibleEntryError(unit.factId, entry);
    }
    // Record the unit's consumption of this rendering's body under its route +
    // play window, so a change to the rendering reaches exactly this unit.
    dependencyByRendering.set(rendering.renderingId, {
      upstreamObjectId: rendering.renderingId,
      upstreamVersion: rendering.version,
      claimId: null,
      fieldPath: ["body"],
      renderingId: rendering.renderingId,
      scope,
      fromPlayOrder: playOrder,
      throughPlayOrder: playOrder,
    });
  }

  const bibleRenderingIds = [...dependencyByRendering.keys()].sort(compareStrings);
  const dependencies = bibleRenderingIds.map((id) => dependencyByRendering.get(id)!);

  return {
    unitId: unit.factId,
    downstreamObjectId: `translation:${unit.factId}`,
    downstreamVersionId: `translation:${unit.factId}:v1`,
    downstreamVersion: 1,
    bibleRenderingIds,
    dependencies,
    boundHash: llmSha256({ unitId: unit.factId, bibleRenderingIds }),
  };
}

/** Resolve a whole work-scope of units, in stable unit order. A single missing
 * entry blocks the whole pass (the offending unit's error propagates). */
export function resolveWorkScopeGroundTruth(
  units: readonly OrderedUnitFact[],
  snapshot: FactSnapshot,
  bible: InstalledBible,
  options: RequirementOptions = {},
): readonly UnitBibleBinding[] {
  return [...units]
    .sort((a, b) => compareStrings(a.factId, b.factId))
    .map((unit) => resolveUnitBibleGroundTruth(unit, snapshot, bible, options));
}
