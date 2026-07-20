// ITOTORI-017 — SpeakerLabelOutput.
//
// Strict JSON contract for what an LLM speaker-labeling role must return. This
// module owns ONLY the wire-shape contract + parser/asserter. Any shape divergence throws a
// typed `SpeakerLabelResponseValidationError` — never a silent fallback.
//
// The shape encodes a four-way distinction:
//   1. `named` — known character with full identity. The reader sees the
//      character's displayName as-is.
//   2. `unknown_to_reader` — the reader does NOT know who this is yet (the
//      character is masked, voice-only, hooded, etc.). The wire shape MAY
//      carry an `internalCharacterId` for cross-line consistency, but that
//      field is PRIVATE and MUST be stripped before any patch-export. The
//      reader-visible identifier is `maskedDisplayName`.
//   3. `unknown_to_parser` — the agent genuinely cannot decide. A `reason`
//      enum makes the ambiguity explicit.
//   4. `narration` — the bridge unit is narration, not dialogue.
//
// The split between (2) and (3) is the load-bearing safety invariant:
// `unknown_to_reader` represents an INTENTIONAL narrative redaction and
// MUST NOT collapse into `named` even if the agent figures out the
// internal identity from neighbouring context. The patch-export boundary must
// reject any resulting identity leak.

export const SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION = "itotori.speaker-label-output.v1" as const;

export const SPEAKER_LABEL_OUTPUT_TOOL_NAME = "itotori-speaker-label-output" as const;

/**
 * Confidence band the agent must self-report. We deliberately use a coarse
 * three-bucket enum rather than a numeric score — providers are
 * inconsistent at calibrating numeric confidence and a coarse enum is
 * easier to test against a confidence floor.
 */
export const SPEAKER_LABEL_CONFIDENCES = ["high", "medium", "low"] as const;
export type SpeakerLabelConfidence = (typeof SPEAKER_LABEL_CONFIDENCES)[number];

/**
 * Closed reason enum that backs `unknown_to_parser`. Distinguishes
 * "I saw nothing" from "I saw conflicting signals" from "this is ambient
 * dialogue with no anchored speaker." Adding a value here requires a
 * prompt-template version bump.
 */
export const SPEAKER_LABEL_UNKNOWN_REASONS = [
  "no_signal",
  "conflicting_signals",
  "ambient_dialogue",
] as const;
export type SpeakerLabelUnknownReason = (typeof SPEAKER_LABEL_UNKNOWN_REASONS)[number];

export const SPEAKER_IDENTITY_KINDS = [
  "named",
  "unknown_to_reader",
  "unknown_to_parser",
  "narration",
] as const;
export type SpeakerIdentityKind = (typeof SPEAKER_IDENTITY_KINDS)[number];

/**
 * Tagged union of speaker identity decisions. Producers MUST emit exactly
 * one of these shapes per label; consumers MUST narrow on `kind` before
 * touching variant-only fields.
 *
 * The `internalCharacterId` on `unknown_to_reader` is INTENTIONALLY
 * separate from `maskedCharacterId` / `maskedDisplayName`. The reader's
 * view of this character only ever uses the masked pair; the internal id
 * lets downstream tools de-duplicate the same hidden speaker across lines
 * without leaking the reveal. The patch-export boundary strips it before any
 * patch payload leaves the system.
 */
export type SpeakerIdentity =
  | {
      kind: "named";
      characterId: string;
      displayName: string;
    }
  | {
      kind: "unknown_to_reader";
      maskedCharacterId: string;
      maskedDisplayName: string;
      /**
       * PRIVATE — never leaks to localization output. Optional, because
       * the agent may genuinely have no internal hypothesis. When set,
       * downstream metadata consumers MAY use this for consistency
       * tracking (e.g. "the masked person in lines 5 and 12 is the same
       * internal character") but MUST NOT surface it to the reader.
       */
      internalCharacterId?: string;
    }
  | {
      kind: "unknown_to_parser";
      reason: SpeakerLabelUnknownReason;
    }
  | {
      kind: "narration";
    };

export type SpeakerLabel = {
  bridgeUnitId: string;
  speakerId: SpeakerIdentity;
  confidence: SpeakerLabelConfidence;
  /** Citations into context artifacts (previous lines, character bios, scene summaries, etc.). */
  evidenceRefs: string[];
  agentRationale: string;
};

export type SpeakerLabelOutput = {
  schemaVersion: typeof SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION;
  labels: SpeakerLabel[];
};

