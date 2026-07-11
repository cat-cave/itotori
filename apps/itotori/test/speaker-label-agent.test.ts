import { describe, expect, it } from "vitest";
import {
  SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
  SpeakerLabelResponseValidationError,
  type SpeakerIdentity,
  type SpeakerLabel,
  type SpeakerLabelOutput,
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
  buildSpeakerLabelPrompt,
  HiddenIdentityLeakError,
  SpeakerLabelAgent,
  SpeakerLabelBelowConfidenceFloorError,
  SpeakerLabelEmptyInputError,
  SpeakerLabelHiddenMaskMismatchError,
  SpeakerLabelLocaleMismatchError,
  SpeakerLabelPartialResultError,
  SpeakerLabelProviderCapabilityError,
  SpeakerLabelUnknownCitationError,
  speakerLabelPromptHash,
  type CharacterBio,
  type SpeakerLabelBridgeUnit,
  type SpeakerLabelInvocationInput,
  type SpeakerLabelModelProfile,
} from "../src/agents/speaker-label/index.js";

const FIXED_ACTOR = { userId: "local-user" };
const FIXED_NOW = (): Date => new Date("2026-06-23T12:00:00Z");

function modelProfile(): SpeakerLabelModelProfile {
  return {
    providerFamily: "fake",
    modelId: "itotori-fake-speaker-label-v0",
    // ITOTORI-220 — required (modelId, providerId) pair.
    providerId: "fake-fixture",
    contextWindowTokens: 16000,
    maxOutputTokens: 1024,
  };
}

function unitsFixture(): SpeakerLabelBridgeUnit[] {
  return [
    {
      bridgeUnitId: "019ed079-0000-7000-8000-00000000a001",
      sourceUnitKey: "scene.001.line.001",
      sourceText: "「我こそが勇者だ」",
      sourceHash: "src-hash-1",
      parserSpeakerHint: "勇者",
    },
    {
      bridgeUnitId: "019ed079-0000-7000-8000-00000000a002",
      sourceUnitKey: "scene.001.line.002",
      sourceText: "「……」",
      sourceHash: "src-hash-2",
      parserSpeakerHint: "????",
    },
    {
      bridgeUnitId: "019ed079-0000-7000-8000-00000000a003",
      sourceUnitKey: "scene.001.line.003",
      sourceText: "夜風が城門を揺らした。",
      sourceHash: "src-hash-3",
    },
    {
      bridgeUnitId: "019ed079-0000-7000-8000-00000000a004",
      sourceUnitKey: "scene.001.line.004",
      sourceText: "「誰だ?!」",
      sourceHash: "src-hash-4",
    },
  ];
}

function rosterFixture(): CharacterBio[] {
  return [
    {
      characterId: "char-yusha",
      displayName: "勇者",
      bioLocale: "ja-JP",
      bioText: "Protagonist of the story; introduced in scene 001.",
      hiddenFromReader: false,
    },
    {
      // The hidden character whose real identity is the demon lord. The
      // reader sees only the masked form until a later reveal.
      characterId: "char-maou",
      displayName: "魔王",
      bioLocale: "ja-JP",
      bioText: "Antagonist; identity withheld until scene 014.",
      hiddenFromReader: true,
      maskedCharacterId: "masked-shadow-001",
      maskedDisplayName: "??? (cloaked figure)",
    },
  ];
}

function inputFixture(
  overrides: Partial<SpeakerLabelInvocationInput> = {},
): SpeakerLabelInvocationInput {
  return {
    projectId: "019ed079-0000-7000-8000-000000000001",
    localeBranchId: "019ed079-0000-7000-8000-000000000002",
    sourceLocale: "ja-JP",
    bridgeUnits: unitsFixture(),
    knownCharacters: rosterFixture(),
    existingSpeakerLabels: new Map(),
    promptTemplateVersion: "itotori-speaker-label-agent-v1",
    modelMetadata: modelProfile(),
    now: FIXED_NOW,
    ...overrides,
  };
}

