import {
  EVIDENCE_KINDS,
  FINDING_KINDS,
  LOCALIZATION_QUALITY_CATEGORIES,
  PROVENANCE_KINDS,
  TRIAGE_SEVERITIES,
  TRIAGE_SUBJECT_KINDS,
} from "@itotori/localization-bridge-schema";
import type { JsonObject, JsonValue } from "../providers/types.js";
import {
  assertDeterministicPreExportQaOutput,
  DETERMINISTIC_PRE_EXPORT_QA_CHECK_CODES,
  runDeterministicPreExportQa,
} from "../services/deterministic-pre-export-qa.js";
import type { ProjectState } from "../services/project-workflow.js";
import type {
  AgentJobInput,
  AgentJudgmentOutput,
  AgentOutputFinding,
  DeterministicToolDefinition,
  DeterministicToolJobInput,
  RegistryInvocationContext,
  RegistrySchemaDescriptor,
  StableJsonHash,
} from "./registry.js";
import { deriveImplementationHash } from "./registry.js";

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

export type DeterministicPreExportQaInput = JsonObject & {
  project: JsonObject;
};

export type DeterministicPreExportQaOutput = JsonObject & {
  outputKind: "deterministic_pre_export_qa";
  failures: JsonObject[];
  findings: JsonObject[];
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

export const deterministicPreExportQaInputSchema = {
  schemaId: "itotori.tool.deterministic-pre-export-qa.input",
  schemaVersion: "1.0.0",
  description: "Project snapshot for the deterministic pre-export QA suite.",
  jsonSchema: {
    type: "object",
    required: ["project"],
    additionalProperties: false,
    properties: {
      project: { type: "object" },
    },
  },
} satisfies RegistrySchemaDescriptor;

// Structured contract for a single emitted QA finding (the `failures` item):
// exact unit reference, a known check code, structured evidence, and a
// structured repair hint. Replaces the previous `{ type: "object" }` item that
// accepted arbitrary shapes (ITOTORI-143).
const deterministicPreExportQaFindingSchema = {
  type: "object",
  required: [
    "checkCode",
    "unitId",
    "sourceUnitKey",
    "sourceText",
    "targetText",
    "message",
    "expected",
    "observed",
    "repairHint",
    "findingKind",
    "qualityCategory",
    "severity",
  ],
  additionalProperties: false,
  properties: {
    checkCode: { enum: [...DETERMINISTIC_PRE_EXPORT_QA_CHECK_CODES] },
    unitId: { type: "string", minLength: 1 },
    sourceUnitKey: { type: "string", minLength: 1 },
    sourceText: { type: "string" },
    targetText: { type: "string" },
    message: { type: "string", minLength: 1 },
    expected: { type: "string" },
    observed: { type: "string" },
    repairHint: { type: "string", minLength: 1 },
    findingKind: { enum: [...FINDING_KINDS] },
    qualityCategory: { enum: [...LOCALIZATION_QUALITY_CATEGORIES] },
    severity: { enum: [...TRIAGE_SEVERITIES] },
  },
} satisfies JsonObject;

// Structured contract for a derived finding record. Enforces the structural
// contract (id, enum classification, affected unit references, structured
// evidence and provenance) without UUID7 strictness, since the tool derives
// ids from project/unit keys.
const deterministicPreExportQaFindingRecordSchema = {
  type: "object",
  required: [
    "findingId",
    "findingKind",
    "severity",
    "qualityCategory",
    "title",
    "description",
    "impact",
    "createdAt",
    "affectedRefs",
    "evidence",
    "provenance",
    "causalLinks",
  ],
  additionalProperties: false,
  properties: {
    findingId: { type: "string", minLength: 1 },
    findingKind: { enum: [...FINDING_KINDS] },
    severity: { enum: [...TRIAGE_SEVERITIES] },
    qualityCategory: { enum: [...LOCALIZATION_QUALITY_CATEGORIES] },
    title: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    impact: { type: "string", minLength: 1 },
    createdAt: { type: "string", minLength: 1 },
    reportedByTaskId: { type: "string", minLength: 1 },
    firstSeenEventId: { type: "string", minLength: 1 },
    affectedRefs: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["subjectKind", "subjectId"],
        additionalProperties: false,
        properties: {
          subjectKind: { enum: [...TRIAGE_SUBJECT_KINDS] },
          subjectId: { type: "string", minLength: 1 },
          label: { type: "string" },
        },
      },
    },
    evidence: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["evidenceId", "evidenceKind", "summary", "provenanceIds"],
        additionalProperties: false,
        properties: {
          evidenceId: { type: "string", minLength: 1 },
          evidenceKind: { enum: [...EVIDENCE_KINDS] },
          summary: { type: "string", minLength: 1 },
          expectedValue: { type: "string" },
          observedValue: { type: "string" },
          provenanceIds: { type: "array", items: { type: "string", minLength: 1 } },
        },
      },
    },
    provenance: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["provenanceId", "provenanceKind"],
        additionalProperties: false,
        properties: {
          provenanceId: { type: "string", minLength: 1 },
          provenanceKind: { enum: [...PROVENANCE_KINDS] },
          checkId: { type: "string", minLength: 1 },
          checkName: { type: "string", minLength: 1 },
          checkVersion: { type: "string", minLength: 1 },
        },
      },
    },
    causalLinks: { type: "array", items: { type: "object" } },
  },
} satisfies JsonObject;

