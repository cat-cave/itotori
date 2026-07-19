import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  LlmMemoConflictError,
  type LlmCallMemoStore,
  type LlmMemoSingleflightInput,
  type LlmMemoSingleflightResult,
} from "@itotori/db";
import { describe, expect, it, vi } from "vitest";
import { createDispatchRuntime } from "../src/composition/live/dispatch-runtime.js";
import { dispatch, type DispatchRuntime } from "../src/llm/dispatch.js";
import { reviewVerdictExample } from "./contract-fixtures-core.js";
import {
  STEP_HASH_A,
  STEP_HASH_B,
  TEST_MODEL_PROFILE,
  physicalCallSpec,
  structuredProviderResponse,
} from "./llm-step-test-support.js";

type JsonObject = Record<string, unknown>;
type CapturedWire = {
  method: string;
  url: string;
  headers: {
    "X-OpenRouter-Metadata": string | null;
    "X-OpenRouter-Cache": string | null;
    Authorization?: string | null;
  };
  body: JsonObject | null;
};

const goldenWire = JSON.parse(
  readFileSync(new URL("./fixtures/llm-zdr-golden-request.json", import.meta.url), "utf8"),
) as CapturedWire;

class MemoryMemoStore implements LlmCallMemoStore {
  readonly #memos = new Map<string, Extract<LlmMemoSingleflightResult, { kind: "completed" }>>();

  async singleflight(input: LlmMemoSingleflightInput): Promise<LlmMemoSingleflightResult> {
    const existing = this.#memos.get(input.memoKey);
    if (existing) {
      if (existing.semanticHash !== input.semanticHash) {
        throw new LlmMemoConflictError(input.memoKey);
      }
      return { ...existing, memoHit: true };
    }
    const execution = await input.execute({ ordinal: 1, startedAt: new Date().toISOString() });
    if (execution.kind === "incomplete") {
      return {
        kind: "incomplete",
        memoHit: false,
        memoKey: input.memoKey,
        semanticHash: input.semanticHash,
        responseJson: execution.responseJson,
        attemptOrdinal: 1,
        failure: execution.failure,
      };
    }
    const completed = {
      kind: "completed" as const,
      memoHit: false,
      memoKey: input.memoKey,
      semanticHash: input.semanticHash,
      responseJson: execution.responseJson,
      outcomeJson: execution.outcomeJson,
      responseEventId: execution.responseEvent.eventId,
    };
    this.#memos.set(input.memoKey, completed);
    return completed;
  }
}

function goldenRuntime(
  prompt: string,
  captured: CapturedWire[],
  providerResponse: Response | Error = structuredProviderResponse(reviewVerdictExample),
): DispatchRuntime {
  const fetcher: NonNullable<DispatchRuntime["fetcher"]> = async (input, init) => {
    const request = new Request(input, init);
    captured.push({
      method: request.method,
      url: request.url,
      headers: {
        "X-OpenRouter-Metadata": request.headers.get("X-OpenRouter-Metadata"),
        "X-OpenRouter-Cache": request.headers.get("X-OpenRouter-Cache"),
        ...(request.method === "GET"
          ? { Authorization: request.headers.get("Authorization") }
          : {}),
      },
      body: request.method === "POST" ? ((await request.clone().json()) as JsonObject) : null,
    });
    if (request.method === "GET") return generationLookupResponse();
    if (providerResponse instanceof Error) throw providerResponse;
    return providerResponse;
  };
  const base = createDispatchRuntime({
    env: {
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1",
      OPENROUTER_ZDR_GUARDRAIL_ASSERTED: "1",
    },
    tools: [],
    contentAccess: { requireContentRead: async () => undefined },
    memoStore: new MemoryMemoStore(),
    profile: TEST_MODEL_PROFILE,
    admission: {
      scope: "test:zdr-golden-wire",
      confirmedCostCapUsd: "10", // itotori-225-audit-allow: synthetic admission cap for a mock-wire test, not a billed model cost
    },
    snapshots: {
      decodeRevisionHash: STEP_HASH_A,
      glossaryRevisionHash: STEP_HASH_B,
      styleRevisionHash: STEP_HASH_A,
      acceptedOutputHeadHash: STEP_HASH_B,
    },
    fetcher,
  });
  return { ...base, readPayload: async () => prompt };
}

