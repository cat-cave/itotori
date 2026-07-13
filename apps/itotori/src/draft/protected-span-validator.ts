// ITOTORI-076 — DraftProtectedSpanValidator (second-layer, acceptance-time).
//
// The TranslationAgent (ITOTORI-075) enforces protected-span correctness at
// the **agent boundary**: every required ref is present, sorted, in-bounds,
// byte-equal to source. That covers a freshly-generated draft. THIS validator
// runs a second pass at **acceptance time** (just before
// `markAttemptSucceeded` is called) and catches issues that can creep in
// between generation and persistence:
//
//   - the draft text was edited (manually or by a downstream rewrite) and a
//     declared span no longer matches its declared range (span_moved);
//   - a span was deleted from the draft entirely (span_deleted);
//   - markup tags were emitted in a malformed shape (e.g. `<br>` instead of
//     `<br/>`, missing closing bracket);
//   - a `{playerName}`-style variable appears twice or was substituted with a
//     localized form;
//   - a glossary term appears but with the wrong capitalization
//     (capitalization_drift) or wholly-wrong target form
//     (glossary_mistranslation).
//
// The closed enum `DraftProtectedSpanViolationKind` is the typed surface a
// the InvocationSupervisor can name in corrective semantic feedback.
// Any new violation kind MUST be added to the enum AND to the switch in the
// retry policy — the `assertNever` default makes that a compile error.

import type { ProtectedSpanRef } from "@itotori/localization-bridge-schema";
import type { TranslationBridgeUnit } from "../agents/translation/shapes.js";

/**
 * Closed enum naming the **shape** of source-side protected spans. Each
 * shape implies a distinct preservation rule that this validator enforces.
 *
 *   - `source_unit`     — verbatim chunk of source text that must reappear
 *                         byte-equal at the declared draft range.
 *   - `markup`          — control tag (e.g. `<br/>`, `[ruby]`, ASCII control
 *                         sequences). Must appear in the draft text in the
 *                         declared order; missing or duplicated → violation.
 *   - `variable`        — template placeholder such as `{playerName}`, `%s`,
 *                         `${gold}`. Must appear exactly once, unchanged.
 *   - `glossary`        — glossary-locked term (e.g. a character name or
 *                         technical term) that must appear at the declared
 *                         range with the documented capitalization.
 */
export const DRAFT_PROTECTED_SPAN_KINDS = [
  "source_unit",
  "markup",
  "variable",
  "glossary",
] as const;
export type DraftProtectedSpanKind = (typeof DRAFT_PROTECTED_SPAN_KINDS)[number];

/**
 * Source-side projection of a protected span. The validator consumes this
 * shape — callers project from whichever upstream catalog they hold
 * (`BridgeSpanV02`, `DraftJobProtectedSpanRef`, etc.). The validator
 * NEVER infers a span kind from the text — it must be declared.
 */
export type DraftSourceProtectedSpan = {
  /** Opaque ref id; must match a `ProtectedSpanRef.refId` in the draft. */
  refId: string;
  /** The literal source text the agent must preserve verbatim. */
  sourceText: string;
  /** Shape of this span — drives which preservation rule we enforce. */
  spanKind: DraftProtectedSpanKind;
  /**
   * For `glossary` spans, the expected verbatim target form (including
   * capitalization). When `undefined`, the validator falls back to
   * `sourceText` (used for `do_not_translate` glossary entries).
   */
  expectedTargetForm?: string;
};

export type DraftProtectedSpanValidationInput = {
  sourceBridgeUnit: TranslationBridgeUnit;
  draftText: string;
  draftProtectedSpanRefs: ReadonlyArray<ProtectedSpanRef>;
  sourceProtectedSpans: ReadonlyArray<DraftSourceProtectedSpan>;
};

