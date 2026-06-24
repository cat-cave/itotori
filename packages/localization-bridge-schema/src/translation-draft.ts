// ITOTORI-075 — StructuredTranslationDraftOutput.
//
// Strict JSON contract for what an LLM translation agent must return.
// The agent is driven by `TranslationAgent.invokeTranslation`
// (apps/itotori/src/agents/translation); this module owns ONLY the
// wire-shape contract + assertion. No silent fallbacks: any shape
// divergence throws a typed `TranslationDraftResponseValidationError`.
//
// Persistence of accepted drafts is the responsibility of downstream
// nodes — ITOTORI-074 lands the `draft_jobs` table and ITOTORI-076 will
// thread the drafts into it. This module ships the wire schema and a
// pure-TS draft shape so producers and consumers can agree before the
// table is fully wired.

import type { Uuid7 } from "./index.js";

export const STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION =
  "itotori.structured-translation-draft-output.v1" as const;

export const STRUCTURED_TRANSLATION_DRAFT_OUTPUT_TOOL_NAME =
  "itotori-structured-translation-draft-output" as const;

/**
 * Closed enum for the agent's self-reported confidence floor.
 *
 * The taxonomy is intentionally narrow — three buckets that downstream
 * triage policy can branch on. We do NOT accept a numeric confidence
 * score: the agent registry's no-confidence rule (see
 * `assertNoConfidenceFields` in apps/itotori/src/agents/registry.ts)
 * forbids `confidence`-named fields, and a floor expressed as an enum
 * keeps the contract self-describing.
 */
export const TRANSLATION_DRAFT_CONFIDENCE_FLOORS = ["low", "medium", "high"] as const;
export type TranslationDraftConfidenceFloor = (typeof TRANSLATION_DRAFT_CONFIDENCE_FLOORS)[number];

/**
 * A reference back into a source unit's protected span, with the
 * span's location remapped into the agent's draft target text.
 *
 * Every protected span on the input MUST appear here for the
 * corresponding draft. The agent invocation service performs a
 * deeper resolution check (range bounds, ordering, overlap,
 * preservation policy) against the typed `TranslationProtectedSpanViolationError`.
 */
export type ProtectedSpanRef = {
  /** The span id ascribed by the caller; opaque to the schema. */
  refId: string;
  /** Inclusive start offset (Unicode code-unit / `string.length` semantics) into `draftText`. */
  startInDraft: number;
  /** Exclusive end offset (Unicode code-unit / `string.length` semantics) into `draftText`. */
  endInDraft: number;
};

export type TranslationDraft = {
  bridgeUnitId: Uuid7;
  sourceLocale: string;
  targetLocale: string;
  draftText: string;
  protectedSpanRefs: ProtectedSpanRef[];
  citationRefs: string[];
  agentRationale: string;
  confidenceFloor: TranslationDraftConfidenceFloor;
};

export type StructuredTranslationDraftOutput = {
  schemaVersion: typeof STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION;
  drafts: TranslationDraft[];
};

/**
 * Strict JSON Schema (draft-07 compatible) for
 * `StructuredTranslationDraftOutput`. Producers MUST emit this exact
 * shape; consumers MUST validate against this schema before persisting.
 * The schema is also wired into the model provider's structured-output
 * request so providers that support `json_schema` mode can refuse
 * out-of-shape generations server-side.
 */
export const STRUCTURED_TRANSLATION_DRAFT_OUTPUT_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "itotori://localization-bridge-schema/structured-translation-draft-output.v1",
  title: "StructuredTranslationDraftOutput",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "drafts"],
  properties: {
    schemaVersion: { const: STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION },
    drafts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "bridgeUnitId",
          "sourceLocale",
          "targetLocale",
          "draftText",
          "protectedSpanRefs",
          "citationRefs",
          "agentRationale",
          "confidenceFloor",
        ],
        properties: {
          bridgeUnitId: { type: "string", minLength: 1 },
          sourceLocale: { type: "string", minLength: 1 },
          targetLocale: { type: "string", minLength: 1 },
          draftText: { type: "string" },
          protectedSpanRefs: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["refId", "startInDraft", "endInDraft"],
              properties: {
                refId: { type: "string", minLength: 1 },
                startInDraft: { type: "integer", minimum: 0 },
                endInDraft: { type: "integer", minimum: 0 },
              },
            },
          },
          citationRefs: {
            type: "array",
            items: { type: "string", minLength: 1 },
          },
          agentRationale: { type: "string", minLength: 1 },
          confidenceFloor: { enum: [...TRANSLATION_DRAFT_CONFIDENCE_FLOORS] },
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Validation surface
// ---------------------------------------------------------------------------

/**
 * Field-path keyed error raised on any shape divergence. The
 * translation invocation service catches this and wraps it in a
 * typed upstream error that names the provider proof / recorded
 * artifact id + draft job attempt id (per ITOTORI-075's diagnostic
 * contract).
 *
 * `path` is a JSON-pointer-style field accessor relative to
 * `StructuredTranslationDraftOutput`.
 */
export class TranslationDraftResponseValidationError extends Error {
  constructor(
    public readonly path: string,
    public readonly rule: string,
    public readonly detail: string,
  ) {
    super(`StructuredTranslationDraftOutput.${path} failed rule '${rule}': ${detail}`);
    this.name = "TranslationDraftResponseValidationError";
  }
}

/**
 * Validates a parsed JSON value against the
 * `StructuredTranslationDraftOutput` schema. Throws
 * `TranslationDraftResponseValidationError` on the first failure.
 * Returns the validated value with the precise type asserted.
 */
