// benchmark-deterministic-metric-suite (§3) — text-box/word-wrap compliance +
// untranslated-residue detection.
//
//   Text-box length / word-wrap (§3): per unit, does the rendered target fit
//   the engine box metrics via a deterministic greedy word-wrap? Reports the
//   overflow count + worst-case overrun.
//   Untranslated residue (§3): the fraction of units still carrying residual
//   source script (JP kana/kanji) outside protected spans.

import { buildMetricFinding } from "./findings.js";
import { countResidualSourceScript, wrapOverrun } from "./text-utils.js";
import type { MetricSystemInput, ScoredMetricOutcome } from "./types.js";

const CHECK_VERSION = "0.1.0";

/**
 * §3 text-box length / word-wrap compliance. A unit OVERFLOWS when, after
 * greedy wrap to the decoded column width, either an unbreakable token exceeds
 * the column budget (worst overrun > 0) or the wrapped line count exceeds the
 * box's `maxLines` (truncation). Reproducible per unit.
 */
export function wrapCompliance(system: MetricSystemInput): ScoredMetricOutcome {
  const findings: ScoredMetricOutcome["findings"] = [];
  let evaluated = 0;
  let compliant = 0;
  let overflowCount = 0;
  let worstOverrunOverall = 0;

  for (const unit of system.units) {
    if (unit.boxMetrics === undefined) {
      continue;
    }
    evaluated += 1;
    const { columns, maxLines } = unit.boxMetrics;
    const { lineCount, worstOverrun } = wrapOverrun(unit.targetText, columns);
    const lineOverflow = Math.max(0, lineCount - maxLines);
    const overflows = worstOverrun > 0 || lineOverflow > 0;
    if (worstOverrun > worstOverrunOverall) {
      worstOverrunOverall = worstOverrun;
    }
    if (!overflows) {
      compliant += 1;
      continue;
    }
    overflowCount += 1;
    findings.push(
      buildMetricFinding({
        systemId: system.systemId,
        checkName: "wrap-compliance",
        checkVersion: CHECK_VERSION,
        unitId: unit.unitId,
        label: unit.label,
        discriminator: "wrap",
        violation: {
          category: "layout",
          qualitySubcategory: "overflow_or_truncation",
          qualitySeverity: "major",
          rootCause: "runtime_environment_or_i18n_limit",
          expectedValue: `fit within ${columns} columns x ${maxLines} lines`,
          observedValue: `wrapped to ${lineCount} line(s), worst overrun ${worstOverrun} column(s)`,
          rationale: `Rendered target does not fit the ${columns}x${maxLines} text box (worst overrun ${worstOverrun} col, ${lineOverflow} line(s) over).`,
        },
      }),
    );
  }

  const failed = evaluated - compliant;
  return {
    metricId: "wrap-compliance",
    checkName: "wrap-compliance",
    checkVersion: CHECK_VERSION,
    ruleCount: evaluated,
    passedRuleCount: compliant,
    failedRuleCount: failed,
    score: evaluated === 0 ? 1 : compliant / evaluated,
    detail: {
      evaluatedUnits: evaluated,
      fitUnits: compliant,
      overflowUnits: overflowCount,
      worstOverrunColumns: worstOverrunOverall,
    },
    findings,
  };
}

/** Strip verbatim protected spans before residue scanning. */
function stripProtectedSpans(text: string, protectedSpans: string[] | undefined): string {
  if (protectedSpans === undefined || protectedSpans.length === 0) {
    return text;
  }
  let stripped = text;
  for (const span of protectedSpans) {
    if (span.length === 0) {
      continue;
    }
    stripped = stripped.split(span).join(" ");
  }
  return stripped;
}

/** §3 untranslated-residue detection for one contestant system. */
export function untranslatedResidue(system: MetricSystemInput): ScoredMetricOutcome {
  const findings: ScoredMetricOutcome["findings"] = [];
  let residualUnits = 0;
  let totalResidualCodepoints = 0;

  for (const unit of system.units) {
    const scannable = stripProtectedSpans(unit.targetText, unit.protectedSpans);
    const residual = countResidualSourceScript(scannable);
    if (residual === 0) {
      continue;
    }
    residualUnits += 1;
    totalResidualCodepoints += residual;
    findings.push(
      buildMetricFinding({
        systemId: system.systemId,
        checkName: "untranslated-residue",
        checkVersion: CHECK_VERSION,
        unitId: unit.unitId,
        label: unit.label,
        discriminator: "residue",
        violation: {
          category: "accuracy",
          qualitySubcategory: "omission",
          qualitySeverity: "major",
          rootCause: "model_draft_error",
          expectedValue: "no residual source-script characters outside protected spans",
          observedValue: `${residual} residual source-script codepoint(s) remain untranslated`,
          rationale: `Target still contains ${residual} untranslated source-script codepoint(s) outside protected spans.`,
        },
      }),
    );
  }

  const total = system.units.length;
  const cleanUnits = total - residualUnits;
  return {
    metricId: "untranslated-residue",
    checkName: "untranslated-residue",
    checkVersion: CHECK_VERSION,
    ruleCount: total,
    passedRuleCount: cleanUnits,
    failedRuleCount: residualUnits,
    score: total === 0 ? 1 : cleanUnits / total,
    detail: {
      units: total,
      cleanUnits,
      residualUnits,
      residualCodepoints: totalResidualCodepoints,
    },
    findings,
  };
}