/**
 * Closed enum of acceptance-time violation kinds. The retry policy
 * branches on this enum in a `switch` whose `default` calls `assertNever`,
 * so a new kind added here remains visible to supervisor corrective feedback.
 *
 *   - `span_deleted`           — required ref absent from the draft entirely
 *                                (no matching entry in `draftProtectedSpanRefs`
 *                                AND the source text does not appear in
 *                                `draftText`). Retryable: prompt the model
 *                                to keep the span.
 *   - `span_moved`             — the source text exists in the draft but its
 *                                declared position is wrong or missing. Two
 *                                sub-cases: (a) a ref IS present but points at
 *                                a different range than where the source text
 *                                actually appears (draft edited after
 *                                generation); or (b) NO ref was declared yet
 *                                the literal source text still appears in
 *                                `draftText` at an undeclared position (the
 *                                model kept the span but failed to declare it).
 *                                Retryable: re-emit with corrected positions.
 *   - `span_duplicated`        — source text appears more than once in the
 *                                draft for a kind that must appear exactly
 *                                once (variable / glossary).
 *   - `malformed_markup`       — declared markup span does not parse cleanly
 *                                (e.g. unbalanced angle brackets, missing
 *                                closing tag). Retryable: ask the model to
 *                                emit the well-formed markup.
 *   - `capitalization_drift`   — glossary span appears at the declared range
 *                                with the right characters but the wrong
 *                                capitalization. Non-retryable: the model
 *                                disagrees on terminology and needs manual
 *                                triage.
 *   - `variable_substituted`   — variable span's literal placeholder was
 *                                replaced with a localized substitute
 *                                (e.g. `{player}` rendered as `[プレイヤー]`).
 *                                Retryable: ask the model to keep the literal.
 *   - `glossary_mistranslation`— glossary span's target form does not match
 *                                the documented term at all. Non-retryable:
 *                                manual triage.
 */
export const DRAFT_PROTECTED_SPAN_VIOLATION_KINDS = [
  "span_deleted",
  "span_moved",
  "span_duplicated",
  "malformed_markup",
  "capitalization_drift",
  "variable_substituted",
  "glossary_mistranslation",
] as const;
export type DraftProtectedSpanViolationKind = (typeof DRAFT_PROTECTED_SPAN_VIOLATION_KINDS)[number];

export type DraftProtectedSpanViolation = {
  kind: DraftProtectedSpanViolationKind;
  /** The source-side span that was violated. */
  spanRefId: string;
  spanKind: DraftProtectedSpanKind;
  bridgeUnitId: string;
  /** Human-readable detail naming the specific divergence. */
  detail: string;
  /**
   * Position evidence pulled from the draft when relevant.
   *   - `declaredRange`: the `(startInDraft, endInDraft)` that the draft
   *     claimed for this span (when the span ref WAS present in the draft).
   *   - `observedRanges`: index ranges where the source text actually
   *     appears in the draft (empty when fully absent).
   */
  evidence: {
    declaredRange?: { startInDraft: number; endInDraft: number };
    observedRanges: ReadonlyArray<{ startInDraft: number; endInDraft: number }>;
  };
};