/**
 * Strict JSON Schema (draft-07 compatible) for `SpeakerLabelOutput`.
 * Producers MUST emit this exact shape; consumers MUST validate against
 * it before persisting or exporting. The agent wires this into the model
 * provider's structured-output request so providers that support
 * `json_schema` mode can refuse out-of-shape generations server-side.
 *
 * Note: the `oneOf` discriminator on `speakerId.kind` mirrors the
 * tagged-union TypeScript type. Each branch lists its required fields
 * and forbids additional properties — this is what makes
 * `internalCharacterId` valid ONLY inside `unknown_to_reader`, and only
 * as an opt-in field that the patch-export filter then strips.
 */
export const SPEAKER_LABEL_OUTPUT_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "itotori://localization-bridge-schema/speaker-label-output.v1",
  title: "SpeakerLabelOutput",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "labels"],
  properties: {
    schemaVersion: { const: SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION },
    labels: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["bridgeUnitId", "speakerId", "confidence", "evidenceRefs", "agentRationale"],
        properties: {
          bridgeUnitId: { type: "string", minLength: 1 },
          speakerId: {
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["kind", "characterId", "displayName"],
                properties: {
                  kind: { const: "named" },
                  characterId: { type: "string", minLength: 1 },
                  displayName: { type: "string", minLength: 1 },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["kind", "maskedCharacterId", "maskedDisplayName"],
                properties: {
                  kind: { const: "unknown_to_reader" },
                  maskedCharacterId: { type: "string", minLength: 1 },
                  maskedDisplayName: { type: "string", minLength: 1 },
                  internalCharacterId: { type: "string", minLength: 1 },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["kind", "reason"],
                properties: {
                  kind: { const: "unknown_to_parser" },
                  reason: { enum: [...SPEAKER_LABEL_UNKNOWN_REASONS] },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["kind"],
                properties: {
                  kind: { const: "narration" },
                },
              },
            ],
          },
          confidence: { enum: [...SPEAKER_LABEL_CONFIDENCES] },
          evidenceRefs: {
            type: "array",
            items: { type: "string", minLength: 1 },
          },
          agentRationale: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Validation surface
// ---------------------------------------------------------------------------

/**
 * Field-path keyed error raised on any shape divergence. The agent's
 * invocation seam catches this and wraps it in a typed upstream error that
 * names the provider proof / recorded artifact id. `path` is a
 * JSON-pointer-style field accessor; `rule` names the schema rule that
 * failed.
 */
export class SpeakerLabelResponseValidationError extends Error {
  constructor(
    public readonly path: string,
    public readonly rule: string,
    public readonly detail: string,
  ) {
    super(`SpeakerLabelOutput.${path} failed rule '${rule}': ${detail}`);
    this.name = "SpeakerLabelResponseValidationError";
  }
}

const SPEAKER_LABEL_TOP_LEVEL_JSON_SCHEMA_METADATA_KEYS = new Set(["$schema", "$id", "title"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strip only JSON-schema metadata echoed alongside the payload. Deliberately
 * do not coerce `speakerId.kind`: `unnamed_character` has no unambiguous
 * target, and mapping it would hide a real modeling error from the retry.
 */
function coerceSpeakerLabelOutput(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const normalized: Record<string, unknown> = { ...value };
  for (const key of SPEAKER_LABEL_TOP_LEVEL_JSON_SCHEMA_METADATA_KEYS) {
    delete normalized[key];
  }
  return normalized;
}

/**
 * Validates a parsed JSON value against the SpeakerLabelOutput schema.
 * Throws `SpeakerLabelResponseValidationError` on the first failure.
 * Returns the validated value with the precise type asserted.
 */
export function assertSpeakerLabelOutput(value: unknown): asserts value is SpeakerLabelOutput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SpeakerLabelResponseValidationError("", "type", "expected object");
  }
  const record = value as Record<string, unknown>;
  const allowedTopLevel = new Set(["schemaVersion", "labels"]);
  for (const key of Object.keys(record)) {
    if (!allowedTopLevel.has(key)) {
      throw new SpeakerLabelResponseValidationError(
        key,
        "additionalProperties",
        `unexpected top-level property ${key}`,
      );
    }
  }
  if (record.schemaVersion !== SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION) {
    throw new SpeakerLabelResponseValidationError(
      "schemaVersion",
      "const",
      `expected ${SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION}, got ${String(record.schemaVersion)}`,
    );
  }
  if (!Array.isArray(record.labels)) {
    throw new SpeakerLabelResponseValidationError("labels", "type", "expected array");
  }
  for (const [index, entry] of record.labels.entries()) {
    assertLabel(entry, `labels[${index}]`);
  }
}

function assertLabel(value: unknown, label: string): asserts value is SpeakerLabel {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SpeakerLabelResponseValidationError(label, "type", "expected object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "bridgeUnitId",
    "speakerId",
    "confidence",
    "evidenceRefs",
    "agentRationale",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new SpeakerLabelResponseValidationError(
        `${label}.${key}`,
        "additionalProperties",
        `unexpected property ${key}`,
      );
    }
  }
  assertNonEmptyString(record.bridgeUnitId, `${label}.bridgeUnitId`);
  assertSpeakerIdentity(record.speakerId, `${label}.speakerId`);
  assertEnum(
    record.confidence,
    SPEAKER_LABEL_CONFIDENCES as ReadonlyArray<string>,
    `${label}.confidence`,
  );
  if (!Array.isArray(record.evidenceRefs)) {
    throw new SpeakerLabelResponseValidationError(
      `${label}.evidenceRefs`,
      "type",
      "expected array",
    );
  }
  for (const [index, ref] of record.evidenceRefs.entries()) {
    assertNonEmptyString(ref, `${label}.evidenceRefs[${index}]`);
  }
  assertNonEmptyString(record.agentRationale, `${label}.agentRationale`);
}

function assertSpeakerIdentity(value: unknown, label: string): asserts value is SpeakerIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SpeakerLabelResponseValidationError(label, "type", "expected object");
  }
  const record = value as Record<string, unknown>;
  const kindRaw = record.kind;
  if (typeof kindRaw !== "string") {
    throw new SpeakerLabelResponseValidationError(
      `${label}.kind`,
      "type",
      "expected discriminator string",
    );
  }
  if (!(SPEAKER_IDENTITY_KINDS as ReadonlyArray<string>).includes(kindRaw)) {
    throw new SpeakerLabelResponseValidationError(
      `${label}.kind`,
      "enum",
      `value '${kindRaw}' not in [${SPEAKER_IDENTITY_KINDS.join(", ")}]`,
    );
  }
  const kind = kindRaw as SpeakerIdentityKind;
  switch (kind) {
    case "named": {
      assertOnlyKeys(record, ["kind", "characterId", "displayName"], label);
      assertNonEmptyString(record.characterId, `${label}.characterId`);
      assertNonEmptyString(record.displayName, `${label}.displayName`);
      return;
    }
    case "unknown_to_reader": {
      assertOnlyKeys(
        record,
        ["kind", "maskedCharacterId", "maskedDisplayName", "internalCharacterId"],
        label,
      );
      assertNonEmptyString(record.maskedCharacterId, `${label}.maskedCharacterId`);
      assertNonEmptyString(record.maskedDisplayName, `${label}.maskedDisplayName`);
      if (record.internalCharacterId !== undefined) {
        assertNonEmptyString(record.internalCharacterId, `${label}.internalCharacterId`);
      }
      return;
    }
    case "unknown_to_parser": {
      assertOnlyKeys(record, ["kind", "reason"], label);
      assertEnum(
        record.reason,
        SPEAKER_LABEL_UNKNOWN_REASONS as ReadonlyArray<string>,
        `${label}.reason`,
      );
      return;
    }
    case "narration": {
      assertOnlyKeys(record, ["kind"], label);
      return;
    }
  }
}

