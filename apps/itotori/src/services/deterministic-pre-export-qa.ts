import { createHash } from "node:crypto";
import type {
  BridgeBundle,
  BridgeBundleV02,
  BridgeUnit,
  FindingRecordV02,
  LocalizationQualityCategoryV02,
  LocalizationUnitV02,
} from "@itotori/localization-bridge-schema";
import type { ProjectState } from "./project-workflow.js";

const CHECK_VERSION = "itotori-020.1";
const CREATED_AT = "2026-06-19T00:00:00.000Z";

export type DeterministicPreExportQaCheckCode =
  | "protected-span-missing"
  | "empty-translation"
  | "charset-invalid"
  | "line-length-exceeded"
  | "punctuation-missing"
  | "glossary-exact-mismatch";

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
      const observedCount = countOccurrences(targetText, spanRaw);
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

function missingRequiredProtectedSpanOccurrences(
  requiredSpans: string[],
  targetText: string,
): string[] {
  const availableCounts = new Map<string, number>();
  const missing: string[] = [];
  for (const spanRaw of requiredSpans) {
    const available = availableCounts.get(spanRaw) ?? countOccurrences(targetText, spanRaw);
    if (available <= 0) {
      missing.push(spanRaw);
      continue;
    }
    availableCounts.set(spanRaw, available - 1);
  }
  return missing;
}

function countOccurrences(targetText: string, raw: string): number {
  if (raw.length === 0) {
    return 0;
  }
  let count = 0;
  let searchStart = 0;
  while (searchStart <= targetText.length) {
    const index = targetText.indexOf(raw, searchStart);
    if (index < 0) {
      return count;
    }
    count += 1;
    searchStart = index + raw.length;
  }
  return count;
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