export type DraftProtectedSpanValidationResult = {
  accepted: boolean;
  violations: ReadonlyArray<DraftProtectedSpanViolation>;
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Second-layer protected-span validator. Stateless; constructed once per
 * process / request scope.
 *
 * The validator returns an accumulated `violations` array rather than
 * throwing on the first failure — the acceptance gate routes the
 * full violation set into InvocationSupervisor's semantic classifier so triage gets a
 * complete picture in one pass.
 */
export class DraftProtectedSpanValidator {
  validate(input: DraftProtectedSpanValidationInput): DraftProtectedSpanValidationResult {
    const violations: DraftProtectedSpanViolation[] = [];

    // Index the draft's claimed refs once.
    const draftRefByRefId = new Map<string, ProtectedSpanRef>();
    for (const ref of input.draftProtectedSpanRefs) {
      // Note: ITOTORI-075's agent already rejects duplicate refIds at
      // generation time. If the input somehow contains two refs with the
      // same id by acceptance time, the second wins; the rest of the
      // validation will still produce useful violations.
      draftRefByRefId.set(ref.refId, ref);
    }

    for (const sourceSpan of input.sourceProtectedSpans) {
      const draftRef = draftRefByRefId.get(sourceSpan.refId);
      const observedRanges = findAllOccurrences(input.draftText, sourceSpan.sourceText);

      switch (sourceSpan.spanKind) {
        case "source_unit": {
          this.validateSourceUnitSpan({
            input,
            sourceSpan,
            draftRef,
            observedRanges,
            violations,
          });
          break;
        }
        case "markup": {
          this.validateMarkupSpan({
            input,
            sourceSpan,
            draftRef,
            observedRanges,
            violations,
          });
          break;
        }
        case "variable": {
          this.validateVariableSpan({
            input,
            sourceSpan,
            draftRef,
            observedRanges,
            violations,
          });
          break;
        }
        case "glossary": {
          this.validateGlossarySpan({
            input,
            sourceSpan,
            draftRef,
            observedRanges,
            violations,
          });
          break;
        }
        default: {
          // Exhaustiveness guard — adding a new DraftProtectedSpanKind
          // without handling it here is a compile error.
          assertNever(sourceSpan.spanKind);
        }
      }
    }

    return {
      accepted: violations.length === 0,
      violations,
    };
  }

  // -------------------------------------------------------------------------
  // Per-kind validators. Each pushes 0..N violations; never throws.
  // -------------------------------------------------------------------------

  private validateSourceUnitSpan(args: PerKindArgs): void {
    const { input, sourceSpan, draftRef, observedRanges, violations } = args;
    if (draftRef === undefined) {
      // Required ref missing entirely from the draft.
      violations.push({
        kind: "span_deleted",
        spanRefId: sourceSpan.refId,
        spanKind: sourceSpan.spanKind,
        bridgeUnitId: input.sourceBridgeUnit.bridgeUnitId,
        detail: `source_unit span '${sourceSpan.refId}' was not declared in the draft's protectedSpanRefs`,
        evidence: { observedRanges },
      });
      return;
    }
    const observed = input.draftText.slice(draftRef.startInDraft, draftRef.endInDraft);
    if (observed !== sourceSpan.sourceText) {
      // Declared range no longer hosts the source text — either the text
      // was edited (span_moved if it appears elsewhere) or it was wholly
      // deleted (span_deleted).
      if (observedRanges.length === 0) {
        violations.push({
          kind: "span_deleted",
          spanRefId: sourceSpan.refId,
          spanKind: sourceSpan.spanKind,
          bridgeUnitId: input.sourceBridgeUnit.bridgeUnitId,
          detail: `source_unit span '${sourceSpan.refId}' is no longer present in draftText`,
          evidence: {
            declaredRange: { startInDraft: draftRef.startInDraft, endInDraft: draftRef.endInDraft },
            observedRanges,
          },
        });
      } else {
        violations.push({
          kind: "span_moved",
          spanRefId: sourceSpan.refId,
          spanKind: sourceSpan.spanKind,
          bridgeUnitId: input.sourceBridgeUnit.bridgeUnitId,
          detail: `source_unit span '${sourceSpan.refId}' declared at [${draftRef.startInDraft}..${draftRef.endInDraft}] but appears at ${formatRanges(observedRanges)}`,
          evidence: {
            declaredRange: { startInDraft: draftRef.startInDraft, endInDraft: draftRef.endInDraft },
            observedRanges,
          },
        });
      }
    }
  }

  private validateMarkupSpan(args: PerKindArgs): void {
    const { input, sourceSpan, draftRef, observedRanges, violations } = args;
    if (!isWellFormedMarkup(sourceSpan.sourceText)) {
      // Caller's catalog has the rule wrong — treat as malformed at
      // source so downstream sees the diagnostic.
      violations.push({
        kind: "malformed_markup",
        spanRefId: sourceSpan.refId,
        spanKind: sourceSpan.spanKind,
        bridgeUnitId: input.sourceBridgeUnit.bridgeUnitId,
        detail: `markup span '${sourceSpan.refId}' sourceText '${sourceSpan.sourceText}' is not well-formed`,
        evidence: { observedRanges },
      });
      return;
    }
    if (draftRef === undefined) {
      violations.push({
        kind: "span_deleted",
        spanRefId: sourceSpan.refId,
        spanKind: sourceSpan.spanKind,
        bridgeUnitId: input.sourceBridgeUnit.bridgeUnitId,
        detail: `markup span '${sourceSpan.refId}' was not declared in the draft's protectedSpanRefs`,
        evidence: { observedRanges },
      });
      return;
    }
    const observed = input.draftText.slice(draftRef.startInDraft, draftRef.endInDraft);
    if (observed === sourceSpan.sourceText) {
      // The literal byte-equal check at the declared range passes —
      // additionally guard against a malformed shape that snuck through
      // (unbalanced angle bracket at the boundary).
      const flanking = surroundingMarkupContext(
        input.draftText,
        draftRef.startInDraft,
        draftRef.endInDraft,
      );
      if (flanking.malformed) {
        violations.push({
          kind: "malformed_markup",
          spanRefId: sourceSpan.refId,
          spanKind: sourceSpan.spanKind,
          bridgeUnitId: input.sourceBridgeUnit.bridgeUnitId,
          detail: `markup span '${sourceSpan.refId}' is byte-equal but flanking context indicates malformed markup (${flanking.reason})`,
          evidence: {
            declaredRange: {
              startInDraft: draftRef.startInDraft,
              endInDraft: draftRef.endInDraft,
            },
            observedRanges,
          },
        });
      }
      return;
    }
    // Declared range no longer hosts the markup verbatim.
    if (observedRanges.length === 0) {
      violations.push({
        kind: "malformed_markup",
        spanRefId: sourceSpan.refId,
        spanKind: sourceSpan.spanKind,
        bridgeUnitId: input.sourceBridgeUnit.bridgeUnitId,
        detail: `markup span '${sourceSpan.refId}' is no longer well-formed at the declared range (observed '${observed}')`,
        evidence: {
          declaredRange: { startInDraft: draftRef.startInDraft, endInDraft: draftRef.endInDraft },
          observedRanges,
        },
      });
    } else {
      violations.push({
        kind: "span_moved",
        spanRefId: sourceSpan.refId,
        spanKind: sourceSpan.spanKind,
        bridgeUnitId: input.sourceBridgeUnit.bridgeUnitId,
        detail: `markup span '${sourceSpan.refId}' declared at [${draftRef.startInDraft}..${draftRef.endInDraft}] but appears at ${formatRanges(observedRanges)}`,
        evidence: {
          declaredRange: { startInDraft: draftRef.startInDraft, endInDraft: draftRef.endInDraft },
          observedRanges,
        },
      });
    }
  }

  private validateVariableSpan(args: PerKindArgs): void {
    const { input, sourceSpan, draftRef, observedRanges, violations } = args;
    if (draftRef === undefined) {
      // No declared ref — either the model dropped it or substituted it
      // with a localized form. Distinguish by checking for the literal.
      if (observedRanges.length === 0) {
        violations.push({
          kind: "variable_substituted",
          spanRefId: sourceSpan.refId,
          spanKind: sourceSpan.spanKind,
          bridgeUnitId: input.sourceBridgeUnit.bridgeUnitId,
          detail: `variable span '${sourceSpan.refId}' literal '${sourceSpan.sourceText}' was substituted or removed from draftText`,
          evidence: { observedRanges },
        });
      } else {
        // The literal IS present in draftText but no ref declares its
        // position. This is NOT span_deleted (whose documented condition
        // requires the source text to be absent); the span survived but its
        // declaration is missing — a position/declaration problem, which is
        // span_moved per its documented sub-case (b).
        violations.push({
          kind: "span_moved",
          spanRefId: sourceSpan.refId,
          spanKind: sourceSpan.spanKind,
          bridgeUnitId: input.sourceBridgeUnit.bridgeUnitId,
          detail: `variable span '${sourceSpan.refId}' literal '${sourceSpan.sourceText}' appears in draftText at ${formatRanges(observedRanges)} but was not declared in protectedSpanRefs`,
          evidence: { observedRanges },
        });
      }
      return;
    }
    const observed = input.draftText.slice(draftRef.startInDraft, draftRef.endInDraft);
    if (observed !== sourceSpan.sourceText) {
      // Declared range no longer hosts the literal.
      if (observedRanges.length === 0) {
        violations.push({
          kind: "variable_substituted",
          spanRefId: sourceSpan.refId,
          spanKind: sourceSpan.spanKind,
          bridgeUnitId: input.sourceBridgeUnit.bridgeUnitId,
          detail: `variable span '${sourceSpan.refId}' literal '${sourceSpan.sourceText}' is no longer present in draftText (declared range hosts '${observed}')`,
          evidence: {
            declaredRange: { startInDraft: draftRef.startInDraft, endInDraft: draftRef.endInDraft },
            observedRanges,
          },
        });
      } else {
        violations.push({
          kind: "span_moved",
          spanRefId: sourceSpan.refId,
          spanKind: sourceSpan.spanKind,
          bridgeUnitId: input.sourceBridgeUnit.bridgeUnitId,
          detail: `variable span '${sourceSpan.refId}' declared at [${draftRef.startInDraft}..${draftRef.endInDraft}] but appears at ${formatRanges(observedRanges)}`,
          evidence: {
            declaredRange: { startInDraft: draftRef.startInDraft, endInDraft: draftRef.endInDraft },
            observedRanges,
          },
        });
      }
      return;
    }
    // Declared range hosts the literal; additionally enforce exactly-once.
    if (observedRanges.length > 1) {
      violations.push({
        kind: "span_duplicated",
        spanRefId: sourceSpan.refId,
        spanKind: sourceSpan.spanKind,
        bridgeUnitId: input.sourceBridgeUnit.bridgeUnitId,
        detail: `variable span '${sourceSpan.refId}' literal '${sourceSpan.sourceText}' appears ${observedRanges.length} times; variables must appear exactly once`,
        evidence: {
          declaredRange: { startInDraft: draftRef.startInDraft, endInDraft: draftRef.endInDraft },
          observedRanges,
        },
      });
    }
  }

  private validateGlossarySpan(args: PerKindArgs): void {
    const { input, sourceSpan, draftRef, violations } = args;
    const expected = sourceSpan.expectedTargetForm ?? sourceSpan.sourceText;
    const expectedOccurrences = findAllOccurrences(input.draftText, expected);

    if (draftRef === undefined) {
      // Required ref missing.
      violations.push({
        kind: "span_deleted",
        spanRefId: sourceSpan.refId,
        spanKind: sourceSpan.spanKind,
        bridgeUnitId: input.sourceBridgeUnit.bridgeUnitId,
        detail: `glossary span '${sourceSpan.refId}' (expected target form '${expected}') was not declared in the draft's protectedSpanRefs`,
        evidence: { observedRanges: expectedOccurrences },
      });
      return;
    }
    const observed = input.draftText.slice(draftRef.startInDraft, draftRef.endInDraft);
    if (observed === expected) {
      // Capitalization + content both match; ensure non-duplication.
      if (expectedOccurrences.length > 1) {
        violations.push({
          kind: "span_duplicated",
          spanRefId: sourceSpan.refId,
          spanKind: sourceSpan.spanKind,
          bridgeUnitId: input.sourceBridgeUnit.bridgeUnitId,
          detail: `glossary span '${sourceSpan.refId}' target form '${expected}' appears ${expectedOccurrences.length} times`,
          evidence: {
            declaredRange: { startInDraft: draftRef.startInDraft, endInDraft: draftRef.endInDraft },
            observedRanges: expectedOccurrences,
          },
        });
      }
      return;
    }
    // Declared range does NOT host the expected form.
    if (observed.toLowerCase() === expected.toLowerCase()) {
      // Same letters, different capitalization → capitalization_drift.
      violations.push({
        kind: "capitalization_drift",
        spanRefId: sourceSpan.refId,
        spanKind: sourceSpan.spanKind,
        bridgeUnitId: input.sourceBridgeUnit.bridgeUnitId,
        detail: `glossary span '${sourceSpan.refId}' expected '${expected}' but observed '${observed}' (capitalization differs)`,
        evidence: {
          declaredRange: { startInDraft: draftRef.startInDraft, endInDraft: draftRef.endInDraft },
          observedRanges: expectedOccurrences,
        },
      });
      return;
    }
    // Wholly-different terminology — mistranslation.
    violations.push({
      kind: "glossary_mistranslation",
      spanRefId: sourceSpan.refId,
      spanKind: sourceSpan.spanKind,
      bridgeUnitId: input.sourceBridgeUnit.bridgeUnitId,
      detail: `glossary span '${sourceSpan.refId}' expected '${expected}' but observed '${observed}' (terminology differs)`,
      evidence: {
        declaredRange: { startInDraft: draftRef.startInDraft, endInDraft: draftRef.endInDraft },
        observedRanges: expectedOccurrences,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type PerKindArgs = {
  input: DraftProtectedSpanValidationInput;
  sourceSpan: DraftSourceProtectedSpan;
  draftRef: ProtectedSpanRef | undefined;
  observedRanges: ReadonlyArray<{ startInDraft: number; endInDraft: number }>;
  violations: DraftProtectedSpanViolation[];
};

function findAllOccurrences(
  haystack: string,
  needle: string,
): Array<{ startInDraft: number; endInDraft: number }> {
  if (needle.length === 0) {
    return [];
  }
  const ranges: Array<{ startInDraft: number; endInDraft: number }> = [];
  let cursor = 0;
  while (cursor <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, cursor);
    if (found < 0) {
      break;
    }
    ranges.push({ startInDraft: found, endInDraft: found + needle.length });
    cursor = found + needle.length;
  }
  return ranges;
}

function formatRanges(ranges: ReadonlyArray<{ startInDraft: number; endInDraft: number }>): string {
  if (ranges.length === 0) {
    return "[]";
  }
  return ranges.map((r) => `[${r.startInDraft}..${r.endInDraft}]`).join(", ");
}

/**
 * Lightweight well-formedness check for the markup catalog entries.
 * We accept three shapes:
 *   - Angle-bracket tags: balanced `<...>` with non-empty body.
 *   - Square-bracket tags: balanced `[...]` with non-empty body.
 *   - ASCII control sequences: starting with `\x1B` (ESC) or `\\u`-escapes.
 * Anything else is rejected to flag a malformed catalog entry.
 */
function isWellFormedMarkup(text: string): boolean {
  if (text.length === 0) {
    return false;
  }
  if (text.startsWith("<") && text.endsWith(">")) {
    const body = text.slice(1, text.length - 1);
    if (body.length === 0) {
      return false;
    }
    return !body.includes("<") && !body.includes(">");
  }
  if (text.startsWith("[") && text.endsWith("]")) {
    const body = text.slice(1, text.length - 1);
    if (body.length === 0) {
      return false;
    }
    return !body.includes("[") && !body.includes("]");
  }
  // ESC-prefixed ASCII control sequence.
  if (text.charCodeAt(0) === 0x1b) {
    return true;
  }
  return false;
}

/**
 * Inspect the characters immediately surrounding a declared markup span to
 * catch malformed neighborhoods (e.g. a stray `<` left over from a
 * partially-edited tag).
 */
function surroundingMarkupContext(
  draftText: string,
  startInDraft: number,
  endInDraft: number,
): { malformed: false } | { malformed: true; reason: string } {
  const before = startInDraft > 0 ? draftText.charAt(startInDraft - 1) : "";
  const after = endInDraft < draftText.length ? draftText.charAt(endInDraft) : "";
  if (before === "<" || before === "[") {
    return { malformed: true, reason: `unexpected opening bracket '${before}' before span` };
  }
  if (after === ">" || after === "]") {
    return { malformed: true, reason: `unexpected closing bracket '${after}' after span` };
  }
  return { malformed: false };
}

function assertNever(value: never): never {
  throw new Error(`exhaustiveness check failed: unexpected value ${String(value)}`);
}
