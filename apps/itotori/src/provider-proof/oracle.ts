// ITOTORI-116 — seeded QA oracle scoring for the provider-proof harness.
//
// Scores the LLM-QA agent's validated findings against a seeded-defect
// oracle BY LOCATION (bridge unit id). Computes detection precision /
// recall / F1, severity calibration over matched findings, and explicit
// false-negative + false-positive accounting so a proof can never silently
// drop a missed seed or an over-eager finding. Mirrors the math in the
// ITOTORI-091 benchmark stage but stays self-contained for the proof.

import type {
  ProviderProofQaOracleReport,
  ProviderProofSeededDefect,
  QaFinding,
} from "@itotori/localization-bridge-schema";

export function scoreQaAgainstOracle(
  seededDefects: readonly ProviderProofSeededDefect[],
  findings: readonly QaFinding[],
): ProviderProofQaOracleReport {
  // Index seeds by the bridge unit they target. A unit may carry >1 seed;
  // the first un-matched seed on that unit is consumed by a finding.
  const seedsByUnit = new Map<string, ProviderProofSeededDefect[]>();
  for (const seed of seededDefects) {
    const list = seedsByUnit.get(seed.bridgeUnitId) ?? [];
    list.push(seed);
    seedsByUnit.set(seed.bridgeUnitId, list);
  }

  const matchedSeedIds = new Set<string>();
  const severityMatches = new Map<string, boolean>();
  const falsePositiveBridgeUnitIds: string[] = [];
  let truePositives = 0;

  for (const finding of findings) {
    const seeds = seedsByUnit.get(finding.bridgeUnitId) ?? [];
    const seed = seeds.find((candidate) => !matchedSeedIds.has(candidate.seededDefectId));
    if (seed === undefined) {
      falsePositiveBridgeUnitIds.push(finding.bridgeUnitId);
      continue;
    }
    matchedSeedIds.add(seed.seededDefectId);
    truePositives += 1;
    severityMatches.set(seed.seededDefectId, finding.severity === seed.severity);
  }

  const seededDefectCount = seededDefects.length;
  const emittedFindingCount = findings.length;
  const falsePositives = falsePositiveBridgeUnitIds.length;
  const falseNegativeSeededDefectIds = seededDefects
    .map((seed) => seed.seededDefectId)
    .filter((seedId) => !matchedSeedIds.has(seedId));
  const falseNegatives = falseNegativeSeededDefectIds.length;

  const precision =
    truePositives + falsePositives === 0 ? 1 : truePositives / (truePositives + falsePositives);
  const recall = seededDefectCount === 0 ? 1 : matchedSeedIds.size / seededDefectCount;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const severityCalibration =
    severityMatches.size === 0
      ? 1
      : [...severityMatches.values()].filter(Boolean).length / severityMatches.size;

  return {
    seededDefectCount,
    emittedFindingCount,
    truePositives,
    falsePositives,
    falseNegatives,
    precision: round(precision),
    recall: round(recall),
    f1: round(f1),
    severityCalibration: round(severityCalibration),
    matchedSeededDefectIds: [...matchedSeedIds].sort(),
    falseNegativeSeededDefectIds: falseNegativeSeededDefectIds.sort(),
    falsePositiveBridgeUnitIds: falsePositiveBridgeUnitIds.sort(),
  };
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
