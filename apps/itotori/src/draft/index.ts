// ITOTORI-076 — public surface of the draft acceptance gate.
//
// Consolidates the validator, classifier, gate helper, and fixture set
// behind one import path so callers don't have to reach across files.

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
  PROVIDER_TIMEOUT_ATTEMPT_INDEX_MAX,
  RetryPolicy,
  type DraftFailure,
  type RetryClassification,
} from "./retry-policy.js";

export {
  acceptOrRejectDraft,
  routeFailedAttempt,
  type AcceptDraftArgs,
  type AcceptDraftResult,
} from "./acceptance-gate.js";

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

export {
  DraftAttemptRecorder,
  type DraftAttemptRecorderArgs,
  type DraftAttemptCostUsd,
  type FallbackEntry,
} from "./draft-attempt-recorder.js";

// ITOTORI-222 — the legacy isolated drafting command was collapsed into
// `apps/itotori/src/orchestrator/agentic-loop.ts`. Direct callers should
// import `runAgenticLoopForUnit` (orchestrator entry point) or
// `runAgenticLoopSmokeCommand` (CLI seam) instead.
