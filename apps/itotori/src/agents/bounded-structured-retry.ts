import { parseWithBoundedRepair } from "../localization/patchback-safety.js";
import type {
  ModelInvocationRequest,
  ModelInvocationResult,
  ModelMessage,
  ModelProvider,
} from "../providers/types.js";

export type BoundedStructuredRetryOptions<T> = {
  provider: ModelProvider;
  request: ModelInvocationRequest;
  parse: (raw: string) => T;
  isSchemaValidationError: (error: unknown) => boolean;
  buildCorrectiveMessages: (
    messages: ReadonlyArray<ModelMessage>,
    error: unknown,
    failedRawContent: string | null,
  ) => ModelMessage[];
  validateResponse: (invocation: ModelInvocationResult) => string;
  validateParsed: (parsed: T) => void;
};

export type BoundedStructuredRetryResult<T> = {
  invocation: ModelInvocationResult;
  parsed: T;
  priorAttempts: ModelInvocationResult[];
};

/**
 * Add the deterministic, schema-specific follow-up without changing the
 * original prompt or allowing a retry loop to grow beyond one extra call.
 */
export function buildStructuredRetryMessages(
  messages: ReadonlyArray<ModelMessage>,
  error: unknown,
  failedRawContent: string | null,
): ModelMessage[] {
  const detail = error instanceof Error ? error.message : String(error);
  return [
    ...messages,
    ...(failedRawContent === null
      ? []
      : [{ role: "assistant" as const, content: failedRawContent }]),
    {
      role: "user",
      content:
        `Your previous response failed schema validation: ${detail}. ` +
        "Re-emit the SAME analysis as a single JSON object that strictly conforms to the schema. " +
        "Fix ONLY the schema violation; do not add commentary, markdown, or a $schema property.",
    },
  ];
}

/**
 * Invoke a structured-output provider, parse it with the existing bounded
 * JSON-repair path, and retry exactly once for a typed schema-validation
 * failure. Response completeness is checked by the caller-supplied validator
 * on both attempts, so partial results never become retryable schema output.
 */
export async function invokeWithBoundedStructuredRetry<T>(
  options: BoundedStructuredRetryOptions<T>,
): Promise<BoundedStructuredRetryResult<T>> {
  const attemptOnce = (invocation: ModelInvocationResult): T => {
    const raw = options.validateResponse(invocation);
    const parsed = parseWithBoundedRepair(raw, options.parse);
    options.validateParsed(parsed);
    return parsed;
  };

  const firstInvocation = await options.provider.invoke(options.request);

  try {
    const parsed = attemptOnce(firstInvocation);
    return {
      invocation: firstInvocation,
      parsed,
      priorAttempts: [],
    };
  } catch (error) {
    if (!options.isSchemaValidationError(error)) {
      throw error;
    }

    const retryRequest: ModelInvocationRequest = {
      ...options.request,
      messages: options.buildCorrectiveMessages(
        options.request.messages,
        error,
        firstInvocation.content,
      ),
    };
    const retryInvocation = await options.provider.invoke(retryRequest);
    const parsed = attemptOnce(retryInvocation);
    return {
      invocation: retryInvocation,
      parsed,
      priorAttempts: [firstInvocation],
    };
  }
}
