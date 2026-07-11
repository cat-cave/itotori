// ITOTORI-078 — StructuredQaFindingOutput.
//
// Strict JSON contract for what an LLM QA agent must return. The agent is
// driven by `QaAgent.invokeQa` (apps/itotori/src/agents/qa); this module
// owns ONLY the wire-shape contract + assertion. No silent fallbacks: any
// shape divergence throws a typed `QaResponseValidationError`.
//
// Persistence of QA findings (the `qa_findings` table + draft-job FK) is
// the responsibility of a follow-up node — ITOTORI-074 lands the
// `draft_jobs` table in parallel. This module ships the wire schema and a
// pure-TS finding shape so producers and consumers can agree before the
// table exists.

import type { Uuid7 } from "./index.js";

export const STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION =
  "itotori.structured-qa-finding-output.v1" as const;

export const STRUCTURED_QA_FINDING_OUTPUT_TOOL_NAME =
  "itotori-structured-qa-finding-output" as const;

/**
 * Severity taxonomy the QA agent MUST use. Mirrors the localization quality
 * severities in the main module but kept narrow on purpose: `info` is
 * permitted for diagnostic surfacing whereas the LQA taxonomy reserves
 * `neutral`. Adding a value here requires a prompt-template version bump.
 */
export const QA_FINDING_SEVERITIES = ["critical", "major", "minor", "info"] as const;
export type QaFindingSeverity = (typeof QA_FINDING_SEVERITIES)[number];

/**
 * Closed-enum category list. New categories require a prompt-template
 * version bump AND a downstream-consumer migration; the strict assertion
 * below rejects any unknown value.
 */
export const QA_FINDING_CATEGORIES = [
  "mistranslation",
  "tone",
  "glossary-conflict",
  "protected-span-violation",
  "terminology-drift",
  "redaction",
  "context-mismatch",
  "other",
] as const;
export type QaFindingCategory = (typeof QA_FINDING_CATEGORIES)[number];

/**
 * Character-offset span inside either the source unit text or the draft
 * target text. The QA agent is responsible for using the same offset model
 * as the input it was given (Unicode code-unit offsets — JavaScript
 * `string.length` semantics).
 */
export type QaFindingSpan = {
  start: number;
  end: number;
};

export type QaFinding = {
  findingId: Uuid7;
  bridgeUnitId: Uuid7;
  severity: QaFindingSeverity;
  category: QaFindingCategory;
  sourceSpan?: QaFindingSpan;
  draftSpan?: QaFindingSpan;
  evidenceRefs: string[];
  recommendation: string;
  agentRationale: string;
};

export type StructuredQaFindingOutput = {
  schemaVersion: typeof STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION;
  findings: QaFinding[];
};

/**
 * Strict JSON Schema (draft-07 compatible) for `StructuredQaFindingOutput`.
 * Producers MUST emit this exact shape; consumers MUST validate against
 * this schema before persisting. The schema is also wired into the model
 * provider's structured-output request so providers that support
 * `json_schema` mode can refuse out-of-shape generations server-side.
 */
