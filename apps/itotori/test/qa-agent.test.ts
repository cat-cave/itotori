import { describe, expect, it } from "vitest";
import {
  QaResponseValidationError,
  STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
  type QaFinding,
} from "@itotori/localization-bridge-schema";
import { FakeModelProvider, fakeModelCapabilities } from "../src/providers/fake.js";
import type {
  ModelCapabilities,
  ModelInvocationRequest,
  ModelInvocationResult,
  ModelProvider,
  ProviderDescriptor,
  ProviderRunRecord,
} from "../src/providers/types.js";
import { createProviderRunId } from "../src/providers/types.js";
import {
  buildQaPrompt,
  makeAllSeverityCategoryFindings,
  makeQaFindingFixture,
  makeStructuredQaFindingOutputFixture,
  QaAgent,
  QaEmptyInputError,
  QaLocaleMismatchError,
  QaPartialResultError,
  QaProviderCapabilityError,
  QaUnknownCitationError,
  qaPromptHash,
  representativeQaFindingsFixture,
  type QaBridgeUnit,
  type QaInvocationInput,
  type QaModelProfile,
} from "../src/agents/qa/index.js";

const FIXED_ACTOR = { userId: "local-user" };
const FIXED_NOW = (): Date => new Date("2026-06-23T12:00:00Z");

function fakeModelProfile(): QaModelProfile {
  return {
    providerFamily: "fake",
    modelId: "itotori-fake-qa-v0",
    // ITOTORI-220 — required (modelId, providerId) pair.
    providerId: "fake-fixture",
    contextWindowTokens: 16000,
    maxOutputTokens: 1024,
  };
}

function unitsFixture(): QaBridgeUnit[] {
  return [
    {
      bridgeUnitId: "019ed079-0000-7000-8000-00000000a001",
      sourceUnitKey: "scene.001.line.001",
      sourceText: "こんにちは、{player}。",
      sourceHash: "src-hash-1",
      draftText: "Hello.",
      draftHash: "drf-hash-1",
      speaker: "narration",
    },
    {
      bridgeUnitId: "019ed079-0000-7000-8000-00000000a002",
      sourceUnitKey: "scene.001.line.002",
      sourceText: "勇者は王様に挨拶した。",
      sourceHash: "src-hash-2",
      draftText: "The warrior greeted the king.",
      draftHash: "drf-hash-2",
      speaker: "narration",
    },
  ];
}

function inputFixture(overrides: Partial<QaInvocationInput> = {}): QaInvocationInput {
  return {
    draftJobId: "019ed079-0000-7000-8000-000000000d00",
    projectId: "019ed079-0000-7000-8000-000000000001",
    localeBranchId: "019ed079-0000-7000-8000-000000000002",
    sourceRevisionId: "019ed079-0000-7000-8000-000000000003",
    sourceLocale: "ja-JP",
    targetLocale: "en-US",
    units: unitsFixture(),
    glossary: [
      {
        termId: "019ed079-0000-7000-8000-00000000b001",
        preferredSourceForm: "勇者",
        preferredTargetForm: "hero",
        policyAction: "localize",
      },
    ],
    styleGuide: [
      {
        ruleId: "tone-001",
        section: "tone",
        guidance: "Use a formal register throughout the story.",
      },
    ],
    modelProfile: fakeModelProfile(),
    qaPromptVersion: "itotori-qa-agent-v1",
    now: FIXED_NOW,
    ...overrides,
  };
}

function buildFakeQaProvider(
  generate: (request: ModelInvocationRequest) => string,
): FakeModelProvider {
  return new FakeModelProvider({
    providerName: "qa-fake",
    modelId: "itotori-fake-qa-v0",
    generate,
  });
}

