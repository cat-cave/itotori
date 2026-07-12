import { describe, expect, it } from "vitest";
import {
  assertStructuredTranslationDraftOutput,
  parseStructuredTranslationDraftOutput,
  STRUCTURED_TRANSLATION_DRAFT_OUTPUT_JSON_SCHEMA,
  STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
  TRANSLATION_DRAFT_CONFIDENCE_FLOORS,
  TranslationDraftResponseValidationError,
} from "../src/translation-draft.js";

function validDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bridgeUnitId: "019ed079-0000-7000-8000-00000000a001",
    sourceLocale: "ja-JP",
    targetLocale: "en-US",
    draftText: "Hello, {player}.",
    protectedSpanRefs: [{ refId: "span-1", startInDraft: 7, endInDraft: 15 }],
    citationRefs: ["glossary:term-yusha"],
    agentRationale: "Translated greeting preserving the player placeholder.",
    confidenceFloor: "medium",
    ...overrides,
  };
}

function validOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
    drafts: [validDraft()],
    ...overrides,
  };
}

describe("StructuredTranslationDraftOutput", () => {
  it("accepts a fully-populated draft", () => {
    expect(() => assertStructuredTranslationDraftOutput(validOutput())).not.toThrow();
  });

  it("rejects an empty drafts array", () => {
    expect(() =>
      assertStructuredTranslationDraftOutput({
        schemaVersion: STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
        drafts: [],
      }),
    ).toThrow(/minItems/);
  });

  it("rejects a blank draftText", () => {
    expect(() =>
      assertStructuredTranslationDraftOutput(
        validOutput({
          drafts: [validDraft({ draftText: "", protectedSpanRefs: [], citationRefs: [] })],
        }),
      ),
    ).toThrow(/nonBlank/);
  });

  it("rejects padded and locale-tagged source-replay draft text", () => {
    expect(() =>
      assertStructuredTranslationDraftOutput(
        validOutput({ drafts: [validDraft({ draftText: " Hello, {player}." })] }),
      ),
    ).toThrow(/trimmed/);

    expect(() =>
      assertStructuredTranslationDraftOutput(
        validOutput({ drafts: [validDraft({ draftText: "[en-US]こんにちは、{player}。" })] }),
      ),
    ).toThrow(/sourceEcho/);
  });

  it("rejects an output without schemaVersion", () => {
    expect(() => assertStructuredTranslationDraftOutput({ drafts: [] })).toThrow(
      TranslationDraftResponseValidationError,
    );
  });

  it("rejects an output with the wrong schemaVersion", () => {
    expect(() =>
      assertStructuredTranslationDraftOutput({ schemaVersion: "v0", drafts: [] }),
    ).toThrow(/schemaVersion/);
  });

  it("rejects drafts missing a required field", () => {
    const value = validOutput({
      drafts: [validDraft({ confidenceFloor: undefined })],
    });
    const draft = (value.drafts as Array<Record<string, unknown>>)[0]!;
    delete draft.confidenceFloor;
    expect(() => assertStructuredTranslationDraftOutput(value)).toThrow(/confidenceFloor/);
  });

  it("reports a genuinely-missing required field with rule 'required' (non-retryable)", () => {
    // A missing field is unrecoverable by re-emission and must be reported
    // as 'required' (not 'type'), so corrective feedback names the omission.
    const value = validOutput({
      drafts: [validDraft({ confidenceFloor: undefined })],
    });
    const draft = (value.drafts as Array<Record<string, unknown>>)[0]!;
    delete draft.confidenceFloor;
    try {
      assertStructuredTranslationDraftOutput(value);
      throw new Error("expected a validation error");
    } catch (error) {
      expect(error).toBeInstanceOf(TranslationDraftResponseValidationError);
      if (error instanceof TranslationDraftResponseValidationError) {
        expect(error.rule).toBe("required");
        expect(error.path).toBe("drafts[0].confidenceFloor");
      }
    }
  });

  it("reports a present-but-wrong-type field with rule 'type' (retryable coercion)", () => {
    // A field that is present with the wrong type is a recoverable
    // coercion glitch — reported as 'type' so corrective feedback names it.
    try {
      assertStructuredTranslationDraftOutput(
        validOutput({ drafts: [validDraft({ draftText: 42 })] }),
      );
      throw new Error("expected a validation error");
    } catch (error) {
      expect(error).toBeInstanceOf(TranslationDraftResponseValidationError);
      if (error instanceof TranslationDraftResponseValidationError) {
        expect(error.rule).toBe("type");
        expect(error.path).toBe("drafts[0].draftText");
      }
    }
  });

  it("rejects unknown top-level properties", () => {
    expect(() =>
      assertStructuredTranslationDraftOutput({
        schemaVersion: STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
        drafts: [],
        repairAttempts: 0,
      }),
    ).toThrow(/repairAttempts/);
  });

  it("rejects unknown draft-level properties", () => {
    expect(() =>
      assertStructuredTranslationDraftOutput(
        validOutput({ drafts: [validDraft({ alternateText: "..." })] }),
      ),
    ).toThrow(/alternateText/);
  });

  it("rejects every invalid confidenceFloor", () => {
    expect(() =>
      assertStructuredTranslationDraftOutput(
        validOutput({ drafts: [validDraft({ confidenceFloor: "extreme" })] }),
      ),
    ).toThrow(/confidenceFloor/);
  });

  it("rejects a protectedSpanRef whose end is not strictly greater than start", () => {
    expect(() =>
      assertStructuredTranslationDraftOutput(
        validOutput({
          drafts: [
            validDraft({
              protectedSpanRefs: [{ refId: "span-1", startInDraft: 5, endInDraft: 5 }],
            }),
          ],
        }),
      ),
    ).toThrow(/spanOrder/);
  });

  it("rejects a non-array drafts field", () => {
    expect(() =>
      assertStructuredTranslationDraftOutput({
        schemaVersion: STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
        drafts: "nope",
      }),
    ).toThrow(/drafts/);
  });

  it("parseStructuredTranslationDraftOutput surfaces a JSON parse error as TranslationDraftResponseValidationError", () => {
    expect(() => parseStructuredTranslationDraftOutput("not-json")).toThrow(
      TranslationDraftResponseValidationError,
    );
  });

  it("parseStructuredTranslationDraftOutput refuses trailing commas (no silent repair)", () => {
    // RFC 8259 forbids trailing commas; the strict parser must reject them.
    const raw = `{"schemaVersion":"${STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION}","drafts":[],}`;
    expect(() => parseStructuredTranslationDraftOutput(raw)).toThrow(
      TranslationDraftResponseValidationError,
    );
  });

  it("parseStructuredTranslationDraftOutput round-trips a valid output", () => {
    const raw = JSON.stringify(validOutput());
    const out = parseStructuredTranslationDraftOutput(raw);
    expect(out.schemaVersion).toBe(STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION);
    expect(out.drafts).toHaveLength(1);
    expect(out.drafts[0]!.confidenceFloor).toBe("medium");
    expect(out.drafts[0]!.protectedSpanRefs[0]!.refId).toBe("span-1");
  });

  it("strips echoed JSON-schema metadata and rewrites the known structural typo", () => {
    const parsed = parseStructuredTranslationDraftOutput(
      JSON.stringify({
        $schema: "http://json-schema.org/draft-07/schema#",
        $id: "itotori://fixture",
        title: "StructuredTranslationDraftOutput",
        schemaVersion: "itotori.structural-translation-draft-output.v1",
        drafts: [validDraft()],
      }),
    );
    expect(parsed.schemaVersion).toBe(STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION);
    expect(parsed.drafts).toHaveLength(1);
  });

  it("does not coerce an unknown top-level key or rewrite a citation ref", () => {
    expect(() =>
      parseStructuredTranslationDraftOutput(JSON.stringify({ ...validOutput(), unexpected: true })),
    ).toThrow(/unexpected/);

    const parsed = parseStructuredTranslationDraftOutput(
      JSON.stringify({
        ...validOutput(),
        drafts: [validDraft({ citationRefs: ["terminology-candidate:≬チュートリアル≭"] })],
      }),
    );
    expect(parsed.drafts[0]?.citationRefs).toEqual(["terminology-candidate:≬チュートリアル≭"]);
  });

  it("confidence-floor enum matches the JSON schema constants", () => {
    const confidenceEnum = (
      STRUCTURED_TRANSLATION_DRAFT_OUTPUT_JSON_SCHEMA.properties.drafts.items.properties
        .confidenceFloor as { enum: ReadonlyArray<string> }
    ).enum;
    expect([...confidenceEnum]).toEqual([...TRANSLATION_DRAFT_CONFIDENCE_FLOORS]);
    expect(STRUCTURED_TRANSLATION_DRAFT_OUTPUT_JSON_SCHEMA.properties.drafts.minItems).toBe(1);
  });

  it("schema version constant is pinned to v1 (changes require a wire-contract bump)", () => {
    expect(STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION).toBe(
      "itotori.structured-translation-draft-output.v1",
    );
  });
});
