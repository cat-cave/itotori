// Field/claim-scoped invalidation: a deterministic, model-free planner that
// intersects a structured upstream diff with the fine-grained consumption edges
// to emit the minimal, content-addressed downstream enhancement + reviewer work
// set. Human-touched consumers are enhanced, never erased.

export {
  diffUpstreamObject,
  StructuredDiffError,
  type ChangeScope,
  type ClaimChange,
  type FieldChange,
  type FieldPath,
  type JsonValue,
  type UpstreamChangeSet,
} from "./structured-diff.js";
export { playWindowsOverlap, routeScopesOverlap } from "./scope-overlap.js";
export { computeImpactSet, type ImpactedConsumer, type ImpactSet } from "./impact-set.js";
export {
  ScopedInvalidationService,
  type InvalidationRequest,
  type ScopedInvalidationDeps,
} from "./service.js";
