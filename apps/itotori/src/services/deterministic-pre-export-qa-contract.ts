import {
  EVIDENCE_KINDS,
  FINDING_KINDS,
  LOCALIZATION_QUALITY_CATEGORIES,
  PROVENANCE_KINDS,
  TRIAGE_SEVERITIES,
  TRIAGE_SUBJECT_KINDS,
} from "@itotori/localization-bridge-schema";
import type {
  FindingRecordV02,
  LocalizationQualityCategoryV02,
} from "@itotori/localization-bridge-schema";

/**
 * Closed enumeration of the deterministic pre-export QA check codes. Kept as a
 * runtime `const` (not merely a TS union) so the registry output schema and the
 * boundary validator can reject any unknown check code fail-closed. Adding a
 * check requires bumping {@link CHECK_VERSION}.
 */
export const DETERMINISTIC_PRE_EXPORT_QA_CHECK_CODES = [
  "protected-span-missing",
  "empty-translation",
  "charset-invalid",
  "line-length-exceeded",
  "punctuation-missing",
  "glossary-exact-mismatch",
] as const;

export type DeterministicPreExportQaCheckCode =
  (typeof DETERMINISTIC_PRE_EXPORT_QA_CHECK_CODES)[number];

export type DeterministicPreExportQaFailure = {
  checkCode: DeterministicPreExportQaCheckCode;
  unitId: string;
  sourceUnitKey: string;
  sourceText: string;
  targetText: string;
  message: string;
  expected: string;
  observed: string;
  repairHint: string;
  findingKind: FindingRecordV02["findingKind"];
  qualityCategory: LocalizationQualityCategoryV02;
  severity: FindingRecordV02["severity"];
};

// ---------------------------------------------------------------------------
// Registry-tool output contract (policy)
//
// The deterministic pre-export QA registry tool result was previously typed at
// the tool boundary as `{ failures: object[]; findings: object[] }` — arbitrary
// object array items. A malformed finding (bad/missing unit ref, unknown check
// code, arbitrary shape) passed the boundary silently. The validator below
// contract-validates every emitted finding fail-closed: exact unit reference,
// known check code, structured evidence, and a structured repair hint. It is
// wired into the tool `run` and mirrors the strict JSON schema enforced at the
// execution boundary.
// ---------------------------------------------------------------------------

export type DeterministicPreExportQaToolOutput = {
  outputKind: "deterministic_pre_export_qa";
  failures: DeterministicPreExportQaFailure[];
  findings: FindingRecordV02[];
};

/**
 * Field-path keyed rejection raised when the deterministic pre-export QA
 * registry output diverges from its contract. `path` is a JSON-pointer-style
 * accessor that names the offending finding/field so callers branch on a named
 * failure rather than parsing prose. Mirrors the {@link QaResponseValidationError}
 * convention in `@itotori/localization-bridge-schema`.
 */
export class DeterministicPreExportQaOutputValidationError extends Error {
  constructor(
    readonly path: string,
    readonly rule: string,
    readonly detail: string,
  ) {
    super(`DeterministicPreExportQaOutput.${path || "<root>"} failed rule '${rule}': ${detail}`);
    this.name = "DeterministicPreExportQaOutputValidationError";
  }
}

/**
 * Validates a deterministic pre-export QA registry tool result against its
 * structured contract, throwing {@link DeterministicPreExportQaOutputValidationError}
 * on the first divergence. Rejects an arbitrary object array item, a finding
 * with a malformed/missing unit reference, and an unknown check code — always
 * with a diagnostic that names the offending item/field.
 */
