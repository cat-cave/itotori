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
    cost: { costKind: "billed" as const, currency: "USD" as const, amountMicrosUsd: 980 },
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

  it("refuses when there are no agents to evaluate", () => {
    expect(() => evaluateQaAgents({ ...input(), agents: [] })).toThrow(QaAgentEvaluationError);
  });
});
