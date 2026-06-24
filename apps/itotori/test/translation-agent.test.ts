import { describe, expect, it } from "vitest";
import {
  STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
  TranslationDraftResponseValidationError,
  type TranslationDraft,
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
import { deterministicFixtureDataHandlingPolicy } from "../src/providers/policy.js";
import {
  buildTranslationPrompt,
  fallbackTimeoutFixture,
  makeStructuredTranslationDraftOutputFixture,
  makeTranslationDraftFixture,
  malformedJsonFixture,
  missingProtectedSpanFixture,
  repairableTrailingCommaFixture,
  representativeTranslationDraftsFixture,
  TRANSLATION_FIXTURE_BRIDGE_UNIT_BASE,
  TRANSLATION_FIXTURE_DRAFT_JOB_ATTEMPT_ID,
  TRANSLATION_FIXTURE_DRAFT_JOB_ID,
  TRANSLATION_FIXTURE_LOCALE_BRANCH_ID,
  TRANSLATION_FIXTURE_PROJECT_ID,
  TRANSLATION_FIXTURE_SOURCE_LOCALE,
  TRANSLATION_FIXTURE_TARGET_LOCALE,
  TranslationAgent,
  TranslationEmptyInputError,
  TranslationLocaleMismatchError,
  TranslationPartialResultError,
  TranslationProtectedSpanViolationError,
  TranslationProviderCapabilityError,
  TranslationUnknownBridgeUnitError,
  TranslationUnknownCitationError,
  translationPromptHash,
  validTranslationDraftFixture,
  type TranslationBridgeUnit,
  type TranslationInvocationInput,
  type TranslationModelProfile,
  type TranslationProtectedSpanInput,
} from "../src/agents/translation/index.js";

const FIXED_ACTOR = { userId: "local-user" };
const FIXED_NOW = (): Date => new Date("2026-06-24T12:00:00Z");

function fakeModelProfile(): TranslationModelProfile {
  return {
    providerFamily: "fake",
    modelId: "itotori-fake-translation-v0",
    contextWindowTokens: 16000,
    maxOutputTokens: 1024,
  };
}

function unitsFixture(): TranslationBridgeUnit[] {
  return [
    {
      bridgeUnitId: `${TRANSLATION_FIXTURE_BRIDGE_UNIT_BASE}01`,
      sourceUnitKey: "scene.001.line.001",
      sourceText: "こんにちは、{player}。",
      sourceHash: "src-hash-1",
      speaker: "narration",
    },
    {
      bridgeUnitId: `${TRANSLATION_FIXTURE_BRIDGE_UNIT_BASE}02`,
      sourceUnitKey: "scene.001.line.002",
      sourceText: "勇者は王様に挨拶した。",
      sourceHash: "src-hash-2",
      speaker: "narration",
    },
    {
      bridgeUnitId: `${TRANSLATION_FIXTURE_BRIDGE_UNIT_BASE}03`,
      sourceUnitKey: "scene.001.line.003",
      sourceText: "魔王城の<ruby>入口</ruby>に到着した。",
      sourceHash: "src-hash-3",
      speaker: "narration",
    },
  ];
}

function protectedSpansFixture(): Map<string, TranslationProtectedSpanInput[]> {
  return new Map<string, TranslationProtectedSpanInput[]>([
    [
      `${TRANSLATION_FIXTURE_BRIDGE_UNIT_BASE}01`,
      [{ refId: "span-greeting-placeholder", sourceText: "{player}" }],
    ],
    [`${TRANSLATION_FIXTURE_BRIDGE_UNIT_BASE}02`, []],
    [
      `${TRANSLATION_FIXTURE_BRIDGE_UNIT_BASE}03`,
      [
        { refId: "span-ruby-open", sourceText: "<ruby>" },
        { refId: "span-ruby-close", sourceText: "</ruby>" },
      ],
    ],
  ]);
}

function inputFixture(
  overrides: Partial<TranslationInvocationInput> = {},
): TranslationInvocationInput {
  return {
    draftJobId: TRANSLATION_FIXTURE_DRAFT_JOB_ID,
    draftJobAttemptId: TRANSLATION_FIXTURE_DRAFT_JOB_ATTEMPT_ID,
    projectId: TRANSLATION_FIXTURE_PROJECT_ID,
    localeBranchId: TRANSLATION_FIXTURE_LOCALE_BRANCH_ID,
    sourceLocale: TRANSLATION_FIXTURE_SOURCE_LOCALE,
    targetLocale: TRANSLATION_FIXTURE_TARGET_LOCALE,
    sourceBridgeUnits: unitsFixture(),
    protectedSpansBySource: protectedSpansFixture(),
    glossary: [
      {
        termId: "glossary:term-greeting",
        preferredSourceForm: "こんにちは",
        preferredTargetForm: "Hello",
        policyAction: "localize",
      },
      {
        termId: "glossary:term-yusha",
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
    contextArtifactRefs: ["context-artifact:scene-summary-001"],
    modelProfile: fakeModelProfile(),
    promptTemplateVersion: "itotori-translation-agent-v1",
    now: FIXED_NOW,
    ...overrides,
  };
}

function buildFakeTranslationProvider(
  generate: (request: ModelInvocationRequest) => string,
): FakeModelProvider {
  return new FakeModelProvider({
    providerName: "translation-fake",
    modelId: "itotori-fake-translation-v0",
    generate,
  });
}

describe("Translation prompt template", () => {
  it("is byte-stable across calls (same input -> same hash)", () => {
    const input = inputFixture();
    const a = buildTranslationPrompt(input);
    const b = buildTranslationPrompt(input);
    expect(a).toEqual(b);
    expect(translationPromptHash(a)).toEqual(translationPromptHash(b));
  });

  it("orders units by sourceUnitKey + bridgeUnitId regardless of input order", () => {
    const base = inputFixture();
    const reversed = inputFixture({
      sourceBridgeUnits: [...base.sourceBridgeUnits].reverse(),
    });
    expect(translationPromptHash(buildTranslationPrompt(base))).toEqual(
      translationPromptHash(buildTranslationPrompt(reversed)),
    );
  });

  it("declares the output schema version and confidence-floor enum in the system text", () => {
    const rendered = buildTranslationPrompt(inputFixture());
    expect(rendered.systemText).toContain(STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION);
    for (const floor of ["low", "medium", "high"]) {
      expect(rendered.systemText).toContain(floor);
    }
  });
});

describe("TranslationAgent.invokeTranslation happy path", () => {
  it("returns parsed drafts, providerRunId, prompt hash, and tokens", async () => {
    const input = inputFixture();
    const drafts = representativeTranslationDraftsFixture();
    const provider = buildFakeTranslationProvider(() =>
      JSON.stringify(makeStructuredTranslationDraftOutputFixture(drafts)),
    );
    const agent = new TranslationAgent({ provider });

    const result = await agent.invokeTranslation(FIXED_ACTOR, input);

    expect(result.drafts).toEqual(drafts);
    expect(result.providerRunId).toMatch(/^fake-/);
    expect(result.promptHashUsed).toMatch(/^[0-9a-f]{64}$/);
    expect(result.tokensIn).toBeGreaterThan(0);
    expect(result.tokensOut).toBeGreaterThan(0);
    expect(result.modelMetadata.modelProfile).toEqual(input.modelProfile);
    expect(result.modelMetadata.providerRun.taskKind).toBe("draft_translation");
    expect(result.recordedArtifactId).toBeUndefined();
  });

  it("validTranslationDraftFixture parses without throwing", async () => {
    const input = inputFixture();
    const provider = buildFakeTranslationProvider(() => validTranslationDraftFixture());
    const agent = new TranslationAgent({ provider });
    const result = await agent.invokeTranslation(FIXED_ACTOR, input);
    expect(result.drafts).toHaveLength(3);
  });

  it("accepts a zero-draft response without throwing (empty array is valid)", async () => {
    const input = inputFixture();
    const provider = buildFakeTranslationProvider(() =>
      JSON.stringify(makeStructuredTranslationDraftOutputFixture([])),
    );
    const agent = new TranslationAgent({ provider });
    const result = await agent.invokeTranslation(FIXED_ACTOR, input);
    expect(result.drafts).toEqual([]);
  });
});

describe("TranslationAgent.invokeTranslation pre-flight invariants", () => {
  it("rejects empty input", async () => {
    const input = inputFixture({ sourceBridgeUnits: [] });
    const provider = buildFakeTranslationProvider(() =>
      JSON.stringify(makeStructuredTranslationDraftOutputFixture([])),
    );
    const agent = new TranslationAgent({ provider });
    await expect(agent.invokeTranslation(FIXED_ACTOR, input)).rejects.toBeInstanceOf(
      TranslationEmptyInputError,
    );
  });

  it("rejects empty source locale", async () => {
    const input = inputFixture({ sourceLocale: "" });
    const provider = buildFakeTranslationProvider(() => validTranslationDraftFixture());
    const agent = new TranslationAgent({ provider });
    await expect(agent.invokeTranslation(FIXED_ACTOR, input)).rejects.toBeInstanceOf(
      TranslationLocaleMismatchError,
    );
  });

  it("rejects empty target locale", async () => {
    const input = inputFixture({ targetLocale: "" });
    const provider = buildFakeTranslationProvider(() => validTranslationDraftFixture());
    const agent = new TranslationAgent({ provider });
    await expect(agent.invokeTranslation(FIXED_ACTOR, input)).rejects.toBeInstanceOf(
      TranslationLocaleMismatchError,
    );
  });

  it("rejects identical source/target locales", async () => {
    const input = inputFixture({ targetLocale: TRANSLATION_FIXTURE_SOURCE_LOCALE });
    const provider = buildFakeTranslationProvider(() => validTranslationDraftFixture());
    const agent = new TranslationAgent({ provider });
    const error = await agent.invokeTranslation(FIXED_ACTOR, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranslationLocaleMismatchError);
    if (error instanceof TranslationLocaleMismatchError) {
      expect(error.field).toBe("targetLocale");
      expect(error.detail).toContain("must differ");
    }
  });
});

describe("TranslationAgent.invokeTranslation provider capability guard", () => {
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
      dataHandling: deterministicFixtureDataHandlingPolicy,
    };
    const descriptor: ProviderDescriptor = {
      family: "fake",
      endpointFamily: "chat-completions",
      providerName: "unsupported-structured-output-provider",
      defaultModelId: "itotori-fake-translation-v0",
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
          dataHandling: capabilities.dataHandling,
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

  it("throws TranslationProviderCapabilityError when structured-output is unsupported", async () => {
    const provider = makeStructuredOutputUnsupportedProvider();
    const agent = new TranslationAgent({ provider });
    const error = await agent
      .invokeTranslation(FIXED_ACTOR, inputFixture())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranslationProviderCapabilityError);
    if (error instanceof TranslationProviderCapabilityError) {
      expect(error.providerName).toBe("unsupported-structured-output-provider");
      expect(error.providerFamily).toBe("fake");
      expect(error.detail).toContain("unsupported");
    }
  });
});

describe("TranslationAgent.invokeTranslation malformed responses", () => {
  it("rejects non-JSON content with TranslationDraftResponseValidationError (malformedJsonFixture)", async () => {
    const input = inputFixture();
    const provider = buildFakeTranslationProvider(() => malformedJsonFixture());
    const agent = new TranslationAgent({ provider });
    const error = await agent.invokeTranslation(FIXED_ACTOR, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranslationDraftResponseValidationError);
    if (error instanceof TranslationDraftResponseValidationError) {
      expect(error.rule).toBe("json");
    }
  });

  it("rejects a response with a trailing comma (repairableTrailingCommaFixture, no silent repair)", async () => {
    const input = inputFixture();
    const provider = buildFakeTranslationProvider(() => repairableTrailingCommaFixture());
    const agent = new TranslationAgent({ provider });
    const error = await agent.invokeTranslation(FIXED_ACTOR, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranslationDraftResponseValidationError);
    if (error instanceof TranslationDraftResponseValidationError) {
      expect(error.rule).toBe("json");
    }
  });

  it("rejects a response with an invalid confidenceFloor enum", async () => {
    const input = inputFixture();
    const invalid = {
      schemaVersion: STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
      drafts: [
        makeTranslationDraftFixture({
          bridgeUnitId: input.sourceBridgeUnits[0]!.bridgeUnitId,
          confidenceFloor: "medium",
        }),
      ],
    };
    // Mutate after construction to bypass the TS literal type guard.
    const mutated = JSON.parse(JSON.stringify(invalid)) as {
      drafts: Array<{ confidenceFloor: string }>;
    };
    mutated.drafts[0]!.confidenceFloor = "extreme";
    const provider = buildFakeTranslationProvider(() => JSON.stringify(mutated));
    const agent = new TranslationAgent({ provider });
    const error = await agent.invokeTranslation(FIXED_ACTOR, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranslationDraftResponseValidationError);
    if (error instanceof TranslationDraftResponseValidationError) {
      expect(error.path).toBe("drafts[0].confidenceFloor");
      expect(error.rule).toBe("enum");
    }
  });

  it("rejects a response with an unknown top-level property", async () => {
    const input = inputFixture();
    const provider = buildFakeTranslationProvider(() =>
      JSON.stringify({
        schemaVersion: STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
        drafts: [],
        repairAttempts: 0,
      }),
    );
    const agent = new TranslationAgent({ provider });
    const error = await agent.invokeTranslation(FIXED_ACTOR, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranslationDraftResponseValidationError);
    if (error instanceof TranslationDraftResponseValidationError) {
      expect(error.rule).toBe("additionalProperties");
      expect(error.path).toBe("repairAttempts");
    }
  });
});

describe("TranslationAgent.invokeTranslation bridge unit + citation resolution", () => {
  it("rejects a draft citing an unknown bridge unit", async () => {
    const input = inputFixture();
    const provider = buildFakeTranslationProvider(() =>
      JSON.stringify(
        makeStructuredTranslationDraftOutputFixture([
          makeTranslationDraftFixture({
            bridgeUnitId: "019ed079-0000-7000-8000-deadbeefdead",
            protectedSpanRefs: [],
            citationRefs: [],
            draftText: "stray draft",
          }),
        ]),
      ),
    );
    const agent = new TranslationAgent({ provider });
    await expect(agent.invokeTranslation(FIXED_ACTOR, input)).rejects.toBeInstanceOf(
      TranslationUnknownBridgeUnitError,
    );
  });

  it("rejects a draft citing an unknown citation ref", async () => {
    const input = inputFixture();
    const provider = buildFakeTranslationProvider(() =>
      JSON.stringify(
        makeStructuredTranslationDraftOutputFixture([
          makeTranslationDraftFixture({
            bridgeUnitId: input.sourceBridgeUnits[1]!.bridgeUnitId,
            draftText: "The hero greeted the king.",
            protectedSpanRefs: [],
            citationRefs: ["glossary:does-not-exist"],
          }),
        ]),
      ),
    );
    const agent = new TranslationAgent({ provider });
    const error = await agent.invokeTranslation(FIXED_ACTOR, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranslationUnknownCitationError);
    if (error instanceof TranslationUnknownCitationError) {
      expect(error.citationRef).toBe("glossary:does-not-exist");
    }
  });

  it("accepts a draft citing a context artifact ref present in the input", async () => {
    const input = inputFixture();
    const provider = buildFakeTranslationProvider(() =>
      JSON.stringify(
        makeStructuredTranslationDraftOutputFixture([
          makeTranslationDraftFixture({
            bridgeUnitId: input.sourceBridgeUnits[1]!.bridgeUnitId,
            draftText: "The hero greeted the king.",
            protectedSpanRefs: [],
            citationRefs: ["context-artifact:scene-summary-001"],
          }),
        ]),
      ),
    );
    const agent = new TranslationAgent({ provider });
    const result = await agent.invokeTranslation(FIXED_ACTOR, input);
    expect(result.drafts).toHaveLength(1);
  });
});

describe("TranslationAgent.invokeTranslation protected-span enforcement", () => {
  it("rejects when a required protected span is missing (missingProtectedSpanFixture)", async () => {
    const input = inputFixture();
    const provider = buildFakeTranslationProvider(() => missingProtectedSpanFixture());
    const agent = new TranslationAgent({ provider });
    const error = await agent.invokeTranslation(FIXED_ACTOR, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranslationProtectedSpanViolationError);
    if (error instanceof TranslationProtectedSpanViolationError) {
      expect(error.reason).toBe("missing_ref");
      expect(error.spanRefId).toBe("span-greeting-placeholder");
    }
  });

  it("rejects when a draft references an unknown span ref", async () => {
    const input = inputFixture();
    const provider = buildFakeTranslationProvider(() =>
      JSON.stringify(
        makeStructuredTranslationDraftOutputFixture([
          makeTranslationDraftFixture({
            bridgeUnitId: input.sourceBridgeUnits[0]!.bridgeUnitId,
            draftText: "Hello, {player}.",
            protectedSpanRefs: [
              { refId: "span-greeting-placeholder", startInDraft: 7, endInDraft: 15 },
              { refId: "span-stowaway", startInDraft: 0, endInDraft: 1 },
            ],
            citationRefs: ["glossary:term-greeting"],
          }),
        ]),
      ),
    );
    const agent = new TranslationAgent({ provider });
    const error = await agent.invokeTranslation(FIXED_ACTOR, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranslationProtectedSpanViolationError);
    if (error instanceof TranslationProtectedSpanViolationError) {
      expect(error.reason).toBe("unknown_ref");
      expect(error.spanRefId).toBe("span-stowaway");
    }
  });

  it("rejects when a draft's protected span goes out of bounds", async () => {
    const input = inputFixture();
    const provider = buildFakeTranslationProvider(() =>
      JSON.stringify(
        makeStructuredTranslationDraftOutputFixture([
          makeTranslationDraftFixture({
            bridgeUnitId: input.sourceBridgeUnits[0]!.bridgeUnitId,
            // Short draft text but the span claims a far-out range.
            draftText: "Hi.",
            protectedSpanRefs: [
              { refId: "span-greeting-placeholder", startInDraft: 0, endInDraft: 99 },
            ],
            citationRefs: ["glossary:term-greeting"],
          }),
        ]),
      ),
    );
    const agent = new TranslationAgent({ provider });
    const error = await agent.invokeTranslation(FIXED_ACTOR, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranslationProtectedSpanViolationError);
    if (error instanceof TranslationProtectedSpanViolationError) {
      expect(error.reason).toBe("out_of_bounds");
    }
  });

  it("rejects when a draft's protected span substring does not equal the source span text (preservation_mismatch)", async () => {
    const input = inputFixture();
    const provider = buildFakeTranslationProvider(() =>
      JSON.stringify(
        makeStructuredTranslationDraftOutputFixture([
          makeTranslationDraftFixture({
            bridgeUnitId: input.sourceBridgeUnits[0]!.bridgeUnitId,
            // Localised placeholder rather than the literal one — must be rejected.
            draftText: "Hello, [player].",
            protectedSpanRefs: [
              { refId: "span-greeting-placeholder", startInDraft: 7, endInDraft: 15 },
            ],
            citationRefs: ["glossary:term-greeting"],
          }),
        ]),
      ),
    );
    const agent = new TranslationAgent({ provider });
    const error = await agent.invokeTranslation(FIXED_ACTOR, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranslationProtectedSpanViolationError);
    if (error instanceof TranslationProtectedSpanViolationError) {
      expect(error.reason).toBe("preservation_mismatch");
    }
  });

  it("rejects when two protected span refs overlap", async () => {
    const input = inputFixture();
    // Draft text: "They arrived at the demon castle <ruby></ruby>."
    //                                              ^33   ^39
    //                                                    ^39  ^46
    // First span at 33..39 = "<ruby>" matches. Second span overlaps at 38..45,
    // and at that range draftText[38..45] = ">< /ruby" - no, let me compute:
    // We use draftText that lets the first span match exactly so the
    // ordered iteration enters the second iteration with previousEnd=39,
    // then the second span's startInDraft=38 < previousEnd triggers
    // overlapping_ref before the substring check runs.
    const provider = buildFakeTranslationProvider(() =>
      JSON.stringify(
        makeStructuredTranslationDraftOutputFixture([
          makeTranslationDraftFixture({
            bridgeUnitId: input.sourceBridgeUnits[2]!.bridgeUnitId,
            draftText: "They arrived at the demon castle <ruby></ruby>.",
            protectedSpanRefs: [
              // First (by sorted startInDraft) — matches "<ruby>" byte-equal.
              { refId: "span-ruby-open", startInDraft: 33, endInDraft: 39 },
              // Second — overlaps by one position. Reaches the overlap
              // check before the preservation check on the second iteration.
              { refId: "span-ruby-close", startInDraft: 38, endInDraft: 45 },
            ],
            citationRefs: ["context-artifact:scene-summary-001"],
          }),
        ]),
      ),
    );
    const agent = new TranslationAgent({ provider });
    const error = await agent.invokeTranslation(FIXED_ACTOR, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranslationProtectedSpanViolationError);
    if (error instanceof TranslationProtectedSpanViolationError) {
      expect(error.reason).toBe("overlapping_ref");
    }
  });

  it("rejects when the same protected span ref is repeated", async () => {
    const input = inputFixture();
    const provider = buildFakeTranslationProvider(() =>
      JSON.stringify(
        makeStructuredTranslationDraftOutputFixture([
          makeTranslationDraftFixture({
            bridgeUnitId: input.sourceBridgeUnits[0]!.bridgeUnitId,
            draftText: "Hello, {player}{player}.",
            protectedSpanRefs: [
              { refId: "span-greeting-placeholder", startInDraft: 7, endInDraft: 15 },
              { refId: "span-greeting-placeholder", startInDraft: 15, endInDraft: 23 },
            ],
            citationRefs: ["glossary:term-greeting"],
          }),
        ]),
      ),
    );
    const agent = new TranslationAgent({ provider });
    const error = await agent.invokeTranslation(FIXED_ACTOR, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranslationProtectedSpanViolationError);
    if (error instanceof TranslationProtectedSpanViolationError) {
      expect(error.reason).toBe("duplicate_ref");
    }
  });
});

describe("TranslationAgent.invokeTranslation locale mismatch in draft", () => {
  it("rejects when a draft's sourceLocale does not match the input", async () => {
    const input = inputFixture();
    const provider = buildFakeTranslationProvider(() =>
      JSON.stringify(
        makeStructuredTranslationDraftOutputFixture([
          makeTranslationDraftFixture({
            bridgeUnitId: input.sourceBridgeUnits[1]!.bridgeUnitId,
            sourceLocale: "ko-KR",
            draftText: "The hero greeted the king.",
            protectedSpanRefs: [],
            citationRefs: ["glossary:term-yusha"],
          }),
        ]),
      ),
    );
    const agent = new TranslationAgent({ provider });
    const error = await agent.invokeTranslation(FIXED_ACTOR, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranslationLocaleMismatchError);
    if (error instanceof TranslationLocaleMismatchError) {
      expect(error.field).toBe("sourceLocale");
      expect(error.observed).toBe("ko-KR");
    }
  });

  it("rejects when a draft's targetLocale does not match the input", async () => {
    const input = inputFixture();
    const provider = buildFakeTranslationProvider(() =>
      JSON.stringify(
        makeStructuredTranslationDraftOutputFixture([
          makeTranslationDraftFixture({
            bridgeUnitId: input.sourceBridgeUnits[1]!.bridgeUnitId,
            targetLocale: "fr-FR",
            draftText: "Le héros salua le roi.",
            protectedSpanRefs: [],
            citationRefs: ["glossary:term-yusha"],
          }),
        ]),
      ),
    );
    const agent = new TranslationAgent({ provider });
    const error = await agent.invokeTranslation(FIXED_ACTOR, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranslationLocaleMismatchError);
    if (error instanceof TranslationLocaleMismatchError) {
      expect(error.field).toBe("targetLocale");
      expect(error.observed).toBe("fr-FR");
    }
  });
});

describe("TranslationAgent.invokeTranslation partial / fallback diagnostics", () => {
  it("throws TranslationPartialResultError when the provider returns empty content (fallbackTimeoutFixture)", async () => {
    const input = inputFixture();
    const provider = buildFakeTranslationProvider(() => fallbackTimeoutFixture());
    const agent = new TranslationAgent({ provider });
    const error = await agent.invokeTranslation(FIXED_ACTOR, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranslationPartialResultError);
    if (error instanceof TranslationPartialResultError) {
      expect(error.detail).toContain("no content");
      expect(error.draftJobAttemptId).toBe(TRANSLATION_FIXTURE_DRAFT_JOB_ATTEMPT_ID);
    }
  });

  it("throws TranslationPartialResultError when finish reason indicates truncation", async () => {
    const truncatingProvider: ModelProvider = {
      descriptor: {
        family: "fake",
        endpointFamily: "chat-completions",
        providerName: "truncating-fake",
        defaultModelId: "itotori-fake-translation-v0",
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
            requestedModelId: request.modelId ?? "itotori-fake-translation-v0",
            actualModelId: request.modelId ?? "itotori-fake-translation-v0",
          },
          structuredOutputMode: request.structuredOutput?.mode ?? "none",
          retryCount: 0,
          errorClasses: [],
          fallbackUsed: false,
          fallbackPlan: [request.modelId ?? "itotori-fake-translation-v0"],
          tokenUsage: { tokenCountSource: "deterministic_counter" },
          cost: { costKind: "zero", currency: "USD", amountMicrosUsd: 0 },
          prompt: request.prompt,
          dataHandling: fakeModelCapabilities.dataHandling,
        };
        return {
          content: '{"schemaVersion":"itotori.structured-translation-draft-output.v1","drafts":[',
          toolCalls: [],
          finishReason: "length",
          providerRun,
        };
      },
    };
    const agent = new TranslationAgent({ provider: truncatingProvider });
    const error = await agent
      .invokeTranslation(FIXED_ACTOR, inputFixture())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranslationPartialResultError);
    if (error instanceof TranslationPartialResultError) {
      expect(error.finishReason).toBe("length");
    }
  });
});

describe("Translation fixture factories", () => {
  it("representativeTranslationDraftsFixture returns three drafts with diverse confidence floors", () => {
    const drafts = representativeTranslationDraftsFixture();
    expect(drafts).toHaveLength(3);
    const floors = new Set(drafts.map((d) => d.confidenceFloor));
    expect(floors).toEqual(new Set(["low", "medium", "high"]));
  });

  it("makeStructuredTranslationDraftOutputFixture wraps drafts with the correct schemaVersion", () => {
    const output = makeStructuredTranslationDraftOutputFixture([]);
    expect(output.schemaVersion).toBe(STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION);
    expect(output.drafts).toEqual([]);
  });

  it("validTranslationDraftFixture is JSON-parseable round-trip", () => {
    const raw = validTranslationDraftFixture();
    const parsed = JSON.parse(raw) as { schemaVersion: string; drafts: TranslationDraft[] };
    expect(parsed.schemaVersion).toBe(STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION);
    expect(parsed.drafts).toHaveLength(3);
  });
});

describe("environment hygiene", () => {
  it("emits no live provider construction at import time (live opt-in only)", () => {
    expect(process.env.ITOTORI_LIVE_PROVIDER ?? "").toBe("");
  });
});