export function assertDeterministicPreExportQaOutput(
  value: unknown,
): asserts value is DeterministicPreExportQaToolOutput {
  const record = asQaObject(value, "");
  const allowedTopLevel = new Set(["outputKind", "failures", "findings"]);
  for (const key of Object.keys(record)) {
    if (!allowedTopLevel.has(key)) {
      throw new DeterministicPreExportQaOutputValidationError(
        key,
        "additionalProperties",
        `unexpected top-level property ${key}`,
      );
    }
  }
  if (record.outputKind !== "deterministic_pre_export_qa") {
    throw new DeterministicPreExportQaOutputValidationError(
      "outputKind",
      "const",
      `expected 'deterministic_pre_export_qa', got ${JSON.stringify(record.outputKind)}`,
    );
  }
  if (!Array.isArray(record.failures)) {
    throw new DeterministicPreExportQaOutputValidationError("failures", "type", "expected array");
  }
  for (const [index, entry] of record.failures.entries()) {
    assertDeterministicPreExportQaFinding(entry, `failures[${index}]`);
  }
  if (!Array.isArray(record.findings)) {
    throw new DeterministicPreExportQaOutputValidationError("findings", "type", "expected array");
  }
  for (const [index, entry] of record.findings.entries()) {
    assertDeterministicQaFindingRecord(entry, `findings[${index}]`);
  }
}

/**
 * Contract-validates a single emitted QA finding (the `failures` item shape):
 * exact unit reference (`unitId` + `sourceUnitKey`), a known check code,
 * structured evidence (`message`/`expected`/`observed`), and a structured
 * repair hint. Rejects arbitrary object array items and unknown enum values.
 */
export function assertDeterministicPreExportQaFinding(
  value: unknown,
  label: string,
): asserts value is DeterministicPreExportQaFailure {
  const record = asQaObject(value, label);
  const allowed = new Set([
    "checkCode",
    "unitId",
    "sourceUnitKey",
    "sourceText",
    "targetText",
    "message",
    "expected",
    "observed",
    "repairHint",
    "findingKind",
    "qualityCategory",
    "severity",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new DeterministicPreExportQaOutputValidationError(
        `${label}.${key}`,
        "additionalProperties",
        `unexpected property ${key}`,
      );
    }
  }
  // Check code — reject any unknown code fail-closed.
  assertQaEnum(record.checkCode, DETERMINISTIC_PRE_EXPORT_QA_CHECK_CODES, `${label}.checkCode`);
  // Exact unit reference.
  assertQaNonEmptyString(record.unitId, `${label}.unitId`);
  assertQaNonEmptyString(record.sourceUnitKey, `${label}.sourceUnitKey`);
  assertQaString(record.sourceText, `${label}.sourceText`);
  assertQaString(record.targetText, `${label}.targetText`);
  // Structured evidence.
  assertQaNonEmptyString(record.message, `${label}.message`);
  assertQaString(record.expected, `${label}.expected`);
  assertQaString(record.observed, `${label}.observed`);
  // Structured repair hint.
  assertQaNonEmptyString(record.repairHint, `${label}.repairHint`);
  // Finding classification enums.
  assertQaEnum(record.findingKind, FINDING_KINDS, `${label}.findingKind`);
  assertQaEnum(record.qualityCategory, LOCALIZATION_QUALITY_CATEGORIES, `${label}.qualityCategory`);
  assertQaEnum(record.severity, TRIAGE_SEVERITIES, `${label}.severity`);
}

/**
 * Structurally validates a derived {@link FindingRecordV02} emitted by the QA
 * tool. Deliberately does NOT enforce UUID7 shape (the tool derives ids from
 * project/unit keys), but requires the structured contract fields — findingId,
 * enum-classified kind/severity/category, a non-empty affected unit reference,
 * and structured evidence — so an arbitrary object array item is rejected.
 */