function findingsForInput(input: QaInvocationInput): QaFinding[] {
  return [
    makeQaFindingFixture({
      findingId: "019ed079-0000-7000-8000-100000000001",
      bridgeUnitId: input.units[0]!.bridgeUnitId,
      severity: "critical",
      category: "protected-span-violation",
      sourceSpan: { start: 6, end: 14 },
      draftSpan: { start: 5, end: 5 },
      evidenceRefs: ["style-guide:protectedSpans"],
      recommendation: "Restore the {player} placeholder.",
      agentRationale: "Source carries {player}; draft drops it.",
    }),
    makeQaFindingFixture({
      findingId: "019ed079-0000-7000-8000-100000000002",
      bridgeUnitId: input.units[1]!.bridgeUnitId,
      severity: "major",
      category: "glossary-conflict",
      evidenceRefs: ["glossary:019ed079-0000-7000-8000-00000000b001"],
      recommendation: "Use 'hero' for 勇者 per glossary.",
      agentRationale: "Glossary says 勇者→hero; draft renders 'warrior'.",
    }),
  ];
}

describe("QA prompt template", () => {
  it("is byte-stable across calls (same input -> same hash)", () => {
    const input = inputFixture();
    const a = buildQaPrompt(input);
    const b = buildQaPrompt(input);
    expect(a).toEqual(b);
    expect(qaPromptHash(a)).toEqual(qaPromptHash(b));
  });

  it("orders units by sourceUnitKey + bridgeUnitId regardless of input order", () => {
    const base = inputFixture();
    const reversed = inputFixture({ units: [...base.units].reverse() });
    expect(qaPromptHash(buildQaPrompt(base))).toEqual(qaPromptHash(buildQaPrompt(reversed)));
  });

  it("declares every severity and category in the prompt schema block", () => {
    const rendered = buildQaPrompt(inputFixture());
    for (const value of ["critical", "major", "minor", "info"]) {
      expect(rendered.systemText).toContain(value);
    }
    for (const value of [
      "mistranslation",
      "tone",
      "glossary-conflict",
      "protected-span-violation",
      "terminology-drift",
      "redaction",
      "context-mismatch",
      "other",
    ]) {
      expect(rendered.systemText).toContain(value);
    }
  });

  it("declares the output schema version", () => {
    const rendered = buildQaPrompt(inputFixture());
    expect(rendered.systemText).toContain(STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION);
  });
});

describe("QaAgent.invokeQa happy path", () => {
  it("returns parsed findings, providerRunId, prompt hash, and tokens", async () => {
    const input = inputFixture();
    const findings = findingsForInput(input);
    const provider = buildFakeQaProvider(() =>
      JSON.stringify(makeStructuredQaFindingOutputFixture(findings)),
    );
    const agent = new QaAgent({ provider });

    const result = await agent.invokeQa(FIXED_ACTOR, input);

    expect(result.findings).toEqual(findings);
    expect(result.providerRunId).toMatch(/^fake-/);
    expect(result.promptHashUsed).toMatch(/^[0-9a-f]{64}$/);
    expect(result.tokensIn).toBeGreaterThan(0);
    expect(result.tokensOut).toBeGreaterThan(0);
    expect(result.modelMetadata.modelProfile).toEqual(input.modelProfile);
    expect(result.modelMetadata.providerRun.taskKind).toBe("llm_qa");
    expect(result.recordedArtifactId).toBeUndefined();
  });

  it("accepts a zero-finding response without throwing (empty array is valid)", async () => {
    const input = inputFixture();
    const provider = buildFakeQaProvider(() =>
      JSON.stringify(makeStructuredQaFindingOutputFixture([])),
    );
    const agent = new QaAgent({ provider });
    const result = await agent.invokeQa(FIXED_ACTOR, input);
    expect(result.findings).toEqual([]);
  });

  it("ITOTORI-220: providerId is propagated through to the ModelProvider call", async () => {
    const input = inputFixture({
      modelProfile: {
        ...fakeModelProfile(),
        providerId: "fake-fixture-pair-test",
      },
    });
    let observedProviderId: string | undefined;
    const provider = new FakeModelProvider({
      providerName: "qa-fake",
      modelId: "itotori-fake-qa-v0",
      generate: (request) => {
        observedProviderId = request.providerId;
        return JSON.stringify(makeStructuredQaFindingOutputFixture([]));
      },
    });
    const agent = new QaAgent({ provider });
    const result = await agent.invokeQa(FIXED_ACTOR, input);
    expect(observedProviderId).toBe("fake-fixture-pair-test");
    expect(result.modelMetadata.providerIdentity.requestedProviderId).toBe(
      "fake-fixture-pair-test",
    );
  });
});

