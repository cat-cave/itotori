// benchmark-deterministic-metric-suite (§3) — speaker-attribution + choice/
// branch correctness.
//
//   Speaker attribution (§3): the fraction of units whose attributed speaker
//   matches the Kaifuu-decoded speaker.
//   Choice / branch correctness (§3): for choice units, whether the rendered
//   options preserve the decoded choice→goto branch targets (structural, not
//   stylistic) — order and target sequence must match the decoded graph.
//
// Both compare the contestant's output against the deterministic Kaifuu decode;
// no interpretation, no model.

import { buildMetricFinding } from "./findings.js";
import type { MetricSystemInput, ScoredMetricOutcome } from "./types.js";

const CHECK_VERSION = "0.1.0";

function normalizeSpeaker(speaker: string): string {
  return speaker.trim();
}

/** §3 speaker-attribution correctness for one contestant system. */
export function speakerAttribution(system: MetricSystemInput): ScoredMetricOutcome {
  const findings: ScoredMetricOutcome["findings"] = [];
  let evaluated = 0;
  let correct = 0;

  for (const unit of system.units) {
    if (unit.decodedSpeaker === undefined) {
      continue;
    }
    evaluated += 1;
    const attributed = unit.attributedSpeaker ?? "";
    if (normalizeSpeaker(attributed) === normalizeSpeaker(unit.decodedSpeaker)) {
      correct += 1;
      continue;
    }
    findings.push(
      buildMetricFinding({
        systemId: system.systemId,
        checkName: "speaker-attribution",
        checkVersion: CHECK_VERSION,
        unitId: unit.unitId,
        label: unit.label,
        discriminator: "speaker",
        violation: {
          category: "accuracy",
          qualitySubcategory: "context_misread",
          qualitySeverity: "major",
          rootCause: "model_draft_error",
          expectedValue: `speaker '${unit.decodedSpeaker}'`,
          observedValue: `speaker '${attributed}'`,
          rationale: `Line attributed to '${attributed}' but the decoded ground-truth speaker is '${unit.decodedSpeaker}'.`,
        },
      }),
    );
  }

  const failed = evaluated - correct;
  return {
    metricId: "speaker-attribution",
    checkName: "speaker-attribution",
    checkVersion: CHECK_VERSION,
    ruleCount: evaluated,
    passedRuleCount: correct,
    failedRuleCount: failed,
    score: evaluated === 0 ? 1 : correct / evaluated,
    detail: { evaluatedUnits: evaluated, correctUnits: correct, mismatchedUnits: failed },
    findings,
  };
}

function branchSequence(options: { branchTarget: string }[]): string {
  return options.map((option) => option.branchTarget).join(" -> ");
}

/** §3 choice/branch correctness for one contestant system. */
export function choiceBranchCorrectness(system: MetricSystemInput): ScoredMetricOutcome {
  const findings: ScoredMetricOutcome["findings"] = [];
  let evaluated = 0;
  let correct = 0;

  for (const unit of system.units) {
    if (unit.choice === undefined) {
      continue;
    }
    evaluated += 1;
    const expected = branchSequence(unit.choice.expectedOptions);
    const actual = branchSequence(unit.choice.actualOptions);
    if (expected === actual) {
      correct += 1;
      continue;
    }
    findings.push(
      buildMetricFinding({
        systemId: system.systemId,
        checkName: "choice-branch-correctness",
        checkVersion: CHECK_VERSION,
        unitId: unit.unitId,
        label: unit.label,
        discriminator: "choice-branch",
        violation: {
          category: "accuracy",
          qualitySubcategory: "choice_semantics_shift",
          qualitySeverity: "critical",
          rootCause: "model_draft_error",
          expectedValue: `branch sequence [${expected}]`,
          observedValue: `branch sequence [${actual}]`,
          rationale:
            "Rendered choice options do not preserve the decoded choice→goto branch targets; the player's intended action/route is altered.",
        },
      }),
    );
  }

  const failed = evaluated - correct;
  return {
    metricId: "choice-branch-correctness",
    checkName: "choice-branch-correctness",
    checkVersion: CHECK_VERSION,
    ruleCount: evaluated,
    passedRuleCount: correct,
    failedRuleCount: failed,
    score: evaluated === 0 ? 1 : correct / evaluated,
    detail: { evaluatedChoices: evaluated, correctChoices: correct, shiftedChoices: failed },
    findings,
  };
}