function assertDeterministicQaFindingRecord(
  value: unknown,
  label: string,
): asserts value is FindingRecordV02 {
  const record = asQaObject(value, label);
  assertQaNonEmptyString(record.findingId, `${label}.findingId`);
  assertQaEnum(record.findingKind, FINDING_KINDS, `${label}.findingKind`);
  assertQaEnum(record.severity, TRIAGE_SEVERITIES, `${label}.severity`);
  assertQaEnum(record.qualityCategory, LOCALIZATION_QUALITY_CATEGORIES, `${label}.qualityCategory`);
  assertQaNonEmptyString(record.title, `${label}.title`);
  assertQaNonEmptyString(record.description, `${label}.description`);
  assertQaNonEmptyString(record.impact, `${label}.impact`);
  assertQaNonEmptyString(record.createdAt, `${label}.createdAt`);
  if (!Array.isArray(record.affectedRefs) || record.affectedRefs.length === 0) {
    throw new DeterministicPreExportQaOutputValidationError(
      `${label}.affectedRefs`,
      "minItems",
      "expected at least one affected unit reference",
    );
  }
  for (const [index, ref] of record.affectedRefs.entries()) {
    const refRecord = asQaObject(ref, `${label}.affectedRefs[${index}]`);
    assertQaEnum(
      refRecord.subjectKind,
      TRIAGE_SUBJECT_KINDS,
      `${label}.affectedRefs[${index}].subjectKind`,
    );
    assertQaNonEmptyString(refRecord.subjectId, `${label}.affectedRefs[${index}].subjectId`);
  }
  if (!Array.isArray(record.evidence) || record.evidence.length === 0) {
    throw new DeterministicPreExportQaOutputValidationError(
      `${label}.evidence`,
      "minItems",
      "expected at least one evidence record",
    );
  }
  for (const [index, evidence] of record.evidence.entries()) {
    const evidenceRecord = asQaObject(evidence, `${label}.evidence[${index}]`);
    assertQaNonEmptyString(evidenceRecord.evidenceId, `${label}.evidence[${index}].evidenceId`);
    assertQaEnum(
      evidenceRecord.evidenceKind,
      EVIDENCE_KINDS,
      `${label}.evidence[${index}].evidenceKind`,
    );
    assertQaNonEmptyString(evidenceRecord.summary, `${label}.evidence[${index}].summary`);
  }
  if (!Array.isArray(record.provenance) || record.provenance.length === 0) {
    throw new DeterministicPreExportQaOutputValidationError(
      `${label}.provenance`,
      "minItems",
      "expected at least one provenance record",
    );
  }
  for (const [index, provenance] of record.provenance.entries()) {
    const provenanceRecord = asQaObject(provenance, `${label}.provenance[${index}]`);
    assertQaEnum(
      provenanceRecord.provenanceKind,
      PROVENANCE_KINDS,
      `${label}.provenance[${index}].provenanceKind`,
    );
  }
  if (!Array.isArray(record.causalLinks)) {
    throw new DeterministicPreExportQaOutputValidationError(
      `${label}.causalLinks`,
      "type",
      "expected array",
    );
  }
}

function asQaObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DeterministicPreExportQaOutputValidationError(
      label,
      "type",
      "expected a QA finding object, not an arbitrary array item",
    );
  }
  return value as Record<string, unknown>;
}

function assertQaString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") {
    throw new DeterministicPreExportQaOutputValidationError(label, "type", "expected string");
  }
}

function assertQaNonEmptyString(value: unknown, label: string): asserts value is string {
  assertQaString(value, label);
  if (value.length === 0) {
    throw new DeterministicPreExportQaOutputValidationError(
      label,
      "minLength",
      "must be a non-empty string",
    );
  }
}

function assertQaEnum(
  value: unknown,
  allowed: readonly string[],
  label: string,
): asserts value is string {
  if (typeof value !== "string") {
    throw new DeterministicPreExportQaOutputValidationError(label, "type", "expected string");
  }
  if (!allowed.includes(value)) {
    throw new DeterministicPreExportQaOutputValidationError(
      label,
      "enum",
      `value ${JSON.stringify(value)} not in [${allowed.join(", ")}]`,
    );
  }
}
