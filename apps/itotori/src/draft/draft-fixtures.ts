// ITOTORI-076 — Pure-TS fixture factories for draft acceptance-gate tests.
//
// Each named fixture below assembles a `DraftProtectedSpanValidationInput`
// plus the expected outcome shape (accepted, or a specific violation kind).
// The fixtures are deliberately small — one bridge unit, a handful of
// spans — so the tests stay byte-stable across diff churn.
//
// The fixtures cover:
//
//   - validDraftFixture                — accepted
//   - spanDeletedDraftFixture          — span_deleted, retryable
//   - spanMovedDraftFixture            — span_moved, retryable
//   - malformedMarkupDraftFixture      — malformed_markup, retryable
//   - variableSubstitutedDraftFixture  — variable_substituted, retryable
//   - spanDuplicatedDraftFixture       — span_duplicated, retryable
//   - nonRetryableFixture              — capitalization_drift, non-retryable
//   - glossaryMistranslationFixture    — glossary_mistranslation, non-retryable

import type { TranslationBridgeUnit } from "../agents/translation/shapes.js";
import type {
  DraftProtectedSpanValidationInput,
  DraftSourceProtectedSpan,
} from "./protected-span-validator.js";

export const DRAFT_FIXTURE_BRIDGE_UNIT_ID = "019ed079-0000-7000-8000-000000000bf1";

export function draftFixtureBridgeUnit(): TranslationBridgeUnit {
  return {
    bridgeUnitId: DRAFT_FIXTURE_BRIDGE_UNIT_ID,
    sourceUnitKey: "scene.001.line.001",
    sourceText: "こんにちは、{player}。勇者は<br/>挨拶した。",
    sourceHash: "src-hash-fixture-001",
    speaker: "narration",
  };
}

/**
 * Realistic source-side span catalog covering each kind. Tests pick
 * subsets via the fixtures below.
 */
export function draftFixtureSourceSpans(): DraftSourceProtectedSpan[] {
  return [
    {
      refId: "span-variable-player",
      sourceText: "{player}",
      spanKind: "variable",
    },
    {
      refId: "span-markup-br",
      sourceText: "<br/>",
      spanKind: "markup",
    },
    {
      refId: "span-glossary-hero",
      sourceText: "勇者",
      spanKind: "glossary",
      expectedTargetForm: "Hero",
    },
    {
      refId: "span-source-quote",
      sourceText: "こんにちは",
      spanKind: "source_unit",
    },
  ];
}

// ---------------------------------------------------------------------------
// Valid (accepted) fixture
// ---------------------------------------------------------------------------

export function validDraftFixture(): DraftProtectedSpanValidationInput {
  // Draft text: "こんにちは, Hello {player}. Hero greeted the king.<br/> end."
  //
  // Positions (string.length / UTF-16 code-unit indexing):
  //   こんにちは        : 0..5    (source_unit / quote)
  //   {player}          : 13..21  (variable)
  //   Hero              : 23..27  (glossary, expectedTargetForm='Hero')
  //   <br/>             : 45..50  (markup)
  const draftText = "こんにちは, Hello {player}. Hero greeted the king.<br/> end.";
  return {
    sourceBridgeUnit: draftFixtureBridgeUnit(),
    draftText,
    draftProtectedSpanRefs: [
      { refId: "span-source-quote", startInDraft: 0, endInDraft: 5 },
      { refId: "span-variable-player", startInDraft: 13, endInDraft: 21 },
      { refId: "span-glossary-hero", startInDraft: 23, endInDraft: 27 },
      { refId: "span-markup-br", startInDraft: 45, endInDraft: 50 },
    ],
    sourceProtectedSpans: draftFixtureSourceSpans(),
  };
}

// ---------------------------------------------------------------------------
// span_deleted (retryable)
// ---------------------------------------------------------------------------

export function spanDeletedDraftFixture(): DraftProtectedSpanValidationInput {
  // Draft text has the quote/variable/glossary but drops the markup
  // span entirely — no `<br/>` anywhere AND no protectedSpanRef for it.
  const draftText = "こんにちは, Hello {player}. Hero greeted the king. end.";
  return {
    sourceBridgeUnit: draftFixtureBridgeUnit(),
    draftText,
    draftProtectedSpanRefs: [
      { refId: "span-source-quote", startInDraft: 0, endInDraft: 5 },
      { refId: "span-variable-player", startInDraft: 13, endInDraft: 21 },
      { refId: "span-glossary-hero", startInDraft: 23, endInDraft: 27 },
      // span-markup-br omitted.
    ],
    sourceProtectedSpans: draftFixtureSourceSpans(),
  };
}

// ---------------------------------------------------------------------------
// span_moved (retryable)
// ---------------------------------------------------------------------------

