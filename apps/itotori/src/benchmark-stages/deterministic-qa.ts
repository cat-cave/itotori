// ITOTORI-090 — Deterministic QA benchmark stage.
//
// Scores the raw-MTL baseline outputs with a fixed, reproducible rule set (no
// model, no provider, no randomness) and emits one `DeterministicQaResultV02`
// per (system, check) carrying rule ids, severity, affected unit ids, and
// pass/fail counts, plus the `deterministic_qa` finding records each failed
// rule produced. Re-running the stage over the same baseline outputs yields a
// byte-identical artifact.

import type {
  BenchmarkArtifactRefV02,
  BenchmarkFindingRecordV02,
  DeterministicQaResultV02,
  LocalizationQualityCategoryV02,
  LocalizationQualitySeverityV02,
  LocalizationRootCauseV02,
} from "@itotori/localization-bridge-schema";
import { deterministicUuid7, sha256HashString } from "./ids.js";
import type { RawMtlBaselineSystemOutput } from "./raw-mtl-baseline.js";

const TAXONOMY_ID = "itotori-lqa-1" as const;
const TAXONOMY_VERSION = "itotori-quality-taxonomy-0.1.0" as const;
const CHECK_VERSION = "0.2.0";
const PLACEHOLDER_PATTERN = /\{[^{}]+\}/gu;

type DeterministicUnit = RawMtlBaselineSystemOutput["units"][number];

type RuleViolation = {
  category: LocalizationQualityCategoryV02;
  qualitySubcategory: string;
  qualitySeverity: LocalizationQualitySeverityV02;
  rootCause: LocalizationRootCauseV02;
  expectedValue: string;
  observedValue: string;
  rationale: string;
};

type DeterministicRule = {
  checkName: string;
  /** Returns a violation for a failed unit, or null when the unit passes. */
  evaluate(unit: DeterministicUnit): RuleViolation | null;
};

/** Every protected `{placeholder}` span in the source must survive translation. */
const protectedSpanPreservation: DeterministicRule = {
  checkName: "protected-span-preservation",
  evaluate(unit) {
    const placeholders = unit.sourceText.match(PLACEHOLDER_PATTERN) ?? [];
    const dropped = placeholders.filter((token) => !unit.targetText.includes(token));
    if (dropped.length === 0) {
      return null;
    }
    return {
      category: "technical_integrity",
      qualitySubcategory: "dropped_protected_span",
      qualitySeverity: "major",
      rootCause: "model_draft_error",
      expectedValue: `preserve protected spans ${placeholders.join(", ")}`,
      observedValue: `dropped protected spans ${dropped.join(", ")}`,
      rationale: `Target output dropped protected span(s) ${dropped.join(", ")} present in the source unit.`,
    };
  },
};

/** A non-empty source unit must not translate to empty/whitespace output. */
const nonEmptyTarget: DeterministicRule = {
  checkName: "non-empty-target",
  evaluate(unit) {
    if (unit.sourceText.trim().length === 0 || unit.targetText.trim().length > 0) {
      return null;
    }
    return {
      category: "accuracy",
      qualitySubcategory: "empty_translation",
      qualitySeverity: "critical",
      rootCause: "model_draft_error",
      expectedValue: "non-empty translated text",
      observedValue: "empty or whitespace-only translated text",
      rationale: "Target output is empty for a non-empty source unit.",
    };
  },
};

const DETERMINISTIC_RULES: readonly DeterministicRule[] = [
  protectedSpanPreservation,
  nonEmptyTarget,
];

export type DeterministicQaInput = {
  baselineOutputs: RawMtlBaselineSystemOutput[];
  startedAt: string;
  completedAt: string;
};

export type DeterministicQaResult = {
  results: DeterministicQaResultV02[];
  findings: BenchmarkFindingRecordV02[];
};

export class DeterministicQaError extends Error {
  constructor(detail: string) {
    super(`deterministic-qa stage refused: ${detail}`);
    this.name = "DeterministicQaError";
  }
}

