// ITOTORI-076 — RetryPolicy classifier.
//
// Translates a typed draft-failure shape into a {retryable, reason}
// decision the acceptance gate forwards to
// `ItotoriDraftJobRepository.markAttemptFailed`. The union of failure
// shapes is closed; the switch in `classify` is exhaustive via
// `assertNever`. Adding a new failure variant without handling it here
// is a compile error.
//
// Classification rules (per the ITOTORI-076 spec):
//
//   schema_validation  (TranslationDraftResponseValidationError)
//     - path indicates a missing required field   → non-retryable
//                                                  (the model cannot
//                                                  satisfy the schema
//                                                  by retrying)
//     - type-coercion / trailing-comma-like      → retryable with
//                                                  repairHint
//
//   protected_span     (DraftProtectedSpanViolation[])
//     - span_deleted / malformed_markup / variable_substituted /
//       span_moved / span_duplicated             → retryable
//     - capitalization_drift / glossary_mistranslation
//                                                → non-retryable
//                                                  (terminology fail —
//                                                  manual triage)
//
//   provider_partial   (TranslationPartialResultError)
//                                                → retryable with
//                                                  attemptIndexNext
//
//   provider_capability(TranslationProviderCapabilityError)
//                                                → non-retryable
//
//   provider_timeout                             → retryable up to
//                                                  attemptIndexMax=3;
//                                                  beyond that
//                                                  non-retryable
//
//   provider_rate_limit                          → retryable with
//                                                  retryAfterMs (when
//                                                  declared)
//
// The classifier is pure / stateless and does not consult the database
// or repository — the acceptance gate threads the result through
// `markAttemptFailed(..., retryable, ...)`.

import type { DraftProtectedSpanViolation } from "./protected-span-validator.js";
import type { TranslationDraftResponseValidationError } from "@itotori/localization-bridge-schema";
import type {
  TranslationPartialResultError,
  TranslationProviderCapabilityError,
} from "../agents/translation/shapes.js";

/**
 * Closed union of failure shapes the policy classifies. New variants
 * MUST be handled in the `switch` below — the `default` calls
 * `assertNever` so omission is a compile error.
 */
export type DraftFailure =
  | {
      kind: "schema_validation";
      error: TranslationDraftResponseValidationError;
      attemptIndexCurrent: number;
    }
  | {
      kind: "protected_span";
      violations: ReadonlyArray<DraftProtectedSpanViolation>;
      attemptIndexCurrent: number;
    }
  | {
      kind: "provider_partial";
      error: TranslationPartialResultError;
      attemptIndexCurrent: number;
    }
  | {
      kind: "provider_capability";
      error: TranslationProviderCapabilityError;
      attemptIndexCurrent: number;
    }
  | {
      kind: "provider_timeout";
      durationMs: number;
      attemptIndexCurrent: number;
    }
  | {
      kind: "provider_rate_limit";
      retryAfterMs?: number;
      attemptIndexCurrent: number;
    };

export type RetryClassification =
  | {
      retryable: true;
      attemptIndexNext: number;
      retryAfterMs?: number;
      repairHint?: string;
    }
  | {
      retryable: false;
      terminalReason: string;
    };

/**
 * Maximum attempt index for `provider_timeout` failures. Attempts at or
 * above this index are classified as non-retryable. The spec calls this
 * out explicitly to avoid unbounded retry loops in the orchestrator.
 */
export const PROVIDER_TIMEOUT_ATTEMPT_INDEX_MAX = 3;

export class RetryPolicy {
  classify(failure: DraftFailure): RetryClassification {
    switch (failure.kind) {
      case "schema_validation":
        return classifySchemaValidation(failure);
      case "protected_span":
        return classifyProtectedSpan(failure);
      case "provider_partial":
        return {
          retryable: true,
          attemptIndexNext: failure.attemptIndexCurrent + 1,
          repairHint: `provider returned a partial response (finishReason=${failure.error.finishReason}); re-issue the structured-output request`,
        };
      case "provider_capability":
        return {
          retryable: false,
          terminalReason: `provider ${failure.error.providerName} (family=${failure.error.providerFamily}) does not support the required capability: ${failure.error.detail}`,
        };
      case "provider_timeout":
        return classifyProviderTimeout(failure);
      case "provider_rate_limit":
        return classifyProviderRateLimit(failure);
      default:
        return assertNever(failure);
    }
  }
}

// ---------------------------------------------------------------------------
// Per-kind classifiers
// ---------------------------------------------------------------------------

function classifySchemaValidation(failure: {
  kind: "schema_validation";
  error: TranslationDraftResponseValidationError;
  attemptIndexCurrent: number;
}): RetryClassification {
  const { error, attemptIndexCurrent } = failure;
  if (isMissingRequiredFieldRule(error.rule)) {
    return {
      retryable: false,
      terminalReason: `schema validation failed at '${error.path}' with rule '${error.rule}': ${error.detail}`,
    };
  }
  // Type coercion, additional properties, enum mismatch, trailing-comma
  // JSON, etc. — the kind of failure a re-emission can plausibly repair.
  return {
    retryable: true,
    attemptIndexNext: attemptIndexCurrent + 1,
    repairHint: `schema validation at '${error.path}' failed rule '${error.rule}'; re-emit with the corrected shape (${error.detail})`,
  };
}