function generationLookupResponse(): Response {
  return new Response(
    JSON.stringify({
      data: {
        id: "generation:test",
        model: "deepseek/deepseek-v4-flash-20260423",
        provider_name: "DeepSeek",
        provider_responses: [
          {
            model_permaslug: "deepseek/deepseek-v4-flash-20260423",
            provider_name: "DeepSeek",
            status: 200,
          },
        ],
        total_cost: 0.00000125,
      },
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

function assertSerializedZdrWire(wire: CapturedWire): void {
  if (wire.method !== "POST" || wire.url !== "https://openrouter.ai/api/v1/chat/completions") {
    throw new Error("request must use the OpenRouter chat-completions transport");
  }
  if (
    wire.headers["X-OpenRouter-Metadata"] !== "enabled" ||
    wire.headers["X-OpenRouter-Cache"] !== "false"
  ) {
    throw new Error("OpenRouter metadata must be enabled and cache must be disabled");
  }
  const body = asObject(wire.body, "request body");
  const provider = asObject(body.provider, "provider");
  const camelCase = ["allowFallbacks", "dataCollection", "requireParameters"].filter(
    (key) => key in provider,
  );
  if (camelCase.length > 0) {
    throw new Error(`camelCase ZDR fields would be silently dropped: ${camelCase.join(", ")}`);
  }
  const providerPins = ["only", "order"].filter((key) => key in provider);
  if (providerPins.length > 0) {
    throw new Error(
      `provider pinning is forbidden under the account-wide posture: ${providerPins}`,
    );
  }
  const requiredProvider = {
    allow_fallbacks: true,
    zdr: true,
    data_collection: "deny",
    require_parameters: true,
  };
  if (!isDeepStrictEqual(provider, requiredProvider)) {
    throw new Error("provider must contain the exact snake_case ZDR policy");
  }
  if (body.model !== "deepseek/deepseek-v4-flash") {
    throw new Error("request model drifted from the exact approved slug");
  }
  if (!Array.isArray(body.plugins) || body.plugins.length !== 0) {
    throw new Error("OpenRouter plugins must be absent");
  }
  const retryFields = collectKeyPaths(body).filter((path) => /retry/iu.test(path));
  if (retryFields.length > 0) throw new Error(`hidden retry fields are forbidden: ${retryFields}`);
}

function asObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function collectKeyPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => collectKeyPaths(item, prefix));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value as JsonObject).flatMap(([key, child]) => {
    const path = prefix.length === 0 ? key : `${prefix}.${key}`;
    return [path, ...collectKeyPaths(child, path)];
  });
}

async function captureWire(): Promise<{
  readonly request: CapturedWire;
  readonly result: Awaited<ReturnType<typeof dispatch>>;
  readonly captured: CapturedWire[];
}> {
  const prompt = "Return the synthetic golden-wire review verdict.";
  const captured: CapturedWire[] = [];
  const result = await dispatch(physicalCallSpec(prompt), goldenRuntime(prompt, captured));
  expect(result.status).toBe("success");
  return { request: captured[0]!, result, captured };
}

describe("the OpenRouter ZDR golden wire", () => {
  it("matches the account-wide actual serialized request and records the served pair post-hoc", async () => {
    const { request: actual, result, captured } = await captureWire();

    assertSerializedZdrWire(actual);
    expect(actual).toEqual(goldenWire);
    // One real SDK POST and one post-request metadata lookup: neither is an
    // implicit SDK retry, and the lookup does not alter the POST policy.
    expect(captured.filter((wire) => wire.url.includes("/chat/completions"))).toHaveLength(1);
    expect(captured.filter((wire) => wire.url.includes("/generation"))).toHaveLength(1);
    const lookup = captured.find((wire) => wire.url.includes("/generation"));
    expect(lookup).toMatchObject({
      method: "GET",
      headers: { Authorization: "Bearer test-key" },
      body: null,
    });
    expect(new URL(lookup!.url).searchParams.get("id")).toBe("generation:test");
    expect(result).toMatchObject({
      status: "success",
      generationId: "generation:test",
      served: {
        status: "confirmed",
        model: "deepseek/deepseek-v4-flash-20260423",
        provider: "DeepSeek",
      },
      verification: "verified",
    });
  });

  it("detects the camelCase silent-drop footgun", async () => {
    const { request: actual } = await captureWire();
    const provider = asObject(asObject(actual.body, "request body").provider, "provider");
    const camelCaseWire: CapturedWire = {
      ...actual,
      body: {
        ...actual.body,
        provider: {
          allowFallbacks: provider.allow_fallbacks,
          zdr: provider.zdr,
          dataCollection: provider.data_collection,
          requireParameters: provider.require_parameters,
        },
      },
    };

    expect(() => assertSerializedZdrWire(camelCaseWire)).toThrow(/silently dropped/u);
  });
});

describe("dispatch privacy failures", () => {
  it("keeps source and target content out of the typed error and logs", async () => {
    const sentinel = "SOURCE_PRIVATE_SENTINEL / TARGET_PRIVATE_SENTINEL";
    const captured: CapturedWire[] = [];
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const result = await dispatch(
        physicalCallSpec(sentinel),
        goldenRuntime(
          sentinel,
          captured,
          new Response(JSON.stringify({ error: { message: `provider rejected ${sentinel}` } }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
      const observability = JSON.stringify({
        result,
        logs: [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls],
      });

      expect(result).toMatchObject({ status: "failure", failureKind: "http" });
      expect(observability).not.toContain("SOURCE_PRIVATE_SENTINEL");
      expect(observability).not.toContain("TARGET_PRIVATE_SENTINEL");
      expect(captured).toHaveLength(1);
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
