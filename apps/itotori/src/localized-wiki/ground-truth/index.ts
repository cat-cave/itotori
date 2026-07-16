// Make the per-target localized bible the GROUND TRUTH — public surface.
//
// The deterministic binding + enforcement + invalidation that turns the
// localized bible (renderings + installed canonical forms) into the authority
// every unit resolves against: each unit RESOLVES the exact name/term/style/
// voice/arc entries it depends on and RECORDS those dependencies; a line
// contradicting an installed canonical form is a DEFECT, never an alternate
// style; a justified bible change precisely REFLOWS only the lines that cited the
// changed entry; and a missing required entry BLOCKS drafting with no fallback.
// Self-contained: it composes the localized-bible installer, the deterministic
// gates, the scoped-invalidation impact set, and the wiki dependency edges — it
// imports nothing from the legacy agents tree.

export {
  CATEGORY_SOURCE_KIND,
  AmbiguousBibleEntryError,
  MissingBibleEntryError,
  type BibleCategory,
  type InstalledBible,
  type InstalledBibleEntry,
  type RequiredBibleEntry,
  type UnitBibleBinding,
} from "./types.js";
export { buildInstalledBible } from "./installed-bible.js";
export { deriveUnitRequirements, type RequirementOptions } from "./requirements.js";
export { resolveUnitBibleGroundTruth, resolveWorkScopeGroundTruth } from "./resolve.js";
export { enforceBibleGroundTruth, type BibleEnforcementResult } from "./enforce.js";
export {
  applyReflowedOutputs,
  bibleEntryDiffBody,
  bindingsToEdges,
  planBibleReflow,
  reflowPlanFor,
  type BibleReflowPlan,
  type UnitLineOutput,
} from "./reflow.js";