function makeOutput(labels: SpeakerLabel[]): SpeakerLabelOutput {
  return {
    schemaVersion: SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
    labels,
  };
}

function namedLabel(
  bridgeUnitId: string,
  opts: { characterId?: string; displayName?: string } = {},
): SpeakerLabel {
  return {
    bridgeUnitId,
    speakerId: {
      kind: "named",
      characterId: opts.characterId ?? "char-yusha",
      displayName: opts.displayName ?? "勇者",
    },
    confidence: "high",
    evidenceRefs: ["parser-hint"],
    agentRationale: "Parser hint names the hero directly.",
  };
}

function maskedLabel(bridgeUnitId: string, opts: { internal?: string } = {}): SpeakerLabel {
  const id: SpeakerIdentity = {
    kind: "unknown_to_reader",
    maskedCharacterId: "masked-shadow-001",
    maskedDisplayName: "??? (cloaked figure)",
  };
  if (opts.internal !== undefined) {
    id.internalCharacterId = opts.internal;
  }
  return {
    bridgeUnitId,
    speakerId: id,
    confidence: "high",
    evidenceRefs: ["scene-summary:scene-001"],
    agentRationale: "Cloaked figure; identity is a narrative reveal.",
  };
}

function unknownToParserLabel(
  bridgeUnitId: string,
  reason: "no_signal" | "conflicting_signals" | "ambient_dialogue",
): SpeakerLabel {
  return {
    bridgeUnitId,
    speakerId: { kind: "unknown_to_parser", reason },
    confidence: "low",
    evidenceRefs: ["parser-hint"],
    agentRationale: `Marked unknown_to_parser (${reason}).`,
  };
}

function narrationLabel(bridgeUnitId: string): SpeakerLabel {
  return {
    bridgeUnitId,
    speakerId: { kind: "narration" },
    confidence: "high",
    evidenceRefs: ["scene-summary:scene-001"],
    agentRationale: "Sentence is a scene descriptor with no spoken voice.",
  };
}

function buildFakeProvider(
  generate: (request: ModelInvocationRequest) => string,
): FakeModelProvider {
  return new FakeModelProvider({
    providerName: "speaker-label-fake",
    modelId: "itotori-fake-speaker-label-v0",
    generate,
  });
}

describe("Speaker-label prompt template", () => {
  it("is byte-stable across calls (same input -> same hash)", () => {
    const input = inputFixture();
    const a = buildSpeakerLabelPrompt(input);
    const b = buildSpeakerLabelPrompt(input);
    expect(a).toEqual(b);
    expect(speakerLabelPromptHash(a)).toEqual(speakerLabelPromptHash(b));
  });

  it("orders units by sourceUnitKey regardless of input order", () => {
    const base = inputFixture();
    const reversed = inputFixture({ bridgeUnits: [...base.bridgeUnits].reverse() });
    expect(speakerLabelPromptHash(buildSpeakerLabelPrompt(base))).toEqual(
      speakerLabelPromptHash(buildSpeakerLabelPrompt(reversed)),
    );
  });

  it("states the exact schema version, allowed kinds, and metadata prohibition", () => {
    const rendered = buildSpeakerLabelPrompt(inputFixture());
    expect(rendered.systemText).toContain(
      `The schemaVersion field MUST equal EXACTLY the string "${SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION}"`,
    );
    expect(rendered.systemText).toContain(
      "The only allowed speakerId.kind values are EXACTLY: named, unknown_to_reader, unknown_to_parser, narration.",
    );
    expect(rendered.systemText).toContain('Do NOT include a "$schema" property');
  });

  it("declares the output schema version and every identity kind", () => {
    const rendered = buildSpeakerLabelPrompt(inputFixture());
    expect(rendered.systemText).toContain(SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION);
    for (const kind of ["named", "unknown_to_reader", "unknown_to_parser", "narration"]) {
      expect(rendered.systemText).toContain(kind);
    }
  });

  it("surfaces hidden characters with their masked identifiers and a USE MASK directive", () => {
    const rendered = buildSpeakerLabelPrompt(inputFixture());
    expect(rendered.userText).toContain("HIDDEN");
    expect(rendered.userText).toContain("masked-shadow-001");
    expect(rendered.userText).toContain("USE MASK");
    // Internal-id appears in the prompt because the agent needs to know
    // the mapping; the run-time invariant ensures it never leaks back
    // out as a named identity.
    expect(rendered.userText).toContain("char-maou");
  });
});

