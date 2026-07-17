import { describe, expect, it } from "vitest";

import { openRouterGenerationLookup } from "../src/llm/openrouter-generation-lookup.js";

describe("OpenRouter generation metadata lookup", () => {
  it("returns the confirmed final served pair from generation metadata", async () => {
    const requests: Request[] = [];
    const source = openRouterGenerationLookup({
      apiKey: "test-openrouter-key",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json(generationResponse());
      },
    });

    await expect(source.lookup({ generationId: "gen-confirmed-1" })).resolves.toEqual({
      generationId: "gen-confirmed-1",
      served: {
        status: "confirmed",
        provider: "DigitalOcean",
        model: "deepseek/deepseek-v4-flash-20260423",
      },
      routerAttempts: [
        {
          ordinal: 1,
          provider: "Morph",
          model: "deepseek/deepseek-v4-flash-20260423",
          httpStatus: 502,
        },
        {
          ordinal: 2,
          provider: "DigitalOcean",
          model: "deepseek/deepseek-v4-flash-20260423",
          httpStatus: 200,
        },
      ],
      usage: { promptTokens: 11, completionTokens: 7, reasoningTokens: 3, cachedTokens: 2 },
      billing: { status: "confirmed", costUsd: "0.00022344" },
      reportedCostUsd: "0.00022344",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url).toBe("https://openrouter.ai/api/v1/generation?id=gen-confirmed-1");
    expect(requests[0]?.headers.get("Authorization")).toBe("Bearer test-openrouter-key");
  });

  it("retries unavailable generation metadata until its served route is present", async () => {
    const responses = [
      new Response(null, { status: 404 }),
      Response.json({ data: null }),
      Response.json(generationResponse()),
    ];
    const source = openRouterGenerationLookup({
      apiKey: "test-openrouter-key",
      retryDelayMs: 0,
      fetch: async () => responses.shift() ?? new Response(null, { status: 500 }),
    });

    await expect(source.lookup({ generationId: "gen-eventual-1" })).resolves.toMatchObject({
      generationId: "gen-eventual-1",
      served: {
        status: "confirmed",
        provider: "DigitalOcean",
        model: "deepseek/deepseek-v4-flash-20260423",
      },
    });
    expect(responses).toEqual([]);
  });

  it("keeps metadata unknown when the route never becomes confirmable", async () => {
    let calls = 0;
    const source = openRouterGenerationLookup({
      apiKey: "test-openrouter-key",
      retryDelayMs: 0,
      fetch: async () => {
        calls += 1;
        return Response.json({ data: {} });
      },
    });

    await expect(source.lookup({ generationId: "gen-unavailable-1" })).resolves.toEqual({
      generationId: null,
      served: { status: "unknown" },
      routerAttempts: [],
      usage: null,
      billing: { status: "billing_unknown" },
      reportedCostUsd: null,
    });
    expect(calls).toBe(5);

    const failingSource = openRouterGenerationLookup({
      apiKey: "test-openrouter-key",
      fetch: async () => {
        throw new Error("generation endpoint unavailable");
      },
    });
    await expect(failingSource.lookup({ generationId: "gen-error-1" })).resolves.toMatchObject({
      generationId: null,
      served: { status: "unknown" },
    });
  });
});

function generationResponse() {
  return {
    data: {
      provider_name: "DigitalOcean",
      model: "deepseek/deepseek-v4-flash-20260423",
      provider_responses: [
        {
          provider_name: "Morph",
          model_permaslug: "deepseek/deepseek-v4-flash-20260423",
          status: 502,
        },
        {
          provider_name: "DigitalOcean",
          model_permaslug: "deepseek/deepseek-v4-flash-20260423",
          status: 200,
        },
      ],
      tokens_prompt: 11,
      tokens_completion: 7,
      native_tokens_reasoning: 3,
      native_tokens_cached: 2,
      total_cost: 0.00022344,
    },
  };
}
