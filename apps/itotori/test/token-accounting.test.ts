// general-audit-1 (genaudit1-00 / genaudit1-01) regression suite.
//
// PROJECT LAW: token counts come ONLY from real provider call output —
// never approximated, defaulted, or estimated. Before this fix, seven
// agents and the agentic-loop probe fell back to a char/4 estimate (or
// zero) and persisted it indistinguishably from a provider-reported count.
//
// These tests pin the two enforcement points:
//   1. The central guard (assertReportedTokenUsage / assertReportedTokenCount).
//   2. The agent boundary (TranslationAgent throws on a missing/estimated
//      count instead of silently recording one).
import { describe, expect, it } from "vitest";
import {
  STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
  type TranslationDraft,
} from "@itotori/localization-bridge-schema";
import {
  assertReportedTokenCount,
  assertReportedTokenUsage,
  isRealTokenCountSource,
  MissingProviderTokenCountError,
} from "../src/providers/token-accounting.js";
import { FakeModelProvider } from "../src/providers/fake.js";
import type {
  ModelInvocationRequest,
  ModelInvocationResult,
  ModelProvider,
  ProviderDescriptor,
  TokenUsage,
} from "../src/providers/types.js";
import {
  makeStructuredTranslationDraftOutputFixture,
  representativeTranslationDraftsFixture,
  TRANSLATION_FIXTURE_BRIDGE_UNIT_BASE,
  TRANSLATION_FIXTURE_DRAFT_JOB_ATTEMPT_ID,
  TRANSLATION_FIXTURE_DRAFT_JOB_ID,
  TRANSLATION_FIXTURE_LOCALE_BRANCH_ID,
  TRANSLATION_FIXTURE_PROJECT_ID,
  TRANSLATION_FIXTURE_SOURCE_LOCALE,
  TRANSLATION_FIXTURE_TARGET_LOCALE,
  TranslationAgent,
  type TranslationBridgeUnit,
  type TranslationInvocationInput,
  type TranslationModelProfile,
  type TranslationProtectedSpanInput,
} from "../src/agents/translation/index.js";

const FIXED_ACTOR = { userId: "local-user" };
const FIXED_NOW = (): Date => new Date("2026-06-24T12:00:00Z");

// ---------------------------------------------------------------------------
// 1. The central guard.
// ---------------------------------------------------------------------------

