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
  ) => ModelMessage[];
  validateResponse: (invocation: ModelInvocationResult) => string;
};

export type BoundedStructuredRetryResult<T> = {
  invocation: ModelInvocationResult;
  parsed: T;
};

/**
 * Add the deterministic, schema-specific follow-up without changing the
 * original prompt or allowing a retry loop to grow beyond one extra call.
 */
export function buildStructuredRetryMessages(
  messages: ReadonlyArray<ModelMessage>,
  error: unknown,
): ModelMessage[] {
  const detail = error instanceof Error ? error.message : String(error);
  return [
    ...messages,
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
  const firstInvocation = await options.provider.invoke(options.request);
  const firstRawContent = options.validateResponse(firstInvocation);

  try {
    return {
      invocation: firstInvocation,
      parsed: parseWithBoundedRepair(firstRawContent, options.parse),
    };
  } catch (error) {
    if (!options.isSchemaValidationError(error)) {
      throw error;
    }

    const retryRequest: ModelInvocationRequest = {
      ...options.request,
      messages: options.buildCorrectiveMessages(options.request.messages, error),
    };
    const retryInvocation = await options.provider.invoke(retryRequest);
    const retryRawContent = options.validateResponse(retryInvocation);
    return {
      invocation: retryInvocation,
      parsed: parseWithBoundedRepair(retryRawContent, options.parse),
    };
  }
}
