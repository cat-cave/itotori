import { createHash } from "node:crypto";
import {
  EVIDENCE_KINDS,
  FINDING_KINDS,
  LOCALIZATION_QUALITY_CATEGORIES,
  PROVENANCE_KINDS,
  TRIAGE_SEVERITIES,
  TRIAGE_SUBJECT_KINDS,
} from "@itotori/localization-bridge-schema";
import type {
  BridgeBundle,
  BridgeBundleV02,
  BridgeUnit,
  FindingRecordV02,
  LocalizationQualityCategoryV02,
  LocalizationUnitV02,
} from "@itotori/localization-bridge-schema";
import type { ProjectState } from "./project-types.js";
import {
  countProtectedSpanOccurrences,
  missingRequiredProtectedSpanOccurrences,
} from "./protected-span-occurrences.js";

const CHECK_VERSION = "itotori-020.1";
const CREATED_AT = "2026-06-19T00:00:00.000Z";

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

export class DeterministicPreExportQaError extends Error {
  constructor(readonly failures: DeterministicPreExportQaFailure[]) {
    super(deterministicQaErrorMessage(failures));
    this.name = "DeterministicPreExportQaError";
  }
}

export function runDeterministicPreExportQa(project: ProjectState): {
  failures: DeterministicPreExportQaFailure[];
  findings: FindingRecordV02[];
} {
  const glossaryTerms = glossaryTermsForProject(project);
  const failures = unitsForBridge(project.bridge).flatMap((unit) => {
    const targetText = project.drafts[unit.bridgeUnitId];
    const unitFailures: DeterministicPreExportQaFailure[] = [];
    if (targetText === undefined) {
      unitFailures.push(
        failure(unit, "", "empty-translation", {
          message: "No target draft exists for this unit.",
          expected: "non-empty target draft",
          observed: "missing draft",
          repairHint: `Draft ${unit.sourceUnitKey} before exporting the patch.`,
          findingKind: "model_output_issue",
          qualityCategory: "technical_integrity",
          severity: "P1",
        }),
      );
      return unitFailures;
    }

    if (targetText.trim().length === 0) {
      unitFailures.push(
        failure(unit, targetText, "empty-translation", {
          message: "The target draft is empty or whitespace only.",
          expected: "non-empty target text",
          observed: JSON.stringify(targetText),
          repairHint: `Replace the empty target for ${unit.sourceUnitKey} with a real translation.`,
          findingKind: "model_output_issue",
          qualityCategory: "accuracy",
          severity: "P1",
        }),
      );
    }

    const requiredProtectedSpans = protectedSpanRaws(unit);
    for (const spanRaw of missingRequiredProtectedSpanOccurrences(
      requiredProtectedSpans,
      targetText,
    )) {
      const requiredCount = requiredProtectedSpans.filter((raw) => raw === spanRaw).length;
      const observedCount = countProtectedSpanOccurrences(targetText, spanRaw);
      const occurrenceNote =
        requiredCount > 1
          ? ` The target contains ${observedCount} occurrence(s), but ${requiredCount} are required.`
          : "";
      unitFailures.push(
        failure(unit, targetText, "protected-span-missing", {
          message: `The target draft does not contain protected span ${JSON.stringify(spanRaw)}.${occurrenceNote}`,
          expected: spanRaw,
          observed: targetText,
          repairHint: `Restore protected span ${spanRaw} exactly in ${unit.sourceUnitKey}.`,
          findingKind: "protected_span_issue",
          qualityCategory: "protected_content",
          severity: "P0",
        }),
      );
    }

    const charsetProblem = firstCharsetProblem(targetText);
    if (charsetProblem !== undefined) {
      unitFailures.push(
        failure(unit, targetText, "charset-invalid", {
          message: `The target draft contains ${charsetProblem.label}.`,
          expected:
            "valid Unicode text without replacement characters or unsupported control codes",
          observed: charsetProblem.observed,
          repairHint: `Remove or replace ${charsetProblem.observed} in ${unit.sourceUnitKey}.`,
          findingKind: "model_output_issue",
          qualityCategory: "technical_integrity",
          severity: "P1",
        }),
      );
    }

    const lineLimit = lineLengthLimit(unit);
    const longLine = firstLongLine(targetText, lineLimit);
    if (longLine !== undefined) {
      unitFailures.push(
        failure(unit, targetText, "line-length-exceeded", {
          message: `Target line ${longLine.lineNumber} has ${longLine.length} characters, exceeding the ${lineLimit} character limit.`,
          expected: `<= ${lineLimit} characters per line`,
          observed: `${longLine.length} characters on line ${longLine.lineNumber}`,
          repairHint: `Shorten or manually wrap line ${longLine.lineNumber} for ${unit.sourceUnitKey}.`,
          findingKind: "model_output_issue",
          qualityCategory: "layout",
          severity: "P2",
        }),
      );
    }

    if (requiresTerminalPunctuation(unit.sourceText) && !hasTerminalPunctuation(targetText)) {
      unitFailures.push(
        failure(unit, targetText, "punctuation-missing", {
          message: "The source ends with terminal punctuation but the target does not.",
          expected: "target ends with terminal punctuation",
          observed: targetText.trimEnd().slice(-1) || "empty target",
          repairHint: `Add appropriate terminal punctuation to ${unit.sourceUnitKey}.`,
          findingKind: "model_output_issue",
          qualityCategory: "locale_convention",
          severity: "P2",
        }),
      );
    }

    for (const term of glossaryTerms) {
      if (term.unitId === unit.bridgeUnitId || !unit.sourceText.includes(term.sourceText)) {
        continue;
      }
      if (!targetText.includes(term.targetText)) {
        unitFailures.push(
          failure(unit, targetText, "glossary-exact-mismatch", {
            message: `The target draft is missing exact glossary target ${JSON.stringify(term.targetText)} for source term ${JSON.stringify(term.sourceText)}.`,
            expected: term.targetText,
            observed: targetText,
            repairHint: `Use glossary term ${term.targetText} exactly in ${unit.sourceUnitKey}.`,
            findingKind: "policy_issue",
            qualityCategory: "terminology",
            severity: "P1",
          }),
        );
      }
    }

    return unitFailures;
  });

  return {
    failures,
    findings: failures.map((qaFailure, index) => findingForFailure(project, qaFailure, index + 1)),
  };
}

