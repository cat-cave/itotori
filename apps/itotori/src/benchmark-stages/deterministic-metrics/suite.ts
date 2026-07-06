// benchmark-deterministic-metric-suite (§3) — the suite runner.
//
// Composes the §3 deterministic metrics over every contestant system and emits:
//   - `DeterministicQaResultV02[]`  one per (system, metric check) — the same
//     schema shape the ITOTORI-090 deterministic-qa stage emits, so metric
//     results compose into a `BenchmarkReportV02` with no forked vocabulary.
//   - `BenchmarkFindingRecordV02[]` all `deterministic_qa` findings.
//   - `MetricScore[]`               reproducible, bias-independent, 0..1,
//     comparable-across-contestant scores (the ranking-eligible signals).
//   - `BackTranslationTripwire[]`   the tripwire signals — deliberately kept
//     OUT of `scores` (§3: back-translation is a tripwire, not a score).
//
// The whole run is a pure function of its input: same input → byte-identical
// output. No model, provider, clock, or randomness.

import type {
  BenchmarkArtifactRefV02,
  BenchmarkFindingRecordV02,
  DeterministicQaResultV02,
} from "@itotori/localization-bridge-schema";
import { deterministicUuid7, sha256HashString } from "../ids.js";
import { backTranslationTripwire } from "./back-translation-tripwire.js";
import { glossaryConsistency, namedEntityConsistency } from "./glossary-and-names.js";
import { wrapCompliance, untranslatedResidue } from "./layout-residue.js";
import { choiceBranchCorrectness, speakerAttribution } from "./structural.js";
import {
  DEFAULT_METRIC_CONFIG,
  type BackTranslationTripwire,
  type CanonTerm,
  type DeterministicMetricConfig,
  type MetricScore,
  type MetricSystemInput,
  type ScoredMetricOutcome,
} from "./types.js";
import { voiceStyleFingerprint } from "./voice-fingerprint.js";

export class DeterministicMetricSuiteError extends Error {
  constructor(detail: string) {
    super(`deterministic-metric-suite refused: ${detail}`);
    this.name = "DeterministicMetricSuiteError";
  }
}

export type DeterministicMetricSuiteInput = {
  systems: MetricSystemInput[];
  /** Corpus glossary: canon term → declared target form. */
  glossary: CanonTerm[];
  /** Corpus canon-name list: name → canon target spelling. */
  canonNames: CanonTerm[];
  /** Optional threshold overrides; defaults are recorded for reproducibility. */
  config?: Partial<DeterministicMetricConfig>;
  startedAt: string;
  completedAt: string;
};

export type DeterministicMetricSuiteResult = {
  results: DeterministicQaResultV02[];
  findings: BenchmarkFindingRecordV02[];
  scores: MetricScore[];
  tripwires: BackTranslationTripwire[];
  config: DeterministicMetricConfig;
};

function toResult(
  outcome: {
    checkName: string;
    checkVersion: string;
    ruleCount: number;
    passedRuleCount: number;
    failedRuleCount: number;
    findings: BenchmarkFindingRecordV02[];
  },
  systemId: string,
  startedAt: string,
  completedAt: string,
): DeterministicQaResultV02 {
  const findingIds = outcome.findings.map((finding) => finding.findingId);
  const artifactRef: BenchmarkArtifactRefV02 = {
    artifactId: deterministicUuid7("metric-suite-artifact", systemId, outcome.checkName),
    artifactKind: "deterministic-metric-report",
    uri: `artifacts/benchmark/deterministic-metrics/${systemId}/${outcome.checkName}.json`,
    hash: sha256HashString([systemId, outcome.checkName, ...findingIds].join("|")),
    mediaType: "application/json",
  };
  return {
    deterministicQaRunId: deterministicUuid7("metric-suite-run", systemId, outcome.checkName),
    evaluatedSystemId: systemId,
    checkName: outcome.checkName,
    checkVersion: outcome.checkVersion,
    startedAt,
    completedAt,
    ruleCount: outcome.ruleCount,
    passedRuleCount: outcome.passedRuleCount,
    failedRuleCount: outcome.failedRuleCount,
    findingIds,
    artifactRefs: [artifactRef],
  };
}

function toScore(outcome: ScoredMetricOutcome, systemId: string): MetricScore {
  return {
    systemId,
    metricId: outcome.metricId,
    checkName: outcome.checkName,
    score: outcome.score,
    ruleCount: outcome.ruleCount,
    passedRuleCount: outcome.passedRuleCount,
    failedRuleCount: outcome.failedRuleCount,
    detail: outcome.detail,
  };
}

/** Run the full §3 deterministic metric suite over all contestant systems. */
export function runDeterministicMetricSuite(
  input: DeterministicMetricSuiteInput,
): DeterministicMetricSuiteResult {
  if (input.systems.length === 0) {
    throw new DeterministicMetricSuiteError("no contestant systems to score");
  }
  const seenSystemIds = new Set<string>();
  for (const system of input.systems) {
    if (seenSystemIds.has(system.systemId)) {
      throw new DeterministicMetricSuiteError(`duplicate systemId '${system.systemId}'`);
    }
    seenSystemIds.add(system.systemId);
    if (system.units.length === 0) {
      throw new DeterministicMetricSuiteError(`system '${system.systemId}' carries zero units`);
    }
  }

  const config: DeterministicMetricConfig = { ...DEFAULT_METRIC_CONFIG, ...input.config };
  const results: DeterministicQaResultV02[] = [];
  const findings: BenchmarkFindingRecordV02[] = [];
  const scores: MetricScore[] = [];
  const tripwires: BackTranslationTripwire[] = [];

  for (const system of input.systems) {
    const scoredOutcomes: ScoredMetricOutcome[] = [
      glossaryConsistency(system, input.glossary),
      namedEntityConsistency(system, input.canonNames),
      wrapCompliance(system),
      speakerAttribution(system),
      choiceBranchCorrectness(system),
      untranslatedResidue(system),
      voiceStyleFingerprint(system, config.voiceDriftThreshold),
    ];
    for (const outcome of scoredOutcomes) {
      results.push(toResult(outcome, system.systemId, input.startedAt, input.completedAt));
      findings.push(...outcome.findings);
      scores.push(toScore(outcome, system.systemId));
    }

    // Back-translation is a TRIPWIRE, not a score: it emits a schema result +
    // findings (so it composes into the report) but is NEVER added to `scores`.
    const tripwireOutcome = backTranslationTripwire(system, config.backTranslationTripwireFloor);
    results.push(toResult(tripwireOutcome, system.systemId, input.startedAt, input.completedAt));
    findings.push(...tripwireOutcome.findings);
    tripwires.push(...tripwireOutcome.tripwires);
  }

  return { results, findings, scores, tripwires, config };
}
