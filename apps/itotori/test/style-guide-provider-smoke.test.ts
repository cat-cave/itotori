import { describe, expect, it, vi } from "vitest";
import {
  AccountZdrAssertionError,
  OpenRouterProvider,
  openRouterDefaultCapabilities,
  type ModelCapabilities,
  type ModelInvocationResult,
  type ProviderRunRecord,
} from "../src/providers/index.js";
import {
  STYLE_GUIDE_LIVE_PROVIDER_ID_ENV,
  STYLE_GUIDE_LIVE_PROVIDER_MODEL_ENV,
  STYLE_GUIDE_LIVE_PROVIDER_SMOKE_FLAG,
  STYLE_GUIDE_PROVIDER_SMOKE_SCHEMA_VERSION,
  STYLE_GUIDE_SUGGESTION_TOOL_NAME,
  assertStyleGuideProviderSmokeFallbackLedger,
  assertStyleGuideProviderSmokeLedger,
  assertStyleGuideSuggestionStructuredOutput,
  parseStyleGuideSuggestionFromProviderResult,
  readSmokeFixture,
  runRecordedStyleGuideProviderSmoke,
  runStyleGuideProviderSmoke,
  styleGuideSuggestionRequest,
  styleGuideSuggestionSchemaDescriptor,
  type StyleGuideProviderSmokeFixture,
} from "../src/style-guide-provider-smoke.js";