describe("SpeakerLabelAgent.invokeSpeakerLabel happy path", () => {
  it("returns parsed labels covering each of the four SpeakerIdentity kinds", async () => {
    const input = inputFixture();
    const labels: SpeakerLabel[] = [
      namedLabel(input.bridgeUnits[0]!.bridgeUnitId),
      maskedLabel(input.bridgeUnits[1]!.bridgeUnitId, { internal: "char-maou" }),
      narrationLabel(input.bridgeUnits[2]!.bridgeUnitId),
      unknownToParserLabel(input.bridgeUnits[3]!.bridgeUnitId, "conflicting_signals"),
    ];
    const provider = buildFakeProvider(() => JSON.stringify(makeOutput(labels)));
    const agent = new SpeakerLabelAgent({ provider });

    const result = await agent.invokeSpeakerLabel(FIXED_ACTOR, input);
    expect(result.labels).toEqual(labels);
    expect(result.providerRunId).toMatch(/^fake-/);
    expect(result.promptHashUsed).toMatch(/^[0-9a-f]{64}$/);
    expect(result.tokensIn).toBeGreaterThan(0);
    expect(result.tokensOut).toBeGreaterThan(0);
    expect(result.modelMetadata.modelProfile).toEqual(input.modelMetadata);
    expect(result.recordedArtifactId).toBeUndefined();
  });

  it("accepts an empty label set (zero-finding response is valid)", async () => {
    const input = inputFixture();
    const provider = buildFakeProvider(() => JSON.stringify(makeOutput([])));
    const agent = new SpeakerLabelAgent({ provider });
    const result = await agent.invokeSpeakerLabel(FIXED_ACTOR, input);
    expect(result.labels).toEqual([]);
  });

  it("ITOTORI-220: providerId is propagated through to the ModelProvider call", async () => {
    const input = inputFixture({
      modelMetadata: {
        ...modelProfile(),
        providerId: "fake-fixture-pair-test",
      },
    });
    let observedProviderId: string | undefined;
    const provider = new FakeModelProvider({
      providerName: "speaker-label-fake",
      modelId: "itotori-fake-speaker-label-v0",
      generate: (request) => {
        observedProviderId = request.providerId;
        return JSON.stringify(makeOutput([]));
      },
    });
    const agent = new SpeakerLabelAgent({ provider });
    const result = await agent.invokeSpeakerLabel(FIXED_ACTOR, input);
    expect(observedProviderId).toBe("fake-fixture-pair-test");
    expect(result.modelMetadata.providerIdentity.requestedProviderId).toBe(
      "fake-fixture-pair-test",
    );
  });
});