export function runDeterministicQaStage(input: DeterministicQaInput): DeterministicQaResult {
  if (input.baselineOutputs.length === 0) {
    throw new DeterministicQaError("no baseline outputs to score");
  }

  const results: DeterministicQaResultV02[] = [];
  const findings: BenchmarkFindingRecordV02[] = [];

  for (const system of input.baselineOutputs) {
    if (system.units.length === 0) {
      throw new DeterministicQaError(`baseline system '${system.systemId}' carries zero units`);
    }
    for (const rule of DETERMINISTIC_RULES) {
      const findingIds: string[] = [];
      let failedRuleCount = 0;
      for (const unit of system.units) {
        const violation = rule.evaluate(unit);
        if (violation === null) {
          continue;
        }
        failedRuleCount += 1;
        const finding = buildFinding(system.systemId, rule.checkName, unit, violation);
        findings.push(finding);
        findingIds.push(finding.findingId);
      }
      const ruleCount = system.units.length;
      const artifactRef: BenchmarkArtifactRefV02 = {
        artifactId: deterministicUuid7(
          "deterministic-qa-artifact",
          system.systemId,
          rule.checkName,
        ),
        artifactKind: "deterministic-qa-report",
        uri: `artifacts/benchmark/deterministic-qa/${system.systemId}/${rule.checkName}.json`,
        hash: sha256HashString([system.systemId, rule.checkName, ...findingIds].join("|")),
        mediaType: "application/json",
      };
      results.push({
        deterministicQaRunId: deterministicUuid7(
          "deterministic-qa-run",
          system.systemId,
          rule.checkName,
        ),
        evaluatedSystemId: system.systemId,
        checkName: rule.checkName,
        checkVersion: CHECK_VERSION,
        startedAt: input.startedAt,
        completedAt: input.completedAt,
        ruleCount,
        passedRuleCount: ruleCount - failedRuleCount,
        failedRuleCount,
        findingIds,
        artifactRefs: [artifactRef],
      });
    }
  }

  return { results, findings };
}

function buildFinding(
  systemId: string,
  checkName: string,
  unit: DeterministicUnit,
  violation: RuleViolation,
): BenchmarkFindingRecordV02 {
  const findingId = deterministicUuid7(
    "deterministic-qa-finding",
    systemId,
    checkName,
    unit.unitId,
  );
  const provenanceId = deterministicUuid7(
    "deterministic-qa-provenance",
    systemId,
    checkName,
    unit.unitId,
  );
  const evidenceId = deterministicUuid7(
    "deterministic-qa-evidence",
    systemId,
    checkName,
    unit.unitId,
  );
  const checkId = deterministicUuid7("deterministic-qa-check", checkName);
  return {
    findingId,
    systemId,
    taxonomyId: TAXONOMY_ID,
    taxonomyVersion: TAXONOMY_VERSION,
    detectorKind: "deterministic_qa",
    category: violation.category,
    qualitySubcategory: violation.qualitySubcategory,
    qualitySeverity: violation.qualitySeverity,
    rootCause: violation.rootCause,
    adjudicationState: "confirmed",
    affectedRefs: [
      {
        subjectKind: "bridge_unit",
        subjectId: unit.unitId,
        label: unit.label,
      },
    ],
    evidence: [
      {
        evidenceId,
        evidenceKind: "validator_message",
        summary: `${checkName} failed on ${unit.label}`,
        subjectRef: {
          subjectKind: "bridge_unit",
          subjectId: unit.unitId,
          label: unit.label,
        },
        expectedValue: violation.expectedValue,
        observedValue: violation.observedValue,
        provenanceIds: [provenanceId],
      },
    ],
    provenance: [
      {
        provenanceId,
        provenanceKind: "deterministic_check",
        checkId,
        checkName,
        checkVersion: CHECK_VERSION,
      },
    ],
    reviewerRationale: violation.rationale,
  };
}
