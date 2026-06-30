// ITOTORI-076 — RetryPolicy unit tests.
//
// One test per classification rule. Each test asserts the precise
// `retryable` boolean + the `terminalReason` (when non-retryable) or
// `repairHint` + `attemptIndexNext` (when retryable).

import { describe, expect, it } from "vitest";
import { TranslationDraftResponseValidationError } from "@itotori/localization-bridge-schema";
import {
  PROVIDER_TIMEOUT_ATTEMPT_INDEX_MAX,
  RetryPolicy,
  type DraftFailure,
  type DraftProtectedSpanViolation,
} from "../src/draft/index.js";
import {
  TranslationPartialResultError,
  TranslationProviderCapabilityError,
} from "../src/agents/translation/index.js";

function spanViolation(
  kind: DraftProtectedSpanViolation["kind"],
  overrides: Partial<DraftProtectedSpanViolation> = {},
): DraftProtectedSpanViolation {
  return {
    kind,
    spanRefId: overrides.spanRefId ?? "span-test",
    spanKind: overrides.spanKind ?? "source_unit",
    bridgeUnitId: overrides.bridgeUnitId ?? "bridge-unit-test",
    detail: overrides.detail ?? "detail",
    evidence: overrides.evidence ?? { observedRanges: [] },
  };
}

describe("RetryPolicy.classify(schema_validation)", () => {
  it("non-retryable when rule='required' (the model omitted a required field)", () => {
    const policy = new RetryPolicy();
    const failure: DraftFailure = {
      kind: "schema_validation",
      error: new TranslationDraftResponseValidationError(
        "drafts[0].confidenceFloor",
        "required",
        "missing required field confidenceFloor",
      ),
      attemptIndexCurrent: 0,
    };
    const result = policy.classify(failure);
    expect(result.retryable).toBe(false);
    if (result.retryable === false) {
      expect(result.terminalReason).toContain("drafts[0].confidenceFloor");
      expect(result.terminalReason).toContain("required");
    }
  });

  it("retryable when rule='type' (a present field has the wrong type — coercible)", () => {
    // Regression: rule 'type' is a recoverable type-coercion glitch (e.g.
    // a number where a string is expected), NOT a missing field. It must
    // stay retryable per the header spec — a re-emit can fix the shape.
    const policy = new RetryPolicy();
    const failure: DraftFailure = {
      kind: "schema_validation",
      error: new TranslationDraftResponseValidationError(
        "drafts[0].draftText",
        "type",
        "expected string",
      ),
      attemptIndexCurrent: 0,
    };
    const result = policy.classify(failure);
    expect(result.retryable).toBe(true);
    if (result.retryable === true) {
      expect(result.attemptIndexNext).toBe(1);
      expect(result.repairHint).toContain("drafts[0].draftText");
      expect(result.repairHint).toContain("type");
    }
  });

  it("non-retryable when rule='minLength' (a required field is missing/empty)", () => {
    const policy = new RetryPolicy();
    const failure: DraftFailure = {
      kind: "schema_validation",
      error: new TranslationDraftResponseValidationError(
        "drafts[0].agentRationale",
        "minLength",
        "must be non-empty",
      ),
      attemptIndexCurrent: 1,
    };
    const result = policy.classify(failure);
    expect(result.retryable).toBe(false);
  });

  it("retryable with repairHint when rule='json' (trailing-comma-like)", () => {
    const policy = new RetryPolicy();
    const failure: DraftFailure = {
      kind: "schema_validation",
      error: new TranslationDraftResponseValidationError(
        "",
        "json",
        "Unexpected token } in JSON at position 5",
      ),
      attemptIndexCurrent: 0,
    };
    const result = policy.classify(failure);
    expect(result.retryable).toBe(true);
    if (result.retryable === true) {
      expect(result.attemptIndexNext).toBe(1);
      expect(result.repairHint).toContain("json");
    }
  });

  it("retryable with repairHint when rule='additionalProperties'", () => {
    const policy = new RetryPolicy();
    const failure: DraftFailure = {
      kind: "schema_validation",
      error: new TranslationDraftResponseValidationError(
        "repairAttempts",
        "additionalProperties",
        "unexpected top-level property",
      ),
      attemptIndexCurrent: 2,
    };
    const result = policy.classify(failure);
    expect(result.retryable).toBe(true);
    if (result.retryable === true) {
      expect(result.attemptIndexNext).toBe(3);
    }
  });
});

