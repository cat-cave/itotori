// The readiness assembler — the deterministic `ReadinessDeps` the driver's bible
// readiness port resolves each unit's ground truth through.
//
// The readiness port (see ../../workflow-ports.ts) calls the localized-wiki
// ground-truth resolver `resolveUnitBibleGroundTruth` over the injected fact
// snapshot + installed bible; a `MissingBibleEntryError` maps to `ready:false`
// naming the missing entry (drafting is blocked, no fallback). This module only
// packages the substrate that resolution reads — the snapshot, the bible, the
// per-unit ordered fact accessor, and the requirement options. Zero model calls.

import type { ReadinessDeps } from "../../deps.js";
import type { DecodeFactSource, InstalledBible, RequirementOptions } from "./substrate.js";

/** Build the readiness seam from the decode fact source + installed bible. The
 * resolver derives each unit's required name/term/style/voice/arc entries from
 * the snapshot and looks up their installed renderings; the port catches a
 * missing-entry throw and reports `ready:false`. */
export function createReadinessDeps(input: {
  readonly facts: DecodeFactSource;
  readonly bible: InstalledBible;
  readonly requirementOptions?: RequirementOptions;
}): ReadinessDeps {
  return {
    orderedFact: (unitId: string) => input.facts.orderedFact(unitId),
    snapshot: input.facts.snapshot,
    bible: input.bible,
    ...(input.requirementOptions !== undefined
      ? { requirementOptions: input.requirementOptions }
      : {}),
  };
}
