import { FINDING_KINDS, TRIAGE_SEVERITIES } from "@itotori/localization-bridge-schema";
import type { JsonObject, JsonValue } from "../providers/types.js";
import type {
  AgentJobInput,
  AgentJudgmentOutput,
  AgentOutputFinding,
  DeterministicToolJobInput,
  RegistryInvocationContext,
  RegistrySchemaDescriptor,
  StableJsonHash,
} from "./registry.js";

export type TranslationQualityJudgeInput = JsonObject & {
  sourceText: string;
  targetText: string;
  targetLocale: string;
  protectedSpans: string[];
};

export type TranslationQualityJudgeOutput = AgentJudgmentOutput & {
  outputKind: "score";
  score: number;
  rationales: [string, ...string[]];
  findings: AgentOutputFinding[];
};

export type ProtectedSpanCheckInput = JsonObject & {
  targetText: string;
  protectedSpans: string[];
};

export type ProtectedSpanCheckFinding = JsonObject & {
  span: string;
  rationale: string;
};

export type ProtectedSpanCheckOutput = JsonObject & {
  outputKind: "protected_span_check";
  missingProtectedSpans: string[];
  findings: ProtectedSpanCheckFinding[];
};

export const translationQualityJudgeInputSchema = {
  schemaId: "itotori.agent.translation-quality-judge.input",
  schemaVersion: "1.0.0",
  description: "Source, target, target locale, and protected spans for LLM quality judgment.",
  jsonSchema: {
    type: "object",
    required: ["sourceText", "targetText", "targetLocale", "protectedSpans"],
    additionalProperties: false,
    properties: {
      sourceText: { type: "string", minLength: 1 },
      targetText: { type: "string", minLength: 1 },
      targetLocale: { type: "string", minLength: 1 },
      protectedSpans: { type: "array", items: { type: "string" } },
    },
  },
} satisfies RegistrySchemaDescriptor;

export const translationQualityJudgeOutputSchema = {
  schemaId: "itotori.agent.translation-quality-judge.output",
  schemaVersion: "1.0.0",
  description: "A score output with rationales and structured findings, never confidence fields.",
  jsonSchema: {
    type: "object",
    required: ["outputKind", "score", "rationales", "findings"],
    additionalProperties: false,
    properties: {
      outputKind: { const: "score" },
      score: { type: "number", minimum: 0, maximum: 1 },
      rationales: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
      findings: {
        type: "array",
        items: {
          type: "object",
          required: ["findingKind", "severity", "title", "rationale", "evidence"],
          additionalProperties: false,
          properties: {
            findingKind: { enum: [...FINDING_KINDS] },
            severity: { enum: [...TRIAGE_SEVERITIES] },
            title: { type: "string", minLength: 1 },
            rationale: { type: "string", minLength: 1 },
            evidence: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
          },
        },
      },
    },
  },
} satisfies RegistrySchemaDescriptor;

export const protectedSpanCheckInputSchema = {
  schemaId: "itotori.tool.protected-span-check.input",
  schemaVersion: "1.0.0",
  description: "Target text and protected spans for deterministic span preservation checks.",
  jsonSchema: {
    type: "object",
    required: ["targetText", "protectedSpans"],
    additionalProperties: false,
    properties: {
      targetText: { type: "string", minLength: 1 },
      protectedSpans: { type: "array", items: { type: "string" } },
    },
  },
} satisfies RegistrySchemaDescriptor;

export const protectedSpanCheckOutputSchema = {
  schemaId: "itotori.tool.protected-span-check.output",
  schemaVersion: "1.0.0",
  description: "Reproducible missing-span findings from a deterministic local check.",
  jsonSchema: {
    type: "object",
    required: ["outputKind", "missingProtectedSpans", "findings"],
    additionalProperties: false,
    properties: {
      outputKind: { const: "protected_span_check" },
      missingProtectedSpans: { type: "array", items: { type: "string" } },
      findings: {
        type: "array",
        items: {
          type: "object",
          required: ["span", "rationale"],
          additionalProperties: false,
          properties: {
            span: { type: "string", minLength: 1 },
            rationale: { type: "string", minLength: 1 },
          },
        },
      },
    },
  },
} satisfies RegistrySchemaDescriptor;

export const fixtureInvocationContext = {
  taskId: "019ed011-0000-7000-8000-000000000011",
  occurredAt: "2026-06-17T12:00:00.000Z",
  subjectRefs: [
    {
      subjectKind: "bridge_unit",
      subjectId: "019ed011-0000-7000-8000-000000000101",
      label: "bridge-unit-fixture",
    },
  ],
} satisfies RegistryInvocationContext;

export const translationQualityJudgeJobFixture = {
  jobKind: "agent_job",
  agentName: "agent.translation-quality-judge",
  agentVersion: "1.0.0",
  context: fixtureInvocationContext,
  input: {
    sourceText: "こんにちは、{player}。",
    targetText: "Hello.",
    targetLocale: "en-US",
    protectedSpans: ["{player}"],
  },
} satisfies AgentJobInput<TranslationQualityJudgeInput>;

export const protectedSpanCheckJobFixture = {
  jobKind: "deterministic_tool_job",
  toolName: "tool.protected-span-check",
  toolVersion: "1.0.0",
  context: fixtureInvocationContext,
  input: {
    targetText: "Hello.",
    protectedSpans: ["{player}"],
  },
} satisfies DeterministicToolJobInput<ProtectedSpanCheckInput>;

export const translationQualityJudgeOutputFixture = {
  outputKind: "score",
  score: 0.25,
  rationales: ["The target dropped a required protected span from the source unit."],
  findings: [
    {
      findingKind: "protected_span_issue",
      severity: "P1",
      title: "Protected span was dropped",
      rationale: "The source includes {player}, but the target omits it.",
      evidence: ["expected {player}", "observed no matching span"],
    },
  ],
} satisfies TranslationQualityJudgeOutput;

export const protectedSpanCheckOutputFixture = {
  outputKind: "protected_span_check",
  missingProtectedSpans: ["{player}"],
  findings: [
    {
      span: "{player}",
      rationale: "The target text does not contain the protected span.",
    },
  ],
} satisfies ProtectedSpanCheckOutput;

export const protectedSpanCheckImplementationHash =
  "sha256:01f38382cce3aa536f1ec7355b2ac3374a4e6b80f8ad6fb2847a60491aee4a57" satisfies StableJsonHash;

export function protectedSpanCheck(input: ProtectedSpanCheckInput): ProtectedSpanCheckOutput {
  const missingProtectedSpans = input.protectedSpans.filter(
    (span) => !input.targetText.includes(span),
  );
  return {
    outputKind: "protected_span_check",
    missingProtectedSpans,
    findings: missingProtectedSpans.map((span) => ({
      span,
      rationale: "The target text does not contain the protected span.",
    })),
  };
}

export function parseTranslationQualityJudgeOutput(
  value: string | null,
): TranslationQualityJudgeOutput {
  if (value === null) {
    throw new Error("translation quality judge returned no content");
  }
  const parsed = JSON.parse(value) as JsonValue;
  if (!isJsonObject(parsed)) {
    throw new Error("translation quality judge output must be a JSON object");
  }
  return parsed as TranslationQualityJudgeOutput;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