describe("token-accounting guard", () => {
  it("returns real counts for a provider_reported usage block", () => {
    const usage: TokenUsage = {
      tokenCountSource: "provider_reported",
      promptTokens: 480,
      completionTokens: 220,
    };
    expect(assertReportedTokenUsage(usage, "run-1")).toEqual({
      tokensIn: 480,
      tokensOut: 220,
      tokenCountSource: "provider_reported",
    });
  });

  it("accepts deterministic_counter (recorded/fake real counts flow through)", () => {
    const usage: TokenUsage = {
      tokenCountSource: "deterministic_counter",
      promptTokens: 12,
      completionTokens: 7,
    };
    expect(assertReportedTokenUsage(usage, "run-recorded")).toEqual({
      tokensIn: 12,
      tokensOut: 7,
      tokenCountSource: "deterministic_counter",
    });
  });

  it("throws when promptTokens is absent (no `?? estimate` substitution)", () => {
    const usage: TokenUsage = { tokenCountSource: "provider_reported", completionTokens: 7 };
    expect(() => assertReportedTokenCount(usage, "promptTokens", "run-2")).toThrow(
      MissingProviderTokenCountError,
    );
  });

  it("throws when completionTokens is absent", () => {
    const usage: TokenUsage = { tokenCountSource: "provider_reported", promptTokens: 7 };
    expect(() => assertReportedTokenUsage(usage, "run-3")).toThrow(MissingProviderTokenCountError);
  });

  it("throws when the source is `estimated` even though counts are present", () => {
    // An estimate must NEVER be accepted as a real count, regardless of
    // whether numbers are present.
    const usage: TokenUsage = {
      tokenCountSource: "estimated",
      promptTokens: 100,
      completionTokens: 50,
    };
    const error = (() => {
      try {
        assertReportedTokenUsage(usage, "run-est");
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(MissingProviderTokenCountError);
    expect((error as MissingProviderTokenCountError).code).toBe("provider_response_invalid");
    expect((error as MissingProviderTokenCountError).tokenCountSource).toBe("estimated");
  });

  it("throws when the source is `unknown` (provider omitted usage entirely)", () => {
    const usage: TokenUsage = { tokenCountSource: "unknown" };
    expect(() => assertReportedTokenUsage(usage, "run-unknown")).toThrow(
      MissingProviderTokenCountError,
    );
  });

  it("isRealTokenCountSource classifies provenances", () => {
    expect(isRealTokenCountSource("provider_reported")).toBe(true);
    expect(isRealTokenCountSource("deterministic_counter")).toBe(true);
    expect(isRealTokenCountSource("estimated")).toBe(false);
    expect(isRealTokenCountSource("unknown")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. The agent boundary.
// ---------------------------------------------------------------------------

/**
 * Wraps a FakeModelProvider but stamps a caller-chosen `tokenUsage` onto the
 * resulting provider run — lets us drive an agent with a provider that
 * omits / fabricates token counts.
 */
class TokenUsageOverrideProvider implements ModelProvider {
  readonly descriptor: ProviderDescriptor;
  constructor(
    private readonly inner: FakeModelProvider,
    private readonly usage: TokenUsage,
  ) {
    this.descriptor = inner.descriptor;
  }
  async invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult> {
    const result = await this.inner.invoke(request);
    return {
      ...result,
      providerRun: { ...result.providerRun, tokenUsage: this.usage },
    };
  }
}

function fakeModelProfile(): TranslationModelProfile {
  return {
    providerFamily: "fake",
    modelId: "itotori-fake-translation-v0",
    providerId: "fake-fixture",
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
  ];
}

function protectedSpansFixture(): Map<string, TranslationProtectedSpanInput[]> {
  return new Map<string, TranslationProtectedSpanInput[]>([
    [
      `${TRANSLATION_FIXTURE_BRIDGE_UNIT_BASE}01`,
      [{ refId: "span-greeting-placeholder", sourceText: "{player}" }],
    ],
  ]);
}

function inputFixture(): TranslationInvocationInput {
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
    ],
    styleGuide: [{ ruleId: "tone-001", section: "tone", guidance: "Use a formal register." }],
    contextArtifactRefs: ["context-artifact:scene-summary-001"],
    modelProfile: fakeModelProfile(),
    promptTemplateVersion: "itotori-translation-agent-v1",
    now: FIXED_NOW,
  };
}

function singleDraftOutput(): TranslationDraft[] {
  const drafts = representativeTranslationDraftsFixture();
  return [{ ...drafts[0], bridgeUnitId: `${TRANSLATION_FIXTURE_BRIDGE_UNIT_BASE}01` }];
}

function buildProvider(usage: TokenUsage): TokenUsageOverrideProvider {
  const drafts = singleDraftOutput();
  const inner = new FakeModelProvider({
    providerName: "translation-fake",
    modelId: "itotori-fake-translation-v0",
    generate: () => JSON.stringify(makeStructuredTranslationDraftOutputFixture(drafts)),
  });
  return new TokenUsageOverrideProvider(inner, usage);
}

describe("TranslationAgent token-count law", () => {
  it("records real provider_reported counts on the happy path", async () => {
    const provider = buildProvider({
      tokenCountSource: "provider_reported",
      promptTokens: 321,
      completionTokens: 123,
    });
    const agent = new TranslationAgent({ provider });
    const result = await agent.invokeTranslation(FIXED_ACTOR, inputFixture());
    expect(result.tokensIn).toBe(321);
    expect(result.tokensOut).toBe(123);
    // Sanity: the output schema version is the one the agent declares.
    expect(STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION).toBeTruthy();
  });

  it("THROWS instead of estimating when the provider omits completion tokens", async () => {
    const provider = buildProvider({
      tokenCountSource: "provider_reported",
      promptTokens: 321,
      // completionTokens deliberately absent — previously this fell back to
      // estimateTokens(rawContent) and was silently recorded.
    });
    const agent = new TranslationAgent({ provider });
    await expect(agent.invokeTranslation(FIXED_ACTOR, inputFixture())).rejects.toBeInstanceOf(
      MissingProviderTokenCountError,
    );
  });

  it("THROWS when the provider returns an estimated usage block", async () => {
    const provider = buildProvider({
      tokenCountSource: "estimated",
      promptTokens: 321,
      completionTokens: 123,
    });
    const agent = new TranslationAgent({ provider });
    await expect(agent.invokeTranslation(FIXED_ACTOR, inputFixture())).rejects.toBeInstanceOf(
      MissingProviderTokenCountError,
    );
  });
});
