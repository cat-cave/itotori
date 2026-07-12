// Protected-span validation remains deterministic input/output validation.
// Invocation retry and provider dispatch live exclusively in the universal
// InvocationSupervisor; the former classifier-only draft façade was removed.

export {
  DRAFT_PROTECTED_SPAN_KINDS,
  DRAFT_PROTECTED_SPAN_VIOLATION_KINDS,
  DraftProtectedSpanValidator,
  type DraftProtectedSpanKind,
  type DraftProtectedSpanValidationInput,
  type DraftProtectedSpanValidationResult,
  type DraftProtectedSpanViolation,
  type DraftProtectedSpanViolationKind,
  type DraftSourceProtectedSpan,
} from "./protected-span-validator.js";

export {
  draftFixtureBridgeUnit,
  draftFixtureSourceSpans,
  DRAFT_FIXTURE_BRIDGE_UNIT_ID,
  glossaryMistranslationFixture,
  malformedMarkupDraftFixture,
  nonRetryableFixture,
  spanDeletedDraftFixture,
  spanDuplicatedDraftFixture,
  spanMovedDraftFixture,
  validDraftFixture,
  variableSubstitutedDraftFixture,
} from "./draft-fixtures.js";

// ITOTORI-222 — the legacy isolated drafting command was collapsed into
// `apps/itotori/src/orchestrator/agentic-loop.ts`. Direct callers should
// import `runAgenticLoopForUnit` (orchestrator entry point) or
// `runAgenticLoopSmokeCommand` (CLI seam) instead.