describe("style-guide provider smoke", () => {
  it("validates the recorded provider suggestion fixture without network", () => {
    const fixture = readSmokeFixture();
    const result = runRecordedStyleGuideProviderSmoke(fixture);

    expect(result).toMatchObject({
      status: "passed",
      mode: "recorded",
      fixtureId: "style-guide-provider-smoke-recorded-v1",
    });
    if (result.status !== "passed") {
      throw new Error("recorded style-guide provider smoke should pass");
    }
    expect(result.parsed.diagnostics).toEqual([]);
    expect(result.parsed.projectedVersion).toMatchObject({
      styleGuideVersionId: "019ed064-0000-7000-8000-000000000030",
      acceptedProposalIds: [
        "019ed064-0000-7000-8000-000000000201",
        "019ed064-0000-7000-8000-000000000202",
      ],
    });
    expect(result.parsed.projectedVersion.policy.sections.tone).toEqual([
      expect.objectContaining({ ruleId: "tone-smoke-warm-direct" }),
    ]);
    expect(result.parsed.projectedVersion.policy.sections.protectedSpans).toEqual([
      expect.objectContaining({ ruleId: "protected-smoke-placeholder-exact" }),
    ]);
  });

  it("parses style-guide suggestions from tool-call structured output", () => {
    const fixture = readSmokeFixture();
    const providerRun: ProviderRunRecord = {
      ...fixture.providerRun,
      structuredOutputMode: "tool_call_arguments",
    };
    const result: ModelInvocationResult = {
      content: null,
      finishReason: "tool_calls",
      providerRun,
      toolCalls: [
        {
          id: "tool-call-style-guide",
          name: STYLE_GUIDE_SUGGESTION_TOOL_NAME,
          argumentsJson: JSON.stringify(fixture.providerResult.contentJson),
        },
      ],
    };

    const parsed = parseStyleGuideSuggestionFromProviderResult(result);

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.projectedVersion.acceptedProposalIds).toEqual(
      fixture.expected.acceptedProposalIds,
    );
  });

  it("rejects malformed structured output at the structured-output boundary before policy projection", () => {
    const fixture = readSmokeFixture();
    const result: ModelInvocationResult = {
      content: JSON.stringify({
        schemaVersion: "itotori.style-guide-conversation.v0",
        transcriptId: "malformed-style-guide-suggestion",
      }),
      finishReason: "stop",
      providerRun: fixture.providerRun,
      toolCalls: [],
    };

    // ITOTORI-133 — missing required top-level fields (turns/proposals/etc.)
    // now fail EARLY at the tightened schema boundary, before the deep
    // transcript validator or policy projection ever run.
    expect(() => parseStyleGuideSuggestionFromProviderResult(result)).toThrow(
      /style-guide suggestion rejected at structured-output boundary/u,
    );
  });

  it("accepts the recorded fixture content against the tightened structured-output schema", () => {
    const fixture = readSmokeFixture();
    expect(() =>
      assertStyleGuideSuggestionStructuredOutput(fixture.providerResult.contentJson),
    ).not.toThrow();
  });

  it("exposes typed item requirements for turns and proposals in the structured-output schema", () => {
    // ITOTORI-133 — turns/proposals are no longer bare `{ type: "array" }`;
    // each carries typed item requirements (required fields + shapes) so the
    // structured-output boundary rejects malformed items.
    const turns = styleGuideSuggestionSchemaDescriptor.jsonSchema.properties?.turns as
      | Record<string, unknown>
      | undefined;
    const proposals = styleGuideSuggestionSchemaDescriptor.jsonSchema.properties?.proposals as
      | Record<string, unknown>
      | undefined;

    expect(turns?.type).toBe("array");
    expect(turns?.items).toMatchObject({
      type: "object",
      required: expect.arrayContaining([
        "turnId",
        "role",
        "localeBranchId",
        "policyVersionId",
        "redaction",
        "proposalIds",
        "citations",
        "publicSummary",
      ]),
    });
    expect(proposals?.type).toBe("array");
    expect(proposals?.items).toMatchObject({
      type: "object",
      required: expect.arrayContaining([
        "proposalId",
        "turnId",
        "rationale",
        "citationIds",
        "examples",
        "edits",
        "decision",
      ]),
    });
  });

  it("rejects a turn missing turnId at the structured-output boundary", () => {
    const content = cloneFixtureContentJson();
    delete content.turns[0]!.turnId;

    expect(() => assertStyleGuideSuggestionStructuredOutput(content)).toThrow(
      /rejected at structured-output boundary:.*turns\[0\]\.turnId is required/u,
    );
  });

  it("rejects a non-object turn item at the structured-output boundary", () => {
    const content = cloneFixtureContentJson();
    content.turns[0] = "not-an-object" as unknown as (typeof content.turns)[number];

    expect(() => assertStyleGuideSuggestionStructuredOutput(content)).toThrow(
      /rejected at structured-output boundary:.*turns\[0\] must be an object/u,
    );
  });

  it("rejects a proposal missing proposalId at the structured-output boundary", () => {
    const content = cloneFixtureContentJson();
    delete content.proposals[0]!.proposalId;

    expect(() => assertStyleGuideSuggestionStructuredOutput(content)).toThrow(
      /rejected at structured-output boundary:.*proposals\[0\]\.proposalId is required/u,
    );
  });

  it("rejects a proposal edit missing its rule object at the structured-output boundary", () => {
    const content = cloneFixtureContentJson();
    delete content.proposals[0]!.edits[0]!.rule;

    expect(() => assertStyleGuideSuggestionStructuredOutput(content)).toThrow(
      /rejected at structured-output boundary:.*proposals\[0\]\.edits\[0\]\.rule is required/u,
    );
  });

  it("rejects a proposal with an empty edits array at the structured-output boundary", () => {
    const content = cloneFixtureContentJson();
    content.proposals[0]!.edits = [];

    expect(() => assertStyleGuideSuggestionStructuredOutput(content)).toThrow(
      /rejected at structured-output boundary:.*proposals\[0\]\.edits must contain at least 1/u,
    );
  });

  it("asserts routed provider, model, fallback, retry, token, cost, and policy ledger fields", () => {
    const fixture = readSmokeFixture();

    expect(() => assertStyleGuideProviderSmokeLedger(fixture.providerRun)).not.toThrow();
    expect(fixture.providerRun).toMatchObject({
      provider: {
        providerFamily: "recorded",
        endpointFamily: "recorded-fixture",
        providerName: "recorded-style-guide-provider",
        requestedModelId: "style-guide-smoke-model-v1",
        actualModelId: "style-guide-smoke-model-v1-routed",
        upstreamProvider: "recorded-upstream",
      },
      fallbackUsed: true,
      fallbackPlan: ["style-guide-smoke-model-v1", "style-guide-smoke-model-v1-routed"],
      retryCount: 1,
      tokenUsage: {
        tokenCountSource: "estimated",
        totalTokens: 530,
      },
      cost: {
        costKind: "billed",
        amountMicrosUsd: 42, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
      },
      // ITOTORI-227 — per-pair `dataHandling` / privacy axes are gone;
      // privacy is enforced account-wide (ZDR assertion) plus
      // per-request (provider.zdr=true default for non-public input).
    });
  });

  it("fails before invocation when capability guards reject style-guide structured output", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    const provider = new OpenRouterProvider({
      modelId: "deepseek/deepseek-v4-flash",
      apiKey: "test-key",
      fetch: fetchMock,
      live: { enabled: true, artifactRecorder: memoryRecorder(), rawCapture: "disabled" },
    });

    await expect(
      provider.invoke(styleGuideSuggestionRequest("deepseek/deepseek-v4-flash")),
    ).rejects.toMatchObject({
      code: "capability_unsupported",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts mocked successful OpenRouter live ledger with real billed usage.cost", async () => {
    const fixture = readSmokeFixture();
    const recorder = memoryRecorder();
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        id: "gen-style-guide-cost-test",
        model: "openai/gpt-4o-mini",
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify(fixture.providerResult.contentJson),
            },
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 42,
          total_tokens: 142,
          cost: 0.000123, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
        },
        openrouter_metadata: {
          requested: "openai/gpt-4o-mini",
          strategy: "direct",
          attempt: 1,
          endpoints: {
            available: [
              {
                provider: "OpenAI",
                model: "openai/gpt-4o-mini",
                selected: true,
              },
            ],
          },
        },
      }),
    ) as unknown as typeof fetch;
    const provider = new OpenRouterProvider({
      modelId: "openai/gpt-4o-mini",
      apiKey: "test-key",
      fetch: fetchMock,
      capabilities: styleGuideLiveSmokeCapabilities(),
      live: { enabled: true, artifactRecorder: recorder, rawCapture: "disabled" },
    });

    // ITOTORI-220 — pin the providerId so the post-response upstream check
    // accepts the mocked `OpenAI` upstream.
    const result = await provider.invoke(
      styleGuideSuggestionRequest("openai/gpt-4o-mini", "OpenAI"),
    );

    expect(result.providerRun.cost).toEqual({
      costKind: "billed",
      currency: "USD",
      amountUsd: "0.000123", // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
      amountMicrosUsd: 123, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
      // ITOTORI-233 — synthetic response has no usage.cost_details so
      // the cache discount lands as 0.
      cacheDiscountMicrosUsd: 0,
    });
    expect(recorder.recordProviderRun).toHaveBeenCalledWith(
      expect.objectContaining({
        run: expect.objectContaining({
          cost: {
            costKind: "billed",
            currency: "USD",
            amountUsd: "0.000123", // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
            amountMicrosUsd: 123, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
            cacheDiscountMicrosUsd: 0,
          },
        }),
      }),
    );
    expect(() => assertStyleGuideProviderSmokeLedger(result.providerRun)).not.toThrow();
  });

  // ITOTORI-132 — Style-guide live smoke fallback coverage.
  //
  // The generic OpenRouter provider unit tests (openrouter-provider.test.ts
  // ITOTORI-242) already prove fallbackUsed + the served pair are recorded on
  // an OR-side ZDR fallback. These tests exercise the SAME recording through
  // the style-guide LIVE SMOKE path (with a MOCKED provider), so the smoke
  // ledger — not just the generic provider — proves fallbackPlan +
  // fallbackChain (+ the served pair) are recorded when a fallback occurs.
  // Per [[feedback_or_side_fallback_not_strict_pin]] the OR-side fallback
  // records the real served pair rather than enforcing a strict provider pin.
  it("ITOTORI-132: records fallbackPlan + fallbackChain + served pair for a mocked successful fallback run through the live smoke path", async () => {
    const fixture = readSmokeFixture();
    const primaryModel = "openai/gpt-4o-mini";
    const fallbackModel = "deepseek/deepseek-v4-flash";
    const servedProvider = "DeepSeek";
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        id: "gen-style-guide-fallback",
        // OpenRouter served the FALLBACK model after the primary 429'd.
        model: fallbackModel,
        provider: servedProvider,
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify(fixture.providerResult.contentJson),
            },
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 42,
          total_tokens: 142,
          cost: 0.000123, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
        },
        openrouter_metadata: {
          requested: primaryModel,
          strategy: "fallback",
          // attempt is 1-indexed: attempt=2 means OpenRouter advanced past the
          // 429'd primary to the next ZDR-allow-list provider (1 retry).
          attempt: 2,
          summary: `${primaryModel} rate-limited (429); served by ${servedProvider}`,
        },
      }),
    ) as unknown as typeof fetch;

    const result = await runStyleGuideProviderSmoke({
      mode: "live",
      env: {
        [STYLE_GUIDE_LIVE_PROVIDER_SMOKE_FLAG]: "1",
        OPENROUTER_API_KEY: "test-key",
        OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1",
        [STYLE_GUIDE_LIVE_PROVIDER_MODEL_ENV]: primaryModel,
        [STYLE_GUIDE_LIVE_PROVIDER_ID_ENV]: "OpenAI",
      },
      fetch: fetchMock,
      fallbackModels: [fallbackModel],
    });

    expect(result.status).toBe("passed");
    if (result.status !== "passed") {
      throw new Error("style-guide live fallback smoke should pass");
    }
    // The smoke ledger records the full fallbackPlan (primary + fallback).
    expect(result.providerRun.fallbackPlan).toEqual([primaryModel, fallbackModel]);
    // fallbackUsed is true: the chain was exercised.
    expect(result.providerRun.fallbackUsed).toBe(true);
    // requestedModelId is the primary; actualModelId is the served fallback.
    expect(result.providerRun.provider.requestedModelId).toBe(primaryModel);
    expect(result.providerRun.provider.actualModelId).toBe(fallbackModel);
    // The real served pair (model + upstream provider) is recorded as truth.
    expect(result.providerRun.provider.upstreamProvider).toBe(servedProvider);
    // retryCount is coherent: a fallback occurred → >= 1 retry (attempt-1).
    expect(result.providerRun.retryCount).toBe(1);

    // The OR-side fallback chain (openrouterRouting) is mirrored verbatim
    // onto the invocation's adapterMetadata AND the recorded artifact, so the
    // swap is auditable, not silent.
    const routing = (result.adapterMetadata as Record<string, unknown> | undefined)
      ?.openrouterRouting as { attempt?: number; summary?: string; strategy?: string } | undefined;
    expect(routing?.attempt).toBe(2);
    expect(routing?.strategy).toBe("fallback");
    expect(routing?.summary).toContain(servedProvider);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.adapterMetadata?.openrouterRouting).toMatchObject({
      attempt: 2,
      strategy: "fallback",
    });

    // The fallback-specific ledger assertion proves the fields are coherent.
    expect(() =>
      assertStyleGuideProviderSmokeFallbackLedger(result.providerRun, {
        requestedModelId: primaryModel,
        fallbackModel,
        servedModelId: fallbackModel,
        servedProviderId: servedProvider,
      }),
    ).not.toThrow();
    // The structural ledger assertion still holds for the fallback run.
    expect(() => assertStyleGuideProviderSmokeLedger(result.providerRun)).not.toThrow();
    // The mocked fallback run made exactly one fetch (no itotori-side retry).
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ITOTORI-132: assertStyleGuideProviderSmokeFallbackLedger rejects a direct-serve run (no fallback) as incoherent", async () => {
    // A direct serve (preferred provider answers, no fallback) must NOT pass
    // the fallback ledger assertion: fallbackUsed is false and retryCount is
    // 0, so the coherence check fails loud rather than silently accepting a
    // misleading fallback plan.
    const fixture = readSmokeFixture();
    const primaryModel = "openai/gpt-4o-mini";
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        id: "gen-style-guide-direct",
        model: primaryModel,
        provider: "OpenAI",
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify(fixture.providerResult.contentJson),
            },
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 42,
          total_tokens: 142,
          cost: 0.000123, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
        },
      }),
    ) as unknown as typeof fetch;

    const result = await runStyleGuideProviderSmoke({
      mode: "live",
      env: {
        [STYLE_GUIDE_LIVE_PROVIDER_SMOKE_FLAG]: "1",
        OPENROUTER_API_KEY: "test-key",
        OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1",
        [STYLE_GUIDE_LIVE_PROVIDER_MODEL_ENV]: primaryModel,
        [STYLE_GUIDE_LIVE_PROVIDER_ID_ENV]: "OpenAI",
      },
      fetch: fetchMock,
      // A fallback plan is configured but OpenRouter served the primary
      // directly — fallbackUsed must be false and the assertion must reject.
      fallbackModels: ["deepseek/deepseek-v4-flash"],
    });

    expect(result.status).toBe("passed");
    if (result.status !== "passed") {
      throw new Error("style-guide live direct-serve smoke should pass");
    }
    expect(result.providerRun.fallbackUsed).toBe(false);
    expect(result.providerRun.retryCount).toBe(0);
    expect(() =>
      assertStyleGuideProviderSmokeFallbackLedger(result.providerRun, {
        requestedModelId: primaryModel,
        fallbackModel: "deepseek/deepseek-v4-flash",
        servedModelId: primaryModel,
        servedProviderId: "OpenAI",
      }),
    ).toThrow(/fallback ledger incoherent/u);
  });

  it("skips live provider smoke unless explicit opt-in and credentials are already exported", async () => {
    await expect(runStyleGuideProviderSmoke({ mode: "live", env: {} })).resolves.toEqual({
      status: "skipped",
      mode: "live",
      reason: "missing_opt_in",
    });
    await expect(
      runStyleGuideProviderSmoke({
        mode: "live",
        env: { [STYLE_GUIDE_LIVE_PROVIDER_SMOKE_FLAG]: "1" },
      }),
    ).resolves.toEqual({
      status: "skipped",
      mode: "live",
      reason: "missing_provider_credential",
    });
  });

  it("refuses opted-in OpenRouter live smoke before fetch without ZDR account assertion", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;

    try {
      await runStyleGuideProviderSmoke({
        mode: "live",
        env: {
          [STYLE_GUIDE_LIVE_PROVIDER_SMOKE_FLAG]: "1",
          OPENROUTER_API_KEY: "test-key",
        },
        fetch: fetchMock,
      });
      throw new Error("style-guide live smoke should require OPENROUTER_ZDR_ACCOUNT_ASSERTED=1");
    } catch (error) {
      expect(error).toBeInstanceOf(AccountZdrAssertionError);
      expect(error).toMatchObject({
        message: expect.stringMatching(/OPENROUTER_ZDR_ACCOUNT_ASSERTED=1 is required/u),
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects stale recorded smoke fixture schemas", () => {
    const fixture: StyleGuideProviderSmokeFixture = {
      ...readSmokeFixture(),
      schemaVersion:
        "itotori.style-guide-provider-smoke.v0" as typeof STYLE_GUIDE_PROVIDER_SMOKE_SCHEMA_VERSION,
    };

    expect(runRecordedStyleGuideProviderSmoke(fixture).status).toBe("passed");
    expect(() =>
      runRecordedStyleGuideProviderSmoke({
        ...fixture,
        schemaVersion: "stale" as typeof STYLE_GUIDE_PROVIDER_SMOKE_SCHEMA_VERSION,
      }),
    ).toThrow(/schema version/u);
  });
});

function memoryRecorder() {
  return {
    recordProviderRun: vi.fn(async () => {}),
  };
}

function cloneFixtureContentJson() {
  return structuredClone(readSmokeFixture().providerResult.contentJson) as {
    turns: Array<Record<string, unknown>>;
    proposals: Array<
      {
        proposalId?: string;
        edits: Array<{ rule?: Record<string, unknown> } & Record<string, unknown>>;
      } & Record<string, unknown>
    >;
  } & Record<string, unknown>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function styleGuideLiveSmokeCapabilities(): ModelCapabilities {
  // ITOTORI-241 — json_schema is unroutable under ZDR for the DEV_PAIR
  // (HTTP 404); json_object is the proven-routable structured mode. The
  // smoke's structured-mode selection reads this sheet.
  return {
    ...openRouterDefaultCapabilities,
    structuredOutputs: {
      ...openRouterDefaultCapabilities.structuredOutputs,
      jsonSchema: "unsupported",
      jsonObject: "supported",
      preferredModes: ["json_object"],
    },
  };
}