describe("SpeakerLabelAgent.invokeSpeakerLabel pre-flight invariants", () => {
  it("rejects empty input", async () => {
    const input = inputFixture({ bridgeUnits: [] });
    const provider = buildFakeProvider(() => JSON.stringify(makeOutput([])));
    const agent = new SpeakerLabelAgent({ provider });
    await expect(agent.invokeSpeakerLabel(FIXED_ACTOR, input)).rejects.toBeInstanceOf(
      SpeakerLabelEmptyInputError,
    );
  });

  it("rejects empty source locale", async () => {
    const input = inputFixture({ sourceLocale: "" });
    const provider = buildFakeProvider(() => JSON.stringify(makeOutput([])));
    const agent = new SpeakerLabelAgent({ provider });
    await expect(agent.invokeSpeakerLabel(FIXED_ACTOR, input)).rejects.toBeInstanceOf(
      SpeakerLabelLocaleMismatchError,
    );
  });

  it("rejects a roster where a hidden bio is missing its mask", async () => {
    const input = inputFixture({
      knownCharacters: [
        {
          characterId: "char-maou",
          displayName: "魔王",
          bioLocale: "ja-JP",
          bioText: "Antagonist.",
          hiddenFromReader: true,
          // no maskedCharacterId / maskedDisplayName — the roster is
          // internally inconsistent.
        },
      ],
    });
    const provider = buildFakeProvider(() => JSON.stringify(makeOutput([])));
    const agent = new SpeakerLabelAgent({ provider });
    await expect(agent.invokeSpeakerLabel(FIXED_ACTOR, input)).rejects.toBeInstanceOf(
      SpeakerLabelHiddenMaskMismatchError,
    );
  });
});

describe("SpeakerLabelAgent.invokeSpeakerLabel provider capability guard", () => {
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
      defaultModelId: "itotori-fake-speaker-label-v0",
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
          cost: { costKind: "zero", currency: "USD", amountUsd: "0", amountMicrosUsd: 0 },
          prompt: request.prompt,
        };
        return {
          content: JSON.stringify(makeOutput([])),
          toolCalls: [],
          finishReason: "stop",
          providerRun,
        };
      },
    };
  }

  it("throws SpeakerLabelProviderCapabilityError when the provider does not declare structured-output support", async () => {
    const provider = makeStructuredOutputUnsupportedProvider();
    const agent = new SpeakerLabelAgent({ provider });
    const error = await agent
      .invokeSpeakerLabel(FIXED_ACTOR, inputFixture())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SpeakerLabelProviderCapabilityError);
  });
});

