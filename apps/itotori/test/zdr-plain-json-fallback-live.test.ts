// itotori-structured-output-plain-json-fallback-under-zdr — paid boundary proof.
//
// THE pilot blocker: before this node the PRODUCTION TranslationAgent resolved
// structured output to `json_object` for the DEV_PAIR, which is UNROUTABLE
// under ZDR (OpenRouter HTTP 404 "No endpoints found that can handle the
// requested parameters" — the ZDR allow-list ∩ response_format-advertising
// providers is empty, and require_parameters:true empties the pool). The fix
// adds a plain-completion fallback to `selectStructuredOutputRequest`; the
// DEV_PAIR sheet now marks BOTH json_schema and json_object unsupported, so
// the production selector resolves to `plain_json` (no response_format / no
// require_parameters → routable) and the agent's SAME strict schema
// validation (parseWithBoundedRepair) still gates the result.
//
// This test drives a real translate request through the ACTUAL
// `TranslationAgent.invokeTranslation` (not a bespoke harness) under
// ZDR/DEV_PAIR. The standalone agent has no durable cost-admission sink, so
// it must refuse before any paid OpenRouter dispatch; a durable driven run is
// the production path for the same selector proof.
//
// Gated on ITOTORI_ZDR_PLAINJSON_LIVE=1 + OPENROUTER_API_KEY +
// OPENROUTER_ZDR_ACCOUNT_ASSERTED=1. Unset → visible skip (no silent pass), so
// `pnpm test` in CI skips it. Budget: ONE small call, capped at $1.00.

import { describe, expect, it } from "vitest";
import {
  OpenRouterProvider,
  assertOpenRouterZdrAccount,
  type JsonObject,
} from "../src/providers/index.js";
import { DEV_PAIR, getModelCapabilities } from "../src/providers/dev-pair.js";
import { TranslationAgent } from "../src/agents/translation/agent.js";
import {
  TRANSLATION_PROMPT_TEMPLATE_VERSION_V1,
  type TranslationInvocationInput,
} from "../src/agents/translation/shapes.js";

const LIVE_ENABLED =
  process.env.ITOTORI_ZDR_PLAINJSON_LIVE === "1" &&
  typeof process.env.OPENROUTER_API_KEY === "string" &&
  process.env.OPENROUTER_API_KEY.length > 0;

const PER_CALL_MAX_PRICE_USD = 0.5;
const FIXED_ACTOR = { userId: "local-user" };

describe("plain-json-fallback-under-zdr — standalone paid-agent boundary", () => {
  it("refuses before paid dispatch without a durable cost-admission sink", async () => {
    if (!LIVE_ENABLED) {
      // eslint-disable-next-line no-console
      console.warn(
        "[zdr-plainjson] skipping real run — set ITOTORI_ZDR_PLAINJSON_LIVE=1, OPENROUTER_API_KEY, " +
          "and OPENROUTER_ZDR_ACCOUNT_ASSERTED=1 to run it",
      );
      return;
    }
    const env = process.env;
    // Privacy gate BEFORE any live byte.
    assertOpenRouterZdrAccount(env);

    // The PRODUCTION DEV_PAIR capability sheet — the very sheet the agent reads
    // via provider.descriptor.capabilities. json_schema + json_object are
    // 'unsupported' (ZDR 404), plainJsonExtraction 'supported', so the
    // production selector resolves to plain_json.
    const capabilities = getModelCapabilities(DEV_PAIR);
    expect(capabilities.structuredOutputs.jsonSchema).toBe("unsupported");
    expect(capabilities.structuredOutputs.jsonObject).toBe("unsupported");
    expect(capabilities.structuredOutputs.plainJsonExtraction).toBe("supported");

    const provider = new OpenRouterProvider({
      modelId: DEV_PAIR.modelId,
      apiKey: env.OPENROUTER_API_KEY as string,
      capabilities,
      routing: {
        zdr: true,
        dataCollection: "deny",
        allowFallbacks: true,
        // Confine the single call under the per-request budget.
        maxPrice: { request: PER_CALL_MAX_PRICE_USD } as JsonObject,
      },
      live: {
        enabled: true,
        artifactRecorder: { recordProviderRun: async () => undefined },
        rawCapture: "disabled",
      },
    });

    const agent = new TranslationAgent({ provider });

    // Synthetic-public source lines (no copyrighted text): plain narration, no
    // placeholders / protected spans / glossary, so a clean draft carries empty
    // citationRefs + protectedSpanRefs.
    const input: TranslationInvocationInput = {
      draftJobId: "019ed100-0000-7000-8000-000000000001",
      draftJobAttemptId: "019ed100-0000-7000-8000-000000000002",
      projectId: "019ed100-0000-7000-8000-000000000003",
      localeBranchId: "019ed100-0000-7000-8000-000000000004",
      sourceLocale: "ja",
      targetLocale: "en",
      sourceBridgeUnits: [
        {
          bridgeUnitId: "019ed100-0000-7000-8000-00000000a001",
          sourceUnitKey: "scene.001.line.001",
          sourceText: "おはようございます。",
          sourceHash: "src-hash-1",
          speaker: "narration",
        },
        {
          bridgeUnitId: "019ed100-0000-7000-8000-00000000a002",
          sourceUnitKey: "scene.001.line.002",
          sourceText: "今日はよい天気ですね。",
          sourceHash: "src-hash-2",
          speaker: "narration",
        },
      ],
      protectedSpansBySource: new Map(),
      glossary: [],
      styleGuide: [],
      modelProfile: {
        providerFamily: "openrouter",
        modelId: DEV_PAIR.modelId,
        providerId: DEV_PAIR.providerId,
        contextWindowTokens: 128_000,
        maxOutputTokens: 1_024,
      },
      promptTemplateVersion: TRANSLATION_PROMPT_TEMPLATE_VERSION_V1,
    };

    await expect(agent.invokeTranslation(FIXED_ACTOR, input)).rejects.toMatchObject({
      name: "InvocationOperationalPauseError",
      blocker: {
        kind: "budget_cap",
        detail: expect.stringContaining("durable cost-admission"),
      },
    });
  }, 120_000);
});