describe("QaAgent.invokeQa pre-flight invariants", () => {
  it("rejects empty input", async () => {
    const input = inputFixture({ units: [] });
    const provider = buildFakeQaProvider(() =>
      JSON.stringify(makeStructuredQaFindingOutputFixture([])),
    );
    const agent = new QaAgent({ provider });
    await expect(agent.invokeQa(FIXED_ACTOR, input)).rejects.toBeInstanceOf(QaEmptyInputError);
  });

  it("rejects empty source locale", async () => {
    const input = inputFixture({ sourceLocale: "" });
    const provider = buildFakeQaProvider(() =>
      JSON.stringify(makeStructuredQaFindingOutputFixture([])),
    );
    const agent = new QaAgent({ provider });
    await expect(agent.invokeQa(FIXED_ACTOR, input)).rejects.toBeInstanceOf(QaLocaleMismatchError);
  });

  it("rejects empty target locale", async () => {
    const input = inputFixture({ targetLocale: "" });
    const provider = buildFakeQaProvider(() =>
      JSON.stringify(makeStructuredQaFindingOutputFixture([])),
    );
    const agent = new QaAgent({ provider });
    await expect(agent.invokeQa(FIXED_ACTOR, input)).rejects.toBeInstanceOf(QaLocaleMismatchError);
  });
});

describe("QaAgent.invokeQa provider capability guard", () => {
  function makeStructuredOutputUnsupportedProvider(): ModelProvider {
    const capabilities: ModelCapabilities = {
      ...fakeModelCapabilities,
      structuredOutputs: {
        jsonSchema: "unsupported",
        jsonObject: "unsupported",
        toolCallArguments: "unsupported",
        plainJsonExtraction: "unsupported",
        preferredModes: [],
      },
    };
    const descriptor: ProviderDescriptor = {
      family: "fake",
      endpointFamily: "chat-completions",
      providerName: "unsupported-structured-output-provider",
      defaultModelId: "itotori-fake-qa-v0",
      capabilities,
    };
    return {
      descriptor,
      async invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult> {
        const startedAt = new Date(0).toISOString();
        const providerRun: ProviderRunRecord = {
          runId: createProviderRunId("unsupported"),
          taskKind: request.taskKind,
          startedAt,
          completedAt: startedAt,
          latencyMs: 0,
          status: "succeeded",
          provider: {
            providerFamily: descriptor.family,
            endpointFamily: descriptor.endpointFamily,
            providerName: descriptor.providerName,
            requestedModelId: request.modelId ?? descriptor.defaultModelId,
            actualModelId: request.modelId ?? descriptor.defaultModelId,
          },
          structuredOutputMode: "none",
          retryCount: 0,
          errorClasses: [],
          fallbackUsed: false,
          fallbackPlan: [request.modelId ?? descriptor.defaultModelId],
          tokenUsage: { tokenCountSource: "deterministic_counter" },
          cost: { costKind: "zero", currency: "USD", amountMicrosUsd: 0 },
          prompt: request.prompt,
        };
        return {
          content: "{}",
          toolCalls: [],
          finishReason: "stop",
          providerRun,
        };
      },
    };
  }

  it("throws QaProviderCapabilityError when the provider does not declare structured-output support", async () => {
    const provider = makeStructuredOutputUnsupportedProvider();
    const agent = new QaAgent({ provider });
    const error = await agent.invokeQa(FIXED_ACTOR, inputFixture()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QaProviderCapabilityError);
    if (error instanceof QaProviderCapabilityError) {
      expect(error.providerName).toBe("unsupported-structured-output-provider");
      expect(error.providerFamily).toBe("fake");
      expect(error.detail).toContain("unsupported");
    }
  });
});

