// ITOTORI-091 — QA-agent evaluation benchmark stage.
//
// Evaluates QA agents against seeded findings using RECORDED model outputs and
// fixture truth data — no live provider credentials. For each agent it matches
// the recorded findings to the seeded-defect oracle BY LOCATION (affected unit),
// then computes detection precision/recall/F1 and the category / severity /
// root-cause calibration of the matched findings. False positives (a finding on
// an un-seeded unit) and false negatives (a seed no finding covered) stay
// tracked in the calibration summary so a QA benchmark can never silently drop
// them.
//
// Opted-in live mode is out of scope for the public fixture: the recorded run
// carries provider-ledger ids (providerRunId + model-output ids), never raw
// prompts or responses.

import type {
  BenchmarkFindingRecordV02,
  BenchmarkProviderRunV02,
  BenchmarkSeededDefectOracleV02,
  LocalizationAdjudicationStateV02,
  LocalizationQualityCategoryV02,
  LocalizationQualitySeverityV02,
  LocalizationRootCauseV02,
  QaAgentEvaluationV02,
  QaAgentMetricsV02,
} from "@itotori/localization-bridge-schema";
import { deterministicUuid7 } from "./ids.js";

const TAXONOMY_ID = "itotori-lqa-1" as const;
const TAXONOMY_VERSION = "itotori-quality-taxonomy-0.1.0" as const;

/** A recorded QA-agent finding (a model output), fixture-safe. */
export type QaAgentRecordedFinding = {
  /** UUID7 bridge-unit id the finding is about. */
  affectedUnitId: string;
  label: string;
  category: LocalizationQualityCategoryV02;
  qualitySubcategory?: string;
  qualitySeverity: LocalizationQualitySeverityV02;
  rootCause: LocalizationRootCauseV02;
  adjudicationState: LocalizationAdjudicationStateV02;
  evidenceSummary: string;
  expectedValue?: string;
  observedValue?: string;
  /** Whether the agent's finding could be scored against the oracle at all. */
  unscorable?: boolean;
  /** Recorded model-output provenance ids — not raw prompts/responses. */
  modelOutputId: string;
  outputHash: string;
  promptHash?: string;
  provider: string;
  model: string;
};

export type QaAgentRecordedRun = {
  qaAgentId: string;
  qaAgentVersion: string;
  evaluatedSystemId: string;
  /** Recorded `llm_qa` provider-run cost record (systemId injected here). */
  providerRun: Omit<BenchmarkProviderRunV02, "systemId">;
  recordedFindings: QaAgentRecordedFinding[];
  limitations: string[];
};

export type QaAgentEvaluationInput = {
  agents: QaAgentRecordedRun[];
  /** Fixture truth data: the seeded-defect oracle. */
  seededDefectOracle: BenchmarkSeededDefectOracleV02[];
};

export type QaAgentCalibrationSummary = {
  qaAgentId: string;
  evaluatedSystemId: string;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  matchedSeededDefectIds: string[];
  falsePositiveUnitIds: string[];
  falseNegativeSeededDefectIds: string[];
  metrics: QaAgentMetricsV02;
};

export type QaAgentEvaluationResult = {
  evaluations: QaAgentEvaluationV02[];
  findings: BenchmarkFindingRecordV02[];
  providerRuns: BenchmarkProviderRunV02[];
  /** Oracle with each seed's `matchedFindingIds` populated by the evaluation. */
  seededDefectOracle: BenchmarkSeededDefectOracleV02[];
  calibration: QaAgentCalibrationSummary[];
};

export class QaAgentEvaluationError extends Error {
  constructor(detail: string) {
    super(`qa-agent-evaluation stage refused: ${detail}`);
    this.name = "QaAgentEvaluationError";
  }
}

