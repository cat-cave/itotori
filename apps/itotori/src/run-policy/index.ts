// Run-policy — the deterministic layer that enforces the legal combinations of
// run mode × context scope × output scope × roster, and gates shippable
// finalization. Self-contained: it composes the roster, the run-mode / context /
// output-scope contracts, and the localized-wiki bible-posture rules READ-ONLY;
// it imports nothing from the legacy agents tree.
//
//   - production and pilot REQUIRE whole-game context + the full roster +
//     wiki-first bible, and differ only on the free output-scope axis;
//   - a narrowed context forces test-dev (with visible provenance) and can never
//     finalize a shippable artifact;
//   - output scope is an independent, self-bounded axis;
//   - only the explicit pure-MTL ablation selects the null-Wiki / direct
//     translation basis, and only under a test-dev run.

export {
  MODE_PROFILES,
  BASE_POSTURE_BY_RUN_MODE,
  FULL_ROSTER,
  profileFor,
  rosterIsFull,
  type ModeProfile,
} from "./mode-profiles.js";
export {
  contextCoversWholeGame,
  contextProvenanceOf,
  forceTestDevForNarrowedContext,
  isNarrowedContext,
  requiredRunModeForContext,
  resolveRunPolicy,
} from "./resolve.js";
export { assertMayFinalizeShippable, finalizeShippable, isShippablePolicy } from "./finalize.js";
export {
  OUTPUT_SCOPE_VALUES,
  RunPolicyError,
  ShippableFinalizationError,
  type AblationSelector,
  type BibleBasis,
  type ContextProvenance,
  type OutputScope,
  type ResolvedRunPolicy,
  type RunPolicyRequest,
  type ShippableArtifact,
} from "./types.js";