export const deterministicPreExportQaOutputSchema = {
  schemaId: "itotori.tool.deterministic-pre-export-qa.output",
  schemaVersion: "1.0.0",
  description: "Full deterministic pre-export QA failures and finding records.",
  jsonSchema: {
    type: "object",
    required: ["outputKind", "failures", "findings"],
    additionalProperties: false,
    properties: {
      outputKind: { const: "deterministic_pre_export_qa" },
      failures: { type: "array", items: deterministicPreExportQaFindingSchema },
      findings: { type: "array", items: deterministicPreExportQaFindingRecordSchema },
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

export const deterministicPreExportQaJobFixture = {
  jobKind: "deterministic_tool_job",
  toolName: "tool.deterministic-pre-export-qa",
  toolVersion: "1.0.0",
  context: fixtureInvocationContext,
  input: {
    project: {
      projectId: "project-test",
      localeBranchId: "locale-en-us",
      targetLocale: "en-US",
      bridge: {
        schemaVersion: "0.1.0",
        bridgeId: "bridge-test",
        sourceBundleHash: "hash-test",
        sourceLocale: "ja-JP",
        extractorName: "kaifuu-fixture",
        extractorVersion: "0.0.0",
        units: [
          {
            bridgeUnitId: "bridge-unit-test",
            sourceUnitKey: "hello.scene.001.line.001",
            occurrenceId: "occurrence-1",
            sourceHash: "source-hash",
            sourceLocale: "ja-JP",
            sourceText: "こんにちは、{player}。",
            textSurface: "dialogue",
            protectedSpans: [
              {
                kind: "placeholder",
                raw: "{player}",
                start: 6,
                end: 14,
                preserveMode: "exact",
              },
            ],
            patchRef: {
              assetId: "source.json",
              writeMode: "replace",
              sourceUnitKey: "hello.scene.001.line.001",
            },
          },
        ],
      },
      drafts: { "bridge-unit-test": "Hello." },
    },
  },
} satisfies DeterministicToolJobInput<DeterministicPreExportQaInput>;

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

export const protectedSpanCheckImplementationHash = deriveImplementationHash({
  toolName: "tool.protected-span-check",
  toolVersion: "1.0.0",
  algorithmName: "protected-span-presence",
  algorithmVersion: "1.0.0",
  inputSchema: protectedSpanCheckInputSchema,
  outputSchema: protectedSpanCheckOutputSchema,
}) satisfies StableJsonHash;

export const deterministicPreExportQaImplementationHash = deriveImplementationHash({
  toolName: "tool.deterministic-pre-export-qa",
  toolVersion: "1.0.0",
  algorithmName: "deterministic-pre-export-qa",
  algorithmVersion: "itotori-020.1",
  inputSchema: deterministicPreExportQaInputSchema,
  outputSchema: deterministicPreExportQaOutputSchema,
}) satisfies StableJsonHash;

export function protectedSpanCheck(input: ProtectedSpanCheckInput): ProtectedSpanCheckOutput {
  const missingProtectedSpans = missingRequiredProtectedSpanOccurrences(
    input.protectedSpans,
    input.targetText,
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

export function deterministicPreExportQa(
  input: DeterministicPreExportQaInput,
): DeterministicPreExportQaOutput {
  const result = runDeterministicPreExportQa(input.project as unknown as ProjectState);
  const output: DeterministicPreExportQaOutput = {
    outputKind: "deterministic_pre_export_qa",
    failures: result.failures as unknown as JsonObject[],
    findings: result.findings as unknown as JsonObject[],
  };
  // Fail-closed: contract-validate every emitted finding (exact unit ref, known
  // check code, structured evidence + repair hint) before it crosses the tool
  // boundary — no arbitrary object array items (ITOTORI-143).
  assertDeterministicPreExportQaOutput(output);
  return output;
}

export const deterministicPreExportQaOutputFixture = deterministicPreExportQa(
  deterministicPreExportQaJobFixture.input,
);

export function deterministicPreExportQaTool(): DeterministicToolDefinition<
  DeterministicPreExportQaInput,
  DeterministicPreExportQaOutput
> {
  return {
    registryKind: "deterministic_tool_definition",
    toolName: "tool.deterministic-pre-export-qa",
    toolVersion: "1.0.0",
    description: "Runs the full deterministic pre-export QA suite over a project snapshot.",
    taskKind: "deterministic_qa",
    capabilityKey: "localization.pre_export_qa",
    inputSchema: deterministicPreExportQaInputSchema,
    outputSchema: deterministicPreExportQaOutputSchema,
    reproducibility: {
      algorithmName: "deterministic-pre-export-qa",
      algorithmVersion: "itotori-020.1",
      implementationHash: deterministicPreExportQaImplementationHash,
      inputHashAlgorithm: "sha256-stable-json-v1",
      outputHashAlgorithm: "sha256-stable-json-v1",
      sideEffectFree: true,
    },
    run: (input) => deterministicPreExportQa(input),
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

function missingRequiredProtectedSpanOccurrences(
  requiredSpans: string[],
  targetText: string,
): string[] {
  const availableCounts = new Map<string, number>();
  const missing: string[] = [];
  for (const spanRaw of requiredSpans) {
    const available = availableCounts.get(spanRaw) ?? countOccurrences(targetText, spanRaw);
    if (available <= 0) {
      missing.push(spanRaw);
      continue;
    }
    availableCounts.set(spanRaw, available - 1);
  }
  return missing;
}

function countOccurrences(targetText: string, raw: string): number {
  if (raw.length === 0) {
    return 0;
  }
  let count = 0;
  let searchStart = 0;
  while (searchStart <= targetText.length) {
    const index = targetText.indexOf(raw, searchStart);
    if (index < 0) {
      return count;
    }
    count += 1;
    searchStart = index + raw.length;
  }
  return count;
}
