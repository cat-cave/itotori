// benchmark-blind-judge-panel — the REAL ZDR ModelProvider-backed judge (§4.1).
//
// This is the live-path counterpart to the deterministic FixtureJudge. It wraps
// a `ModelProvider` (an OpenRouter ZDR-routed pair on the live path) and adapts
// it to `BlindJudgeAdapter`:
//   - builds a `ModelInvocationRequest` (taskKind `llm_qa`, the (modelId,
//     providerId) pair, a per-call USD cap) from the BLINDED unit input,
//   - invokes the provider,
//   - parses the judge's structured JSON into the §4.3 output contract
//     (per-candidate, per-dimension 0–4 score + cited reasoning), rejecting any
//     malformed/out-of-contract response rather than silently accepting garbage,
//   - passes the provider's REAL `ProviderRunRecord` straight through so the
//     panel reads cost from `usage.cost` only (§4.1) and never approximates.
//
// §4.1 ZDR gate: a response whose wire routing posture is not `zdr:true` is
// DISQUALIFIED (thrown), never scored — the panel is ZDR-routed only.

import type {
  BenchmarkRubricDimensionId,
  BenchmarkRubricScore,
} from "@itotori/localization-bridge-schema";
import {
  BENCHMARK_RUBRIC_DIMENSION_IDS,
  BENCHMARK_RUBRIC_SCORES,
} from "@itotori/localization-bridge-schema";
import { createHash } from "node:crypto";
import { executeStructuredInvocation } from "../orchestrator/invocation-supervisor.js";
import { selectStructuredOutputRequest } from "../providers/structured-output.js";
import type {
  JsonObject,
  ModelCapabilities,
  ModelInvocationRequest,
  ModelProvider,
} from "../providers/types.js";
import type {
  BlindJudgeAdapter,
  BlindJudgeUnitInput,
  JudgeCandidateScoring,
  JudgeCitation,
  JudgeDimensionScore,
  JudgeUnitScoring,
} from "./blind-judge-panel.js";

export class ZdrJudgeError extends Error {
  constructor(detail: string) {
    super(`blind-judge zdr adapter refused: ${detail}`);
    this.name = "ZdrJudgeError";
  }
}

export type ZdrModelJudgeOptions = {
  judgeId: string;
  modelId: string;
  providerId: string;
  modelFamily: string;
  provider: ModelProvider;
  capabilities: ModelCapabilities;
  /** Per-call USD cap mirrored to the request and enforced against usage.cost. */
  maxPriceUsd: number;
};

const STRUCTURED_OUTPUT_NAME = "itotori_blind_judge_scoring";

/**
 * The real ZDR judge. Same `BlindJudgeAdapter` seam the FixtureJudge implements,
 * so the panel orchestrator and its bias guards are byte-identical across the
 * test and live paths — only the scoring source differs.
 */
export class ZdrModelJudge implements BlindJudgeAdapter {
  readonly judgeId: string;
  readonly modelId: string;
  readonly providerId: string;
  readonly modelFamily: string;
  private readonly provider: ModelProvider;
  private readonly capabilities: ModelCapabilities;
  private readonly maxPriceUsd: number;

  constructor(options: ZdrModelJudgeOptions) {
    this.judgeId = options.judgeId;
    this.modelId = options.modelId;
    this.providerId = options.providerId;
    this.modelFamily = options.modelFamily;
    this.provider = options.provider;
    this.capabilities = options.capabilities;
    this.maxPriceUsd = options.maxPriceUsd;
  }

  async scoreUnit(input: BlindJudgeUnitInput): Promise<JudgeUnitScoring> {
    const request = this.buildRequest(input);
    const supervised = await executeStructuredInvocation(this.provider, {
      request,
      parse: (raw) => parseJudgeScoringJson(raw, input),
      validateParsed: () => undefined,
      validateResponse: (invocation) => {
        const run = invocation.providerRun;
        // §4.1 — validate posture before accepting the physical attempt. A
        // non-ZDR serve is disqualified and receives the same bounded
        // corrective route handling as every other semantic failure.
        if (run.routingPosture.zdr !== true) {
          throw new ZdrJudgeError(
            `judge '${this.judgeId}' response was not ZDR-routed (routingPosture.zdr=${String(run.routingPosture.zdr)})`,
          );
        }
        return invocation.content ?? "";
      },
      isSchemaValidationError: (error) => error instanceof ZdrJudgeError,
      successDecision: "advance",
    });
    const run = supervised.invocation.providerRun;
    const candidates = supervised.parsed;
    return { unitId: input.unitId, candidates, providerRun: run };
  }