export function spanMovedDraftFixture(): DraftProtectedSpanValidationInput {
  // The literal `こんにちは` appears in the draft, but NOT at the
  // declared range. The validator must report `span_moved`.
  //
  // Draft text: "Hi! こんにちは, Hero. <br/>"  — quote at offset 4..9
  const draftText = "Hi! こんにちは, Hero. <br/>";
  return {
    sourceBridgeUnit: draftFixtureBridgeUnit(),
    draftText,
    draftProtectedSpanRefs: [
      // Claims the quote starts at 0 but really starts at 4.
      { refId: "span-source-quote", startInDraft: 0, endInDraft: 5 },
      { refId: "span-glossary-hero", startInDraft: 11, endInDraft: 15 },
      { refId: "span-markup-br", startInDraft: 17, endInDraft: 22 },
    ],
    // Only include the spans we want under test (no variable for this case).
    sourceProtectedSpans: [
      {
        refId: "span-source-quote",
        sourceText: "こんにちは",
        spanKind: "source_unit",
      },
      {
        refId: "span-glossary-hero",
        sourceText: "勇者",
        spanKind: "glossary",
        expectedTargetForm: "Hero",
      },
      {
        refId: "span-markup-br",
        sourceText: "<br/>",
        spanKind: "markup",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// malformed_markup (retryable)
// ---------------------------------------------------------------------------

export function malformedMarkupDraftFixture(): DraftProtectedSpanValidationInput {
  // Draft renders `<br/>` byte-equal but with a stray opening `<`
  // immediately before it — flanking-context check fires.
  //
  // Draft text: "Hello. <<br/> end."
  //                      ^7..12 = "<br/>" (byte-equal)
  //                     ^6      = stray "<"
  const draftText = "Hello. <<br/> end.";
  return {
    sourceBridgeUnit: draftFixtureBridgeUnit(),
    draftText,
    draftProtectedSpanRefs: [{ refId: "span-markup-br", startInDraft: 8, endInDraft: 13 }],
    sourceProtectedSpans: [
      {
        refId: "span-markup-br",
        sourceText: "<br/>",
        spanKind: "markup",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// variable_substituted (retryable)
// ---------------------------------------------------------------------------

export function variableSubstitutedDraftFixture(): DraftProtectedSpanValidationInput {
  // The model replaced `{player}` with a localized `[プレイヤー]` form.
  // The literal `{player}` does not appear anywhere in the draft.
  const draftText = "Hello, [プレイヤー]!";
  return {
    sourceBridgeUnit: draftFixtureBridgeUnit(),
    draftText,
    draftProtectedSpanRefs: [],
    sourceProtectedSpans: [
      {
        refId: "span-variable-player",
        sourceText: "{player}",
        spanKind: "variable",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// span_duplicated (retryable)
// ---------------------------------------------------------------------------

export function spanDuplicatedDraftFixture(): DraftProtectedSpanValidationInput {
  // Variable appears twice — once at the declared range, once again
  // later in the draft.
  const draftText = "Hi {player}, hello {player}.";
  return {
    sourceBridgeUnit: draftFixtureBridgeUnit(),
    draftText,
    draftProtectedSpanRefs: [{ refId: "span-variable-player", startInDraft: 3, endInDraft: 11 }],
    sourceProtectedSpans: [
      {
        refId: "span-variable-player",
        sourceText: "{player}",
        spanKind: "variable",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// capitalization_drift (NON-retryable)
// ---------------------------------------------------------------------------

export function nonRetryableFixture(): DraftProtectedSpanValidationInput {
  // Glossary term capitalization disagrees with the expected target.
  // Expected: "Hero"; observed: "hero".
  const draftText = "The hero greeted the king.";
  return {
    sourceBridgeUnit: draftFixtureBridgeUnit(),
    draftText,
    draftProtectedSpanRefs: [{ refId: "span-glossary-hero", startInDraft: 4, endInDraft: 8 }],
    sourceProtectedSpans: [
      {
        refId: "span-glossary-hero",
        sourceText: "勇者",
        spanKind: "glossary",
        expectedTargetForm: "Hero",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// glossary_mistranslation (NON-retryable)
// ---------------------------------------------------------------------------

export function glossaryMistranslationFixture(): DraftProtectedSpanValidationInput {
  // Glossary term substituted with a wholly different word.
  // Expected: "Hero"; observed: "Champion".
  const draftText = "The Champion greeted the king.";
  return {
    sourceBridgeUnit: draftFixtureBridgeUnit(),
    draftText,
    draftProtectedSpanRefs: [{ refId: "span-glossary-hero", startInDraft: 4, endInDraft: 12 }],
    sourceProtectedSpans: [
      {
        refId: "span-glossary-hero",
        sourceText: "勇者",
        spanKind: "glossary",
        expectedTargetForm: "Hero",
      },
    ],
  };
}