export function evaluateQaAgents(input: QaAgentEvaluationInput): QaAgentEvaluationResult {
  if (input.agents.length === 0) {
    throw new QaAgentEvaluationError("no recorded QA agents to evaluate");
  }

  const evaluations: QaAgentEvaluationV02[] = [];
  const findings: BenchmarkFindingRecordV02[] = [];
  const providerRuns: BenchmarkProviderRunV02[] = [];
  const calibration: QaAgentCalibrationSummary[] = [];
  // Accumulate matched finding ids per seeded defect across all agents.
  const matchedFindingIdsBySeed = new Map<string, string[]>();

  // Index seeds by affected unit id for location-based detection matching.
  const seedsByUnitId = new Map<string, BenchmarkSeededDefectOracleV02[]>();
  for (const seed of input.seededDefectOracle) {
    for (const ref of seed.affectedRefs) {
      const list = seedsByUnitId.get(ref.subjectId) ?? [];
      list.push(seed);
      seedsByUnitId.set(ref.subjectId, list);
    }
  }

  for (const agent of input.agents) {
    const agentFindingIds: string[] = [];
    const matchedFindings: Array<{
      finding: QaAgentRecordedFinding;
      seed: BenchmarkSeededDefectOracleV02;
    }> = [];
    const falsePositiveUnitIds: string[] = [];
    let unscorableCount = 0;
    let adjudicatedCount = 0;

    for (const recorded of agent.recordedFindings) {
      const finding = buildLlmQaFinding(agent, recorded);
      const matchedSeed = (seedsByUnitId.get(recorded.affectedUnitId) ?? [])[0];
      if (matchedSeed !== undefined) {
        finding.seededDefectId = matchedSeed.seededDefectId;
        matchedFindings.push({ finding: recorded, seed: matchedSeed });
        const ids = matchedFindingIdsBySeed.get(matchedSeed.seededDefectId) ?? [];
        ids.push(finding.findingId);
        matchedFindingIdsBySeed.set(matchedSeed.seededDefectId, ids);
      } else if (recorded.unscorable !== true) {
        falsePositiveUnitIds.push(recorded.affectedUnitId);
      }
      if (recorded.unscorable === true) {
        unscorableCount += 1;
      }
      if (recorded.adjudicationState !== "unreviewed") {
        adjudicatedCount += 1;
      }
      findings.push(finding);
      agentFindingIds.push(finding.findingId);
    }

    const providerRun: BenchmarkProviderRunV02 = {
      ...agent.providerRun,
      systemId: agent.evaluatedSystemId,
    };
    providerRuns.push(providerRun);

    const matchedSeedIds = new Set(matchedFindings.map((entry) => entry.seed.seededDefectId));
    const allSeeds = input.seededDefectOracle;
    const totalSeeds = allSeeds.length;
    // GRANULARITY (it091): detection is scored at SEED level. A seed is a true
    // positive iff >=1 recorded finding matched it, counted ONCE regardless of
    // how many findings pointed at that seed. This keeps truePositives coherent
    // with the seed-level false negatives (truePositives + falseNegatives ==
    // totalSeeds) and bounds recall = truePositives / totalSeeds at <= 1 even
    // when several findings collapse onto one seed. Precision is measured over
    // the FINDING population instead — the findings that could be scored against
    // the oracle (matched findings vs. false-positive findings) — so its
    // numerator and denominator share the finding granularity. Recall shares the
    // seed granularity, and F1 is the harmonic mean of those two internally
    // coherent values.
    const truePositives = matchedSeedIds.size;
    const falsePositives = falsePositiveUnitIds.length;
    // Finding-level count of matched findings backs the finding-scoped precision
    // (distinct from the seed-level truePositives above).
    const matchedFindingCount = matchedFindings.length;
    const falseNegativeSeedIds = allSeeds
      .map((seed) => seed.seededDefectId)
      .filter((seedId) => !matchedSeedIds.has(seedId));
    const findingsEmitted = agent.recordedFindings.length;
    const scorableFindings = findingsEmitted - unscorableCount;

    const seededRecall = totalSeeds === 0 ? 1 : truePositives / totalSeeds;
    const seededPrecision =
      matchedFindingCount + falsePositives === 0
        ? 1
        : matchedFindingCount / (matchedFindingCount + falsePositives);
    const f1 =
      seededPrecision + seededRecall === 0
        ? 0
        : (2 * seededPrecision * seededRecall) / (seededPrecision + seededRecall);

    const categoryAccuracy = ratioOf(
      matchedFindings.filter((m) => m.finding.category === m.seed.category).length,
      matchedFindings.length,
    );
    const qualitySeverityAccuracy = ratioOf(
      matchedFindings.filter((m) => m.finding.qualitySeverity === m.seed.qualitySeverity).length,
      matchedFindings.length,
    );
    const rootCauseAccuracy = ratioOf(
      matchedFindings.filter((m) => m.finding.rootCause === m.seed.expectedRootCause).length,
      matchedFindings.length,
    );
    const criticalSeeds = allSeeds.filter((seed) => seed.qualitySeverity === "critical");
    const criticalRecall = ratioOf(
      criticalSeeds.filter((seed) => matchedSeedIds.has(seed.seededDefectId)).length,
      criticalSeeds.length,
    );
    const humanConfirmedPrecision = ratioOf(
      matchedFindings.filter((m) => m.finding.adjudicationState === "confirmed").length,
      scorableFindings,
    );

    const metrics: QaAgentMetricsV02 = {
      seededRecall: round(seededRecall),
      seededPrecision: round(seededPrecision),
      f1: round(f1),
      categoryAccuracy: round(categoryAccuracy),
      qualitySeverityAccuracy: round(qualitySeverityAccuracy),
      rootCauseAccuracy: round(rootCauseAccuracy),
      criticalRecall: round(criticalRecall),
      unscorableRate: round(ratioOf(unscorableCount, findingsEmitted)),
      humanConfirmedPrecision: round(humanConfirmedPrecision),
      findingsEmitted,
      scorableFindings,
      adjudicatedFindings: adjudicatedCount,
    };

    evaluations.push({
      qaAgentEvaluationId: deterministicUuid7(
        "qa-agent-evaluation",
        agent.qaAgentId,
        agent.evaluatedSystemId,
      ),
      qaAgentId: agent.qaAgentId,
      qaAgentVersion: agent.qaAgentVersion,
      evaluatedSystemId: agent.evaluatedSystemId,
      providerRunIds: [providerRun.providerRunId],
      findingIds: agentFindingIds,
      metrics,
      limitations: agent.limitations,
    });

    calibration.push({
      qaAgentId: agent.qaAgentId,
      evaluatedSystemId: agent.evaluatedSystemId,
      truePositives,
      falsePositives,
      falseNegatives: falseNegativeSeedIds.length,
      matchedSeededDefectIds: [...matchedSeedIds],
      falsePositiveUnitIds,
      falseNegativeSeededDefectIds: falseNegativeSeedIds,
      metrics,
    });
  }

  const seededDefectOracle = input.seededDefectOracle.map((seed) => ({
    ...seed,
    matchedFindingIds: matchedFindingIdsBySeed.get(seed.seededDefectId) ?? [],
  }));

  return { evaluations, findings, providerRuns, seededDefectOracle, calibration };
}