  private buildRequest(input: BlindJudgeUnitInput): ModelInvocationRequest {
    const promptHash = `sha256:${createHash("sha256")
      .update(`blind-judge:${this.judgeId}:${input.unitId}`)
      .digest("hex")}`;
    const userPayload = {
      unitId: input.unitId,
      decodedContext: input.decodedContext,
      dimensions: input.rubric.dimensions.map((d) => ({
        id: d.id,
        title: d.title,
        criterion: d.criterion,
      })),
      scale: input.rubric.scale.map((s) => ({ score: s.score, anchor: s.anchor })),
      candidates: input.candidates.map((c) => ({
        blindLabel: c.blindLabel,
        candidateText: c.candidateText,
      })),
    };
    return {
      taskKind: "llm_qa",
      modelId: this.modelId,
      providerId: this.providerId,
      inputClassification: "private_corpus",
      messages: [
        {
          role: "system",
          content:
            "You are a blind localization-quality judge. Score EVERY candidate on EVERY rubric dimension " +
            "using the 0-4 anchored scale, judging in-context against the decoded ground truth ONLY. " +
            "Longer is NOT better; reward correctness-in-context. You do not know which system produced any " +
            "candidate. For any score below 4 you MUST attach a citation " +
            "{ sourceSpan, decodedContextUsed, rationale }; a sub-4 score without a complete citation is dropped. " +
            "Return ONLY a JSON object of shape " +
            '{ "candidates": [ { "blindLabel": string, "dimensions": [ { "dimensionId": string, "score": 0..4, ' +
            '"citation": { "sourceSpan": string, "decodedContextUsed": string, "rationale": string } | null } ] } ] }.',
        },
        { role: "user", content: JSON.stringify(userPayload) },
      ],
      structuredOutput: selectStructuredOutputRequest(this.capabilities, {
        name: STRUCTURED_OUTPUT_NAME,
        schema: judgeScoringJsonSchema() as unknown as JsonObject,
        strict: true,
      }),
      generation: { temperature: 0, maxOutputTokens: 4000 },
      maxPriceUsd: this.maxPriceUsd,
      prompt: {
        presetId: `itotori-blind-judge-${this.judgeId}`,
        templateVersion: "1.0.0",
        promptHash,
        schemaVersion: "itotori.prompt-preset.v0",
        configSnapshot: { unitId: input.unitId, rubricVersion: input.rubric.rubricVersion },
      },
      fallbackModels: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Strict parser — reject-before-accept for the §4.3 output contract.
// ---------------------------------------------------------------------------

const DIMENSION_ID_SET = new Set<string>(BENCHMARK_RUBRIC_DIMENSION_IDS);
const SCORE_SET = new Set<number>(BENCHMARK_RUBRIC_SCORES);

/**
 * Parse + strictly validate a judge model's JSON into `JudgeCandidateScoring[]`.
 * Every candidate must carry a known blind label from THIS unit and score every
 * rubric dimension exactly once with an in-range 0–4 score; a malformed shape,
 * unknown label, missing dimension, or out-of-range score is a hard error.
 */
export function parseJudgeScoringJson(
  content: string | null,
  input: BlindJudgeUnitInput,
): JudgeCandidateScoring[] {
  if (content === null || content.trim().length === 0) {
    throw new ZdrJudgeError(`unit '${input.unitId}' judge returned empty content`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new ZdrJudgeError(
      `unit '${input.unitId}' judge content is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ZdrJudgeError(`unit '${input.unitId}' judge response must be a JSON object`);
  }
  const candidatesRaw = (parsed as Record<string, unknown>).candidates;
  if (!Array.isArray(candidatesRaw)) {
    throw new ZdrJudgeError(`unit '${input.unitId}' judge response.candidates must be an array`);
  }

  const expectedLabels = new Set(input.candidates.map((c) => c.blindLabel));
  const requiredDimensions = new Set<string>(input.rubric.dimensions.map((d) => d.id));
  const seenLabels = new Set<string>();
  const out: JudgeCandidateScoring[] = [];

  for (const candidateRaw of candidatesRaw) {
    if (typeof candidateRaw !== "object" || candidateRaw === null) {
      throw new ZdrJudgeError(`unit '${input.unitId}' candidate must be an object`);
    }
    const record = candidateRaw as Record<string, unknown>;
    const blindLabel = record.blindLabel;
    if (typeof blindLabel !== "string" || !expectedLabels.has(blindLabel)) {
      throw new ZdrJudgeError(
        `unit '${input.unitId}' candidate has unknown blind label ${JSON.stringify(blindLabel)}`,
      );
    }
    if (seenLabels.has(blindLabel)) {
      throw new ZdrJudgeError(`unit '${input.unitId}' candidate '${blindLabel}' scored twice`);
    }
    seenLabels.add(blindLabel);
    const dimensionsRaw = record.dimensions;
    if (!Array.isArray(dimensionsRaw)) {
      throw new ZdrJudgeError(
        `unit '${input.unitId}' candidate '${blindLabel}' dimensions must be an array`,
      );
    }
    const seenDimensions = new Set<string>();
    const dimensions: JudgeDimensionScore[] = [];
    for (const dimRaw of dimensionsRaw) {
      if (typeof dimRaw !== "object" || dimRaw === null) {
        throw new ZdrJudgeError(
          `unit '${input.unitId}' '${blindLabel}' dimension must be an object`,
        );
      }
      const dimRecord = dimRaw as Record<string, unknown>;
      const dimensionId = dimRecord.dimensionId;
      if (typeof dimensionId !== "string" || !DIMENSION_ID_SET.has(dimensionId)) {
        throw new ZdrJudgeError(
          `unit '${input.unitId}' '${blindLabel}' has unknown dimensionId ${JSON.stringify(dimensionId)}`,
        );
      }
      if (seenDimensions.has(dimensionId)) {
        throw new ZdrJudgeError(
          `unit '${input.unitId}' '${blindLabel}' scored dimension '${dimensionId}' twice`,
        );
      }
      seenDimensions.add(dimensionId);
      const score = dimRecord.score;
      if (typeof score !== "number" || !SCORE_SET.has(score)) {
        throw new ZdrJudgeError(
          `unit '${input.unitId}' '${blindLabel}'.${dimensionId} score ${JSON.stringify(score)} is not a 0-4 rubric score`,
        );
      }
      dimensions.push({
        dimensionId: dimensionId as BenchmarkRubricDimensionId,
        score: score as BenchmarkRubricScore,
        citation: parseCitation(dimRecord.citation, input.unitId, blindLabel, dimensionId),
      });
    }
    const missing = [...requiredDimensions].filter((d) => !seenDimensions.has(d));
    if (missing.length > 0) {
      throw new ZdrJudgeError(
        `unit '${input.unitId}' '${blindLabel}' did not score dimension(s): ${missing.join(", ")}`,
      );
    }
    out.push({ blindLabel, dimensions });
  }

  const missingLabels = [...expectedLabels].filter((l) => !seenLabels.has(l));
  if (missingLabels.length > 0) {
    throw new ZdrJudgeError(
      `unit '${input.unitId}' judge did not score candidate(s): ${missingLabels.join(", ")}`,
    );
  }
  return out;
}

function parseCitation(
  raw: unknown,
  unitId: string,
  blindLabel: string,
  dimensionId: string,
): JudgeCitation | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ZdrJudgeError(
      `unit '${unitId}' '${blindLabel}'.${dimensionId} citation must be an object or null`,
    );
  }
  const record = raw as Record<string, unknown>;
  const sourceSpan = record.sourceSpan;
  const decodedContextUsed = record.decodedContextUsed;
  const rationale = record.rationale;
  if (
    typeof sourceSpan !== "string" ||
    typeof decodedContextUsed !== "string" ||
    typeof rationale !== "string"
  ) {
    throw new ZdrJudgeError(
      `unit '${unitId}' '${blindLabel}'.${dimensionId} citation must carry string sourceSpan/decodedContextUsed/rationale`,
    );
  }
  return { sourceSpan, decodedContextUsed, rationale };
}

/** The JSON schema forwarded on the wire when the pair supports json_schema. */
function judgeScoringJsonSchema(): Record<string, unknown> {
  const citationSchema = {
    type: ["object", "null"],
    properties: {
      sourceSpan: { type: "string" },
      decodedContextUsed: { type: "string" },
      rationale: { type: "string" },
    },
    required: ["sourceSpan", "decodedContextUsed", "rationale"],
    additionalProperties: false,
  };
  return {
    type: "object",
    properties: {
      candidates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            blindLabel: { type: "string" },
            dimensions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  dimensionId: { type: "string", enum: [...BENCHMARK_RUBRIC_DIMENSION_IDS] },
                  score: { type: "integer", enum: [...BENCHMARK_RUBRIC_SCORES] },
                  citation: citationSchema,
                },
                required: ["dimensionId", "score", "citation"],
                additionalProperties: false,
              },
            },
          },
          required: ["blindLabel", "dimensions"],
          additionalProperties: false,
        },
      },
    },
    required: ["candidates"],
    additionalProperties: false,
  };
}