function unitsForBridge(
  bridge: BridgeBundle | BridgeBundleV02,
): Array<BridgeUnit | LocalizationUnitV02> {
  return bridge.units;
}

function failure(
  unit: BridgeUnit | LocalizationUnitV02,
  targetText: string,
  checkCode: DeterministicPreExportQaCheckCode,
  details: Omit<
    DeterministicPreExportQaFailure,
    "checkCode" | "unitId" | "sourceUnitKey" | "sourceText" | "targetText"
  >,
): DeterministicPreExportQaFailure {
  return {
    checkCode,
    unitId: unit.bridgeUnitId,
    sourceUnitKey: unit.sourceUnitKey,
    sourceText: unit.sourceText,
    targetText,
    ...details,
  };
}

function protectedSpanRaws(unit: BridgeUnit | LocalizationUnitV02): string[] {
  if ("spans" in unit) {
    return unit.spans.map((span) => span.raw);
  }
  return unit.protectedSpans.map((span) => span.raw);
}

function firstCharsetProblem(targetText: string): { label: string; observed: string } | undefined {
  for (let index = 0; index < targetText.length; index += 1) {
    const codeUnit = targetText.charCodeAt(index);
    if (codeUnit === 0xfffd) {
      return { label: "Unicode replacement character U+FFFD", observed: "U+FFFD" };
    }
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = targetText.charCodeAt(index + 1);
      if (!(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff)) {
        return { label: "unpaired high surrogate", observed: codePointLabel(codeUnit) };
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return { label: "unpaired low surrogate", observed: codePointLabel(codeUnit) };
    }
    if (isUnsupportedControlCode(codeUnit)) {
      return { label: "unsupported control code", observed: codePointLabel(codeUnit) };
    }
  }
  return undefined;
}

function isUnsupportedControlCode(codeUnit: number): boolean {
  return (
    (codeUnit < 0x20 && codeUnit !== 0x09 && codeUnit !== 0x0a && codeUnit !== 0x0d) ||
    (codeUnit >= 0x7f && codeUnit <= 0x9f)
  );
}

function codePointLabel(codeUnit: number): string {
  return `U+${codeUnit.toString(16).toUpperCase().padStart(4, "0")}`;
}

function lineLengthLimit(unit: BridgeUnit | LocalizationUnitV02): number {
  const surface = "surfaceKind" in unit ? unit.surfaceKind : unit.textSurface;
  switch (surface) {
    case "speaker_name":
      return 32;
    case "choice_label":
    case "ui_label":
      return 48;
    case "image_text":
      return 64;
    case "tutorial_text":
      return 120;
    default:
      return 160;
  }
}

