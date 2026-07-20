// Precise enhancement + rerun-only-implicated + byte-range-scoped patch — the
// offline-provable core for a batched ONE-FIELD Wiki/bible enhancement.
//
// Composes the real substrate (the scoped-invalidation impact set, the bible
// reflow partition, the workflow rerun scope) and the patch byte-range-scoping
// logic into one deterministic, model-free plan. The live lane proves the same
// scoping over REAL patched bytes (the native Kaifuu apply over the real game
// root); this module is the offline-provable core that underpins it.
//
// Self-contained: it composes sibling modules and imports nothing from
// retired execution internals.

export {
  applyPreciseEnhancement,
  planEnhancementImpact,
  type EnhancementImpact,
  type HashIdenticalTarget,
} from "./impact.js";
export {
  byteRangesOverlap,
  scopePatchUpdate,
  targetTextByteLength,
  targetTextByteRange,
  type ByteRange,
  type PatchUpdateScope,
} from "./patch-scope.js";