function classifyProtectedSpan(failure: {
  kind: "protected_span";
  violations: ReadonlyArray<DraftProtectedSpanViolation>;
  attemptIndexCurrent: number;
}): RetryClassification {
  if (failure.violations.length === 0) {
    // Guard: nobody should pass an empty violations array to a failure
    // classifier — but if they do, refuse to retry.
    return {
      retryable: false,
      terminalReason:
        "protected_span failure declared with an empty violations array (programmer error)",
    };
  }
  // Walk the violations; if any is non-retryable, the whole failure is
  // non-retryable (we never silently downgrade a hard terminology fail
  // to a retry).
  for (const violation of failure.violations) {
    if (isNonRetryableSpanViolation(violation.kind)) {
      return {
        retryable: false,
        terminalReason: `non-retryable protected-span violation '${violation.kind}' on span '${violation.spanRefId}': ${violation.detail}`,
      };
    }
  }
  const lead = failure.violations[0];
  if (lead === undefined) {
    // Logically unreachable (we checked length above) but the type
    // system can't see that without a manual guard under
    // noUncheckedIndexedAccess.
    return {
      retryable: false,
      terminalReason:
        "protected_span failure: lead violation could not be read after non-empty check",
    };
  }
  return {
    retryable: true,
    attemptIndexNext: failure.attemptIndexCurrent + 1,
    repairHint: `protected-span violation '${lead.kind}' on span '${lead.spanRefId}'; re-emit preserving the source span verbatim`,
  };
}

function classifyProviderTimeout(failure: {
  kind: "provider_timeout";
  durationMs: number;
  attemptIndexCurrent: number;
}): RetryClassification {
  if (failure.attemptIndexCurrent >= PROVIDER_TIMEOUT_ATTEMPT_INDEX_MAX) {
    return {
      retryable: false,
      terminalReason: `provider timeout after ${failure.durationMs}ms; attemptIndex=${failure.attemptIndexCurrent} exceeds policy max ${PROVIDER_TIMEOUT_ATTEMPT_INDEX_MAX}`,
    };
  }
  return {
    retryable: true,
    attemptIndexNext: failure.attemptIndexCurrent + 1,
    repairHint: `provider timeout after ${failure.durationMs}ms; re-issue the request`,
  };
}

function classifyProviderRateLimit(failure: {
  kind: "provider_rate_limit";
  retryAfterMs?: number;
  attemptIndexCurrent: number;
}): RetryClassification {
  const base: RetryClassification = {
    retryable: true,
    attemptIndexNext: failure.attemptIndexCurrent + 1,
    repairHint: "provider rate-limited the request; honor retryAfterMs when present",
  };
  if (failure.retryAfterMs !== undefined) {
    return { ...base, retryAfterMs: failure.retryAfterMs };
  }
  return base;
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

/**
 * Schema-validation rules that indicate the model omitted (or emptied) a
 * required field, rather than emitting a recoverable shape glitch. Rules
 * in this set are **non-retryable** per the spec — a re-emit will not fix
 * them, and we route them to manual triage:
 *
 *   - "required": the validator (translation-draft.ts) raises this when a
 *     required field is genuinely absent from the object.
 *   - "minLength": a required string was present but empty.
 *
 * NOTE: "type" is deliberately NOT in this set. The validator emits
 * "type" only for a field that is present with the wrong type (a
 * type-coercion glitch — e.g. a number where a string is expected),
 * which is recoverable by re-emission and therefore retryable per the
 * header spec (lines 13-18). Genuinely-missing fields are reported as
 * "required", not "type".
 */
const MISSING_REQUIRED_FIELD_RULES: ReadonlyArray<string> = ["required", "minLength"];

function isMissingRequiredFieldRule(rule: string): boolean {
  return MISSING_REQUIRED_FIELD_RULES.includes(rule);
}

/**
 * Protected-span violation kinds that route to manual triage rather
 * than another model attempt.
 *
 *   - capitalization_drift: model & glossary disagree on the canonical
 *     form. A re-emit will just re-produce the same disagreement.
 *   - glossary_mistranslation: same — manual triage.
 */
const NON_RETRYABLE_SPAN_VIOLATIONS: ReadonlyArray<string> = [
  "capitalization_drift",
  "glossary_mistranslation",
];

function isNonRetryableSpanViolation(kind: string): boolean {
  return NON_RETRYABLE_SPAN_VIOLATIONS.includes(kind);
}

function assertNever(value: never): never {
  throw new Error(`exhaustiveness check failed: unexpected value ${String(value)}`);
}