export function assertStructuredTranslationDraftOutput(
  value: unknown,
): asserts value is StructuredTranslationDraftOutput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TranslationDraftResponseValidationError("", "type", "expected object");
  }
  const record = value as Record<string, unknown>;
  const allowedTopLevel = new Set(["schemaVersion", "drafts"]);
  for (const key of Object.keys(record)) {
    if (!allowedTopLevel.has(key)) {
      throw new TranslationDraftResponseValidationError(
        key,
        "additionalProperties",
        `unexpected top-level property ${key}`,
      );
    }
  }
  if (record.schemaVersion !== STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION) {
    throw new TranslationDraftResponseValidationError(
      "schemaVersion",
      "const",
      `expected ${STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION}, got ${String(record.schemaVersion)}`,
    );
  }
  if (!Array.isArray(record.drafts)) {
    throw new TranslationDraftResponseValidationError("drafts", "type", "expected array");
  }
  for (const [index, entry] of record.drafts.entries()) {
    assertDraft(entry, `drafts[${index}]`);
  }
}

function assertDraft(value: unknown, label: string): asserts value is TranslationDraft {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TranslationDraftResponseValidationError(label, "type", "expected object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "bridgeUnitId",
    "sourceLocale",
    "targetLocale",
    "draftText",
    "protectedSpanRefs",
    "citationRefs",
    "agentRationale",
    "confidenceFloor",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new TranslationDraftResponseValidationError(
        `${label}.${key}`,
        "additionalProperties",
        `unexpected property ${key}`,
      );
    }
  }
  assertNonEmptyString(record.bridgeUnitId, `${label}.bridgeUnitId`);
  assertNonEmptyString(record.sourceLocale, `${label}.sourceLocale`);
  assertNonEmptyString(record.targetLocale, `${label}.targetLocale`);
  // draftText may be empty (the model can decide to emit an empty
  // target string for an info-only protected-span pass-through); we
  // therefore require `string` but not `minLength: 1`.
  if (typeof record.draftText !== "string") {
    throw new TranslationDraftResponseValidationError(
      `${label}.draftText`,
      "type",
      "expected string",
    );
  }
  if (!Array.isArray(record.protectedSpanRefs)) {
    throw new TranslationDraftResponseValidationError(
      `${label}.protectedSpanRefs`,
      "type",
      "expected array",
    );
  }
  for (const [index, ref] of record.protectedSpanRefs.entries()) {
    assertProtectedSpanRef(ref, `${label}.protectedSpanRefs[${index}]`);
  }
  if (!Array.isArray(record.citationRefs)) {
    throw new TranslationDraftResponseValidationError(
      `${label}.citationRefs`,
      "type",
      "expected array",
    );
  }
  for (const [index, ref] of record.citationRefs.entries()) {
    assertNonEmptyString(ref, `${label}.citationRefs[${index}]`);
  }
  assertNonEmptyString(record.agentRationale, `${label}.agentRationale`);
  assertEnum(
    record.confidenceFloor,
    TRANSLATION_DRAFT_CONFIDENCE_FLOORS as ReadonlyArray<string>,
    `${label}.confidenceFloor`,
  );
}

function assertProtectedSpanRef(value: unknown, label: string): asserts value is ProtectedSpanRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TranslationDraftResponseValidationError(label, "type", "expected object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["refId", "startInDraft", "endInDraft"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new TranslationDraftResponseValidationError(
        `${label}.${key}`,
        "additionalProperties",
        `unexpected property ${key}`,
      );
    }
  }
  assertNonEmptyString(record.refId, `${label}.refId`);
  assertNonNegativeInteger(record.startInDraft, `${label}.startInDraft`);
  assertNonNegativeInteger(record.endInDraft, `${label}.endInDraft`);
  if ((record.endInDraft as number) <= (record.startInDraft as number)) {
    throw new TranslationDraftResponseValidationError(
      label,
      "spanOrder",
      `endInDraft ${String(record.endInDraft)} must be greater than startInDraft ${String(record.startInDraft)}`,
    );
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") {
    throw new TranslationDraftResponseValidationError(label, "type", "expected string");
  }
  if (value.length === 0) {
    throw new TranslationDraftResponseValidationError(label, "minLength", "must be non-empty");
  }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TranslationDraftResponseValidationError(label, "type", "expected integer");
  }
  if (value < 0) {
    throw new TranslationDraftResponseValidationError(label, "minimum", "must be >= 0");
  }
}

function assertEnum(
  value: unknown,
  allowed: ReadonlyArray<string>,
  label: string,
): asserts value is string {
  if (typeof value !== "string") {
    throw new TranslationDraftResponseValidationError(label, "type", "expected string");
  }
  if (!allowed.includes(value)) {
    throw new TranslationDraftResponseValidationError(
      label,
      "enum",
      `value '${value}' not in [${allowed.join(", ")}]`,
    );
  }
}

/**
 * Parse a raw provider response (string) into a validated
 * `StructuredTranslationDraftOutput`. Wraps JSON parse failures into
 * `TranslationDraftResponseValidationError` so callers never see a
 * raw `SyntaxError`. The parser is strict: trailing commas, comments,
 * and other non-RFC-8259 extensions are rejected (no silent repair).
 */
export function parseStructuredTranslationDraftOutput(
  raw: string,
): StructuredTranslationDraftOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TranslationDraftResponseValidationError(
      "",
      "json",
      `provider response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertStructuredTranslationDraftOutput(parsed);
  return parsed;
}
