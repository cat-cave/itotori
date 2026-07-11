import { describe, expect, it } from "vitest";
import {
  parseSpeakerLabelOutput,
  SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
  SpeakerLabelResponseValidationError,
  type SpeakerLabelOutput,
} from "@itotori/localization-bridge-schema";
import { FakeModelProvider } from "../src/providers/fake.js";
import type { ModelInvocationRequest } from "../src/providers/types.js";
import {
  buildStructuredRetryMessages,
  invokeWithBoundedStructuredRetry,
} from "../src/agents/bounded-structured-retry.js";
import type { BoundedStructuredRetryOptions } from "../src/agents/bounded-structured-retry.js";

const PROMPT_HASH = `sha256:${"0".repeat(64)}`;

function request(): ModelInvocationRequest {
  return {
    taskKind: "experiment",
    modelId: "retry-fixture-model",
    providerId: "retry-fixture-provider",
    inputClassification: "synthetic_public",
    messages: [
      { role: "system", content: "Emit a speaker-label object." },
      { role: "user", content: "Label this line." },
    ],
    structuredOutput: { mode: "json_object" },
    prompt: {
      presetId: "retry-fixture",
      templateVersion: "v1",
      promptHash: PROMPT_HASH,
    },
  };
}

function invalidSpeakerOutput(): string {
  return JSON.stringify({
    schemaVersion: SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
    labels: [],
    unexpected: true,
  });
}

function validSpeakerOutput(): string {
  return JSON.stringify({
    schemaVersion: SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
    labels: [],
  });
}

function invokeOptions(
  provider: FakeModelProvider,
  requestToUse: ModelInvocationRequest,
  validateParsed: (parsed: SpeakerLabelOutput) => void = () => {},
): BoundedStructuredRetryOptions<SpeakerLabelOutput> {
  return {
    provider,
    request: requestToUse,
    parse: parseSpeakerLabelOutput,
    isSchemaValidationError: (error) => error instanceof SpeakerLabelResponseValidationError,
    buildCorrectiveMessages: buildStructuredRetryMessages,
    validateResponse: (invocation) => {
      if (invocation.content === null || invocation.content.trim().length === 0) {
        throw new Error("provider returned no content");
      }
      return invocation.content;
    },
    validateParsed,
  };
}

describe("bounded structured-output retry", () => {
  it("retries one schema-invalid response and parses the second response", async () => {
    let invocationCount = 0;
    const requests: ModelInvocationRequest[] = [];
    const provider = new FakeModelProvider({
      providerName: "retry-fixture-provider",
      modelId: "retry-fixture-model",
      generate: (receivedRequest) => {
        invocationCount += 1;
        requests.push(receivedRequest);
        return invocationCount === 1 ? invalidSpeakerOutput() : validSpeakerOutput();
      },
    });

    const result = await invokeWithBoundedStructuredRetry(invokeOptions(provider, request()));

    expect(invocationCount).toBe(2);
    expect(result.parsed.labels).toEqual([]);
    expect(result.priorAttempts).toHaveLength(1);
    expect(result.priorAttempts[0]?.content).toBe(invalidSpeakerOutput());
    expect(requests[1]?.messages).toContainEqual({
      role: "assistant",
      content: invalidSpeakerOutput(),
    });
    expect(requests[1]?.messages.at(-1)?.content).toContain(
      "unexpected top-level property unexpected",
    );
    expect(requests[1]?.messages.at(-1)?.content).toContain(
      "do not add commentary, markdown, or a $schema property",
    );
  });

  it("does not retry a non-schema error (e.g. empty content) and invokes exactly once", async () => {
    let invocationCount = 0;
    const provider = new FakeModelProvider({
      providerName: "retry-fixture-provider",
      modelId: "retry-fixture-model",
      generate: () => {
        invocationCount += 1;
        // Empty content trips validateResponse, which throws a plain (non
        // schema-validation) Error — the bounded retry must NOT re-invoke.
        return "";
      },
    });

    const error = await invokeWithBoundedStructuredRetry(invokeOptions(provider, request())).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("provider returned no content");
    expect(error).not.toBeInstanceOf(SpeakerLabelResponseValidationError);
    expect(invocationCount).toBe(1);
  });

  it("throws the second typed validation error and never makes a third call", async () => {
    let invocationCount = 0;
    const provider = new FakeModelProvider({
      providerName: "retry-fixture-provider",
      modelId: "retry-fixture-model",
      generate: () => {
        invocationCount += 1;
        return invalidSpeakerOutput();
      },
    });

    const error = await invokeWithBoundedStructuredRetry(invokeOptions(provider, request())).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(SpeakerLabelResponseValidationError);
    expect(invocationCount).toBe(2);
  });

  it("does not accept a schema-valid retry that fails semantic validation", async () => {
    let invocationCount = 0;
    const semanticError = new Error("semantic validation failed");
    const provider = new FakeModelProvider({
      providerName: "retry-fixture-provider",
      modelId: "retry-fixture-model",
      generate: () => {
        invocationCount += 1;
        return invocationCount === 1 ? invalidSpeakerOutput() : validSpeakerOutput();
      },
    });
    const validateParsed = (parsed: SpeakerLabelOutput): void => {
      expect(parsed.labels).toEqual([]);
      if (invocationCount === 2) {
        throw semanticError;
      }
    };

    await expect(
      invokeWithBoundedStructuredRetry(invokeOptions(provider, request(), validateParsed)),
    ).rejects.toBe(semanticError);
    expect(invocationCount).toBe(2);
  });

  it("does not retry when the first schema-valid attempt fails semantic validation", async () => {
    let invocationCount = 0;
    const semanticError = new Error("first-attempt semantic validation failed");
    const provider = new FakeModelProvider({
      providerName: "retry-fixture-provider",
      modelId: "retry-fixture-model",
      generate: () => {
        invocationCount += 1;
        return validSpeakerOutput();
      },
    });

    await expect(
      invokeWithBoundedStructuredRetry(
        invokeOptions(provider, request(), () => {
          throw semanticError;
        }),
      ),
    ).rejects.toBe(semanticError);
    expect(invocationCount).toBe(1);
  });

  it("reports no prior attempts when the first attempt succeeds", async () => {
    const provider = new FakeModelProvider({
      providerName: "retry-fixture-provider",
      modelId: "retry-fixture-model",
      generate: () => validSpeakerOutput(),
    });

    const result = await invokeWithBoundedStructuredRetry(invokeOptions(provider, request()));

    expect(result.priorAttempts).toHaveLength(0);
  });
});