function firstLongLine(
  targetText: string,
  limit: number,
): { lineNumber: number; length: number } | undefined {
  const lines = targetText.split(/\r\n|\n|\r/u);
  for (const [index, line] of lines.entries()) {
    const length = Array.from(line).length;
    if (length > limit) {
      return { lineNumber: index + 1, length };
    }
  }
  return undefined;
}

function requiresTerminalPunctuation(sourceText: string): boolean {
  return /[。！？.!?]\s*$/u.test(sourceText);
}

function hasTerminalPunctuation(targetText: string): boolean {
  return /[.!?。！？…]\s*$/u.test(targetText);
}

type GlossaryTerm = {
  unitId: string;
  sourceText: string;
  targetText: string;
};

function glossaryTermsForProject(project: ProjectState): GlossaryTerm[] {
  const terms: GlossaryTerm[] = [];
  for (const unit of unitsForBridge(project.bridge)) {
    const policyTargetText =
      "policy" in unit && unit.policy?.targetText !== undefined
        ? unit.policy.targetText
        : undefined;
    const targetText = policyTargetText ?? project.drafts[unit.bridgeUnitId];
    if (targetText === undefined || targetText.trim().length === 0) {
      continue;
    }
    if (isGlossaryUnit(unit)) {
      terms.push({
        unitId: unit.bridgeUnitId,
        sourceText: unit.sourceText,
        targetText,
      });
    }
  }
  return terms;
}

function isGlossaryUnit(unit: BridgeUnit | LocalizationUnitV02): boolean {
  if (unit.sourceUnitKey.includes(".glossary.") || unit.sourceUnitKey.includes("/glossary/")) {
    return true;
  }
  return (
    "context" in unit && "database" in unit.context && unit.context.database.fieldKey === "term"
  );
}

function findingForFailure(
  project: ProjectState,
  qaFailure: DeterministicPreExportQaFailure,
  index: number,
): FindingRecordV02 {
  const idSeed = {
    projectId: project.projectId,
    localeBranchId: project.localeBranchId,
    unitId: qaFailure.unitId,
    sourceUnitKey: qaFailure.sourceUnitKey,
    checkCode: qaFailure.checkCode,
    expected: qaFailure.expected,
    index,
  };
  const provenanceId = deterministicQaUuid("provenance", idSeed);
  return {
    findingId: deterministicQaUuid("finding", idSeed),
    findingKind: qaFailure.findingKind,
    severity: qaFailure.severity,
    qualityCategory: qaFailure.qualityCategory,
    title: `Pre-export QA: ${qaFailure.checkCode}`,
    description: `${qaFailure.message} Unit ${qaFailure.unitId} (${qaFailure.sourceUnitKey}). Repair hint: ${qaFailure.repairHint}`,
    impact:
      "Patch export is blocked until deterministic QA can prove the target text is safe to export.",
    createdAt: CREATED_AT,
    affectedRefs: [
      {
        subjectKind: "bridge_unit",
        subjectId: qaFailure.unitId,
        label: qaFailure.sourceUnitKey,
      },
      {
        subjectKind: "locale_branch",
        subjectId: project.localeBranchId,
        label: project.targetLocale,
      },
    ],
    evidence: [
      {
        evidenceId: deterministicQaUuid("evidence", idSeed),
        evidenceKind: "validator_message",
        summary: `${qaFailure.checkCode}: ${qaFailure.message} Repair hint: ${qaFailure.repairHint}`,
        expectedValue: qaFailure.expected,
        observedValue: qaFailure.observed,
        provenanceIds: [provenanceId],
      },
    ],
    provenance: [
      {
        provenanceId,
        provenanceKind: "deterministic_check",
        checkId: deterministicQaUuid("check", idSeed),
        checkName: qaFailure.checkCode,
        checkVersion: CHECK_VERSION,
      },
    ],
    causalLinks: [],
  };
}

function deterministicQaUuid(kind: string, seed: Record<string, unknown>): string {
  const suffix = createHash("sha256")
    .update(`${kind}:${JSON.stringify(seed)}`)
    .digest("hex")
    .slice(0, 12);
  return `019ed020-0000-7000-8000-${suffix}`;
}

function deterministicQaErrorMessage(failures: DeterministicPreExportQaFailure[]): string {
  const summary = failures
    .map(
      (qaFailure) =>
        `${qaFailure.checkCode} ${qaFailure.unitId} (${qaFailure.sourceUnitKey}): ${qaFailure.message} Repair hint: ${qaFailure.repairHint}`,
    )
    .join("; ");
  return `deterministic pre-export QA failed for ${failures.length} finding(s): ${summary}`;
}

// ---------------------------------------------------------------------------
// Registry-tool output contract (ITOTORI-143)
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