describe("SpeakerLabelAgent.invokeSpeakerLabel hidden-identity preservation (P0)", () => {
  it("POSITIVE: a hiddenFromReader: true character is correctly labeled unknown_to_reader and the input round-trips", async () => {
    const input = inputFixture();
    // The hidden character speaks line a002. The provider emits the
    // mask, not the internal identity.
    const labels: SpeakerLabel[] = [
      maskedLabel(input.bridgeUnits[1]!.bridgeUnitId, { internal: "char-maou" }),
    ];
    const provider = buildFakeProvider(() => JSON.stringify(makeOutput(labels)));
    const agent = new SpeakerLabelAgent({ provider });
    const result = await agent.invokeSpeakerLabel(FIXED_ACTOR, input);
    expect(result.labels).toHaveLength(1);
    const id = result.labels[0]!.speakerId;
    expect(id.kind).toBe("unknown_to_reader");
    if (id.kind === "unknown_to_reader") {
      expect(id.maskedCharacterId).toBe("masked-shadow-001");
      expect(id.maskedDisplayName).toBe("??? (cloaked figure)");
      // Internal id is preserved on the INTERNAL surface for tracking.
      expect(id.internalCharacterId).toBe("char-maou");
    }
  });

  it("NEGATIVE: a `named` label for a hidden character (by characterId) throws HiddenIdentityLeakError", async () => {
    const input = inputFixture();
    const leakedLabels: SpeakerLabel[] = [
      // Attempt to leak the demon lord's identity using the internal
      // character id.
      {
        bridgeUnitId: input.bridgeUnits[1]!.bridgeUnitId,
        speakerId: {
          kind: "named",
          characterId: "char-maou",
          displayName: "Demon Lord",
        },
        confidence: "high",
        evidenceRefs: ["parser-hint"],
        agentRationale: "I figured it out from the bio.",
      },
    ];
    const provider = buildFakeProvider(() => JSON.stringify(makeOutput(leakedLabels)));
    const agent = new SpeakerLabelAgent({ provider });
    const error = await agent.invokeSpeakerLabel(FIXED_ACTOR, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HiddenIdentityLeakError);
    if (error instanceof HiddenIdentityLeakError) {
      expect(error.bridgeUnitId).toBe(input.bridgeUnits[1]!.bridgeUnitId);
      expect(error.leakedCharacterId).toBe("char-maou");
      expect(error.maskedCharacterId).toBe("masked-shadow-001");
    }
  });

  it("NEGATIVE: a `named` label for a hidden character (by displayName) also throws HiddenIdentityLeakError", async () => {
    const input = inputFixture();
    const leakedLabels: SpeakerLabel[] = [
      {
        bridgeUnitId: input.bridgeUnits[1]!.bridgeUnitId,
        speakerId: {
          kind: "named",
          characterId: "any-id-shape",
          displayName: "魔王",
        },
        confidence: "high",
        evidenceRefs: ["parser-hint"],
        agentRationale: "Leaks via displayName.",
      },
    ];
    const provider = buildFakeProvider(() => JSON.stringify(makeOutput(leakedLabels)));
    const agent = new SpeakerLabelAgent({ provider });
    await expect(agent.invokeSpeakerLabel(FIXED_ACTOR, input)).rejects.toBeInstanceOf(
      HiddenIdentityLeakError,
    );
  });

  it("rejects an unknown_to_reader label whose mask does not match the roster", async () => {
    const input = inputFixture();
    const bad: SpeakerLabel[] = [
      {
        bridgeUnitId: input.bridgeUnits[1]!.bridgeUnitId,
        speakerId: {
          kind: "unknown_to_reader",
          maskedCharacterId: "masked-WRONG",
          maskedDisplayName: "??? (cloaked figure)",
          internalCharacterId: "char-maou",
        },
        confidence: "high",
        evidenceRefs: ["parser-hint"],
        agentRationale: "Masked but with the wrong mask id.",
      },
    ];
    const provider = buildFakeProvider(() => JSON.stringify(makeOutput(bad)));
    const agent = new SpeakerLabelAgent({ provider });
    await expect(agent.invokeSpeakerLabel(FIXED_ACTOR, input)).rejects.toBeInstanceOf(
      SpeakerLabelHiddenMaskMismatchError,
    );
  });
});

describe("SpeakerLabelAgent.invokeSpeakerLabel confidence floor", () => {
  it("rejects labels reporting confidence below the caller-supplied floor", async () => {
    const input = inputFixture({ confidenceFloor: "medium" });
    const labels: SpeakerLabel[] = [
      { ...narrationLabel(input.bridgeUnits[0]!.bridgeUnitId), confidence: "low" },
    ];
    const provider = buildFakeProvider(() => JSON.stringify(makeOutput(labels)));
    const agent = new SpeakerLabelAgent({ provider });
    const error = await agent.invokeSpeakerLabel(FIXED_ACTOR, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SpeakerLabelBelowConfidenceFloorError);
    if (error instanceof SpeakerLabelBelowConfidenceFloorError) {
      expect(error.bridgeUnitId).toBe(input.bridgeUnits[0]!.bridgeUnitId);
      expect(error.observed).toBe("low");
      expect(error.floor).toBe("medium");
    }
  });

  it("accepts labels meeting the floor", async () => {
    const input = inputFixture({ confidenceFloor: "medium" });
    const labels: SpeakerLabel[] = [
      { ...narrationLabel(input.bridgeUnits[0]!.bridgeUnitId), confidence: "medium" },
    ];
    const provider = buildFakeProvider(() => JSON.stringify(makeOutput(labels)));
    const agent = new SpeakerLabelAgent({ provider });
    await expect(agent.invokeSpeakerLabel(FIXED_ACTOR, input)).resolves.toMatchObject({
      labels: [expect.objectContaining({ confidence: "medium" })],
    });
  });
});

