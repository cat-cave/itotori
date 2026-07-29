import { createHash } from "node:crypto";
import {
  AuthorizationError,
  LlmDurabilityFaultError,
  LlmMemoConflictError,
  LlmRetriesExhaustedError,
  type LlmAttemptFailure,
  type LlmCallMemoStore,
  type LlmMemoSingleflightInput,
  type LlmMemoSingleflightResult,
} from "@itotori/db";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CALL_SPEC_SCHEMA_VERSION,
  DECODE_GET_UNITS_RESULT_SCHEMA_VERSION,
  REVIEW_VERDICT_SCHEMA_VERSION,
  type CallSpec,
} from "../src/contracts/index.js";
import { dispatch, type DispatchRuntime, type DispatchTool } from "../src/llm/dispatch.js";
import { reviewVerdictExample } from "./contract-fixtures-core.js";
import {
  TEST_MODEL_PROFILE,
  decodedUnitsTool,
  httpProviderResponse,
  rawTransportDropError,
  toolLoopSpec,
  toolProviderResponse,
} from "./llm-step-test-support.js";

import {
  HASH_A,
  HASH_B,
  CapturedRequest,
  ProviderResponse,
  MemoryMemoStore,
  contentHash,
  streamChunk,
  sse,
  structuredResponse,
  completedThenLostResponse,
  TRANSIENT_TRANSPORT,
  toolCallResponse,
  callSpec,
  runtime,
  faultAt,
  liveEnabled,
} from "./llm-dispatch.support.js";

