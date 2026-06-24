// ITOTORI-076 — DraftProtectedSpanValidator unit tests.
//
// One test per violation kind (positive + negative). Each test pins
// the kind, spanRefId, bridgeUnitId, and where relevant the
// declaredRange / observedRanges evidence.

import { describe, expect, it } from "vitest";
import {
  DRAFT_PROTECTED_SPAN_VIOLATION_KINDS,
  DraftProtectedSpanValidator,
  glossaryMistranslationFixture,
  malformedMarkupDraftFixture,
  nonRetryableFixture,
  spanDeletedDraftFixture,
  spanDuplicatedDraftFixture,
  spanMovedDraftFixture,
  validDraftFixture,
  variableSubstitutedDraftFixture,
} from "../src/draft/index.js";

describe("DraftProtectedSpanValidator", () => {
  it("accepts the validDraftFixture without violations", () => {
    const validator = new DraftProtectedSpanValidator();
    const result = validator.validate(validDraftFixture());
    expect(result.accepted).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("rejects spanDeletedDraftFixture with kind='span_deleted' on the markup ref", () => {
    const validator = new DraftProtectedSpanValidator();
    const input = spanDeletedDraftFixture();
    const result = validator.validate(input);
    expect(result.accepted).toBe(false);
    const violation = result.violations.find((v) => v.kind === "span_deleted");
    expect(violation).toBeDefined();
    if (violation === undefined) return;
    expect(violation.spanRefId).toBe("span-markup-br");
    expect(violation.spanKind).toBe("markup");
    expect(violation.bridgeUnitId).toBe(input.sourceBridgeUnit.bridgeUnitId);
    expect(violation.evidence.declaredRange).toBeUndefined();
    expect(violation.evidence.observedRanges).toEqual([]);
  });

  it("rejects spanMovedDraftFixture with kind='span_moved' on the source_unit ref", () => {
    const validator = new DraftProtectedSpanValidator();
    const result = validator.validate(spanMovedDraftFixture());
    expect(result.accepted).toBe(false);
    const moved = result.violations.find((v) => v.kind === "span_moved");
    expect(moved).toBeDefined();
    if (moved === undefined) return;
    expect(moved.spanRefId).toBe("span-source-quote");
    expect(moved.spanKind).toBe("source_unit");
    expect(moved.evidence.declaredRange).toEqual({ startInDraft: 0, endInDraft: 5 });
    expect(moved.evidence.observedRanges).toEqual([{ startInDraft: 4, endInDraft: 9 }]);
  });

  it("rejects malformedMarkupDraftFixture with kind='malformed_markup' from flanking context", () => {
    const validator = new DraftProtectedSpanValidator();
    const result = validator.validate(malformedMarkupDraftFixture());
    expect(result.accepted).toBe(false);
    expect(result.violations).toHaveLength(1);
    const v = result.violations[0];
    expect(v).toBeDefined();
    if (v === undefined) return;
    expect(v.kind).toBe("malformed_markup");
    expect(v.spanRefId).toBe("span-markup-br");
    expect(v.spanKind).toBe("markup");
    expect(v.detail).toContain("flanking");
  });

  it("rejects variableSubstitutedDraftFixture with kind='variable_substituted'", () => {
    const validator = new DraftProtectedSpanValidator();
    const result = validator.validate(variableSubstitutedDraftFixture());
    expect(result.accepted).toBe(false);
    expect(result.violations).toHaveLength(1);
    const v = result.violations[0];
    expect(v).toBeDefined();
    if (v === undefined) return;
    expect(v.kind).toBe("variable_substituted");
    expect(v.spanRefId).toBe("span-variable-player");
    expect(v.spanKind).toBe("variable");
  });

  it("rejects spanDuplicatedDraftFixture with kind='span_duplicated'", () => {
    const validator = new DraftProtectedSpanValidator();
    const result = validator.validate(spanDuplicatedDraftFixture());
    expect(result.accepted).toBe(false);
    const dup = result.violations.find((v) => v.kind === "span_duplicated");
    expect(dup).toBeDefined();
    if (dup === undefined) return;
    expect(dup.spanRefId).toBe("span-variable-player");
    expect(dup.spanKind).toBe("variable");
    expect(dup.evidence.observedRanges.length).toBe(2);
  });

  it("rejects nonRetryableFixture with kind='capitalization_drift'", () => {
    const validator = new DraftProtectedSpanValidator();
    const result = validator.validate(nonRetryableFixture());
    expect(result.accepted).toBe(false);
    expect(result.violations).toHaveLength(1);
    const v = result.violations[0];
    expect(v).toBeDefined();
    if (v === undefined) return;
    expect(v.kind).toBe("capitalization_drift");
    expect(v.spanRefId).toBe("span-glossary-hero");
    expect(v.spanKind).toBe("glossary");
    expect(v.detail).toContain("Hero");
    expect(v.detail).toContain("hero");
  });

  it("rejects glossaryMistranslationFixture with kind='glossary_mistranslation'", () => {
    const validator = new DraftProtectedSpanValidator();
    const result = validator.validate(glossaryMistranslationFixture());
    expect(result.accepted).toBe(false);
    expect(result.violations).toHaveLength(1);
    const v = result.violations[0];
    expect(v).toBeDefined();
    if (v === undefined) return;
    expect(v.kind).toBe("glossary_mistranslation");
    expect(v.detail).toContain("Champion");
  });

  it("accepts an empty source-span catalog as trivially valid", () => {
    const validator = new DraftProtectedSpanValidator();
    const result = validator.validate({
      sourceBridgeUnit: validDraftFixture().sourceBridgeUnit,
      draftText: "anything goes",
      draftProtectedSpanRefs: [],
      sourceProtectedSpans: [],
    });
    expect(result.accepted).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("emits a malformed_markup violation when the source catalog itself is malformed", () => {
    const validator = new DraftProtectedSpanValidator();
    const result = validator.validate({
      sourceBridgeUnit: validDraftFixture().sourceBridgeUnit,
      draftText: "Hi <br/>",
      draftProtectedSpanRefs: [{ refId: "bad", startInDraft: 3, endInDraft: 8 }],
      sourceProtectedSpans: [{ refId: "bad", sourceText: "<>", spanKind: "markup" }],
    });
    expect(result.accepted).toBe(false);
    expect(result.violations[0]).toBeDefined();
    expect(result.violations[0]?.kind).toBe("malformed_markup");
    expect(result.violations[0]?.detail).toContain("not well-formed");
  });

  it("exposes the full closed enum so adding a new kind is a deliberate change", () => {
    expect(new Set(DRAFT_PROTECTED_SPAN_VIOLATION_KINDS)).toEqual(
      new Set([
        "span_deleted",
        "span_moved",
        "span_duplicated",
        "malformed_markup",
        "capitalization_drift",
        "variable_substituted",
        "glossary_mistranslation",
      ]),
    );
  });
});
