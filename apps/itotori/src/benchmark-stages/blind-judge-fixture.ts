// benchmark-blind-judge-panel — deterministic FIXTURE judge (test path only).
//
// §4 requires the judge to be abstracted so the unit tests are driven by
// DETERMINISTIC fixture-judges with NO real LLM calls. This module is that test
// double: a `BlindJudgeAdapter` whose scores come from a caller-supplied
// deterministic function (keyed on the STABLE candidate text, never the blind
// label — so two judges agree on the same real contestant despite different
// randomized orders). It also RECORDS every `BlindJudgeUnitInput` it received so
// a test can prove no provenance leaked to the judge (§4.2).
//
// Cost: a fixture judge makes no upstream call, so its provider run carries the
// canonical ZERO_COST + a local-only ZDR posture. It contributes $0 to the
// panel's real-cost aggregate (truthful — nothing was billed), and the
// no-hardcoded-cost audit stays clean (no fabricated billed amount anywhere).

import type {
  BenchmarkQualityRubric,
  BenchmarkRubricDimensionId,
  BenchmarkRubricScore,
} from "@itotori/localization-bridge-schema";
import { ZERO_COST } from "../providers/cost.js";
import { localOnlyRoutingPosture, type ProviderRunRecord } from "../providers/types.js";
import type {
  BlindCandidate,
  BlindJudgeAdapter,
  BlindJudgeUnitInput,
  JudgeCitation,
  JudgeDimensionScore,
  JudgeUnitScoring,
} from "./blind-judge-panel.js";
import type { DecodedGroundTruthContext } from "./decoded-context-feed.js";

/**
 * The deterministic scoring hook. Given the unit's decoded context, one
 * anonymized candidate, and a rubric dimension, it returns that dimension's
 * 0–4 score and (for sub-4 scores) a §4.3 citation. Keyed on `candidate.text`
 * (stable per real contestant) so agreement is controllable across judges.
 */
export type FixtureJudgeScoreFn = (args: {
  decodedContext: DecodedGroundTruthContext;
  candidate: BlindCandidate;
  dimensionId: BenchmarkRubricDimensionId;
  rubric: BenchmarkQualityRubric;
}) => { score: BenchmarkRubricScore; citation: JudgeCitation | null };

export type FixtureJudgeOptions = {
  judgeId: string;
  modelId: string;
  providerId: string;
  modelFamily: string;
  scoreFn: FixtureJudgeScoreFn;
};

/**
 * A deterministic fixture judge. Records the inputs it was handed (for the
 * provenance-anonymization test) and scores every candidate on every rubric
 * dimension via `scoreFn`.
 */
export class FixtureJudge implements BlindJudgeAdapter {
  readonly judgeId: string;
  readonly modelId: string;
  readonly providerId: string;
  readonly modelFamily: string;
  /** Every `BlindJudgeUnitInput` this judge received, in call order. */
  readonly receivedInputs: BlindJudgeUnitInput[] = [];
  private readonly scoreFn: FixtureJudgeScoreFn;

  constructor(options: FixtureJudgeOptions) {
    this.judgeId = options.judgeId;
    this.modelId = options.modelId;
    this.providerId = options.providerId;
    this.modelFamily = options.modelFamily;
    this.scoreFn = options.scoreFn;
  }

  async scoreUnit(input: BlindJudgeUnitInput): Promise<JudgeUnitScoring> {
    this.receivedInputs.push(input);
    const candidates = input.candidates.map((candidate) => ({
      blindLabel: candidate.blindLabel,
      dimensions: input.rubric.dimensions.map<JudgeDimensionScore>((dimension) => {
        const result = this.scoreFn({
          decodedContext: input.decodedContext,
          candidate,
          dimensionId: dimension.id,
          rubric: input.rubric,
        });
        return {
          dimensionId: dimension.id,
          score: result.score,
          citation: result.citation,
        };
      }),
    }));
    return {
      unitId: input.unitId,
      candidates,
      providerRun: fixtureJudgeProviderRun(
        this.judgeId,
        this.modelId,
        this.providerId,
        input.unitId,
      ),
    };
  }
}

/**
 * The canonical zero-cost, local-ZDR provider run a fixture judge emits. Uses
 * `ZERO_COST` (no billed amount is ever fabricated) and the local-only routing
 * posture (zdr:true — nothing left the process, so ZDR is trivially in force).
 */
export function fixtureJudgeProviderRun(
  judgeId: string,
  modelId: string,
  providerId: string,
  unitId: string,
): ProviderRunRecord {
  return {
    runId: `fixture-judge:${judgeId}:${unitId}`,
    taskKind: "llm_qa",
    startedAt: "1970-01-01T00:00:00.000Z",
    completedAt: "1970-01-01T00:00:00.000Z",
    latencyMs: 0,
    status: "succeeded",
    provider: {
      providerFamily: "fake",
      endpointFamily: "recorded-fixture",
      providerName: `fixture-judge:${judgeId}`,
      requestedModelId: modelId,
      actualModelId: modelId,
      requestedProviderId: providerId,
    },
    structuredOutputMode: "plain_json",
    retryCount: 0,
    errorClasses: [],
    fallbackUsed: false,
    fallbackPlan: [],
    tokenUsage: { tokenCountSource: "deterministic_counter", totalTokens: 0 },
    cost: ZERO_COST,
    routingPosture: localOnlyRoutingPosture(providerId),
    usageResponseJson: {},
    prompt: {
      presetId: `itotori-blind-judge-${judgeId}`,
      templateVersion: "1.0.0",
      promptHash: `sha256:fixture-${judgeId}`,
    },
  };
}