function buildLlmQaFinding(
  agent: QaAgentRecordedRun,
  recorded: QaAgentRecordedFinding,
): BenchmarkFindingRecordV02 {
  const findingId = deterministicUuid7(
    "qa-agent-finding",
    agent.qaAgentId,
    agent.evaluatedSystemId,
    recorded.affectedUnitId,
    recorded.category,
  );
  const provenanceId = deterministicUuid7("qa-agent-provenance", findingId);
  const evidenceId = deterministicUuid7("qa-agent-evidence", findingId);
  return {
    findingId,
    systemId: agent.evaluatedSystemId,
    taxonomyId: TAXONOMY_ID,
    taxonomyVersion: TAXONOMY_VERSION,
    detectorKind: "llm_qa",
    category: recorded.category,
    ...(recorded.qualitySubcategory !== undefined
      ? { qualitySubcategory: recorded.qualitySubcategory }
      : {}),
    qualitySeverity: recorded.qualitySeverity,
    rootCause: recorded.rootCause,
    adjudicationState: recorded.adjudicationState,
    affectedRefs: [
      {
        subjectKind: "bridge_unit",
        subjectId: recorded.affectedUnitId,
        label: recorded.label,
      },
    ],
    evidence: [
      {
        evidenceId,
        evidenceKind: "text_excerpt",
        summary: recorded.evidenceSummary,
        subjectRef: {
          subjectKind: "bridge_unit",
          subjectId: recorded.affectedUnitId,
          label: recorded.label,
        },
        ...(recorded.expectedValue !== undefined ? { expectedValue: recorded.expectedValue } : {}),
        ...(recorded.observedValue !== undefined ? { observedValue: recorded.observedValue } : {}),
        provenanceIds: [provenanceId],
      },
    ],
    provenance: [
      {
        provenanceId,
        provenanceKind: "model_output",
        modelOutputId: recorded.modelOutputId,
        provider: recorded.provider,
        model: recorded.model,
        outputHash: recorded.outputHash,
        ...(recorded.promptHash !== undefined ? { promptHash: recorded.promptHash } : {}),
      },
    ],
  };
}

function ratioOf(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
