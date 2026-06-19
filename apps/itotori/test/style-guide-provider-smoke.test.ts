import { describe, expect, it, vi } from "vitest";
import {
  OpenRouterProvider,
  type ModelInvocationResult,
  type ProviderRunRecord,
} from "../src/providers/index.js";
import {
  STYLE_GUIDE_LIVE_PROVIDER_SMOKE_FLAG,
  STYLE_GUIDE_PROVIDER_SMOKE_SCHEMA_VERSION,
  STYLE_GUIDE_SUGGESTION_TOOL_NAME,
  assertStyleGuideProviderSmokeLedger,
  parseStyleGuideSuggestionFromProviderResult,
  readSmokeFixture,
  runRecordedStyleGuideProviderSmoke,
  runStyleGuideProviderSmoke,
  styleGuideSuggestionRequest,
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

  it("rejects malformed structured output before policy projection", () => {
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

    expect(() => parseStyleGuideSuggestionFromProviderResult(result)).toThrow(
      /style-guide suggestion validation failed/u,
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
        costKind: "provider_estimate",
        amountMicrosUsd: 42,
      },
      dataHandling: {
        dataCollection: "deny",
        trainingUse: "deny",
        rawCaptureDefault: "disabled",
      },
      accountPrivacy: {
        inputOutputLogging: "disabled",
        providerDataPolicyFilters: "enabled",
      },
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