describe("QaAgent.invokeQa malformed responses", () => {
  it("rejects non-JSON content with QaResponseValidationError", async () => {
    const input = inputFixture();
    const provider = buildFakeQaProvider(() => "not-json");
    const agent = new QaAgent({ provider });
    const error = await agent.invokeQa(FIXED_ACTOR, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QaResponseValidationError);
    if (error instanceof QaResponseValidationError) {
      expect(error.rule).toBe("json");
    }
  });

  it("rejects a response with an invalid severity enum", async () => {
    const input = inputFixture();
    const invalid = {
      schemaVersion: STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
      findings: [
        {
          findingId: "019ed079-0000-7000-8000-100000000001",
          bridgeUnitId: input.units[0]!.bridgeUnitId,
          severity: "showstopper",
          category: "tone",
          evidenceRefs: ["x"],
          recommendation: "fix it",
          agentRationale: "because",
        },
      ],
    };
    const provider = buildFakeQaProvider(() => JSON.stringify(invalid));
    const agent = new QaAgent({ provider });
    const error = await agent.invokeQa(FIXED_ACTOR, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QaResponseValidationError);
    if (error instanceof QaResponseValidationError) {
      expect(error.path).toBe("findings[0].severity");
      expect(error.rule).toBe("enum");
    }
  });

  it("rejects a response missing a required field", async () => {
    const input = inputFixture();
    const invalid = {
      schemaVersion: STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
      findings: [
        {
          findingId: "019ed079-0000-7000-8000-100000000001",
          bridgeUnitId: input.units[0]!.bridgeUnitId,
          severity: "minor",
          category: "tone",
          evidenceRefs: ["x"],
          // missing recommendation
          agentRationale: "because",
        },
      ],
    };
    const provider = buildFakeQaProvider(() => JSON.stringify(invalid));
    const agent = new QaAgent({ provider });
    const error = await agent.invokeQa(FIXED_ACTOR, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QaResponseValidationError);
    if (error instanceof QaResponseValidationError) {
      expect(error.path).toBe("findings[0].recommendation");
    }
  });

  it("rejects a response with an additional unknown property", async () => {
    const input = inputFixture();
    const invalid = {
      schemaVersion: STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
      findings: [
        {
          findingId: "019ed079-0000-7000-8000-100000000001",
          bridgeUnitId: input.units[0]!.bridgeUnitId,
          severity: "minor",
          category: "tone",
          evidenceRefs: ["x"],
          recommendation: "fix",
          agentRationale: "because",
          confidence: 0.9,
        },
      ],
    };
    const provider = buildFakeQaProvider(() => JSON.stringify(invalid));
    const agent = new QaAgent({ provider });
    const error = await agent.invokeQa(FIXED_ACTOR, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QaResponseValidationError);
    if (error instanceof QaResponseValidationError) {
      expect(error.rule).toBe("additionalProperties");
      expect(error.path).toBe("findings[0].confidence");
    }
  });

  it("rejects a response with an invalid schemaVersion", async () => {
    const input = inputFixture();
    const invalid = {
      schemaVersion: "something-else",
      findings: [],
    };
    const provider = buildFakeQaProvider(() => JSON.stringify(invalid));
    const agent = new QaAgent({ provider });
    const error = await agent.invokeQa(FIXED_ACTOR, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QaResponseValidationError);
    if (error instanceof QaResponseValidationError) {
      expect(error.path).toBe("schemaVersion");
      expect(error.rule).toBe("const");
    }
  });

  it("rejects a sourceSpan whose end is before start", async () => {
    const input = inputFixture();
    const invalid = {
      schemaVersion: STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
      findings: [
        {
          findingId: "019ed079-0000-7000-8000-100000000001",
          bridgeUnitId: input.units[0]!.bridgeUnitId,
          severity: "minor",
          category: "tone",
          sourceSpan: { start: 10, end: 5 },
          evidenceRefs: ["x"],
          recommendation: "fix",
          agentRationale: "because",
        },
      ],
    };
    const provider = buildFakeQaProvider(() => JSON.stringify(invalid));
    const agent = new QaAgent({ provider });
    const error = await agent.invokeQa(FIXED_ACTOR, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QaResponseValidationError);
    if (error instanceof QaResponseValidationError) {
      expect(error.rule).toBe("spanOrder");
    }
  });

  it("rejects a finding citing an unknown bridge unit", async () => {
    const input = inputFixture();
    const invalid = {
      schemaVersion: STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
      findings: [
        {
          findingId: "019ed079-0000-7000-8000-100000000001",
          bridgeUnitId: "019ed079-0000-7000-8000-deadbeefdead",
          severity: "minor",
          category: "tone",
          evidenceRefs: ["x"],
          recommendation: "fix",
          agentRationale: "because",
        },
      ],
    };
    const provider = buildFakeQaProvider(() => JSON.stringify(invalid));
    const agent = new QaAgent({ provider });
    const error = await agent.invokeQa(FIXED_ACTOR, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QaUnknownCitationError);
  });
});

