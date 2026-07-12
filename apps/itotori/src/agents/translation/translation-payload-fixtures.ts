// ITOTORI-075 — Pure-TS fixture factories for translation drafts.
//
// Stand-alone factory functions used by tests + downstream consumers
// to assemble realistic draft shapes. Carries NO database dependency:
// the draft persistence wiring is owned by a follow-up node
// (ITOTORI-076), so these fixtures only commit to the wire shape from
// `@itotori/localization-bridge-schema`.
//
// The five named fixtures below mirror the diagnostic spec contract
// for ITOTORI-075:
//   - validTranslationDraftFixture      : known-good 3-draft response
//   - malformedJsonFixture              : invalid JSON
//   - missingProtectedSpanFixture       : output drops a required ref
//   - repairableTrailingCommaFixture    : trailing-comma JSON (bounded json-repair salvages it)
//   - fallbackTimeoutFixture            : empty response simulating provider timeout

import {
  STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
  type ProtectedSpanRef,
  type StructuredTranslationDraftOutput,
  type TranslationDraft,
  type TranslationDraftConfidenceFloor,
} from "@itotori/localization-bridge-schema";

export const TRANSLATION_FIXTURE_DRAFT_JOB_ID = "019ed079-0000-7000-8000-000000000d10";
export const TRANSLATION_FIXTURE_DRAFT_JOB_ATTEMPT_ID = "019ed079-0000-7000-8000-000000000d11";
export const TRANSLATION_FIXTURE_PROJECT_ID = "019ed079-0000-7000-8000-000000000001";
export const TRANSLATION_FIXTURE_LOCALE_BRANCH_ID = "019ed079-0000-7000-8000-000000000002";
export const TRANSLATION_FIXTURE_BRIDGE_UNIT_BASE = "019ed079-0000-7000-8000-00000000ac";

export const TRANSLATION_FIXTURE_SOURCE_LOCALE = "ja-JP";
export const TRANSLATION_FIXTURE_TARGET_LOCALE = "en-US";

export type TranslationDraftFactoryOverrides = {
  bridgeUnitId?: string;
  sourceLocale?: string;
  targetLocale?: string;
  draftText?: string;
  protectedSpanRefs?: ProtectedSpanRef[];
  citationRefs?: string[];
  agentRationale?: string;
  confidenceFloor?: TranslationDraftConfidenceFloor;
};

export function makeTranslationDraftFixture(
  overrides: TranslationDraftFactoryOverrides = {},
): TranslationDraft {
  return {
    bridgeUnitId: overrides.bridgeUnitId ?? `${TRANSLATION_FIXTURE_BRIDGE_UNIT_BASE}01`,
    sourceLocale: overrides.sourceLocale ?? TRANSLATION_FIXTURE_SOURCE_LOCALE,
    targetLocale: overrides.targetLocale ?? TRANSLATION_FIXTURE_TARGET_LOCALE,
    draftText: overrides.draftText ?? "Hello, {player}.",
    protectedSpanRefs: overrides.protectedSpanRefs ?? [
      { refId: "span-1", startInDraft: 7, endInDraft: 15 },
    ],
    citationRefs: overrides.citationRefs ?? ["glossary:term-yusha"],
    agentRationale:
      overrides.agentRationale ??
      "Localized the greeting while preserving the player placeholder byte-equal.",
    confidenceFloor: overrides.confidenceFloor ?? "medium",
  };
}

export function makeStructuredTranslationDraftOutputFixture(
  drafts: TranslationDraft[],
): StructuredTranslationDraftOutput {
  return {
    schemaVersion: STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
    drafts,
  };
}

/**
 * Returns a structured 3-draft fixture where every protected span
 * survives byte-equal. Anchors a wide range of tests:
 *   - happy-path parse
 *   - protected-span preservation
 *   - citation resolution
 */
export function representativeTranslationDraftsFixture(): TranslationDraft[] {
  return [
    makeTranslationDraftFixture({
      bridgeUnitId: `${TRANSLATION_FIXTURE_BRIDGE_UNIT_BASE}01`,
      draftText: "Hello, {player}.",
      protectedSpanRefs: [{ refId: "span-greeting-placeholder", startInDraft: 7, endInDraft: 15 }],
      citationRefs: ["glossary:term-greeting"],
      agentRationale: "Localized greeting preserves the {player} placeholder byte-equal.",
      confidenceFloor: "high",
    }),
    makeTranslationDraftFixture({
      bridgeUnitId: `${TRANSLATION_FIXTURE_BRIDGE_UNIT_BASE}02`,
      draftText: "The hero greeted the king.",
      protectedSpanRefs: [],
      citationRefs: ["glossary:term-yusha"],
      agentRationale: "Applied the glossary's preferred target form 'hero' for 勇者.",
      confidenceFloor: "medium",
    }),
    makeTranslationDraftFixture({
      bridgeUnitId: `${TRANSLATION_FIXTURE_BRIDGE_UNIT_BASE}03`,
      draftText: "They arrived at the demon castle <ruby>entrance</ruby>.",
      protectedSpanRefs: [
        { refId: "span-ruby-open", startInDraft: 33, endInDraft: 39 },
        { refId: "span-ruby-close", startInDraft: 47, endInDraft: 54 },
      ],
      citationRefs: ["context-artifact:scene-summary-001"],
      agentRationale:
        "Preserved the ruby markup spans byte-equal; used scene context for the demon castle referent.",
      confidenceFloor: "low",
    }),
  ];
}

/**
 * Known-good 3-draft response with all required fields populated.
 * The returned string is exactly what a recorded bundle would carry
 * as its `content`.
 */
export function validTranslationDraftFixture(): string {
  return JSON.stringify(
    makeStructuredTranslationDraftOutputFixture(representativeTranslationDraftsFixture()),
  );
}

/**
 * Provider response that is not valid JSON. Used to assert the
 * parser throws `TranslationDraftResponseValidationError` with
 * rule='json'.
 */
export function malformedJsonFixture(): string {
  return "this is definitely not JSON {{{";
}

/**
 * Provider response that omits a protected-span ref the input
 * catalog required. Drives the
 * `TranslationProtectedSpanViolationError({reason:'missing_ref'})`
 * path.
 */
export function missingProtectedSpanFixture(): string {
  const drafts = representativeTranslationDraftsFixture().map((draft, index) => {
    if (index === 0) {
      // Drop the placeholder ref entirely but leave the draft text
      // intact so the violation reports `missing_ref` rather than a
      // schema error.
      return { ...draft, protectedSpanRefs: [] };
    }
    return draft;
  });
  return JSON.stringify(makeStructuredTranslationDraftOutputFixture(drafts));
}

/**
 * Provider response with a trailing comma — RFC 8259 forbids them, so a raw
 * JSON.parse refuses. The TranslationAgent's bounded `repairJsonObject` salvage
 * (patchback-safety) strips the trailing comma before schema validation, so
 * this response is now recovered rather than rejected. Used to assert the
 * deterministic json-repair path.
 */
export function repairableTrailingCommaFixture(): string {
  const complete = JSON.stringify(
    makeStructuredTranslationDraftOutputFixture(representativeTranslationDraftsFixture()),
  );
  // Hand-built from a complete valid response so the only defect is the
  // trailing comma itself; the agent must never treat an empty draft list as a
  // successful recovery.
  return `${complete.slice(0, -1)},}`;
}

/**
 * Provider response that is empty (the provider timed out before
 * emitting any content). Drives the
 * `TranslationPartialResultError` path.
 */
export function fallbackTimeoutFixture(): string {
  return "";
}
