// benchmark-deterministic-metric-suite (§3) — glossary/terminology + named-
// entity consistency.
//
//   Glossary consistency (§3): for each canon term with a declared target
//   form, the fraction of source occurrences rendered with the declared form.
//   Named-entity consistency (§3): the same computation over the corpus
//   canon-NAME list (character/place/item names), so a contestant is scored on
//   consistent, canon romanization/spelling.
//
// Both are ground-truth-anchored (corpus glossary / canon-name list) and
// self-consistent (the same source term must map to the same declared target
// everywhere), producing a reproducible occurrence-compliance fraction.

import { buildMetricFinding, type MetricViolation } from "./findings.js";
import { countOccurrences } from "./text-utils.js";
import type { CanonTerm, MetricSystemInput, ScoredMetricOutcome } from "./types.js";

const CHECK_VERSION = "0.1.0";

type TermMetricSpec = {
  metricId: string;
  checkName: string;
  qualitySubcategory: string;
  makeExpected: (term: CanonTerm) => string;
  makeObserved: (term: CanonTerm, occurrences: number) => string;
  rationale: (term: CanonTerm) => string;
};

const GLOSSARY_SPEC: TermMetricSpec = {
  metricId: "glossary-consistency",
  checkName: "glossary-consistency",
  qualitySubcategory: "glossary_violation",
  makeExpected: (term) =>
    `render '${term.sourceTerm}' as declared glossary form '${term.targetForm}'`,
  makeObserved: (term, occurrences) =>
    `'${term.sourceTerm}' present in ${occurrences} occurrence(s); declared form '${term.targetForm}' absent from target`,
  rationale: (term) =>
    `Target does not use the declared glossary form '${term.targetForm}' for source term '${term.sourceTerm}'.`,
};

const NAMED_ENTITY_SPEC: TermMetricSpec = {
  metricId: "named-entity-consistency",
  checkName: "named-entity-consistency",
  qualitySubcategory: "canon_name_violation",
  makeExpected: (term) =>
    `render name '${term.sourceTerm}' with canon spelling '${term.targetForm}'`,
  makeObserved: (term, occurrences) =>
    `name '${term.sourceTerm}' present in ${occurrences} occurrence(s); canon spelling '${term.targetForm}' absent from target`,
  rationale: (term) =>
    `Target does not use the canon spelling '${term.targetForm}' for name '${term.sourceTerm}'.`,
};

function evaluateTermConsistency(
  system: MetricSystemInput,
  terms: CanonTerm[],
  spec: TermMetricSpec,
): ScoredMetricOutcome {
  const findings: ScoredMetricOutcome["findings"] = [];
  let totalOccurrences = 0;
  let compliantOccurrences = 0;

  for (const unit of system.units) {
    for (const term of terms) {
      const occurrences = countOccurrences(unit.sourceText, term.sourceTerm);
      if (occurrences === 0) {
        continue;
      }
      totalOccurrences += occurrences;
      if (unit.targetText.includes(term.targetForm)) {
        compliantOccurrences += occurrences;
        continue;
      }
      const violation: MetricViolation = {
        category: "terminology",
        qualitySubcategory: spec.qualitySubcategory,
        qualitySeverity: "major",
        rootCause: "glossary_policy_gap",
        expectedValue: spec.makeExpected(term),
        observedValue: spec.makeObserved(term, occurrences),
        rationale: spec.rationale(term),
      };
      findings.push(
        buildMetricFinding({
          systemId: system.systemId,
          checkName: spec.checkName,
          checkVersion: CHECK_VERSION,
          unitId: unit.unitId,
          label: unit.label,
          discriminator: term.sourceTerm,
          violation,
        }),
      );
    }
  }

  const failedRuleCount = totalOccurrences - compliantOccurrences;
  const score = totalOccurrences === 0 ? 1 : compliantOccurrences / totalOccurrences;
  return {
    metricId: spec.metricId,
    checkName: spec.checkName,
    checkVersion: CHECK_VERSION,
    ruleCount: totalOccurrences,
    passedRuleCount: compliantOccurrences,
    failedRuleCount,
    score,
    detail: {
      occurrences: totalOccurrences,
      compliantOccurrences,
      violationOccurrences: failedRuleCount,
    },
    findings,
  };
}

/** §3 glossary/terminology consistency for one contestant system. */
export function glossaryConsistency(
  system: MetricSystemInput,
  glossary: CanonTerm[],
): ScoredMetricOutcome {
  return evaluateTermConsistency(system, glossary, GLOSSARY_SPEC);
}

/** §3 named-entity consistency for one contestant system. */
export function namedEntityConsistency(
  system: MetricSystemInput,
  canonNames: CanonTerm[],
): ScoredMetricOutcome {
  return evaluateTermConsistency(system, canonNames, NAMED_ENTITY_SPEC);
}