export const STRUCTURED_QA_FINDING_OUTPUT_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "itotori://localization-bridge-schema/structured-qa-finding-output.v1",
  title: "StructuredQaFindingOutput",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "findings"],
  properties: {
    schemaVersion: { const: STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "findingId",
          "bridgeUnitId",
          "severity",
          "category",
          "evidenceRefs",
          "recommendation",
          "agentRationale",
        ],
        properties: {
          findingId: { type: "string", minLength: 1 },
          bridgeUnitId: { type: "string", minLength: 1 },
          severity: { enum: [...QA_FINDING_SEVERITIES] },
          category: { enum: [...QA_FINDING_CATEGORIES] },
          sourceSpan: {
            type: "object",
            additionalProperties: false,
            required: ["start", "end"],
            properties: {
              start: { type: "integer", minimum: 0 },
              end: { type: "integer", minimum: 0 },
            },
          },
          draftSpan: {
            type: "object",
            additionalProperties: false,
            required: ["start", "end"],
            properties: {
              start: { type: "integer", minimum: 0 },
              end: { type: "integer", minimum: 0 },
            },
          },
          evidenceRefs: {
            type: "array",
            items: { type: "string", minLength: 1 },
          },
          recommendation: { type: "string", minLength: 1 },
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
 * Field-path keyed error raised on any shape divergence. The QA invocation
 * service catches `QaResponseValidationError` and wraps it in a typed
 * upstream error that names the provider proof / recorded artifact id.
 * `path` is a JSON-pointer-style field accessor.
 */
export class QaResponseValidationError extends Error {
  constructor(
    public readonly path: string,
    public readonly rule: string,
    public readonly detail: string,
  ) {
    super(`StructuredQaFindingOutput.${path} failed rule '${rule}': ${detail}`);
    this.name = "QaResponseValidationError";
  }
}

const QA_TOP_LEVEL_JSON_SCHEMA_METADATA_KEYS = new Set(["$schema", "$id", "title"]);
const QA_SCHEMA_VERSION_COERCIONS: Record<string, string> = {
  "itotori.structural-qa-finding-output.v1": STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Normalize only provider echoes that are unambiguous and payload-neutral.
 * A two-integer span array has one obvious object representation; strings and
 * numbers do not, so they deliberately remain strict validation failures.
 */
function coerceStructuredQaFindingOutput(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  const normalized: Record<string, unknown> = { ...value };
  for (const key of QA_TOP_LEVEL_JSON_SCHEMA_METADATA_KEYS) {
    delete normalized[key];
  }

  if (
    typeof normalized.schemaVersion === "string" &&
    Object.prototype.hasOwnProperty.call(QA_SCHEMA_VERSION_COERCIONS, normalized.schemaVersion)
  ) {
    normalized.schemaVersion = QA_SCHEMA_VERSION_COERCIONS[normalized.schemaVersion];
  }

  if (Array.isArray(normalized.findings)) {
    normalized.findings = normalized.findings.map((entry) => {
      if (!isRecord(entry)) {
        return entry;
      }
      const finding: Record<string, unknown> = { ...entry };
      for (const field of ["sourceSpan", "draftSpan"] as const) {
        const span = finding[field];
        if (!Array.isArray(span) || span.length !== 2) {
          continue;
        }
        const [start, end] = span;
        if (isNonNegativeInteger(start) && isNonNegativeInteger(end)) {
          finding[field] = { start, end };
        }
      }
      return finding;
    });
  }

  return normalized;
}

/**
 * Validates a parsed JSON value against the StructuredQaFindingOutput
 * schema. Throws `QaResponseValidationError` on the first failure. Returns
 * the validated value with the precise type asserted.
 */
export function assertStructuredQaFindingOutput(
  value: unknown,
): asserts value is StructuredQaFindingOutput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new QaResponseValidationError("", "type", "expected object");
  }
  const record = value as Record<string, unknown>;
  const allowedTopLevel = new Set(["schemaVersion", "findings"]);
  for (const key of Object.keys(record)) {
    if (!allowedTopLevel.has(key)) {
      throw new QaResponseValidationError(
        key,
        "additionalProperties",
        `unexpected top-level property ${key}`,
      );
    }
  }
  if (record.schemaVersion !== STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION) {
    throw new QaResponseValidationError(
      "schemaVersion",
      "const",
      `expected ${STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION}, got ${String(record.schemaVersion)}`,
    );
  }
  if (!Array.isArray(record.findings)) {
    throw new QaResponseValidationError("findings", "type", "expected array");
  }
  for (const [index, entry] of record.findings.entries()) {
    assertFinding(entry, `findings[${index}]`);
  }
}

function assertFinding(value: unknown, label: string): asserts value is QaFinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new QaResponseValidationError(label, "type", "expected object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "findingId",
    "bridgeUnitId",
    "severity",
    "category",
    "sourceSpan",
    "draftSpan",
    "evidenceRefs",
    "recommendation",
    "agentRationale",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new QaResponseValidationError(
        `${label}.${key}`,
        "additionalProperties",
        `unexpected property ${key}`,
      );
    }
  }
  assertNonEmptyString(record.findingId, `${label}.findingId`);
  assertNonEmptyString(record.bridgeUnitId, `${label}.bridgeUnitId`);
  assertEnum(record.severity, QA_FINDING_SEVERITIES as ReadonlyArray<string>, `${label}.severity`);
  assertEnum(record.category, QA_FINDING_CATEGORIES as ReadonlyArray<string>, `${label}.category`);
  if (record.sourceSpan !== undefined) {
    assertSpan(record.sourceSpan, `${label}.sourceSpan`);
  }
  if (record.draftSpan !== undefined) {
    assertSpan(record.draftSpan, `${label}.draftSpan`);
  }
  if (!Array.isArray(record.evidenceRefs)) {
    throw new QaResponseValidationError(`${label}.evidenceRefs`, "type", "expected array");
  }
  for (const [index, ref] of record.evidenceRefs.entries()) {
    assertNonEmptyString(ref, `${label}.evidenceRefs[${index}]`);
  }
  assertNonEmptyString(record.recommendation, `${label}.recommendation`);
  assertNonEmptyString(record.agentRationale, `${label}.agentRationale`);
}

function assertSpan(value: unknown, label: string): asserts value is QaFindingSpan {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new QaResponseValidationError(label, "type", "expected object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["start", "end"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new QaResponseValidationError(
        `${label}.${key}`,
        "additionalProperties",
        `unexpected property ${key}`,
      );
    }
  }
  assertNonNegativeInteger(record.start, `${label}.start`);
  assertNonNegativeInteger(record.end, `${label}.end`);
  if ((record.end as number) < (record.start as number)) {
    throw new QaResponseValidationError(
      label,
      "spanOrder",
      `end ${String(record.end)} must be >= start ${String(record.start)}`,
    );
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") {
    throw new QaResponseValidationError(label, "type", "expected string");
  }
  if (value.length === 0) {
    throw new QaResponseValidationError(label, "minLength", "must be non-empty");
  }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new QaResponseValidationError(label, "type", "expected integer");
  }
  if (value < 0) {
    throw new QaResponseValidationError(label, "minimum", "must be >= 0");
  }
}

function assertEnum(
  value: unknown,
  allowed: ReadonlyArray<string>,
  label: string,
): asserts value is string {
  if (typeof value !== "string") {
    throw new QaResponseValidationError(label, "type", "expected string");
  }
  if (!allowed.includes(value)) {
    throw new QaResponseValidationError(
      label,
      "enum",
      `value '${value}' not in [${allowed.join(", ")}]`,
    );
  }
}

/**
 * Parse a raw provider response (string) into a validated
 * `StructuredQaFindingOutput`. Wraps JSON parse failures into
 * `QaResponseValidationError` so callers never see a raw `SyntaxError`.
 */
export function parseStructuredQaFindingOutput(raw: string): StructuredQaFindingOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new QaResponseValidationError(
      "",
      "json",
      `provider response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const coerced = coerceStructuredQaFindingOutput(parsed);
  assertStructuredQaFindingOutput(coerced);
  return coerced;
}