describe("QaAgent.invokeQa partial / fallback diagnostics", () => {
  it("throws QaPartialResultError when the provider returns empty content", async () => {
    const input = inputFixture();
    const provider = buildFakeQaProvider(() => "");
    const agent = new QaAgent({ provider });
    const error = await agent.invokeQa(FIXED_ACTOR, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QaPartialResultError);
    if (error instanceof QaPartialResultError) {
      expect(error.detail).toContain("no content");
    }
  });

  it("throws QaPartialResultError when finish reason indicates truncation", async () => {
    // Build a provider that fakes a `length` finish reason to simulate
    // hitting maxOutputTokens before the JSON completed.
    const truncatingProvider: ModelProvider = {
      descriptor: {
        family: "fake",
        endpointFamily: "chat-completions",
        providerName: "truncating-fake",
        defaultModelId: "itotori-fake-qa-v0",
        capabilities: fakeModelCapabilities,
      },
      async invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult> {
        const startedAt = new Date(0).toISOString();
        const providerRun: ProviderRunRecord = {
          runId: createProviderRunId("truncating"),
          taskKind: request.taskKind,
          startedAt,
          completedAt: startedAt,
          latencyMs: 0,
          status: "partial",
          provider: {
            providerFamily: "fake",
            endpointFamily: "chat-completions",
            providerName: "truncating-fake",
            requestedModelId: request.modelId ?? "itotori-fake-qa-v0",
            actualModelId: request.modelId ?? "itotori-fake-qa-v0",
          },
          structuredOutputMode: request.structuredOutput?.mode ?? "none",
          retryCount: 0,
          errorClasses: [],
          fallbackUsed: false,
          fallbackPlan: [request.modelId ?? "itotori-fake-qa-v0"],
          tokenUsage: { tokenCountSource: "deterministic_counter" },
          cost: { costKind: "zero", currency: "USD", amountMicrosUsd: 0 },
          prompt: request.prompt,
        };
        return {
          content: '{"schemaVersion":"itotori.structured-qa-finding-output.v1","findings":[',
          toolCalls: [],
          finishReason: "length",
          providerRun,
        };
      },
    };
    const agent = new QaAgent({ provider: truncatingProvider });
    const error = await agent.invokeQa(FIXED_ACTOR, inputFixture()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QaPartialResultError);
    if (error instanceof QaPartialResultError) {
      expect(error.finishReason).toBe("length");
    }
  });
});

describe("Fixture factories", () => {
  it("makeAllSeverityCategoryFindings returns one finding per severity × category", () => {
    const all = makeAllSeverityCategoryFindings();
    expect(all).toHaveLength(4 * 8);
    // Each combination unique
    const seen = new Set<string>();
    for (const f of all) {
      seen.add(`${f.severity}::${f.category}`);
    }
    expect(seen.size).toBe(4 * 8);
  });

  it("representativeQaFindingsFixture returns four findings spanning every severity", () => {
    const reps = representativeQaFindingsFixture();
    expect(reps).toHaveLength(4);
    const severities = new Set(reps.map((f) => f.severity));
    expect(severities).toEqual(new Set(["critical", "major", "minor", "info"]));
  });

  it("makeStructuredQaFindingOutputFixture wraps findings with the correct schemaVersion", () => {
    const output = makeStructuredQaFindingOutputFixture([]);
    expect(output.schemaVersion).toBe(STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION);
    expect(output.findings).toEqual([]);
  });
});

describe("environment hygiene", () => {
  it("emits no live provider construction at import time (live opt-in only)", () => {
    expect(process.env.ITOTORI_LIVE_PROVIDER ?? "").toBe("");
  });
});