function assertOnlyKeys(
  record: Record<string, unknown>,
  allowed: ReadonlyArray<string>,
  label: string,
): void {
  const set = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!set.has(key)) {
      throw new SpeakerLabelResponseValidationError(
        `${label}.${key}`,
        "additionalProperties",
        `unexpected property ${key} for kind=${String(record.kind)}`,
      );
    }
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") {
    throw new SpeakerLabelResponseValidationError(label, "type", "expected string");
  }
  if (value.length === 0) {
    throw new SpeakerLabelResponseValidationError(label, "minLength", "must be non-empty");
  }
}

function assertEnum(
  value: unknown,
  allowed: ReadonlyArray<string>,
  label: string,
): asserts value is string {
  if (typeof value !== "string") {
    throw new SpeakerLabelResponseValidationError(label, "type", "expected string");
  }
  if (!allowed.includes(value)) {
    throw new SpeakerLabelResponseValidationError(
      label,
      "enum",
      `value '${value}' not in [${allowed.join(", ")}]`,
    );
  }
}

/**
 * Parse a raw provider response (string) into a validated
 * `SpeakerLabelOutput`. Wraps JSON parse failures into
 * `SpeakerLabelResponseValidationError` so callers never see a raw
 * `SyntaxError`.
 */
export function parseSpeakerLabelOutput(raw: string): SpeakerLabelOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // Intentional: malformed JSON is exactly what the corrective re-ask recovers.
    throw new SpeakerLabelResponseValidationError(
      "",
      "json",
      `provider response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const coerced = coerceSpeakerLabelOutput(parsed);
  assertSpeakerLabelOutput(coerced);
  return coerced;
}