describe("SpeakerLabelAgent.invokeSpeakerLabel malformed and ambient responses", () => {
  it("rejects non-JSON content with SpeakerLabelResponseValidationError", async () => {
    const input = inputFixture();
    const provider = buildFakeProvider(() => "not-json");
    const agent = new SpeakerLabelAgent({ provider });
    const error = await agent.invokeSpeakerLabel(FIXED_ACTOR, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SpeakerLabelResponseValidationError);
  });

  it("rejects a label citing an unknown bridge unit id", async () => {
    const input = inputFixture();
    const labels: SpeakerLabel[] = [namedLabel("019ed079-0000-7000-8000-deadbeefdead")];
    const provider = buildFakeProvider(() => JSON.stringify(makeOutput(labels)));
    const agent = new SpeakerLabelAgent({ provider });
    await expect(agent.invokeSpeakerLabel(FIXED_ACTOR, input)).rejects.toBeInstanceOf(
      SpeakerLabelUnknownCitationError,
    );
  });

  it("rejects an unknown_to_parser label whose reason is outside the closed enum", async () => {
    const input = inputFixture();
    const labels = [
      {
        bridgeUnitId: input.bridgeUnits[0]!.bridgeUnitId,
        speakerId: { kind: "unknown_to_parser", reason: "vibes" },
        confidence: "low",
        evidenceRefs: ["parser-hint"],
        agentRationale: "Bad reason.",
      },
    ];
    const provider = buildFakeProvider(() =>
      JSON.stringify({ schemaVersion: SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION, labels }),
    );
    const agent = new SpeakerLabelAgent({ provider });
    await expect(agent.invokeSpeakerLabel(FIXED_ACTOR, input)).rejects.toBeInstanceOf(
      SpeakerLabelResponseValidationError,
    );
  });
});

describe("SpeakerLabelAgent.invokeSpeakerLabel narration vs dialogue distinction", () => {
  it("accepts narration labels for non-dialogue lines without inventing speakers", async () => {
    const input = inputFixture();
    const labels: SpeakerLabel[] = [narrationLabel(input.bridgeUnits[2]!.bridgeUnitId)];
    const provider = buildFakeProvider(() => JSON.stringify(makeOutput(labels)));
    const agent = new SpeakerLabelAgent({ provider });
    const result = await agent.invokeSpeakerLabel(FIXED_ACTOR, input);
    const id = result.labels[0]!.speakerId;
    expect(id.kind).toBe("narration");
  });

  it("preserves the unknown_to_parser variant when the agent reports ambient dialogue", async () => {
    const input = inputFixture();
    const labels: SpeakerLabel[] = [
      unknownToParserLabel(input.bridgeUnits[3]!.bridgeUnitId, "ambient_dialogue"),
    ];
    const provider = buildFakeProvider(() => JSON.stringify(makeOutput(labels)));
    const agent = new SpeakerLabelAgent({ provider });
    const result = await agent.invokeSpeakerLabel(FIXED_ACTOR, input);
    const id = result.labels[0]!.speakerId;
    expect(id.kind).toBe("unknown_to_parser");
    if (id.kind === "unknown_to_parser") {
      expect(id.reason).toBe("ambient_dialogue");
    }
  });
});

describe("SpeakerLabelAgent.invokeSpeakerLabel partial / fallback diagnostics", () => {
  it("throws SpeakerLabelPartialResultError when the provider returns empty content", async () => {
    const input = inputFixture();
    const provider = buildFakeProvider(() => "");
    const agent = new SpeakerLabelAgent({ provider });
    await expect(agent.invokeSpeakerLabel(FIXED_ACTOR, input)).rejects.toBeInstanceOf(
      SpeakerLabelPartialResultError,
    );
  });
});

describe("environment hygiene", () => {
  it("emits no live provider construction at import time (live opt-in only)", () => {
    expect(process.env.ITOTORI_LIVE_PROVIDER ?? "").toBe("");
  });
});
