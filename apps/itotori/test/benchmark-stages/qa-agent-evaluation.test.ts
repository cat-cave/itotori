// ITOTORI-091 — QA-agent evaluation stage unit tests (precision/recall +
// severity calibration against seeded findings, false positives, and false
// negatives) using recorded model outputs only.

import { describe, expect, it } from "vitest";
import {
  QaAgentEvaluationError,
  evaluateQaAgents,
  type QaAgentEvaluationInput,
  type QaAgentRecordedRun,
} from "../../src/benchmark-stages/index.js";

const U2 = "019ed010-0000-7000-8000-000000000002";
const U3 = "019ed010-0000-7000-8000-000000000003";
const U4 = "019ed010-0000-7000-8000-000000000004";

function seed(seededDefectId: string, unitId: string, category: string, severity: string) {
  return {
    seededDefectId,
    fixtureOrCorpusRefId: "itotori-public-fixture",
    seedKind: "wrong_glossary_term",
    targetLocale: "en-US",
    affectedRefs: [{ subjectKind: "bridge_unit" as const, subjectId: unitId, label: unitId }],
    category: category as never,
    qualitySeverity: severity as never,
    expectedRootCause: "benchmark_seed" as never,
    expectedDetectorKinds: ["llm_qa"] as never,
    matchedFindingIds: [],
    publicContent: true,
  };
}

function providerRun() {
  return {
    providerRunId: "019ed010-0000-7000-8000-000000000103",
    taskKind: "llm_qa" as const,
    startedAt: "2026-06-28T12:01:10.000Z",
    completedAt: "2026-06-28T12:01:12.000Z",
    status: "succeeded" as const,
    provider: {
      providerFamily: "recorded" as const,
      endpointFamily: "recorded-fixture",
      providerName: "recorded-provider",
      requestedModelId: "fixture-qa-model-v1",
      actualModelId: "fixture-qa-model-v1",
    },
    prompt: { promptPresetId: "itotori-qa-agent-lqa-v1", promptTemplateVersion: "1.0.0" },
    structuredOutputMode: "json_schema",
    retryCount: 0,
    errorClasses: [],
    fallbackUsed: false,
    tokenUsage: {
      tokenCountSource: "provider_reported" as const,
      promptTokens: 20,
      completionTokens: 10,
      totalTokens: 30,
    },
    cost: { costKind: "billed" as const, currency: "USD" as const, amountMicrosUsd: 980 }, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
  };
}

function recordedFinding(unitId: string, category: string, severity: string) {
  return {
    affectedUnitId: unitId,
    label: unitId,
    category: category as never,
    qualitySeverity: severity as never,
    rootCause: "benchmark_seed" as never,
    adjudicationState: "confirmed" as never,
    evidenceSummary: `agent finding on ${unitId}`,
    modelOutputId: `019ed010-0000-7000-8000-0000000008${unitId.slice(-2)}`,
    outputHash: `sha256:${"4".repeat(64)}`,
    provider: "recorded-provider",
    model: "fixture-qa-model-v1",
  };
}

function input(): QaAgentEvaluationInput {
  const agent: QaAgentRecordedRun = {
    qaAgentId: "terminology-qa-agent",
    qaAgentVersion: "0.2.0",
    evaluatedSystemId: "itotori-draft",
    limitations: ["smoke"],
    providerRun: providerRun(),
    recordedFindings: [
      // matches seed A by location, but mis-labels severity (minor vs major)
      recordedFinding(U2, "terminology", "minor"),
      // un-seeded unit → false positive
      recordedFinding(U4, "style", "major"),
    ],
  };
  return {
    agents: [agent],
    seededDefectOracle: [
      seed("seed-A", U2, "terminology", "major"),
      seed("seed-B", U3, "accuracy", "critical"),
    ],
  };
}