describe("RetryPolicy.classify(protected_span)", () => {
  it("retryable when the only violation is span_deleted", () => {
    const policy = new RetryPolicy();
    const failure: DraftFailure = {
      kind: "protected_span",
      violations: [spanViolation("span_deleted", { spanRefId: "span-deleted-x" })],
      attemptIndexCurrent: 0,
    };
    const result = policy.classify(failure);
    expect(result.retryable).toBe(true);
    if (result.retryable === true) {
      expect(result.repairHint).toContain("span_deleted");
      expect(result.repairHint).toContain("span-deleted-x");
      expect(result.attemptIndexNext).toBe(1);
    }
  });

  it("retryable when the only violation is malformed_markup", () => {
    const policy = new RetryPolicy();
    const failure: DraftFailure = {
      kind: "protected_span",
      violations: [spanViolation("malformed_markup")],
      attemptIndexCurrent: 0,
    };
    const result = policy.classify(failure);
    expect(result.retryable).toBe(true);
  });

  it("retryable when the only violation is variable_substituted", () => {
    const policy = new RetryPolicy();
    const failure: DraftFailure = {
      kind: "protected_span",
      violations: [spanViolation("variable_substituted")],
      attemptIndexCurrent: 0,
    };
    const result = policy.classify(failure);
    expect(result.retryable).toBe(true);
  });

  it("non-retryable when any violation is capitalization_drift", () => {
    const policy = new RetryPolicy();
    const failure: DraftFailure = {
      kind: "protected_span",
      violations: [
        spanViolation("span_deleted"),
        spanViolation("capitalization_drift", { spanRefId: "span-glossary-x" }),
      ],
      attemptIndexCurrent: 0,
    };
    const result = policy.classify(failure);
    expect(result.retryable).toBe(false);
    if (result.retryable === false) {
      expect(result.terminalReason).toContain("capitalization_drift");
      expect(result.terminalReason).toContain("span-glossary-x");
    }
  });

  it("non-retryable when any violation is glossary_mistranslation", () => {
    const policy = new RetryPolicy();
    const failure: DraftFailure = {
      kind: "protected_span",
      violations: [spanViolation("glossary_mistranslation")],
      attemptIndexCurrent: 0,
    };
    const result = policy.classify(failure);
    expect(result.retryable).toBe(false);
  });

  it("non-retryable (programmer error) when violations array is empty", () => {
    const policy = new RetryPolicy();
    const failure: DraftFailure = {
      kind: "protected_span",
      violations: [],
      attemptIndexCurrent: 0,
    };
    const result = policy.classify(failure);
    expect(result.retryable).toBe(false);
    if (result.retryable === false) {
      expect(result.terminalReason).toContain("empty violations array");
    }
  });
});

describe("RetryPolicy.classify(provider_partial)", () => {
  it("retryable with attemptIndexNext = current + 1", () => {
    const policy = new RetryPolicy();
    const failure: DraftFailure = {
      kind: "provider_partial",
      error: new TranslationPartialResultError(
        "provider-run-id",
        "draft-attempt-id",
        "length",
        "truncated mid-emit",
      ),
      attemptIndexCurrent: 1,
    };
    const result = policy.classify(failure);
    expect(result.retryable).toBe(true);
    if (result.retryable === true) {
      expect(result.attemptIndexNext).toBe(2);
      expect(result.repairHint).toContain("length");
    }
  });
});

describe("RetryPolicy.classify(provider_capability)", () => {
  it("non-retryable, terminalReason names provider", () => {
    const policy = new RetryPolicy();
    const failure: DraftFailure = {
      kind: "provider_capability",
      error: new TranslationProviderCapabilityError(
        "unsupported-provider",
        "fake",
        "structured output mode json_schema is unsupported",
      ),
      attemptIndexCurrent: 0,
    };
    const result = policy.classify(failure);
    expect(result.retryable).toBe(false);
    if (result.retryable === false) {
      expect(result.terminalReason).toContain("unsupported-provider");
      expect(result.terminalReason).toContain("fake");
    }
  });
});

describe("RetryPolicy.classify(provider_timeout)", () => {
  it("retryable when attemptIndexCurrent < PROVIDER_TIMEOUT_ATTEMPT_INDEX_MAX", () => {
    const policy = new RetryPolicy();
    const failure: DraftFailure = {
      kind: "provider_timeout",
      durationMs: 30_000,
      attemptIndexCurrent: 1,
    };
    const result = policy.classify(failure);
    expect(result.retryable).toBe(true);
    if (result.retryable === true) {
      expect(result.attemptIndexNext).toBe(2);
      expect(result.repairHint).toContain("timeout");
    }
  });

  it("non-retryable when attemptIndexCurrent >= PROVIDER_TIMEOUT_ATTEMPT_INDEX_MAX", () => {
    const policy = new RetryPolicy();
    const failure: DraftFailure = {
      kind: "provider_timeout",
      durationMs: 30_000,
      attemptIndexCurrent: PROVIDER_TIMEOUT_ATTEMPT_INDEX_MAX,
    };
    const result = policy.classify(failure);
    expect(result.retryable).toBe(false);
    if (result.retryable === false) {
      expect(result.terminalReason).toContain("exceeds policy max");
    }
  });
});

describe("RetryPolicy.classify(provider_rate_limit)", () => {
  it("retryable and honors retryAfterMs when provided", () => {
    const policy = new RetryPolicy();
    const failure: DraftFailure = {
      kind: "provider_rate_limit",
      retryAfterMs: 5_000,
      attemptIndexCurrent: 0,
    };
    const result = policy.classify(failure);
    expect(result.retryable).toBe(true);
    if (result.retryable === true) {
      expect(result.retryAfterMs).toBe(5_000);
      expect(result.attemptIndexNext).toBe(1);
    }
  });

  it("retryable and omits retryAfterMs when not provided", () => {
    const policy = new RetryPolicy();
    const failure: DraftFailure = {
      kind: "provider_rate_limit",
      attemptIndexCurrent: 0,
    };
    const result = policy.classify(failure);
    expect(result.retryable).toBe(true);
    if (result.retryable === true) {
      expect(result.retryAfterMs).toBeUndefined();
    }
  });
});