describe("the rebuilt LLM dispatcher", () => {
  it("classifies an injected in-flight process death as cancelled", async () => {
    const prompt = "Return a review verdict.";
    const configured = runtime(
      prompt,
      [structuredResponse(JSON.stringify(reviewVerdictExample))],
      [],
    );

    const result = await dispatch(callSpec(prompt), {
      ...configured,
      memo: {
        ...configured.memo,
        durabilityFaults: faultAt("in-flight"),
      },
    });

    expect(result).toMatchObject({ status: "failure", failureKind: "cancelled" });
  });

  it("classifies an injected tool-loop process death as cancelled", async () => {
    const prompt = "Use the decoded-unit tool, then return a verdict.";
    const captured: CapturedRequest[] = [];
    let toolRuns = 0;
    const configured = runtime(prompt, [toolProviderResponse(1)], captured, [
      decodedUnitsTool(() => (toolRuns += 1)),
    ]);

    const result = await dispatch(toolLoopSpec(prompt), {
      ...configured,
      memo: {
        ...configured.memo,
        durabilityFaults: faultAt("after-tool-result"),
      },
    });

    expect(result).toMatchObject({ status: "failure", failureKind: "cancelled" });
    expect(captured).toHaveLength(1);
    expect(toolRuns).toBe(1);
  });

  it("resumes a fresh tool-loop dispatch after a post-result durability fault", async () => {
    const prompt = "Use the decoded-unit tool, then return a verdict.";
    const interruptedRequests: CapturedRequest[] = [];
    let interruptedToolRuns = 0;
    const interrupted = runtime(prompt, [toolProviderResponse(1)], interruptedRequests, [
      decodedUnitsTool(() => (interruptedToolRuns += 1)),
    ]);

    const interruptedResult = await dispatch(toolLoopSpec(prompt), {
      ...interrupted,
      memo: {
        ...interrupted.memo,
        durabilityFaults: faultAt("after-tool-result"),
      },
    });

    expect(interruptedResult).toMatchObject({ status: "failure", failureKind: "cancelled" });
    expect(interruptedRequests).toHaveLength(1);
    expect(interruptedToolRuns).toBe(1);

    const restartedRequests: CapturedRequest[] = [];
    let restartedToolRuns = 0;
    const restarted = runtime(
      prompt,
      [structuredResponse(JSON.stringify(reviewVerdictExample))],
      restartedRequests,
      [decodedUnitsTool(() => (restartedToolRuns += 1))],
    );

    const restartedResult = await dispatch(toolLoopSpec(prompt), {
      ...restarted,
      memo: { ...restarted.memo, store: interrupted.memo.store },
    });

    expect(restartedResult).toMatchObject({ status: "success", memoHit: false });
    expect(restartedRequests).toHaveLength(1);
    expect(restartedRequests[0]?.body).toMatchObject({
      response_format: { type: "json_schema", json_schema: { strict: true } },
    });
    expect(restartedToolRuns).toBe(1);
  });

  it("hard-cancels a hung stream at each attempt deadline and records transient deadline failures", async () => {
    const prompt = "Return a review verdict before the synthetic deadline.";
    const store = new MemoryMemoStore();
    const profile = {
      ...TEST_MODEL_PROFILE,
      deadlines: { normalMs: 10, deepMs: 20 },
    };
    const signals: AbortSignal[] = [];
    const configured = runtime(prompt, [], []);
    const startedAt = Date.now();

    const result = await dispatch(callSpec(prompt), {
      ...configured,
      memo: {
        ...configured.memo,
        store,
        profile,
        retry: { random: () => 0, sleep: async () => undefined },
      },
      fetcher: async (input, init) => {
        signals.push(new Request(input, init).signal);
        return new Promise<Response>(() => undefined);
      },
    });

    expect(result).toMatchObject({ status: "failure", failureKind: "retries-exhausted" });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(store.failures).toEqual(
      Array.from({ length: 3 }, () => ({
        classification: "transient",
        kind: "deadline",
        httpStatus: null,
        retryAfterMs: null,
      })),
    );
  });

  it("fails before transport when the OpenRouter API key is absent", async () => {
    const prompt = "Return a review verdict.";
    const captured: CapturedRequest[] = [];
    const configured = runtime(
      prompt,
      [structuredResponse(JSON.stringify(reviewVerdictExample))],
      captured,
    );

    await expect(dispatch(callSpec(prompt), { ...configured, env: {} })).rejects.toThrow(
      /OPENROUTER_API_KEY/u,
    );
    expect(captured).toHaveLength(0);
  });

  it("sends the mandatory ZDR wire and accepts an unknown served pair explicitly", async () => {
    const prompt = "Return the requested synthetic review verdict.";
    const captured: CapturedRequest[] = [];
    const result = await dispatch(
      callSpec(prompt),
      runtime(prompt, [structuredResponse(JSON.stringify(reviewVerdictExample))], captured),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]?.headers.get("X-OpenRouter-Metadata")).toBe("enabled");
    expect(captured[0]?.headers.get("X-OpenRouter-Cache")).toBe("false");
    expect(captured[0]?.body).toMatchObject({
      model: "deepseek/deepseek-v4-flash",
      provider: {
        allow_fallbacks: true,
        zdr: true,
        data_collection: "deny",
        require_parameters: true,
      },
      plugins: [],
      reasoning: { effort: "none" },
      max_tokens: 2_048,
      response_format: {
        type: "json_schema",
        json_schema: { name: "structured_output", strict: true },
      },
    });
    expect(captured[0]?.body).not.toHaveProperty("provider.allowFallbacks");
    expect(captured[0]?.body).not.toHaveProperty("provider.dataCollection");
    // policy - the wire names no provider: automatic fallback (zdr:true)
    // confines routing to the account ZDR allow-list without an only/order pin.
    expect(captured[0]?.body).not.toHaveProperty("provider.only");
    expect(captured[0]?.body).not.toHaveProperty("provider.order");
    expect(captured[0]?.body).not.toHaveProperty("parallel_tool_calls");
    expect(captured[0]?.body).not.toHaveProperty("seed");
    expect(captured[0]?.body).not.toHaveProperty("max_completion_tokens");

    expect(result).toMatchObject({
      status: "success",
      served: { status: "unknown" },
      generationId: null,
      verification: "explicit-unknown",
      usage: { promptTokens: 11, completionTokens: 7, reasoningTokens: 3, cachedTokens: 2 },
      billing: { status: "confirmed", costUsd: "0.00000125" },
    });
    expect(result).toHaveProperty("value");
    expect(result.events.map((event) => event.kind)).toEqual([
      "run-started",
      "model-step-finished",
      "run-finished",
    ]);
  });

  it("does not bypass TanStack with response headers while served metadata is unknown", async () => {
    const prompt = "Return the requested synthetic review verdict.";
    const verified = await dispatch(
      callSpec(prompt),
      runtime(
        prompt,
        [
          structuredResponse(JSON.stringify(reviewVerdictExample), undefined, undefined, {
            "x-generation-id": "gen-header-1",
            "x-provider-name": "Morph",
          }),
        ],
        [],
      ),
    );

    expect(verified).toMatchObject({
      status: "success",
      generationId: null,
      served: { status: "unknown" },
      verification: "explicit-unknown",
    });

    const absent = await dispatch(
      callSpec(`${prompt} No response metadata.`),
      runtime(
        `${prompt} No response metadata.`,
        [structuredResponse(JSON.stringify(reviewVerdictExample))],
        [],
      ),
    );

    expect(absent).toMatchObject({
      status: "success",
      generationId: null,
      served: { status: "unknown" },
      verification: "explicit-unknown",
    });
  });

  it("permits OpenRouter fallback and retries a single-provider 429 without aborting", async () => {
    // policy - proves fallback is genuinely ENABLED without a live outage:
    // inject a 429 on the first upstream, then a valid response. This shows the
    // wire permits OpenRouter to fall back and the dispatcher does not treat a
    // single-provider rate limit as a terminal failure. (Server-side alternate
    // selection is OpenRouter-internal; served-provider stays deferred.)
    const prompt = "Return the requested synthetic review verdict.";
    const captured: CapturedRequest[] = [];
    const base = runtime(
      prompt,
      [httpProviderResponse(429, "0"), structuredResponse(JSON.stringify(reviewVerdictExample))],
      captured,
    );
    // Deterministic, instant retry - no real backoff sleep.
    const configured: DispatchRuntime = {
      ...base,
      memo: { ...base.memo, retry: { random: () => 0, sleep: async () => undefined } },
    };

    const result = await dispatch(callSpec(prompt), configured);

    // (i) The outgoing request PERMITS OpenRouter-side fallback: allow_fallbacks
    //     is true, ZDR confines it to the allow-list, and there is NO only/order
    //     pin - so a 429 on one endpoint is allowed to route to another.
    expect(captured[0]?.body.provider).toEqual({
      allow_fallbacks: true,
      zdr: true,
      data_collection: "deny",
      require_parameters: true,
    });
    expect(captured[0]?.body).not.toHaveProperty("provider.only");
    expect(captured[0]?.body).not.toHaveProperty("provider.order");
    // (ii) The dispatcher made a SECOND attempt after the 429 rather than
    //      aborting on the single-provider rate limit, and recovered.
    expect(captured).toHaveLength(2);
    expect(result.status).toBe("success");
  });

  it("retries raw transport exceptions, then succeeds", async () => {
    // A raw connection reset reaches streaming execute's catch before the
    // adapter can emit RUN_ERROR. It is therefore safe to retry under the
    // bounded attempt budget.
    const prompt = "Return the requested synthetic review verdict.";
    const captured: CapturedRequest[] = [];
    const store = new MemoryMemoStore();
    const base = runtime(
      prompt,
      [
        rawTransportDropError(),
        rawTransportDropError(),
        structuredResponse(JSON.stringify(reviewVerdictExample)),
      ],
      captured,
    );
    const configured: DispatchRuntime = {
      ...base,
      memo: { ...base.memo, store, retry: { random: () => 0, sleep: async () => undefined } },
    };

    const result = await dispatch(callSpec(prompt), configured);

    // Two raw transport failures were retried, and the third attempt succeeded.
    expect(captured).toHaveLength(3);
    expect(result.status).toBe("success");
    // Each retried attempt was recorded as a transient transport failure — the
    // http_attempts ledger preserves the lineage of the retried physical steps.
    expect(store.failures).toEqual([TRANSIENT_TRANSPORT, TRANSIENT_TRANSPORT]);
  });

  it("treats an adapter RUN_ERROR as terminal billing-unknown", async () => {
    const prompt = "Return the requested synthetic review verdict.";
    const captured: CapturedRequest[] = [];
    const store = new MemoryMemoStore();
    const base = runtime(prompt, [completedThenLostResponse()], captured);
    const configured: DispatchRuntime = {
      ...base,
      memo: { ...base.memo, store, retry: { random: () => 0, sleep: async () => undefined } },
    };

    const result = await dispatch(callSpec(prompt), configured);

    // The adapter discards completion metadata when it emits RUN_ERROR; retrying
    // could re-bill an already-completed response, so exactly one attempt stops.
    expect(captured).toHaveLength(1);
    expect(result).toMatchObject({
      status: "failure",
      failureKind: "transport",
      billing: { status: "billing-unknown" },
    });
    expect(store.failures).toEqual([
      { classification: "permanent", kind: "transport", httpStatus: null, retryAfterMs: null },
    ]);
  });

  it("surfaces a clear retries-exhausted terminal failure when raw transport exceptions persist", async () => {
    const prompt = "Return the requested synthetic review verdict.";
    const captured: CapturedRequest[] = [];
    const store = new MemoryMemoStore();
    const base = runtime(
      prompt,
      [rawTransportDropError(), rawTransportDropError(), rawTransportDropError()],
      captured,
    );
    const configured: DispatchRuntime = {
      ...base,
      memo: { ...base.memo, store, retry: { random: () => 0, sleep: async () => undefined } },
    };

    const result = await dispatch(callSpec(prompt), configured);

    // Exactly the bounded budget of attempts — not a hang, not unbounded retries.
    expect(captured).toHaveLength(3);
    expect(result).toMatchObject({ status: "failure", failureKind: "retries-exhausted" });
    expect(store.failures).toEqual([TRANSIENT_TRANSPORT, TRANSIENT_TRANSPORT, TRANSIENT_TRANSPORT]);
  });

  it("does not retry a non-transient 4xx transport failure", async () => {
    // A 400 will not improve on retry: classify permanent and fail once.
    const prompt = "Return the requested synthetic review verdict.";
    const captured: CapturedRequest[] = [];
    const store = new MemoryMemoStore();
    const base = runtime(prompt, [httpProviderResponse(400)], captured);
    const configured: DispatchRuntime = {
      ...base,
      memo: { ...base.memo, store, retry: { random: () => 0, sleep: async () => undefined } },
    };

    const result = await dispatch(callSpec(prompt), configured);

    expect(captured).toHaveLength(1);
    expect(result).toMatchObject({ status: "failure", failureKind: "http" });
    expect(store.failures).toEqual([
      { classification: "permanent", kind: "http", httpStatus: 400, retryAfterMs: null },
    ]);
  });

  it("returns malformed terminal JSON as a typed failure without salvage or retry", async () => {
    const prompt = "Return a review verdict.";
    const captured: CapturedRequest[] = [];
    const fencedJson = `\`\`\`json\n${JSON.stringify(reviewVerdictExample)}\n\`\`\``;
    const result = await dispatch(
      callSpec(prompt),
      runtime(prompt, [structuredResponse(fencedJson)], captured),
    );

    expect(captured).toHaveLength(1);
    expect(result).toMatchObject({
      status: "failure",
      failureKind: "invalid-json",
      generationId: null,
      verification: "quarantined",
    });
    expect(result).not.toHaveProperty("value");
  });

  it("does not fabricate a zero cost when upstream omits cost", async () => {
    const prompt = "Return a review verdict.";
    const result = await dispatch(
      callSpec(prompt),
      runtime(
        prompt,
        [structuredResponse(JSON.stringify(reviewVerdictExample), undefined, null)],
        [],
      ),
    );

    expect(result).toMatchObject({
      status: "success",
      billing: { status: "billing-unknown" },
    });
  });

  it("returns schema-invalid terminal content as a typed failure", async () => {
    const prompt = "Return a review verdict.";
    const captured: CapturedRequest[] = [];
    const result = await dispatch(
      callSpec(prompt),
      runtime(prompt, [structuredResponse("{}")], captured),
    );

    expect(captured).toHaveLength(1);
    expect(result).toMatchObject({ status: "failure", failureKind: "schema-failure" });
    expect(result).not.toHaveProperty("value");
  });

  it("classifies a measured-profile mismatch before it is mistaken for transport", async () => {
    const prompt = "Return a review verdict.";
    const configured = runtime(prompt, [], []);
    const result = await dispatch(callSpec(prompt), {
      ...configured,
      memo: {
        ...configured.memo,
        profile: { ...configured.memo.profile, name: "draft" },
      },
    });

    expect(result).toMatchObject({ status: "failure", failureKind: "configuration" });
  });

  it("classifies a content-read denial before it is mistaken for transport", async () => {
    const prompt = "Return a review verdict.";
    const configured = runtime(prompt, [], []);
    const result = await dispatch(callSpec(prompt), {
      ...configured,
      contentAccess: {
        async requireContentRead() {
          throw new AuthorizationError({ userId: "denied-user" }, "content.read");
        },
      },
    });

    expect(result).toMatchObject({ status: "failure", failureKind: "permission" });
  });
});