describe("qa-agent-evaluation stage", () => {
  it("computes precision/recall/F1 with false positives and false negatives tracked", () => {
    const result = evaluateQaAgents(input());
    const metrics = result.evaluations[0].metrics;
    expect(metrics.seededRecall).toBe(0.5); // 1 of 2 seeds matched
    expect(metrics.seededPrecision).toBe(0.5); // 1 TP, 1 FP
    expect(metrics.f1).toBe(0.5);

    const calibration = result.calibration[0];
    expect(calibration.truePositives).toBe(1);
    expect(calibration.falsePositives).toBe(1);
    expect(calibration.falseNegatives).toBe(1);
    expect(calibration.falseNegativeSeededDefectIds).toEqual(["seed-B"]);
    expect(calibration.falsePositiveUnitIds).toEqual([U4]);
  });

  it("counts a seed matched by multiple findings once (seed-level recall <= 1)", () => {
    // Two DISTINCT findings (different category => different finding id) both
    // land on U2, so both match seed-A by location. Under the old finding-level
    // truePositives this produced truePositives=2 while falseNegatives stayed
    // seed-level (1) — an inconsistent 2+1=3 over only 2 seeds, and a recall
    // numerator that could exceed the seed denominator. Reconciled to seed level
    // the seed is a single true positive.
    const agent: QaAgentRecordedRun = {
      qaAgentId: "terminology-qa-agent",
      qaAgentVersion: "0.2.0",
      evaluatedSystemId: "itotori-draft",
      limitations: ["smoke"],
      providerRun: providerRun(),
      recordedFindings: [
        recordedFinding(U2, "terminology", "major"),
        recordedFinding(U2, "accuracy", "major"),
      ],
    };
    const result = evaluateQaAgents({
      agents: [agent],
      seededDefectOracle: [
        seed("seed-A", U2, "terminology", "major"),
        seed("seed-B", U3, "accuracy", "critical"),
      ],
    });

    const calibration = result.calibration[0];
    // Seed counted ONCE, not once per matching finding.
    expect(calibration.truePositives).toBe(1);
    expect(calibration.matchedSeededDefectIds).toEqual(["seed-A"]);
    expect(calibration.falseNegatives).toBe(1); // seed-B unmatched
    // Internal consistency: truePositives + falseNegatives == totalSeeds.
    expect(calibration.truePositives + calibration.falseNegatives).toBe(2);

    const metrics = result.evaluations[0].metrics;
    // recall is seed-level and can never exceed 1 despite 2 findings on 1 seed.
    expect(metrics.seededRecall).toBe(0.5);
    expect(metrics.seededRecall).toBeLessThanOrEqual(1);
    // precision is finding-level: 2 matched findings, 0 false positives => 1.
    expect(metrics.seededPrecision).toBe(1);
    // F1 is the harmonic mean of the two coherent values.
    expect(metrics.f1).toBeCloseTo((2 * 1 * 0.5) / (1 + 0.5), 6);
    // Both findings are recorded against the single matched seed.
    const seedA = result.seededDefectOracle.find((s) => s.seededDefectId === "seed-A");
    expect(seedA?.matchedFindingIds).toHaveLength(2);
  });

  it("matches EVERY seed on a multi-seed unit independently (not first-only)", () => {
    // U2 carries THREE seeds; a single finding lands on U2. Location-based
    // matching credits ALL of them, so seeds A and B on U2 are both found. Seed
    // C lives on an un-covered unit (U3) and stays a false negative. Under the
    // old first-only match, U2's finding matched seed-A alone, so seeds B and C
    // were both false negatives (1 TP + 2 FN); the fix yields 2 TP + 1 FN.
    const agent: QaAgentRecordedRun = {
      qaAgentId: "terminology-qa-agent",
      qaAgentVersion: "0.2.0",
      evaluatedSystemId: "itotori-draft",
      limitations: ["smoke"],
      providerRun: providerRun(),
      recordedFindings: [recordedFinding(U2, "terminology", "major")],
    };
    const result = evaluateQaAgents({
      agents: [agent],
      seededDefectOracle: [
        seed("seed-A", U2, "terminology", "major"),
        seed("seed-B", U2, "accuracy", "major"),
        seed("seed-C", U3, "accuracy", "critical"),
      ],
    });

    const calibration = result.calibration[0];
    // Both seeds on U2 are matched independently — not capped at the first.
    expect(calibration.truePositives).toBe(2);
    expect(calibration.matchedSeededDefectIds).toEqual(["seed-A", "seed-B"]);
    expect(calibration.falseNegatives).toBe(1);
    expect(calibration.falseNegativeSeededDefectIds).toEqual(["seed-C"]);
    // Internal consistency preserved: truePositives + falseNegatives == totalSeeds.
    expect(calibration.truePositives + calibration.falseNegatives).toBe(3);
    expect(calibration.falsePositives).toBe(0);

    const metrics = result.evaluations[0].metrics;
    // Seed-level recall reflects both matched seeds: 2 of 3.
    expect(metrics.seededRecall).toBeCloseTo(2 / 3, 6);
    // The single finding matched (>=1 seed), 0 false positives => precision 1.
    expect(metrics.seededPrecision).toBe(1);
    // The one finding is recorded against BOTH seeds it covers on the unit.
    const seedA = result.seededDefectOracle.find((s) => s.seededDefectId === "seed-A");
    const seedB = result.seededDefectOracle.find((s) => s.seededDefectId === "seed-B");
    expect(seedA?.matchedFindingIds).toHaveLength(1);
    expect(seedB?.matchedFindingIds).toEqual(seedA?.matchedFindingIds);
  });

  it("scores category/severity/root-cause calibration against the matched seed", () => {
    const metrics = evaluateQaAgents(input()).evaluations[0].metrics;
    expect(metrics.categoryAccuracy).toBe(1); // terminology == terminology
    expect(metrics.qualitySeverityAccuracy).toBe(0); // minor != major
    expect(metrics.rootCauseAccuracy).toBe(1); // benchmark_seed == benchmark_seed
    expect(metrics.criticalRecall).toBe(0); // critical seed-B unmatched
  });

  it("emits llm_qa findings, stamps matched seeds, and covers them in the evaluation", () => {
    const result = evaluateQaAgents(input());
    expect(result.findings).toHaveLength(2);
    expect(result.findings.every((f) => f.detectorKind === "llm_qa")).toBe(true);
    const matched = result.findings.find((f) => f.affectedRefs[0].subjectId === U2);
    expect(matched?.seededDefectId).toBe("seed-A");
    // The seeded oracle now records which finding matched it.
    const seedA = result.seededDefectOracle.find((s) => s.seededDefectId === "seed-A");
    expect(seedA?.matchedFindingIds).toEqual([matched?.findingId]);
    // QA coverage: every emitted finding id is listed in the evaluation.
    expect(new Set(result.evaluations[0].findingIds)).toEqual(
      new Set(result.findings.map((f) => f.findingId)),
    );
    expect(result.evaluations[0].providerRunIds).toEqual([providerRun().providerRunId]);
  });

  it("is reproducible across runs", () => {
    expect(evaluateQaAgents(input())).toEqual(evaluateQaAgents(input()));
  });

  // ITOTORI-027 — the harness EXCLUDES unscorable findings from the
  // false-positive count, and `buildLlmQaFinding` MUST persist the unscorable
  // flag onto the finding record so the dashboard's `summarizeQaAgents`
  // reproduces the same exclusion from the persisted data (without
  // re-running the harness). The persisted flag is the durable signal.
  it("persists the unscorable flag on the emitted finding record", () => {
    const agent: QaAgentRecordedRun = {
      qaAgentId: "terminology-qa-agent",
      qaAgentVersion: "0.2.0",
      evaluatedSystemId: "itotori-draft",
      limitations: ["smoke"],
      providerRun: providerRun(),
      recordedFindings: [
        // matched finding on a seeded unit — unscorable flag is absent
        recordedFinding(U2, "terminology", "major"),
        // un-seeded unit — not unscorable, would be a false positive
        recordedFinding(U4, "style", "major"),
        // unscorable finding on an un-seeded unit — must be PERSISTED as
        // `unscorable: true` so downstream can exclude it from FP without
        // re-running the harness.
        { ...recordedFinding(U4, "accuracy", "major"), unscorable: true },
      ],
    };
    const result = evaluateQaAgents({
      agents: [agent],
      seededDefectOracle: [
        seed("seed-A", U2, "terminology", "major"),
        seed("seed-B", U3, "accuracy", "critical"),
      ],
    });

    // The matched finding carries no unscorable flag (it was a real match).
    const matched = result.findings.find((f) => f.affectedRefs[0].subjectId === U2);
    expect(matched?.unscorable).toBeUndefined();
    expect(matched?.seededDefectId).toBe("seed-A");

    // The unscorable finding on U4 carries `unscorable: true` on the
    // PERSISTED record. The harness also excludes it from the FP count
    // (falsePositiveUnitIds), keeping internal + persisted signals aligned.
    const unscorablePersist = result.findings.find((f) => f.unscorable === true);
    expect(unscorablePersist?.affectedRefs[0].subjectId).toBe(U4);
    expect(unscorablePersist?.seededDefectId).toBeUndefined();
    expect(result.calibration[0].falsePositives).toBe(1);
    expect(result.calibration[0].falsePositiveUnitIds).toEqual([U4]);
    // The harness also surfaces the unscorable count separately so the
    // scorableFindings metric stays coherent.
    expect(result.evaluations[0].metrics.scorableFindings).toBe(2);
    expect(result.evaluations[0].metrics.unscorableRate).toBeCloseTo(1 / 3, 6);
  });

  it("refuses when there are no agents to evaluate", () => {
    expect(() => evaluateQaAgents({ ...input(), agents: [] })).toThrow(QaAgentEvaluationError);
  });
});
